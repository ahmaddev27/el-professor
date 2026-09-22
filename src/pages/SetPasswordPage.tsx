import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, Eye, EyeOff, AlertCircle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import { SIGN_IN_PATH } from '../lib/adminGate';
import EmphasizedText from '../components/auth/EmphasizedText';
import AuthShell from '../components/auth/AuthShell';
import { authFieldIconClass, authFieldWithIconClass } from '../components/auth/authStyles';
import { Alert, Button, Field, Input, cn } from '../components/ui';

const MIN_LEN = 8;

const SetPasswordPage: React.FC = () => {
  const { t } = useTranslation();
  const { setAuthNotice, clearAuthNotice } = useAuth();
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

          It also leaves a sentence behind. Since 17.09.2026 there is one
          sign-in screen, and it is the company card — it says nothing about
          the platform, so without this the account arrives at a generic form
          with no idea why it was signed out of a password it had just set. The
          notice lives above App and outside clearSessionData, so it survives
          the sign-out and the router swap; `stayPut` takes it back, because a
          session that is still on screen must not leave a message waiting on
          the next sign-in screen anyone opens.
        */
        const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        const stayPut = () => {
          setSignOutPending(false);
          clearAuthNotice();
          window.history.replaceState(window.history.state, '', here);
          navigate('/', { replace: true });
        };
        setTimeout(() => {
          setAuthNotice('auth.notice.platformPasswordSignIn');
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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is unchanged. The three states are the ones the page drew
  // before — checking the session, no session, the form (then its success) —
  // on the design system. The two password fields stay in that order, new
  // password first, which is how the e2e suite fills them.

  if (checkingSession) {
    return (
      <main className="flex min-h-[calc(100dvh-var(--env-banner-height,0px))] items-center justify-center bg-canvas font-ui">
        <div aria-hidden className="size-10 rounded-full border-2 border-line border-b-brand motion-safe:animate-spin" />
      </main>
    );
  }

  if (!hasSession) {
    return (
      <AuthShell title={t('setpw.sessionExpired')}>
        <div className="grid gap-5">
          <div className="flex items-start gap-3 text-sm leading-relaxed text-fg-muted">
            <AlertCircle aria-hidden className="mt-0.5 size-5 shrink-0 text-critical" />
            <p>{t('setpw.noSessionBody')}</p>
          </div>
          <Button size="lg" className="w-full" onClick={() => navigate('/auth/forgot-password', { replace: true })}>
            {t('setpw.requestNewCode')}
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={title}
      subtitle={
        <>
          {subtitle}
          {email && (
            <span className="mt-2 block break-words text-xs">
              <EmphasizedText template={t('setpw.forEmail')} placeholder="email" value={email} className="font-medium text-fg" />
            </span>
          )}
        </>
      }
    >
      {success ? (
        <div className="text-center" role="status">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-positive-soft text-positive">
            <CheckCircle2 aria-hidden className="size-6" />
          </div>
          <h2 className="mb-2 font-semibold">{t('setpw.saved')}</h2>
          <p className="text-sm text-fg-muted">
            {signOutPending ? t('setpw.platformSignInAgain') : t('setpw.redirecting')}
          </p>
        </div>
      ) : (
        <>
          {error && <Alert tone="critical" className="mb-5" title={error} />}

          <form onSubmit={handleSubmit} className="grid gap-4">
            <Field label={t('setpw.newPasswordLabel')} id="set-password-new">
              <div className="relative">
                <Lock aria-hidden className={authFieldIconClass} />
                <Input
                  id="set-password-new"
                  type={show ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={cn(authFieldWithIconClass, 'pr-11')}
                  placeholder={t('setpw.minChars')}
                  autoComplete="new-password"
                  required
                  minLength={MIN_LEN}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShow(!show)}
                  aria-label={show ? t('auth.hidePassword') : t('auth.showPassword')}
                  className="absolute right-0.5 top-1/2 -translate-y-1/2"
                >
                  {show ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                </Button>
              </div>
            </Field>

            <Field label={t('setpw.confirmLabel')} id="set-password-confirm">
              <div className="relative">
                <Lock aria-hidden className={authFieldIconClass} />
                <Input
                  id="set-password-confirm"
                  type={show ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className={authFieldWithIconClass}
                  placeholder={t('setpw.repeat')}
                  autoComplete="new-password"
                  required
                  minLength={MIN_LEN}
                />
              </div>
            </Field>

            <Button type="submit" size="lg" disabled={loading || !password || !confirm} loading={loading} className="mt-1 w-full">
              {!loading && <ShieldCheck aria-hidden />}
              <span>{isInvite ? t('setpw.activate') : t('setpw.save')}</span>
            </Button>
          </form>
        </>
      )}
    </AuthShell>
  );
};

export default SetPasswordPage;
