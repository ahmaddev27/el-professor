import { describe, it, expect, vi, beforeEach } from 'vitest'

/*
  BelegePage's Excel button never worked. The old exportToExcel() built a financial
  report around income, a running balance, ROI and a profit verdict, and Receipt
  carries none of those — it has `expense`, no `income`, no `balance`. So it threw
  before writing a cell, with no try/catch and no error boundary on the page: the
  click produced no file, no toast, nothing at all. Measured by calling it on one
  real-shaped Receipt.

  Both halves are pinned: the exporter the screen uses now reaches the write with
  real rows on that same input, and the old one is kept as the negative control so
  nobody wires it back. xlsx's writeFile is mocked at the module boundary — the
  real one is a DOM download and its property is not redefinable.
*/
// vi.mock is hoisted above every other statement, so the spy has to be created
// inside vi.hoisted or the factory closes over a variable that does not exist yet.
const { writeFile } = vi.hoisted(() => ({ writeFile: vi.fn() }))
vi.mock('xlsx', async (importOriginal) => {
  const real = await importOriginal<typeof import('xlsx')>()
  return { ...real, writeFile, default: { ...real, writeFile } }
})

import { exportTableToExcel, exportToExcel } from './excelExport'
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

  it('negative control: the old exportToExcel still throws on the same input, before writing', () => {
    expect(() => exportToExcel(ONE, 0, false)).toThrow(TypeError)
    expect(writeFile).not.toHaveBeenCalled()
  })
})
