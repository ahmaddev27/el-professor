/**
 * The editable text of the one-time-code mails and the sender's display name
 * (plan 3.10, the settings `mail.template.<purpose>` and `mail.sender`).
 *
 * Pure: no Deno, npm: or jsr: import, so the edge functions, the browser's
 * settings screen and vitest all load this one file. The database validates
 * every value it stores (`app_private.platform_settings_problem_mail`,
 * migration 20260920130000); the functions here say the same thing in
 * TypeScript, so the screen can name a bad field before a save and so a mail is
 * never built from a stored value this build cannot read.
 *
 * ## What may be changed, and what may not
 *
 * Four fields per mail: the subject, the heading, the paragraphs of the body,
 * and — where the mail has one — the label of its button or link. Everything
 * else stays as `otp-mail.ts` writes it: the code box and its validity line
 * ("Der Code ist 10 Minuten gültig." states a limit the database enforces), the
 * link targets, and the security note ("Geben Sie den Code niemals weiter").
 *
 * **The code never appears in a subject.** Mail providers keep subjects in
 * their logs and show them on lock screens (the rule `otp-mail.ts` already
 * states). Structurally: the subject accepts no variable at all, `{code}` is
 * not a variable anywhere — the layout draws the code in its own box — and a
 * subject carrying six digits in a row is refused. And once more at send time:
 * a subject that contains the code it is about to carry is replaced by the
 * default.
 *
 * **A template this build cannot read falls back to the default text**, whole,
 * rather than failing the mail. A code that never arrives locks somebody out of
 * a signup or a password reset; default wording costs nothing.
 *
 * ## A stored template is an override
 *
 * The migration seeds `{}` for every mail: no field overridden, so every mail
 * reads exactly as before, byte for byte. A field the owner sets replaces its
 * default; a field left out keeps following the code, so a later correction of
 * a default reaches every mail nobody customised.
 */
import { emphasis, escapeHtml } from './email-layout.mjs';

/**
 * The code mails whose text may be changed. `platform_login` is not among
 * them: platform sign-in has had no second step since the owner's decision of
 * 16.09.2026, so nobody receives that mail, and an editor for it would describe
 * something that does not happen.
 */
export const MAIL_TEMPLATE_PURPOSES = ['signup_verify', 'password_reset', 'invite_activate', 'email_change'] as const;
export type MailTemplatePurpose = typeof MAIL_TEMPLATE_PURPOSES[number];

export function isMailTemplatePurpose(value: unknown): value is MailTemplatePurpose {
  return typeof value === 'string' && (MAIL_TEMPLATE_PURPOSES as readonly string[]).includes(value);
}

/** The settings key that holds one mail's template. */
export function mailTemplateKey(purpose: MailTemplatePurpose): `mail.template.${MailTemplatePurpose}` {
  return `mail.template.${purpose}`;
}

/**
 * The variables a paragraph may use, per mail. Nothing else is substituted, and
 * a brace that is not one of these is refused.
 *
 * `{company}` is the inviting company's name — or "El-Professor" for an
 * invitation to the platform team, which belongs to no company.
 */
export const MAIL_TEMPLATE_VARIABLES: Readonly<Record<MailTemplatePurpose, readonly string[]>> = {
  signup_verify:   ['email'],
  password_reset:  ['email'],
  invite_activate: ['email', 'company'],
  email_change:    ['email', 'new_email'],
};

/** Whether the mail carries a button or a link whose label a template may set. */
export const MAIL_TEMPLATE_HAS_BUTTON: Readonly<Record<MailTemplatePurpose, boolean>> = {
  signup_verify:   true,
  password_reset:  true,
  invite_activate: true,
  email_change:    false,
};

export interface MailTemplateText {
  readonly subject: string;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  /** Absent where the mail has neither a button nor a link. */
  readonly button?: string;
}

/**
 * The text every code mail carries today, in template form. `otp-mail.ts` takes
 * its subjects, headings and labels from here, and `mail-template.test.ts`
 * renders these paragraphs through the template path and compares them with the
 * default body byte for byte, so the two cannot drift.
 *
 * One difference is deliberate and documented: the default invitation body
 * leaves the company out when there is none ("Für Sie wurde ein Zugang
 * angelegt."), which a single line of template text cannot say. A customised
 * body reads "bei El-Professor" there instead.
 */
export const MAIL_TEMPLATE_DEFAULTS: Readonly<Record<MailTemplatePurpose, MailTemplateText>> = {
  signup_verify: {
    subject: 'Ihr Bestätigungscode – El-Professor',
    heading: 'Bestätigen Sie Ihre E-Mail-Adresse',
    paragraphs: ['Geben Sie diesen Code auf der Registrierungsseite ein, um Ihr El-Professor-Konto für {email} zu aktivieren.'],
    button: 'Seite geschlossen? Hier bestätigen',
  },
  password_reset: {
    subject: 'Code zum Zurücksetzen Ihres Passworts – El-Professor',
    heading: 'Ihr Code für ein neues Passwort',
    paragraphs: ['Für Ihr El-Professor-Konto {email} wurde ein neues Passwort angefordert. Geben Sie diesen Code ein:'],
    button: 'Seite geschlossen? Neuen Code anfordern',
  },
  invite_activate: {
    subject: 'Ihre Einladung zu El-Professor',
    heading: 'Sie wurden zu El-Professor eingeladen',
    paragraphs: ['Für Sie wurde ein Zugang bei {company} angelegt. Öffnen Sie die Einladungsseite und geben Sie diesen Code ein, um Ihr Passwort festzulegen.'],
    button: 'Einladung annehmen',
  },
  email_change: {
    subject: 'Neue E-Mail-Adresse bestätigen – El-Professor',
    heading: 'Neue E-Mail-Adresse bestätigen',
    paragraphs: ['Geben Sie diesen Code in El-Professor ein, um die Anmeldeadresse von {email} auf {new_email} zu ändern.'],
  },
};

/** What `{company}` reads as when an invitation belongs to no company. */
export const MAIL_TEMPLATE_NO_COMPANY = 'El-Professor';

/** A stored template: every field optional, a missing one keeps its default. */
export interface MailTemplateOverrides {
  readonly subject?: string;
  readonly heading?: string;
  readonly paragraphs?: readonly string[];
  readonly button?: string;
}

// The bounds are the database's (migration 20260920130000); a change is made in
// both places, and tests/rls/settings.sql pins the SQL side at each edge.
export const MAIL_SUBJECT_MAX = 150;
export const MAIL_HEADING_MAX = 150;
export const MAIL_BUTTON_MAX = 60;
export const MAIL_PARAGRAPH_MAX = 1000;
export const MAIL_PARAGRAPHS_MAX = 5;
export const MAIL_SENDER_NAME_MAX = 80;

/**
 * Wider than PostgreSQL's `[[:cntrl:]]`, so the screen never sends a value the
 * database would refuse. A paragraph is one paragraph: a line break inside one
 * would be dropped by HTML and kept by the plain-text part, and the two parts
 * of one mail must say the same thing.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const TOKEN = /\{([a-z_]+)\}/g;
const CODE_TOKEN = /\{\s*code\s*\}/i;
const SIX_DIGITS = /\d{6}/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A single-line text field: a string, not blank, within `max`, no control character. */
function plainTextProblem(value: unknown, max: number): boolean {
  return typeof value !== 'string'
    || value.trim() === ''
    || value.length > max
    || CONTROL_CHARACTERS.test(value);
}

/** Whether every brace in `text` belongs to one of `allowed`'s `{name}` tokens. */
function onlyAllowedTokens(text: string, allowed: readonly string[]): boolean {
  const rest = text.replace(TOKEN, (token, name: string) => (allowed.includes(name) ? '' : token));
  return !/[{}]/.test(rest);
}

/**
 * What is wrong with a stored template for one mail, as the database names it
 * — `mail.template.<purpose>`, then `.subject`, `.subject.code`, `.heading`,
 * `.paragraphs`, `.paragraphs.<index>` or `.button` — or null when nothing is.
 */
export function mailTemplateProblem(purpose: MailTemplatePurpose, value: unknown): string | null {
  const path = `mail.template.${purpose}`;
  if (!isRecord(value)) return path;

  const allowed = MAIL_TEMPLATE_HAS_BUTTON[purpose]
    ? ['button', 'heading', 'paragraphs', 'subject']
    : ['heading', 'paragraphs', 'subject'];
  if (Object.keys(value).some(key => !allowed.includes(key))) return path;

  if ('subject' in value) {
    const subject = value.subject;
    if (plainTextProblem(subject, MAIL_SUBJECT_MAX)) return `${path}.subject`;
    if (CODE_TOKEN.test(subject as string) || SIX_DIGITS.test(subject as string)) return `${path}.subject.code`;
    if (/[{}]/.test(subject as string)) return `${path}.subject`;
  }

  if ('heading' in value) {
    if (plainTextProblem(value.heading, MAIL_HEADING_MAX) || /[{}]/.test(value.heading as string)) {
      return `${path}.heading`;
    }
  }

  if ('paragraphs' in value) {
    const paragraphs = value.paragraphs;
    if (!Array.isArray(paragraphs) || paragraphs.length === 0 || paragraphs.length > MAIL_PARAGRAPHS_MAX) {
      return `${path}.paragraphs`;
    }
    for (let i = 0; i < paragraphs.length; i += 1) {
      const paragraph = paragraphs[i];
      if (plainTextProblem(paragraph, MAIL_PARAGRAPH_MAX)
          || !onlyAllowedTokens(paragraph as string, MAIL_TEMPLATE_VARIABLES[purpose])) {
        return `${path}.paragraphs.${i}`;
      }
    }
  }

  if ('button' in value) {
    if (plainTextProblem(value.button, MAIL_BUTTON_MAX) || /[{}]/.test(value.button as string)) {
      return `${path}.button`;
    }
  }

  return null;
}

/** A stored template, or null for anything the database would not have accepted. */
export function parseMailTemplate(purpose: MailTemplatePurpose, value: unknown): MailTemplateOverrides | null {
  if (mailTemplateProblem(purpose, value) !== null) return null;
  const record = value as Record<string, unknown>;
  const overrides: {
    subject?: string; heading?: string; paragraphs?: readonly string[]; button?: string;
  } = {};
  if (typeof record.subject === 'string') overrides.subject = record.subject;
  if (typeof record.heading === 'string') overrides.heading = record.heading;
  if (Array.isArray(record.paragraphs)) overrides.paragraphs = [...(record.paragraphs as string[])];
  if (typeof record.button === 'string') overrides.button = record.button;
  return overrides;
}

/** The values a paragraph's variables stand for, one mail at a time. */
export interface MailTemplateValues {
  email: string;
  newEmail?: string | null;
  companyName?: string | null;
}

function variableValue(name: string, values: MailTemplateValues): string {
  switch (name) {
    case 'email':     return values.email;
    case 'new_email': return values.newEmail ?? '';
    case 'company':   return values.companyName?.trim() || MAIL_TEMPLATE_NO_COMPANY;
    default:          return '';
  }
}

/**
 * Customised paragraphs as the two parts of a mail. In the HTML part the text
 * is escaped and each value set in bold, exactly as the default bodies set an
 * address; paragraphs are separated by an empty line, inside the layout's one
 * body block.
 */
export function renderMailParagraphs(
  paragraphs: readonly string[],
  values: MailTemplateValues,
): { html: string; text: string } {
  const html = paragraphs.map(paragraph => {
    let out = '';
    let last = 0;
    for (const match of paragraph.matchAll(TOKEN)) {
      const index = match.index ?? 0;
      out += escapeHtml(paragraph.slice(last, index));
      out += emphasis(variableValue(match[1], values));
      last = index + match[0].length;
    }
    return out + escapeHtml(paragraph.slice(last));
  });
  const text = paragraphs.map(paragraph =>
    paragraph.replace(TOKEN, (_token, name: string) => variableValue(name, values)));
  return { html: html.join('<br><br>'), text: text.join('\n\n') };
}

/**
 * The subject a mail is sent with. The stored one, unless it would carry the
 * code — which the validator already makes impossible; this is the last word,
 * at the moment the code is known.
 */
export function safeSubject(subject: string, fallback: string, code: string | undefined): string {
  if (code && subject.includes(code)) return fallback;
  return subject;
}

// ─── The sender ──────────────────────────────────────────────────────────────

/**
 * The display name in the From header of every mail the edge functions send.
 * The address itself is not a setting: it must sit on the domain Resend has
 * verified, and a wrong one would stop every mail, so it stays `SMTP_SENDER`
 * in each environment's `.env`.
 */
export interface MailSender {
  readonly name: string;
}

/**
 * `<`, `>`, `"`, `\` and `@` are refused: a display name that looks like an
 * address ("support@bank.de" <noreply@…>) is how a mail pretends to come from
 * somebody else.
 */
const SENDER_FORBIDDEN = /[<>"\\@]/;

export function mailSenderProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'mail.sender';
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'name') return 'mail.sender';
  const name = value.name;
  if (plainTextProblem(name, MAIL_SENDER_NAME_MAX)
      || SENDER_FORBIDDEN.test(name as string)
      || (name as string) !== (name as string).trim()) {
    return 'mail.sender.name';
  }
  return null;
}

export function parseMailSender(value: unknown): MailSender | null {
  if (mailSenderProblem(value) !== null) return null;
  return { name: (value as { name: string }).name };
}

// ─── Reading both at send time ───────────────────────────────────────────────

/** The slice of a Supabase client this needs, so tests can pass a fake. */
export interface MailSettingsRpc {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface MailDeliverySettings {
  /** Null: keep `SMTP_SENDER_NAME`. */
  senderName: string | null;
  /** Null: no stored template applies, so every field is the default. */
  template: MailTemplateOverrides | null;
}

export const NO_MAIL_SETTINGS: MailDeliverySettings = Object.freeze({ senderName: null, template: null });

/**
 * The sender and, for a code mail, its template, through
 * `public.mail_delivery_settings(purpose)` with the service role.
 *
 * Never rejects. A failed read, a malformed answer or a stored value this
 * build cannot read all mean "the defaults" — a code mail that goes out in its
 * default wording is always better than one that does not go out. `onFailure`
 * receives the error for the caller's log; it never sees a value.
 */
export async function loadMailDeliverySettings(
  client: MailSettingsRpc,
  purpose: string | null,
  onFailure?: (err: unknown) => void,
): Promise<MailDeliverySettings> {
  try {
    const { data, error } = await client.rpc('mail_delivery_settings', { p_purpose: purpose });
    if (error) throw error;
    if (!isRecord(data)) return NO_MAIL_SETTINGS;
    const sender = parseMailSender(data.sender);
    const template = isMailTemplatePurpose(purpose) ? parseMailTemplate(purpose, data.template) : null;
    return { senderName: sender?.name ?? null, template };
  } catch (err) {
    onFailure?.(err);
    return NO_MAIL_SETTINGS;
  }
}
