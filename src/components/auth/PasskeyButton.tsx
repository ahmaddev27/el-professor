import React, { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { passkeyMessageKey } from '../../lib/passkeyClient';
import { signInWithPasskey } from '../../lib/passkeyFlows';
import { usePasskeysEnabled } from '../../hooks/usePasskeysEnabled';
import { Button } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n';

/**
 * "Sign in with a passkey", on `/login`.
 *
 * It renders **nothing at all** until GoTrue has said passkeys are enabled
 * (`lib/authProviderSettings`, which reads `passkeys_enabled` out of
 * `GET /auth/v1/settings`). The stack pins v2.190.0 since PR #341, so the field
 * exists and is `false` while `PASSKEY_SIGNIN_ENABLED` is false — which is how
 * it ships — and on an older image, or a rollback across that upgrade, the field
 * is absent instead. Either way this returns null.
 * `PasskeyButton.render.test.ts` is the proof, and it measures the settings gate
 * with the browser capability stubbed on, so the two cannot cover for one
 * another.
 *
 * It is `GoogleButton`'s shape deliberately, down to owning its own top margin:
 * a wrapper on the screen would still occupy its spacing while this returns
 * null, and the signed-out card would move by that much with the feature off.
 *
 * Three ways it differs from the Google button, each for a reason:
 *
 *  - **No email is typed first.** GoTrue's authentication route is
 *    discoverable (`BeginDiscoverableLogin`, empty `allowCredentials`), so the
 *    authenticator offers what it holds and the server resolves the account.
 *  - **Platform staff are not refused.** `googleSignInRefusal()` exists because
 *    a third party vouches for a Google identity; nothing vouches for a passkey
 *    but the authenticator holding it. The owner's decision of 27.10.2026 is
 *    that a passkey counts as a password does — for platform admins, for
 *    companies, for everything — and `20261027140000` admits `passkey` in the
 *    database's own allow-list. Do not copy Google's refusal across.
 *  - **The browser's own capability is part of the gate.** A passkey ceremony
 *    needs `navigator.credentials`; where there is none, the button could only
 *    fail, and the password form beside it is already the answer.
 */

interface PasskeyButtonProps {
  /** Shows the "or" rule above the button. */
  divider?: boolean;
  /** Where the screen shows a refusal. */
  onError?: (message: TranslationKey) => void;
}

const PasskeyButton: React.FC<PasskeyButtonProps> = ({ divider = false, onError }) => {
  const { t } = useTranslation();
  const enabled = usePasskeysEnabled();
  const [busy, setBusy] = useState(false);

  if (!enabled) return null;

  const press = async () => {
    setBusy(true);
    const result = await signInWithPasskey();
    if (!result.ok) {
      setBusy(false);
      onError?.(passkeyMessageKey(result.failure));
      return;
    }
    // The session is installed. AuthContext's listener swaps the public router
    // for the authenticated one and SignInRoute decides where it lands, so
    // there is deliberately no navigate() here — one issued across that swap
    // lands in the router being unmounted. The button stays busy until then.
  };

  // ── Presentation ──────────────────────────────────────────────────────────
  return (
    <div className="mt-5 space-y-4 font-ui">
      {divider && (
        <div className="flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-line" />
          <span className="text-xs text-fg-subtle">{t('auth.google.or')}</span>
          <span className="h-px flex-1 bg-line" />
        </div>
      )}
      <Button
        type="button"
        variant="secondary"
        size="lg"
        onClick={() => { void press(); }}
        disabled={busy}
        loading={busy}
        className="w-full"
      >
        {!busy && <KeyRound aria-hidden />}
        {busy ? t('passkey.signIn.busy') : t('passkey.signIn.label')}
      </Button>
    </div>
  );
};

export default PasskeyButton;
