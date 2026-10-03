import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a Node build script without type declarations
import { renderGoTrueTemplate, TEMPLATES, templateActions } from '../../../scripts/build-email-templates.mjs';
import { EMAIL_FOOTER_TEXT, escapeHtml, renderEmailHtml, renderEmailText } from './email-layout.mjs';

/**
 * sha256 of each GoTrue template as scripts/build-email-templates.mjs renders it
 * for https://elprofessor.eu. A deliberate change to these templates updates the
 * hashes in the same commit, and never the other way round: the point of the pin
 * is that somebody reads what moved.
 *
 * Line endings are normalized first, so a Windows checkout with autocrlf does
 * not fail on bytes the build on Linux never produces.
 *
 * **Moved once, on 03.10.2026**, when the mails took the current identity. The
 * first set was what the build produced before the layout moved into
 * email-layout.mjs (origin/staging f191575) â€” that move had to change nothing and
 * diffing the generated files for both origins showed it did not.
 *
 * What moved this time, measured on the rendered HTML rather than assumed: the
 * old `#111827` ink and `#2563eb` link are at **0 occurrences** across all five,
 * replaced by the board's night (23) and blue (5). The complete set of hexes the
 * five templates now contain is `#0a0f1c #146bff #2f3437 #787774 #eaeaea #f7f6f3
 * #ffffff` â€” the palette and nothing else. No markup, no wording and no template
 * action changed; the allow-list and the `{{` rule below are what prove that
 * independently of these hashes.
 */
const TEMPLATE_BYTES: Record<string, string> = {
  'invite.html': 'dc09f033ec9bf4365dd34c1cf0fe126f9bf13d2744a8e70a00bd23a9d45d14d9',
  'recovery.html': '69a9e8344048d8d5a9e3e2dd3d2034e09a549c011ec7f73163d7525a3705400e',
  'confirmation.html': 'a48fb33e97e27177bdf46cc55af85e790329b13fe3b1202447a3e30030a7332f',
  'email-change.html': 'e81ebca85ff720e026c2ddcd95280d2a1cd6143cd4c472b6e12581ebecb4ba32',
  'magic-link.html': '74e9f2324da24e6bcea6bd8d8787b3d83bad7398c03de510cec461bc3fa40109',
};

const LOGO = 'https://elprofessor.eu/email-templates/logo.png';
const render = (file: string): string => renderGoTrueTemplate(TEMPLATES[file], LOGO);

describe('GoTrue templates', () => {
  it('are the five the build writes', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(Object.keys(TEMPLATE_BYTES).sort());
  });

  it.each(Object.keys(TEMPLATE_BYTES))('%s is byte for byte what the build produced before the move', (file) => {
    const html = render(file).replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(html, 'utf8').digest('hex')).toBe(TEMPLATE_BYTES[file]);
  });

  it.each(Object.keys(TEMPLATE_BYTES))('%s passes the template-action allow-list', (file) => {
    const { actions, unexpected } = templateActions(render(file));
    expect(unexpected).toEqual([]);
    expect(actions.filter((action: string) => action === '{{ .ConfirmationURL }}')).toHaveLength(3);
  });

  it('the allow-list catches an action GoTrue does not know', () => {
    expect(templateActions('<p>{{ .Secret }}</p><p>{{ .Email }}</p>').unexpected).toEqual(['{{ .Secret }}']);
  });
});

describe('renderEmailHtml', () => {
  const base = {
    logoUrl: 'https://app.elprofessor.eu/email-templates/logo.png',
    eyebrow: 'Passwort',
    heading: 'Ihr Code',
    preheader: 'Vorschau',
    bodyHtml: 'Text',
    noteHtml: 'Hinweis',
  };

  it('escapes the plain-text fields', () => {
    const html = renderEmailHtml({ ...base, eyebrow: '<b>', heading: 'A & B', preheader: '"x"', code: '123456', codeCaption: "it's" });
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('A &amp; B');
    expect(html).toContain('&quot;x&quot;');
    expect(html).toContain('it&#39;s');
  });

  it('sets the code as a single text node, so copying it yields six digits', () => {
    expect(renderEmailHtml({ ...base, code: '123456' })).toMatch(/>123456<\/p>/);
  });

  it.each(['12345', '1234567', '123 456', 'abcdef'])('refuses the code %j', (code) => {
    expect(() => renderEmailHtml({ ...base, code })).toThrow();
  });

  it.each(['javascript:alert(1)', '/relative', 'https://x.de/"onmouseover="y', 'data:text/html,x'])(
    'refuses the link target %j',
    (href) => {
      expect(() => renderEmailHtml({ ...base, cta: { label: 'Los', href } })).toThrow();
      expect(() => renderEmailHtml({ ...base, link: { label: 'Los', href } })).toThrow();
    },
  );

  it('writes no GoTrue action unless it is handed one', () => {
    const html = renderEmailHtml({ ...base, code: '123456', link: { label: 'Seite', href: 'https://app.elprofessor.eu/x' } });
    expect(html).not.toContain('{{');
  });
});

describe('renderEmailText', () => {
  it('puts the code on its own line and ends with the footer', () => {
    const text = renderEmailText({
      heading: 'Ihr Code',
      bodyText: 'Geben Sie ihn ein.',
      code: '123456',
      codeCaption: 'Der Code ist 10 Minuten gأ¼ltig.',
      link: { label: 'Seite', href: 'https://app.elprofessor.eu/x' },
      noteText: 'Hinweis',
    });
    expect(text.split('\n')).toContain('123456');
    expect(text).toContain('Seite:\nhttps://app.elprofessor.eu/x\n');
    expect(text.endsWith(`-- \n${EMAIL_FOOTER_TEXT}\n`)).toBe(true);
  });
});

describe('escapeHtml', () => {
  it('escapes the five characters that matter in content and in attributes', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
