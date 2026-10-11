/**
 * What the receipt rules read out of OCR text — pinned, because two engines now
 * feed them.
 *
 * `parseReceiptText` used to be the back half of `extractReceiptData`, reachable
 * only through tesseract and a canvas. It is a pure function now, so the same
 * German rules can read text from a phone's own OCR engine as well as from the
 * browser's. That makes these assertions load-bearing in a new way: the driver
 * app carries a copy of this module, and this file is the fixture both sides are
 * measured against.
 *
 * **These are characterization tests, not specifications.** They record what the
 * rules do today so that a change becomes visible. Two of the recorded answers
 * are not what anyone would design:
 *
 * - the fuel receipt's amount is CORRECT (74,24, the Gesamtbetrag) and is still
 *   marked `Unsicher`, because `mwst` appears nearby and costs it 80 points.
 *   That is the case the driver app's "confirm this field" marker exists for.
 * - the workshop receipt reports a `receiptNumber` of `'datum'` — the word, not
 *   a number. A latent defect; it is pinned here rather than fixed, so that
 *   fixing it is a deliberate act with its own diff.
 *
 * Do not update a failing expectation without reading why it moved. The amount
 * reaches a driver's balance and the Tankenquote.
 */
import { describe, it, expect } from 'vitest'
import { parseReceiptText } from './receiptTextParse'

/** A fuel receipt: grouped lines, a tax line near the total, a time. */
const FUEL = `ARAL Tankstelle
Hauptstrasse 12
10115 Berlin
Datum 09.10.2026  Uhrzeit 14:32
Beleg-Nr 004711
Super E10
41,47 L   EUR/L 1,789
Netto        62,39
MwSt 19%     11,85
Gesamtbetrag  74,24
Bar gegeben   80,00
Rueckgeld      5,76`

/** A car wash: one amount, one label, nothing to confuse it. */
const WASH = `Clean Car Autowaesche GmbH
Industrieweg 3
80331 Muenchen
Datum: 01.03.2026
Waesche Premium
Summe EUR 24,90`

/** A workshop invoice over a thousand euros: the grouped-amount shape. */
const BIG = `KFZ Werkstatt Mueller
Ringstr. 8
50667 Koeln
Belegdatum 15.02.2026
Oel wechseln
Zu zahlen 2.480,00`

describe('a fuel receipt', () => {
  const r = parseReceiptText(FUEL)

  it('reads the date, the time and the receipt number', () => {
    expect(r.date).toBe('2026-10-09')
    expect(r.time).toBe('14:32')
    expect(r.receiptNumber).toBe('004711')
  })

  it('takes the Gesamtbetrag and not the cash given, the change or the tax', () => {
    expect(r.amount).toBe(74.24)
  })

  it('recognises the category and the merchant', () => {
    expect(r.category).toBe('Tanken')
    expect(r.merchantName).toBe('ARAL Tankstelle')
  })

  it('reads the postal code and resolves the city', () => {
    expect(r.postalCode).toBe('10115')
    expect(r.city).toBe('Berlin')
  })

  it('still marks the amount uncertain, although it is the right one', () => {
    // The tax line costs it 80 points, which drops it under the 50 the code
    // calls confident. `ReceiptModal` reads this exact prefix, so the wording is
    // data: changing it changes what the screen highlights.
    expect(r.amountConfidence).toBe(45)
    expect(r.amountReason).toBe('Unsicher: +100 Label: Gesamtbetrag; -80 Ausschluss-Label: mwst')
    expect(r.dateConfidence).toBe(100)
  })
})

describe('a car wash receipt', () => {
  const r = parseReceiptText(WASH)

  it('reads an unambiguous total with full confidence and no Unsicher prefix', () => {
    expect(r.amount).toBe(24.9)
    expect(r.amountConfidence).toBe(100)
    expect(r.amountReason).toBe('+100 Label: Summe EUR; +70 EUR auf gleicher Zeile')
  })

  it('reads the date, the place and the merchant', () => {
    expect(r.date).toBe('2026-03-01')
    expect(r.postalCode).toBe('80331')
    expect(r.city).toBe('Muenchen')
    expect(r.merchantName).toBe('Clean Car Autowaesche GmbH')
  })

  it('leaves the category empty rather than guessing', () => {
    // The stored vocabulary is 'Autowäsche' with an umlaut; this line has none,
    // which is what an OCR pass often produces. No category is the honest answer.
    expect(r.category).toBeUndefined()
  })
})

describe('an invoice over a thousand euros', () => {
  const r = parseReceiptText(BIG)

  it('reads a GROUPED amount whole', () => {
    // The shape `receiptOcrAmount.test.ts` exists for: a pattern that matched a
    // piece of this read 480,00 and accepted it without a warning.
    expect(r.amount).toBe(2480)
    expect(r.amountConfidence).toBe(100)
  })

  it('reads the date from a Belegdatum label', () => {
    expect(r.date).toBe('2026-02-15')
  })

  it('reports the word "datum" as a receipt number — a pinned defect', () => {
    // Recorded, not endorsed. Fixing it is its own change, and this line is what
    // will fail and make that change visible.
    expect(r.receiptNumber).toBe('datum')
  })
})

describe('the fuel figures', () => {
  it('reads litres and the unit price written as `41,47 L   EUR/L 1,789`', () => {
    const r = parseReceiptText(FUEL)
    expect(r.litres).toBe(41.47)
    expect(r.pricePerLitre).toBe(1.789)
  })

  it('reads them written as `Menge: 35.39 Liter` and `Einzelpreis 1,559`', () => {
    // The shape of a real Star Tankstelle receipt, and the one whose total
    // came out as 8,80 before the rows were rebuilt from the OCR coordinates.
    const r = parseReceiptText(`Star Tankstelle
50937 Koeln
Datum 10.10.2026
Diesel
Menge: 35.39 Liter
Einzelpreis 1,559
TOTAL 55,11 EUR`)
    expect(r.amount).toBe(55.11)
    expect(r.litres).toBe(35.39)
    expect(r.pricePerLitre).toBe(1.559)
  })

  it('leaves both undefined on a receipt that is not fuel', () => {
    const r = parseReceiptText(WASH)
    expect(r.litres).toBeUndefined()
    expect(r.pricePerLitre).toBeUndefined()
  })

  it('does not read the TOTAL as a unit price', () => {
    // 74,24 is far outside any pump price, and a figure outside the band is
    // dropped rather than offered: a wrong number in the form is worse than
    // an empty one the driver fills in.
    expect(parseReceiptText('Gesamtbetrag 74,24 EUR/L').pricePerLitre).toBeUndefined()
  })

  it('does not read a tanker-sized quantity', () => {
    expect(parseReceiptText('Menge 9999,00 Liter').litres).toBeUndefined()
  })

  it('does not take a fraction of a litre for a fill', () => {
    expect(parseReceiptText('0,41 L').litres).toBeUndefined()
  })
})

describe('text with nothing in it', () => {
  it('answers an empty result rather than throwing', () => {
    const r = parseReceiptText('')
    expect(r.amount).toBeUndefined()
    expect(r.date).toBeUndefined()
  })

  it('survives text that has no receipt in it at all', () => {
    const r = parseReceiptText('hello\nworld\n\n   \n')
    expect(r.amount).toBeUndefined()
    expect(r.date).toBeUndefined()
  })
})
