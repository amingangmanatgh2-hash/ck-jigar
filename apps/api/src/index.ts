import { buildApp } from './app';
import { runScheduled } from './cron';
import type { Env } from './env';

export { RateLimiter } from './do/rate-limiter';
export { RunCoordinator } from './do/run-coordinator';
export { UserHub } from './do/user-hub';

const app = buildApp();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  // Cron trigger (every minute): reminders, recovery of stalled runs, expiry of approvals, housekeeping.
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
