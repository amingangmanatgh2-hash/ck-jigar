import { ChatScreen } from './Chat';
import { ChatInfoScreen } from './ChatInfo';

/** `/c/<id>` → the chat, `/c/<id>/info` → its settings. */
export function Chat({ route }: { route: string[] }) {
  const id = route[1]!;
  return route[2] === 'info' ? <ChatInfoScreen key={`info-${id}`} conversationId={id} /> : <ChatScreen key={id} conversationId={id} />;
}
