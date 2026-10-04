// @ts-self-types="./email-layout.d.mts"
/**
 * The one El-Professor mail layout.
 *
 * Two producers render through it, which is why this is a plain ES module with
 * no Node or Deno API in it:
 *
 * - scripts/build-email-templates.mjs builds the GoTrue templates at build time.
 *   It keeps GoTrue's `{{ .ConfirmationURL }}` as the button target, and its
 *   output did not change by a single byte when the layout moved here.
 * - supabase/functions/_shared/otp-mail.ts renders the one-time-code mails at
 *   request time.
 *
 * Why the markup looks the way it does (tables, inline styles, a PNG logo on a
 * white tile, no web fonts, `table-layout:fixed`) is explained in the header of
 * the build script. Two rules belong to the code mails:
 *
 * - The code is a single text node spaced out with CSS letter-spacing. Copying
 *   it yields the six digits and nothing else; spaces or one cell per digit
 *   would paste as "1 2 3 4 5 6" into the code field.
 * - `{{` never appears outside a GoTrue template action. In a GoTrue template a
 *   stray one breaks the parse and GoTrue silently falls back to its English
 *   default; in a code mail it would be a placeholder nobody filled in.
 */

export const EMAIL_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

/**
 * The brand palette, as a mail client can render it.
 *
 * `ink` and `link` moved onto the identity on 03.10.2026, when the mark on the
 * tile became the current one: both comments beside them had gone stale, because
 * the mark is navy-and-blue and `#111827` is neither. The two values are the
 * brand's own: the board's **night** and **blue** as `src/index.css:15` names them,
 * carried by the tokens `--fg` / `--canvas` (10 15 28) and `--brand` (20 107 255).
 *
 * **`link` is the one that needed checking rather than picking.** `#146BFF` on
 * the white card is **4.63:1**, which clears AA for body text; the `#2563eb` it
 * replaces was 5.17:1. Nothing measures this automatically — `tokens.contrast.test.ts`
 * parses `src/index.css` and has never seen this file — so a future change here
 * is a contrast decision somebody has to make by hand.
 *
 * `canvas`, `card`, `border`, `body` and `muted` are deliberately unchanged: they
 * are paper, not identity, and moving them would restyle five byte-pinned
 * templates for nothing.
 */
export const EMAIL_COLORS = Object.freeze({
  canvas: '#F7F6F3',
  card: '#FFFFFF',
  border: '#EAEAEA',
  ink: '#0A0F1C',     // the board's night: the dark of the mark and of the app frame
  body: '#2F3437',
  muted: '#787774',
  link: '#146BFF',    // the board's blue: the mark's glasses and the wordmark
});

const FONT = EMAIL_FONT;
const C = EMAIL_COLORS;
const MONO = "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace";

export const EMAIL_FOOTER_TEXT =
  'El-Professor · Lohn- und Planungsverwaltung für Taxi- und Mietwagenunternehmen\n' +
  'Diese E-Mail wurde automatisch versendet. Antworten auf diese Adresse werden nicht gelesen.';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for element content and double-quoted attribute values. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** An address or name set in bold inside body copy. The text is escaped. */
export function emphasis(text) {
  return `<strong style="color:${C.ink};font-weight:600;">${escapeHtml(text)}</strong>`;
}

const CODE_PATTERN = /^\d{6}$/;
// An absolute web URL, or GoTrue's own action. Anything else in an href is a bug.
const HREF_PATTERN = /^(?:https?:\/\/[^\s"'<>]+|\{\{ \.ConfirmationURL \}\})$/;

function requireCode(code) {
  if (code !== undefined && !CODE_PATTERN.test(code)) {
    throw new Error('email layout: code must be exactly six digits');
  }
}

function requireHref(href) {
  if (!HREF_PATTERN.test(href)) throw new Error('email layout: link target must be an absolute http(s) URL');
  return escapeHtml(href);
}

/**
 * A full HTML document, lang="de".
 *
 * `eyebrow`, `heading`, `preheader`, labels and captions are plain text and
 * escaped here. `bodyHtml` and `noteHtml` are trusted markup: callers escape
 * every interpolated value with escapeHtml() or emphasis().
 */
export function renderEmailHtml(content) {
  const { logoUrl, eyebrow, heading, preheader, bodyHtml, code, codeCaption, cta, link, noteHtml } = content;
  requireCode(code);

  // Each block ends with a newline and blocks are separated by one empty line,
  // which is exactly the whitespace of the original single template.
  const blocks = [
    `      <p style="margin:0 0 28px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.body};">${bodyHtml}</p>
`,
  ];

  if (code !== undefined) {
    const caption = codeCaption
      ? `
          <p style="margin:12px 0 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};">${escapeHtml(codeCaption)}</p>`
      : '';
    blocks.push(`      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px 0;"><tr>
        <td align="center" style="background-color:${C.canvas};border:1px solid ${C.border};border-radius:8px;padding:22px 16px 20px 16px;">
          <p style="margin:0;padding-left:0.3em;font-family:${MONO};font-size:34px;line-height:1.2;font-weight:600;letter-spacing:0.3em;color:${C.ink};">${code}</p>${caption}
        </td>
      </tr></table>
`);
  }

  if (cta) {
    const href = requireHref(cta.href);
    blocks.push(`      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px 0;"><tr>
        <td bgcolor="${C.ink}" style="border-radius:6px;background-color:${C.ink};">
          <a href="${href}" target="_blank" style="display:inline-block;padding:13px 22px;font-family:${FONT};font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(cta.label)}</a>
        </td>
      </tr></table>
`);
    if (cta.fallbackLink) {
      blocks.push(`      <p style="margin:0 0 6px 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};">Falls der Button nicht funktioniert, öffnen Sie diesen Link:</p>
      <p style="margin:0 0 28px 0;font-family:${FONT};font-size:13px;line-height:1.5;word-break:break-all;overflow-wrap:anywhere;"><a href="${href}" target="_blank" style="color:${C.link};text-decoration:underline;">${href}</a></p>
`);
    }
  }

  if (link) {
    const href = requireHref(link.href);
    blocks.push(`      <p style="margin:0 0 28px 0;font-family:${FONT};font-size:14px;line-height:1.5;"><a href="${href}" target="_blank" style="color:${C.link};text-decoration:underline;">${escapeHtml(link.label)}</a></p>
`);
  }

  blocks.push(`      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="background-color:${C.canvas};border:1px solid ${C.border};border-radius:6px;padding:14px 16px;font-family:${FONT};font-size:13px;line-height:1.55;color:${C.body};">${noteHtml}</td>
      </tr></table>
`);

  return `<!DOCTYPE html>
<html lang="de" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(heading)}</title>
<style>
  @media (max-width: 520px) {
    .card { padding: 28px 22px 26px 22px !important; }
    .h1   { font-size: 21px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${C.canvas};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.canvas};">
<tr><td align="center" style="padding:40px 16px;">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;table-layout:fixed;">

    <tr><td style="padding:0 4px 24px 4px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:middle;padding-right:12px;">
          <img src="${escapeHtml(logoUrl)}" width="44" height="44" alt="El-Professor" style="display:block;width:44px;height:44px;border:1px solid ${C.border};border-radius:8px;background-color:#ffffff;">
        </td>
        <td style="vertical-align:middle;font-family:${FONT};font-size:17px;font-weight:600;letter-spacing:-0.01em;color:${C.ink};">El-Professor</td>
      </tr></table>
    </td></tr>

    <tr><td class="card" style="background-color:${C.card};border:1px solid ${C.border};border-radius:8px;padding:40px 40px 36px 40px;">

      <p style="margin:0 0 12px 0;font-family:${FONT};font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${C.muted};">${escapeHtml(eyebrow)}</p>
      <h1 class="h1" style="margin:0 0 20px 0;font-family:${FONT};font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-0.02em;color:${C.ink};">${escapeHtml(heading)}</h1>
${blocks.join('\n')}
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

/**
 * The plain-text part of the same message. The code, when there is one, stands
 * on a line of its own so a reader can select it without the sentence around it.
 */
export function renderEmailText(content) {
  const { heading, bodyText, code, codeCaption, link, noteText } = content;
  requireCode(code);
  const lines = ['El-Professor', '', heading, '', bodyText, ''];
  if (code !== undefined) {
    lines.push(code);
    if (codeCaption) lines.push(codeCaption);
    lines.push('');
  }
  if (link) {
    requireHref(link.href);
    lines.push(`${link.label}:`, link.href, '');
  }
  lines.push(noteText, '', '-- ', EMAIL_FOOTER_TEXT, '');
  return lines.join('\n');
}
