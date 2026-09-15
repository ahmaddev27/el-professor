# Interface audit (Phase 2.1)

What the current El-Professor screens get wrong, in order of priority, so that Phase 5 can fix them batch by batch with the design system from Phase 2.2. The visual direction and the prototype for approval are described in [`../README.md`](../README.md).

## Method

- **Where:** staging (`https://app.elprofessor.eu`) on 15.09.2026, running the `staging` branch this work is based on.
- **As whom:** signed in once as the admin of **E2E Test GmbH**, the test company of the end-to-end kit, in its premium trial and without business data. The run only navigated: nothing was typed into a form or saved. Most screens therefore show their empty state.
- **What:** 24 screens (4 public: landing page, Anmelden, Registrierung, Passwort vergessen; 20 company screens) at 375, 768 and 1280 px in the default dark theme, plus Übersicht, Belege, Fahrzeuge and Gehälter in the light theme at 375 and 1280 px. The 80 screenshots are in [`screens/`](screens/), named `{screen}-{width}[-hell].webp` and cut off at 2,400 px.
- **Measured on every capture:** horizontal overflow, page height, headings and landmarks, and on phones the controls smaller than 44 px. axe-core 4.10 (WCAG 2.0 and 2.1, levels A and AA) ran on every screen at 1280 px.
- **Counted in the source** under `src/`, leaving out the new `components/ui` and `design-preview`: inline style objects, hard-coded colours, hand-built tables and overlays, spinners.
- **Not covered:** the platform panel (`/super-admin`; the end-to-end kit has no platform login), dialogs and multi-step flows (Fahrtenbuch import, Monatsplanung, the historical wizards), and screens holding a real company's volume of data.

A full-page capture ends the fixed sidebar at the height of the first screen. That comes from how the screenshot is stitched and is not a defect.

**P1:** wrong, misleading or unusable for someone (a product rule broken, content off the screen, a WCAG A or AA failure). **P2:** inconsistent or harder to use on many screens; goes away as screens move onto the design system. **P3:** polish.

## Summary

| # | Finding | Priority | Where | Answer in the design system |
|---|---|---|---|---|
| 1 | [Figures with a US decimal point](#1-figures-with-a-us-decimal-point) | P1 | Übersicht, Bargeldbestand, landing page | `formatPercent`, `formatEuro` |
| 2 | [Content wider than the screen](#2-content-wider-than-the-screen) | P1 | 8 screens | `PageHeader`, wrapping filter rows, `DataTable` |
| 3 | [Buttons without an accessible name](#3-buttons-without-an-accessible-name) | P1 | every company screen | labelled icon buttons, `Tooltip` |
| 4 | [Form fields without a label](#4-form-fields-without-a-label) | P1 | 10 screens | `Field` |
| 5 | [Text below AA contrast](#5-text-below-aa-contrast) | P1 | 21 of 24 screens | tokens held to AA by a build test |
| 6 | [A debug box on Fixkosten](#6-a-debug-box-on-fixkosten) | P1 | Fixkosten | remove it |
| 7 | [Settings for mail nobody sends](#7-settings-for-mail-nobody-sends) | P1 | Benachrichtigungen | product decision first |
| 8 | [The staging banner covers the sidebar](#8-the-staging-banner-covers-the-sidebar) | P2 | every company screen on staging | `AppShell` sits below the banner |
| 9 | [No single accent colour](#9-no-single-accent-colour) | P2 | every screen | one `brand` colour |
| 10 | [Every screen builds its own header](#10-every-screen-builds-its-own-header) | P2 | 9 screens | `PageHeader` |
| 11 | [Tables built by hand](#11-tables-built-by-hand) | P2 | 88 tables | `DataTable` |
| 12 | [Overlays and dialogs built by hand](#12-overlays-and-dialogs-built-by-hand) | P2 | 57 overlays, 6 native dialogs | `Dialog`, `Sheet` |
| 13 | [Waiting shows a spinner](#13-waiting-shows-a-spinner) | P2 | 94 spinners | `Skeleton`, loading states |
| 14 | [Übersicht shows everything at once](#14-übersicht-shows-everything-at-once) | P2 | Übersicht | `KpiCard`, the prototype dashboard |
| 15 | [Small touch targets on phones](#15-small-touch-targets-on-phones) | P2 | every company screen | larger controls on touch screens |
| 16 | [Navigation](#16-navigation) | P2 | sidebar, top bar | `AppShell` |
| 17 | [Type](#17-type) | P2 | every screen | Barlow, tabular figures |
| 18 | [Status messages that contradict each other](#18-status-messages-that-contradict-each-other) | P2 | trial banner, Übersicht, Abonnement | one status line |
| 19 | [Mixed language and fixed German](#19-mixed-language-and-fixed-german) | P3 | Umsätze, trial banner | dictionaries |
| 20 | [Einstellungen is one long form](#20-einstellungen-is-one-long-form) | P3 | Einstellungen | sections, `Field` hints |
| 21 | [Headings and landmarks](#21-headings-and-landmarks) | P3 | 4 company screens, public pages | `PageHeader`, `AppShell` |
| 22 | [Sign-in and landing page](#22-sign-in-and-landing-page) | P3 | Anmelden, landing page | Phase 1, a separate decision |

## P1

### 1. Figures with a US decimal point

Übersicht shows **`0.0%`** as Gewinnmarge and **`0.0% Marge`** under Firmengewinn, and writes the change against the previous month the same way. `OverviewPage.tsx` builds these with `toFixed(1)` followed by `%` (lines 56, 543 and 795; lines 864 and 956 do the same without decimals). Bargeldbestand writes its three totals and every transaction as **`0.00 €`** (`BargeldbestandPage.tsx` lines 221, 234, 255 and 363), and its Excel export column the same way (lines 160 and 164). Every figure in the product is meant to read the German way, `0,0 %` and `0,00 €`, as Übersicht, Belege, Umsätze, Fixkosten and Gehälter already write their euro amounts. The landing page advertises `99.9%` uptime (`LandingPage.tsx:919`).

Each is a one-line change and could ship before Phase 5. Design system: `formatPercent` and `formatEuro` in `src/components/ui/format.ts`.
Screenshots: [uebersicht-1280](screens/uebersicht-1280.webp), [bargeldbestand-375](screens/bargeldbestand-375.webp).

### 2. Content wider than the screen

| Screen | Width | Wider by | What runs off |
|---|---|---|---|
| Abrechnung | 375 px | 133 px | the four filter selects stay on one row |
| Gehälter | 375 px | 62 px | the header card: "Gesamt Fällig" and its amount hang off the right edge |
| Benutzer | 375 px | 30 px | the "Benutzerverwaltung" title in the header card |
| Fixkosten | 375 px | 18 px | the "Excel" button sits outside the header card |
| Werkstatt | 375 px | 11 px | "Heute" beside the month switcher; "Neuer Check" wraps onto two lines |
| Notizen | 375 px | 4 px | |
| Belege | 768 px | 18 px | "Zusammenfassung PDF" in the filter row, while the search field shrinks to its icon |
| Umsätze | 375 px | 5 px | the total in the header card |
| Umsätze | 1280 px | 32 px | the filter row: "Excel" is cut off at the card edge |

On a phone the whole page can be dragged sideways; on a laptop Umsätze hides half of its export button.
Screenshots: [abrechnung-375](screens/abrechnung-375.webp), [gehaelter-375](screens/gehaelter-375.webp), [benutzer-375](screens/benutzer-375.webp), [fixkosten-375](screens/fixkosten-375.webp), [werkstatt-375](screens/werkstatt-375.webp), [belege-768](screens/belege-768.webp), [umsaetze-375](screens/umsaetze-375.webp), [umsaetze-1280](screens/umsaetze-1280.webp).

### 3. Buttons without an accessible name

axe reports `button-name` (critical) on every company screen. The one on every screen is the close button of the trial banner (`TrialBanner.tsx:56`): an icon without a label, about 17 px square. On phones and tablets the menu button (`Sidebar.tsx:178`) has no name either. Benachrichtigungen adds five unnamed switches, Benutzer and Stundennachweis one unnamed icon button each. A screen-reader user hears "button" and nothing more (WCAG 4.1.2).

Design system: every icon button carries an `aria-label`, and `Tooltip` shows the same words on hover and keyboard focus.

### 4. Form fields without a label

axe `label` and `select-name` (critical). Einstellungen has 20 fields whose visible labels are not connected to them. Abrechnung has 4 unnamed selects, Stundennachweis 3, Bargeldbestand 2 selects and 3 fields, Werkstatt and Notizen one select each, Belege one select and one field. Übersicht, Mein Konto, Registrierung and the landing page have one unnamed field each. A screen reader announces a field without saying what it is for, and clicking a label does not put the cursor in its field (WCAG 1.3.1, 4.1.2).

Design system: `Field` connects the label, the hint and the error message to its control.

### 5. Text below AA contrast

axe `color-contrast` (serious) on 21 of the 24 screens: every company screen and the landing page, from 5 elements on Monatsplanung and Stundennachweis to 51 on Übersicht (57 in the light theme) and 61 on the landing page. Anmelden, Registrierung and Passwort vergessen pass. The legacy colour for captions and secondary labels fails in both themes:

| Pair | Contrast | AA for text |
|---|---|---|
| `--text-tertiary` #64748B on `--bg-surface` #111827 (dark) | 3.73:1 | 4.5:1 |
| `--text-tertiary` #9CA3AF on white (light) | 2.54:1 | 4.5:1 |

Design system: `src/components/ui/tokens.contrast.test.ts` checks every colour pair the components render, in both themes, as part of the build.

### 6. A debug box on Fixkosten

Fixkosten shows the signed-in user a box reading "Benutzerinfo: e2e-admin@example.com | Rolle: admin | Kann bearbeiten: Ja". It is developer output: it tells the office nothing it needs, puts the e-mail address on a screen others may see, and on a phone takes the space above the list.
Screenshot: [fixkosten-375](screens/fixkosten-375.webp).

### 7. Settings for mail nobody sends

Benachrichtigungen lets a company switch four e-mail notifications on and off and closes with "Für TÜV-Benachrichtigungen wird täglich geprüft ob Fahrzeuge betroffen sind." No code reads these settings and no job sends anything (CLAUDE.md, "Nothing sends a notification"). A fleet owner who relies on the screen misses a TÜV date. This needs a product decision, building the sender or marking the screen as not active yet, before the screen gets the new design.
Screenshot: [benachrichtigungen-1280](screens/benachrichtigungen-1280.webp).

## P2

### 8. The staging banner covers the sidebar

On staging the orange environment banner is fixed over the top 28 px. `EnvironmentBanner` pads the page body, but the fixed sidebar ignores that padding, so the company name at the top of the sidebar and, on phones, the menu button (fixed 12 px from the top) sit under the banner. Production has no banner, but staging is where every change is checked and where this work is approved.

Design system: `AppShell` and `Sheet` place themselves below `--env-banner-height`, which `EnvironmentBanner` now sets.

### 9. No single accent colour

The dark theme's accent is cyan #06B6D4 and the light theme's is blue #2563EB; neither is the brand blue #146BFF, so the product changes its main colour when the theme changes. Screens then pick their own: green for "Beleg hinzufügen", "Excel" and "Neue Einnahme hinzufügen", amber for "Neuer Check" on Werkstatt, purple for "Historischen Abgleich starten" on Monatsplanung, a cyan-to-blue gradient on the sign-in and sign-up buttons, and three different colours for the three plans on Registrierung. Belege puts a green and a cyan main button side by side. The source holds 3,234 hard-coded colour values and 5,377 inline style objects across 133 files; `HistoricalWorkingHoursWizard.tsx` alone has 1,150 inline style objects.

Design system: one `brand` colour for actions, links and the current page; green, amber and red only for a status.
Screenshots: [belege-1280](screens/belege-1280.webp), [monatsplanung-1280](screens/monatsplanung-1280.webp), [registrierung-375](screens/registrierung-375.webp).

### 10. Every screen builds its own header

Umsätze, Fixkosten, Gehälter, Benutzer and Einstellungen open with a large gradient card that repeats the page title ("Umsätze" above "Umsätze hinzufügen", "Fixkosten" above "Fixkosten"). Werkstatt uses an icon block, Belege, Fahrzeuge, Monatsplanung and Abonnement a plain title. The main action moves between the header, the card and a full-width bar below it (Umsätze, Fixkosten), and Fahrzeuge names the same action "Neues Fahrzeug" in the header and "Fahrzeug hinzufügen" in the empty state.

Design system: `PageHeader` with a title, one line of description and the actions on the right, the main one last.
Screenshots: [umsaetze-1280](screens/umsaetze-1280.webp), [fahrzeuge-1280](screens/fahrzeuge-1280.webp), [einstellungen-1280](screens/einstellungen-1280.webp).

### 11. Tables built by hand

88 `<table>` elements, each styled on its own. On Belege the header row is a separate card from the rows, columns past the card edge are cut off without a sign that the table scrolls, and the scroll area cannot be reached with the keyboard (axe `scrollable-region-focusable` on Belege and Gehälter). Amounts use proportional figures, so a column of euro values does not line up.

Design system: `DataTable`, with sortable columns, a header that stays in view, right-aligned German amounts in tabular figures, loading, empty and error states, and a scroll area reachable with the keyboard.

### 12. Overlays and dialogs built by hand

57 overlays are built by hand (`fixed inset-0`), and 6 messages use the browser's own dialogs: five `alert()` calls in `HistoricalWorkingHoursWizard.tsx` and one `confirm()` in `ReferralCodesManagement.tsx`. Keeping keyboard focus inside, closing with Escape, stopping the page behind from scrolling and returning focus afterwards depend on each implementation, and the browser dialogs cannot take the product's look.

Design system: `Dialog` and `Sheet` on Radix, which handle all four.

### 13. Waiting shows a spinner

The source has 94 spinners. Moving between screens replaces the content with "Wird geladen…" until the data is in: in the first capture pass, 13 of the 80 screenshots still showed a spinner after the network had gone quiet and another 1.5 seconds had passed, and had to be taken again with a wait of up to 30 seconds. Plan-dependent items also appear in the sidebar only once the plan has loaded, so the navigation changes length after the screen is shown.

Design system: `Skeleton` in the shape of the content; `DataTable` and `KpiCard` have loading states.

### 14. Übersicht shows everything at once

2,409 px tall on a laptop and 4,397 px on a phone: a trial card, six key-figure tiles and ten panels (6-Monats-Trend, Einnahmen-Mix, Gewinnberechnung, Bargeld-Übersicht, Fahrer-Performance, Ranking, Größte Ausgaben, Flottenstatus, Letzte Belege, Schnellaktionen). The uppercase tile labels run into their icons at 375 and 1280 px ("GESAMTKOSTEN", "FIRMENGEWINN", "GEWINNMARGE"). Without data the chart labels every axis step "0k", and half of the panels are empty boxes. The page is 1,231 lines of code.

Design system: the prototype's Übersicht, with four key figures, one chart that also opens as a table, a short "Handlungsbedarf" list linking to the screen that resolves each item, open salaries and the fleet's TÜV status.
Screenshots: [uebersicht-1280](screens/uebersicht-1280.webp), [uebersicht-375](screens/uebersicht-375.webp), [uebersicht-1280-hell](screens/uebersicht-1280-hell.webp).

### 15. Small touch targets on phones

Every company screen has 25 to 54 controls smaller than 44 px on a phone (Einstellungen 54, Umsätze 37, Werkstatt 35, Mein Konto 34, Benachrichtigungen and Rollen 33). The trial banner's close button is 17 px, below even the 24 px minimum of WCAG 2.2 (2.5.8).

Design system: buttons, fields, selects, tabs and navigation links grow to 40 to 44 px on touch screens, and fields use 16 px text there so iOS does not zoom into the page when one is tapped.

### 16. Navigation

The sidebar is one list of fourteen items with a single group label ("VERWALTUNG") before the admin items; at 1280×800 Rollen, Abonnement and Einstellungen sit below the visible part of the sidebar. The top bar holds a theme button on the left and language and account on the right, with no company name or plan. On a phone the staging banner, the trial banner and the top bar stack up to about 160 px before any content.

Design system: `AppShell`, with the same items and names grouped into Betrieb, Finanzen, Planung & Dokumente and Verwaltung, folding to icons on a laptop and opening as a drawer on a phone, and the company name and plan in the top bar.
Screenshots: [belege-1280](screens/belege-1280.webp), [abrechnung-375](screens/abrechnung-375.webp).

### 17. Type

Every screen uses the operating system's default font (`ui-sans-serif, system-ui`), so the product looks different on Windows, macOS and Android, and its figures are proportional. Small uppercase labels with wide spacing are used for key-figure tiles, table headers, section titles and the sign-in form ("E-MAIL-ADRESSE"); at that size they read harder than sentence case.

Design system: Barlow, served from our own server, sentence-case labels, tabular figures for amounts.

### 18. Status messages that contradict each other

The test company is in its trial and also has an active subscription, and the screens say both without reconciling them: every screen carries "Testphase aktiv" with the days left, while Abonnement says "Aktiv bis 14. September 2036". Übersicht repeats the trial message in a card of its own with a second "Plan wählen" button, and the banner's "Plan wählen" opens an e-mail draft instead of the plan screen.
Screenshots: [abonnement-1280](screens/abonnement-1280.webp), [uebersicht-1280](screens/uebersicht-1280.webp).

## P3

### 19. Mixed language and fixed German

Umsätze explains its entry types as "Bargeld (Cash), Umsatz (Revenue) und Trinkgeld (Tips)". The expired-trial banner hard-codes "Plan wählen" (`TrialBanner.tsx:87`), where the active-trial banner takes it from the dictionary.

### 20. Einstellungen is one long form

3,142 px on a laptop with a single "Speichern" at the very bottom, and a "Vorschau" column that shows only the company name. The format examples `DE123456789`, `HRB 12345` and `COBADEFFXXX` are placeholders in a grey close to entered text, so an empty field can look filled in.
Screenshot: [einstellungen-1280](screens/einstellungen-1280.webp).

### 21. Headings and landmarks

Belege, Fahrzeuge, Rollen and Mein Konto style their title as a heading without making it an `h1`, so a screen-reader user cannot jump to it. Anmelden, Registrierung, Passwort vergessen and the landing page have no `main` landmark.

Design system: `PageHeader` renders the `h1`; `AppShell` renders `main` and a "Zum Inhalt springen" link.

### 22. Sign-in and landing page

Anmelden still offers "Mit Google anmelden", which Phase 1 removes, and its footer says "© 2025". The landing page is 9,256 px long, uses gradient text in its headlines and states figures in US format (`99.9%`, finding 1). It is not in any Phase 5 batch and needs a decision of its own.
Screenshots: [login-1280](screens/login-1280.webp), [landing-1280](screens/landing-1280.webp).

## What already works

- The public pages fit every width, and so do 13 of the 20 company screens on a phone.
- Every company screen has `main` and `nav` landmarks, marks the current navigation item and offers the language switch.
- Most lists have an empty state with words, and some with a create button ("Keine Fahrzeuge vorhanden").
- Date fields show `TT.MM.JJJJ` in a German browser, and Übersicht, Belege, Umsätze, Fixkosten and Gehälter write euro amounts the German way.

## Screens

| Screen | Route | 375 px | 768 px | 1280 px | Light |
|---|---|---|---|---|---|
| Landing page | `/` | [375](screens/landing-375.webp) | [768](screens/landing-768.webp) | [1280](screens/landing-1280.webp) | |
| Anmelden | `/login` | [375](screens/login-375.webp) | [768](screens/login-768.webp) | [1280](screens/login-1280.webp) | |
| Registrierung | `/signup` | [375](screens/registrierung-375.webp) | [768](screens/registrierung-768.webp) | [1280](screens/registrierung-1280.webp) | |
| Passwort vergessen | `/auth/forgot-password` | [375](screens/passwort-vergessen-375.webp) | [768](screens/passwort-vergessen-768.webp) | [1280](screens/passwort-vergessen-1280.webp) | |
| Übersicht | `/overview` | [375](screens/uebersicht-375.webp) | [768](screens/uebersicht-768.webp) | [1280](screens/uebersicht-1280.webp) | [375](screens/uebersicht-375-hell.webp), [1280](screens/uebersicht-1280-hell.webp) |
| Belege | `/belege` | [375](screens/belege-375.webp) | [768](screens/belege-768.webp) | [1280](screens/belege-1280.webp) | [375](screens/belege-375-hell.webp), [1280](screens/belege-1280-hell.webp) |
| Fahrer | `/fahrer` | [375](screens/fahrer-375.webp) | [768](screens/fahrer-768.webp) | [1280](screens/fahrer-1280.webp) | |
| Fahrzeuge | `/cars` | [375](screens/fahrzeuge-375.webp) | [768](screens/fahrzeuge-768.webp) | [1280](screens/fahrzeuge-1280.webp) | [375](screens/fahrzeuge-375-hell.webp), [1280](screens/fahrzeuge-1280-hell.webp) |
| Umsätze | `/umsaetze` | [375](screens/umsaetze-375.webp) | [768](screens/umsaetze-768.webp) | [1280](screens/umsaetze-1280.webp) | |
| Fixkosten | `/fixkosten` | [375](screens/fixkosten-375.webp) | [768](screens/fixkosten-768.webp) | [1280](screens/fixkosten-1280.webp) | |
| Bargeldbestand | `/bargeldbestand` | [375](screens/bargeldbestand-375.webp) | [768](screens/bargeldbestand-768.webp) | [1280](screens/bargeldbestand-1280.webp) | |
| Werkstatt | `/werkstatt` | [375](screens/werkstatt-375.webp) | [768](screens/werkstatt-768.webp) | [1280](screens/werkstatt-1280.webp) | |
| Abrechnung | `/abrechnung` | [375](screens/abrechnung-375.webp) | [768](screens/abrechnung-768.webp) | [1280](screens/abrechnung-1280.webp) | |
| Notizen | `/notes` | [375](screens/notizen-375.webp) | [768](screens/notizen-768.webp) | [1280](screens/notizen-1280.webp) | |
| Benachrichtigungen | `/benachrichtigungen` | [375](screens/benachrichtigungen-375.webp) | [768](screens/benachrichtigungen-768.webp) | [1280](screens/benachrichtigungen-1280.webp) | |
| Gehälter | `/salaries` | [375](screens/gehaelter-375.webp) | [768](screens/gehaelter-768.webp) | [1280](screens/gehaelter-1280.webp) | [375](screens/gehaelter-375-hell.webp), [1280](screens/gehaelter-1280-hell.webp) |
| Dokumente | `/dokumente` | [375](screens/dokumente-375.webp) | [768](screens/dokumente-768.webp) | [1280](screens/dokumente-1280.webp) | |
| Stundennachweis | `/stundennachweis` | [375](screens/stundennachweis-375.webp) | [768](screens/stundennachweis-768.webp) | [1280](screens/stundennachweis-1280.webp) | |
| Monatsplanung | `/company-planner` | [375](screens/monatsplanung-375.webp) | [768](screens/monatsplanung-768.webp) | [1280](screens/monatsplanung-1280.webp) | |
| Benutzer | `/users` | [375](screens/benutzer-375.webp) | [768](screens/benutzer-768.webp) | [1280](screens/benutzer-1280.webp) | |
| Rollen | `/roles` | [375](screens/rollen-375.webp) | [768](screens/rollen-768.webp) | [1280](screens/rollen-1280.webp) | |
| Abonnement | `/billing` | [375](screens/abonnement-375.webp) | [768](screens/abonnement-768.webp) | [1280](screens/abonnement-1280.webp) | |
| Einstellungen | `/settings` | [375](screens/einstellungen-375.webp) | [768](screens/einstellungen-768.webp) | [1280](screens/einstellungen-1280.webp) | |
| Mein Konto | `/mein-konto` | [375](screens/mein-konto-375.webp) | [768](screens/mein-konto-768.webp) | [1280](screens/mein-konto-1280.webp) | |
