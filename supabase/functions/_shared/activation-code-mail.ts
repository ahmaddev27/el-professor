/**
 * The mail that carries an activation code a platform admin has just
 * generated, and the rule for who receives it.
 *
 * No Deno, npm: or jsr: import: vitest runs this file in Node. The Deno half,
 * which looks the recipients up and sends, is activation-code-delivery.ts.
 *
 * German whatever language the reader uses in the app, like every other mail.
 * The rules of otp-mail.ts hold here too:
 *
 * - The subject never contains the code.
 * - No link carries a token or a query string.
 * - Every interpolated value is escaped; a company name can contain anything.
 */
import { emphasis, escapeHtml, renderEmailHtml, renderEmailText } from './email-layout.mjs';
import { appOrigin, formatBerlinDateTime, type RenderedMail } from './otp-mail.ts';

export const ACTIVATION_CODE_MAIL_SUBJECT = 'Ihr Aktivierungscode für El-Professor';

/** The words the activation screen uses (activation.duration.* and activation.custom in de.ts). */
const DURATION_WORDS: Readonly<Record<string, string>> = {
  '1_monat': '1 Monat',
  '3_monate': '3 Monate',
  '1_jahr': '1 Jahr',
  'benutzerdefiniert': 'Benutzerdefiniert',
};

export interface ActivationCodeGrant {
  durationType: string;
  customDays?: number | null;
  customExpiresAt?: string | null;
}

export interface ActivationCodeMailVars extends ActivationCodeGrant {
  /** The web app's origin, e.g. https://elprofessor.eu. */
  appUrl: string;
  /** Six digits. Never log it. */
  code: string;
  /** When the code stops being redeemable: two minutes after it was generated. */
  expiresAt: Date;
  /** The company the code is bound to, when it is. */
  companyName?: string | null;
}

/** `HH:MM` in Europe/Berlin. */
export function formatBerlinTime(date: Date): string {
  return formatBerlinDateTime(date).split(', ')[1];
}

/** `DD.MM.YYYY` in Europe/Berlin. */
function formatBerlinDate(date: Date): string {
  return formatBerlinDateTime(date).split(', ')[0];
}

/**
 * What the code grants, as the activation screen names it. A custom code adds
 * what redeem_activation_code reads first: its fixed end date, else its days.
 */
export function describeActivationCodeGrant(grant: ActivationCodeGrant): string {
  const words = DURATION_WORDS[grant.durationType];
  if (!words) throw new Error('activation code mail: unknown duration type');
  if (grant.durationType !== 'benutzerdefiniert') return words;

  if (grant.customExpiresAt) {
    const end = new Date(grant.customExpiresAt);
    if (!Number.isNaN(end.getTime())) return `${words}: bis ${formatBerlinDate(end)}`;
  }
  if (typeof grant.customDays === 'number' && Number.isFinite(grant.customDays)) {
    return `${words}: ${grant.customDays} ${grant.customDays === 1 ? 'Tag' : 'Tage'}`;
  }
  return words;
}

/** The mail with the code, what it grants, until when it is valid, and where to redeem it. */
export function buildActivationCodeMail(vars: ActivationCodeMailVars): RenderedMail {
  const origin = appOrigin(vars.appUrl);
  if (Number.isNaN(vars.expiresAt.getTime())) throw new Error('activation code mail: invalid expiry');
  const grant = describeActivationCodeGrant(vars);
  const until = formatBerlinTime(vars.expiresAt);
  const company = vars.companyName?.trim() || null;
  const activationHref = `${origin}/abo-aktivieren`;

  const heading = 'Ihr Aktivierungscode';
  const forHtml = company ? `Für ${emphasis(company)} wurde` : 'Für Sie wurde';
  const forText = company ? `Für ${company} wurde` : 'Für Sie wurde';
  const bodyHtml = `${forHtml} ein Aktivierungscode für El-Professor erstellt. Laufzeit: ${emphasis(grant)}.`;
  const bodyText = `${forText} ein Aktivierungscode für El-Professor erstellt. Laufzeit: ${grant}.`;
  const caption = `Der Code ist bis ${until} Uhr (Europe/Berlin) gültig und kann nur einmal verwendet werden.`;
  const note = 'Melden Sie sich bei El-Professor an und geben Sie den Code auf der Seite „Abo aktivieren“ ein. '
    + 'Nicht erwartet? Dann können Sie diese E-Mail ignorieren. Geben Sie den Code nicht weiter.';
  const cta = { label: 'Code einlösen', href: activationHref, fallbackLink: true };

  return {
    subject: ACTIVATION_CODE_MAIL_SUBJECT,
    html: renderEmailHtml({
      logoUrl: `${origin}/email-templates/logo.png`,
      eyebrow: 'Aktivierung',
      heading,
      preheader: `Ihr Aktivierungscode für El-Professor, gültig bis ${until} Uhr.`,
      bodyHtml,
      code: vars.code,
      codeCaption: caption,
      cta,
      noteHtml: escapeHtml(note),
    }),
    text: renderEmailText({
      heading,
      bodyText,
      code: vars.code,
      codeCaption: caption,
      link: { label: cta.label, href: cta.href },
      noteText: note,
    }),
  };
}

// ── Who receives the code ────────────────────────────────────────────────────

/** A company member as the delivery module loads it: the profile plus its GoTrue account. */
export interface CompanyAdminCandidate {
  email: string | null;
  role: string | null;
  status: string | null;
  isSuperAdmin: boolean | null;
  emailConfirmedAt: string | null;
  bannedUntil: string | null;
  deletedAt: string | null;
}

export type ActivationCodeRecipientSource = 'target_email' | 'company_admins' | 'none';

export interface ActivationCodeRecipients {
  source: ActivationCodeRecipientSource;
  /** Lower-cased, without duplicates, sorted. */
  recipients: string[];
}

/**
 * The code's target address when it has one. Otherwise, for a code bound to a
 * company, that company's admins who can sign in: an active admin profile, not
 * platform staff, and a confirmed, undeleted, unbanned account. Otherwise nobody.
 */
export function selectActivationCodeRecipients(input: {
  targetEmail?: string | null;
  companyId?: string | null;
  companyAdmins: readonly CompanyAdminCandidate[];
  now: Date;
}): ActivationCodeRecipients {
  const target = input.targetEmail?.trim().toLowerCase();
  if (target) return { source: 'target_email', recipients: [target] };
  if (!input.companyId) return { source: 'none', recipients: [] };

  const addresses = input.companyAdmins
    .filter((candidate) =>
      candidate.role === 'admin'
      && candidate.status === 'active'
      && candidate.isSuperAdmin !== true
      && Boolean(candidate.email?.trim())
      && Boolean(candidate.emailConfirmedAt)
      && !candidate.deletedAt
      && (!candidate.bannedUntil || new Date(candidate.bannedUntil).getTime() <= input.now.getTime()))
    .map((candidate) => (candidate.email as string).trim().toLowerCase());

  return { source: 'company_admins', recipients: [...new Set(addresses)].sort() };
}
