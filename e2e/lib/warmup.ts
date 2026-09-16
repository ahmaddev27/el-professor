import { chromium, type Page } from '@playwright/test';

/**
 * Brings staging up, once, before any test asserts anything.
 *
 * ## What actually goes wrong without this
 *
 * The suite runs right after a staging release, and four merges in a row failed
 * on a `toBeVisible()` that passed when the test was re-run by itself. Two
 * different tests, and the artifact of the forgot-password one says why. It is
 * not slowness:
 *
 *     POST /functions/v1/otp-request  ->  502, ~130 ms on the wire
 *
 * The page had already rendered "Ein unerwarteter Fehler ist aufgetreten" while
 * the assertion was still waiting. That 502 is not the function's: main/index.ts
 * answers 401, 404 or its own JSON 500 and never 502, and the CORS preflight to
 * the same URL answered 200 a moment earlier — so the gateway reached the
 * runtime, and what failed was a cold boot of the *user worker* for
 * otp-request. src/lib/otpClient.ts reads a 5xx with no `ok` field as
 * `internal`, the screen shows its error box, and the assertion then waits out
 * its whole timeout for a notice that can no longer appear.
 *
 * A release is not what makes that worker cold, only what guarantees it: the
 * same 502 was reproduced here after ten quiet minutes, with no deploy
 * involved. So anyone whose "Passwort vergessen" is the first traffic in a
 * while meets it too. That is worth fixing on the product's side, and is not
 * something this suite can do.
 *
 * That is why the two earlier attempts did not help. PR #33 gave that assertion
 * 20 s and PR #40 gave every expect 15 s, but the error was on screen 0.45 s
 * after the click. No timeout can wait out an answer that already came.
 *
 * ## Why the staging-banner test is the same failure
 *
 * That test calls no edge function, so the 502 above cannot be its cause — but
 * both things it asserts, the heading and the banner, come from the bundle
 * alone. EnvironmentBanner keys off VITE_DEPLOY_ENV, baked in at build time,
 * and reads nothing over the network. So the only way both assertions fail is
 * that React never mounted: the document or the 4.4 MB bundle did not arrive as
 * the app. Same family as the 502 — a first request through the gateway, to a
 * stack that has gone cold, that does not produce the real answer.
 *
 * So the warm-up below does not merely load the page. It retries while the
 * navigation is answered by the gateway rather than the app, and it waits for
 * the SPA to actually mount, which is the condition both of those tests need
 * and neither of them states.
 *
 * ## Why a warm-up rather than a longer wait
 *
 * Booting a worker and filling a cache are preconditions of the tests, not part
 * of what they prove. Meeting them here makes the first assertion of the suite
 * face a stack that is already up — deterministic, where a bigger timeout only
 * makes the same red run slower. The retries below are bounded and belong to
 * the precondition; no test is retried, so a real regression still fails on the
 * first run, and a stack that never comes up fails *here*, by name, instead of
 * as a mystery assertion three steps into a test.
 *
 * ## Why these particular requests
 *
 * `{}` is the entire body sent to the functions. Both parse the body first and
 * answer 400 invalid_request before they reach the database, the rate limits or
 * the mailer (parseOtpRequest / parseOtpVerify in _shared/otp-core.ts), so
 * warming costs no code, no mail, and none of the budget forgot-password needs:
 * one code per address per minute, five per hour, twenty requests per IP per
 * hour. The anon key must be sent with them — main/index.ts checks it before it
 * creates the worker, so a warm-up without it is refused at the door and boots
 * nothing.
 *
 * The app shell is warmed through a real browser rather than fetch(): the
 * bundle is 4.4 MB, served compressed, and the cold fetch of it in the failure
 * trace took 31 s of that test's 90 s budget. A plain fetch would negotiate a
 * different encoding and warm a variant no test ever asks for. That page load
 * also warms PostgREST, through the get_public_config AppConfigProvider issues
 * on mount.
 */

/** At or above this, the gateway answered and the thing behind it did not. */
const GATEWAY_FAILURE_STATUS = 500;

/**
 * Pauses grow — 3 s, 6 s, 9 s … capped — because retrying is not free here.
 * Every POST makes main/index.ts call userWorkers.create again, and each worker
 * asks for 256 MB, so pressing a runtime that is already struggling to start
 * one is a way to stop it ever starting. Measured on staging: a warm-up firing
 * one request every 2 s watched otp-request answer 502 six times in 14 s and
 * never come up, while single requests a couple of minutes later were served in
 * ~2 s. Waiting longer between tries is the cheaper half of this fix.
 */
const RETRY_PAUSE_STEP_MS = 3_000;
const RETRY_PAUSE_CAP_MS = 15_000;

const FUNCTION_ATTEMPTS = 7;
/** Long enough that a request being served through a slow boot is not cut off. */
const FUNCTION_TIMEOUT_MS = 30_000;

/** The cold bundle took 31 s in the failure trace; this is that with room to spare. */
const PAGE_ATTEMPTS = 3;
const PAGE_LOAD_TIMEOUT_MS = 60_000;
const MOUNT_TIMEOUT_MS = 15_000;

/**
 * The edge functions the suite calls. Each is its own worker with its own first
 * boot, so warming one does not warm the other.
 */
const FUNCTIONS = ['otp-request', 'otp-verify'] as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing. Run "npm run setup" in e2e/ once; it writes e2e/.env.local.`);
  return value;
}

/** What one probe saw, and whether it means the thing behind it is up. */
type Probe = { ready: boolean; detail: string };

const message = (err: unknown): string =>
  err instanceof Error ? err.message.split('\n')[0] : String(err);

/**
 * Repeats a probe until the thing behind it serves, and fails by name when it
 * never does. The only retry loop in this suite, and it guards a precondition
 * rather than an assertion.
 */
async function untilServing(label: string, attempts: number, probe: () => Promise<Probe>): Promise<void> {
  const startedAt = Date.now();
  let last = '';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { ready, detail } = await probe();
    last = detail;
    if (ready) {
      // Said out loud on purpose: a start that needed more than one try is the
      // very thing that used to fail the suite, and it should stay readable in
      // the log now that it no longer does.
      const tries = attempt === 1 ? '1 try' : `${attempt} tries`;
      console.log(`  ${label}: ready after ${tries}, ${Date.now() - startedAt} ms (${detail})`);
      return;
    }
    console.log(`  ${label}: ${detail} on try ${attempt} — still coming up`);
    if (attempt < attempts) await sleep(Math.min(attempt * RETRY_PAUSE_STEP_MS, RETRY_PAUSE_CAP_MS));
  }

  const seconds = Math.round((Date.now() - startedAt) / 1_000);
  throw new Error(
    `${label} never served in ${attempts} tries over ${seconds} s; the last answer was ${last}. ` +
      'Staging is not up — check it before reading anything this suite reports.',
  );
}

/**
 * Ready means the *function* answered, not merely that something did.
 * main/index.ts refuses a bad key with 401 and an unknown name with 404 before
 * it ever creates the worker, so neither of those proves the boot this warm-up
 * exists to force. The 400 the function itself gives a body it cannot parse
 * does prove it: that line runs inside the worker.
 */
async function probeFunction(name: string): Promise<Probe> {
  try {
    const response = await fetch(`${new URL(required('E2E_API_URL')).origin}/functions/v1/${name}`, {
      method: 'POST',
      headers: { apikey: required('E2E_ANON_KEY'), 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(FUNCTION_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as { ok?: unknown; reason?: unknown } | null;
    const answered = body?.ok === false && body.reason === 'invalid_request';
    return answered
      ? { ready: true, detail: `HTTP ${response.status} invalid_request` }
      : { ready: false, detail: `HTTP ${response.status}, not the function's own answer` };
  } catch (err) {
    return { ready: false, detail: message(err) };
  }
}

/** Ready means the SPA mounted, not merely that the document answered 200. */
async function probeAppShell(page: Page): Promise<Probe> {
  let status: number;
  try {
    const response = await page.goto('/login', { waitUntil: 'load', timeout: PAGE_LOAD_TIMEOUT_MS });
    if (!response) return { ready: false, detail: 'the navigation produced no response' };
    status = response.status();
  } catch (err) {
    return { ready: false, detail: message(err) };
  }
  if (status >= GATEWAY_FAILURE_STATUS) return { ready: false, detail: `HTTP ${status} from the gateway` };

  try {
    await page.waitForSelector('#root > *', { timeout: MOUNT_TIMEOUT_MS });
  } catch {
    return { ready: false, detail: `HTTP ${status}, but the app did not mount` };
  }
  return { ready: true, detail: `HTTP ${status}, app mounted` };
}

async function warmAppShell(): Promise<void> {
  const baseURL = required('E2E_BASE_URL');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({
      baseURL,
      // The same origin pin the config uses, so the staging login is never sent
      // to the API host or anywhere else.
      httpCredentials: {
        username: required('E2E_STAGING_USER'),
        password: required('E2E_STAGING_PASS'),
        origin: new URL(baseURL).origin,
      },
    });
    const page = await context.newPage();
    await untilServing('app shell', PAGE_ATTEMPTS, () => probeAppShell(page));
  } finally {
    await browser.close();
  }
}

/**
 * Warms the app shell, then each function in turn. In turn, not at once: the
 * workers share one runtime, and starting them together is the load the cold
 * boot already fails under.
 */
export async function warmStaging(): Promise<void> {
  console.log('Warming staging before the first assertion:');
  await warmAppShell();
  for (const name of FUNCTIONS) {
    await untilServing(name, FUNCTION_ATTEMPTS, () => probeFunction(name));
  }
}
