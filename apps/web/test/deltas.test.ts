import { describe, expect, it } from 'vitest';
import { applyDelta } from '../src/lib/deltas';

describe('applyDelta', () => {
  it('appends a piece that continues the text', () => {
    expect(applyDelta('Hel', { offset: 3, text: 'lo' })).toBe('Hello');
    expect(applyDelta('', { offset: 0, text: 'Hi' })).toBe('Hi');
  });

  it('treats a replayed piece as harmless (events can be delivered twice)', () => {
    expect(applyDelta('Hello', { offset: 3, text: 'lo' })).toBe('Hello');
    expect(applyDelta('Hello', { offset: 0, text: 'Hello' })).toBe('Hello');
  });

  it('adds only the unseen tail of an overlapping piece', () => {
    expect(applyDelta('Hello', { offset: 3, text: 'lo, world' })).toBe('Hello, world');
  });

  it('refuses a piece that starts beyond the end: something before it is missing', () => {
    expect(applyDelta('Hel', { offset: 5, text: 'x' })).toBeNull();
    expect(applyDelta('', { offset: 4, text: 'x' })).toBeNull();
  });

  it('appends when the server sends no offsets (older servers)', () => {
    expect(applyDelta('a', { text: 'b' })).toBe('ab');
  });

  it('keeps Persian text intact', () => {
    expect(applyDelta('حتماً', { offset: 5, text: '! سلام' })).toBe('حتماً! سلام');
  });
});
