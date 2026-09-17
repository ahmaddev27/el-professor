/**
 * The bounded retry AuthContext puts around one profile load.
 *
 * The profile decides every gate in App: a load that never answered must never
 * be read as "this account has no profile row", so `profileLoaded` is raised
 * only by a query that came back. That is the safe direction, and on its own it
 * would leave a first load that failed on an indefinite spinner — the session
 * reloads the profile only on a token refresh or a page reload, which can be
 * the better part of an hour away.
 *
 * So the attempt is repeated a few times before the screen gives up and offers
 * a way out. The backoff is linear and short (400 ms, then 800 ms): together
 * under one and a half seconds, which a person waits through without noticing,
 * and long enough to ride out the blip that usually causes this.
 *
 * Kept pure, and separate from AuthContext, for one reason: AuthContext cannot
 * be imported in the test environment. `lib/supabase` reads
 * `window.location.origin` at module load, and vitest runs in `node` with no
 * DOM, so the policy is tested here instead of through the provider.
 */

/** Total attempts, the first one included. */
export const PROFILE_LOAD_ATTEMPTS = 3;

/** Multiplied by the attempt number, so the pauses are 400 ms and then 800 ms. */
export const PROFILE_LOAD_BACKOFF_MS = 400;

export interface AttemptOptions {
  attempts?: number;
  backoffMs?: number;
  /** Injected by the tests; production waits with setTimeout. */
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

/**
 * Runs `attempt` until it reports that it answered, or until the attempts are
 * used up. `attempt` returns whether the query answered — **not** whether it
 * found anything: a profile that answered "no row" is an answer, and the caller
 * treats it as one.
 *
 * Returns true when some attempt answered, false when none did. It never
 * throws: an attempt is expected to report a failure, not raise one.
 */
export async function attemptUntilAnswered(
  attempt: () => Promise<boolean>,
  options: AttemptOptions = {},
): Promise<boolean> {
  const attempts = options.attempts ?? PROFILE_LOAD_ATTEMPTS;
  const backoffMs = options.backoffMs ?? PROFILE_LOAD_BACKOFF_MS;
  const wait = options.wait ?? sleep;

  for (let attemptNumber = 1; attemptNumber <= attempts; attemptNumber++) {
    if (await attempt()) return true;
    if (attemptNumber < attempts) await wait(backoffMs * attemptNumber);
  }
  return false;
}
