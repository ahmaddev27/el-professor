import React, { useEffect, useState } from 'react';
import { User, Mail, Lock, Eye, EyeOff, AlertCircle, CheckCircle2, Building2, ShieldCheck, KeyRound } from 'lucide-react';
import { Alert, Button, Card, Input, PageHeader } from '../components/ui';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import {
  formatOtpMessage,
  isPlausibleEmail,
  normalizeEmail,
  otpMessage,
  requestOtp,
  type OtpRequestFailure,
  type OtpVerifyFailure,
} from '../lib/otpClient';
import { changePlatformEmail, platformEmailChangeMessageKey } from '../lib/platformEmailChange';
import { proveWithPasskey, proveWithPassword, type ReauthProof } from '../lib/reauthProof';
import { usePasskeysEnabled } from '../hooks/usePasskeysEnabled';
import EmphasizedText from '../components/auth/EmphasizedText';
import OtpChallenge from '../components/auth/OtpChallenge';
import PasskeyCard from '../components/account/PasskeyCard';

const MIN_LEN = 8;

/** A code went to the new address; the change happens once it is entered. */
type EmailChallenge = { newEmail: string; accessToken: string; cooldownSeconds: number };

/**
 * The signed-in user's own account: display name, email address, password.
 *
 * Reachable by every authenticated principal, the platform super admin
 * included — PlatformAccountGuard lets this one path through precisely because
 * it shows no tenant data, only the caller's own record.
 *
 * Both sensitive changes re-authenticate first, because an unattended
 * signed-in browser must not be enough to take the account over:
 *
 * - Password: `supabase.auth.updateUser()` accepts a new password on the
 *   strength of the session alone, so the current password is verified with a
 *   sign-in call before the update is sent.
 * - Email address: the same sign-in is the password proof the server demands
 *   (at most ten minutes old, read from the token's `amr` claim). The trigger
 *   sync_user_profile_email keeps user_profiles.email in step with auth.users.
 *
 * The email address takes one of two paths, and the sign-in above is the same
 * in both:
 *
 * - **A company user** gets a code at the new address and the change happens
 *   when it is entered (otp-request / otp-verify, unchanged).
 * - **A platform account** changes it at once (the owner's decision of
 *   17.09.2026: the code goes to the new mailbox, which the owner could not
 *   read). `platform-staff/email-change` re-checks on the server that the
 *   account really is platform staff and that the password proof behind the
 *   token is fresh, so the branch below chooses a form, never a permission.
 */
const AccountPage: React.FC = () => {
  const { t, tPlural } = useTranslation();
  const { user, profile, isSuperAdmin } = useAuth();
  const passkeysOn = usePasskeysEnabled();

  const [companyName, setCompanyName] = useState<string | null>(null);

  const [fullName, setFullName] = useState('');
  const [nameBusy, setNameBusy] = useState(false);
  const [nameMsg, setNameMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [email, setEmail] = useState('');
  const [emailPw, setEmailPw] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [emailChallenge, setEmailChallenge] = useState<EmailChallenge | null>(null);

  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Keyed on the values rather than the objects: each re-authenticating sign-in
  // below reloads the profile, and resetting the fields on every reload wiped
  // whatever was being typed.
  useEffect(() => {
    setFullName(profile?.full_name ?? '');
  }, [profile?.full_name]);

  useEffect(() => {
    setEmail(profile?.email ?? user?.email ?? '');
  }, [profile?.email, user?.email]);

  useEffect(() => {
    if (!profile?.company_id) { setCompanyName(null); return; }
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from('companies').select('name').eq('id', profile.company_id).maybeSingle();
      if (alive) setCompanyName(data?.name ?? null);
    })();
    return () => { alive = false; };
  }, [profile?.company_id]);

  // The address the account signs in with. auth.users is the authority; the
  // profile copy is only for display.
  const signInEmail = user?.email ?? profile?.email ?? '';

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    setNameMsg(null);
    const trimmed = fullName.trim();
    if (!trimmed) { setNameMsg({ ok: false, text: t('account.error.nameEmpty') }); return; }
    setNameBusy(true);
    const { error } = await supabase
      .from('user_profiles').update({ full_name: trimmed }).eq('user_id', user!.id);
    setNameBusy(false);
    setNameMsg(error
      ? { ok: false, text: error.message }
      : { ok: true, text: t('account.saved.name') });
  };

  /**
   * How the re-authentication proof is produced, and by which method.
   *
   * The call is what proves the secret to GoTrue and mints the session whose
   * `amr` claim both servers then read: otp-request for the code path, and
   * platform-staff/email-change for the direct one. It is not a browser-side
   * check — the browser only carries the resulting token.
   *
   * There are two methods now and they are interchangeable here by design. A
   * fresh passkey assertion mints a session whose single `amr` entry is stamped
   * now, by the same `AddClaimToSession` line that stamps a password one, and
   * `REAUTH_PROOF_METHODS` in otp-core.ts names both. So the 600-second window
   * is unchanged and un-relaxed; what changed is that an operator who signs in
   * with a passkey can now satisfy it. Without this the platform email change
   * was reachable only with a password — which is why this slice closes it
   * rather than leaving it to the first passkey-only operator to discover.
   */
  type Prover = () => Promise<ReauthProof>;
  const withPassword: Prover = () => proveWithPassword(signInEmail, emailPw);
  // `user!.id` is safe inside the guard below: nothing draws this page without a
  // session, and the button that uses it is drawn only when `user?.id` is set.
  const withPasskey: Prover = () => proveWithPasskey(user!.id);

  /** The address as typed, or null with the message already shown. */
  const validatedNewEmail = (): string | null => {
    const next = normalizeEmail(email);
    if (!isPlausibleEmail(next)) { setEmailMsg({ ok: false, text: t('account.error.emailInvalid') }); return null; }
    if (next === normalizeEmail(signInEmail)) { setEmailMsg({ ok: false, text: t('account.error.emailUnchanged') }); return null; }
    return next;
  };

  const requestEmailChange = async (prove: Prover) => {
    setEmailMsg(null);
    const next = validatedNewEmail();
    if (!next) return;

    setEmailBusy(true);
    const proof = await prove();
    if (!proof.ok) {
      setEmailBusy(false);
      setEmailMsg({ ok: false, text: t(proof.messageKey) });
      return;
    }
    const accessToken = proof.accessToken;

    const result = await requestOtp({ purpose: 'email_change', newEmail: next, accessToken });
    setEmailBusy(false);
    if (!result.ok) {
      const message = otpMessage(result);
      setEmailMsg({ ok: false, text: message ? formatOtpMessage(message, t, tPlural) : t('otp.error.internal') });
      return;
    }
    setEmailPw('');
    setEmailChallenge({ newEmail: next, accessToken, cooldownSeconds: result.cooldownSeconds });
  };

  /**
   * The platform account's path: no code, the change happens in the request.
   *
   * The server checks again that this account holds an active platform staff
   * row (`not_platform_account`) and that the token's password proof is fresh
   * (`reauth_required`), so nothing here is the control.
   */
  const changeEmailDirectly = async (prove: Prover) => {
    setEmailMsg(null);
    const next = validatedNewEmail();
    if (!next) return;

    setEmailBusy(true);
    const proof = await prove();
    if (!proof.ok) {
      setEmailBusy(false);
      setEmailMsg({ ok: false, text: t(proof.messageKey) });
      return;
    }
    const accessToken = proof.accessToken;

    const result = await changePlatformEmail({ newEmail: next, accessToken });
    if (!result.ok) {
      setEmailBusy(false);
      setEmailMsg({ ok: false, text: t(platformEmailChangeMessageKey(result.reason)) });
      return;
    }
    // A refreshed token carries the new address, and AuthContext's listener
    // reloads the profile the trigger has already updated.
    await supabase.auth.refreshSession();
    setEmailBusy(false);
    setEmailPw('');
    setEmailMsg({ ok: true, text: t('account.saved.email') });
  };

  const handleEmailVerified = async () => {
    // A refreshed token carries the new address, and AuthContext's listener
    // reloads the profile the trigger has already updated.
    await supabase.auth.refreshSession();
    setEmailChallenge(null);
    setEmailMsg({ ok: true, text: t('account.saved.email') });
  };

  // otp-request accepts the password proof behind the token for ten minutes
  // only, and the token is void once its session ends. Only the form can produce
  // a new one, so the code screen gives way to it and says why, instead of
  // telling the user to confirm a password on a screen that has no password field.
  const returnToEmailForm = (result: OtpRequestFailure | OtpVerifyFailure): boolean => {
    if (result.reason !== 'reauth_required' && result.reason !== 'unauthorized') return false;
    const message = otpMessage(result);
    setEmailChallenge(null);
    setEmailMsg({ ok: false, text: message ? formatOtpMessage(message, t, tPlural) : t('otp.error.internal') });
    return true;
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg(null);
    if (newPw.length < MIN_LEN) { setPwMsg({ ok: false, text: t('account.error.pwShort', { n: String(MIN_LEN) }) }); return; }
    if (newPw !== confirmPw)    { setPwMsg({ ok: false, text: t('account.error.pwMismatch') }); return; }
    if (newPw === currentPw)    { setPwMsg({ ok: false, text: t('account.error.pwSame') }); return; }

    setPwBusy(true);
    // Prove the person at the keyboard knows the current password before
    // accepting a new one. updateUser() would not ask.
    const { error: authErr } = await supabase.auth.signInWithPassword({
      email: profile?.email ?? user?.email ?? '',
      password: currentPw,
    });
    if (authErr) {
      setPwBusy(false);
      setPwMsg({ ok: false, text: t('account.error.pwCurrentWrong') });
      return;
    }

    const { error } = await supabase.auth.updateUser({ password: newPw });
    if (!error && profile?.must_change_password) {
      await supabase.from('user_profiles')
        .update({ must_change_password: false }).eq('user_id', user!.id);
    }
    setPwBusy(false);
    if (error) { setPwMsg({ ok: false, text: error.message }); return; }
    setCurrentPw(''); setNewPw(''); setConfirmPw('');
    setPwMsg({ ok: true, text: t('account.saved.password') });
  };

  // ── Presentation (phase 5)
  const Notice: React.FC<{ msg: { ok: boolean; text: string } | null }> = ({ msg }) =>
    !msg ? null : (
      <Alert
        tone={msg.ok ? 'positive' : 'critical'}
        icon={msg.ok ? CheckCircle2 : AlertCircle}
        role={msg.ok ? 'status' : 'alert'}
        className="mt-3"
      >
        {msg.text}
      </Alert>
    );

  const sectionTitle = 'flex items-center gap-2 font-ui text-base font-semibold text-fg';

  const emailHeading = (
    <h3 className={sectionTitle}>
      <Mail size={16} className="text-brand-text" aria-hidden />
      {t('account.email.heading')}
    </h3>
  );

  return (
    <div className="max-w-3xl space-y-6 font-ui">
      <PageHeader title={t('account.title')} description={t('account.subtitle')} />

      {/* Who you are — read-only facts about the account */}
      <Card className="p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-fg-subtle">
              {t('account.field.role')}
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-fg">
              <ShieldCheck size={14} className="text-brand-text" aria-hidden />
              {isSuperAdmin ? t('account.role.superAdmin') : t(`account.role.${profile?.role ?? 'viewer'}` as never)}
            </p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-xs uppercase tracking-wide text-fg-subtle">
              {t('account.field.company')}
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-fg">
              <Building2 size={14} className="text-brand-text" aria-hidden />
              {/* "No company" is a claim, so it waits for the profile and is only made for an account with none. */}
              {companyName ?? (profile && !profile.company_id ? t('account.company.none') : '…')}
            </p>
          </div>
        </div>
      </Card>

      {/* Display name */}
      <form onSubmit={saveName} className="glass-card rounded-surface p-5 text-fg">
          <h3 className={sectionTitle}>
            <User size={16} className="text-brand-text" aria-hidden />
            {t('account.name.heading')}
          </h3>
          <Input
            type="text"
            value={fullName}
            onChange={e => setFullName(e.target.value)}
            className="mt-3"
            placeholder={t('account.name.placeholder')}
            aria-label={t('account.name.heading')}
          />
          <Notice msg={nameMsg} />
          <Button type="submit" disabled={nameBusy} className="mt-4">
            {nameBusy ? t('common.saving') : t('common.save')}
          </Button>
      </form>

      {/* Email. A company user gets a code at the new address and the challenge
          below completes the change; a platform account changes it in one step. */}
      {emailChallenge ? (
        <Card className="p-5">
          {emailHeading}
          <div className="mt-3">
            <OtpChallenge
              surface="app"
              purpose="email_change"
              email={signInEmail}
              newEmail={emailChallenge.newEmail}
              accessToken={emailChallenge.accessToken}
              initialCooldownSeconds={emailChallenge.cooldownSeconds}
              hint={
                <EmphasizedText
                  template={t('account.email.codeSentTo')}
                  placeholder="email"
                  value={emailChallenge.newEmail}
                  className="font-medium text-fg"
                />
              }
              verifyLabel={t('account.email.submit')}
              onVerified={handleEmailVerified}
              onFailure={returnToEmailForm}
              onResendFailure={returnToEmailForm}
              onBack={() => setEmailChallenge(null)}
              backLabel={t('common.cancel')}
            />
          </div>
        </Card>
      ) : (
        <form
          onSubmit={e => {
            e.preventDefault();
            void (isSuperAdmin ? changeEmailDirectly : requestEmailChange)(withPassword);
          }}
          className="glass-card rounded-surface p-5 text-fg"
        >
            {emailHeading}
            <p className="mt-1 text-xs text-fg-muted">
              {isSuperAdmin ? t('account.email.platformHint') : t('account.email.hint')}
            </p>
            <div className="mt-3 space-y-3">
              <Input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                aria-label={t('account.email.heading')}
                autoComplete="email"
              />
              <Input
                type="password"
                value={emailPw}
                onChange={e => setEmailPw(e.target.value)}
                placeholder={t('account.email.currentPassword')}
                aria-label={t('account.email.currentPassword')}
                autoComplete="current-password"
                required
              />
            </div>
            <Notice msg={emailMsg} />
            <Button type="submit" disabled={emailBusy || !emailPw} className="mt-4">
              {emailBusy
                ? (isSuperAdmin ? t('common.saving') : t('otp.verifying'))
                : (isSuperAdmin ? t('account.email.changeNow') : t('account.email.sendCode'))}
            </Button>

            {/* The same change, proved with a passkey instead of the password.
                `type="button"`, so the password field's `required` does not block
                it — which is the whole point: an operator who holds no password
                they can type must still be able to move their address, and for a
                platform account that proof is the only control there is. It is
                drawn only once GoTrue reports passkeys, so this is absent on
                today's server. */}
            {passkeysOn && user?.id && (
              <div className="mt-3 font-ui">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={emailBusy}
                  onClick={() => { void (isSuperAdmin ? changeEmailDirectly : requestEmailChange)(withPasskey); }}
                >
                  <KeyRound size={16} aria-hidden />
                  {t('passkey.reauth.useInstead')}
                </Button>
                <p className="mt-1.5 text-xs text-fg-subtle">{t('passkey.reauth.hint')}</p>
              </div>
            )}
        </form>
      )}

      {/* Password */}
      <form onSubmit={savePassword} className="glass-card rounded-surface p-5 text-fg">
          <h3 className={sectionTitle}>
            <Lock size={16} className="text-brand-text" aria-hidden />
            {t('account.password.heading')}
          </h3>
          <p className="mt-1 text-xs text-fg-muted">
            {t('account.password.hint', { n: String(MIN_LEN) })}
          </p>

          <div className="mt-3 space-y-3">
            <Input
              type={showPw ? 'text' : 'password'}
              value={currentPw}
              onChange={e => setCurrentPw(e.target.value)}
              placeholder={t('account.password.current')}
              aria-label={t('account.password.current')}
              autoComplete="current-password"
            />
            <div className="relative">
              <Input
                type={showPw ? 'text' : 'password'}
                value={newPw}
                onChange={e => setNewPw(e.target.value)}
                className="pe-10"
                placeholder={t('account.password.new')}
                aria-label={t('account.password.new')}
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                className="absolute end-2 top-1/2 -translate-y-1/2 rounded-tight p-1 text-fg-subtle hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:min-w-10 [@media(pointer:coarse)]:end-0 [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center"
                aria-label={showPw ? t('account.password.hide') : t('account.password.show')}
              >
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <Input
              type={showPw ? 'text' : 'password'}
              value={confirmPw}
              onChange={e => setConfirmPw(e.target.value)}
              placeholder={t('account.password.confirm')}
              aria-label={t('account.password.confirm')}
              autoComplete="new-password"
            />
          </div>

          <Notice msg={pwMsg} />
          <Button type="submit" disabled={pwBusy} className="mt-4">
            {pwBusy ? t('common.saving') : t('account.password.submit')}
          </Button>
      </form>

      {/* Renders nothing until GoTrue reports passkeys, so this page is
          unchanged on today's server. */}
      <PasskeyCard />
    </div>
  );
};

export default AccountPage;
