import { useEffect, useReducer } from 'react';
import { secondsRemaining } from '../lib/otpUi';

/**
 * Whole seconds until `untilMs`, re-rendering once per second while it counts.
 *
 * The value is computed from the clock on every render rather than stored, so
 * the first render after a new deadline is already right instead of showing
 * the previous countdown for a frame.
 */
export function useCountdown(untilMs: number | null): number {
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (untilMs === null) return;
    let shown = secondsRemaining(untilMs, Date.now());
    if (shown === 0) return;

    const id = window.setInterval(() => {
      const next = secondsRemaining(untilMs, Date.now());
      if (next !== shown) {
        shown = next;
        rerender();
      }
      if (next === 0) window.clearInterval(id);
    }, 250);
    return () => window.clearInterval(id);
  }, [untilMs]);

  return secondsRemaining(untilMs, Date.now());
}
