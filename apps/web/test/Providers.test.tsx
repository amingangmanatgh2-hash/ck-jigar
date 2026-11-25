import type { ConversationDto } from '@aminchat/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunPanel } from '../src/components/RunPanel';
import { Convs, Ai } from '../src/lib/endpoints';
import { agentIcon } from '../src/components/pickers';
import { setLocale, translate } from '../src/lib/i18n';
import { ModelsScreen } from '../src/screens/Models';
import { modelsStore } from '../src/state/ai';
import { convStore } from '../src/state/conversations';
import { sessionStore } from '../src/state/session';
import { toastStore } from '../src/state/toast';
import { model, modelsResponse, provider, run, step, usageSummary } from './fixtures';

vi.mock('../src/lib/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/endpoints')>();
  return {
    ...actual,
    Ai: { ...actual.Ai, models: vi.fn(), usage: vi.fn(), refreshModels: vi.fn() },
    Convs: { ...actual.Convs, direct: vi.fn() },
  };
});

const T = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars);
const TF = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('fa', key, vars);
const models = vi.mocked(Ai.models);
const usage = vi.mocked(Ai.usage);
const direct = vi.mocked(Convs.direct);

function signIn(role: 'user' | 'admin' = 'user') {
  sessionStore.set({ status: 'authenticated', user: { id: 'u1', username: 'alice', displayName: 'Alice', avatarUrl: null, role, locale: 'en', timezone: 'UTC' } as never });
}

describe('Models screen — one banner per AI service, honest about what is connected', () => {
  beforeEach(() => {
    setLocale('en');
    signIn();
    modelsStore.set({ data: null, loading: false, error: null });
    models.mockReset();
    usage.mockReset();
    usage.mockResolvedValue(usageSummary());
  });

  it('says which services are connected, and shows where each model runs', async () => {
    models.mockResolvedValue(modelsResponse());
    render(<ModelsScreen />);
    const banners = await screen.findAllByTestId('backend-banner');
    expect(banners.map((b) => [b.getAttribute('data-provider'), b.getAttribute('data-connected')])).toEqual([
      ['workers-ai', 'true'],
      ['groq', 'true'],
    ]);
    expect(banners[0]).toHaveTextContent(T('model.provider.connected', { name: 'Cloudflare Workers AI' }));
    expect(banners[1]).toHaveTextContent(T('model.provider.connected', { name: 'Groq' }));
    const cards = screen.getAllByTestId('model-card');
    expect(within(cards.find((c) => c.getAttribute('data-model') === 'openai/gpt-oss-20b')!).getByText(/Runs on Groq/)).toBeInTheDocument();
    expect(within(cards.find((c) => c.getAttribute('data-model') === '@cf/google/gemma-4-26b-a4b-it')!).getByText(/Runs on Workers AI/)).toBeInTheDocument();
  });

  it('warns that text sent to Groq is processed outside Cloudflare — only when Groq is connected', async () => {
    models.mockResolvedValue(modelsResponse());
    const { unmount } = render(<ModelsScreen />);
    expect(await screen.findByTestId('groq-privacy')).toHaveTextContent(/outside Cloudflare/);
    unmount();

    modelsStore.set({ data: null, loading: false, error: null });
    models.mockResolvedValue(modelsResponse({ providers: [provider(), provider({ id: 'groq', label: 'Groq', connected: false })] }));
    render(<ModelsScreen />);
    await screen.findAllByTestId('backend-banner');
    expect(screen.queryByTestId('groq-privacy')).toBeNull();
  });

  it('says plainly that Groq is not connected, while Workers AI still is', async () => {
    models.mockResolvedValue(
      modelsResponse({
        providers: [provider(), provider({ id: 'groq', label: 'Groq', connected: false })],
        models: [model(), model({ id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', provider: 'groq', status: 'unavailable', reasonCode: 'not_connected', selectable: false, roles: ['fast'] })],
      }),
    );
    render(<ModelsScreen />);
    const banners = await screen.findAllByTestId('backend-banner');
    expect(banners[1]).toHaveTextContent(T('model.provider.notConnected', { name: 'Groq' }));
    expect(banners[1]).toHaveAttribute('data-connected', 'false');
    const card = screen.getAllByTestId('model-card').find((c) => c.getAttribute('data-model') === 'openai/gpt-oss-20b')!;
    expect(card).toHaveAttribute('data-status', 'unavailable'); // never shown as ready
    expect(within(card).getByText(T('model.reason.not_connected'))).toBeInTheDocument();
  });

  it('shows one warning, and no model as ready, when no service is connected', async () => {
    models.mockResolvedValue(
      modelsResponse({
        providers: [provider({ connected: false }), provider({ id: 'groq', label: 'Groq', connected: false })],
        models: [model({ status: 'unavailable', reasonCode: 'not_connected', selectable: false })],
        defaults: { chat: null, fast: null, code: null, vision: null, asr: null, embedding: null, image: null },
      }),
    );
    render(<ModelsScreen />);
    const banner = await screen.findByTestId('backend-banner');
    expect(banner).toHaveAttribute('data-backend', 'unavailable');
    expect(banner).toHaveTextContent(T('model.provider.allDown'));
    expect(screen.getAllByTestId('model-card').every((c) => c.getAttribute('data-status') !== 'available')).toBe(true);
  });

  it('has the same messages in Persian', () => {
    for (const key of ['model.provider.connected', 'model.provider.notConnected', 'model.provider.allDown', 'model.provider.groqPrivacy', 'model.provider.runsOn', 'run.openChat', 'run.startChat', 'tool.chat_open'] as const) {
      expect(TF(key, { name: 'X', chat: 'Y' }), key).not.toBe(key);
      expect(TF(key, { name: 'X', chat: 'Y' }), key).not.toBe(T(key, { name: 'X', chat: 'Y' }));
    }
    expect(TF('model.provider.groqPrivacy')).toContain('Cloudflare');
  });
});

describe('the Quick agent in the interface', () => {
  it('has its own icon in the agent picker (not the fallback)', () => {
    expect(agentIcon({ icon: 'zap' })).toBe('zap');
    expect(agentIcon({ icon: 'unknown-icon' })).toBe('sparkles');
  });
});

describe('RunPanel — the button for a chat the Quick agent found', () => {
  const found = (action: NonNullable<ReturnType<typeof step>['action']>) =>
    run({
      agentId: 'quick',
      status: 'completed',
      steps: [step({ id: 's1', title: 'Find the chat with Bob', tool: 'chat_open', status: 'completed', action, output: { text: 'Found the chat with Bob.' } })],
    });

  beforeEach(() => {
    setLocale('en');
    signIn();
    direct.mockReset();
    toastStore.set(() => []);
    convStore.set((s) => ({ ...s, items: [] }));
    window.location.hash = '#/';
  });

  it('labels the tool in words and opens an existing chat only when the user taps', async () => {
    render(<RunPanel run={found({ type: 'open_chat', conversationId: 'conv-bob', userId: 'u-bob', title: 'Bob Builder' })} defaultOpen />);
    expect(screen.getByText(T('tool.chat_open'))).toBeInTheDocument();
    expect(window.location.hash).toBe('#/'); // finding the chat never navigates by itself
    const button = screen.getByTestId('open-chat-action');
    expect(button).toHaveTextContent(T('run.openChat', { chat: 'Bob Builder' }));
    await userEvent.click(button);
    expect(window.location.hash).toBe('#/c/conv-bob');
    expect(direct).not.toHaveBeenCalled(); // nothing is created for a chat that exists
  });

  it('starts a chat with a person who has none yet — on tap, never before — then opens it', async () => {
    const created = { id: 'conv-new', type: 'direct' } as unknown as ConversationDto;
    direct.mockResolvedValue({ conversation: created });
    render(<RunPanel run={found({ type: 'open_chat', conversationId: null, userId: 'u-zed', title: 'Zed Stranger' })} defaultOpen />);
    expect(direct).not.toHaveBeenCalled();
    const button = screen.getByTestId('open-chat-action');
    expect(button).toHaveTextContent(T('run.startChat', { chat: 'Zed Stranger' }));
    await userEvent.click(button);
    await waitFor(() => expect(window.location.hash).toBe('#/c/conv-new'));
    expect(direct).toHaveBeenCalledTimes(1);
    expect(direct).toHaveBeenCalledWith('u-zed', false); // a normal chat, never an encrypted one by surprise
    expect(convStore.get().items.map((c) => c.id)).toContain('conv-new');
  });

  it('shows the reason and stays put when the chat cannot be started', async () => {
    direct.mockRejectedValue(Object.assign(new Error('nope'), { code: 'FORBIDDEN' }));
    render(<RunPanel run={found({ type: 'open_chat', conversationId: null, userId: 'u-zed', title: 'Zed Stranger' })} defaultOpen />);
    await userEvent.click(screen.getByTestId('open-chat-action'));
    await waitFor(() => expect(toastStore.get().some((t) => t.kind === 'error')).toBe(true));
    expect(window.location.hash).toBe('#/');
    expect(screen.getByTestId('open-chat-action')).not.toBeDisabled(); // can be tried again
  });

  it('offers no button when the step found nothing, or is not an open-chat step', () => {
    render(<RunPanel run={run({ status: 'completed', steps: [step({ tool: 'chat_open', status: 'completed', action: undefined, output: { text: 'No chat or person matches “x”.' } })] })} defaultOpen />);
    expect(screen.queryByTestId('open-chat-action')).toBeNull();
  });
});
