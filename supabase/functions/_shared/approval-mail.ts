/**
 * The mail a company's administrators receive when a platform admin approves
 * the company, rendered with the shared layout.
 *
 * German whatever language the reader uses in the app, like every other mail.
 * The rules of otp-mail.ts hold here too:
 *
 * - The subject never contains the code.
 * - No link carries a token or a query string.
 * - Every interpolated value is escaped; a company name can contain anything.
 *
 * With a trial code the mail says how to redeem it, and that the trial's days
 * start at redemption, not with the mail. Without one (a company that did not
 * sign up for a trial, or whose trial started at signup) it only says that the
 * company is approved.
 */
import { emphasis, escapeHtml, renderEmailHtml, renderEmailText } from './email-layout.mjs';
import { appOrigin, type RenderedMail } from './otp-mail.ts';

export interface ApprovalMailVars {
  /** The web app's origin, e.g. https://elprofessor.eu. */
  appUrl: string;
  companyName?: string | null;
  /** The trial code, when the approval created one. Never log it. */
  code?: string | null;
  /** The trial's length in days, as the database reports it. */
  trialDays: number;
}

export const APPROVAL_MAIL_SUBJECT = 'Ihr Unternehmen ist freigeschaltet – El-Professor';

const EYEBROW = 'Freischaltung';
const HEADING = 'Ihr Unternehmen ist freigeschaltet';

function requireTrialDays(days: number): number {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error('approval mail: trialDays must be a positive whole number');
  }
  return days;
}

/** The approval mail, with the trial code and how to redeem it when there is one. */
export function buildApprovalMail(vars: ApprovalMailVars): RenderedMail {
  const origin = appOrigin(vars.appUrl);
  const days = requireTrialDays(vars.trialDays);
  const company = vars.companyName?.trim() || null;
  const loginHref = `${origin}/login`;
  const logoUrl = `${origin}/email-templates/logo.png`;
  const approvedHtml = `${company ? emphasis(company) : 'Ihr Unternehmen'} ist jetzt für El-Professor freigeschaltet.`;
  const approvedText = `${company ?? 'Ihr Unternehmen'} ist jetzt für El-Professor freigeschaltet.`;

  if (!vars.code) {
    const body = 'Sie können sich ab sofort anmelden.';
    const note = 'Sie erhalten diese E-Mail, weil Sie bei El-Professor als Administrator des Unternehmens eingetragen sind.';
    const cta = { label: 'Anmelden', href: loginHref, fallbackLink: true };
    return {
      subject: APPROVAL_MAIL_SUBJECT,
      html: renderEmailHtml({
        logoUrl,
        eyebrow: EYEBROW,
        heading: HEADING,
        preheader: 'Ihr Zugang zu El-Professor ist freigeschaltet.',
        bodyHtml: `${approvedHtml} ${body}`,
        cta,
        noteHtml: escapeHtml(note),
      }),
      text: renderEmailText({
        heading: HEADING,
        bodyText: `${approvedText} ${body}`,
        link: { label: cta.label, href: cta.href },
        noteText: note,
      }),
    };
  }

  const activationHref = `${origin}/abo-aktivieren`;
  const intro = `Mit diesem Code starten Sie Ihre ${days}-tägige Testphase:`;
  const caption = `Die ${days} Tage beginnen erst, wenn Sie den Code einlösen.`;
  const rules = 'Das kann nur ein Administrator Ihres Unternehmens. Der Code gilt, bis er eingelöst oder durch einen neuen Code ersetzt wird. Geben Sie ihn nicht weiter.';
  // The HTML has a button for the sign-in; the text part has only one link
  // line, so its note carries the sign-in address instead.
  const noteHtml = `So lösen Sie den Code ein: Melden Sie sich bei El-Professor an und geben Sie den Code auf der Aktivierungsseite ein. ${rules}`;
  const noteText = `So lösen Sie den Code ein: Melden Sie sich unter ${loginHref} bei El-Professor an und geben Sie den Code auf der Aktivierungsseite ein. ${rules}`;
  const link = { label: 'Zur Aktivierungsseite', href: activationHref };

  return {
    subject: APPROVAL_MAIL_SUBJECT,
    html: renderEmailHtml({
      logoUrl,
      eyebrow: EYEBROW,
      heading: HEADING,
      preheader: `Mit Ihrem Code starten Sie die ${days}-tägige Testphase von El-Professor.`,
      bodyHtml: `${approvedHtml} ${intro}`,
      code: vars.code,
      codeCaption: caption,
      cta: { label: 'Anmelden', href: loginHref },
      link,
      noteHtml: escapeHtml(noteHtml),
    }),
    text: renderEmailText({
      heading: HEADING,
      bodyText: `${approvedText} ${intro}`,
      code: vars.code,
      codeCaption: caption,
      link,
      noteText,
    }),
  };
}
