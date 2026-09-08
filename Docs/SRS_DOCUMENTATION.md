# Software Requirements Specification (SRS)
# El-Professor — Taxi & Mietwagen Verwaltungsplattform

> **Version:** 1.0 · **Datum:** September 2026  
> **Status:** In Entwicklung  
> **Plattform-Typ:** Multi-Tenant SaaS

---

## 1. Einleitung

### 1.1 Zweck
Dieses Dokument definiert die funktionalen und nicht-funktionalen Anforderungen an die El-Professor-Plattform — eine Cloud-basierte Verwaltungslösung für Taxi- und Mietwagenunternehmen in Deutschland.

### 1.2 Umfang
Die Plattform bietet:
- Firmen-Verwaltung mit isolierten Daten pro Tenant
- Fahrer-, Fahrzeug-, Beleg- und Umsatzverwaltung
- Gehaltsabrechnung und Zahlungsverfolgung
- Dokumentengenerierung (Rechnungen, Aufträge, Quittungen)
- Stundennachweise mit Fahrtenbuch-Integration
- Monatsplanung mit 5-Phasen-Engine
- Super Admin Dashboard für Plattum-Kontrolle
- Tarif-basiertes Feature-Gating (Basic / Advanced / Premium)

### 1.3 Definitionen
| Begriff | Definition |
|---------|-----------|
| Tenant | Eine Firma (Company) auf der Plattform |
| Super Admin | Plattform-Administrator mit Vollzugriff |
| Admin | Firmen-Administrator |
| Creator | Nutzer mit Erstellungsberechtigung |
| Viewer | Nutzer mit Lesezugriff |
| Trial | Testphase mit Premium-Features |
| RLS | Row Level Security (PostgreSQL) |
| Edge Function | Serverless Function (Deno Runtime) |

---

## 2. Gesamtbeschreibung

### 2.1 Produkt-Perspektive
El-Professor ist eine eigenständige Web-Applikation (SPA), die direkt im Browser läuft. Das Backend besteht aus Supabase (PostgreSQL, Auth, Edge Functions, Storage). Es gibt keine externe API außer Supabase.

### 2.2 Benutzerklassen

| Klasse | Beschreibung | Zugriff |
|--------|-------------|---------|
| Super Admin | Plattform-Betreiber | Alle Firmen, Abos, Codes, Statistiken |
| Admin | Firmen-Besitzer / -Verwalter | Eigene Firma: Benutzer, Rollen, Einstellungen |
| Creator | Mitarbeiter mit Schreibrechten | Eigene Firma: Daten erfassen & bearbeiten |
| Viewer | Mitarbeiter mit Leserechten | Eigene Firma: Daten ansehen |

### 2.3 Betriebsbedingungen
- **Browser:** Moderne Browser (Chrome, Firefox, Safari, Edge)
- **Geräte:** Desktop (primär), Tablet (sekundär), Mobile (eingeschränkt)
- **Sprache:** Deutsch (UI), deutsche Datumsformate
- **Verfügbarkeit:** 24/7 (abhängig von Supabase Uptime)

---

## 3. Funktionale Anforderungen

### 3.1 Authentifizierung & Autorisierung

#### REQ-AUTH-01: Login
- **Beschreibung:** Nutzer können sich mit E-Mail und Passwort einloggen.
- **Eingabe:** E-Mail, Passwort
- **Verarbeitung:** Supabase Auth validiert Credentials → Profil laden → Block-Reason prüfen
- **Ausgabe:** Session-Token oder Fehlermeldung

#### REQ-AUTH-02: Google OAuth
- **Beschreibung:** Login via Google-Konto.
- **Verarbeitung:** OAuth-Redirect zu Google → Callback → Profil laden

#### REQ-AUTH-03: Registrierung (Firma)
- **Beschreibung:** Neue Firmen registrieren sich mit Firmenname, E-Mail, Passwort.
- **Verarbeitung:** Supabase Auth → `company-signup` Edge Function → Company-Datensatz (status=trial, approval=pending)
- **Ausgabe:** Pending-Seite ("Registrierung wird geprüft")

#### REQ-AUTH-04: Passwort vergessen
- **Beschreibung:** Reset-Link via E-Mail.
- **Verarbeitung:** Supabase Auth sendet Reset-Mail → `/auth/set-password`

#### REQ-AUTH-05: Passwort ändern (erzwungen)
- **Beschreibung:** Bei `must_change_password=true` wird der Nutzer zur Passwortänderung gezwungen.
- **Bedingung:** Alle Routen außer `/set-new-password` werden blockiert.

#### REQ-AUTH-06: Session-Timeout
- **Beschreibung:** Nach 20 Minuten Inaktivität wird der Nutzer automatisch abgemeldet.
- **Verarbeitung:** `localStorage` Tracking + `setTimeout` → Auto-Logout

#### REQ-AUTH-07: Block-Reason-Prüfung
- **Beschreibung:** Beim Login wird Nutzer- und Firmen-Status geprüft.
- **Block-Gründe:**
  - `user_inactive` — Konto deaktiviert
  - `user_suspended` — Konto gesperrt
  - `user_deactivated` — Konto entfernt
  - `company_suspended` — Firma gesperrt
  - `company_inactive` — Firma inaktiv
  - `company_deleted` — Firma gelöscht
  - `company_pending` — Freischaltung ausstehend
  - `company_rejected` — Registrierung abgelehnt

---

### 3.2 Firmen-Verwaltung (Super Admin)

#### REQ-COMP-01: Freischaltung
- **Beschreibung:** Super Admin kann ausstehende Registrierungen freischalten oder ablehnen.
- **Aktionen:** Freischalten (approval=approved), Ablehnen (approval=rejected + Grund), Sperren (approval=suspended)

#### REQ-COMP-02: Status-Verwaltung
- **Beschreibung:** Super Admin kann Firmen-Status ändern.
- **Status:** active, trial, suspended, inactive, archived, deleted

#### REQ-COMP-03: Tarif-Verwaltung
- **Beschreibung:** Super Admin kann Tarif pro Firma ändern (basic / advanced / premium).

#### REQ-COMP-04: Abrechnungszyklus
- **Beschreibung:** Super Admin kann monatlich/jährlich umschalten.

#### REQ-COMP-05: Fahrzeuglimit
- **Beschreibung:** Super Admin kann das Fahrzeuglimit pro Firma festlegen (1–200).

#### REQ-COMP-06: Trial-Verlängerung
- **Beschreibung:** Super Admin kann Trial um 7 Tage verlängern.

#### REQ-COMP-07: "Als Firma öffnen"
- **Beschreibung:** Super Admin kann in die Sicht einer beliebigen Firma wechseln.
- **Verarbeitung:** `SuperAdminContext` setzt `activeCompanyId` → alle Queries nutzen diese ID

#### REQ-COMP-08: Plattform-KPIs
- **Beschreibung:** Dashboard zeigt: Unternehmen gesamt, Benutzer, Fahrer, Belege, Trials, Status-Verteilung, Plan-Verteilung.

---

### 3.3 Benutzer-Verwaltung

#### REQ-USER-01: Benutzer einladen
- **Beschreibung:** Admin kann neue Benutzer einladen mit temporärem Passwort.
- **Verarbeitung:** `manage-users` Edge Function → Profil + Auth-User → `must_change_password=true`

#### REQ-USER-02: Benutzer bearbeiten
- **Beschreibung:** Admin kann Name, Rolle, Status ändern.

#### REQ-USER-03: Benutzer deaktivieren
- **Beschreibung:** Admin kann Benutzer auf `inactive` oder `suspended` setzen.

#### REQ-USER-04: Benutzer-Status
- **Beschreibung:** Status-Modell: active, inactive, pending_invite, suspended, deactivated

---

### 3.4 Rollen-Verwaltung

#### REQ-ROLE-01: Custom Rollen
- **Beschreibung:** Admin kann benutzerdefinierte Rollen erstellen.

#### REQ-ROLE-02: Seiten-Berechtigungen
- **Beschreibung:** Pro Rolle und Seite: `can_view` und `can_edit` setzen.

#### REQ-ROLE-03: System-Rollen
- **Beschreibung:** System-Rollen (admin, creator, viewer) sind nicht löschbar.

---

### 3.5 Fahrer-Verwaltung

#### REQ-DRIVER-01: Fahrer anlegen
- **Felder:** Name, Geschlecht, Beschäftigungstyp, Gehaltsbereich, Status

#### REQ-DRIVER-02: Fahrer-Status
- **Status:** active, inactive

#### REQ-DRIVER-03: Verfügbarkeit & Schichtfenster
- **Felder:** Verfügbarkeit pro Wochentag, Schicht-Start/Ende, Full-Day-Verfügbarkeit, `can_cover_other_drivers`

#### REQ-DRIVER-04: Fahrer-Notizen
- **Beschreibung:** Notizen mit Datumsbereich und Planungs-Flags (Urlaub, Krankheit, etc.)

---

### 3.6 Fahrzeug-Verwaltung

#### REQ-CAR-01: Fahrzeug anlegen
- **Felder:** Kennzeichen, Marke, Modell, TÜV-Termine, Status

#### REQ-CAR-02: Werkstatt-Checks
- **Beschreibung:** Prüf-Checklisten pro Fahrzeug mit KM-Stand (Pflichtfeld).

#### REQ-CAR-03: TÜV-Verfolgung
- **Beschreibung:** TÜV-Termine werden getrackt und bei Nähe gewarnt.

---

### 3.7 Beleg-Verwaltung

#### REQ-RECEIPT-01: Beleg erfassen
- **Beschreibung:** Foto-Upload + manuelle Daten.
- **Felder:** Datum, Betrag, Kategorie, Beschäftigt, Foto

#### REQ-RECEIPT-02: OCR-Extraktion
- **Beschreibung:** Automatische Texterkennung aus Beleg-Fotos.
- **Verarbeitung:** `extract-receipt` Edge Function (Tesseract.js)

#### REQ-RECEIPT-03: Beleg-Statistiken
- **Beschreibung:** Übersicht mit Summen, Kategorien und Zeitraum-Filter.

---

### 3.8 Umsatz-Verwaltung

#### REQ-INCOME-01: Wöchentliche Erfassung
- **Felder:** Woche, Betrag, Trip-Count, Fahrtenbuch-Quelle

#### REQ-INCOME-02: Wochen-Berechnung
- **Beschreibung:** Wochen werden Montag–Sonntag berechnet.

---

### 3.9 Fixkosten

#### REQ-FIX-01: Fixkosten verwalten
- **Beschreibung:** Wiederkehrende Kosten pro Firma mit Kategorie und Betrag.

---

### 3.10 Bargeldbestand

#### REQ-CASH-01: Transaktionen
- **Beschreibung:** Ein- und Auszahlungen mit automatischer Saldo-Neuberechnung (DB-Trigger).

---

### 3.11 Abrechnung

#### REQ-ABR-01: Wöchentliche Abrechnung
- **Beschreibung:** Aggregation pro Fahrer & Woche via RPC-Funktionen.

#### REQ-ABR-02: Monatliche Abrechnung
- **Beschreibung:** Aggregation pro Fahrer & Monat.

#### REQ-ABR-03: Steuerberater-Export
- **Beschreibung:** Export im Format für Steuerberater.

---

### 3.12 Gehälter

#### REQ-SAL-01: Gehaltsberechnung
- **Beschreibung:** Monatsabhängige Berechnung mit Brutto/Netto und Payroll-Split.

#### REQ-SAL-02: Zahlungsverwaltung
- **Beschreibung:** Gehalts-Zahlungen mit Status (offen / bezahlt) und Quittungs-PDF.

---

### 3.13 Dokumente

#### REQ-DOC-01: Dokument-Builder
- **Beschreibung:** WYSIWYG-Editor für Dokumente mit Vorlagen.

#### REQ-DOC-02: Vorlagen
- **Beschreibung:** Mietwagenauftrag, Trinkgeld-Quittung, Rechnungen.

#### REQ-DOC-03: PDF-Export
- **Beschreibung:** Dokumente können als PDF exportiert werden.

---

### 3.14 Stundennachweis

#### REQ-STU-01: Stunden erfassen
- **Beschreibung:** Pro Fahrer & Monat mit Fahrtenbuch-Integration.

#### REQ-STU-02: PDF-Export & Storage
- **Beschreibung:** PDF wird generiert und im Supabase Storage gespeichert.

---

### 3.15 Monatsplanung

#### REQ-PLAN-01: 5-Phasen-Engine
- **Phase 1:** Fahrer-Pool & Verfügbarkeit
- **Phase 3:** Zuweisungs-Vorschau
- **Phase 4:** Apply-Tracking
- **Phase 5:** Ausnahmen & Monatslimit

#### REQ-PLAN-02: Planungs-Runs
- **Beschreibung:** Runs können archiviert, ersetzt und purged werden.

#### REQ-PLAN-03: Finalisierung
- **Beschreibung:** Planungen können finalisiert und korrigiert werden.

#### REQ-PLAN-04: Excel-Export
- **Beschreibung:** Export der Planung als XLSX.

---

### 3.16 Tarif-Gating

#### REQ-PLAN-GATE-01: Feature-Sperre
- **Beschreibung:** Features werden basierend auf dem Tarif gesperrt oder freigeschaltet.
- **Basic:** Übersicht, Belege, Fahrer, Fahrzeuge, Umsätze, Fixkosten, Bargeldbestand
- **Advanced:** + Werkstatt, Abrechnung, Notizen, Rollen & Nutzer, Benachrichtigungen
- **Premium:** + Gehälter, Dokumente, Stundennachweis, Monatsplanung

#### REQ-PLAN-GATE-02: Trial-Premium
- **Beschreibung:** Während der Trial-Phase sind alle Premium-Features freigeschaltet.

#### REQ-PLAN-GATE-03: Super Admin Bypass
- **Beschreibung:** Super Admin hat Zugriff auf alle Features unabhängig vom Tarif.

---

### 3.17 Abonnement & Billing

#### REQ-SUB-01: Aktivierung
- **Beschreibung:** Abonnement kann via Aktivierungscode oder manueller Zuweisung aktiviert werden.

#### REQ-SUB-02: Rabattcodes
- **Beschreibung:** Rabattcodes mit Nutzungstracking.

#### REQ-SUB-03: Empfehlungscodes
- **Beschreibung:** Referral-Programm mit Zuordnung zu Firmen.

#### REQ-SUB-04: Bargeld-Abrechnung
- **Beschreibung:** Cash-basierte Abrechnung für Abonnements.

---

### 3.18 Einstellungen

#### REQ-SET-01: Firmen-Stammdaten
- **Felder:** Name, Rechtsform, E-Mail, Telefon, Adresse, PLZ, Stadt, Land

#### REQ-SET-02: Logo-Upload
- **Beschreibung:** Firmen-Logo wird im Supabase Storage gespeichert.

#### REQ-SET-03: Business-Kalender
- **Beschreibung:** Kalender-Logik mit deutschen Feiertagen.

#### REQ-SET-04: Fahrer-pro-Fahrzeug-Limit
- **Beschreibung:** Konfigurierbares Limit pro Firma.

---

### 3.19 Benachrichtigungen

#### REQ-NOTIF-01: Einstellungen
- **Beschreibung:** Pro Firma konfigurierbare Benachrichtigungs-Einstellungen.

---

## 4. Nicht-funktionale Anforderungen

### 4.1 Performance
- **NFR-PERF-01:** Seiten-Ladezeit < 3 Sekunden (First Contentful Paint).
- **NFR-PERF-02:** Tabellen mit > 100 Zeilen müssen virtualisiert oder paginiert sein.
- **NFR-PERF-03:** Auto-Refresh alle 60 Sekunden für Live-Daten (Super Admin Dashboard).

### 4.2 Sicherheit
- **NFR-SEC-01:** Row Level Security (RLS) auf allen Tabellen — keine Daten-Lecks zwischen Tenants.
- **NFR-SEC-02:** SECURITY DEFINER Functions für privilegierte Operationen.
- **NFR-SEC-03:** Session-Timeout nach 20 Minuten Inaktivität.
- **NFR-SEC-04:** Erzwungener Passwortwechsel bei eingeladenen Benutzern.
- **NFR-SEC-05:** Company Approval Flow — keine Nutzung ohne Freischaltung.
- **NFR-SEC-06:** Subscription Guard — kein Zugriff ohne aktives Abo.
- **NFR-SEC-07:** Alle Edge Functions haben CORS-Header konfiguriert.

### 4.3 Verfügbarkeit
- **NFR-AVAIL-01:** Plattform 24/7 verfügbar (abhängig von Supabase Uptime).
- **NFR-AVAIL-02:** Auto-Logout bei Session-Timeout mit Datenbereinigung.

### 4.4 Usability
- **NFR-USA-01:** Responsive Design (Mobile, Tablet, Desktop).
- **NFR-USA-02:** Deutsche UI mit deutschen Datumsformaten.
- **NFR-USA-03:** Dark/Light-Theme via CSS-Variablen.
- **NFR-USA-04:** Konsistente 8px-Abstandssystematik.
- **NFR-USA-05:** Toast-Benachrichtigungen für Erfolg-/Fehler-Meldungen.

### 4.5 Wartbarkeit
- **NFR-MAINT-01:** TypeScript für Type-Safety.
- **NFR-MAINT-02:** Komponenten-basierte Architektur (Single Responsibility).
- **NFR-MAINT-03:** Migration-basierte Schema-Änderungen (Supabase Migrations).

### 4.6 Skalierbarkeit
- **NFR-SCALE-01:** Multi-Tenant-Architektur mit `company_id`-Isolation.
- **NFR-SCALE-02:** DB-Trigger für automatische Berechnungen (z.B. Cash-Balance).
- **NFR-SCALE-03:** RPC-Funktionen für komplexe Aggregationen.

---

## 5. System-Anforderungen

### 5.1 Frontend
- React 18+
- TypeScript 5+
- Vite 5+
- Tailwind CSS 3+
- Moderner Browser mit ES2020+ Support

### 5.2 Backend
- Supabase Projekt (PostgreSQL 15+)
- Supabase Auth (Email/Password + Google OAuth)
- Supabase Edge Functions (Deno Runtime)
- Supabase Storage (Logos, PDFs, Fahrtenbuch-Imports)

### 5.3 Externe Dienste
- Tesseract.js (OCR — Client-seitig oder Edge Function)
- Google OAuth (optional)

---

## 6. Datenmodell (Kern-Entitäten)

```
companies (1) ──< user_profiles (N)
companies (1) ──< drivers (N)
companies (1) ──< cars (N)
companies (1) ──< receipts (N)
companies (1) ──< income (N)
companies (1) ──< fixed_costs (N)
companies (1) ──< cash_transactions (N)
companies (1) ──< salaries (N)
companies (1) ──< company_settings (1)
companies (1) ──< roles (N)
roles (1) ──< role_permissions (N)
roles (1) ──< user_profiles (N)
drivers (1) ──< driver_notes (N)
drivers (1) ──< salaries (N)
drivers (1) ──< salary_payments (N)
drivers (1) ──< saved_stundennachweise (N)
cars (1) ──< werkstatt_checks (N)
companies (1) ──< documents (N)
companies (1) ──< document_templates (N)
companies (1) ──< fahrtenbuch_imports (N)
fahrtenbuch_imports (1) ──< fahrtenbuch_trips (N)
companies (1) ──< company_planning_runs (N)
company_planning_runs (1) ──< planning_finalizations (N)
company_planning_runs (1) ──< planning_run_adjustments (N)
companies (1) ──< discount_codes (N)
companies (1) ──< activation_codes (N)
companies (1) ──< notification_settings (N)
```

---

## 7. Use-Case-Diagramm (Textuell)

### UC-01: Firma registriert sich
**Akteur:** Neuer Nutzer (Firmeninhaber)  
**Vorbedingung:** Kein Konto vorhanden  
**Hauptfluss:**
1. Nutzer öffnet Signup-Seite
2. Gibt Firmenname, E-Mail, Passwort ein
3. System erstellt Auth-User + Company (status=trial, approval=pending)
4. System zeigt "Wartet auf Freischaltung"-Seite

**Alternative:** Ablehnung durch Super Admin → Nutzer sieht Ablehnungs-Seite

### UC-02: Super Admin schaltet Firma frei
**Akteur:** Super Admin  
**Vorbedingung:** Mindestens eine pending-Firma  
**Hauptfluss:**
1. Super Admin öffnet Dashboard → Tab "Freischaltung"
2. Sieht Liste der pending-Firmen
3. Klickt "Freischalten" → Firma wird auf approval=approved gesetzt
4. Nutzer der Firma kann einloggen

### UC-03: Admin lädt Benutzer ein
**Akteur:** Admin  
**Vorbedingung:** Angemeldet, Firma freigeschaltet  
**Hauptfluss:**
1. Admin öffnet Benutzer-Seite
2. Klickt "Einladen"
3. Gibt E-Mail, Name, Rolle ein
4. System erstellt User via `manage-users` Edge Function
5. Neuer User bekommt `must_change_password=true`

### UC-04: Fahrer-Verwaltung
**Akteur:** Admin / Creator  
**Hauptfluss:**
1. Fahrer-Seite öffnen
2. Fahrer anlegen/bearbeiten (Name, Status, Beschäftigungstyp)
3. Verfügbarkeit & Schichtfenster konfigurieren
4. Notizen mit Datumsbereich hinzufügen

### UC-05: Monatsplanung
**Akteur:** Admin / Creator  
**Hauptfluss:**
1. Monatsplanung-Seite öffnen
2. Phase 1: Fahrer-Pool prüfen
3. Phase 3: Zuweisungs-Vorschau prüfen
4. Phase 4: Planung anwenden
5. Phase 5: Ausnahmen & Limits prüfen
6. Planung finalisieren
7. Als XLSX exportieren

### UC-06: Beleg mit OCR
**Akteur:** Admin / Creator  
**Hauptfluss:**
1. Beleg-Seite öffnen
2. Foto hochladen
3. OCR-Extraktion starten (Edge Function)
4. Extrahierte Daten prüfen/korrigieren
5. Beleg speichern

### UC-07: Gehaltsabrechnung
**Akteur:** Admin  
**Hauptfluss:**
1. Gehälter-Seite öffnen
2. Monat auswählen
3. Gehaltsberechnung prüfen (Brutto/Netto/Payroll-Split)
4. Zahlung erfassen
5. Quittungs-PDF generieren

### UC-08: Super Admin verwaltet Abos
**Akteur:** Super Admin  
**Hauptfluss:**
1. Dashboard → Unternehmen-Tabelle
2. Tarif, Abrechnungszyklus, Fahrzeuglimit ändern
3. Manuelles Abo zuweisen
4. Trial verlängern oder Firma aktivieren

---

## 8. Abhängigkeiten

| Paket | Zweck |
|-------|-------|
| `@supabase/supabase-js` | Supabase Client |
| `react-router-dom` | Routing |
| `lucide-react` | Icons |
| `recharts` | Charts |
| `date-fns` | Datums-Logik |
| `jspdf` + `html2canvas` | PDF-Generierung |
| `xlsx` | Excel-Export |
| `tesseract.js` | OCR (Belege) |

---

## 9. Offene Punkte / Roadmap

1. **Benutzer-Verwaltung im Super Admin Dashboard** — aktuell noch auf Firmenebene, soll zentralisiert werden
2. **Stripe-Integration** — derzeit cash-basierte Abrechnung, Stripe noch nicht konfiguriert
3. **Mobile-App** — derzeit nur Web-App, native App geplant
4. **Mehrsprachigkeit** — derzeit nur Deutsch, Erweiterung auf Englisch geplant
5. **API für Drittanbieter** — derzeit keine öffentliche API
