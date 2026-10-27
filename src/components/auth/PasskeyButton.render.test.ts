import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settle, textOf } from '../../test-utils/tree';
import { resetAuthProviderSettingsCache } from '../../lib/authProviderSettings';

/**
 * The sign-in button draws nothing until the server says passkeys are on.
 *
 * This is the proof that the slice is safe to merge before the GoTrue upgrade,
 * and it is a measurement rather than an assertion about intent: the real
 * `authProviderSettings` runs against a stubbed `GET /auth/v1/settings`, so what
 * is varied is the server's own answer and nothing else.
 *
 * **The browser capability is stubbed ON throughout.** The gate has two halves —
 * the server's answer and `navigator.credentials` — and in Node the second is
 * absent, so without this stub every case would pass for the wrong reason and
 * the test would measure the test environment. With it on, the server's answer
 * is the only variable.
 *
 * The dictionary is the real German one, so a key missing from it renders as the
 * key and fails here.
 */

vi.mock('../../lib/supabase', () => ({ supabase: {}, appOrigin: 'https://app.example.test' }));
vi.mock('../../contexts/LanguageContext', async () => {
  const { translate } = await import('../../i18n');
  return { useTranslation: () => ({ t: (key: never) => translate('de', key), tPlural: () => '' }) };
});

const { default: PasskeyButton } = await import('./PasskeyButton');

function serverSettings(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

/** A browser that can run a ceremony, so the server's answer is the variable. */
function browserCanDoWebAuthn(): void {
  vi.stubGlobal('window', { PublicKeyCredential: class {} });
  vi.stubGlobal('navigator', { credentials: { get: () => {}, create: () => {} } });
}

async function draw(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(PasskeyButton, { divider: true })); });
  await settle();
  return renderer;
}

beforeEach(() => {
  resetAuthProviderSettingsCache();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://api.example.test');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
  browserCanDoWebAuthn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetAuthProviderSettingsCache();
});

describe('PasskeyButton, with the browser able', () => {
  it.each([
    // The first row is the server this ships against: GoTrue v2.170.0 predates
    // passkeys_enabled, so its answer simply has no such key.
    ['v2.170.0, which has no such field', { external: { google: true }, disable_signup: false }],
    ['the switch off', { external: { google: true }, passkeys_enabled: false }],
    ['the string "true" rather than true', { passkeys_enabled: 'true' }],
    ['nothing usable at all', null],
  ])('draws nothing when the server reports %s', async (_label, body) => {
    serverSettings(body);
    expect(await draw().then(tree => tree.toJSON())).toBeNull();
  });

  it('draws nothing when the settings request fails outright', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await draw().then(tree => tree.toJSON())).toBeNull();
  });

  it('draws the button once the server reports passkeys on', async () => {
    serverSettings({ external: { google: false }, passkeys_enabled: true });
    const tree = await draw();

    expect(tree.toJSON()).not.toBeNull();
    expect(textOf(tree)).toContain('Mit Passkey anmelden');
    // No key leaked through: the German dictionary carries every label here.
    expect(textOf(tree)).not.toContain('passkey.');
  });

  it('draws nothing on a browser with no WebAuthn, however the server answers', async () => {
    serverSettings({ passkeys_enabled: true });
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    expect(await draw().then(tree => tree.toJSON())).toBeNull();
  });

  it('owns its own spacing, so the signed-out card does not move while it is off', async () => {
    // GoogleButton's rule, and for the same reason: a wrapper on the screen
    // would still occupy its margin while this returns null.
    serverSettings({ passkeys_enabled: true });
    const tree = await draw();
    const root = tree.toJSON() as { props: { className: string } };
    expect(root.props.className).toContain('mt-5');
  });
});
