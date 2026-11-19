import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../src/components/ApprovalCard';
import { Ai } from '../src/lib/endpoints';
import { setLocale, translate } from '../src/lib/i18n';
import { approval } from './fixtures';

vi.mock('../src/lib/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/endpoints')>();
  return { ...actual, Ai: { ...actual.Ai, decide: vi.fn() } };
});

const decide = vi.mocked(Ai.decide);
const T = (key: Parameters<typeof translate>[1]) => translate('en', key);

describe('ApprovalCard', () => {
  beforeEach(() => {
    setLocale('en');
    decide.mockReset();
  });

  it('spells out what the AI wants to do and sends nothing until the user decides', () => {
    render(<ApprovalCard approval={approval()} />);
    expect(screen.getByText('Send a message to Reza')).toBeInTheDocument();
    expect(screen.getByText(T('tool.message_send'))).toBeInTheDocument();
    expect(screen.getByLabelText(T('approval.text'))).toHaveValue('I will be late');
    expect(screen.getByRole('button', { name: T('approval.approve') })).toBeEnabled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('sends the text the user EDITED, not the model’s draft', async () => {
    decide.mockResolvedValue({ approval: approval({ status: 'approved' }) });
    const onDecided = vi.fn();
    render(<ApprovalCard approval={approval()} onDecided={onDecided} />);
    const box = screen.getByLabelText(T('approval.text'));
    await userEvent.clear(box);
    await userEvent.type(box, 'Ten minutes late');
    await userEvent.click(screen.getByRole('button', { name: T('approval.approve') }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('ap1', 'approve', { text: 'Ten minutes late' }));
    expect(onDecided).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }));
  });

  it('approves without edits when nothing was changed', async () => {
    decide.mockResolvedValue({ approval: approval({ status: 'approved' }) });
    render(<ApprovalCard approval={approval()} />);
    await userEvent.click(screen.getByRole('button', { name: T('approval.approve') }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('ap1', 'approve', undefined));
  });

  it('rejects without sending any edits', async () => {
    decide.mockResolvedValue({ approval: approval({ status: 'rejected' }) });
    render(<ApprovalCard approval={approval()} />);
    await userEvent.type(screen.getByLabelText(T('approval.text')), ' (changed)');
    await userEvent.click(screen.getByRole('button', { name: T('approval.reject') }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('ap1', 'reject', undefined));
  });

  it('turns a list field into one item per line and back', async () => {
    decide.mockResolvedValue({ approval: approval({ status: 'approved' }) });
    const poll = approval({ action: 'poll_create', payload: { question: 'Lunch?', options: ['Pizza', 'Sushi'] }, editable: ['question', 'options'] });
    render(<ApprovalCard approval={poll} />);
    const options = screen.getByLabelText(new RegExp(T('approval.options')));
    expect(options).toHaveValue('Pizza\nSushi');
    await userEvent.type(options, '\nSalad');
    await userEvent.click(screen.getByRole('button', { name: T('approval.approve') }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('ap1', 'approve', { options: ['Pizza', 'Sushi', 'Salad'] }));
  });

  it('shows no buttons once it has been decided or has expired', () => {
    const { rerender } = render(<ApprovalCard approval={approval({ status: 'approved' })} />);
    expect(screen.queryByRole('button', { name: T('approval.approve') })).toBeNull();
    expect(screen.getByText(T('approval.status.approved'))).toBeInTheDocument();
    rerender(<ApprovalCard approval={approval({ status: 'expired' })} />);
    expect(screen.queryByRole('button', { name: T('approval.reject') })).toBeNull();
    expect(screen.getByText(T('approval.status.expired'))).toBeInTheDocument();
  });

  it('does not double-submit while a decision is in flight', async () => {
    let finish: (v: { approval: ReturnType<typeof approval> }) => void = () => undefined;
    decide.mockReturnValue(new Promise((r) => (finish = r)));
    render(<ApprovalCard approval={approval()} />);
    const approve = screen.getByRole('button', { name: T('approval.approve') });
    await userEvent.click(approve);
    await userEvent.click(approve);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: T('approval.reject') })).toBeDisabled();
    finish({ approval: approval({ status: 'approved' }) });
  });
});
