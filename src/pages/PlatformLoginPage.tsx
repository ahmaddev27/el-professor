import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Eye, EyeOff, LogIn, Lock, Mail, ShieldCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { platformSignInMessageKey } from '../lib/adminGate';
import type { TranslationKey } from '../i18n';

/**
 * The platform team's own sign-in page, at `/admin/login` (plan slice 3.6a).
 *
 * **Email address and password, and nothing else.** The owner decided on
 * 16.09.2026 that platform sign-in has no second step — plan slice 3.2, a code
 * on every platform sign-in, was cancelled — and that platform accounts never
 * sign in with Google. So there is no OTP challenge here and no Google button;
 * the refusal for a Google session that belongs to a platform account already
 * lives in AuthContext and is not weakened by anything on this page.
 *
 * There is no signup link either: a platform account is created by an owner,
 * through `platform-staff`, and never by whoever finds this page.
 *
 * Every refusal reads the same — see `platformSignInMessageKey`, which is where
 * that rule is written down and tested. This page is a directory of the people
 * who administer the platform, so a message that told a wrong password apart
 * from an address nobody has would answer, for anyone who asked, whether an
 * address is one of them.
 *
 * Signing in is all this page does. Where the account goes next is App's
 * `/admin/login` route, which asks `platformEntry()`: the panel for an account
 * the panel is for, its own app for a company user. Nothing here is a security
 * boundary — the database checks every platform action again through
 * `platform_can()`.
 *
 * The look is the admin shell's, on the legacy CSS variables AdminLayout and
 * AdminSidebar use, so the sign-in and the panel behind it are visibly one
 * place. Phase 5 moves both to src/components/ui together.
 */
const PlatformLoginPage: React.FC = () => {
  const { t } = useTranslation();
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrorKey(null);
    setLoading(true);

    // `blockReason` is deliberately not read: AuthContext resolves it to a
    // sentence naming exactly why an account was refused, and that sentence is
    // what this page must not show. A refused sign-in has already been signed
    // out again by signIn() itself.
    const { error } = await signIn(email.trim(), password);
    if (error) setErrorKey(platformSignInMessageKey(error));

    setLoading(false);
  };

  const fieldStyle: React.CSSProperties = {
    background: 'var(--bg-subtle)',
    border: '1px solid var(--border)',
    color: 'var(--text-primary)',
  };

  const labelClass = 'block text-xs font-semibold uppercase tracking-wider mb-2';

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--bg-base)' }}>
      <div className="absolute top-4 right-4 z-10">
        <LanguageSwitcher />
      </div>

      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <div
            className="w-12 h-12 mx-auto mb-4 flex items-center justify-center rounded-xl"
            style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)' }}
          >
            <ShieldCheck size={22} style={{ color: 'var(--warning)' }} aria-hidden="true" />
          </div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
            {t('admin.login.title')}
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--warning)' }}>
            {t('admin.login.lead')}
          </p>
        </div>

        <div
          className="rounded-2xl p-6"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
        >
          {errorKey && (
            <div
              role="alert"
              className="mb-5 p-3.5 rounded-xl flex items-start gap-2.5"
              style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)' }}
            >
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} aria-hidden="true" />
              <span className="text-sm leading-relaxed" style={{ color: 'var(--danger)' }}>
                {t(errorKey)}
              </span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="platform-email" className={labelClass} style={{ color: 'var(--text-tertiary)' }}>
                {t('auth.email')}
              </label>
              <div className="relative">
                <Mail
                  size={16}
                  className="absolute left-3.5 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--text-tertiary)' }}
                  aria-hidden="true"
                />
                <input
                  id="platform-email"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 rounded-xl text-sm focus:outline-none"
                  style={fieldStyle}
                  placeholder={t('auth.emailPlaceholder')}
                  autoComplete="username"
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor="platform-password" className={labelClass} style={{ color: 'var(--text-tertiary)' }}>
                {t('auth.password')}
              </label>
              <div className="relative">
                <Lock
                  size={16}
                  className="absolute left-3.5 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--text-tertiary)' }}
                  aria-hidden="true"
                />
                <input
                  id="platform-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full pl-10 pr-12 py-3 rounded-xl text-sm focus:outline-none"
                  style={fieldStyle}
                  placeholder={t('auth.passwordPlaceholder')}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <div className="mt-2 text-right">
                <Link to="/auth/forgot-password" className="text-xs" style={{ color: 'var(--accent)' }}>
                  {t('auth.forgotPassword')}
                </Link>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 mt-2 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: 'var(--warning)', color: 'white' }}
            >
              {loading ? (
                <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
              ) : (
                <>
                  <LogIn size={16} aria-hidden="true" />
                  <span>{t('admin.login.submit')}</span>
                </>
              )}
            </button>
          </form>

          <p className="mt-5 text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
            {t('admin.login.noGoogle')}
          </p>
        </div>

        <p className="text-center mt-5 text-sm" style={{ color: 'var(--text-tertiary)' }}>
          {t('admin.login.companyHint')}{' '}
          <Link to="/login" style={{ color: 'var(--accent)' }}>
            {t('admin.login.companyLink')}
          </Link>
        </p>
      </div>
    </div>
  );
};

export default PlatformLoginPage;
