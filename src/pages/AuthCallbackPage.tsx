import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';

type CallbackType = 'recovery' | 'invite' | 'signup' | 'magiclink' | 'email_change' | string;

const AuthCallbackPage: React.FC = () => {
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    // Parse type from hash or query string
    const hash = window.location.hash || '';
    const search = window.location.search || '';

    const hashParams = new URLSearchParams(
      hash.startsWith('#') ? hash.slice(1) : ''
    );
    const queryParams = new URLSearchParams(
      search.startsWith('?') ? search.slice(1) : ''
    );

    const getParam = (key: string) =>
      hashParams.get(key) || queryParams.get(key);

    const hashError = getParam('error') || getParam('error_description');
    const type: CallbackType = getParam('type') ?? '';

    if (hashError) {
      const decodedError = decodeURIComponent(hashError);
      if (decodedError.toLowerCase().includes('expired')) {
        setError('Der Link ist abgelaufen. Bitte fordern Sie einen neuen Link an.');
      } else {
        setError('Der Link ist ungültig oder abgelaufen. Bitte fordern Sie einen neuen Link an.');
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
            setError('Der Link ist ungültig oder abgelaufen. Bitte fordern Sie einen neuen Link an.');
          } else {
            setError('Die Sitzung konnte nicht hergestellt werden. Bitte versuchen Sie es erneut.');
          }
        }
      } catch {
        if (!cancelled) {
          setError('Ein unerwarteter Fehler ist aufgetreten. Bitte versuchen Sie es erneut.');
        }
      }
    };

    go();
    return () => { cancelled = true; };
  }, [navigate]);

  return (
    <div className="min-h-screen bg-[#060a0f] flex items-center justify-center p-4">
      <div className="relative w-full max-w-sm text-center">
        {error ? (
          <div className="bg-white/4 backdrop-blur-xl border border-white/10 rounded-2xl p-7">
            <div className="w-12 h-12 rounded-full bg-red-500/15 border border-red-500/30 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="text-red-400" size={22} />
            </div>
            <h2 className="text-white font-semibold mb-2">Link ungültig</h2>
            <p className="text-white/60 text-sm leading-relaxed mb-6">{error}</p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => navigate('/auth/forgot-password', { replace: true })}
                className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-3 px-4 rounded-xl font-semibold text-sm"
              >
                Neuen Link anfordern
              </button>
              <button
                onClick={() => navigate('/login', { replace: true })}
                className="w-full text-white/50 hover:text-white/80 text-sm py-2 transition-colors"
              >
                Zurück zur Anmeldung
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-cyan-400 mx-auto mb-4" />
            <p className="text-white/50 text-sm">Link wird überprüft...</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default AuthCallbackPage;
