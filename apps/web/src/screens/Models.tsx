import type { ModelDto, ModelRole, UsageSummaryDto } from '@aminchat/shared';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { ModelStatusBadge, modelReasonText } from '../components/pickers';
import { Button, ErrorBanner, ProgressBar, Spinner } from '../components/ui';
import { Ai } from '../lib/endpoints';
import { fmtCompact, fmtDateTime, fmtNumber } from '../lib/format';
import { useErrorText, useLocale, useT, type Key } from '../lib/i18n';
import { refreshModels, useModels } from '../state/ai';
import { useUser } from '../state/session';
import { toast } from '../state/toast';

const ROLES: ModelRole[] = ['chat', 'fast', 'code', 'vision', 'asr', 'image'];

export function UsageChart({ days }: { days: UsageSummaryDto['byDay'] }) {
  const t = useT();
  const locale = useLocale();
  const max = Math.max(1, ...days.map((d) => d.tokens));
  if (days.length === 0) return <p className="muted">{t('usage.noData')}</p>;
  return (
    <figure className="chart" aria-label={t('usage.byDay')}>
      <div className="chart-bars" role="img" aria-label={t('usage.byDay')}>
        {days.map((d) => (
          <div key={d.day} className="chart-col" title={`${d.day}: ${fmtNumber(d.tokens, locale)} ${t('usage.tokens')}`}>
            <span className="chart-bar" style={{ height: `${Math.max(3, Math.round((d.tokens / max) * 100))}%` }} />
          </div>
        ))}
      </div>
      <figcaption className="muted small">
        {days[0]!.day} → {days[days.length - 1]!.day}
      </figcaption>
    </figure>
  );
}

export function UsagePanel({ usage }: { usage: UsageSummaryDto }) {
  const t = useT();
  const locale = useLocale();
  const q = usage.quota;
  return (
    <div className="stack" data-testid="usage-panel">
      <div className="meters">
        <div className="meter">
          <div className="row between">
            <span>{t('usage.todayTokens')}</span>
            <strong>
              {fmtCompact(usage.today.tokens, locale)} / {fmtCompact(q.dailyTokens, locale)}
            </strong>
          </div>
          <ProgressBar value={usage.today.tokens} max={q.dailyTokens} label={t('usage.todayTokens')} />
        </div>
        <div className="meter">
          <div className="row between">
            <span>{t('usage.todayRequests')}</span>
            <strong>
              {fmtNumber(usage.today.requests, locale)} / {fmtNumber(q.dailyRequests, locale)}
            </strong>
          </div>
          <ProgressBar value={usage.today.requests} max={q.dailyRequests} label={t('usage.todayRequests')} />
        </div>
        <div className="meter">
          <div className="row between">
            <span>{t('usage.monthTokens')}</span>
            <strong>
              {fmtCompact(usage.month.tokens, locale)} / {fmtCompact(q.monthlyTokens, locale)}
            </strong>
          </div>
          <ProgressBar value={usage.month.tokens} max={q.monthlyTokens} label={t('usage.monthTokens')} />
        </div>
      </div>
      {q.custom && <p className="chip chip-info">{t('usage.customQuota')}</p>}
      {usage.today.errors > 0 && <p className="muted small">{t('usage.errorsToday', { n: usage.today.errors })}</p>}
      <h4>{t('usage.byDay')}</h4>
      <UsageChart days={usage.byDay} />
      <h4>{t('usage.byModel')}</h4>
      {usage.byModel.length === 0 ? (
        <p className="muted">{t('usage.noData')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('model.name')}</th>
                <th>{t('usage.tokens')}</th>
                <th>{t('usage.requests')}</th>
                <th>{t('usage.errors')}</th>
                <th>{t('usage.fallbacks')}</th>
              </tr>
            </thead>
            <tbody>
              {usage.byModel.map((m) => (
                <tr key={m.modelId}>
                  <td dir="ltr">{m.modelId.split('/').pop()}</td>
                  <td>{fmtNumber(m.tokens, locale)}</td>
                  <td>{fmtNumber(m.requests, locale)}</td>
                  <td>{fmtNumber(m.errors, locale)}</td>
                  <td>{fmtNumber(m.fallbacks, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ModelCard({ m }: { m: ModelDto }) {
  const t = useT();
  const locale = useLocale();
  const caps = (['vision', 'tools', 'json', 'reasoning', 'streaming'] as const).filter((c) => m.capabilities[c]);
  return (
    <article className={`model-card status-${m.status}`} data-testid="model-card" data-status={m.status} data-model={m.id}>
      <header className="row between">
        <div>
          <strong>{m.label}</strong>
          <div className="muted small">{m.vendor}</div>
        </div>
        <ModelStatusBadge model={m} />
      </header>
      <code className="model-id" dir="ltr">
        {m.id}
      </code>
      {m.status !== 'available' && modelReasonText(t, m) && (
        <p className="small muted">
          {modelReasonText(t, m)}
          {m.reasonCode === 'check_failed' && m.reason && (
            <>
              {' '}
              <bdi dir="ltr" className="model-detail">
                {m.reason}
              </bdi>
            </>
          )}
        </p>
      )}
      <div className="tags">
        {m.roles.map((r) => (
          <span key={r} className="chip">
            {t(`model.role.${r}` as Key)}
          </span>
        ))}
        {caps.map((c) => (
          <span key={c} className="chip chip-tool">
            {t(`model.cap.${c}` as Key)}
          </span>
        ))}
      </div>
      <dl className="facts">
        <div>
          <dt>{t('model.contextLabel')}</dt>
          <dd>{fmtCompact(m.contextWindow, locale)}</dd>
        </div>
        <div>
          <dt>{t('model.price')}</dt>
          <dd>{m.pricing ? <bdi dir="ltr">{`$${m.pricing.inputPerM} / $${m.pricing.outputPerM}`}</bdi> : '—'}</dd>
        </div>
        <div>
          <dt>{t('model.latency')}</dt>
          <dd>{m.latencyMs ? t('model.ms', { n: fmtNumber(m.latencyMs, locale) }) : '—'}</dd>
        </div>
        <div>
          <dt>{t('model.checked')}</dt>
          <dd>{m.checkedAt ? fmtDateTime(m.checkedAt, locale) : t('model.neverChecked')}</dd>
        </div>
      </dl>
    </article>
  );
}

export function ModelsScreen() {
  const t = useT();
  const locale = useLocale();
  const me = useUser();
  const errText = useErrorText();
  const { data: models, error, loading } = useModels();
  const [usage, setUsage] = useState<UsageSummaryDto | null>(null);
  const [usageError, setUsageError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);

  const loadUsage = useCallback(() => Ai.usage().then((u) => (setUsage(u), setUsageError(null))).catch(setUsageError), []);
  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  async function recheck() {
    setChecking(true);
    try {
      await Ai.refreshModels();
      await refreshModels();
      toast(t('model.rechecked'), 'success');
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setChecking(false);
    }
  }

  const connected = models?.backend === 'workers-ai';
  return (
    <section className="page" aria-label={t('nav.models')}>
      <header className="page-head">
        <h1>{t('nav.models')}</h1>
        {me.role === 'admin' && (
          <Button icon="refresh" busy={checking} onClick={() => void recheck()}>
            {t('model.recheck')}
          </Button>
        )}
      </header>
      <div className="page-body">
        {error != null && !models && <ErrorBanner text={errText(error)} onRetry={() => void refreshModels()} />}
        {loading && !models && <Spinner label={t('common.loading')} />}
        {models && (
          <>
            <div className={`banner ${connected ? 'banner-info' : 'banner-warn'}`} role="status" data-testid="backend-banner" data-backend={models.backend}>
              <Icon name={connected ? 'cpu' : 'alert'} size={18} />
              <span>{connected ? t('model.backend.connected') : t('model.backend.unavailable')}</span>
            </div>

            <section className="panel" aria-label={t('model.defaults')}>
              <h3>{t('model.defaults')}</h3>
              <p className="muted small">{t('model.defaultsHint')}</p>
              <dl className="facts wide">
                {ROLES.map((r) => {
                  const id = models.defaults[r];
                  const model = models.models.find((m) => m.id === id);
                  return (
                    <div key={r}>
                      <dt>{t(`model.role.${r}` as Key)}</dt>
                      <dd>{model ? model.label : <span className="muted">{t('model.noneVerified')}</span>}</dd>
                    </div>
                  );
                })}
              </dl>
              {models.checkedAt && <p className="muted small">{t('model.lastCheck', { time: fmtDateTime(models.checkedAt, locale) })}</p>}
            </section>

            <section aria-label={t('model.all')}>
              <h3>{t('model.all')}</h3>
              <div className="cards">
                {models.models.map((m) => (
                  <ModelCard key={m.id} m={m} />
                ))}
              </div>
            </section>
          </>
        )}

        <section className="panel" aria-label={t('usage.title')}>
          <h3>{t('usage.title')}</h3>
          {usageError != null && !usage && <ErrorBanner text={errText(usageError)} onRetry={() => void loadUsage()} />}
          {!usage && !usageError && <Spinner />}
          {usage && <UsagePanel usage={usage} />}
        </section>
      </div>
    </section>
  );
}
