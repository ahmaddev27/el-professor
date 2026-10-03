/**
 * Build the German, El-Professor-branded GoTrue mail templates.
 *
 *   VITE_APP_URL=https://elprofessor.eu node scripts/build-email-templates.mjs
 *
 * Runs after `vite build` (see package.json) and writes dist/email-templates/*.html.
 * They ship with the frontend and GoTrue fetches them from the web container
 * (see GOTRUE_MAILER_TEMPLATES_* in deploy/docker-compose.yml). The generated
 * HTML is not committed: edit the copy here â€” one layout keeps the five
 * messages from drifting apart.
 *
 * The layout itself lives in supabase/functions/_shared/email-layout.mjs, because
 * the edge functions render the one-time-code mails with the same markup. Moving
 * it there changed none of these five files by a single byte.
 *
 * The logo URL is absolute because a mail client fetches it from the reader's
 * machine, and it differs per environment. Production and staging build from
 * the same commit, so a URL written into a committed file would put one
 * environment's address into the other's mail. VITE_APP_URL is required and
 * there is no default, for the same reason.
 *
 * Email is not the web. What shapes every choice in the layout:
 *
 * - Layout is tables with inline styles. Gmail strips <style> in some contexts,
 *   Outlook desktop renders with Word, and neither honours flexbox or grid.
 *   The one <style> block only tightens padding on phones; the message is fully
 *   usable where it is dropped, because nothing structural depends on it.
 * - `table-layout:fixed` on the column is what keeps a phone from overflowing.
 *   Without it the table sizes to its widest unbreakable content â€” the raw
 *   link â€” and the card runs off the right edge of the screen.
 * - No web fonts. A system stack renders everywhere; a webfont falls back
 *   unpredictably and adds a request.
 * - The logo is a PNG on a white ground, never a transparent SVG. Gmail drops
 *   SVG, and clients that force dark mode invert the page â€” a black mark on a
 *   transparent background vanishes, a white tile with a black mark does not.
 * - The brand name is also live text next to the logo, because many clients
 *   block images until the reader allows them.
 * - The link is repeated as plain text under the button, for clients that
 *   break buttons and for readers who distrust them.
 *
 * GoTrue renders these with Go's html/template. Keep `{{` out of anything that
 * is not a template action â€” including CSS and HTML comments.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderEmailHtml } from '../supabase/functions/_shared/email-layout.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const TEMPLATES = {
  'invite.html': {
    eyebrow: 'Einladung',
    heading: 'Sie wurden zu El-Professor eingeladen',
    preheader: 'Legen Sie Ihr Passwort fest und melden Sie sich bei El-Professor an.',
    body: 'Fأ¼r Sie wurde ein Konto bei El-Professor angelegt. Legen Sie أ¼ber den folgenden Link ein Passwort fest, um sich anzumelden.',
    cta: 'Einladung annehmen',
    note: 'Wenn Sie keine Einladung erwartet haben, kأ¶nnen Sie diese E-Mail ignorieren.',
  },

  // Sent in two situations through the same GoTrue template: an admin invited
  // a new employee (manage-users sends a recovery link to an account that has
  // no usable password yet), and someone used "Passwort vergessen". The copy
  // has to read naturally for both, so it says "festlegen", not "zurأ¼cksetzen".
  'recovery.html': {
    eyebrow: 'Passwort',
    heading: 'Passwort festlegen',
    preheader: 'Legen Sie ein Passwort fأ¼r Ihr El-Professor-Konto fest.',
    body: 'أœber den folgenden Link legen Sie ein neues Passwort fأ¼r Ihr <span style="white-space:nowrap;">El-Professor-Konto</span> <strong style="color:#0A0F1C;font-weight:600;">{{ .Email }}</strong> fest.',
    cta: 'Passwort festlegen',
    note: 'Wenn Sie diese E-Mail nicht erwartet haben, kأ¶nnen Sie sie ignorieren â€” Ihr Konto bleibt unverأ¤ndert. Der Link ist aus Sicherheitsgrأ¼nden nur begrenzt gأ¼ltig.',
  },

  'confirmation.html': {
    eyebrow: 'Registrierung',
    heading: 'E-Mail-Adresse bestأ¤tigen',
    preheader: 'Bestأ¤tigen Sie Ihre E-Mail-Adresse, um die Registrierung abzuschlieأںen.',
    body: 'Bitte bestأ¤tigen Sie Ihre E-Mail-Adresse, um die Registrierung bei El-Professor abzuschlieأںen.',
    cta: 'E-Mail-Adresse bestأ¤tigen',
    note: 'Wenn Sie sich nicht bei El-Professor registriert haben, kأ¶nnen Sie diese E-Mail ignorieren.',
  },

  'email-change.html': {
    eyebrow: 'Kontoأ¤nderung',
    heading: 'Neue E-Mail-Adresse bestأ¤tigen',
    preheader: 'Bestأ¤tigen Sie die أ„nderung Ihrer E-Mail-Adresse bei El-Professor.',
    body: 'Bitte bestأ¤tigen Sie, dass Ihre E-Mail-Adresse bei El-Professor von <strong style="color:#0A0F1C;font-weight:600;">{{ .Email }}</strong> zu <strong style="color:#0A0F1C;font-weight:600;">{{ .NewEmail }}</strong> geأ¤ndert werden soll.',
    cta: 'أ„nderung bestأ¤tigen',
    note: 'Wenn Sie diese أ„nderung nicht veranlasst haben, ignorieren Sie diese E-Mail und أ¤ndern Sie vorsorglich Ihr Passwort.',
  },

  'magic-link.html': {
    eyebrow: 'Anmeldung',
    heading: 'Ihr Anmeldelink',
    preheader: 'Melden Sie sich mit einem Klick bei El-Professor an.',
    body: 'أœber den folgenden Link melden Sie sich bei El-Professor an.',
    cta: 'Jetzt anmelden',
    note: 'Wenn Sie keine Anmeldung angefordert haben, kأ¶nnen Sie diese E-Mail ignorieren.',
  },
};

/** One GoTrue template. `body` and `note` may contain markup; everything else is text. */
export function renderGoTrueTemplate({ eyebrow, heading, preheader, body, cta, note }, logoUrl) {
  return renderEmailHtml({
    logoUrl,
    eyebrow,
    heading,
    preheader,
    bodyHtml: body,
    cta: { label: cta, href: '{{ .ConfirmationURL }}', fallbackLink: true },
    noteHtml: note,
  });
}

const ALLOWED_ACTION = /^\{\{ \.(ConfirmationURL|Email|NewEmail|SiteURL|Token|TokenHash|RedirectTo) \}\}$/;

/**
 * The template actions in a rendered file, and the ones GoTrue would not know.
 * A stray `{{` outside a template action breaks GoTrue's parse and silently
 * reverts that message to the English default.
 */
export function templateActions(html) {
  const actions = html.match(/\{\{[^}]*\}\}/g) ?? [];
  return { actions, unexpected: actions.filter((a) => !ALLOWED_ACTION.test(a)) };
}

// CI sets VITE_APP_URL explicitly per environment. A local `npm run build` has
// no such variable, so it reads the same .env.production Vite itself used.
function appUrl() {
  if (process.env.VITE_APP_URL) return { url: process.env.VITE_APP_URL, from: 'environment' };
  const file = path.join(ROOT, '.env.production');
  if (existsSync(file)) {
    const m = readFileSync(file, 'utf8').match(/^VITE_APP_URL=(.+)$/m);
    if (m) return { url: m[1].trim(), from: '.env.production' };
  }
  throw new Error('VITE_APP_URL is not set â€” refusing to build mail templates with a guessed logo URL');
}

function main() {
  const { url: APP_URL, from: APP_URL_FROM } = appUrl();
  if (!/^https:\/\/[^/]+$/.test(APP_URL.replace(/\/$/, ''))) {
    throw new Error(`VITE_APP_URL must be an https origin with no path, got: ${APP_URL}`);
  }
  const logo = `${APP_URL.replace(/\/$/, '')}/email-templates/logo.png`;
  if (!existsSync(path.join(ROOT, 'dist'))) {
    throw new Error('dist/ does not exist â€” run this after vite build, not before');
  }

  const out = path.join(ROOT, 'dist', 'email-templates');
  mkdirSync(out, { recursive: true });
  console.log(`  mail templates for ${APP_URL} (from ${APP_URL_FROM})`);
  for (const [file, t] of Object.entries(TEMPLATES)) {
    const html = renderGoTrueTemplate(t, logo);
    const { actions, unexpected } = templateActions(html);
    if (unexpected.length) throw new Error(`${file}: unexpected template action ${unexpected.join(', ')}`);
    writeFileSync(path.join(out, file), html);
    console.log(`  ${file.padEnd(20)} ${String(html.length).padStart(5)} bytes  ${actions.length} actions`);
  }
}

// Imported by the tests for TEMPLATES and templateActions; run as a script by
// the build. Node names the entry module by the real path of argv[1], so the
// comparison resolves links the same way: a checkout reached through a symlink
// or a junction must still build, not skip the templates without a word.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
