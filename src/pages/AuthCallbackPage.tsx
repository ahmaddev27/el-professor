import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { supabase, authRedirect } from '../lib/supabase';
import { useTranslation } from '../contexts/LanguageContext';
import { consumeGoogleSignInIntent, readGoogleSignInIntent } from '../lib/googleSignIn';
import { callbackFailureView } from '../lib/oauthErrors';

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

  return (
    <div className="min-h-screen bg-[#060a0f] flex items-center justify-center p-4">
      <div className="relative w-full max-w-sm text-center">
        {error ? (
          <div className="bg-white/4 backdrop-blur-xl border border-white/10 rounded-2xl p-7">
            <div className="w-12 h-12 rounded-full bg-red-500/15 border border-red-500/30 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="text-red-400" size={22} />
            </div>
            <h2 className="text-white font-semibold mb-2">
              {fromGoogle ? t('auth.signIn') : t('signup.callback.title')}
            </h2>
            <p className="text-white/60 text-sm leading-relaxed mb-6">{error}</p>
            <div className="flex flex-col gap-2">
              {/* A Google sign-in is restarted from the sign-in screen; there is
                  no link to request again. */}
              {!fromGoogle && (
                <button
                  onClick={() => navigate('/auth/forgot-password', { replace: true })}
                  className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-3 px-4 rounded-xl font-semibold text-sm"
                >
                  {t('signup.callback.requestNewLink')}
                </button>
              )}
              <button
                onClick={() => navigate('/login', { replace: true })}
                className={fromGoogle
                  ? 'w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-3 px-4 rounded-xl font-semibold text-sm'
                  : 'w-full text-white/50 hover:text-white/80 text-sm py-2 transition-colors'}
              >
                {t('signup.callback.backToLogin')}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-cyan-400 mx-auto mb-4" />
            <p className="text-white/50 text-sm">{t('signup.callback.checking')}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default AuthCallbackPage;
