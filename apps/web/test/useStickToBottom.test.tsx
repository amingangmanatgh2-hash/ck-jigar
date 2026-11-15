import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStickToBottom } from '../src/lib/useStickToBottom';

/** jsdom has no layout: give the scroller a height we control and a ResizeObserver we can trigger. */
let observers: { cb: () => void; targets: Element[] }[] = [];
class FakeResizeObserver {
  entry = { cb: () => undefined as void, targets: [] as Element[] };
  constructor(cb: () => void) {
    this.entry.cb = cb;
    observers.push(this.entry);
  }
  observe(el: Element) {
    this.entry.targets.push(el);
  }
  disconnect() {
    observers = observers.filter((o) => o !== this.entry);
  }
  unobserve() {}
}
const contentGrew = () => act(() => observers.forEach((o) => o.cb()));

let scrollHeight = 1000;
const CLIENT = 400;

function Harness({ k = 'a' }: { k?: string }) {
  const { scroller, inner, onScroll, showJump, toBottom } = useStickToBottom(k);
  return (
    <div>
      <div
        ref={(el) => {
          scroller.current = el;
          if (el) {
            Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
            Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => CLIENT });
          }
        }}
        data-testid="scroller"
        onScroll={onScroll}
      >
        <div ref={inner} />
      </div>
      {showJump && <button onClick={() => toBottom(false)}>jump</button>}
    </div>
  );
}

describe('useStickToBottom', () => {
  beforeEach(() => {
    observers = [];
    scrollHeight = 1000;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  });
  afterEach(() => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  });

  const scroller = () => document.querySelector('[data-testid=scroller]') as HTMLElement;
  const userScrollsTo = (top: number) => {
    scroller().scrollTop = top;
    act(() => void scroller().dispatchEvent(new Event('scroll')));
  };

  it('starts at the bottom and follows content that grows without any new message', () => {
    render(<Harness />);
    expect(scroller().scrollTop).toBe(1000);
    scrollHeight = 1600; // e.g. an approval card or the run panel appeared
    contentGrew();
    expect(scroller().scrollTop).toBe(1600);
  });

  it('stops following once the user scrolls up to read, and offers a jump button', () => {
    const { queryByText } = render(<Harness />);
    expect(queryByText('jump')).toBeNull();
    userScrollsTo(100); // far from the bottom (1000 - 100 - 400 = 500 px)
    scrollHeight = 1600;
    contentGrew();
    expect(scroller().scrollTop).toBe(100); // not yanked away from what they are reading
    expect(queryByText('jump')).not.toBeNull();
  });

  it('follows again after the user returns to the bottom, or presses the jump button', () => {
    const { getByText, queryByText } = render(<Harness />);
    userScrollsTo(100);
    act(() => getByText('jump').click());
    expect(scroller().scrollTop).toBe(1000);
    expect(queryByText('jump')).toBeNull();
    scrollHeight = 1300;
    contentGrew();
    expect(scroller().scrollTop).toBe(1300);
  });

  it('does not mistake its own scrolling for the user leaving the bottom', () => {
    render(<Harness />);
    // a big jump in content, pinned by us; the browser then fires a scroll event for OUR scroll
    scrollHeight = 5000;
    contentGrew();
    act(() => void scroller().dispatchEvent(new Event('scroll')));
    scrollHeight = 5200;
    contentGrew();
    expect(scroller().scrollTop).toBe(5200);
  });

  it('starts at the bottom again when the conversation changes', () => {
    const { rerender } = render(<Harness k="a" />);
    userScrollsTo(50);
    scrollHeight = 2000;
    rerender(<Harness k="b" />);
    expect(scroller().scrollTop).toBe(2000);
  });
});
