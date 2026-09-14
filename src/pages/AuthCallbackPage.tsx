import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { supabase, authRedirect } from '../lib/supabase';
import { useTranslation } from '../contexts/LanguageContext';

type CallbackType = 'recovery' | 'invite' | 'signup' | 'magiclink' | 'email_change' | string;

const AuthCallbackPage: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    // Captured in lib/supabase before supabase-js consumed the URL: by now the
    // hash that carried these is already gone.
    const hashError = authRedirect.error;
    const type: CallbackType = authRedirect.type;

    if (hashError) {
      if (hashError.toLowerCase().includes('expired')) {
        setError(t('signup.callback.linkExpired'));
      } else {
        setError(t('signup.callback.linkInvalid'));
      }
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
          if (type === 'recovery' || type === 'invite') {
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
            <h2 className="text-white font-semibold mb-2">{t('signup.callback.title')}</h2>
            <p className="text-white/60 text-sm leading-relaxed mb-6">{error}</p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => navigate('/auth/forgot-password', { replace: true })}
                className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-3 px-4 rounded-xl font-semibold text-sm"
              >
                {t('signup.callback.requestNewLink')}
              </button>
              <button
                onClick={() => navigate('/login', { replace: true })}
                className="w-full text-white/50 hover:text-white/80 text-sm py-2 transition-colors"
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
