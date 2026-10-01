/**
 * The payroll summary survives the writer swap — checked on the written bytes.
 *
 * ## What was in doubt, and what was not
 *
 * `exportFahreruebersichtToExcel` had **always** described a fully drawn sheet: a
 * title band, a meta row, a header row, banded data rows, a footer note, 22
 * styles, row heights, column widths and a merge list. `xlsx@0.20.3` discarded all
 * of it — `get_cell_style` reads one property, `cell.z` — so the Steuerberater's
 * summary arrived as a bare grid. `b081c18` changed the **writer** and nothing
 * else: not one cell, style, width or merge moved.
 *
 * So the only question is whether that description survives ExcelJS. Nothing about
 * the figures is in doubt and nothing here asserts one.
 *
 * ## Why not an e2e download
 *
 * Because the export sits behind the Stundennachweis wizard and needs a saved
 * Stundennachweis to reach, and walking that wizard on staging did not produce one
 * — its "Plan generieren" left the screen unchanged. That walk was not wasted: it
 * recorded every request the wizard sent, and the only POSTs were
 * `get_public_config` and `get_app_config`. **It writes to no table at all**,
 * which is worth knowing about a screen whose job is generating hours to hit a
 * salary target.
 *
 * This test reaches the same bytes by a shorter road: it captures the workbook the
 * function hands the writer, runs it through the real `exceljs`, reads it back and
 * counts. A download would additionally prove the screen's data path, which this
 * change did not touch.
 */
import { describe, it, expect, vi } from 'vitest';
import type * as XLSX from 'xlsx';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Captures the workbook instead of downloading it. Resolves, because the export
// attaches a `.catch` to what it returns.
const { downloadStyledWorkbook, captured } = vi.hoisted(() => {
  const captured: { workbook: unknown; filename: string }[] = [];
  return {
    captured,
    downloadStyledWorkbook: vi.fn((workbook: unknown, filename: string) => {
      captured.push({ workbook, filename });
      return Promise.resolve();
    }),
  };
});
vi.mock('./styledWorkbookDownload', async (importOriginal) => {
  const real = await importOriginal<typeof import('./styledWorkbookDownload')>();
  return { ...real, downloadStyledWorkbook };
});

import { exportFahreruebersichtToExcel, type DriverSummary } from './fahreruebersichtExport';
import { applyStyledWorkbook } from './styledWorkbookDownload';

const saved = (over: Record<string, unknown> = {}) => ({
  id: 's1', driver_id: 'd1', driver_name: 'Anna Beispiel', personalnummer: 'P-001',
  month: 11, year: 2026,
  grundlohn_min: 9_600, nachtarbeit_min: 1_200, nacht04_min: 300,
  samstag_min: 480, sonntag_min: 390, feiertag_min: 0, weihnachten_min: 0,
  working_days: 20,
  ...over,
}) as never;

const DRIVERS: DriverSummary[] = [
  { driver_id: 'd1', driver_name: 'Anna Beispiel',   personalnummer: 'P-001', saved: saved() },
  { driver_id: 'd2', driver_name: 'Bert Nachtfahrt', personalnummer: 'P-002',
    saved: saved({ id: 's2', driver_id: 'd2', driver_name: 'Bert Nachtfahrt',
                   personalnummer: 'P-002', grundlohn_min: 7_200, nachtarbeit_min: 4_800 }) },
  // A driver with no saved sheet: its row is written empty rather than skipped,
  // which is what the "manuell zu befüllen" footer is about.
  { driver_id: 'd3', driver_name: 'Clara Nullsatz',  personalnummer: 'P-003', saved: null },
];

/** Runs the captured workbook through the real writer and reads the bytes back. */
async function written(source: XLSX.WorkBook) {
  const loaded: unknown = await import('exceljs');
  const candidate = loaded as { Workbook?: unknown; default?: { Workbook?: unknown } };
  const Workbook = (candidate.Workbook ?? candidate.default?.Workbook) as new () => any;

  const out = new Workbook();
  applyStyledWorkbook(source, out);
  const buffer = await out.xlsx.writeBuffer();

  const back = new Workbook();
  await back.xlsx.load(buffer);
  return back;
}

describe('the Fahrerübersicht reaches the file drawn', () => {
  it('writes through the styled writer, never through xlsx', () => {
    captured.length = 0;
    downloadStyledWorkbook.mockClear();

    exportFahreruebersichtToExcel({
      month: 11, year: 2026, companyName: 'DEMO Monatsplanung GmbH', drivers: DRIVERS,
    });

    expect(downloadStyledWorkbook).toHaveBeenCalledTimes(1);
    expect(captured[0].filename).toBe('Fahreruebersicht_Stundennachweis_11_2026.xlsx');
  });

  it('and the 22 styles it describes survive into the bytes', { timeout: 60_000 }, async () => {
    captured.length = 0;
    exportFahreruebersichtToExcel({
      month: 11, year: 2026, companyName: 'DEMO Monatsplanung GmbH', drivers: DRIVERS,
    });

    const book = await written(captured[0].workbook as XLSX.WorkBook);
    const sheet = book.worksheets[0];

    let fills = 0, borders = 0, widths = 0;
    sheet.eachRow({ includeEmpty: false }, (row: any) => {
      row.eachCell({ includeEmpty: false }, (cell: any) => {
        if (cell.fill?.type) fills++;
        if (cell.border && Object.keys(cell.border).length > 0) borders++;
      });
    });
    sheet.columns?.forEach((column: any) => { if (column.width) widths++; });

    // eslint-disable-next-line no-console
    console.log(`  Fahrerübersicht: rows=${sheet.rowCount} fills=${fills}`
      + ` borders=${borders} widths=${widths} merges=${sheet.model?.merges?.length ?? 0}`);

    expect(fills, 'not one cell carries a fill').toBeGreaterThan(0);
    expect(borders, 'not one cell carries a border').toBeGreaterThan(0);
    expect(widths, 'the column widths were lost').toBeGreaterThan(0);
    // The sheet is named for its period, which is how a year of them stacks up.
    expect(sheet.name).toBe('11_2026');
  });

  it('carries no signature in any cell or document property', { timeout: 60_000 }, async () => {
    captured.length = 0;
    exportFahreruebersichtToExcel({
      month: 11, year: 2026, companyName: 'DEMO Monatsplanung GmbH', drivers: DRIVERS,
    });

    const book = await written(captured[0].workbook as XLSX.WorkBook);
    const found: string[] = [];
    for (const sheet of book.worksheets) {
      sheet.eachRow({ includeEmpty: false }, (row: any) => {
        row.eachCell({ includeEmpty: false }, (cell: any) => {
          if (typeof cell.value === 'string' && /professor/i.test(cell.value)) {
            found.push(`${sheet.name} ${cell.address}: ${cell.value}`);
          }
        });
      });
    }
    for (const [key, value] of Object.entries({
      creator: book.creator, company: book.company, title: book.title, subject: book.subject,
    })) {
      if (typeof value === 'string' && /professor/i.test(value)) found.push(`[${key}] ${value}`);
    }
    expect(found).toEqual([]);
  });

  it('keeps the header row in view, which a 25-column sheet needs', { timeout: 60_000 }, async () => {
    captured.length = 0;
    exportFahreruebersichtToExcel({
      month: 11, year: 2026, companyName: 'DEMO Monatsplanung GmbH', drivers: DRIVERS,
    });

    const book = await written(captured[0].workbook as XLSX.WorkBook);
    const frozen = book.worksheets[0].views?.some((view: any) => view.state === 'frozen');
    // `ws['!freeze']` was added with the writer swap and had never had an effect
    // before it: xlsx emits no `<pane>` at all.
    expect(frozen, 'the freeze pane did not reach the file').toBe(true);
  });
});
