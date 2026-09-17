import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, Eye, EyeOff, AlertCircle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useTranslation } from '../contexts/LanguageContext';
import { SIGN_IN_PATH } from '../lib/adminGate';
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
   * Whether **this session** must be replaced by a password sign-in before the
   * panel will work.
   *
   * Since 20260919130000 a platform capability requires a session GoTrue
   * established with a password, and a session minted from a one-time code
   * carries `amr: [{method: "otp"}]` (`POST /auth/v1/verify`, verify.go:279).
   * Such a session holds no role, so a platform account that has just chosen a
   * password is signed out here and sent to the one sign-in screen to use it,
   * rather than landing on the panel's "no platform role" screen, which would
   * say the wrong thing.
   *
   * **The question is about the session, not the account.** Keying this on
   * `user_profiles.is_super_admin` — "is this account platform staff" — would
   * sign out a colleague who arrived from a real password sign-in: an owner
   * sets a temporary password, the colleague signs in with it (`amr: password`,
   * the panel fully usable), `MustChangePasswordGuard` sends them here, and
   * they would be signed out for nothing. So the account flag only decides
   * whether the question is worth asking, and `platform_whoami()` answers it —
   * the database's own answer, so it cannot drift from the rule.
   *
   * Unanswered is not "sign out": an error leaves the session alone and the
   * page behaves as it always did. The panel's own screen still offers a
   * logout, so that path is recoverable; wrongly ending a usable session is
   * not.
   */
  const [isPlatformAccount, setIsPlatformAccount] = useState(false);
  /** The success panel says "sign in again" only once that is what will happen. */
  const [signOutPending, setSignOutPending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  /**
   * Does the session in hand hold a platform role? `platform_whoami()` is the
   * database's own answer, so this can never disagree with the server-side rule.
   * An error answers `true` — "nothing to do here" — because an unanswered
   * question is not a reason to end somebody's session.
   */
  const sessionHoldsPlatformRole = async (): Promise<boolean> => {
    try {
      const { data, error: rpcError } = await supabase.rpc('platform_whoami');
      if (rpcError) return true;
      const role = (data as { role?: unknown } | null)?.role;
      return typeof role === 'string' && role.length > 0;
    } catch {
      return true;
    }
  };

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

      if (isPlatformAccount && !(await sessionHoldsPlatformRole())) {
        setSignOutPending(true);
        /*
          The session in hand holds no platform capability — the database just
          said so — so ending it is what turns the password just chosen into a
          usable sign-in.

          The address is rewritten *before* signOut, not navigated to after it:
          signing out swaps App's authenticated router for the public one, and a
          navigate() issued around that swap can land in the router being
          unmounted. Same reason as useOtpSessionHandoff.

          If the sign-out does not happen — blocked storage, a dead network —
          the address is put back and the ordinary redirect runs, because the
          alternative is a URL saying /login while the authenticated panel is
          still on screen, with nothing to click but reload. Both failure
          shapes are handled: supabase-js resolves with an `error` for most of
          them and rejects only for the rest.
        */
        const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        const stayPut = () => {
          setSignOutPending(false);
          window.history.replaceState(window.history.state, '', here);
          navigate('/', { replace: true });
        };
        setTimeout(() => {
          window.history.replaceState(window.history.state, '', SIGN_IN_PATH);
          supabase.auth
            .signOut({ scope: 'local' })
            .then(({ error: signOutError }) => { if (signOutError) stayPut(); })
            .catch(stayPut);
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
                {signOutPending ? t('setpw.platformSignInAgain') : t('setpw.redirecting')}
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
