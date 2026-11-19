import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Keeps a scrolling message list pinned to the newest content — also when the content grows *without* a new message
 * (a run panel expanding, an approval card appearing, an image loading) — unless the user scrolled up to read.
 *
 * Scroll events caused by our own pinning are recognised and ignored: otherwise a big content jump right after a
 * programmatic scroll looks like "the user scrolled away" and the list stops following.
 */
export function useStickToBottom(resetKey: unknown) {
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const ours = useRef<number | null>(null); // scrollTop we set ourselves, until its scroll event has been seen
  const [showJump, setShowJump] = useState(false);

  const pin = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setShowJump(false);
    if (smooth && typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      return;
    }
    el.scrollTop = el.scrollHeight;
    ours.current = el.scrollTop;
  }, []);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    if (ours.current !== null && Math.abs(el.scrollTop - ours.current) < 2) {
      ours.current = null;
      return; // the echo of our own scroll
    }
    ours.current = null;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    setShowJump(!near);
  }, []);

  // a different conversation: start at the bottom again
  useEffect(() => {
    pin();
  }, [resetKey, pin]);

  useEffect(() => {
    const content = inner.current;
    const el = scroller.current;
    if (!content || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stick.current) pin();
    });
    observer.observe(content);
    observer.observe(el); // the viewport itself can change (composer growing, on-screen keyboard)
    return () => observer.disconnect();
  }, [pin]);

  return { scroller, inner, stick, showJump, onScroll, toBottom: pin };
}
