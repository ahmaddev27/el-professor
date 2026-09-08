/**
 * German public holiday calculator with Bundesland support.
 *
 * Single source of truth for:
 * - Monatsplanung Stundennachweis Preview
 * - Stundennachweis PDF export
 * - Salary calculation (Feiertag premium)
 */

/** Normalise a Bundesland string to a canonical two-letter code. */
export function normaliseBundesland(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = raw.trim().toLowerCase();
  // Two-letter abbreviations
  if (s === 'bw') return 'BW';
  if (s === 'by' || s === 'bavaria') return 'BY';
  if (s === 'be' || s === 'berlin') return 'BE';
  if (s === 'bb' || s === 'brandenburg') return 'BB';
  if (s === 'hb' || s === 'bremen') return 'HB';
  if (s === 'hh' || s === 'hamburg') return 'HH';
  if (s === 'he' || s === 'hessen' || s === 'hesse') return 'HE';
  if (s === 'mv' || s === 'mecklenburg') return 'MV';
  if (s === 'ni' || s === 'niedersachsen' || s === 'lower saxony') return 'NI';
  if (
    s === 'nrw' ||
    s === 'nw' ||
    s === 'nordrhein-westfalen' ||
    s === 'nordrhein westfalen' ||
    s === 'north rhine-westphalia'
  ) return 'NW';
  if (s === 'rp' || s === 'rheinland-pfalz' || s === 'rhineland-palatinate') return 'RP';
  if (s === 'sl' || s === 'saarland') return 'SL';
  if (s === 'sn' || s === 'sachsen' || s === 'saxony') return 'SN';
  if (s === 'st' || s === 'sachsen-anhalt') return 'ST';
  if (s === 'sh' || s === 'schleswig-holstein') return 'SH';
  if (s === 'th' || s === 'thüringen' || s === 'thuringia') return 'TH';
  return '';
}

/**
 * Compute Easter Sunday for a given year using the Gauss/Anonymous Gregorian algorithm.
 * Returns a UTC Date at midnight.
 */
function easterSundayUTC(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 1-based
  const day   = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function utcOffset(d: Date, offsetDays: number): Date {
  return new Date(d.getTime() + offsetDays * 86400000);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function utcDateStr(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Returns a Set of YYYY-MM-DD holiday strings for the given year and Bundesland.
 *
 * Pass `bundesland` as a raw string from company_settings.state — it will be
 * normalised automatically.  Pass null/'' to get only nationwide (federal)
 * holidays.
 *
 * Nationwide holidays included for all Bundesländer:
 *   Neujahr, Karfreitag, Ostermontag, Tag der Arbeit, Christi Himmelfahrt,
 *   Pfingstmontag, Tag der Deutschen Einheit, 1. + 2. Weihnachtstag
 *
 * NW (NRW) additions:
 *   Fronleichnam, Allerheiligen
 */
export function getHolidaysForYear(year: number, bundesland?: string | null): Set<string> {
  const bl = normaliseBundesland(bundesland);
  const set = new Set<string>();
  const add = (y: number, m: number, d: number) => set.add(`${y}-${pad2(m)}-${pad2(d)}`);

  // ── Fixed nationwide holidays ────────────────────────────────────────────
  add(year, 1, 1);    // Neujahr
  add(year, 5, 1);    // Tag der Arbeit
  add(year, 10, 3);   // Tag der Deutschen Einheit
  add(year, 12, 25);  // 1. Weihnachtstag
  add(year, 12, 26);  // 2. Weihnachtstag

  // ── Easter-based nationwide holidays ────────────────────────────────────
  const easter = easterSundayUTC(year);
  set.add(utcDateStr(utcOffset(easter, -2)));  // Karfreitag    (Good Friday)
  set.add(utcDateStr(utcOffset(easter, +1)));  // Ostermontag   (Easter Monday)
  set.add(utcDateStr(utcOffset(easter, +39))); // Christi Himmelfahrt (Ascension)
  set.add(utcDateStr(utcOffset(easter, +50))); // Pfingstmontag (Whit Monday)

  // ── Bundesland-specific additions ────────────────────────────────────────
  if (bl === 'NW' || bl === 'BW' || bl === 'BY' || bl === 'HE' || bl === 'RP' || bl === 'SL') {
    // Fronleichnam = 60 days after Easter Sunday
    set.add(utcDateStr(utcOffset(easter, +60)));
  }

  if (bl === 'NW' || bl === 'BY' || bl === 'RP' || bl === 'SL' || bl === 'ST' || bl === 'TH') {
    // Allerheiligen (All Saints) — 1 November; only some Bundesländer
    if (bl === 'NW' || bl === 'BY' || bl === 'RP' || bl === 'SL') {
      add(year, 11, 1);
    }
  }

  if (bl === 'BY' || bl === 'SL') {
    // Mariä Himmelfahrt — 15 August
    add(year, 8, 15);
  }

  if (bl === 'BW' || bl === 'BY' || bl === 'ST') {
    // Heilige Drei Könige — 6 January
    add(year, 1, 6);
  }

  if (bl === 'SN' || bl === 'TH') {
    // Buß- und Bettag — Wednesday before 23 November
    const nov23 = new Date(Date.UTC(year, 10, 23));
    const bbt = new Date(nov23.getTime() - ((nov23.getUTCDay() + 4) % 7) * 86400000);
    set.add(utcDateStr(bbt));
  }

  return set;
}

/**
 * Returns true if `dateStr` (YYYY-MM-DD) is a public holiday for the given Bundesland.
 *
 * @param dateStr  Calendar date in local time (YYYY-MM-DD).
 * @param bundesland  Raw company state string (e.g. "NRW", "Nordrhein-Westfalen", "NW").
 */
export function isPublicHoliday(dateStr: string, bundesland?: string | null): boolean {
  if (!dateStr) return false;
  const year = parseInt(dateStr.slice(0, 4), 10);
  if (isNaN(year)) return false;
  return getHolidaysForYear(year, bundesland).has(dateStr);
}
