import { LIMITS, type AttachmentDto } from '@aminchat/shared';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { canRecord, startRecording, type Recording } from '../lib/audio';
import { Ai, Files } from '../lib/endpoints';
import { fmtBytes } from '../lib/format';
import { useErrorText, useLocale, useT } from '../lib/i18n';
import { toast } from '../state/toast';
import { Icon } from './Icon';
import { IconButton } from './ui';

export interface PendingFile {
  key: string;
  name: string;
  size: number;
  status: 'uploading' | 'done' | 'error';
  file?: AttachmentDto;
  error?: string;
}

/** Uploads files the moment they are chosen (so the send button only needs ids). Removing a chip deletes the uploaded file again. */
export function useAttachments() {
  const t = useT();
  const errText = useErrorText();
  const [items, setItems] = useState<PendingFile[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const add = useCallback(
    (list: FileList | File[]) => {
      const files = [...list];
      const room = LIMITS.attachmentsPerMessage - itemsRef.current.length;
      if (files.length > room) toast(t('attach.tooMany', { n: LIMITS.attachmentsPerMessage }), 'error');
      for (const file of files.slice(0, Math.max(0, room))) {
        const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        if (file.size > LIMITS.fileMaxBytes) {
          toast(t('attach.tooLarge', { name: file.name, mb: Math.round(LIMITS.fileMaxBytes / 1048576) }), 'error');
          continue;
        }
        setItems((cur) => [...cur, { key, name: file.name, size: file.size, status: 'uploading' }]);
        Files.upload(file)
          .then((att) => setItems((cur) => cur.map((x) => (x.key === key ? { ...x, status: 'done', file: att } : x))))
          .catch((err) => setItems((cur) => cur.map((x) => (x.key === key ? { ...x, status: 'error', error: errText(err) } : x))));
      }
    },
    [t, errText],
  );

  const remove = useCallback((key: string) => {
    const item = itemsRef.current.find((x) => x.key === key);
    setItems((cur) => cur.filter((x) => x.key !== key));
    if (item?.file) void Files.remove(item.file.id).catch(() => undefined);
  }, []);

  /** After a successful send the files belong to the message, so they are only forgotten locally. */
  const clear = useCallback(() => setItems([]), []);
  const ids = items.filter((x) => x.status === 'done' && x.file).map((x) => x.file!.id);
  return { items, add, remove, clear, ids, uploading: items.some((x) => x.status === 'uploading') };
}

type VoiceState = 'idle' | 'recording' | 'transcribing';

export function useVoice(onText: (text: string) => void) {
  const t = useT();
  const locale = useLocale();
  const errText = useErrorText();
  const [state, setState] = useState<VoiceState>('idle');
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<Recording | null>(null);

  useEffect(() => {
    if (state !== 'recording') return;
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - (rec.current?.startedAt ?? Date.now())) / 1000)), 500);
    return () => clearInterval(id);
  }, [state]);
  useEffect(() => () => rec.current?.cancel(), []);

  const transcribe = useCallback(
    async (blob: Blob) => {
      setState('transcribing');
      try {
        const res = await Ai.transcribe(blob, locale);
        onText(res.text);
      } catch (err) {
        toast(errText(err), 'error');
      } finally {
        setState('idle');
      }
    },
    [locale, onText, errText],
  );

  const start = useCallback(async () => {
    try {
      rec.current = await startRecording((blob) => {
        rec.current = null;
        void transcribe(blob);
      });
      setSeconds(0);
      setState('recording');
    } catch (err) {
      const name = (err as DOMException)?.name;
      toast(name === 'NotAllowedError' || name === 'SecurityError' ? t('voice.denied') : t('voice.failed'), 'error');
    }
  }, [t, transcribe]);

  const stop = useCallback(async () => {
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    await transcribe(await r.stop());
  }, [transcribe]);

  const cancel = useCallback(() => {
    rec.current?.cancel();
    rec.current = null;
    setState('idle');
  }, []);

  return { state, seconds, start, stop, cancel, supported: canRecord() };
}

const drafts = new Map<string, string>();

interface Props {
  /** Key to remember an unsent draft per conversation/thread. */
  draftKey: string;
  placeholder: string;
  maxChars: number;
  disabled?: boolean;
  /** An answer is being produced: the send button turns into a stop button. */
  running?: boolean;
  sending?: boolean;
  onSend: (text: string, fileIds: string[]) => Promise<boolean | void> | boolean | void;
  onStop?: () => void;
  allowFiles?: boolean;
  allowVoice?: boolean;
  /** Extra buttons on the start side (share-from-chat, @AMINAI …). */
  tools?: ReactNode;
  /** Chips shown above the input (shared content, reply preview, notices). */
  top?: ReactNode;
  /** Initial text (e.g. when editing a message). */
  initialText?: string;
  /** The composer can send without text (e.g. only shared content or files). */
  allowEmpty?: boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  onTyping?: () => void;
  sendLabel?: string;
  /** Offer "@AMINAI" while the user types an @ (chats where the assistant can be summoned). */
  mention?: boolean;
  /** Appends text at the end of the draft whenever `id` changes (e.g. the "@AMINAI" button). */
  insert?: { id: number; text: string } | null;
  /** Called with the current draft whenever it changes. */
  onTextChange?: (text: string) => void;
}

const coarse = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

export function Composer(p: Props) {
  const t = useT();
  const locale = useLocale();
  const [text, setText] = useState(() => p.initialText ?? drafts.get(p.draftKey) ?? '');
  const own = useRef<HTMLTextAreaElement>(null);
  const ta = p.textareaRef ?? own;
  const files = useAttachments();
  const fileInput = useRef<HTMLInputElement>(null);
  const appendText = useCallback((extra: string) => setText((cur) => (cur ? `${cur.replace(/\s+$/, '')} ${extra}` : extra)), []);
  const voice = useVoice(appendText);

  // draft persistence per conversation/thread
  useEffect(() => {
    if (p.initialText === undefined) drafts.set(p.draftKey, text);
  }, [p.draftKey, p.initialText, text]);
  useEffect(() => {
    setText(p.initialText ?? drafts.get(p.draftKey) ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.draftKey, p.initialText]);

  // auto-grow
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 170)}px`;
  }, [text, ta]);

  const onTextChange = p.onTextChange;
  useEffect(() => onTextChange?.(text), [text, onTextChange]);

  const lastInsert = useRef<number | null>(null);
  useEffect(() => {
    if (!p.insert || lastInsert.current === p.insert.id) return;
    lastInsert.current = p.insert.id;
    const extra = p.insert.text;
    setText((cur) => (cur.includes(extra.trim()) ? cur : `${cur}${cur && !/\s$/.test(cur) ? ' ' : ''}${extra}`));
    ta.current?.focus();
  }, [p.insert, ta]);

  const mentionToken = p.mention ? /(^|\s)@([A-Za-z_]*)$/.exec(text) : null;
  const mentionOffer = !!mentionToken && 'aminai'.startsWith((mentionToken[2] ?? '').toLowerCase().replace('_', '')) && (mentionToken[2] ?? '').length < 7;

  const trimmed = text.trim();
  const canSend = !p.disabled && !p.sending && !files.uploading && (trimmed.length > 0 || (p.allowEmpty ?? false) || files.ids.length > 0) && text.length <= p.maxChars;

  async function submit() {
    if (!canSend) return;
    const result = await p.onSend(trimmed, files.ids);
    if (result !== false) {
      setText('');
      drafts.delete(p.draftKey);
      files.clear();
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {p.top}
      {mentionOffer && (
        <button
          type="button"
          className="mention-offer"
          onClick={() => {
            setText((cur) => cur.replace(/@[A-Za-z_]*$/, '@AMINAI '));
            ta.current?.focus();
          }}
        >
          <Icon name="sparkles" size={16} /> <strong>@AMINAI</strong> <span className="muted small">{t('mention.offer')}</span>
        </button>
      )}
      {files.items.length > 0 && (
        <ul className="chips" aria-label={t('attach.files')}>
          {files.items.map((f) => (
            <li key={f.key} className={`chip chip-file chip-${f.status}`} title={f.error}>
              {f.status === 'uploading' ? <span className="spinner small" aria-hidden="true" /> : <Icon name={f.status === 'error' ? 'alert' : 'file'} size={14} />}
              <span className="chip-name" dir="auto">
                {f.name}
              </span>
              <span className="muted small">{f.status === 'error' ? f.error : fmtBytes(f.size, locale)}</span>
              <button type="button" className="icon-btn small" aria-label={t('attach.remove', { name: f.name })} onClick={() => files.remove(f.key)}>
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {voice.state === 'recording' && (
        <div className="recording" role="status">
          <span className="rec-dot" aria-hidden="true" />
          <span>{t('voice.recording')}</span>
          <time>{`${Math.floor(voice.seconds / 60)}:${String(voice.seconds % 60).padStart(2, '0')}`}</time>
          <button type="button" className="link-btn" onClick={voice.cancel}>
            {t('common.cancel')}
          </button>
        </div>
      )}
      {voice.state === 'transcribing' && (
        <div className="recording" role="status">
          <span className="spinner small" aria-hidden="true" /> {t('voice.transcribing')}
        </div>
      )}
      <div className="composer-row">
        {p.tools}
        {p.allowFiles && (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              aria-label={t('attach.choose')}
              data-testid="file-input"
              onChange={(e) => {
                if (e.target.files) files.add(e.target.files);
                e.target.value = '';
              }}
            />
            <IconButton icon="attach" label={t('attach.add')} disabled={p.disabled || files.items.length >= LIMITS.attachmentsPerMessage} onClick={() => fileInput.current?.click()} />
          </>
        )}
        <textarea
          ref={ta}
          className="composer-input"
          dir="auto"
          rows={1}
          value={text}
          placeholder={p.placeholder}
          aria-label={p.placeholder}
          disabled={p.disabled}
          maxLength={p.maxChars + 200}
          onChange={(e) => {
            setText(e.target.value);
            p.onTyping?.();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !coarse()) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {p.allowVoice && voice.supported && (
          <IconButton
            icon={voice.state === 'recording' ? 'stop' : 'mic'}
            label={voice.state === 'recording' ? t('voice.stop') : t('voice.start')}
            active={voice.state === 'recording'}
            disabled={p.disabled || voice.state === 'transcribing'}
            onClick={() => (voice.state === 'recording' ? void voice.stop() : void voice.start())}
          />
        )}
        {p.running ? (
          <button type="button" className="send-btn stop" onClick={p.onStop} aria-label={t('run.stop')} title={t('run.stop')}>
            <Icon name="stop" size={18} />
          </button>
        ) : (
          <button type="submit" className="send-btn" disabled={!canSend} aria-label={p.sendLabel ?? t('common.send')} title={p.sendLabel ?? t('common.send')}>
            {p.sending ? <span className="spinner small light" aria-hidden="true" /> : <Icon name="send" size={18} flip />}
          </button>
        )}
      </div>
      {text.length > p.maxChars * 0.9 && (
        <p className={`counter small ${text.length > p.maxChars ? 'error-text' : 'muted'}`}>
          {text.length} / {p.maxChars}
        </p>
      )}
    </form>
  );
}
