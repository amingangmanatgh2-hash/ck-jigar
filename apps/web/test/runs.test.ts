import { describe, expect, it } from 'vitest';
import { isActiveRun, mergeApproval, mergeStep, newerRun, pendingApprovals, statusTone } from '../src/lib/runs';
import { approval, run, step } from './fixtures';

describe('newerRun', () => {
  it('accepts the first snapshot', () => {
    const r = run();
    expect(newerRun(undefined, r)).toBe(r);
  });

  it('ignores a stale snapshot: "pending" from the HTTP response after the socket said "running"', () => {
    const live = run({ status: 'running', steps: [step()] });
    expect(newerRun(live, run({ status: 'pending' }))).toBe(live);
    expect(newerRun(live, run({ status: 'planning' }))).toBe(live);
  });

  it('never leaves a final state', () => {
    const done = run({ status: 'completed' });
    expect(newerRun(done, run({ status: 'running' }))).toBe(done);
    expect(newerRun(done, run({ status: 'awaiting_approval' }))).toBe(done);
  });

  it('moves forward, including between the two middle states', () => {
    expect(newerRun(run({ status: 'running' }), run({ status: 'awaiting_approval' })).status).toBe('awaiting_approval');
    expect(newerRun(run({ status: 'awaiting_approval' }), run({ status: 'running' })).status).toBe('running');
    expect(newerRun(run({ status: 'running' }), run({ status: 'failed' })).status).toBe('failed');
  });

  it('keeps the fuller list of steps and approvals', () => {
    const prev = run({ status: 'running', steps: [step({ id: 'a' }), step({ id: 'b' })], approvals: [approval()] });
    const next = run({ status: 'running', steps: [step({ id: 'a' })], approvals: [] });
    const merged = newerRun(prev, next);
    expect(merged.steps).toHaveLength(2);
    expect(merged.approvals).toHaveLength(1);
  });
});

describe('run helpers', () => {
  it('knows which runs are still going', () => {
    expect(isActiveRun(run({ status: 'pending' }))).toBe(true);
    expect(isActiveRun(run({ status: 'awaiting_approval' }))).toBe(true);
    expect(isActiveRun(run({ status: 'completed' }))).toBe(false);
    expect(isActiveRun(run({ status: 'cancelled' }))).toBe(false);
    expect(isActiveRun(null)).toBe(false);
  });

  it('lists only approvals that still wait for a decision', () => {
    const r = run({ approvals: [approval({ id: 'a1' }), approval({ id: 'a2', status: 'approved' }), approval({ id: 'a3', status: 'expired' })] });
    expect(pendingApprovals(r).map((a) => a.id)).toEqual(['a1']);
    expect(pendingApprovals(null)).toEqual([]);
  });

  it('merges a step and an approval by id, in place', () => {
    const r = run({ steps: [step({ id: 'a', status: 'pending' })], approvals: [approval({ id: 'x' })] });
    expect(mergeStep(r, step({ id: 'a', status: 'completed' })).steps).toEqual([expect.objectContaining({ id: 'a', status: 'completed' })]);
    expect(mergeStep(r, step({ id: 'b' })).steps.map((s) => s.id)).toEqual(['a', 'b']);
    expect(mergeApproval(r, approval({ id: 'x', status: 'approved' })).approvals[0]!.status).toBe('approved');
  });

  it('gives every status a tone for the UI', () => {
    expect(statusTone('failed')).toBe('bad');
    expect(statusTone('completed')).toBe('ok');
    expect(statusTone('awaiting_approval')).toBe('warn');
  });
});
