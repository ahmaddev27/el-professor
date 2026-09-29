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
  xlsx's writeFile is mocked at the module boundary — the real one is a DOM
  download and its property is not redefinable.
*/
// vi.mock is hoisted above every other statement, so the spy has to be created
// inside vi.hoisted or the factory closes over a variable that does not exist yet.
const { writeFile } = vi.hoisted(() => ({ writeFile: vi.fn() }))
vi.mock('xlsx', async (importOriginal) => {
  const real = await importOriginal<typeof import('xlsx')>()
  return { ...real, writeFile, default: { ...real, writeFile } }
})

import * as excelExport from './excelExport'
import { exportTableToExcel } from './excelExport'
import type { Receipt } from '../types/receipt'

const ONE: Receipt[] = [{
  id: 'r1', receiptNumber: 'BEL-1', date: '2026-09-01',
  description: 'Tanken', driverName: 'Ali', expense: 42.5,
  paymentMethod: 'bar',
}]

beforeEach(() => writeFile.mockClear())

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
    expect(writeFile).toHaveBeenCalledTimes(1)
  })

  it('negative control: the old exportToExcel is gone, so nothing can wire it back', () => {
    // It threw a TypeError on this very `ONE` before it was deleted: it read
    // `receipt.income` and `receipt.balance`, which the Receipt model has never
    // carried. Absence is the stronger pin — a throw could be "fixed" by adding
    // the two fields to a row and the report would still be built on a model the
    // database does not have.
    expect(Object.keys(excelExport)).not.toContain('exportToExcel')
  })
})
