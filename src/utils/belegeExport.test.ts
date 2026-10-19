import { describe, it, expect, vi, beforeEach } from 'vitest'

/*
  BelegePage's Excel button never worked. The old exportToExcel() built a financial
  report around income, a running balance, ROI and a profit verdict, and Receipt
  carries none of those — it has `expense`, no `income`, no `balance`. So it threw
  before writing a cell, with no try/catch and no error boundary on the page: the
  click produced no file, no toast, nothing at all. Measured by calling it on one
  real-shaped Receipt.

  Both halves are pinned: the exporter the screen uses now reaches the write with
  real rows on that same input, and the old one can no longer be wired back
  because it no longer exists — deleted under the owner's decision D-E, which the
  second test below states as the absence of the export rather than as a throw.

  The write is mocked at the module boundary, because the real one is a DOM
  download and this suite runs in node. Since the ExcelJS swap that write is
  `downloadStyledWorkbook`, not `XLSX.writeFile`: xlsx 0.20.3 discards every
  fill, font, border and alignment the exporter describes (`get_cell_style` reads
  only `cell.z`), so a styled table written through it came out plain. The
  assertion is the same one — the exporter reaches its write with real rows —
  against the writer that now performs it, and `XLSX.writeFile` stays mocked as
  the negative control: a regression back onto the styleless writer fails here
  rather than silently producing an unstyled file.
*/
// vi.mock is hoisted above every other statement, so the spy has to be created
// inside vi.hoisted or the factory closes over a variable that does not exist yet.
const { writeFile } = vi.hoisted(() => ({ writeFile: vi.fn() }))
vi.mock('xlsx', async (importOriginal) => {
  const real = await importOriginal<typeof import('xlsx')>()
  return { ...real, writeFile, default: { ...real, writeFile } }
})

// Resolves, because `exportTableToExcel` attaches a `.catch` to what it returns.
// A bare factory rather than one spreading the real module: that module lazily
// imports exceljs, and nothing here needs it loaded.
const { downloadStyledWorkbook } = vi.hoisted(() => ({
  downloadStyledWorkbook: vi.fn(() => Promise.resolve()),
}))
vi.mock('./styledWorkbookDownload', () => ({ downloadStyledWorkbook }))

import * as excelExport from './excelExport'
import { exportTableToExcel } from './excelExport'
import { buildBelegeExportOptions, NO_RECEIPT_FILTERS } from './belegeExport'
import type { Receipt } from '../types/receipt'

const ONE: Receipt[] = [{
  id: 'r1', receiptNumber: 'BEL-1', date: '2026-09-01',
  description: 'Tanken', driverName: 'Ali', expense: 42.5,
  paymentMethod: 'bar',
}]

beforeEach(() => {
  writeFile.mockClear()
  downloadStyledWorkbook.mockClear()
})

describe('the Belege Excel export', () => {
  it('the generic exporter reaches the write for a real Receipt, where the old one threw', () => {
    expect(() => exportTableToExcel({
      filename: 'belege_test', sheetTitle: 'Belege', moduleName: 'Belege',
      columns: [
        { key: 'receiptNumber', label: 'Belegnummer', width: 20 },
        { key: 'expense', label: 'Betrag', width: 16, align: 'right', format: v => String(v) },
      ],
      rows: ONE.map(r => ({ receiptNumber: r.receiptNumber, expense: r.expense })),
      totals: { expense: '42,50 EUR' },
    })).not.toThrow()
    expect(downloadStyledWorkbook).toHaveBeenCalledTimes(1)
    // The workbook that reached the write is a real one with the row in it, not
    // an empty object the exporter happened to hand over. A6 is the first data
    // row: rows 0-4 are accent, title, meta, spacer and the column header.
    const [workbook, filename] = downloadStyledWorkbook.mock.calls[0] as unknown as [
      { Sheets: Record<string, Record<string, { v?: unknown } | undefined>> },
      string,
    ]
    expect(filename).toBe('belege_test.xlsx')
    expect(workbook.Sheets.Belege.A6?.v).toBe('BEL-1')
    // Negative control: not through the writer that would have dropped every
    // fill, font and border on the way out.
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('negative control: the old exportToExcel is gone, so nothing can wire it back', () => {
    // It threw a TypeError on this very `ONE` before it was deleted: it read
    // `receipt.income` and `receipt.balance`, which the Receipt model has never
    // carried. Absence is the stronger pin — a throw could be "fixed" by adding
    // the two fields to a row and the report would still be built on a model the
    // database does not have.
    expect(Object.keys(excelExport)).not.toContain('exportToExcel')
  })

  it('gives each Beleg detail its own column; an absent figure is empty, not 0', () => {
    const t = ((key: string) => key) as never
    const fuel: Receipt = { ...ONE[0], merchantName: 'Star', city: 'Solingen', receiptTime: '03:15:00',
      litres: 25.87, pricePerLitre: 2.049, odometerKm: 20140, rangeKm: 793 }
    const options = buildBelegeExportOptions([fuel, ONE[0]], NO_RECEIPT_FILTERS, t)
    const keys = options.columns.map(c => c.key)
    expect(keys).toEqual(expect.arrayContaining(
      ['merchantName', 'city', 'receiptTime', 'litres', 'pricePerLitre', 'odometerKm', 'rangeKm']))
    expect(options.rows[0]).toMatchObject({ merchantName: 'Star', city: 'Solingen', receiptTime: '03:15',
      litres: 25.87, pricePerLitre: 2.049, odometerKm: 20140, rangeKm: 793 })
    expect(options.rows[1]).toMatchObject({ merchantName: null, city: null, receiptTime: null,
      litres: null, pricePerLitre: null, odometerKm: null, rangeKm: null })
    expect(options.columns.find(c => c.key === 'pricePerLitre')?.type).toBe('number3')
  })
})
