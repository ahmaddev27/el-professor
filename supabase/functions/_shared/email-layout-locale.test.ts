import { describe, expect, it } from 'vitest';
import { EMAIL_FOOTER_TEXT, renderEmailHtml, renderEmailText } from './email-layout.mjs';

/**
 * The language, direction and footer options are opt-in. These pin that a mail
 * passing none of them gets the document it always got; the five GoTrue
 * templates' sha256 pins in `email-layout.test.ts` are the byte-level proof.
 */
const content = {
  logoUrl: 'https://x.test/logo.png',
  eyebrow: 'E',
  heading: 'H',
  preheader: 'P',
  bodyHtml: '<b>b</b>',
  noteHtml: 'n',
};

describe('renderEmailHtml locale options', () => {
  it('without options: German, left-to-right, the German footer', () => {
    const html = renderEmailHtml(content);
    expect(html).toContain('<html lang="de" xmlns="http://www.w3.org/1999/xhtml">');
    expect(html).not.toContain('dir=');
    expect(html).toContain(`${EMAIL_FOOTER_TEXT.split('\n')[0]}<br>\n      ${EMAIL_FOOTER_TEXT.split('\n')[1]}\n`);
  });

  it('is identical when the defaults are passed explicitly', () => {
    expect(renderEmailHtml({ ...content, lang: 'de', dir: 'ltr', footer: EMAIL_FOOTER_TEXT.split('\n') as [string, string] }))
      .toBe(renderEmailHtml(content));
  });

  it('rtl stamps dir on html, body, the outer table and the card and nowhere else', () => {
    const html = renderEmailHtml({ ...content, lang: 'ar', dir: 'rtl' });
    expect(html.match(/ dir="rtl"/g)).toHaveLength(4);
    expect(html).toContain('<html lang="ar" dir="rtl"');
  });

  it('escapes a footer and a language', () => {
    const html = renderEmailHtml({ ...content, lang: 'a"b', footer: ['<x>', '&'] });
    expect(html).toContain('lang="a&quot;b"');
    expect(html).toContain('&lt;x&gt;<br>');
  });
});

describe('renderEmailText footer', () => {
  it('defaults to the German footer and can be replaced', () => {
    const base = { heading: 'H', bodyText: 'b', noteText: 'n' };
    expect(renderEmailText(base)).toContain(EMAIL_FOOTER_TEXT);
    expect(renderEmailText({ ...base, footer: ['one', 'two'] })).toContain('-- \none\ntwo\n');
  });
});
