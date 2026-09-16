import { describe, expect, it } from 'vitest';
import {
  attemptUntilAnswered,
  PROFILE_LOAD_ATTEMPTS,
  PROFILE_LOAD_BACKOFF_MS,
} from './profileLoadRetry';

/** An attempt that answers on the nth try, and a record of what it was asked. */
function answersOnAttempt(n: number) {
  const state = { calls: 0 };
  return {
    state,
    attempt: async () => {
      state.calls += 1;
      return state.calls >= n;
    },
  };
}

/** Records every pause instead of taking it, so the tests do not wait. */
function recordedWaits() {
  const waited: number[] = [];
  return { waited, wait: async (ms: number) => { waited.push(ms); } };
}

describe('attemptUntilAnswered', () => {
  it('answers on the first try without pausing', async () => {
    const { state, attempt } = answersOnAttempt(1);
    const { waited, wait } = recordedWaits();

    await expect(attemptUntilAnswered(attempt, { wait })).resolves.toBe(true);
    expect(state.calls).toBe(1);
    expect(waited).toEqual([]);
  });

  it('retries a load that did not answer, and stops as soon as one does', async () => {
    const { state, attempt } = answersOnAttempt(2);
    const { waited, wait } = recordedWaits();

    await expect(attemptUntilAnswered(attempt, { wait })).resolves.toBe(true);
    expect(state.calls).toBe(2);
    // One pause, between the two attempts — never after the last one.
    expect(waited).toEqual([PROFILE_LOAD_BACKOFF_MS]);
  });

  it('gives up after the bounded attempts, so the screen can offer a way out', async () => {
    // The failed-first-load path: nothing ever answers, and the caller must be
    // told so rather than left waiting. `false` is what keeps `profileLoaded`
    // down, and what puts the retry and sign-out screen in front of the person.
    const { state, attempt } = answersOnAttempt(Number.POSITIVE_INFINITY);
    const { waited, wait } = recordedWaits();

    await expect(attemptUntilAnswered(attempt, { wait })).resolves.toBe(false);
    expect(state.calls).toBe(PROFILE_LOAD_ATTEMPTS);
    // Linear backoff, and no pause after the attempt that gave up.
    expect(waited).toEqual([PROFILE_LOAD_BACKOFF_MS, PROFILE_LOAD_BACKOFF_MS * 2]);
  });

  it('keeps the whole wait short enough to sit through', () => {
    const total = Array.from({ length: PROFILE_LOAD_ATTEMPTS - 1 }, (_, i) => PROFILE_LOAD_BACKOFF_MS * (i + 1))
      .reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeLessThanOrEqual(1500);
  });

  it('takes the attempt count from its caller', async () => {
    const { state, attempt } = answersOnAttempt(Number.POSITIVE_INFINITY);
    const { wait } = recordedWaits();

    await expect(attemptUntilAnswered(attempt, { attempts: 1, wait })).resolves.toBe(false);
    expect(state.calls).toBe(1);
  });
});
