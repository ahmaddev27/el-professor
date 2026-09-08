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

  // ── Plan gating ────────────────────────────────────────────────────────────
  'locked.title':           '{feature} is not included in your plan',
  'locked.body.before':     'This module is available from the',
  'locked.body.after':      'onwards. Contact us to upgrade your plan.',
  'locked.planSuffix':      '{plan} plan',
  'locked.backToOverview':  'Back to overview',
  'locked.upgrade':         'Upgrade plan',
  'locked.availableIn':     'Included in the {plan} plan',
  'locked.feature.rollenNutzer': 'Roles & users',
  'locked.feature.trinkgeld':      'Trinkgeld Quittung',
  'locked.feature.stundennachweis': 'Stundennachweis',
  'locked.feature.allAdvanced':  '+ all Advanced features',

  // ── Trial banner ───────────────────────────────────────────────────────────
  'trial.urgent.one':       'Only {count} day left in your free trial — upgrade now to keep access.',
  'trial.urgent.other':     'Only {count} days left in your free trial — upgrade now to keep access.',
  'trial.warning':          'Your trial ends in {count} days. Choose a plan to continue.',
  'trial.active.one':       'Trial active — {count} day remaining. All premium features unlocked.',
  'trial.active.other':     'Trial active — {count} days remaining. All premium features unlocked.',
  'trial.expired':          'Your trial has ended. Advanced and Premium features are no longer available. Please choose a plan to restore full access.',
  'trial.choosePlan':       'Choose a plan',

  // ── Account status pages ───────────────────────────────────────────────────
  'status.pending.title':   'Registration received',
  'status.pending.thanks':  'Thank you for signing up{name}.',
  'status.pending.body':    'Your company account is currently being reviewed by our team. You will receive an email as soon as your access has been activated.',
  'status.pending.contact': 'If you have any questions please contact',
  'status.rejected.title':  'Registration declined',
  'status.rejected.body':   'Unfortunately your registration request could not be approved.',
  'status.rejected.reason': 'Reason',
  'status.rejected.contact': 'For more information or questions please contact',
  'status.suspended.title': 'Access blocked',
  'status.suspended.body':  'Your company account has been temporarily suspended. Access to the application is currently not possible.',
  'status.contact':         'For more information please contact',

  // ── Account blocked ────────────────────────────────────────────────────────
  'blocked.title':          'Access blocked',
  'blocked.contactHint':    'For more information please contact',
};
