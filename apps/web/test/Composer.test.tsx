import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../src/components/Composer';
import { setLocale } from '../src/lib/i18n';

let n = 0;
const setup = (props: Partial<React.ComponentProps<typeof Composer>> = {}) => {
  const onSend = vi.fn(async () => true as boolean | void);
  const draftKey = `test-${++n}`;
  render(<Composer draftKey={draftKey} placeholder="Message" maxChars={50} onSend={onSend} {...props} />);
  return { onSend, box: screen.getByRole('textbox', { name: 'Message' }), draftKey };
};

describe('Composer', () => {
  beforeEach(() => {
    setLocale('en');
    window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  });

  it('sends on Enter, keeps a newline on Shift+Enter, and clears afterwards', async () => {
    const { onSend, box } = setup();
    await userEvent.type(box, 'hello{Shift>}{Enter}{/Shift}world');
    expect(box).toHaveValue('hello\nworld');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello\nworld', []));
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('does not send an empty or whitespace-only message', async () => {
    const { onSend, box } = setup();
    await userEvent.type(box, '   {Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps the text when sending fails, so nothing the user wrote is lost', async () => {
    const onSend = vi.fn(async () => false);
    const { box } = setup({ onSend });
    await userEvent.type(box, 'important{Enter}');
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(box).toHaveValue('important');
  });

  it('refuses text beyond the limit', async () => {
    const { onSend, box } = setup({ maxChars: 5 });
    await userEvent.type(box, 'abcdefgh{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('remembers an unsent draft per conversation', async () => {
    const first = setup();
    await userEvent.type(first.box, 'draft text');
    document.body.innerHTML = '';
    render(<Composer draftKey={first.draftKey} placeholder="Message" maxChars={50} onSend={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('draft text');
  });

  it('turns the send button into a stop button while an answer is being written', async () => {
    const onStop = vi.fn();
    setup({ running: true, onStop });
    await userEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalled();
  });

  it('lets each message choose its own direction (Persian right-to-left, English left-to-right)', () => {
    const { box } = setup();
    expect(box).toHaveAttribute('dir', 'auto');
  });

  it('offers @AMINAI while the user types a mention in a chat that allows it', async () => {
    const { box } = setup({ mention: true });
    await userEvent.type(box, 'hi @AM');
    const offer = await screen.findByRole('button', { name: /@AMINAI/ });
    await userEvent.click(offer);
    expect(box).toHaveValue('hi @AMINAI ');
  });
});
