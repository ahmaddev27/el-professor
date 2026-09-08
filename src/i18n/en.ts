import type { PartialDictionary } from './index';

/**
 * English dictionary.
 *
 * Intentionally a Partial: screens are translated incrementally, and any key not
 * listed here renders its German text rather than a raw key.
 *
 * German domain vocabulary is kept verbatim — Stundennachweis, Fahrtenbuch,
 * Abrechnung, Belege, Werkstatt, Bundesland. Operators use these words daily and
 * they must match the wording on the documents sent to the Steuerberater.
 * Translating them would put the UI and the paperwork out of step.
 */
export const en: PartialDictionary = {
  // ── Navigation ─────────────────────────────────────────────────────────────
  'nav.overview':           'Overview',
  'nav.belege':             'Belege',        // statutory term, kept German
  'nav.fahrer':             'Drivers',
  'nav.cars':               'Vehicles',
  'nav.umsaetze':           'Revenue',
  'nav.fixkosten':          'Fixed costs',
  'nav.bargeldbestand':     'Cash balance',
  'nav.werkstatt':          'Werkstatt',     // statutory term, kept German
  'nav.abrechnung':         'Abrechnung',    // statutory term, kept German
  'nav.notes':              'Notes',
  'nav.notifications':      'Notifications',
  'nav.salaries':           'Salaries',
  'nav.documents':          'Documents',
  'nav.planner':            'Monatsplanung', // statutory term, kept German
  'nav.users':              'Users',
  'nav.roles':              'Roles',
  'nav.billing':            'Subscription',
  'nav.settings':           'Settings',
  'nav.section.management': 'Management',
  'nav.section.superAdmin': 'Super Admin',
  'nav.backToAdmin':        'Back to administration',

  // ── Admin shell ────────────────────────────────────────────────────────────
  'admin.title':            'Administration',
  'admin.subtitle':         'Platform management',
  'admin.badge':            'Administration',
  'admin.nav.platform':     'Platform',
  'admin.nav.companies':    'Companies',
  'admin.nav.billing':      'Subscriptions & payments',
  'admin.nav.diagnostics':  'Acceptance diagnostics',

  // ── Shell chrome ───────────────────────────────────────────────────────────
  'shell.systemName':       'Management system',
  'shell.superAdminView':   'Super admin view',
  'shell.themeToLight':     'Switch to light mode',
  'shell.themeToDark':      'Switch to dark mode',
  'shell.exitCompanyView':  'Exit company view',
  'shell.language':         'Language',

  // ── Common actions and states ──────────────────────────────────────────────
  'common.save':            'Save',
  'common.saving':          'Saving…',
  'common.cancel':          'Cancel',
  'common.delete':          'Delete',
  'common.deleting':        'Deleting…',
  'common.edit':            'Edit',
  'common.close':           'Close',
  'common.back':            'Back',
  'common.loading':         'Loading…',
  'common.search':          'Search',
  'common.confirm':         'Confirm',
  'common.yes':             'Yes',
  'common.no':              'No',
  'common.logout':          'Sign out',
  'common.settings':        'Settings',
  'common.error':           'Error',
  'common.required':        'Required',

  // ── Authentication ─────────────────────────────────────────────────────────
  'auth.signIn':            'Sign in',
  'auth.signingIn':         'Signing in…',
  'auth.email':             'Email address',
  'auth.emailPlaceholder':  'you@email.com',
  'auth.password':          'Password',
  'auth.passwordPlaceholder': 'Your password',
  'auth.forgotPassword':    'Forgot your password?',
  'auth.signInWithGoogle':  'Sign in with Google',
  'auth.noAccountYet':      'No account yet?',
  'auth.register':          'Register',
  'auth.or':                'or',
  'auth.tryFree':           'Try free for 14 days',
  'auth.showPassword':      'Show password',
  'auth.hidePassword':      'Hide password',

  'auth.error.invalidCredentials': 'Invalid email address or password. Please check your details.',
  'auth.error.tooManyAttempts':    'Too many sign-in attempts. Please wait a few minutes and try again.',
  'auth.error.emailNotConfirmed': 'Email confirmation is still enabled in the Supabase settings. Please disable "Confirm email" under Authentication > Providers > Email.',
  'auth.error.generic':            'Sign-in failed. Please try again.',
  'auth.error.network':            'Network error. Please check your internet connection.',
  'auth.error.google':             'Google sign-in failed. Please try again.',

  // ── Account blocked ────────────────────────────────────────────────────────
  'blocked.title':          'Access blocked',
  'blocked.contactHint':    'For more information please contact',
};
