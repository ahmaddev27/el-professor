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
 * The two DRIVER mails (the Abrechnung and its reminder) are written in the
 * driver's `preferred_language` (`ar`, `en`, `de`; English when unknown), with the
 * words in `driver-mail-copy.ts`. The manager summary is a mail to the company
 * and stays German. Money and dates stay German in every language.
 * **The wording is fixed in code and
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
import { appOrigin, type RenderedMail } from './otp-mail.ts';
import {
  DRIVER_MAIL_COPY,
  fillTemplate,
  localizePeriodLabel,
  type DriverMailCopy,
} from './driver-mail-copy.ts';
import {
  isRtl,
  ltrRunHtml,
  ltrRunText,
  nameRunHtml,
  nameRunText,
  type MailLanguage,
} from './mail-language.ts';

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
  /**
   * The language to write in. **Required, with no default here**: an optional
   * parameter would be a place for German (or anything else) to be chosen by
   * accident. Callers pass `resolveMailLanguage(driver.preferred_language)`.
   */
  language: MailLanguage;
  driverName: string;
  companyName: string;
  /** "Woche 5" / "Woche 5 - August 2026", as the screen labels it. */
  periodLabel: string;
  /** "31.08.2026 – 06.09.2026". Already formatted, and German in every language. */
  periodRange: string;
  figures: AbrechnungFigures;
  /**
   * `APP_URL`, passed in by the function rather than read here.
   *
   * This file must stay free of anything the Node test runner cannot load, and
   * `Deno.env` is exactly that — the same reason `notification-mail.ts` takes it
   * as an argument. It is used for the logo's absolute URL and nothing else.
   */
  appUrl: string;
  /**
   * Whether the card is attached as a PNG. The screen's send attaches it; the
   * scheduled job has no browser to draw it and does not, and the mail must not
   * claim an attachment it does not carry. Absent means attached, which keeps
   * every existing caller's bytes unchanged.
   */
  imageAttached?: boolean;
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
 * How a driver mail is spoken: the copy table, and the two ways a sentence is
 * filled (HTML and plain text).
 *
 * Names, labels and ranges go into a sentence as isolated runs in Arabic (see
 * `mail-language.ts`) and as they are everywhere else, so English and German
 * bytes are not touched by the right-to-left work.
 */
interface Voice {
  language: MailLanguage;
  rtl: boolean;
  copy: DriverMailCopy;
  html: (template: string, slots: Slots) => string;
  text: (template: string, slots: Slots) => string;
}

interface Slots {
  name?: string;
  label?: string;
  range?: string;
  company?: string;
  count?: string;
  clock?: string;
  /** The bare `HH:MM`, for the sentence that turns it into a clock time. */
  time?: string;
}

function voice(language: MailLanguage): Voice {
  const html = (template: string, slots: Slots) => fillTemplate(
    template,
    {
      name: nameRunHtml(escapeHtml(slots.name ?? ''), language),
      label: nameRunHtml(escapeHtml(slots.label ?? ''), language),
      company: nameRunHtml(escapeHtml(slots.company ?? ''), language),
      range: ltrRunHtml(escapeHtml(slots.range ?? ''), language),
      count: ltrRunHtml(escapeHtml(slots.count ?? ''), language),
      clock: ltrRunHtml(escapeHtml(slots.clock ?? ''), language),
      time: escapeHtml(slots.time ?? ''),
    },
    escapeHtml,
  );
  const text = (template: string, slots: Slots) => fillTemplate(
    template,
    {
      name: nameRunText(slots.name ?? '', language),
      label: nameRunText(slots.label ?? '', language),
      company: nameRunText(slots.company ?? '', language),
      range: ltrRunText(slots.range ?? '', language),
      count: ltrRunText(slots.count ?? '', language),
      clock: ltrRunText(slots.clock ?? '', language),
      time: slots.time ?? '',
    },
    (literal) => literal,
  );
  return { language, rtl: isRtl(language), copy: DRIVER_MAIL_COPY[language], html, text };
}

/**
 * One row of the figures table, in HTML.
 *
 * A table and not a list: a reader comparing four amounts wants them aligned, and
 * every mail client renders a table the same way where a flex row is anybody's
 * guess. The value sits at the end of the line in the reading direction, so in
 * Arabic it is on the left, and it is its own left-to-right run so `506,95 €`
 * keeps its euro sign on the right of the figure.
 */
function row(v: Voice, labelHtml: string, value: string, strong = false): string {
  const weight = strong ? 'font-weight:600;' : '';
  const align = v.rtl ? 'left' : 'right';
  return (
    '<tr>'
    + `<td style="padding:6px 0;color:#475569;font-size:14px;">${labelHtml}</td>`
    + `<td style="padding:6px 0;text-align:${align};font-size:14px;${weight}white-space:nowrap;">`
    + `${ltrRunHtml(escapeHtml(value), v.language)}</td>`
    + '</tr>'
  );
}

export function renderAbrechnungMail(input: AbrechnungMailInput): RenderedMail {
  const { driverName, companyName, periodRange, figures } = input;
  const v = voice(input.language);
  const { copy } = v;
  const c = copy.abrechnung;
  const periodLabel = localizePeriodLabel(input.periodLabel, input.language);
  const withImage = input.imageAttached ?? true;
  const origin = appOrigin(input.appUrl);
  const slots: Slots = {
    name: driverName, label: periodLabel, range: periodRange, company: companyName,
    count: String(figures.belegeCount),
  };

  // The driver hands money IN when the difference is positive and is owed money
  // when it is negative. Saying "Betrag" for both would make the one case a driver
  // most needs to understand the one the mail is silent about.
  const owesCompany = figures.difference >= 0;
  const differenceTemplate = owesCompany ? c.owes : c.credit;

  const lines = [
    row(v, v.html(c.cash, slots), euro(figures.cash)),
    row(v, v.html(c.belege, slots), euro(figures.belege)),
    row(v, v.html(differenceTemplate, slots), euro(Math.abs(figures.difference)), true),
  ];
  if (figures.tankenquote !== null) {
    lines.push(row(v, v.html(c.tankenquote, slots), percent(figures.tankenquote)));
  }

  const bodyHtml =
    `<p style="margin:0 0 16px;">${v.html(copy.hello, slots)}</p>`
    + `<p style="margin:0 0 16px;">${v.html(c.intro, slots)}</p>`
    + `<table role="presentation"${v.rtl ? ' dir="rtl"' : ''} `
    + 'style="width:100%;border-collapse:collapse;margin:0 0 16px;">'
    + lines.join('')
    + '</table>'
    + (withImage ? `<p style="margin:0 0 16px;">${v.html(c.imageNote, slots)}</p>` : '')
    + `<p style="margin:0;">${v.html(c.sources, slots)}</p>`;

  const textLines = [
    v.text(copy.hello, slots),
    '',
    v.text(c.intro, slots),
    '',
    `${v.text(c.cash, slots)}: ${ltrRunText(euro(figures.cash), v.language)}`,
    `${v.text(c.belege, slots)}: ${ltrRunText(euro(figures.belege), v.language)}`,
    `${v.text(differenceTemplate, slots)}: ${ltrRunText(euro(Math.abs(figures.difference)), v.language)}`,
  ];
  if (figures.tankenquote !== null) {
    textLines.push(`${v.text(c.tankenquote, slots)}: ${ltrRunText(percent(figures.tankenquote), v.language)}`);
  }
  if (withImage) textLines.push('', v.text(c.imageNote, slots));
  textLines.push('', v.text(c.sources, slots));

  return {
    // The subject names the driver's own week and nothing else. No figure in it:
    // a subject line is shown on a lock screen, and what a driver owes is not for
    // whoever is holding the phone.
    subject: v.text(c.subject, slots),
    html: renderEmailHtml({
      logoUrl: `${origin}/email-templates/logo.png`,
      eyebrow: companyName,
      heading: v.text(c.heading, slots),
      preheader: v.text(c.preheader, slots),
      bodyHtml,
      // No call to action and no link: this mail asks the driver to do nothing on
      // a screen, and a link into the app would be one they cannot open — a driver
      // has no account here.
      noteHtml: escapeHtml(c.note),
      ...layoutLocale(v),
    }),
    text: renderEmailText({
      heading: v.text(c.heading, slots),
      bodyText: textLines.join('\n'),
      noteText: c.note,
      footer: copy.footer,
    }),
  };
}

/** The layout options that make a mail the driver's language and direction. */
function layoutLocale(v: Voice) {
  return {
    lang: v.language,
    ...(v.rtl ? { dir: 'rtl' as const } : {}),
    footer: v.copy.footer,
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

// ─── The manager's summary ───────────────────────────────────────────────────

/** One driver's line in the manager's summary. */
export interface SummaryRow {
  driverName: string;
  figures: AbrechnungFigures;
}

export interface AbrechnungSummaryInput {
  companyName: string;
  periodLabel: string;
  periodRange: string;
  rows: readonly SummaryRow[];
  appUrl: string;
}

const SUMMARY_NOTE = 'Diese E-Mail wurde automatisch aus dem Abrechnungssystem Ihres '
  + 'Unternehmens erstellt. Sie ist eine Übersicht, keine Rechnung und keine '
  + 'Zahlungsaufforderung. Den automatischen Versand stellen Sie in den '
  + 'Einstellungen unter „Abrechnung per E-Mail“ ein.';

function cell(text: string, align: 'left' | 'right', strong = false): string {
  const weight = strong ? 'font-weight:600;' : '';
  return `<td style="padding:6px 8px 6px 0;text-align:${align};font-size:13px;${weight}`
    + `${align === 'right' ? 'white-space:nowrap;' : ''}">${escapeHtml(text)}</td>`;
}

/** "Abzugeben" / "Guthaben" and the amount, as the driver mail says it. */
function differenceText(difference: number): string {
  return `${difference >= 0 ? 'Abzugeben' : 'Guthaben'} ${euro(Math.abs(difference))}`;
}

/**
 * ONE mail to a company's administrators: every driver of the week and their
 * Abrechnung, in a table, with the totals below.
 *
 * The same four figures the driver's own mail carries, from the same rows. The
 * subject names the week and the company and no figure, like the driver's mail:
 * it shows on a lock screen. Rows arrive in the order the caller wants; the
 * totals are sums of the rows shown, so the table adds up on its face.
 */
export function renderAbrechnungSummaryMail(input: AbrechnungSummaryInput): RenderedMail {
  const { companyName, periodLabel, periodRange, rows } = input;
  const origin = appOrigin(input.appUrl);

  const totals = rows.reduce(
    (sum, r) => ({
      cash: sum.cash + r.figures.cash,
      belege: sum.belege + r.figures.belege,
      difference: sum.difference + r.figures.difference,
    }),
    { cash: 0, belege: 0, difference: 0 },
  );

  const head = '<tr>'
    + ['Fahrer', 'Bargeld', 'Belege', 'Saldo'].map((label, i) =>
      `<th style="padding:6px 8px 6px 0;text-align:${i === 0 ? 'left' : 'right'};`
      + `font-size:12px;color:#475569;border-bottom:1px solid #cbd5e1;">${escapeHtml(label)}</th>`).join('')
    + '</tr>';
  const body = rows.map((r) => '<tr>'
    + cell(r.driverName, 'left')
    + cell(euro(r.figures.cash), 'right')
    + cell(euro(r.figures.belege), 'right')
    + cell(euro(r.figures.difference), 'right')
    + '</tr>').join('');
  const foot = '<tr>'
    + cell('Gesamt', 'left', true)
    + cell(euro(totals.cash), 'right', true)
    + cell(euro(totals.belege), 'right', true)
    + cell(euro(totals.difference), 'right', true)
    + '</tr>';

  const bodyHtml =
    '<p style="margin:0 0 16px;">Guten Tag,</p>'
    + `<p style="margin:0 0 16px;">hier ist die Abrechnungsübersicht für ${escapeHtml(periodLabel)} `
    + `(${escapeHtml(periodRange)}) von ${escapeHtml(companyName)}.</p>`
    + '<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px;">'
    + head + body + foot + '</table>'
    + '<p style="margin:0 0 8px;font-size:13px;color:#475569;">'
    + 'Saldo: Bargeld minus Belege. Positiv bedeutet, dass der Fahrer Geld abgibt, negativ, '
    + 'dass ihm Geld zusteht.</p>'
    + `<p style="margin:0;font-size:13px;color:#475569;">${rows.length} `
    + 'Fahrer mit Buchungen in dieser Woche.</p>';

  const textRows = rows.map((r) =>
    `${r.driverName}: Bargeld ${euro(r.figures.cash)}, Belege ${euro(r.figures.belege)}, `
    + differenceText(r.figures.difference));
  const bodyText = [
    'Guten Tag,',
    '',
    `hier ist die Abrechnungsübersicht für ${periodLabel} (${periodRange}) von ${companyName}.`,
    '',
    ...textRows,
    '',
    `Gesamt: Bargeld ${euro(totals.cash)}, Belege ${euro(totals.belege)}, Saldo ${euro(totals.difference)}`,
    '',
    'Saldo: Bargeld minus Belege. Positiv bedeutet, dass der Fahrer Geld abgibt, negativ, dass ihm Geld zusteht.',
  ].join('\n');

  return {
    subject: `Abrechnungsübersicht ${periodLabel} – ${companyName}`,
    html: renderEmailHtml({
      logoUrl: `${origin}/email-templates/logo.png`,
      eyebrow: companyName,
      heading: `Abrechnungsübersicht ${periodLabel}`,
      preheader: `Alle Fahrer für ${periodRange}`,
      bodyHtml,
      noteHtml: escapeHtml(SUMMARY_NOTE),
    }),
    text: renderEmailText({
      heading: `Abrechnungsübersicht ${periodLabel}`,
      bodyText,
      noteText: SUMMARY_NOTE,
    }),
  };
}

export interface ReminderMailInput {
  /** Required, like `AbrechnungMailInput.language`. */
  language: MailLanguage;
  driverName: string;
  companyName: string;
  periodLabel: string;
  periodRange: string;
  /** `HH:MM`, Europe/Berlin: when the Abrechnung goes out. */
  sendTime: string;
  appUrl: string;
}

/**
 * The reminder sent shortly before the weekly Abrechnung: this driver has
 * recorded neither cash nor a cash receipt for the week.
 *
 * It states **no amount, on purpose**. The figures are exactly what is
 * incomplete, and a confident number in a reminder would be wrong. It says what
 * the mail is about (which week), what is missing, and when the Abrechnung goes
 * out, and it says that a driver with nothing to hand in can ignore it, because
 * the rule behind it is deliberately plain and will sometimes reach someone who
 * did nothing wrong. No link: there is nothing to open, and a driver has no
 * account here.
 */
export function renderReminderMail(input: ReminderMailInput): RenderedMail {
  const { driverName, companyName, periodRange, sendTime } = input;
  const v = voice(input.language);
  const { copy } = v;
  const c = copy.reminder;
  const periodLabel = localizePeriodLabel(input.periodLabel, input.language);
  const origin = appOrigin(input.appUrl);
  const clock = fillTemplate(c.clock, { time: sendTime }, (literal) => literal);
  const slots: Slots = {
    name: driverName, label: periodLabel, range: periodRange, company: companyName, clock,
  };

  const bodyHtml =
    `<p style="margin:0 0 16px;">${v.html(copy.hello, slots)}</p>`
    + `<p style="margin:0 0 16px;">${v.html(c.intro, slots)}</p>`
    + `<p style="margin:0 0 16px;">${v.html(c.missing, slots)}</p>`
    + `<p style="margin:0 0 16px;">${v.html(c.when, slots)}</p>`
    + `<p style="margin:0;">${v.html(c.ignore, slots)}</p>`;

  const bodyText = [
    v.text(copy.hello, slots),
    '',
    v.text(c.intro, slots),
    '',
    v.text(c.missing, slots),
    '',
    v.text(c.when, slots),
    '',
    v.text(c.ignore, slots),
  ].join('\n');

  return {
    // No figure in it, and nothing a lock screen should not show.
    subject: v.text(c.subject, slots),
    html: renderEmailHtml({
      logoUrl: `${origin}/email-templates/logo.png`,
      eyebrow: companyName,
      heading: c.heading,
      preheader: v.text(c.preheader, slots),
      bodyHtml,
      noteHtml: escapeHtml(c.note),
      ...layoutLocale(v),
    }),
    text: renderEmailText({
      heading: c.heading,
      bodyText,
      noteText: c.note,
      footer: copy.footer,
    }),
  };
}
