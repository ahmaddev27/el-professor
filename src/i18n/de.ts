/**
 * German dictionary — the source language and the fallback for every other.
 *
 * Keys are namespaced with dots: `nav.*`, `auth.*`, `common.*`. Keep them
 * alphabetical within a namespace so additions are easy to place and conflicts
 * are easy to spot.
 *
 * Statutory German terms (Stundennachweis, Fahrtenbuch, Abrechnung, Beleg,
 * Werkstatt, Lohnart, Bundesland) appear verbatim in BOTH dictionaries — see
 * the note in ./index.ts for why they are not translated.
 */
export const de = {
  // ── Navigation ─────────────────────────────────────────────────────────────
  'nav.overview':           'Übersicht',
  'nav.belege':             'Belege',
  'nav.fahrer':             'Fahrer',
  'nav.cars':               'Fahrzeuge',
  'nav.umsaetze':           'Umsätze',
  'nav.fixkosten':          'Fixkosten',
  'nav.bargeldbestand':     'Bargeldbestand',
  'nav.werkstatt':          'Werkstatt',
  'nav.abrechnung':         'Abrechnung',
  'nav.notes':              'Notizen',
  'nav.notifications':      'Benachrichtigungen',
  'nav.salaries':           'Gehälter',
  'nav.documents':          'Dokumente',
  'nav.planner':            'Monatsplanung',
  'nav.users':              'Benutzer',
  'nav.roles':              'Rollen',
  'nav.billing':            'Abonnement',
  'nav.settings':           'Einstellungen',
  'nav.section.management': 'Verwaltung',
  'nav.section.superAdmin': 'Super Admin',
  'nav.backToAdmin':        'Zurück zur Verwaltung',

  // ── Admin shell ────────────────────────────────────────────────────────────
  'admin.title':            'Administration',
  'admin.subtitle':         'Plattformverwaltung',
  'admin.badge':            'Administration',
  'admin.nav.platform':     'Plattform',
  'admin.nav.companies':    'Unternehmen',
  'admin.nav.billing':      'Abos & Zahlungen',
  'admin.nav.diagnostics':  'Abnahme-Diagnose',

  // ── Shell chrome ───────────────────────────────────────────────────────────
  'shell.systemName':       'Verwaltungssystem',
  'shell.superAdminView':   'Super Admin Ansicht',
  'shell.themeToLight':     'Zum hellen Modus wechseln',
  'shell.themeToDark':      'Zum dunklen Modus wechseln',
  'shell.exitCompanyView':  'Unternehmensansicht beenden',
  'shell.language':         'Sprache',

  // ── Common actions and states ──────────────────────────────────────────────
  'common.save':            'Speichern',
  'common.saving':          'Wird gespeichert…',
  'common.cancel':          'Abbrechen',
  'common.delete':          'Löschen',
  'common.deleting':        'Löschen…',
  'common.edit':            'Bearbeiten',
  'common.close':           'Schließen',
  'common.back':            'Zurück',
  'common.loading':         'Wird geladen…',
  'common.search':          'Suchen',
  'common.confirm':         'Bestätigen',
  'common.yes':             'Ja',
  'common.no':              'Nein',
  'common.logout':          'Abmelden',
  'common.settings':        'Einstellungen',
  'common.error':           'Fehler',
  'common.required':        'Pflichtfeld',

  // ── Authentication ─────────────────────────────────────────────────────────
  'auth.signIn':            'Anmelden',
  'auth.signingIn':         'Anmeldung läuft…',
  'auth.email':             'E-Mail-Adresse',
  'auth.emailPlaceholder':  'ihre@email.de',
  'auth.password':          'Passwort',
  'auth.passwordPlaceholder': 'Ihr Passwort',
  'auth.forgotPassword':    'Passwort vergessen?',
  'auth.signInWithGoogle':  'Mit Google anmelden',
  'auth.noAccountYet':      'Noch kein Konto?',
  'auth.register':          'Registrieren',
  'auth.or':                'oder',
  'auth.tryFree':           '14 Tage kostenlos testen',
  'auth.showPassword':      'Passwort anzeigen',
  'auth.hidePassword':      'Passwort verbergen',

  'auth.error.invalidCredentials': 'Ungültige E-Mail-Adresse oder Passwort. Bitte überprüfen Sie Ihre Eingaben.',
  'auth.error.tooManyAttempts':    'Zu viele Anmeldeversuche. Bitte warten Sie einige Minuten und versuchen Sie es erneut.',
  'auth.error.emailNotConfirmed': 'E-Mail-Bestätigung ist noch in den Supabase-Einstellungen aktiviert. Bitte deaktivieren Sie "Confirm email" unter Authentication > Providers > Email.',
  'auth.error.generic':            'Anmeldung nicht möglich. Bitte versuchen Sie es erneut.',
  'auth.error.network':            'Netzwerkfehler. Bitte prüfen Sie Ihre Internetverbindung.',
  'auth.error.google':             'Google-Anmeldung fehlgeschlagen. Bitte versuchen Sie es erneut.',

  // ── Account blocked ────────────────────────────────────────────────────────
  'blocked.title':          'Zugang gesperrt',
  'blocked.contactHint':    'Für weitere Informationen wenden Sie sich bitte an',
} as const;
