import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
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
 * exactly what happened on PR #57's merge: confirmed in
 * app_private.otp_send_events as `email_hourly`, three refusals in 35 minutes,
 * while every earlier merge run shows `issued`.
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
 * index used. It is a hint, not a lock, and every way it can be wrong has to
 * end somewhere other than "every run draws the same address", because that is
 * the bug this replaces.
 *
 * - **Two runs starting in the same moment** can read the same value and draw
 *   the same address. Nothing is corrupted: they spend two of that address's
 *   five codes, and the run after them moves on. A lock would buy nothing —
 *   the suite is `workers: 1` and is run one at a time.
 * - **Missing, unreadable or garbled** falls back to a random index. Note what
 *   the property is: *not deterministic*, rather than "never zero" — the draw
 *   can legitimately land on index 0, and `pickResetAddress` adds one to it
 *   anyway. Do not "fix" the randomness into a constant; a fixed fallback on a
 *   machine that cannot keep the file sends every run at the same address.
 * - **Readable but not writable** is the one that needs saying out loud,
 *   because it is the case that silently defeats the two above: the read
 *   succeeds, so nothing looks wrong, and the same stale value comes back on
 *   every run. On Windows it is the likely path rather than an exotic one —
 *   `renameSync` is MoveFileExW with MOVEFILE_REPLACE_EXISTING, which, unlike
 *   POSIX rename(2), fails when the destination is held open by another
 *   process such as a virus scanner or a file-sync client. So a failed write
 *   is both warned about and answered by drawing at random, which keeps the
 *   runs spread out even while the counter is stuck.
 *
 * The write is a temp file plus a rename, so a run killed mid-write leaves the
 * previous counter rather than half a number. The temp name ends in `.local`
 * too, so a killed run leaves nothing untracked behind either.
 */

const COUNTER_FILE = resolve(__dirname, '..', '.reset-rotation.local');

function readCounter(size: number): number {
  try {
    const parsed = Number.parseInt(readFileSync(COUNTER_FILE, 'utf8').trim(), 10);
    // `>= 0` is load-bearing: a negative value would survive `% size` as a
    // negative index, since JavaScript's `%` keeps the sign of the dividend.
    if (Number.isInteger(parsed) && parsed >= 0) return parsed % size;
  } catch {
    // Missing on a fresh checkout, and unreadable is not worth distinguishing.
  }
  return Math.floor(Math.random() * size);
}

/** False when the rotation could not be persisted, so the caller can react. */
function writeCounter(value: number): boolean {
  const temporary = resolve(__dirname, '..', `.reset-rotation.${process.pid}.local`);
  try {
    writeFileSync(temporary, `${value}\n`, { mode: 0o600 });
    renameSync(temporary, COUNTER_FILE);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`Could not persist the reset-address rotation to ${COUNTER_FILE}: ${reason}`);
    try {
      unlinkSync(temporary);
    } catch {
      // It may never have been created; there is nothing to clean up.
    }
    return false;
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
  if (writeCounter(next)) return pool[next];

  // The counter is stuck, so the next run would read the same stale value and
  // draw this same address, and the one after that too. Drawing at random keeps
  // the runs spread over the pool until someone fixes the file.
  console.warn('The rotation is not being persisted — drawing this run\'s address at random.');
  return pool[Math.floor(Math.random() * pool.length)];
}
