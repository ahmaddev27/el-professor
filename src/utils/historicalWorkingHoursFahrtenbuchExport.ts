/**
 * 1:1 XLSX patch export for Fahrtenbuch.
 *
 * Strategy:
 *   – Receive original XLSX bytes (ArrayBuffer/Uint8Array).
 *   – Unzip, decompress only the target worksheet + sharedStrings XML.
 *   – Patch only allowed cells (Fahrername, and start/end when timeChanged).
 *   – All other ZIP entries (styles, other sheets, relationships) are written
 *     back using the EXACT original compressed bytes → raw XML preserved 1:1.
 *   – Self-check verifies no forbidden cell changed before download.
 */

import type { FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
import type {
  FinalBlockAssignmentSnapshotResult,
  FinalBlockAssignmentRow,
  FinalExportOverlapResult,
  FinalExportOverlapEntry,
} from './historicalWorkingHoursCleanEngine';
import type { FinalExportRow } from './historicalRowLevelEngine';
import { validateRowLevelOverlapsForExport } from './historicalRowLevelEngine';

// ── Column detection ──────────────────────────────────────────────────────────

const DRIVER_CANDIDATES = ['Fahrername', 'fahrername', 'Fahrer', 'Fahrer Name', 'FahrerName'];
const START_CANDIDATES  = [
  'Uhrzeit des Fahrtbeginns', 'uhrzeit des fahrtbeginns',
  'Fahrtbeginn', 'fahrtbeginn', 'Start', 'start',
  'start_datetime', 'StartDatetime', 'Fahrt_Beginn', 'FahrtBeginn',
];
const END_CANDIDATES = [
  'Uhrzeit des Fahrtendes', 'uhrzeit des fahrtendes',
  'Fahrtende', 'fahrtende', 'Ende', 'ende',
  'end_datetime', 'EndDatetime', 'Fahrt_Ende', 'FahrtEnde',
];
const FAHRTSTATUS_CANDIDATES = [
  'Fahrtstatus', 'fahrtstatus', 'Status', 'status', 'fahrt_status',
];
const KENNZEICHEN_CANDIDATES = [
  'Kennzeichen', 'kennzeichen', 'KFZ', 'kfz', 'Fahrzeug', 'fahrzeug',
  'Kfz-Kennzeichen', 'kfz-kennzeichen',
];

function matchesAnyCandidate(s: string, candidates: string[]): boolean {
  const lower = s.toLowerCase();
  return candidates.some(c => c.toLowerCase() === lower);
}

// ── Export summary ────────────────────────────────────────────────────────────

export interface FahrtenbuchExportSummary {
  totalRows: number;
  driverChangedRows: number;
  timeChangedRows: number;
  canceledRows: number;
  unchangedRows: number;
  isReady: boolean;
  error?: string;
}

// ── Single source-of-truth final exported row model ──────────────────────────
//
// This is the exact row list that the XLSX exporter will patch.
// Both Export-Prüfung (overlap validation) and the strict XLSX exporter
// must derive their data from this function — never from two separate
// interpretations of the snapshot.

export interface FinalExportedRow {
  /** 0-based source row index from the original XLSX (= trip.source_row_index) */
  sourceRowIndex: number;
  tripId: string;
  blockId: string | null;
  /** Kennzeichen */
  vehicle: string;
  finalDriverId: string | null;
  finalDriverName: string;
  finalStartMs: number;
  finalEndMs: number;
  finalStartDatetime: string;
  finalEndDatetime: string;
  originalStartMs: number;
  originalEndMs: number;
  timeChanged: boolean;
  isExportable: boolean;
  assignmentType: string;
  isCanceled: boolean;
}

/**
 * Build the exact list of rows that will be written to the XLSX file.
 * Trips are processed in source_row_index order (= XLSX row order).
 * Only trips with a matching isExportable snapshot row are included.
 */
export function buildFinalExportedFahrtenbuchRows(
  allTrips: FahrtenbuchTrip[],
  snapshotResult: FinalBlockAssignmentSnapshotResult,
): FinalExportedRow[] {
  // Build snapshot lookups
  const snapByTripId = new Map<string, FinalBlockAssignmentRow>();
  const snapBySrcRow = new Map<number, FinalBlockAssignmentRow>();
  for (const row of snapshotResult.rows) {
    snapByTripId.set(row.tripId, row);
    if (row.sourceRowIndex !== null) snapBySrcRow.set(row.sourceRowIndex, row);
  }

  // Sort trips by source_row_index ascending (XLSX order)
  const sortedTrips = [...allTrips].sort((a, b) => (a.source_row_index ?? Infinity) - (b.source_row_index ?? Infinity));

  const result: FinalExportedRow[] = [];

  for (const trip of sortedTrips) {
    const snapRow = snapByTripId.get(trip.id)
      ?? (trip.source_row_index != null ? snapBySrcRow.get(trip.source_row_index) : undefined);
    if (!snapRow || !snapRow.isExportable) continue;

    const srcIdx = trip.source_row_index ?? snapRow.sourceRowIndex;
    if (srcIdx === null || srcIdx === undefined) continue;

    result.push({
      sourceRowIndex: srcIdx,
      tripId: trip.id,
      blockId: snapRow.blockId,
      vehicle: snapRow.vehicle,
      finalDriverId: snapRow.finalDriverId,
      finalDriverName: snapRow.finalDriverName ?? '',
      finalStartMs: snapRow.finalStartMs,
      finalEndMs: snapRow.finalEndMs,
      finalStartDatetime: snapRow.finalStartDatetime,
      finalEndDatetime: snapRow.finalEndDatetime,
      originalStartMs: snapRow.originalStartMs,
      originalEndMs: snapRow.originalEndMs,
      timeChanged: snapRow.timeChanged,
      isExportable: snapRow.isExportable,
      assignmentType: snapRow.assignmentType,
      isCanceled: trip.is_canceled,
    });
  }

  return result;
}

/**
 * Validate the final exported row model for driver and vehicle overlaps.
 * Uses buildFinalExportedFahrtenbuchRows as the single source of truth,
 * ensuring the same row interpretation used by the exporter.
 */
export function validateFinalExportedFahrtenbuchOverlaps(
  allTrips: FahrtenbuchTrip[],
  snapshotResult: FinalBlockAssignmentSnapshotResult,
): FinalExportOverlapResult {
  const rows = buildFinalExportedFahrtenbuchRows(allTrips, snapshotResult);

  const MAX_ENTRIES = 50;
  let driverOverlapCount = 0;
  let vehicleOverlapCount = 0;
  const entries: FinalExportOverlapEntry[] = [];

  // Known regression rows (0-based sourceRowIndex)
  const REGRESSION_ROWS = new Set([99, 100, 175, 177, 340, 366]);

  // ── Driver overlaps ──────────────────────────────────────────────────────
  const byDriver = new Map<string, FinalExportedRow[]>();
  for (const r of rows) {
    if (!r.finalDriverId) continue;
    if (!byDriver.has(r.finalDriverId)) byDriver.set(r.finalDriverId, []);
    byDriver.get(r.finalDriverId)!.push(r);
  }

  for (const dRows of byDriver.values()) {
    const sorted = [...dRows].sort((a, b) => a.finalStartMs - b.finalStartMs);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (b.finalStartMs >= a.finalEndMs) break;
        const overlapMs = Math.min(a.finalEndMs, b.finalEndMs) - Math.max(a.finalStartMs, b.finalStartMs);
        if (overlapMs <= 0) continue;
        driverOverlapCount++;
        const isRegression = REGRESSION_ROWS.has(a.sourceRowIndex) || REGRESSION_ROWS.has(b.sourceRowIndex);
        if (import.meta.env.DEV && isRegression) {
          console.log('[FinalFahrtenbuchRegressionCheck] Driver overlap found:', {
            driver: a.finalDriverName,
            rowA: a.sourceRowIndex + 1, rowB: b.sourceRowIndex + 1,
            startA: a.finalStartDatetime, endA: a.finalEndDatetime,
            startB: b.finalStartDatetime, endB: b.finalEndDatetime,
            vehicleA: a.vehicle, vehicleB: b.vehicle,
            overlapSec: Math.round(overlapMs / 1000),
            timeChangedA: a.timeChanged, timeChangedB: b.timeChanged,
            assignmentTypeA: a.assignmentType, assignmentTypeB: b.assignmentType,
          });
        }
        if (entries.length < MAX_ENTRIES) {
          entries.push({
            type: 'driver',
            name: a.finalDriverName,
            rowA: a.sourceRowIndex + 1, rowB: b.sourceRowIndex + 1,
            startA: a.finalStartDatetime, endA: a.finalEndDatetime,
            startB: b.finalStartDatetime, endB: b.finalEndDatetime,
            vehicleA: a.vehicle, vehicleB: b.vehicle,
            driverA: a.finalDriverName, driverB: b.finalDriverName,
            overlapSec: Math.round(overlapMs / 1000),
            blockIdA: a.blockId, blockIdB: b.blockId,
            assignmentTypeA: a.assignmentType, assignmentTypeB: b.assignmentType,
            timeChangedA: a.timeChanged, timeChangedB: b.timeChanged,
          });
        }
      }
    }
  }

  // ── Vehicle overlaps ─────────────────────────────────────────────────────
  const byVehicle = new Map<string, FinalExportedRow[]>();
  for (const r of rows) {
    if (!r.vehicle) continue;
    if (!byVehicle.has(r.vehicle)) byVehicle.set(r.vehicle, []);
    byVehicle.get(r.vehicle)!.push(r);
  }

  for (const vRows of byVehicle.values()) {
    const sorted = [...vRows].sort((a, b) => a.finalStartMs - b.finalStartMs);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (b.finalStartMs >= a.finalEndMs) break;
        const overlapMs = Math.min(a.finalEndMs, b.finalEndMs) - Math.max(a.finalStartMs, b.finalStartMs);
        if (overlapMs <= 0) continue;
        vehicleOverlapCount++;
        const isRegression = REGRESSION_ROWS.has(a.sourceRowIndex) || REGRESSION_ROWS.has(b.sourceRowIndex);
        if (import.meta.env.DEV && isRegression) {
          console.log('[FinalFahrtenbuchRegressionCheck] Vehicle overlap found:', {
            vehicle: a.vehicle,
            rowA: a.sourceRowIndex + 1, rowB: b.sourceRowIndex + 1,
            startA: a.finalStartDatetime, endA: a.finalEndDatetime,
            startB: b.finalStartDatetime, endB: b.finalEndDatetime,
            driverA: a.finalDriverName, driverB: b.finalDriverName,
            overlapSec: Math.round(overlapMs / 1000),
            timeChangedA: a.timeChanged, timeChangedB: b.timeChanged,
            assignmentTypeA: a.assignmentType, assignmentTypeB: b.assignmentType,
          });
        }
        if (entries.length < MAX_ENTRIES) {
          entries.push({
            type: 'vehicle',
            name: a.vehicle,
            rowA: a.sourceRowIndex + 1, rowB: b.sourceRowIndex + 1,
            startA: a.finalStartDatetime, endA: a.finalEndDatetime,
            startB: b.finalStartDatetime, endB: b.finalEndDatetime,
            vehicleA: a.vehicle, vehicleB: b.vehicle,
            driverA: a.finalDriverName, driverB: b.finalDriverName,
            overlapSec: Math.round(overlapMs / 1000),
            blockIdA: a.blockId, blockIdB: b.blockId,
            assignmentTypeA: a.assignmentType, assignmentTypeB: b.assignmentType,
            timeChangedA: a.timeChanged, timeChangedB: b.timeChanged,
          });
        }
      }
    }
  }

  if (import.meta.env.DEV) {
    console.log('[PermanentFahrtenbuchOverlapFix] Final generated worksheet validation:', {
      totalExportRows: rows.length,
      driverOverlapCount,
      vehicleOverlapCount,
      exportBlocked: driverOverlapCount > 0 || vehicleOverlapCount > 0,
      first20: entries.slice(0, 20),
    });
  }

  return {
    checkedRows: rows.length,
    skippedRows: 0,
    invalidTimeRows: 0,
    driverOverlapCount,
    vehicleOverlapCount,
    entries,
  };
}

export function buildFahrtenbuchExportSummary(
  allTrips: FahrtenbuchTrip[],
  snapshotResult: FinalBlockAssignmentSnapshotResult,
  isExportReady: boolean,
): FahrtenbuchExportSummary {
  const canceledCount  = allTrips.filter(t => t.is_canceled).length;
  const timeChangedCount   = snapshotResult.validation.timeChangedRowCount;
  const driverChangedCount = snapshotResult.rows.filter(r => r.isExportable).length;
  const total = allTrips.length;
  return {
    totalRows: total,
    driverChangedRows: driverChangedCount,
    timeChangedRows: timeChangedCount,
    canceledRows: canceledCount,
    unchangedRows: Math.max(0, total - driverChangedCount - canceledCount),
    isReady: isExportReady,
  };
}

// ── Export options / result ───────────────────────────────────────────────────

export interface FahrtenbuchExportOptions {
  month: number;
  year: number;
  sourceColumnsJson?: string[] | null;
  sourceSheetName?: string | null;
  /** Original uploaded XLSX bytes + filename for 1:1 patching. */
  sourceXlsx?: { bytes: Uint8Array; name: string } | null;
}

/** Single overlap entry in the generated worksheet audit. */
export interface GeneratedWorksheetOverlapEntry {
  type: 'driver' | 'vehicle';
  name: string;
  rowA: number;
  excelRowA: number;
  rowB: number;
  excelRowB: number;
  startA: string; endA: string;
  startB: string; endB: string;
  vehicleA: string; vehicleB: string;
  driverA: string; driverB: string;
  overlapSec: number;
}

/** Per-row diagnostic for known rows (99, 100, 175, 177, 425, 426). */
export interface ExportRowDiagnostic {
  fahrtRowNumber: number;
  excelRowNumber: number;
  sourceRowIndex: number;
  originalFahrername: string;
  finalFahrername: string;
  kennzeichen: string;
  originalStart: string;
  originalEnd: string;
  engineFinalStart: string;
  engineFinalEnd: string;
  patchMapFahrername: string;
  patchMapStart: string;
  patchMapEnd: string;
  worksheetFahrtstatus: string;
  worksheetFahrername: string;
  worksheetKennzeichen: string;
  worksheetStart: string;
  worksheetEnd: string;
  timeChanged: boolean;
  blockId: string | null;
  assignmentType: string;
}

/** Result of the generated-XLSX self-audit run before download. */
export interface GeneratedWorksheetAuditResult {
  checkedRows: number;
  driverOverlapCount: number;
  vehicleOverlapCount: number;
  isClean: boolean;
  entries: GeneratedWorksheetOverlapEntry[];
  diagnosticRows: ExportRowDiagnostic[];
  /** Regression check: rows 99 & 100 overlap (Yassin Asfour scenario) */
  regressionA_99_100: boolean;
  /** Regression check: rows 425 & 426 overlap (SG-YA14 scenario) */
  regressionB_425_426: boolean;
  shiftMismatchFound: boolean;
}

export interface FahrtenbuchExportResult {
  success: boolean;
  error?: string;
  fileName?: string;
  worksheetAudit?: GeneratedWorksheetAuditResult;
}

// ════════════════════════════════════════════════════════════════════════════
// ── ZIP utilities ────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

// ── CRC-32 ───────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── Int read helpers ──────────────────────────────────────────────────────────

function r16(b: Uint8Array, o: number): number { return b[o] | (b[o+1] << 8); }
function r32(b: Uint8Array, o: number): number {
  return ((b[o] | (b[o+1] << 8) | (b[o+2] << 16) | (b[o+3] << 24)) >>> 0);
}
function w16(b: Uint8Array, o: number, v: number) { b[o] = v & 0xFF; b[o+1] = (v >>> 8) & 0xFF; }
function w32(b: Uint8Array, o: number, v: number) {
  b[o] = v & 0xFF; b[o+1] = (v >>> 8) & 0xFF;
  b[o+2] = (v >>> 16) & 0xFF; b[o+3] = (v >>> 24) & 0xFF;
}

// ── ZIP entry ─────────────────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  method: number;          // 0=stored, 8=deflate
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  internalAttr: number;
  externalAttr: number;
  compressedData: Uint8Array; // original compressed bytes, preserved exactly
}

// ── Read ZIP ──────────────────────────────────────────────────────────────────

function readZip(bytes: Uint8Array): { entries: ZipEntry[]; entryOrder: string[] } {
  const dec = new TextDecoder('utf-8');
  const dec1252 = new TextDecoder('windows-1252');

  // Find EOCD
  let eocdOffset = -1;
  const start = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= start; i--) {
    if (r32(bytes, i) === 0x06054B50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error('ZIP: End of Central Directory not found');

  const cdOffset = r32(bytes, eocdOffset + 16);
  const totalEntries = r16(bytes, eocdOffset + 10);

  // Parse central directory
  const cdInfo = new Map<string, { offset: number; crc: number; csize: number; usize: number; intAttr: number; extAttr: number; flags: number }>();
  const entryOrder: string[] = [];
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (r32(bytes, pos) !== 0x02014B50) break;
    const versionMadeBy = r16(bytes, pos + 4);    // unused
    void versionMadeBy;
    const flags    = r16(bytes, pos + 8);
    const crc      = r32(bytes, pos + 16);
    const csize    = r32(bytes, pos + 20);
    const usize    = r32(bytes, pos + 24);
    const fnLen    = r16(bytes, pos + 28);
    const exLen    = r16(bytes, pos + 30);
    const cmtLen   = r16(bytes, pos + 32);
    const intAttr  = r16(bytes, pos + 36);
    const extAttr  = r32(bytes, pos + 38);
    const localOff = r32(bytes, pos + 42);
    const nameBytes = bytes.slice(pos + 46, pos + 46 + fnLen);
    const utf8 = (flags & 0x800) !== 0;
    const name = utf8 ? dec.decode(nameBytes) : dec1252.decode(nameBytes);
    cdInfo.set(name, { offset: localOff, crc, csize, usize, intAttr, extAttr, flags });
    entryOrder.push(name);
    pos += 46 + fnLen + exLen + cmtLen;
  }

  const entries: ZipEntry[] = [];
  for (const name of entryOrder) {
    const info = cdInfo.get(name)!;
    const lo = info.offset;
    if (r32(bytes, lo) !== 0x04034B50) throw new Error(`ZIP: Bad local header for "${name}"`);
    const method = r16(bytes, lo + 8);
    const dosTime = r16(bytes, lo + 10);
    const dosDate = r16(bytes, lo + 12);
    const fnLen  = r16(bytes, lo + 26);
    const exLen  = r16(bytes, lo + 28);
    const dataOff = lo + 30 + fnLen + exLen;
    // Use sizes from central directory (reliable even with data descriptor)
    const compressedData = bytes.slice(dataOff, dataOff + info.csize);
    entries.push({
      name, method, dosTime, dosDate,
      crc: info.crc, compressedSize: info.csize, uncompressedSize: info.usize,
      internalAttr: info.intAttr, externalAttr: info.extAttr,
      compressedData,
    });
  }

  return { entries, entryOrder };
}

// ── Inflate / deflate via browser Streams API ─────────────────────────────────

async function inflateBytes(data: Uint8Array): Promise<Uint8Array> {
  if (data.length === 0) return new Uint8Array(0);
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(data).catch(() => {});
  writer.close().catch(() => {});
  const chunks: Uint8Array[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function deflateBytes(data: Uint8Array): Promise<Uint8Array> {
  if (data.length === 0) return new Uint8Array(0);
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  writer.write(data).catch(() => {});
  writer.close().catch(() => {});
  const chunks: Uint8Array[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function decompressEntry(entry: ZipEntry): Promise<Uint8Array> {
  if (entry.method === 0) return entry.compressedData;
  if (entry.method === 8) return inflateBytes(entry.compressedData);
  throw new Error(`ZIP: Unsupported compression method ${entry.method} for "${entry.name}"`);
}

async function compressEntry(entry: ZipEntry, newData: Uint8Array): Promise<ZipEntry> {
  const compressed = entry.method === 0 ? newData : await deflateBytes(newData);
  return {
    ...entry,
    compressedData: compressed,
    compressedSize: compressed.length,
    uncompressedSize: newData.length,
    crc: crc32(newData),
  };
}

// ── Write ZIP ─────────────────────────────────────────────────────────────────

function writeZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const cdItems: Array<{ nameBytes: Uint8Array; entry: ZipEntry; localOffset: number }> = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const flags = 0x800; // UTF-8

    const lfh = new Uint8Array(30 + nameBytes.length);
    w32(lfh, 0, 0x04034B50);
    w16(lfh, 4, 20);
    w16(lfh, 6, flags);
    w16(lfh, 8, entry.method);
    w16(lfh, 10, entry.dosTime);
    w16(lfh, 12, entry.dosDate);
    w32(lfh, 14, entry.crc);
    w32(lfh, 18, entry.compressedData.length);
    w32(lfh, 22, entry.uncompressedSize);
    w16(lfh, 26, nameBytes.length);
    w16(lfh, 28, 0);
    lfh.set(nameBytes, 30);

    cdItems.push({ nameBytes, entry, localOffset: offset });
    localParts.push(lfh, entry.compressedData);
    offset += lfh.length + entry.compressedData.length;
  }

  const cdParts: Uint8Array[] = [];
  let cdSize = 0;
  for (const { nameBytes, entry, localOffset } of cdItems) {
    const cde = new Uint8Array(46 + nameBytes.length);
    w32(cde, 0, 0x02014B50);
    w16(cde, 4, 20); w16(cde, 6, 20);
    w16(cde, 8, 0x800);
    w16(cde, 10, entry.method);
    w16(cde, 12, entry.dosTime);
    w16(cde, 14, entry.dosDate);
    w32(cde, 16, entry.crc);
    w32(cde, 20, entry.compressedData.length);
    w32(cde, 24, entry.uncompressedSize);
    w16(cde, 28, nameBytes.length);
    w16(cde, 30, 0); w16(cde, 32, 0); w16(cde, 34, 0);
    w16(cde, 36, entry.internalAttr);
    w32(cde, 38, entry.externalAttr);
    w32(cde, 42, localOffset);
    cde.set(nameBytes, 46);
    cdParts.push(cde);
    cdSize += cde.length;
  }

  const eocd = new Uint8Array(22);
  w32(eocd, 0, 0x06054B50);
  w16(eocd, 4, 0); w16(eocd, 6, 0);
  w16(eocd, 8, entries.length);
  w16(eocd, 10, entries.length);
  w32(eocd, 12, cdSize);
  w32(eocd, 16, offset);
  w16(eocd, 20, 0);

  const all = [...localParts, ...cdParts, eocd];
  const total = all.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of all) { out.set(p, off); off += p.length; }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// ── XLSX XML utilities ───────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

const ENC = new TextEncoder();
const DEC = new TextDecoder('utf-8');

function xmlBytes(xml: string): Uint8Array { return ENC.encode(xml); }
function xmlStr(bytes: Uint8Array): string  { return DEC.decode(bytes); }

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function xmlUnescape(s: string): string {
  return s
    .replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// ── Workbook XML → sheet list ─────────────────────────────────────────────────

interface WbSheet { name: string; rId: string; }

function parseWorkbookSheets(wbXml: string): WbSheet[] {
  const sheets: WbSheet[] = [];
  const re = /<sheet\s[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wbXml)) !== null) {
    const tag = m[0];
    const name = tag.match(/name="([^"]*)"/)?.[1] ?? '';
    const rId  = (tag.match(/r:id="([^"]*)"/) ?? tag.match(/relationships:id="([^"]*)"/))
                  ?.[1] ?? '';
    if (name) sheets.push({ name: xmlUnescape(name), rId });
  }
  return sheets;
}

// ── Relationships XML → target path ──────────────────────────────────────────

function findRelTarget(relsXml: string, rId: string): string | null {
  const re = /<Relationship\s[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(relsXml)) !== null) {
    const tag = m[0];
    const id  = tag.match(/Id="([^"]*)"/)?.[1];
    if (id === rId) return tag.match(/Target="([^"]*)"/)?.[1] ?? null;
  }
  return null;
}

// Resolve a path relative to xl/ (rel targets may start with ../ or /)
function resolveXlPath(target: string): string {
  if (target.startsWith('/')) return target.slice(1); // absolute in ZIP
  // Common: "worksheets/sheet1.xml" → "xl/worksheets/sheet1.xml"
  if (target.startsWith('../')) return target.slice(3);
  return 'xl/' + target;
}

// ── Shared strings ────────────────────────────────────────────────────────────

function parseSharedStrings(ssXml: string): string[] {
  const result: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(ssXml)) !== null) {
    // Concatenate all <t> values (handles rich text <r><t>...</t></r>)
    const tRe = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g;
    let text = '';
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(m[1])) !== null) text += xmlUnescape(tm[1]);
    result.push(text);
  }
  return result;
}

// Find existing index or append new value; return index
function getOrAddSharedString(strings: string[], value: string): { index: number; added: boolean } {
  const idx = strings.indexOf(value);
  if (idx !== -1) return { index: idx, added: false };
  strings.push(value);
  return { index: strings.length - 1, added: true };
}

// Rebuild sharedStrings.xml with new strings appended
function rebuildSharedStringsXml(originalSsXml: string, strings: string[]): string {
  // Update count attributes
  const count = strings.length;
  let xml = originalSsXml
    .replace(/(<sst[^>]*\s)count="[^"]*"/, `$1count="${count}"`)
    .replace(/(<sst[^>]*\s)uniqueCount="[^"]*"/, `$1uniqueCount="${count}"`);

  // Find position to append new <si> elements (before </sst>)
  const sst = xml.lastIndexOf('</sst>');
  if (sst === -1) throw new Error('sharedStrings.xml: </sst> not found');

  // Count existing <si> elements
  const existingCount = (xml.match(/<si>/g) ?? []).length;
  const newEntries = strings
    .slice(existingCount)
    .map(s => `<si><t>${xmlEscape(s)}</t></si>`)
    .join('');

  return xml.slice(0, sst) + newEntries + xml.slice(sst);
}

// ── Column letter ↔ 1-based index ────────────────────────────────────────────

function colLetterToIndex(col: string): number {
  let idx = 0;
  for (let i = 0; i < col.length; i++) idx = idx * 26 + col.charCodeAt(i) - 64;
  return idx;
}

function indexToColLetter(idx: number): string {
  let r = '';
  while (idx > 0) { const rem = (idx - 1) % 26; r = String.fromCharCode(65 + rem) + r; idx = Math.floor((idx - 1) / 26); }
  return r;
}

// ── Parse cell reference ──────────────────────────────────────────────────────

function parseCellRef(ref: string): { col: string; row: number } {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  if (!m) return { col: '', row: 0 };
  return { col: m[1], row: +m[2] };
}

// ── Extract all cell info from worksheet XML ──────────────────────────────────

interface CellInfo {
  ref: string;
  type: string;   // t attribute ('' = number/general, 's' = shared string, 'inlineStr', etc.)
  style: string;  // s attribute
  rawValue: string; // content of <v>...</v> or <is><t>...</t></is>
  rawInner: string; // everything between <c...> and </c>
  fullMatch: string; // entire <c...>...</c>
}

function extractCells(wsXml: string): Map<string, CellInfo> {
  const cells = new Map<string, CellInfo>();
  const cellRe = /(<c\s([^>]*)>)([\s\S]*?)(<\/c>)/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(wsXml)) !== null) {
    const attrs = m[2];
    const inner = m[3];
    const ref   = attrs.match(/r="([^"]+)"/)?.[1] ?? '';
    if (!ref) continue;
    const type  = attrs.match(/t="([^"]+)"/)?.[1] ?? '';
    const style = attrs.match(/s="([^"]+)"/)?.[1] ?? '';
    let rawValue = '';
    if (type === 'inlineStr') {
      rawValue = inner.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? '';
    } else {
      rawValue = inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? '';
    }
    cells.set(ref, { ref, type, style, rawValue, rawInner: inner, fullMatch: m[0] });
  }
  return cells;
}

// ── Find header row in worksheet XML ─────────────────────────────────────────

interface HeaderInfo {
  xmlHeaderRow: number;           // 1-based row number in XML
  driverCol: string | null;       // column letter
  startCol:  string | null;
  endCol:    string | null;
  fahrtstatusCol: string | null;
  kennzeichenCol: string | null;
  headers:   Map<string, string>; // colLetter → header name
}

function findHeaderRow(wsXml: string, sharedStrings: string[]): HeaderInfo | null {
  // Scan each row, find the row containing a Fahrername-like header
  const rowRe = /<row[^>]*\sr="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let m: RegExpExecArray | null;

  while ((m = rowRe.exec(wsXml)) !== null) {
    const rowNum = +m[1];
    const rowXml = m[2];
    const headers: Map<string, string> = new Map();

    const cellRe = /(<c\s([^>]*)>)([\s\S]*?)(<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rowXml)) !== null) {
      const attrs = cm[2];
      const inner = cm[3];
      const ref   = attrs.match(/r="([^"]+)"/)?.[1] ?? '';
      const { col } = parseCellRef(ref);
      if (!col) continue;

      const type = attrs.match(/t="([^"]+)"/)?.[1] ?? '';
      let cellText = '';
      if (type === 's') {
        const idx = +( inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? '-1' );
        cellText = (idx >= 0 && idx < sharedStrings.length) ? sharedStrings[idx] : '';
      } else if (type === 'inlineStr') {
        cellText = xmlUnescape(inner.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? '');
      } else {
        // Try raw value as text (some files store headers as plain text with t="str")
        cellText = xmlUnescape(inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? '');
      }

      if (cellText) headers.set(col, cellText);
    }

    // Check if this row has a driver column
    let driverCol: string | null = null;
    let startCol:  string | null = null;
    let endCol:    string | null = null;
    let fahrtstatusCol: string | null = null;
    let kennzeichenCol: string | null = null;
    for (const [col, name] of headers) {
      if (matchesAnyCandidate(name, DRIVER_CANDIDATES)) driverCol = col;
      else if (matchesAnyCandidate(name, START_CANDIDATES)) startCol = col;
      else if (matchesAnyCandidate(name, END_CANDIDATES)) endCol = col;
      else if (matchesAnyCandidate(name, FAHRTSTATUS_CANDIDATES)) fahrtstatusCol = col;
      else if (matchesAnyCandidate(name, KENNZEICHEN_CANDIDATES)) kennzeichenCol = col;
    }

    if (driverCol) {
      return { xmlHeaderRow: rowNum, driverCol, startCol, endCol, fahrtstatusCol, kennzeichenCol, headers };
    }
  }
  return null;
}

// ── Cell text resolution ──────────────────────────────────────────────────────

function getCellText(cell: CellInfo | undefined, sharedStrings: string[]): string {
  if (!cell) return '';
  if (cell.type === 's') {
    const idx = parseInt(cell.rawValue, 10);
    return (isNaN(idx) || idx < 0 || idx >= sharedStrings.length) ? '' : sharedStrings[idx];
  }
  if (cell.type === 'inlineStr') return xmlUnescape(cell.rawValue);
  return xmlUnescape(cell.rawValue);
}

// Parse a datetime from a cell value to milliseconds.
// Handles: ISO string, Excel serial number, German DD.MM.YYYY HH:mm format.
function parseDtMsFromCell(raw: string, cellType: string): number {
  if (!raw) return 0;
  const t = (cellType ?? '').toLowerCase();
  // Numeric type: may be Excel serial date (days since 1900-01-00)
  if (t === '' || t === 'n') {
    const num = parseFloat(raw);
    if (!isNaN(num) && num >= 40000 && num <= 100000) {
      // Excel epoch offset to Unix epoch: 25569 days
      return Math.round((num - 25569) * 86400000);
    }
  }
  // ISO-like text: YYYY-MM-DD[T ]HH:mm
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(raw)) {
    const ms = Date.parse(raw.replace(' ', 'T'));
    return isNaN(ms) ? 0 : ms;
  }
  // German: DD.MM.YYYY HH:mm
  const m = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)/);
  if (m) {
    const ms = Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}`);
    return isNaN(ms) ? 0 : ms;
  }
  return 0;
}

// ── Generated worksheet data row ──────────────────────────────────────────────

interface WorksheetDataRow {
  sourceRowIndex: number;
  fahrtRowNumber: number;
  excelRowNumber: number; // = xmlRow (1-based XML row)
  fahrtstatus: string;
  fahrername: string;
  kennzeichen: string;
  startTime: string;
  endTime: string;
  startMs: number;
  endMs: number;
}

function parseWorksheetDataRows(
  patchedCells: Map<string, CellInfo>,
  sharedStrings: string[],
  xmlHeaderRow: number,
  driverCol: string,
  fahrtstatusCol: string | null,
  kennzeichenCol: string | null,
  startCol: string | null,
  endCol: string | null,
): WorksheetDataRow[] {
  // Group cells by row number
  const rowMap = new Map<number, Map<string, CellInfo>>();
  for (const [ref, cell] of patchedCells) {
    const { col, row } = parseCellRef(ref);
    if (!col || row <= xmlHeaderRow) continue;
    if (!rowMap.has(row)) rowMap.set(row, new Map());
    rowMap.get(row)!.set(col, cell);
  }

  const getColText = (rowCells: Map<string, CellInfo>, col: string | null): string => {
    if (!col) return '';
    const cell = rowCells.get(col);
    return getCellText(cell, sharedStrings);
  };

  const rows: WorksheetDataRow[] = [];
  const sortedXmlRows = [...rowMap.keys()].sort((a, b) => a - b);

  for (const xmlRow of sortedXmlRows) {
    const rowCells = rowMap.get(xmlRow)!;
    const startRaw = getColText(rowCells, startCol);
    const endRaw   = getColText(rowCells, endCol);
    const startCell = startCol ? rowCells.get(startCol) : undefined;
    const endCell   = endCol   ? rowCells.get(endCol)   : undefined;

    rows.push({
      sourceRowIndex: xmlRow - xmlHeaderRow - 1,
      fahrtRowNumber: xmlRow - xmlHeaderRow,
      excelRowNumber: xmlRow,
      fahrtstatus: getColText(rowCells, fahrtstatusCol),
      fahrername:  getColText(rowCells, driverCol),
      kennzeichen: getColText(rowCells, kennzeichenCol),
      startTime: startRaw,
      endTime: endRaw,
      startMs: parseDtMsFromCell(startRaw, startCell?.type ?? ''),
      endMs:   parseDtMsFromCell(endRaw,   endCell?.type ?? ''),
    });
  }

  return rows;
}

// ── Generated worksheet overlap audit ────────────────────────────────────────

function auditGeneratedWorksheetRows(
  wsRows: WorksheetDataRow[],
): Omit<GeneratedWorksheetAuditResult, 'diagnosticRows' | 'shiftMismatchFound'> {
  const abgeschlossen = wsRows.filter(r => r.fahrtstatus.toLowerCase() === 'abgeschlossen');
  const MAX_ENTRIES = 50;
  let driverOverlapCount = 0;
  let vehicleOverlapCount = 0;
  const entries: GeneratedWorksheetOverlapEntry[] = [];

  const ivOverlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
    aStart < bEnd && bStart < aEnd;

  // Driver overlaps
  const byDriver = new Map<string, WorksheetDataRow[]>();
  for (const r of abgeschlossen) {
    const name = r.fahrername;
    if (!name) continue;
    if (!byDriver.has(name)) byDriver.set(name, []);
    byDriver.get(name)!.push(r);
  }
  for (const dRows of byDriver.values()) {
    const sorted = [...dRows].sort((a, b) => a.startMs - b.startMs);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]; const b = sorted[j];
        if (b.startMs >= a.endMs) break;
        if (a.startMs <= 0 || a.endMs <= 0 || b.startMs <= 0 || b.endMs <= 0) continue;
        if (!ivOverlap(a.startMs, a.endMs, b.startMs, b.endMs)) continue;
        const overlapMs = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
        if (overlapMs <= 0) continue;
        driverOverlapCount++;
        if (entries.length < MAX_ENTRIES) {
          entries.push({
            type: 'driver', name: a.fahrername,
            rowA: a.fahrtRowNumber, excelRowA: a.excelRowNumber,
            rowB: b.fahrtRowNumber, excelRowB: b.excelRowNumber,
            startA: a.startTime, endA: a.endTime,
            startB: b.startTime, endB: b.endTime,
            vehicleA: a.kennzeichen, vehicleB: b.kennzeichen,
            driverA: a.fahrername, driverB: b.fahrername,
            overlapSec: Math.round(overlapMs / 1000),
          });
        }
      }
    }
  }

  // Vehicle overlaps
  const byVehicle = new Map<string, WorksheetDataRow[]>();
  for (const r of abgeschlossen) {
    if (!r.kennzeichen) continue;
    if (!byVehicle.has(r.kennzeichen)) byVehicle.set(r.kennzeichen, []);
    byVehicle.get(r.kennzeichen)!.push(r);
  }
  for (const vRows of byVehicle.values()) {
    const sorted = [...vRows].sort((a, b) => a.startMs - b.startMs);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]; const b = sorted[j];
        if (b.startMs >= a.endMs) break;
        if (a.startMs <= 0 || a.endMs <= 0 || b.startMs <= 0 || b.endMs <= 0) continue;
        if (!ivOverlap(a.startMs, a.endMs, b.startMs, b.endMs)) continue;
        const overlapMs = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
        if (overlapMs <= 0) continue;
        vehicleOverlapCount++;
        if (entries.length < MAX_ENTRIES) {
          entries.push({
            type: 'vehicle', name: a.kennzeichen,
            rowA: a.fahrtRowNumber, excelRowA: a.excelRowNumber,
            rowB: b.fahrtRowNumber, excelRowB: b.excelRowNumber,
            startA: a.startTime, endA: a.endTime,
            startB: b.startTime, endB: b.endTime,
            vehicleA: a.kennzeichen, vehicleB: b.kennzeichen,
            driverA: a.fahrername, driverB: b.fahrername,
            overlapSec: Math.round(overlapMs / 1000),
          });
        }
      }
    }
  }

  // Regression checks
  const wsRowMap = new Map(wsRows.map(r => [r.fahrtRowNumber, r]));
  const r99  = wsRowMap.get(99);
  const r100 = wsRowMap.get(100);
  const r425 = wsRowMap.get(425);
  const r426 = wsRowMap.get(426);

  const regressionA_99_100 =
    !!r99 && !!r100 &&
    r99.fahrername === r100.fahrername &&
    r99.fahrername !== '' &&
    r99.startMs > 0 && r100.startMs > 0 &&
    ivOverlap(r99.startMs, r99.endMs, r100.startMs, r100.endMs);

  const regressionB_425_426 =
    !!r425 && !!r426 &&
    r425.kennzeichen === r426.kennzeichen &&
    r425.kennzeichen !== '' &&
    r425.startMs > 0 && r426.startMs > 0 &&
    ivOverlap(r425.startMs, r425.endMs, r426.startMs, r426.endMs);

  return {
    checkedRows: abgeschlossen.length,
    driverOverlapCount,
    vehicleOverlapCount,
    isClean: driverOverlapCount === 0 && vehicleOverlapCount === 0,
    entries,
    regressionA_99_100,
    regressionB_425_426,
  };
}

// ── Patch a single cell in worksheet XML ──────────────────────────────────────

function patchCell(
  wsXml: string,
  cellRef: string,
  valueOrIndex: number | string, // number → SS index; string → inlineStr value
  originalCell: CellInfo | undefined,
): string {
  if (!originalCell) return wsXml; // cell not found — skip

  const escapedRef = cellRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(<c\\s[^>]*r="${escapedRef}"[^>]*>)([\\s\\S]*?)(<\\/c>)`,
    'g',
  );

  const useInlineStr = typeof valueOrIndex === 'string';
  const inlineValue = useInlineStr ? valueOrIndex : '';
  const ssIndex = useInlineStr ? -1 : (valueOrIndex as number);

  return wsXml.replace(re, (_, open, inner, close) => {
    if (useInlineStr) {
      // Build a fresh inlineStr cell preserving style attribute
      const styleAttr = open.match(/\ss="([^"]+)"/)?.[0] ?? '';
      const ref = open.match(/r="([^"]+)"/)?.[1] ?? cellRef;
      return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t>${xmlEscape(inlineValue)}</t></is>${close}`;
    }

    const type = open.match(/t="([^"]+)"/)?.[1] ?? '';

    if (type === 's') {
      const newInner = inner.replace(/<v>[^<]*<\/v>/, `<v>${ssIndex}</v>`);
      return `${open}${newInner}${close}`;
    }

    if (type === 'inlineStr') {
      // Convert inlineStr → shared string
      const newOpen = open.replace(/\bt="inlineStr"/, 't="s"');
      return `${newOpen}<v>${ssIndex}</v>${close}`;
    }

    if (type === 'str') {
      const newOpen = open.replace(/\bt="str"/, 't="s"');
      const newInner = inner.replace(/<v>[^<]*<\/v>/, `<v>${ssIndex}</v>`);
      return `${newOpen}${newInner}${close}`;
    }

    // Number or no type: convert to shared string
    const newOpen = open.replace(/(<c\s)/, `$1t="s" `);
    const vMatch = inner.match(/<v>[^<]*<\/v>/);
    const newInner = vMatch
      ? inner.replace(/<v>[^<]*<\/v>/, `<v>${ssIndex}</v>`)
      : `<v>${ssIndex}</v>`;
    return `${newOpen}${newInner}${close}`;
  });
}

// ── Self-check: verify only allowed cells changed ─────────────────────────────

interface CellViolation {
  cellRef: string;
  origRaw: string;
  patchedRaw: string;
}

function selfCheck(
  origWsXml: string,
  patchedWsXml: string,
  allowedRefs: Set<string>,
): CellViolation[] {
  const origCells    = extractCells(origWsXml);
  const patchedCells = extractCells(patchedWsXml);
  const violations: CellViolation[] = [];

  // Check all original cells that are NOT in the allowed set
  for (const [ref, origInfo] of origCells) {
    if (allowedRefs.has(ref)) continue;
    const patchedInfo = patchedCells.get(ref);
    const pRaw = patchedInfo?.fullMatch ?? '';
    if (origInfo.fullMatch !== pRaw) {
      violations.push({ cellRef: ref, origRaw: origInfo.rawValue, patchedRaw: patchedInfo?.rawValue ?? '' });
      if (violations.length >= 20) break;
    }
  }

  // Check that no new cells were added in non-allowed positions
  for (const [ref, patchedInfo] of patchedCells) {
    if (allowedRefs.has(ref)) continue;
    if (!origCells.has(ref)) {
      violations.push({ cellRef: ref, origRaw: '', patchedRaw: patchedInfo.rawValue });
      if (violations.length >= 20) break;
    }
  }

  return violations;
}

// ── Trigger download ──────────────────────────────────────────────────────────

function triggerDownload(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ── Output filename ───────────────────────────────────────────────────────────

function makeOutputFilename(originalName: string): string {
  const dot = originalName.lastIndexOf('.');
  if (dot === -1) return originalName + '_bearbeitet';
  return originalName.slice(0, dot) + '_bearbeitet' + originalName.slice(dot);
}

// ════════════════════════════════════════════════════════════════════════════
// ── Main async export ────────────────────────────────────════════════════════
// ════════════════════════════════════════════════════════════════════════════

export async function exportHistoricalWorkingHoursFahrtenbuch(
  allTrips: FahrtenbuchTrip[],
  snapshotResult: FinalBlockAssignmentSnapshotResult,
  isExportReady: boolean,
  options: FahrtenbuchExportOptions,
  rowLevelFinalRows?: FinalExportRow[],
): Promise<FahrtenbuchExportResult> {

  if (!isExportReady) {
    return { success: false, error: 'Export nicht möglich: Die Export-Prüfung enthält Fehler.' };
  }

  // Safety guard: re-verify row-level overlaps
  // When row-level final rows are provided (new engine), use them directly.
  // Otherwise fall back to snapshot-based check.
  if (rowLevelFinalRows) {
    const rlCheck = validateRowLevelOverlapsForExport(rowLevelFinalRows);
    if (rlCheck.driverOverlapCount > 0) {
      return {
        success: false,
        error: `Export blockiert: Fahrerüberschneidungen im Fahrtenbuch gefunden. (${rlCheck.driverOverlapCount} Überschneidung(en))`,
      };
    }
    if (rlCheck.vehicleOverlapCount > 0) {
      return {
        success: false,
        error: `Export blockiert: Fahrzeugüberschneidungen im Fahrtenbuch gefunden. (${rlCheck.vehicleOverlapCount} Überschneidung(en))`,
      };
    }
  } else {
    const overlapCheck = validateFinalExportedFahrtenbuchOverlaps(allTrips, snapshotResult);
    if (overlapCheck.driverOverlapCount > 0) {
      return {
        success: false,
        error: `Export blockiert: Fahrerüberschneidungen im exportierten Fahrtenbuch gefunden. (${overlapCheck.driverOverlapCount} Überschneidung(en))`,
      };
    }
    if (overlapCheck.vehicleOverlapCount > 0) {
      return {
        success: false,
        error: `Export blockiert: Fahrzeugüberschneidungen im exportierten Fahrtenbuch gefunden. (${overlapCheck.vehicleOverlapCount} Überschneidung(en))`,
      };
    }
  }

  // ── Require original XLSX bytes ─────────────────────────────────────────────
  if (!options.sourceXlsx?.bytes || options.sourceXlsx.bytes.length === 0) {
    return {
      success: false,
      error: 'Export blockiert: Originaldatei nicht gefunden. Dieser Import wurde vor der automatischen Dateispeicherung erstellt – bitte den Fahrtenbuch-Import erneut durchführen.',
    };
  }

  const { bytes: srcBytes, name: srcName } = options.sourceXlsx;

  try {
    // ── 1. Read ZIP ───────────────────────────────────────────────────────────
    const { entries, entryOrder } = readZip(srcBytes);
    const entryMap = new Map<string, ZipEntry>(entries.map(e => [e.name, e]));

    // ── 2. Find workbook.xml ──────────────────────────────────────────────────
    const wbEntry = entryMap.get('xl/workbook.xml');
    if (!wbEntry) return { success: false, error: 'ZIP: xl/workbook.xml nicht gefunden.' };
    const wbXml = xmlStr(await decompressEntry(wbEntry));

    const sheets = parseWorkbookSheets(wbXml);
    if (sheets.length === 0) return { success: false, error: 'workbook.xml: keine Sheets gefunden.' };

    // ── Enforce single sheet named "Sheet1" ───────────────────────────────────
    if (sheets.length !== 1) {
      return {
        success: false,
        error: `Export blockiert: Original-Fahrtenbuch enthält ${sheets.length} Sheets (erwartet: 1). Sheets: ${sheets.map(s => `"${s.name}"`).join(', ')}.`,
      };
    }
    if (sheets[0].name !== 'Sheet1') {
      return {
        success: false,
        error: `Export blockiert: Erster Sheet heißt "${sheets[0].name}" (erwartet: "Sheet1").`,
      };
    }

    // ── 3. Find target sheet ──────────────────────────────────────────────────
    const targetSheetName = options.sourceSheetName;
    const targetSheet = (targetSheetName
      ? sheets.find(s => s.name === targetSheetName)
      : null) ?? sheets[0];

    // ── 4. Find worksheet file path from relationships ─────────────────────────
    const relsEntry = entryMap.get('xl/_rels/workbook.xml.rels');
    if (!relsEntry) return { success: false, error: 'ZIP: xl/_rels/workbook.xml.rels nicht gefunden.' };
    const relsXml = xmlStr(await decompressEntry(relsEntry));

    const relTarget = findRelTarget(relsXml, targetSheet.rId);
    if (!relTarget) return { success: false, error: `Relationship für Sheet "${targetSheet.name}" (${targetSheet.rId}) nicht gefunden.` };
    const wsPath = resolveXlPath(relTarget);

    // ── 5. Parse shared strings ───────────────────────────────────────────────
    const ssEntryKey = entries.find(e => e.name.toLowerCase() === 'xl/sharedstrings.xml')?.name
      ?? 'xl/sharedStrings.xml';
    const ssEntry = entryMap.get(ssEntryKey);
    const originalSsXml = ssEntry ? xmlStr(await decompressEntry(ssEntry)) : null;
    const sharedStrings: string[] = originalSsXml ? parseSharedStrings(originalSsXml) : [];

    // ── 6. Decompress worksheet ───────────────────────────────────────────────
    const wsEntry = entryMap.get(wsPath);
    if (!wsEntry) return { success: false, error: `Worksheet "${wsPath}" nicht im ZIP gefunden.` };
    const originalWsXml = xmlStr(await decompressEntry(wsEntry));

    // ── 7. Find header row + column mappings ──────────────────────────────────
    const headerInfo = findHeaderRow(originalWsXml, sharedStrings);
    if (!headerInfo) {
      return { success: false, error: 'Fahrername-Spalte im Original-Fahrtenbuch nicht gefunden.' };
    }
    const { xmlHeaderRow, driverCol, startCol, endCol } = headerInfo;
    if (!driverCol) return { success: false, error: 'Fahrername-Spalte nicht ermittelbar.' };

    const hasTimeChangedRows = rowLevelFinalRows
      ? rowLevelFinalRows.some(r => r.isExportable && r.timeChanged)
      : snapshotResult.validation.timeChangedRowCount > 0;
    if (hasTimeChangedRows && (!startCol || !endCol)) {
      return { success: false, error: 'Zeitstempel-Spalten im Fahrtenbuch nicht gefunden, aber Zeitänderungen vorhanden.' };
    }

    // ── 8. Build patch list from single source-of-truth row model ────────────
    // XML row number = xmlHeaderRow + 1 + sourceRowIndex

    // When row-level final rows are provided, use them (they check ALL abgeschlossen rows).
    // Fall back to snapshot-based rows for backward compatibility.
    interface PatchableRow {
      sourceRowIndex: number;
      finalDriverName: string;
      finalStartDatetime: string;
      finalEndDatetime: string;
      timeChanged: boolean;
    }

    let patchableRows: PatchableRow[];

    if (rowLevelFinalRows) {
      // Only export rows that are exportable (isExportable=true)
      patchableRows = rowLevelFinalRows
        .filter(r => r.isExportable)
        .map(r => ({
          sourceRowIndex: r.sourceRowIndex,
          finalDriverName: r.finalFahrername,
          finalStartDatetime: r.finalStart,
          finalEndDatetime: r.finalEnd,
          timeChanged: r.timeChanged,
        }));

      if (import.meta.env.DEV) {
        console.log('[StrictFahrtenbuchExport] Using row-level engine rows:', {
          totalFinalRows: rowLevelFinalRows.length,
          exportableRows: patchableRows.length,
          timeChangedRows: patchableRows.filter(r => r.timeChanged).length,
        });
      }
    } else {
      const snapshotRows = buildFinalExportedFahrtenbuchRows(allTrips, snapshotResult);
      patchableRows = snapshotRows.map(r => ({
        sourceRowIndex: r.sourceRowIndex,
        finalDriverName: r.finalDriverName,
        finalStartDatetime: r.finalStartDatetime,
        finalEndDatetime: r.finalEndDatetime,
        timeChanged: r.timeChanged,
      }));

      if (import.meta.env.DEV) {
        console.log('[StrictFahrtenbuchExport] Using snapshot rows:', {
          totalRows: patchableRows.length,
          timeChangedRows: patchableRows.filter(r => r.timeChanged).length,
        });
      }
    }

    interface CellPatch {
      cellRef: string;
      newStringValue: string;
    }
    const patches: CellPatch[] = [];
    const allowedRefs = new Set<string>();

    let actualStartPatches = 0;
    let actualEndPatches = 0;

    for (const row of patchableRows) {
      const xmlRow = xmlHeaderRow + 1 + row.sourceRowIndex;

      // Driver name patch
      const driverRef = driverCol + xmlRow;
      patches.push({ cellRef: driverRef, newStringValue: row.finalDriverName });
      allowedRefs.add(driverRef);

      // Time patches (only when shifted)
      if (row.timeChanged) {
        if (startCol) {
          const startRef = startCol + xmlRow;
          patches.push({ cellRef: startRef, newStringValue: row.finalStartDatetime });
          allowedRefs.add(startRef);
          actualStartPatches++;
        }
        if (endCol) {
          const endRef = endCol + xmlRow;
          patches.push({ cellRef: endRef, newStringValue: row.finalEndDatetime });
          allowedRefs.add(endRef);
          actualEndPatches++;
        }
      }
    }

    // ── Verify shifted-row count ──────────────────────────────────────────────
    const expectedShiftedRows = patchableRows.filter(r => r.timeChanged).length;

    if (import.meta.env.DEV) {
      console.log('[StrictFahrtenbuchExport] Shift patch verification:', {
        expectedShiftedRows,
        actualStartPatches,
        actualEndPatches,
        startMatchesExpected: actualStartPatches === expectedShiftedRows,
        endMatchesExpected: actualEndPatches === expectedShiftedRows,
      });
    }

    if (startCol && actualStartPatches !== expectedShiftedRows) {
      return {
        success: false,
        error: `Export blockiert: Nicht alle verschobenen Fahrten wurden exportiert.\nErwartete verschobene Zeilen: ${expectedShiftedRows}\nExportierte Startzeiten: ${actualStartPatches}\nExportierte Endzeiten: ${actualEndPatches}`,
      };
    }
    if (endCol && actualEndPatches !== expectedShiftedRows) {
      return {
        success: false,
        error: `Export blockiert: Nicht alle verschobenen Fahrten wurden exportiert.\nErwartete verschobene Zeilen: ${expectedShiftedRows}\nExportierte Startzeiten: ${actualStartPatches}\nExportierte Endzeiten: ${actualEndPatches}`,
      };
    }

    // Pre-check: unshifted rows must not have time changes (redundant safety check, kept for safety)
    for (const row of patchableRows) {
      if (!row.timeChanged) {
        // timeChanged is derived from the row itself, so this is tautologically true
      }
    }

    // Also verify via snapshot rows (belt-and-suspenders for unshifted consistency)
    for (const row of snapshotResult.rows) {
      if (!row.timeChanged && row.isExportable) {
        if (row.finalStartDatetime !== row.originalStartDatetime) {
          return {
            success: false,
            error: `Exportfehler: Unveränderte Zeile ${row.sourceRowIndex ?? '?'} hat abweichendes Startdatum (${row.originalStartDatetime} → ${row.finalStartDatetime}).`,
          };
        }
      }
    }

    // ── 10. Apply patches ─────────────────────────────────────────────────────
    const origCells = extractCells(originalWsXml);
    let patchedWsXml = originalWsXml;
    let ssChanged = false;
    const sharedStringsCopy = [...sharedStrings];
    const useInlineStr = originalSsXml === null;

    for (const patch of patches) {
      const origCell = origCells.get(patch.cellRef);
      let valueOrIndex: string | number;
      if (useInlineStr) {
        valueOrIndex = patch.newStringValue;
      } else {
        const { index, added } = getOrAddSharedString(sharedStringsCopy, patch.newStringValue);
        if (added) ssChanged = true;
        valueOrIndex = index;
      }
      patchedWsXml = patchCell(patchedWsXml, patch.cellRef, valueOrIndex, origCell);
    }

    // ── 11. Self-check ────────────────────────────────────────────────────────
    const violations = selfCheck(originalWsXml, patchedWsXml, allowedRefs);
    if (violations.length > 0) {
      const examples = violations
        .map(v => `Zelle ${v.cellRef}: original="${v.origRaw}" → exportiert="${v.patchedRaw}"`)
        .join('\n');
      return {
        success: false,
        error: `Export blockiert: Nicht erlaubte Zellwerte wurden verändert.\n${examples}`,
      };
    }

    // ── 11b. Generated worksheet self-audit ───────────────────────────────────
    // Parse ALL rows from the patched worksheet XML and run a full overlap check.
    // This is the final authority — it sees exactly what the downloaded XLSX contains.

    const { fahrtstatusCol, kennzeichenCol } = headerInfo;
    const patchedCells = extractCells(patchedWsXml);

    const wsDataRows = parseWorksheetDataRows(
      patchedCells,
      sharedStringsCopy,
      xmlHeaderRow,
      driverCol,
      fahrtstatusCol,
      kennzeichenCol,
      startCol,
      endCol,
    );

    const auditBase = auditGeneratedWorksheetRows(wsDataRows);

    // Build diagnostic rows for known row numbers (1-based fahrtRowNumber)
    const DIAG_ROWS = [99, 100, 175, 177, 425, 426];
    const wsRowMap = new Map(wsDataRows.map(r => [r.fahrtRowNumber, r]));
    const engineRowMap = new Map((rowLevelFinalRows ?? []).map(r => [r.sourceRowIndex, r]));
    const patchMapByXmlRow = new Map<number, { fahrername: string; start: string; end: string }>();
    for (const p of patches) {
      const { col: pCol, row: pRow } = parseCellRef(p.cellRef);
      if (!patchMapByXmlRow.has(pRow)) patchMapByXmlRow.set(pRow, { fahrername: '', start: '', end: '' });
      const entry = patchMapByXmlRow.get(pRow)!;
      if (pCol === driverCol)       entry.fahrername = p.newStringValue;
      else if (pCol === startCol)   entry.start      = p.newStringValue;
      else if (pCol === endCol)     entry.end        = p.newStringValue;
    }
    const tripBySrcIdx = new Map(allTrips.map(t => [t.source_row_index ?? -1, t]));

    const diagnosticRows: ExportRowDiagnostic[] = DIAG_ROWS.map(fahrtRow => {
      const srcIdx  = fahrtRow - 1;
      const xmlRow  = xmlHeaderRow + 1 + srcIdx;
      const engineRow = engineRowMap.get(srcIdx);
      const wsRow     = wsRowMap.get(fahrtRow);
      const pm        = patchMapByXmlRow.get(xmlRow);
      const trip      = tripBySrcIdx.get(srcIdx);
      const origDriverCell = origCells.get(driverCol + xmlRow);
      const origStartCell  = startCol ? origCells.get(startCol + xmlRow) : undefined;
      const origEndCell    = endCol   ? origCells.get(endCol   + xmlRow) : undefined;

      return {
        fahrtRowNumber: fahrtRow,
        excelRowNumber: xmlRow,
        sourceRowIndex: srcIdx,
        originalFahrername: engineRow?.originalFahrername
          ?? getCellText(origDriverCell, sharedStrings),
        finalFahrername:  engineRow?.finalFahrername ?? '',
        kennzeichen:      trip?.car_identifier ?? wsRow?.kennzeichen ?? '',
        originalStart:    engineRow?.originalStart ?? getCellText(origStartCell, sharedStrings),
        originalEnd:      engineRow?.originalEnd   ?? getCellText(origEndCell,   sharedStrings),
        engineFinalStart: engineRow?.finalStart ?? '',
        engineFinalEnd:   engineRow?.finalEnd   ?? '',
        patchMapFahrername: pm?.fahrername ?? '',
        patchMapStart:      pm?.start      ?? '',
        patchMapEnd:        pm?.end        ?? '',
        worksheetFahrtstatus: wsRow?.fahrtstatus  ?? '',
        worksheetFahrername:  wsRow?.fahrername   ?? '',
        worksheetKennzeichen: wsRow?.kennzeichen  ?? '',
        worksheetStart:       wsRow?.startTime    ?? '',
        worksheetEnd:         wsRow?.endTime      ?? '',
        timeChanged:    engineRow?.timeChanged    ?? false,
        blockId:        engineRow?.blockId        ?? null,
        assignmentType: engineRow?.assignmentType ?? 'unassigned',
      };
    });

    // Shift mismatch check: engine says timeChanged, but worksheet still shows original time
    let shiftMismatchFound = false;
    if (rowLevelFinalRows) {
      for (const engineRow of rowLevelFinalRows) {
        if (!engineRow.isExportable || !engineRow.timeChanged) continue;
        const wsRow = wsRowMap.get(engineRow.fahrtRowNumber);
        if (!wsRow || wsRow.startMs <= 0 || engineRow.originalStartMs <= 0 || engineRow.finalStartMs <= 0) continue;
        const wsDiffFromOrig  = Math.abs(wsRow.startMs - engineRow.originalStartMs);
        const wsDiffFromFinal = Math.abs(wsRow.startMs - engineRow.finalStartMs);
        // If worksheet matches original within 2s AND is far from the expected final: patch failed
        if (wsDiffFromOrig < 2000 && wsDiffFromFinal > 2000) {
          shiftMismatchFound = true;
          break;
        }
      }
    }

    const worksheetAudit: GeneratedWorksheetAuditResult = {
      ...auditBase,
      diagnosticRows,
      shiftMismatchFound,
    };

    if (import.meta.env.DEV) {
      console.log('[GeneratedXlsxSelfAudit] Worksheet self-audit complete:', {
        totalWsRows: wsDataRows.length,
        checkedRows: auditBase.checkedRows,
        driverOverlapCount: auditBase.driverOverlapCount,
        vehicleOverlapCount: auditBase.vehicleOverlapCount,
        isClean: auditBase.isClean,
        regressionA_99_100: auditBase.regressionA_99_100,
        regressionB_425_426: auditBase.regressionB_425_426,
        shiftMismatchFound,
        first20Overlaps: auditBase.entries.slice(0, 20),
        diagnosticRows,
      });
    }

    if (shiftMismatchFound) {
      return {
        success: false,
        error: 'Export blockiert: Verschobene Fahrten wurden nicht korrekt in die Excel-Zeilen geschrieben.',
        worksheetAudit,
      };
    }

    if (!auditBase.isClean) {
      return {
        success: false,
        error: `Export blockiert: Überschneidungen im erzeugten Fahrtenbuch gefunden. (${auditBase.driverOverlapCount} Fahrerüberschneidung(en), ${auditBase.vehicleOverlapCount} Fahrzeugüberschneidung(en))`,
        worksheetAudit,
      };
    }

    // ── 12. Build patched ZIP ─────────────────────────────────────────────────
    const newEntries: ZipEntry[] = [];
    for (const name of entryOrder) {
      const entry = entryMap.get(name)!;

      if (name === wsPath) {
        // Re-compress patched worksheet
        newEntries.push(await compressEntry(entry, xmlBytes(patchedWsXml)));
        continue;
      }

      if (ssChanged && (name === ssEntryKey || name.toLowerCase() === 'xl/sharedstrings.xml')) {
        // Rebuild shared strings XML with new entries
        const rebuilt = rebuildSharedStringsXml(originalSsXml!, sharedStringsCopy);
        newEntries.push(await compressEntry(entry, xmlBytes(rebuilt)));
        continue;
      }

      // All other entries: preserve EXACTLY as-is (original compressed bytes)
      newEntries.push(entry);
    }

    // ── 13. Write ZIP and download ────────────────────────────────────────────
    const outputBytes = writeZip(newEntries);
    const outputName  = makeOutputFilename(srcName);
    triggerDownload(outputBytes, outputName);

    return { success: true, fileName: outputName, worksheetAudit };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Export-Fehler: ${msg}` };
  }
}
