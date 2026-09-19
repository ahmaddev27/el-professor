import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, RefreshCw, ShieldCheck } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import { useCountdown } from '../../hooks/useCountdown';
import {
  OTP_CODE_LENGTH,
  formatOtpMessage,
  isPublicOtpPurpose,
  otpMessage,
  requestOtp,
  verifyOtp,
  type OtpPurpose,
  type OtpRequestFailure,
  type OtpRequestInput,
  type OtpVerifyFailure,
  type OtpVerifySuccess,
} from '../../lib/otpClient';
import {
  cooldownDeadline,
  failureClearsCode,
  failureNeedsNewCode,
  resendCooldownSeconds,
  resendNotice,
  type OtpNotice,
} from '../../lib/otpUi';
import EmphasizedText from './EmphasizedText';
import NoticeBox from './NoticeBox';
import OtpCodeInput from './OtpCodeInput';
import { authPrimaryButtonClass, authQuietLinkClass, authSpinnerClass, type AuthSurface } from './authStyles';

export interface OtpChallengeProps {
  purpose: OtpPurpose;
  /** The account's address. For the public purposes it is also what identifies the challenge. */
  email: string;
  /** email_change only: the address the code went to. */
  newEmail?: string;
  /** email_change and platform_login: the caller's access token. */
  accessToken?: string;
  /** Seconds the resend button waits at first — the server's cooldown after the request that sent this code. */
  initialCooldownSeconds?: number;
  initialNotice?: OtpNotice | null;
  /**
   * Receives a verified result. Returning a failure (typically `session_failed`
   * when the returned session could not be installed) shows it like an answer
   * from the server.
   */
  onVerified: (result: OtpVerifySuccess) => void | OtpVerifyFailure | Promise<void | OtpVerifyFailure>;
  /** Return true when the screen presents this failure itself. */
  onFailure?: (result: OtpVerifyFailure) => boolean | void;
  /** The same for a failed request for a new code. */
  onResendFailure?: (result: OtpRequestFailure) => boolean | void;
  onBack?: () => void;
  backLabel?: string;
  /** Replaces the "code sent to {email}" line; `null` hides it. */
  hint?: React.ReactNode | null;
  verifyLabel?: string;
  surface?: AuthSurface;
}

type Busy = 'verify' | 'resend' | null;

/**
 * Enter a one-time code, or ask for a new one.
 *
 * Submits by itself when the sixth digit arrives. A wrong code clears the boxes
 * and says how many attempts are left; a locked, expired or superseded code
 * disables verification and moves the emphasis to "new code", because nothing
 * typed into those boxes can succeed any more.
 */
const OtpChallenge: React.FC<OtpChallengeProps> = ({
  purpose,
  email,
  newEmail,
  accessToken,
  initialCooldownSeconds = 0,
  initialNotice = null,
  onVerified,
  onFailure,
  onResendFailure,
  onBack,
  backLabel,
  hint,
  verifyLabel,
  surface = 'dark',
}) => {
  const { t, tPlural } = useTranslation();
  const hintId = useId();
  const alertId = useId();

  const [code, setCode] = useState('');
  // Remounting the boxes is how focus returns to the first one after a reset.
  const [inputGeneration, setInputGeneration] = useState(0);
  const [busy, setBusyState] = useState<Busy>(null);
  const busyRef = useRef<Busy>(null);
  const [notice, setNotice] = useState<OtpNotice | null>(initialNotice);
  const [needsNewCode, setNeedsNewCode] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(
    () => cooldownDeadline(initialCooldownSeconds, Date.now()),
  );
  const secondsLeft = useCountdown(cooldownUntil);
  const resendButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (needsNewCode) resendButton.current?.focus();
  }, [needsNewCode]);

  const setBusy = (next: Busy) => {
    busyRef.current = next;
    if (mounted.current) setBusyState(next);
  };

  const resetCode = () => {
    setCode('');
    setInputGeneration(generation => generation + 1);
  };

  const showFailure = (result: OtpVerifyFailure) => {
    if (failureClearsCode(result.reason)) resetCode();
    if (failureNeedsNewCode(result.reason)) setNeedsNewCode(true);
    setInvalid(result.reason === 'invalid_code');
    if (onFailure?.(result) === true) {
      setNotice(null);
      return;
    }
    const message = otpMessage(result);
    setNotice(message ? { tone: 'error', message } : null);
  };

  const verify = async (candidate: string) => {
    if (busyRef.current !== null || needsNewCode) return;
    if (candidate.length !== OTP_CODE_LENGTH) {
      setInvalid(true);
      setNotice({ tone: 'error', message: { key: 'otp.error.invalidInput' } });
      return;
    }

    setBusy('verify');
    setNotice(null);
    setInvalid(false);
    const result = await verifyOtp({
      purpose,
      email: isPublicOtpPurpose(purpose) ? email : undefined,
      code: candidate,
      accessToken,
    });
    if (!mounted.current) return;
    if (!result.ok) {
      setBusy(null);
      showFailure(result);
      return;
    }

    const followUp = await onVerified(result);
    // A successful sign-in usually unmounts this screen on the way to the next one.
    if (!mounted.current) return;
    setBusy(null);
    if (followUp) showFailure(followUp);
  };

  const requestInput = (): OtpRequestInput => {
    if (purpose === 'email_change') return { purpose, newEmail: newEmail ?? '', accessToken: accessToken ?? '' };
    if (purpose === 'platform_login') return { purpose, accessToken: accessToken ?? '' };
    return { purpose, email };
  };

  const resend = async () => {
    if (busyRef.current !== null || secondsLeft > 0) return;
    setBusy('resend');
    setNotice(null);
    const result = await requestOtp(requestInput());
    if (!mounted.current) return;
    setBusy(null);
    setCooldownUntil(cooldownDeadline(resendCooldownSeconds(result), Date.now()));
    if (result.ok) {
      // The new code supersedes the old one on the server.
      resetCode();
      setNeedsNewCode(false);
      setInvalid(false);
    } else if (onResendFailure?.(result) === true) {
      return;
    }
    setNotice(resendNotice(purpose, result));
  };

  const isDark = surface === 'dark';
  const recipient = purpose === 'email_change' && newEmail ? newEmail : email;
  const verifyDisabled = busy !== null || needsNewCode || code.length !== OTP_CODE_LENGTH;
  const resendDisabled = busy !== null || secondsLeft > 0;
  const describedBy = hint === null ? alertId : `${hintId} ${alertId}`;

  const appButtonStyle = (inactive: boolean): React.CSSProperties => ({
    background: inactive ? 'var(--bg-muted)' : 'var(--accent)',
    color: inactive ? 'var(--text-tertiary)' : 'var(--text-inverse)',
    cursor: inactive ? 'not-allowed' : 'pointer',
  });

  const resendClass = isDark
    ? `inline-flex items-center gap-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        needsNewCode
          ? 'px-3 py-2 rounded-xl border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 font-semibold hover:bg-cyan-500/20'
          : 'text-cyan-300/80 hover:text-cyan-200'
      }`
    : `inline-flex items-center gap-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        needsNewCode ? 'px-3 py-2 rounded-lg' : ''
      }`;
  const resendStyle: React.CSSProperties | undefined = isDark
    ? undefined
    : needsNewCode
      ? { background: 'var(--accent)', color: 'var(--text-inverse)' }
      : { color: 'var(--accent-text)' };

  return (
    <form
      noValidate
      onSubmit={event => {
        event.preventDefault();
        void verify(code);
      }}
    >
      {hint !== null && (
        <p
          id={hintId}
          className={`mb-4 text-sm leading-relaxed break-words ${isDark ? 'text-white/60' : ''}`}
          style={isDark ? undefined : { color: 'var(--text-secondary)' }}
        >
          {hint ?? (
            <EmphasizedText
              template={t('otp.code.hint')}
              placeholder="email"
              value={recipient}
              className={isDark ? 'text-cyan-300' : 'font-medium'}
              style={isDark ? undefined : { color: 'var(--text-primary)' }}
            />
          )}
        </p>
      )}

      <OtpCodeInput
        key={inputGeneration}
        value={code}
        onChange={next => {
          if (busyRef.current !== null) return;
          setCode(next);
          if (invalid) setInvalid(false);
        }}
        onComplete={completed => { void verify(completed); }}
        disabled={needsNewCode}
        invalid={invalid}
        autoFocus
        describedBy={describedBy}
        surface={surface}
      />

      {/* Two regions that always exist, so a message added to either is announced. */}
      <div id={alertId} role="alert" aria-atomic="true">
        {notice?.tone === 'error' && (
          <div className="mt-4">
            <NoticeBox tone="error" surface={surface}>{formatOtpMessage(notice.message, t, tPlural)}</NoticeBox>
          </div>
        )}
      </div>
      <div role="status" aria-atomic="true">
        {notice?.tone === 'success' && (
          <div className="mt-4">
            <NoticeBox tone="success" surface={surface}>{formatOtpMessage(notice.message, t, tPlural)}</NoticeBox>
          </div>
        )}
      </div>

      <button
        type="submit"
        disabled={verifyDisabled}
        className={isDark
          ? `${authPrimaryButtonClass} mt-5`
          : 'mt-5 w-full rounded-lg px-4 py-2 text-sm font-medium transition-colors flex items-center justify-center gap-2'}
        style={isDark ? undefined : appButtonStyle(verifyDisabled)}
      >
        {busy === 'verify' ? (
          <>
            <span className={authSpinnerClass} aria-hidden="true" />
            <span>{t('otp.verifying')}</span>
          </>
        ) : (
          <>
            <ShieldCheck size={15} aria-hidden="true" />
            <span>{verifyLabel ?? t('otp.verify')}</span>
          </>
        )}
      </button>

      <div className={`mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 ${onBack ? 'justify-between' : 'justify-end'}`}>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            disabled={busy !== null}
            className={isDark ? `${authQuietLinkClass} disabled:opacity-50` : 'inline-flex items-center gap-1.5 text-sm disabled:opacity-50'}
            style={isDark ? undefined : { color: 'var(--text-secondary)' }}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            {backLabel ?? t('common.back')}
          </button>
        )}
        <button
          ref={resendButton}
          type="button"
          onClick={() => { void resend(); }}
          disabled={resendDisabled}
          className={resendClass}
          style={resendStyle}
        >
          <RefreshCw size={14} className={busy === 'resend' ? 'animate-spin' : ''} aria-hidden="true" />
          <span>{secondsLeft > 0 ? t('otp.resendIn', { seconds: secondsLeft }) : t('otp.resend')}</span>
        </button>
      </div>
    </form>
  );
};

export default OtpChallenge;
