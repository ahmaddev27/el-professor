/**
 * Synthetic December 2026 Fahrtenbuch for the staging demo company
 * "DEMO Monatsplanung GmbH", in the 18-column Uber export layout.
 *
 *   node scripts/demo/december-2026.mjs [output-directory]
 *
 * Writes DEMO_Fahrtenbuch_Dezember_2026.xlsx (never committed). The file is
 * meant to be imported through the product's own import screen, so every import
 * rule (file hash, row keys, start_at/end_at, status) applies to it.
 *
 * Deterministic: a seeded PRNG, no Math.random, no clock. Everything is
 * invented: vehicles B-DEMO-1..3, three drivers, fictional addresses.
 *
 * Wall times are Europe/Berlin local times and December has no DST change, so
 * plain minute arithmetic from 2026-12-01 00:00 is exact.
 */
import ExcelJS from 'exceljs';
import path from 'node:path';
import fs from 'node:fs';

const OUT_DIR = process.argv[2]
  ?? 'C:\\Users\\ahmad\\AppData\\Local\\Temp\\claude\\c--Users-ahmad-Desktop-Pro\\8fb23811-48fb-4692-b8d1-61c4779e6283\\scratchpad\\demo-december\\';
const FILE_NAME = 'DEMO_Fahrtenbuch_Dezember_2026.xlsx';

export const HEADERS = [
  'Datum/Uhrzeit Auftragseingang',
  'Uhrzeit der Auftragsuebermittlung',
  'Geplante Abholzeit',
  'Datum der Fahrt',
  'Fahrtstatus',
  'Standort des Fahrzeugs bei Auftragsuebermittlung',
  'Uhrzeit des Fahrtbeginns',
  'Uhrzeit des Fahrtendes',
  'Kennzeichen',
  'Fahrzeugtyp',
  'Fahrername',
  'Fahrpreis',
  'Trinkgeld',
  'Kilometer',
  'Zahlungsart',
  'Abholort',
  'Zielort',
  'Vorreservierte Fahrt',
];

const BASE = { lat: 52.52, lon: 13.405 };

// ── PRNG ──────────────────────────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261201);
const rf = (a, b) => a + rng() * (b - a);
const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
const pick = list => list[Math.floor(rng() * list.length)];

// ── Time: seconds since 2026-12-01 00:00 local wall time ─────────────────────
const EPOCH = Date.UTC(2026, 11, 1, 0, 0, 0);
const p2 = n => String(n).padStart(2, '0');
function stamp(sec) {
  const d = new Date(EPOCH + sec * 1000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} `
    + `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.000`;
}
const dateOf = sec => stamp(sec).slice(0, 10);
const MIN = 60;

// ── Geography (synthetic) ────────────────────────────────────────────────────
const KM_PER_DEG_LAT = 111.2;
const kmPerDegLon = lat => 111.2 * Math.cos((lat * Math.PI) / 180);
function dist(a, b) {
  const dy = (b.lat - a.lat) * KM_PER_DEG_LAT;
  const dx = (b.lon - a.lon) * kmPerDegLon(a.lat);
  return Math.hypot(dx, dy);
}
function offset(from, km, bearingRad) {
  return {
    lat: from.lat + (km * Math.cos(bearingRad)) / KM_PER_DEG_LAT,
    lon: from.lon + (km * Math.sin(bearingRad)) / kmPerDegLon(from.lat),
  };
}
function bearingTo(from, to) {
  return Math.atan2((to.lon - from.lon) * kmPerDegLon(from.lat), (to.lat - from.lat) * KM_PER_DEG_LAT);
}
/** A point `km` away from `from`; steered back toward the base when it would wander off. */
function pointAway(from, km) {
  const toBase = bearingTo(from, BASE);
  const wander = dist(from, BASE) > 11;
  const bearing = wander ? toBase + rf(-0.9, 0.9) : rf(0, 2 * Math.PI);
  return offset(from, km, bearing);
}
function nearBase(radiusKm) {
  return offset(BASE, rf(0.05, radiusKm), rf(0, 2 * Math.PI));
}

const STREETS = [
  'Demoweg', 'Musterallee', 'Beispielstraße', 'Testgasse', 'Probeweg', 'Fiktivstraße', 'Modellring',
  'Mustermannstraße', 'Exempelstraße', 'Schemaweg', 'Attrappenallee', 'Platzhalterstraße', 'Kulissenweg',
  'Spielwiesenallee', 'Entwurfstraße', 'Erfundenstraße', 'Probierplatz', 'Skizzenweg', 'Vorlagenstraße',
  'Nachbildungsallee', 'Dummyweg', 'Simulationsring', 'Übungsweg', 'Versuchsstraße',
];
const POSTAL = [
  ['10115', 52.532, 13.384], ['10117', 52.517, 13.389], ['10178', 52.521, 13.41], ['10243', 52.512, 13.44],
  ['10405', 52.535, 13.425], ['10623', 52.508, 13.322], ['10709', 52.495, 13.31], ['10961', 52.49, 13.395],
  ['12043', 52.48, 13.44], ['10247', 52.515, 13.468], ['13353', 52.545, 13.355], ['10785', 52.505, 13.365],
];
function postalFor(p) {
  let best = POSTAL[0];
  let bestD = Infinity;
  for (const row of POSTAL) {
    const d = dist(p, { lat: row[1], lon: row[2] });
    if (d < bestD) { bestD = d; best = row; }
  }
  return best[0];
}
function makeAddress(p, avoidStreet = null) {
  let street = pick(STREETS);
  while (street === avoidStreet) street = pick(STREETS);
  const number = ri(1, 120);
  const postal = postalFor(p);
  return { p, street, number, postal, text: `${street} ${number}, ${postal} Berlin, Deutschland` };
}

// ── Money ────────────────────────────────────────────────────────────────────
const money = n => n.toFixed(2);
function fareFor(km, minutes) {
  const raw = (3.9 + 1.55 * km + 0.3 * minutes) * rf(0.93, 1.07);
  return Math.min(45, Math.max(9, raw));
}

// ── Shifts ───────────────────────────────────────────────────────────────────
const WEEKDAYS_DEC = [1, 2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 28, 29, 30, 31];
const dowOf = day => new Date(Date.UTC(2026, 11, day)).getUTCDay(); // 0 = Sunday

const DRIVERS = [
  {
    name: 'Anna Beispiel', plate: 'B-DEMO-1',
    days: WEEKDAYS_DEC.filter(d => ![24, 25, 31, 14, 22].includes(d)),
    startHour: [7, 9],
  },
  {
    name: 'Emil Normal', plate: 'B-DEMO-2',
    days: WEEKDAYS_DEC.filter(d => ![24, 25, 3, 10, 17].includes(d)),
    startHour: [10, 12],
  },
  {
    name: 'Bert Nachtfahrt', plate: 'B-DEMO-3',
    // Thursday to Sunday nights; the night of 31.12. would run into January.
    days: Array.from({ length: 31 }, (_, i) => i + 1).filter(d => [4, 5, 6, 0].includes(dowOf(d)) && d !== 31),
    startHour: [21, 22],
  },
];

/** Rides given a deliberate edge case, keyed "driver:shiftIndex:rideIndex". */
const SPECIAL = {
  'Anna Beispiel:6:2': 'same_address',
  'Emil Normal:5:3': 'same_street',
  'Bert Nachtfahrt:8:2': 'zero_distance',
  'Anna Beispiel:12:1': 'implausible_speed',
};
/** Where a cancelled ride is slipped in: "driver:shiftIndex" after ride index 1. */
const CANCELLED_AFTER = { 'Anna Beispiel:9': 1, 'Emil Normal:11': 2, 'Bert Nachtfahrt:4': 1 };
/** Rides ordered away from the base after the previous ride ended. */
const AWAY = new Set([
  'Anna Beispiel:3:3', 'Anna Beispiel:14:2', 'Emil Normal:7:2', 'Emil Normal:13:4', 'Bert Nachtfahrt:6:3', 'Bert Nachtfahrt:12:2',
]);
/** Rides ordered a few minutes after the previous one ended, near the base. */
const AT_BASE_RATE = 0.13;
const PREBOOKED = new Set(['Anna Beispiel:2:1', 'Anna Beispiel:10:3', 'Emil Normal:4:2', 'Emil Normal:12:1', 'Bert Nachtfahrt:3:3', 'Bert Nachtfahrt:10:1']);

function buildRide(ctx, prev, key, driver, i, shiftStart) {
  const special = SPECIAL[key];
  const kind = i === 0 ? 'first'
    : AWAY.has(key) ? 'away'
      : rng() < AT_BASE_RATE ? 'at_base' : 'during';
  let start;
  let order;
  let pickupPoint;
  let position;
  if (kind === 'first') {
    start = shiftStart;
    order = start - ri(3, 9) * MIN - ri(0, 59);
    pickupPoint = pointAway(BASE, rf(1.2, 6));
    position = nearBase(0.75);
  } else if (kind === 'during') {
    const overlap = ri(2, Math.min(9, Math.floor((prev.end - prev.start) / MIN) - 2));
    order = prev.end - overlap * MIN - ri(0, 59);
    start = prev.end + ri(3, 8) * MIN + ri(0, 59);
    pickupPoint = prev.drop.p;
    position = {
      lat: (prev.pick.p.lat + prev.drop.p.lat) / 2 + rf(-0.004, 0.004),
      lon: (prev.pick.p.lon + prev.drop.p.lon) / 2 + rf(-0.006, 0.006),
    };
  } else if (kind === 'at_base') {
    order = prev.end + ri(1, 3) * MIN + ri(0, 59);
    start = order + ri(3, 6) * MIN + ri(0, 59);
    pickupPoint = pointAway(BASE, rf(1, 4));
    position = nearBase(0.9);
  } else {
    order = prev.end + ri(10, 15) * MIN + ri(0, 59);
    start = order + ri(2, 4) * MIN + ri(0, 59);
    position = offset(BASE, rf(5.5, 14), rf(0, 2 * Math.PI));
    pickupPoint = pointAway(position, rf(0.3, 1.2));
  }
  if (kind !== 'first' && start - prev.end > 20 * MIN) start = prev.end + 20 * MIN;

  let minutes = ri(8, 40);
  let km;
  if (special === 'same_address') minutes = ri(8, 10);
  if (special === 'same_street') minutes = ri(8, 10);
  if (special === 'zero_distance') minutes = ri(6, 8);
  if (special === 'implausible_speed') minutes = 8;
  const speed = rf(16, 36);
  km = Math.round(((minutes * speed) / 60) * 10) / 10;

  const pick1 = makeAddress(pickupPoint);
  let drop;
  if (special === 'same_address') {
    drop = { ...pick1 };
    km = Math.round(minutes * 0.2 * 10) / 10;
  } else if (special === 'same_street') {
    const number = pick1.number + ri(20, 60);
    drop = { ...pick1, number, text: `${pick1.street} ${number}, ${pick1.postal} Berlin, Deutschland`, p: offset(pick1.p, 0.5, rf(0, 6)) };
    km = Math.round(minutes * 0.18 * 10) / 10;
  } else if (special === 'zero_distance') {
    drop = makeAddress(pointAway(pickupPoint, 2), pick1.street);
    km = 0;
  } else {
    if (special === 'implausible_speed') km = 40;
    drop = makeAddress(pointAway(pickupPoint, Math.max(0.8, km / 1.3)), pick1.street);
  }

  const startSec = start;
  const endSec = start + minutes * MIN + ri(0, 59);
  const prebooked = PREBOOKED.has(key);
  const fare = special === 'zero_distance' ? 9 : fareFor(km, minutes);
  const cash = rng() < 0.16;
  const tip = rng() < 0.07 ? pick([1, 1.5, 2, 3, 5]) : 0;
  return {
    start: startSec, end: endSec, order, pick: pick1, drop, position, km, fare, cash, tip, prebooked,
    status: 'Abgeschlossen', special: special ?? null, kind, driver: driver.name, plate: driver.plate,
  };
}

function buildCancelled(driver, prev, key) {
  const order = prev.start + 5 * MIN + ri(0, 59);
  return {
    start: null, end: null, order, pick: makeAddress(pointAway(BASE, rf(1, 7))), drop: null,
    position: pointAway(prev.drop.p, rf(0.2, 1)), km: 0, fare: pick([3.5, 4.5, 5, 6.5]), cash: false, tip: 0, prebooked: false,
    status: 'Storniert', special: 'cancelled', kind: 'cancelled', driver: driver.name, plate: driver.plate,
    shiftKey: key,
  };
}

function buildRides() {
  const rides = [];
  for (const driver of DRIVERS) {
    driver.days.forEach((day, shiftIndex) => {
      const shiftStart = (day - 1) * 24 * 3600 + ri(...driver.startHour) * 3600 + ri(0, 3) * 15 * MIN + ri(0, 59);
      const count = ri(4, 7);
      let prev = null;
      for (let i = 0; i < count; i++) {
        const key = `${driver.name}:${shiftIndex}:${i}`;
        const ride = buildRide({}, prev, key, driver, i, shiftStart);
        rides.push(ride);
        prev = ride;
        const cancelKey = `${driver.name}:${shiftIndex}`;
        if (CANCELLED_AFTER[cancelKey] === i) rides.push(buildCancelled(driver, ride, cancelKey));
      }
    });
  }
  return rides;
}

// ── Rows ─────────────────────────────────────────────────────────────────────
const pos = p => `${p.lat.toFixed(6)} ${p.lon.toFixed(6)}`;

function toRow(r) {
  const received = r.prebooked ? r.order - (20 * 3600 + ri(0, 1800)) : r.order - ri(20, 110);
  const completed = r.status === 'Abgeschlossen';
  return [
    stamp(received),
    stamp(r.order),
    r.prebooked ? stamp(Math.ceil(r.start / (5 * MIN)) * 5 * MIN) : null,
    dateOf(completed ? r.start : r.order),
    r.status,
    pos(r.position),
    completed ? stamp(r.start) : null,
    completed ? stamp(r.end) : null,
    r.plate,
    'UberX',
    r.driver,
    money(r.fare),
    money(r.tip),
    r.km === 0 ? '0' : r.km.toFixed(1),
    r.cash ? 'Bargeld' : 'Uber App',
    r.pick.text,
    completed ? r.drop.text : null,
    r.prebooked ? 'Ja' : 'Nein',
  ];
}

export function generate() {
  const rides = buildRides().sort((a, b) => (a.order - b.order) || a.driver.localeCompare(b.driver));
  return { rides, rows: rides.map(toRow) };
}

async function main() {
  const { rides, rows } = generate();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Fahrten');
  ws.addRow(HEADERS);
  for (const row of rows) ws.addRow(row.map(v => (v === null ? null : String(v))));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, FILE_NAME);
  await wb.xlsx.writeFile(target);

  const by = {};
  for (const r of rides) {
    by[r.driver] ??= { rides: 0, cancelled: 0 };
    by[r.driver][r.status === 'Storniert' ? 'cancelled' : 'rides']++;
  }
  console.log(JSON.stringify({ file: target, rows: rows.length, byDriver: by }, null, 2));
}

if (process.argv[1]?.endsWith('december-2026.mjs')) await main();
