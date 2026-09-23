import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LogIn, Mail, Lock, Eye, EyeOff, MailCheck } from 'lucide-react';
import { useAuth, BLOCK_MESSAGE_KEYS } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import GoogleButton from './auth/GoogleButton';
import { LegalLinks } from './legal/LegalLinks';
import AuthShell from './auth/AuthShell';
import { authFieldIconClass, authFieldWithIconClass, authLinkClass } from './auth/authStyles';
import { Alert, Button, Field, Input, cn } from './ui';
import type { TranslationKey } from '../i18n';

/**
 * Classify a raw auth error into a translation key.
 *
 * Our own block reasons never reach here — signIn() reports those through
 * `blockReason`, which handleSubmit resolves before falling back to this.
 */
const toErrorKey = (msg: string): TranslationKey => {
  const m = msg.toLowerCase();
  if (m.includes('invalid login credentials') || m.includes('invalid credentials')) {
    return 'auth.error.invalidCredentials';
  }
  if (m.includes('email not confirmed')) {
    return 'auth.error.emailNotConfirmed';
  }
  if (m.includes('too many requests') || m.includes('rate limit')) {
    return 'auth.error.tooManyAttempts';
  }
  if (m.includes('network') || m.includes('fetch')) {
    return 'auth.error.network';
  }
  return 'auth.error.generic';
};

/**
 * GoTrue refuses a password sign-in for an address nobody confirmed — an owner
 * who signed up and never entered the code. supabase-js names that by code;
 * the message match is the fallback for errors built without one.
 */
const isUnconfirmedEmail = (error: { code?: unknown; message?: unknown } | null | undefined): boolean =>
  error?.code === 'email_not_confirmed' ||
  (typeof error?.message === 'string' && toErrorKey(error.message) === 'auth.error.emailNotConfirmed');

const LoginForm: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [needsVerification, setNeedsVerification] = useState(false);
  const [loading, setLoading] = useState(false);
  const { signIn, authNotice, clearAuthNotice } = useAuth();

  // A session AuthContext ended for a reason of our own — today a Google
  // sign-in that must not stand, a platform account above all (plan 1.6). It
  // belongs in the same box as every other sign-in error, and leaves the
  // context as soon as it is shown.
  useEffect(() => {
    if (!authNotice) return;
    setError(t(authNotice));
    clearAuthNotice();
  }, [authNotice, clearAuthNotice, t]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNeedsVerification(false);
    setLoading(true);

    const { error, blockReason } = await signIn(email, password);

    if (blockReason) {
      // Our own reason, and it carries a key — never run it through the
      // classifier, which only knows Supabase's own English error strings.
      setError(t(BLOCK_MESSAGE_KEYS[blockReason]));
    } else if (isUnconfirmedEmail(error)) {
      setNeedsVerification(true);
      setError(t('auth.error.emailNotConfirmed'));
    } else if (error) {
      setError(t(toErrorKey(error.message || '')));
    }

    setLoading(false);
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the sign-in and is unchanged: every refusal branch,
  // the notice a Google refusal leaves, and the one call to signIn(). Below it
  // is drawn with the design system. What the e2e suite finds here stays as it
  // was: one email and one password field, one submit button inside the form,
  // a button named exactly "Anmelden", one heading naming "Anmelden" (the page's
  // h1 now, where it was the card's h2), and the Google button's own label.

  return (
    <AuthShell
      title={t('auth.signIn')}
      subtitle={t('shell.systemName')}
      footer={
        <>
          <p className="text-sm text-fg-muted">
            {t('auth.noAccountYet')}{' '}
            <Link to="/signup" className={authLinkClass}>
              {t('auth.tryFree')}
            </Link>
          </p>
          <p className="text-xs text-fg-subtle">© 2025 El-Professor</p>
          {/* #97's Impressum and Datenschutz links. The page follows the theme
              now, so they take the theme's tone rather than `onDark`. */}
          <LegalLinks className="justify-center" />
        </>
      }
    >
      {error && (
        <Alert
          tone="critical"
          className="mb-5"
          title={error}
          action={needsVerification ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => navigate('/auth/verify-email', { state: { email: email.trim() } })}
            >
              <MailCheck aria-hidden />
              {t('auth.verifyEmailCta')}
            </Button>
          ) : undefined}
        />
      )}

      <form onSubmit={handleSubmit} className="grid gap-4">
        <Field label={t('auth.email')}>
          <div className="relative">
            <Mail aria-hidden className={authFieldIconClass} />
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={authFieldWithIconClass}
              placeholder={t('auth.emailPlaceholder')}
              required
            />
          </div>
        </Field>

        <div className="grid gap-2">
          <Field label={t('auth.password')}>
            <div className="relative">
              <Lock aria-hidden className={authFieldIconClass} />
              <Input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={cn(authFieldWithIconClass, 'pr-11')}
                placeholder={t('auth.passwordPlaceholder')}
                required
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                className="absolute right-0.5 top-1/2 -translate-y-1/2"
              >
                {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
              </Button>
            </div>
          </Field>
          <div className="text-right">
            <Link to="/auth/forgot-password" className={cn(authLinkClass, 'text-[13px]')}>
              {t('auth.forgotPassword')}
            </Link>
          </div>
        </div>

        <Button type="submit" size="lg" disabled={loading} loading={loading} className="mt-1 w-full">
          {!loading && <LogIn aria-hidden />}
          {t('auth.signIn')}
        </Button>
      </form>

      {/* Renders nothing until GoTrue reports Google as enabled — its own
          spacing included, so the card is unchanged while it is off. */}
      <GoogleButton
        from="login"
        labelKey="auth.google.signIn"
        divider
        onError={key => setError(t(key))}
      />
    </AuthShell>
  );
};

export default LoginForm;
