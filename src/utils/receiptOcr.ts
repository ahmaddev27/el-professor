import { createWorker } from 'tesseract.js';

export interface OcrResult {
  date?: string;          // ISO yyyy-MM-dd
  time?: string;          // HH:mm
  receiptNumber?: string;
  amount?: number;
  postalCode?: string;
  city?: string;
  category?: string;
  merchantName?: string;
  // Confidence metadata for UI highlighting
  amountConfidence?: number;   // 0-100
  dateConfidence?: number;     // 0-100
  amountReason?: string;
  dateReason?: string;
  // Debug: all candidates found (including rejected)
  amountCandidates?: OcrCandidate[];
  dateCandidates?: OcrCandidate[];
  plzCandidates?: PlzDebugCandidate[];
}

export interface PlzDebugCandidate {
  postalCode: string;
  city: string;
  score: number;
  reason: string;
  rejected: boolean;
  rejectedReason?: string;
}

export interface OcrCandidate {
  field: 'date' | 'amount';
  value: string;
  score: number;
  reason: string;
  sourceLine: string;
  rejected?: boolean;
  rejectedReason?: string;
}

// ── Image preprocessing via Canvas ──────────────────────────────────────────

function preprocessImage(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const scale = Math.max(1, Math.min(3, 1600 / Math.max(img.width, img.height)));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);
        const d = imageData.data;
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          const c = Math.min(255, Math.max(0, (lum - 128) * 1.5 + 128));
          d[i] = d[i + 1] = d[i + 2] = c;
        }
        ctx.putImageData(imageData, 0, 0);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/png'));
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

// ── OCR text normalization ───────────────────────────────────────────────────

function normalizeOcrText(raw: string): string {
  return raw
    .replace(/€/g, 'EUR')
    .replace(/\bEUF\b/g, 'EUR')   // OCR misreads EUR as EUF
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// ── Date-part detection ──────────────────────────────────────────────────────
// Build a set of all substrings that are known parts of dates in the full text.
// Used to reject amount candidates that are date fragments (e.g. "09.06" from "09.06.2026").

function buildDatePartSet(lines: string[]): Set<string> {
  const parts = new Set<string>();
  // Match full German dates DD.MM.YYYY or DD.MM.YY (4 or 2 digit year)
  const fullDate4 = /\b(\d{1,2}\.\d{1,2}\.\d{4})\b/g;
  const fullDate2 = /\b(\d{1,2}\.\d{1,2}\.\d{2})\b/g;
  // ISO dates YYYY-MM-DD
  const isoDate = /\b(\d{4}-\d{2}-\d{2})\b/g;
  // Slash dates DD/MM/YYYY
  const slashDate = /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/g;

  for (const line of lines) {
    for (const re of [fullDate4, fullDate2, isoDate, slashDate]) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        const full = m[1];
        parts.add(full);
        // Also add the DD.MM prefix that could look like an amount
        const ddmm = full.match(/^(\d{1,2}\.\d{1,2})\./);
        if (ddmm) parts.add(ddmm[1]);
        // Add all sub-pairs with commas too (e.g. "09,06" from misread)
        const ddmmComma = full.replace('.', ',').match(/^(\d{1,2},\d{1,2})\./);
        if (ddmmComma) parts.add(ddmmComma[1]);
      }
    }
  }
  return parts;
}

// Check if a raw amount string (like "09.06" or "09,06") is a date fragment
function isDatePart(raw: string, datePartSet: Set<string>): boolean {
  return datePartSet.has(raw) || datePartSet.has(raw.replace(',', '.')) || datePartSet.has(raw.replace('.', ','));
}

// ── Amount candidate extraction ──────────────────────────────────────────────

// Labels confirming the final total — scored strongly positive
const TOTAL_LABEL_RE = /\b(gesamtbetrag|z[-\s]?summe|endbetrag|zu\s*zahlen|total|summe\s*eur|summe)\b/i;
// Secondary total labels
const SECONDARY_TOTAL_RE = /\b(brutto|betrag)\b/i;

// Labels that strongly indicate the amount is NOT the final total
const IGNORE_LABEL_RE = /\b(netto|mwst|mehrwertsteuer|ust|steuer|rückgeld|wechselgeld|gegeben|bar\s*gegeben)\b/i;

// Lines that should never produce amount candidates
const SKIP_LINE_RE = /\b(datum|uhrzeit|startzeitpunkt|beendigungszeitpunkt|tse|seriennr|signaturz|tel\.?|fax|steuer[-\s]?nr|ust[-\s]?id|belegnummer|beleg[-\s]?nr|bon[-\s]?nr|kassenid|terminal|kartenklasse|trace|genehmigung|ktm|pan|aid|tvr|tsi|arc)\b/i;

// Lines containing fuel quantity/unit-price — amounts on these lines are NOT totals.
// Matches: "14,21 l", "1,829 EUR/l", "EUR/L", "€/l", "EUR pro Liter", etc.
const FUEL_UNIT_LINE_RE = /eur\s*\/\s*l|EUR\/L|€\s*\/\s*l|\d+[,\.]\d+\s*l\b|liter|ltr\b|menge|preis\s*\/\s*l|einzelpreis|eur\s*pro\s*l/i;

// Amount format: 25,32 or 25.32
const AMOUNT_RE = /\b(\d{1,4}[,\.]\d{2})\b/g;

function parseRawAmount(raw: string): number | null {
  // German: 25,32 → 25.32; English: 25.32 → 25.32
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  const n = parseFloat(normalized);
  if (isNaN(n) || n <= 0 || n >= 10000) return null;
  return Math.round(n * 100) / 100;
}

// Format a number as German decimal string: 41.47 → "41,47"
export function formatAmountDE(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function extractAmountCandidates(lines: string[], datePartSet: Set<string>): OcrCandidate[] {
  const candidates: OcrCandidate[] = [];

  // Pre-scan: collect total-label values and compute gegeben/Rückgeld expected total
  const gesamtValues = new Set<string>();
  const bruttoValues = new Set<string>();

  // Gegeben/Rückgeld consistency: expectedTotal = gegeben - Rückgeld
  let gegebenAmount: number | null = null;
  let rueckgeldAmount: number | null = null;

  for (const line of lines) {
    const lower = line.toLowerCase();
    const amtsInLine = [...line.matchAll(AMOUNT_RE)].map(m => m[1]);
    if (/gesamtbetrag|z[-\s]?summe|endbetrag|zu\s*zahlen|total/i.test(line)) {
      amtsInLine.forEach(v => gesamtValues.add(v.replace(',', '.')));
    }
    if (/\bbrutto\b/i.test(line) && !/netto|mwst/i.test(lower)) {
      amtsInLine.forEach(v => bruttoValues.add(v.replace(',', '.')));
    }
    // Capture gegeben and Rückgeld amounts for consistency cross-check
    if (/\bgegeben\b/i.test(line) && !/rückgeld|wechselgeld/i.test(line)) {
      const first = amtsInLine[amtsInLine.length - 1]; // last amount on line = the value
      if (first) gegebenAmount = parseRawAmount(first);
    }
    if (/\b(rückgeld|wechselgeld)\b/i.test(line)) {
      const first = amtsInLine[amtsInLine.length - 1];
      if (first) rueckgeldAmount = parseRawAmount(first);
    }
  }

  // If gegeben and Rückgeld both found, derive expected total
  const expectedTotal: number | null =
    gegebenAmount !== null && rueckgeldAmount !== null
      ? Math.round((gegebenAmount - rueckgeldAmount) * 100) / 100
      : null;

  lines.forEach((line, idx) => {
    // Hard skip: lines that should never produce amounts
    if (SKIP_LINE_RE.test(line)) return;

    // Hard skip: fuel quantity/unit-price lines — "14,21 l", "1,829 EUR/l", etc.
    if (FUEL_UNIT_LINE_RE.test(line)) {
      // Still emit rejected candidates for debug visibility
      const amts = [...line.matchAll(AMOUNT_RE)];
      for (const match of amts) {
        candidates.push({
          field: 'amount',
          value: match[1],
          score: -9999,
          reason: '',
          sourceLine: line.trim(),
          rejected: true,
          rejectedReason: 'Kraftstoff-Mengen/Einheitspreis-Zeile (EUR/l, Liter, etc.)',
        });
      }
      return;
    }

    const amounts = [...line.matchAll(AMOUNT_RE)];
    if (amounts.length === 0) return;

    for (const match of amounts) {
      const raw = match[1];

      // Reject: date fragment
      if (isDatePart(raw, datePartSet)) {
        candidates.push({
          field: 'amount',
          value: raw,
          score: -9999,
          reason: '',
          sourceLine: line.trim(),
          rejected: true,
          rejectedReason: `Teil eines Datums (${raw})`,
        });
        continue;
      }

      const parsed = parseRawAmount(raw);
      if (parsed === null) continue;

      // Reject: too small to be a fuel/service total
      if (parsed < 1) {
        candidates.push({
          field: 'amount',
          value: raw,
          score: -9999,
          reason: '',
          sourceLine: line.trim(),
          rejected: true,
          rejectedReason: 'Betrag < 1 EUR',
        });
        continue;
      }

      // Reject: liter quantity suffix immediately after amount ("14,21 l")
      const matchPos = line.indexOf(raw);
      const afterMatch = line.slice(matchPos + raw.length).trimStart();
      if (/^l\b/i.test(afterMatch)) {
        candidates.push({
          field: 'amount',
          value: raw,
          score: -9999,
          reason: '',
          sourceLine: line.trim(),
          rejected: true,
          rejectedReason: 'Literangabe nach Zahl (Kraftstoffmenge, kein Betrag)',
        });
        continue;
      }

      let score = 10;
      const reasons: string[] = [];

      const normalizedRaw = raw.replace(',', '.');

      // Context lines
      const prevLine = lines[idx - 1] ?? '';
      const nextLine = lines[idx + 1] ?? '';
      const context = [prevLine, line, nextLine].join(' ').toLowerCase();

      // +100: Gesamtbetrag on same line
      if (TOTAL_LABEL_RE.test(line)) {
        score += 100;
        const lbl = line.match(TOTAL_LABEL_RE)?.[0] ?? '';
        reasons.push(`+100 Label: ${lbl}`);
      } else if (TOTAL_LABEL_RE.test(prevLine) || TOTAL_LABEL_RE.test(nextLine)) {
        // +90: Gesamtbetrag on adjacent line
        score += 90;
        reasons.push('+90 Label auf Nachbarzeile');
      }

      // +70: EUR on same line
      if (/EUR/.test(line)) {
        score += 70;
        reasons.push('+70 EUR auf gleicher Zeile');
      }

      // +60: same value also appears near Brutto (tax table confirmation)
      if (bruttoValues.has(normalizedRaw)) {
        score += 60;
        reasons.push('+60 Wert auch bei Brutto');
      }

      // +80: value matches expectedTotal derived from gegeben − Rückgeld
      // e.g. 30,00 − 4,01 = 25,99 → strong confirmation this is the real total
      if (expectedTotal !== null && Math.abs(parsed - expectedTotal) < 0.01) {
        score += 80;
        reasons.push(`+80 Stimmt mit gegeben−Rückgeld überein (${expectedTotal.toFixed(2)})`);
      }

      // Negative: excluded labels in context
      if (IGNORE_LABEL_RE.test(context)) {
        const lbl = context.match(IGNORE_LABEL_RE)?.[0] ?? '';
        score -= 80;
        reasons.push(`-80 Ausschluss-Label: ${lbl}`);
      }

      // Negative: secondary total in context (Brutto in tax block)
      if (SECONDARY_TOTAL_RE.test(line) && !TOTAL_LABEL_RE.test(line)) {
        score -= 10;
        reasons.push('-10 Nur Brutto/Betrag ohne Hauptlabel');
      }

      // Position bonus: lower in receipt = closer to totals
      const positionBonus = Math.floor((idx / Math.max(lines.length, 1)) * 20);
      score += positionBonus;

      candidates.push({
        field: 'amount',
        value: raw,
        score,
        reason: reasons.join('; ') || 'Betrag gefunden',
        sourceLine: line.trim(),
        rejected: false,
      });
    }
  });

  return candidates;
}

// ── Date candidate extraction ────────────────────────────────────────────────

const DATE_LABEL_RE = /\b(datum|date|beleg[-\s]?datum|startzeitpunkt|tse[-\s]?start|belegdatum)\b/i;
const DATE_NOISE_RE = /\b(tse|seriennr|signaturz|steuer[-\s]?nr|ust[-\s]?id|trace|genehmigung)\b/i;

const DATE_PATTERNS = [
  /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/,
  /\b(\d{1,2})\.(\d{1,2})\.(\d{2})\b/,
  /\b(\d{4})-(\d{2})-(\d{2})\b/,
];

function tryParseDate(m: RegExpMatchArray): string | null {
  let day: string, month: string, year: string;
  if (m[0].includes('-')) {
    year = m[1]; month = m[2]; day = m[3];
  } else {
    day = m[1].padStart(2, '0');
    month = m[2].padStart(2, '0');
    year = m[3].length === 2 ? '20' + m[3] : m[3];
  }
  const iso = `${year}-${month}-${day}`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  if (parseInt(year) < 2000 || parseInt(year) > 2099) return null;
  if (parseInt(month) < 1 || parseInt(month) > 12) return null;
  if (parseInt(day) < 1 || parseInt(day) > 31) return null;
  return iso;
}

function extractDateCandidates(lines: string[]): OcrCandidate[] {
  const candidates: OcrCandidate[] = [];

  lines.forEach((line, idx) => {
    if (DATE_NOISE_RE.test(line) && !DATE_LABEL_RE.test(line)) return;

    for (const pat of DATE_PATTERNS) {
      const m = line.match(pat);
      if (!m) continue;
      const iso = tryParseDate(m);
      if (!iso) continue;

      let score = 20;
      const reasons: string[] = [];

      if (DATE_LABEL_RE.test(line)) {
        score += 50;
        reasons.push('+50 Datum-Label auf gleicher Zeile');
      } else if (DATE_LABEL_RE.test(lines[idx - 1] ?? '')) {
        score += 35;
        reasons.push('+35 Datum-Label auf Vorzeile');
      }

      const hasTime = /\b\d{1,2}:\d{2}\b/.test(line) || /\b\d{1,2}:\d{2}\b/.test(lines[idx + 1] ?? '');
      if (hasTime) {
        score += 20;
        reasons.push('+20 Uhrzeit in Nähe');
      }

      const earlyBonus = Math.floor(((lines.length - idx) / Math.max(lines.length, 1)) * 15);
      score += earlyBonus;

      if (DATE_NOISE_RE.test(line) && !DATE_LABEL_RE.test(line)) {
        score -= 40;
        reasons.push('-40 TSE/technische Zeile');
      }

      candidates.push({
        field: 'date',
        value: iso,
        score,
        reason: reasons.join('; ') || 'Datum gefunden',
        sourceLine: line.trim(),
        rejected: false,
      });
    }
  });

  return candidates;
}

// ── PLZ/Stadt candidate extraction ──────────────────────────────────────────

// Footer / legal address: these words on the SAME LINE as the PLZ indicate it's a legal footer.
// Must NOT include station operator names (ROC Deutschland GmbH, Echo Tankstellen GmbH, etc.)
// which appear at the top of the receipt, not the footer.
const PLZ_FOOTER_RE = /\b(postfach|p\.?o\.?\s*box|ustidnr|ust[-\s]?id|steuernummer|steuer[-\s]?nr|verkauf\s*an|abweichend)\b/i;

// Labels on the SAME LINE as the 5-digit number that indicate it is NOT a PLZ.
// These only fire on the candidate line itself — NOT on adjacent lines.
const PLZ_BAD_SAME_LINE_RE = /\b(belegnummer|beleg[-\s]?nr|bon[-\s]?nr|tse[-\s]?beleg|signaturz|ust[-\s]?id|steuernummer|steuer[-\s]?nr|kundenr|kassennr|trace|genehmigung|terminal|ktm|vsn)\b/i;

// Receipt body start — first line with a transaction/detail label
const BODY_START_RE = /\b(datum|uhrzeit|belegnummer|beleg[-\s]?nr|super\s*e10|diesel|benzin|gesamtbetrag|summe|netto|mwst|brutto)\b/i;

interface PlzCandidate {
  postalCode: string;
  city: string;
  score: number;
  lineIdx: number;
  reason: string;
  rejected: boolean;
  rejectedReason?: string;
}

function extractPlzCandidates(lines: string[]): PlzCandidate[] {
  const candidates: PlzCandidate[] = [];

  // Find where the receipt body starts (first line with a transaction label)
  let bodyStartIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (BODY_START_RE.test(lines[i])) {
      bodyStartIdx = i;
      break;
    }
  }

  const isValidCity = (city: string): boolean => {
    const c = city.trim();
    if (c.length < 2) return false;
    if (/^\d+$/.test(c)) return false;
    if (/^[A-Z]{1,3}$/.test(c)) return false;
    if (/[\/\\|#@]/.test(c)) return false;
    return true;
  };

  // Core logic — all rejections check only the candidate's own line, NOT adjacent lines.
  // This prevents Tel./Fax on the line AFTER the PLZ from falsely rejecting the PLZ.
  const tryAdd = (postalCode: string, rawCity: string, lineIdx: number, adjacent: boolean) => {
    const city = rawCity.trim().split(/\s{2,}/)[0].trim();
    if (!isValidCity(city)) return;

    const line = lines[lineIdx] ?? '';
    const prevLine = lines[lineIdx - 1] ?? '';

    // Reject: 5-digit number embedded in slash-separated code on same line (e.g. "3966/00001/014")
    if (/\/\d{5}[\/\s]|\d+\/\d{5}$/.test(line)) {
      candidates.push({ postalCode, city, score: -9999, lineIdx, reason: '', rejected: true, rejectedReason: 'Belegnummer-Segment (Slash-Muster)' });
      return;
    }

    // Reject: known-bad label is on the SAME LINE as the PLZ candidate only
    if (PLZ_BAD_SAME_LINE_RE.test(line)) {
      candidates.push({ postalCode, city, score: -9999, lineIdx, reason: '', rejected: true, rejectedReason: `Technisches Label auf gleicher Zeile: ${line.trim().slice(0, 50)}` });
      return;
    }

    // Reject: footer/legal keywords on the same line as the PLZ
    if (PLZ_FOOTER_RE.test(line)) {
      candidates.push({ postalCode, city, score: -9999, lineIdx, reason: '', rejected: true, rejectedReason: `Footer/rechtliche Adresse: ${line.trim().slice(0, 50)}` });
      return;
    }

    // Reject: appears well after the receipt body started
    if (lineIdx > bodyStartIdx + 1) {
      candidates.push({ postalCode, city, score: -9999, lineIdx, reason: '', rejected: true, rejectedReason: `Nach Belegkopf (Zeile ${lineIdx} > Körperbeginn ${bodyStartIdx})` });
      return;
    }

    let score = 20;
    const reasons: string[] = [];

    if (lineIdx < lines.length * 0.35) {
      score += 100;
      reasons.push('+100 Im oberen Drittel');
    } else {
      score += 40;
      reasons.push('+40 Im oberen Bereich');
    }

    // Bonus: line before looks like a street address
    if (/\b(str\.|straße|gasse|allee|weg|platz|ring|damm|chaussee|ufer)\b/i.test(prevLine)) {
      score += 80;
      reasons.push('+80 Nach Straßenzeile');
    }

    if (adjacent) {
      score -= 10;
      reasons.push('-10 PLZ/Stadt aus Nachbarzeilen');
    }

    candidates.push({ postalCode, city, score, lineIdx, reason: reasons.join('; ') || 'PLZ gefunden', rejected: false });
  };

  // ── Pass 1: inline — "42655 Solingen" on the same OCR line ─────────────────
  const PLZ_INLINE_RE = /\b(\d{5})\s+([A-ZÄÖÜa-zäöüß][A-Za-zÄÖÜäöüß .-]{1,40})/g;
  lines.forEach((line, idx) => {
    PLZ_INLINE_RE.lastIndex = 0;
    for (const m of line.matchAll(PLZ_INLINE_RE)) {
      tryAdd(m[1], m[2], idx, false);
    }
  });

  // ── Pass 2: adjacent — "42655" on line N, "Solingen" on line N+1 ───────────
  const PLZ_ALONE_RE = /^\s*(\d{5})\s*$/;
  lines.forEach((line, idx) => {
    const m = line.match(PLZ_ALONE_RE);
    if (!m) return;
    const postalCode = m[1];
    const nextLine = (lines[idx + 1] ?? '').trim();
    if (
      nextLine.length >= 2 &&
      /^[A-ZÄÖÜa-zäöüß]/.test(nextLine) &&
      !/\d/.test(nextLine) &&
      nextLine.length <= 50
    ) {
      tryAdd(postalCode, nextLine, idx, true);
    }
  });

  return candidates;
}

// ── Other parsers ────────────────────────────────────────────────────────────

function parseTime(lines: string[]): string | undefined {
  for (const line of lines) {
    const m = line.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/);
    if (!m) continue;
    const h = parseInt(m[1]);
    const min = parseInt(m[2]);
    if (h > 23 || min > 59) continue;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  return undefined;
}

function parseReceiptNumber(text: string): string | undefined {
  const patterns = [
    /(?:TSE-?Beleg-?Nr\.?|Beleg-?Nr\.?|Belegnummer|Bon-?Nr\.?|Rechnungs-?Nr\.?|Quittungs-?Nr\.?)[:\s#]*([A-Z0-9\/\-\.]{4,30})/i,
    /(?:Bon|Beleg|Quittung)\s*[:#]?\s*([A-Z0-9\/\-\.]{4,30})/i,
    /\b(\d{4}\/\d{5}\/\d{3})\b/,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return m[1].trim();
  }
  return undefined;
}

function parseCategory(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (/\b(benzin|diesel|kraftstoff|tanken|tank|super|e5|e10|sprit|fuel|petrol|gas\s*station)\b/.test(lower)) return 'Tanken';
  if (/\b(autowäsche|car\s*wash|wasch|wäsche)\b/.test(lower)) return 'Autowäsche';
  if (/\b(öl|oil|ölwechsel|oil\s*change)\b/.test(lower)) return 'Öl wechseln';
  if (/\b(zubehör|ersatzteile|auto\s*parts|accessory)\b/.test(lower)) return 'Autozubehör';
  return undefined;
}

function parseMerchantName(lines: string[]): string | undefined {
  const meaningful = lines.filter(l => l.length > 2 && !/^\d+$/.test(l));
  return meaningful[0] || undefined;
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function extractReceiptData(
  file: File | Blob,
  onProgress?: (pct: number) => void,
): Promise<OcrResult> {
  const dataUrl = await preprocessImage(file);

  const worker = await createWorker('deu+eng', 1, {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text' && onProgress) {
        onProgress(Math.round(m.progress * 100));
      }
    },
  });

  try {
    const { data: { text } } = await worker.recognize(dataUrl);

    const normalized = normalizeOcrText(text);
    const lines = normalized.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const fullText = lines.join('\n');

    // Build date-part lookup for amount rejection
    const datePartSet = buildDatePartSet(lines);

    // ── Amount candidates ──────────────────────────────────────────────────
    const amountCandidates = extractAmountCandidates(lines, datePartSet);
    const amountValid = amountCandidates.filter(c => !c.rejected).sort((a, b) => b.score - a.score);
    const bestAmount = amountValid[0];

    // ── Date candidates ────────────────────────────────────────────────────
    const dateCandidates = extractDateCandidates(lines);
    const dateValid = dateCandidates.filter(c => !c.rejected).sort((a, b) => b.score - a.score);
    const bestDate = dateValid[0];

    // ── PLZ candidates ─────────────────────────────────────────────────────
    const plzCandidates = extractPlzCandidates(lines);
    const plzValid = plzCandidates.filter(c => !c.rejected).sort((a, b) => b.score - a.score);
    const bestPlz = plzValid[0];

    // ── Confidence thresholds ──────────────────────────────────────────────
    const CONFIDENT = 50;
    const UNCERTAIN = 25;

    const result: OcrResult = {};

    if (bestDate && bestDate.score >= UNCERTAIN) {
      result.date = bestDate.value;
      result.dateConfidence = Math.min(100, bestDate.score);
      result.dateReason = bestDate.reason;
    }
    if (result.dateConfidence !== undefined && result.dateConfidence < CONFIDENT) {
      result.dateReason = `Unsicher: ${result.dateReason}`;
    }

    if (bestAmount && bestAmount.score >= UNCERTAIN) {
      result.amount = parseRawAmount(bestAmount.value) ?? undefined;
      result.amountConfidence = Math.min(100, bestAmount.score);
      result.amountReason = bestAmount.reason;
    }
    if (result.amountConfidence !== undefined && result.amountConfidence < CONFIDENT) {
      result.amountReason = `Unsicher: ${result.amountReason}`;
    }

    if (bestPlz) {
      result.postalCode = bestPlz.postalCode;
      result.city = bestPlz.city;
    }

    result.time = parseTime(lines);
    result.receiptNumber = parseReceiptNumber(fullText);
    result.category = parseCategory(fullText);
    result.merchantName = parseMerchantName(lines);

    // Debug: include rejected candidates too (up to 8 total per field)
    result.plzCandidates = plzCandidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(c => ({
        postalCode: c.postalCode,
        city: c.city,
        score: c.score,
        reason: c.reason,
        rejected: c.rejected,
        rejectedReason: c.rejectedReason,
      }));
    result.amountCandidates = amountCandidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    result.dateCandidates = dateCandidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    return result;
  } finally {
    await worker.terminate();
  }
}
