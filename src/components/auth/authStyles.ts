/**
 * Class names shared by the signed-out screens.
 *
 * Since phase 5 batch 4 these screens are on the design system and follow the
 * theme like every converted screen; before it they painted their own dark
 * background whatever the theme said. Fields, buttons and messages come from
 * src/components/ui — what is left here is what those primitives do not cover.
 *
 * `AuthSurface` says where a one-time-code block sits. 'dark' is the card of a
 * signed-out screen (the name is older than the theme: those screens were
 * always dark), 'app' a page inside the signed-in shell — Mein Konto, which is
 * not on the design system yet — where the buttons keep their own width
 * instead of spanning the card.
 */
export type AuthSurface = 'dark' | 'app';

/** An icon inside a field, at its left edge; the field gets `authFieldWithIconClass`. */
export const authFieldIconClass =
  'pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle';

/** Room for that icon in a design-system Input. */
export const authFieldWithIconClass = 'pl-9';

const focusRing =
  'rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/** A link inside a sentence: "Passwort vergessen?", "14 Tage kostenlos testen". */
export const authLinkClass = `font-medium text-brand-text underline-offset-4 hover:underline ${focusRing}`;

/** A quiet navigation link under a card: "Zurück zur Anmeldung". */
export const authQuietLinkClass = `inline-flex items-center gap-1.5 text-sm text-fg-muted transition-colors hover:text-fg ${focusRing}`;
