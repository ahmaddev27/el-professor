import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { LogIn, Mail, Lock, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import LanguageSwitcher from './LanguageSwitcher';
import type { TranslationKey } from '../i18n';

// Google icon (inline SVG, no dependency needed)
const GoogleIcon: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
);

/**
 * Classify a raw auth error into a translation key.
 *
 * Returns null when the message is one of our own BLOCK_MESSAGES, which is
 * already written for the user and passes through unchanged.
 */
const toErrorKey = (msg: string): TranslationKey | null => {
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
  // Already-localized messages from BLOCK_MESSAGES pass through untouched.
  if (msg.includes('Ihren Administrator') || msg.includes('Support') || msg.includes('Postfach')) {
    return null;
  }
  return 'auth.error.generic';
};

const LoginForm: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const { t } = useTranslation();

  // Resolve a raw auth error to display text. A null key means the message is
  // already user-facing (one of our BLOCK_MESSAGES) and is shown as-is.
  const translateAuthError = (message: string): string => {
    const key = toErrorKey(message);
    return key ? t(key) : message;
  };
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const { signIn, signInWithGoogle } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const { error } = await signIn(email, password);

    if (error) {
      setError(translateAuthError(error.message || ''));
    }

    setLoading(false);
  };

  const handleGoogle = async () => {
    setError('');
    setGoogleLoading(true);
    const { error } = await signInWithGoogle();
    if (error) {
      setError(t('auth.error.google'));
      setGoogleLoading(false);
    }
    // On success the browser redirects to /auth/callback — no need to reset loading
  };

  return (
    <div className="min-h-screen bg-[#060a0f] flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(6,182,212,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(6,182,212,0.03)_1px,transparent_1px)] bg-[size:48px_48px]" />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-cyan-600/5 rounded-full blur-[120px] pointer-events-none" />

      <div className="absolute top-4 right-4 z-10">
        <LanguageSwitcher variant="dark" />
      </div>

      <div className="relative w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center">
            <img src="/professor_logo_white.svg" alt="El-Professor" className="w-16 h-16 object-contain drop-shadow-[0_0_16px_rgba(6,182,212,0.5)]" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">El-Professor</h1>
          <p className="text-white/40 text-sm">{t('shell.systemName')}</p>
        </div>

        {/* Card */}
        <div className="bg-white/4 backdrop-blur-xl border border-white/10 rounded-2xl p-7 shadow-[0_24px_64px_rgba(0,0,0,0.5)]">
          <h2 className="text-lg font-semibold text-white mb-5 text-center">{t('auth.signIn')}</h2>

          {error && (
            <div className="mb-5 p-3.5 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-2.5">
              <AlertCircle className="text-red-400 flex-shrink-0 mt-0.5" size={16} />
              <span className="text-red-300 text-sm leading-relaxed">{error}</span>
            </div>
          )}

          {/* Google Sign-In */}
          <button
            type="button"
            onClick={handleGoogle}
            disabled={googleLoading || loading}
            className="w-full flex items-center justify-center gap-3 py-3 px-4 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-white text-sm font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed mb-5"
          >
            {googleLoading ? (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
            ) : (
              <GoogleIcon size={18} />
            )}
            <span>{t('auth.signInWithGoogle')}</span>
          </button>

          {/* Divider */}
          <div className="flex items-center gap-3 mb-5">
            <div className="flex-1 h-px bg-white/8" />
            <span className="text-white/25 text-xs font-medium">{t('auth.or')}</span>
            <div className="flex-1 h-px bg-white/8" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-white/40 uppercase tracking-wider mb-2">
                {t('auth.email')}
              </label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-white/5 border border-white/10 text-white placeholder-white/20 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/40 transition-all text-sm"
                  placeholder={t('auth.emailPlaceholder')}
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-white/40 uppercase tracking-wider mb-2">
                {t('auth.password')}
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-12 py-3 bg-white/5 border border-white/10 text-white placeholder-white/20 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/40 transition-all text-sm"
                  placeholder={t('auth.passwordPlaceholder')}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/60 transition-colors"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <div className="mt-2 text-right">
                <Link
                  to="/auth/forgot-password"
                  className="text-xs text-cyan-300/80 hover:text-cyan-200 transition-colors"
                >
                  {t('auth.forgotPassword')}
                </Link>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || googleLoading}
              className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-3 px-4 rounded-xl font-semibold text-sm hover:shadow-[0_4px_24px_rgba(6,182,212,0.4)] hover:-translate-y-0.5 focus:outline-none transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 flex items-center justify-center gap-2 mt-2"
            >
              {loading ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
              ) : (
                <>
                  <LogIn size={16} />
                  <span>{t('auth.signIn')}</span>
                </>
              )}
            </button>
          </form>
        </div>

        <p className="text-center mt-5 text-white/30 text-sm">
          {t('auth.noAccountYet')}{' '}
          <Link to="/signup" className="text-cyan-300/80 hover:text-cyan-200 transition-colors">
            {t('auth.tryFree')}
          </Link>
        </p>

        <div className="text-center mt-4 text-white/20 text-xs">
          © 2025 El-Professor
        </div>
      </div>
    </div>
  );
};

export default LoginForm;
