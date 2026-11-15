import type { ConversationDto } from '@aminchat/shared';
import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Segmented, Switch } from '../components/ui';
import { Convs } from '../lib/endpoints';
import { useErrorText, useT, type Key } from '../lib/i18n';
import { navigate } from '../lib/router';
import { upsertConversation } from '../state/conversations';
import { toast } from '../state/toast';

/** One-glance state of what AMIN AI may do in this chat *for me* (the same rules the server enforces). */
export function aiSummaryKey(conv: ConversationDto): Key {
  if (conv.e2ee) return 'ai.access.e2ee';
  const eff = conv.ai.effective;
  if (!eff.allowed) {
    switch (eff.reason) {
      case 'blocked':
        return 'ai.access.blocked';
      case 'role':
        return 'ai.access.admins';
      default:
        return 'ai.access.off';
    }
  }
  if (eff.adminAssist) return 'ai.access.assist';
  return eff.level === 'context' ? 'ai.access.context' : 'ai.access.mention';
}

export function AiAccessSummary({ conv, compact }: { conv: ConversationDto; compact?: boolean }) {
  const t = useT();
  if (conv.type === 'ai') return null;
  const key = aiSummaryKey(conv);
  const on = !conv.e2ee && conv.ai.effective.allowed;
  return (
    <button type="button" className={`ai-pill${on ? ' on' : ''}${conv.e2ee ? ' e2ee' : ''}`} onClick={() => navigate(`/c/${conv.id}/info`)} title={t(`${key}.long` as Key)} aria-label={`${t('ai.name')}: ${t(key)}`} data-testid="ai-pill" data-access={on ? conv.ai.effective.level : 'none'}>
      <Icon name={conv.e2ee ? 'lock' : 'sparkles'} size={14} />
      {!compact && <span>{t(key)}</span>}
      {compact && <span className="pill-text">{t(key)}</span>}
    </button>
  );
}

/** Per-chat AI access controls: personal consent in direct chats, admin policy in groups; never available in secret chats. */
export function AiAccessPanel({ conv }: { conv: ConversationDto }) {
  const t = useT();
  const errText = useErrorText();
  const [busy, setBusy] = useState(false);
  const isAdmin = conv.myRole === 'owner' || conv.myRole === 'admin';

  async function run(fn: () => Promise<{ conversation: ConversationDto }>) {
    setBusy(true);
    try {
      upsertConversation((await fn()).conversation);
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-label={t('ai.access.title')} data-testid="ai-access-panel">
      <h3>
        <Icon name="sparkles" size={18} /> {t('ai.access.title')}
      </h3>
      <p className="muted small">{t(`${aiSummaryKey(conv)}.long` as Key)}</p>

      {conv.e2ee ? (
        <p className="banner banner-info">
          <Icon name="lock" size={18} />
          <span>{t('ai.access.e2eeExplain')}</span>
        </p>
      ) : conv.type === 'direct' ? (
        <>
          <Segmented
            label={t('ai.access.mine')}
            value={conv.ai.myAccess}
            onChange={(access) => void run(() => Convs.setAi(conv.id, { access }))}
            options={[
              { value: 'off', label: t('ai.level.off') },
              { value: 'mention', label: t('ai.level.mention') },
              { value: 'context', label: t('ai.level.context') },
            ]}
          />
          <p className="muted small">{t(`ai.level.${conv.ai.myAccess}.desc` as Key)}</p>
          <Switch
            checked={conv.ai.myBlocked}
            disabled={busy}
            onChange={(blocked) => void run(() => Convs.setAi(conv.id, { blocked }))}
            label={t('ai.access.block')}
            description={t('ai.access.blockDesc')}
          />
          {conv.ai.peerBlocked && (
            <p className="banner banner-warn">
              <Icon name="alert" size={18} />
              <span>{t('ai.access.peerBlocked')}</span>
            </p>
          )}
        </>
      ) : (
        <>
          <Segmented
            label={t('ai.access.groupLevel')}
            value={conv.ai.groupLevel}
            onChange={(level) => void run(() => Convs.setAiPolicy(conv.id, { level, invokeRoles: conv.ai.invokeRoles }))}
            options={(['off', 'mention', 'context', 'assist'] as const).map((v) => ({ value: v, label: t(`ai.level.${v}` as Key), disabled: !isAdmin || busy }))}
          />
          <p className="muted small">{t(`ai.group.${conv.ai.groupLevel}.desc` as Key)}</p>
          <Segmented
            label={t('ai.access.who')}
            value={conv.ai.invokeRoles}
            onChange={(invokeRoles) => void run(() => Convs.setAiPolicy(conv.id, { level: conv.ai.groupLevel, invokeRoles }))}
            options={[
              { value: 'all', label: t('ai.who.all'), disabled: !isAdmin || busy },
              { value: 'admins', label: t('ai.who.admins'), disabled: !isAdmin || busy },
            ]}
          />
          {!isAdmin && <p className="muted small">{t('ai.access.adminOnly')}</p>}
        </>
      )}
    </section>
  );
}
