import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../src/components/Composer';
import { ApiError } from '../src/lib/api';
import { Files, Server } from '../src/lib/endpoints';
import { setLocale, translate } from '../src/lib/i18n';
import { capabilitiesFrom, capabilitiesStore, refreshCapabilities, resetCapabilities, UNKNOWN_CAPABILITIES } from '../src/state/capabilities';
import { toastStore } from '../src/state/toast';

vi.mock('../src/lib/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/endpoints')>();
  return { ...actual, Files: { ...actual.Files, upload: vi.fn(), remove: vi.fn(async () => ({ ok: true })) }, Server: { health: vi.fn() } };
});

const upload = vi.mocked(Files.upload);
const health = vi.mocked(Server.health);
const T = (key: Parameters<typeof translate>[1]) => translate('en', key);
const F = (key: Parameters<typeof translate>[1]) => translate('fa', key);
const HEALTH = { ok: true as const, service: 'amin-chat', time: 1, environment: 'production', endpoints: [], ai: { 'workers-ai': true, groq: true } };

describe('what the server can keep (capabilities)', () => {
  beforeEach(() => {
    resetCapabilities();
    health.mockReset();
  });

  it('only an explicit "no" switches files off: unknown, failed requests, older servers and a plain yes all keep them on', () => {
    expect(UNKNOWN_CAPABILITIES).toEqual({ files: true, known: false });
    expect(capabilitiesFrom({ storage: { files: false } })).toEqual({ files: false, known: true });
    expect(capabilitiesFrom({ storage: { files: true } })).toEqual({ files: true, known: true });
    expect(capabilitiesFrom({})).toEqual({ files: true, known: true }); // a server from before the field existed
    expect(capabilitiesFrom(null)).toEqual({ files: true, known: true });
    expect(capabilitiesFrom(undefined)).toEqual({ files: true, known: true });
    expect(capabilitiesFrom({ storage: {} as never })).toEqual({ files: true, known: true });
  });

  it('is read from the public health document, and a failed request changes nothing', async () => {
    health.mockResolvedValueOnce({ ...HEALTH, storage: { files: false } });
    await refreshCapabilities();
    expect(capabilitiesStore.get()).toEqual({ files: false, known: true });
    health.mockRejectedValueOnce(new ApiError(0, 'NETWORK', 'down'));
    await refreshCapabilities();
    expect(capabilitiesStore.get()).toEqual({ files: false, known: true }); // what was known stays known
    health.mockResolvedValueOnce({ ...HEALTH, storage: { files: true } });
    await refreshCapabilities();
    expect(capabilitiesStore.get()).toEqual({ files: true, known: true });
    resetCapabilities();
    expect(capabilitiesStore.get()).toEqual(UNKNOWN_CAPABILITIES);
    health.mockRejectedValueOnce(new Error('boom'));
    await expect(refreshCapabilities()).resolves.toBeUndefined();
    expect(capabilitiesStore.get()).toEqual(UNKNOWN_CAPABILITIES); // never switched off by a failure
  });
});

describe('the composer on a server without file storage', () => {
  let n = 0;
  const setup = () => {
    const onSend = vi.fn(async () => true as boolean | void);
    render(<Composer draftKey={`nofiles-${++n}`} placeholder="Message" maxChars={50} allowFiles onSend={onSend} />);
    return { onSend };
  };
  const lastToast = () => toastStore.get().at(-1);

  beforeEach(() => {
    setLocale('en');
    resetCapabilities();
    toastStore.set(() => []);
    upload.mockReset();
    window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  });
  afterEach(() => resetCapabilities());

  it('with file storage it offers attaching as always, and uploads what is chosen', async () => {
    upload.mockResolvedValue({ id: 'f1', name: 'a.txt', mime: 'text/plain', size: 1, kind: 'text', category: null, createdAt: 1 });
    capabilitiesStore.set({ files: true, known: true });
    setup();
    expect(screen.queryByTestId('attach-unavailable')).toBeNull();
    const attach = screen.getByRole('button', { name: T('attach.add') });
    expect(attach).not.toHaveAttribute('aria-disabled');
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  });

  it('without file storage the attach button says so (it looks disabled but stays tappable, because a phone has no tooltip) and nothing is uploaded', async () => {
    capabilitiesStore.set({ files: false, known: true });
    setup();
    expect(screen.queryByRole('button', { name: T('attach.add') })).toBeNull();
    const button = screen.getByTestId('attach-unavailable');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('aria-label', T('attach.unavailable'));
    expect(button).toHaveAttribute('title', T('attach.unavailable'));
    expect(button).toHaveClass('needs-setup');
    await userEvent.click(button);
    expect(lastToast()).toMatchObject({ kind: 'info', text: T('attach.unavailable') });
    expect(upload).not.toHaveBeenCalled();
  });

  it('files that arrive another way (paste, drop, the hidden input) are refused with the same reason, and not uploaded', () => {
    capabilitiesStore.set({ files: false, known: true });
    setup();
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] } });
    expect(upload).not.toHaveBeenCalled();
    expect(lastToast()).toMatchObject({ kind: 'error', text: T('attach.unavailable') });
    expect(screen.queryByLabelText(T('attach.files'))).toBeNull(); // no chip for a file that was never taken
  });

  it('follows the server answer while the composer is on screen', async () => {
    setup();
    expect(screen.queryByTestId('attach-unavailable')).toBeNull(); // unknown = available
    health.mockResolvedValueOnce({ ...HEALTH, storage: { files: false } });
    await refreshCapabilities();
    expect(await screen.findByTestId('attach-unavailable')).toBeInTheDocument();
  });

  it('the text of the reason exists in both languages and says what is wrong in each', () => {
    expect(T('attach.unavailable')).toMatch(/not connected/);
    expect(F('attach.unavailable')).toMatch(/وصل نیست/);
    expect(T('err.FILE_STORAGE_NOT_CONNECTED')).toMatch(/not connected/);
    expect(F('err.FILE_STORAGE_NOT_CONNECTED')).toMatch(/وصل نیست/);
    expect(T('storage.attention.r2_not_connected')).toMatch(/run the deployment again/);
    expect(F('storage.attention.r2_not_connected')).toMatch(/دوباره deploy کنید/);
  });
});
