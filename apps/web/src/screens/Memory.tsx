import { LIMITS, MEMORY_KINDS, type MemoryItemDto, type MemorySettingsDto, type MemorySuggestionDto } from '@aminchat/shared';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { Button, ConfirmDialog, EmptyState, ErrorBanner, IconButton, Spinner, Switch } from '../components/ui';
import { Ai } from '../lib/endpoints';
import { useErrorText, useT, type Key } from '../lib/i18n';
import { realtime } from '../lib/realtime';
import { toast } from '../state/toast';

type Kind = (typeof MEMORY_KINDS)[number];
const kindKey = (k: string) => `memory.kind.${k}` as Key;

function KindSelect({ value, onChange, id }: { value: Kind; onChange: (k: Kind) => void; id?: string }) {
  const t = useT();
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value as Kind)} aria-label={t('memory.kind')}>
      {MEMORY_KINDS.map((k) => (
        <option key={k} value={k}>
          {t(kindKey(k))}
        </option>
      ))}
    </select>
  );
}

function Item({ item, onChanged }: { item: MemoryItemDto; onChanged: () => void }) {
  const t = useT();
  const errText = useErrorText();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.content);
  const [kind, setKind] = useState<Kind>(item.kind);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await Ai.patchMemory(item.id, { content: text.trim(), kind });
      setEditing(false);
      onChanged();
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="memory-item" data-testid="memory-item">
      {editing ? (
        <div className="stack">
          <textarea dir="auto" rows={3} value={text} maxLength={LIMITS.memoryItemMaxChars} aria-label={t('memory.content')} onChange={(e) => setText(e.target.value)} />
          <div className="row">
            <KindSelect value={kind} onChange={setKind} />
            <Button variant="primary" busy={busy} disabled={!text.trim()} onClick={() => void save()}>
              {t('common.save')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setText(item.content);
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="memory-text">
            <span dir="auto">{item.content}</span>
            <span className="muted small">
              {t(kindKey(item.kind))}
              {item.project ? ` · ${item.project}` : ''} · {item.source === 'user' ? t('memory.source.user') : t('memory.source.ai')}
            </span>
          </div>
          <IconButton icon="edit" size={16} label={t('common.edit')} onClick={() => setEditing(true)} />
          <IconButton
            icon="trash"
            size={16}
            label={t('common.delete')}
            onClick={async () => {
              try {
                await Ai.deleteMemory(item.id);
                onChanged();
              } catch (err) {
                toast(errText(err), 'error');
              }
            }}
          />
        </>
      )}
    </li>
  );
}

function Suggestion({ s, onDecided }: { s: MemorySuggestionDto; onDecided: () => void }) {
  const t = useT();
  const errText = useErrorText();
  const [text, setText] = useState(s.content);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  async function decide(decision: 'approve' | 'reject') {
    setBusy(decision);
    try {
      await Ai.decideSuggestion(s.id, { decision, ...(decision === 'approve' && text.trim() !== s.content ? { content: text.trim() } : {}) });
      onDecided();
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setBusy(null);
    }
  }
  return (
    <li className="suggestion" data-testid="memory-suggestion">
      <p className="muted small">
        <Icon name="sparkles" size={14} /> {t('memory.suggested')} · {t(kindKey(s.kind))}
        {s.project ? ` · ${s.project}` : ''}
      </p>
      <textarea dir="auto" rows={2} value={text} maxLength={LIMITS.memoryItemMaxChars} aria-label={t('memory.content')} onChange={(e) => setText(e.target.value)} />
      {s.reason && (
        <p className="muted small" dir="auto">
          {t('memory.reason')}: {s.reason}
        </p>
      )}
      <div className="row">
        <Button variant="primary" icon="check" busy={busy === 'approve'} disabled={busy !== null || !text.trim()} onClick={() => void decide('approve')}>
          {t('memory.remember')}
        </Button>
        <Button variant="ghost" icon="x" busy={busy === 'reject'} disabled={busy !== null} onClick={() => void decide('reject')}>
          {t('memory.dismiss')}
        </Button>
      </div>
    </li>
  );
}

export function MemoryScreen() {
  const t = useT();
  const errText = useErrorText();
  const [data, setData] = useState<{ settings: MemorySettingsDto; items: MemoryItemDto[]; suggestions: MemorySuggestionDto[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [newText, setNewText] = useState('');
  const [newKind, setNewKind] = useState<Kind>('preference');
  const [adding, setAdding] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await Ai.memory());
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
    const off = realtime.on((ev) => ev.type === 'memory.suggestion' && void load());
    const offResync = realtime.onResync(() => void load());
    return () => {
      off();
      offResync();
    };
  }, [load]);

  async function setting(patch: Partial<MemorySettingsDto>) {
    try {
      const { settings } = await Ai.memorySettings(patch);
      setData((d) => (d ? { ...d, settings } : d));
    } catch (err) {
      toast(errText(err), 'error');
    }
  }

  async function add() {
    setAdding(true);
    try {
      await Ai.addMemory({ kind: newKind, content: newText.trim() });
      setNewText('');
      await load();
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setAdding(false);
    }
  }

  const enabled = data?.settings.enabled ?? true;
  return (
    <section className="page" aria-label={t('nav.memory')}>
      <header className="page-head">
        <h1>{t('nav.memory')}</h1>
      </header>
      <div className="page-body">
        {error != null && !data && <ErrorBanner text={errText(error)} onRetry={() => void load()} />}
        {!data && !error && <Spinner label={t('common.loading')} />}
        {data && (
          <>
            <p className="banner banner-info">
              <Icon name="info" size={18} />
              <span>{t('memory.explain')}</span>
            </p>

            <section className="panel" aria-label={t('memory.settings')}>
              <h3>{t('memory.settings')}</h3>
              <Switch checked={data.settings.enabled} onChange={(enabled) => void setting({ enabled })} label={t('memory.enabled')} description={t('memory.enabledDesc')} />
              <Switch checked={data.settings.autoSuggest} disabled={!enabled} onChange={(autoSuggest) => void setting({ autoSuggest })} label={t('memory.autoSuggest')} description={t('memory.autoSuggestDesc')} />
              <Switch checked={data.settings.allowHistoryRecall} disabled={!enabled} onChange={(allowHistoryRecall) => void setting({ allowHistoryRecall })} label={t('memory.recall')} description={t('memory.recallDesc')} />
              {!enabled && <p className="muted small">{t('memory.disabledNote')}</p>}
            </section>

            {data.suggestions.filter((s) => s.status === 'pending').length > 0 && (
              <section className="panel" aria-label={t('memory.suggestions')}>
                <h3>{t('memory.suggestions')}</h3>
                <ul className="stack">
                  {data.suggestions
                    .filter((s) => s.status === 'pending')
                    .map((s) => (
                      <Suggestion key={s.id} s={s} onDecided={() => void load()} />
                    ))}
                </ul>
              </section>
            )}

            <section className="panel" aria-label={t('memory.items')}>
              <h3>
                {t('memory.items')} <span className="muted small">({data.items.length}/{LIMITS.memoryItemsMax})</span>
              </h3>
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newText.trim()) void add();
                }}
              >
                <label htmlFor="memory-new" className="sr-only">
                  {t('memory.add')}
                </label>
                <textarea id="memory-new" dir="auto" rows={2} value={newText} maxLength={LIMITS.memoryItemMaxChars} placeholder={t('memory.addPlaceholder')} onChange={(e) => setNewText(e.target.value)} />
                <div className="row">
                  <KindSelect value={newKind} onChange={setNewKind} />
                  <Button type="submit" icon="plus" busy={adding} disabled={!newText.trim()}>
                    {t('memory.add')}
                  </Button>
                </div>
              </form>
              {data.items.length === 0 ? (
                <EmptyState icon="brain" title={t('memory.empty')} text={t('memory.emptyHint')} />
              ) : (
                <ul className="memory-list">
                  {data.items.map((item) => (
                    <Item key={item.id} item={item} onChanged={() => void load()} />
                  ))}
                </ul>
              )}
            </section>

            <section className="panel danger-zone" aria-label={t('memory.danger')}>
              <h3>{t('memory.danger')}</h3>
              <p className="muted small">{t('memory.deleteAllDesc')}</p>
              <Button variant="danger" icon="trash" disabled={data.items.length === 0 && data.suggestions.length === 0} onClick={() => setConfirmAll(true)}>
                {t('memory.deleteAll')}
              </Button>
            </section>
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirmAll}
        danger
        busy={deleting}
        title={t('memory.deleteAll')}
        text={t('memory.deleteAllConfirm')}
        confirmLabel={t('memory.deleteAll')}
        onClose={() => setConfirmAll(false)}
        onConfirm={async () => {
          setDeleting(true);
          try {
            await Ai.deleteAllMemory();
            setConfirmAll(false);
            toast(t('memory.deleted'), 'success');
            await load();
          } catch (err) {
            toast(errText(err), 'error');
          } finally {
            setDeleting(false);
          }
        }}
      />
    </section>
  );
}
