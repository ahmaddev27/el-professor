import {
  computeLohnartSeconds,
  getGermanNationalHolidays,
  type FinalBlockAssignmentSnapshotResult,
  type RegularDriverTarget,
} from './historicalWorkingHoursCleanEngine';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HistoricalWorkingHoursStundennachweisDriverPreview {
  driverId: string;
  driverName: string;
  driverRole: 'regular' | 'inhaber';
  targetBaseSec1000: number;
  targetNight25Sec1500: number;
  targetNight40Sec1501: number;
  targetSundaySec1510: number;
  targetHolidaySec: number;
  targetTotalSec: number;
  actualBaseSec1000: number;
  actualNight25Sec1500: number;
  actualNight40Sec1501: number;
  actualSundaySec1510: number;
  actualHolidaySec: number;
  actualTotalSec: number;
  correctionBaseSec1000: number;
  correctionNight25Sec1500: number;
  correctionNight40Sec1501: number;
  correctionSundaySec1510: number;
  correctionHolidaySec: number;
  finalBaseSec1000: number;
  finalNight25Sec1500: number;
  finalNight40Sec1501: number;
  finalSundaySec1510: number;
  finalHolidaySec: number;
  finalTotalSec: number;
  isBalanced: boolean;
  warnings: string[];
}

export interface HistoricalWorkingHoursStundennachweisPreviewResult {
  isReady: boolean;
  driverPreviews: HistoricalWorkingHoursStundennachweisDriverPreview[];
  errorCount: number;
  warningCount: number;
  totalCorrectionSec: number;
  generatedFromSnapshotRows: number;
}

// ── Computation ───────────────────────────────────────────────────────────────

const BALANCE_TOL = 1;                    // 1-second balance check tolerance
const CORRECTION_DISPLAY_TOLERANCE_SEC = 30; // corrections below 30s are treated as zero and final normalized to target

export function buildStundennachweisPreview(
  snapshotResult: FinalBlockAssignmentSnapshotResult,
  regularTargets: RegularDriverTarget[],
  inhaberId: string | null,
  inhaberName: string | null,
  year: number,
): HistoricalWorkingHoursStundennachweisPreviewResult {
  const rows = snapshotResult.rows ?? [];

  // ── Step 1: Aggregate actual block hours per driver ──────────────────────
  // Group exportable rows by (blockId, finalDriverId) to get block intervals,
  // then compute Lohnart seconds from the block's time span (not per-trip).

  interface BlockAccum { startMs: number; endMs: number; driverId: string; driverName: string; role: 'regular' | 'inhaber' }

  const blockMap = new Map<string, BlockAccum>();

  for (const row of rows) {
    if (!row.isExportable) continue;
    if (!row.finalDriverId || !row.blockId) continue;

    const key = `${row.blockId}::${row.finalDriverId}`;
    const existing = blockMap.get(key);
    if (!existing) {
      const role: 'regular' | 'inhaber' = row.finalDriverRole === 'regular' ? 'regular' : 'inhaber';
      blockMap.set(key, {
        startMs: row.finalStartMs,
        endMs: row.finalEndMs,
        driverId: row.finalDriverId,
        driverName: row.finalDriverName ?? row.finalDriverId,
        role,
      });
    } else {
      existing.startMs = Math.min(existing.startMs, row.finalStartMs);
      existing.endMs   = Math.max(existing.endMs,   row.finalEndMs);
    }
  }

  // ── Step 2: Build per-driver actual Lohnart totals ───────────────────────

  interface DriverAccum {
    driverId: string;
    driverName: string;
    role: 'regular' | 'inhaber';
    baseSec: number;
    night25Sec: number;
    night40Sec: number;
    sundaySec: number;
    holidaySec: number;
  }

  const driverMap = new Map<string, DriverAccum>();

  const holidayCache = new Map<number, Set<string>>();
  const getHolidays = (y: number): Set<string> => {
    if (!holidayCache.has(y)) holidayCache.set(y, getGermanNationalHolidays(y));
    return holidayCache.get(y)!;
  };

  for (const [, block] of blockMap) {
    const existing = driverMap.get(block.driverId);
    if (!existing) {
      driverMap.set(block.driverId, {
        driverId: block.driverId,
        driverName: block.driverName,
        role: block.role,
        baseSec: 0, night25Sec: 0, night40Sec: 0, sundaySec: 0, holidaySec: 0,
      });
    }
    // computeLohnartSeconds handles holiday detection internally via startMs year
    const la = computeLohnartSeconds(block.startMs, block.endMs, getHolidays(new Date(block.startMs).getFullYear()));
    const acc = driverMap.get(block.driverId)!;
    acc.baseSec    += la.baseSec;
    acc.night25Sec += la.night25Sec;
    acc.night40Sec += la.night40Sec;
    acc.sundaySec  += la.sundaySec;
    acc.holidaySec += la.holidaySec;
  }

  // ── Step 3: Build per-driver previews ────────────────────────────────────

  const targetMap = new Map<string, RegularDriverTarget>();
  for (const t of regularTargets) targetMap.set(t.driverId, t);

  // Collect all driver IDs that appear in snapshot (regular + inhaber)
  const allDriverIds = new Set<string>();
  for (const [, acc] of driverMap) allDriverIds.add(acc.driverId);
  // Also add regular targets even if they have zero blocks
  for (const t of regularTargets) allDriverIds.add(t.driverId);

  const previews: HistoricalWorkingHoursStundennachweisDriverPreview[] = [];
  let errorCount = 0;
  let warningCount = 0;
  let totalCorrectionSec = 0;

  for (const driverId of allDriverIds) {
    const acc = driverMap.get(driverId);
    const target = targetMap.get(driverId);
    const role: 'regular' | 'inhaber' =
      acc?.role ?? (driverId === inhaberId ? 'inhaber' : 'regular');

    const driverName = acc?.driverName
      ?? target?.driverName
      ?? (driverId === inhaberId ? (inhaberName ?? driverId) : driverId);

    const actual = {
      baseSec:    acc?.baseSec    ?? 0,
      night25Sec: acc?.night25Sec ?? 0,
      night40Sec: acc?.night40Sec ?? 0,
      sundaySec:  acc?.sundaySec  ?? 0,
      holidaySec: acc?.holidaySec ?? 0,
    };
    const actualTotalSec = actual.baseSec + actual.night25Sec + actual.night40Sec + actual.sundaySec + actual.holidaySec;

    const tgt = role === 'regular' && target ? {
      base:    target.targetBaseSec1000,
      night25: target.targetNight25Sec1500,
      night40: target.targetNight40Sec1501,
      sunday:  target.targetSundaySec1510,
      holiday: target.targetHolidaySec,
      total:   target.targetTotalSec,
    } : { base: 0, night25: 0, night40: 0, sunday: 0, holiday: 0, total: 0 };

    const warnings: string[] = [];

    const correction = {
      base:    0,
      night25: 0,
      night40: 0,
      sunday:  0,
      holiday: 0,
    };

    if (role === 'regular') {
      const pairs: Array<[keyof typeof correction, number, number, string]> = [
        ['base',    actual.baseSec,    tgt.base,    '1000 Std'],
        ['night25', actual.night25Sec, tgt.night25, '1500 N25%'],
        ['night40', actual.night40Sec, tgt.night40, '1501 N40%'],
        ['sunday',  actual.sundaySec,  tgt.sunday,  '1510 Son'],
        ['holiday', actual.holidaySec, tgt.holiday, 'Feiertag'],
      ];
      for (const [key, actualSec, targetSec, label] of pairs) {
        if (actualSec > targetSec + BALANCE_TOL) {
          warnings.push(`Ist-Wert überschreitet Soll-Wert für ${label} (Ist: ${(actualSec / 3600).toFixed(2)} h, Soll: ${(targetSec / 3600).toFixed(2)} h)`);
          warningCount++;
        } else if (actualSec < targetSec - BALANCE_TOL) {
          const raw = targetSec - actualSec;
          const displayable = raw >= CORRECTION_DISPLAY_TOLERANCE_SEC ? raw : 0;
          correction[key] = displayable;
          totalCorrectionSec += displayable;
        }
      }
    }

    const final = {
      // When correction was suppressed (gap < display tolerance), normalize final to target
      base:    correction.base > 0 ? actual.baseSec    + correction.base    : (tgt.base    > 0 && Math.abs(actual.baseSec    - tgt.base)    < CORRECTION_DISPLAY_TOLERANCE_SEC ? tgt.base    : actual.baseSec),
      night25: correction.night25 > 0 ? actual.night25Sec + correction.night25 : (tgt.night25 > 0 && Math.abs(actual.night25Sec - tgt.night25) < CORRECTION_DISPLAY_TOLERANCE_SEC ? tgt.night25 : actual.night25Sec),
      night40: correction.night40 > 0 ? actual.night40Sec + correction.night40 : (tgt.night40 > 0 && Math.abs(actual.night40Sec - tgt.night40) < CORRECTION_DISPLAY_TOLERANCE_SEC ? tgt.night40 : actual.night40Sec),
      sunday:  correction.sunday  > 0 ? actual.sundaySec  + correction.sunday  : (tgt.sunday  > 0 && Math.abs(actual.sundaySec  - tgt.sunday)  < CORRECTION_DISPLAY_TOLERANCE_SEC ? tgt.sunday  : actual.sundaySec),
      holiday: correction.holiday > 0 ? actual.holidaySec + correction.holiday : (tgt.holiday > 0 && Math.abs(actual.holidaySec - tgt.holiday) < CORRECTION_DISPLAY_TOLERANCE_SEC ? tgt.holiday : actual.holidaySec),
    };
    const finalTotalSec = final.base + final.night25 + final.night40 + final.sunday + final.holiday;

    const isBalanced = role !== 'regular' || (
      Math.abs(final.base    - tgt.base)    <= CORRECTION_DISPLAY_TOLERANCE_SEC &&
      Math.abs(final.night25 - tgt.night25) <= CORRECTION_DISPLAY_TOLERANCE_SEC &&
      Math.abs(final.night40 - tgt.night40) <= CORRECTION_DISPLAY_TOLERANCE_SEC &&
      Math.abs(final.sunday  - tgt.sunday)  <= CORRECTION_DISPLAY_TOLERANCE_SEC &&
      Math.abs(final.holiday - tgt.holiday) <= CORRECTION_DISPLAY_TOLERANCE_SEC
    );

    if (role === 'regular' && !isBalanced) errorCount++;

    previews.push({
      driverId,
      driverName,
      driverRole: role,
      targetBaseSec1000:    tgt.base,
      targetNight25Sec1500: tgt.night25,
      targetNight40Sec1501: tgt.night40,
      targetSundaySec1510:  tgt.sunday,
      targetHolidaySec:     tgt.holiday,
      targetTotalSec:       tgt.total,
      actualBaseSec1000:    actual.baseSec,
      actualNight25Sec1500: actual.night25Sec,
      actualNight40Sec1501: actual.night40Sec,
      actualSundaySec1510:  actual.sundaySec,
      actualHolidaySec:     actual.holidaySec,
      actualTotalSec,
      correctionBaseSec1000:    correction.base,
      correctionNight25Sec1500: correction.night25,
      correctionNight40Sec1501: correction.night40,
      correctionSundaySec1510:  correction.sunday,
      correctionHolidaySec:     correction.holiday,
      finalBaseSec1000:    final.base,
      finalNight25Sec1500: final.night25,
      finalNight40Sec1501: final.night40,
      finalSundaySec1510:  final.sunday,
      finalHolidaySec:     final.holiday,
      finalTotalSec,
      isBalanced,
      warnings,
    });
  }

  // Sort: regular drivers first (sorted by name), then inhaber
  previews.sort((a, b) => {
    if (a.driverRole !== b.driverRole) return a.driverRole === 'regular' ? -1 : 1;
    return a.driverName.localeCompare(b.driverName, 'de');
  });

  return {
    isReady: errorCount === 0,
    driverPreviews: previews,
    errorCount,
    warningCount,
    totalCorrectionSec,
    generatedFromSnapshotRows: rows.filter(r => r.isExportable).length,
  };
}
