/**
 * The one way the browser posts to an edge function that answers a person: the
 * transport of travelRouteClient and geocodeClient, and nothing of either's
 * contract.
 *
 * It sends the signed-in user's access token (the functions ask GoTrue who that
 * is, and refuse the anon key, which ships in this bundle and proves nothing),
 * waits for a bounded time, asks for a fresh session once after a 401, and
 * never throws: what it returns is either "there was no session", "nothing
 * answered", or what the function answered, for the caller to read with its own
 * parser.
 */

export interface EdgeCallDeps {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** The caller's access token, or null when there is no session. */
  getAccessToken?: () => Promise<string | null>;
  /** Asks for a fresh session after a 401; true when there is one. */
  refreshSession?: () => Promise<boolean>;
}

export type EdgeOutcome =
  | { readonly kind: 'no_session' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'answered'; readonly status: number; readonly body: unknown };

// Imported on use: supabase.ts reads `window` as it loads, and the seam must be testable without a browser.
async function currentAccessToken(): Promise<string | null> {
  const { supabase } = await import('./supabase');
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function refreshedSession(): Promise<boolean> {
  const { supabase } = await import('./supabase');
  const { data, error } = await supabase.auth.refreshSession();
  return !error && !!data.session;
}

function endpoint(name: string, baseUrl?: string): string {
  const base = (baseUrl ?? String(import.meta.env.VITE_SUPABASE_URL ?? '')).replace(/\/+$/, '');
  return `${base}/functions/v1/${name}`;
}

interface Exchange {
  readonly status: number;
  readonly body: unknown;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text(); // an abort lands here and is the timeout
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** null when the request never produced an answer: no connection, or no answer in time. */
async function exchange(name: string, payload: string, token: string, deps: EdgeCallDeps, timeoutMs: number): Promise<Exchange | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (deps.fetchImpl ?? fetch)(endpoint(name, deps.baseUrl), {
      method: 'POST',
      headers: {
        apikey: String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: payload,
      signal: controller.signal,
    });
    return { status: response.status, body: await readJson(response) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function tokenOrNull(deps: EdgeCallDeps): Promise<string | null> {
  try {
    return await (deps.getAccessToken ?? currentAccessToken)();
  } catch {
    return null;
  }
}

async function refreshed(deps: EdgeCallDeps): Promise<boolean> {
  try {
    return await (deps.refreshSession ?? refreshedSession)();
  } catch {
    return false;
  }
}

/** Posts `payload` (already JSON text) to the function `name`. `defaultTimeoutMs` applies when the deps name none. */
export async function postToEdgeFunction(name: string, payload: string, deps: EdgeCallDeps, defaultTimeoutMs: number): Promise<EdgeOutcome> {
  const timeoutMs = deps.timeoutMs ?? defaultTimeoutMs;
  let token = await tokenOrNull(deps);
  if (!token) return { kind: 'no_session' };
  let answer = await exchange(name, payload, token, deps, timeoutMs);
  if (answer?.status === 401 && (await refreshed(deps))) {
    token = await tokenOrNull(deps);
    if (token) answer = await exchange(name, payload, token, deps, timeoutMs);
  }
  return answer ? { kind: 'answered', status: answer.status, body: answer.body } : { kind: 'unreachable' };
}
