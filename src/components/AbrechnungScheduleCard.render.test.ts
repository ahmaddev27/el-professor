import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_DRIVER_STATUS, DEACTIVATED_DRIVER_STATUS } from '../utils/driverStatus';
import { summariseReminderRoster } from '../../supabase/functions/_shared/abrechnung-reminder-core';

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
  /** Every `.eq(column, value)` the roster query applied, for the assertion below. */
  driverFilters: Array<[string, unknown]>;
} = { schedule: null, drivers: [], driversFail: false, driverFilters: [] };

/**
 * `.from('drivers')` as `fetchAllPaginated` drives it: select → eq → eq → order
 * → range.
 *
 * It **applies** the `.eq()` filters it is given and **records** them, and the
 * two serve different assertions. Applying them makes the fake answer what the
 * real PostgREST would, so the rendered figures are the figures. Recording them
 * is what lets a test see the query itself — necessary here, because
 * `summariseReminderRoster` applies the same status test a second time, so
 * removing the filter from the card does **not** change a single rendered
 * number. Measured, not assumed: the first version of this file claimed it did,
 * and a mutation control showed the claim was false.
 */
function driversQuery() {
  const answer = () => {
    if (state.driversFail) return { data: null, error: { message: 'boom' } };
    const rows = state.drivers.filter(row => state.driverFilters.every(
      ([column, value]) => column !== 'status' || row.status === value,
    ));
    return { data: rows, error: null };
  };
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => { state.driverFilters.push([column, value]); return chain; },
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
    state.driverFilters = [];
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

  /**
   * **The control on the query itself**, and the only one at this level: the
   * card asks for active drivers and nothing else.
   *
   * `summariseReminderRoster` tests the status again, so no rendered figure
   * moves when the filter goes — which is why this assertion is about the
   * statement the card sent and not about what it drew. The second wall is
   * deliberate (the job shares that function and must count the deactivated for
   * its own report), so the two walls are pinned by two different assertions:
   * this one, and `driverReads.test.ts`'s chooser check, which reads the source.
   */
  it('asks the database for active drivers only', async () => {
    state.drivers = [{ status: 'active', email: 'a@example.com' }];
    await render();
    expect(state.driverFilters).toContainEqual(['status', ACTIVE_DRIVER_STATUS]);
    expect(state.driverFilters.map(([column]) => column)).toContain('company_id');
  });

  /**
   * The behaviour the two walls produce together. It holds whichever wall is
   * doing the work, which is the point of having two.
   */
  it('never counts a deactivated driver, however many of them there are', async () => {
    state.drivers = [
      { status: 'active', email: 'a@example.com' },
      { status: 'inactive', email: 'b@example.com' },
      { status: 'inactive', email: null },
      { status: 'inactive', email: 'a@example.com' },
    ];
    const text = await render();
    expect(text).toContain('Die Erinnerung erreicht 1 von 1 aktiven Fahrern.');
    // The deactivated rows would otherwise have produced both warnings: one
    // without an address, and one sharing the active driver's address.
    expect(text).not.toContain('keine E-Mail-Adresse und erh');
    expect(text).not.toContain('gehört mehreren aktiven Fahrern');
  });

  /**
   * The one divergence the query filter leaves open, pinned rather than removed.
   *
   * `summariseReminderRoster` lives in `supabase/functions/_shared/` because the
   * JOB shares it, and nothing there can import `src/utils/driverStatus.ts` — so
   * "active" is necessarily spelled twice. This is the same situation as
   * `notificationSelection.parity.test.ts`, and the same remedy: a test on the
   * `src/` side, which can see both, requires them to agree. If
   * `ACTIVE_DRIVER_STATUS` ever changes value, the card's query follows it, the
   * shared core's literal does not, and the card and the job would disagree
   * about who is active. Then this fails — and the fix is to decide which value
   * is right, never to copy one side onto the other.
   */
  it('agrees with the shared core about which status string means active', () => {
    const address = 'a@example.com';
    expect(summariseReminderRoster([{ status: ACTIVE_DRIVER_STATUS, email: address }]))
      .toMatchObject({ active: 1, reachable: 1 });
    expect(summariseReminderRoster([{ status: DEACTIVATED_DRIVER_STATUS, email: address }]))
      .toMatchObject({ active: 0, reachable: 0 });
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
