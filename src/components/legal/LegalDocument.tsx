import {
  impressumSections,
  privacyAsOfLine,
  type Impressum,
  type PrivacyContent,
} from '../../lib/legalPages';

/**
 * The two legal documents as a reader sees them: on `/impressum` and
 * `/datenschutz`, and in the settings editor's previews, from the same
 * components, so the preview is the page.
 *
 * German in both languages — the headings and labels come from
 * `lib/legalPages.ts`, never from the dictionaries — and marked `lang="de"`, so
 * a screen reader running in English still reads them as German.
 */

const LINK_CLASS = [
  'break-all text-brand-text underline-offset-2 hover:underline',
  'rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
].join(' ');

/** Every section of an Impressum that has something in it; nothing for an unpublished one. */
export function ImpressumDocument({ impressum }: { impressum: Impressum }) {
  const sections = impressumSections(impressum);
  return (
    <div lang="de" className="space-y-6 font-ui">
      {sections.map(section => (
        <section key={section.heading} className="space-y-1.5">
          <h2 className="text-[15px] font-semibold leading-snug text-fg">{section.heading}</h2>
          <div className="space-y-0.5 text-sm leading-relaxed text-fg">
            {section.lines.map((line, index) => (
              <p key={index} className="break-words">
                {line.label ? <span className="text-fg-muted">{line.label}: </span> : null}
                {line.href ? <a className={LINK_CLASS} href={line.href}>{line.text}</a> : line.text}
              </p>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * The privacy text, paragraph by paragraph, under its date. A line break inside
 * a paragraph is kept (`whitespace-pre-line`): an address block needs one. The
 * text is plain — the database refuses anything that could be markup — and
 * React escapes it on top of that.
 */
export function PrivacyDocument({ privacy }: { privacy: PrivacyContent }) {
  return (
    <div lang="de" className="space-y-4 font-ui">
      {privacy.asOf ? <p className="text-sm text-fg-muted">{privacyAsOfLine(privacy.asOf)}</p> : null}
      {privacy.paragraphs.map((paragraph, index) => (
        <p key={index} className="whitespace-pre-line break-words text-sm leading-relaxed text-fg sm:text-[15px]">
          {paragraph}
        </p>
      ))}
    </div>
  );
}
