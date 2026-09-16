# El-Professor

[![Deploy](https://github.com/ahmaddev27/el-professor/actions/workflows/deploy.yml/badge.svg?branch=staging&event=push)](https://github.com/ahmaddev27/el-professor/actions/workflows/deploy.yml)
[![PR checks](https://github.com/ahmaddev27/el-professor/actions/workflows/pr-checks.yml/badge.svg?event=pull_request)](https://github.com/ahmaddev27/el-professor/actions/workflows/pr-checks.yml)
[![Production](https://img.shields.io/website?url=https%3A%2F%2Felprofessor.eu&label=production&up_message=online&down_message=offline)](https://elprofessor.eu)
[![Staging](https://img.shields.io/website?url=https%3A%2F%2Fapp.elprofessor.eu%2Fversion.txt&label=staging&up_message=online&down_message=offline)](https://app.elprofessor.eu)
[![E2E on staging](https://img.shields.io/badge/e2e%20on%20staging-5%2F5%20passing-2ea44f)](e2e/README.md)

![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-self--hosted-3FCF8E?logo=supabase&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-e2e-2EAD33?logo=playwright&logoColor=white)
![Languages](https://img.shields.io/badge/UI-Deutsch%20%7C%20English-555555)

![Requirements plan](https://img.shields.io/badge/requirements%20plan-21%20of%2037%20steps-yellow)
![Phase 0](https://img.shields.io/badge/phase%200-5%2F6-yellowgreen)
![Phases 1–4](https://img.shields.io/badge/phases%201%E2%80%934-building-orange)
![Phase 5](https://img.shields.io/badge/phase%205-not%20started-lightgrey)

---

## Project status

> Kept current with every fix and feature. Last update: **15.09.2026**.

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
| **1** | OTP and account security | `▰▰▰▰▰▰▱` **6/7** · 86% | ![on staging](https://img.shields.io/badge/-on%20staging-2ea44f) PRs #11, #16, #14; done once the code flows pass on staging and a real code arrives from production. 1.6 Google sign-in: database (PR #22) and deploy settings (PR #29) are on staging, switched off; the sign-in screens wait for the Google Cloud clients, a privacy policy and an Impressum |
| **2** | Design system and prototype | `▰▰▰` **3/3** · 100% | ![on staging](https://img.shields.io/badge/-on%20staging-2ea44f) PR #17; approved when the owner asked to merge every open PR |
| **3** | Platform admin and permissions | `▰▰▰▰▱▱▱▱▱▱▱▱▱` **4/13** · 31% | ![building](https://img.shields.io/badge/-building-orange) restructured into slices on 15.09.2026; 3.0 (PR #12), 3.1 (PR #24), the first part of 3.6b (PR #36) and 3.5 (PR #39) merged; 3.9 building; 3.2 cancelled on 16.09.2026 (platform admin sign-in stays password-only); the 3.8 conflict report merged (PR #21) |
| **4** | Cash salary receipt | `▰▰▰` **3/3** · 100% | ![on staging](https://img.shields.io/badge/-on%20staging-2ea44f) logic and database (PR #13), screens, PDF and receipt list (PR #34); the Bargeldbestand page still reads the old source (4.3b) |
| **5** | Design rollout | `▱▱▱▱▱` **0/5** | ![not started](https://img.shields.io/badge/-not%20started-lightgrey) |

**Overall:** `▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱` 21 of 37 steps · 57%

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
- [x] **1.6, database part** Google sign-in groundwork: pending Google signups, one shared company insert, and register, reconcile and purge RPCs for the service role only; nothing calls them yet — PR #22
- [x] **Security fix:** `is_user_super_admin()` never answers NULL, and `create_user_profile_manual` is closed to anonymous callers (closed by hand on production and staging first) — PR #26
- [x] **Security:** five guarded RPCs are no longer executable by anonymous callers (none was exploitable) — PR #28
- [x] A generated activation code is emailed to the address on the code, or to the company admins; its validity stays 2 minutes — PR #30
- [x] **1.6, deploy part** Google sign-in deploy settings, switched off: Kong closes GoTrue signup, otp and magiclink (403, checked on every release), the auth entrypoint refuses any switch value but true or false, and oauth-account refuses platform staff — PR #29
- [x] **3.1** Platform authority: four staff roles (owner, support, billing, read_only) with a capability matrix, an append-only audit log, audited platform reads and writes in manage-users and generate-activation-code, and a profile guard that refuses JWT changes of company, staff flag and user id — PR #24
- [x] **4.3a** Gehaltsquittung screens: issue a cash salary receipt from the salary balance, a German PDF with the amount in words, the receipt list on Dokumente with void and signed-copy upload, and receipt payments locked in the salary details — PR #34
- [x] **3.6b, part 1** Audited platform read models: paginated company, vehicle, driver, user and audit-log lists for platform staff, each checking its capability and refusing to answer when its audit row cannot be written — PR #36
- [x] **3.5** Audited platform write RPCs: company approval, lifecycle, trial, plan, subscriptions, invoices and codes all go through one audited path, staff can be invited (owner role only until 3.3), and the discount-code, activation-attempt and approval-note holes are closed — PR #39
- [ ] **0.6** First production release from CI — the owner presses the button

### Building now

Agents build in parallel git worktrees. Each branch ends in a reviewed PR into `staging`, and nothing merges on its own: PRs are merged one at a time, with the e2e suite after each staging release.

| Stream | Branch | State |
|---|---|---|
| Prices and features in the database (3.9) | `phase3/pricing-settings` | PR #38, fixing review findings |

### Environments

| | production | staging |
|---|---|---|
| status | ![production](https://img.shields.io/website?url=https%3A%2F%2Felprofessor.eu&label=status&up_message=online&down_message=offline) | ![staging](https://img.shields.io/website?url=https%3A%2F%2Fapp.elprofessor.eu%2Fversion.txt&label=status&up_message=online&down_message=offline) |
| web | https://elprofessor.eu | https://app.elprofessor.eu (login required) |
| API | https://api.elprofessor.eu | https://api-staging.elprofessor.eu |
| branch | `main` — deployed by a manual button | `staging` — deployed on every push |
| mail | Resend | Mailpit keeps a copy and relays to Resend, except `@example.com` |

### Waiting on the owner

- DNS record `mail-staging` → `159.195.205.30`, then a Mailpit login.
- Step 0.6: merge `staging` into `main` and press the production button.
- Approve a production `OTP_PEPPER` before 0.6, and after it, receive a real code mail at an address you own.
- Rotate the secrets that were exposed in chat.
- Answer the agents' open questions listed in HANDOFF.md.
- Decide how overlapping salary rows are merged, and confirm the receipt numbering (details in HANDOFF.md).
- Phase 3 decisions D1–D13, seller data for invoices, and the admin email for the Y&A Mobility company account (listed in the plan).
- Google sign-in: two Google Cloud OAuth clients (production and staging), a privacy policy and an Impressum, and decisions G1–G3.

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
