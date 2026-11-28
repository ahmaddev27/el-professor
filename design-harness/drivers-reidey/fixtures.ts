/**
 * The Fahrer and Fahrzeuge lists in Reidey's layout (27.11.2026): a live
 * partner connection, the Reidey link rows (linked, linked but departed, and
 * three waiting for a decision), drivers with an e-mail and a phone, one
 * vehicle out of service, and the answers of the update button and of the
 * delete check.
 *
 * Only with `?reidey=1` on those two screens, so every other batch's harness,
 * flows and shots stay exactly as they were. Nothing here is a real person:
 * the names are the design preview's, every address is `@example.com` and
 * every number is a run of zeros.
 */
import { HARNESS_COMPANY_ID, scenario } from '../scenario';
import type { Row } from '../fixtures';
import { driverRecords } from '../fixtures-batch1b';
import { carsRows } from '../fixtures';

const params = new URLSearchParams(window.location.search);

export function isDriversReideyScenario(): boolean {
  return params.get('reidey') === '1' && (scenario.screen === 'fahrer' || scenario.screen === 'fahrzeuge');
}

const CREATED_AT = '2026-11-20T08:00:00.000Z';

/** Who carries an address and a number; the others show an empty cell, as a real list does. */
const CONTACT: Record<string, { email?: string; phone?: string }> = {
  d01: { email: 'mehmet.yildiz@example.com', phone: '+49 151 00000001' },
  d02: { email: 'svenja.krueger@example.com', phone: '+49 151 00000002' },
  d03: { phone: '+49 151 00000003' },
  d04: { email: 'dragan.petrovic@example.com' },
  d06: { email: 'katarzyna.nowak@example.com', phone: '+49 151 00000006' },
  d07: { phone: '+49 151 00000007' },
  d09: { email: 'ewa.kowalczyk@example.com', phone: '+49 151 00000009' },
  d11: { email: 'anja.schubert@example.com' },
  d12: { email: 'karim.mansour@example.com', phone: '+49 151 00000012' },
  d16: { email: 'marco.rossi@example.com', phone: '+49 151 00000016' },
};

/** Linked to a Reidey account; d16 has since left the roster (the departed badge). */
const LINKED = ['d01', 'd02', 'd03', 'd04', 'd06', 'd07', 'd09', 'd12', 'd16'];
const DEPARTED = new Set(['d16']);

function linkRows(): Row[] {
  const names = new Map(driverRecords().map(driver => [String(driver.id), String(driver.name)]));
  const linked = LINKED.map((driverId, index) => ({
    id: `pl-${driverId}`,
    company_id: HARNESS_COMPANY_ID,
    partner: 'reidey',
    external_driver_id: String(9100 + index),
    proposed_name: null,
    proposed_email: null,
    proposed_phone: null,
    status: 'linked',
    driver_id: driverId,
    partner_removed_at: DEPARTED.has(driverId) ? '2026-11-18T06:00:00.000Z' : null,
    decision_reason: null,
    link_method: index < 4 ? null : 'automatic_match',
    created_at: CREATED_AT,
    drivers: { name: names.get(driverId) ?? '' },
  }));
  // The three the import could not decide: a name two active drivers share
  // (the harness has no second namesake, the reason is what the screen reads),
  // the name of a driver who left, and a driver Reidey sent without a name.
  const pending = [
    { id: 'pl-p1', external: '9201', name: 'Jonas Albrecht', reason: 'name_ambiguous' },
    { id: 'pl-p2', external: '9202', name: 'Sebastian Kühn', reason: 'name_inactive' },
    { id: 'pl-p3', external: '9203', name: 'Unbekannter Fahrer', reason: 'name_missing' },
  ].map(link => ({
    id: link.id,
    company_id: HARNESS_COMPANY_ID,
    partner: 'reidey',
    external_driver_id: link.external,
    proposed_name: link.name,
    proposed_email: null,
    proposed_phone: '+49 151 00000000',
    status: 'pending',
    driver_id: null,
    partner_removed_at: null,
    decision_reason: link.reason,
    link_method: null,
    created_at: CREATED_AT,
    drivers: null,
  }));
  return [...linked, ...pending];
}

export function driversReideyTables(): Array<[string, Row[]]> {
  if (!isDriversReideyScenario()) return [];
  const drivers = driverRecords().map(driver => ({ ...driver, ...(CONTACT[String(driver.id)] ?? {}) }));
  const cars = carsRows().map((car, index) => (index === 2 ? { ...car, status: 'inactive' } : car));
  return [
    ['drivers', scenario.data === 'empty' && scenario.screen === 'fahrer' ? [] : drivers],
    ['cars', scenario.data === 'empty' && scenario.screen === 'fahrzeuge' ? [] : cars],
    ['partner_connections', [{ id: 'pc-1', company_id: HARNESS_COMPANY_ID, partner: 'reidey', status: 'active' }]],
    ['partner_driver_links', linkRows()],
    ['partner_note_submissions', []],
    ['partner_receipt_submissions', []],
  ];
}

/** The driver who has never driven: the one row the delete check lets go. */
export const DELETABLE_DRIVER_ID = 'd19';

/** The database's answers this screen asks for; null for anything else. */
export function driversReideyRpc(name: string, args?: Record<string, unknown>): { data: unknown; error: null } | null {
  if (!isDriversReideyScenario()) return null;
  switch (name) {
    case 'partner_drivers_import':
      return {
        data: {
          ok: true, created: 2, linked: 1, pending: 3, skipped_count: 3,
          skipped: [
            { link_id: 'pl-p1', name: 'Jonas Albrecht', reason: 'name_ambiguous' },
            { link_id: 'pl-p2', name: 'Sebastian Kühn', reason: 'name_inactive' },
            { link_id: 'pl-p3', name: 'Unbekannter Fahrer', reason: 'name_missing' },
          ],
        },
        error: null,
      };
    case 'partner_vehicles_import':
      return { data: { ok: true, created: 1, linked: 0, skipped: [] }, error: null };
    case 'driver_delete_check':
      return args?.p_driver_id === DELETABLE_DRIVER_ID
        ? { data: { ok: true, deletable: true, blockers: [] }, error: null }
        : {
          data: {
            ok: true,
            deletable: false,
            blockers: [
              { table: 'fahrtenbuch_trips', rows: 412 },
              { table: 'partner_driver_links', rows: 1 },
              { table: 'salaries', rows: 6 },
              { table: 'salary_cash_receipts', rows: 2 },
            ],
          },
          error: null,
        };
    default:
      return null;
  }
}

/** The partner pull's answer: the roster or the vehicle list as Reidey sent it. */
export function driversReideyInvoke(name: string, options?: { body?: { scope?: string } }): { data: unknown; error: null } | null {
  if (!isDriversReideyScenario() || name !== 'partner-pull') return null;
  const scope = options?.body?.scope === 'vehicles' ? 'vehicles' : 'drivers';
  return scope === 'drivers'
    ? { data: { ok: true, scope, seen: 22, new: 3, departed: 1, returned: 0, truncated: false }, error: null }
    : { data: { ok: true, scope, seen: 12, new: 1, departed: 0, returned: 0, truncated: false }, error: null };
}
