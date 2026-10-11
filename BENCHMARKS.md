# Benchmarks

The numbers below come from one `make bench` run, which takes about 6 minutes and re-seeds before
each benchmark. The full per-round output is in
[`bench/results/2026-10-11-1255.txt`](bench/results/2026-10-11-1255.txt).

**Setup**

- Hardware: an Apple M4 (10 cores, 16 GB), running Docker Desktop (a VM with 10 CPUs and 7.7 GiB).
- Database: Postgres 17.11 with default settings.
- Application: one API process and one worker, with batches of 500, a 15s lease, and pacing at
  10,000 deals/s unless stated.
- Data: the full seed, so Large Co has 500,000 deals.
- **Paced** means the worker's speed limit is on (10,000 deals/s per job, the default). It waits
  after each 500-deal batch until 50ms have passed. **Unpaced** means the limit is off
  (`WORKER_MAX_DEALS_PER_SECOND=0`): batches run back to back, as fast as the database allows.

## 1. A bulk move of 50,000 deals

Medians of 5 runs, moving the same 50,000 deals back and forth with nothing else running.

|                                 | Paced (default) | Unpaced        |
| ------------------------------- | --------------- | -------------- |
| Wall-clock (POST to completion) | 6.34s           | 2.06s          |
| Worker time                     | 5.32s           | 1.06s          |
| Sustained throughput            | 9,405 deals/s   | 47,266 deals/s |
| Submit, including the snapshot  | 161ms           | 195ms          |

About 1s of each wall-clock is the worker's once-a-second check for new jobs. Waking workers with
`LISTEN/NOTIFY` would remove it.

## 2. Users' latency while bulk jobs run

- An open-loop load generator sends 200 requests/s per workspace: 60% list a stage, 20% read a
  deal, 20% move a deal by hand.
- Latency is measured from each request's scheduled send time.
- Two rounds of 15s phases are run, swapping the order of the conditions between rounds.
- "Same" is Large Co, where the jobs run; "other" is Small Co 1.

Times are in ms, from the worse of the two rounds:

| Condition               | p99, same | p99, other | Worst single request |
| ----------------------- | --------: | ---------: | -------------------: |
| No job                  |   4.1–4.3 |    4.2–4.6 |                 9–23 |
| Paced jobs running      |       4.5 |        4.3 |                   36 |
| Just after paced jobs   |       4.4 |        4.1 |                   91 |
| Unpaced jobs running    |       7.1 |        9.0 |                   83 |
| Just after unpaced jobs |       6.3 |        7.0 |                   76 |

- **Paced, p99 is unchanged in both workspaces.** Unpaced, it roughly doubles, and the other
  workspace is hit as hard as the job's own: the cost lands on the shared database.
- **Medians don't move.** The effect is all in the tail.
- **Single slow requests of up to ~90ms still happen around jobs of either kind.** They come from
  database-wide checkpoints and vacuum, the hole described in DESIGN.md. Runs vary: earlier
  unpaced runs reached a p99 of 21ms.

## 3. Kill and resume

The worker was sent SIGKILL with 31,500 of 50,000 deals committed, then restarted at once.

|                          |                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Another worker took over | 15.6s after the kill, when the 15s lease ran out                                                                                                                         |
| Job completed            | 17.2s after the kill (20.6s start to finish, against 5.3s uninterrupted)                                                                                                 |
| Proof                    | Completed; 50,000 moved with 50,000 history rows. No deal moved twice, none left without an outcome, none outside the snapshot touched. 1 failed attempt ("worker lost") |

Resume time is the lease. A shorter `WORKER_LEASE_MS` means faster takeover, and the lease-epoch
fence keeps it correct either way.

## Reproduce

```bash
make bench
```

Each benchmark also runs on its own: `dist/bench/throughput.js`, `dist/bench/isolation.js` (both
through `docker compose run --rm bench node …`), and `make bench-kill-resume`. Run
`make seed-full` afterwards, because the benchmarks move deals.

**Not covered:**

- One API process and one worker only.
- Default Postgres settings.
- Docker Desktop on macOS, not a Linux server.
- Latency measured inside the Docker network, so it excludes real network time.
