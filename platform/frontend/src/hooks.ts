import { useEffect, useRef } from 'react';

/** Calls onClose when Escape is pressed while `active` is true. */
export function useEscape(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onClose]);
}

/**
 * Runs `fn` now and every `intervalMs` while enabled. Pauses while the tab is
 * hidden and refreshes as soon as it becomes visible again.
 */
export function usePolling(fn: () => unknown, intervalMs: number, enabled: boolean): void {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  }, [fn]);

  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      if (!document.hidden) void latest.current();
    };
    void latest.current();
    const timer = setInterval(run, intervalMs);
    document.addEventListener('visibilitychange', run);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  }, [enabled, intervalMs]);
}
