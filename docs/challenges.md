# Challenges

The problems I ran into while building this, what caused each one, and how I fixed it. Several
were found only because I measured or deliberately broke things, rather than trusting that tests
pass.

## Toolchain

### The newest framework versions didn't work with the test and lint tools

- **Problem:** the latest NestJS (12) is ESM-only, and the latest TypeScript (7) isn't supported
  by ts-jest or typescript-eslint.
- **Fix:** NestJS 11 (CommonJS, still maintained) with TypeScript 6.0, the newest combination the
  whole toolchain supports. Nothing in this project needs the newer versions.

## Proving the tests test something

### A test that passed without the mechanism it was meant to protect

- **Problem:** the idempotency test sent 10 identical requests at once and expected one job. To
  check it, I replaced the database's unique constraint with a naive "check, then insert". The
  test still passed.
- **Cause:** each submission finishes in a couple of milliseconds, so the 10 requests rarely
  overlapped, and the race never happened.
- **Fix:** a deterministic test. It holds the original request's transaction open, sends the
  duplicate, checks in `pg_locks` that the duplicate is waiting on the original's key, then
  commits and checks the duplicate got the original's job. With the constraint removed, this test
  fails every time.
- **Lesson:** I checked each safety mechanism by removing it and confirming its test fails:
  - the row lock on single moves
  - the version check
  - the lease-epoch fence
  - the idempotency constraint
  - the pool's error handler
  - pacing
  - round-robin turns
  - time slicing

### Time slicing alone wouldn't have made the queue fair

- **Problem:** when I removed round-robin ordering to check its test, the time-slicing test failed
  as well.
- **Cause:** with plain oldest-job-first claiming, a job handed back after its slice is still the
  oldest job, so the same worker claims it straight back. The waiting workspace waits exactly as
  long as before, and handing the job back achieves nothing.
- **Lesson:** fairness needs both pieces. Time slicing creates the moment to switch, and
  round-robin claiming decides who gets that moment. A live run on the real stack confirmed the
  pair: a 179-deal Small Co job waited about 1 second instead of the roughly 5 seconds the Large
  Co job needed. The Large Co job resumed from its cursor with nothing lost.

### Breaking things carefully

- **A broken mutation proved nothing.** My first attempt at removing the lease-epoch check left a
  SQL parameter unused. Every query then errored, so every test failed for the wrong reason. Each
  mutation now keeps the SQL valid, so it disables only the mechanism under test.
- **A failing test hung the whole suite.** A worker-loop test that failed before calling
  `worker.stop()` left a worker polling the database, and Jest never exited. The loop tests now
  run the worker through a helper that always stops it, even when the test fails.
- **A wait condition that was true too early.** A test waited for "the job has no lease owner" to
  detect a graceful handover. A pending job has no owner before it is ever claimed, so the test
  finished before the worker started. It now waits for "at least one batch committed _and_ no
  owner".

## Robustness

### The worker crashed when Postgres restarted

- **Problem:** during a benchmark, Postgres restarted and the worker process died. Its job then
  stayed `pending` with nobody to run it.
- **Cause:** Postgres closed the worker's idle pooled connection. The pg driver reports that as an
  `error` event on the pool, and with no listener registered, Node treats it as fatal. The API
  shared the same weakness, because it uses the same pool code.
- **Fix:** every pool now logs the error. The pool already discards the broken connection and
  opens a new one for the next query.
- **Proof:** a regression test ends the pool's connections with `pg_terminate_backend` and fails
  if the listener is removed. I also restarted Postgres underneath the running worker and API:
  both stayed up and the next job completed.

### A benchmark that waited forever

- **Problem:** with no worker alive, the benchmark polled its job's status indefinitely.
- **Fix:** each job now has a 2-minute deadline, and the error message suggests checking that a
  worker is running.

## Performance

### A batch that was 165× slower than it should have been

- **Problem:** under benchmark load, bulk jobs crawled at about 900–4,000 deals/s, against
  roughly 30,000 deals/s when run alone. Nothing errored and nothing retried.
- **Cause:** `EXPLAIN ANALYZE` showed one batch taking 2.6s, almost all of it in the step that
  records each deal's outcome. The planner joined the job's items to the batch by scanning all
  50,000 items for each of the 500 batch rows: 25 million comparisons. A newly created job isn't
  in the table's statistics yet, so the planner believed it had about one item and chose a plan
  that is only cheap for tiny inputs. Earlier runs had been fast only because the statistics
  happened to favour the right plan, so the bug was latent.
- **Fix:** the batch statement is now written so that no plan can be expensive:
  - every step is limited to the batch's own `seq` range
  - "was this deal moved?" is a hashed `IN` instead of a join
  - the final count no longer joins two intermediate results

  One batch dropped from 2,627ms to 15.9ms. Under load, jobs now run steadily at about 39,000
  deals/s.

- **Lesson:** a query's speed depends on its plan, and the plan depends on statistics I don't
  control. Hot-path SQL should be bounded by construction, not by the planner's luck.

## Measuring honestly

### The first measurement said bulk jobs made users faster

- **Problem:** the first run showed users' p99 latency _lower_ while bulk jobs ran.
- **Causes:**
  - The comparison was unfair: the baseline always ran first, while things were slightly colder.
  - At 100 requests/s per workspace, the system had so much headroom that the job made no
    difference. Idle virtual CPUs also sleep, and a busy machine responds slightly faster.
- **Fix:** rounds now alternate which condition runs first, and the request rate went up. At 200
  requests/s per workspace the real effect appeared:
  - Maximum latency jumped from about 10ms to 70–150ms during bulk jobs, in **both** workspaces.
  - In one round, p99 rose from about 5ms to over 40ms.
  - Elevated latency lasted after the jobs finished, while Postgres cleaned up old row versions
    and flushed its write-ahead log.
- **Lesson:** the load generator is open-loop (requests are sent on schedule, and latency is
  measured from the scheduled time), so stalls can't hide. Even so, a benchmark can mislead
  through phase order and too little load.

### Docker doesn't remove a CPU limit the way I expected

- **Problem:** to emulate a smaller database, I limited Postgres to 2 CPUs with
  `docker update --cpus 2`. Running `docker update --cpus 0` afterwards left the limit in place.
- **Fix:** I restored the container from the compose file
  (`docker compose up -d --force-recreate postgres`) and confirmed the limit was gone.
