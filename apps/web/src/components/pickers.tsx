import type { AgentDto, ModelDto, ModelsResponse } from '@aminchat/shared';
import { useState } from 'react';
import { fmtCompact } from '../lib/format';
import { useLocale, useT, type TFn } from '../lib/i18n';
import { Icon, type IconName } from './Icon';
import { useDismiss } from './ui';

const AGENT_ICON: Record<string, IconName> = {
  sparkles: 'sparkles',
  'check-square': 'tasks',
  search: 'search',
  code: 'cpu',
  send: 'send',
  folder: 'file',
  palette: 'image',
  wand: 'sparkles',
};

export const agentIcon = (a: Pick<AgentDto, 'icon'>): IconName => AGENT_ICON[a.icon] ?? 'sparkles';

function Popup({ label, button, children }: { label: string; button: React.ReactNode; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="picker" ref={ref}>
      <button type="button" className="picker-btn" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>
        {button}
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className="picker-pop" role="listbox" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function AgentPicker({ agents, value, onChange, disabled }: { agents: AgentDto[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const current = agents.find((a) => a.id === value) ?? agents[0];
  if (!current) return null;
  return (
    <Popup
      label={t('agent.select')}
      button={
        <>
          <Icon name={agentIcon(current)} size={16} />
          <span>{current.name[locale]}</span>
        </>
      }
    >
      {(close) =>
        disabled ? (
          <p className="muted small pad">{t('agent.busy')}</p>
        ) : (
          agents.map((a) => (
            <button
              key={a.id}
              type="button"
              role="option"
              aria-selected={a.id === value}
              className={`picker-item${a.id === value ? ' on' : ''}`}
              onClick={() => {
                onChange(a.id);
                close();
              }}
            >
              <Icon name={agentIcon(a)} size={18} />
              <span className="picker-text">
                <strong>{a.name[locale]}</strong>
                <span className="muted small">{a.description[locale]}</span>
                {a.tools.length > 0 && (
                  <span className="tool-tags">
                    {a.tools.map((tool) => (
                      <span key={tool.id} className={`chip chip-tool${tool.available ? '' : ' off'}`} title={tool.available ? tool.title : (tool.reason ?? t('agent.toolOff'))}>
                        {tool.title}
                      </span>
                    ))}
                  </span>
                )}
              </span>
              {a.id === value && <Icon name="check" size={16} />}
            </button>
          ))
        )
      }
    </Popup>
  );
}

/** Localised cause of a model not being ready (the server sends a machine code; `reason` stays as the technical detail). */
export function modelReasonText(t: TFn, m: Pick<ModelDto, 'reasonCode' | 'deprecatedOn'>): string | null {
  switch (m.reasonCode) {
    case 'not_connected':
      return t('model.reason.not_connected');
    case 'deprecated':
      return t('model.reason.deprecated', { date: m.deprecatedOn ?? '' });
    case 'unverified':
      return t('model.reason.unverified');
    case 'stale':
      return t('model.reason.stale');
    case 'check_failed':
      return t('model.reason.check_failed');
    default:
      return null;
  }
}

const statusKey = (m: ModelDto) => (m.status === 'available' ? 'model.status.available' : m.status === 'unavailable' ? 'model.status.unavailable' : 'model.status.unknown');

export function ModelStatusBadge({ model }: { model: Pick<ModelDto, 'status' | 'reasonCode' | 'deprecatedOn'> }) {
  const t = useT();
  return (
    <span className={`chip chip-model-${model.status}`} title={modelReasonText(t, model) ?? undefined} data-status={model.status}>
      {t(statusKey(model as ModelDto))}
    </span>
  );
}

/**
 * Only models the server marks `selectable` can be chosen. A model that is unavailable (or not yet verified) is never shown as
 * ready: it is listed with its real status and cannot be selected.
 */
export function ModelPicker({ models, value, onChange }: { models: ModelsResponse | null; value: string | null; onChange: (id: string | null) => void }) {
  const t = useT();
  const locale = useLocale();
  const chatModels = (models?.models ?? []).filter((m) => m.roles.some((r) => r === 'chat' || r === 'code' || r === 'vision'));
  const current = chatModels.find((m) => m.id === value);
  return (
    <Popup
      label={t('model.select')}
      button={
        <>
          <Icon name="cpu" size={16} />
          <span>{current ? current.label : t('model.auto')}</span>
        </>
      }
    >
      {(close) => (
        <>
          <button type="button" role="option" aria-selected={value === null} className={`picker-item${value === null ? ' on' : ''}`} onClick={() => { onChange(null); close(); }}>
            <Icon name="sparkles" size={18} />
            <span className="picker-text">
              <strong>{t('model.auto')}</strong>
              <span className="muted small">{t('model.autoHint')}</span>
            </span>
            {value === null && <Icon name="check" size={16} />}
          </button>
          {chatModels.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={m.id === value}
              aria-disabled={!m.selectable}
              disabled={!m.selectable}
              className={`picker-item${m.id === value ? ' on' : ''}`}
              onClick={() => {
                onChange(m.id);
                close();
              }}
            >
              <Icon name="cpu" size={18} />
              <span className="picker-text">
                <strong>{m.label}</strong>
                <span className="muted small">
                  {m.vendor} · {t('model.context', { n: fmtCompact(m.contextWindow, locale) })}
                </span>
                {!m.selectable && modelReasonText(t, m) && <span className="error-text small">{modelReasonText(t, m)}</span>}
              </span>
              <ModelStatusBadge model={m} />
            </button>
          ))}
          {chatModels.length === 0 && <p className="muted small pad">{t('model.none')}</p>}
        </>
      )}
    </Popup>
  );
}
