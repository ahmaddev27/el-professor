/**
 * Stands in for src/utils/receiptOcr.ts: Tesseract downloads its language data
 * and takes seconds, and a screenshot needs one fixed answer. The scenario's
 * `ocr` parameter picks what a scanned image yields:
 *
 *   ok         every field read with confidence
 *   uncertain  date and amount read, both marked "Unsicher" (the default)
 *   fail       nothing read at all
 *
 * The answers are shaped exactly like the real module's, candidates and the
 * German reason strings included, and progress is reported twice on the way.
 * Every other export (formatAmountDE among them) is the real module's.
 */
import type { OcrResult } from '../../src/utils/receiptOcr';
import { scenario } from '../scenario';

export * from '../../src/utils/receiptOcr';

const CANDIDATES: OcrResult = {
  amountCandidates: [
    { field: 'amount', value: '41,47', score: 44, reason: 'Zeile mit "SUMME"', sourceLine: 'SUMME EUR 41,47' },
    { field: 'amount', value: '34,85', score: 18, reason: 'Nettobetrag', sourceLine: 'Netto 34,85 MwSt 19% 6,62' },
    { field: 'amount', value: '2026', score: 0, reason: '', sourceLine: '12.09.2026 17:42', rejected: true, rejectedReason: 'Teil eines Datums' },
  ],
  dateCandidates: [
    { field: 'date', value: '2026-09-12', score: 40, reason: 'Datum mit Uhrzeit', sourceLine: '12.09.2026 17:42' },
  ],
  plzCandidates: [
    { postalCode: '13405', city: 'Berlin', score: 60, reason: 'PLZ vor Ortsname', rejected: false },
  ],
};

const ANSWERS: Record<typeof scenario.ocr, OcrResult> = {
  ok: {
    ...CANDIDATES,
    date: '2026-09-12',
    amount: 41.47,
    postalCode: '13405',
    city: 'Berlin',
    category: 'Tanken',
    amountConfidence: 88,
    dateConfidence: 90,
    amountReason: 'Zeile mit "SUMME"',
    dateReason: 'Datum mit Uhrzeit',
  },
  uncertain: {
    ...CANDIDATES,
    date: '2026-09-12',
    amount: 41.47,
    postalCode: '13405',
    city: 'Berlin',
    category: 'Tanken',
    amountConfidence: 44,
    dateConfidence: 40,
    amountReason: 'Unsicher: Zeile mit "SUMME"',
    dateReason: 'Unsicher: Datum mit Uhrzeit',
  },
  fail: {},
};

export async function extractReceiptData(
  _file: File | Blob,
  onProgress?: (pct: number) => void,
): Promise<OcrResult> {
  await new Promise(resolve => setTimeout(resolve, 150));
  onProgress?.(40);
  await new Promise(resolve => setTimeout(resolve, 150));
  onProgress?.(100);
  return JSON.parse(JSON.stringify(ANSWERS[scenario.ocr])) as OcrResult;
}
