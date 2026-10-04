/**
 * The four notification mails, and who receives them.
 *
 * No Deno, npm: or jsr: import: vitest runs this file in Node, like
 * activation-code-mail.ts, whose rules hold here too:
 *
 * - No link carries a token or a query string.
 * - Every interpolated value is escaped; a company name and a number plate can
 *   contain anything.
 *
 * German whatever language the reader uses in the app, like every other
 * transactional mail this product sends. **The wording is fixed in this file
 * and is deliberately not a `mail.template.*` settings key in this slice:**
 * a new key means restating `app_private.platform_settings_problem` with every
 * existing branch carried over character for character, which is a slice of its
 * own. Making these editable is the follow-up, and that is the function it
 * would have to restate.
 *
 * These mails carry no code and no one-time link, so nothing here goes near
 * `safeSubject()`'s territory: the subject names the car or the trial and
 * nothing secret.
 */
import { emphasis, escapeHtml, renderEmailHtml, renderEmailText } from './email-layout.mjs';
import { appOrigin, type RenderedMail } from './otp-mail.ts';
import {
  selectActivationCodeRecipients,
  type CompanyAdminCandidate,
} from './activation-code-mail.ts';
import type { NotificationType, PlannedNotification } from './notification-core.ts';

/** `DD.MM.YYYY` from a `YYYY-MM-DD` day. Never US `MM/DD/YYYY`. */
export function formatGermanDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new RangeError('notification mail: day must be YYYY-MM-DD');
  return `${match[3]}.${match[2]}.${match[1]}`;
}

/** "1 Tag" / "5 Tagen", for "in …". */
function inDays(days: number): string {
  return days === 1 ? '1 Tag' : `${days} Tagen`;
}

/** "seit 1 Tag" / "seit 5 Tagen", for a date that has passed. */
function sinceDays(days: number): string {
  const passed = Math.abs(days);
  return passed === 1 ? 'seit 1 Tag' : `seit ${passed} Tagen`;
}

/** The car as the mail names it: its plate, or a neutral word when it has none. */
export function describeCar(plate: string | null | undefined): string {
  const text = plate?.trim();
  return text && text.length > 0 ? text : 'Ihr Fahrzeug';
}

interface MailCopy {
  eyebrow: string;
  subject: string;
  heading: string;
  preheader: string;
  /** Plain text; the HTML part escapes it and marks `emphasis` separately. */
  bodyText: string;
  bodyHtml: string;
  note: string;
  cta: { label: string; path: string };
}

const SETTINGS_NOTE = 'Diese Benachrichtigung können Sie in El-Professor unter „Benachrichtigungen“ jederzeit abschalten.';

function copyFor(item: PlannedNotification): MailCopy {
  const due = formatGermanDay(item.dueDay);
  const company = item.companyName?.trim() || null;

  switch (item.type) {
    case 'tuev_bald_ablaufend': {
      const car = describeCar(item.plate);
      const when = item.daysLeft === 0 ? 'heute' : `in ${inDays(item.daysLeft)}`;
      return {
        eyebrow: 'Fahrzeuge',
        subject: `TÜV läuft ab: ${car} – El-Professor`,
        heading: 'TÜV läuft bald ab',
        preheader: `Der TÜV für ${car} ist noch bis ${due} gültig.`,
        bodyText: `Der TÜV für ${car} ist noch bis ${due} gültig und läuft damit ${when} ab. Bitte vereinbaren Sie rechtzeitig einen Termin für die Hauptuntersuchung.`,
        bodyHtml: `Der TÜV für ${emphasis(car)} ist noch bis ${emphasis(due)} gültig und läuft damit ${escapeHtml(when)} ab. Bitte vereinbaren Sie rechtzeitig einen Termin für die Hauptuntersuchung.`,
        note: SETTINGS_NOTE,
        cta: { label: 'Fahrzeuge öffnen', path: '/fahrzeuge' },
      };
    }
    case 'tuev_abgelaufen': {
      const car = describeCar(item.plate);
      return {
        eyebrow: 'Fahrzeuge',
        subject: `TÜV abgelaufen: ${car} – El-Professor`,
        heading: 'TÜV ist abgelaufen',
        preheader: `Der TÜV für ${car} ist am ${due} abgelaufen.`,
        bodyText: `Der TÜV für ${car} ist am ${due} abgelaufen, also ${sinceDays(item.daysLeft)}. Ein Fahrzeug ohne gültige Hauptuntersuchung darf nicht eingesetzt werden.`,
        bodyHtml: `Der TÜV für ${emphasis(car)} ist am ${emphasis(due)} abgelaufen, also ${escapeHtml(sinceDays(item.daysLeft))}. Ein Fahrzeug ohne gültige Hauptuntersuchung darf nicht eingesetzt werden.`,
        note: SETTINGS_NOTE,
        cta: { label: 'Fahrzeuge öffnen', path: '/fahrzeuge' },
      };
    }
    case 'trial_bald_ablaufend': {
      const when = item.daysLeft === 0 ? 'heute' : `in ${inDays(item.daysLeft)}`;
      const who = company ? `Die Testphase von ${company}` : 'Ihre Testphase';
      const whoHtml = company ? `Die Testphase von ${emphasis(company)}` : 'Ihre Testphase';
      return {
        eyebrow: 'Abonnement',
        subject: 'Ihre Testphase läuft bald ab – El-Professor',
        heading: 'Testphase läuft bald ab',
        preheader: `Die Testphase endet am ${due}.`,
        bodyText: `${who} endet am ${due}, also ${when}. Lösen Sie Ihren Aktivierungscode ein, damit Sie ohne Unterbrechung weiterarbeiten können.`,
        bodyHtml: `${whoHtml} endet am ${emphasis(due)}, also ${escapeHtml(when)}. Lösen Sie Ihren Aktivierungscode ein, damit Sie ohne Unterbrechung weiterarbeiten können.`,
        note: SETTINGS_NOTE,
        cta: { label: 'Abo aktivieren', path: '/abo-aktivieren' },
      };
    }
    case 'trial_abgelaufen': {
      const who = company ? `Die Testphase von ${company}` : 'Ihre Testphase';
      const whoHtml = company ? `Die Testphase von ${emphasis(company)}` : 'Ihre Testphase';
      return {
        eyebrow: 'Abonnement',
        subject: 'Ihre Testphase ist abgelaufen – El-Professor',
        heading: 'Testphase ist abgelaufen',
        preheader: `Die Testphase ist am ${due} abgelaufen.`,
        bodyText: `${who} ist am ${due} abgelaufen. Ihre Daten bleiben vollständig erhalten. Lösen Sie einen Aktivierungscode ein, um El-Professor weiter zu nutzen.`,
        bodyHtml: `${whoHtml} ist am ${emphasis(due)} abgelaufen. Ihre Daten bleiben vollständig erhalten. Lösen Sie einen Aktivierungscode ein, um El-Professor weiter zu nutzen.`,
        note: SETTINGS_NOTE,
        cta: { label: 'Abo aktivieren', path: '/abo-aktivieren' },
      };
    }
  }
}

/** The mail for one planned notification. */
export function buildNotificationMail(item: PlannedNotification, appUrl: string): RenderedMail {
  const origin = appOrigin(appUrl);
  const copy = copyFor(item);
  const href = `${origin}${copy.cta.path}`;

  return {
    subject: copy.subject,
    html: renderEmailHtml({
      logoUrl: `${origin}/email-templates/logo.png`,
      eyebrow: copy.eyebrow,
      heading: copy.heading,
      preheader: copy.preheader,
      bodyHtml: copy.bodyHtml,
      cta: { label: copy.cta.label, href, fallbackLink: true },
      noteHtml: escapeHtml(copy.note),
    }),
    text: renderEmailText({
      heading: copy.heading,
      bodyText: copy.bodyText,
      link: { label: copy.cta.label, href },
      noteText: copy.note,
    }),
  };
}

/**
 * Who receives a company's notification.
 *
 * Exactly `selectActivationCodeRecipients`' company branch, called with no
 * target address: the company's admins who can sign in — an active `admin`
 * profile that is not platform staff, with a confirmed, undeleted, unbanned
 * account — and nobody when there are none. The rule is not restated here on
 * purpose; it is one function, and a change to who may receive a company mail
 * moves both at once.
 */
export function selectNotificationRecipients(input: {
  companyId: string;
  companyAdmins: readonly CompanyAdminCandidate[];
  now: Date;
}): string[] {
  return selectActivationCodeRecipients({
    targetEmail: null,
    companyId: input.companyId,
    companyAdmins: input.companyAdmins,
    now: input.now,
  }).recipients;
}

export type { NotificationType };
