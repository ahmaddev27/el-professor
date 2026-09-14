import { spawn, type ChildProcess } from 'node:child_process';
import { Mailpit } from './mailpit';

// Mailpit listens only on the host's loopback. Until mail-staging.elprofessor.eu
// resolves, the suite reaches it through an SSH tunnel it opens here and closes
// when the run ends. With an https E2E_MAILPIT_URL no tunnel is needed.
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

  const mailpit = Mailpit.fromEnv();
  const deadline = Date.now() + 20_000;
  while (!(await mailpit.isReachable())) {
    if (Date.now() > deadline) {
      tunnel?.kill();
      throw new Error(`Mailpit is not reachable at ${url.origin} — check the SSH tunnel and the e2e Mailpit login (npm run setup)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return async () => {
    tunnel?.kill();
  };
}
