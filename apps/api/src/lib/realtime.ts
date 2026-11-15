import type { RealtimeEvent } from '@aminchat/shared';
import type { Env } from '../env';

/** Sends events to the live connections of the given users. Never throws: realtime is best-effort, D1 is the source of truth. */
export async function publishToUsers(env: Env, userIds: Iterable<string>, events: RealtimeEvent | RealtimeEvent[]): Promise<void> {
  const unique = [...new Set(userIds)];
  await Promise.allSettled(
    unique.map(async (id) => {
      try {
        await env.USER_HUB.get(env.USER_HUB.idFromName(id)).publish(events);
      } catch (err) {
        console.warn('realtime publish failed', id, String((err as Error)?.message ?? err));
      }
    }),
  );
}
