import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, Eye, EyeOff, AlertCircle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useTranslation } from '../contexts/LanguageContext';
import { ADMIN_LOGIN_PATH } from '../lib/adminGate';
import EmphasizedText from '../components/auth/EmphasizedText';

const MIN_LEN = 8;

const SetPasswordPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [email, setEmail] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  /**
   * `user_profiles.is_super_admin`, which routes the browser and grants
   * nothing. Read here for one reason: since 20260919130000 a platform
   * capability requires a session GoTrue established with a password, and this
   * page is only ever reached with one that it did not — an `invite_activate`
   * or `password_reset` code, which `POST /auth/v1/verify` mints with
   * `amr: [{method: "otp"}]`. So a platform account that has just chosen a
   * password is signed out here and sent to `/admin/login` to use it, rather
   * than landing on the panel's "no platform role" screen, which would be the
   * wrong sentence. A company user keeps its session and goes to its own app.
   */
  const [isPlatformAccount, setIsPlatformAccount] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      if (data.session) {
        setHasSession(true);
        setEmail(data.session.user.email ?? '');
        try {
          const { data: profile } = await supabase
            .from('user_profiles')
            .select('status, is_super_admin')
            .eq('user_id', data.session.user.id)
            .maybeSingle();
          if (mounted) {
            setStatus(profile?.status ?? '');
            setIsPlatformAccount(profile?.is_super_admin === true);
          }
        } catch {
          /* ignore */
        }
      }
      if (mounted) setCheckingSession(false);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const isInvite = status === 'pending_invite';
  const title = isInvite ? t('setpw.welcomeTitle') : t('setpw.newTitle');
  const subtitle = isInvite
    ? t('setpw.welcomeSub')
    : t('setpw.newSub');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.length < MIN_LEN) {
      setError(t('setpw.minLength', { n: MIN_LEN }));
      return;
    }
    if (password !== confirm) {
      setError(t('setpw.mismatch'));
      return;
    }

    setLoading(true);
    try {
      const { error: updErr } = await supabase.auth.updateUser({ password });
      if (updErr) {
        setError(t('setpw.saveFailed'));
        return;
      }

      if (isInvite) {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          await supabase
            .from('user_profiles')
            .update({ status: 'active', activated_at: new Date().toISOString(), must_change_password: false })
            .eq('user_id', user.id);
        }
      } else {
        // Clear must_change_password flag for temp-password users.
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          await supabase
            .from('user_profiles')
            .update({ must_change_password: false })
            .eq('user_id', user.id);
        }
      }

      setSuccess(true);

      if (isPlatformAccount) {
        /*
          The session in hand was minted by a one-time code, so it holds no
          platform capability (20260919130000). Ending it is what turns the
          password just chosen into a usable sign-in.

          The address is rewritten *before* signOut, not navigated to after it:
          signing out swaps App's authenticated router for the public one, and a
          navigate() issued around that swap can land in the router being
          unmounted. Same reason as useOtpSessionHandoff.
        */
        setTimeout(() => {
          window.history.replaceState(window.history.state, '', ADMIN_LOGIN_PATH);
          void supabase.auth.signOut({ scope: 'local' });
        }, 1600);
        return;
      }

      setTimeout(() => navigate('/', { replace: true }), 1200);
    } catch {
      setError(t('forgot.unexpected'));
    } finally {
      setLoading(false);
    }
  };

  if (checkingSession) {
    return (
      <div className="min-h-screen bg-[#060a0f] flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-cyan-400" />
      </div>
    );
  }

  if (!hasSession) {
    return (
      <div className="min-h-screen bg-[#060a0f] flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-white/4 backdrop-blur-xl border border-white/10 rounded-2xl p-7 text-center">
          <div className="w-12 h-12 rounded-full bg-red-500/15 border border-red-500/30 flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="text-red-400" size={22} />
          </div>
          <h2 className="text-white font-semibold mb-2">{t('setpw.sessionExpired')}</h2>
          <p className="text-white/60 text-sm mb-6">
            {t('setpw.noSessionBody')}
          </p>
          <button
            onClick={() => navigate('/auth/forgot-password', { replace: true })}
            className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-3 px-4 rounded-xl font-semibold text-sm"
          >
            {t('setpw.requestNewCode')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#060a0f] flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(6,182,212,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(6,182,212,0.03)_1px,transparent_1px)] bg-[size:48px_48px]" />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-cyan-600/5 rounded-full blur-[120px] pointer-events-none" />

      <div className="relative w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center">
            <img src="/professor_logo_white.svg" alt="El-Professor" className="w-16 h-16 object-contain drop-shadow-[0_0_16px_rgba(6,182,212,0.5)]" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">{title}</h1>
          <p className="text-white/40 text-sm">{subtitle}</p>
          {email && (
            <p className="text-white/60 text-xs mt-3 break-words">
              <EmphasizedText template={t('setpw.forEmail')} placeholder="email" value={email} className="text-cyan-300" />
            </p>
          )}
        </div>

        <div className="bg-white/4 backdrop-blur-xl border border-white/10 rounded-2xl p-7 shadow-[0_24px_64px_rgba(0,0,0,0.5)]">
          {success ? (
            <div className="text-center" role="status">
              <div className="w-12 h-12 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="text-emerald-400" size={22} />
              </div>
              <h2 className="text-white font-semibold mb-2">{t('setpw.saved')}</h2>
              <p className="text-white/60 text-sm">
                {isPlatformAccount ? t('setpw.platformSignInAgain') : t('setpw.redirecting')}
              </p>
            </div>
          ) : (
            <>
              {error && (
                <div role="alert" className="mb-5 p-3.5 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-2.5">
                  <AlertCircle className="text-red-400 flex-shrink-0" size={16} />
                  <span className="text-red-300 text-sm">{error}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="set-password-new" className="block text-xs font-semibold text-white/40 uppercase tracking-wider mb-2">
                    {t('setpw.newPasswordLabel')}
                  </label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} />
                    <input
                      id="set-password-new"
                      type={show ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full pl-10 pr-12 py-3 bg-white/5 border border-white/10 text-white placeholder-white/20 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/40 transition-all text-sm"
                      placeholder={t('setpw.minChars')}
                      autoComplete="new-password"
                      required
                      minLength={MIN_LEN}
                    />
                    <button
                      type="button"
                      onClick={() => setShow(!show)}
                      aria-label={show ? t('auth.hidePassword') : t('auth.showPassword')}
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/60"
                    >
                      {show ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>

                <div>
                  <label htmlFor="set-password-confirm" className="block text-xs font-semibold text-white/40 uppercase tracking-wider mb-2">
                    {t('setpw.confirmLabel')}
                  </label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} />
                    <input
                      id="set-password-confirm"
                      type={show ? 'text' : 'password'}
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      className="w-full pl-10 pr-4 py-3 bg-white/5 border border-white/10 text-white placeholder-white/20 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/40 transition-all text-sm"
                      placeholder={t('setpw.repeat')}
                      autoComplete="new-password"
                      required
                      minLength={MIN_LEN}
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading || !password || !confirm}
                  className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-3 px-4 rounded-xl font-semibold text-sm hover:shadow-[0_4px_24px_rgba(6,182,212,0.4)] hover:-translate-y-0.5 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 flex items-center justify-center gap-2 mt-2"
                >
                  {loading ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                  ) : (
                    <>
                      <ShieldCheck size={15} />
                      <span>{isInvite ? t('setpw.activate') : t('setpw.save')}</span>
                    </>
                  )}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SetPasswordPage;
