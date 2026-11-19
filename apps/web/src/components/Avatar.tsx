import type { UserDto } from '@aminchat/shared';
import { useT } from '../lib/i18n';
import { Icon } from './Icon';

const HUES = [250, 200, 160, 20, 330, 45, 280, 120];
const hueOf = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length]!;
};

export const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = [...(parts[0] ?? '?')][0] ?? '?';
  const second = parts.length > 1 ? ([...parts[parts.length - 1]!][0] ?? '') : '';
  return (first + second).toUpperCase();
};

/** AMIN AI's own avatar. `busy` animates it while a response is being prepared (no animation under prefers-reduced-motion). */
export function AiAvatar({ size = 44, busy = false }: { size?: number; busy?: boolean }) {
  return (
    <span className={`ai-avatar${busy ? ' busy' : ''}`} style={{ width: size, height: size }} aria-hidden="true" data-testid="ai-avatar" data-busy={busy ? 'true' : 'false'}>
      <span className="ai-avatar-ring" />
      <span className="ai-avatar-core">
        <Icon name="sparkles" size={Math.round(size * 0.5)} strokeWidth={1.6} />
      </span>
    </span>
  );
}

export function Avatar({ name, size = 44, group = false }: { name: string; size?: number; group?: boolean }) {
  const hue = hueOf(name);
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: `linear-gradient(135deg, hsl(${hue} 70% 58%), hsl(${(hue + 40) % 360} 70% 48%))` }} aria-hidden="true">
      {group ? <Icon name="users" size={Math.round(size * 0.5)} /> : initials(name)}
    </span>
  );
}

export function UserAvatar({ user, size = 44, busy = false }: { user: Pick<UserDto, 'displayName' | 'kind'>; size?: number; busy?: boolean }) {
  return user.kind === 'ai' ? <AiAvatar size={size} busy={busy} /> : <Avatar name={user.displayName} size={size} />;
}

/** The "verified AI" mark shown next to AMIN AI's name everywhere. */
export function VerifiedBadge({ size = 16 }: { size?: number }) {
  const t = useT();
  return (
    <span className="verified" role="img" aria-label={t('ai.verified')} title={t('ai.verified')} style={{ width: size, height: size }} data-testid="verified-badge">
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
        <path d="M12 1.8l2.6 1.7 3.1-.1 1.4 2.7 2.7 1.4-.1 3.1 1.7 2.6-1.7 2.6.1 3.1-2.7 1.4-1.4 2.7-3.1-.1L12 22.2l-2.6-1.7-3.1.1-1.4-2.7-2.7-1.4.1-3.1L.6 11.8l1.7-2.6-.1-3.1 2.7-1.4 1.4-2.7 3.1.1z" fill="currentColor" />
        <path d="M7.8 12.3l2.9 2.9 5.6-5.8" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export function NameWithBadge({ user, name }: { user?: Pick<UserDto, 'displayName' | 'verified' | 'kind'> | null; name?: string }) {
  const label = name ?? user?.displayName ?? '';
  return (
    <span className="name-with-badge">
      <span className="name-text" dir="auto">
        {label}
      </span>
      {user?.verified && <VerifiedBadge size={15} />}
    </span>
  );
}
