import { lazy, Suspense, useEffect } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { Spinner, Toaster } from '../components/ui';
import { useT, type Key } from '../lib/i18n';
import { realtime } from '../lib/realtime';
import { parseHash, useRoute } from '../lib/router';
import { useStore } from '../lib/store';
import { loadConversations, applyRealtimeEvent } from '../state/conversations';
import { sessionStore } from '../state/session';
import { AiChatScreen } from './AiChat';
import { Chat } from './ChatRouter';
import { ChatList } from './ChatList';

// Secondary screens are loaded when first opened: the chat list and the conversations are what the app must show first.
const MemoryScreen = lazy(() => import('./Memory').then((m) => ({ default: m.MemoryScreen })));
const ModelsScreen = lazy(() => import('./Models').then((m) => ({ default: m.ModelsScreen })));
const SettingsScreen = lazy(() => import('./Settings').then((m) => ({ default: m.SettingsScreen })));
const TasksScreen = lazy(() => import('./Tasks').then((m) => ({ default: m.TasksScreen })));

type Section = 'chats' | 'tasks' | 'memory' | 'models' | 'settings';
const NAV: { id: Section; icon: IconName; label: Key; href: string }[] = [
  { id: 'chats', icon: 'chat', label: 'nav.chats', href: '#/' },
  { id: 'tasks', icon: 'tasks', label: 'nav.tasks', href: '#/tasks' },
  { id: 'memory', icon: 'brain', label: 'nav.memory', href: '#/memory' },
  { id: 'models', icon: 'cpu', label: 'nav.models', href: '#/models' },
  { id: 'settings', icon: 'settings', label: 'nav.settings', href: '#/settings' },
];

const sectionOf = (first: string | undefined): Section => (first === 'tasks' || first === 'memory' || first === 'models' || first === 'settings' ? first : 'chats');

/**
 * Responsive layout. Wide screens: navigation rail + chat list + conversation side by side. Narrow screens (phones, Android app):
 * one pane at a time — the list, or the open conversation full-screen — with a bottom tab bar on the list/section pages.
 */
export function Shell() {
  const t = useT();
  const route = useRoute();
  const meId = useStore(sessionStore, (s) => s.user?.id ?? null);
  const first = route.path[0];
  const section = sectionOf(first);
  const inConversation = section === 'chats' && (first === 'c' || first === 'ai');

  useEffect(() => {
    void loadConversations();
    const off = realtime.on((ev) => {
      if (applyRealtimeEvent(ev, meId) === 'refetch') void loadConversations();
    });
    const offResync = realtime.onResync(() => void loadConversations());
    return () => {
      off();
      offResync();
    };
  }, [meId]);

  let activeId: string | null = null;
  if (first === 'c') activeId = route.path[1] ?? null;
  else if (first === 'ai') activeId = 'ai';

  let main: React.ReactNode;
  if (section === 'tasks') main = <TasksScreen />;
  else if (section === 'memory') main = <MemoryScreen />;
  else if (section === 'models') main = <ModelsScreen />;
  else if (section === 'settings') main = <SettingsScreen />;
  else if (first === 'ai') main = <AiChatScreen param={route.path[1]} />;
  else if (first === 'c' && route.path[1]) main = <Chat route={route.path} />;
  else
    main = (
      <div className="welcome-pane">
        <Icon name="chat" size={48} />
        <p className="muted">{t('chat.selectPrompt')}</p>
      </div>
    );

  return (
    <div className={`shell${inConversation ? ' in-conversation' : ''}${section !== 'chats' ? ' in-section' : ''}`}>
      <nav className="rail" aria-label={t('nav.main')}>
        {NAV.map((n) => (
          <a key={n.id} href={n.href} className={`rail-item${section === n.id ? ' active' : ''}`} aria-current={section === n.id ? 'page' : undefined}>
            <Icon name={n.icon} size={22} />
            <span>{t(n.label)}</span>
          </a>
        ))}
      </nav>
      {section === 'chats' && (
        <aside className="list-pane">
          <ChatList activeId={activeId} />
        </aside>
      )}
      <main className="main-pane">
        <Suspense
          fallback={
            <div className="center pad">
              <Spinner label={t('common.loading')} />
            </div>
          }
        >
          {main}
        </Suspense>
      </main>
      <Toaster />
    </div>
  );
}

export { parseHash };
