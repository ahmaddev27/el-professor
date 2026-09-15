/**
 * The German copy of every one-time-code mail, rendered with the shared layout.
 *
 * All of it is German whatever language the reader uses in the app, like the
 * GoTrue templates. Three rules hold for every message:
 *
 * - The subject never contains the code. Mail providers keep subjects in logs
 *   and show them on lock screens.
 * - No link carries a token or a query string. The address travels only in the
 *   #fragment, which a browser never sends to a server, so no access log sees it.
 * - Every interpolated value is escaped: an address can legally contain quotes
 *   and ampersands, and a company name can contain anything.
 */
import { emphasis, escapeHtml, renderEmailHtml, renderEmailText } from './email-layout.mjs';
import type { EmailCta, EmailLink } from './email-layout.d.mts';
import type { OtpPurpose } from './otp-core.ts';

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

export interface OtpMailVars {
  /** The web app's origin, e.g. https://elprofessor.eu. */
  appUrl: string;
  /** The account's current address. */
  email: string;
  /** email_change only: the address being confirmed. */
  newEmail?: string | null;
  /** invite_activate only. The sentence reads correctly without it. */
  companyName?: string | null;
  code: string;
}

const VALIDITY = 'Der Code ist 10 Minuten gültig.';
const NEVER_SHARE = 'Geben Sie den Code niemals weiter – El-Professor fragt Sie nie danach.';

interface Copy {
  subject: string;
  eyebrow: string;
  heading: string;
  preheader: string;
  bodyHtml: string;
  bodyText: string;
  codeCaption: string;
  note: string;
  cta?: EmailCta;
  link?: EmailLink;
}

function appOrigin(appUrl: string): string {
  const origin = appUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/.test(origin)) {
    throw new Error('otp mail: APP_URL must be an origin such as https://elprofessor.eu');
  }
  return origin;
}

/**
 * An address as the value of a link's #fragment.
 *
 * encodeURIComponent leaves ! ' ( ) * as they are. An apostrophe is legal in an
 * address (o'brien@…) but not in a link target the layout accepts, so without
 * this the mail for such an address could never be built, and its owner would
 * never get a code. The page reads the value back with decodeURIComponent.
 */
export function fragmentValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function copyFor(purpose: OtpPurpose, vars: OtpMailVars, origin: string): Copy {
  const { email } = vars;
  const fragment = `#email=${fragmentValue(email)}`;

  switch (purpose) {
    case 'signup_verify':
      return {
        subject: 'Ihr Bestätigungscode – El-Professor',
        eyebrow: 'Registrierung',
        heading: 'Bestätigen Sie Ihre E-Mail-Adresse',
        preheader: 'Ihr Code zum Abschluss der Registrierung bei El-Professor.',
        bodyHtml: `Geben Sie diesen Code auf der Registrierungsseite ein, um Ihr El-Professor-Konto für ${emphasis(email)} zu aktivieren.`,
        bodyText: `Geben Sie diesen Code auf der Registrierungsseite ein, um Ihr El-Professor-Konto für ${email} zu aktivieren.`,
        codeCaption: VALIDITY,
        link: { label: 'Seite geschlossen? Hier bestätigen', href: `${origin}/auth/verify-email${fragment}` },
        note: `Nicht registriert? Dann können Sie diese E-Mail ignorieren. Ohne Bestätigung wird die Registrierung nach 24 Stunden gelöscht. ${NEVER_SHARE}`,
      };

    case 'password_reset':
      return {
        subject: 'Code zum Zurücksetzen Ihres Passworts – El-Professor',
        eyebrow: 'Passwort',
        heading: 'Ihr Code für ein neues Passwort',
        preheader: 'Ihr Code zum Festlegen eines neuen Passworts bei El-Professor.',
        bodyHtml: `Für Ihr El-Professor-Konto ${emphasis(email)} wurde ein neues Passwort angefordert. Geben Sie diesen Code ein:`,
        bodyText: `Für Ihr El-Professor-Konto ${email} wurde ein neues Passwort angefordert. Geben Sie diesen Code ein:`,
        codeCaption: VALIDITY,
        link: { label: 'Seite geschlossen? Neuen Code anfordern', href: `${origin}/auth/forgot-password` },
        note: `Nicht angefordert? Dann können Sie diese E-Mail ignorieren – Ihr Passwort bleibt unverändert. ${NEVER_SHARE}`,
      };

    case 'invite_activate': {
      const company = vars.companyName?.trim();
      return {
        subject: 'Ihre Einladung zu El-Professor',
        eyebrow: 'Einladung',
        heading: 'Sie wurden zu El-Professor eingeladen',
        preheader: 'Legen Sie mit Ihrem Code ein Passwort für El-Professor fest.',
        bodyHtml: `Für Sie wurde ein Zugang${company ? ` bei ${emphasis(company)}` : ''} angelegt. Öffnen Sie die Einladungsseite und geben Sie diesen Code ein, um Ihr Passwort festzulegen.`,
        bodyText: `Für Sie wurde ein Zugang${company ? ` bei ${company}` : ''} angelegt. Öffnen Sie die Einladungsseite und geben Sie diesen Code ein, um Ihr Passwort festzulegen.`,
        codeCaption: `${VALIDITY} Abgelaufen? Auf der Einladungsseite erhalten Sie einen neuen Code.`,
        cta: { label: 'Einladung annehmen', href: `${origin}/einladung${fragment}`, fallbackLink: true },
        note: `Keine Einladung erwartet? Dann können Sie diese E-Mail ignorieren. ${NEVER_SHARE}`,
      };
    }

    case 'email_change': {
      const newEmail = vars.newEmail;
      if (!newEmail) throw new Error('otp mail: email_change needs the new address');
      return {
        subject: 'Neue E-Mail-Adresse bestätigen – El-Professor',
        eyebrow: 'Kontoänderung',
        heading: 'Neue E-Mail-Adresse bestätigen',
        preheader: 'Ihr Code zur Bestätigung Ihrer neuen E-Mail-Adresse bei El-Professor.',
        bodyHtml: `Geben Sie diesen Code in El-Professor ein, um die Anmeldeadresse von ${emphasis(email)} auf ${emphasis(newEmail)} zu ändern.`,
        bodyText: `Geben Sie diesen Code in El-Professor ein, um die Anmeldeadresse von ${email} auf ${newEmail} zu ändern.`,
        codeCaption: VALIDITY,
        note: `Nicht veranlasst? Dann können Sie diese E-Mail ignorieren. ${NEVER_SHARE}`,
      };
    }

    case 'platform_login':
      return {
        subject: 'Ihr Anmeldecode für die Plattformverwaltung – El-Professor',
        eyebrow: 'Plattformverwaltung',
        heading: 'Ihr Anmeldecode',
        preheader: 'Ihr Code für die Anmeldung in der Plattformverwaltung von El-Professor.',
        bodyHtml: `Für die Anmeldung in der Plattformverwaltung mit ${emphasis(email)} wurde dieser Code angefordert.`,
        bodyText: `Für die Anmeldung in der Plattformverwaltung mit ${email} wurde dieser Code angefordert.`,
        codeCaption: VALIDITY,
        note: `Nicht Sie? Ändern Sie sofort Ihr Passwort – jemand kennt es. ${NEVER_SHARE}`,
      };
  }
}

/** The mail carrying a code, for one purpose. */
export function buildOtpMail(purpose: OtpPurpose, vars: OtpMailVars): RenderedMail {
  const origin = appOrigin(vars.appUrl);
  const copy = copyFor(purpose, vars, origin);
  const html = renderEmailHtml({
    logoUrl: `${origin}/email-templates/logo.png`,
    eyebrow: copy.eyebrow,
    heading: copy.heading,
    preheader: copy.preheader,
    bodyHtml: copy.bodyHtml,
    code: vars.code,
    codeCaption: copy.codeCaption,
    cta: copy.cta,
    link: copy.link,
    noteHtml: escapeHtml(copy.note),
  });
  const text = renderEmailText({
    heading: copy.heading,
    bodyText: copy.bodyText,
    code: vars.code,
    codeCaption: copy.codeCaption,
    link: copy.cta ? { label: copy.cta.label, href: copy.cta.href } : copy.link,
    noteText: copy.note,
  });
  return { subject: copy.subject, html, text };
}

export interface EmailChangedNoticeVars {
  appUrl: string;
  oldEmail: string;
  newEmail: string;
  changedAt: Date;
}

/** `DD.MM.YYYY, HH:MM` in Europe/Berlin, the way the rest of the product writes dates. */
export function formatBerlinDateTime(date: Date): string {
  const parts: Record<string, string> = {};
  const format = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  for (const part of format.formatToParts(date)) parts[part.type] = part.value;
  return `${parts.day}.${parts.month}.${parts.year}, ${parts.hour}:${parts.minute}`;
}

/**
 * The notice sent to the old address after an email change. It carries no code
 * and no link: its only job is to tell the real owner, if the change was not
 * theirs, that it happened.
 */
export function buildEmailChangedNotice(vars: EmailChangedNoticeVars): RenderedMail {
  const origin = appOrigin(vars.appUrl);
  const when = formatBerlinDateTime(vars.changedAt);
  const heading = 'Ihre E-Mail-Adresse wurde geändert';
  const note = 'Nicht Sie? Wenden Sie sich sofort an Ihren Administrator oder den Support.';
  return {
    subject: 'Ihre E-Mail-Adresse wurde geändert – El-Professor',
    html: renderEmailHtml({
      logoUrl: `${origin}/email-templates/logo.png`,
      eyebrow: 'Sicherheitshinweis',
      heading,
      preheader: 'Die Anmeldeadresse Ihres El-Professor-Kontos wurde geändert.',
      bodyHtml: `Die Anmeldeadresse Ihres Kontos wurde am ${escapeHtml(when)} Uhr (Europe/Berlin) von ${emphasis(vars.oldEmail)} auf ${emphasis(vars.newEmail)} geändert.`,
      noteHtml: escapeHtml(note),
    }),
    text: renderEmailText({
      heading,
      bodyText: `Die Anmeldeadresse Ihres Kontos wurde am ${when} Uhr (Europe/Berlin) von ${vars.oldEmail} auf ${vars.newEmail} geändert.`,
      noteText: note,
    }),
  };
}
