# Design remake V2 — plan

Owner's request, 27.11.2026: *apply this design to the whole system, a remake of the design.* The
design is the "Glass / Remake V2" system specified in
`/home/ahmad/design-inputs/reidey-remake-v2/design-system-handoff.md`, with reference source at commit
`4b5290a5`, which is read-only and never copied wholesale. The owner decided the same day: **everything as
in the file, colours included**.

- **Follows the spec:** the emerald palette (`#047857` / `#34d399`), the glass recipe, the ambient
  field and the grain, Geist and Geist Mono, every component, and the shell.
- **Stays El-Professor's:** the product name, and the logo glyph (`public/brand/mark-on-dark.png`),
  which is drawn inside the spec's dark `.brand-mark` tile.
- **Retired:** blue `#146BFF` and cyan `#00E7FF`.
- **Wording:** nothing in the product names the design's origin.

This is a **port onto our system, not a copy.** The base stays Vite, React 18, Tailwind **v3**, Radix, cva
and `cn()`, with RGB-channel tokens in the `@tokens light` / `@tokens dark` blocks of `src/index.css`.
There is no Next.js, no Tailwind v4, no `next/font` and no `localStorage('theme')` script: our
`ThemeProvider` already writes `.dark` on the root.

## 1. Tokens: mapped by role, never by name

Both systems use the names `--canvas`, `--surface` and `--overlay`, and they mean different things. On
our side, `--overlay` is the dialog surface; on the spec's side, it is the scrim. So the token names
below are El-Professor's, and only the values move.

| our token (role) | spec source | light | dark |
|---|---|---|---|
| `canvas`: page background | `--canvas` | `#e8efec` | `#050a08` |
| `raised`: cards, tables, panels | `--surface` (translucent) | `255 255 255` @ .62 | `255 255 255` @ .045 |
| `overlay`: dialogs, sheets, menus, popovers | `--glass-strong` | `249 252 251` @ .80 | `14 20 18` @ .80 |
| `sunken`: table header, hover, skeleton, inset fills | `--surface-3` | `17 25 22` @ .06 | `255 255 255` @ .07 |
| `field`: input fill | the `.input` fill | `255 255 255` @ .62 | `255 255 255` @ .04 |
| `solid` (**new**): dense data, toast, menus that must not show through | `--surface-solid` | `#f7faf9` | `#111715` |
| `fg` / `fg-muted` / `fg-subtle` | `--ink` / `--ink-muted` / `--ink-subtle` | `#111916` / `#4f5b56` / `#525e59` (§1) | `#e5ebe8` / `#b5bfba` / `#acb7b2` (§1) |
| `line`: dividers | `--line` | `17 25 22` @ .08 | `255 255 255` @ .08 |
| `line-strong`: **control borders** | `--line-strong`, raised to 3:1 (§3) | `17 25 22` @ .50 | `255 255 255` @ .42 (§1) |
| `brand`: primary fill, active mark | `--primary` | `#047857` | `#34d399` |
| `brand-hover` | `--primary-hover` | `#065f46` | `#6ee7b7` |
| `brand-fg`: text on brand | `--primary-ink` | `#ffffff` | `#04261a` |
| `brand-soft`: selected/info fill | `--primary-soft` | `#e2f3eb` | `#0f2a20` |
| `brand-text`: links, active nav text | `--primary-soft-ink` | `#05603f` | `#74e3b8` |
| `signal`: was the brand cyan | `--declined-fg` (teal) | `#0b6259` | `#84d9cf` |
| `focus`: focus outline | `--primary`, not `--focus` (§3) | `#047857` | `#34d399` |
| `positive` / `positive-soft` | `--success-fg` / `--success-bg` | `#05603f` / `#e6f5ee` | `#74e3b8` / `#0e2a1f` |
| `caution` / `caution-soft` | `--warning-fg` / `--warning-bg` | `#8a4b06` / `#fcf2df` | `#f5c46b` / `#2e220c` |
| `critical` / `critical-soft` | `--danger-fg` / `--danger-bg` | `#a8231b` / `#fdecec` | `#ffa39e` / `#331416` |
| `critical-solid`: destructive fill under a white label | ours, kept (§3) | `#a8231b` | `#c0262d` |

**New tokens, all additive:**

- **Tones without one today:** `info`, `accent`, `declined` and `neutral`, each with `-soft` (the bg) and
  the fg as the bare name.
- **Dots for every tone:** `positive-dot`, `caution-dot`, `critical-dot`, `info-dot`, `accent-dot`,
  `declined-dot` and `neutral-dot`.
- **Chart series:** `chart-1` … `chart-5` and `chart-1-soft`.
- **Scrim:** the spec's `--overlay` and `--glass-scrim`.
- **Glass, not colours:** `--glass-edge` (a colour), `--glass-hi`, `--glass-shadow`, `--glass-sheet`,
  `--amb-1` … `--amb-4`, `--grain`, `--ease`, and the radius scale `--r-xs` … `--r-2xl`. These are
  values, not channel triples.

**How alpha fits the RGB-channel convention.** A token stays a channel triple, and a translucent one gains
a sibling, `--<name>-a`. Tailwind's colour becomes `rgb(var(--raised) / calc(var(--raised-a, 1) *
<alpha-value>))`, so:

- `bg-raised` paints the spec's `rgb(255 255 255 / .62)`;
- `bg-raised/50` halves it;
- an opaque token, which has no `-a`, behaves exactly as before.

`tokens.contrast.test.ts` reads both and composites every translucent token before it measures (§6). A
channel triple can never hold a shadow or a gradient, so those live as plain custom properties beside
the blocks, outside the `@tokens` markers the test parses.

**The legacy tokens are remapped in stage 1, not kept (decided while building, 27.11).** The owner
retired the blue, and a legacy screen inside the new frame would otherwise keep it until its batch. The
remap keeps every name and role, so no markup changes:

- the accent family becomes the emerald brand (`#047857` / `#34d399`, `accent-text` `#05603f` /
  `#74e3b8`);
- the neutrals (`bg-*`, `border*`, `text-*`) become the remake's green-greys (`bg-base` is the canvas,
  `#e8efec` / `#050a08`);
- the status colours were already the remake's red, green and amber, and keep their values.

**Why that is safe for the documents, measured rather than assumed.** The 39 and 44 `var(--…)` reads in
the Trinkgeld-Quittung and Mietwagenauftrag modals are all in the modal chrome. Their `A4Document`
sheets, which html2canvas draws, read none. The captured region of `DriverSalarySummaryCard` reads none,
and neither do the Gehaltsquittung, the Abrechnung share card, or any PDF builder. Every document paints
fixed colours and pins its own font, so nothing printed moves.

The legacy blocks retire in R6, once nothing reads them. **What the remap does not reach:** about twenty
legacy files hard-code blue hex values in their own markup. Those go with their batch (R1–R5), because
changing a file's markup is that file's conversion.

**Changed from the table above while building, each because the contrast test refused the spec value
over the glow (§3):**

| token | spec | ours | why |
|---|---|---|---|
| light `fg-subtle` | `#5d6964` | `#525e59` | 3.83:1 on the canvas under the strongest glow |
| dark `fg-muted` | `#a3afaa` | `#b5bfba` | 4.20:1 on an inset fill inside a card |
| dark `fg-subtle` | `#93a09a` | `#acb7b2` | 3.51:1 there |
| dark `line-strong` | white @ .38 | white @ .42 | 2.92:1 for a field's border on its own fill |
| light primary gradient top | `#0b9068` | `#098663` | white is 4.04:1 on the spec's top stop |
| critical label | `brand-fg` | `critical-fg` (white, both themes) | the dark `brand-fg` is dark green, 3.4:1 on the red |

**Not in stage 1:** the chart series tokens. No stage-1 component draws a chart from them, and the spec's
orange, violet and grey are under 3:1 on a card, so they are added and measured with the first chart
that uses them (R1).

## 2. The glass recipe, the ambient field, and the fallbacks

**Where the recipe lives:** in `src/index.css`, in `@layer components`, as `.glass-card`,
`.glass-sheet`, `.glass-sidebar`, `.glass-overlay` and `.glass-topbar`, so a utility can still override
any of them.

**What each one paints:**

- background, `--glass-edge` border, and the shadow stack `var(--glass-hi), 0 0 0 1px
  rgb(var(--line)/var(--line-a)), var(--glass-shadow)`;
- for overlays, `--shadow-lg` in place of `--glass-shadow`;
- `backdrop-filter`, layer by layer:

  | layer | blur / saturate |
  |---|---|
  | sidebar | 22px / 160% |
  | overlay | 26px / 180% |
  | mobile drawer | 28px / 180% |
  | topbar | 18px / 170% |
  | toast | 16px / 160% |
  | scrim | 6px / 120% |
  | cards | none, as in the spec |

**The ambient field and grain:**

- `html` carries the canvas colour.
- `body::before` (z −2) holds the four radial glows at the spec's positions.
- `body::after` (z −1) is the SVG `feTurbulence` grain at `opacity: var(--grain)`.
- `body` gets `isolation: isolate`.

So the glow shows through, the seven full-page wrappers that paint an opaque `bg-canvas` become
transparent: `AppLayout`, `AppShell`, `AuthShell`, `AccountStatusPage`, `SetPasswordPage`,
`AuthCallbackPage` and `LegalPage`. The legacy `body { background-color: var(--bg-base) }` goes, because
`html` now carries the canvas.

**The spec's fallback block, ported verbatim:**

- With `prefers-reduced-transparency: reduce`, `prefers-contrast: more`, or no `backdrop-filter`
  support: every glass surface turns solid, at the spec's values per theme. `backdrop-filter` is
  removed, and the grain is hidden.
- With `prefers-contrast: more` only: `line` and `line-strong` also step up to the spec's values. Ours
  is already .50 / .38, so it only ever rises.

**The sheet and the topbar blur through a `::before` layer (decided while building, 27.11).** The spec
puts `backdrop-filter` on the element. Here that would make the content sheet the containing block of
every `position: fixed` descendant, and the sheet holds every page. The legacy screens' inline
`fixed inset-0` dialogs would then open inside the sheet instead of over the viewport, and UserMenu's
click-outside layer would shrink to the 60px topbar. The layer creates no stacking context on the sheet,
so a legacy dialog's z-50 still covers the sidebar. The glow and the grain move to z −3 and −2 so the
layer (−1) blurs them, as the spec's pane does. Dialogs, menus, the drawer and the toast keep the filter
on the element: they are portalled, and a scrolling pane's `::before` would cover only its first
screen. The rule that follows is that a legacy `fixed inset-0` modal is never rendered inside a
design-system `DialogContent` or `SheetContent`; measured, none is today.

## 3. Where we do not inherit the spec, and why

Each item below is a gap the brief says not to inherit, or a pair our contrast test already pins.

1. **Focus.** The spec's `--focus` (`#10b981`) reaches only about 2.2:1 on the light canvas, and the spec
   defines no `:focus-visible` style for buttons, tabs, menus or switches. We keep our 2px
   `focus-visible` outline on every control. Its colour is `brand`, which reaches 3:1 as a non-text
   mark, and the spec's soft 3px `--focus` glow is added around fields as decoration.
2. **Control borders.** The spec's `--line-strong` (.15) is well under the 3:1 that SC 1.4.11 and our
   test require of an input's boundary. Dividers keep the spec's `line`, but `line-strong`, which only
   frames controls, takes the spec's own *more-contrast* value: .50 in light, .38 in dark.
3. **The destructive fill.** The spec's `.btn-danger` puts white on `--danger-dot` (`#e5484d`), which
   is about 4.2:1. `critical-solid` stays at a red that carries a white label at 4.5:1.
4. **Links and active nav text.** These are text, so they need 4.5:1 over the worst glow. `brand-text`
   is the spec's `--primary-soft-ink`, never `--primary`, which the spec itself measures only as a
   3:1 UI colour.
5. **Motion.** The page settle fills `backwards`, not the spec's `both`. A transform left in effect
   after the animation makes each settled child a containing block for `position: fixed`, so a legacy
   dialog rendered inside a page would open inside that child. The spec gates only the page settle. Every animation here — fade, pop, slide, settle,
   ping, shimmer and spin — runs under `motion-safe:` or inside `prefers-reduced-motion: no-preference`.
6. **Modals.** Radix keeps its scroll lock and focus trap. The spec has neither, and its `Modal` is not
   ported; only its look is.
7. **Touch.** Every control keeps 40–44 px and 16 px field text under `pointer:coarse`. The spec's
   36 px button and 40 px input are the mouse sizes.

## 4. Fonts

- **Geist and Geist Mono** (OFL) are copied from the reference into `src/assets/fonts/` as the two
  variable woff2 files, with `@font-face` in `index.css`, `font-display: swap`, and weights 400–700 and
  400–600. Vite fingerprints them, and nothing loads from a CDN.
- **`font-ui` becomes Geist**, and so does Tailwind's `sans`. The whole product therefore changes face,
  including the legacy screens, the admin panel and the landing page's default stack, because the brief
  asks for the whole system.
- **The type scale is carried as literal sizes** in the primitives: title 24/600, card title 15/600,
  body 13.5, secondary 13, small 12.5 and caption 12. The spec defines no type tokens.
- **Barlow stays installed, for one picture only.** The Abrechnung share card is rendered by html2canvas
  inside the converted page's `font-ui` root, so today the PNG a driver receives is set in Barlow. A
  picture's look is its content, so that card gets `fontFamily: Barlow` pinned on its existing style
  object, and Barlow is not loaded until the card renders. Every other document already pins its own
  font: the Gehaltsquittung, the Trinkgeld-Quittung, the Mietwagenauftrag, the Stundennachweis sheet and
  `DriverSalarySummaryCard`.
- **RTL is not ported.** The UI's languages are `de` and `en` (`src/i18n/index.ts`). Arabic exists only
  as a driver's mail language (`src/lib/driverLanguage.ts`), which the UI already renders with
  `dir="auto"`, so there is no RTL locale. Tajawal, the RTL rules and the Latin-digit helpers are
  therefore not ported. If an RTL UI language is ever added, it brings them.

## 5. Components: spec section → our primitive

`src/components/ui` keeps every export, prop and variant name, so no screen's code changes; only the
classes inside move. In the table, `motion-safe` means the animation runs only when the user has not
asked for reduced motion.

| spec | ours | change |
|---|---|---|
| `.btn` (primary gradient, secondary glass, ghost, danger, sizes 30/36/44) | `Button` | Primary: the spec's gradient and its three-part shadow (dark: the light-emerald gradient). Secondary: the glass with `--glass-hi`. Ghost: a white wash on hover. Radius md = 10px. Weight 550, size 13.5px. Active state `translate-y-px scale-[.99]`, motion-safe. Coarse sizes kept. |
| `.icon-btn` | `Button size="icon"` | 36px, ghost wash on hover. |
| `.card` | `Card*` | `raised` fill, `--glass-edge` border, radius xl = 18px, the glass shadow stack, no blur. Head padding `16 18 0`, body `16 18 18`, foot `12 18` with a top border. Card title 15/600. |
| `.stat` | `KpiCard` | Padding `16 16 14`, a 28px tinted icon tile, value 26px/600 in tabular figures. |
| `.ph` | `PageHeader` | h1 24px/600 with −.025em tracking, muted description capped at 68ch, actions wrap. |
| `.badge` (22px pill, 12/550, dot) | `Badge` | Existing tones mapped onto success, warning, danger and neutral, plus `info`, `accent` and `declined` as new optional tones. A dot only where a caller asks for one. |
| `.tabs` / `.seg` | `Tabs` | `TabsList` gets the 40px underline tabs, with a 2px brand bar inset 10px. `variant="segmented"` gets the spec's `.seg`. |
| `.field`, `.input`, `.select`, `.textarea` | `Field`, `Input`, `NativeSelect`, `Select` | 40px (44 on coarse), radius 10px, `field` fill with an inner shadow. Focus: a brand border plus the 3px soft glow, with our outline kept. Invalid: the `critical` border with a soft ring. Label 13/550, hint 12.5 `fg-subtle`. |
| `.tbl` | `DataTable` | Header 12.5/550 `fg-subtle` on a white wash (dark .025). Cells `11px 14px`, the first and last cell 18px, row hover a wash. Containment rules kept (`dataTableContainment.test.ts`). |
| `.modal`, `.app-modal`, the overlay | `Dialog`, `ConfirmDialog`, `MessageDialog`, `Sheet` | `overlay` glass with 26px blur and radius 2xl = 22px. Widths 420 / 560 / 760 / 920. Padding `20 22 0` / `18 22` / `14 22 18`, with a top border on the foot. The scrim is `--glass-scrim` with a 6px blur. The pop is motion-safe. |
| `.menu`, `.app-menu` | `Select` content, `Tooltip` | Glass-strong, 26px blur, items 34px, menu padding 6px. |
| `.app-toast` | the legacy `ToastContext` | **Batch, not stage 1:** the toast is legacy markup with its own logic. |
| `.empty`, `.skel` | `EmptyState`, `Skeleton` | 48px icon tile. The shimmer runs for 1.6s and is motion-safe. |
| `.callout`, `.banner` | `Alert` | The tone's soft colour mixed at 78–82% over the glass, with the inset highlight. |
| `.switch`, `.chip`, `.av`, `.otp` | not primitives yet | `Switch`, `Chip` and `Avatar` are new **only when a batch needs them**. The OTP boxes are batch 4's `OtpChallenge` and take the field look from the tokens. |

## 6. The contrast test

`tokens.contrast.test.ts` changes its parser, not its rules.

**Parsing:** it reads `-a` alphas and composites every translucent token. It follows the spec's own
method, and covers a stack the spec does not test.

**The surface stack:** canvas → the strongest single glow (each of the four `amb` tones on its own, at
full alpha) → the sheet (`--glass-sheet`) → the surface (`raised`, `sunken`, `field`, `overlay`).

**What is measured:** text is measured against the backdrop nearest its own luminance, and every
existing pair keeps its threshold.

**What is added:**

- the tone pairs for info, violet, teal and neutral (the spec's info, accent, declined and neutral;
  renamed by role, because `accent` is a legacy token name with another meaning);
- `brand-fg` on both stops of the primary gradient, at rest and on hover;
- `toast-fg` on the toast;
- the `solid` surface;
- every pair on `--glass-sheet` itself, because a page body sits on the sheet.

**The legacy blocks:**

- `ON_LEGACY_PAGE` keeps measuring on `--bg-base` while AdminLayout still paints it. AdminLayout moves
  in stage 1, so that block is re-read there: a pair is removed only when nothing renders it.
- `ON_LEGACY_SURFACE`, the OTP block on Mein Konto, is unchanged.

`accentLabel.contrast.test.ts` (legacy) is unchanged and still passes. Its rule — `accent-text` is
not a label on `accent` — holds for the emerald values too.

**The worst case, not an average.** A pair passes only if it passes on every colour its background can
render as: the canvas, the canvas under each glow at its peak, the sheet over those, a card over those,
and a dialog over the scrim over those. A negative control (restoring the spec's light `fg-subtle` and
dark `line-strong`) fails exactly the four pairs it should.

## 7. The shells

- **`AppLayout`, with `Sidebar`, `UserMenu`, `AnnouncementBanner`, `SupportSessionBar` and
  `SupportReasonModal`:**
  - On desktop (`lg`, ≥1024px; the spec breaks at 960, and we keep Tailwind's `lg`), a floating
    glass-sheet sidebar: width 254px, inset 10px, radius 22px, 22px blur. Nav items are 36px, 13.5/500,
    `fg-muted`. The active item is a white glass chip with a brand icon.
  - Main is a raised `glass-sheet` with a 10px inset, under a sticky glass topbar (60px).
  - **The page keeps scrolling the window**, not an inner `.page-scroll`. Screens, the responsive sweep
    and html2canvas all assume the document scrolls, so the topbar sticks at the viewport top rather
    than inside a fixed-height sheet. That one difference is deliberate.
  - The page is padded `28 32 56`, with a 1440 max-width.
  - On mobile, the sheet goes full-bleed, and the drawer is a 286px glass-strong panel over a blurred
    scrim, sliding in with motion-safe.
  - `NAV_ITEMS`, `ADMIN_ITEMS`, the `can()` and module gates, every handler and the menu state stay byte
    for byte; only class strings and wrapper markup change, proved by script (§9).
  - The brand row is the El-Professor glyph in the spec's `.brand-mark` tile, then the company name.
- **`AdminLayout` and `AdminSidebar` (legacy):** the same frame, moved off inline styles onto tokens in
  the phase 5 way. The platform pages inside stay legacy until their batch.
- **`AppShell` (`/design-preview`'s frame):** the same frame. Its existing collapse (a 68px rail) gets
  the spec's look. The preview pages are rebuilt in the new look in light and dark, on invented data,
  and the build flag still keeps them out of production.
- **No new shell behaviour** — no Ctrl/⌘+B, no stored collapsed state for the company shell. That is
  logic, and stage 1 is look only. It is listed as an open question.

## 8. Order of work

**Stage 1 (one PR, then the owner's approval):**

- the tokens, the fonts, the glass layer and the fallbacks;
- every `src/components/ui` primitive;
- `AppLayout` and its parts;
- `AdminLayout` and `AdminSidebar`;
- `AppShell` and `/design-preview`;
- the full-page wrappers made transparent;
- the Abrechnung card's font pin;
- the contrast test and the style ratchet;
- before/after screenshots at 1440 and 375 (touch), light and dark, of every harness screen.

Every already-converted screen (phase 5 batches 1–4 and the frame) changes **through the tokens and
primitives alone**, and is checked in the shots.

**Batches (after approval, one PR each, each with the phase 5 proofs):**

| batch | screens |
|---|---|
| R1 | `OverviewPage`, `LockedFeaturePage` |
| R2 | `NotesPage`, `WerkstattPage`, `NotificationsPage` |
| R3 | `AccountPage`; then the OTP block's `ON_LEGACY_SURFACE` pairs retire |
| R4 | the admin panel: `SuperAdminDashboard`, `CompaniesPage`, `PlatformDirectoriesPage`, `PlatformTeamPage`, `PlatformAuditPage`, `PlatformSettingsPage`, `PlatformPlansPage`, `SubscriptionBillingPage`, `AbnahmeDiagnosticPage` |
| R5 | the components phase 5 left legacy on purpose: the salary dialogs, the planning and document builders' screen parts (never the documents), the toast, `ConfirmationModal` callers, and `LandingPage` |
| R6 | retire the legacy tokens once nothing reads them; the document components move their `var(--…)` reads to fixed values first, proved unchanged |

## 9. Verification

| check | how |
|---|---|
| look only | Every changed screen or shell file is checked against `origin/staging` with `design-harness/identity-proof.mjs`: logic region line by line, every handler and call carried. A negative control is run first. Primitives keep their exported API, checked by the typecheck of the files they touch. |
| the narrow gates (no full build until the owner says so) | `npm run styles`; `vitest` on `tokens.contrast.test.ts` and on the tests of every touched file; `node scripts/typecheck-ratchet.mjs` once at the end, at `nice -n 10`. |
| the shots | `design-harness/capture.mjs` and `batch4/capture.mjs` gained `--widths`, `--out` and a `HARNESS_PLAYWRIGHT` / `HARNESS_CHANNEL` override. The box has no Chrome, but Playwright's cached Chromium 131 runs, driven by `playwright-core@1.49.1` kept outside the repo. Shots go to `Docs/design/remake-v2/<batch>/{before,after}/`. |
| production bundle | `/design-preview` stays behind `__DESIGN_PREVIEW__`, and `buildFlag.test.ts` and `gate.test.ts` run. |

## 10. Risks

- **Translucency over dense data.** A 62% white card over a green glow reads paler than a solid one.
  The spec measures it, we measure it too (§6), and the reduced-transparency fallback turns it solid.
- **`backdrop-filter` cost on long tables.** Cards carry no blur, so only the frame, the dialogs and the
  menus blur, as in the spec.
- **Legacy screens inside a green frame.** The remapped legacy tokens turn their accents emerald (§1),
  but blue they hard-code in markup stays until their batch. That shows in the stage-1 shots of
  Übersicht, Werkstatt and Benachrichtigungen, and it is named in the report.
- **The style ratchet** counts hard-coded colours per file. The glyph tile's gradient and the primary
  gradient are colours, so they live in `index.css` as custom properties, never in a component.
- **Window scroll instead of an inner sheet scroll** (§7) means the topbar sticks to the viewport top
  and the sheet's top inset scrolls away. This is deliberate and recorded.

## 11. Open questions for the owner

1. The collapsible rail with Ctrl/⌘+B in the company shell: it is new behaviour, so is it wanted?
2. Whether the landing page (`/`, today a dark marketing page in its own style) joins the remake in R5
   or keeps its look.
