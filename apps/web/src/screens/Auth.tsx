import { USERNAME_REGEX, LIMITS } from '@aminchat/shared';
import { useState } from 'react';
import { AiAvatar } from '../components/Avatar';
import { Button, Field, Segmented } from '../components/ui';
import { getServer, isNative, normalizeServerUrl, setServer } from '../lib/api';
import { setLocale, useErrorText, useLocale, useT } from '../lib/i18n';
import { signIn, signUp, useSession } from '../state/session';

/** Sign in / create account. Every request that follows is authenticated by the bearer token this screen obtains. */
export function AuthScreen() {
  const t = useT();
  const locale = useLocale();
  const errText = useErrorText();
  const { expired } = useSession();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [server, setServerValue] = useState(getServer());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const native = isNative();

  const usernameOk = USERNAME_REGEX.test(username.trim());
  const passwordOk = password.length >= LIMITS.passwordMin;
  const canSubmit = mode === 'login' ? username.trim().length > 0 && password.length > 0 : usernameOk && passwordOk;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    if (native) {
      const normalized = normalizeServerUrl(server);
      if (!normalized) return setError(t('settings.serverInvalid'));
      setServer(normalized);
    }
    setBusy(true);
    try {
      if (mode === 'login') await signIn(username, password);
      else await signUp({ username, password, displayName });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <AiAvatar size={72} />
          <h1>{t('app.name')}</h1>
          <p className="muted">{t('auth.tagline')}</p>
        </div>
        {expired && (
          <p className="banner banner-warn" role="alert">
            {t('auth.expired')}
          </p>
        )}
        <Segmented
          label={t('auth.mode')}
          value={mode}
          onChange={(m) => {
            setMode(m);
            setError(null);
          }}
          options={[
            { value: 'login', label: t('auth.login') },
            { value: 'register', label: t('auth.register') },
          ]}
        />
        <form onSubmit={submit} className="stack" noValidate>
          {native && (
            <Field label={t('settings.serverUrl')} hint={t('settings.serverHint')}>
              {(id) => <input id={id} dir="ltr" inputMode="url" autoCapitalize="none" value={server} placeholder="https://amin-chat.example.workers.dev" onChange={(e) => setServerValue(e.target.value)} />}
            </Field>
          )}
          <Field label={t('auth.username')} hint={mode === 'register' ? t('auth.usernameHint') : undefined} error={mode === 'register' && username && !usernameOk ? t('auth.usernameInvalid') : null}>
            {(id) => <input id={id} dir="ltr" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />}
          </Field>
          {mode === 'register' && (
            <Field label={t('auth.displayName')}>{(id) => <input id={id} dir="auto" autoComplete="name" value={displayName} maxLength={LIMITS.displayNameMax} onChange={(e) => setDisplayName(e.target.value)} />}</Field>
          )}
          <Field label={t('auth.password')} hint={mode === 'register' ? t('auth.passwordHint') : undefined}>
            {(id) => <input id={id} type="password" dir="ltr" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          {error && (
            <p className="banner banner-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" busy={busy} disabled={!canSubmit} className="full">
            {mode === 'login' ? t('auth.login') : t('auth.register')}
          </Button>
        </form>
        <div className="auth-foot">
          <button type="button" className="link-btn" onClick={() => setLocale(locale === 'fa' ? 'en' : 'fa')}>
            {locale === 'fa' ? 'English' : 'فارسی'}
          </button>
        </div>
      </div>
    </main>
  );
}
