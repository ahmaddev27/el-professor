import { spawn, type ChildProcess } from 'node:child_process';
import { Mailpit } from './mailpit';
import { warmStaging } from './warmup';

// Mailpit listens only on the host's loopback. Until mail-staging.elprofessor.eu
// resolves, the suite reaches it through an SSH tunnel it opens here and closes
// when the run ends. With an https E2E_MAILPIT_URL no tunnel is needed.
//
// Staging is warmed here too, before the first test asserts anything: the first
// request after a release is answered by the gateway rather than by the app,
// and that is what four merges in a row failed on. lib/warmup.ts has the
// measurements.
export default async function globalSetup(): Promise<() => Promise<void>> {
  const url = new URL(process.env.E2E_MAILPIT_URL!);
  let tunnel: ChildProcess | undefined;

  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') {
    tunnel = spawn(
      'ssh',
      ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes', '-L', `${url.port}:127.0.0.1:8025`, process.env.E2E_SSH_HOST ?? 'elprofessor'],
      { stdio: 'ignore' },
    );
  }

  // Either step can fail, and neither may leave the tunnel behind: Playwright
  // never calls the teardown below when global setup throws.
  try {
    await waitForMailpit(url);
    await warmStaging();
  } catch (err) {
    tunnel?.kill();
    throw err;
  }

  return async () => {
    tunnel?.kill();
  };
}

async function waitForMailpit(url: URL): Promise<void> {
  const mailpit = Mailpit.fromEnv();
  const deadline = Date.now() + 20_000;
  while (!(await mailpit.isReachable())) {
    if (Date.now() > deadline) {
      throw new Error(`Mailpit is not reachable at ${url.origin} — check the SSH tunnel and the e2e Mailpit login (npm run setup)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
