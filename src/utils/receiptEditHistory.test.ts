/**
 * The Beleg edit history's display seam (receipt_edits, 20261027160000).
 *
 * The trigger logs every changed column generically, so a column this map has
 * never heard of WILL eventually arrive — the pinned rule is that it falls
 * back to the raw name instead of vanishing: a history that omits a change is
 * worse than one with an untranslated label.
 */
import { describe, it, expect } from 'vitest'
import {
  mapReceiptEditRow,
  receiptEditFieldKey,
  sortReceiptEdits,
} from './receiptEditHistory'

describe('mapReceiptEditRow', () => {
  it('reads a change row as PostgREST serialises it', () => {
    const entry = mapReceiptEditRow({
      id: 'e-1',
      action: 'change',
      field: 'expense',
      old_value: '41.08',
      new_value: '41.80',
      edited_by: 'u-1',
      edited_at: '2026-10-27T10:00:00+00:00',
    })
    expect(entry).toEqual({
      id: 'e-1',
      action: 'change',
      field: 'expense',
      oldValue: '41.08',
      newValue: '41.80',
      editedBy: 'u-1',
      editedAt: '2026-10-27T10:00:00+00:00',
    })
  })

  it('reads a confirm row, whose values are null by the table CHECK', () => {
    const entry = mapReceiptEditRow({
      id: 'e-2', action: 'confirm', field: 'receipt',
      old_value: null, new_value: null, edited_by: 'u-1',
      edited_at: '2026-10-27T10:00:00+00:00',
    })
    expect(entry.action).toBe('confirm')
    expect(entry.oldValue).toBeNull()
    expect(entry.newValue).toBeNull()
  })
})

describe('receiptEditFieldKey', () => {
  it('names each logged column with the label the form already uses', () => {
    expect(receiptEditFieldKey('expense')).toBe('common.expenses')
    expect(receiptEditFieldKey('street')).toBe('rec.street')
    expect(receiptEditFieldKey('printed_receipt_number')).toBe('rec.printedNumber')
    expect(receiptEditFieldKey('tse_time')).toBe('rec.tseTime')
  })

  it('answers null for a column it has never heard of, never a guess', () => {
    // The generic trigger logs new columns before anyone extends this map;
    // the caller then shows the raw name.
    expect(receiptEditFieldKey('some_future_column')).toBeNull()
  })
})

describe('sortReceiptEdits', () => {
  it('sorts newest first and breaks a timestamp tie by id, stably', () => {
    const rows = [
      { id: 'a', action: 'change' as const, field: 'city', oldValue: null, newValue: 'Hagen', editedBy: 'u', editedAt: '2026-10-27T09:00:00+00:00' },
      { id: 'b', action: 'confirm' as const, field: 'receipt', oldValue: null, newValue: null, editedBy: 'u', editedAt: '2026-10-27T10:00:00+00:00' },
      { id: 'c', action: 'change' as const, field: 'expense', oldValue: '1', newValue: '2', editedBy: 'u', editedAt: '2026-10-27T10:00:00+00:00' },
    ]
    expect(sortReceiptEdits(rows).map(r => r.id)).toEqual(['c', 'b', 'a'])
    // and the input is not mutated
    expect(rows.map(r => r.id)).toEqual(['a', 'b', 'c'])
  })
})
