import { DurableObject } from 'cloudflare:workers';
import { executeRun, settleCancelled } from '../agents/executor';
import type { Env } from '../env';
import { clipForLog } from '../lib/text';

/**
 * One Durable Object per AI run. It owns the *live* part of a run:
 *  - `start()` / `resume()` schedule an alarm; the alarm handler executes the run, so the work is not tied to the
 *    lifetime of the HTTP request that created it (a request can end while the run keeps streaming);
 *  - `cancel()` aborts the in-flight model/tool calls of a running run immediately, or settles a parked one.
 * All durable state (status, steps, approvals, event log) lives in D1; the DO only coordinates, so a lost DO instance can
 * always be resumed by the scheduled recovery job (see cron.ts).
 */
export class RunCoordinator extends DurableObject<Env> {
  private controller: AbortController | null = null;
  private running = false;
  /** A resume that arrived while the executor was still winding down: it must not be lost. */
  private resumeQueued = false;

  async start(runId: string): Promise<void> {
    await this.ctx.storage.put('runId', runId);
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Continue after an approval decision or after the run stopped heart-beating. A run that is executing right now is left alone. */
  async resume(runId: string): Promise<boolean> {
    await this.ctx.storage.put('runId', runId);
    if (this.running) {
      // For example: the user approved at the very moment the executor was parking the run. Continue right after it returns.
      this.resumeQueued = true;
      return true;
    }
    await this.ctx.storage.setAlarm(Date.now());
    return true;
  }

  async cancel(runId: string): Promise<void> {
    if (this.running && this.controller) {
      this.controller.abort(new Error('cancelled'));
      return;
    }
    await settleCancelled(this.env, runId);
  }

  async isRunning(): Promise<boolean> {
    return this.running;
  }

  override async alarm(): Promise<void> {
    const runId = await this.ctx.storage.get<string>('runId');
    if (!runId || this.running) return;
    this.running = true;
    this.controller = new AbortController();
    try {
      await executeRun(this.env, runId, this.controller.signal);
    } catch (err) {
      // executeRun reports problems through the run itself; anything reaching here is unexpected
      console.error('run coordinator crashed', runId, clipForLog(err));
    } finally {
      this.running = false;
      this.controller = null;
      if (this.resumeQueued) {
        this.resumeQueued = false;
        await this.ctx.storage.setAlarm(Date.now());
      }
    }
  }
}
