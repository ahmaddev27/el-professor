import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a Node build script without type declarations
import { renderGoTrueTemplate, TEMPLATES, templateActions } from '../../../scripts/build-email-templates.mjs';
import { EMAIL_FOOTER_TEXT, escapeHtml, renderEmailHtml, renderEmailText } from './email-layout.mjs';

/**
 * sha256 of each GoTrue template as scripts/build-email-templates.mjs rendered
 * it for https://elprofessor.eu before its layout moved into email-layout.mjs
 * (origin/staging f191575). The move had to change none of them, and diffing
 * the generated files for both origins showed it did not. A deliberate change
 * to these templates updates the hashes in the same commit.
 *
 * Line endings are normalized first, so a Windows checkout with autocrlf does
 * not fail on bytes the build on Linux never produces.
 */
const BEFORE_THE_MOVE: Record<string, string> = {
  'invite.html': '835b2b53345dde82d962ec6a92ef6877a53590c9892de55187892ec91e4e8187',
  'recovery.html': 'ef91056c75dc7f14a258efd25781c99cee82f931c3ee752894b2cd27a287b7f7',
  'confirmation.html': 'dd1f23c40a1af00be4392408adcc151635d1a996572a44efff21e1adfd3b3db6',
  'email-change.html': '3e0ec026a56bb72a6dfc69d49a95e44075166da82882496008a684e71f79c837',
  'magic-link.html': '3a3acf89ff36046c0afca4329fc30cd7562504f0092b6f502e06306d8a690db9',
};

const LOGO = 'https://elprofessor.eu/email-templates/logo.png';
const render = (file: string): string => renderGoTrueTemplate(TEMPLATES[file], LOGO);

describe('GoTrue templates', () => {
  it('are the five the build writes', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(Object.keys(BEFORE_THE_MOVE).sort());
  });

  it.each(Object.keys(BEFORE_THE_MOVE))('%s is byte for byte what the build produced before the move', (file) => {
    const html = render(file).replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(html, 'utf8').digest('hex')).toBe(BEFORE_THE_MOVE[file]);
  });

  it.each(Object.keys(BEFORE_THE_MOVE))('%s passes the template-action allow-list', (file) => {
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
      codeCaption: 'Der Code ist 10 Minuten gültig.',
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
