/**
 * Design remake, batch R2: invented data for Notizen, Werkstatt and Benachrichtigungen.
 *
 * Notizen reads `driver_notes` (with the driver and the car embedded), `drivers`,
 * `cars`, `user_profiles`, `partner_connections` and `partner_note_submissions`.
 * Werkstatt reads `werkstatt_checks` (car embedded as `car`) for the week the
 * clock is in, and the new-check dialog reads `cars`. Benachrichtigungen reads
 * `notification_settings`. The capture clock is fixed at Monday 14.09.2026, so
 * the dates below are fixed too. Nothing here is a real person or company.
 * This file answers for its own screens only.
 */
import type { Row } from '../fixtures';
import { HARNESS_COMPANY_ID, HARNESS_USER_ID } from '../scenario';

export type R2Screen =
  | 'r2-notizen' | 'r2-notizen-leer' | 'r2-werkstatt' | 'r2-werkstatt-leer' | 'r2-benachrichtigungen';

const SCREENS: readonly string[] = [
  'r2-notizen', 'r2-notizen-leer', 'r2-werkstatt', 'r2-werkstatt-leer', 'r2-benachrichtigungen',
];
const requested = new URLSearchParams(window.location.search).get('screen');
export const r2Screen: R2Screen | null = SCREENS.includes(requested ?? '') ? (requested as R2Screen) : null;

const DRIVERS: Array<[string, string]> = [
  ['r2-d1', 'Lena Hartmann'], ['r2-d2', 'Tobias Kessler'], ['r2-d3', 'Selin Aydın'],
  ['r2-d4', 'Marek Zielinski'], ['r2-d5', 'Birgit Sandmann'], ['r2-d6', 'Florian Wegener'],
];

/** Plate, TÜV valid until: expired, soon (inside 60 days) and valid. */
const CARS: Array<[string, string]> = [
  ['M-ZK 2101', '2026-08-19'], ['M-ZK 2102', '2026-10-15'], ['M-ZK 2103', '2027-03-24'],
  ['M-ZK 2104', '2027-04-30'], ['M-ZK 2105', '2027-07-21'], ['M-ZK 2106', '2026-11-02'],
];

function carRows(): Row[] {
  return CARS.map(([kennzeichen, tuev], i) => ({
    id: `r2-car-${i + 1}`,
    company_id: HARNESS_COMPANY_ID,
    kennzeichen,
    tuev_gueltig_bis: tuev,
    status: i === 5 ? 'inactive' : 'active',
  }));
}

function driverRows(): Row[] {
  return DRIVERS.map(([id, name]) => ({ id, company_id: HARNESS_COMPANY_ID, name, status: 'active', salary_ratio: 0.5 }));
}

function profileRows(): Row[] {
  return [
    { id: 'r2-up-1', user_id: HARNESS_USER_ID, company_id: HARNESS_COMPANY_ID, full_name: 'Katrin Lindner', email: 'katrin.lindner@example.com', role: 'admin', status: 'active' },
    { id: 'r2-up-2', user_id: 'r2-user-2', company_id: HARNESS_COMPANY_ID, full_name: 'Jan Vogt', email: 'jan.vogt@example.com', role: 'editor', status: 'active' },
  ];
}

type NoteSpec = {
  driver: number; car: number | null; type: string; behavior: string; date: string; text: string;
  fullDay?: boolean; from?: string; to?: string; endDate?: string;
  app?: boolean; verification?: 'verified' | 'rejected' | 'unverified'; evidence?: boolean; occurred?: string;
};

const NOTES: NoteSpec[] = [
  { driver: 1, car: null, type: 'sick', behavior: 'exclude_from_plan', date: '2026-09-01', endDate: '2026-09-03', fullDay: true, text: 'Krankmeldung per Telefon, Attest folgt.' },
  { driver: 2, car: null, type: 'vacation', behavior: 'exclude_from_plan', date: '2026-09-07', endDate: '2026-09-18', fullDay: true, text: 'Urlaub laut Antrag vom Juli.' },
  { driver: 3, car: 1, type: 'blitzer', behavior: 'neutral', date: '2026-09-02', text: 'Anhörungsbogen wegen Geschwindigkeit, 14 km/h zu schnell.', verification: 'verified', evidence: true, occurred: '2026-08-28T16:42:00+02:00' },
  { driver: 4, car: 2, type: 'accident', behavior: 'neutral', date: '2026-09-04', text: 'Parkschaden hinten links am Hauptbahnhof, Fotos gemacht.', verification: 'unverified', evidence: true, occurred: '2026-09-04T21:15:00+02:00' },
  { driver: 5, car: 3, type: 'kontrolle', behavior: 'neutral', date: '2026-09-05', text: 'Verkehrskontrolle ohne Beanstandung.', app: true, verification: 'verified', occurred: '2026-09-05T23:05:00+02:00' },
  { driver: 6, car: 4, type: 'breakdown', behavior: 'neutral', date: '2026-09-08', text: 'Motorkontrollleuchte an, Fahrzeug in die Werkstatt gebracht.', app: true, verification: 'unverified', occurred: '2026-09-08T07:30:00+02:00' },
  { driver: 1, car: null, type: 'general', behavior: 'must_include_in_plan', date: '2026-09-09', fullDay: false, from: '06:00', to: '14:00', text: 'Möchte am Mittwoch nur die Frühschicht fahren.' },
  { driver: 2, car: 5, type: 'wait', behavior: 'neutral', date: '2026-09-10', text: 'Wartezeit am Flughafen, Fluggast eine Stunde verspätet.', app: true, verification: 'rejected', occurred: '2026-09-10T18:20:00+02:00' },
  { driver: 3, car: null, type: 'off', behavior: 'exclude_from_plan', date: '2026-09-12', endDate: '2026-09-13', fullDay: true, text: 'Freier Tag nach Absprache.' },
  { driver: 4, car: null, type: 'other', behavior: 'neutral', date: '2026-09-14', text: 'Neue Handynummer: bitte im Funkplan ändern.' },
  { driver: 5, car: 2, type: 'blitzer', behavior: 'neutral', date: '2026-09-15', text: 'Foto vom Bußgeldbescheid hochgeladen, Zahlung läuft über das Büro.', app: true, verification: 'unverified', evidence: true, occurred: '2026-09-11T05:48:00+02:00' },
  { driver: 6, car: null, type: 'general', behavior: 'neutral', date: '2026-08-28', text: '' },
];

function noteRows(): Row[] {
  return NOTES.map((n, i): Row => {
    const [driverId, driverName] = DRIVERS[n.driver - 1];
    const car = n.car ? CARS[n.car - 1] : null;
    const day = n.date;
    return {
      id: `r2-note-${i + 1}`,
      company_id: HARNESS_COMPANY_ID,
      driver_id: driverId,
      car_id: n.car ? `r2-car-${n.car}` : null,
      note_date: `${day}T08:00:00+02:00`,
      note_text: n.text,
      note_type: n.type,
      note_planning_behavior: n.behavior,
      is_full_day: n.fullDay ?? true,
      start_time: n.from ?? null,
      end_time: n.to ?? null,
      start_date: day,
      end_date: n.endDate ?? day,
      created_by: n.app ? null : HARNESS_USER_ID,
      submitted_by_name: n.app ? driverName : null,
      entry_source: n.app ? 'driver_app' : 'manual',
      verification_status: n.verification ?? 'unverified',
      evidence_path: n.evidence ? `${HARNESS_COMPANY_ID}/notes/r2-note-${i + 1}.pdf` : null,
      occurred_at: n.occurred ?? null,
      reported_at: n.occurred ?? null,
      created_at: `${day}T09:00:00+02:00`,
      updated_at: `${day}T09:00:00+02:00`,
      drivers: { name: driverName },
      cars: car ? { kennzeichen: car[0] } : null,
    };
  });
}

/** [car index, status, check date, notes, repair notes, oil, km]. 14.–20.09. is the week on screen. */
const CHECKS: Array<[number, string, string, string, string | null, string, number]> = [
  [1, 'negative', '2026-09-14', 'Bremsen quietschen vorne links.', null, 'ok', 148230],
  [2, 'positive', '2026-09-14', 'Ölwechsel ohne Befund.', null, 'ok', 96410],
  [3, 'repaired', '2026-09-15', 'Stoßdämpfer hinten schlug durch.', 'Beide Stoßdämpfer hinten erneuert.', 'ok', 121870],
  [4, 'positive', '2026-09-16', 'Reifendruck und Beleuchtung in Ordnung.', null, 'ok', 73190],
  [5, 'negative', '2026-09-17', 'Ölstand niedrig, leichter Ölverlust.', null, 'niedrig', 188540],
  [2, 'positive', '2026-09-18', 'Scheibenwischer getauscht.', null, 'ok', 96655],
  [1, 'repaired', '2026-09-02', 'Kühlwasser fehlte.', 'Kühlwasserschlauch ersetzt.', 'ok', 147800],
  [4, 'positive', '2026-09-09', 'Inspektion ohne Befund.', null, 'ok', 72860],
];

function checkRows(): Row[] {
  return CHECKS.map(([carIndex, status, date, notes, repair, oil, km], i) => ({
    id: `r2-wk-${i + 1}`,
    company_id: HARNESS_COMPANY_ID,
    car_id: `r2-car-${carIndex}`,
    status,
    check_date: date,
    month: Number(date.slice(5, 7)),
    year: Number(date.slice(0, 4)),
    week_number: 1,
    notes,
    repair_notes: repair,
    oil_status: oil,
    km_stand: km,
    created_at: `${date}T09:00:00+02:00`,
    car: { kennzeichen: CARS[carIndex - 1][0] },
  }));
}

function notificationRows(): Row[] {
  return [
    { id: 'r2-ns-1', company_id: HARNESS_COMPANY_ID, notification_type: 'tuev_bald_ablaufend', enabled: true, email_global_enabled: true },
    { id: 'r2-ns-2', company_id: HARNESS_COMPANY_ID, notification_type: 'tuev_abgelaufen', enabled: false, email_global_enabled: true },
  ];
}

const NOTES_TABLES = ['driver_notes', 'drivers', 'cars', 'user_profiles', 'partner_connections', 'partner_note_submissions'];

/** Rows for this batch's screens only; empty on every other batch's. */
export function r2Tables(): Array<[string, Row[]]> {
  switch (r2Screen) {
    case 'r2-notizen':
      return [
        ['driver_notes', noteRows()], ['drivers', driverRows()], ['cars', carRows()],
        ['user_profiles', profileRows()], ['partner_connections', []],
        ['partner_note_submissions', [
          { id: 'r2-ps-1', company_id: HARNESS_COMPANY_ID, status: 'pending' },
          { id: 'r2-ps-2', company_id: HARNESS_COMPANY_ID, status: 'pending' },
        ]],
      ];
    case 'r2-notizen-leer':
      return NOTES_TABLES.map(name => [name, name === 'drivers' ? driverRows() : name === 'cars' ? carRows() : []]);
    case 'r2-werkstatt':
      return [['werkstatt_checks', checkRows()], ['cars', carRows()]];
    case 'r2-werkstatt-leer':
      return [['werkstatt_checks', []], ['cars', carRows()]];
    case 'r2-benachrichtigungen':
      return [['notification_settings', notificationRows()]];
    default:
      return [];
  }
}
