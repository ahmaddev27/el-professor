/**
 * The customisable text of the code mails (plan 3.10).
 *
 * Three things are pinned here, and each has been where this repository lost a
 * rule before:
 *
 * - **Nothing changes until the owner changes it.** With no template, `{}`, or
 *   one this build cannot read, every mail is the default — and the default
 *   paragraphs, run through the template path, are the default body byte for
 *   byte. So the text the editor shows as "the default" is the text that goes
 *   out.
 * - **The code never reaches a subject**, by the validator and again at send
 *   time.
 * - **The two validators agree.** The bounds are read out of the migration's
 *   SQL and compared with the TypeScript constants, and the seeds are read out
 *   of it and compared with what keeps every mail as it was.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOtpMail } from './otp-mail.ts';
// @ts-expect-error -- a plain .mjs module shared with the Node build script
import { EMAIL_COLORS } from './email-layout.mjs';
import {
  loadMailDeliverySettings,
  MAIL_BUTTON_MAX,
  MAIL_HEADING_MAX,
  MAIL_PARAGRAPH_MAX,
  MAIL_PARAGRAPHS_MAX,
  MAIL_SENDER_NAME_MAX,
  MAIL_SUBJECT_MAX,
  MAIL_TEMPLATE_DEFAULTS,
  MAIL_TEMPLATE_HAS_BUTTON,
  MAIL_TEMPLATE_PURPOSES,
  mailSenderProblem,
  mailTemplateKey,
  mailTemplateProblem,
  parseMailSender,
  parseMailTemplate,
  renderMailParagraphs,
  safeSubject,
  type MailTemplatePurpose,
} from './mail-template.ts';

const MIGRATION = readFileSync(
  new URL('../../migrations/20260920130000_platform_settings_mail_flags_seller_read.sql', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

const CODE = '048213';
const vars = {
  appUrl: 'https://app.elprofessor.eu',
  email: 'anna@example.com',
  newEmail: 'neu@example.com',
  companyName: 'Taxi Müller & Söhne',
  code: CODE,
};

describe('with nothing customised, every mail is the default', () => {
  it.each(MAIL_TEMPLATE_PURPOSES)('%s: no template, {} and an unreadable one all send the same bytes', (purpose) => {
    const plain = buildOtpMail(purpose, vars);
    expect(buildOtpMail(purpose, vars, {})).toEqual(plain);
    expect(buildOtpMail(purpose, vars, null)).toEqual(plain);
    expect(buildOtpMail(purpose, vars, 'not a template')).toEqual(plain);
    expect(buildOtpMail(purpose, vars, { subject: 'Ihr Code {code}' })).toEqual(plain);
    expect(buildOtpMail(purpose, vars, { paragraphs: [] })).toEqual(plain);
  });

  it.each(MAIL_TEMPLATE_PURPOSES)('%s: the default text, set explicitly, is the default mail byte for byte', (purpose) => {
    // What the editor shows as "the default" must be what goes out when the
    // owner saves it unchanged — including the invitation's company.
    const defaults = MAIL_TEMPLATE_DEFAULTS[purpose];
    expect(buildOtpMail(purpose, vars, { ...defaults })).toEqual(buildOtpMail(purpose, vars));
  });

  it('the one documented difference: a customised invitation says "bei El-Professor" when no company invited', () => {
    const noCompany = { ...vars, companyName: null };
    const custom = buildOtpMail('invite_activate', noCompany, { paragraphs: MAIL_TEMPLATE_DEFAULTS.invite_activate.paragraphs });
    expect(custom.text).toContain('Für Sie wurde ein Zugang bei El-Professor angelegt.');
    expect(buildOtpMail('invite_activate', noCompany).text).toContain('Für Sie wurde ein Zugang angelegt.');
  });

  it('platform_login takes no template at all', () => {
    const plain = buildOtpMail('platform_login', vars);
    expect(buildOtpMail('platform_login', vars, { subject: 'Anders' })).toEqual(plain);
  });
});

describe('a customised template', () => {
  const template = {
    subject: 'Willkommen – bitte bestätigen',
    heading: 'Fast geschafft',
    paragraphs: ['Hallo {email}, Sie sind fast fertig.', 'Zweiter Absatz <b>ohne</b> Markup & mit Zeichen.'],
    button: 'Zur Bestätigung',
  };

  it('replaces the subject, the heading, the body and the link label, and nothing else', () => {
    const mail = buildOtpMail('signup_verify', vars, template);
    expect(mail.subject).toBe('Willkommen – bitte bestätigen');
    expect(mail.html).toContain('<title>Fast geschafft</title>');
    expect(mail.html).toContain('>Zur Bestätigung</a>');
    // the code box, its validity and the security note stay as they were
    expect(mail.html).toContain(CODE);
    expect(mail.text).toContain('Der Code ist 10 Minuten gültig.');
    expect(mail.text).toContain('Geben Sie den Code niemals weiter – El-Professor fragt Sie nie danach.');
    // the link target is the default's
    expect(mail.html).toContain('href="https://app.elprofessor.eu/auth/verify-email#email=anna%40example.com"');
  });

  it('escapes the text and sets each value in bold, as the default bodies set an address', () => {
    const mail = buildOtpMail('signup_verify', vars, template);
    // The ink comes from `EMAIL_COLORS` rather than being written out: this line
    // held `#111827` as a literal and broke on 03.10.2026 when the mails took the
    // current identity, which is a test failing for the palette's reason rather
    // than its own. What it is really asserting is that the address is set in
    // bold **in the body ink**, whatever that ink is.
    expect(mail.html).toContain(
      `Hallo <strong style="color:${EMAIL_COLORS.ink};font-weight:600;">anna@example.com</strong>, Sie sind fast fertig.`);
    expect(mail.html).toContain('Zweiter Absatz &lt;b&gt;ohne&lt;/b&gt; Markup &amp; mit Zeichen.');
    expect(mail.html).not.toContain('<b>ohne</b>');
  });

  it('writes the plain-text part with the same paragraphs, an empty line apart', () => {
    const mail = buildOtpMail('signup_verify', vars, template);
    expect(mail.text).toContain('Hallo anna@example.com, Sie sind fast fertig.\n\nZweiter Absatz <b>ohne</b> Markup & mit Zeichen.');
  });

  it('renames the invitation button, and its fallback link keeps the same target', () => {
    const mail = buildOtpMail('invite_activate', vars, { button: 'Jetzt starten' });
    expect(mail.html).toContain('>Jetzt starten</a>');
    expect(mail.text).toContain('Jetzt starten:\nhttps://app.elprofessor.eu/einladung#email=anna%40example.com');
  });

  it('fills {company} and {new_email} only where they belong', () => {
    const invite = renderMailParagraphs(['Bei {company} für {email}.'], { email: 'a@x.de', companyName: 'Firma' });
    expect(invite.text).toBe('Bei Firma für a@x.de.');
    const change = renderMailParagraphs(['{email} wird {new_email}.'], { email: 'a@x.de', newEmail: 'b@x.de' });
    expect(change.text).toBe('a@x.de wird b@x.de.');
  });
});

describe('the code never reaches a subject', () => {
  it.each(MAIL_TEMPLATE_PURPOSES)('%s: {code}, six digits and any variable are refused in the subject', (purpose) => {
    const key = mailTemplateKey(purpose);
    expect(mailTemplateProblem(purpose, { subject: 'Ihr Code {code}' })).toBe(`${key}.subject.code`);
    expect(mailTemplateProblem(purpose, { subject: 'Ihr Code { CODE }' })).toBe(`${key}.subject.code`);
    expect(mailTemplateProblem(purpose, { subject: 'Code 482915' })).toBe(`${key}.subject.code`);
    expect(mailTemplateProblem(purpose, { subject: 'Hallo {email}' })).toBe(`${key}.subject`);
    expect(mailTemplateProblem(purpose, { subject: 'Ihr Code – 2026' })).toBeNull();
  });

  it('{code} is not a variable anywhere', () => {
    expect(mailTemplateProblem('signup_verify', { paragraphs: ['Ihr Code: {code}'] }))
      .toBe('mail.template.signup_verify.paragraphs.0');
  });

  it('and at send time a subject that holds the code is replaced by the default', () => {
    expect(safeSubject('Ihr Code 048213', 'Standard', CODE)).toBe('Standard');
    expect(safeSubject('Ihr Code', 'Standard', CODE)).toBe('Ihr Code');
    expect(safeSubject('Ihr Code', 'Standard', undefined)).toBe('Ihr Code');
  });
});

describe('what a template may say', () => {
  const key = (purpose: MailTemplatePurpose) => mailTemplateKey(purpose);

  it('accepts the empty override and every field alone', () => {
    for (const purpose of MAIL_TEMPLATE_PURPOSES) {
      expect(mailTemplateProblem(purpose, {})).toBeNull();
      expect(parseMailTemplate(purpose, {})).toEqual({});
      expect(mailTemplateProblem(purpose, { heading: 'Hallo' })).toBeNull();
    }
  });

  it('refuses anything that is not an object, and any field it does not know', () => {
    expect(mailTemplateProblem('signup_verify', [])).toBe(key('signup_verify'));
    expect(mailTemplateProblem('signup_verify', 'x')).toBe(key('signup_verify'));
    expect(mailTemplateProblem('signup_verify', { preheader: 'x' })).toBe(key('signup_verify'));
  });

  it('refuses a button label on the one mail that has no button', () => {
    expect(MAIL_TEMPLATE_HAS_BUTTON.email_change).toBe(false);
    expect(mailTemplateProblem('email_change', { button: 'Los' })).toBe(key('email_change'));
    expect(mailTemplateProblem('invite_activate', { button: 'Los' })).toBeNull();
  });

  it('refuses a variable a mail does not have, and a stray brace', () => {
    expect(mailTemplateProblem('signup_verify', { paragraphs: ['Bei {company}'] })).toBe(`${key('signup_verify')}.paragraphs.0`);
    expect(mailTemplateProblem('invite_activate', { paragraphs: ['Bei {company}'] })).toBeNull();
    expect(mailTemplateProblem('email_change', { paragraphs: ['Neu: {new_email}'] })).toBeNull();
    expect(mailTemplateProblem('invite_activate', { paragraphs: ['ok', 'Klammer { offen'] })).toBe(`${key('invite_activate')}.paragraphs.1`);
    expect(mailTemplateProblem('invite_activate', { paragraphs: ['{{email}}'] })).toBe(`${key('invite_activate')}.paragraphs.0`);
    expect(mailTemplateProblem('invite_activate', { heading: 'Hallo {email}' })).toBe(`${key('invite_activate')}.heading`);
    expect(mailTemplateProblem('invite_activate', { button: '{email}' })).toBe(`${key('invite_activate')}.button`);
  });

  it('refuses blanks, control characters and overlong text, at the database\'s bounds', () => {
    const p = key('password_reset');
    expect(mailTemplateProblem('password_reset', { subject: '   ' })).toBe(`${p}.subject`);
    expect(mailTemplateProblem('password_reset', { subject: 'x'.repeat(MAIL_SUBJECT_MAX) })).toBeNull();
    expect(mailTemplateProblem('password_reset', { subject: 'x'.repeat(MAIL_SUBJECT_MAX + 1) })).toBe(`${p}.subject`);
    expect(mailTemplateProblem('password_reset', { heading: 'a\nb' })).toBe(`${p}.heading`);
    expect(mailTemplateProblem('password_reset', { heading: 'x'.repeat(MAIL_HEADING_MAX + 1) })).toBe(`${p}.heading`);
    expect(mailTemplateProblem('password_reset', { button: 'x'.repeat(MAIL_BUTTON_MAX + 1) })).toBe(`${p}.button`);
    expect(mailTemplateProblem('password_reset', { paragraphs: ['x'.repeat(MAIL_PARAGRAPH_MAX)] })).toBeNull();
    expect(mailTemplateProblem('password_reset', { paragraphs: ['x'.repeat(MAIL_PARAGRAPH_MAX + 1)] })).toBe(`${p}.paragraphs.0`);
    expect(mailTemplateProblem('password_reset', { paragraphs: Array(MAIL_PARAGRAPHS_MAX).fill('x') })).toBeNull();
    expect(mailTemplateProblem('password_reset', { paragraphs: Array(MAIL_PARAGRAPHS_MAX + 1).fill('x') })).toBe(`${p}.paragraphs`);
    expect(mailTemplateProblem('password_reset', { paragraphs: [] })).toBe(`${p}.paragraphs`);
    expect(mailTemplateProblem('password_reset', { paragraphs: ['a\tb'] })).toBe(`${p}.paragraphs.0`);
    expect(mailTemplateProblem('password_reset', { paragraphs: [3] })).toBe(`${p}.paragraphs.0`);
  });

  it('every default is itself a valid template', () => {
    for (const purpose of MAIL_TEMPLATE_PURPOSES) {
      expect(mailTemplateProblem(purpose, { ...MAIL_TEMPLATE_DEFAULTS[purpose] })).toBeNull();
    }
  });
});

describe('the sender', () => {
  it('accepts a plain display name', () => {
    expect(parseMailSender({ name: 'El-Professor' })).toEqual({ name: 'El-Professor' });
    expect(parseMailSender({ name: 'El-Professor Support' })).toEqual({ name: 'El-Professor Support' });
  });

  it('refuses what could pass for an address, and anything else malformed', () => {
    for (const name of ['support@bank.de', 'Bank <x@y.de>', 'Say "hi"', 'a\\b', ' El-Professor', '', 'a\nb', 'x'.repeat(MAIL_SENDER_NAME_MAX + 1)]) {
      expect(mailSenderProblem({ name })).toBe('mail.sender.name');
    }
    expect(mailSenderProblem({ name: 'x'.repeat(MAIL_SENDER_NAME_MAX) })).toBeNull();
    expect(mailSenderProblem({})).toBe('mail.sender');
    expect(mailSenderProblem({ name: 'x', address: 'y' })).toBe('mail.sender');
    expect(mailSenderProblem(null)).toBe('mail.sender');
  });
});

describe('reading the settings at send time never stops a mail', () => {
  const answering = (data: unknown, error: unknown = null) => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      expect(fn).toBe('mail_delivery_settings');
      expect(Object.keys(args)).toEqual(['p_purpose']);
      return { data, error };
    },
  });

  it('reads the sender and the template of a code mail', async () => {
    const settings = await loadMailDeliverySettings(
      answering({ sender: { name: 'Plattform' }, template: { subject: 'Hallo' } }), 'signup_verify');
    expect(settings).toEqual({ senderName: 'Plattform', template: { subject: 'Hallo' } });
  });

  it('ignores a template for anything but a code mail, and an unreadable part keeps its default', async () => {
    expect(await loadMailDeliverySettings(answering({ sender: { name: 'P' }, template: { subject: 'x' } }), null))
      .toEqual({ senderName: 'P', template: null });
    expect(await loadMailDeliverySettings(answering({ sender: { name: 'a@b' }, template: { subject: '{code}' } }), 'signup_verify'))
      .toEqual({ senderName: null, template: null });
    expect(await loadMailDeliverySettings(answering('nonsense'), 'signup_verify'))
      .toEqual({ senderName: null, template: null });
  });

  it('a failed read answers the defaults and reports the error, never the value', async () => {
    const seen: unknown[] = [];
    const settings = await loadMailDeliverySettings(answering(null, new Error('boom')), 'signup_verify', (err) => seen.push(err));
    expect(settings).toEqual({ senderName: null, template: null });
    expect(seen).toHaveLength(1);

    const throwing = { rpc: () => { throw new Error('network'); } };
    expect(await loadMailDeliverySettings(throwing, 'password_reset')).toEqual({ senderName: null, template: null });
  });
});

describe('the migration and this module say the same thing', () => {
  const constant = (name: string): number => {
    const match = MIGRATION.match(new RegExp(`${name}\\s+CONSTANT integer := (\\d+);`));
    if (!match) throw new Error(`the migration declares no ${name}`);
    return Number(match[1]);
  };

  it('the bounds', () => {
    expect(constant('c_subject_max')).toBe(MAIL_SUBJECT_MAX);
    expect(constant('c_heading_max')).toBe(MAIL_HEADING_MAX);
    expect(constant('c_button_max')).toBe(MAIL_BUTTON_MAX);
    expect(constant('c_paragraph_max')).toBe(MAIL_PARAGRAPH_MAX);
    expect(constant('c_paragraphs_max')).toBe(MAIL_PARAGRAPHS_MAX);
    expect(constant('c_sender_max')).toBe(MAIL_SENDER_NAME_MAX);
  });

  it('the mails whose text may change', () => {
    const match = MIGRATION.match(/c_purposes\s+CONSTANT text\[\]\s+:= ARRAY\[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const purposes = [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(purposes).toEqual([...MAIL_TEMPLATE_PURPOSES].sort());
  });

  it('the seeds: the sender both hosts already use, and an empty override for every mail', () => {
    const sender = MIGRATION.match(/\$seed_mail_sender\$([\s\S]*?)\$seed_mail_sender\$/);
    expect(JSON.parse(sender![1])).toEqual({ name: 'El-Professor' });
    const compose = readFileSync(new URL('../../../deploy/docker-compose.yml', import.meta.url), 'utf8');
    expect(compose).toContain('SMTP_SENDER_NAME: ${SMTP_SENDER_NAME:-El-Professor}');

    for (const purpose of MAIL_TEMPLATE_PURPOSES) {
      const seed = MIGRATION.match(new RegExp(`\\('${mailTemplateKey(purpose).replace(/\./g, '\\.')}',\\s*\\$seed_mail_template\\$([\\s\\S]*?)\\$seed_mail_template\\$`));
      expect(seed, purpose).not.toBeNull();
      expect(JSON.parse(seed![1])).toEqual({});
    }
  });
});
