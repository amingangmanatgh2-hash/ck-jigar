import { useConnection, hostOf, useAfterDelay } from '../state/connection';
import { useT } from '../lib/i18n';
import { navigate } from '../lib/router';
import { Icon } from './Icon';

/**
 * A single line at the top of the screen that says what is wrong with the connection — and nothing when all is well.
 * It waits a moment before showing up so that normal reconnects (switching tabs, a brief signal drop) do not flash it.
 */
export function ConnectionBanner() {
  const t = useT();
  const c = useConnection();
  const trouble = c.state === 'reconnecting' || c.state === 'polling' || c.usingFallback || c.queued > 0;
  const show = useAfterDelay(trouble, 2500);
  if (!show) return null;

  const lines: string[] = [];
  if (c.state === 'reconnecting') lines.push(t('conn.reconnecting'));
  else if (c.state === 'polling') lines.push(t('conn.polling'));
  if (c.usingFallback) lines.push(t('conn.fallback', { host: hostOf(c.active) || '…' }));
  if (c.queued > 0) lines.push(t('conn.queued', { n: c.queued }));

  return (
    <div className={`conn-banner ${c.state === 'reconnecting' ? 'bad' : 'warn'}`} role="status" aria-live="polite" data-testid="connection-banner">
      <Icon name="globe" size={16} />
      <span>{lines.join(' ')}</span>
      <button type="button" className="conn-banner-link" onClick={() => navigate('/settings')}>
        {t('conn.settings')}
      </button>
    </div>
  );
}
