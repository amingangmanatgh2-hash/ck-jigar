import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';
import { dismissToast, useToasts } from '../state/toast';
import { Icon, type IconName } from './Icon';

export function Button({ variant = 'default', busy, icon, children, className, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost'; busy?: boolean; icon?: IconName }) {
  return (
    <button type="button" className={`btn btn-${variant}${className ? ` ${className}` : ''}`} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={18} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, flip, active, size = 20, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; flip?: boolean; active?: boolean; size?: number }) {
  return (
    <button type="button" className={`icon-btn${active ? ' active' : ''}${className ? ` ${className}` : ''}`} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={size} flip={flip} />
    </button>
  );
}

export const Spinner = ({ label }: { label?: string }) => (
  <span className="spinner" role="status" aria-label={label} />
);

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="switch-row">
      <div className="switch-text">
        <label htmlFor={id}>{label}</label>
        {description && <p className="muted small">{description}</p>}
      </div>
      <button id={id} type="button" role="switch" aria-checked={checked} className={`switch${checked ? ' on' : ''}`} disabled={disabled} onClick={() => onChange(!checked)}>
        <span className="switch-knob" />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; disabled?: boolean; hint?: string }[]; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} disabled={o.disabled} title={o.hint} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && !error && <p className="muted small">{hint}</p>}
      {error && (
        <p className="error-text small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: IconName; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={28} />
      </span>
      <h3>{title}</h3>
      {text && <p className="muted">{text}</p>}
      {action}
    </div>
  );
}

export function ErrorBanner({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="banner banner-error" role="alert">
      <Icon name="alert" size={18} />
      <span>{text}</span>
      {onRetry && (
        <button type="button" className="link-btn" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

/** Accessible modal: Escape closes, focus moves into the dialog and returns to the opener, backdrop click closes. */
export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab' && node) {
        const items = [...node.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled'));
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref}>
        <header className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <IconButton icon="x" label={t('common.close')} onClick={onClose} />
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ open, title, text, confirmLabel, danger, busy, onConfirm, onClose }: { open: boolean; title: string; text: string; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{text}</p>
    </Dialog>
  );
}

export function Toaster() {
  const toasts = useToasts();
  const t = useT();
  return (
    <div className="toaster" aria-live="polite" aria-atomic="false">
      {toasts.map((x) => (
        <div key={x.id} className={`toast toast-${x.kind}`} role={x.kind === 'error' ? 'alert' : 'status'}>
          <span>{x.text}</span>
          <button type="button" className="icon-btn small" aria-label={t('common.close')} onClick={() => dismissToast(x.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ProgressBar({ value, max, label, tone }: { value: number; max: number; label: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const auto = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok';
  return (
    <div className={`progress progress-${tone ?? auto}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Closes a popup when the user clicks outside or presses Escape. */
export function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  return ref;
}
