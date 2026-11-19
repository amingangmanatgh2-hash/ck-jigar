import { useState } from 'react';
import { pool, type EndpointInfo } from '../lib/endpointPool';
import { useT, type Key } from '../lib/i18n';
import { hostOf, useConnection, usePool } from '../state/connection';
import { Icon } from './Icon';
import { Button, Field, IconButton } from './ui';

/**
 * The addresses the app can use, which one is in use, whether each answers, and a field to add one (for example a relay someone
 * gave you). Used in Settings and on the "cannot reach the server" screen — where it matters most.
 */
export function EndpointList() {
  const t = useT();
  const state = usePool();
  const conn = useConnection();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  function add() {
    const result = pool.addCustom(value);
    if (result === 'ok') {
      setValue('');
      setError(null);
    } else setError(t(`conn.err.${result}` as Key));
  }

  const label = (e: EndpointInfo) => (e.base === '' ? t('conn.thisSite') : hostOf(e.base));
  const sourceOf = (e: EndpointInfo): Key => `conn.source.${e.source}` as Key;

  return (
    <div className="endpoint-list">
      <p className="muted small">{t('conn.intro')}</p>
      <p className="small" data-testid="transport">
        <strong>{t('conn.transport')}: </strong>
        {conn.transport === 'websocket' ? t('conn.transport.websocket') : conn.transport === 'poll' ? t('conn.transport.poll') : t('conn.transport.none')}
      </p>
      <ul className="endpoint-items" aria-label={t('conn.addresses')}>
        {state.endpoints.map((e) => (
          <li key={e.base || 'self'} className={`endpoint-item${e.base === state.active ? ' active' : ''}`} data-testid="endpoint">
            <span className={`dot dot-${e.health}`} role="img" aria-label={t(`conn.health.${e.health}` as Key)} title={t(`conn.health.${e.health}` as Key)} />
            <span className="endpoint-main">
              <bdi dir="ltr" className="endpoint-host">
                {label(e)}
              </bdi>
              <span className="muted small">
                {t(sourceOf(e))} · {t(`conn.health.${e.health}` as Key)}
                {e.latencyMs !== null && e.health === 'ok' ? ` · ${t('conn.latency', { ms: e.latencyMs })}` : ''}
              </span>
            </span>
            {e.base === state.active && (
              <span className="chip chip-ok">
                <Icon name="check" size={12} /> {t('conn.active')}
              </span>
            )}
            {(e.source === 'custom' || e.source === 'learned') && <IconButton icon="trash" size={16} label={t('conn.remove')} onClick={() => pool.remove(e.base)} />}
          </li>
        ))}
      </ul>
      <Button icon="refresh" busy={state.probing} onClick={() => void pool.probeAll()}>
        {state.probing ? t('conn.testing') : t('conn.test')}
      </Button>
      <form
        className="endpoint-add"
        onSubmit={(ev) => {
          ev.preventDefault();
          add();
        }}
      >
        <Field label={t('conn.addLabel')} error={error}>
          {(id) => <input id={id} dir="ltr" inputMode="url" autoComplete="off" value={value} placeholder={t('conn.addPlaceholder')} onChange={(e) => setValue(e.target.value)} />}
        </Field>
        <Button type="submit" icon="plus" disabled={!value.trim()}>
          {t('conn.add')}
        </Button>
      </form>
    </div>
  );
}
