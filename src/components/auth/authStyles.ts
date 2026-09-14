/**
 * Class names shared by the signed-out screens, which paint their own dark
 * background instead of using the theme tokens (see LanguageSwitcher's `dark`
 * variant). `app` is the themed surface inside the signed-in shell.
 */
export type AuthSurface = 'dark' | 'app';

export const authLabelClass = 'block text-xs font-semibold text-white/40 uppercase tracking-wider mb-2';

export const authInputClass =
  'w-full pl-10 pr-4 py-3 bg-white/5 border border-white/10 text-white placeholder-white/20 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/40 transition-all text-sm';

export const authPrimaryButtonClass =
  'w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-3 px-4 rounded-xl font-semibold text-sm hover:shadow-[0_4px_24px_rgba(6,182,212,0.4)] hover:-translate-y-0.5 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none flex items-center justify-center gap-2';

export const authQuietLinkClass = 'inline-flex items-center gap-1.5 text-white/50 hover:text-white/80 text-sm transition-colors';

export const authSpinnerClass = 'animate-spin rounded-full h-4 w-4 border-b-2 border-current';
