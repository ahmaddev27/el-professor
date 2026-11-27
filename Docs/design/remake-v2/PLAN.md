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

The legacy blocks retired in R6 (27.11.2026), once nothing read them. **What the remap does not reach:** about twenty
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

**The chart series came with R1** (the Overview's charts, the first to use them): `chart-1` … `chart-5`
and `chart-1-soft`, in Tailwind as `chart-1` … `chart-5` and `chart-1-soft`. A series line, bar or slice
carries meaning apart from its legend, so unlike a tone's dot it must reach 3:1 (SC 1.4.11) on every pane
a chart sits on — canvas, sheet, raised and overlay — and `tokens.contrast.test.ts` measures all forty
pairs. Five spec values did not, so each was darkened (light) or lightened (dark) along its own hue to
just past 3:1, the smallest change that passes:

| token | spec | ours | spec's worst |
|---|---|---|---|
| light `chart-1` | `#0e9f6e` | `#0a845b` | 2.27:1 on the canvas |
| light `chart-3` | `#e0892b` | `#a6641d` | 1.81:1 |
| light `chart-4` | `#8b7cf0` | `#7366c8` | 2.26:1 |
| light `chart-5` | `#98a39e` | `#6d7672` | 1.74:1 |
| dark `chart-5` | `#6f7b76` | `#889791` | 2.19:1 on a card |

`chart-2` and the other four dark series are the spec's values. `chart-1-soft` is the spec's tint and is
not measured: it is an area's fill under its own line, never a mark alone.

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
  - **The topbar follows the spec's order** (27.11.2026, after the owner's screenshot of the panel):
    the section's name at the start (`.crumbs`, from `navCrumbKey()` over the sidebars' own nav
    lists), the actions at the end (language, theme, user menu). Both shells.
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
| R1 | `OverviewPage`, `LockedFeaturePage` — **done 27.11.2026** (below) |
| R2 | `NotesPage`, `WerkstattPage`, `NotificationsPage` — **done 27.11.2026** (below) |
| R3 | `AccountPage`; then the OTP block's `ON_LEGACY_SURFACE` pairs retire — **done 27.11.2026** (below, with R4) |
| R4 | the admin panel: `SuperAdminDashboard`, `CompaniesPage`, `PlatformDirectoriesPage`, `PlatformTeamPage`, `PlatformAuditPage`, `PlatformSettingsPage`, `PlatformPlansPage`, `SubscriptionBillingPage`, `AbnahmeDiagnosticPage` — **done 27.11.2026** (below; `PlatformPlansPage` was already on tokens) |
| R5 | the components phase 5 left legacy on purpose: the salary dialogs, the planning and document builders' screen parts (never the documents), the toast, `ConfirmationModal` callers, and `LandingPage` — **done 27.11.2026** (below) |
| R6 | retire the legacy tokens once nothing reads them; the document components move their `var(--…)` reads to fixed values first, proved unchanged — **done 27.11.2026** (below) |

**R1, as built (27.11.2026, branch `design/remake-r1`).**

- **What moved.** Both screens draw from tokens and primitives only. The Overview's style counts went from 187 inline styles and 110 colours to 2 and 0. The two left are a tooltip row's series colour and a ranking bar's width, both data. `LockedFeaturePage` went from 15 and 3 to 0 and 0.
- **The Overview's colours.** Every series and status keeps its old hue on a token: Umsatz `chart-2`, Gewinn `chart-1`, Gehälter `chart-3`, Kosten `critical`, the four slices of the revenue mix `chart-2/3/4/1`, and the plan tiers `info` / `caution` / `positive`. The profit total is the brand fill when the month made money and `critical-solid` when it did not.
- **The proof.** `identity-proof.mjs` against `origin/staging`, after a negative control:
  - The logic regions differ only by the helper components the Overview kept above its main component. These are 196 contiguous old lines, from `DeltaBadge` to `PlanStatusCard`, which are presentation and now sit below the marker.
  - On the locked page, the difference is the 6 lines of its colour map.
  - All 157 and all 8 logic calls are carried.
  - The only handlers lost are the hover painters, 12 on the Overview and 2 on the locked page, which are `hover:` classes now.
- **Found in the shots.** At 375 px the open-salaries table broke every amount across two lines. Its figures and dates are `whitespace-nowrap` now, and the table scrolls inside a positioned frame.

**R2, as built (27.11.2026, branch `design/remake-r2`, stacked on R1).**

- **What moved.** `NotesPage`, `WerkstattPage` with its form `WerkstattCheckModal`, and `NotificationsPage`. Every one went to 0 inline styles and 0 colours: 86/1, 54/7, 46/2 and 34/1 before. No data-driven style was needed.
- **Dialogs.** The note form and the Werkstatt form are `Dialog`s (they stay open while saving and show the failure); both deletes are `ConfirmDialog`. The Werkstatt form keeps its old rule that a click beside it does not throw the form away, and Escape and the close button do nothing while a save runs. Its submit sits in the footer with `form=`, the `CarModal` pattern.
- **Colours.** Werkstatt: positive `positive`, negative `critical`, repaired `info` (its old hue was blue, and as a status it is a tone, not brand). Each card also carries a `Badge` with the word, so colour is not the only signal. Notes: the planning effect "exclude" is `critical`, "must include" `caution`.
- **The proof.** `identity-proof.mjs` against `origin/staging`, after a negative control on each file. Every logic call is carried (74, 31, 25, and 20 of 22 on Notifications, where the two missing are the two `.map(…)` blocks whose markup was restyled; the `Toggle`s and `handleTypeToggle` inside them are carried). The logic regions differ only by presentation that moved below the marker: the two `inputStyle` objects, Werkstatt's `getStatusConfig` (words and colours in one map; the label is still read the same way) and Notifications' `iconColor`/`iconBg`. The handlers lost are hover painters (22, 14, 12 and 8). The status picker's three `setStatus('…')` buttons are one mapped `setStatus(option.key)`.
- **Tests.** The four test files that open a dialog mock `ui`'s `Dialog` and `ConfirmDialog`, because `react-test-renderer` cannot draw a portal; the mocked `ConfirmDialog` keeps the real contract (`onConfirm()` then `onClose()`). A mutation control (confirm without `onConfirm`) fails the four delete tests. Two files outside the screens' own tests had to follow: `EditModals.writeRefusal.test.ts` (it opens `WerkstattCheckModal`; it mocks `Dialog` now too), and `scripts/style-ratchet.test.ts`, whose "a screen not yet converted" control was Werkstatt and is `AccountPage` now.
- **Found in the shots.** A Werkstatt card read „Datum:17.9.2026“: the labels end in a colon with no space (also before R2); they carry `mr-1` now. „Heute“ was plain text beside two bordered arrows and is a secondary button in the page and the form. At 375 px the four status filters wrapped into three and one; they are two by two on a phone. In the form at 375 px, „→“ fell onto a line of its own; the calendar, both arrows and the month are one group now.
- **Left as it was.** Both pages draw the edit button with a `CreditCard` icon (`CreditCard as Edit2`), as six other files do; the notes tests find the edit button by that icon. That is a question for the owner, not a look-only change. **Answered 27.11.2026:** the owner chose the pencil, and `c2202e1` swapped it in all seven files (`Pencil as Edit2`, so no JSX line moved).

**R3 and R4, as built (27.11.2026, branch `design/remake-r3`, one PR).**

- **What moved.** Mein Konto (`AccountPage`, 33 inline styles / 0 colours → 0 / 0) and the platform panel:
  - the dashboard (174 / 25 → 1 / 0; the one left is a plan bar's width, which is data);
  - the company list with its four dialogs (264 / 21 → 0 / 0);
  - billing (79 / 5) with its four dialogs and the manual subscription dialog;
  - the activation, discount and referral codes (101 / 41, 77 / 14, 42 / 11);
  - Team, Protokoll and the directories;
  - the settings page with three editors and the kit they share (its one left is a field width passed in as data);
  - the Abnahme diagnostics (90 / 111 → 0 / 0).

  `PlatformPlansPage`, `ImpressumEditor` and `PrivacyTextEditor` were already on tokens. The style ratchet ends at 2992 / 2228 in 33 files.
- **Retired.** `ON_LEGACY_SURFACE` in `tokens.contrast.test.ts` is gone, because every screen that renders the one-time-code block is now on tokens. The control in `scripts/style-ratchet.test.ts` ("a file the remake never converts") now uses the Gehaltsquittung sheet. That file stays on inline styles for good, so the control cannot move again.
- **The proof.** `identity-proof.mjs` ran against `origin/staging`, per file, after a negative control.
  - Every logic call is carried in all 21 files: 31 on Mein Konto, 87 on the dashboard, 62 on Abnahme, 61 on billing. The one exception is the directories' `switchTab(id)`, which moved from the trigger's `onClick` to `Tabs onValueChange`.
  - The logic regions of Mein Konto, the referral codes and five dialogs are identical. The rest differ only by presentation: status maps that held colours, and the `inputStyle` / `labelStyle` / `cardStyle` objects.
  - Every `onChange` and `onClick` expression of the old markup is present verbatim in the new. The handlers lost are hover painters and two tab setters that are now on `onValueChange`.
  - The settings files had no marker on staging, so their logic regions include markup. Their handlers were compared by hand.
- **Behaviour that changed on purpose** (each item is named in the PR):
  - **Buttons gated with `hidden={!can…}` now hide.** These are: open a company, edit, restore, and the manual subscription. `inline-flex` outranks the `hidden` attribute, so on staging these row buttons were drawn for a `support`, `billing` or `read_only` account, and the database then refused the action. They now carry `[&[hidden]]:hidden`. The lifecycle menu was a plain `div` and already hid.
  - **The hand-built overlays are now `Dialog`s.**
    - A click beside a form still does not close it.
    - Escape and the close button call the old close handler.
    - A dialog that runs a request ignores close while it runs. These are reject company, the manual subscription, assign, generate invoices, mark paid, the discount code and the activation confirm.
    - A generated activation code cannot be dismissed with Escape or a click beside it.
  - **The tab strips are Radix `Tabs`**, so the arrow keys now switch tabs. In the directories, clicking the tab that is already open no longer resets its filters, because Radix fires no change for the same value.
  - **The settings kit's `Note` is now an `Alert`.** This slightly changes the note in the Impressum and Datenschutz editors too.
  - **`Button` has no caution variant.** The discount code's "hide" button lost its amber, and the lifecycle "medium" confirm is now the brand primary. The dialog's wording carries the weight.
  - **The billing actions menu is named "Aktionen"** (`sa.subs.actionsMenu`, a new key). It was named "Anzeigen" before.
  - **Mein Konto's four unlabelled fields now carry an `aria-label`.**
- **Found by review.** An independent reviewer read the diff before the build and found four problems, all fixed before the gate:
  - `CompaniesPage` had a duplicate import.
  - `CompaniesPage` had lost the import of `berlinToday`, so the companies export would have thrown on click.
  - The dashboard's quick-action links had lost `flex`.
  - Four dialogs could be closed in the middle of a request.
- **Tests.**
  - `responsiveRules.test.ts` finds `overflow-x-auto` on each company-table frame and requires `relative`, with a mutation control.
  - `ReferralCodesManagement.writeRefusal.test.ts` now mocks only `Alert`.
  - The typecheck baseline fell from 165 to 163. Two unused icon imports in `InvoiceDetailModal` went with the old markup, and three `React` imports the conversion left unused were removed.
- **Harness.** `design-harness/r4/` (fixtures and routes) and `design-harness/shots-r4.mjs` add a platform owner with every capability. The fakes switch to it for `?screen=r4-*`, and every other batch is unchanged.

**R5, as built (27.11.2026, branch `design/remake-r5`, one PR).**

- **What moved.** The style ratchet fell from 2992 inline styles and 2228 colours in 33 files to 349 and 366 in 14. Counts are inline styles / colours, before → after:
  - **Planning and documents, the screen parts only:**
    - the Arbeitsstunden wizard (985 / 682 → 5 / 11);
    - Monatsplanung's assignment preview (331 / 344 → 0 / 0) and Stundennachweis preview (207 / 139 → 0 / 0);
    - the Brutto-Gehälter wizard (147 / 106 → 0 / 0);
    - `FinalizePlanningModal` (50 / 32 → 0 / 0);
    - `HistoricalHourTargetsManager` (70 / 41 → 0 / 0);
    - `FahrtenbuchImportModal` (94 / 4 → 0 / 0);
    - `CompanyPlannerPage` (29 / 15 → 0 / 0);
    - `MonatsplanungAppliedRuns` (39 / 37 → 0 / 0);
    - the Stundennachweis page around its `Timesheet` (154 / 71 → 72 / 29, every remaining one inside `Timesheet` but one field in `EditableCell`);
    - the Trinkgeld-Quittung and Mietwagenauftrag dialogs around their `A4Document` (87 / 37 → 42 / 34 and 155 / 50 → 94 / 48, all remaining ones inside the sheet).
  - **The three salary dialogs** (104 / 2, 37 / 1 and 20 / 1 → 0 / 0) are Radix `Dialog`s that ignore a close while they write.
  - **`ConfirmationModal`** (11 / 2) is deleted. `SalariesManagement`'s status dialog, its last caller, is a `MessageDialog`.
  - **The landing page** (325 / 369 → 0 / 0) follows the theme and draws `BrandLogo` beside the wordmark.
  - **Smaller pieces:**
    - the toast is `glass-strong`;
    - App.tsx's loading and "profile unavailable" states are on `bg-canvas` and a glass card;
    - `LanguageSwitcher` lost its `default` variant, and the legal pages ask for `ui`;
    - the revenue-mix colours in `overviewHelpers.ts` are chart tokens;
    - `warningCategories.ts`'s group colours are status tokens, with `classify()` untouched.
- **What is left, on purpose.**
  - Every document region named in `src/rtlClasses.test.ts`, byte for byte: both `A4Document`s, `Timesheet`, `GehaltsquittungDocument`, `DriverSalarySummaryCard` and the Abrechnung image.
  - The Arbeitsstunden wizard's `DRIVER_COLORS` series and its three `#2563eb` fallbacks. The screen builds `colour + '18'` alphas from them, so they stay hex and feed five data-driven styles.
  - The staging banner and Google's button. Their colours are measured from source.
- **The proof.** Each payroll file has its own script, which ran after a negative control. These are `design-harness/identity-r5-hwh.mjs`, `-reconciliation`, `-assignment`, `-snpreview`, `-finalize`, `-planner`, `-stundennachweis`, `-quittung` (both dialogs) and `-landing`.
  - The Arbeitsstunden wizard's script strips every `className` and `style` from both sides with the TypeScript parser and token-diffs the rest. It found 116 hunks: 99 colour literals swapped for token classes and 17 named entries, each with its reason. Every surviving `style` property is checked against the old file.
  - The other files ran through `identity-proof.mjs`.
  - A call checker extracted every call and every behaving attribute from the old markup and found none missing.
  - The document regions are compared byte for byte against `origin/staging`.
- **Behaviour that changed on purpose:**
  - **The salary dialogs ignore Escape, a click beside them and the close button while a write runs.** The old overlays closed on a click beside them.
  - **Colour no longer carries meaning on its own.** Each `FinalizePlanningModal` check row has an icon and a screen-reader word.
  - **In the Arbeitsstunden wizard,** solid blue, green and violet buttons are the brand primary. Solid amber badges with dark text are `bg-caution-soft text-caution`. `short` and `long` stay distinguishable: `long` is the stronger fill. The amber "Originaldaten-Warnung" stays caution and an app-made overlap stays critical.
  - **The landing page follows the theme** and is no longer always dark.
- **Found by review.** An independent reviewer read the diff after the first build and found three real problems, all fixed:
  - **The wizard's block stat strip lost its colours.** The codemod wrote `s.color ?? s.dim ? … : …`, and `??` binds tighter than `?:`, so every coloured figure (Gültig, Kurz, Lang, Ungültig) came out grey and the invalid count lost its red. A scan of every added line for `??` or `||` beside a ternary found no second case.
  - **An unassigned block with a cross-vehicle conflict had the same fill as one without** (both branches `bg-caution-soft`). It is the faint fill again without a conflict, and the conflict badge has a fill of its own.
  - **`SalaryDetailsModal` could be closed while it saved.** Its close runs `onUpdate()` at once, so Escape or the close button now waits for `savingPayroll` and `loadingWeekly`.

  It also noted that `short` and `long` blocks are both amber now. They still differ in fill strength and carry their word, so they were left as they are.
- **Tests.**
  - `accentLabel.contrast.test.ts` ran its "finds the style objects" and "still wired into the scan" controls on the real source, and the real source no longer holds a `-solid` fill by name. Both controls are now fixtures run through the same functions (`indirectSolidFillsIn`). The rules themselves still scan `src/`.
  - `ToastContext.render.test.ts` asserts `glass-strong` and no inline style.
  - `landingFeatureCards.test.ts` asserts `accent-brand`.
  - `SalaryDetailsModal.writeRefusal.test.ts` mocks `ConfirmDialog` with the real contract.
  - `responsiveRules.test.ts` follows the converted frames.
  - The typecheck baseline fell from 163 to 161: two unused names went with the old markup.
- **Left for R6:** the landing page's hero keyframes in `src/index.css` are physical and do not mirror in Arabic. Done in R6.

**R6, as built (27.11.2026, branch `design/remake-r6`, one PR), with two Arabic fixes the owner reported the same evening.**

- **The last readers of the legacy tokens moved to tokens.**
  - `NoteProvenanceFields` and `NoteReviewPanel` draw their fields with `controlFrameClass` (the textarea with NotesPage's `h-auto resize-none py-2` pattern) and their text with `text-fg` / `text-fg-muted` / `text-fg-subtle`.
  - `DriverSalarySummaryCard`'s two export buttons, which sit outside the captured card, are design-system `Button`s. Everything from `CARD — exported as image` to the end of the file is byte-identical (checked as a string).
  - Seven stat figures in `HistoricalWorkingHoursWizard` passed `'var(--text-primary)'` or `'var(--text-secondary)'` as a **class name**, an R5 codemod slip, so they drew in the inherited colour. They are `text-fg` / `text-fg-muted`. Each changed line differs from staging's only in that value (checked by script).
  - The one document that read a theme colour, the Timesheet's absence badge (`text-fg-subtle`), takes `text-[#525e59]`: the light theme's value, so the light sheet is unchanged and the dark one no longer changes the document. That is the style ratchet's one rise (StundennachweisPage colours 29 → 30); `DriverSalarySummaryCard` falls from 35 inline styles to 29, so the baseline is 343 / 367 in 14 files (from 349 / 366).
- **`src/index.css`** loses both `@legacy-tokens` blocks, the sixteen unused legacy component classes (`.panel*`, `.text-main|sub|muted|accent`, `.btn-*`, `.input-base`, `.badge-*`, `.divider`) and five unused animations (`slide-in-right`, three `float-*` aliases, `fade-in`). The global `select` rule reads `--fg` on `--solid` (opaque, because the browser draws the option list over everything), not the legacy pair and four fixed hex values.
- **The landing hero mirrors in Arabic.** Every sideways offset and every tilt in its keyframes and its reduced-motion rests is multiplied by `--hero-x`, which is `1` under `[dir='ltr']` and `-1` under `[dir='rtl']` (declared outside the Tailwind layer, which keeps only rules for classes it finds).
- **Tests.** `accentLabel.contrast.test.ts` is deleted: it paired legacy fills with their labels, and its own control needed a source file still painting `var(--accent)`. `tokens.contrast.test.ts` loses its legacy section (a note says where its rules live on). `legacyTokensRetired.test.ts` fails if `index.css` defines a legacy name or any file under `src/` (and `index.html`) reads one, with a positive control over six spellings, two of them near misses (`--border-strong`, `--line-strong`) that must not match.
- **The sidebar was missing in Arabic on every wide screen, in both shells** (owner's screenshot of `/admin/protokoll`, 27.11.2026). The drawer's closed state was `-translate-x-full rtl:translate-x-full`. Tailwind 3.4 writes `rtl:` as `:where(…)`, the specificity of one class, and emits it *after* the screen variants, so it beat `lg:translate-x-0` and slid the sticky sidebar out past the right edge, leaving its strip empty. Measured in the compiled CSS, not reasoned: `.lg\:translate-x-0` at line 7626, `.rtl\:translate-x-full:where(…)` at 7837. The closed state is `max-lg:-translate-x-full max-lg:rtl:translate-x-full` now, in `Sidebar` and `AdminSidebar`; no other `rtl:` class shares an element with a screen variant of the same utility.
- **The Arabic face is Tajawal** (owner, 27.11.2026), replacing IBM Plex Sans Arabic: `@fontsource/tajawal`, Arabic subset only (400, 500, 700; it has no 600, so semibold draws 700). Latin text and figures stay Geist, so a figure on an Arabic screen is the same as on the German document.
- **The date fields' `mm / dd / yyyy`** is the browser's own date control, which formats by the browser's UI language and never by the page's: an English Chrome shows it on the German screen too (`design-harness/capture.mjs` passes `--lang=de-DE` for exactly that reason). Arabic did not cause it, and replacing the native control is a separate decision.

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
