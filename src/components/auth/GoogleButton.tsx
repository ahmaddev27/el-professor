import React, { useEffect, useState } from 'react';
import { loadAuthProviderSettings } from '../../lib/authProviderSettings';
import {
  startGoogleSignIn,
  type GoogleSignInOrigin,
  type GoogleSignInSelection,
} from '../../lib/googleSignIn';
import { useTranslation } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n';

/**
 * The "sign in with Google" button (plan step 1.6).
 *
 * It renders **nothing at all** until GoTrue has said the provider is enabled
 * (`lib/authProviderSettings`). While `GOOGLE_SIGNIN_ENABLED` is false — which
 * is how this pull request ships — every screen below looks exactly as it does
 * today, its hint included.
 *
 * No Google script or asset is loaded either: the mark is inline SVG and the
 * redirect happens only on a press, so the signed-out screens still make no
 * third-party request and need no consent banner for this.
 */

interface GoogleButtonProps {
  /** Which screen this is, for the one-time marker the callback reads back. */
  from: GoogleSignInOrigin;
  /** The button's own wording; the screens differ ("sign in" vs "sign up"). */
  labelKey: TranslationKey;
  /** A sentence under the button, shown only when the button itself is. */
  hintKey?: TranslationKey;
  /** What a visitor had already chosen on the signup screen, if anything. */
  selection?: GoogleSignInSelection | null;
  /** Shows the "or" rule above the button. */
  divider?: boolean;
  /** Where the screen shows a failure to start the redirect. */
  onError?: (message: TranslationKey) => void;
}

/** Google's mark, inline so the signed-out screens load nothing from Google. */
const GoogleMark: React.FC = () => (
  <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24s.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

const GoogleButton: React.FC<GoogleButtonProps> = ({
  from,
  labelKey,
  hintKey,
  selection = null,
  divider = false,
  onError,
}) => {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadAuthProviderSettings().then(settings => {
      if (!cancelled) setEnabled(settings.google);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!enabled) return null;

  const press = async () => {
    setStarting(true);
    const result = await startGoogleSignIn(from, { selection });
    if (!result.ok) {
      setStarting(false);
      onError?.(result.message);
    }
    // On success the browser is already on its way to Google; leaving the
    // button disabled keeps a second press from starting a second flow.
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is unchanged: nothing renders until GoTrue reports the
  // provider, and a press starts one flow. The rule and the hint below follow
  // the design tokens. The button itself keeps Google's own colours, not ours:
  // Google's branding guidelines allow its light theme (fill #FFFFFF, border
  // #747775, text #1F1F1F) and its dark theme (#131314, #8E918F, #E3E3E3) and
  // nothing else, and the mark's four colours may not change at all. Those are
  // the colours the style ratchet still counts in this file.

  // The spacing above the button belongs here, not to a wrapper on the screens:
  // a wrapper still occupies its margin while this returns null, which would
  // move every signed-out screen by 20 px with the provider switched off.
  return (
    <div className="mt-5 space-y-4 font-ui">
      {divider && (
        <div className="flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-line" />
          <span className="text-xs text-fg-subtle">{t('auth.google.or')}</span>
          <span className="h-px flex-1 bg-line" />
        </div>
      )}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => { void press(); }}
          disabled={starting}
          className="flex h-11 w-full items-center justify-center gap-2.5 rounded-control border border-[#747775] bg-[#FFFFFF] px-4 text-sm font-semibold text-[#1F1F1F] transition-[filter] hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#8E918F] dark:bg-[#131314] dark:text-[#E3E3E3] dark:hover:brightness-125 [@media(pointer:coarse)]:h-12"
        >
          <GoogleMark />
          <span>{starting ? t('auth.google.starting') : t(labelKey)}</span>
        </button>
        {hintKey && <p className="text-center text-xs leading-relaxed text-fg-subtle">{t(hintKey)}</p>}
      </div>
    </div>
  );
};

export default GoogleButton;
