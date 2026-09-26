# El-Professor

[![Deploy](https://github.com/ahmaddev27/el-professor/actions/workflows/deploy.yml/badge.svg?branch=staging&event=push)](https://github.com/ahmaddev27/el-professor/actions/workflows/deploy.yml)
[![PR checks](https://github.com/ahmaddev27/el-professor/actions/workflows/pr-checks.yml/badge.svg?event=pull_request)](https://github.com/ahmaddev27/el-professor/actions/workflows/pr-checks.yml)
[![Production](https://img.shields.io/website?url=https%3A%2F%2Felprofessor.eu&label=production&up_message=online&down_message=offline)](https://elprofessor.eu)
[![Staging](https://img.shields.io/website?url=https%3A%2F%2Fapp.elprofessor.eu%2Fversion.txt&label=staging&up_message=online&down_message=offline)](https://app.elprofessor.eu)
[![E2E on staging](https://img.shields.io/badge/e2e%20on%20staging-16%20passed%2C%201%20skipped-2ea44f)](e2e/README.md)
[![Plan](https://img.shields.io/badge/plan-36%20of%2040%20steps%20·%2090%25-2ea44f)](el-professor-plan.html)

![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-self--hosted-3FCF8E?logo=supabase&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-e2e-2EAD33?logo=playwright&logoColor=white)
![Languages](https://img.shields.io/badge/UI-Deutsch%20%7C%20English-555555)

---

## What it is

A multi-tenant SaaS for German taxi and Mietwagen fleets: import the monthly Fahrtenbuch (the XLSX ride log), assign drivers to vehicle blocks, and produce the Stundennachweise and a corrected Fahrtenbuch that reconcile with the Steuerberater's figures. Around that it keeps drivers, vehicles, Belege, salaries, the weekly Abrechnung and the cash till.

A React SPA on a self-hosted Supabase stack (PostgreSQL, Auth, Storage, Edge Functions); there is no application server of our own. The UI is German and English with German as the fallback, and generated documents, domain terms, money and dates stay German (`41,47`, `DD.MM.YYYY`). Since 23.09.2026 every screen is converted: the engines name a dictionary key beside their German text (PR #112) and the last visible labels, buttons and empty states go through `t(...)`.

## Status

> Last update: **24.09.2026**. A step counts once it is merged into `staging` and verified there.

`▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱` **36 of 40 steps · 90%**

| Phase | What | Progress | State |
|---|---|---|---|
| **0** | Releases, rollback, staging protection | `▰▰▰▰▰▰` 6/6 | live on both |
| **1** | OTP and account security | `▰▰▰▰▰▰▱` 6/7 | Google sign-in is on for staging; production waits only for the owner's Impressum and privacy text |
| **2** | Design system and prototype | `▰▰▰` 3/3 | live |
| **3** | Platform panel and permissions | `▰▰▰▰▰▰▰▰▰▰▰▰▱` 12/13 | 3.13b open as a PR: the company’s own settings are read inside a context, nothing links to `/super-admin` any more, and the Benutzer list no longer stops at GoTrue’s first 50 accounts. The `support`, `billing` and `read_only` staff roles are enabled in review (owner’s decision, 23.09.2026). Company permissions: slice C reaches the tables it did not (PR #110) and **slice B lets a company name a role of its own** (PR #117) — the global unique name that made that impossible was also the only thing stopping a role called `admin` from granting administration by name |
| **4** | Cash salary receipt | `▰▰▰` 3/3 | live |
| **5** | Design rollout | `▰▰▰▰▱` 4/5 | every screen batch merged; the frame itself — `AppLayout`, the sidebar, the two banners and the support bar — is open as a PR. `AdminLayout` stays legacy on purpose |
| **FA** | Fahrtenbuch analysis | `▰▰▱` 2/3 | import reliability and the analysis engine are live; the settings tables and the Fahrtenanalyse screen are open as a PR — it shows and explains a month of imported rides and changes no trip |
| **BN** | Notifications | `▰` 1/1 | open as a PR. The Benachrichtigungen screen had been a preference panel for a feature that was never built — nothing read its table. A TÜV expiry and a trial end now reach the company's administrators, once per occurrence and never nightly, and a paying customer still on `status = 'trial'` is told nothing about a trial. **Nothing is sent until the owner approves one host cron line** |

**Production serves `9f5e833`** (23.09.2026): phase 5 complete, the legal pages, the invoice-coverage fix, Fahrtenbuch import reliability, and two defects that had been live — an Inhaber saved as an employee when edited, and every user edit without a new password failing.

**In review, outside the phase table:** the RLS kit could be lied to. PostgreSQL resolves schema `USAGE` when a statement is *parsed* and plpgsql caches the parsed form, so a privilege error inside a `SECURITY INVOKER` trigger is raised only for the first role that cannot parse it — and the permission matrix runs every fixture as the owner before it probes anyone. PR #117's roles trigger reached `app_private`, which no company administrator may use: the feature was dead for every user and the kit passed twice. One `DISCARD PLANS` per principal closes it, a regression section fails if that is reverted, and two catalogue rules in `assertions.sql` stop the shape coming back. What the cache masks is a table rather than a sentence, and it is measured rather than read off the source — a reading of PostgreSQL's internals was wrong three times here, in both directions. Schema `USAGE` is masked; `EXECUTE` is masked only for an inlinable `sql` callee and not for a plpgsql one or one carrying a `SET` clause; table privileges and RLS are not. One thing is measured and **unexplained** — why the matrix's `roles I` cell moved — and it is recorded as open rather than guessed at. The mask is also **not** confined to a test fixture: two ordinary roles on one pooled connection are enough, one holding a privilege and one not. **Production exposure is nil today, measured read-only** — no schema and no inlinable function is granted unevenly across the three roles PostgREST uses in a way anything reaches, and none of them can use `app_private` at all — but it is a standing property, so a migration that grants one of those roles what another lacks reopens it. The two queries to re-run are in CLAUDE.md.

Detail lives elsewhere, one place each: [PROGRESS.md](PROGRESS.md) per step with dates and PRs (Arabic), [HANDOFF.md](HANDOFF.md) for where things stand and how to pick the work up, [el-professor-plan.html](el-professor-plan.html) for the plan (Arabic).

## Waiting on the owner

- **The Impressum and the privacy text**, filled once in `/admin` → settings. Google sign-in on production is then one switch and one Deploy.
- **Rotate the secrets that were exposed in chat.**
- **The notification job's cron line**, staging first, after reading a dry run. Staging mail reaches real customers, so arming it there is a decision of its own. [HANDOFF.md](HANDOFF.md) has the dry run and both lines.
- **D14 — whether the panel's company list and its money move behind audited read models.** Slice 3.13b closed the last *company-owned* table a platform account read by capability; `companies` and the three subscription tables stay on `companies.read` by plan 3.A's design. Closing them is a UI change to four screens, not a policy edit. [HANDOFF.md](HANDOFF.md) has the lift.
- The open decisions and questions listed in [HANDOFF.md](HANDOFF.md), including how overlapping salary rows are merged.

## Environments

| | production | staging |
|---|---|---|
| web | https://elprofessor.eu | https://app.elprofessor.eu (login required) |
| API | https://api.elprofessor.eu | https://api-staging.elprofessor.eu |
| branch | `main` — deployed by a manual button | `staging` — deployed on every push |
| mail | Resend | Mailpit keeps a copy and relays to Resend, except `@example.com`; read it at mail-staging.elprofessor.eu |
| Google sign-in | off until the legal pages are filled | on |
| GoTrue signup | closed; Kong answers 403 on signup, otp and magiclink | the same |

## Run it locally

Needs Node.js 24 (`.nvmrc`) and npm.

```bash
npm install
cp .env.example .env   # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_APP_URL
npm run dev            # Vite dev server
npm run build          # ratchets, tests, vite build, mail templates
npm run test           # vitest run
```

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` point at a Supabase stack — staging's for day-to-day work. `VITE_APP_URL` is the origin baked into auth email links; it may stay blank locally and must be the real domain in production.

End-to-end tests run against staging: `cd e2e && npm install && npm run setup && npm test` ([e2e/README.md](e2e/README.md)). The SQL boundary is checked with the RLS kit, which runs on the VPS ([CLAUDE.md](CLAUDE.md)).

## Where to read more

- [CLAUDE.md](CLAUDE.md) — rules and mechanisms: architecture, deployment, domain rules, sharp edges. Authoritative; read it before changing code.
- [CONTRIBUTING.md](CONTRIBUTING.md) — branch model, commit messages, and the rules that must not be traded away.
- [Docs/audit/](Docs/audit/) — the code audit: verified findings and the phased remediation plan.
- [Docs/TECHNICAL_REFERENCE.md](Docs/TECHNICAL_REFERENCE.md) — the older developer reference; it predates the self-hosted stack in places, and CLAUDE.md and the code win.
