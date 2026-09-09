/**
 * Finale Dokumente erstellen – modal for V1 planning finalization.
 *
 * Flow:
 *  1. Run pre-flight consistency checks against live DB data.
 *  2. If all checks pass, generate Fahrtenbuch XLSX + per-driver Stundennachweis
 *     summaries from the same data snapshot (same DB read).
 *  3. Persist a planning_finalizations record so stale detection works later.
 *  4. Trigger browser downloads for Fahrtenbuch XLSX.
 *  5. Expose download buttons for each Stundennachweis (PDF via existing util).
 *
 * Read-only from the trip perspective — no writes to fahrtenbuch_trips.
 * Only write: one INSERT into planning_finalizations.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  FileText,
  Loader2,
  Lock,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { exportAppliedRunXlsx, type AppliedRunSummary } from '../utils/monatsplanungXlsxExport';
import {
  exportStundennachweisAsPdf,
  type PdfDayRow,
  type PdfTotals,
} from '../utils/stundennachweisPdfExport';
import {
  resolveActualRideWindow,
  fmtAbsDateTime,
  fmtAbsTime,
  fmtAbsDate,
} from '../utils/planningQualityChecks';
import MonatsplanungStundennachweisPreview from './MonatsplanungStundennachweisPreview';

// ── Types ──────────────────────────────────────────────────────────────────

const DEFAULT_CAR_SWITCH_GAP_MINUTES = 30;

interface Props {
  run: AppliedRunSummary;
  companyId: string;
  userId: string | undefined;
  onClose: () => void;
  /** Called after successful finalization so parent can reload and mark stale. */
  onFinalized: (finalizationId: string) => void;
}

interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
}

interface DriverSummary {
  id: string;
  name: string;
  trips: number;
  blocks: number;
  workMinutes: number;
  nightMinutes: number;
  sundayMinutes: number;
  expectedBrutto: number | null;
  /** Per-driver PDF rows built from the finalized snapshot. Available in-session only. */
  pdfData?: { rows: PdfDayRow[]; totals: PdfTotals };
}

interface FinalSnapshot {
  totalTrips: number;
  driverCount: number;
  drivers: DriverSummary[];
  driverSummaryJson: Record<string, unknown>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatError(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const parts: string[] = [];
    if (o['message']) parts.push(`Message: ${o['message']}`);
    if (o['details']) parts.push(`Details: ${o['details']}`);
    if (o['code']) parts.push(`Code: ${o['code']}`);
    if (o['hint']) parts.push(`Hint: ${o['hint']}`);
    if (parts.length > 0) return parts.join('\n');
    try { return JSON.stringify(err, null, 2); } catch { return String(err); }
  }
  return String(err);
}

const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

const CHECK_SUGGESTIONS: Record<string, string[]> = {
  'Fahrzeugwechsel zu kurz': [
    'Diese Fahrten liegen auf unterschiedlichen Fahrzeugen zu nah beieinander. Zwischen zwei verschiedenen Fahrzeugen muss der konfigurierte Fahrzeugwechsel-Puffer eingehalten werden.',
    'Prüfen Sie in der Transfer-Analyse, ob einer der betroffenen Blöcke auf einen anderen passenden Fahrer verschoben werden kann.',
    'Wenn viele Konflikte am selben Tag entstehen, planen Sie den Tag erneut mit „Ein Fahrzeug pro Fahrer/Tag" oder verschieben Sie ganze Blöcke statt einzelner Fahrten.',
    'Blöcke mit unterschiedlichen Fahrzeugen dürfen nicht zusammengeführt werden, um diese Prüfung zu umgehen.',
  ],
  'Fahrer-Überschneidung': [
    'Ein Fahrer ist im gleichen Zeitraum mehrfach verplant. Prüfen Sie die betroffenen Fahrten in der Monatsplanung.',
    'Stellen Sie sicher, dass der Fahrer nicht zwei überlappenden Fahrten oder Blöcken zugewiesen ist.',
    'Kehren Sie zur Monatsplanung zurück und korrigieren Sie die Zuweisung bevor Sie die Finalisierung durchführen.',
  ],
  'Fahrzeug-Überschneidungen': [
    'Dieses Fahrzeug ist im gleichen Zeitraum mehrfach verplant. Bitte prüfen Sie die betroffenen Fahrten im Fahrtenbuch.',
    'Ein Fahrerwechsel löst diesen Konflikt meistens nicht, weil das Fahrzeug selbst zeitlich überschneidet.',
    'Prüfen Sie, ob eine Fahrt doppelt importiert wurde, falsche Zeiten hat oder eigentlich storniert ist.',
    'Falls die Quelldaten falsch sind, korrigieren Sie die Fahrtenbuch-Datei und importieren Sie sie erneut.',
  ],
  'Max. 3 Schichten pro Fahrer/Tag': [
    'Der Stundennachweis darf pro Fahrer und Tag maximal 3 Schichten ausweisen.',
    'Prüfen Sie, ob einzelne Blöcke auf andere Fahrer verteilt werden können.',
    'Die Komprimierung betrifft nur die Anzeige und den Export — das Fahrtenbuch darf dadurch nicht verändert werden.',
    'Erstellen Sie keine künstlichen Fahrten und ändern Sie keine Fahrtenbuch-Daten für diesen Zweck.',
  ],
  'Alle Fahrten haben Fahrerzuordnung': [
    'Öffnen Sie die Monatsplanung erneut und wenden Sie die Planung vollständig an, damit alle Fahrten einem Fahrer zugewiesen sind.',
  ],
  'Alle Fahrten haben Block-ID': [
    'Die Planung muss erneut angewendet werden, damit alle Fahrten mit einem Block verknüpft sind.',
    'Falls einzelne Fahrten nachträglich hinzugefügt wurden, müssen sie ebenfalls in einem gültigen Block enthalten sein.',
  ],
  'Alle Fahrten haben Zeitangaben': [
    'Prüfen Sie den Fahrtenbuch-Import. Fahrten ohne Start- oder Endzeit können nicht finalisiert werden.',
    'Fahrten ohne vollständige Zeitangaben müssen in der Quelldatei korrigiert und erneut importiert werden.',
  ],
  'Stundennachweis Preview generierbar': [
    'Für einen oder mehrere Fahrer konnten keine Stundennachweis-Daten ermittelt werden.',
    'Stellen Sie sicher, dass alle Fahrten korrekt einem Block zugewiesen sind und gültige Zeitangaben haben.',
    'Führen Sie danach die Prüfung erneut aus.',
  ],
  'Stundennachweis Abdeckung': [
    'Einige Fahrten aus dem Fahrtenbuch sind in keinem Stundennachweis-Zeitraum enthalten.',
    'Ursache: Diese Fahrten haben keine Block-Zuordnung (assignment_block_id fehlt) oder ihr Block hat keine gültigen Zeitangaben.',
    'Kehren Sie zur Monatsplanung zurück und stellen Sie sicher, dass alle Fahrten korrekt einem Schichtblock zugewiesen sind.',
    'Nach einem erneuten Anwenden der Planung alle Checks erneut ausführen.',
  ],
};

function minsToHHMM(m: number): string {
  if (m <= 0) return '0:00';
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

function fmtDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

// ── Main component ─────────────────────────────────────────────────────────

export default function FinalizePlanningModal({ run, companyId, userId, onClose, onFinalized }: Props) {
  const [step, setStep] = useState<'idle' | 'checking' | 'ready' | 'finalizing' | 'done' | 'blocked'>('idle');
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [snapshot, setSnapshot] = useState<FinalSnapshot | null>(null);
  const [error, setError] = useState('');
  const [finalizationId, setFinalizationId] = useState('');
  const [finalizedAt, setFinalizedAt] = useState('');
  const [xlsxDownloading, setXlsxDownloading] = useState(false);
  const [xlsxDone, setXlsxDone] = useState(false);
  const [downloadingStundenDriverId, setDownloadingStundenDriverId] = useState<string | null>(null);
  const [expandedSuggestions, setExpandedSuggestions] = useState<Set<number>>(new Set());
  const [showStundenPreview, setShowStundenPreview] = useState(false);

  function toggleSuggestions(index: number): void {
    setExpandedSuggestions(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  // ── Pre-flight checks + snapshot build ──────────────────────────────────

  const runChecks = useCallback(async () => {
    setStep('checking');
    setError('');
    setChecks([]);
    setSnapshot(null);

    try {
      // Resolve the vehicle switch buffer from the applied run settings.
      // Falls back to the default if not stored (older runs).
      const settingsJson = run.settings_json ?? {};
      const storedBuffer = settingsJson['vehicle_switch_buffer_minutes'];
      const MIN_CAR_SWITCH_GAP_MINUTES: number =
        (typeof storedBuffer === 'number' && storedBuffer >= 0)
          ? storedBuffer
          : DEFAULT_CAR_SWITCH_GAP_MINUTES;

      const results: CheckResult[] = [];

      // 1. Confirm planning run is still 'applied'
      const { data: runRow, error: runErr } = await supabase
        .from('company_planning_runs')
        .select('id, status, apply_summary_json')
        .eq('id', run.id)
        .single();

      if (runErr || !runRow) {
        results.push({ label: 'Planning Run vorhanden', ok: false, detail: runErr ? formatError(runErr) : 'Nicht gefunden' });
        setChecks(results);
        setStep('blocked');
        return;
      }
      results.push({
        label: 'Planning Run Status',
        ok: runRow.status === 'applied',
        detail: runRow.status === 'applied' ? 'applied' : `Erwartet "applied", gefunden "${runRow.status}"`,
      });

      // 2. Load all trips for this run (batched)
      const BATCH = 1000;
      const allTrips: Array<{
        id: string;
        trip_date: string;
        start_time: string | null;
        end_time: string | null;
        assigned_driver_id: string | null;
        assigned_driver_name: string | null;
        assignment_block_id: string | null;
        car_identifier: string | null;
        is_canceled: boolean;
        raw_data_json: Record<string, unknown> | null;
      }> = [];

      let offset = 0;
      while (true) {
        const { data, error: tErr } = await supabase
          .from('fahrtenbuch_trips')
          .select('id, trip_date, start_time, end_time, assigned_driver_id, assigned_driver_name, assignment_block_id, car_identifier, is_canceled, raw_data_json')
          .eq('company_id', companyId)
          .eq('assignment_planning_run_id', run.id)
          .order('id', { ascending: true })
          .range(offset, offset + BATCH - 1);
        if (tErr) throw new Error(`Datenbankfehler beim Laden der Fahrten:\n${formatError(tErr)}`);
        allTrips.push(...(data ?? []));
        if ((data?.length ?? 0) < BATCH) break;
        offset += BATCH;
      }

      const nonCanceled = allTrips.filter(t => !t.is_canceled);
      const expectedUpdated = (runRow.apply_summary_json as Record<string, unknown> | null)?.updated_trips;
      const expectedCount = typeof expectedUpdated === 'number' ? expectedUpdated : null;

      // 3. Trip count
      results.push({
        label: 'Fahrten-Anzahl',
        ok: expectedCount === null || nonCanceled.length === expectedCount,
        detail: expectedCount !== null
          ? `${nonCanceled.length} von ${expectedCount} erwartet`
          : `${nonCanceled.length} Fahrten`,
      });

      // 4. No duplicate trip IDs
      const idSet = new Set<string>();
      const dups: string[] = [];
      for (const t of allTrips) {
        if (idSet.has(t.id)) dups.push(t.id);
        idSet.add(t.id);
      }
      results.push({
        label: 'Keine doppelten Trip-IDs',
        ok: dups.length === 0,
        detail: dups.length === 0 ? 'OK' : `${dups.length} Duplikate`,
      });

      // 5. No trips without driver
      const missingDriver = nonCanceled.filter(t => !t.assigned_driver_id).length;
      results.push({
        label: 'Alle Fahrten haben Fahrerzuordnung',
        ok: missingDriver === 0,
        detail: missingDriver === 0 ? 'OK' : `${missingDriver} ohne Fahrer`,
      });

      // 6. No trips without block ID
      const missingBlock = nonCanceled.filter(t => !t.assignment_block_id).length;
      results.push({
        label: 'Alle Fahrten haben Block-ID',
        ok: missingBlock === 0,
        detail: missingBlock === 0 ? 'OK' : `${missingBlock} ohne Block-ID`,
      });

      // 7. No trips without times
      const missingTime = nonCanceled.filter(t => !t.start_time || !t.end_time).length;
      results.push({
        label: 'Alle Fahrten haben Zeitangaben',
        ok: missingTime === 0,
        detail: missingTime === 0 ? 'OK' : `${missingTime} ohne Start/End-Zeit`,
      });

      // 8. Max-3-Schichten-Regel per driver per day (compressed view)
      const MAX_SHIFT = 270; // 4:30
      const MAX_DAY = 510;   // 8:30
      function toMins(t: string): number {
        const [h, m] = t.split(':').map(Number);
        return h * 60 + m;
      }
      function segDur(s: string, e: string): number {
        const f = toMins(s), t2 = toMins(e);
        return t2 >= f ? t2 - f : 1440 - f + t2;
      }
      type DayKey = string; // "driverId_date"
      const dayShifts = new Map<DayKey, Array<{ s: number; e: number }>>();
      for (const t of nonCanceled) {
        if (!t.start_time || !t.end_time || !t.assigned_driver_id) continue;
        const key: DayKey = `${t.assigned_driver_id}_${t.trip_date}`;
        const arr = dayShifts.get(key) ?? [];
        arr.push({ s: toMins(t.start_time.slice(0, 5)), e: toMins(t.end_time.slice(0, 5)) });
        dayShifts.set(key, arr);
      }
      let compressedDayCount = 0;
      let max3HardViolations = 0;
      const max3ViolationDetails: string[] = [];
      for (const [dayKey, windows] of dayShifts) {
        windows.sort((a, b) => a.s - b.s);
        // Step 1: merge overlapping windows
        const merged: Array<{ s: number; e: number }> = [];
        for (const w of windows) {
          const last = merged[merged.length - 1];
          if (!last || w.s > last.e) merged.push({ ...w });
          else last.e = Math.max(last.e, w.e);
        }
        // Step 2: smallest-gap compression — keep merging the closest adjacent pair until ≤3
        const hadMore = merged.length > 3;
        while (merged.length > 3) {
          let minGap = Infinity, minIdx = 0;
          for (let i = 0; i < merged.length - 1; i++) {
            const gap = merged[i + 1].s - merged[i].e;
            if (gap < minGap) { minGap = gap; minIdx = i; }
          }
          merged[minIdx] = { s: merged[minIdx].s, e: Math.max(merged[minIdx].e, merged[minIdx + 1].e) };
          merged.splice(minIdx + 1, 1);
        }
        if (hadMore) compressedDayCount++;
        // After compression merged.length is always ≤3; flag only if somehow still above (safety net)
        if (merged.length > 3) {
          max3HardViolations++;
          const [dId, date] = dayKey.split('_');
          const dName = nonCanceled.find(t => t.assigned_driver_id === dId)?.assigned_driver_name ?? dId;
          max3ViolationDetails.push(`${dName} · ${date} · ${merged.length} Schichten`);
        }
      }
      results.push({
        label: 'Max. 3 Schichten pro Fahrer/Tag',
        ok: max3HardViolations === 0,
        detail: max3HardViolations === 0
          ? compressedDayCount > 0
            ? `OK · ${compressedDayCount} Fahrer-Tag${compressedDayCount === 1 ? '' : 'e'} auf maximal 3 Schichten komprimiert`
            : 'OK'
          : `${max3HardViolations} Fahrer-Tage konnten nicht auf ≤3 Schichten komprimiert werden:\n${max3ViolationDetails.slice(0, 10).join('\n')}${max3ViolationDetails.length > 10 ? `\n… und ${max3ViolationDetails.length - 10} weitere` : ''}`,
      });

      // ── Inner helpers: full-timestamp math (avoids HH:MM wrap-around) ────
      function parseTsMs(date: string, time: string): number {
        return new Date(`${date}T${time.slice(0, 5)}:00`).getTime();
      }
      function localDateStr(ms: number): string {
        const d = new Date(ms);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
      function overlapMs(sMs: number, eMs: number, rS: number, rE: number): number {
        const lo = Math.max(sMs, rS), hi = Math.min(eMs, rE);
        return lo < hi ? hi - lo : 0;
      }
      function computeBlockNight(sMs: number, eMs: number): { nacht: number; n04: number } {
        const sDay = Math.floor(sMs / 86400000) * 86400000;
        const eDay = Math.floor((eMs - 1) / 86400000) * 86400000;
        let nacht = 0, n04 = 0;
        for (let day = sDay; day <= eDay; day += 86400000) {
          // 04:00–06:00 and 23:00–00:00 are Nachtarbeit (mutually exclusive with 0–4)
          nacht += Math.floor(overlapMs(sMs, eMs, day + 4 * 3600000, day + 6 * 3600000) / 60000);
          nacht += Math.floor(overlapMs(sMs, eMs, day + 23 * 3600000, day + 24 * 3600000) / 60000);
          // 00:00–04:00 is Nacht 0–4 exclusively
          n04   += Math.floor(overlapMs(sMs, eMs, day, day + 4 * 3600000) / 60000);
        }
        return { nacht, n04 };
      }
      function msToHHMM(ms: number): string {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }
      function minsToDecStr(m: number): string {
        return (Math.round((m / 60) * 100) / 100).toFixed(2).replace('.', ',');
      }

      // 9. Fahrzeugwechsel zu kurz — same driver, different car, 0 ≤ gap < 30 min
      // Uses resolveActualRideWindow for correct midnight/cross-day timestamps.
      type TripForSwitch = {
        trip_date: string;
        start_time: string | null;
        end_time: string | null;
        assigned_driver_id: string;
        assigned_driver_name: string | null;
        car_identifier: string;
        raw_data_json: Record<string, unknown> | null;
      };
      const switchViolations: string[] = [];
      const byDriver = new Map<string, TripForSwitch[]>();
      for (const t of nonCanceled) {
        if (!t.assigned_driver_id || !t.car_identifier || !t.start_time || !t.end_time) continue;
        const key = t.assigned_driver_id;
        if (!byDriver.has(key)) byDriver.set(key, []);
        byDriver.get(key)!.push(t as TripForSwitch);
      }
      for (const trips of byDriver.values()) {
        trips.sort((a, b) => {
          const aRw = resolveActualRideWindow(a);
          const bRw = resolveActualRideWindow(b);
          return aRw.actualStartMs - bRw.actualStartMs;
        });
        for (let i = 1; i < trips.length; i++) {
          const prev = trips[i - 1];
          const curr = trips[i];
          if (prev.car_identifier === curr.car_identifier) continue;
          const prevRw = resolveActualRideWindow(prev);
          const currRw = resolveActualRideWindow(curr);
          const gapMs = currRw.actualStartMs - prevRw.actualEndMs;
          const gapMinutes = gapMs / 60000;
          if (gapMinutes < 0 || gapMinutes >= MIN_CAR_SWITCH_GAP_MINUTES) continue;
          const driverName = prev.assigned_driver_name ?? prev.assigned_driver_id;
          switchViolations.push(
            `${driverName} · ${fmtAbsDate(prevRw.actualEndMs)} · ${prev.car_identifier} → ${curr.car_identifier} · Ende ${fmtAbsTime(prevRw.actualEndMs)} → Start ${fmtAbsTime(currRw.actualStartMs)} · Abstand ${gapMinutes.toFixed(1).replace('.', ',')} Min`
          );
        }
      }
      results.push({
        label: 'Fahrzeugwechsel zu kurz',
        ok: switchViolations.length === 0,
        detail: switchViolations.length === 0 ? 'OK' : switchViolations.join('\n'),
      });

      // 10. Fahrer-Überschneidungen — same assigned driver, overlapping trips (negative gap)
      const driverOverlapViolations: string[] = [];
      for (const driverTrips of byDriver.values()) {
        for (let i = 1; i < driverTrips.length; i++) {
          const prev = driverTrips[i - 1];
          const curr = driverTrips[i];
          const prevRw = resolveActualRideWindow(prev);
          const currRw = resolveActualRideWindow(curr);
          const gapMs = currRw.actualStartMs - prevRw.actualEndMs;
          if (gapMs < 0) {
            const overlapMin = Math.round(-gapMs / 60000);
            if (overlapMin <= 0) continue;
            const driverName = prev.assigned_driver_name ?? prev.assigned_driver_id;
            const prevCar = prev.car_identifier ?? '?';
            const currCar = curr.car_identifier ?? '?';
            driverOverlapViolations.push(
              `${driverName} · ${prevCar} ${fmtAbsDateTime(prevRw.actualStartMs)}–${fmtAbsTime(prevRw.actualEndMs)} ↔ ` +
              `${currCar} ${fmtAbsDateTime(currRw.actualStartMs)}–${fmtAbsTime(currRw.actualEndMs)} · Überschneidung ${overlapMin} Min`
            );
          }
        }
      }
      results.push({
        label: 'Fahrer-Überschneidung',
        ok: driverOverlapViolations.length === 0,
        detail: driverOverlapViolations.length === 0 ? 'OK' : driverOverlapViolations.join('\n'),
      });

      // 11. Fahrzeug-Überschneidungen — same car, different drivers, overlapping times
      const overlapViolations: string[] = [];
      const byCar = new Map<string, Array<{
        trip_date: string; start_time: string | null; end_time: string | null;
        assigned_driver_id: string; assigned_driver_name: string | null;
        raw_data_json: Record<string, unknown> | null;
      }>>();
      for (const t of nonCanceled) {
        if (!t.car_identifier || !t.start_time || !t.end_time || !t.assigned_driver_id) continue;
        const arr = byCar.get(t.car_identifier) ?? [];
        arr.push({ trip_date: t.trip_date, start_time: t.start_time, end_time: t.end_time, assigned_driver_id: t.assigned_driver_id, assigned_driver_name: t.assigned_driver_name, raw_data_json: t.raw_data_json });
        byCar.set(t.car_identifier, arr);
      }
      for (const [carId, carTrips] of byCar) {
        carTrips.sort((a, b) => {
          const aRw = resolveActualRideWindow(a);
          const bRw = resolveActualRideWindow(b);
          return aRw.actualStartMs - bRw.actualStartMs;
        });
        for (let i = 1; i < carTrips.length; i++) {
          const prev = carTrips[i - 1];
          const curr = carTrips[i];
          if (prev.assigned_driver_id === curr.assigned_driver_id) continue;
          const prevRw = resolveActualRideWindow(prev);
          const currRw = resolveActualRideWindow(curr);
          if (currRw.actualStartMs < prevRw.actualEndMs) {
            const pd = prev.assigned_driver_name ?? prev.assigned_driver_id;
            const cd = curr.assigned_driver_name ?? curr.assigned_driver_id;
            const overlapMin = Math.round((prevRw.actualEndMs - currRw.actualStartMs) / 60000);
            overlapViolations.push(
              `${carId} · ${fmtAbsDate(prevRw.actualStartMs)} · ${pd} ${fmtAbsTime(prevRw.actualStartMs)}–${fmtAbsTime(prevRw.actualEndMs)} ↔ ${cd} ${fmtAbsTime(currRw.actualStartMs)}–${fmtAbsTime(currRw.actualEndMs)} · Überschneidung ${overlapMin} Min`
            );
          }
        }
      }
      results.push({
        label: 'Fahrzeug-Überschneidungen',
        ok: overlapViolations.length === 0,
        detail: overlapViolations.length === 0 ? 'OK' : overlapViolations.join('\n'),
      });

      // 11. Build blocks from trips (time-interval based — no assignment_block_id dependency).
      // Group every non-canceled trip by (driver_id, trip_date), sort by start,
      // merge overlapping/touching intervals so every trip is covered.
      type FinBlock = {
        block_id: string; driver_id: string; driver_name: string;
        service_date: string;
        block_start_ms: number; block_end_ms: number;
        duration_minutes: number; nachtarbeit: number; nacht04: number;
      };

      // Collect absolute intervals per (driverId, serviceDate)
      interface FinInterval {
        sMs: number; eMs: number;
        driverId: string; driverName: string; serviceDate: string;
      }
      const finIntervals: FinInterval[] = [];
      for (const t of nonCanceled) {
        if (!t.start_time || !t.end_time || !t.assigned_driver_id) continue;
        const rw = resolveActualRideWindow({
          trip_date: t.trip_date,
          start_time: t.start_time,
          end_time: t.end_time,
          raw_data_json: t.raw_data_json,
        });
        const sMs = rw.actualStartMs > 0 ? rw.actualStartMs : parseTsMs(t.trip_date, t.start_time);
        let eMs = rw.actualEndMs > 0 ? rw.actualEndMs : parseTsMs(t.trip_date, t.end_time);
        if (eMs <= sMs) eMs += 86400000;
        finIntervals.push({
          sMs, eMs,
          driverId: t.assigned_driver_id,
          driverName: t.assigned_driver_name ?? t.assigned_driver_id,
          serviceDate: t.trip_date,
        });
      }

      // Group by (driverId, serviceDate), sort, merge
      const finGroupMap = new Map<string, FinInterval[]>();
      for (const iv of finIntervals) {
        const key = `${iv.driverId}|${iv.serviceDate}`;
        const arr = finGroupMap.get(key) ?? [];
        arr.push(iv);
        finGroupMap.set(key, arr);
      }

      const finBlocks: FinBlock[] = [];
      let finBlockSeq = 0;
      for (const [, ivs] of finGroupMap) {
        ivs.sort((a, b) => a.sMs - b.sMs);
        // Merge overlapping/touching
        interface Span { sMs: number; eMs: number; driverId: string; driverName: string; serviceDate: string; }
        const spans: Span[] = [];
        for (const iv of ivs) {
          const last = spans[spans.length - 1];
          if (!last || iv.sMs > last.eMs) {
            spans.push({ sMs: iv.sMs, eMs: iv.eMs, driverId: iv.driverId, driverName: iv.driverName, serviceDate: iv.serviceDate });
          } else {
            last.eMs = Math.max(last.eMs, iv.eMs);
          }
        }
        for (const span of spans) {
          if (span.eMs <= span.sMs) continue;
          const night = computeBlockNight(span.sMs, span.eMs);
          finBlocks.push({
            block_id: `fin_${finBlockSeq++}`,
            driver_id: span.driverId, driver_name: span.driverName,
            service_date: span.serviceDate,
            block_start_ms: span.sMs, block_end_ms: span.eMs,
            duration_minutes: Math.floor((span.eMs - span.sMs) / 60000),
            nachtarbeit: night.nacht, nacht04: night.n04,
          });
        }
      }

      // ── Coverage validation: every non-canceled trip must be covered by its driver's blocks ──
      // Two minutes tolerance for display rounding (PDFs show HH:MM, trips have seconds).
      const COVERAGE_TOLERANCE_MS = 2 * 60 * 1000;
      const blocksByDriverForCoverage = new Map<string, { sMs: number; eMs: number }[]>();
      for (const b of finBlocks) {
        const arr = blocksByDriverForCoverage.get(b.driver_id) ?? [];
        arr.push({ sMs: b.block_start_ms, eMs: b.block_end_ms });
        blocksByDriverForCoverage.set(b.driver_id, arr);
      }
      interface UncoveredEntry { tripId: string; driverName: string; date: string; vehicle: string; start: string; end: string; }
      const uncoveredTrips: UncoveredEntry[] = [];
      for (const t of nonCanceled) {
        if (!t.start_time || !t.end_time || !t.assigned_driver_id) continue;
        const rw = resolveActualRideWindow({
          trip_date: t.trip_date, start_time: t.start_time, end_time: t.end_time, raw_data_json: t.raw_data_json,
        });
        const tSMs = rw.actualStartMs > 0 ? rw.actualStartMs : parseTsMs(t.trip_date, t.start_time);
        let tEMs = rw.actualEndMs > 0 ? rw.actualEndMs : parseTsMs(t.trip_date, t.end_time);
        if (tEMs <= tSMs) tEMs += 86400000;
        const driverBlocks = blocksByDriverForCoverage.get(t.assigned_driver_id) ?? [];
        const isCovered = driverBlocks.some(b =>
          b.sMs <= tSMs + COVERAGE_TOLERANCE_MS &&
          b.eMs >= tEMs - COVERAGE_TOLERANCE_MS,
        );
        if (!isCovered) {
          uncoveredTrips.push({
            tripId: t.id,
            driverName: t.assigned_driver_name ?? t.assigned_driver_id,
            date: t.trip_date,
            vehicle: t.car_identifier ?? '—',
            start: msToHHMM(tSMs),
            end: msToHHMM(tEMs),
          });
        }
      }
      if (uncoveredTrips.length > 0) {
        console.error('[FinalizePlanningModal] Uncovered trips:', uncoveredTrips);
      }
      const coverageLines: string[] = [];
      if (uncoveredTrips.length > 0) {
        coverageLines.push(
          `${uncoveredTrips.length} Fahrt${uncoveredTrips.length === 1 ? '' : 'en'} aus dem Fahrtenbuch ` +
          `${uncoveredTrips.length === 1 ? 'ist' : 'sind'} in keinem Stundennachweis-Zeitraum enthalten:`,
        );
        for (const u of uncoveredTrips.slice(0, 20)) {
          coverageLines.push(`${u.driverName} · ${u.date} · ${u.vehicle} · ${u.start}–${u.end}`);
        }
        if (uncoveredTrips.length > 20) {
          coverageLines.push(`… und ${uncoveredTrips.length - 20} weitere Fahrten`);
        }
      }
      results.push({
        label: 'Stundennachweis Abdeckung',
        ok: uncoveredTrips.length === 0,
        detail: uncoveredTrips.length === 0
          ? `OK · alle ${nonCanceled.length} Fahrten durch Stundennachweis-Blöcke abgedeckt`
          : coverageLines.join('\n'),
      });
      const driverMap = new Map<string, DriverSummary & { blockSet: Set<string> }>();
      for (const t of nonCanceled) {
        const name = t.assigned_driver_name ?? '(unbekannt)';
        const key = t.assigned_driver_id ?? name;
        if (!driverMap.has(key)) {
          driverMap.set(key, { id: key, name, trips: 0, blocks: 0, blockSet: new Set(), workMinutes: 0, nightMinutes: 0, sundayMinutes: 0, expectedBrutto: null });
        }
        const d = driverMap.get(key)!;
        d.trips++;
        if (t.assignment_block_id) d.blockSet.add(t.assignment_block_id);
      }
      // Accumulate block-level time data (uses ms arithmetic, handles overnight correctly)
      for (const b of finBlocks) {
        const d = driverMap.get(b.driver_id);
        if (!d) continue;
        d.workMinutes  += b.duration_minutes;
        d.nightMinutes += b.nachtarbeit;
        const [by, bm, bd] = b.service_date.split('-').map(Number);
        if (new Date(by, bm - 1, bd).getDay() === 0) d.sundayMinutes += b.duration_minutes;
      }

      // Build per-driver per-day PDF rows (used for Stundennachweis download in done state)
      const driverDateBlocks = new Map<string, Map<string, FinBlock[]>>();
      for (const b of finBlocks) {
        if (!driverDateBlocks.has(b.driver_id)) driverDateBlocks.set(b.driver_id, new Map());
        const dateMap = driverDateBlocks.get(b.driver_id)!;
        const arr = dateMap.get(b.service_date) ?? [];
        arr.push(b);
        dateMap.set(b.service_date, arr);
      }
      const WDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
      const driverPdfMap = new Map<string, { rows: PdfDayRow[]; totals: PdfTotals }>();
      for (const [driverId, dateMap] of driverDateBlocks) {
        const totals: PdfTotals = { grundlohn: 0, nachtarbeit: 0, nacht04: 0, sonntag: 0, feiertag: 0, weihnachten: 0 };
        const rows: PdfDayRow[] = [];
        for (const [serviceDate, dayBlocks] of dateMap) {
          dayBlocks.sort((a, b2) => a.block_start_ms - b2.block_start_ms);
          // Compress to max 3 blocks per day (same rule as Stundennachweis Preview)
          while (dayBlocks.length > 3) {
            let bestIdx = -1, bestGap = Infinity;
            for (let i = 0; i < dayBlocks.length - 1; i++) {
              const g = dayBlocks[i + 1].block_start_ms - dayBlocks[i].block_end_ms;
              if (g < bestGap) { bestGap = g; bestIdx = i; }
            }
            if (bestIdx === -1) break;
            const a2 = dayBlocks[bestIdx], b2 = dayBlocks[bestIdx + 1];
            dayBlocks.splice(bestIdx, 2, {
              block_id: `${a2.block_id}+${b2.block_id}`,
              driver_id: a2.driver_id, driver_name: a2.driver_name,
              service_date: a2.service_date,
              block_start_ms: a2.block_start_ms,
              block_end_ms: Math.max(a2.block_end_ms, b2.block_end_ms),
              duration_minutes: a2.duration_minutes + b2.duration_minutes,
              nachtarbeit: a2.nachtarbeit + b2.nachtarbeit,
              nacht04: a2.nacht04 + b2.nacht04,
            });
          }
          const [sy, sm, sd] = serviceDate.split('-').map(Number);
          const date = new Date(sy, sm - 1, sd);
          const dow = date.getDay();
          const isSun = dow === 0;
          const dayGrund = dayBlocks.reduce((s, b2) => s + b2.duration_minutes, 0);
          const dayNacht = dayBlocks.reduce((s, b2) => s + b2.nachtarbeit, 0);
          const dayN04  = dayBlocks.reduce((s, b2) => s + b2.nacht04, 0);
          const daySon  = isSun ? dayGrund : 0;
          rows.push({
            date, weekday: WDAY_SHORT[dow],
            isSat: dow === 6, isSun, isHol: false,
            von1: dayBlocks[0] ? msToHHMM(dayBlocks[0].block_start_ms) : '',
            bis1: dayBlocks[0] ? msToHHMM(dayBlocks[0].block_end_ms)   : '',
            von2: dayBlocks[1] ? msToHHMM(dayBlocks[1].block_start_ms) : '',
            bis2: dayBlocks[1] ? msToHHMM(dayBlocks[1].block_end_ms)   : '',
            von3: dayBlocks[2] ? msToHHMM(dayBlocks[2].block_start_ms) : '',
            bis3: dayBlocks[2] ? msToHHMM(dayBlocks[2].block_end_ms)   : '',
            grundlohn:     minsToDecStr(dayGrund),
            nachtarbeit:   minsToDecStr(dayNacht),
            nachtarbeit04: minsToDecStr(dayN04),
            sonntag:       minsToDecStr(daySon),
            feiertag:      '0,00',
            weihnachten:   '0,00',
          });
          totals.grundlohn   += dayGrund;
          totals.nachtarbeit += dayNacht;
          totals.nacht04     += dayN04;
          totals.sonntag     += daySon;
        }
        rows.sort((a, b2) => a.date.getTime() - b2.date.getTime());
        driverPdfMap.set(driverId, { rows, totals });
      }

      const drivers: DriverSummary[] = [...driverMap.values()].map(d => ({
        id: d.id,
        name: d.name,
        trips: d.trips,
        blocks: d.blockSet.size,
        workMinutes: d.workMinutes,
        nightMinutes: d.nightMinutes,
        sundayMinutes: d.sundayMinutes,
        expectedBrutto: d.expectedBrutto,
        pdfData: driverPdfMap.get(d.id),
      })).sort((a, b) => b.trips - a.trips);

      // Check: Stundennachweis Preview generierbar for all assigned drivers
      const snMissing = drivers.filter(d => !d.pdfData || d.pdfData.rows.length === 0).map(d => d.name);
      results.push({
        label: 'Stundennachweis Preview generierbar',
        ok: snMissing.length === 0,
        detail: snMissing.length === 0
          ? `OK · ${drivers.length} Fahrer`
          : `Fahrer ohne Stundennachweis-Daten: ${snMissing.join(', ')}`,
      });

      const snap: FinalSnapshot = {
        totalTrips: nonCanceled.length,
        driverCount: drivers.length,
        drivers,
        // Store aggregate data in DB; exclude pdfData (large, in-session only)
        driverSummaryJson: {
          drivers: drivers.map(d => ({
            id: d.id, name: d.name, trips: d.trips, blocks: d.blocks,
            workMinutes: d.workMinutes, nightMinutes: d.nightMinutes,
            sundayMinutes: d.sundayMinutes, expectedBrutto: d.expectedBrutto,
          })),
        },
      };

      setChecks(results);
      setSnapshot(snap);

      const allOk = results.every(r => r.ok);
      setStep(allOk ? 'ready' : 'blocked');
    } catch (e) {
      console.error('Finalization consistency check failed', e);
      setError(formatError(e));
      setStep('blocked');
    }
  }, [run, companyId]);

  useEffect(() => { void runChecks(); }, [runChecks]);

  // ── Finalization ───────────────────────────────────────────────────────

  const handleFinalize = useCallback(async () => {
    if (!snapshot) return;
    setStep('finalizing');
    setError('');
    try {
      // 1. Insert finalization record
      const { data: finRow, error: finErr } = await supabase
        .from('planning_finalizations')
        .insert({
          planning_run_id: run.id,
          company_id: companyId,
          finalized_by: userId ?? null,
          trip_count: snapshot.totalTrips,
          driver_count: snapshot.driverCount,
          driver_summary_json: snapshot.driverSummaryJson,
          is_stale: false,
          document_status: 'ready',
        })
        .select('id, finalized_at')
        .single();

      if (finErr || !finRow) throw new Error(finErr ? `Datenbankfehler:\n${formatError(finErr)}` : 'Finalisierung konnte nicht gespeichert werden');

      setFinalizationId(finRow.id as string);
      setFinalizedAt(finRow.finalized_at as string);

      setStep('done');
      onFinalized(finRow.id as string);
    } catch (e) {
      console.error('Finalization failed', e);
      setError(formatError(e));
      setStep('ready');
    }
  }, [snapshot, run, companyId, userId, onFinalized]);

  // ── Re-download Fahrtenbuch ──────────────────────────────────────────

  const handleRedownload = async () => {
    setXlsxDownloading(true);
    try {
      await exportAppliedRunXlsx(run, 'original');
      setXlsxDone(true);
    } finally {
      setXlsxDownloading(false);
    }
  };

  // ── Download per-driver Stundennachweis PDF from finalized snapshot ──

  function handleDownloadStunden(driver: DriverSummary): void {
    if (!driver.pdfData) return;
    setDownloadingStundenDriverId(driver.id);
    try {
      const safeName = driver.name.replace(/[/\\:*?"<>|]/g, '_');
      exportStundennachweisAsPdf(
        {
          driver: { name: driver.name },
          month: run.month,
          year: run.year,
          rows: driver.pdfData.rows,
          totals: driver.pdfData.totals,
          warnings: [`Finalisierter Stundennachweis · ${MONTHS_DE[run.month - 1]} ${run.year}`],
        },
        `Stundennachweis_${safeName}_${MONTHS_DE[run.month - 1]}_${run.year}.pdf`,
      );
    } finally {
      setDownloadingStundenDriverId(null);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────

  const allChecksOk = checks.length > 0 && checks.every(c => c.ok);
  const criticalFails = checks.filter(c => !c.ok);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,0.75)' }}
      onClick={step === 'finalizing' || step === 'done' ? undefined : onClose}
    >
      <div
        className="rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
          <div>
            <h3 className="text-base font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <Sparkles size={16} style={{ color: '#f59e0b' }} />
              Finale Dokumente erstellen
            </h3>
            <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
              {MONTHS_DE[run.month - 1]} {run.year} · {run.file_name || run.id.slice(0, 8)}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={step === 'finalizing'}
            className="p-1 rounded disabled:opacity-40"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">

          {/* Checks */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                Konsistenzprüfung
              </span>
              {step === 'checking' && <Loader2 size={12} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />}
            </div>
            <div className="space-y-1.5">
              {step === 'checking' && checks.length === 0 && (
                <div className="text-sm py-2" style={{ color: 'var(--text-tertiary)' }}>Prüfung läuft…</div>
              )}
              {checks.map((c, i) => (
                <div key={i} className="flex items-start gap-2.5 text-sm">
                  {c.ok
                    ? <CheckCircle2 size={15} className="shrink-0 mt-0.5" style={{ color: '#22c55e' }} />
                    : <AlertTriangle size={15} className="shrink-0 mt-0.5" style={{ color: '#dc2626' }} />
                  }
                  <div className="min-w-0 flex-1">
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{c.label}</span>
                    {!c.ok && (
                      <div className="mt-0.5 space-y-0.5">
                        {c.detail.split('\n').map((line, li) => (
                          <div key={li} className="text-xs" style={{ color: '#dc2626' }}>{line}</div>
                        ))}
                      </div>
                    )}
                    {c.ok && c.detail !== 'OK' && (
                      <span className="ml-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>{c.detail}</span>
                    )}
                    {/* Suggestions for failed checks */}
                    {!c.ok && CHECK_SUGGESTIONS[c.label] && (
                      <div className="mt-1.5">
                        <button
                          className="inline-flex items-center gap-1 text-xs font-semibold transition-colors hover:opacity-80"
                          style={{ color: '#2563eb' }}
                          onClick={() => toggleSuggestions(i)}
                        >
                          {expandedSuggestions.has(i)
                            ? <><ChevronUp size={11} /> Vorschläge ausblenden</>
                            : <><ChevronDown size={11} /> Vorschläge anzeigen</>
                          }
                        </button>
                        {expandedSuggestions.has(i) && (
                          <ul className="mt-1.5 space-y-1 pl-3 border-l-2" style={{ borderColor: 'rgba(37,99,235,0.3)' }}>
                            {CHECK_SUGGESTIONS[c.label].map((s, si) => (
                              <li key={si} className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                <span className="font-semibold" style={{ color: '#2563eb' }}>Vorschlag {si + 1}:</span>{' '}{s}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Blocked banner */}
          {step === 'blocked' && criticalFails.length > 0 && (
            <div className="px-4 py-3 rounded-lg text-sm" style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.35)', color: '#991b1b' }}>
              <div className="font-bold flex items-center gap-2 mb-1">
                <Lock size={14} />
                {criticalFails.some(f => f.label === 'Stundennachweis Abdeckung')
                  ? 'Stundennachweis unvollständig — Finalisierung blockiert'
                  : 'Finalisierung blockiert'}
              </div>
              <p className="text-xs">
                {criticalFails.length} Prüfung{criticalFails.length > 1 ? 'en haben' : ' hat'} Probleme gefunden.
              </p>
              {criticalFails.some(f => f.label === 'Stundennachweis Abdeckung') && (
                <p className="text-xs mt-1" style={{ color: '#991b1b', fontWeight: 600 }}>
                  Einige Fahrten aus dem Fahrtenbuch sind in keinem Stundennachweis-Zeitraum enthalten. Die Finale Dokumente können erst erstellt werden, wenn alle Fahrten vollständig abgedeckt sind.
                </p>
              )}
              <p className="text-xs mt-1.5" style={{ color: '#7f1d1d' }}>
                {criticalFails.some(f => f.label === 'Stundennachweis Abdeckung')
                  ? 'Kehren Sie zur Monatsplanung zurück und stellen Sie sicher, dass alle Fahrten einem gültigen Schichtblock zugewiesen sind.'
                  : 'Diese Konflikte sollten bereits vor dem Anwenden der Planung behoben werden. Bitte kehren Sie zur Monatsplanung zurück, passen Sie die Planung an und prüfen Sie die Planqualität erneut.'}
              </p>
            </div>
          )}

          {/* Snapshot summary */}
          {snapshot && (step === 'ready' || step === 'finalizing' || step === 'done') && (
            <div className="rounded-lg px-4 py-3 space-y-2" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
              <div className="text-xs font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--text-tertiary)' }}>
                Snapshot-Übersicht
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span style={{ color: 'var(--text-tertiary)' }}>Fahrten gesamt: </span>
                  <strong style={{ color: 'var(--text-primary)' }}>{snapshot.totalTrips}</strong>
                </div>
                <div>
                  <span style={{ color: 'var(--text-tertiary)' }}>Fahrer: </span>
                  <strong style={{ color: 'var(--text-primary)' }}>{snapshot.driverCount}</strong>
                </div>
              </div>
              <div className="space-y-1 mt-1">
                {snapshot.drivers.map(d => (
                  <div key={d.name} className="flex items-center justify-between text-xs py-1 border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                    <div className="flex items-center gap-2">
                      <Users size={11} style={{ color: 'var(--text-tertiary)' }} />
                      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{d.name}</span>
                    </div>
                    <div className="flex gap-3" style={{ color: 'var(--text-secondary)' }}>
                      <span>{d.trips} Fahrten</span>
                      <span>{d.blocks} Blöcke</span>
                      <span>{minsToHHMM(d.workMinutes)} h</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Done state */}
          {step === 'done' && (
            <div className="rounded-lg px-4 py-4 space-y-3" style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)' }}>
              <div className="flex items-center gap-2 font-bold" style={{ color: '#15803d' }}>
                <CheckCircle2 size={16} />
                Finale Dokumente erstellt
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <div>Fahrtenbuch: <strong style={{ color: 'var(--text-primary)' }}>bereit</strong></div>
                <div>Stundennachweise: <strong style={{ color: 'var(--text-primary)' }}>{snapshot?.driverCount ?? 0} Fahrer</strong></div>
                <div>Fahrten: <strong style={{ color: 'var(--text-primary)' }}>{snapshot?.totalTrips ?? 0}</strong></div>
                <div>Finalisiert am: <strong style={{ color: 'var(--text-primary)' }}>{fmtDateTime(finalizedAt)}</strong></div>
              </div>
              {/* Fahrtenbuch download */}
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  onClick={handleRedownload}
                  disabled={xlsxDownloading}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 transition-all"
                  style={{ background: 'rgba(34,197,94,0.15)', color: '#15803d', border: '1px solid rgba(34,197,94,0.4)' }}
                >
                  {xlsxDownloading ? <Loader2 size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />}
                  Fahrtenbuch herunterladen
                </button>
                <button
                  onClick={() => setShowStundenPreview(true)}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold transition-all"
                  style={{ background: 'rgba(6,182,212,0.12)', color: '#0e7490', border: '1px solid rgba(6,182,212,0.35)' }}
                >
                  <FileText size={14} />
                  Stundennachweis Preview anzeigen
                </button>
              </div>
              {/* Per-driver Stundennachweis downloads (from the same finalized snapshot) */}
              {snapshot && snapshot.drivers.some(d => d.pdfData) && (
                <div className="space-y-1.5 pt-1">
                  <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                    Stundennachweise herunterladen
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {snapshot.drivers.map(d => d.pdfData ? (
                      <button
                        key={d.id}
                        onClick={() => handleDownloadStunden(d)}
                        disabled={downloadingStundenDriverId === d.id}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50 transition-all"
                        style={{ background: 'rgba(34,197,94,0.1)', color: '#15803d', border: '1px solid rgba(34,197,94,0.3)' }}
                      >
                        {downloadingStundenDriverId === d.id
                          ? <Loader2 size={11} className="animate-spin" />
                          : <FileText size={11} />
                        }
                        {d.name}
                      </button>
                    ) : null)}
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    Alle Stundennachweise stammen aus dem finalisierten Snapshot. Bitte jetzt herunterladen — nach einem Transfer wird die Finalisierung als veraltet markiert.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Note about what finalization does */}
          {(step === 'ready') && (
            <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(6,182,212,0.07)', border: '1px solid rgba(6,182,212,0.2)', color: 'var(--text-secondary)' }}>
              Fahrtenbuch und Stundennachweise werden aus demselben aktuellen Daten-Snapshot generiert.
              Nach Abschluss kann der Finalisierungs-Status durch weitere Transfers als veraltet markiert werden.
            </div>
          )}

          {error && (
            <div className="px-3 py-2 rounded-lg text-sm whitespace-pre-wrap" style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', fontFamily: error.includes('\n') ? 'monospace' : 'inherit', fontSize: 12 }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t shrink-0" style={{ borderColor: 'var(--border)' }}>
          <button
            onClick={onClose}
            disabled={step === 'finalizing'}
            className="px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
            style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
          >
            {step === 'done' ? 'Schließen' : 'Abbrechen'}
          </button>

          {step !== 'done' && (
            <div className="flex items-center gap-2">
              {step === 'blocked' && (
                <button
                  onClick={runChecks}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold"
                  style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                >
                  Erneut prüfen
                </button>
              )}
              <button
                onClick={handleFinalize}
                disabled={step !== 'ready' || !allChecksOk}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold disabled:opacity-40 transition-all"
                style={{
                  background: step === 'ready' && allChecksOk ? '#f59e0b' : 'var(--bg-muted)',
                  color: step === 'ready' && allChecksOk ? '#fff' : 'var(--text-tertiary)',
                  border: 'none',
                }}
              >
                {step === 'finalizing'
                  ? <><Loader2 size={14} className="animate-spin" /> Wird erstellt…</>
                  : <><Sparkles size={14} /> Finale Dokumente erstellen</>
                }
              </button>
            </div>
          )}
        </div>
      </div>

      {showStundenPreview && (
        <MonatsplanungStundennachweisPreview
          run={{
            id: run.id,
            company_id: run.company_id,
            month: run.month,
            year: run.year,
            status: run.status,
            file_name: run.file_name,
            applied_at: run.applied_at,
            import_id: run.import_id ?? null,
            source_sheet_name: run.source_sheet_name ?? null,
            source_columns_json: run.source_columns_json ?? null,
          }}
          onClose={() => setShowStundenPreview(false)}
        />
      )}
    </div>
  );
}
