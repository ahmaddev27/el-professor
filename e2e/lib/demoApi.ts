/**
 * The demo company's own REST session, for fixtures the screens cannot make.
 *
 * It signs in as the DEMO Monatsplanung GmbH administrator — the same account
 * the browser specs use — so every write goes through the company's own RLS and
 * can only ever touch that one company. Nothing here knows a password: it is
 * read from E2E_DEMO_* in the gitignored e2e/.env.local.
 */
const apiOrigin = (): string => new URL(process.env.E2E_API_URL!).origin;

export interface DemoApi {
  companyId: string;
  userId: string;
  get(path: string): Promise<any[]>;
}

export async function demoApi(): Promise<DemoApi> {
  if (apiOrigin() !== 'https://api-staging.elprofessor.eu') {
    throw new Error(`E2E_API_URL must be staging's API, not ${apiOrigin()}`);
  }
  const key = process.env.E2E_ANON_KEY!;
  const login = await fetch(`${apiOrigin()}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.E2E_DEMO_EMAIL, password: process.env.E2E_DEMO_PASSWORD }),
  });
  if (!login.ok) throw new Error(`demo sign-in answered ${login.status}`);
  const session = await login.json() as { access_token: string; user: { id: string; email: string } };
  if (session.user.email !== process.env.E2E_DEMO_EMAIL) throw new Error('signed in as an unexpected account');

  const headers = {
    apikey: key,
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
  const call = async (path: string) => {
    const res = await fetch(`${apiOrigin()}/rest/v1/${path}`, { method: 'GET', headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : [];
  };
  const profile = await call(`user_profiles?select=company_id&user_id=eq.${session.user.id}`);
  const companyId = profile[0]?.company_id as string | undefined;
  if (!companyId) throw new Error('the demo account has no company');
  return {
    companyId,
    userId: session.user.id,
    get: call,
  };
}
