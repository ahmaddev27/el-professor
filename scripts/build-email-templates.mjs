#!/usr/bin/env node
/**
 * Build the German, El-Professor-branded GoTrue mail templates.
 *
 *   VITE_APP_URL=https://elprofessor.eu node scripts/build-email-templates.mjs
 *
 * Runs after `vite build` (see package.json) and writes dist/email-templates/*.html.
 * They ship with the frontend and GoTrue fetches them from the web container
 * (see GOTRUE_MAILER_TEMPLATES_* in deploy/docker-compose.yml). The generated
 * HTML is not committed: edit the copy here — one layout keeps the five
 * messages from drifting apart.
 *
 * The logo URL is absolute because a mail client fetches it from the reader's
 * machine, and it differs per environment. Production and staging build from
 * the same commit, so a URL written into a committed file would put one
 * environment's address into the other's mail. VITE_APP_URL is required and
 * there is no default, for the same reason.
 *
 * Email is not the web. What shapes every choice below:
 *
 * - Layout is tables with inline styles. Gmail strips <style> in some contexts,
 *   Outlook desktop renders with Word, and neither honours flexbox or grid.
 *   The one <style> block only tightens padding on phones; the message is fully
 *   usable where it is dropped, because nothing structural depends on it.
 * - `table-layout:fixed` on the column is what keeps a phone from overflowing.
 *   Without it the table sizes to its widest unbreakable content — the raw
 *   link — and the card runs off the right edge of the screen.
 * - No web fonts. A system stack renders everywhere; a webfont falls back
 *   unpredictably and adds a request.
 * - The logo is a PNG on a white ground, never a transparent SVG. Gmail drops
 *   SVG, and clients that force dark mode invert the page — a black mark on a
 *   transparent background vanishes, a white tile with a black mark does not.
 * - The brand name is also live text next to the logo, because many clients
 *   block images until the reader allows them.
 * - The link is repeated as plain text under the button, for clients that
 *   break buttons and for readers who distrust them.
 *
 * GoTrue renders these with Go's html/template. Keep `{{` out of anything that
 * is not a template action — including CSS and HTML comments.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'dist', 'email-templates');

// CI sets VITE_APP_URL explicitly per environment. A local `npm run build` has
// no such variable, so it reads the same .env.production Vite itself used.
function appUrl() {
  if (process.env.VITE_APP_URL) return { url: process.env.VITE_APP_URL, from: 'environment' };
  const file = path.join(ROOT, '.env.production');
  if (existsSync(file)) {
    const m = readFileSync(file, 'utf8').match(/^VITE_APP_URL=(.+)$/m);
    if (m) return { url: m[1].trim(), from: '.env.production' };
  }
  throw new Error('VITE_APP_URL is not set — refusing to build mail templates with a guessed logo URL');
}
const { url: APP_URL, from: APP_URL_FROM } = appUrl();
if (!/^https:\/\/[^/]+$/.test(APP_URL.replace(/\/$/, ''))) {
  throw new Error(`VITE_APP_URL must be an https origin with no path, got: ${APP_URL}`);
}
const LOGO = `${APP_URL.replace(/\/$/, '')}/email-templates/logo.png`;
if (!existsSync(path.join(ROOT, 'dist'))) {
  throw new Error('dist/ does not exist — run this after vite build, not before');
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
const C = {
  canvas: '#F7F6F3',
  card: '#FFFFFF',
  border: '#EAEAEA',
  ink: '#111827',     // the app's --text-primary, and the colour of the logo mark
  body: '#2F3437',
  muted: '#787774',
  link: '#2563eb',    // the app's --accent
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One message. `body` and `note` may contain markup; everything else is text. */
function render({ eyebrow, heading, preheader, body, cta, note }) {
  return `<!DOCTYPE html>
<html lang="de" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(heading)}</title>
<style>
  @media (max-width: 520px) {
    .card { padding: 28px 22px 26px 22px !important; }
    .h1   { font-size: 21px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${C.canvas};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.canvas};">
<tr><td align="center" style="padding:40px 16px;">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;table-layout:fixed;">

    <tr><td style="padding:0 4px 24px 4px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:middle;padding-right:12px;">
          <img src="${LOGO}" width="44" height="44" alt="El-Professor" style="display:block;width:44px;height:44px;border:1px solid ${C.border};border-radius:8px;background-color:#ffffff;">
        </td>
        <td style="vertical-align:middle;font-family:${FONT};font-size:17px;font-weight:600;letter-spacing:-0.01em;color:${C.ink};">El-Professor</td>
      </tr></table>
    </td></tr>

    <tr><td class="card" style="background-color:${C.card};border:1px solid ${C.border};border-radius:8px;padding:40px 40px 36px 40px;">

      <p style="margin:0 0 12px 0;font-family:${FONT};font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${C.muted};">${esc(eyebrow)}</p>
      <h1 class="h1" style="margin:0 0 20px 0;font-family:${FONT};font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-0.02em;color:${C.ink};">${esc(heading)}</h1>
      <p style="margin:0 0 28px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.body};">${body}</p>

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px 0;"><tr>
        <td bgcolor="${C.ink}" style="border-radius:6px;background-color:${C.ink};">
          <a href="{{ .ConfirmationURL }}" target="_blank" style="display:inline-block;padding:13px 22px;font-family:${FONT};font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:6px;">${esc(cta)}</a>
        </td>
      </tr></table>

      <p style="margin:0 0 6px 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};">Falls der Button nicht funktioniert, öffnen Sie diesen Link:</p>
      <p style="margin:0 0 28px 0;font-family:${FONT};font-size:13px;line-height:1.5;word-break:break-all;overflow-wrap:anywhere;"><a href="{{ .ConfirmationURL }}" target="_blank" style="color:${C.link};text-decoration:underline;">{{ .ConfirmationURL }}</a></p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="background-color:${C.canvas};border:1px solid ${C.border};border-radius:6px;padding:14px 16px;font-family:${FONT};font-size:13px;line-height:1.55;color:${C.body};">${note}</td>
      </tr></table>

    </td></tr>

    <tr><td style="padding:24px 4px 0 4px;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};">
      El-Professor · Lohn- und Planungsverwaltung für Taxi- und Mietwagenunternehmen<br>
      Diese E-Mail wurde automatisch versendet. Antworten auf diese Adresse werden nicht gelesen.
    </td></tr>

  </table>

</td></tr>
</table>
</body>
</html>
`;
}

const TEMPLATES = {
  'invite.html': {
    eyebrow: 'Einladung',
    heading: 'Sie wurden zu El-Professor eingeladen',
    preheader: 'Legen Sie Ihr Passwort fest und melden Sie sich bei El-Professor an.',
    body: 'Für Sie wurde ein Konto bei El-Professor angelegt. Legen Sie über den folgenden Link ein Passwort fest, um sich anzumelden.',
    cta: 'Einladung annehmen',
    note: 'Wenn Sie keine Einladung erwartet haben, können Sie diese E-Mail ignorieren.',
  },

  // Sent in two situations through the same GoTrue template: an admin invited
  // a new employee (manage-users sends a recovery link to an account that has
  // no usable password yet), and someone used "Passwort vergessen". The copy
  // has to read naturally for both, so it says "festlegen", not "zurücksetzen".
  'recovery.html': {
    eyebrow: 'Passwort',
    heading: 'Passwort festlegen',
    preheader: 'Legen Sie ein Passwort für Ihr El-Professor-Konto fest.',
    body: 'Über den folgenden Link legen Sie ein neues Passwort für Ihr <span style="white-space:nowrap;">El-Professor-Konto</span> <strong style="color:#111827;font-weight:600;">{{ .Email }}</strong> fest.',
    cta: 'Passwort festlegen',
    note: 'Wenn Sie diese E-Mail nicht erwartet haben, können Sie sie ignorieren — Ihr Konto bleibt unverändert. Der Link ist aus Sicherheitsgründen nur begrenzt gültig.',
  },

  'confirmation.html': {
    eyebrow: 'Registrierung',
    heading: 'E-Mail-Adresse bestätigen',
    preheader: 'Bestätigen Sie Ihre E-Mail-Adresse, um die Registrierung abzuschließen.',
    body: 'Bitte bestätigen Sie Ihre E-Mail-Adresse, um die Registrierung bei El-Professor abzuschließen.',
    cta: 'E-Mail-Adresse bestätigen',
    note: 'Wenn Sie sich nicht bei El-Professor registriert haben, können Sie diese E-Mail ignorieren.',
  },

  'email-change.html': {
    eyebrow: 'Kontoänderung',
    heading: 'Neue E-Mail-Adresse bestätigen',
    preheader: 'Bestätigen Sie die Änderung Ihrer E-Mail-Adresse bei El-Professor.',
    body: 'Bitte bestätigen Sie, dass Ihre E-Mail-Adresse bei El-Professor von <strong style="color:#111827;font-weight:600;">{{ .Email }}</strong> zu <strong style="color:#111827;font-weight:600;">{{ .NewEmail }}</strong> geändert werden soll.',
    cta: 'Änderung bestätigen',
    note: 'Wenn Sie diese Änderung nicht veranlasst haben, ignorieren Sie diese E-Mail und ändern Sie vorsorglich Ihr Passwort.',
  },

  'magic-link.html': {
    eyebrow: 'Anmeldung',
    heading: 'Ihr Anmeldelink',
    preheader: 'Melden Sie sich mit einem Klick bei El-Professor an.',
    body: 'Über den folgenden Link melden Sie sich bei El-Professor an.',
    cta: 'Jetzt anmelden',
    note: 'Wenn Sie keine Anmeldung angefordert haben, können Sie diese E-Mail ignorieren.',
  },
};

mkdirSync(OUT, { recursive: true });
console.log(`  mail templates for ${APP_URL} (from ${APP_URL_FROM})`);
for (const [file, t] of Object.entries(TEMPLATES)) {
  const html = render(t);
  // A stray `{{` outside a template action breaks GoTrue's parse and silently
  // reverts that message to the English default.
  const actions = html.match(/\{\{[^}]*\}\}/g) ?? [];
  const bad = actions.filter((a) => !/^\{\{ \.(ConfirmationURL|Email|NewEmail|SiteURL|Token|TokenHash|RedirectTo) \}\}$/.test(a));
  if (bad.length) throw new Error(`${file}: unexpected template action ${bad.join(', ')}`);
  writeFileSync(path.join(OUT, file), html);
  console.log(`  ${file.padEnd(20)} ${String(html.length).padStart(5)} bytes  ${actions.length} actions`);
}
