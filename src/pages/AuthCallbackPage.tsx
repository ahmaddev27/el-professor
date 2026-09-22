import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { supabase, authRedirect } from '../lib/supabase';
import { useTranslation } from '../contexts/LanguageContext';
import { consumeGoogleSignInIntent, readGoogleSignInIntent } from '../lib/googleSignIn';
import { callbackFailureView } from '../lib/oauthErrors';
import AuthShell from '../components/auth/AuthShell';
import { Button } from '../components/ui';

type CallbackType = 'recovery' | 'invite' | 'signup' | 'magiclink' | 'email_change' | string;

/**
 * `/auth/callback`: where every mail link and, since plan 1.6, every Google
 * sign-in comes back to.
 *
 * A failure arrives as `error`, `error_code` and `error_description` in the
 * fragment. `lib/oauthErrors` turns the codes into a sentence in both
 * languages; the English description GoTrue writes is never shown. The choice
 * of buttons follows from where the failure came from: a mail link can be
 * requested again, a Google sign-in is simply started again from the sign-in
 * screen.
 */
const AuthCallbackPage: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const [fromGoogle, setFromGoogle] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Captured in lib/supabase before supabase-js consumed the URL: by now the
    // hash that carried these is already gone.
    const hashError = authRedirect.error;
    const type: CallbackType = authRedirect.type;
    // Peeked, not consumed: a Google sign-in that worked is settled by
    // AuthContext, which needs the marker to recognise this session.
    //
    // The marker alone. An `error_code` in the fragment says nothing about
    // where the failure came from: GoTrue sends `otp_expired` for a dead
    // recovery or invite link too, and reading that as a Google attempt
    // retitled the card and hid "Neuen Link anfordern", which is the only way
    // out of an expired link. Those link paths are legacy — the app issues
    // one-time codes — but the wrong answer was unconditional.
    const googleAttempt = readGoogleSignInIntent() !== null;

    if (hashError) {
      const view = callbackFailureView({
        error: authRedirect.errorFamily,
        errorCode: authRedirect.errorCode,
        description: hashError,
        fromGoogle: googleAttempt,
      });
      setFromGoogle(view.googleTitle);
      setError(t(view.messageKey));
      // This attempt is over; a retry starts a new one.
      consumeGoogleSignInIntent();
      return;
    }

    const go = async () => {
      try {
        // supabase-js with detectSessionInUrl:true consumes the token automatically.
        // Poll for session to establish.
        for (let i = 0; i < 30; i++) {
          if (cancelled) return;
          const { data } = await supabase.auth.getSession();
          if (data.session) {
            if (cancelled) return;

            if (type === 'recovery' || type === 'invite') {
              navigate('/auth/set-password', { replace: true });
            } else {
              navigate('/', { replace: true });
            }
            return;
          }
          await new Promise((r) => setTimeout(r, 150));
        }

        if (!cancelled) {
          // Session never appeared
          setFromGoogle(googleAttempt);
          if (googleAttempt) {
            consumeGoogleSignInIntent();
            setError(t('auth.google.error.generic'));
          } else if (type === 'recovery' || type === 'invite') {
            setError(t('signup.callback.linkInvalid'));
          } else {
            setError(t('signup.callback.sessionFailed'));
          }
        }
      } catch {
        if (!cancelled) {
          setError(t('forgot.unexpected'));
        }
      }
    };

    go();
    return () => { cancelled = true; };
  }, [navigate, t]);

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is unchanged. A failure is drawn in the signed-out frame
  // with the same two ways on: a new link only when the link came by mail, and
  // the sign-in screen, which is the main way on after a Google attempt.

  if (error) {
    return (
      <AuthShell title={fromGoogle ? t('auth.signIn') : t('signup.callback.title')}>
        <div className="grid gap-5">
          <div className="flex items-start gap-3 text-sm leading-relaxed text-fg-muted">
            <AlertCircle aria-hidden className="mt-0.5 size-5 shrink-0 text-critical" />
            <p role="alert">{error}</p>
          </div>
          <div className="grid gap-2">
            {/* A Google sign-in is restarted from the sign-in screen; there is
                no link to request again. */}
            {!fromGoogle && (
              <Button size="lg" className="w-full" onClick={() => navigate('/auth/forgot-password', { replace: true })}>
                {t('signup.callback.requestNewLink')}
              </Button>
            )}
            <Button
              size={fromGoogle ? 'lg' : 'md'}
              variant={fromGoogle ? 'primary' : 'ghost'}
              className="w-full"
              onClick={() => navigate('/login', { replace: true })}
            >
              {t('signup.callback.backToLogin')}
            </Button>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <main className="flex min-h-[calc(100dvh-var(--env-banner-height,0px))] items-center justify-center bg-canvas px-4 font-ui">
      <div role="status" className="grid justify-items-center gap-4 text-center">
        <div aria-hidden className="size-10 rounded-full border-2 border-line border-b-brand motion-safe:animate-spin" />
        <p className="text-sm text-fg-muted">{t('signup.callback.checking')}</p>
      </div>
    </main>
  );
};

export default AuthCallbackPage;
