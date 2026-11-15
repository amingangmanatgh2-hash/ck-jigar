import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBubble } from '../src/components/MessageBubble';
import { setLocale, translate } from '../src/lib/i18n';
import { streams } from '../src/lib/streams';
import { message } from './fixtures';

const aiUser = { id: 'usr_amin_ai', username: 'aminai', displayName: 'AMIN AI', kind: 'ai', verified: true } as never;

describe('MessageBubble', () => {
  beforeEach(() => {
    setLocale('en');
    streams.clear();
  });

  it('shows "thinking" before the first piece of an answer arrives', () => {
    render(<MessageBubble message={message({ id: 'a', status: 'streaming', body: '' })} mine={false} sender={aiUser} />);
    expect(screen.getByRole('status')).toHaveTextContent(translate('en', 'ai.thinking'));
  });

  it('shows the answer as it is being written, even though the stored body is still empty', () => {
    render(<MessageBubble message={message({ id: 'live', status: 'streaming', body: '' })} mine={false} sender={aiUser} />);
    act(() => streams.feed('live', { offset: 0, text: 'The first ' }));
    expect(screen.getByText(/The first/)).toBeInTheDocument();
    act(() => streams.feed('live', { offset: 10, text: 'words' }));
    expect(screen.getByText(/The first words/)).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the final stored text once the message is complete, and offers copy', () => {
    render(<MessageBubble message={message({ id: 'done', status: 'sent', body: '**Done.** Anything else?', meta: { ai: { modelId: 'gemma' } } as never })} mine={false} sender={aiUser} />);
    expect(screen.getByText('Done.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /copy/i }).length).toBeGreaterThan(0);
  });

  it('shows a person’s own text as plain text (Markdown and HTML are not interpreted)', () => {
    const { container } = render(<MessageBubble message={message({ id: 'u', senderId: 'me', body: '**not bold** <b>x</b>' })} mine sender={{ id: 'me', displayName: 'Me' } as never} />);
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('p.plain')).toHaveTextContent('**not bold** <b>x</b>');
  });

  it('says so when a message is encrypted and cannot be read on this device', () => {
    render(<MessageBubble message={message({ id: 'e', senderId: 'peer', body: null, cipher: { v: 1, iv: 'a', ct: 'b' } })} mine={false} sender={{ id: 'peer', displayName: 'Peer' } as never} decrypted={null} />);
    expect(screen.getByText(translate('en', 'e2ee.undecryptable'))).toBeInTheDocument();
  });

  it('shows the decrypted text of an encrypted message', () => {
    render(<MessageBubble message={message({ id: 'e', senderId: 'peer', body: null, cipher: { v: 1, iv: 'a', ct: 'b' } })} mine={false} sender={{ id: 'peer', displayName: 'Peer' } as never} decrypted="the secret plan" />);
    expect(screen.getByText('the secret plan')).toBeInTheDocument();
  });

  it('writes the AI policy change of a group as a system line', () => {
    render(<MessageBubble message={message({ id: 's', kind: 'system', senderId: 'x', meta: { system: { code: 'ai_policy_changed', by: 'Sara', level: 'mention', invokeRoles: 'admins' } } as never })} mine={false} />);
    expect(screen.getByTestId('system-message')).toHaveTextContent('Sara');
  });

  it('shows a message that is still waiting to be sent, and what can be done with one that was refused', async () => {
    const onRetry = vi.fn();
    const onDiscard = vi.fn();
    const { rerender } = render(<MessageBubble message={message({ id: 'pending:abc', senderId: 'me', body: 'written offline' })} mine sender={{ id: 'me', displayName: 'Me' } as never} outbox={{ state: 'pending', onRetry, onDiscard }} />);
    expect(screen.getByTestId('outbox-pending')).toHaveTextContent(translate('en', 'outbox.waiting'));
    expect(screen.queryByTestId('outbox-failed')).toBeNull();

    rerender(<MessageBubble message={message({ id: 'pending:abc', senderId: 'me', body: 'written offline' })} mine sender={{ id: 'me', displayName: 'Me' } as never} outbox={{ state: 'failed', errorText: 'No access', onRetry, onDiscard }} />);
    const failed = screen.getByTestId('outbox-failed');
    expect(failed).toHaveTextContent(translate('en', 'outbox.failed'));
    expect(failed).toHaveTextContent('No access');
    await userEvent.click(screen.getByRole('button', { name: translate('en', 'outbox.retry') }));
    await userEvent.click(screen.getByRole('button', { name: translate('en', 'outbox.discard') }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('shows nothing extra for a normal, delivered message', () => {
    render(<MessageBubble message={message({ id: 'm1', senderId: 'me', body: 'delivered' })} mine sender={{ id: 'me', displayName: 'Me' } as never} />);
    expect(screen.queryByTestId('outbox-pending')).toBeNull();
    expect(screen.queryByTestId('outbox-failed')).toBeNull();
  });
});
