import type { SessionDto } from '@aminchat/shared';
import { useCallback, useEffect, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { Button, ConfirmDialog, ErrorBanner, Field, IconButton, Segmented, Spinner } from '../components/ui';
import { getServer, isNative, normalizeServerUrl, setServer } from '../lib/api';
import { hasLocalKeys } from '../lib/e2ee';
import { Admin, Auth, Users, type AdminOverview, type QuotaDto } from '../lib/endpoints';
import { fmtDateTime, fmtNumber } from '../lib/format';
import { setLocale, useErrorText, useLocale, useT, type Locale } from '../lib/i18n';
import { signOut, updateSelf, useUser } from '../state/session';
import { toast } from '../state/toast';
import { UsagePanel } from './Models';
import type { UsageSummaryDto, UserDto } from '@aminchat/shared';
import { applyTheme, getTheme, type Theme } from '../lib/theme';

function ProfileSection() {
  const t = useT();
  const me = useUser();
  const errText = useErrorText();
  const [name, setName] = useState(me.displayName);
  const [bio, setBio] = useState(me.bio ?? '');
  const [busy, setBusy] = useState(false);
  const dirty = name.trim() !== me.displayName || bio.trim() !== (me.bio ?? '');
  return (
    <form
      className="panel"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const { user } = await Auth.updateMe({ displayName: name.trim(), bio: bio.trim() || null });
          updateSelf(user);
          toast(t('settings.saved'), 'success');
        } catch (err) {
          toast(errText(err), 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="profile-card">
        <Avatar name={me.displayName} size={72} />
        <p className="muted">@{me.username}</p>
        {me.role === 'admin' && <span className="chip chip-info">{t('settings.admin')}</span>}
      </div>
      <Field label={t('settings.displayName')}>{(id) => <input id={id} dir="auto" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label={t('settings.bio')}>{(id) => <textarea id={id} dir="auto" rows={2} value={bio} maxLength={300} onChange={(e) => setBio(e.target.value)} />}</Field>
      <Button type="submit" variant="primary" busy={busy} disabled={!dirty || !name.trim()}>
        {t('common.save')}
      </Button>
    </form>
  );
}

function AppearanceSection() {
  const t = useT();
  const locale = useLocale();
  const [theme, setTheme] = useState<Theme>(getTheme());
  return (
    <section className="panel" aria-label={t('settings.appearance')}>
      <h3>
        <Icon name="language" size={18} /> {t('settings.appearance')}
      </h3>
      <Segmented
        label={t('settings.language')}
        value={locale}
        onChange={(l: Locale) => {
          setLocale(l);
          void Auth.updateMe({ locale: l }).then((r) => updateSelf(r.user)).catch(() => undefined);
        }}
        options={[
          { value: 'fa', label: 'فارسی' },
          { value: 'en', label: 'English' },
        ]}
      />
      <Segmented
        label={t('settings.theme')}
        value={theme}
        onChange={(v: Theme) => {
          setTheme(v);
          applyTheme(v);
        }}
        options={[
          { value: 'system', label: t('settings.theme.system') },
          { value: 'light', label: t('settings.theme.light') },
          { value: 'dark', label: t('settings.theme.dark') },
        ]}
      />
    </section>
  );
}

function SecuritySection() {
  const t = useT();
  const locale = useLocale();
  const me = useUser();
  const errText = useErrorText();
  const [sessions, setSessions] = useState<SessionDto[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => Auth.sessions().then((r) => (setSessions(r.sessions), setError(null))).catch(setError), []);
  useEffect(() => {
    void load();
  }, [load]);
  const localKey = hasLocalKeys(me.id);
  return (
    <section className="panel" aria-label={t('settings.security')}>
      <h3>
        <Icon name="shield" size={18} /> {t('settings.security')}
      </h3>
      <p className="small">
        <Icon name="lock" size={14} /> {localKey ? t('settings.e2eeHere') : me.hasE2eeKey ? t('settings.e2eeElsewhere') : t('settings.e2eeNone')}
      </p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await Auth.changePassword({ currentPassword: current, newPassword: next });
            setCurrent('');
            setNext('');
            toast(t('settings.passwordChanged'), 'success');
          } catch (err) {
            toast(errText(err), 'error');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t('settings.currentPassword')}>{(id) => <input id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
        <Field label={t('settings.newPassword')} hint={t('auth.passwordHint')}>
          {(id) => <input id={id} type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />}
        </Field>
        <Button type="submit" busy={busy} disabled={!current || next.length < 8}>
          {t('settings.changePassword')}
        </Button>
      </form>
      <h4>{t('settings.sessions')}</h4>
      {error != null && <ErrorBanner text={errText(error)} onRetry={() => void load()} />}
      {!sessions && !error && <Spinner />}
      <ul className="list">
        {(sessions ?? []).map((s) => (
          <li key={s.id} className="list-row">
            <div className="list-item static">
              <Icon name="shield" size={18} />
              <span className="list-main">
                <strong>
                  {s.current ? t('settings.thisDevice') : (s.userAgent?.slice(0, 48) ?? t('settings.unknownDevice'))}
                </strong>
                <span className="muted small">{t('settings.lastUsed', { time: fmtDateTime(s.lastUsedAt, locale) })}</span>
              </span>
            </div>
            {!s.current && (
              <IconButton
                icon="x"
                size={16}
                label={t('settings.revoke')}
                onClick={async () => {
                  try {
                    await Auth.revokeSession(s.id);
                    void load();
                  } catch (err) {
                    toast(errText(err), 'error');
                  }
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ServerSection() {
  const t = useT();
  const [value, setValue] = useState(getServer());
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <section className="panel" aria-label={t('settings.server')}>
      <h3>
        <Icon name="globe" size={18} /> {t('settings.server')}
      </h3>
      <p className="muted small">{t('settings.serverHint')}</p>
      <Field label={t('settings.serverUrl')} error={error}>
        {(id) => <input id={id} dir="ltr" inputMode="url" value={value} placeholder="https://amin-chat.example.workers.dev" onChange={(e) => setValue(e.target.value)} />}
      </Field>
      <Button
        onClick={() => {
          const normalized = normalizeServerUrl(value);
          if (normalized === null) return setError(t('settings.serverInvalid'));
          setError(null);
          setConfirm(normalized);
        }}
      >
        {t('settings.serverApply')}
      </Button>
      <ConfirmDialog
        open={confirm !== null}
        title={t('settings.server')}
        text={t('settings.serverConfirm')}
        confirmLabel={t('settings.serverApply')}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          const url = confirm ?? '';
          setConfirm(null);
          await signOut();
          setServer(url);
          window.location.reload();
        }}
      />
    </section>
  );
}

/** Administrators only: usage across users and per-user AI quotas (the server rejects everybody else with 403). */
function AdminSection() {
  const t = useT();
  const locale = useLocale();
  const errText = useErrorText();
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<UserDto[]>([]);
  const [target, setTarget] = useState<UserDto | null>(null);
  const [usage, setUsage] = useState<UsageSummaryDto | null>(null);
  const [fields, setFields] = useState({ dailyTokens: '', dailyRequests: '', monthlyTokens: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Admin.overview(7).then(setOverview).catch(setError);
  }, []);
  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    let alive = true;
    const id = setTimeout(() => Users.search(q.trim()).then((r) => alive && setFound(r.users.filter((u) => u.kind === 'human'))).catch(() => alive && setFound([])), 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [q]);

  async function pick(u: UserDto) {
    setTarget(u);
    setFound([]);
    setQ('');
    try {
      const us = await Admin.userUsage(u.id);
      setUsage(us);
      setFields({ dailyTokens: us.quota.custom ? String(us.quota.dailyTokens) : '', dailyRequests: us.quota.custom ? String(us.quota.dailyRequests) : '', monthlyTokens: us.quota.custom ? String(us.quota.monthlyTokens) : '' });
    } catch (err) {
      toast(errText(err), 'error');
    }
  }

  const num = (s: string): number | null => (s.trim() === '' ? null : Math.max(0, Math.floor(Number(s))));
  async function save() {
    if (!target) return;
    setSaving(true);
    try {
      const body = { dailyTokens: num(fields.dailyTokens), dailyRequests: num(fields.dailyRequests), monthlyTokens: num(fields.monthlyTokens) };
      if (Object.values(body).some((v) => v !== null && !Number.isFinite(v))) throw Object.assign(new Error('invalid'), { code: 'VALIDATION_ERROR' });
      const { quota }: { quota: QuotaDto } = await Admin.setQuota(target.id, body);
      toast(t(quota.custom ? 'admin.quotaSaved' : 'admin.quotaReset'), 'success');
      setUsage(await Admin.userUsage(target.id));
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" aria-label={t('admin.title')} data-testid="admin-section">
      <h3>
        <Icon name="shield" size={18} /> {t('admin.title')}
      </h3>
      {error != null && <ErrorBanner text={errText(error)} />}
      {overview && (
        <>
          <h4>{t('admin.topUsers', { days: overview.days })}</h4>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('admin.user')}</th>
                  <th>{t('usage.tokens')}</th>
                  <th>{t('usage.requests')}</th>
                </tr>
              </thead>
              <tbody>
                {overview.byUser.map((u) => (
                  <tr key={u.userId}>
                    <td dir="ltr">@{u.username}</td>
                    <td>{fmtNumber(u.tokens, locale)}</td>
                    <td>{fmtNumber(u.requests, locale)}</td>
                  </tr>
                ))}
                {overview.byUser.length === 0 && (
                  <tr>
                    <td colSpan={3} className="muted">
                      {t('usage.noData')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
      <h4>{t('admin.quota')}</h4>
      <div className="search-box">
        <Icon name="search" size={18} />
        <input type="search" dir="auto" value={q} placeholder={t('users.search')} aria-label={t('users.search')} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="list">
        {found.map((u) => (
          <li key={u.id}>
            <button type="button" className="list-item" onClick={() => void pick(u)}>
              <Avatar name={u.displayName} size={32} />
              <span className="list-main">
                <strong dir="auto">{u.displayName}</strong>
                <span className="muted small">@{u.username}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {target && (
        <div className="stack">
          <p>
            <strong dir="auto">{target.displayName}</strong> <span className="muted">@{target.username}</span>
          </p>
          <div className="grid-3">
            <Field label={t('admin.dailyTokens')}>{(id) => <input id={id} inputMode="numeric" value={fields.dailyTokens} placeholder={t('admin.default')} onChange={(e) => setFields((f) => ({ ...f, dailyTokens: e.target.value.replace(/\D/g, '') }))} />}</Field>
            <Field label={t('admin.dailyRequests')}>{(id) => <input id={id} inputMode="numeric" value={fields.dailyRequests} placeholder={t('admin.default')} onChange={(e) => setFields((f) => ({ ...f, dailyRequests: e.target.value.replace(/\D/g, '') }))} />}</Field>
            <Field label={t('admin.monthlyTokens')}>{(id) => <input id={id} inputMode="numeric" value={fields.monthlyTokens} placeholder={t('admin.default')} onChange={(e) => setFields((f) => ({ ...f, monthlyTokens: e.target.value.replace(/\D/g, '') }))} />}</Field>
          </div>
          <p className="muted small">{t('admin.quotaHint')}</p>
          <Button variant="primary" busy={saving} onClick={() => void save()}>
            {t('common.save')}
          </Button>
          {usage && <UsagePanel usage={usage} />}
        </div>
      )}
    </section>
  );
}

export function SettingsScreen() {
  const t = useT();
  const me = useUser();
  const [out, setOut] = useState(false);
  return (
    <section className="page" aria-label={t('nav.settings')}>
      <header className="page-head">
        <h1>{t('nav.settings')}</h1>
      </header>
      <div className="page-body">
        <ProfileSection />
        <AppearanceSection />
        <SecuritySection />
        {isNative() && <ServerSection />}
        {me.role === 'admin' && <AdminSection />}
        <section className="panel">
          <Button variant="danger" icon="logout" onClick={() => setOut(true)}>
            {t('settings.logout')}
          </Button>
          <p className="muted small">{t('settings.version', { v: __APP_VERSION__ })}</p>
        </section>
      </div>
      <ConfirmDialog open={out} title={t('settings.logout')} text={t('settings.logoutConfirm')} confirmLabel={t('settings.logout')} onClose={() => setOut(false)} onConfirm={() => void signOut()} />
    </section>
  );
}
