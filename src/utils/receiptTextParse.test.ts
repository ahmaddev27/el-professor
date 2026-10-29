/**
 * What the receipt rules read out of OCR text — pinned, because two engines now
 * feed them.
 *
 * `parseReceiptText` used to be the back half of `extractReceiptData`, reachable
 * only through tesseract and a canvas. It is a pure function now, so the same
 * German rules can read text from a phone's own OCR engine as well as from the
 * browser's. That makes these assertions load-bearing in a new way: Reidey's
 * driver app carries a copy of this module, and this file is the fixture set
 * both sides are measured against — its copy is
 * `tests/receipt-text-parse.test.mjs` in that repository, and a change made on
 * one side and not the other fails here rather than disagreeing in silence.
 *
 * **These are characterization tests, not specifications.** They record what the
 * rules do today so that a change becomes visible. One recorded answer is not
 * what anyone would design:
 *
 * - the fuel receipt's amount is CORRECT (74,24, the Gesamtbetrag) and is still
 *   marked `Unsicher`, because `mwst` appears nearby and costs it 80 points.
 *   That is the case the driver app's "confirm this field" marker exists for.
 *
 * A second such answer was retired deliberately on 27.10.2026: the workshop
 * receipt used to report a `receiptNumber` of `'datum'` — the word, cut out of
 * `Belegdatum` — and the bare `Bon|Beleg|Quittung` patterns now require a word
 * boundary, so no number on that invoice means none is reported.
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

  it('reads the street and the station from the header, and no operator', () => {
    expect(r.street).toBe('Hauptstrasse 12')
    expect(r.stationName).toBe('ARAL Tankstelle')
    expect(r.operatorName).toBeUndefined()
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

  it('reports no receipt number rather than a word', () => {
    // Fixed deliberately on 27.10.2026: `Bon|Beleg|Quittung` now require a word
    // boundary, so `Belegdatum` no longer yields the word "datum" as a number.
    // No number on this invoice means none is reported. (The old pinned defect
    // asserted `'datum'` here; it is retired, not forgotten.)
    expect(r.receiptNumber).toBeUndefined()
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

// ── The JET Hagen receipt, 20.10.2026 ────────────────────────────────────────
//
// A real receipt that exposed four misreadings at once: the TSE Anmeldezeit
// (08:46:19) was reported as the sale time instead of the printed `Datum Zeit`
// 08:45; `Summe Netto` outscored `Summe` through the position bonus and 34,52
// was reported as the total with full confidence; the printed Bon number
// (90521) was not read at all; and on a tilted photo the city came out as
// "Hagen Tei.Nr." and the merchant as the street plus the garbled name. Values
// asserted here are what the PAPER prints — the fixture is the receipt, not
// the bug.

/** The rows as printed: name, street, PLZ, contact block, items, totals,
 *  TSE block, and the columnar `Datum Zeit Bon` trailer. */
const JET = `JET Tankstelle Detlev Wüstenfelder
Eckeseyer Straße 113-115
58089 Hagen
Tel.Nr. 0 23 31- 2 24 88
Fax.Nr.0 23 31-92 45 07
Steuer-Nr. 321/5125/2808
www.JET.de
* 19,95 Liter #  08 *  EUR  41,08*A
Super E10
2,059 EUR / Liter
Z-Summe  EUR  41,08
19,00 % MWST. A  EUR  6,56
Summe  EUR  41,08
Bar Indoor  EUR  41,08
19,00 % MWST. A  EUR  6,56
Summe Netto  EUR  34,52
POS S/N: NAMOS-4314-002
TSE S/N: B81779BAB235100F610722F9D42C171
Transaktionsnummer: 1142170
Anmeldezeit (Start): 20.10.2026 08:46:19
Anmeldezeit (Ende): 20.10.2026 08:46:19
Signaturzähler: 2659248
Datum  Zeit  Bon  POS KNo Schicht
20.10.26  08:45  90521  02 0005  848
Wir bedanken uns für Ihren Einkauf und w`

/** The same receipt as a tilted photo yields it: the first two rows merged
 *  left-first, the PLZ row merged with the Tel row, OCR misreads kept. */
const JET_TILTED = `Eckeseyer Straße 113-115  JET Tankstel le Detlev Wtistenfelder
58089 Hagen  Tei.Nr. 0 23 31- 2 24 88
Fax.Nr.0 23 31-92 45 07
Steuer-Nr. 321/5125/2808
www.JET.de
* 19,95 Liter #  08 *  EUR  41,08*A
Super E10
2,059 EUR / Liter
Z-Summe  EUR  41,08
19,00 % MWST. A  EUR  6,56
Summe  EUR  41,08
Bar Indoor  EUR  41,08
19,00 % MWST. A  EUR  6,56
Summe Netto  EUR  34,52
Transaktionsnummer: 1142170
Anmeldezeit (Start): 20.10.2026 08:46:19
Anmeldezeit (Ende): 20.10.2026 08:46:19
Datum  Zeit  Bon  POS KNo Schicht
20.10.26  08:45  90521  02 0005  848
Wir bedanken uns für Ihren Einkauf und w`

describe('the JET Hagen receipt', () => {
  it('reads the printed sale time, not the TSE Anmeldezeit', () => {
    const r = parseReceiptText(JET)
    expect(r.time).toBe('08:45')
    expect(r.tseTime).toBe('08:46:19')
    expect(r.date).toBe('2026-10-20')
  })

  it('takes the Summe, never the Summe Netto, the MWST or the tendered cash', () => {
    expect(parseReceiptText(JET).amount).toBe(41.08)
  })

  it('reads the printed Bon number from the columnar trailer', () => {
    expect(parseReceiptText(JET).bonNumber).toBe('90521')
  })

  it('reads station, operator and street as separate fields, umlauts intact', () => {
    const r = parseReceiptText(JET)
    expect(r.merchantName).toBe('JET Tankstelle Detlev Wüstenfelder')
    expect(r.stationName).toBe('JET Tankstelle')
    expect(r.operatorName).toBe('Detlev Wüstenfelder')
    expect(r.street).toBe('Eckeseyer Straße 113-115')
    expect(r.postalCode).toBe('58089')
    expect(r.city).toBe('Hagen')
  })

  it('reads the fuel figures with the third decimal, and the product confirms the total', () => {
    const r = parseReceiptText(JET)
    expect(r.litres).toBe(19.95)
    expect(r.pricePerLitre).toBe(2.059)
    // 19,95 × 2,059 = 41,077 ≈ the printed 41,08, so the total is confirmed
    // rather than flagged.
    expect(r.amountReason?.startsWith('Unsicher')).toBe(false)
  })
})

describe('the JET receipt as a tilted photo', () => {
  it('does not read the phone number into the city', () => {
    const r = parseReceiptText(JET_TILTED)
    expect(r.city).toBe('Hagen')
    expect(r.postalCode).toBe('58089')
  })

  it('does not let the street contaminate the merchant', () => {
    const r = parseReceiptText(JET_TILTED)
    expect(r.street).toBe('Eckeseyer Straße 113-115')
    expect(r.merchantName?.includes('Straße')).toBe(false)
    expect(r.merchantName?.includes('113')).toBe(false)
  })

  it('keeps the sale time and the total through the tilt', () => {
    const r = parseReceiptText(JET_TILTED)
    expect(r.time).toBe('08:45')
    expect(r.amount).toBe(41.08)
  })
})

// ── Guard rails the JET case exposed, as their own minimal fixtures ──────────

describe('the guards the JET case exposed', () => {
  it('never lets Summe Netto beat a labelled total, whatever its position', () => {
    const r = parseReceiptText(`Tankstelle Test
Gesamtbetrag  EUR  50,00
19,00 % MWST  EUR  7,98
Summe Netto  EUR  42,02`)
    expect(r.amount).toBe(50)
  })

  it('flags a total below litres times price for review, and never replaces it', () => {
    // 30 l × 1,80 = 54,00, yet the only total line says 42,02: on a fuel
    // receipt the total cannot undercut the fuel line alone, so the figure is
    // kept (discounts exist) but marked for the driver to confirm.
    const r = parseReceiptText(`Tankstelle Test
Diesel
30,00 Liter
1,800 EUR / Liter
Gesamtbetrag  EUR  42,02`)
    expect(r.amount).toBe(42.02)
    expect(r.amountReason?.startsWith('Unsicher')).toBe(true)
  })
})

// Station-header hygiene, 29.10.2026: four misreadings off one production
// screenshot — `Esso)` with a stray bracket, `Sol ingen` as the city,
// `JET TANKSTELLE 318` with the branch number glued into the name, and
// `JET Tankstel le …` where the OCR space inside the station word defeated
// the split entirely. General rules; the fixtures are shapes, not that
// screenshot.
describe('the station header hygiene', () => {
  it('strips an unbalanced bracket around the name and heals the city', () => {
    const r = parseReceiptText(`Esso)
Hauptstraße 5
42651 Sol ingen
Summe  EUR  20,00`)
    expect(r.merchantName).toBe('Esso')
    // "ingen" starts lower-case and is no connector word, so it continues
    // the word before it. The PLZ stays untouched beside it.
    expect(r.city).toBe('Solingen')
    expect(r.postalCode).toBe('42651')
  })

  it('keeps balanced brackets as part of the name', () => {
    const r = parseReceiptText(`Tank (24h) Center GmbH
Industriestraße 2
44787 Bochum
Summe  EUR  15,00`)
    expect(r.merchantName).toBe('Tank (24h) Center GmbH')
  })

  it('does not glue real multi-word cities together', () => {
    const frankfurt = parseReceiptText(`Waschpark Mitte
Mainzer Landstraße 50
60311 Frankfurt am Main
Summe  EUR  10,00`)
    expect(frankfurt.city).toBe('Frankfurt am Main')
    const bergisch = parseReceiptText(`Autohaus Nord
Kölner Straße 100
51465 Bergisch Gladbach
Summe  EUR  12,00`)
    expect(bergisch.city).toBe('Bergisch Gladbach')
  })

  it('recognises the split station word on the tilted photo, operator kept as read', () => {
    // `Tankstel le` is the OCR's space, not two words. The keyword itself is
    // repaired — it is a recognised vocabulary word — but the operator's NAME
    // is kept exactly as read (`Wtistenfelder`): a person's spelling is never
    // guessed without the paper.
    const r = parseReceiptText(JET_TILTED)
    expect(r.stationName).toBe('JET Tankstelle')
    expect(r.operatorName).toBe('Detlev Wtistenfelder')
  })

  it('reads a branch number after the station word as its own field', () => {
    const r = parseReceiptText(`JET TANKSTELLE 318
Kölner Str. 8
42651 Solingen
Summe  EUR  30,00`)
    expect(r.stationName).toBe('JET TANKSTELLE')
    expect(r.stationNumber).toBe('318')
    // The full printed line survives untouched beside the split.
    expect(r.merchantName).toBe('JET TANKSTELLE 318')
    // A branch number before the operator leaves the operator intact.
    const withOperator = parseReceiptText(`ARAL Station 77 Hans Meier
Bahnhofstraße 1
50667 Köln
Summe  EUR  25,00`)
    expect(withOperator.stationName).toBe('ARAL Station')
    expect(withOperator.stationNumber).toBe('77')
    expect(withOperator.operatorName).toBe('Hans Meier')
  })

  it('leaves digits inside an ordinary merchant name alone', () => {
    const r = parseReceiptText(`Autoteile 24 GmbH
Bahnhofstraße 1
50667 Köln
Summe  EUR  9,99`)
    expect(r.merchantName).toBe('Autoteile 24 GmbH')
    expect(r.stationNumber).toBeUndefined()
  })

  it('reports no branch number as no field, not an empty one', () => {
    expect(parseReceiptText(JET).stationNumber).toBeUndefined()
  })
})

// The Shell Düsseldorf receipt, 29.10.2026: a real long receipt (marketing
// tail, TSE block with `Start/Ende`, a labelled `Obj.-Nr.`). What it pins:
// the printed sale stamp 15:47 beside the Beleg-Nr wins over the TSE
// Start/Ende clock; the labelled object number is the station's own number;
// and the thermal misread of the litre unit (`l` → `1`) is readable when —
// and only when — the price-per-litre label anchors the same line.

const SHELL = `Shell Station
Goller Tankstellen GmbH
Niederrheinstr. 135
40474 Düsseldorf
Obj.-Nr.: 0000003708  Tel.: 0211/454791
Fax.: 0211/459582
Beleg-Nr. 3933/010/0002 28.09.2026 15:47
*U00002 Super FuelSave E16  50,00 EUR *A*
*Zp 02  21,94 l  2,279 EUR/l  *  *
Gesamtbetrag  50,00 EUR
gegeben  50,00 EUR
Typ  Netto  MwSt  Brutto
A:19,00%  42,02  7,98  50,00
Legende der Steuernummer(n)
# Gesellschaft  DE 811127597
DIENSTAG IST WASCHTAG !!!
Sparen Sie 1 EUR je Fahrzeugwäsche !!!
POS:68007-0000003708-2 TSE-Beleg-Nr. 336123
Signaturzähler: 359534
Start/Ende: 28.09.2026 16:47:26 / 28.09.2026 16:47:51`

/** The same receipt with the litre unit and the price's `l` misread as `1`. */
const SHELL_MISREAD = SHELL.replace(
  '*Zp 02  21,94 l  2,279 EUR/l  *  *',
  '*Zp 02  21,94 1  2,279 EUR/1  *  *',
)

describe('the Shell Düsseldorf receipt', () => {
  it('reads the printed sale time, not the TSE Start/Ende clock', () => {
    const r = parseReceiptText(SHELL)
    expect(r.date).toBe('2026-09-28')
    expect(r.time).toBe('15:47')
    expect(r.tseTime).toBe('16:47:26')
  })

  it('reads the Gesamtbetrag, and the fuel figures confirm it', () => {
    const r = parseReceiptText(SHELL)
    expect(r.amount).toBe(50)
    expect(r.litres).toBe(21.94)
    expect(r.pricePerLitre).toBe(2.279)
    expect(r.amountReason?.startsWith('Unsicher')).toBe(false)
  })

  it('reads station, street, city, and the labelled Obj number', () => {
    const r = parseReceiptText(SHELL)
    expect(r.stationName).toBe('Shell Station')
    expect(r.street).toBe('Niederrheinstr. 135')
    expect(r.postalCode).toBe('40474')
    expect(r.city).toBe('Düsseldorf')
    expect(r.stationNumber).toBe('0000003708')
    expect(r.receiptNumber).toBe('3933/010/0002')
  })

  it('still parses the fuel line with l misread as 1, anchored', () => {
    const r = parseReceiptText(SHELL_MISREAD)
    expect(r.pricePerLitre).toBe(2.279)
    expect(r.litres).toBe(21.94)
    expect(r.amount).toBe(50)
  })

  it('never takes a bare digit as litres without the price anchor', () => {
    const r = parseReceiptText(`Tankstelle Test
Posten 23,50 1
Gesamtbetrag  EUR  23,50`)
    expect(r.litres).toBeUndefined()
  })

  it('reads a labelled Tankstellen-Nr as the station number too', () => {
    const r = parseReceiptText(`Aral Tankstelle
Hauptstraße 1
40627 Düsseldorf
Tankstellen-Nr.: 0201099115
Summe  EUR  20,00`)
    expect(r.stationNumber).toBe('0201099115')
  })

  it('lets the number in the printed name win over a labelled one', () => {
    const r = parseReceiptText(`JET TANKSTELLE 318
Kölner Str. 8
42651 Solingen
Tankstellen-Nr.: 999
Summe  EUR  30,00`)
    expect(r.stationNumber).toBe('318')
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
