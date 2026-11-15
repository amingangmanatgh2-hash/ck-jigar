import { useEffect, useState } from 'react';
import { AiAvatar } from '../components/Avatar';
import { EndpointList } from '../components/EndpointList';
import { Button } from '../components/ui';
import { pool } from '../lib/endpointPool';
import { useT } from '../lib/i18n';
import { bootstrapSession } from '../state/session';

/**
 * Shown when a saved session exists but the server cannot be reached. The user is NOT signed out and nothing is lost. The app keeps
 * trying by itself (a timer, the network coming back, another address starting to work) and offers the address list meanwhile.
 */
export function OfflineScreen() {
  const t = useT();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const retry = async () => {
      if (!alive) return;
      setBusy(true);
      try {
        await bootstrapSession();
      } finally {
        if (alive) setBusy(false);
      }
    };
    const off = pool.onActiveChange(() => void retry());
    const timer = setInterval(() => void retry(), 15_000);
    window.addEventListener('online', retry);
    return () => {
      alive = false;
      off();
      clearInterval(timer);
      window.removeEventListener('online', retry);
    };
  }, []);

  return (
    <main className="auth" data-testid="offline-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <AiAvatar size={72} />
          <h1>{t('conn.offline.title')}</h1>
          <p className="muted">{t('conn.offline.text')}</p>
        </div>
        <Button variant="primary" icon="refresh" busy={busy} onClick={() => void bootstrapSession()}>
          {t('conn.offline.retry')}
        </Button>
        <EndpointList />
      </div>
    </main>
  );
}
