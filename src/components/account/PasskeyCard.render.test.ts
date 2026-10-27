import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonsLabelled, press, settle, textOf } from '../../test-utils/tree';
import { resetAuthProviderSettingsCache } from '../../lib/authProviderSettings';

/**
 * The account's passkey card: dark until the server says otherwise, and honest
 * about a list it could not read.
 *
 * As in `PasskeyButton.render.test.ts`, the browser capability is stubbed **on**
 * throughout so the server's answer is the only variable; without that every
 * case would pass in Node for the wrong reason.
 *
 * The dictionary is the real German one, so a key missing from it renders as the
 * key and fails here.
 */

const session = { access_token: 'session-token' };

vi.mock('../../lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session } }) } },
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'owner@example.test' } }),
}));
vi.mock('../../contexts/LanguageContext', async () => {
  const { translate } = await import('../../i18n');
  return {
    useTranslation: () => ({
      t: (key: never, vars?: never) => translate('de', key, vars),
      tPlural: () => '',
    }),
  };
});

const { default: PasskeyCard } = await import('./PasskeyCard');

interface ServerOptions {
  passkeysEnabled?: boolean;
  /** The passkey list, or a status for a read that fails. */
  rows?: unknown;
  listStatus?: number;
}

function server(options: ServerOptions = {}): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/auth/v1/settings')) {
      return new Response(JSON.stringify(
        options.passkeysEnabled ? { passkeys_enabled: true } : { external: { google: true } },
      ), { status: 200 });
    }
    if (url.endsWith('/auth/v1/passkeys')) {
      return options.listStatus && options.listStatus !== 200
        ? new Response(JSON.stringify({ message: 'nope' }), { status: options.listStatus })
        : new Response(JSON.stringify(options.rows ?? []), { status: 200 });
    }
    return new Response('unexpected route', { status: 500 });
  }));
}

function browserCanDoWebAuthn(): void {
  vi.stubGlobal('window', { PublicKeyCredential: class {} });
  vi.stubGlobal('navigator', { credentials: { get: () => {}, create: () => {} } });
}

async function draw(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(PasskeyCard)); });
  await settle();
  return renderer;
}

const passkey = (id: string, name: string) => ({
  id,
  friendly_name: name,
  created_at: '2026-10-27T08:00:00Z',
  last_used_at: null,
});

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

describe('PasskeyCard while the server reports no passkeys', () => {
  it('draws nothing, and asks for no list at all', async () => {
    server({ passkeysEnabled: false });
    const tree = await draw();

    expect(tree.toJSON()).toBeNull();
    const asked = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(call => String(call[0]));
    expect(asked).toEqual(['https://api.example.test/auth/v1/settings']);
  });

  it('draws nothing on a browser with no WebAuthn either', async () => {
    server({ passkeysEnabled: true });
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    expect(await draw().then(tree => tree.toJSON())).toBeNull();
  });
});

describe('PasskeyCard with passkeys on', () => {
  it('lists what the account holds, with the date in the product s own format', async () => {
    server({ passkeysEnabled: true, rows: [passkey('p1', 'iPhone von Ahmad'), passkey('p2', 'YubiKey')] });
    const text = textOf(await draw());

    expect(text).toContain('iPhone von Ahmad');
    expect(text).toContain('YubiKey');
    // German order, never US MM/DD, and in Europe/Berlin rather than the viewer's zone.
    expect(text).toContain('27.10.2026');
    expect(text).toContain('noch nie verwendet');
  });

  it('says a read failed instead of drawing an empty list', async () => {
    // An empty list is the claim "this account has no passkey". A failed read is
    // not evidence for it, and on this card it would invite the owner to add a
    // second passkey they already have.
    server({ passkeysEnabled: true, listStatus: 500 });
    const text = textOf(await draw());

    expect(text).toContain('Die Passkeys konnten nicht geladen werden.');
    expect(text).toContain('sie bedeutet nicht, dass keine Passkeys vorhanden sind');
    expect(text).not.toContain('Für dieses Konto ist noch kein Passkey registriert.');
    expect(buttonsLabelled(await draw(), 'Erneut laden')).toHaveLength(1);
  });

  it('says so plainly when there is none, once the read succeeded', async () => {
    server({ passkeysEnabled: true, rows: [] });
    const text = textOf(await draw());
    expect(text).toContain('Für dieses Konto ist noch kein Passkey registriert.');
    expect(text).not.toContain('konnten nicht geladen werden');
  });

  it('states the recovery story rather than leaving it to be discovered', async () => {
    server({ passkeysEnabled: true, rows: [passkey('p1', 'iPhone')] });
    const text = textOf(await draw());

    expect(text).toContain('Wenn Sie Ihr Gerät verlieren');
    expect(text).toContain('jedes Konto in El-Professor besitzt ein Passwort');
  });

  it('warns that the last passkey is the last one, and only then', async () => {
    server({ passkeysEnabled: true, rows: [passkey('p1', 'iPhone')] });
    const only = await draw();
    await press(buttonsLabelled(only, 'Entfernen')[0]);
    expect(textOf(only)).toContain('Das ist Ihr letzter Passkey.');

    server({ passkeysEnabled: true, rows: [passkey('p1', 'iPhone'), passkey('p2', 'YubiKey')] });
    const two = await draw();
    await press(buttonsLabelled(two, 'Entfernen')[0]);
    expect(textOf(two)).not.toContain('Das ist Ihr letzter Passkey.');
    expect(textOf(two)).toContain('kann danach nicht mehr zur Anmeldung verwendet werden');
  });

  it('asks for a re-authentication before adding one, and offers both methods only when one exists', async () => {
    server({ passkeysEnabled: true, rows: [] });
    const empty = await draw();
    expect(textOf(empty)).toContain('Bestätigen Sie zuerst, dass Sie es sind');
    expect(buttonsLabelled(empty, 'Mit Passwort bestätigen')).toHaveLength(1);
    // Nothing to assert with yet, so the passkey route would only fail.
    expect(buttonsLabelled(empty, 'Mit vorhandenem Passkey bestätigen')).toHaveLength(0);

    server({ passkeysEnabled: true, rows: [passkey('p1', 'iPhone')] });
    const one = await draw();
    expect(buttonsLabelled(one, 'Mit vorhandenem Passkey bestätigen')).toHaveLength(1);
  });

  it('withholds the password route until a password has been typed', async () => {
    server({ passkeysEnabled: true, rows: [] });
    const tree = await draw();
    expect(buttonsLabelled(tree, 'Mit Passwort bestätigen')[0].props.disabled).toBe(true);
  });

  it('stops offering to add one at the ceiling, and says why', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => passkey(`p${i}`, `Gerät ${i}`));
    server({ passkeysEnabled: true, rows });
    const tree = await draw();

    expect(textOf(tree)).toContain('Mehr als 10 Passkeys sind pro Konto nicht möglich.');
    expect(buttonsLabelled(tree, 'Mit Passwort bestätigen')).toHaveLength(0);
  });

  it('leaks no dictionary key', async () => {
    server({ passkeysEnabled: true, rows: [passkey('p1', 'iPhone')] });
    expect(textOf(await draw())).not.toContain('passkey.');
  });
});
