import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Abrechnung schedule card, rendered with the real German dictionary, for
 * the one thing it says that nothing else does: **who the reminder reaches, and
 * who it cannot reach.**
 *
 * The rest of the card's preview is built from the WEEK's bookings
 * (`abrechnung_schedule_preview`), so a driver with no bookings appears in none
 * of its buckets. That is how an active driver with no e-mail address came to
 * receive nothing with nobody told — measured on production 26.10.2026: one
 * driver at Y&A Mobility, one of 20 such drivers across six companies. The run
 * counted him as `no_address: 1` in a log nobody reads.
 *
 * A missing dictionary key renders as the key itself, so these assertions also
 * fail the build when a key is added to only one dictionary.
 */

vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));

interface DriverRow { status: string | null; email: string | null }

const state: {
  schedule: Record<string, unknown> | null;
  drivers: DriverRow[];
  driversFail: boolean;
} = { schedule: null, drivers: [], driversFail: false };

/** `.from('drivers')` as `fetchAllPaginated` drives it: select → eq → order → range. */
function driversQuery() {
  const answer = () => (state.driversFail
    ? { data: null, error: { message: 'boom' } }
    : { data: state.drivers, error: null });
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    range: () => Promise.resolve(answer()),
  };
  return chain;
}

function scheduleQuery() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: state.schedule, error: null }),
  };
  return chain;
}

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (table: string) => (table === 'drivers' ? driversQuery() : scheduleQuery()),
    // The week preview is a separate read; a failure there must not hide the roster.
    rpc: () => Promise.resolve({ data: null, error: { message: 'preview unavailable' } }),
  },
}));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('../contexts/SuperAdminContext', () => ({
  useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }),
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

const { default: AbrechnungScheduleCard } = await import('./AbrechnungScheduleCard');

const REMINDING = {
  driver_mail_enabled: true, manager_summary_enabled: false, weekday: 1,
  send_time: '10:00:00', reminder_enabled: true, reminder_lead_minutes: 60,
  armed_at: '2026-01-01T00:00:00.000Z',
};

async function render(): Promise<string> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(createElement(AbrechnungScheduleCard, { readOnly: false }));
  });
  // The schedule, the preview and the roster are three reads; let them settle.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  const text = JSON.stringify(tree!.toJSON());
  tree!.unmount();
  return text;
}

describe('the reminder roster on the schedule card', () => {
  beforeEach(() => {
    state.schedule = { ...REMINDING };
    state.drivers = [];
    state.driversFail = false;
  });

  it('names the active driver who has no address and therefore gets nothing', async () => {
    state.drivers = [
      { status: 'active', email: 'a@example.com' },
      { status: 'active', email: null },
      { status: 'inactive', email: 'b@example.com' },
    ];
    const text = await render();
    expect(text).toContain('1 aktiver Fahrer hat keine E-Mail-Adresse und erhält keine Erinnerung.');
    expect(text).toContain('Die Erinnerung erreicht 1 von 2 aktiven Fahrern.');
  });

  it('uses the plural for several, and says nothing when every driver has an address', async () => {
    state.drivers = [
      { status: 'active', email: null }, { status: 'active', email: '  ' },
      { status: 'active', email: 'a@example.com' },
    ];
    expect(await render()).toContain('2 aktive Fahrer haben keine E-Mail-Adresse');

    state.drivers = [{ status: 'active', email: 'a@example.com' }];
    expect(await render()).not.toContain('keine E-Mail-Adresse und erh');
  });

  it('says that an address two drivers share gets one reminder, not two', async () => {
    state.drivers = [
      { status: 'active', email: 'driver.a@example.com' },
      { status: 'active', email: 'Driver.A@Example.com' },
    ];
    const text = await render();
    expect(text).toContain('1 E-Mail-Adresse gehört mehreren aktiven Fahrern.');
    expect(text).toContain('Die Erinnerung erreicht 1 von 2 aktiven Fahrern.');
  });

  it('shows a failed roster read as a failure, never as a count of zero', async () => {
    state.driversFail = true;
    const text = await render();
    expect(text).toContain('Die Fahrerliste konnte nicht geladen werden.');
    expect(text).not.toContain('Die Erinnerung erreicht');
    expect(text).not.toContain('keine E-Mail-Adresse und erh');
  });

  it('asks nothing and says nothing when the saved schedule does not remind', async () => {
    state.schedule = { ...REMINDING, reminder_enabled: false };
    state.drivers = [{ status: 'active', email: null }];
    const text = await render();
    expect(text).not.toContain('Die Erinnerung erreicht');
    expect(text).not.toContain('keine E-Mail-Adresse und erh');
  });

  it('describes the switch as reaching every active driver, not only one who recorded nothing', async () => {
    const text = await render();
    expect(text).toContain('Jeder aktive Fahrer mit hinterlegter E-Mail-Adresse');
    expect(text).not.toContain('weder Bargeld noch Barbelege erfasst hat');
  });
});
