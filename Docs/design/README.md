# Design (Phase 2)

The redesign of El-Professor, request 4 of the requirements plan. Phase 2 defines the design system and a prototype; **the owner approves the prototype before any existing screen changes.** Phase 3.6 (the `/admin` panel) and Phase 5 (moving the screens across in batches) start after that approval.

## Visual direction, for approval

- **Colours from the brand board.** Dark mode is the board itself: night `#0A0F1C` for the page, `#0C1730` for cards and the sidebar, blue `#146BFF` for actions. Light mode keeps the same blue on a cool grey page (`#F4F6FA`) with white cards. The cyan `#00E7FF` marks keyboard focus in dark mode and is not used as decoration.
- **One accent colour.** Blue means "you can act here" or "you are here". Green, amber and red appear only for a status (TÜV valid, expiring, expired; a salary unpaid), always with a word and an icon, never colour alone.
- **Type:** Barlow, a plain DIN-style typeface close to the tagline on the brand board, served from our own server (no request to Google). Amounts use equal-width figures, so a column of euro values lines up.
- **Calmer screens:** fewer boxes, thin borders, almost no shadow in dark mode. Buttons and fields have 8 px corners; cards, tables and dialogs 12 px; status badges are fully round. Every colour pair meets WCAG AA in both themes, checked by the build.
- **Übersicht:** four key figures, one revenue chart that also opens as a table, a short "Handlungsbedarf" list that links to the screen resolving each item, open salaries, and the fleet's TÜV status. Today's Übersicht has six tiles and ten panels.
- **Navigation:** today's items and names, grouped into Betrieb, Finanzen, Planung & Dokumente and Verwaltung. On a laptop the sidebar folds to icons; on a phone it opens as a drawer.
- **Touch screens:** buttons, fields and navigation links grow to 40 to 44 px, and fields use 16 px text so a phone does not zoom in when one is tapped.

## Where to look

- **Prototype screenshots:** [`prototype/`](prototype/), in German, light and dark, at 375, 768 and 1280 px: `{width}-{theme}-uebersicht.png`, `-fahrzeuge.png`, `-fahrzeug-formular.png` (the add form showing a validation error), `-navigation.png` (the folded sidebar or the phone drawer), and `1280-{theme}-komponenten.png` with every component in its states.
- **On staging, once merged:** `https://app.elprofessor.eu/design-preview`, behind the staging login, without signing in to the app. Invented sample data; nothing is saved. Production builds do not contain it.
- **The audit of today's screens:** [`audit/`](audit/README.md), 22 findings in priority order with 80 screenshots.
- **Gehaltsquittung (plan 4.3a):** [`gehaltsquittung/`](gehaltsquittung/), the first real screens on the design system: the receipt list on Dokumente and each step of the dialog, rendered with invented data in a German Chrome, light, dark, English and at 390 px (`390-*` shows the whole scrolled dialog).
- **Phase 5, the rollout:** [`phase5/batch1/`](phase5/batch1/) holds Fahrzeuge and Fixkosten before and after their move onto the design system, 34 shots each, named `{width}-{theme}-{screen}[-{state}].webp`. Both sets come from `design-harness/` — the production screens inside the production frame, on invented data — so they compare like for like; the 375 px shots are taken as a touch phone. [`phase5/batch2/`](phase5/batch2/) holds Gehälter, Abrechnung and Bargeldbestand the same way, 47 shots each, including a failed load of each screen, a platform view context, a billing reader who cannot read the cash ledger, and October carrying the Storno of a Gehaltsquittung paid in September. The Abrechnung share image is not among them: it is a document, rendered off-screen, and stayed as it was. [`phase5/batch3/`](phase5/batch3/) holds Dokumente, Monatsplanung and Stundennachweis, 51 shots each: the three pages in all six sizes and themes, Phase 1's form too, and their dialogs, steps and states at 1280 light and 375 dark, plus English. Batch 3's harness data includes an applied planning run, so Phase 1's blocks and the Stundennachweis preview are drawn by the product's own code on invented rides.
- **Code:** tokens in `src/index.css` and `tailwind.config.js`, components and `AppShell` in `src/components/ui`, the prototype in `src/design-preview`. CLAUDE.md, "Design system and the design preview", has the rules.

## Open questions for the owner

1. Approve the direction, or say what to change.
2. The plan asked for a "new UI" switch on staging. The prototype is a separate page instead, so the real screens on staging stay exactly as they are. A switch makes sense once Phase 5 has real screens in both versions.
3. Date fields use the browser's own date picker, which follows the browser's language: `tt.mm.jjjj` in a German browser, `mm/dd/yyyy` in an English one. A German date field in Phase 5 would make every date field `TT.MM.JJJJ`.
4. Three findings of the audit are product questions more than design: the debug box on Fixkosten (6), the Benachrichtigungen screen for mail that is never sent (7), and the figures written with a US decimal point on Übersicht and Bargeldbestand (1), which are small enough to fix before Phase 5.
