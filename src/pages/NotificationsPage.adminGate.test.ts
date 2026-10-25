import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settle, textOf } from '../test-utils/tree';
import { callsOf, type FakeCall } from '../test-utils/fakeSupabase';

/**
 * Benachrichtigungen: the switches and the save follow `is_company_admin()`.
 *
 * `notification_settings` has one SELECT policy with no role term and two write
 * policies that both ask `is_company_admin()` (20260917130000, `'SIU'` with
 * `admin_w`). So a supervisor, an editor or a viewer read the page, and the
 * upsert their Speichern sent was refused with 42501 — and unlike the zero-row
 * UPDATE hazard `src/lib/writeOutcome.ts` exists for, an upsert's
 * `ON CONFLICT DO UPDATE` arm raises on the existing row rather than filtering
 * it away, so the toast was a raw PostgreSQL sentence inside a German screen.
 *
 * `useCompanyScope` is the real hook here; only AuthContext and
 * SuperAdminContext are scripted, so what is tested is the page's own formula
 * `!readOnly && (isAdmin || kind === 'support')` against the four personas the
 * database distinguishes, with the real German dictionary behind `t`.
 */

type Persona = {
  isAdmin: boolean;
  scope: { kind: 'own' | 'view' | 'support' | 'none'; readOnly: boolean; isPlatformSession: boolean };
};

const PERSONAS: Record<string, Persona> = {
  admin:     { isAdmin: true,  scope: { kind: 'own',     readOnly: false, isPlatformSession: false } },
  viewer:    { isAdmin: false, scope: { kind: 'own',     readOnly: false, isPlatformSession: false } },
  support:   { isAdmin: false, scope: { kind: 'support', readOnly: false, isPlatformSession: true  } },
  viewCtx:   { isAdmin: false, scope: { kind: 'view',    readOnly: true,  isPlatformSession: true  } },
};

const world = vi.hoisted(() => ({
  persona: null as null | {
    isAdmin: boolean;
    scope: { kind: string; readOnly: boolean; isPlatformSession: boolean };
  },
  showToast: vi.fn(),
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
}));

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    if (call.table === 'notification_settings' && call.op === 'select') {
      return {
        data: [
          { notification_type: 'tuev_bald_ablaufend', enabled: true,  email_global_enabled: true },
          { notification_type: 'tuev_abgelaufen',     enabled: false, email_global_enabled: true },
        ],
        error: null,
      };
    }
    return { data: null, error: null };
  });
  return { supabase: world.fake.client };
});

vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: world.showToast }) }));
vi.mock('../contexts/SuperAdminContext', () => ({
  useSuperAdmin: () => ({ effectiveCompanyId: 'company-1', companyScope: world.persona!.scope }),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    isAdmin: world.persona!.isAdmin,
    can: () => world.persona!.isAdmin,
    canCreate: world.persona!.isAdmin,
    canEdit: () => world.persona!.isAdmin,
    canDelete: () => world.persona!.isAdmin,
  }),
}));
vi.mock('../contexts/LanguageContext', async () => {
  const { translate, translatePlural } = await import('../i18n');
  const value = {
    language: 'de',
    setLanguage: () => {},
    t: (key: never, vars?: never) => translate('de', key, vars),
    tPlural: (keys: never, count: number, vars?: never) => translatePlural('de', keys, count, vars),
  };
  return { useTranslation: () => value };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { default: NotificationsPage } = await import('./NotificationsPage');

async function open(name: keyof typeof PERSONAS): Promise<ReactTestRenderer> {
  world.persona = PERSONAS[name];
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(createElement(NotificationsPage)); });
  await settle();
  return tree;
}

const switches = (tree: ReactTestRenderer): ReactTestInstance[] =>
  tree.root.findAll(node => node.type === 'button' && node.props.role === 'switch');

const flat = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(flat).join('');

const saveButtons = (tree: ReactTestRenderer): ReactTestInstance[] =>
  tree.root.findAll(node => node.type === 'button' && flat(node).includes('Einstellungen speichern'));

const quickActions = (tree: ReactTestRenderer): ReactTestInstance[] =>
  tree.root.findAll(node => node.type === 'button'
    && (flat(node).includes('Alle aktivieren') || flat(node).includes('Alle deaktivieren')));

beforeEach(() => {
  world.showToast.mockReset();
  if (world.fake) world.fake.calls.length = 0;
});

describe('NotificationsPage: the administrator gate the policies already enforce', () => {
  it('offers the switches and the save to an administrator of the company', async () => {
    const tree = await open('admin');
    expect(switches(tree)).toHaveLength(3); // the master plus the two TÜV types
    expect(switches(tree).every(s => s.props.disabled === false)).toBe(true);
    expect(saveButtons(tree)).toHaveLength(1);
    expect(quickActions(tree).every(b => b.props.disabled === false)).toBe(true);
    expect(textOf(tree)).not.toContain('Keine Berechtigung');
  });

  it('offers them inside a support session, which is_company_admin() also admits', async () => {
    const tree = await open('support');
    expect(switches(tree).every(s => s.props.disabled === false)).toBe(true);
    expect(saveButtons(tree)).toHaveLength(1);
    expect(textOf(tree)).not.toContain('Keine Berechtigung');
  });

  it('locks every switch and withholds the save from a non-administrator', async () => {
    const tree = await open('viewer');
    expect(switches(tree)).toHaveLength(3);
    expect(switches(tree).every(s => s.props.disabled === true)).toBe(true);
    expect(quickActions(tree).every(b => b.props.disabled === true)).toBe(true);
    expect(saveButtons(tree)).toHaveLength(0);
  });

  it('says why, in the sentence SettingsPage prints for a refused settings write', async () => {
    const tree = await open('viewer');
    expect(textOf(tree)).toContain('Keine Berechtigung zum Schreiben der Einstellungen');
  });

  it('names the support session instead for a platform read context', async () => {
    const tree = await open('viewCtx');
    expect(textOf(tree)).toContain('nur in einer Support-Sitzung ändern');
    expect(textOf(tree)).not.toContain('Keine Berechtigung');
    expect(saveButtons(tree)).toHaveLength(0);
  });

  it('sends no write for a non-administrator, even when a switch is pressed', async () => {
    const tree = await open('viewer');
    for (const toggle of switches(tree)) {
      await act(async () => { toggle.props.onClick?.({}); });
    }
    await settle();
    // Any save control that is still drawn is pressed too, so that this says
    // "nothing was sent" and not merely "the test did not try".
    for (const button of saveButtons(tree)) {
      await act(async () => { button.props.onClick?.({}); });
    }
    await settle();
    expect(callsOf(world.fake!.calls, 'notification_settings', 'insert')).toHaveLength(0);
    expect(callsOf(world.fake!.calls, 'notification_settings', 'update')).toHaveLength(0);
    expect(world.fake!.calls.some(c => c.filters.some(f => f.startsWith('upsert:')))).toBe(false);
    expect(world.showToast).not.toHaveBeenCalled();
  });
});
