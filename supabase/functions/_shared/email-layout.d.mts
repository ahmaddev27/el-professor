// Types for email-layout.mjs. The module is plain JavaScript so the Node build
// script can import it without a TypeScript step; Deno picks these declarations
// up through the @ts-self-types directive at the top of that file.

export interface EmailCta {
  label: string;
  /** An absolute http(s) URL, or GoTrue's `{{ .ConfirmationURL }}`. */
  href: string;
  /** Repeat the target as a plain link under the button. */
  fallbackLink?: boolean;
}

export interface EmailLink {
  label: string;
  href: string;
}

export interface EmailHtmlContent {
  /** Absolute URL of logo.png for the environment the mail is sent from. */
  logoUrl: string;
  eyebrow: string;
  heading: string;
  preheader: string;
  /** Trusted markup: escape every interpolated value with escapeHtml or emphasis. */
  bodyHtml: string;
  /** Exactly six digits, or the render throws. */
  code?: string;
  codeCaption?: string;
  cta?: EmailCta;
  /** A plain text link below the body, for mails without a button. */
  link?: EmailLink;
  /** Trusted markup, like bodyHtml. */
  noteHtml: string;
}

export interface EmailTextContent {
  heading: string;
  bodyText: string;
  code?: string;
  codeCaption?: string;
  link?: EmailLink;
  noteText: string;
}

export declare const EMAIL_FONT: string;
export declare const EMAIL_COLORS: Readonly<{
  canvas: string;
  card: string;
  border: string;
  ink: string;
  body: string;
  muted: string;
  link: string;
}>;
export declare const EMAIL_FOOTER_TEXT: string;
export declare function escapeHtml(value: string): string;
export declare function emphasis(text: string): string;
export declare function renderEmailHtml(content: EmailHtmlContent): string;
export declare function renderEmailText(content: EmailTextContent): string;
