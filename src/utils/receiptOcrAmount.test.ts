/**
 * The OCR's amount pattern decides what figure is auto-filled into a Beleg, and
 * from there into the Abrechnung and the Tankenquote. It had no test at all.
 *
 * **The defect.** `\b(\d{1,4}[,.]\d{2})\b` cannot match a German grouped amount,
 * and matches a *piece* of one instead. On '2.480,00': `\d{1,4}` takes '2',
 * `[,.]` takes '.', `\d{2}` takes '48', and the closing `\b` then sits between '8'
 * and '0' — two word characters — so it fails, and nothing else can start at '2'.
 * The scan moves on and matches **'480,00'**, because the '.' before it is a
 * non-word character so the leading `\b` holds. That parses to 480.00, under the
 * 10000 ceiling, and is accepted with no uncertainty warning.
 *
 * '1.000,00' behaved differently and harmlessly — the piece it matched was
 * '000,00', which parses to 0 and is rejected. So the defect bites only when the
 * group after the separator starts with a non-zero digit, which is most of them.
 *
 * **Measured on production 27.09.2026:** of 915 receipts exactly **one** has an
 * expense of 1000 or more, and the maximum is 1000.00. So it is latent today and
 * fires on the next Werkstatt or fuel invoice over a thousand euros.
 *
 * The first half below is characterization — every shape that occurs today must
 * capture and parse to exactly what it did before.
 */
import { describe, it, expect } from 'vitest'
import { __ocrInternals } from './receiptOcr'

const { AMOUNT_RE, normalizeAmountRaw, parseRawAmount } = __ocrInternals

/** All amounts the pattern finds in a line, in order. */
function capture(line: string): string[] {
  return [...line.matchAll(new RegExp(AMOUNT_RE.source, 'g'))].map(m => m[1])
}

/** The pattern that shipped, so the defect can be seen rather than described. */
function captureAsShipped(line: string): string[] {
  return [...line.matchAll(/\b(\d{1,4}[,.]\d{2})\b/g)].map(m => m[1])
}

describe('amounts that occur today — these must not move', () => {
  const same: Array<[string, string[]]> = [
    ['GESAMT 25,32 EUR', ['25,32']],
    ['TOTAL 25.32', ['25.32']],
    ['Summe 7,00', ['7,00']],
    ['999,99 EUR', ['999,99']],
    ['14,21 l zu 1,83', ['14,21', '1,83']],
    ['kein Betrag hier', []],
  ]

  it.each(same)('%s captures %j, exactly as before', (line, expected) => {
    expect(capture(line)).toEqual(expected)
    expect(captureAsShipped(line)).toEqual(expected)
  })

  it('normalises to the same key as the three naive copies did', () => {
    expect(normalizeAmountRaw('25,32')).toBe('25.32')
    expect(normalizeAmountRaw('25.32')).toBe('25.32')
    // Which is what `raw.replace(',', '.')` gave for both.
    expect('25,32'.replace(',', '.')).toBe(normalizeAmountRaw('25,32'))
    expect('25.32'.replace(',', '.')).toBe(normalizeAmountRaw('25.32'))
  })

  it('parses them to the same numbers', () => {
    expect(parseRawAmount('25,32')).toBe(25.32)
    expect(parseRawAmount('25.32')).toBe(25.32)
    expect(parseRawAmount('7,00')).toBe(7)
    expect(parseRawAmount('0,00')).toBe(null)
  })
})

describe('German grouped amounts — the defect', () => {
  it('captures 2.480,00 whole, where the shipped pattern captured 480,00', () => {
    expect(capture('GESAMT 2.480,00 EUR')).toEqual(['2.480,00'])
    // NEGATIVE CONTROL: the exact figure a Beleg was created with.
    expect(captureAsShipped('GESAMT 2.480,00 EUR')).toEqual(['480,00'])
    expect(parseRawAmount('2.480,00')).toBe(2480)
    expect(parseRawAmount('480,00')).toBe(480)
  })

  it('captures 1.000,00 whole, where the shipped pattern found a zero it threw away', () => {
    expect(capture('Summe 1.000,00')).toEqual(['1.000,00'])
    expect(captureAsShipped('Summe 1.000,00')).toEqual(['000,00'])
    expect(parseRawAmount('1.000,00')).toBe(1000)
    // This is why 1.000,00 was harmless and 2.480,00 was not.
    expect(parseRawAmount('000,00')).toBe(null)
  })

  it('normalises a grouped amount to a real number, which the naive copy did not', () => {
    expect(normalizeAmountRaw('2.480,00')).toBe('2480.00')
    expect('2.480,00'.replace(',', '.')).toBe('2.480.00') // the naive result
  })

  it('yields no candidate at all above the ceiling, rather than a plausible fragment', () => {
    expect(capture('GESAMT 12.345,67')).toEqual(['12.345,67'])
    expect(parseRawAmount('12.345,67')).toBe(null)
    // Before: it captured a fragment that parsed cleanly and was accepted.
    expect(captureAsShipped('GESAMT 12.345,67')).toEqual(['345,67'])
    expect(parseRawAmount('345,67')).toBe(345.67)
  })

  it('leaves a date alone, as before', () => {
    // `isDatePart` exists because the pattern has always matched date fragments;
    // the grouped alternative needs a comma, so it cannot make this worse.
    expect(capture('Datum 01.02.2026')).toEqual(captureAsShipped('Datum 01.02.2026'))
  })
})
