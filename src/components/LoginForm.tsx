import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { LogIn, Mail, Lock, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { useAuth, BLOCK_MESSAGE_KEYS } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import LanguageSwitcher from './LanguageSwitcher';
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

const LoginForm: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const { t } = useTranslation();

  const translateAuthError = (message: string): string => t(toErrorKey(message));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { signIn } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const { error, blockReason } = await signIn(email, password);

    if (blockReason) {
      // Our own reason, and it carries a key — never run it through the
      // classifier, which only knows Supabase's own English error strings.
      setError(t(BLOCK_MESSAGE_KEYS[blockReason]));
    } else if (error) {
      setError(translateAuthError(error.message || ''));
    }

    setLoading(false);
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
              disabled={loading}
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
