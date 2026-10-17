import { createElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * The company settings page, rendered once per tab with the real German
 * dictionary: a key missing from it renders as the key and fails here. The four
 * cards that own their own queries are replaced by markers; what is checked is
 * the page's own regrouping, the address as the source of the open tab, and that
 * the preview and the save bar sit where they should.
 */

// Radix Tabs focuses through requestAnimationFrame, which the node environment lacks.
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));

const settings = { company_name: 'Muster Taxi GmbH', logo_url: null, drivers_per_car_limit: 4, iban: 'DE89370400440532013000' };

vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../contexts/CompanySettingsContext', () => ({
  useCompanySettings: () => ({ settings, loading: false, updateSettings: vi.fn(), refreshSettings: vi.fn() }),
  resolveLogoUrl: (value: string) => value,
}));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('../contexts/SuperAdminContext', () => ({
  useSuperAdmin: () => ({ effectiveCompanyId: 'company-1', companyScope: { readOnly: false, isPlatformSession: false } }),
}));
vi.mock('../components/partner/PartnerConnectCard', () => ({ PartnerConnectCard: () => 'MARKER-PARTNER' }));
vi.mock('../components/AbrechnungScheduleCard', () => ({ default: () => 'MARKER-ABRECHNUNG' }));
vi.mock('../components/NotificationAddressCard', () => ({ default: () => 'MARKER-NOTIFY' }));
vi.mock('../components/NotificationRecipientsCard', () => ({ default: () => 'MARKER-RECIPIENTS' }));
vi.mock('../components/UberPullScheduleCard', () => ({ default: () => 'MARKER-UBER' }));
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

const { default: SettingsPage } = await import('./SettingsPage');

function collect(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(collect).join('');
}

let lastSearch = '';
function Spy() {
  lastSearch = useLocation().search;
  return null;
}

async function open(url: string): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(MemoryRouter, { initialEntries: [url] }, createElement(SettingsPage), createElement(Spy)));
  });
  return renderer;
}

describe('SettingsPage tabs', () => {
  it('opens on the company tab for no tab and for an unknown one', async () => {
    for (const url of ['/settings', '/settings?tab=nonsense', '/settings?tab=__proto__']) {
      const text = collect((await open(url)).root);
      expect(text).toContain('Unternehmensidentität');
      expect(text).not.toContain('Rechtliche Daten');
    }
  });

  it('draws the company tab: logo, identity, contact, address, management, with the preview and the save bar', async () => {
    const text = collect((await open('/settings?tab=company')).root);
    for (const word of ['Unternehmensidentität', 'Vorschau', 'Speichern', 'Zurücksetzen']) expect(text).toContain(word);
    expect(text).not.toContain('MARKER-');
  });

  it('draws the legal tab: legal data and bank, with the preview and the save bar', async () => {
    const text = collect((await open('/settings?tab=legal')).root);
    for (const word of ['Rechtliche Daten', 'Bankverbindung', 'Vorschau', 'Speichern']) expect(text).toContain(word);
    expect(text).not.toContain('Unternehmensidentität');
  });

  it('draws the operations tab: operations and document defaults, saved by the same bar, no preview', async () => {
    const text = collect((await open('/settings?tab=operations')).root);
    for (const word of ['Betriebseinstellungen', 'Dokumenteneinstellungen', 'Speichern']) expect(text).toContain(word);
    expect(text).not.toContain('Vorschau');
  });

  it('draws the connections tab: the four cards, and no company form to save', async () => {
    const text = collect((await open('/settings?tab=connections')).root);
    for (const word of ['MARKER-PARTNER', 'MARKER-NOTIFY', 'MARKER-ABRECHNUNG', 'MARKER-UBER', 'MARKER-RECIPIENTS']) expect(text).toContain(word);
    expect(text).not.toContain('Zurücksetzen');
  });

  it('keeps the tab in the address when one is chosen', async () => {
    const renderer = await open('/settings');
    const trigger = renderer.root.findAll(n => n.props?.role === 'tab' && collect(n).includes('Rechtliches'))[0];
    await act(async () => { trigger.props.onMouseDown({ button: 0, ctrlKey: false, preventDefault() {} }); });
    expect(lastSearch).toBe('?tab=legal');
    expect(collect(renderer.root)).toContain('Bankverbindung');
  });
});
