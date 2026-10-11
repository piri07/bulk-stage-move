import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config';

// Entries older than one interval are dead weight; past this many, sweep them out.
const SWEEP_ABOVE = 10_000;

/**
 * Per-job poll limit: a job's state can be read at most once per interval (2s by default),
 * whoever asks, under the same rule in every workspace. A faster poll gets 429 with Retry-After,
 * so a client polling in a tight loop costs an in-memory check rather than a database read, and
 * can't use up the allowance of anyone else's job.
 *
 * The key is workspace + job, so a request naming the wrong workspace can't use up the owner's
 * allowance. State is per API instance: with several instances, each enforces the interval
 * separately (a shared store or the gateway would make it exact).
 */
@Injectable()
export class PollLimitGuard implements CanActivate {
  private readonly lastPoll = new Map<string, number>();
  private readonly intervalMs: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.intervalMs = config.bulk.pollIntervalMs;
  }

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { workspaceId?: string }>();
    const key = `${request.workspaceId ?? ''}:${String(request.params.id)}`;
    const now = Date.now();

    const last = this.lastPoll.get(key);
    if (last !== undefined && now - last < this.intervalMs) {
      const retryAfterMs = this.intervalMs - (now - last);
      http.getResponse<Response>().setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: `poll a job at most once every ${this.intervalMs / 1000}s`,
          retryAfterMs,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.lastPoll.set(key, now);
    if (this.lastPoll.size > SWEEP_ABOVE) this.sweep(now);
    return true;
  }

  private sweep(now: number): void {
    for (const [key, at] of this.lastPoll) {
      if (now - at >= this.intervalMs) this.lastPoll.delete(key);
    }
  }
}
