import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Puts the E2E admin's password back to the value in .env.local. Tests that
 * change it (password reset) call this afterwards, so the next test and the
 * next run can still sign in.
 */
export function resetAdminPassword(): void {
  const result = spawnSync('bash', ['setup-staging.sh', '--reset-admin-password'], {
    cwd: resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Resetting the E2E admin password failed:\n${result.stdout}\n${result.stderr}`);
  }
}
