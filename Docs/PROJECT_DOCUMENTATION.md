# El-Professor — Projekt-Dokumentation

> **Version:** 1.0 · **Datum:** September 2026  
> **Plattform:** SaaS für Taxi- & Mietwagenunternehmen (Deutschland)

---

## 1. Übersicht

El-Professor ist eine multi-tenant SaaS-Plattform zur Verwaltung von Taxi- und Mietwagenunternehmen. Jede Firma (Company) hat ihre eigenen isolierten Daten — Fahrer, Fahrzeuge, Belege, Umsätze, Gehälter, Dokumente und mehr. Ein Super Admin steuert die gesamte Plattform: Firmen-Freischaltungen, Abonnements, Rabattcodes, Aktivierungscodes und Plattform-Statistiken.

---

## 2. Tech-Stack

| Schicht | Technologie |
|---------|------------|
| Frontend | React 18 + TypeScript |
| Build-Tool | Vite 5 |
| Styling | Tailwind CSS 3 (CSS-Variablen für Dark/Light-Theme) |
| Routing | React Router DOM v7 |
| Icons | Lucide React |
| Charts | Recharts |
| PDF-Erstellung | jsPDF + html2canvas |
| Excel-Export | xlsx (SheetJS) |
| OCR (Belege) | Tesseract.js |
| Datums-Logik | date-fns (de-Locale) |
| Backend / DB | Supabase (PostgreSQL + Auth + Edge Functions + Storage) |
| Edge Functions | Deno Runtime (Supabase Functions) |

---

## 3. Architektur

```
Browser (React SPA)
    │
    ├── Supabase Auth (Email/Password, Google OAuth)
    ├── Supabase PostgreSQL (mit Row Level Security)
    ├── Supabase Edge Functions (Deno)
    └── Supabase Storage (Logos, PDFs, Fahrtenbuch-Imports)
```

### 3.1 Multi-Tenancy

- Jede Firma ist ein Datensatz in der `companies`-Tabelle.
- Alle geschäftsbezogenen Tabellen haben eine `company_id`-Spalte.
- Row Level Security (RLS) isoliert die Daten zwischen Firmen.
- Ein Super Admin kann als "Viewer" in jede Firma wechseln (`SuperAdminContext`).

### 3.2 Auth-Guard-Pipeline

Beim Login durchläuft ein Nutzer folgende Guards (in `App.tsx`):

1. **Auth Loading** — Warten auf Session-Wiederherstellung
2. **Approval Gate** — `pending` / `rejected` / `suspended` → eigene Seiten
3. **Must-Change-Password Guard** — erzwingt Passwortwechsel bei `must_change_password=true`
4. **Subscription Guard** — leitet zu `/abo-aktivieren` bei inaktivem Abo
5. **Plan Gate** — sperrt Features nach Tarif (Basic / Advanced / Premium)

---

## 4. Rollen & Berechtigungen

| Rolle | Beschreibung |
|-------|-------------|
| **Super Admin** | Volle Plattum-Kontrolle — alle Firmen, Abos, Codes, Statistiken |
| **Admin** | Verwaltet seine Firma — Benutzer, Rollen, Einstellungen, Abrechnung |
| **Creator** | Erstellt & bearbeitet Inhalte (Fahrer, Belege, Umsätze, etc.) |
| **Viewer** | Lesezugriff nur — keine Erstellung oder Löschung |

### Berechtigungs-Modell

- `isAdmin` → Rolle = "admin"
- `isCreator` → Rolle = "creator" oder "admin"
- `isViewer` → Rolle = "viewer" (ohne Admin/Creator)
- `canCreate` → Admin oder Creator
- `canEdit(createdBy)` → Admin oder eigener Datensatz
- `canDelete(createdBy)` → Admin oder eigener Datensatz

Zusätzlich gibt es ein feingranulares Rollen-System (`roles` + `role_permissions` Tabellen), das pro Seite `can_view` / `can_edit` steuert.

---

## 5. Tarife (Plans)

| Feature | Basic | Advanced | Premium |
|---------|:-----:|:--------:|:-------:|
| Übersicht | ✅ | ✅ | ✅ |
| Belege | ✅ | ✅ | ✅ |
| Fahrer | ✅ | ✅ | ✅ |
| Fahrzeuge | ✅ | ✅ | ✅ |
| Umsätze | ✅ | ✅ | ✅ |
| Fixkosten | ✅ | ✅ | ✅ |
| Bargeldbestand | ✅ | ✅ | ✅ |
| Werkstatt | — | ✅ | ✅ |
| Abrechnung | — | ✅ | ✅ |
| Notizen | — | ✅ | ✅ |
| Rollen & Nutzer | — | ✅ | ✅ |
| Benachrichtigungen | — | ✅ | ✅ |
| Gehälter | — | — | ✅ |
| Dokumente | — | — | ✅ |
| Stundennachweis | — | — | ✅ |
| Monatsplanung | — | — | ✅ |

- **Trial-Phase:** Neue Firmen erhalten eine Testphase (Premium-Features). Nach Ablauf wird auf den gebuchten Tarif reduziert.
- **Abrechnung:** Monatlich oder Jährlich.
- **Fahrzeuglimit:** Pro Firma konfigurierbar (`subscription_car_limit`).

---

## 6. Features (Use Cases)

### 6.1 Übersicht (Overview)
Dashboard mit KPIs, Charts und Schnellzugriff auf alle Bereiche.

### 6.2 Belege (Receipts)
- Beleg-Verwaltung mit Foto-Upload
- OCR-Extraktion via Tesseract.js / Edge Function `extract-receipt`
- Kategorisierung, Statistiken, PDF-Export

### 6.3 Fahrer (Drivers)
- Fahrer-Stammdaten (Name, Geschlecht, Beschäftigungstyp, Gehaltsbereich)
- Status-Verwaltung (aktiv / inaktiv)
- Verfügbarkeit & Schichtfenster für Monatsplanung
- Notizen mit Datumsbereich und Planungs-Flags

### 6.4 Fahrzeuge (Cars)
- Fahrzeug-Verwaltung mit TÜV-Terminen
- Werkstatt-Checks mit KM-Stand
- Status (aktiv / inaktiv), Block-Resolver für Planung

### 6.5 Umsätze (Income)
- Wöchentliche Einnahmen-Erfassung
- Trip-Count, Fahrtenbuch-Quelle
- Wochen-Berechnung (Montag–Sonntag)

### 6.6 Fixkosten (Fixed Costs)
- Wiederkehrende Kosten pro Firma
- Kategorisierung

### 6.7 Bargeldbestand (Cash Balance)
- Transaktionsverfolgung (Einzahlungen / Auszahlungen)
- Saldo-Recalculation via DB-Trigger

### 6.8 Werkstatt (Workshop)
- Prüf-Checklisten pro Fahrzeug
- KM-Stand-Pflichtfeld
- Status-Tracking

### 6.9 Abrechnung (Accounting)
- Wöchentliche & monatliche Abrechnung
- RPC-Funktionen für aggregierte Auswertungen
- Steuerberater-Export

### 6.10 Notizen (Notes)
- Fahrer-Notizen mit Datumsbereich
- Planungs-Flags (z.B. Urlaub, Krankheit)
- Validierungs-Logik

### 6.11 Gehälter (Salaries)
- Monatsabhängige Gehaltsberechnung
- Netto-/Brutto-Spalten, Payroll-Split
- Zahlungsverwaltung (`salary_payments`)
- Quittungs-PDF-Export

### 6.12 Dokumente (Documents)
- Dokument-Builder mit Vorlagen
- Mietwagenauftrag, Trinkgeld-Quittung, Rechnungen
- Template-System mit Storage
- PDF-Generierung

### 6.13 Stundennachweis (Time Tracking)
- Stunden-Nachweise pro Fahrer & Monat
- PDF-Export & Storage
- Fahrtenbuch-Integration

### 6.14 Monatsplanung (Monthly Planning)
- 5-Phasen-Planungs-Engine:
  - Phase 1: Fahrer-Pool & Verfügbarkeit
  - Phase 3: Zuweisungs-Vorschau
  - Phase 4: Apply-Tracking
  - Phase 5: Ausnahmen & Monatslimit
- Planungs-Runs mit Archivierung
- Finalisierung & Adjustments
- Excel/XLSX-Export

### 6.15 Benutzer (Users)
- Einladung neuer Benutzer mit temporärem Passwort
- `must_change_password`-Flow
- Status: active / inactive / pending_invite / suspended / deactivated
- Verwaltet via Edge Function `manage-users`

### 6.16 Rollen (Roles)
- Custom Rollen mit Seiten-Berechtigungen
- `can_view` / `can_edit` pro Seite
- System-Rollen (nicht löschbar)

### 6.17 Einstellungen (Settings)
- Firmen-Stammdaten (Name, Adresse, PLZ, Stadt)
- Logo-Upload (Storage)
- Business-Kalender-Logik
- Fahrer-pro-Fahrzeug-Limit

### 6.18 Abonnement & Billing
- Aktivierung via Aktivierungscode oder manueller Zuweisung
- Rabattcodes & Empfehlungscodes
- Bargeld-Abrechnung (cash-based billing)

---

## 7. Super Admin Dashboard

### 7.1 Plattform-Übersicht
- KPIs: Unternehmen, Benutzer, Fahrer, Belege, Trials
- Status-Verteilung (Aktiv / Trial / Gesperrt / Inaktiv / Archiviert / Gelöscht)
- Plan-Verteilung (Basic / Advanced / Premium)
- Handlungsbedarf-Liste (abgelaufene Trials, keine Benutzer, etc.)
- Live-Countdown für auslaufende Trials
- Neueste Registrierungen

### 7.2 Freischaltungen (Approvals)
- Pending-Unternehmen mit Freischalt-/Ablehn-Buttons
- Ablehnungsgrund-Erfassung
- Suspendierung bereits freigeschalteter Firmen
- Status-Tabelle aller Unternehmen

### 7.3 Unternehmen (Companies)
- Vollständige Firmen-Verwaltung
- Status, Tarif, Abrechnungszyklus, Fahrzeuglimit änderbar
- "Als Firma öffnen" — Super Admin wechselt in Firmen-Sicht

### 7.4 Abos & Zahlungen (Subscription Billing)
- Abonnement-Verwaltung
- Manuelle Abo-Zuweisung
- Bargeld-Transaktionen

### 7.5 Rabattcodes (Discount Codes)
- Erstellung & Verwaltung von Rabattcodes
- Nutzungstracking

### 7.6 Empfehlungscodes (Referral Codes)
- Referral-Programm
- Zuordnung zu Firmen

### 7.7 Aktivierungscodes (Activation Codes)
- Code-Generierung
- Vorschau & Redemption
- Audit-Fields

---

## 8. Edge Functions

| Funktion | Zweck |
|----------|------|
| `manage-users` | Benutzer erstellen, aktualisieren, löschen (Admin-Aktionen) |
| `company-signup` | Neue Firmen-Registrierung mit Trial |
| `extract-receipt` | OCR-Extraktion von Beleg-Fotos |
| `generate-activation-code` | Aktivierungscode generieren |
| `apply-discount-code` | Rabattcode anwenden |
| `validate-discount-code` | Rabattcode validieren |
| `update-income-weeks` | Wochen-Backfill für Umsatzdaten |

Alle Edge Functions haben CORS-Header konfiguriert (`Access-Control-Allow-Origin: *`).

---

## 9. Datenbank-Schema (Wichtige Tabellen)

| Tabelle | Beschreibung |
|---------|-------------|
| `companies` | Firmen mit Status, Tarif, Trial, Abonnement |
| `user_profiles` | Benutzer mit Rolle, Status, `is_super_admin` |
| `roles` | Custom Rollen pro Firma |
| `role_permissions` | Seiten-Berechtigungen pro Rolle |
| `drivers` | Fahrer-Stammdaten |
| `driver_notes` | Fahrer-Notizen mit Planungs-Flags |
| `cars` | Fahrzeuge mit TÜV & Status |
| `werkstatt_checks` | Werkstatt-Prüfungen mit KM-Stand |
| `receipts` | Belege mit OCR-Daten |
| `income` | Wöchentliche Umsätze mit Trip-Count |
| `fixed_costs` | Fixkosten pro Firma |
| `cash_transactions` | Bargeld-Transaktionen |
| `salaries` | Gehaltsberechnungen (Brutto/Netto/Payroll-Split) |
| `salary_payments` | Gehalts-Zahlungen |
| `company_settings` | Firmen-Einstellungen (Logo, Limits, Kalender) |
| `documents` | Generierte Dokumente |
| `document_templates` | Dokument-Vorlagen |
| `saved_stundennachweise` | Gespeicherte Stundennachweise mit PDF-Storage |
| `fahrtenbuch_imports` | Fahrtenbuch-Importe (XLSX) |
| `fahrtenbuch_trips` | Einzelne Fahrten (immutable) |
| `company_planning_runs` | Monatsplanung-Runs |
| `planning_finalizations` | Finalisierte Planungen |
| `planning_run_adjustments` | Planungs-Korrekturen |
| `historical_*` | Historische Rekonstruktion & Abgleich-Tabellen |
| `discount_codes` | Rabattcodes |
| `referrals` | Empfehlungscodes |
| `activation_codes` | Aktivierungscodes mit Audit-Fields |
| `notification_settings` | Benachrichtigungs-Einstellungen |

---

## 10. File-Struktur

```
project/
├── src/
│   ├── App.tsx                     # Routing + Guards
│   ├── main.tsx                    # Entry point
│   ├── contexts/
│   │   ├── AuthContext.tsx         # Auth, Profile, Subscription
│   │   ├── CompanySettingsContext  # Firmen-Einstellungen
│   │   ├── SuperAdminContext       # "Als Firma anzeigen"-Modus
│   │   ├── PlanContext.tsx         # Tarif-Gating
│   │   ├── ThemeContext            # Dark/Light
│   │   └── ToastContext            # Notifications
│   ├── components/                 # 40+ wiederverwendbare Komponenten
│   ├── pages/                      # 25+ Seiten (eine pro Feature)
│   ├── hooks/                      # Custom Hooks (DB, Documents, Fahrtenbuch)
│   ├── lib/                        # Supabase-Client, API
│   ├── types/                      # TypeScript-Typdefinitionen
│   └── utils/                      # 30+ Utilities (PDF, Excel, Planning, etc.)
├── supabase/
│   ├── functions/                  # 7 Edge Functions (Deno)
│   └── migrations/                 # 120+ SQL-Migrationen
└── backend/                        # Legacy PHP-Backend (nicht aktiv)
```

---

## 11. Sicherheits-Features

- **Row Level Security (RLS)** auf allen Tabellen — Firmenisolation
- **SECURITY DEFINER Functions** für privilegierte Operationen
- **Session-Timeout** — 20 Min Inaktivität → Auto-Logout
- **Must-Change-Password** — erzwungener Passwortwechsel bei Einladung
- **Company Approval Flow** — Registrierung muss freigeschaltet werden
- **Subscription Guard** — kein Zugriff ohne aktives Abo
- **Plan-Gating** — Features nur im gebuchten Tarif
- **Company Status Gates** — suspended / inactive / deleted blockieren Login

---

## 12. User-Flows

### 12.1 Registrierung (Neue Firma)
```
Signup → Company erstellt (status=trial, approval=pending)
       → Super Admin sieht Pending-Anfrage
       → Freischaltung (approval=approved) ODER Ablehnung (approval=rejected)
       → Nutzer kann einloggen → Trial-Premium → Abo aktivieren
```

### 12.2 Login
```
Email/Password → Supabase Auth
              → Profile laden
              → Block-Reason prüfen (inactive/suspended/company_status)
              → Approval-Gate (pending/rejected/suspended)
              → Must-Change-Password?
              → Subscription aktiv?
              → Plan-Gate → Feature-Zugriff
```

### 12.3 Super Admin
```
Login → /super-admin → Plattform-Übersicht
                     → Freischaltungen verwalten
                     → Unternehmen verwalten (Status, Tarif, Limits)
                     → Abos & Zahlungen
                     → Rabatt-/Empfehlungs-/Aktivierungscodes
                     → "Als Firma öffnen" → Firmen-Sicht
```
