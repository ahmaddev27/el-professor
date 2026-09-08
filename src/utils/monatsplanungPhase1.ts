// Monatsplanung – Phase 1
// Read-only vehicle-block preview built from a Fahrtenbuch import.
// No driver logic. No persistence. No assignment.

export const VEHICLE_BLOCK_GAP_MINUTES = 60;
export const DEFAULT_MAX_VEHICLE_BLOCK_DURATION_MINUTES = 270; // 4.5h
export const MAX_VEHICLE_BLOCK_DURATION_MINUTES = DEFAULT_MAX_VEHICLE_BLOCK_DURATION_MINUTES; // deprecated alias
export const MIN_VEHICLE_BLOCK_DURATION_MINUTES = 30;  // default Min Blockdauer
export const MAX_BLOCK_DURATION_LOWER_BOUND = 60;
export const MAX_BLOCK_DURATION_UPPER_BOUND = 720;

export interface Phase1Options {
  blockSeparatorGapMinutes?: number;
  /** Min Blockdauer in minutes. 0 disables short-block merging. */
  minBlockDurationMinutes?: number;
  /** Max Blockdauer in minutes. Default 270 (4.5h). Range 60–720. */
  maxBlockDurationMinutes?: number;
}

export type SplitReason = 'gap_gt_60' | 'max_duration_4_5h' | 'end_of_vehicle_day';
export type MergeStatus = 'none' | 'merged_short' | 'short_warning';

export interface Phase1Trip {
  id: string;
  trip_date: string;            // YYYY-MM-DD (audit/billing date)
  start_time: string | null;    // HH:MM (normalized)
  end_time: string | null;      // HH:MM (normalized)
  car_id: string | null;
  car_identifier: string | null;
  is_canceled: boolean;
  source_row_index: number | null;
  /**
   * Actual UTC ms of the trip's real start, resolved from raw_data_json
   * (Uhrzeit des Fahrtbeginns). When set, Phase 1 sorts and groups by this
   * instead of trip_date + start_time, fixing reversed Excel row ranges and
   * midnight-trip misclassification.
   */
  actual_start_ms?: number;
  /**
   * Actual UTC ms of the trip's real end, resolved from raw_data_json
   * (Uhrzeit des Fahrtendes).
   */
  actual_end_ms?: number;
}

export interface Phase1TripRow {
  trip_id: string;
  excel_row: number | null;
  start_datetime: string;
  end_datetime: string;
}

export interface Phase1VehicleBlock {
  block_id: string;
  vehicle_id: string;
  vehicle_identifier: string;
  /** Actual calendar date of the block start (YYYY-MM-DD). */
  service_date: string;
  /** Actual start ISO (YYYY-MM-DDTHH:MM) derived from actual timestamps. */
  block_start_datetime: string;
  /** Actual end ISO (YYYY-MM-DDTHH:MM) derived from actual timestamps. */
  block_end_datetime: string;
  duration_minutes: number;
  trip_ids: string[];
  trip_count: number;
  first_trip_id: string;
  last_trip_id: string;
  /** Minimum source_row_index across all trips in this block. */
  first_excel_row: number | null;
  /** Maximum source_row_index across all trips in this block. */
  last_excel_row: number | null;
  trip_rows: Phase1TripRow[];
  split_reason: SplitReason;
  internal_gaps: number[];
  longest_internal_gap_minutes: number;
  merge_status: MergeStatus;
  /** UTC ms of block actual start (= curStart.getTime()). Always set by Phase 1. */
  actual_start_ms?: number;
  /** UTC ms of block actual end (= curEnd.getTime()). Always set by Phase 1. */
  actual_end_ms?: number;
}

export interface Phase1CoverageIssue {
  type: 'duplicate_trip' | 'missing_trip' | 'canceled_in_block' | 'block_too_long' | 'block_gap_too_large' | 'unsorted_blocks';
  detail: string;
}

export interface Phase1Result {
  blocks: Phase1VehicleBlock[];
  summary: {
    total_trips: number;
    abgeschlossen: number;
    storniert: number;
    vehicles: number;
    blocks_total: number;
    blocks_split_by_gap: number;
    blocks_split_by_max_duration: number;
    max_block_duration_minutes: number;
    observed_max_block_duration_minutes: number;
    coverage_issues: number;
    block_separator_gap_minutes: number;
    min_block_duration_minutes: number;
    short_blocks_detected: number;
    short_blocks_merged: number;
    short_blocks_remaining: number;
  };
  perVehicle: Array<{
    vehicle_id: string;
    vehicle_identifier: string;
    blocks: number;
    trips: number;
    avg_trips_per_block: number;
    avg_block_duration_minutes: number;
    max_block_duration_minutes: number;
  }>;
  coverageIssues: Phase1CoverageIssue[];
  skippedTrips: Array<{ id: string; reason: string }>;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseDt(dateStr: string, timeStr: string): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const tm = /^(\d{1,2}):(\d{2})/.exec(timeStr);
  if (!dm || !tm) return null;
  return new Date(
    Number(dm[1]),
    Number(dm[2]) - 1,
    Number(dm[3]),
    Number(tm[1]),
    Number(tm[2]),
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dateStrLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

// ── internal parsed trip ─────────────────────────────────────────────────────

interface ParsedTrip {
  id: string;
  vehicle_id: string;
  vehicle_identifier: string;
  /** Actual calendar date (YYYY-MM-DD) of the trip start. */
  actual_date: string;
  /** audit/billing date from source */
  trip_date: string;
  startDt: Date;
  endDt: Date;
  excelRow: number | null;
}

// ── main function ─────────────────────────────────────────────────────────────

export function buildPhase1VehicleBlocks(trips: Phase1Trip[], options: Phase1Options = {}): Phase1Result {
  const gapMinutes = Math.max(0, Math.round(options.blockSeparatorGapMinutes ?? VEHICLE_BLOCK_GAP_MINUTES));
  const minBlockMinutes = Math.max(0, Math.min(120, Math.round(options.minBlockDurationMinutes ?? MIN_VEHICLE_BLOCK_DURATION_MINUTES)));
  const maxBlockMinutes = Math.max(
    MAX_BLOCK_DURATION_LOWER_BOUND,
    Math.min(
      MAX_BLOCK_DURATION_UPPER_BOUND,
      Math.round(options.maxBlockDurationMinutes ?? DEFAULT_MAX_VEHICLE_BLOCK_DURATION_MINUTES),
    ),
  );
  const totalTrips = trips.length;
  let canceled = 0;
  const skipped: Array<{ id: string; reason: string }> = [];

  // 1. Filter to non-canceled with valid datetimes & vehicle.
  //    Group by vehicle only (not vehicle + service_date) so that midnight trips
  //    are processed alongside the correct actual-date peers.
  const groups = new Map<string, ParsedTrip[]>();

  for (const t of trips) {
    if (t.is_canceled) {
      canceled++;
      continue;
    }
    if (!t.start_time || !t.end_time) {
      skipped.push({ id: t.id, reason: 'missing_time' });
      continue;
    }
    const vehicleId = t.car_id ?? t.car_identifier;
    if (!vehicleId) {
      skipped.push({ id: t.id, reason: 'missing_vehicle' });
      continue;
    }

    let startDt: Date;
    let endDt: Date;

    // Prefer actual timestamps from raw_data_json (pre-computed by caller).
    // Fall back to service_date + HH:MM with overnight correction.
    if (t.actual_start_ms && t.actual_start_ms > 0) {
      startDt = new Date(t.actual_start_ms);
    } else {
      const d = parseDt(t.trip_date, t.start_time);
      if (!d) { skipped.push({ id: t.id, reason: 'invalid_datetime' }); continue; }
      startDt = d;
    }

    if (t.actual_end_ms && t.actual_end_ms > 0) {
      endDt = new Date(t.actual_end_ms);
    } else {
      const d = parseDt(t.trip_date, t.end_time);
      if (!d) { skipped.push({ id: t.id, reason: 'invalid_datetime' }); continue; }
      endDt = d;
      // Fallback overnight correction: end before start means trip crosses midnight.
      if (endDt.getTime() < startDt.getTime()) {
        endDt = new Date(endDt.getTime() + 24 * 60 * 60 * 1000);
      }
    }

    // Group by vehicle only — gaps handle day boundaries naturally.
    const key = vehicleId;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push({
      id: t.id,
      vehicle_id: vehicleId,
      vehicle_identifier: t.car_identifier ?? vehicleId,
      actual_date: dateStrLocal(startDt),
      trip_date: t.trip_date,
      startDt,
      endDt,
      excelRow: t.source_row_index,
    });
  }

  const abgeschlossen = totalTrips - canceled - skipped.length;

  // 2 + 3 + 4. Sort by actual start, split on gap > gapMinutes or max duration.
  const blocks: Phase1VehicleBlock[] = [];
  let splitByGap = 0;
  let splitByMaxDuration = 0;

  for (const arr of groups.values()) {
    // Sort by actual start timestamp.
    arr.sort((a, b) => a.startDt.getTime() - b.startDt.getTime());

    let cur: ParsedTrip[] = [];
    let curStart: Date | null = null;
    let curEnd: Date | null = null;
    const internalGaps: number[] = [];

    const flush = (reason: SplitReason) => {
      if (cur.length === 0 || !curStart || !curEnd) return;
      const duration = minutesBetween(curStart, curEnd);
      const gaps = [...internalGaps];
      const longestGap = gaps.length ? Math.max(...gaps) : 0;
      const tripIds = cur.map(t => t.id);

      // Excel rows: min/max across all trips in block (not first/last in sorted order).
      const excelNums = cur.map(t => t.excelRow).filter((r): r is number => r !== null);
      const minExcelRow = excelNums.length ? Math.min(...excelNums) : null;
      const maxExcelRow = excelNums.length ? Math.max(...excelNums) : null;

      const rows = cur.map<Phase1TripRow>(t => ({
        trip_id: t.id,
        excel_row: t.excelRow,
        start_datetime: isoLocal(t.startDt),
        end_datetime: isoLocal(t.endDt),
      }));

      // service_date = actual calendar date of block start.
      const serviceDate = dateStrLocal(curStart);
      const blockStart = isoLocal(curStart);
      const blockEnd = isoLocal(curEnd);

      blocks.push({
        block_id: `${cur[0].vehicle_id}|${serviceDate}|${blockStart}|${blockEnd}`,
        vehicle_id: cur[0].vehicle_id,
        vehicle_identifier: cur[0].vehicle_identifier,
        service_date: serviceDate,
        block_start_datetime: blockStart,
        block_end_datetime: blockEnd,
        duration_minutes: duration,
        trip_ids: tripIds,
        trip_count: cur.length,
        first_trip_id: tripIds[0],
        last_trip_id: tripIds[tripIds.length - 1],
        first_excel_row: minExcelRow,
        last_excel_row: maxExcelRow,
        trip_rows: rows,
        split_reason: reason,
        internal_gaps: gaps,
        longest_internal_gap_minutes: longestGap,
        merge_status: 'none',
        actual_start_ms: curStart.getTime(),
        actual_end_ms: curEnd.getTime(),
      });
      cur = [];
      curStart = null;
      curEnd = null;
      internalGaps.length = 0;
    };

    for (const t of arr) {
      if (cur.length === 0) {
        cur.push(t);
        curStart = t.startDt;
        curEnd = t.endDt;
        continue;
      }
      const prev = cur[cur.length - 1];
      const gap = minutesBetween(prev.endDt, t.startDt);
      if (gap > gapMinutes) {
        flush('gap_gt_60');
        splitByGap++;
        cur.push(t);
        curStart = t.startDt;
        curEnd = t.endDt;
        continue;
      }
      const potentialEnd = t.endDt.getTime() > curEnd!.getTime() ? t.endDt : curEnd!;
      const potentialDuration = minutesBetween(curStart!, potentialEnd);
      if (potentialDuration > maxBlockMinutes) {
        flush('max_duration_4_5h');
        splitByMaxDuration++;
        cur.push(t);
        curStart = t.startDt;
        curEnd = t.endDt;
        continue;
      }
      if (gap > 0) internalGaps.push(gap);
      cur.push(t);
      curEnd = potentialEnd;
    }
    flush('end_of_vehicle_day');
  }

  // 4b. Short-block merge phase (Min Blockdauer).
  // Operates per vehicle_id to never cross vehicles. Repeatedly merges the
  // shortest block under min duration with its closest neighbor (by gap) as
  // long as the merged block stays <= maxBlockMinutes. Trip coverage is
  // preserved. Remaining short blocks are flagged with merge_status='short_warning'.
  let shortBlocksDetected = 0;
  let shortBlocksMerged = 0;
  let shortBlocksRemaining = 0;

  if (minBlockMinutes > 0) {
    // Bucket by vehicle_id only (matches the grouping above).
    const byBucket = new Map<string, Phase1VehicleBlock[]>();
    for (const b of blocks) {
      const arr = byBucket.get(b.vehicle_id) ?? [];
      arr.push(b);
      byBucket.set(b.vehicle_id, arr);
    }

    const survivors: Phase1VehicleBlock[] = [];

    for (const bucket of byBucket.values()) {
      // Sort by actual start (block_start_datetime is now actual ISO).
      bucket.sort((a, b) => a.block_start_datetime.localeCompare(b.block_start_datetime));
      shortBlocksDetected += bucket.filter(b => b.duration_minutes < minBlockMinutes).length;

      // Greedy merge loop: pick the shortest short block, merge with closer neighbor.
      let progress = true;
      while (progress && bucket.length > 1) {
        progress = false;
        let bestIdx = -1;
        let bestDur = Infinity;
        for (let i = 0; i < bucket.length; i++) {
          if (bucket[i].duration_minutes < minBlockMinutes && bucket[i].duration_minutes < bestDur) {
            bestIdx = i;
            bestDur = bucket[i].duration_minutes;
          }
        }
        if (bestIdx === -1) break;

        const cur = bucket[bestIdx];
        const prev = bestIdx > 0 ? bucket[bestIdx - 1] : null;
        const next = bestIdx < bucket.length - 1 ? bucket[bestIdx + 1] : null;

        const gapTo = (a: Phase1VehicleBlock, b: Phase1VehicleBlock): number => {
          const aEnd = new Date(a.block_end_datetime).getTime();
          const bStart = new Date(b.block_start_datetime).getTime();
          return Math.max(0, Math.round((bStart - aEnd) / 60000));
        };
        const mergedDuration = (a: Phase1VehicleBlock, b: Phase1VehicleBlock): number => {
          const aStart = new Date(a.block_start_datetime).getTime();
          const bEnd = new Date(b.block_end_datetime).getTime();
          return Math.max(0, Math.round((bEnd - aStart) / 60000));
        };

        const candPrev = prev ? { other: prev, gap: gapTo(prev, cur), durAfter: mergedDuration(prev, cur), atIdx: bestIdx - 1 } : null;
        const candNext = next ? { other: next, gap: gapTo(cur, next), durAfter: mergedDuration(cur, next), atIdx: bestIdx } : null;

        const candidates = [candPrev, candNext].filter((c): c is NonNullable<typeof candPrev> => !!c);
        candidates.sort((a, b) => a.gap - b.gap || a.durAfter - b.durAfter);

        let mergedSomething = false;
        for (const c of candidates) {
          if (c.durAfter > maxBlockMinutes) continue;
          const left = bucket[c.atIdx];
          const right = bucket[c.atIdx + 1];
          const bridgeGap = gapTo(left, right);
          const mergedTripIds = [...left.trip_ids, ...right.trip_ids];
          const mergedRows = [...left.trip_rows, ...right.trip_rows]
            .sort((x, y) => x.start_datetime.localeCompare(y.start_datetime));
          const newGaps = [...left.internal_gaps, ...right.internal_gaps];
          if (bridgeGap > 0) newGaps.push(bridgeGap);
          const longestGap = newGaps.length ? Math.max(...newGaps) : 0;
          const newStart = left.block_start_datetime;
          const newEnd = right.block_end_datetime;

          // Recompute min/max Excel rows across both merged blocks.
          const allExcelRows = [...left.trip_rows, ...right.trip_rows]
            .map(r => r.excel_row)
            .filter((r): r is number => r !== null);
          const newFirstExcel = allExcelRows.length ? Math.min(...allExcelRows) : null;
          const newLastExcel  = allExcelRows.length ? Math.max(...allExcelRows) : null;

          const merged: Phase1VehicleBlock = {
            block_id: `${left.vehicle_id}|${left.service_date}|${newStart}|${newEnd}`,
            vehicle_id: left.vehicle_id,
            vehicle_identifier: left.vehicle_identifier,
            service_date: left.service_date,
            block_start_datetime: newStart,
            block_end_datetime: newEnd,
            duration_minutes: c.durAfter,
            trip_ids: mergedTripIds,
            trip_count: mergedTripIds.length,
            first_trip_id: mergedRows[0]?.trip_id ?? left.first_trip_id,
            last_trip_id: mergedRows[mergedRows.length - 1]?.trip_id ?? right.last_trip_id,
            first_excel_row: newFirstExcel,
            last_excel_row: newLastExcel,
            trip_rows: mergedRows,
            split_reason: left.split_reason,
            internal_gaps: newGaps,
            longest_internal_gap_minutes: longestGap,
            merge_status: 'merged_short',
            actual_start_ms: left.actual_start_ms,
            actual_end_ms: right.actual_end_ms,
          };
          bucket.splice(c.atIdx, 2, merged);
          shortBlocksMerged++;
          mergedSomething = true;
          break;
        }
        if (mergedSomething) progress = true;
      }

      for (const b of bucket) {
        if (b.duration_minutes < minBlockMinutes && b.merge_status !== 'merged_short') {
          b.merge_status = 'short_warning';
          shortBlocksRemaining++;
        }
      }
      survivors.push(...bucket);
    }

    blocks.length = 0;
    blocks.push(...survivors);
  }

  // 5. Sort all blocks chronologically by actual start timestamp.
  blocks.sort((a, b) => {
    const msA = a.actual_start_ms ?? new Date(a.block_start_datetime).getTime();
    const msB = b.actual_start_ms ?? new Date(b.block_start_datetime).getTime();
    if (msA !== msB) return msA - msB;
    return a.vehicle_identifier.localeCompare(b.vehicle_identifier);
  });

  // 6. Validation / coverage
  const coverageIssues: Phase1CoverageIssue[] = [];
  const seen = new Map<string, number>();
  for (const b of blocks) {
    for (const tid of b.trip_ids) {
      seen.set(tid, (seen.get(tid) ?? 0) + 1);
    }
    if (b.duration_minutes > maxBlockMinutes) {
      coverageIssues.push({
        type: 'block_too_long',
        detail: `Block ${b.block_id} hat Dauer ${b.duration_minutes} Min. (> ${maxBlockMinutes})`,
      });
    }
    if (b.longest_internal_gap_minutes > gapMinutes) {
      coverageIssues.push({
        type: 'block_gap_too_large',
        detail: `Block ${b.block_id} hat internen Gap ${b.longest_internal_gap_minutes} Min. (> ${gapMinutes})`,
      });
    }
  }
  for (const [tid, count] of seen) {
    if (count > 1) {
      coverageIssues.push({ type: 'duplicate_trip', detail: `Trip ${tid} ist in ${count} Blöcken enthalten` });
    }
  }
  for (const t of trips) {
    if (t.is_canceled) continue;
    if (!t.start_time || !t.end_time) continue;
    if (!(t.car_id ?? t.car_identifier)) continue;
    if (!seen.has(t.id)) {
      coverageIssues.push({ type: 'missing_trip', detail: `Trip ${t.id} wurde keinem Block zugeordnet` });
    }
  }

  // 7. Per-vehicle summary
  const perVehicleMap = new Map<string, { vehicle_id: string; vehicle_identifier: string; blocks: Phase1VehicleBlock[] }>();
  for (const b of blocks) {
    let v = perVehicleMap.get(b.vehicle_id);
    if (!v) {
      v = { vehicle_id: b.vehicle_id, vehicle_identifier: b.vehicle_identifier, blocks: [] };
      perVehicleMap.set(b.vehicle_id, v);
    }
    v.blocks.push(b);
  }
  const perVehicle = Array.from(perVehicleMap.values()).map(v => {
    const tripCount = v.blocks.reduce((s, x) => s + x.trip_count, 0);
    const totalDur  = v.blocks.reduce((s, x) => s + x.duration_minutes, 0);
    const maxDur    = v.blocks.reduce((m, x) => Math.max(m, x.duration_minutes), 0);
    return {
      vehicle_id: v.vehicle_id,
      vehicle_identifier: v.vehicle_identifier,
      blocks: v.blocks.length,
      trips: tripCount,
      avg_trips_per_block: v.blocks.length ? tripCount / v.blocks.length : 0,
      avg_block_duration_minutes: v.blocks.length ? totalDur / v.blocks.length : 0,
      max_block_duration_minutes: maxDur,
    };
  }).sort((a, b) => a.vehicle_identifier.localeCompare(b.vehicle_identifier));

  const observedMaxBlockDuration = blocks.reduce((m, b) => Math.max(m, b.duration_minutes), 0);

  return {
    blocks,
    summary: {
      total_trips: totalTrips,
      abgeschlossen,
      storniert: canceled,
      vehicles: perVehicleMap.size,
      blocks_total: blocks.length,
      blocks_split_by_gap: splitByGap,
      blocks_split_by_max_duration: splitByMaxDuration,
      max_block_duration_minutes: maxBlockMinutes,
      observed_max_block_duration_minutes: observedMaxBlockDuration,
      coverage_issues: coverageIssues.length,
      block_separator_gap_minutes: gapMinutes,
      min_block_duration_minutes: minBlockMinutes,
      short_blocks_detected: shortBlocksDetected,
      short_blocks_merged: shortBlocksMerged,
      short_blocks_remaining: shortBlocksRemaining,
    },
    perVehicle,
    coverageIssues,
    skippedTrips: skipped,
  };
}
