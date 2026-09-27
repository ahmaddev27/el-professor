/**
 * `parseMoney` decides what every imported ride's Preis and Trinkgeld are stored
 * as, and from those come the Abrechnung, the Umsatz on the Overview and each
 * driver's revenue share. So this file is written in two halves, and the first
 * matters more than the second.
 *
 * **Half one — characterization.** Every shape present in today's data must parse
 * to exactly the number it parsed to before. Measured on staging on 27.09.2026
 * over all 251262 key/value pairs in `raw_data_json`:
 *
 *   27273  values shaped `123.45`      (a dot decimal — what the export writes)
 *       0  with a German thousands separator
 *       0  with a single digit after a comma
 *       0  with two digits after a comma
 *   323.22 the highest `price_amount` stored anywhere
 *
 * So the fix below could not have changed a stored amount, and these tests are
 * what keep it that way.
 *
 * **Half two — the defect.** A German amount kept its grouping dot and gained a
 * second one, and `parseFloat` stops at the second: '1.000,00' became 1, and
 * '2.480,00' became 2.48. A single decimal digit was dropped entirely: '5,5'
 * became 5. Those inputs do not occur in today's data, which is why this is a
 * latent defect and not a live one — and why it would have been silent on the
 * first export that wrote amounts differently.
 */
import { describe, it, expect } from 'vitest'
import { parseMoney } from './fahrtenbuchImportParser'

/** The body that shipped, so the difference can be seen rather than asserted. */
function parseMoneyAsShipped(raw: unknown): number {
  if (raw === null || raw === undefined) return 0
  if (typeof raw === 'number') return Math.round(raw * 100) / 100
  const s = String(raw).trim()
  if (!s || s === '\\N') return 0
  const cleaned = s.replace(/[^\d,.-]/g, '').replace(/,(\d{2})$/, '.$1')
  const n = parseFloat(cleaned)
  return isNaN(n) ? 0 : Math.round(n * 100) / 100
}

describe('parseMoney — the shapes today’s data actually carries', () => {
  // These are the ones that must not move. 27273 rows on staging are this shape.
  const unchanged: Array<[string | number | null, number]> = [
    ['123.45', 123.45],
    ['12.34', 12.34],
    ['0.99', 0.99],
    ['323.22', 323.22],
    ['7', 7],
    ['0', 0],
    ['12,50', 12.5],
    ['-12,50', -12.5],
    ['12,50 €', 12.5],
    ['', 0],
    ['\\N', 0],
    [null, 0],
    [12.345, 12.35],
  ]

  it.each(unchanged)('parses %p as %p, exactly as before', (input, expected) => {
    expect(parseMoney(input as never)).toBe(expected)
    // And the shipped body agreed — this is the characterization half.
    expect(parseMoneyAsShipped(input)).toBe(expected)
  })
})

describe('parseMoney — the German shapes that were wrong', () => {
  const corrected: Array<[string, number, number]> = [
    // input,        correct,   what shipped
    ['1.234,56', 1234.56, 1.23],
    ['1.000,00', 1000, 1],
    ['2.480,00', 2480, 2.48],
    ['10.000,50', 10000.5, 10],
    ['1.234.567,89', 1234567.89, 1.23],
    ['5,5', 5.5, 5],
    ['0,5', 0.5, 0],
    ['1.234.567', 1234567, 1.23],
  ]

  it.each(corrected)('parses %p as %p, where the shipped body gave %p', (input, correct, shipped) => {
    expect(parseMoney(input)).toBe(correct)
    // NEGATIVE CONTROL: the old body really did return the wrong figure, so this
    // test fails loudly if someone restores it.
    expect(parseMoneyAsShipped(input)).toBe(shipped)
    expect(shipped).not.toBe(correct)
  })

  it('leaves a single dot ambiguous, deliberately, and unchanged', () => {
    // '1.234' could be one thousand two hundred, or one and a bit. The data gives
    // no reason to choose, and 27273 rows depend on one dot meaning a decimal
    // point, so it keeps reading as one.
    expect(parseMoney('1.234')).toBe(1.23)
    expect(parseMoneyAsShipped('1.234')).toBe(1.23)
  })

  it('reads a space as grouping, which both bodies already did', () => {
    expect(parseMoney('1 234,56')).toBe(1234.56)
  })
})
