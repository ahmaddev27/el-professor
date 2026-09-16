import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Which address this run's password-reset test may spend a code on.
 *
 * ## Why a pool at all
 *
 * otp-request issues at most five codes per address per hour (`c_email_hourly`
 * in 20260915100100_otp_rpcs.sql, a SQL CONSTANT and a security control — not
 * something a test may lower). Past that it still answers 202, because the
 * answer must not reveal whether an account exists, so no mail is sent and the
 * test waits out its 45 s and fails as if the mailer were broken. That is
 * exactly what happened on PR #57's merge: confirmed in app_private.
 * otp_send_events as `email_hourly`, three refusals in 35 minutes, while every
 * earlier merge run shows `issued`.
 *
 * One shared address therefore caps the whole suite at five runs an hour. Six
 * addresses raise that to thirty, which is past the other limit in the same
 * file — twenty requests per IP per hour — so the binding constraint stops
 * being the one a normal day of merges can reach. setup-staging.sh seeds them
 * and writes the list into .env.local.
 *
 * ## The rotation, and how it degrades
 *
 * A counter file next to .env.local (gitignored by `*.local`) holds the last
 * index used. It is a hint, not a lock, and both ways it can be wrong are
 * survivable by design:
 *
 * - **Two runs starting in the same moment** can read the same value and pick
 *   the same address. Nothing is corrupted: they spend two of that address's
 *   five codes, and the run after them moves on. A lock would buy nothing here
 *   — the suite is `workers: 1` and is run one at a time.
 * - **A missing, unreadable or garbled counter** falls back to a *random*
 *   index, never to zero. Falling back to a fixed index is the tempting
 *   version and the wrong one: a machine that cannot keep the file would then
 *   send every run at the same address and rebuild the bug this replaces.
 *
 * The write is a temp file plus a rename, so a run killed mid-write leaves the
 * previous counter rather than half a number, and a counter that cannot be
 * written at all is ignored — the address for this run is already chosen.
 */

const COUNTER_FILE = resolve(__dirname, '..', '.reset-rotation.local');

function readCounter(size: number): number {
  try {
    const parsed = Number.parseInt(readFileSync(COUNTER_FILE, 'utf8').trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed % size;
  } catch {
    // Missing on a fresh checkout, and unreadable is not worth distinguishing.
  }
  return Math.floor(Math.random() * size);
}

function writeCounter(value: number): void {
  try {
    const temporary = `${COUNTER_FILE}.${process.pid}`;
    writeFileSync(temporary, `${value}\n`, { mode: 0o600 });
    renameSync(temporary, COUNTER_FILE);
  } catch {
    // The address is already chosen; losing the counter only costs the next
    // run its ordering, and that run falls back to a random index.
  }
}

/** The addresses setup-staging.sh seeded, in the order it wrote them. */
export function resetAddressPool(): string[] {
  const pool = (process.env.E2E_RESET_EMAILS ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address.length > 0);
  if (pool.length === 0) {
    throw new Error(
      'E2E_RESET_EMAILS is empty. Run "npm run setup" in e2e/ once; it seeds the ' +
        'password-reset accounts and writes the list into e2e/.env.local.',
    );
  }
  return pool;
}

/** Advances the rotation and returns the address this run may spend a code on. */
export function pickResetAddress(): string {
  const pool = resetAddressPool();
  const next = (readCounter(pool.length) + 1) % pool.length;
  writeCounter(next);
  return pool[next];
}
