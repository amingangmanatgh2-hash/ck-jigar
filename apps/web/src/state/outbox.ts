import { Convs } from '../lib/endpoints';
import { Outbox } from '../lib/outbox';
import { useStore } from '../lib/store';

const storage = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => localStorage.setItem(k, v),
  remove: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      // nothing to remove
    }
  },
};

/** The device-wide queue of unsent messages of the signed-in user. */
export const outbox = new Outbox({
  storage,
  now: () => Date.now(),
  send: (conversationId, body) => Convs.send(conversationId, body),
});

export const useOutbox = <S>(selector: (s: ReturnType<typeof outbox.state.get>) => S): S => useStore(outbox.state, selector);
