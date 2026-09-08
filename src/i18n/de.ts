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

  // ── Plan gating ────────────────────────────────────────────────────────────
  'locked.title':           '{feature} ist nicht in Ihrem Plan',
  'locked.body.before':     'Dieses Modul ist ab dem',
  'locked.body.after':      'verfügbar. Kontaktieren Sie uns um Ihren Plan zu upgraden.',
  'locked.planSuffix':      '{plan}-Plan',
  'locked.backToOverview':  'Zurück zur Übersicht',
  'locked.upgrade':         'Plan upgraden',
  'locked.availableIn':     'Verfügbar im {plan}-Plan',
  'locked.feature.rollenNutzer': 'Rollen & Nutzer',
  'locked.feature.trinkgeld':      'Trinkgeld Quittung',
  'locked.feature.stundennachweis': 'Stundennachweis',
  'locked.feature.allAdvanced':  '+ alle Advanced-Features',

  // ── Trial banner ───────────────────────────────────────────────────────────
  'trial.urgent.one':       'Nur noch {count} Tag in Ihrer kostenlosen Testphase — jetzt upgraden um den Zugang zu behalten.',
  'trial.urgent.other':     'Nur noch {count} Tage in Ihrer kostenlosen Testphase — jetzt upgraden um den Zugang zu behalten.',
  'trial.warning':          'Ihre Testphase endet in {count} Tagen. Wählen Sie einen Plan um weiterzumachen.',
  'trial.active.one':       'Testphase aktiv — {count} Tag verbleibt. Alle Premium-Features freigeschaltet.',
  'trial.active.other':     'Testphase aktiv — {count} Tage verbleiben. Alle Premium-Features freigeschaltet.',
  'trial.expired':          'Ihre Testphase ist abgelaufen. Advanced- und Premium-Features sind nicht mehr verfügbar. Bitte wählen Sie einen Plan um den vollen Zugriff wiederherzustellen.',
  'trial.choosePlan':       'Plan wählen',

  // ── Account status pages ───────────────────────────────────────────────────
  'status.pending.title':   'Registrierung eingegangen',
  'status.pending.thanks':  'Vielen Dank für Ihre Anmeldung{name}.',
  'status.pending.body':    'Ihr Unternehmenskonto wird derzeit von unserem Team geprüft. Sie erhalten eine E-Mail, sobald Ihr Zugang freigeschaltet wurde.',
  'status.pending.contact': 'Bei Fragen wenden Sie sich bitte an',
  'status.rejected.title':  'Registrierung abgelehnt',
  'status.rejected.body':   'Leider konnte Ihre Registrierungsanfrage nicht genehmigt werden.',
  'status.rejected.reason': 'Grund',
  'status.rejected.contact': 'Für weitere Informationen oder Rückfragen wenden Sie sich bitte an',
  'status.suspended.title': 'Zugang gesperrt',
  'status.suspended.body':  'Ihr Unternehmenskonto wurde vorübergehend gesperrt. Der Zugriff auf die Anwendung ist derzeit nicht möglich.',
  'status.contact':         'Für weitere Informationen wenden Sie sich bitte an',

  // ── Account blocked ────────────────────────────────────────────────────────
  'blocked.title':          'Zugang gesperrt',
  'blocked.contactHint':    'Für weitere Informationen wenden Sie sich bitte an',
} as const;
