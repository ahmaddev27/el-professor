/**
 * The weekly Abrechnung as a mail to the driver it is about.
 *
 * No Deno, `npm:` or `jsr:` import, so vitest runs this file in Node like
 * `notification-mail.ts`, whose rules hold here too:
 *
 * - No link carries a token or a query string.
 * - Every interpolated value is escaped. A driver's name can contain anything,
 *   and so can a week label that came from a screen.
 *
 * German whatever language the sender uses in the app, like every other
 * transactional mail this product sends. **The wording is fixed in this file and
 * is deliberately not a `mail.template.*` settings key in this slice:** a new key
 * means restating `app_private.platform_settings_problem` with every existing
 * branch carried over character for character, which is a slice of its own. The
 * notifications set that precedent and this follows it.
 *
 * ## What this mail is, and what it is not
 *
 * It is a **summary a driver reads**, not a document anybody files. It carries
 * the four figures the Abrechnung screen shows and the same card as a PNG, and it
 * says in its own words that the figures come from the company's records and that
 * questions go to the office. It is not a Lohnabrechnung, not a Quittung, and not
 * a receipt for anything — those are separate documents with their own rules, and
 * calling this one of them in the wording would be wrong.
 *
 * ## The money is formatted here and computed nowhere
 *
 * Every figure arrives already decided, in euros, from the screen that showed it
 * to the operator. Nothing here adds, rounds or converts: the mail and the image
 * must agree, and they can only agree by coming from one place.
 */
import { escapeHtml, renderEmailHtml, renderEmailText } from './email-layout.mjs';
import type { RenderedMail } from './otp-mail.ts';

/** The figures the Abrechnung screen shows, as it shows them. */
export interface AbrechnungFigures {
  /** Cash the driver collected, in euros. */
  cash: number;
  /** What the driver spent and has receipts for, in euros. */
  belege: number;
  /** Cash minus Belege: what the driver hands in. Negative means owed to them. */
  difference: number;
  /** Receipts count behind `belege`, so the driver can check the number. */
  belegeCount: number;
  /** The fuel share as a percentage, or null when it could not be computed. */
  tankenquote: number | null;
}

export interface AbrechnungMailInput {
  driverName: string;
  companyName: string;
  /** "Woche 5" / "Woche 5 - August 2026", as the screen labels it. */
  periodLabel: string;
  /** "31.08.2026 – 06.09.2026". Already German, already formatted. */
  periodRange: string;
  figures: AbrechnungFigures;
}

/**
 * German money: a comma for the decimal, a dot for thousands, two places.
 *
 * Written here rather than imported from `src/utils/money.ts` because this file
 * must stay free of anything the edge runtime cannot load, and that module is in
 * the browser bundle. The rule is one line and the test pins it against the same
 * examples.
 */
export function euro(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  const [whole, cents] = Math.abs(rounded).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${rounded < 0 ? '-' : ''}${grouped},${cents} €`;
}

/** A percentage as the screen prints it: one decimal, a comma. */
export function percent(value: number): string {
  return `${(Math.round(value * 10) / 10).toFixed(1).replace('.', ',')} %`;
}

/**
 * One row of the figures table, in HTML.
 *
 * A table and not a list: a reader comparing four amounts wants them aligned, and
 * every mail client renders a table the same way where a flex row is anybody's
 * guess.
 */
function row(label: string, value: string, strong = false): string {
  const weight = strong ? 'font-weight:600;' : '';
  return (
    '<tr>'
    + `<td style="padding:6px 0;color:#475569;font-size:14px;">${escapeHtml(label)}</td>`
    + `<td style="padding:6px 0;text-align:right;font-size:14px;${weight}white-space:nowrap;">`
    + `${escapeHtml(value)}</td>`
    + '</tr>'
  );
}

export function renderAbrechnungMail(input: AbrechnungMailInput): RenderedMail {
  const { driverName, companyName, periodLabel, periodRange, figures } = input;

  // The driver hands money IN when the difference is positive and is owed money
  // when it is negative. Saying "Betrag" for both would make the one case a driver
  // most needs to understand the one the mail is silent about.
  const owesCompany = figures.difference >= 0;
  const differenceLabel = owesCompany ? 'Abzugeben' : 'Guthaben';

  const lines = [
    row('Bargeld eingenommen', euro(figures.cash)),
    row(`Belege (${figures.belegeCount})`, euro(figures.belege)),
    row(differenceLabel, euro(Math.abs(figures.difference)), true),
  ];
  if (figures.tankenquote !== null) {
    lines.push(row('Tankenquote', percent(figures.tankenquote)));
  }

  const bodyHtml =
    `<p style="margin:0 0 16px;">Hallo ${escapeHtml(driverName)},</p>`
    + `<p style="margin:0 0 16px;">hier ist deine Abrechnung für ${escapeHtml(periodLabel)} `
    + `(${escapeHtml(periodRange)}).</p>`
    + '<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px;">'
    + lines.join('')
    + '</table>'
    + '<p style="margin:0 0 16px;">Die Übersicht hängt dieser E-Mail auch als Bild an.</p>'
    + '<p style="margin:0;">Die Zahlen stammen aus den Aufzeichnungen von '
    + `${escapeHtml(companyName)}. Bei Fragen wende dich bitte an das Büro.</p>`;

  const textLines = [
    `Hallo ${driverName},`,
    '',
    `hier ist deine Abrechnung für ${periodLabel} (${periodRange}).`,
    '',
    `Bargeld eingenommen: ${euro(figures.cash)}`,
    `Belege (${figures.belegeCount}): ${euro(figures.belege)}`,
    `${differenceLabel}: ${euro(Math.abs(figures.difference))}`,
  ];
  if (figures.tankenquote !== null) {
    textLines.push(`Tankenquote: ${percent(figures.tankenquote)}`);
  }
  textLines.push(
    '',
    'Die Übersicht hängt dieser E-Mail auch als Bild an.',
    '',
    `Die Zahlen stammen aus den Aufzeichnungen von ${companyName}. `
    + 'Bei Fragen wende dich bitte an das Büro.',
  );

  return {
    // The subject names the driver's own week and nothing else. No figure in it:
    // a subject line is shown on a lock screen, and what a driver owes is not for
    // whoever is holding the phone.
    subject: `Abrechnung ${periodLabel} – ${companyName}`,
    html: renderEmailHtml({
      eyebrow: companyName,
      heading: `Abrechnung ${periodLabel}`,
      preheader: `Deine Abrechnung für ${periodRange}`,
      bodyHtml,
    }),
    text: renderEmailText({
      heading: `Abrechnung ${periodLabel}`,
      bodyText: textLines.join('\n'),
    }),
  };
}

/** `Abrechnung_Woche_5_2026.png` — safe for a Content-Disposition filename. */
export function attachmentName(periodLabel: string): string {
  const safe = periodLabel
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return `Abrechnung_${safe || 'Uebersicht'}.png`;
}
