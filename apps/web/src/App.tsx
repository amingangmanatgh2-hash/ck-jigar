import { Spinner, Toaster } from './components/ui';
import { useT } from './lib/i18n';
import { ConnectionBanner } from './components/ConnectionBanner';
import { AuthScreen } from './screens/Auth';
import { OfflineScreen } from './screens/Offline';
import { Shell } from './screens/Shell';
import { useSession } from './state/session';

/** Auth gate. Nothing but the sign-in screen is reachable without a valid session; the realtime socket is opened by the session store. */
export function App() {
  const session = useSession();
  const t = useT();
  if (session.status === 'loading') {
    return (
      <div className="boot">
        <Spinner label={t('common.loading')} />
      </div>
    );
  }
  if (session.status === 'offline') {
    return (
      <>
        <OfflineScreen />
        <Toaster />
      </>
    );
  }
  if (session.status === 'anonymous') {
    return (
      <>
        <AuthScreen />
        <Toaster />
      </>
    );
  }
  return (
    <>
      <Shell />
      <ConnectionBanner />
    </>
  );
}
