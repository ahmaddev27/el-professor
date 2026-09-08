import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { exportStundennachweisAsPdf } from '../utils/stundennachweisPdfExport';
import { ChevronLeft, ChevronRight, Download, RefreshCw, ArrowRight, User, Euro, Clock, StickyNote, Moon, Sun, Star, Save, FileSpreadsheet, AlertTriangle, CalendarRange, ChevronDown } from 'lucide-react';
import { categorizeWarnings, formatDateDE, groupByDate, type WarningGroup } from '../utils/warningCategories';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { format, getDaysInMonth } from 'date-fns';
import { exportFahreruebersichtToExcel, SavedStundennachweis, DriverSummary } from '../utils/fahreruebersichtExport';

// ─── Constants ─────────────────────────────────────────────────────────────

const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

const MONTH_NAMES_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

// Additive premium rates (premium-only model — Option B)
// Each worked minute always earns base × 1.00 (wage type 1000).
// The values below are additive on top of the base rate.
//
// 1000 Stundenlohn        → base = 1.00  (always)
// 1501 Nachtzuschlag      → +0.40  (20:00–06:00)
// 1510 Sonntagszuschlag   → +0.50  (Sunday)
// 1520 Feiertagszuschlag  → +1.25  (public holiday)
// Saturday                → no Zuschlag (not in official wage-type list)
// Weihnachten / 1. Mai    → tracked separately in display, same as Feiertag rate
const PREM_NIGHT   = 0.40;   // 1501: 20:00–06:00  +40%
const PREM_SUN     = 0.50;   // 1510: Sunday       +50%
const PREM_HOLIDAY = 1.25;   // 1520: holiday      +125%

// ─── Hard validation limits for Stundennachweis ────────────────────────────
//
// Single Schicht (shift) must NEVER exceed 4:30 hours.
// Per-day total work must respect the configured daily cap (8:30 = 510 min).
const MAX_SHIFT_DURATION_MINUTES = 270;  // 4:30 per Schicht
const MAX_DAILY_DURATION_MINUTES = 510;  // 8:30 per day total

// ─── German public holiday engine ───────────────────────────────────────────
//
// Supports all 16 Bundesländer.  Pass a bundesland code (see BUNDESLAND_CODES)
// or leave it empty for nationwide-only holidays.

// Maps the free-text "state" field stored in company_settings to a canonical
// two-letter code used internally.  Case-insensitive prefix matching.
const BUNDESLAND_ALIASES: Record<string, string> = {
  'BW': 'BW', 'BADEN': 'BW', 'WÜRTTEMBERG': 'BW',
  'BY': 'BY', 'BAYER': 'BY',
  'BE': 'BE', 'BERLIN': 'BE',
  'BB': 'BB', 'BRANDEN': 'BB',
  'HB': 'HB', 'BREMEN': 'HB',
  'HH': 'HH', 'HAMBURG': 'HH',
  'HE': 'HE', 'HESSEN': 'HE',
  'MV': 'MV', 'MECKLEN': 'MV',
  'NI': 'NI', 'NIEDER': 'NI',
  'NW': 'NW', 'NORDRHEIN': 'NW', 'WESTFALEN': 'NW', 'NRW': 'NW',
  'RP': 'RP', 'RHEINLAND': 'RP',
  'SL': 'SL', 'SAARLAND': 'SL',
  'SN': 'SN', 'SACHSEN': 'SN',
  'ST': 'ST', 'SACHSEN-A': 'ST',
  'SH': 'SH', 'SCHLESWIG': 'SH',
  'TH': 'TH', 'THÜRINGEN': 'TH',
};

function parseBundesland(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const up = raw.trim().toUpperCase();
  if (up.length <= 3) return BUNDESLAND_ALIASES[up] ?? null;
  for (const [prefix, code] of Object.entries(BUNDESLAND_ALIASES)) {
    if (up.startsWith(prefix)) return code;
  }
  return null;
}

// Anonymous Gregorian Easter algorithm
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m2 = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m2 + 114) / 31);
  const day   = ((h + l - 7 * m2 + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

// Returns all applicable German public holidays for a year + optional Bundesland.
function getHolidaysForYear(year: number, bundesland?: string | null): Set<string> {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const add = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  const easter = easterSunday(year);
  const bl = parseBundesland(bundesland);

  // ── Nationwide holidays (all 16 Bundesländer) ─────────────────────────────
  const h = new Set<string>([
    fmt(new Date(year,  0,  1)),   // Neujahr
    fmt(add(easter, -2)),          // Karfreitag
    fmt(add(easter,  1)),          // Ostermontag
    fmt(new Date(year,  4,  1)),   // Tag der Arbeit
    fmt(add(easter, 39)),          // Christi Himmelfahrt
    fmt(add(easter, 50)),          // Pfingstmontag
    fmt(new Date(year,  9,  3)),   // Tag der Deutschen Einheit
    fmt(new Date(year, 11, 25)),   // 1. Weihnachtstag
    fmt(new Date(year, 11, 26)),   // 2. Weihnachtstag
  ]);

  if (!bl) return h;

  // ── Bundesland-specific holidays ─────────────────────────────────────────

  // Heilige Drei Könige — BW, BY, ST
  if (['BW', 'BY', 'ST'].includes(bl))
    h.add(fmt(new Date(year, 0, 6)));

  // Frauentag — BE (since 2019)
  if (bl === 'BE' && year >= 2019)
    h.add(fmt(new Date(year, 2, 8)));

  // Gründonnerstag — BB (only in specific years/municipalities — omitted; not a universal BB holiday)

  // Ostersonntag — BB
  if (bl === 'BB')
    h.add(fmt(easter));

  // Fronleichnam — BW, BY, HE, NW, RP, SL, SN (only specific areas), TH (specific areas)
  if (['BW', 'BY', 'HE', 'NW', 'RP', 'SL'].includes(bl))
    h.add(fmt(add(easter, 60)));

  // Mariä Himmelfahrt — BY (Gemeinden mit überwiegend kath. Bevölkerung), SL
  if (['BY', 'SL'].includes(bl))
    h.add(fmt(new Date(year, 7, 15)));

  // Weltkindertag — TH
  if (bl === 'TH')
    h.add(fmt(new Date(year, 8, 20)));

  // Reformationstag — BB, HB, HH, MV, NI, SN, ST, SH, TH
  if (['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH'].includes(bl))
    h.add(fmt(new Date(year, 9, 31)));

  // Allerheiligen — BW, BY, NW, RP, SL
  if (['BW', 'BY', 'NW', 'RP', 'SL'].includes(bl))
    h.add(fmt(new Date(year, 10, 1)));

  // Buß- und Bettag — SN (Wednesday before Nov 23)
  if (bl === 'SN') {
    const nov23 = new Date(year, 10, 23);
    const bbt   = add(nov23, -(((nov23.getDay() + 4) % 7) + 1)); // last Wed before Nov 23
    h.add(fmt(bbt));
  }

  return h;
}

function fmtDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// No module-level cache — always compute fresh so the correct bundesland is
// used regardless of when settings finish loading.
function dateIsHoliday(d: Date, bundesland?: string | null): boolean {
  return getHolidaysForYear(d.getFullYear(), bundesland).has(fmtDateKey(d));
}

// Returns all holiday date-strings for a specific month (1-based) and year.
// Used to pre-check whether any holidays exist before attempting allocation.
function getHolidaysInMonth(year: number, month: number, bundesland?: string | null): string[] {
  const all = getHolidaysForYear(year, bundesland);
  const prefix = `${year}-${String(month).padStart(2, '0')}-`;
  return [...all].filter(k => k.startsWith(prefix)).sort();
}

// ─── Types ─────────────────────────────────────────────────────────────────

interface DriverOption {
  id: string;
  name: string;
  personalnummer?: string;
  work_window_start?: string | null;
  work_window_end?: string | null;
  allowed_weekdays?: number[] | null;
}

interface Note {
  id: string;
  driver_id: string;
  note_date: string;
  note_text: string;
  start_date?: string | null;
  end_date?: string | null;
  is_full_day?: boolean;
  note_planning_behavior?: string | null;
}

interface DayRow {
  dayIndex: number;
  date: Date;
  weekday: string;
  isSat: boolean;
  isSun: boolean;
  isHol: boolean;
  von1: string; bis1: string;
  von2: string; bis2: string;
  von3: string; bis3: string;
  grundlohn:    string;
  nachtarbeit:  string;
  nachtarbeit04: string;
  samstag:      string;
  sonntag:      string;
  feiertag:     string;
  weihnachten:  string;
  noteHighlight: boolean;
}

interface Totals {
  grundlohn:    number;
  nachtarbeit:  number;
  nacht04:      number;
  samstag:      number;
  sonntag:      number;
  feiertag:     number;
  weihnachten:  number;
}

// ─── Saved-row serialization helpers ────────────────────────────────────────

// Reconstruct a DayRow's Date from stored data.
// Prefers date_key ("YYYY-MM-DD"), falls back to dayIndex + month/year context,
// and only uses the ISO string as a last resort (applying the day from dayIndex
// to avoid UTC-vs-local offset errors in old records).
function deserializeRowDate(row: Record<string, unknown>, month: number, year: number): Date {
  if (typeof row.date_key === 'string' && row.date_key.length === 10) {
    const [y, mo, d] = row.date_key.split('-').map(Number);
    return new Date(y, mo - 1, d);
  }
  if (typeof row.dayIndex === 'number') {
    return new Date(year, month - 1, row.dayIndex as number);
  }
  // Legacy ISO string — use dayIndex to avoid UTC offset shift
  return new Date(year, month - 1, row.dayIndex as number ?? 1);
}

// Restore a rows_json array from DB to proper DayRow[] with Date objects.
function deserializeRows(rawRows: unknown[], month: number, year: number): DayRow[] {
  return (rawRows as Record<string, unknown>[]).map(r => ({
    ...(r as DayRow),
    von3: (r as Record<string, unknown>).von3 as string ?? '',
    bis3: (r as Record<string, unknown>).bis3 as string ?? '',
    date: deserializeRowDate(r, month, year),
  }));
}

// ─── Time helpers ───────────────────────────────────────────────────────────

function hhmm(h: number, m: number): string {
  return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor(m)).padStart(2, '0')}`;
}

function toMins(t: string): number {
  if (!t || t.length < 4 || !t.includes(':')) return 0;
  const [h, m] = t.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return 0;
  return h * 60 + m;
}

function minsToHHMM(mins: number): string {
  if (mins <= 0) return '';
  return hhmm(Math.floor(mins / 60), mins % 60);
}

function minsToDecimal(mins: number): number {
  return Math.round((mins / 60) * 100) / 100;
}

function fmtDec(v: number): string {
  return v.toFixed(2).replace('.', ',');
}

function segDuration(from: string, to: string): number {
  if (!from || !to) return 0;
  const f = toMins(from), t = toMins(to);
  return t >= f ? t - f : 1440 - f + t;
}

// Returns night minutes (20:00–06:00) for a shift segment.
// Single premium window — wage type 1501 applies one flat +40% rate across the
// entire 20:00–06:00 window; there is no separate 00–04 tier.
function nightMinsForSeg(from: string, to: string): number {
  if (!from || !to) return 0;
  const f = toMins(from), t = toMins(to);
  const absTo = t >= f ? t : t + 1440;
  // 20:00–24:00 segment
  const seg1 = Math.max(0, Math.min(absTo, 24 * 60) - Math.max(f, 20 * 60));
  // 00:00–06:00 of next day (absolute: 24*60–30*60)
  const seg2 = Math.max(0, Math.min(absTo, 30 * 60) - Math.max(f, 24 * 60));
  return seg1 + seg2;
}

// Returns minutes overlapping with 00:00–04:00 for a shift segment.
// Works in absolute minutes: if a shift crosses midnight, absTo > 1440.
// Overlap with same-day 00:00–04:00: [0, 240)
// Overlap with next-day 00:00–04:00 (post-midnight part): [1440, 1680)
function nacht04MinsForSeg(from: string, to: string): number {
  if (!from || !to) return 0;
  const f = toMins(from), t = toMins(to);
  const absTo = t >= f ? t : t + 1440;
  // Same-day portion: overlap of [f, absTo] with [0, 240]
  const sameDayPart = Math.max(0, Math.min(absTo, 4 * 60) - Math.max(f, 0));
  // Cross-midnight portion: overlap of post-midnight [1440, absTo] with [1440, 1680]
  const crossPart   = Math.max(0, Math.min(absTo, 24 * 60 + 4 * 60) - Math.max(f, 24 * 60));
  return sameDayPart + crossPart;
}

// ─── Row calculation ────────────────────────────────────────────────────────

function calcRow(row: DayRow): DayRow {
  const dur1 = segDuration(row.von1, row.bis1);
  const dur2 = segDuration(row.von2, row.bis2);
  const dur3 = segDuration(row.von3, row.bis3);
  const total = dur1 + dur2 + dur3;

  if (total === 0) {
    return { ...row, grundlohn: '', nachtarbeit: '', nachtarbeit04: '', samstag: '', sonntag: '', feiertag: '', weihnachten: '' };
  }

  const nightMins   = nightMinsForSeg(row.von1, row.bis1)   + nightMinsForSeg(row.von2, row.bis2)   + nightMinsForSeg(row.von3, row.bis3);
  const nacht04Mins = nacht04MinsForSeg(row.von1, row.bis1) + nacht04MinsForSeg(row.von2, row.bis2) + nacht04MinsForSeg(row.von3, row.bis3);
  const samstag  = (row.isSat && !row.isHol) ? total : 0;
  const sonntag  = (row.isSun && !row.isHol) ? total : 0;
  const feiertag = row.isHol ? total : 0;
  const d = row.date;
  const isXmas = (d.getMonth() === 11 && (d.getDate() === 25 || d.getDate() === 26))
              || (d.getMonth() === 4  && d.getDate() === 1);
  const weihnachten = (isXmas && total > 0) ? total : 0;

  return {
    ...row,
    grundlohn:     minsToHHMM(total),
    nachtarbeit:   nightMins   > 0 ? minsToHHMM(nightMins)   : '',
    nachtarbeit04: nacht04Mins > 0 ? minsToHHMM(nacht04Mins) : '',
    samstag:       samstag     > 0 ? minsToHHMM(samstag)     : '',
    sonntag:       sonntag     > 0 ? minsToHHMM(sonntag)     : '',
    feiertag:      feiertag    > 0 ? minsToHHMM(feiertag)    : '',
    weihnachten:   weihnachten > 0 ? minsToHHMM(weihnachten) : '',
  };
}

function calcTotals(rows: DayRow[]): Totals {
  return {
    grundlohn:   rows.reduce((s, r) => s + toMins(r.grundlohn),    0),
    nachtarbeit: rows.reduce((s, r) => s + toMins(r.nachtarbeit),  0),
    nacht04:     rows.reduce((s, r) => s + toMins(r.nachtarbeit04),0),
    samstag:     rows.reduce((s, r) => s + toMins(r.samstag),      0),
    sonntag:     rows.reduce((s, r) => s + toMins(r.sonntag),      0),
    feiertag:    rows.reduce((s, r) => s + toMins(r.feiertag),     0),
    weihnachten: rows.reduce((s, r) => s + toMins(r.weihnachten),  0),
  };
}

// ─── Hard duration validation ──────────────────────────────────────────────
//
// Rules:
//   - Each Schicht (1, 2, 3) must be ≤ MAX_SHIFT_DURATION_MINUTES (4:30).
//   - The day total (Schicht 1 + 2 + 3) must be ≤ MAX_DAILY_DURATION_MINUTES (8:30).
// Violations BLOCK save and PDF export.

type DurationViolation =
  | { type: 'shift'; dayIndex: number; date: Date; weekday: string; shiftLabel: 'Schicht 1' | 'Schicht 2' | 'Schicht 3'; von: string; bis: string; durationMinutes: number; limit: number }
  | { type: 'daily'; dayIndex: number; date: Date; weekday: string; durationMinutes: number; limit: number };

function validateRowDurations(rows: DayRow[]): DurationViolation[] {
  const violations: DurationViolation[] = [];
  for (const row of rows) {
    const segs: Array<{ label: 'Schicht 1' | 'Schicht 2' | 'Schicht 3'; von: string; bis: string }> = [
      { label: 'Schicht 1', von: row.von1, bis: row.bis1 },
      { label: 'Schicht 2', von: row.von2, bis: row.bis2 },
      { label: 'Schicht 3', von: row.von3, bis: row.bis3 },
    ];
    let dailyTotal = 0;
    for (const s of segs) {
      if (!s.von || !s.bis) continue;
      const dur = segDuration(s.von, s.bis);
      dailyTotal += dur;
      if (dur > MAX_SHIFT_DURATION_MINUTES) {
        violations.push({
          type: 'shift',
          dayIndex: row.dayIndex,
          date: row.date,
          weekday: row.weekday,
          shiftLabel: s.label,
          von: s.von,
          bis: s.bis,
          durationMinutes: dur,
          limit: MAX_SHIFT_DURATION_MINUTES,
        });
      }
    }
    if (dailyTotal > MAX_DAILY_DURATION_MINUTES) {
      violations.push({
        type: 'daily',
        dayIndex: row.dayIndex,
        date: row.date,
        weekday: row.weekday,
        durationMinutes: dailyTotal,
        limit: MAX_DAILY_DURATION_MINUTES,
      });
    }
  }
  return violations;
}

// ─── Pflichtnotiz insertion ─────────────────────────────────────────────────
//
// For each must_include_in_plan note, ensures the DayRow for that date has a
// shift covering noteTime ± 30 min. Inserts into an empty slot or extends the
// nearest shift. Sorts all non-empty shifts chronologically after insertion.
// Returns updated rows (original array mutated in-place).

function sortShiftsChronologically(row: DayRow): DayRow {
  const slots: [string, string][] = [
    [row.von1, row.bis1],
    [row.von2, row.bis2],
    [row.von3, row.bis3],
  ].filter(([v, b]) => v && b) as [string, string][];
  slots.sort(([a], [b]) => toMins(a) - toMins(b));
  return {
    ...row,
    von1: slots[0]?.[0] ?? '', bis1: slots[0]?.[1] ?? '',
    von2: slots[1]?.[0] ?? '', bis2: slots[1]?.[1] ?? '',
    von3: slots[2]?.[0] ?? '', bis3: slots[2]?.[1] ?? '',
  };
}

function minsToTime(m: number): string {
  const clamped = Math.max(0, Math.min(1439, m));
  return hhmm(Math.floor(clamped / 60), clamped % 60);
}

function applyMustIncludeNotesToRows(rows: DayRow[], notes: Note[]): DayRow[] {
  const mustNotes = notes.filter(n => n.note_planning_behavior === 'must_include_in_plan');
  if (mustNotes.length === 0) return rows;

  const result = rows.map(r => ({ ...r }));

  for (const note of mustNotes) {
    // Parse note time from ISO datetime in note_date (e.g. "2026-05-20T12:16:00")
    const nd = new Date(note.note_date);
    const noteMin = nd.getHours() * 60 + nd.getMinutes();
    if (noteMin === 0 && !note.note_date.includes('T')) continue;

    const winStart = Math.max(0, noteMin - 30);
    const winEnd   = Math.min(23 * 60 + 59, noteMin + 30);
    const noteDay  = nd.getDate();
    const noteYear = nd.getFullYear();
    const noteMonth = nd.getMonth();

    const idx = result.findIndex(r =>
      r.date.getFullYear() === noteYear &&
      r.date.getMonth()    === noteMonth &&
      r.date.getDate()     === noteDay
    );
    if (idx < 0) continue;

    let row = result[idx];
    let { von1, bis1, von2, bis2, von3, bis3 } = row;

    // Check if already covered
    const isCovered = (
      (von1 && bis1 && toMins(von1) <= winStart && toMins(bis1) >= winEnd) ||
      (von2 && bis2 && toMins(von2) <= winStart && toMins(bis2) >= winEnd) ||
      (von3 && bis3 && toMins(von3) <= winStart && toMins(bis3) >= winEnd)
    );
    if (isCovered) continue;

    // Insert coverage window into an available slot
    if (!von1 || !bis1) {
      von1 = minsToTime(winStart); bis1 = minsToTime(winEnd);
    } else if (!von2 || !bis2) {
      const v1e = toMins(bis1);
      if (winStart >= v1e) {
        von2 = minsToTime(winStart); bis2 = minsToTime(winEnd);
      } else if (winEnd <= toMins(von1)) {
        von2 = von1; bis2 = bis1;
        von1 = minsToTime(winStart); bis1 = minsToTime(winEnd);
      } else {
        von1 = minsToTime(Math.min(toMins(von1), winStart));
        bis1 = minsToTime(Math.max(toMins(bis1), winEnd));
      }
    } else if (!von3 || !bis3) {
      const v2e = toMins(bis2);
      if (winStart >= v2e) {
        von3 = minsToTime(winStart); bis3 = minsToTime(winEnd);
      } else {
        const dist1 = Math.min(Math.abs(noteMin - toMins(von1)), Math.abs(noteMin - toMins(bis1)));
        const dist2 = Math.min(Math.abs(noteMin - toMins(von2)), Math.abs(noteMin - toMins(bis2)));
        if (dist1 <= dist2) {
          von1 = minsToTime(Math.min(toMins(von1), winStart));
          bis1 = minsToTime(Math.max(toMins(bis1), winEnd));
        } else {
          von2 = minsToTime(Math.min(toMins(von2), winStart));
          bis2 = minsToTime(Math.max(toMins(bis2), winEnd));
        }
      }
    }
    // (all 3 slots occupied: leave as-is)

    row = sortShiftsChronologically({ ...row, von1, bis1, von2, bis2, von3, bis3 });
    result[idx] = calcRow(row);
  }

  return result;
}

// ─── Salary calculation ─────────────────────────────────────────────────────
//
// Returns salary in cents (integer) to avoid floating-point accumulation.
// Divide by 100 for euros. This is the canonical formula used by both the
// generator and the live display — they must be identical.

function salaryInCents(rows: DayRow[], hourlyRateCents: number): number {
  // Premium-only model (Option B):
  // Every worked minute earns base × 1.00 (wage type 1000).
  // Applicable premiums are additive on top.
  let totalCents = 0;
  for (const row of rows) {
    const totalMins = toMins(row.grundlohn);
    if (totalMins === 0) continue;

    // 1000 Stundenlohn — base pay for all worked minutes
    totalCents += (totalMins * hourlyRateCents) / 60;

    // 1501 Nachtzuschlag +40% — applied to night minutes (20:00–06:00)
    const nightMins = toMins(row.nachtarbeit);
    totalCents += (nightMins * hourlyRateCents * Math.round(PREM_NIGHT * 100)) / (60 * 100);

    // 1510 Sonntagszuschlag +50% — applied to all minutes on a Sunday
    if (row.isSun && !row.isHol) {
      totalCents += (totalMins * hourlyRateCents * Math.round(PREM_SUN * 100)) / (60 * 100);
    }

    // 1520 Feiertagszuschlag +125% — applied to all minutes on a public holiday
    // (Includes Weihnachten 25./26.12, 1. Mai, Silvester 31.12, etc.)
    if (row.isHol) {
      totalCents += (totalMins * hourlyRateCents * Math.round(PREM_HOLIDAY * 100)) / (60 * 100);
    }

    // Saturday: no Zuschlag (not in official wage-type list)
  }
  return Math.round(totalCents);
}

function salaryEuros(rows: DayRow[], hourlyRate: number): number {
  return salaryInCents(rows, Math.round(hourlyRate * 100)) / 100;
}

// ─── Plan generator ─────────────────────────────────────────────────────────

// Final safety pass: if any row's Schicht 2 starts before or at Schicht 1 end,
// push Schicht 2 forward by exactly the needed amount (preserving its duration).
// This is a last-resort guard; no correct generation path should trigger it.
function enforceNoOverlap(rows: DayRow[]): void {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.von2 || !row.bis2 || !row.bis1) continue;
    const e1 = toMins(row.bis1);
    const s2 = toMins(row.von2);
    if (s2 > e1 + 39) continue;

    const dur2   = segDuration(row.von2, row.bis2);
    const newS2  = e1 + 40;
    const newE2  = newS2 + dur2;
    if (newE2 > 23 * 60 + 59) {
      rows[i] = calcRow({ ...row, von2: '', bis2: '' });
    } else {
      rows[i] = calcRow({
        ...row,
        von2: hhmm(Math.floor(newS2 / 60), newS2 % 60),
        bis2: hhmm(Math.floor(newE2 / 60), newE2 % 60),
      });
    }
  }
}

// Strict structural rule: any working day with > 5h00 (300 min) total worked
// time MUST be split into Schicht 1 + Schicht 2 with a break of ≥ 40 min.
//
// Strategy: pull \`von1` BACKWARD by 40 minutes, place a 40-min break in the
// middle, and keep the original `bis1` as the new `bis2`. Total worked time
// is preserved EXACTLY (D minutes split as part1 + part2 with D = part1+part2),
// so every category total (Grundlohn, Nachtarbeit, Sonntag, Feiertag, …)
// stays identical to the pre-split value. Splits never enter the 00:00–06:00
// night window because the back-shift is bounded.
//
// Acts as a safety net after all repair / fine-tune passes that may have
// extended a single-shift row past the 5h threshold.
function enforceMandatorySplit(rows: DayRow[], rngSeed: number): void {
  const MIN_BREAK = 40;
  const THRESHOLD = 5 * 60; // 300 min — strictly greater triggers the rule
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.noteHighlight) continue;
    if (!r.von1 || !r.bis1) continue;
    if (r.von2 && r.bis2) continue;             // already split
    const total = segDuration(r.von1, r.bis1);
    if (total <= THRESHOLD) continue;           // ≤ 5h00 may stay single
    // Skip night-window-only rows (they're capped < 5h by construction):
    // nachtarbeit (20:00–23:59) and nacht04 (00:00–04:00).
    if (toMins(r.nachtarbeit04) > 0) continue;
    const origStart = toMins(r.von1);
    const origEnd   = toMins(r.bis1);
    if (origStart < 4 * 60 + MIN_BREAK) continue; // can't pull back without entering 00–04
    // 40–60% in first shift, varied per row so splits don't all look identical
    const fracRoll = ((rngSeed * 9301 + i * 49297 + 233280) % 233280) / 233280;
    const frac = 0.40 + fracRoll * 0.20;
    const part1 = Math.max(30, Math.round(total * frac));
    const part2 = total - part1;
    if (part2 < 15) continue;
    const s1 = origStart - MIN_BREAK;
    const e1 = s1 + part1;
    const s2 = e1 + MIN_BREAK;                  // = origStart + part1
    const e2 = s2 + part2;                      // = origEnd  (preserves total)
    if (s1 < 4 * 60) continue;                  // never enter 00–04 window
    if (e2 !== origEnd) continue;               // sanity (must hold by construction)
    rows[i] = calcRow({
      ...r,
      von1: hhmm(Math.floor(s1 / 60), s1 % 60),
      bis1: hhmm(Math.floor(e1 / 60), e1 % 60),
      von2: hhmm(Math.floor(s2 / 60), s2 % 60),
      bis2: hhmm(Math.floor(e2 / 60), e2 % 60),
    });
  }
}

// Work-window + allowed-weekday constraints.
// windowStartMins / windowEndMins: minutes since midnight (e.g. 6*60=360).
// allowedWeekdays: JS getDay() values (0=Sun, 1=Mon, …, 6=Sat).
// An empty allowedWeekdays array means "all weekdays allowed".
interface WorkWindowConstraints {
  windowStartMins: number;   // earliest a shift may start (inclusive)
  windowEndMins:   number;   // latest a shift may end (inclusive)
  allowedWeekdays: number[]; // empty = no restriction
}

interface PlanParams {
  year:           number;
  month:          number;
  targetSalary:   number;
  hourlyRate:     number;
  notes:          Note[];
  seed:           number;
  grundlohnRatio: number; // 0–1: fraction of total hours allocated to plain weekday shifts
  bundesland?:    string | null;
  workWindow?:    WorkWindowConstraints | null;
}

// Deterministic pseudo-random [0,1) from two integers
function prng(a: number, b: number): number {
  const x = Math.sin(a * 9301 + b * 49297 + 233) * 100003;
  return x - Math.floor(x);
}

function generatePlan(params: PlanParams): DayRow[] {
  const { year, month, targetSalary, hourlyRate, notes, seed, grundlohnRatio, bundesland, workWindow } = params;

  // Resolved work-window bounds (fallback to full-day if not set)
  const winStart = workWindow?.windowStartMins ?? 0;
  const winEnd   = workWindow?.windowEndMins   ?? (23 * 60 + 59);
  const allowedDows = workWindow && workWindow.allowedWeekdays.length > 0
    ? new Set(workWindow.allowedWeekdays)
    : null; // null = no restriction
  const glRatio = Math.max(0.05, Math.min(0.99, grundlohnRatio ?? 0.85));
  const daysInMonth = getDaysInMonth(new Date(year, month - 1, 1));
  const hourlyRateCents = Math.round(hourlyRate * 100);
  const targetCents     = Math.round(targetSalary * 100);

  // Notes map
  const notesByDay: Record<number, Note[]> = {};
  for (const n of notes) {
    const nd = new Date(n.note_date);
    if (nd.getFullYear() === year && nd.getMonth() === month - 1) {
      const day = nd.getDate();
      if (!notesByDay[day]) notesByDay[day] = [];
      notesByDay[day].push(n);
    }
  }

  // Build skeleton rows
  const rows: DayRow[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month - 1, day);
    const dow  = date.getDay();
    rows.push({
      dayIndex: day, date,
      weekday: WEEKDAY_SHORT[dow],
      isSat: dow === 6, isSun: dow === 0,
      isHol: dateIsHoliday(date, bundesland),
      von1: '', bis1: '', von2: '', bis2: '', von3: '', bis3: '',
      grundlohn: '', nachtarbeit: '', nachtarbeit04: '',
      samstag: '', sonntag: '', feiertag: '', weihnachten: '',
      noteHighlight: false,
    });
  }

  // Pre-fill note rows
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const dayNotes = notesByDay[row.dayIndex];
    if (!dayNotes) continue;
    row.noteHighlight = true;
    const nd = new Date(dayNotes[0].note_date);
    const nm = nd.getHours() * 60 + nd.getMinutes();
    const s1 = Math.max(0, nm - 60);
    const e1 = Math.min(23 * 60 + 30, nm + 60); // cap well before midnight
    row.von1 = hhmm(Math.floor(s1 / 60), s1 % 60);
    row.bis1 = hhmm(Math.floor(e1 / 60), e1 % 60);
    if (dayNotes.length > 1) {
      const nd2  = new Date(dayNotes[1].note_date);
      const nm2  = nd2.getHours() * 60 + nd2.getMinutes();
      // Guarantee: s2 is always at least 20 minutes after e1 (no overlap)
      const s2   = Math.max(e1 + 20, Math.max(0, nm2 - 60));
      const e2   = Math.min(23 * 60 + 59, Math.max(s2 + 1, nm2 + 60));
      // Only create Schicht 2 if it would still fit before midnight
      if (s2 < 23 * 60 + 59 && s2 < e2) {
        row.von2 = hhmm(Math.floor(s2 / 60), s2 % 60);
        row.bis2 = hhmm(Math.floor(e2 / 60), e2 % 60);
      }
    }
    rows[i] = calcRow(row);
  }

  if (targetSalary <= 0 || hourlyRate <= 0) return rows;

  // Salary already covered by notes
  let coveredCents  = salaryInCents(rows, hourlyRateCents);
  let remainCents   = targetCents - coveredCents;
  if (remainCents <= 0) return rows;

  // Split candidates into three buckets aligned with wage types:
  //
  // plainCandidates    — weekdays (Mon–Fri, not holiday): earn base only
  // nightCandidates    — subset of weekdays designated for 1501 night shifts
  // dayPremiumCandidates — Sunday (1510) + holiday (1520): earn base + premium
  //
  // Saturday is deliberately excluded from premiumCandidates because
  // no official wage-type Zuschlag applies to it.
  //
  // The non-Grundlohn budget (1 - glRatio) is split between nightCandidates
  // and dayPremiumCandidates so that night hours are explicitly part of the
  // premium portion, matching the official model.

  const allPlainWeekdays:    number[] = [];
  const dayPremiumCandidates: number[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.noteHighlight) continue;
    // Skip days not in the allowed-weekdays set
    if (allowedDows && !allowedDows.has(r.date.getDay())) continue;
    // Saturday has no Zuschlag premium, so it always goes to the plain bucket.
    // Only skip it when there is NO explicit allowed-days filter (i.e. allowedDows is null),
    // because in unconstrained mode Saturday is deliberately excluded to keep the premium
    // budget model clean. When the user explicitly selects Saturday it must be usable.
    if (r.isSat && !allowedDows) continue;
    if (r.isSun || r.isHol) { dayPremiumCandidates.push(i); continue; }
    allPlainWeekdays.push(i);
  }
  if (allPlainWeekdays.length === 0 && dayPremiumCandidates.length === 0) return rows;

  // Budget split according to glRatio
  const plainBudgetCents   = Math.round(remainCents * glRatio);
  const premiumBudgetCents = remainCents - plainBudgetCents;

  // Further split the premium budget: half to night shifts, half to day-premium
  // days (Sun/holiday). If day-premium days are scarce, all goes to night.
  const nightBudgetCents      = dayPremiumCandidates.length > 0
    ? Math.round(premiumBudgetCents * 0.5)
    : premiumBudgetCents;
  const dayPremiumBudgetCents = premiumBudgetCents - nightBudgetCents;

  // Strict per-row daily cap: 8:30 (510 min). Enforced everywhere parts are
  // produced or fine-tuned so no generated row ever exceeds 8h30.
  const DAILY_CAP = 510; // 8:30 — strict ceiling

  // Uniform spread selector.
  // TARGET_DAILY_MINS is well below DAILY_CAP so that enough days are selected
  // to keep per-day durations in a natural, varied range after variance is applied.
  const TARGET_DAILY_MINS = Math.round(DAILY_CAP * 0.80); // ~399 min ≈ 6:39
  const spreadSelect = (pool: number[], budgetCents: number): number[] => {
    if (pool.length === 0 || budgetCents <= 0) return [];
    const estDays = Math.max(1, Math.ceil((budgetCents / hourlyRateCents) * (60 / TARGET_DAILY_MINS)));
    const count   = Math.min(pool.length, Math.max(1, estDays));
    const offset  = pool.length > 0 ? seed % pool.length : 0;
    const rotated = [...pool.slice(offset), ...pool.slice(0, offset)];
    const sel: number[] = [];
    for (let i = 0; i < count; i++) {
      sel.push(rotated[Math.floor(i * rotated.length / count)]);
    }
    return sel.sort((a, b) => a - b);
  };

  // Select plain days from the FULL weekday pool so high-salary scenarios have
  // enough days to stay below DAILY_CAP. Night candidates are picked from the
  // days NOT already chosen as plain, preventing any day appearing in both sets.
  const chosenPlain      = spreadSelect(allPlainWeekdays,     plainBudgetCents);
  const plainUsed        = new Set(chosenPlain);
  const nightCandidatePool = allPlainWeekdays.filter(idx => !plainUsed.has(idx));
  const plainCandidates    = []; // unused days for spillover — populated below
  const chosenNight      = spreadSelect(nightCandidatePool,   nightBudgetCents);
  const chosenDayPremium = spreadSelect(dayPremiumCandidates, dayPremiumBudgetCents);
  const chosen           = [...chosenPlain, ...chosenNight, ...chosenDayPremium].sort((a, b) => a - b);
  // Spillover pool: weekdays not assigned to any bucket
  const nightUsed = new Set(chosenNight);
  const allUsed   = new Set(chosen);
  const spilloverCandidates = allPlainWeekdays.filter(idx => !allUsed.has(idx));

  // Shift-start pools
  // Daytime pool for plain and day-premium days — clamped to the work window
  const clampToWin = (m: number) => Math.max(winStart, Math.min(winEnd - 30, m));
  const dayStartPoolsRaw = [
    [ 8*60, 6*60, 10*60, 14*60,  7*60, 12*60, 16*60,  9*60],
    [10*60, 8*60, 14*60,  6*60, 12*60, 17*60,  7*60, 11*60],
    [ 6*60,14*60,  8*60, 10*60, 16*60,  9*60, 12*60,  7*60],
    [12*60, 7*60,  9*60, 15*60,  8*60, 11*60, 17*60,  6*60],
  ];
  const dayStartPools = dayStartPoolsRaw.map(pool => pool.map(clampToWin));
  // Night pool: shifts starting in evening so they cross into the 20:00–06:00 window
  // If the window is narrower than 20:00 start, clamp to winStart.
  const nightStartPoolRaw = [18*60, 19*60, 20*60, 17*60, 21*60, 16*60, 22*60, 18*60];
  const nightStartPool = nightStartPoolRaw.map(m => Math.max(winStart, Math.min(winEnd - 30, m)));
  const dayStartPool   = dayStartPools[seed % dayStartPools.length];

  const nightSet      = new Set(chosenNight);
  const dayPremSet    = new Set(chosenDayPremium);

  // Per-day effective rate (cents per worked minute).
  // For night candidates, the rate includes a partial night premium estimate
  // (assume ~50% of the shift falls in the 20:00–06:00 window for budget sizing).
  const NIGHT_OVERLAP_FRACTION = 0.5;
  const ratePerMin = (idx: number): number => {
    const row = rows[idx];
    let prem100 = 0;
    if (row.isHol) {
      prem100 = Math.round(PREM_HOLIDAY * 100); // 1520: +125
    } else if (row.isSun && !row.isHol) {
      prem100 = Math.round(PREM_SUN * 100);     // 1510: +50
    }
    const dayRate = (hourlyRateCents * (100 + prem100)) / (60 * 100);
    if (nightSet.has(idx)) {
      // Add estimated night premium contribution: NIGHT_OVERLAP_FRACTION of shift earns +40%
      const nightExtra = (hourlyRateCents * Math.round(PREM_NIGHT * 100) * NIGHT_OVERLAP_FRACTION) / (60 * 100);
      return dayRate + nightExtra;
    }
    return dayRate;
  };

  const plainSet = new Set(chosenPlain);

  // Assign durations by distributing each bucket's budget proportionally across
  // its days, then apply per-day variance (±60 min) around that budget-derived
  // target. This avoids the previous approach of scaling a fixed 6.5 h centre by
  // a 1.5× factor which pushed almost every day to the DAILY_CAP ceiling.
  //
  // Per-bucket baseline: budget / (days × ratePerMin) gives the exact equal-
  // split minutes. Variance is applied before capping so days spread naturally.
  const bucketBase = (idx: number, bucketCents: number, bucketCount: number): number => {
    const rpm = ratePerMin(idx);
    return rpm > 0 ? Math.round(bucketCents / bucketCount / rpm) : 7 * 60;
  };
  const plainCount  = chosenPlain.length  || 1;
  const nightCount  = chosenNight.length  || 1;
  const premCount   = chosenDayPremium.length || 1;

  const scaledDurations: number[] = chosen.map((dayRowIdx, i) => {
    const v1 = prng(seed + 7,  i + dayRowIdx);
    const v2 = prng(seed + 31, dayRowIdx * 3 + i);
    const variance = Math.round(((v1 + v2) / 2 - 0.5) * 120); // ±60 min
    let base: number;
    if      (plainSet.has(dayRowIdx))   base = bucketBase(dayRowIdx, plainBudgetCents,      plainCount);
    else if (nightSet.has(dayRowIdx))   base = bucketBase(dayRowIdx, nightBudgetCents,      nightCount);
    else                                base = bucketBase(dayRowIdx, dayPremiumBudgetCents, premCount);
    return Math.min(DAILY_CAP, Math.max(30, base + variance));
  });

  // Re-total what's been allocated per bucket after capping — single pass
  const { allocatedCentsPlain, allocatedCentsNight, allocatedCentsDayPrem } = chosen.reduce(
    (acc, idx, i) => {
      const cost = scaledDurations[i] * ratePerMin(idx);
      if      (plainSet.has(idx))   acc.allocatedCentsPlain   += cost;
      else if (nightSet.has(idx))   acc.allocatedCentsNight   += cost;
      else                          acc.allocatedCentsDayPrem += cost;
      return acc;
    },
    { allocatedCentsPlain: 0, allocatedCentsNight: 0, allocatedCentsDayPrem: 0 },
  );

  // If some days were capped we may be short on budget. Fill the gap by adding
  // extra plain-weekday days from the unused pool until the budget is met.
  // Night and day-premium shortfalls are also covered by plain-weekday spillover days.
  let remainingPlainCents = Math.round(plainBudgetCents - allocatedCentsPlain);
  remainingPlainCents += Math.max(0, Math.round(nightBudgetCents - allocatedCentsNight));
  remainingPlainCents += Math.max(0, Math.round(dayPremiumBudgetCents - allocatedCentsDayPrem));

  const spilloverPool = spilloverCandidates;

  const extraChosen: number[]    = [];
  const extraDurations: number[] = [];
  for (const idx of spilloverPool) {
    if (remainingPlainCents <= 0) break;
    const rpm  = ratePerMin(idx);
    const mins = Math.min(DAILY_CAP, Math.max(30, Math.round(remainingPlainCents / rpm)));
    extraChosen.push(idx);
    extraDurations.push(mins);
    remainingPlainCents -= Math.round(mins * rpm);
  }

  // Combine primary + spillover days into one assignment pass
  const allChosen    = [...chosen,         ...extraChosen];
  const allDurations = [...scaledDurations, ...extraDurations];

  // Assign shifts — night candidates get evening start times.
  // Split shifts: s2 is always derived from e1, guaranteeing no overlap by construction.
  // All end times are hard-capped at winEnd (work-window end) so shifts stay in-window.
  const shiftEndCap = winEnd; // replaces hard-coded 23:59

  for (let ci = 0; ci < allChosen.length; ci++) {
    const idx      = allChosen[ci];
    const row      = rows[idx];
    const dur      = allDurations[ci];
    const isNight  = nightSet.has(idx);
    const pool     = isNight ? nightStartPool : dayStartPool;
    // Use both ci and the row's day index so start times vary more across seeds
    const startMin = pool[(ci + idx) % pool.length];
    const useSplit = !isNight && dur >= 5 * 60 && prng(seed + 13, ci) > 0.35;

    if (useSplit) {
      const splitFrac = 0.50 + (prng(seed + 17, ci) - 0.5) * 0.20; // 40–60% in first shift
      const part1 = Math.round(dur * splitFrac);
      const part2 = dur - part1;
      const breakMins = 20 + Math.round(prng(seed + 19, ci) * 25); // 20–45 min break
      const s1 = startMin;
      const e1 = s1 + part1;          // end of shift 1
      const s2 = e1 + breakMins;      // start of shift 2, always after e1
      const e2 = s2 + part2;          // end of shift 2
      // Only use split if everything fits within work window
      if (e2 <= shiftEndCap && e1 <= shiftEndCap) {
        rows[idx] = calcRow({
          ...row,
          von1: hhmm(Math.floor(s1/60), s1%60), bis1: hhmm(Math.floor(e1/60), e1%60),
          von2: hhmm(Math.floor(s2/60), s2%60), bis2: hhmm(Math.floor(e2/60), e2%60),
        });
        continue;
      }
    }
    // Single shift — cap at work-window end to stay in-window
    const s = startMin;
    const e = Math.min(s + dur, shiftEndCap);
    rows[idx] = calcRow({ ...row, von1: hhmm(Math.floor(s/60), s%60), bis1: hhmm(Math.floor(e/60), e%60), von2: '', bis2: '' });
  }

  // ── EXACT-CENT CORRECTION ──────────────────────────────────────────────────
  //
  // After assigning integer-minute shifts, compute the exact salary and adjust
  // the last worked day's end time by whole minutes until we are within one
  // minute of target, then handle the residual sub-minute difference by directly
  // tweaking the displayed "Berechneter Lohn" — but we must NOT fake the display.
  //
  // Instead: iterate adjustment over the last day minute-by-minute until
  // the integer-minute salary matches target to the cent. Since each minute
  // of that day has a known cost, we can compute the exact minute count needed
  // without iteration.

  const correct = () => {
    // Find last non-note worked day
    let adjIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!rows[i].noteHighlight && rows[i].von1 && rows[i].bis1) { adjIdx = i; break; }
    }
    if (adjIdx < 0) return;

    const row = rows[adjIdx];
    const rpm = ratePerMin(adjIdx); // cents per minute

    // Night premium on this specific day (approximate: assume shift is daytime for correction)
    // We add minutes to bis1 which may enter night territory. For the correction we use the
    // simplest possible: add/remove whole minutes and recompute until cents match.
    const currentCents = salaryInCents(rows, hourlyRateCents);
    const diffCents    = targetCents - currentCents;

    if (diffCents === 0) return;

    // Direction: add or remove minutes
    const direction = diffCents > 0 ? 1 : -1;
    const absDiff   = Math.abs(diffCents);

    // How many whole minutes does it take to cover |diffCents| at this day's rate?
    // rpm may include night premium if we're adjusting a night shift.
    // Use the actual end minute to determine if adjustment enters night territory.
    let minutesToAdjust = Math.round(absDiff / rpm);

    const curEnd   = toMins(row.bis1);
    const curStart = toMins(row.von1);
    const seg2Mins  = segDuration(row.von2, row.bis2);
    const von2Min   = row.von2 ? toMins(row.von2) : 23 * 60 + 59;
    // Hard upper bound for bis1:
    // - never exceed 23:59 (prevents overnight wrap)
    // - never reach or exceed von2 on split-shift days (prevents overlap)
    // - combined (seg1 + seg2) must stay within DAILY_CAP
    const overlapCap = row.von2 ? von2Min - 1 : 23 * 60 + 59;
    const maxEnd = direction > 0
      ? Math.min(overlapCap, curStart + Math.max(1, DAILY_CAP - seg2Mins))
      : 23 * 60 + 59;
    const newEnd = Math.max(curStart + 1, Math.min(maxEnd, curEnd + direction * minutesToAdjust));
    rows[adjIdx] = calcRow({ ...row, bis1: hhmm(Math.floor(newEnd / 60), newEnd % 60) });

    // After adjustment, there may still be a 1–3 cent residual from the
    // night-premium calculation changing. Do one more fine-tune pass (±2 min).
    const afterCents  = salaryInCents(rows, hourlyRateCents);
    const residual    = targetCents - afterCents;
    if (residual === 0) return;

    const dir2    = residual > 0 ? 1 : -1;
    const adjVon2 = rows[adjIdx].von2 ? toMins(rows[adjIdx].von2) - 1 : 23 * 60 + 59;
    for (let delta = 1; delta <= 5; delta++) {
      const tryEnd   = toMins(rows[adjIdx].bis1) + dir2 * delta;
      const seg2M    = segDuration(rows[adjIdx].von2, rows[adjIdx].bis2);
      const tryTotal = (tryEnd - toMins(rows[adjIdx].von1)) + seg2M;
      if (tryEnd < toMins(rows[adjIdx].von1) + 1 || tryEnd > 23 * 60 + 59) break;
      if (dir2 > 0 && tryEnd > adjVon2) break;
      if (dir2 > 0 && tryTotal > DAILY_CAP) break;
      const trial = calcRow({ ...rows[adjIdx], bis1: hhmm(Math.floor(tryEnd/60), tryEnd%60) });
      const trialRows = [...rows];
      trialRows[adjIdx] = trial;
      if (salaryInCents(trialRows, hourlyRateCents) === targetCents) {
        rows[adjIdx] = trial;
        return;
      }
    }

    // Sub-minute residual that no integer-minute adjustment can close:
    // Distribute it by also adjusting a second day (the one before adjIdx).
    const residual2 = targetCents - salaryInCents(rows, hourlyRateCents);
    if (residual2 === 0) return;

    for (let i = adjIdx - 1; i >= 0; i--) {
      if (!rows[i].noteHighlight && rows[i].von1 && rows[i].bis1) {
        const dir3    = residual2 > 0 ? 1 : -1;
        const iVon2   = rows[i].von2 ? toMins(rows[i].von2) - 1 : 23 * 60 + 59;
        for (let delta = 1; delta <= 5; delta++) {
          const tryEnd2 = toMins(rows[i].bis1) + dir3 * delta;
          if (tryEnd2 < toMins(rows[i].von1) + 1 || tryEnd2 > 23 * 60 + 59) break;
          if (dir3 > 0 && tryEnd2 > iVon2) break;
          const trial2 = calcRow({ ...rows[i], bis1: hhmm(Math.floor(tryEnd2/60), tryEnd2%60) });
          const trialRows2 = [...rows];
          trialRows2[i] = trial2;
          if (salaryInCents(trialRows2, hourlyRateCents) === targetCents) {
            rows[i] = trial2;
            return;
          }
        }
        break;
      }
    }
  };

  correct();
  enforceMandatorySplit(rows, params.seed);
  enforceNoOverlap(rows);
  return rows;
}

// ─── Plan generator — from target hour totals ───────────────────────────────
//
// Takes target totals in MINUTES for each column and distributes them across
// the month by assigning days of the right type (Sunday/holiday for Sonntag/
// Feiertag, night-eligible days for Nachtarbeit, plain weekdays for Grundlohn).
// The result is a valid, editable DayRow[] that matches the targets as closely
// as possible while keeping shifts realistic and non-overlapping.

interface TotalsTarget {
  grundlohn:   number; // total minutes
  nachtarbeit: number;
  nacht04:     number; // column exists but treated the same as nachtarbeit
  sonntag:     number;
  feiertag:    number;
}

function generatePlanFromTotals(
  year: number, month: number,
  targets: TotalsTarget,
  notes: Note[],
  seed: number,
  bundesland?: string | null,
  workWindow?: WorkWindowConstraints | null,
): DayRow[] {
  const winStart = workWindow?.windowStartMins ?? 0;
  const winEnd   = workWindow?.windowEndMins   ?? (23 * 60 + 59);
  const allowedDowsT = workWindow && workWindow.allowedWeekdays.length > 0
    ? new Set(workWindow.allowedWeekdays)
    : null;
  const daysInMonth = getDaysInMonth(new Date(year, month - 1, 1));

  // Notes map
  const notesByDay: Record<number, Note[]> = {};
  for (const n of notes) {
    const nd = new Date(n.note_date);
    if (nd.getFullYear() === year && nd.getMonth() === month - 1) {
      const day = nd.getDate();
      if (!notesByDay[day]) notesByDay[day] = [];
      notesByDay[day].push(n);
    }
  }

  // Build skeleton rows
  const rows: DayRow[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month - 1, day);
    const dow  = date.getDay();
    rows.push({
      dayIndex: day, date,
      weekday: WEEKDAY_SHORT[dow],
      isSat: dow === 6, isSun: dow === 0,
      isHol: dateIsHoliday(date, bundesland),
      von1: '', bis1: '', von2: '', bis2: '', von3: '', bis3: '',
      grundlohn: '', nachtarbeit: '', nachtarbeit04: '',
      samstag: '', sonntag: '', feiertag: '', weihnachten: '',
      noteHighlight: false,
    });
  }

  // Pre-fill note rows
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const dayNotes = notesByDay[row.dayIndex];
    if (!dayNotes) continue;
    row.noteHighlight = true;
    const nd = new Date(dayNotes[0].note_date);
    const nm = nd.getHours() * 60 + nd.getMinutes();
    const s1 = Math.max(0, nm - 60);
    const e1 = Math.min(23 * 60 + 30, nm + 60);
    row.von1 = hhmm(Math.floor(s1 / 60), s1 % 60);
    row.bis1 = hhmm(Math.floor(e1 / 60), e1 % 60);
    if (dayNotes.length > 1) {
      const nd2  = new Date(dayNotes[1].note_date);
      const nm2  = nd2.getHours() * 60 + nd2.getMinutes();
      const s2   = Math.max(e1 + 20, Math.max(0, nm2 - 60));
      const e2   = Math.min(23 * 60 + 59, Math.max(s2 + 1, nm2 + 60));
      if (s2 < 23 * 60 + 59 && s2 < e2) {
        row.von2 = hhmm(Math.floor(s2 / 60), s2 % 60);
        row.bis2 = hhmm(Math.floor(e2 / 60), e2 % 60);
      }
    }
    rows[i] = calcRow(row);
  }

  // Strict per-row daily cap: 8:30 (510 min). Any candidate part above this
  // is clamped by brokenStick and the overflow redistributed (zero-sum), so
  // the totals stay exact while no row exceeds the cap.
  const DAILY_CAP = 510; // 8:30 — strict ceiling

  // ── Classify available days by type ────────────────────────────────────────

  const holDays:  number[] = []; // public holiday (non-note)
  const sunDays:  number[] = []; // Sunday, non-holiday, non-note
  const weekDays: number[] = []; // Mon–Fri, non-holiday, non-note

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.noteHighlight) continue;
    // Respect allowed-weekdays constraint
    if (allowedDowsT && !allowedDowsT.has(r.date.getDay())) continue;
    if (r.isHol)  { holDays.push(i);  continue; }
    if (r.isSun)  { sunDays.push(i);  continue; }
    // Saturday: exclude from plain weekday pool only when no explicit filter is set
    // (default unconstrained behavior). When the user explicitly selects Saturday it
    // should be treated as a plain working day (Grundlohn, no Zuschlag).
    if (r.isSat && !allowedDowsT) continue;
    weekDays.push(i);
  }

  // ── Seeded helpers ─────────────────────────────────────────────────────────

  const rotate = <T,>(arr: T[]): T[] => {
    if (arr.length === 0) return arr;
    const off = seed % arr.length;
    return [...arr.slice(off), ...arr.slice(0, off)];
  };

  const pickN = (pool: number[], n: number): number[] => {
    if (n <= 0 || pool.length === 0) return [];
    const rot   = rotate(pool);
    const count = Math.min(pool.length, n);
    const sel: number[] = [];
    for (let i = 0; i < count; i++) sel.push(rot[Math.floor(i * rot.length / count)]);
    return sel.sort((a, b) => a - b);
  };

  // ── brokenStick ───────────────────────────────────────────────────────────
  // Splits `total` minutes into `n` parts that sum exactly to `total`.
  // Each part is clamped to [minPart, maxPart].  Uses random cut-points so the
  // resulting values are statistically distinct (no equal-share repetition).
  //
  // `bseed` and `chosen` drive deterministic cut-point seeds so the same
  // inputs always produce the same split (reproducible by seed).
  //
  // Similarity-penalty pass: after clamping, parts are spread so that no two
  // values (including values already seen in `seenDurations`) are within
  // `minSpread` minutes of each other.  Each adjustment is zero-sum against
  // the neighbour, so the total is always preserved exactly.
  //
  // `minSpread` defaults to 15 min — wide enough that near-duplicates like
  // "08:17 / 08:18 / 08:19" are broken up into more natural variation.
  const brokenStick = (
    total:         number,
    n:             number,
    minPart:       number,
    maxPart:       number,
    bseed:         number,
    chosen:        number[],
    seenDurations: Set<number> = new Set(),
    minSpread      = 45,
  ): number[] => {
    if (n <= 0) return [];
    if (n === 1) return [total];
    const parts: number[] = new Array(n).fill(0);
    // Generate n-1 interior cut-points in [0, total], sort, take differences
    const cuts: number[] = [0, total];
    for (let ci = 1; ci < n; ci++) {
      cuts.splice(ci, 0, Math.round(prng(bseed + ci * 7, chosen[ci - 1] * 3 + ci) * total));
    }
    cuts.sort((a, b) => a - b);
    for (let ci = 0; ci < n; ci++) parts[ci] = cuts[ci + 1] - cuts[ci];
    // Clamp to [minPart, maxPart] and redistribute overflow
    let overflow = 0;
    for (let ci = 0; ci < n; ci++) {
      const before = parts[ci];
      parts[ci] = Math.min(maxPart, Math.max(minPart, before));
      overflow  += before - parts[ci];
    }
    for (let ci = 0; ci < n && overflow !== 0; ci++) {
      const room = overflow > 0 ? maxPart - parts[ci] : parts[ci] - minPart;
      const adj  = overflow > 0 ? Math.min(overflow, room) : Math.max(overflow, -room);
      parts[ci] += adj;
      overflow  -= adj;
    }
    if (overflow !== 0) parts[n - 1] = Math.min(maxPart, Math.max(minPart, parts[n - 1] + overflow));

    // Similarity-penalty pass: ensure no part is within `minSpread` minutes of
    // any previously-seen duration OR of any other part already processed.
    // A tooClose match triggers a larger nudge (up to minSpread steps) rather
    // than the old ±4 nudge, so "08:17/08:18/08:19" clusters are truly broken.
    // Every nudge is balanced against the adjacent neighbour (zero-sum).
    const localSeen = new Set(seenDurations);
    const isTooClose = (v: number): boolean =>
      [...localSeen].some(u => Math.abs(u - v) < minSpread);

    for (let ci = 0; ci < n; ci++) {
      if (isTooClose(parts[ci])) {
        const neighbour = ci + 1 < n ? ci + 1 : ci - 1;
        // Try nudges of increasing magnitude in both directions
        let found = false;
        outer: for (let mag = minSpread; mag <= minSpread * 3; mag += 3) {
          for (const dir of [1, -1]) {
            const adj  = dir * mag;
            const newA = parts[ci] + adj;
            const newB = parts[neighbour] - adj;
            if (newA < minPart || newA > maxPart) continue;
            if (newB < minPart || newB > maxPart) continue;
            if (isTooClose(newA)) continue;
            parts[ci]        = newA;
            parts[neighbour] = newB;
            found = true;
            break outer;
          }
        }
        // If no nudge found (very tight range), at least try smaller adjustments
        if (!found) {
          for (let delta = 1; delta < minSpread && !found; delta++) {
            const neighbour2 = ci + 1 < n ? ci + 1 : ci - 1;
            for (const dir of [1, -1]) {
              const adj  = dir * delta;
              const newA = parts[ci] + adj;
              const newB = parts[neighbour2] - adj;
              if (newA < minPart || newA > maxPart) continue;
              if (newB < minPart || newB > maxPart) continue;
              if (isTooClose(newA)) continue;
              parts[ci]         = newA;
              parts[neighbour2] = newB;
              found = true;
              break;
            }
          }
        }
      }
      localSeen.add(parts[ci]);
    }

    // ── Strict distinctness pass ──────────────────────────────────────────────
    // Even after the similarity pass, two parts can still land on the SAME
    // value when both hit `maxPart` from clamp-overflow (this is what produced
    // the repeated `08:19` = 499 min cluster). Sweep duplicates and balance
    // ±k against a neighbour, zero-sum so the total stays exact.
    const valueCount = new Map<number, number>();
    for (const v of parts) valueCount.set(v, (valueCount.get(v) || 0) + 1);
    for (let ci = 0; ci < n; ci++) {
      if ((valueCount.get(parts[ci]) || 0) <= 1) continue;
      const neighbour = ci + 1 < n ? ci + 1 : ci - 1;
      if (neighbour < 0 || neighbour === ci) continue;
      let resolved = false;
      for (let k = 1; k <= Math.max(20, minSpread) && !resolved; k++) {
        for (const dir of [1, -1]) {
          const newA = parts[ci] + dir * k;
          const newB = parts[neighbour] - dir * k;
          if (newA < minPart || newA > maxPart) continue;
          if (newB < minPart || newB > maxPart) continue;
          // Avoid swapping into another existing duplicate
          if ((valueCount.get(newA) || 0) >= 1) continue;
          if (newA === newB) continue;
          // Apply
          valueCount.set(parts[ci], (valueCount.get(parts[ci]) || 1) - 1);
          valueCount.set(parts[neighbour], (valueCount.get(parts[neighbour]) || 1) - 1);
          parts[ci] = newA;
          parts[neighbour] = newB;
          valueCount.set(newA, (valueCount.get(newA) || 0) + 1);
          valueCount.set(newB, (valueCount.get(newB) || 0) + 1);
          resolved = true;
          break;
        }
      }
    }

    return parts;
  };

  // ── nudgeStart ────────────────────────────────────────────────────────────
  // Returns a start minute that is not within `gap` minutes of any value
  // already in `usedStarts`.  Tries up to 8 deterministic offsets then gives
  // up to avoid an infinite loop.  Adds the final value to `usedStarts`.
  const nudgeStart = (
    candidate: number,
    usedStarts: Set<number>,
    minStart:   number,
    maxStart:   number,
    nSeed:      number,
    gap = 20,
  ): number => {
    let s = candidate;
    const range = Math.max(1, maxStart - minStart);
    for (let attempt = 0; attempt < 8; attempt++) {
      const tooClose = [...usedStarts].some(u => Math.abs(u - s) < gap);
      if (!tooClose) break;
      // Spread attempts evenly across the available range, not just random
      const spread = minStart + Math.round(((attempt * 1.618 + prng(seed + 53 + attempt, nSeed * 7 + attempt)) % 1) * range);
      s = Math.max(minStart, Math.min(maxStart, spread));
    }
    s = Math.max(minStart, Math.min(maxStart, s));
    usedStarts.add(s);
    return s;
  };

  // ── dejitterMinute ────────────────────────────────────────────────────────
  // Shift `minOfDay` off the round `:00` minute so the document does not
  // contain repeated round-hour times like `00:00 / 04:00 / 08:00`.
  // First :00 per generation is allowed, further ones are shifted by 4–14 min.
  //
  // CRITICAL: only shifts BACKWARD (earlier).  This guarantees that the
  // shift's end (= start + duration) never crosses its category's end-cap,
  // so totals are never reduced by dejittering.  If shifting backward
  // would violate `low`, the original :00 value is returned unchanged.
  const usedZeroMinute = { count: 0 };
  const dejitterMinute = (
    minOfDay: number,
    rowSeed:  number,
    low      = 0,
    high     = 23 * 60 + 59,
  ): number => {
    const clamped = Math.max(low, Math.min(high, minOfDay));
    if (clamped % 60 !== 0) return clamped;
    if (usedZeroMinute.count < 1) { usedZeroMinute.count++; return clamped; }
    const offset = 4 + Math.floor(prng(seed + 101, rowSeed * 13 + 7) * 11); // 4..14
    const back   = clamped - offset;
    if (back >= low) return back;
    const fwd    = clamped + offset;
    if (fwd  <= high) return fwd;
    return clamped;
  };

  // Place a day shift for `idx` with `targetMins` total worked time.
  //
  // Split decision rules (applied per-row using prng so the pattern varies):
  //   < 3 h  → always single shift   (short, no break needed)
  //   3–5 h  → 30 % chance of split  (medium, occasionally split)
  //   5–7 h  → 70 % chance of split  (long, usually split)
  //   ≥ 7 h  → always split          (very long, break is mandatory)
  //
  // Break duration is varied per-row using `usedBreaks` to avoid repetition.
  // Split fraction is varied: first part is 40–65 % of the total.
  // Returns actual minutes reflected in grundlohn after calcRow.
  const placeDayShift = (
    idx: number,
    targetMins: number,
    startMin: number,
    endCap: number,   // latest minute the whole shift (incl shift 2) may end
    rowSeed: number,
    usedBreaks: Set<number> = new Set(),
  ): number => {
    const dur = Math.min(DAILY_CAP, Math.max(1, targetMins));

    // ── Decide whether to split ──────────────────────────────────────────────
    // Strict rule: any worked day STRICTLY GREATER than 5h00 (300 min)
    // MUST be split into two shifts. Below the threshold, splitting is
    // optional and used sparingly to keep the month varied.
    const MUST_SPLIT_OVER = 5 * 60; // 300 min
    const splitRoll       = prng(seed + 41, rowSeed);
    const splitChance     = dur > MUST_SPLIT_OVER
                          ? 1.00 // mandatory
                          : dur < 4 * 60 ? 0
                          : 0.20; // 4h00–5h00 occasionally
    const mustSplit = dur > MUST_SPLIT_OVER;
    const doSplit   = mustSplit || (splitChance > 0 && splitRoll < splitChance);

    if (doSplit) {
      // Split fraction: 30–70 % of total — wider so split-shift shapes vary
      // strongly across the month (not all "morning-then-afternoon" twins).
      const frac = 0.30 + prng(seed + 43, rowSeed * 3 + 1) * 0.40;
      const p1   = Math.max(30, Math.round(dur * frac));
      const p2   = dur - p1;
      if (p2 >= 15) {
        // Strict rule: break between Schicht 1 and Schicht 2 must be ≥ 40 min.
        // Range 40–90 min, varied per row. Reject break lengths within 6 min
        // of an already-used break so the same pause shape doesn't repeat.
        const MIN_BREAK = 40;
        const MAX_BREAK = 90;
        const tooClose = (v: number) => [...usedBreaks].some(u => Math.abs(u - v) < 6);
        let brk = MIN_BREAK + Math.round(prng(seed + 47, rowSeed * 5 + 3) * (MAX_BREAK - MIN_BREAK));
        for (let attempt = 0; attempt < 10 && tooClose(brk); attempt++) {
          brk = MIN_BREAK + Math.round(prng(seed + 47 + attempt * 3, rowSeed * 5 + 3 + attempt) * (MAX_BREAK - MIN_BREAK));
        }
        if (brk < MIN_BREAK) brk = MIN_BREAK;
        usedBreaks.add(brk);
        const s1 = startMin;
        const e1 = s1 + p1;
        const s2 = e1 + brk;
        const e2 = s2 + p2;
        if (e2 <= endCap && e1 <= endCap) {
          rows[idx] = calcRow({ ...rows[idx],
            von1: hhmm(Math.floor(s1/60), s1%60), bis1: hhmm(Math.floor(e1/60), e1%60),
            von2: hhmm(Math.floor(s2/60), s2%60), bis2: hhmm(Math.floor(e2/60), e2%60),
          });
          return toMins(rows[idx].grundlohn);
        }
        // Tight-fit fallback: keep the mandatory ≥40 min break, but pull the
        // start earlier so the whole split shift fits inside endCap. Add a
        // pseudo-random back-off so multiple tight-fits don't all park at the
        // same end time (the source of the "many rows ending at 19:59" smell).
        if (mustSplit) {
          const totalNeeded = dur + MIN_BREAK;
          const backoff = Math.round(prng(seed + 53, rowSeed * 11 + 7) * 35); // 0–35 min
          const s1b = Math.max(0, endCap - totalNeeded - backoff);
          const e1b = s1b + p1;
          const s2b = e1b + MIN_BREAK;
          const e2b = s2b + p2;
          if (e2b <= endCap && s1b >= 0) {
            usedBreaks.add(MIN_BREAK);
            rows[idx] = calcRow({ ...rows[idx],
              von1: hhmm(Math.floor(s1b/60), s1b%60), bis1: hhmm(Math.floor(e1b/60), e1b%60),
              von2: hhmm(Math.floor(s2b/60), s2b%60), bis2: hhmm(Math.floor(e2b/60), e2b%60),
            });
            return toMins(rows[idx].grundlohn);
          }
        }
      }
    }

    // Single shift fallback (only used for short days ≤ 5h00 — see split rule).
    // If the random start would clamp the end against endCap (creating the
    // tell-tale "ends at 19:59" pattern), pull the start back so the duration
    // is preserved AWAY from the cap, with a small random back-off for variety.
    let s1 = startMin;
    if (s1 + dur > endCap) {
      const backoff = Math.round(prng(seed + 59, rowSeed * 13 + 5) * 25); // 0–25 min
      s1 = Math.max(0, endCap - dur - backoff);
    }
    const end = s1 + dur;
    rows[idx] = calcRow({ ...rows[idx],
      von1: hhmm(Math.floor(s1/60), s1%60),
      bis1: hhmm(Math.floor(end/60), end%60),
      von2: '', bis2: '',
    });
    return toMins(rows[idx].grundlohn);
  };

  // Legacy wrapper used by Feiertag / Sonntag steps (single-shift only, no split).
  const assignShift = (
    idx: number,
    targetMins: number,
    startMin: number,
    _allowSplit: boolean,
    _splitSeed: number,
  ): number => placeDayShift(idx, targetMins, startMin, Math.min(winEnd, 19 * 60 + 59), idx);

  // ── Step 1: Assign Feiertag days ───────────────────────────────────────────
  // All hours on a holiday row count toward Feiertag (and Grundlohn).
  // holDays contains only non-note rows flagged isHol=true.
  // If targets.feiertag > 0 but holDays is empty the month simply has no
  // applicable holidays — we leave Feiertag at 0 and compensate in Grundlohn.

  let remFeiertag = targets.feiertag;
  const chosenHol: number[] = [];

  if (remFeiertag > 0 && holDays.length > 0) {
    // Spread across as many holiday days as needed (cap at available count)
    const maxPerDay = Math.round(DAILY_CAP * 0.75); // ~374 min ≈ 6.2 h — realistic max
    const numDays   = Math.min(holDays.length, Math.max(1, Math.ceil(remFeiertag / maxPerDay)));
    const picked    = pickN(holDays, numDays);
    chosenHol.push(...picked);

    let remHol = remFeiertag;
    for (let ci = 0; ci < picked.length; ci++) {
      const idx      = picked[ci];
      if (remHol <= 0) break;
      const share    = Math.round(remHol / (picked.length - ci));
      const dur      = Math.min(share, maxPerDay, DAILY_CAP);
      // Vary start time: base at window start (or 07:00) + up to 3 h of pseudo-random offset
      const holStartBase = Math.max(winStart, 6 * 60 + 30);
      const rawStart = holStartBase + Math.round(prng(seed + 5, idx) * 3 * 60);
      const startMin = dejitterMinute(rawStart, idx * 7 + ci, holStartBase, holStartBase + 3 * 60);
      const endMin   = Math.min(winEnd, 19 * 60, startMin + dur);
      rows[idx] = calcRow({ ...rows[idx],
        von1: hhmm(Math.floor(startMin / 60), startMin % 60),
        bis1: hhmm(Math.floor(endMin / 60), endMin % 60),
        von2: '', bis2: '',
      });
      remHol -= toMins(rows[idx].feiertag);
    }

    // Fine-tune last holiday day to hit exact target
    const feiertagTotal = rows.reduce((s, r) => s + toMins(r.feiertag), 0);
    const diff = targets.feiertag - feiertagTotal;
    if (diff !== 0 && chosenHol.length > 0) {
      const idx = chosenHol[chosenHol.length - 1];
      if (rows[idx]?.von1) {
        const curEnd = toMins(rows[idx].bis1);
        const newEnd = Math.min(19 * 60 + 59, Math.max(toMins(rows[idx].von1) + 1, curEnd + diff));
        rows[idx] = calcRow({ ...rows[idx], bis1: hhmm(Math.floor(newEnd / 60), newEnd % 60) });
      }
    }
    remFeiertag = Math.max(0, targets.feiertag - rows.reduce((s, r) => s + toMins(r.feiertag), 0));
  }

  // ── Step 2: Assign Sonntag days ────────────────────────────────────────────

  const globalSeenDurations = new Set<number>();

  let remSonntag = targets.sonntag;
  if (remSonntag > 0 && sunDays.length > 0) {
    const chosen    = pickN(sunDays, Math.min(sunDays.length, Math.max(1, Math.ceil(remSonntag / Math.round(DAILY_CAP * 0.75)))));
    const sunParts  = brokenStick(remSonntag, chosen.length, 15, Math.round(DAILY_CAP * 0.75), seed + 23, chosen, globalSeenDurations);
    sunParts.forEach(p => globalSeenDurations.add(p));
    const sunStarts = new Set<number>();

    for (let ci = 0; ci < chosen.length; ci++) {
      const idx      = chosen[ci];
      // Add ±15 min jitter — wider range means starts spread more naturally
      const sunBase  = Math.max(winStart, 7 * 60);
      const jitter   = Math.round((prng(seed + 71, idx * 11 + ci) - 0.5) * 30);
      const rawStart = sunBase + Math.round(prng(seed + 13, idx) * Math.max(0, Math.min(210, winEnd - sunBase - 60))) + jitter;
      const nudged   = nudgeStart(rawStart, sunStarts, sunBase, Math.min(winEnd - 30, sunBase + 5 * 60), idx * 3 + ci);
      const start    = dejitterMinute(nudged, idx * 29 + ci, sunBase, Math.min(winEnd - 30, sunBase + 5 * 60));
      const actual   = assignShift(idx, sunParts[ci], start, false, ci);
      remSonntag    -= actual;
    }
    // Fine-tune last day to match exactly
    const sonntagTotal = rows.reduce((s, r) => s + toMins(r.sonntag), 0);
    if (sonntagTotal !== targets.sonntag && chosen.length > 0) {
      const idx = chosen[chosen.length - 1];
      if (rows[idx].von1) {
        const delta  = targets.sonntag - sonntagTotal;
        const curEnd = toMins(rows[idx].bis1);
        const newEnd = Math.min(19 * 60 + 59, Math.max(toMins(rows[idx].von1) + 1, curEnd + delta));
        rows[idx] = calcRow({ ...rows[idx], bis1: hhmm(Math.floor(newEnd/60), newEnd%60) });
      }
    }
  }

  // ── Step 3a: Assign Nachtarbeit days (20:00–23:59) ─────────────────────────
  // Only runs when targets.nachtarbeit > 0.
  // Shifts are placed entirely in 20:00–23:59 so calcRow records them in the
  // nachtarbeit column. If the target is 0 this block is skipped entirely.

  const usedNight = new Set<number>();
  let assignedNachtarbeit = 0;

  if (targets.nachtarbeit > 0 && weekDays.length > 0) {
    const maxNightPerDay  = 23 * 60 + 59 - 20 * 60; // 239 min
    const nNight          = Math.min(weekDays.length, Math.max(1, Math.ceil(targets.nachtarbeit / maxNightPerDay)));
    const chosen          = pickN(weekDays, nNight);
    const nightParts      = brokenStick(targets.nachtarbeit, chosen.length, 15, maxNightPerDay, seed + 29, chosen, globalSeenDurations);
    nightParts.forEach(p => globalSeenDurations.add(p));
    const nightStarts     = new Set<number>();

    for (let ci = 0; ci < chosen.length; ci++) {
      const idx      = chosen[ci];
      usedNight.add(idx);
      // Start varies between 20:00 and (23:59 - duration) so the shift always ends before midnight.
      // Add ±7 min minute-level jitter so repeated nights never look identical (e.g. 20:00, 20:07, 20:14).
      const dur      = nightParts[ci];
      const maxStart = Math.max(20 * 60, 23 * 60 + 59 - dur);
      // ±15 min jitter; spread candidates across the full 20:00–maxStart window
      const jitter   = Math.round((prng(seed + 79, idx * 13 + ci) - 0.5) * 30);
      const rawStart = 20 * 60 + Math.round(prng(seed + 13, idx * 5 + ci) * Math.max(0, maxStart - 20 * 60)) + jitter;
      const nudged   = nudgeStart(rawStart, nightStarts, 20 * 60, maxStart, idx * 3 + ci, 12);
      const startMin = dejitterMinute(nudged, idx * 19 + ci, 20 * 60, maxStart);
      const end      = Math.min(winEnd, 23 * 60 + 59, startMin + dur);
      rows[idx] = calcRow({ ...rows[idx],
        von1: hhmm(Math.floor(startMin / 60), startMin % 60),
        bis1: hhmm(Math.floor(end / 60), end % 60),
        von2: '', bis2: '',
      });
      assignedNachtarbeit += toMins(rows[idx].nachtarbeit);
    }
    // Fine-tune last night day to hit the exact Nachtarbeit target
    if (assignedNachtarbeit !== targets.nachtarbeit && chosen.length > 0) {
      for (let ci = chosen.length - 1; ci >= 0; ci--) {
        const idx = chosen[ci];
        if (!rows[idx].von1) continue;
        const delta  = targets.nachtarbeit - assignedNachtarbeit;
        const curEnd = toMins(rows[idx].bis1);
        const newEnd = Math.min(23 * 60 + 59, Math.max(toMins(rows[idx].von1) + 1, curEnd + delta));
        rows[idx] = calcRow({ ...rows[idx], bis1: hhmm(Math.floor(newEnd / 60), newEnd % 60) });
        break;
      }
    }
  }

  // ── Step 3b: Assign Nacht 0–4 Uhr days (00:00–04:00) ──────────────────────
  // targets.nacht04 → shifts placed inside 00:00–04:00 only.
  // calcRow would count 00:00–06:00 as nachtarbeit; we override that by writing
  // nachtarbeit04 directly and clearing nachtarbeit on those rows so the two
  // columns stay strictly separate.

  const usedNacht04 = new Set<number>();
  let assignedNacht04 = 0;

  if (targets.nacht04 > 0 && weekDays.length > 0) {
    // Tightened ceilings to kill the "03:35 / 03:35 / 03:32" near-clone pattern.
    // Each shift must be in [minPerDay, maxPerDay] with enough spread budget
    // for brokenStick to produce visibly distinct lengths.
    // Wider per-day window kills the "03:30 / 03:15 / 03:05" near-family AND
    // the new "02:13 / 02:25 / 02:37" tiny-correction family by raising the floor.
    const maxPerDay = 235; // 03:55 — strong upper variety
    const minPerDay = 170; // 02:50 — eliminates short artificial nights
    const pool04 = weekDays.filter(idx => !usedNight.has(idx));
    const pool   = pool04.length > 0 ? pool04 : weekDays;
    // Use fewer, longer nights so each block is naturally medium-length.
    const idealDays = Math.max(2, Math.ceil(targets.nacht04 / 205));
    const nDays  = Math.min(pool.length, idealDays);
    const chosen = pickN(pool, nDays);
    const n      = chosen.length;

    // ── Build varied durations that sum exactly to targets.nacht04 ────────────
    // Spread budget = (max-min)/(n-1) — pick a stricter spread when room allows.
    const nightSpread = Math.max(15, Math.min(45, Math.floor((maxPerDay - minPerDay) / Math.max(1, n - 1)) - 5));
    const durations   = brokenStick(targets.nacht04, n, minPerDay, maxPerDay, seed + 19, chosen, globalSeenDurations, nightSpread);
    durations.forEach(p => globalSeenDurations.add(p));

    // ── Place each shift inside 00:00–04:00 ───────────────────────────────────
    const nacht04Starts = new Set<number>();
    for (let ci = 0; ci < n; ci++) {
      const idx     = chosen[ci];
      usedNacht04.add(idx);
      const dur     = durations[ci];
      // CRITICAL: force start minute-of-hour into [3, 23] so we NEVER emit
      // `00:00–04:00` clones. Combined with `dur < maxPerDay` from brokenStick
      // and the duration diversity pass, every night block ends up unique
      // (e.g. 00:07–03:51, 01:14–03:48, 00:21–03:58).
      const maxStart   = Math.max(0, maxPerDay - dur);
      const minOffset  = 3 + Math.floor(prng(seed + 83, idx * 9 + ci) * 21); // 3..23 min
      const maxHour    = Math.floor(maxStart / 60);
      const hourBucket = maxHour > 0 ? Math.floor(prng(seed + 113, idx * 11 + ci) * (maxHour + 1)) : 0;
      const candidate  = Math.max(0, Math.min(maxStart, hourBucket * 60 + minOffset));
      const startMin   = nudgeStart(candidate, nacht04Starts, 0, maxStart, idx * 11 + ci, 12);
      const endMin   = startMin + dur; // guaranteed ≤ 240

      rows[idx] = calcRow({ ...rows[idx],
        von1: hhmm(Math.floor(startMin / 60), startMin % 60),
        bis1: hhmm(Math.floor(endMin   / 60), endMin   % 60),
        von2: '', bis2: '',
      });
      const workedMins = toMins(rows[idx].grundlohn);
      rows[idx] = {
        ...rows[idx],
        nachtarbeit04: workedMins > 0 ? minsToHHMM(workedMins) : '',
        nachtarbeit:   '',
      };
      assignedNacht04 += workedMins;
    }

    // Fine-tune: spread residual across up to 2 nacht04 days, 1 min at a time
    let n04residual = targets.nacht04 - assignedNacht04;
    if (n04residual !== 0) {
      const n04cands: number[] = [];
      for (let ci = chosen.length - 1; ci >= 0 && n04cands.length < 2; ci--) {
        if (rows[chosen[ci]]?.von1) n04cands.push(chosen[ci]);
      }
      let pass = 0;
      while (n04residual !== 0 && pass < 20) {
        const idx = n04cands[pass % n04cands.length];
        if (!idx && idx !== 0) break;
        const dir    = n04residual > 0 ? 1 : -1;
        const curEnd = toMins(rows[idx].bis1);
        const newEnd = curEnd + dir;
        if (newEnd >= toMins(rows[idx].von1) + 1 && newEnd <= 4 * 60) {
          rows[idx] = calcRow({ ...rows[idx], bis1: hhmm(Math.floor(newEnd / 60), newEnd % 60) });
          const wm = toMins(rows[idx].grundlohn);
          rows[idx] = { ...rows[idx], nachtarbeit04: wm > 0 ? minsToHHMM(wm) : '', nachtarbeit: '' };
          n04residual -= dir;
        }
        pass++;
      }
    }
  }

  // ── Step 4: Assign plain Grundlohn days ────────────────────────────────────
  // targets.grundlohn = total worked minutes across ALL days.
  // Already-assigned days (feiertag, sonntag, nacht) count toward this total.
  // Plain shifts are clamped to 06:00–19:59 when targets.nachtarbeit === 0
  // so they can never accidentally produce night hours.

  const alreadyAssignedMins = rows.reduce((s, r) => s + toMins(r.grundlohn), 0);
  let remPlain = targets.grundlohn - alreadyAssignedMins;

  // When nachtarbeit target is 0, the latest a plain shift can end without
  // touching the 20:00 night window is 19:59.  Cap the start accordingly.
  // Additionally honour the work-window end cap (winEnd).
  const plainEndCap   = Math.min(winEnd, targets.nachtarbeit === 0 ? 19 * 60 + 59 : 23 * 60 + 59);
  const plainMaxDur   = targets.nachtarbeit === 0 ? 13 * 60 + 59 : DAILY_CAP; // 06:00–19:59 = 839 min

  if (remPlain > 0) {
    const plainPool = weekDays.filter(idx => !usedNight.has(idx) && !usedNacht04.has(idx));

    if (plainPool.length > 0) {
      // Realistic per-day window: 5h00 .. 8h30. Kills tiny correction days AND
      // the 11:44-style outliers in one stroke; every plain day looks human.
      const plainDayMin = 5 * 60;          // 300 min — no day shorter than 5h
      const plainDayMax = Math.min(plainMaxDur, DAILY_CAP, 8 * 60 + 30); // 510 min
      // Pick the day count so the average lands inside [6h30, 7h30].
      const targetAvg   = 7 * 60;          // 420 min — typical full-time day
      const nIdeal      = Math.max(1, Math.round(remPlain / targetAvg));
      const nMin        = Math.max(1, Math.ceil(remPlain / plainDayMax));
      const nMax        = Math.max(1, Math.floor(remPlain / plainDayMin));
      const nPlain      = Math.min(plainPool.length, Math.max(nMin, Math.min(nMax, nIdeal)));
      const chosen      = pickN(plainPool, nPlain);
      // Spread budget across the day-length window — adaptive minSpread.
      const plainSpread = Math.max(15, Math.min(45, Math.floor((plainDayMax - plainDayMin) / Math.max(1, nPlain - 1)) - 5));
      const plainParts  = brokenStick(remPlain, chosen.length, plainDayMin, plainDayMax, seed + 37, chosen, globalSeenDurations, plainSpread);

      // ── Hard-ban duplicates of 08:19 (= 499) and 08:30 (= 510 = cap) ───────
      // brokenStick clamp-overflow can park multiple parts on the cap. The
      // strict-distinct pass keeps one; we additionally allow at most ONE row
      // at the cap, and zero rows at the legacy 499 sentinel. Excess parts
      // are exchanged ±k min with a neighbour (zero-sum, total preserved).
      const BAN_ALL    = new Set<number>([499]); // 08:19 — never allowed
      const BAN_REPEAT = new Set<number>([510]); // 08:30 — at most once
      const seenCap = { 510: 0 };
      for (let ci = 0; ci < plainParts.length; ci++) {
        const v = plainParts[ci];
        const isBanned = BAN_ALL.has(v) || (BAN_REPEAT.has(v) && (seenCap[v as 510] = (seenCap[v as 510] || 0) + 1) > 1);
        if (!isBanned) continue;
        const neighbour = ci + 1 < plainParts.length ? ci + 1 : ci - 1;
        if (neighbour < 0 || neighbour === ci) continue;
        for (let k = 1; k <= 60; k++) {
          let resolved = false;
          for (const dir of [1, -1]) {
            const newA = plainParts[ci]        + dir * k;
            const newB = plainParts[neighbour] - dir * k;
            if (BAN_ALL.has(newA) || BAN_ALL.has(newB)) continue;
            if (newA < plainDayMin || newA > plainDayMax) continue;
            if (newB < plainDayMin || newB > plainDayMax) continue;
            plainParts[ci]        = newA;
            plainParts[neighbour] = newB;
            resolved = true; break;
          }
          if (resolved) break;
        }
      }

      plainParts.forEach(p => globalSeenDurations.add(p));
      const plainStarts = new Set<number>();
      const usedBreaks  = new Set<number>();

      // Start base honours work-window start; range is constrained to end cap
      const startBase  = winStart > 0 ? winStart : 6 * 60;
      // Widen the window: up to 8h or 11h depending on night mode, but never past plainEndCap
      const startRangeRaw = targets.nachtarbeit === 0 ? 8 * 60 : 11 * 60;
      const startRange = Math.max(0, Math.min(startRangeRaw, plainEndCap - startBase - 30));

      for (let ci = 0; ci < chosen.length; ci++) {
        const idx = chosen[ci];
        if (remPlain <= 0) break;

        // ±15 min jitter on top of the pseudo-random start
        const jitter   = Math.round((prng(seed + 89, idx * 17 + ci) - 0.5) * 30);
        const rawStart = startBase + Math.round(prng(seed + 7, idx * 3 + ci) * startRange) + jitter;
        const nudgedSt = nudgeStart(rawStart, plainStarts, startBase, startBase + startRange, idx * 5 + ci, 20);
        const startMin = dejitterMinute(nudgedSt, idx * 31 + ci, startBase, startBase + startRange);

        // placeDayShift handles single-vs-split decision internally
        remPlain -= placeDayShift(idx, plainParts[ci], startMin, plainEndCap, idx * 7 + ci, usedBreaks);
      }

      // Fine-tune: spread any rounding residual across up to 3 plain days,
      // 1 minute at a time, so no single day becomes an obvious "correction day".
      let residual = targets.grundlohn - rows.reduce((s, r) => s + toMins(r.grundlohn), 0);
      if (residual !== 0) {
        // Collect up to 5 candidate indices spread across chosen[], skip note rows.
        // Wider distribution prevents the residual from "lumping" on a few rows
        // and creating spurious 1-minute bumps that read as artificial.
        const candidates: number[] = [];
        for (let ci = chosen.length - 1; ci >= 0 && candidates.length < 5; ci--) {
          const idx = chosen[ci];
          if (!rows[idx].von1 || rows[idx].noteHighlight) continue;
          candidates.push(idx);
        }
        // Distribute 1 min at a time across candidates until residual is zero
        let pass = 0;
        while (residual !== 0 && pass < 60) {
          const idx = candidates[pass % candidates.length];
          if (!idx && idx !== 0) break;
          const dir = residual > 0 ? 1 : -1;
          // Strict cap: never let a row's total work exceed 8h30 (510 min)
          const rowWork = toMins(rows[idx].grundlohn);
          if (dir > 0 && rowWork >= DAILY_CAP) { pass++; continue; }
          if (rows[idx].von2 && rows[idx].bis2) {
            const curEnd = toMins(rows[idx].bis2);
            const newEnd = curEnd + dir;
            if (newEnd > toMins(rows[idx].von2) && newEnd <= plainEndCap && rowWork + dir <= DAILY_CAP) {
              rows[idx] = calcRow({ ...rows[idx], bis2: hhmm(Math.floor(newEnd / 60), newEnd % 60) });
              residual -= dir;
            }
          } else {
            const curEnd = toMins(rows[idx].bis1);
            const newEnd = curEnd + dir;
            if (newEnd > toMins(rows[idx].von1) && newEnd <= plainEndCap && rowWork + dir <= DAILY_CAP) {
              rows[idx] = calcRow({ ...rows[idx], bis1: hhmm(Math.floor(newEnd / 60), newEnd % 60) });
              residual -= dir;
            }
          }
          pass++;
        }
      }
    }
  }

  // ── Realism pass: dedupe clustered end times (esp. 19:59) ─────────────────
  // Shifts whole rows earlier by a varied amount when the same end-time
  // appears more than once. Duration is preserved (von & bis shifted by the
  // same delta) so category totals stay exact. Safety: the new start must
  // remain ≥ 04:00 (no accidental Nacht 0–4 contribution) and ≥ 0.
  {
    const endCount = new Map<string, number>();
    const endTimeOf = (r: typeof rows[number]) => r.bis2 || r.bis1 || '';
    for (const r of rows) {
      const e = endTimeOf(r);
      if (e) endCount.set(e, (endCount.get(e) || 0) + 1);
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.von1 || !r.bis1) continue;
      if (usedNacht04.has(i)) continue; // 04:00-bounded rows handled separately
      const endStr = endTimeOf(r);
      const cnt = endCount.get(endStr) || 0;
      if (cnt < 2) continue; // unique end — leave alone
      // Pick a back-off that puts this row on a non-clustered minute.
      const baseStart = toMins(r.von1);
      const lowerBound = Math.max(4 * 60, baseStart - 50); // don't enter 00–04
      const maxDelta = baseStart - lowerBound;
      if (maxDelta <= 0) continue;
      let chosenDelta = 0;
      for (let attempt = 0; attempt < 12; attempt++) {
        const k = 5 + Math.round(prng(seed + 67 + attempt, i * 19 + attempt) * Math.min(40, maxDelta));
        if (k <= 0 || k > maxDelta) continue;
        const newEnd = toMins(r.bis2 || r.bis1) - k;
        const candidate = hhmm(Math.floor(newEnd / 60), newEnd % 60);
        if ((endCount.get(candidate) || 0) === 0) {
          chosenDelta = k; break;
        }
      }
      if (chosenDelta === 0) {
        // No fully-unique slot found — still pull back by a small random amount
        // so this row no longer matches the cluster end-time exactly.
        chosenDelta = Math.min(maxDelta, 7 + Math.round(prng(seed + 71, i * 23) * 18));
      }
      if (chosenDelta <= 0) continue;
      // Apply uniform shift to all four slots
      const shift = (t: string) => {
        if (!t) return t;
        const m = toMins(t) - chosenDelta;
        if (m < 0) return t;
        return hhmm(Math.floor(m / 60), m % 60);
      };
      const newVon1 = shift(r.von1);
      const newBis1 = shift(r.bis1);
      const newVon2 = r.von2 ? shift(r.von2) : '';
      const newBis2 = r.bis2 ? shift(r.bis2) : '';
      // Update counts for the OLD and NEW end strings
      endCount.set(endStr, (endCount.get(endStr) || 1) - 1);
      const newEndStr = newBis2 || newBis1;
      endCount.set(newEndStr, (endCount.get(newEndStr) || 0) + 1);
      rows[i] = calcRow({ ...rows[i], von1: newVon1, bis1: newBis1, von2: newVon2, bis2: newBis2 });
    }
  }

  // ── Final guard: zero out nachtarbeit on all rows when target is 0 ──────────
  // Catches any residual night minutes that slipped through (e.g. from note-prefill
  // or edge cases in the fine-tune passes above).
  if (targets.nachtarbeit === 0) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].nachtarbeit && !usedNacht04.has(i)) {
        rows[i] = { ...rows[i], nachtarbeit: '' };
      }
    }
  }

  // ── Strict repair pass ─────────────────────────────────────────────────────
  // After all fine-tunes, walk every category and shift `bis1` (or `bis2`)
  // of an existing row in that category by ±1 min until the total matches
  // the target exactly.  Acts as a last-line guarantee that humanization
  // (dejitter, similarity nudges) cannot leak total drift into the result.
  const repairCategory = (
    catName: 'grundlohn' | 'nachtarbeit' | 'nacht04' | 'sonntag' | 'feiertag',
    target:  number,
  ) => {
    for (let safety = 0; safety < 240; safety++) {
      const got = catName === 'nacht04'
        ? rows.reduce((s, r) => s + toMins(r.nachtarbeit04), 0)
        : rows.reduce((s, r) => s + toMins(r[catName]),     0);
      const diff = target - got;
      if (diff === 0) return;
      const dir  = diff > 0 ? 1 : -1;
      // Find a row that contributes to this category and can absorb ±1 min.
      //
      // CRITICAL: each category may only be repaired by touching rows that
      // contribute *exclusively* to that category. Otherwise adjusting one
      // category leaks into another (e.g. extending bis1 on a holiday row to
      // close a Grundlohn shortfall would inflate Feiertag past its target,
      // because calcRow assigns the full row total to feiertag when isHol).
      let acted = false;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r.von1) continue;
        if (r.noteHighlight) continue;
        // Category-strict eligibility — touch ONLY rows that don't pollute
        // other already-balanced categories.
        if (catName === 'grundlohn') {
          if (r.isHol) continue;                          // would inflate feiertag
          if (r.isSun) continue;                          // would inflate sonntag
          if (toMins(r.nachtarbeit04) > 0) continue;      // would inflate nacht04
          if (toMins(r.nachtarbeit)   > 0) continue;      // would inflate nachtarbeit
          if (toMins(r.grundlohn) <= 0) continue;
        } else if (catName === 'nachtarbeit') {
          if (r.isHol) continue;
          if (r.isSun) continue;
          if (toMins(r.nachtarbeit04) > 0) continue;
          if (toMins(r.nachtarbeit)   <= 0) continue;
        } else if (catName === 'nacht04') {
          if (r.isHol) continue;
          if (r.isSun) continue;
          if (toMins(r.nachtarbeit04) <= 0) continue;
        } else if (catName === 'sonntag') {
          if (!r.isSun || r.isHol) continue;              // only pure Sundays
        } else { // feiertag
          if (!r.isHol) continue;                         // only true holidays
        }
        const useBis2 = !!r.von2 && !!r.bis2;
        const startKey = useBis2 ? 'von2' : 'von1';
        const endKey   = useBis2 ? 'bis2' : 'bis1';
        const cap = catName === 'nacht04' ? 4 * 60
                  : catName === 'nachtarbeit' ? 23 * 60 + 59
                  : 23 * 60 + 59;
        const curEnd = toMins(r[endKey]);
        const newEnd = curEnd + dir;
        if (newEnd <= toMins(r[startKey])) continue;
        if (newEnd > cap) continue;
        const updated = calcRow({ ...r, [endKey]: hhmm(Math.floor(newEnd / 60), newEnd % 60) });
        // Preserve the explicit nacht04 column when in nacht04 mode
        if (catName === 'nacht04') {
          const wm = toMins(updated.grundlohn);
          rows[i] = { ...updated, nachtarbeit04: wm > 0 ? minsToHHMM(wm) : '', nachtarbeit: '' };
        } else {
          rows[i] = updated;
        }
        acted = true;
        break;
      }
      if (!acted) break;
    }
  };
  // Order matters: repair sub-categories first, grundlohn last (it's a sum view)
  repairCategory('feiertag',    targets.feiertag);
  repairCategory('sonntag',     targets.sonntag);
  repairCategory('nacht04',     targets.nacht04);
  repairCategory('nachtarbeit', targets.nachtarbeit);
  repairCategory('grundlohn',   targets.grundlohn);

  // ── Final validation ────────────────────────────────────────────────────────
  // Log a warning if any category total drifted from its target.  The caller
  // (handleStep2Totals) can use this to decide whether to warn the user.
  if (typeof console !== 'undefined') {
    const t = calcTotals(rows);
    const check = (name: string, got: number, want: number) => {
      if (Math.abs(got - want) > 1) {
        console.warn(`[generatePlanFromTotals] ${name}: got ${got} min, wanted ${want} min`);
      }
    };
    check('grundlohn',   t.grundlohn,   targets.grundlohn);
    check('nachtarbeit', t.nachtarbeit, targets.nachtarbeit);
    check('nacht04',     t.nacht04,     targets.nacht04);
    check('sonntag',     t.sonntag,     targets.sonntag);
    check('feiertag',    t.feiertag,    targets.feiertag);
  }

  enforceMandatorySplit(rows, seed);
  enforceNoOverlap(rows);
  return rows;
}

// ─── PDF export — delegates to shared renderer ─────────────────────────────

interface PdfData {
  driver:   DriverOption;
  month:    number;
  year:     number;
  rows:     DayRow[];
  totals:   Totals;
  notes?:   Note[];
  warnings?: string[];
}

/** Map planning behavior to a human-readable German label. */
function behaviorLabel(n: Note): string | null {
  const beh = n.note_planning_behavior
    ?? (['krank','urlaub','frei','nicht verfügbar','gesperrt','ausfall','abwesend'].some(k => n.note_text.toLowerCase().includes(k)) ? 'exclude_from_plan'
      : ['blitzer','unfall','panne','kontrolle','wartezeit'].some(k => n.note_text.toLowerCase().includes(k)) ? 'must_include_in_plan'
      : null);
  if (beh === 'exclude_from_plan')    return 'Abwesenheit';
  if (beh === 'must_include_in_plan') return 'Pflichtnotiz';
  return null;
}

function exportPDF(data: PdfData, filename: string): void {
  const { rows } = data;

  const pdfNotes = (data.notes ?? []).map(n => {
    const beh = n.note_planning_behavior
      ?? (['krank','urlaub','frei','nicht verfügbar','gesperrt','ausfall','abwesend'].some(k => n.note_text.toLowerCase().includes(k)) ? 'exclude_from_plan'
        : ['blitzer','unfall','panne','kontrolle','wartezeit'].some(k => n.note_text.toLowerCase().includes(k)) ? 'must_include_in_plan'
        : null);
    const typeLabel = beh === 'exclude_from_plan' ? 'Abwesenheit'
                    : beh === 'must_include_in_plan' ? 'Pflichtnotiz'
                    : null;

    let noteTextFinal = n.note_text || null;

    // For Pflichtnotiz: check if the ±30 min window is covered by a shift
    if (beh === 'must_include_in_plan') {
      const noteD2  = new Date(n.note_date);
      const dayNum2 = noteD2.getDate();
      const noteHM  = noteD2.getHours() * 60 + noteD2.getMinutes();
      const winS2   = Math.max(0, noteHM - 30);
      const winE2   = Math.min(23 * 60 + 59, noteHM + 30);
      const matchRow2 = rows.find(r => r.date.getDate() === dayNum2);
      const checkSeg2 = (v: string, b: string) => {
        if (!v || !b) return false;
        const sv = toMins(v), sb = toMins(b);
        return sv <= winS2 && sb >= winE2;
      };
      const covered2 = matchRow2 && (
        checkSeg2(matchRow2.von1, matchRow2.bis1) ||
        checkSeg2(matchRow2.von2, matchRow2.bis2) ||
        checkSeg2(matchRow2.von3, matchRow2.bis3)
      );
      const slotLabel2 = `${hhmm(Math.floor(winS2/60), winS2%60)}–${hhmm(Math.floor(winE2/60), winE2%60)}`;
      const coverageNote = covered2
        ? `im Plan (${slotLabel2})`
        : 'nicht darstellbar';
      noteTextFinal = noteTextFinal
        ? `${noteTextFinal} — ${coverageNote}`
        : coverageNote;
    }

    return {
      note_date:  n.note_date,
      note_type:  typeLabel,
      note_text:  noteTextFinal,
      start_date: n.start_date ?? null,
      end_date:   n.end_date ?? null,
    };
  });
  exportStundennachweisAsPdf(
    { ...data, notes: pdfNotes, warnings: data.warnings ?? [] },
    filename,
  );
}

// ─── Shared input style ─────────────────────────────────────────────────────

const IS: React.CSSProperties = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  color: 'var(--text-primary)',
  fontSize: '0.875rem',
  padding: '0.625rem 0.875rem',
  outline: 'none',
  width: '100%',
};

// ─── 24-hour time input ─────────────────────────────────────────────────────
//
// Browser's <input type="time"> can display 12h format depending on locale.
// To guarantee 24h everywhere we render a plain text input with HH:MM pattern
// validation, so the value is always displayed and stored as HH:MM.

const TimeInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  cellStyle?: React.CSSProperties;
}> = ({ value, onChange, cellStyle }) => {
  const [localVal, setLocalVal] = useState(value);

  // Keep in sync with parent
  useEffect(() => { setLocalVal(value); }, [value]);

  const commit = (raw: string) => {
    // Accept HH:MM patterns only; strip anything else
    const cleaned = raw.replace(/[^0-9:]/g, '');
    // If user typed 4 digits without colon e.g. "0815" → "08:15"
    const normalized = cleaned.length === 4 && !cleaned.includes(':')
      ? `${cleaned.slice(0,2)}:${cleaned.slice(2)}`
      : cleaned;

    const match = normalized.match(/^(\d{1,2}):(\d{2})$/);
    if (match) {
      const h = parseInt(match[1], 10);
      const m = parseInt(match[2], 10);
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        const formatted = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        setLocalVal(formatted);
        onChange(formatted);
        return;
      }
    }
    if (raw === '') {
      setLocalVal('');
      onChange('');
      return;
    }
    // Invalid: revert to last valid
    setLocalVal(value);
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      placeholder=""
      maxLength={5}
      value={localVal}
      onChange={e => setLocalVal(e.target.value)}
      onBlur={e => commit(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }}
      style={{
        width: '100%',
        border: 'none',
        background: 'transparent',
        outline: 'none',
        fontSize: '9.5px',
        fontFamily: 'Arial, Helvetica, sans-serif',
        textAlign: 'center',
        color: '#000',
        padding: '0',
        ...(cellStyle || {}),
      }}
    />
  );
};

// ─── Step 1 ─────────────────────────────────────────────────────────────────

const Step1: React.FC<{
  drivers: DriverOption[];
  onNext: (driverId: string, month: number, year: number) => void;
}> = ({ drivers, onNext }) => {
  const [driverId, setDriverId] = useState('');
  const [month, setMonth]       = useState(new Date().getMonth() + 1);
  const [year,  setYear]        = useState(new Date().getFullYear());
  const years = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 2 + i);

  return (
    <div className="max-w-lg mx-auto">
      <div className="rounded-xl p-8 space-y-6"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)' }}>
        <div className="flex items-center gap-3 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white"
            style={{ background: 'var(--accent)' }}>1</div>
          <div>
            <h2 className="font-bold" style={{ color: 'var(--text-primary)' }}>Fahrer &amp; Zeitraum</h2>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Fahrer, Monat und Jahr auswählen</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              <User size={13} className="inline mr-1" />Fahrer *
            </label>
            <select value={driverId} onChange={e => setDriverId(e.target.value)} style={IS}>
              <option value="">Fahrer auswählen …</option>
              {drivers.map(d => (
                <option key={d.id} value={d.id}>
                  {d.name}{d.personalnummer ? ` — Pers.-Nr. ${d.personalnummer}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Monat *</label>
              <select value={month} onChange={e => setMonth(Number(e.target.value))} style={IS}>
                {MONTH_NAMES_DE.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Jahr *</label>
              <select value={year} onChange={e => setYear(Number(e.target.value))} style={IS}>
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>
        </div>

        <button
          onClick={() => driverId && onNext(driverId, month, year)}
          disabled={!driverId}
          className="w-full py-3 rounded-lg font-semibold text-sm transition-all flex items-center justify-center gap-2"
          style={driverId
            ? { background: 'var(--accent)', color: 'white' }
            : { background: 'var(--bg-muted)', color: 'var(--text-tertiary)', cursor: 'not-allowed' }}>
          Weiter <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
};

// ─── Step 2 ─────────────────────────────────────────────────────────────────

// Parses a German decimal string (comma or dot) to a float, returns 0 on failure
function parseDE(s: string): number {
  const v = parseFloat(s.replace(',', '.'));
  return isNaN(v) ? 0 : v;
}

// Converts a decimal hours string (e.g. "143,00") to whole minutes
function decToMins(s: string): number {
  return Math.round(parseDE(s) * 60);
}

// All editable fields in Step 2, hoisted to the parent so they survive unmount/remount.
interface Step2FormState {
  tab:         'salary' | 'totals';
  salary:      string;
  rate:        string;
  glRatio:     string; // empty string = use default 85 %
  tGrundlohn:  string;
  tNacht:      string;
  tNacht04:    string;
  tSonntag:    string;
  tFeiertag:   string;
}

const DEFAULT_STEP2_STATE: Step2FormState = {
  tab:         'salary',
  salary:      '',
  rate:        '',
  glRatio:     '',        // intentionally empty — user sees placeholder, default applied at generation
  tGrundlohn:  '',
  tNacht:      '',
  tNacht04:    '',
  tSonntag:    '',
  tFeiertag:   '',
};

interface Step2Props {
  driver:        DriverOption;
  month:         number;
  year:          number;
  initialState:  Step2FormState;
  onStateChange: (s: Step2FormState) => void;
  onGenerateSalary:  (salary: number, rate: number, glRatio: number, ww: WorkWindowConstraints) => void;
  onGenerateTotals:  (targets: TotalsTarget, ww: WorkWindowConstraints) => void;
  onBack:        () => void;
}

// Converts "HH:MM" string to minutes since midnight
function hhmmToMins(s: string): number {
  const m = toMins(s);
  return isNaN(m) ? 0 : m;
}

// Weekday short labels keyed by JS getDay() value (0=Sun..6=Sat).
const WEEKDAY_SHORT_BY_JS: Record<number, string> = {
  1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa', 0: 'So',
};

// Render a compact summary like "Mo–Fr" / "Mo, Mi, Fr" from JS-getDay values.
function formatProfileWeekdays(jsDays: number[]): string {
  if (!jsDays || jsDays.length === 0) return 'Keine Arbeitstage hinterlegt';
  const order = [1, 2, 3, 4, 5, 6, 0]; // Mo..So
  const ordered = order.filter(d => jsDays.includes(d));
  if (ordered.length === 5 && ordered.every((d, i) => d === [1,2,3,4,5][i])) return 'Mo–Fr';
  if (ordered.length === 7) return 'Mo–So';
  return ordered.map(d => WEEKDAY_SHORT_BY_JS[d]).join(', ');
}

const Step2: React.FC<Step2Props> = ({
  driver, month, year,
  initialState, onStateChange,
  onGenerateSalary, onGenerateTotals, onBack,
}) => {
  // All form state is initialized from the parent-persisted snapshot.
  // Every setter also calls onStateChange so the parent always has the latest values.
  const [tab,        setTabRaw]        = useState(initialState.tab);
  const [salary,     setSalaryRaw]     = useState(initialState.salary);
  const [rate,       setRateRaw]       = useState(initialState.rate);
  const [glRatio,    setGlRatioRaw]    = useState(initialState.glRatio);
  const [tGrundlohn, setTGrundlohnRaw] = useState(initialState.tGrundlohn);
  const [tNacht,     setTNachtRaw]     = useState(initialState.tNacht);
  const [tNacht04,   setTNacht04Raw]   = useState(initialState.tNacht04);
  const [tSonntag,   setTSonntagRaw]   = useState(initialState.tSonntag);
  const [tFeiertag,  setTFeiertagRaw]  = useState(initialState.tFeiertag);

  const [err, setErr] = useState('');

  // Arbeitszeitfenster comes exclusively from the driver profile.
  // allowed_weekdays in the profile uses ISO 1=Mon..7=Sun; the rest of this
  // page uses JS getDay() (0=Sun..6=Sat). Convert ISO 7 -> JS 0.
  const profileStart = driver.work_window_start ?? null;
  const profileEnd   = driver.work_window_end   ?? null;
  const profileIsoDays = Array.isArray(driver.allowed_weekdays) ? driver.allowed_weekdays : null;
  const allowedDows: number[] = profileIsoDays && profileIsoDays.length > 0
    ? profileIsoDays.map(d => (d === 7 ? 0 : d))
    : [];
  const hasProfileWindow = !!(profileStart && profileEnd) || allowedDows.length > 0;

  // Helpers that update local state AND propagate to parent
  const notify = (patch: Partial<Step2FormState>) => {
    onStateChange({
      tab, salary, rate, glRatio,
      tGrundlohn, tNacht, tNacht04, tSonntag, tFeiertag,
      ...patch,
    });
  };

  const setTab        = (v: 'salary' | 'totals') => { setTabRaw(v);        notify({ tab: v }); };
  const setSalary     = (v: string)               => { setSalaryRaw(v);     notify({ salary: v }); };
  const setRate       = (v: string)               => { setRateRaw(v);       notify({ rate: v }); };
  const setGlRatio    = (v: string)               => { setGlRatioRaw(v);    notify({ glRatio: v }); };
  const setTGrundlohn = (v: string)               => { setTGrundlohnRaw(v); notify({ tGrundlohn: v }); };
  const setTNacht     = (v: string)               => { setTNachtRaw(v);     notify({ tNacht: v }); };
  const setTNacht04   = (v: string)               => { setTNacht04Raw(v);   notify({ tNacht04: v }); };
  const setTSonntag   = (v: string)               => { setTSonntagRaw(v);   notify({ tSonntag: v }); };
  const setTFeiertag  = (v: string)               => { setTFeiertagRaw(v);  notify({ tFeiertag: v }); };

  const buildWorkWindow = (): WorkWindowConstraints => ({
    windowStartMins: profileStart ? hhmmToMins(profileStart) : 0,
    windowEndMins:   profileEnd   ? hhmmToMins(profileEnd)   : (23 * 60 + 59),
    allowedWeekdays: allowedDows,
  });

  const GL_RATIO_DEFAULT = 0.85;

  const goSalary = () => {
    const s = parseDE(salary);
    const r = parseDE(rate);
    if (!s || s <= 0) { setErr('Bitte einen gültigen Zielbetrag eingeben.'); return; }
    if (!r || r <= 0) { setErr('Bitte einen gültigen Stundensatz eingeben.'); return; }
    // Grundlohn-Anteil is optional — empty → default 85 %
    let g = GL_RATIO_DEFAULT;
    if (glRatio.trim() !== '') {
      const parsed = parseDE(glRatio);
      if (isNaN(parsed) || parsed < 1 || parsed > 99) {
        setErr('Grundlohn-Anteil muss zwischen 1 und 99 liegen (oder leer lassen für Standard 85 %).'); return;
      }
      g = parsed / 100;
    }
    if (!hasProfileWindow) { setErr('Kein Arbeitszeitfenster im Fahrerprofil hinterlegt. Bitte im Fahrerprofil ergänzen.'); return; }
    if (allowedDows.length === 0) { setErr('Im Fahrerprofil sind keine Arbeitstage hinterlegt. Bitte im Fahrerprofil ergänzen.'); return; }
    setErr(''); onGenerateSalary(s, r, g, buildWorkWindow());
  };

  const goTotals = () => {
    const gl = decToMins(tGrundlohn);
    if (gl <= 0) { setErr('Grundlohn-Stunden müssen größer als 0 sein.'); return; }
    if (!hasProfileWindow) { setErr('Kein Arbeitszeitfenster im Fahrerprofil hinterlegt. Bitte im Fahrerprofil ergänzen.'); return; }
    if (allowedDows.length === 0) { setErr('Im Fahrerprofil sind keine Arbeitstage hinterlegt. Bitte im Fahrerprofil ergänzen.'); return; }
    setErr('');
    onGenerateTotals({
      grundlohn:   gl,
      nachtarbeit: decToMins(tNacht),
      nacht04:     decToMins(tNacht04),
      sonntag:     decToMins(tSonntag),
      feiertag:    decToMins(tFeiertag),
    }, buildWorkWindow());
  };

  // Shared tab button style
  const tabBtn = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '0.5rem 0',
    fontSize: '0.8125rem',
    fontWeight: active ? 600 : 400,
    borderRadius: '0.5rem',
    border: 'none',
    cursor: 'pointer',
    transition: 'all 0.15s',
    background:  active ? 'var(--accent)' : 'transparent',
    color:       active ? 'white' : 'var(--text-secondary)',
  });

  return (
    <div className="max-w-lg mx-auto">
      <div className="rounded-xl p-8 space-y-5"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)' }}>

        {/* ── Step header ── */}
        <div className="flex items-center gap-3 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white"
            style={{ background: 'var(--accent)' }}>2</div>
          <div>
            <h2 className="font-bold" style={{ color: 'var(--text-primary)' }}>Lohnparameter</h2>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {driver.name} — {MONTH_NAMES_DE[month - 1]} {year}
            </p>
          </div>
        </div>

        {/* ── Tab switcher ── */}
        <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
          <button style={tabBtn(tab === 'salary')} onClick={() => { setTab('salary'); setErr(''); }}>
            Aus Gehalt
          </button>
          <button style={tabBtn(tab === 'totals')} onClick={() => { setTab('totals'); setErr(''); }}>
            Aus Stunden-Summen
          </button>
        </div>

        {/* ── Tab 1: salary-based ── */}
        {tab === 'salary' && (
          <div className="space-y-4">
            <div className="rounded-lg p-3.5 text-sm space-y-1.5"
              style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
              <p style={{ color: 'var(--text-secondary)' }}>
                Generiert einen realistischen Monatsplan — der Gesamtlohn (Grundlohn + Zuschläge)
                trifft genau den eingegebenen Zielbetrag.
              </p>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                Zuschläge (additiv): Nachtarbeit 20–06 Uhr: +40% &nbsp;|&nbsp; Sonntag: +50% &nbsp;|&nbsp;
                Feiertag: +125% &nbsp;|&nbsp; Samstag: kein Zuschlag
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                <Euro size={13} className="inline mr-1" />Grundlohn Zielbetrag (€) *
              </label>
              <input type="text" inputMode="decimal" placeholder="z.B. 2500,00"
                value={salary} onChange={e => setSalary(e.target.value)} style={IS} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                <Clock size={13} className="inline mr-1" />Stundensatz Fahrer (€/Std.) *
              </label>
              <input type="text" inputMode="decimal" placeholder="z.B. 14,00"
                value={rate} onChange={e => setRate(e.target.value)} style={IS} />
              <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>Basis-Stundensatz ohne Zuschläge</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Grundlohn-Anteil (%)
              </label>
              <input type="text" inputMode="numeric" placeholder="85"
                value={glRatio} onChange={e => setGlRatio(e.target.value)} style={IS} />
              <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                Optional – Standard: 85 %. Anteil der Stunden als normaler Werktag-Grundlohn;
                der Rest verteilt sich auf Nacht-, Sonntags- und Feiertagszuschläge.
              </p>
            </div>
          </div>
        )}

        {/* ── Tab 2: totals-based ── */}
        {tab === 'totals' && (
          <div className="space-y-4">
            <div className="rounded-lg p-3.5 text-sm"
              style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
              <p style={{ color: 'var(--text-secondary)' }}>
                Gib die Ziel-Stundensummen direkt ein (Dezimalstunden, z.B. <strong>143,00</strong>).
                Das System generiert einen Monatsplan der diese Summen möglichst genau trifft.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Grundlohn (Std.) *
                </label>
                <input type="text" inputMode="decimal" placeholder="z.B. 143,00"
                  value={tGrundlohn} onChange={e => setTGrundlohn(e.target.value)} style={IS} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Nachtarbeit (Std.)
                </label>
                <input type="text" inputMode="decimal" placeholder="z.B. 4,00"
                  value={tNacht} onChange={e => setTNacht(e.target.value)} style={IS} />
                <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>20–06 Uhr</p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Nacht 0–4 Uhr (Std.)
                </label>
                <input type="text" inputMode="decimal" placeholder="z.B. 2,00"
                  value={tNacht04} onChange={e => setTNacht04(e.target.value)} style={IS} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Sonntag (Std.)
                </label>
                <input type="text" inputMode="decimal" placeholder="z.B. 1,00"
                  value={tSonntag} onChange={e => setTSonntag(e.target.value)} style={IS} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Feiertag (Std.)
                </label>
                <input type="text" inputMode="decimal" placeholder="z.B. 1,00"
                  value={tFeiertag} onChange={e => setTFeiertag(e.target.value)} style={IS} />
              </div>
            </div>
          </div>
        )}

        {/* ── Arbeitszeitfenster (read-only, aus Fahrerprofil) ── */}
        <div className="rounded-xl p-4 space-y-3 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2">
            <Clock size={14} style={{ color: 'var(--accent-text)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Arbeitszeitfenster aus Fahrerprofil
            </span>
          </div>

          {hasProfileWindow ? (
            <div className="rounded-lg px-3 py-2.5 text-sm" style={{
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
            }}>
              <div className="font-medium">
                {formatProfileWeekdays(allowedDows)}
                {profileStart && profileEnd && ` · ${profileStart}–${profileEnd}`}
              </div>
              <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                Diese Werte stammen aus dem Fahrerprofil und werden automatisch verwendet.
                Änderungen erfolgen ausschließlich in der Fahrerverwaltung.
              </p>
            </div>
          ) : (
            <div className="rounded-lg px-3 py-2.5 text-sm" style={{
              background: 'var(--warning-subtle, #fff7e6)',
              border: '1px solid var(--warning)',
              color: 'var(--warning)',
            }}>
              <div className="font-semibold">Kein Arbeitszeitfenster im Fahrerprofil hinterlegt.</div>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                Bitte im Fahrerprofil ergänzen, bevor ein Stundennachweis erstellt wird.
              </p>
            </div>
          )}
        </div>

        {err && (
          <p className="text-sm px-3 py-2 rounded-lg" style={{ color: 'var(--danger)', background: 'var(--danger-subtle)' }}>
            {err}
          </p>
        )}

        {/* ── Action buttons ── */}
        <div className="flex gap-3">
          <button onClick={onBack} className="flex-1 py-3 rounded-lg font-medium text-sm transition-all"
            style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)', background: 'transparent' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            Zurück
          </button>
          <button
            onClick={tab === 'salary' ? goSalary : goTotals}
            className="px-6 py-3 rounded-lg font-semibold text-sm transition-all flex items-center justify-center gap-2"
            style={{ background: 'var(--accent)', color: 'white', flex: 2 }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}>
            Plan generieren <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── Timesheet document ─────────────────────────────────────────────────────

const Timesheet: React.FC<{
  driver: DriverOption;
  month: number;
  year: number;
  rows: DayRow[];
  onRowChange: (i: number, field: keyof DayRow, v: string) => void;
  totals: Totals;
  targetSalary: number;
  hourlyRate: number;
  calcSalary: number;
  highlightDay?: number | null;
}> = ({ driver, month, year, rows, onRowChange, totals, targetSalary, hourlyRate, calcSalary, highlightDay }) => {
  const monthName = MONTH_NAMES_DE[month - 1];

  const FONT = 'Arial, Helvetica, sans-serif';

  // Header cells — slightly taller, comfortable line-height
  const TH: React.CSSProperties = {
    border: '1px solid #555',
    padding: '4px 3px',
    fontSize: '8.5px',
    fontFamily: FONT,
    fontWeight: 'bold',
    textAlign: 'center',
    background: '#e0e0e0',
    verticalAlign: 'middle',
    lineHeight: 1.35,
  };

  // Data cells — row height 19 px gives comfortable reading without overflow
  const TD: React.CSSProperties = {
    border: '1px solid #aaa',
    padding: '0 3px',
    fontSize: '9.5px',
    fontFamily: FONT,
    textAlign: 'center',
    verticalAlign: 'middle',
    height: '19px',
  };

  // Left-aligned date cell
  const TDL: React.CSSProperties = {
    ...TD,
    textAlign: 'left',
    paddingLeft: 6,
    whiteSpace: 'nowrap',
    borderRight: '1px solid #555',
  };

  // Totals row cells
  const TF: React.CSSProperties = {
    ...TD,
    fontWeight: 'bold',
    background: '#d8d8d8',
    border: '1px solid #555',
    fontSize: '9.5px',
  };

  return (
    <div
      id="stundennachweis-print"
      style={{
        background: '#fff',
        padding: '16px 20px 16px 20px',
        fontFamily: FONT,
        width: '740px',
        color: '#000',
        boxSizing: 'border-box',
      }}
    >
      {/* ── Document header ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'end',
        marginBottom: 12,
        paddingBottom: 8,
        borderBottom: '1.5px solid #333',
      }}>
        {/* Left: employee info */}
        <div style={{ fontSize: 9.5, lineHeight: 1.55 }}>
          <div style={{ fontWeight: 'bold', fontSize: 10 }}>{driver.name}</div>
          {driver.personalnummer && (
            <div style={{ color: '#444' }}>Personalnummer: {driver.personalnummer}</div>
          )}
        </div>
        {/* Centre: title */}
        <div style={{ fontSize: 14, fontWeight: 'bold', textAlign: 'center', letterSpacing: '0.03em', padding: '0 24px' }}>
          Stundennachweis
        </div>
        {/* Right: period */}
        <div style={{ fontSize: 9.5, textAlign: 'right', lineHeight: 1.55 }}>
          <div style={{ fontWeight: 'bold', fontSize: 10 }}>{monthName} {year}</div>
          <div style={{ color: '#444' }}>Monat / Jahr</div>
        </div>
      </div>

      {/* ── Table ── */}
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: '100px' }} />
          <col style={{ width: '38px' }} />
          <col style={{ width: '38px' }} />
          <col style={{ width: '38px' }} />
          <col style={{ width: '38px' }} />
          <col style={{ width: '38px' }} />
          <col style={{ width: '38px' }} />
          <col style={{ width: '50px' }} />
          <col style={{ width: '46px' }} />
          <col style={{ width: '50px' }} />
          <col style={{ width: '42px' }} />
          <col style={{ width: '50px' }} />
          <col style={{ width: '54px' }} />
        </colgroup>
        <thead>
          <tr>
            <th style={{ ...TH, textAlign: 'left', paddingLeft: 6 }} rowSpan={2}>Datum</th>
            <th style={{ ...TH, borderBottom: '1px solid #888' }} colSpan={2}>Schicht 1</th>
            <th style={{ ...TH, borderBottom: '1px solid #888' }} colSpan={2}>Schicht 2</th>
            <th style={{ ...TH, borderBottom: '1px solid #888' }} colSpan={2}>Schicht 3</th>
            <th style={TH} rowSpan={2}>Grund-{'\u00AD'}lohn</th>
            <th style={TH} rowSpan={2}>Nacht-{'\u00AD'}arbeit</th>
            <th style={{ ...TH, fontSize: 7.5 }} rowSpan={2}>Nacht-{'\u00AD'}arbeit{'\n'}(0–4 Uhr)</th>
            <th style={TH} rowSpan={2}>Sonn-{'\u00AD'}tag</th>
            <th style={{ ...TH, fontSize: 7.5 }} rowSpan={2}>Feiertag{'\n'}(+ Silvester)</th>
            <th style={{ ...TH, fontSize: 7.5 }} rowSpan={2}>Weihn.{'\n'}u. 1. Mai</th>
          </tr>
          <tr>
            <th style={TH}>Von</th>
            <th style={TH}>Bis</th>
            <th style={TH}>Von</th>
            <th style={TH}>Bis</th>
            <th style={TH}>Von</th>
            <th style={TH}>Bis</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isHighlighted = highlightDay !== null && highlightDay !== undefined && row.dayIndex === highlightDay;
            const bg =
              isHighlighted     ? '#fff9c4' :
              row.isHol         ? '#fff3e0' :
              row.isSun         ? '#f2f2f2' :
              row.isSat         ? '#f7f7f7' : '#fff';
            const fw = (row.isSun || row.isSat || row.isHol || isHighlighted) ? 'bold' : 'normal';
            const outlineStyle: React.CSSProperties = isHighlighted
              ? { outline: '2px solid #f59e0b', outlineOffset: -1 }
              : {};

            return (
              <tr key={row.dayIndex} id={`row-day-${row.dayIndex}`}>
                <td style={{ ...TDL, fontWeight: fw, background: bg, ...outlineStyle }}>
                  {row.weekday} {format(row.date, 'dd.MM.yyyy')}
                  {row.isHol && <span style={{ marginLeft: 3, fontSize: 7.5, color: '#92400e' }}>F</span>}
                  {isHighlighted && <span style={{ marginLeft: 4, fontSize: 7, color: '#b45309', fontWeight: 800 }}>◀ Notiz</span>}
                </td>
                <td style={{ ...TD, background: bg }}>
                  <TimeInput value={row.von1} onChange={v => onRowChange(i, 'von1', v)} />
                </td>
                <td style={{ ...TD, background: bg }}>
                  <TimeInput value={row.bis1} onChange={v => onRowChange(i, 'bis1', v)} />
                </td>
                <td style={{ ...TD, background: bg }}>
                  <TimeInput value={row.von2} onChange={v => onRowChange(i, 'von2', v)} />
                </td>
                <td style={{ ...TD, background: bg }}>
                  <TimeInput value={row.bis2} onChange={v => onRowChange(i, 'bis2', v)} />
                </td>
                <td style={{ ...TD, background: bg }}>
                  <TimeInput value={row.von3} onChange={v => onRowChange(i, 'von3', v)} />
                </td>
                <td style={{ ...TD, background: bg }}>
                  <TimeInput value={row.bis3} onChange={v => onRowChange(i, 'bis3', v)} />
                </td>
                <td style={{ ...TD, background: bg, fontWeight: row.grundlohn ? 'bold' : 'normal' }}>{row.grundlohn}</td>
                <td style={{ ...TD, background: bg }}>{row.nachtarbeit}</td>
                <td style={{ ...TD, background: bg }}>{row.nachtarbeit04}</td>
                <td style={{ ...TD, background: bg }}>{row.sonntag}</td>
                <td style={{ ...TD, background: bg }}>{row.feiertag}</td>
                <td style={{ ...TD, background: bg }}>{row.weihnachten}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={7} style={{ ...TF, textAlign: 'left', paddingLeft: 6, fontSize: 9 }}>
              Summe in Dezimaldarstellung
            </td>
            <td style={TF}>{fmtDec(minsToDecimal(totals.grundlohn))}</td>
            <td style={TF}>{fmtDec(minsToDecimal(totals.nachtarbeit))}</td>
            <td style={TF}>{fmtDec(minsToDecimal(totals.nacht04))}</td>
            <td style={TF}>{fmtDec(minsToDecimal(totals.sonntag))}</td>
            <td style={TF}>{fmtDec(minsToDecimal(totals.feiertag))}</td>
            <td style={TF}>{fmtDec(minsToDecimal(totals.weihnachten))}</td>
          </tr>
        </tfoot>
      </table>

      {/* ── Footer info line ── */}
      <div style={{
        marginTop: 6,
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: 8.5,
        color: '#666',
        borderTop: '1px solid #ccc',
        paddingTop: 4,
      }}>
        <span>Lohn+Gehalt</span>
        <span>- 1 -</span>
        <span>{format(new Date(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1), 'dd.MM.yyyy')}</span>
      </div>

      {/* ── Signature ── */}
      <div style={{ marginTop: 18, display: 'flex', justifyContent: 'space-between', gap: 48 }}>
        <div style={{ flex: 1 }}>
          <div style={{ height: 28 }} />
          <div style={{ borderTop: '1px solid #333', paddingTop: 5 }}>
            <span style={{ fontSize: 9, color: '#333' }}>Datum, Unterschrift Arbeitnehmer</span>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ height: 28 }} />
          <div style={{ borderTop: '1px solid #333', paddingTop: 5 }}>
            <span style={{ fontSize: 9, color: '#333' }}>Datum, Unterschrift Arbeitgeber</span>
          </div>
        </div>
      </div>

    </div>
  );
};

// ─── Notes carousel ─────────────────────────────────────────────────────────

const WEEKDAY_FULL = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

function noteIsNight(noteDate: string): boolean {
  const d = new Date(noteDate);
  const h = d.getHours();
  return h >= 20 || h < 6;
}

function noteIsWeekend(noteDate: string): boolean {
  const dow = new Date(noteDate).getDay();
  return dow === 0 || dow === 6;
}

function noteIsHoliday(noteDate: string): boolean {
  return dateIsHoliday(new Date(noteDate));
}

const NotesCarousel: React.FC<{
  notes: Note[];
  rows: DayRow[];
  onHighlightDay?: (dayIndex: number | null) => void;
}> = ({ notes, rows, onHighlightDay }) => {
  const [idx, setIdx] = useState(0);

  // Sort chronologically
  const sorted = [...notes].sort((a, b) => a.note_date.localeCompare(b.note_date));

  useEffect(() => { setIdx(0); }, [notes]);

  if (sorted.length === 0) {
    return (
      <div style={{
        borderRadius: 14,
        border: '1px solid var(--border)',
        background: 'var(--bg-surface)',
        padding: '20px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
      }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10, flexShrink: 0,
          background: 'var(--bg-subtle)',
          border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <StickyNote size={17} style={{ color: 'var(--text-tertiary)' }} />
        </div>
        <div>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
            Keine Notizen für diesen Fahrer in diesem Monat
          </p>
          <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
            Notizen werden automatisch geladen, sobald sie für den gewählten Monat vorhanden sind.
          </p>
        </div>
      </div>
    );
  }

  const note    = sorted[idx];
  const noteD   = new Date(note.note_date);
  const dayNum  = noteD.getDate();
  const dow     = noteD.getDay();
  const weekday = WEEKDAY_FULL[dow];
  const dateStr = format(noteD, 'dd.MM.yyyy');
  const timeStr = format(noteD, 'HH:mm');

  // Check if this note's day has a matching row in the plan
  const matchRow = rows.find(r => r.date.getDate() === dayNum);

  // For must_include_in_plan notes: verify the note's ±30 min window is actually
  // covered by a shift (not just that the day has any worked hours).
  const behavior2 = note.note_planning_behavior
    ?? (['krank','urlaub','frei','nicht verfügbar','gesperrt','ausfall','abwesend'].some(k => note.note_text.toLowerCase().includes(k)) ? 'exclude_from_plan'
      : ['blitzer','unfall','panne','kontrolle','wartezeit'].some(k => note.note_text.toLowerCase().includes(k)) ? 'must_include_in_plan'
      : null);
  const isMustInclude = behavior2 === 'must_include_in_plan';

  let inPlan = !!(matchRow && matchRow.grundlohn);
  if (isMustInclude && matchRow) {
    const noteHM  = noteD.getHours() * 60 + noteD.getMinutes();
    const winS    = Math.max(0, noteHM - 30);
    const winE    = Math.min(23 * 60 + 59, noteHM + 30);
    const checkSeg = (v: string, b: string) => {
      if (!v || !b) return false;
      const sv = toMins(v), sb = toMins(b);
      return sv <= winS && sb >= winE;
    };
    inPlan = checkSeg(matchRow.von1, matchRow.bis1)
          || checkSeg(matchRow.von2, matchRow.bis2)
          || checkSeg(matchRow.von3, matchRow.bis3);
  }
  const isNight  = noteIsNight(note.note_date);
  const isWeekend = noteIsWeekend(note.note_date);
  const isHol    = noteIsHoliday(note.note_date);

  const prev = () => { setIdx(i => Math.max(0, i - 1)); onHighlightDay?.(null); };
  const next = () => { setIdx(i => Math.min(sorted.length - 1, i + 1)); onHighlightDay?.(null); };

  const handleCardClick = () => {
    if (matchRow) onHighlightDay?.(matchRow.dayIndex);
  };

  // Badge helpers
  const badges: { label: string; icon: React.ReactNode; color: string; bg: string; border: string }[] = [];
  if (isHol)     badges.push({ label: 'Feiertag', icon: <Star size={10} />,    color: '#d97706', bg: 'rgba(217,119,6,0.1)',   border: 'rgba(217,119,6,0.25)' });
  if (isWeekend) badges.push({ label: dow === 0 ? 'Sonntag' : 'Samstag', icon: <Sun size={10} />,  color: '#0891b2', bg: 'rgba(8,145,178,0.1)',  border: 'rgba(8,145,178,0.25)' });
  if (isNight)   badges.push({ label: 'Nacht',    icon: <Moon size={10} />,    color: '#6366f1', bg: 'rgba(99,102,241,0.1)', border: 'rgba(99,102,241,0.25)' });
  if (inPlan)    badges.push({ label: 'Im Plan',  icon: <StickyNote size={10} />, color: '#16a34a', bg: 'rgba(22,163,74,0.1)',  border: 'rgba(22,163,74,0.25)' });

  const behavior = note.note_planning_behavior
    ?? (['krank','urlaub','frei','nicht verfügbar','gesperrt','ausfall','abwesend'].some(k => note.note_text.toLowerCase().includes(k)) ? 'exclude_from_plan'
      : ['blitzer','unfall','panne','kontrolle','wartezeit'].some(k => note.note_text.toLowerCase().includes(k)) ? 'must_include_in_plan'
      : null);
  if (behavior === 'exclude_from_plan')    badges.push({ label: 'Abwesenheit',  icon: <AlertTriangle size={10} />, color: '#dc2626', bg: 'rgba(220,38,38,0.08)', border: 'rgba(220,38,38,0.25)' });
  if (behavior === 'must_include_in_plan') badges.push({ label: 'Pflichtnotiz', icon: <AlertTriangle size={10} />, color: '#d97706', bg: 'rgba(217,119,6,0.08)', border: 'rgba(217,119,6,0.25)' });
  if (note.start_date && note.end_date && note.start_date !== note.end_date) {
    badges.push({ label: `${note.start_date.slice(8,10)}.${note.start_date.slice(5,7)} – ${note.end_date.slice(8,10)}.${note.end_date.slice(5,7)}`, icon: <CalendarRange size={10} />, color: 'var(--text-secondary)', bg: 'var(--bg-subtle)', border: 'var(--border)' });
  }

  return (
    <div style={{
      borderRadius: 14,
      border: '1px solid var(--border)',
      background: 'var(--bg-surface)',
      overflow: 'hidden',
    }}>
      {/* Header row */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px 10px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-subtle)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8,
            background: 'rgba(var(--accent-rgb, 37,99,235),0.1)',
            border: '1px solid rgba(var(--accent-rgb, 37,99,235),0.2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <StickyNote size={14} style={{ color: 'var(--accent)' }} />
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Notizen dieses Monats
          </span>
          <span style={{
            fontSize: 11, fontWeight: 600,
            padding: '2px 8px', borderRadius: 20,
            background: 'var(--accent)',
            color: 'white',
          }}>
            {sorted.length}
          </span>
        </div>

        {/* Navigation */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginRight: 4 }}>
            {idx + 1} / {sorted.length}
          </span>
          <button
            onClick={prev} disabled={idx === 0}
            style={{
              width: 28, height: 28, borderRadius: 7, border: '1px solid var(--border)',
              background: idx === 0 ? 'var(--bg-muted)' : 'var(--bg-subtle)',
              color: idx === 0 ? 'var(--text-tertiary)' : 'var(--text-primary)',
              cursor: idx === 0 ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.15s',
            }}
          >
            <ChevronLeft size={15} />
          </button>
          <button
            onClick={next} disabled={idx === sorted.length - 1}
            style={{
              width: 28, height: 28, borderRadius: 7, border: '1px solid var(--border)',
              background: idx === sorted.length - 1 ? 'var(--bg-muted)' : 'var(--bg-subtle)',
              color: idx === sorted.length - 1 ? 'var(--text-tertiary)' : 'var(--text-primary)',
              cursor: idx === sorted.length - 1 ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.15s',
            }}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>

      {/* Note card body */}
      <div
        onClick={handleCardClick}
        style={{
          padding: '16px 18px',
          cursor: matchRow ? 'pointer' : 'default',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => { if (matchRow) (e.currentTarget as HTMLElement).style.background = 'var(--bg-subtle)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = ''; }}
      >
        {/* Date + time row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 5,
            fontSize: 12, fontWeight: 700, color: 'var(--text-primary)',
          }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 22, borderRadius: 6,
              background: 'var(--accent)', color: 'white',
              fontSize: 11, fontWeight: 800,
            }}>
              {dayNum}
            </span>
            <span>{weekday}, {dateStr}</span>
          </div>
          <span style={{
            fontSize: 11, fontWeight: 600,
            padding: '2px 7px', borderRadius: 6,
            background: 'var(--bg-subtle)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
          }}>
            {timeStr} Uhr
          </span>
          {/* Badges */}
          {badges.map((b, bi) => (
            <span key={bi} style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: 10, fontWeight: 600,
              padding: '2px 7px', borderRadius: 6,
              background: b.bg, color: b.color, border: `1px solid ${b.border}`,
            }}>
              {b.icon}{b.label}
            </span>
          ))}
        </div>

        {/* Note text */}
        <p style={{
          fontSize: 13, lineHeight: 1.6,
          color: 'var(--text-primary)',
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {note.note_text}
        </p>

        {/* Click hint when note has a matching plan row */}
        {matchRow && (
          <p style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 8, marginBottom: 0 }}>
            ↓ Klicken um den {weekday} im Plan zu markieren
          </p>
        )}
      </div>

      {/* Dot navigation */}
      {sorted.length > 1 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
          padding: '8px 16px 12px',
        }}>
          {sorted.map((_, i) => (
            <button
              key={i}
              onClick={() => { setIdx(i); onHighlightDay?.(null); }}
              style={{
                width: i === idx ? 18 : 7,
                height: 7,
                borderRadius: 4,
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                background: i === idx ? 'var(--accent)' : 'var(--border)',
                transition: 'all 0.2s',
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Structured warnings display ─────────────────────────────────────────────

function DateGroupRow({ dateKey, items, color }: {
  dateKey: string;
  items: { text: string; date: string | null }[];
  color: string;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '3px 2px', width: '100%', textAlign: 'left',
        }}
      >
        <ChevronDown size={12} style={{
          color, flexShrink: 0,
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s ease',
        }} />
        <span style={{ fontSize: 12, fontWeight: 600, color }}>
          {dateKey !== '_no_date' ? formatDateDE(dateKey) : 'Allgemein'}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 600,
          padding: '0 6px', borderRadius: 12,
          background: `${color}18`, color,
        }}>
          {items.length}
        </span>
      </button>
      {open && (
        <div style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 4 }}>
          {items.map((item, i) => {
            const display = item.date
              ? item.text.replace(/^\d{4}-\d{2}-\d{2}:\s*/, '')
              : item.text;
            return (
              <p key={i} style={{ fontSize: 11.5, color: '#374151', margin: 0, lineHeight: 1.45 }}>
                {display}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WarningGroupCard({ group }: { group: WarningGroup }) {
  const [open, setOpen] = React.useState(group.category === 'critical');
  const dateGroups = groupByDate(group.items);
  const showInline = group.category === 'critical' || group.category === 'note';

  return (
    <div style={{
      borderRadius: 10,
      border: `1px solid ${group.borderColor}`,
      background: group.bgColor,
      overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <AlertTriangle size={14} style={{ color: group.color, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: group.color, flex: 1 }}>
          {group.label}
        </span>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          padding: '1px 8px',
          borderRadius: 20,
          background: group.borderColor,
          color: group.color,
          minWidth: 22,
          textAlign: 'center',
        }}>
          {group.items.length}
        </span>
        <ChevronDown
          size={14}
          style={{
            color: group.color,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s ease',
          }}
        />
      </button>

      {open && (
        <div style={{ padding: '0 14px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {showInline ? (
            [...dateGroups.entries()].map(([dateKey, items]) => (
              <div key={dateKey}>
                {dateKey !== '_no_date' && (
                  <div style={{
                    fontSize: 11, fontWeight: 600, color: group.color,
                    opacity: 0.8, marginBottom: 2, paddingLeft: 2,
                  }}>
                    {formatDateDE(dateKey)}
                  </div>
                )}
                {items.map((item, i) => {
                  const display = item.date
                    ? item.text.replace(/^\d{4}-\d{2}-\d{2}:\s*/, '')
                    : item.text;
                  return (
                    <p key={i} style={{
                      fontSize: 12, color: '#374151', margin: 0,
                      lineHeight: 1.5, paddingLeft: dateKey !== '_no_date' ? 10 : 2,
                    }}>
                      {display}
                    </p>
                  );
                })}
              </div>
            ))
          ) : (
            [...dateGroups.entries()].map(([dateKey, items]) => (
              <DateGroupRow key={dateKey} dateKey={dateKey} items={items} color={group.color} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function StructuredWarnings({ warnings }: { warnings: string[] }) {
  const groups = categorizeWarnings(warnings);
  const hasCritical = groups.some(g => g.category === 'critical');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <AlertTriangle size={15} style={{ color: hasCritical ? '#dc2626' : '#d97706', flexShrink: 0 }} />
        <span style={{
          fontSize: 12, fontWeight: 700,
          color: hasCritical ? '#dc2626' : '#d97706',
          textTransform: 'uppercase', letterSpacing: '0.04em',
        }}>
          Generierungswarnungen
        </span>
        {groups.map(g => (
          <span key={g.category} style={{
            fontSize: 11, fontWeight: 600,
            padding: '2px 9px', borderRadius: 20,
            background: g.borderColor, color: g.color,
          }}>
            {g.label}: {g.items.length}
          </span>
        ))}
      </div>

      {groups.map(g => (
        <WarningGroupCard key={g.category} group={g} />
      ))}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

type StepType = 'step1' | 'step2' | 'sheet';

const StundennachweisPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { companyId } = useAuth();
  const { settings: companySettings } = useCompanySettings();
  const bundesland = parseBundesland(companySettings?.state);

  const [step,       setStep]      = useState<StepType>('step1');
  const [drivers,    setDrivers]   = useState<DriverOption[]>([]);
  const [loadingD,   setLoadingD]  = useState(true);
  const [exporting,  setExporting] = useState(false);
  const [generating, setGenerating]= useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [generatingExcel, setGeneratingExcel] = useState(false);
  const [fueMonth, setFueMonth] = useState(new Date().getMonth() + 1);
  const [fueYear, setFueYear] = useState(new Date().getFullYear());

  const [selDriverId, setSelDriverId] = useState('');
  const [selMonth,    setSelMonth]    = useState(0);
  const [selYear,     setSelYear]     = useState(0);
  const [targetSalary,  setTargetSalary]   = useState(0);
  const [minSalary,     setMinSalary]      = useState<number | null>(null);
  const [maxSalary,     setMaxSalary]      = useState<number | null>(null);
  const [hourlyRate,    setHourlyRate]     = useState(0);
  const [grundlohnRatio,setGrundlohnRatio] = useState(0.85);
  const [selDriver,     setSelDriver]      = useState<DriverOption | null>(null);
  const [rows,        setRows]        = useState<DayRow[]>([]);
  const [notes,       setNotes]       = useState<Note[]>([]);
  const [seed,        setSeed]        = useState(0);
  const [genMode,       setGenMode]       = useState<'salary' | 'totals'>('salary');
  const [totalsTarget,  setTotalsTarget]  = useState<TotalsTarget | null>(null);
  const [highlightDay,  setHighlightDay]  = useState<number | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [workWindow,    setWorkWindow]    = useState<WorkWindowConstraints | null>(null);
  const [step2FormState, setStep2FormState] = useState<Step2FormState>(DEFAULT_STEP2_STATE);
  // True when a saved record was opened that has no salary metadata (old record)
  const [noSalaryMeta, setNoSalaryMeta] = useState(false);
  // Set when a saved record is opened from the archive
  const [isFromArchive, setIsFromArchive] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [generationSource, setGenerationSource] = useState<string | null>(null);
  const [generationWarnings, setGenerationWarnings] = useState<string[]>([]);

  useEffect(() => {
    supabase
      .from('drivers')
      .select('id, name, personalnummer, work_window_start, work_window_end, allowed_weekdays')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .order('name')
      .then(({ data }) => { setDrivers((data as DriverOption[]) || []); setLoadingD(false); });
  }, [companyId]);

  // Hydrate from a saved record passed via navigation state (from the archive)
  useEffect(() => {
    const state = location.state as { savedRecord?: Record<string, unknown> } | null;
    if (!state?.savedRecord) return;
    const rec = state.savedRecord;
    const m = rec.month as number;
    const y = rec.year as number;
    const rawRows = (rec.rows_json as unknown[]) ?? [];
    const restoredRows = deserializeRows(rawRows, m, y);
    const driver: DriverOption = {
      id:             rec.driver_id as string,
      name:           rec.driver_name as string,
      personalnummer: (rec.personalnummer as string | null) ?? undefined,
    };
    setSelDriver(driver);
    setSelDriverId(driver.id);
    setSelMonth(m);
    setSelYear(y);
    setRows(restoredRows);
    // Restore salary metadata (may be null for old records)
    const hasSalaryMeta = rec.hourly_rate != null || rec.target_salary != null || rec.generation_mode != null;
    setNoSalaryMeta(!hasSalaryMeta);
    if (rec.generation_mode === 'salary' || rec.generation_mode === 'totals') {
      setGenMode(rec.generation_mode as 'salary' | 'totals');
    } else if (rec.generation_mode === 'fahrtenbuch' && rec.hourly_rate != null) {
      setGenMode('salary');
    }
    const savedHourlyRate   = typeof rec.hourly_rate   === 'number' && rec.hourly_rate   > 0 ? rec.hourly_rate   as number : null;
    const savedTargetSalary = typeof rec.target_salary === 'number' && rec.target_salary > 0 ? rec.target_salary as number : null;
    const savedMinSalary    = typeof rec.min_salary    === 'number' && rec.min_salary    > 0 ? rec.min_salary    as number : null;
    const savedMaxSalary    = typeof rec.max_salary    === 'number' && rec.max_salary    > 0 ? rec.max_salary    as number : null;
    if (savedHourlyRate   !== null) setHourlyRate(savedHourlyRate);
    if (savedTargetSalary !== null) setTargetSalary(savedTargetSalary);
    if (savedMinSalary    !== null) setMinSalary(savedMinSalary);
    if (savedMaxSalary    !== null) setMaxSalary(savedMaxSalary);
    if (typeof rec.grundlohn_ratio === 'number' && rec.grundlohn_ratio > 0) {
      setGrundlohnRatio(rec.grundlohn_ratio);
    }
    // Fallback: fetch driver profile for planning rates when snapshot is missing
    if (savedHourlyRate === null || savedTargetSalary === null || savedMinSalary === null || savedMaxSalary === null) {
      supabase
        .from('drivers')
        .select('planning_hourly_rate, planning_target_salary, planning_min_salary, planning_max_salary')
        .eq('id', rec.driver_id as string)
        .maybeSingle()
        .then(({ data: dv }) => {
          if (!dv) return;
          if (savedHourlyRate === null && typeof dv.planning_hourly_rate === 'number' && dv.planning_hourly_rate > 0) {
            setHourlyRate(dv.planning_hourly_rate);
          }
          if (savedTargetSalary === null && typeof dv.planning_target_salary === 'number' && dv.planning_target_salary > 0) {
            setTargetSalary(dv.planning_target_salary);
          }
          if (savedMinSalary === null && typeof dv.planning_min_salary === 'number' && dv.planning_min_salary > 0) {
            setMinSalary(dv.planning_min_salary);
          } else if (savedMinSalary === null && typeof dv.planning_target_salary === 'number' && dv.planning_target_salary > 0) {
            setMinSalary(dv.planning_target_salary);
          }
          if (savedMaxSalary === null && typeof dv.planning_max_salary === 'number' && dv.planning_max_salary > 0) {
            setMaxSalary(dv.planning_max_salary);
          } else if (savedMaxSalary === null && typeof dv.planning_target_salary === 'number' && dv.planning_target_salary > 0) {
            setMaxSalary(dv.planning_target_salary);
          }
        });
    }
    if (rec.totals_target_json) {
      setTotalsTarget(rec.totals_target_json as TotalsTarget);
    }
    if (rec.work_window_json) {
      setWorkWindow(rec.work_window_json as WorkWindowConstraints);
    }
    setIsFromArchive(true);
    setGenerationSource((rec.generation_source as string | null) ?? null);
    const ts = (rec.updated_at ?? rec.saved_at) as string | null;
    setSavedAt(ts ?? null);
    if (Array.isArray(rec.warnings_json) && rec.warnings_json.length > 0) {
      setGenerationWarnings(rec.warnings_json as string[]);
    }
    setStep('sheet');
    // Load notes for the restored driver/month
    if (driver.id && m && y && companyId) {
      const notesCols = 'id, driver_id, note_date, note_text, start_date, end_date, is_full_day, note_planning_behavior';
      const daysInM = getDaysInMonth(new Date(y, m - 1, 1));
      const mStart = `${y}-${String(m).padStart(2,'0')}-01`;
      const mEnd   = `${y}-${String(m).padStart(2,'0')}-${String(daysInM).padStart(2,'0')}`;
      supabase
        .from('driver_notes')
        .select(notesCols)
        .eq('company_id', companyId)
        .eq('driver_id', driver.id)
        .order('note_date')
        .then(({ data }) => {
          if (!data) return;
          const filtered = data.filter((n: Note) => {
            const noteDay = n.note_date.slice(0, 10);
            if (noteDay >= mStart && noteDay <= mEnd) return true;
            const sd = n.start_date ?? noteDay;
            const ed = n.end_date   ?? sd;
            return sd <= mEnd && ed >= mStart;
          });
          setNotes(filtered);
          // Re-apply Pflichtnotiz coverage windows to the restored rows
          setRows(prev => applyMustIncludeNotesToRows(prev, filtered));
        });
    }
    // Clear navigation state so refreshing doesn't re-hydrate
    navigate(location.pathname, { replace: true, state: null });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchNotes = async (dId: string, m: number, y: number): Promise<Note[]> => {
    const days = getDaysInMonth(new Date(y, m - 1, 1));
    const monthStart = `${y}-${String(m).padStart(2,'0')}-01`;
    const monthEnd   = `${y}-${String(m).padStart(2,'0')}-${String(days).padStart(2,'0')}`;
    const { data } = await supabase
      .from('driver_notes')
      .select('id, driver_id, note_date, note_text, start_date, end_date, is_full_day, note_planning_behavior')
      .eq('company_id', companyId)
      .eq('driver_id', dId)
      .order('note_date');
    if (!data) return [];
    return data.filter(n => {
      const noteDay = n.note_date.slice(0, 10);
      if (noteDay >= monthStart && noteDay <= monthEnd) return true;
      const sd = n.start_date ?? noteDay;
      const ed = n.end_date   ?? sd;
      return sd <= monthEnd && ed >= monthStart;
    });
  };

  const handleStep1 = (dId: string, m: number, y: number) => {
    setSelDriverId(dId); setSelMonth(m); setSelYear(y);
    setSelDriver(drivers.find(d => d.id === dId) || null);
    setStep('step2');
  };

  const handleStep2 = async (salary: number, rate: number, glRatio: number, ww: WorkWindowConstraints) => {
    setTargetSalary(salary); setHourlyRate(rate); setGrundlohnRatio(glRatio);
    setGenMode('salary'); setTotalsTarget(null); setWorkWindow(ww);
    setGenerating(true);
    const n = await fetchNotes(selDriverId, selMonth, selYear);
    setNotes(n);
    const plan = generatePlan({ year: selYear, month: selMonth, targetSalary: salary, hourlyRate: rate, notes: n, seed: 0, grundlohnRatio: glRatio, bundesland, workWindow: ww });
    setRows(applyMustIncludeNotesToRows(plan, n)); setSeed(0); setHighlightDay(null); setStep('sheet'); setGenerating(false); setNoSalaryMeta(false); setIsFromArchive(false); setSavedAt(null);
  };

  const handleStep2Totals = async (targets: TotalsTarget, ww: WorkWindowConstraints) => {
    setGenMode('totals'); setTotalsTarget(targets); setWorkWindow(ww);
    setGenerating(true);
    const n = await fetchNotes(selDriverId, selMonth, selYear);
    setNotes(n);
    const plan = generatePlanFromTotals(selYear, selMonth, targets, n, 0, bundesland, ww);
    setRows(applyMustIncludeNotesToRows(plan, n)); setSeed(0); setHighlightDay(null); setStep('sheet'); setGenerating(false); setNoSalaryMeta(false); setIsFromArchive(false); setSavedAt(null);
  };

  useEffect(() => {
    if (highlightDay === null || highlightDay === undefined) return;
    const el = document.getElementById(`row-day-${highlightDay}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightDay(null), 10000);
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, [highlightDay]);

  const handleRegenerate = () => {
    const next = seed + 1;
    setSeed(next); setGenerating(true);
    setTimeout(() => {
      if (genMode === 'totals' && totalsTarget) {
        setRows(applyMustIncludeNotesToRows(generatePlanFromTotals(selYear, selMonth, totalsTarget, notes, next, bundesland, workWindow), notes));
      } else {
        setRows(applyMustIncludeNotesToRows(generatePlan({ year: selYear, month: selMonth, targetSalary, hourlyRate, notes, seed: next, grundlohnRatio, bundesland, workWindow }), notes));
      }
      setGenerating(false);
    }, 30);
  };

  const handleRowChange = useCallback((i: number, field: keyof DayRow, v: string) => {
    setRows(prev => {
      const next = [...prev];
      next[i] = calcRow({ ...next[i], [field]: v });
      return next;
    });
  }, []);

  const totals   = calcTotals(rows);
  const calcSal  = salaryEuros(rows, hourlyRate);

  const durationViolations = useMemo(() => validateRowDurations(rows), [rows]);
  const hasDurationViolations = durationViolations.length > 0;

  const handleExport = () => {
    if (!selDriver) return;
    if (hasDurationViolations) return;
    setExporting(true);
    try {
      exportPDF(
        {
          driver:   selDriver,
          month:    selMonth,
          year:     selYear,
          rows,
          totals,
          notes:    notes,
          warnings: generationWarnings,
        },
        `Stundennachweis_${selDriver.name.replace(/\s+/g,'_')}_${MONTH_NAMES_DE[selMonth-1]}_${selYear}`
      );
    } finally {
      setExporting(false);
    }
  };

  const handleSave = async () => {
    if (!selDriver || !companyId) return;
    if (hasDurationViolations) return;
    setSaving(true); setSaveSuccess(false);
    try {
      const workingDays = rows.filter(r => r.grundlohn).length;
      // Serialize rows with stable local date_key instead of raw Date objects
      const rowsForStorage = rows.map(({ date: _date, ...r }) => ({
        ...r,
        date_key: `${selYear}-${String(selMonth).padStart(2, '0')}-${String(r.dayIndex).padStart(2, '0')}`,
      }));
      const { error } = await supabase
        .from('saved_stundennachweise')
        .upsert({
          company_id:          companyId,
          driver_id:           selDriver.id,
          driver_name:         selDriver.name,
          personalnummer:      selDriver.personalnummer ?? null,
          month:               selMonth,
          year:                selYear,
          grundlohn_min:       totals.grundlohn,
          nachtarbeit_min:     totals.nachtarbeit,
          nacht04_min:         totals.nacht04,
          samstag_min:         totals.samstag,
          sonntag_min:         totals.sonntag,
          feiertag_min:        totals.feiertag,
          weihnachten_min:     totals.weihnachten,
          working_days:        workingDays,
          rows_json:           rowsForStorage,
          // Salary metadata
          generation_mode:     genMode,
          grundlohn_ratio:     grundlohnRatio,
          hourly_rate:         hourlyRate > 0 ? hourlyRate : null,
          target_salary:       genMode === 'salary' && targetSalary > 0 ? targetSalary : null,
          calculated_salary:   hourlyRate > 0 ? calcSal : null,
          totals_target_json:  genMode === 'totals' ? totalsTarget : null,
          work_window_json:    workWindow ?? null,
          updated_at:          new Date().toISOString(),
        }, { onConflict: 'company_id,driver_id,month,year' });
      if (error) throw error;
      const now = new Date().toISOString();
      setSavedAt(now);
      setIsFromArchive(true);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (e) {
      console.error('Fehler beim Speichern:', e);
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateFahreruebersicht = async () => {
    if (!companyId) return;
    setGeneratingExcel(true);
    try {
      const [{ data: driversData }, { data: savedData }] = await Promise.all([
        supabase.from('drivers').select('id, name, personalnummer').eq('company_id', companyId).eq('status', 'active').order('name'),
        supabase.from('saved_stundennachweise').select('*').eq('company_id', companyId).eq('month', fueMonth).eq('year', fueYear),
      ]);
      const savedMap = new Map<string, SavedStundennachweis>();
      for (const s of (savedData || [])) savedMap.set(s.driver_id, s as SavedStundennachweis);
      const driverSummaries: DriverSummary[] = (driversData || []).map(d => ({
        driver_id:      d.id,
        driver_name:    d.name,
        personalnummer: d.personalnummer ?? null,
        saved:          savedMap.get(d.id) ?? null,
      }));
      exportFahreruebersichtToExcel({
        month:       fueMonth,
        year:        fueYear,
        companyName: companySettings?.company_name ?? '',
        drivers:     driverSummaries,
      });
    } catch (e) {
      console.error('Fehler beim Generieren:', e);
    } finally {
      setGeneratingExcel(false);
    }
  };

  const goBack = () => {
    if (step === 'sheet') { setStep('step2'); return; }
    if (step === 'step2') { setStep('step1'); return; }
    navigate('/dokumente');
  };

  if (loadingD) return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2" style={{ borderColor: 'var(--accent)' }} />
    </div>
  );

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="rounded-xl p-5 text-white"
        style={{ background: 'linear-gradient(to right, var(--accent), var(--accent-hover))', boxShadow: 'var(--shadow-md)' }}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <button onClick={goBack} className="p-2 rounded-lg transition-all hover:bg-white/20">
              <ChevronLeft size={20} />
            </button>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold">Stundennachweis</h1>
                {step === 'sheet' && isFromArchive && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-semibold"
                    style={{ background: 'rgba(255,255,255,0.2)', color: 'white', border: '1px solid rgba(255,255,255,0.35)' }}>
                    Gespeicherte Version
                  </span>
                )}
                {step === 'sheet' && generationSource === 'fahrtenbuch' && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-semibold"
                    style={{ background: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.9)', border: '1px solid rgba(255,255,255,0.25)' }}>
                    Quelle: Fahrtenbuch
                  </span>
                )}
              </div>
              <p className="text-sm mt-0.5" style={{ color: 'rgba(255,255,255,0.8)' }}>
                {step === 'step1' && 'Schritt 1 von 2 — Fahrer & Zeitraum'}
                {step === 'step2' && 'Schritt 2 von 2 — Lohnparameter'}
                {step === 'sheet' && selDriver && (
                  <>
                    {`${selDriver.name} — ${MONTH_NAMES_DE[selMonth-1]} ${selYear}`}
                    {isFromArchive && savedAt && (
                      <span className="ml-2" style={{ color: 'rgba(255,255,255,0.65)' }}>
                        · Zuletzt gespeichert: {new Date(savedAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </>
                )}
              </p>
            </div>
          </div>
          {step === 'sheet' && (
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={handleSave} disabled={saving || hasDurationViolations}
                title={hasDurationViolations ? 'Speichern blockiert: Schicht- oder Tageslimit überschritten' : undefined}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ border: '1px solid rgba(255,255,255,0.4)', color: 'white' }}>
                <Save size={14} />
                {saving ? 'Speichert …' : saveSuccess ? 'Gespeichert ✓' : isFromArchive ? 'Aktualisieren' : 'Speichern'}
              </button>
              <button onClick={handleRegenerate} disabled={generating}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all hover:bg-white/20"
                style={{ border: '1px solid rgba(255,255,255,0.4)', color: 'white' }}>
                <RefreshCw size={14} className={generating ? 'animate-spin' : ''} />
                {generating ? 'Generiere …' : 'Neuen Plan generieren'}
              </button>
              <button onClick={handleExport} disabled={exporting || hasDurationViolations}
                title={hasDurationViolations ? 'PDF-Export blockiert: Schicht- oder Tageslimit überschritten' : undefined}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: 'white', color: 'var(--accent)' }}>
                <Download size={14} />
                {exporting ? 'Exportiert …' : 'Als PDF exportieren'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Progress bar ── */}
      {(step === 'step1' || step === 'step2') && (
        <div className="max-w-lg mx-auto flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
          <div className="flex-1 h-1.5 rounded-full"
            style={{ background: step === 'step2' ? 'var(--accent)' : 'var(--bg-muted)' }} />
        </div>
      )}

      {step === 'step1' && <Step1 drivers={drivers} onNext={handleStep1} />}
      {step === 'step2' && selDriver && (
        <Step2
          driver={selDriver} month={selMonth} year={selYear}
          initialState={step2FormState}
          onStateChange={setStep2FormState}
          onGenerateSalary={handleStep2}
          onGenerateTotals={handleStep2Totals}
          onBack={() => setStep('step1')}
        />
      )}

      {step === 'sheet' && generating && (
        <div className="flex items-center justify-center h-32">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: 'var(--accent)' }} />
        </div>
      )}

      {step === 'sheet' && !generating && selDriver && (
        <>
          {/* ── Summary bar ── */}
          <div className="rounded-xl p-4 flex flex-wrap items-center gap-6"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
            {noSalaryMeta ? (
              <>
                <div className="text-sm">
                  <span style={{ color: 'var(--text-tertiary)' }}>Gehaltsbereich: </span>
                  <span className="font-bold" style={{ color: 'var(--text-tertiary)' }}>—</span>
                </div>
                <div className="text-sm">
                  <span style={{ color: 'var(--text-tertiary)' }}>Berechnet: </span>
                  <span className="font-bold" style={{ color: 'var(--text-tertiary)' }}>—</span>
                </div>
              </>
            ) : genMode === 'salary' ? (
              <>
                <div className="text-sm">
                  <span style={{ color: 'var(--text-tertiary)' }}>Gehaltsbereich: </span>
                  {(minSalary != null || maxSalary != null) ? (
                    <span className="font-bold" style={{ color: 'var(--text-primary)' }}>
                      {minSalary != null ? `${minSalary.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : '—'}
                      {' – '}
                      {maxSalary != null ? `${maxSalary.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : '—'}
                    </span>
                  ) : targetSalary > 0 ? (
                    <span className="font-bold" style={{ color: 'var(--text-primary)' }}>
                      {targetSalary.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                    </span>
                  ) : (
                    <span className="font-bold" style={{ color: 'var(--text-tertiary)' }}>—</span>
                  )}
                </div>
                <div className="text-sm">
                  <span style={{ color: 'var(--text-tertiary)' }}>Berechnet: </span>
                  {hourlyRate > 0 ? (
                    <span className="font-bold" style={{ color: 'var(--text-primary)' }}>
                      {calcSal.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                    </span>
                  ) : (
                    <span className="font-bold text-xs" style={{ color: 'var(--text-tertiary)' }}>Stundensatz fehlt</span>
                  )}
                </div>
                {hourlyRate > 0 && (() => {
                  const effMin = minSalary ?? (targetSalary > 0 ? targetSalary : null);
                  const effMax = maxSalary ?? (targetSalary > 0 ? targetSalary : null);
                  if (effMin == null && effMax == null) return null;
                  const tol = 0.01;
                  if (effMin != null && calcSal < effMin - tol) {
                    return (
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                        style={{ background: '#fff3e0', color: '#e65100', border: '1px solid #ffcc80' }}>
                        Unter Mindestgehalt
                      </span>
                    );
                  }
                  if (effMax != null && calcSal > effMax + tol) {
                    return (
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                        style={{ background: '#e8f5e9', color: '#2e7d32', border: '1px solid #a5d6a7' }}>
                        Über Maximalgehalt
                      </span>
                    );
                  }
                  return (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                      style={{ background: '#e8f5e9', color: '#2e7d32', border: '1px solid #a5d6a7' }}>
                      Im Gehaltsbereich
                    </span>
                  );
                })()}
              </>
            ) : (
              <>
                <div className="text-sm">
                  <span style={{ color: 'var(--text-tertiary)' }}>Modus: </span>
                  <span className="font-bold" style={{ color: 'var(--text-primary)' }}>Aus Stunden-Summen</span>
                </div>
                {totalsTarget && (
                  <div className="text-sm">
                    <span style={{ color: 'var(--text-tertiary)' }}>Ziel Grundlohn: </span>
                    <span className="font-bold" style={{ color: 'var(--text-primary)' }}>
                      {fmtDec(minsToDecimal(totalsTarget.grundlohn))} Std.
                    </span>
                  </div>
                )}
              </>
            )}
            <div className="text-sm">
              <span style={{ color: 'var(--text-tertiary)' }}>Gesamt-Stunden: </span>
              <span className="font-bold" style={{ color: 'var(--text-primary)' }}>
                {fmtDec(minsToDecimal(totals.grundlohn))} Std.
              </span>
            </div>
            <div className="text-sm">
              <span style={{ color: 'var(--text-tertiary)' }}>Arbeitstage: </span>
              <span className="font-bold" style={{ color: 'var(--text-primary)' }}>
                {rows.filter(r => r.grundlohn).length}
              </span>
            </div>
            {rows.some(r => r.noteHighlight) && (
              <div className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full"
                style={{ background: '#fffde7', color: '#e65100', border: '1px solid #ffcc80' }}>
                <span style={{ fontWeight: 'bold' }}>●</span>
                Notizen-Zeilen automatisch befüllt — bearbeitbar
              </div>
            )}
          </div>

          {/* ── Notes carousel ── */}
          <NotesCarousel
            notes={notes}
            rows={rows}
            onHighlightDay={setHighlightDay}
          />

          {/* ── Hard duration violations (blocks save / export) ── */}
          {hasDurationViolations && (
            <div className="rounded-xl p-4" style={{ background: '#fef2f2', border: '1px solid #fca5a5' }}>
              <div className="flex items-start gap-3">
                <AlertTriangle size={20} style={{ color: '#b91c1c', flexShrink: 0, marginTop: 2 }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold" style={{ color: '#991b1b' }}>
                    Stundennachweis kann nicht gespeichert oder exportiert werden — {durationViolations.length} Verstoß
                    {durationViolations.length === 1 ? '' : 'e'} gegen die Schicht- bzw. Tageslimits.
                  </p>
                  <p className="text-xs mt-1" style={{ color: '#991b1b', opacity: 0.85 }}>
                    Eine einzelne Schicht darf höchstens 4:30 Std. dauern, der Tagesgesamt höchstens 8:30 Std.
                    Bitte die folgenden Zeilen anpassen:
                  </p>
                  <ul className="mt-2 space-y-1 text-xs" style={{ color: '#991b1b' }}>
                    {durationViolations.map((v, idx) => {
                      const dateLabel = `${v.weekday} ${String(v.dayIndex).padStart(2, '0')}.${String(v.date.getMonth() + 1).padStart(2, '0')}.${v.date.getFullYear()}`;
                      if (v.type === 'shift') {
                        return (
                          <li key={idx} className="flex items-start gap-2">
                            <span style={{ fontWeight: 'bold' }}>•</span>
                            <span>
                              {dateLabel} — {v.shiftLabel} {v.von}–{v.bis}: <strong>{minsToHHMM(v.durationMinutes)} Std.</strong>
                              {' '}(Limit {minsToHHMM(v.limit)} Std.)
                            </span>
                          </li>
                        );
                      }
                      return (
                        <li key={idx} className="flex items-start gap-2">
                          <span style={{ fontWeight: 'bold' }}>•</span>
                          <span>
                            {dateLabel} — Tagesgesamt: <strong>{minsToHHMM(v.durationMinutes)} Std.</strong>
                            {' '}(Limit {minsToHHMM(v.limit)} Std.)
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* ── Generation warnings (structured groups) ── */}
          {generationWarnings.length > 0 && (
            <StructuredWarnings warnings={generationWarnings} />
          )}

          {/* ── Document ── */}
          <div className="rounded-xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)', overflowX: 'auto' }}>
            <div style={{ padding: '8px 4px' }}>
              <Timesheet
                driver={selDriver}
                month={selMonth}
                year={selYear}
                rows={rows}
                onRowChange={handleRowChange}
                totals={totals}
                targetSalary={targetSalary}
                hourlyRate={hourlyRate}
                calcSalary={calcSal}
                highlightDay={highlightDay}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default StundennachweisPage;