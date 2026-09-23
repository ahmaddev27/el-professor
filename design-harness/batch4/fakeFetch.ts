/**
 * Answers the edge functions and GoTrue's settings route in the batch-4
 * harness, by replacing `window.fetch` before any screen mounts.
 *
 * The screens call these with a bare `fetch` (otpClient, authProviderSettings,
 * the manage-users calls in UserManagement, company-signup, the discount
 * check), so replacing fetch rather than a module leaves every one of those
 * call sites exactly as it ships. The URLs start with VITE_SUPABASE_URL, which
 * the harness's Vite config sets to https://harness.invalid; anything else is
 * passed to the real fetch (Vite's own module requests).
 *
 * What each route answers follows the scenario, and every request is recorded
 * in `window.__harness.writes` with its method and body, so flows-batch4.mjs can
 * check that a screen still sends what it sent before.
 */
import { userRows, type Row } from './fixtures';
import { answerLater, recordWrite } from './fakes/supabase';
import { HARNESS_GOOD_CODE, scenario } from './scenario';

const API = 'https://harness.invalid';
const realFetch = window.fetch.bind(window);

const users: Row[] = scenario.data === 'empty' ? [userRows()[0]] : userRows();
let attemptsLeft = 4;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function parseBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function manageUsers(route: string, method: string, body: Record<string, unknown>): Response {
  switch (route) {
    case 'list':
      if (scenario.data === 'error') return json(500, { success: false, error: 'Benutzer konnten nicht geladen werden' });
      return json(200, users.map(user => ({ ...user })));
    case 'create': {
      const email = String(body.email ?? '');
      if (users.some(user => user.email === email)) {
        return json(400, { success: false, error: 'Diese E-Mail-Adresse ist bereits registriert.' });
      }
      users.push({
        id: `00000000-0000-4000-8000-${String(users.length + 1).padStart(12, '0')}`,
        email,
        full_name: body.full_name,
        role: body.role,
        status: body.use_temp_password ? 'active' : 'pending_invite',
        must_change_password: Boolean(body.use_temp_password),
        created_at: new Date().toISOString(),
        company_id: users[0]?.company_id,
        is_super_admin: false,
      });
      return json(200, { success: true });
    }
    case 'update': {
      const user = users.find(candidate => candidate.id === body.user_id);
      if (user) Object.assign(user, { full_name: body.full_name, role: body.role, ...(body.email ? { email: body.email } : {}) });
      return json(200, { success: true });
    }
    case 'delete': {
      const index = users.findIndex(candidate => candidate.id === body.user_id);
      if (index >= 0) users.splice(index, 1);
      return json(200, { success: true });
    }
    case 'activate-deactivate': {
      const user = users.find(candidate => candidate.id === body.user_id);
      if (user) user.status = body.status;
      return json(200, { success: true });
    }
    case 'reset-password': {
      const user = users.find(candidate => candidate.id === body.user_id);
      if (user) user.must_change_password = true;
      return json(200, { success: true });
    }
    case 'resend-invite':
      return json(429, { success: false, reason: 'cooldown', retry_after_seconds: 42, error: 'Bitte warten' });
    default:
      return json(404, { success: false, error: `${method} ${route} is not in the harness` });
  }
}

function otpVerify(body: Record<string, unknown>): Response {
  if (body.code === HARNESS_GOOD_CODE) {
    return json(200, {
      ok: true,
      purpose: body.purpose,
      next: body.purpose === 'signup_verify' ? 'app' : 'set_password',
      session: { access_token: 'harness-access-token', refresh_token: 'harness-refresh-token', expires_in: 3600, expires_at: 0 },
    });
  }
  attemptsLeft = Math.max(0, attemptsLeft - 1);
  return attemptsLeft === 0
    ? json(200, { ok: false, reason: 'locked' })
    : json(200, { ok: false, reason: 'invalid_code', attempts_left: attemptsLeft });
}

function route(path: string, method: string, body: Record<string, unknown>): Response {
  if (path === '/auth/v1/settings') return json(200, { external: { google: scenario.google }, disable_signup: !scenario.google });
  if (path.startsWith('/functions/v1/manage-users/')) return manageUsers(path.slice('/functions/v1/manage-users/'.length), method, body);
  switch (path) {
    case '/functions/v1/otp-request':
      return json(202, { ok: true, cooldown_seconds: 60, expires_in_seconds: 600 });
    case '/functions/v1/otp-verify':
      return otpVerify(body);
    case '/functions/v1/company-signup':
      return json(200, { success: true, verification: { status: 'sent', cooldown_seconds: 60 } });
    case '/functions/v1/validate-discount-code':
      return String(body.code ?? '').toUpperCase() === 'HERBST10'
        ? json(200, {
            valid: true,
            discount_amount: Math.round(Number(body.current_price ?? 0) * 10) / 100,
            final_price: Math.round(Number(body.current_price ?? 0) * 90) / 100,
            german_message: 'Rabattcode angewendet: 10 % Rabatt',
          })
        : json(200, { valid: false, german_message: 'Dieser Rabattcode ist ungültig oder abgelaufen.' });
    case '/functions/v1/oauth-account':
      return body.action === 'register'
        ? json(200, { ok: true, company: { id: 'new-company', name: body.company_name }, discount: null })
        : json(200, { ok: true });
    default:
      return json(404, { error: `${method} ${path} is not in the harness` });
  }
}

window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(API)) return realFetch(input, init);
  const path = new URL(url).pathname;
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = parseBody(init);
  if (method !== 'GET') recordWrite(path, method, path.includes('otp-verify') ? { ...body, code: '••••••' } : body);
  const never = scenario.data === 'loading' && path.endsWith('/manage-users/list');
  return answerLater(() => route(path, method, body), never);
};
