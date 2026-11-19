import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Admin } from '../src/lib/endpoints';
import { setLocale, translate } from '../src/lib/i18n';
import { StorageSection } from '../src/screens/Settings';
import { toastStore } from '../src/state/toast';
import { storageStatus } from './fixtures';

vi.mock('../src/lib/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/endpoints')>();
  return { ...actual, Admin: { ...actual.Admin, storage: vi.fn(), checkStorage: vi.fn(), offloadNow: vi.fn() } };
});

const storage = vi.mocked(Admin.storage);
const check = vi.mocked(Admin.checkStorage);
const offload = vi.mocked(Admin.offloadNow);
const T = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars);
const lastToast = () => toastStore.get().at(-1);

describe('StorageSection (administrators)', () => {
  beforeEach(() => {
    setLocale('en');
    toastStore.set(() => []);
    storage.mockReset();
    check.mockReset();
    offload.mockReset();
  });

  it('shows both tiers and the policy in plain words', async () => {
    storage.mockResolvedValue(storageStatus({ lastRunAt: Date.UTC(2026, 10, 14, 10, 30) }));
    render(<StorageSection />);
    expect(await screen.findByText(T('storage.health.ok'))).toBeInTheDocument();
    expect(screen.getByText(T('storage.hot'))).toBeInTheDocument();
    expect(screen.getByText(T('storage.cold'))).toBeInTheDocument();
    expect(screen.getByText(/after 7 days, or when they are larger than 5 MB/)).toBeInTheDocument();
    expect(screen.queryByTestId('storage-attention')).toBeNull();
  });

  it.each([
    ['auth_failed', 'drive_auth_failed', /drive:token/],
    ['quota_full', 'drive_full', /full/],
    ['degraded', 'drive_degraded', /retries automatically/],
  ] as const)('explains a %s connection and what to do about it', async (health, attention, words) => {
    storage.mockResolvedValue(storageStatus({ attention, cold: { health, error: 'invalid_grant: Token has been expired or revoked.' } }));
    render(<StorageSection />);
    const banner = await screen.findByTestId('storage-attention');
    expect(banner).toHaveAttribute('data-attention', attention);
    expect(banner).toHaveTextContent(words);
    expect(screen.getByTestId('drive-health')).toHaveAttribute('data-health', health);
    expect(screen.getByText(T(`storage.health.${health}`))).toBeInTheDocument();
    // Google's own (English) message is only a collapsed technical detail
    expect(screen.getByText(T('storage.detail'))).toBeInTheDocument();
  });

  it('is honest that without Drive nothing moves, and offers no buttons that cannot work', async () => {
    storage.mockResolvedValue(storageStatus({ attention: 'r2_filling_without_drive', cold: { configured: false, health: 'not_configured', files: 0, bytes: 0 } }));
    render(<StorageSection />);
    expect(await screen.findByText(T('storage.health.not_configured'))).toBeInTheDocument();
    expect(screen.getByTestId('storage-attention')).toHaveTextContent(/Drive is not connected/);
    expect(screen.getByRole('button', { name: T('storage.check') })).toBeDisabled();
    expect(screen.getByRole('button', { name: T('storage.offload') })).toBeDisabled();
  });

  it('tests the connection for real and reports the outcome', async () => {
    storage.mockResolvedValue(storageStatus({ attention: 'drive_auth_failed', cold: { health: 'auth_failed' } }));
    check.mockResolvedValue(storageStatus({ cold: { health: 'ok', account: { used: 2 * 1024 ** 3, limit: 15 * 1024 ** 3 } } }));
    render(<StorageSection />);
    await userEvent.click(await screen.findByRole('button', { name: T('storage.check') }));
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(T('storage.health.ok'))).toBeInTheDocument();
    expect(screen.getByText(/2 GB of 15 GB used/)).toBeInTheDocument();
    expect(screen.queryByTestId('storage-attention')).toBeNull();
    expect(lastToast()).toMatchObject({ kind: 'success', text: T('storage.checkOk') });
  });

  it('reports what the manual job run did, including partial failure', async () => {
    storage.mockResolvedValue(storageStatus());
    offload.mockResolvedValueOnce({ report: { skipped: null, moved: 3, bytes: 10, failed: 0, purged: 0 }, status: storageStatus() });
    offload.mockResolvedValueOnce({ report: { skipped: 'nothing_to_do', moved: 0, bytes: 0, failed: 0, purged: 0 }, status: storageStatus() });
    offload.mockResolvedValueOnce({ report: { skipped: null, moved: 0, bytes: 0, failed: 2, purged: 0 }, status: storageStatus() });
    render(<StorageSection />);
    const button = await screen.findByRole('button', { name: T('storage.offload') });
    await userEvent.click(button);
    await waitFor(() => expect(lastToast()?.text).toBe(T('storage.moved', { n: 3 })));
    await userEvent.click(button);
    await waitFor(() => expect(lastToast()?.text).toBe(T('storage.nothing')));
    await userEvent.click(button);
    await waitFor(() => expect(lastToast()).toMatchObject({ kind: 'error', text: T('storage.someFailed', { n: 2 }) }));
  });

  it('speaks Persian, right to left, with Persian digits', async () => {
    setLocale('fa');
    storage.mockResolvedValue(storageStatus({ attention: 'drive_full', cold: { health: 'quota_full' } }));
    render(<StorageSection />);
    expect(await screen.findByText(translate('fa', 'storage.health.quota_full'))).toBeInTheDocument();
    expect(screen.getByTestId('storage-attention')).toHaveTextContent('فضای Google Drive متصل پر است');
    expect(screen.getByText(/۱۲ فایل/)).toBeInTheDocument();
  });
});
