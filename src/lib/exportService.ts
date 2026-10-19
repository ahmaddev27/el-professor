/**
 * The one network seam to the Excel export service.
 *
 * Every operational Excel file is written by the service (deploy/export-service)
 * and by nothing in the browser, because the companies receiving those files
 * check the writer. THERE IS NO FALLBACK, and that is the point: a file written
 * by a JavaScript library when the service is down would carry the wrong
 * signature and the user would never know. When the service cannot be reached
 * this module throws, the caller shows why, and no file exists.
 *
 * It sends the signed-in user's access token. The service asks GoTrue who that
 * is and refuses the anon key, which ships in this bundle and proves nothing.
 *
 * Exports used to work from `useDatabase`'s localStorage fallback when Supabase
 * was unreachable. They no longer do: the rows are still in the page, but the
 * service is a separate round trip.
 */
import type { WorkbookPayload } from './workbookContract';

export type ExportFailureKind =
  | 'unreachable' // fetch failed, or the gateway/service answered 502/503/504
  | 'timeout'
  | 'busy'
  | 'rate_limited'
  | 'unauthorized'
  | 'too_large'
  | 'rejected' // the service understood the request and will not write this content
  | 'server';

const RETRYABLE: ReadonlySet<ExportFailureKind> = new Set(['unreachable', 'timeout', 'busy', 'rate_limited', 'server']);

export interface ExportFailureDetail {
  code?: string;
  sheet?: string;
  row?: number;
  column?: number;
  requestId?: string;
  retryAfterSeconds?: number;
}

export class ExportServiceError extends Error {
  readonly kind: ExportFailureKind;
  readonly detail: ExportFailureDetail;

  constructor(kind: ExportFailureKind, detail: ExportFailureDetail = {}) {
    super(`export service: ${kind}${detail.code ? ` (${detail.code})` : ''}`);
    this.name = 'ExportServiceError';
    this.kind = kind;
    this.detail = detail;
  }

  /** Whether pressing the button again can help. Rejected content and a lost session cannot. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

export const EXPORT_TIMEOUT_MS = 60_000;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface ExportServiceDeps {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** The caller's access token, or null when there is no session. */
  getAccessToken?: () => Promise<string | null>;
  /** Asks for a fresh session after a 401; true when there is one. */
  refreshSession?: () => Promise<boolean>;
}

// The client is imported on use: supabase.ts reads `window` as it loads, and the
// seam must be testable without a browser.
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

function endpoint(baseUrl?: string): string {
  const base = (baseUrl ?? String(import.meta.env.VITE_SUPABASE_URL ?? '')).replace(/\/+$/, '');
  return `${base}/export/v1/workbook`;
}

/** Posts the payload and answers the workbook, or throws an ExportServiceError. */
export async function fetchWorkbook(payload: WorkbookPayload, deps: ExportServiceDeps = {}): Promise<Blob> {
  const getToken = deps.getAccessToken ?? currentAccessToken;
  const refresh = deps.refreshSession ?? refreshedSession;
  const body = JSON.stringify(payload);

  let token = await getToken();
  if (!token) throw new ExportServiceError('unauthorized');
  let response = await send(body, token, deps);
  if (response.status === 401 && (await refresh())) {
    token = await getToken();
    if (token) response = await send(body, token, deps);
  }
  return interpret(response);
}

async function send(body: string, token: string, deps: ExportServiceDeps): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? EXPORT_TIMEOUT_MS);
  try {
    return await (deps.fetchImpl ?? fetch)(endpoint(deps.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    // An aborted request is the timeout; anything else (DNS, TLS, a CORS-less 502
    // from a gateway with nothing behind it) is the service not being there.
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    throw new ExportServiceError(aborted ? 'timeout' : 'unreachable');
  } finally {
    clearTimeout(timer);
  }
}

interface ErrorBody {
  code?: string;
  request_id?: string;
  sheet?: string;
  row?: number;
  column?: number;
  retry_after?: number;
}

async function errorBody(response: Response): Promise<ErrorBody> {
  try {
    const parsed: unknown = await response.json();
    const error = (parsed as { error?: unknown } | null)?.error;
    return error && typeof error === 'object' ? (error as ErrorBody) : {};
  } catch {
    return {};
  }
}

function retryAfter(response: Response, body: ErrorBody): number | undefined {
  const header = Number(response.headers.get('Retry-After'));
  if (Number.isFinite(header) && header > 0) return header;
  return typeof body.retry_after === 'number' ? body.retry_after : undefined;
}

async function interpret(response: Response): Promise<Blob> {
  if (response.ok) return acceptedWorkbook(response);
  const body = await errorBody(response);
  const detail: ExportFailureDetail = {
    code: body.code,
    sheet: body.sheet,
    row: body.row,
    column: body.column,
    requestId: body.request_id ?? response.headers.get('X-Request-Id') ?? undefined,
    retryAfterSeconds: retryAfter(response, body),
  };
  throw new ExportServiceError(failureKind(response.status, body.code), detail);
}

function failureKind(status: number, code: string | undefined): ExportFailureKind {
  if (status === 401) return 'unauthorized';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status === 422) return 'rejected';
  if (status === 504) return code === 'timeout' ? 'timeout' : 'unreachable';
  if (status === 503) return code === 'busy' ? 'busy' : 'unreachable';
  if (status === 502) return 'unreachable';
  return 'server';
}

async function acceptedWorkbook(response: Response): Promise<Blob> {
  const type = response.headers.get('Content-Type') ?? '';
  // A proxy's own page with a 200 is not a workbook. Saving it as .xlsx would
  // hand the user a corrupt file, which is the one thing worse than a refusal.
  if (!type.startsWith(XLSX_MIME)) {
    throw new ExportServiceError('server', { requestId: response.headers.get('X-Request-Id') ?? undefined });
  }
  return response.blob();
}
