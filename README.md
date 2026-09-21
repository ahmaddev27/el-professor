# El-Professor

[![Deploy](https://github.com/ahmaddev27/el-professor/actions/workflows/deploy.yml/badge.svg?branch=staging&event=push)](https://github.com/ahmaddev27/el-professor/actions/workflows/deploy.yml)
[![PR checks](https://github.com/ahmaddev27/el-professor/actions/workflows/pr-checks.yml/badge.svg?event=pull_request)](https://github.com/ahmaddev27/el-professor/actions/workflows/pr-checks.yml)
[![Production](https://img.shields.io/website?url=https%3A%2F%2Felprofessor.eu&label=production&up_message=online&down_message=offline)](https://elprofessor.eu)
[![Staging](https://img.shields.io/website?url=https%3A%2F%2Fapp.elprofessor.eu%2Fversion.txt&label=staging&up_message=online&down_message=offline)](https://app.elprofessor.eu)
[![E2E on staging](https://img.shields.io/badge/e2e%20on%20staging-13%20passed%2C%201%20skipped-2ea44f)](e2e/README.md)

![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-self--hosted-3FCF8E?logo=supabase&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-e2e-2EAD33?logo=playwright&logoColor=white)
![Languages](https://img.shields.io/badge/UI-Deutsch%20%7C%20English-555555)

![Requirements plan](https://img.shields.io/badge/requirements%20plan-23%20of%2037%20steps-yellow)
![Phase 0](https://img.shields.io/badge/phase%200-5%2F6-yellowgreen)
![Phases 1–4](https://img.shields.io/badge/phases%201%E2%80%934-building-orange)
![Phase 5](https://img.shields.io/badge/phase%205-not%20started-lightgrey)

---

## Project status

> Kept current with every fix and feature. Last update: **21.09.2026**.

| Document | What it is |
|---|---|
| [PROGRESS.md](PROGRESS.md) | Progress log per step, with dates, PRs and what was verified (Arabic) |
| [HANDOFF.md](HANDOFF.md) | Where things stand and how to pick the work up |
| [el-professor-plan.html](el-professor-plan.html) | The plan for the five requirements, open in a browser (Arabic) |
| [CLAUDE.md](CLAUDE.md) | Rules, mechanisms and sharp edges — read before changing code |

### Progress

A step counts once it is merged into `staging` and verified there. Production receives everything at step 0.6.

| Phase | Requirement | Progress | State |
|---|---|---|---|
| **0** | Releases, rollback, staging protection | `▰▰▰▰▰▱` **5/6** · 83% | ![live on staging](https://img.shields.io/badge/-live%20on%20staging-2ea44f) 0.6 waits for the production button |
| **1** | OTP and account security | `▰▰▰▰▰▰▱` **6/7** · 86% | ![on staging](https://img.shields.io/badge/-on%20staging-2ea44f) PRs #11, #16, #14; done once the code flows pass on staging and a real code arrives from production. 1.6 Google sign-in: database (PR #22), deploy settings (PR #29) and the sign-in screens (PR #45, with the registration gate fixed in PR #51) are on staging, and the provider was **switched on for staging** on 16.09.2026. The server-side rule — a platform capability requires a session GoTrue established with a password, so a session Google minted holds none — is built as of 17.09.2026 (migration `20260919130000`); until then the refusal of a platform-staff Google sign-in was enforced in the browser only. Production still waits for a privacy policy and an Impressum; it needs no Google client of its own since the owner answered G3 on 17.09.2026 — one client serves both environments, declared with `GOOGLE_CLIENT_SHARED=true` in both `.env` files. **In review, not merged:** a platform account changes its own address with its current password and no code (owner’s decision, 17.09.2026) — company users keep the code, and the password proof in the session’s `amr` claim, at most ten minutes old, is unchanged and is now the only control, since the emailed code went to the *new* address and never proved anything about the account |
| **2** | Design system and prototype | `▰▰▰` **3/3** · 100% | ![on staging](https://img.shields.io/badge/-on%20staging-2ea44f) PR #17; approved when the owner asked to merge every open PR. Three contrast fixes followed on the legacy tokens every current screen still renders from: PR #72 put 73 button labels on `--text-inverse`; PR #76 darkened `--success` and `--warning` by the owner's decision of 17.09.2026, giving the fill its own `--success-solid` / `--warning-solid` because in the dark theme no single value can be both a legible fill and legible text; PR #79 did the same for `--danger` on 18.09.2026, so all three status colours now hold the Phase-2 palette's own values and the split exists in the dark theme only. ~200 theme-blind hardcoded hex colours are known and **deferred to phase 5** |
| **3** | Platform admin and permissions | `▰▰▰▰▰▰▱▱▱▱▱▱▱` **6/13** · 46% | ![building](https://img.shields.io/badge/-building-orange) restructured into slices on 15.09.2026; 3.0 (PR #12), 3.1 (PR #24), the first part of 3.6b (PR #36), 3.5 (PR #39), 3.9 (PR #38, hardened by PR #44) and 3.3 (PR #46, which raises `SCHEMA_EPOCH` to 2) merged; the 3.6c panel pages followed (PR #50, plus the Konto link in PR #48) and then 3.6a, the `/admin` front door with its own password sign-in (PR #57), both inside the 3.6 slice already counted at PR #36, so the tally does not move for a slice counted once; **3.4 (support sessions) is the slice that closes the temporary concession 3.3 shipped with, and its first half merged on 17.09.2026** (PR #56: `app_private.platform_company_contexts`, a read or support context for sixty minutes tied to the sign-in session, and `get_active_company_id()` answering it). **Its second half merged on 18.09.2026** (PR #80): the bar, opening and ending a context, and the fix for “entering a company”, which 3.4a had deliberately left dead by withdrawing the direct read. Rendering it on staging that day — the first time anyone had — found one defect: a full page reload threw the session out of the company, because the guard decided before `platform_whoami()` had answered and read “no company” out of an unanswered question. **PR #82 is that fix, in review**: the guard waits on a spinner rather than guessing, and never by assuming allowed. It also reports what the 15.09 plan had wrong (Abrechnung and Rollen were already correct) and what the browser cannot fix: `manage-users` ignores the support context entirely — its `list` route answers a platform caller with every account of every company, and five of its write routes act on any account in any company — and the `fahrtenbuch-files` and `company-logos` storage policies still resolve the company from the account's own profile, so an XLSX import and a logo upload are refused inside a support session. Both are pre-existing and both are SQL or edge-function work; the screens now name the cause instead of showing a raw error. The tally moves when the slice is complete; 3.2 cancelled on 16.09.2026 (platform admin sign-in stays password-only); the 3.8 conflict report merged (PR #21), and **the owner answered its six open rules on 17.09.2026, so 3.8-U1 — the one subscription model, expansion and backfill — merged**: `public.subscription_coverage` plus `app_private.recompute_company_subscription`, the only writer of `subscription_status`, `subscription_expires_at` and `plan`; one suspension state (`companies.status`), and a migration that refuses to apply if any company's or any profile's access changes. **He gave the grace number on 18.09.2026, so 3.8-U2 — the invoice and payment functions — is in review**: a paid invoice records the calendar month it names, an unpaid one grants until two business days after its due date and then closes, and cancelling withdraws the coverage while keeping the invoice and the payment. **U2 changes no company's admission at the moment of deploy** — it writes no coverage row and touches no invoice, and its self-check fails the release if one exists. `SCHEMA_EPOCH` stays at 2. **3.4's file half is in review (PR #84):** the bucket policies now read for the opened company in either mode and write only for a member or inside a support session, so a support session imports a Fahrtenbuch, uploads a logo and reads a Stundennachweis PDF, and a read-only context no longer writes the `documents` bucket; storage-api's claims carried no `amr` the database could read, so `jwt_amr()` learned its shape, without which no platform account held a role on any file request. No member's access changes. **3.12 is in review (PR #87):** the Team page reads `platform_staff_list`, a sixth audited read model for `staff.manage`, instead of folding the audit log, so the roster names members by address and grantor and no longer depends on how long the log is kept. **3.8-U3 merged (PR #85), and a fix to U1 is in review (PR #88):** a tier the owner sets on a company whose every period has ended is no longer written back by the next recompute (`20260920150000`, which writes no row) |
| **4** | Cash salary receipt | `▰▰▰` **3/3** · 100% | ![on staging](https://img.shields.io/badge/-on%20staging-2ea44f) logic and database (PR #13), screens, PDF and receipt list (PR #34), Bargeldbestand on the cash ledger (PR #43) and the receipt preview on the salary payment row (PR #49). **In review, not merged:** 4.3d (PR #69) — the owner's decision of 17.09.2026 that every cash salary payment goes through the Gehaltsquittung path, because a cash payment added on the salary screen wrote no `cash_movements` row, so the money left the till and the Bargeldbestand never moved; the weekly "Bar zurück" is deliberately excluded, since it counts as paid and never moves cash. and 4.3e (PR #73) — the other half of the overlapping-salary decision: the Gehälter screen now **deletes** a salary row, which is the whole merge, so it no longer means a direct database edit. No migration was needed; `salaries` already carries a DELETE policy gated on salaries-edit, pinned by the RLS matrix. A delete is refused for good when the row has a Gehaltsquittung, and until they are removed when it has payments — that second rule is the application's alone, since the foreign key would cascade them away silently. Editing a period was built and then removed under review: the screen matches a row to the selected period by exact equality of both ends, so widening a row drops it out of its own table and re-creates the overlap. The screen has not been rendered. And 4.3f (PR #75) — the receipt-numbering decision, answered on 17.09.2026: `GQ-YYYY-NNNN` now carries the **year of the salary** (`business_year`, the business year of `period_start`), not the year of the payment, so the number and the year already stored on the row can never disagree. Receipts issued before it keep the payment year and are never renumbered, so both conventions coexist in the history. The counter is unchanged and still gapless, per company and per that year. No `SCHEMA_EPOCH` bump, and no TypeScript: the browser never predicted a number. And 4.3g (PR #78) — its other half, the owner's decision of 18.09.2026 that the document must show the salary's business period, so the number explains itself: the sheet now prints **Abrechnungsmonat** beside its Zeitraum, from the `business_month` / `business_year` the row already stored, and the receipt list gets the same column. A salary whose period starts Thursday 01.01.2026 is numbered `GQ-2025-…` and now says *Dezember 2025* on the paper instead of leaving "2025" unexplained. No SQL: the two columns were written since `20260914140000` and merely never selected. And 4.3h (PR #81) — a rule rather than a feature, and the owner's decision of 18.09.2026: **a platform support session never issues, voids or signs a Gehaltsquittung, permanently.** PR #80 left the screens refusing but recorded it as provisional, on the stated ground that the receipt "records no actor" — which was wrong, it records three (`confirmed_by`, `voided_by`, `cash_movements.created_by`, all from `auth.uid()`), and a reason that expires would have been read as permission to reopen the rule once 3.4c's audit triggers land. The real reason cannot expire: a Gehaltsquittung attests to a physical handover of banknotes that no platform agent witnessed, which is attestation and not traceability. Named and not hidden: the refusal is the browser's alone — all three RPCs resolve the caller with `get_active_company_id()` and still succeed inside a context — and moving it into them is a recorded SQL follow-up for 3.4c. **No decision is open in this phase any more** |
| **5** | Design rollout | `▱▱▱▱▱` **0/5** | ![not started](https://img.shields.io/badge/-not%20started-lightgrey) |

**Overall:** `▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱` 23 of 37 steps · 62%

### Live on staging

- [x] **0.1** Login attempts limited per client — PR #2
- [x] **0.2** Every release kept, rollback with one button — PR #3
- [x] **0.3** Production deploys only what staging runs — PR #3
- [x] **0.4** Staging web behind a login — PR #5
- [x] **0.5** End-to-end suite, 5/5 passing; its first run found reset and invite links that signed users straight back out, fixed in the same PR — PR #7
- [x] Staging mail reaches real recipients through Resend, `example.com` excluded, by the owner's decision — PR #8, #9
- [x] **1.1** OTP database: code tables, rate-limited RPCs and one-transaction signup — PR #11
- [x] **1.0, 1.2–1.5** One-time codes for signup, "Passwort vergessen", invitations and email change; public signup closed, Google sign-in removed, and each function gets only the variables it needs — PR #16, #14
- [x] **Security fix:** anonymous callers can no longer list users, redeem discount or activation codes, or read a user's status. Closed by hand on production and staging on 15.09.2026, and made permanent by migration `20260915110000` — PR #15
- [x] **4.1–4.2** Cash receipt foundations: receipts, a cash ledger, gapless GQ numbering and integer-cent helpers; the Trinkgeld-Quittung prints amounts of 1000 € and more correctly again — PR #13
- [x] Landing page works on phones and tablets: sections stack to one column, and the mobile menu has Anmelden — PR #19
- [x] **2.1–2.3** Design system, interface audit and the approval prototype at `/design-preview` (staging and dev only; no existing screen changed) — PR #17
- [x] The product is named El-Professor in the docs, the landing page and the package; Y&A Mobility is one customer company — PR #20
- [x] **3.0** Permission matrix: seven roles × every table, view and client-callable RPC, including moving a row into another company; six more functions closed to anonymous callers — PR #12
- [x] **3.8 U0** Subscription conflict report: a read-only SQL report of where the subscription models disagree, run once on staging — PR #21
- [x] **3.8 U1** One subscription model, expansion and backfill: `subscription_coverage`, `recompute_company_subscription`, one suspension state, and a migration gated on nobody's access changing
- [x] **3.8 U2** One subscription model, the invoice and payment functions: paying records the invoiced month, an unpaid invoice grants two business days past its due date, cancelling withdraws the coverage — live on production since 19.09.2026
- [x] **3.8 U3** One subscription model, no direct writes: a trigger refuses any change to the five subscription columns of `companies` from the roles PostgREST serves, a catalogue check fails a release that adds another writer, and a vitest fails on a direct `.from('companies')` write; the e2e setup records coverage instead of writing the columns — PR #85
- [x] **3.8 fix** A tier the owner sets on a company whose every period has ended is no longer reverted by the next recompute: the recompute reads a tier only from a period that has not ended, the set `platform_company_set_plan` writes to; the migration writes no row. Two paths in U2's invoice apply stay open for the owner — PR #88, in review
- [x] **1.6, database part** Google sign-in groundwork: pending Google signups, one shared company insert, and register, reconcile and purge RPCs for the service role only; nothing calls them yet — PR #22
- [x] **Security fix:** `is_user_super_admin()` never answers NULL, and `create_user_profile_manual` is closed to anonymous callers (closed by hand on production and staging first) — PR #26
- [x] **Security:** five guarded RPCs are no longer executable by anonymous callers (none was exploitable) — PR #28
- [x] A generated activation code is emailed to the address on the code, or to the company admins; its validity stays 2 minutes — PR #30
- [x] **1.6, deploy part** Google sign-in deploy settings, switched off: Kong closes GoTrue signup, otp and magiclink (403, checked on every release), the auth entrypoint refuses any switch value but true or false, and oauth-account refuses platform staff — PR #29
- [x] **3.1** Platform authority: four staff roles (owner, support, billing, read_only) with a capability matrix, an append-only audit log, audited platform reads and writes in manage-users and generate-activation-code, and a profile guard that refuses JWT changes of company, staff flag and user id — PR #24
- [x] **4.3a** Gehaltsquittung screens: issue a cash salary receipt from the salary balance, a German PDF with the amount in words, the receipt list on Dokumente with void and signed-copy upload, and receipt payments locked in the salary details — PR #34
- [x] **3.6b, part 1** Audited platform read models: paginated company, vehicle, driver, user and audit-log lists for platform staff, each checking its capability and refusing to answer when its audit row cannot be written — PR #36
- [x] **3.5** Audited platform write RPCs: company approval, lifecycle, trial, plan, subscriptions, invoices and codes all go through one audited path, staff can be invited (owner role only until 3.3), and the discount-code, activation-attempt and approval-note holes are closed — PR #39
- [x] **3.9** Prices and the feature map move into the database: one price book and one plan-feature map, read by `compute_plan_price` and the app, written only by the roles the capability matrix allows (the feature map by the owner alone), with parity tests that pin today's numbers — PR #38
- [x] **3.9, hardening** Settings audit rows capped at 120 per actor per minute, an incomplete plan-feature map refused, and the rate-limit helper failing closed on a NULL actor; all three rules of the 3.5 audit guard re-checked on staging afterwards — PR #44
- [x] **1.6, screens part** Google sign-in screens, shipped with the provider switched off (`/auth/v1/settings` reports `google:false` in both environments): a Google button behind the settings check, a complete-registration page, error mapping that no longer swallows dead mail links, and a bounded recovery screen when the profile cannot be read. The platform-staff refusal is enforced in the browser only; the server-side rule waits for 3.3 — PR #45
- [x] **4.3b** Bargeldbestand and the Overview cash panel read one cash ledger: paginated queries, scope established before any figure is claimed, and German formatting on the new cards. The seeded staging check confirms a receipt paid in one month and voided in the next lowers the first month and raises the second — PR #43
- [x] **3.3** One policy shape for every tenant table: the RLS policies were rewritten onto capabilities in migration `20260917130000`, which raises `SCHEMA_EPOCH` to 2, so a rollback across this release is refused by design and the way back is the `pg_dump` snapshot taken before migrating. Platform staff cannot write tenant data outside a support session, and two billing tables gained a trigger pinning `company_id`. The per-company parity gate on staging reported 30 profiles and zero mismatches — PR #46
- [x] **3.6c** The four missing panel pages: Verzeichnisse (vehicles, drivers and users across all companies), Protokoll (the audit log), Einstellungen (the price book and the plan feature map) and Team, each reading the read models and write RPCs phase 3 already serves; the Konto link in the platform sidebar came with it — PR #50, #48
- [x] **4.3** The Gehaltsquittung preview on the salary payment row: the row already showed a lock badge and a link that navigated away to Dokumente, and now previews the stored receipt in place, with a PDF download — PR #49
- [x] **1.6, registration gate** A Google signup with no profile row is no longer read as "nothing to do": such an account reached `/overview` inside the tenant shell with `invalid input syntax for type uuid: "null"` errors instead of the complete-your-registration screen — PR #51
- [x] **Post-3.3 cleanup:** the Bargeldbestand ledger guard widened to the `business.read` capability instead of deleted, since `billing` does not hold that capability and would otherwise have been shown a false `0,00 €`; and the four `oauth_*` RPCs added to the RLS matrix, which now records a refusal for all seven principals — PR #53
- [x] **e2e** Staging is warmed up before the first assertion instead of the timeouts being raised again: the first `otp-request` after a quiet period answers **502 in ~130 ms**, so the error box was on screen 0.45 s after the click and no timeout could ever wait it out — PR #55
- [x] **3.6a** The `/admin` front door: the panel gets its own entry and its own sign-in page (email and password only — no code, no Google, no signup link), every refusal reading the same sentence so the page cannot say who is on the platform team. `/super-admin/*` keeps working as a rewrite onto `/admin/*` until slice 3.13 removes it together with the in-app links that still point there, and the remembered return path is validated rather than trusted — only a path inside the panel survives — PR #57. **The separate sign-in page was reversed the next day; see the entry below**
- [x] **One sign-in screen** (owner's decision, 17.09.2026, reversing half of 3.6a): `/login` is where platform accounts and company users alike sign in, and the account decides where the session goes. `/admin/login` is kept as a redirect onto it, carrying the remembered return path, which is re-validated at every step rather than trusted once. The Google button shows for everyone, because nothing knows who a visitor is before they sign in; a platform account that presses it is refused with a sentence, and the decision asks **how the session was minted** (`sessionCameFromGoogle`) and never whether the account has a Google identity. **Recorded, not hidden, and as measured fact:** the *network* surface is unchanged — the old page posted to the same `/auth/v1/token?grant_type=password` — so what widens is UI discoverability and credential stuffing by default. #57's uniform-refusal property is gone, but it protected nothing obtainable: GoTrue v2.170.0 verifies the password before it reports an unconfirmed address (measured on staging 17.09.2026 — wrong password `invalid_credentials`, correct password `email_not_confirmed`, unknown address `invalid_credentials`), so the distinct messages are not an address-existence oracle. What remains is the rate limit's shape: **per source IP**, 60 requests per 5 minutes on `/token` **shared between sign-ins and token refresh**, with no per-account counter and no lockout — it bounds a single-host brute force, scales away with rotating IPs, and can cost real users behind the same NAT their token refresh
- [x] **3.10 (second half) and 3.11** Settings for the mail sender's name and the text of the four one-time-code mails (subject, heading, paragraphs, button — every template seeded empty, so each mail is byte-identical until the owner changes a field; the code can never reach a subject; an unreadable template sends the default wording), the invoice PDF printing the `seller` setting (through `platform_invoice_seller()`, `companies.read`, one audited read per PDF — unchanged output until the seller is filled in), announcements for all companies, plans or named companies with a timestamp window and German/English text (the audience is never sent to a tenant), and feature flags (`useFlag`, off unless named; nothing reads one yet). Editors on the Einstellungen screen, rendered locally in light and dark. The test send (`platform-mail-test`) is not built — PR #89, in review
- [x] **1.6, deploy** One Google OAuth client for both environments (owner decision G3, 17.09.2026). The release guard no longer refuses a shared `GOOGLE_CLIENT_ID` outright — it refuses one that was not declared: `GOOGLE_CLIENT_SHARED=true` must stand in **both** `.env` files, the opt-in on one side only is refused with that side named, and any other value is refused like the switch. So sharing is a written decision rather than an accident of editing, and the partial mistake — the other environment's id pasted in with no opt-in — still fails the release; a wholesale copy of an `.env` is caught by the `PROJECT_NAME` guard that runs before it, not by this one. The risk the owner accepted: staging runs a copy of production's accounts, so one client is one consent screen and one token audience across both environments — PR #64
- [x] **Defect fix, the normal path:** a paying customer was locked out of its own product. Signup writes `status = 'trial'` with an inactive subscription, approval changes only the approval flag, and redeeming an activation code writes the subscription columns and never `status` — so `status` stays `trial` for ever, and on the day the trial window closed the **browser alone** called the company `trial_expired`, emptied the sidebar and put `LockedFeaturePage` on ten routes, while the server went on answering every query. The browser now asks the server's question: a live subscription makes a company active on its stored plan whatever `status` says, and the same subscription term gates the `active` branch, so the browser is nowhere more permissive than `get_active_company_id()` — with one carve-out the owner kept, a *running* trial. The platform dashboard reads the same way, or it would have contradicted the customer's own screen: it counted every paying customer in `expiredTrials` behind a red tile and raised a critical *Testphase abgelaufen* against it. Approved 17.09.2026 as class 3 of the subscription decision sheet — PR #68
- [ ] **0.6** First production release from CI — the owner presses the button. **Weigh first:** production has no `otp-request` today, so the first release brings both the function and the cold-boot 502 above

### Building now

Agents build in parallel git worktrees. Each branch ends in a reviewed PR into `staging`, and nothing merges on its own: PRs are merged one at a time, with the e2e suite after each staging release.

| Stream | Branch | State |
|---|---|---|
| Support sessions and the company workspace (3.4) | — | **approved on 16.09.2026 as the next slice**, ahead of 3.6a, 3.12, 3.7, 3.8 and 3.10–3.13. 3.3 shipped with a temporary concession the owner approved the same day: any staff role holding `business.read` reads every company's Fahrtenbuch, planning, historical and ledger data directly, with no audit row and no session. **3.4 is what closes it**, so the longer it waits the longer that concession stands. 3.6c's workspace tab waits for it too |
| Support sessions, the database and the functions (3.4a) | `phase3/support-sessions-db` | **PR #56, open and in rework — not merged** |
| The seller, the trial length and the invoice defaults (3.10, first half) | `phase3/settings-seller-trial` | PR #58, open |
| The forgot-password spec's timeout budget | `fix/e2e-forgot-password-headroom` | PR #59, open. Separate from the spec's other defect, which is still unfixed: the product's limit of five codes per address per hour refuses the sixth request while `otp-request` answers 202 regardless, so the suite waits for mail that was never sent. That fix belongs in the suite — **the limit must not be weakened** |
| The staff roster read model, `platform_staff_list` (3.12) | `phase3/platform-team-page` | **PR #87, in review.** The sixth audited read model (`staff.manage`, owners only), with each member's sign-in address and who granted the membership; the Team page reads it and no longer folds the audit log. The NULL actors on staging's staff rows came from rows written with no session, not from the staff functions — pinned in the RLS kit, not redefined. Non-owner roles stay refused (a separate PR, now a product decision). Audit retention (D4) still waits until this is live on production |

The post-3.3 cleanup **merged as PR #53** and is live on staging. It widened the Bargeldbestand ledger guard rather than deleting it: the ledger is in scope when the reader is in their own company **or** holds the `business.read` capability, because 3.3 grants that read by capability and `billing` does not hold it — deleting the guard outright would have reintroduced a confident and false `0,00 €` for a billing account. It also added the four missing `oauth_*` lines to the RLS matrix, which now record a refusal for all seven principals. The RLS kit was run against it before merging: all assertions passed, and the four `UNCOVERED` warnings are gone.

After 3.4, what remains of phase 3 is 3.6a, 3.12, 3.7a/b, 3.8 U3, 3.10, 3.11 and 3.13.

### Environments

| | production | staging |
|---|---|---|
| status | ![production](https://img.shields.io/website?url=https%3A%2F%2Felprofessor.eu&label=status&up_message=online&down_message=offline) | ![staging](https://img.shields.io/website?url=https%3A%2F%2Fapp.elprofessor.eu%2Fversion.txt&label=status&up_message=online&down_message=offline) |
| web | https://elprofessor.eu | https://app.elprofessor.eu (login required) |
| API | https://api.elprofessor.eu | https://api-staging.elprofessor.eu |
| branch | `main` — deployed by a manual button | `staging` — deployed on every push |
| mail | Resend directly (`GOTRUE_SMTP_HOST=smtp.resend.com`) | Mailpit keeps a copy and relays to Resend, except `@example.com` — left as it is by the owner's decision of 16.09.2026, because the e2e suite has no other way to read a one-time code. The mailbox is reachable at `mail-staging.elprofessor.eu` since 16.09.2026 |
| edge functions | the pre-pipeline bundle — no `otp-request`, `otp-verify`, `oauth-account` or `platform-staff` | all of them |
| platform panel | — | `/admin`, with its own sign-in, since PR #57 |
| GoTrue signup | closed since 16.09.2026 (`disable_signup:true`) | closed; Kong answers 403 on signup, otp and magiclink |
| Google sign-in | off, and stays off until the password-session rule exists | on since 16.09.2026 |

### Waiting on the owner

- Step 0.6: merge `staging` into `main` and press the production button. Its last technical blocker is gone — a production `OTP_PEPPER` was written on 16.09.2026 with the owner's approval. After the release: receive a real code mail at an address you own.
- ~~DNS record `mail-staging` → `159.195.205.30`~~ — **done on 16.09.2026.** It resolves and the mailbox opens in a browser behind its login.
- Rotate the secrets that were exposed in chat.
- Answer the agents' open questions listed in HANDOFF.md.
- Decide how overlapping salary rows are merged, and confirm the receipt numbering (details in HANDOFF.md).
- Phase 3 decisions D1–D13, seller data for invoices, and the admin email for the Y&A Mobility company account (listed in the plan).
- Google sign-in on production: a privacy policy and an Impressum, and decisions G1 and G2. **G3 is answered (17.09.2026): one Google OAuth client for both environments**, so production needs none of its own — add production's `/auth/v1/callback` to the client's authorised redirect URIs and put `GOOGLE_CLIENT_SHARED=true` in both `.env` files, or `deploy.sh` refuses the shared id. Staging's client is in place and the provider is on there.

---

## What it is

El-Professor is a multi-tenant SaaS for German taxi and Mietwagen fleet operators. It handles their monthly payroll and compliance paperwork: import the Fahrtenbuch (the XLSX ride log), assign drivers to vehicle blocks, and produce the Stundennachweise (statutory time records) and a corrected Fahrtenbuch that reconcile with the Steuerberater's payroll figures. Around that it keeps drivers, vehicles, Belege, salaries and the weekly Abrechnung.

It is a React SPA that talks directly to a self-hosted Supabase stack (PostgreSQL, Auth, Storage, Edge Functions); there is no application server of our own. The UI is German and English with German as the fallback, while generated documents, domain terms, money and dates stay German (`41,47`, `DD.MM.YYYY`).

## Run it locally

Needs Node.js 24 (`.nvmrc`) and npm.

```bash
npm install
cp .env.example .env   # then fill in the three keys below
npm run dev            # Vite dev server
npm run build          # typecheck ratchet, tests, vite build, mail templates
npm run test           # vitest run
```

| `.env` key | Value |
|---|---|
| `VITE_SUPABASE_URL` | API URL of the Supabase stack; staging's for day-to-day work |
| `VITE_SUPABASE_ANON_KEY` | that stack's anon key |
| `VITE_APP_URL` | origin baked into auth email links; may stay blank locally, must be the real domain in production |

End-to-end tests run against staging: `cd e2e && npm install && npm run setup && npm test` (details in [e2e/README.md](e2e/README.md)).

## Where to read more

- [CLAUDE.md](CLAUDE.md) — rules and mechanisms: architecture, environments and deployment, domain rules, sharp edges. Authoritative; read it before changing code.
- [HANDOFF.md](HANDOFF.md) — where things stand, host operations and open questions.
- [PROGRESS.md](PROGRESS.md) — progress log per step, with dates, PRs and what was verified (Arabic).
- [el-professor-plan.html](el-professor-plan.html) — the plan for the five requirements; open it in a browser (Arabic).
- [CONTRIBUTING.md](CONTRIBUTING.md) — branch model, commit messages and the rules that must not be traded away.
- [Docs/audit/](Docs/audit/) — code audit: verified findings and the phased remediation plan.
- [Docs/TECHNICAL_REFERENCE.md](Docs/TECHNICAL_REFERENCE.md) — the older developer reference: business rules, planning phases, schema, edge functions. It predates the self-hosted stack in places; CLAUDE.md and the code win.
