/**
 * Phase 5, the frame.
 *
 * This batch's subject is `AppLayout` itself rather than a screen, so its shot
 * list is wide instead of deep: one screen from each earlier batch, which the
 * harness already registers, plus the screens that were never converted and so
 * have never been seen inside a design-system frame. Those are the seam this
 * batch exists to check — a legacy page on a `--canvas` frame.
 *
 * `scenario.ts` knows batch 1's screen names only and falls back to Fahrzeuge
 * for any other, so this batch reads `screen` from the query string itself, as
 * batch 3 and the Fahrtenanalyse do.
 */
import type { Row } from '../fixtures';

export type ApplayoutScreen = 'uebersicht' | 'benachrichtigungen' | 'werkstatt';

const params = new URLSearchParams(window.location.search);
const requested = params.get('screen');
export const applayoutScreen: ApplayoutScreen | null =
  requested === 'uebersicht' || requested === 'benachrichtigungen' || requested === 'werkstatt'
    ? requested
    : null;

/**
 * Rows for this batch's screens only — an empty list on every other batch's, so
 * a shot of Fahrzeuge or Dokumente is unaffected by anything here.
 */
export function applayoutTables(): Array<[string, Row[]]> {
  if (!applayoutScreen) return [];
  if (applayoutScreen === 'werkstatt') {
    return [['werkstatt_checks', werkstattRows()]];
  }
  // Die Übersicht liest sieben Tabellen; die ungesetzten antworten leer, was
  // die Seite als Null darstellt. Benachrichtigungen hat keine gespeicherte
  // Zeile, also zeichnet der Bildschirm seine Voreinstellungen.
  return [];
}

function werkstattRows(): Row[] {
  return [
    {
      id: 'wk-1',
      company_id: 'company-1',
      car_id: 'car-1',
      check_date: '2026-09-02',
      next_check_date: '2027-09-02',
      check_type: 'TÜV',
      notes: 'Hauptuntersuchung ohne Mängel.',
      created_at: '2026-09-02T08:00:00+02:00',
    },
    {
      id: 'wk-2',
      company_id: 'company-1',
      car_id: 'car-2',
      check_date: '2026-08-18',
      next_check_date: '2026-10-18',
      check_type: 'Inspektion',
      notes: 'Bremsbeläge vorne erneuert.',
      created_at: '2026-08-18T09:30:00+02:00',
    },
  ];
}
