import type { SearchHitDto, ThreadDto } from '@aminchat/shared';
import { useEffect, useState } from 'react';
import { Ai } from '../lib/endpoints';
import { fmtListTime } from '../lib/format';
import { useErrorText, useLocale, useT } from '../lib/i18n';
import { dropThread } from '../state/ai';
import { toast } from '../state/toast';
import { Icon } from './Icon';
import { ConfirmDialog, Dialog, EmptyState, IconButton } from './ui';

interface Props {
  open: boolean;
  onClose: () => void;
  threads: ThreadDto[];
  loading: boolean;
  currentId: string | null;
  onOpen: (threadId: string) => void;
  onNew: () => void;
  onDeleted: (threadId: string) => void;
}

/** Conversation history of the AMIN AI chat with full-text search across all past conversations. */
export function ThreadDrawer({ open, onClose, threads, loading, currentId, onOpen, onNew, onDeleted }: Props) {
  const t = useT();
  const locale = useLocale();
  const errText = useErrorText();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHitDto[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [confirm, setConfirm] = useState<ThreadDto | null>(null);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setHits(null);
      return;
    }
    setSearching(true);
    let alive = true;
    const id = setTimeout(() => {
      Ai.search(query, 'ai')
        .then((r) => alive && setHits(r.hits))
        .catch((err) => alive && (toast(errText(err), 'error'), setHits([])))
        .finally(() => alive && setSearching(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [q, errText]);

  return (
    <>
      <Dialog open={open} onClose={onClose} title={t('thread.history')}>
        <div className="search-box">
          <Icon name="search" size={18} />
          <input type="search" value={q} dir="auto" placeholder={t('thread.search')} aria-label={t('thread.search')} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button type="button" className="btn btn-primary full" onClick={() => { onNew(); onClose(); }}>
          <Icon name="plus" size={18} /> {t('thread.new')}
        </button>
        {hits !== null ? (
          <ul className="list" aria-label={t('thread.results')}>
            {searching && <li className="muted pad">{t('common.loading')}</li>}
            {!searching && hits.length === 0 && <li className="muted pad">{t('thread.noResults')}</li>}
            {hits.map((h) => (
              <li key={h.messageId}>
                <button type="button" className="list-item" onClick={() => h.threadId && (onOpen(h.threadId), onClose())}>
                  <span className="list-main">
                    <strong dir="auto">{h.threadTitle ?? t('thread.untitled')}</strong>
                    <span className="muted small clamp-2" dir="auto">
                      {h.snippet}
                    </span>
                  </span>
                  <time className="muted small">{fmtListTime(h.createdAt, locale)}</time>
                </button>
              </li>
            ))}
          </ul>
        ) : loading && threads.length === 0 ? (
          <p className="muted pad">{t('common.loading')}</p>
        ) : threads.length === 0 ? (
          <EmptyState icon="chat" title={t('thread.empty')} />
        ) : (
          <ul className="list" aria-label={t('thread.history')}>
            {threads.map((th) => (
              <li key={th.id} className={`list-row${th.id === currentId ? ' on' : ''}`}>
                <button type="button" className="list-item" aria-current={th.id === currentId} onClick={() => { onOpen(th.id); onClose(); }}>
                  <span className="list-main">
                    <strong dir="auto">{th.title ?? t('thread.untitled')}</strong>
                    <span className="muted small">{t('thread.messages', { n: th.messageCount ?? 0 })}</span>
                  </span>
                  <time className="muted small">{fmtListTime(th.updatedAt, locale)}</time>
                </button>
                <IconButton icon="trash" size={16} label={t('thread.delete')} onClick={() => setConfirm(th)} />
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      <ConfirmDialog
        open={confirm !== null}
        danger
        title={t('thread.delete')}
        text={t('thread.deleteConfirm', { title: confirm?.title ?? t('thread.untitled') })}
        confirmLabel={t('common.delete')}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          const th = confirm;
          if (!th) return;
          try {
            await Ai.deleteThread(th.id);
            dropThread(th.id);
            onDeleted(th.id);
          } catch (err) {
            toast(errText(err), 'error');
          }
          setConfirm(null);
        }}
      />
    </>
  );
}
