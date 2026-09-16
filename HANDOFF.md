# Handoff

Last updated: **16.09.2026**

Start here when you pick up this project. Read it together with [CLAUDE.md](CLAUDE.md), which holds the rules and how every mechanism works, and [PROGRESS.md](PROGRESS.md), which records what is done and what was verified. The owner-facing plan is [el-professor-plan.html](el-professor-plan.html). The older developer reference, moved out of the README in PR #18, is [Docs/TECHNICAL_REFERENCE.md](Docs/TECHNICAL_REFERENCE.md); where it disagrees with CLAUDE.md or the code, they win.

## Where things stand

- **Current work:** Phase 0 is done on staging except 0.6. Merged so far: PR #11, #16 and #14 (all of Phase 1's code), PR #15 (security fix), PR #13 (receipt foundations, steps 4.1 and 4.2), PR #17 (design system and prototype, 2.1–2.3), PR #20 (the product is named El-Professor), PR #12 (permission matrix, 3.0), PR #21 (3.8 U0 subscription conflict report), PR #22 (Google sign-in database, inert), PR #26 (NULL-safe super-admin check), PR #28 (anon revoked on five guarded RPCs), PR #30 (activation codes emailed when generated), PR #29 (Google sign-in deploy settings, Kong closed routes and oauth-account, switched off) and PR #24 (3.1 platform authority: platform_staff with four roles, the capability matrix, an append-only audit log, audited manage-users and generate-activation-code, and the profile guard). PR #34 added the Gehaltsquittung screens (plan 4.3a), and PR #36 the first part of 3.6b: audited platform read models for companies, vehicles, drivers, users and the audit log, each checking its capability and refusing when its audit row cannot be written. PR #39 added 3.5: audited platform write RPCs for companies, trials, plans, subscriptions, invoices and codes, staff invitations through a new platform-staff function, and the discount-code, activation-attempt and approval-note holes closed. PR #38 added 3.9: the price book and the plan-feature map now live in app_private.platform_settings, compute_plan_price reads them, and the parity tests pin today's numbers, and PR #44 hardened that slice (settings audit rows capped per actor, an incomplete feature map refused, the rate-limit helper failing closed on a NULL actor). PR #45 added the 1.6 sign-in screens, shipped with the provider switched off, and PR #43 the last part of 4.3: Bargeldbestand and the Overview cash panel read the cash_movements ledger. The release wrapper was reinstalled from PR #29 just before it merged on 16.09.2026; the previous one is kept as `/usr/local/sbin/el-professor-release.bak-20260916`. On 15.09.2026 the owner approved a restructured Phase 3 (slices 3.0–3.13: staff roles, audited reads, support sessions, a settings area, one subscription model), Google sign-in as step 1.6, and emailing each activation code when the platform admin generates it, with the validity unchanged at 2 minutes. An earlier idea from the same day, a trial code sent at approval (PR #25), was dropped by the owner and the PR closed. The plan file is the reference.
- **Done on staging:**
  - 0.1 login rate limits, PR #2.
  - 0.2 kept releases and rollback, PR #3. Rollback was exercised on the host.
  - 0.3 production gate, PR #3. It takes effect once the code reaches `main`.
  - 0.4 staging web login, PR #5.
- **0.5, end-to-end test tooling, PR #7:** `e2e/` (Playwright with the installed Chrome, Mailpit helper, `setup-staging.sh`). All five tests pass on staging, on `831de37` and again after `45ff313` deployed. Its first run found a live bug, fixed in the same PR: a password-reset or invite link signed the user straight back out when they had not used the app for 20 minutes. `AuthContext` now treats a session whose `last_sign_in_at` is under 5 minutes old as fresh, and `authRedirect` in `src/lib/supabase.ts` keeps the link type that supabase-js strips from the hash.
- **Next:** 0.6, the first production release from CI. Only the owner presses that button.
- **In progress since 14.09.2026, as a background workflow:** Phases 1–4 are being built in parallel worktrees.
  - Branches: `phase1/otp-db`, `phase1/otp-functions`, `phase1/otp-frontend`, `phase2/design-system`, `phase3/rls-baseline`, then `phase3/platform-authority`, and `phase4/receipt-foundations`.
  - Each branch ends in a reviewed PR into `staging`. Nothing from the agents is merged or deployed automatically.
  - Merge them one at a time, and run `cd e2e && npm test` after each staging deploy. Merge the OTP branches in order: `otp-db`, `otp-functions`, `otp-frontend`.
  - The first run (`wf_ce583f7b-774`) was cut off by a session restart. Its uncommitted work was saved as one `wip:` commit per branch. The second run (`wf_864f8ee2-06d`) died after five hours when this machine lost its network, and its work was saved the same way. The third run (`wf_c24553f4-594`) commits a checkpoint after every step and retries a build agent that dies. The dev machine slept overnight; the runtime restarted the agents that were cut off. By 15.09.2026 it had opened:
    - PR #11, OTP database. Review approved with six minor findings; merged.
    - PR #12, permission baseline. Review asked for two major changes: UPDATE probes never moved a row to another tenant, and a live hole. PR #15 closed the hole. The fix added a move probe that reaches only WITH CHECK (`SELECT … FOR UPDATE`, then `UPDATE … WHERE CURRENT OF`), proven by loosening one policy on purpose, and migration `20260915120000` for six more functions. Merged.
    - PR #13, receipt foundations. Review approved with seven minor findings. Merged after a dry run of its migration on staging.
    - PR #16, OTP edge functions, and PR #14, OTP screens. Both reviews approved, with 6 and 4 minor findings. Merged back to back.
    - PR #17, design system and prototype. Review approved; merged after the owner asked to merge every open PR.
  - The fourth run (`wf_29c78f4c-a9b`, 15.09.2026) builds the product name (PR #20, merged), Google sign-in PR A then PR B (shipped switched off), the 3.8 U0 subscription conflict report (PR #21), and 3.1 platform authority. After 3.1, 3.5, 3.6b and 3.9 follow. Slice 3.2 (a code at every platform sign-in) was cancelled by the owner on 16.09.2026: platform admin sign-in stays email and password only, and platform staff never sign in with Google. The Phase 1 `platform_login` objects stay merged and unused until the owner decides about them. The activation code email merged as PR #30: `generate-activation-code` mails the code to `target_email`, otherwise to the active, confirmed, non-staff admins of `company_id`; a failed mail never undoes the code.
  - The first e2e run after a staging release can time out, because the first call to an edge function boots a fresh isolate: the forgot-password test missed its 5 s wait right after PR #30 and again right after PR #29, and passed when rerun. Its two function-backed waits allow 20 s, and after the sign-in spec missed the same way once, the default expect timeout in playwright.config.ts is now 15 s. The 90 s test timeout still catches a real hang.
- **Gehaltsquittung screens (PR #34), what to know:**
  - The modal issues a receipt from the salary balance, prints a German PDF with the amount in words, lists receipts on Dokumente with void and signed-copy upload, and locks receipt payments in the salary details. No SQL changed; the RPCs come from PR #13.
  - Double booking: the request id is written to the tab sessionStorage the moment the request leaves, reused on retry and after a reload, and cleared on a definitive answer. Closing while the outcome is unknown goes through a confirmation. What it cannot cover: another tab, another browser, or cleared storage. A database-side guard is an open owner question.
  - `react-test-renderer` is a new dev dependency: the repository has no DOM test environment, and the lifecycle fix needed a rendered hook.
  - 4.3b followed in PR #43; see its entry below.
  - Owner questions are listed in the PR and in PROGRESS.md.
- **Bargeldbestand on the cash ledger (PR #43, plan 4.3b), what to know:**
  - `BargeldbestandPage` and the Overview cash panel read `cash_movements` through `utils/cashLedger.ts`. Both establish scope before making any claim: `cash_movements` and `salary_cash_receipts` are readable by the owning company only, so platform staff inside a customer read that customer's Bargeld and Belege and none of its movements. An empty set there is indistinguishable from "no payouts", so out of scope the payout card is dropped, the older "Bargeld − Belege" label kept, and the caveat carried into the Excel dump. Printing 0,00 € would have turned a missing read into a false claim.
  - Five defects from the review, all fixed before merge: a literal minus prefixed to an already-signed number (a receipt paid in one month and voided in the next rendered "−-300,00 €"); none of the three queries paginated, and the largest staging company already holds 836 receipts against PostgREST's silent 1000-row cap, so the balance would have under-reported cash with no failure signal; `calcCashSummary` had no test; an unknown `source_type` made real cash vanish from the balance rather than merely be miscategorised; and the two new cards rendered a decimal point instead of the German comma.
  - **What the merge gate proved and what it did not.** Staging holds zero cash movements, zero receipts and zero Gehaltsquittung payments across 19 companies, so every comparison in the parity script had a third term of exactly zero: it proved the two formulas equivalent and never exercised the divergence.
  - **The seeded check that does exercise it has now run on staging**, inside a transaction that ended in `ROLLBACK`, acting as the e2e test company's own admin under RLS rather than as a superuser: a driver, a salary of 300,00 € for March 2026, `confirm_salary_cash_payment` for 300,00 € dated 15.03.2026, then `void_salary_cash_receipt`. The payment produced receipt `GQ-2026-0001` and exactly one outgoing movement of 300,00 € in 2026-03; the void marked the receipt `voided` and produced one incoming movement of 300,00 € in 2026-09 — today's month, because a storno is booked on the day of the void. Net per month: 2026-03 is −300,00 €, 2026-09 is +300,00 €. The documented cash-book rule therefore holds against the live RPCs, not only in theory.
  - **Its limit:** that verified the database side — the RPCs write the movements with the right month attribution. It did not verify the screen, which rests on the four `calcCashSummary` tests PR #43 added, covering the same month boundary and the void landing in the next month. Nothing was left behind on staging, so a check against the rendered Bargeldbestand figures would still need data seeded and kept.
- **Follow-ups from 3.9 (PR #38), none blocking:**
  - ~~`platform_settings_get` writes an audit row per call with no rate limit~~ — closed by PR #44 (migration `20260917120000`): settings audit rows are capped at 120 per actor per minute, and the rate-limit helper now fails closed on a NULL actor instead of answering "not limited".
  - ~~The `plan_features` validator accepts a partial map~~ — closed by PR #44: an incomplete map is refused.
  - `AppConfigContext` reads the price book once per session, so a long session quotes stale prices.
  - The fail-closed rule (a feature the map does not name needs premium) and both parsers have no vitest coverage. PR #44 added a provider test that demonstrably fails against the unfixed code, but it covers the reload path, not this rule.
  - Two migrations share the prefix `20260916150000` (3.5's allowlist, 3.9's price book). Ordering is deterministic by filename and nothing is load-bearing; give each later slice its own prefix.
- **Audit allowlist, before merging 3.9 (PR #38):**
  - PR #39 ships `supabase/migrations/20260916150000_platform_audit_record_allowlist.sql`, which sets the allowed audit namespaces to `platform_staff|legacy|auth|platform_read`.
  - 3.9 adds `platform_settings`. Its migration must extend that allowlist to all five namespaces, never redefine the function from an older body, or it silently reopens forged audit rows.
  - 3.9 also has to move off the `20260916150000` prefix, which PR #39 now uses.
  - **Checked again after PR #44 merged**, read-only on staging: all three rules of the 3.5 audit guard are intact — the action allow-list, the reserved namespaces, and the 120-per-minute cap. Keep checking this after any migration that touches `platform_audit_record`; PR #38 came within one review of silently reverting the guard by redefining the function from an older body.
- **Settings hardening (PR #44, plan slice 3.9), what to know:**
  - Migration `20260917120000` bounds the settings audit rows at 120 per actor per minute, refuses an incomplete `plan_features` map, and makes the rate-limit helper fail closed on a NULL actor.
  - Four defects the review found, all fixed before merge: a change of signed-in account did not reload the configuration, because the effect watched a two-valued derivation of the user id, so switching between two signed-in accounts never re-ran it; `refresh()` could strand the loading spinner forever; a migration self-check demanded exactly 16 feature keys while the check below it asserted that an extra key is valid, which could abort a release for no reason; and the rate-limit helper returned "not limited" for a NULL actor, a fail-open default in a schema whose rule is the opposite. A provider test was added that demonstrably fails against the unfixed code.
  - Verified after the merge, read-only on staging: the ledger row is present, the NULL-actor branch really does return true, `plan_features` still holds 16 keys, anon can call neither settings RPC, and prices are unchanged and exact (advanced with 8 cars monthly 304,00 €, premium with 12 cars yearly 8.164,80 €). The RLS kit was re-run against the branch after the fixes and passed. e2e 12 passed.
- **Google sign-in screens (PR #45, plan 1.6 PR C), what to know:**
  - The screens ship with the provider **switched off**; `/auth/v1/settings` reports `google:false` in both environments and stays that way.
  - Fixed before merge: the Google error mapping was consulted before the intent check, so any GoTrue failure carrying `error=access_denied` — the shape it sends for a dead mail link — displayed "Die Anmeldung mit Google wurde abgebrochen" and hid the "Neuen Link anfordern" button; a failed profile read skipped the reconcile, the platform-staff refusal and the new registration gate at once, letting a company-less account reach the tenant router; signing out from the waiting page could land on a dead `/auth/callback`; reconcile ran on every page load forever for every Google customer; the button's wrapper still added 20px with the provider off; and an unread route value was dropped. A follow-up replaced the indefinite spinner a failed profile load produced with a recovery screen offering retry and sign-out, behind a bounded retry policy (3 attempts, 400 then 800 ms) that is unit-tested. 126 new vitest cases. e2e 13 passed, 1 skipped — the skip is the Google spec skipping itself while the provider is off, which is the intended assertion.
  - **Recorded honestly, as the PR body now does: the platform-staff refusal is enforced in the browser, not the server.** The database refuses platform staff in the three `oauth-account` actions and nowhere else, so a staff account that completed a Google sign-in would still hold a valid GoTrue JWT until our own JavaScript ended the session. The server-side rule — requiring the session JWT's `amr` claim to name the password method before any platform capability — is deliberately deferred until after slice 3.3 rewrites `is_user_super_admin`, and **Google stays switched off in both environments until it exists.**
- **3.1 platform authority (PR #24), what to know:**
  - Until 3.3 rewrites the older policies, `is_user_super_admin()` (any active staff row) gives every staff role owner-level writes. Grant no non-owner role on production before 3.3, and 3.5 must refuse creating one until then.
  - The production backfill makes every flagged profile an owner and prints how many of them still have a company. Staging had one owner and none with a company.
  - The platform_login eligibility inside `otp_issue` now reads the staff row. The Phase 1 platform_login objects stay unused, since 3.2 was cancelled.
  - Follow-up for 3.5: `platform_audit_record` lets any active staff role write unlimited rows attributed to itself; add a rate limit or restrict the outcome.
  - D2, D3 and D5 keep their conservative defaults. Rerun a single spec with `npx playwright test forgot-password` (a name filter; a Windows path argument finds no tests).
  - The laptop has 8 GB RAM. Agents run every `npm ci` and build through `buildlock.sh` in the session scratchpad (two machine-wide slots) and wrap RLS kit runs on the VPS in `flock /root/.el-professor-rls-kit.lock`.
- **Second security finding, 15.09.2026.** `create_user_profile_manual` was executable by anon.
  - **Why the guard failed:** it read `IF NOT is_user_super_admin()`, and the helper returned NULL for a caller without a profile. On top of that, `enforce_user_profile_privilege_guard` returns NEW when `auth.uid()` is NULL.
  - **No role changed:** the upsert still failed with 23502, because `user_profiles.email` is NOT NULL and the function never supplies it.
  - **Closed by hand, with the owner's approval:** EXECUTE revoked on production and staging (anon gets 401).
  - **Made permanent (PR #26, `20260915130000`):** it also makes `is_user_super_admin()` answer false, never NULL.
  - **Follow-ups from its scan:**
    - anon still holds EXECUTE on `reassign_fahrtenbuch_trip`, `delete_activation_code`, `hide_activation_code`, `revoke_activation_code` and `update_company_subscription_manual`. Their guards are NULL-safe; PR #28 (`20260915140000`) revoked anon and PUBLIC on all five.
    - `create_user_profile_manual` can never complete, and nothing calls `list_users_for_admin` or `create_user_account`. Drop them with a `SCHEMA_EPOCH` bump.
    - `preview_activation_code` compares its binding with a NULL-blind `<>` (3.5).
    - `enforce_user_profile_privilege_guard` passes any caller whose `auth.uid()` is NULL (3.1).
- **Function ownership, found in the PR #25 review.**
  - On the real databases, older SECURITY DEFINER functions such as `redeem_activation_code` are owned by `postgres`, which is not a superuser there.
  - `CREATE OR REPLACE` keeps that owner. A redefined function that calls an `app_private` helper then fails with "permission denied", while the RLS kit passes, because its fixture has no owners.
  - Add `ALTER FUNCTION … OWNER TO CURRENT_USER` and an owner self-check (see `phase3/platform-authority`, migration `20260916110010`).
- **Subscription conflict report (PR #21), counts on staging:**
  - 9 companies say `active` with no expiry, 8 of them suspended.
  - 2 still say `active` after their expiry.
  - 1 paying company is locked because its status is still `trial`.
  - 11 have suspension flags that disagree.
  - 1 subscription row is invoiced at a price that differs from the price book.
  - 2 open invoices are past due while access is active.
  - 1 old activation code has no recorded period.
  - U1 needs an owner rule (D8 to D10) for each class.
  - `OTP_PEPPER`: provisioned in staging's `.env` on 15.09.2026 (64 hex characters, never printed). Production needs its own, different one before 0.6, or its deploy is refused. That waits for the owner's go. All three OTP streams follow the contract kept at `C:\Users\ahmad\.claude\plans\otp-contract-wf_ce583f7b-774.md`, outside the repo.
- **Staging mail reaches real recipients** (owner's decision, 14.09.2026). Mailpit keeps a copy of every message and relays it through production's Resend account, except mail to `@example.com`. Live on staging since PR #8 (`45ff313`). Resend lists the relayed test mails to `delivered@resend.dev` as `delivered`.
- **Security fix, 15.09.2026.** Anyone holding the public anon key could call `list_users_for_admin()` and read every account's email, name and role.
  - **Why the guard failed:** it reads `IF auth.email() != 'support@…' THEN RAISE`. For an anonymous caller `auth.email()` is NULL, so the comparison is NULL and the RAISE never runs. Confirmed on staging: 15 rows came back.
  - **Closed by hand, with the owner's approval.** On production and staging, EXECUTE was revoked from anon and PUBLIC on `list_users_for_admin`, `create_user_account`, `redeem_discount_code`, `preview_activation_code` and `redeem_activation_code`. Signed-in users keep the activation functions and service_role keeps discount redemption. anon now gets 401.
  - **No sign of use:** Kong's production log starts 13.09.2026 and shows no call to these functions.
  - **Made permanent (PR #15):** migration `20260915110000_revoke_anon_from_unguarded_functions.sql`, which also closes `get_user_status` and `is_user_active` and fails the release if anon can still run any of them.
- **Receipt foundations (PR #13), for whoever builds step 4.3.** The screens wait for the owner's design approval. Carry these review findings into 4.3:
  - `payment_date` has no lower bound and no relation to the salary period.
  - A signed copy can be replaced without keeping the previous path.
  - The receipt month comes from `get_business_month(period_start)`, which mislabels a salary row that does not start on a Monday.
  - The RPCs and storage policies must adopt PLATFORM's server-side block once it exists.
  - When 4.3 ships, add the Gehaltsquittung to the closed list of German-only documents in `src/i18n/index.ts`.
- **Phase 1 on staging (PR #11, #16, #14).** Codes replace the links for signup, "Passwort vergessen", invitations and email changes.
  - GoTrue's public `/signup` is closed and answers 422 `signup_disabled`.
  - Each function receives only its allowlisted variables, and none gets `SUPABASE_DB_URL`.
  - `AuthCallbackPage` and GoTrue's link templates stay for one release, so a link mailed just before still works.
  - A staging rollback across #16 is refused on purpose, because it would reopen signup.
  - Phase 1 is not done until two things happen: the code flows pass on staging (with `@example.com` addresses only), and a real code reaches an owner's mailbox from production.
- **`main` is behind `staging`** by the Phase 0 work. Production still runs a bundle deployed before CI releases existed.

## What is live where

| | production | staging |
|---|---|---|
| web | `https://elprofessor.eu` — pre-CI bundle | `https://app.elprofessor.eu` — behind Basic Auth |
| API | `https://api.elprofessor.eu` | `https://api-staging.elprofessor.eu` |
| release record | none yet; the first CI release is step 0.6 | `/srv/PRO-staging/releases/`, `current` → the live one (`status staging`) |
| login rate limits | not yet; they arrive with 0.6 | on |
| mail | Resend | Mailpit, relaying to Resend except `@example.com`; `mail-staging` DNS record still missing |

## Installed on the host by hand, not by CI

- `/usr/local/sbin/el-professor-release`: `deploy/ci-release.sh`. It is the only thing the CI key can run: `release`, `rollback`, `status`. Reinstall it before merging a workflow change that relies on it.
- `/usr/local/sbin/el-professor-caddy-guard` plus its systemd `.path`/`.timer`/`.service` units: `deploy/caddy/guard.sh`.
- `/srv/caddy-sites/elprofessor.caddy`: the published routes. Change them only through `deploy/caddy/publish.sh`.
- `/srv/PRO-staging/deploy/set-staging-password.sh`, `set-mailpit-password.sh` and `set-staging-mail-relay.sh`.
- `/srv/PRO-staging/deploy/otp-housekeeping.sh`, scheduled by `/etc/cron.d/el-professor-otp` to run hourly and daily on staging. The production lines are added at 0.6.
- Previous versions are kept in `/root/el-professor-caddy-backups/` and `/root/el-professor-release.before-rollback-*`.

Secrets never enter git:

- `/srv/PRO*/deploy/.env`
- `/root/el-professor-secrets/staging-web-auth` (current staging user: `admon`)
- `/srv/PRO-staging/deploy/mailpit-ui-auth` (placeholder user `locked` until the owner sets a login)
- `/srv/PRO-staging/deploy/mailpit-relay.yml` (holds production's Resend key; `MAILPIT_RELAY_ALL` in staging's `.env` switches relaying on)

## Common operations

| Task | How |
|---|---|
| Deploy staging | Merge a PR into `staging`. |
| Deploy production | Merge `staging` into `main`, then Actions → Deploy → Run workflow on `main` and confirm `production`. The job refuses unless `main`'s tree is exactly what staging runs. |
| See what runs | On the host: `SSH_ORIGINAL_COMMAND="status staging" /usr/local/sbin/el-professor-release` |
| Roll back | Actions → Rollback, which is visible once `rollback.yml` is on `main`. Or on the host: `SSH_ORIGINAL_COMMAND="rollback staging" /usr/local/sbin/el-professor-release`. Undo it by deploying again. |
| Change routes | Edit `deploy/caddy/elprofessor.caddy`, then `EL_PROFESSOR_SSH=elprofessor bash deploy/caddy/publish.sh` |
| Change the staging login | `ssh -t root@159.195.205.30 /srv/PRO-staging/deploy/set-staging-password.sh` (without `-t` the prompts cannot read the password) |
| Staging mail relay | `ssh root@159.195.205.30 /srv/PRO-staging/deploy/set-staging-mail-relay.sh` turns it on; `--test` sends one mail to Resend's sink address; `--off` keeps mail on the host |
| Reach the host from the dev machine | `ssh elprofessor` (dedicated key; see memory) |
| Run the end-to-end tests | `cd e2e && npm install && npm run setup && npm test` (details in `e2e/README.md`) |

## Waiting on the owner

- **GoTrue signup is open on the production stack — a decision, not a task for us to take.** Measured read-only: `api.elprofessor.eu` reports `disable_signup:false` with `mailer_autoconfirm:true`, the Kong `auth-v1-closed` block is absent there (the three closed paths answer 405 on production where staging answers 403), and the anon key is in the public bundle as it must be. So `POST /auth/v1/signup` on the live product appears open to anyone, minting an auto-confirmed account with no company. **This was not verified by exploiting it — no account was created on production.** RLS keeps such an account away from customer data, but it holds a valid JWT, which passes the edge-function router, and `extract-receipt` spends `ANTHROPIC_API_KEY` on any request carrying a valid token with no role or tenant check. The cause is that production has never run a pipeline release, so PR #29's Kong guard never reached it — not anything in the three merges of 16.09.2026. **Proposed fix, awaiting the owner:** set `GOTRUE_DISABLE_SIGNUP=true` in production's `.env` and recreate only the auth container; the application never uses GoTrue signup, since signup goes through `signup_create_company` plus OTP codes.
- **`OTP_PEPPER` is missing from production's `.env`**, and `deploy.sh` refuses a release without one of at least 32 characters that production does not share with staging. It blocks step 0.6. Production's migration ledger is already baselined (154 rows against 17 companies), so `--baseline` is not needed.
- DNS A record `mail-staging` → `159.195.205.30`, then `set-mailpit-password.sh`.
- Step 0.6: merge `staging` into `main` and press the production button.
- Rotate the secrets that were exposed: root SSH password, production database password, and the Resend key pasted in chat.
- Phase 3 decisions D1–D13, seller data for invoices, and the admin email for the Y&A Mobility company account (all listed in the plan file).
- Google sign-in (1.6): two Google Cloud OAuth clients, one per environment, a privacy policy and an Impressum, and decisions G1–G3.
- Rules for each subscription conflict class before step U1 (D8 to D10), counts above.
- Questions the agents raised:
  - **OTP-DB.** If GoTrue confirmed a new owner's address but `signup_complete` then failed, may the owner finish with a new signup code? That needs a contract change; the alternative is that `otp-verify` retries completion.
  - **OTP-DB.** A new signup with an unverified address replaces the pending one immediately, which stops address squatting but lets anyone knock out a real owner. Keep that, or only replace one older than about 10 minutes?
  - **Baseline.** `get_current_cash_balance()` reads a receipts column that no longer exists and nothing calls it. Drop it or fix it?
  - **Baseline.** `storage.objects` policies are not in the matrix because the fixture is a public-schema dump. Take a schema-only storage dump before step 3.3 rewrites those policies?
  - **Receipt.** One staging company has overlapping salary rows: 5 drivers, 25 rows, 16 overlapping pairs, no exact duplicates. The owner needs to decide:
    - which row is the salary of record (the business month, say);
    - what happens to payments recorded on the others;
    - how overlaps are prevented afterwards. An exclusion constraint on driver and period needs `btree_gist`.

    Until then, `confirm_salary_cash_payment` refuses those rows with `overlapping_salary`.
  - **Receipt.** Receipt numbers are `GQ-YYYY-NNNN`, using the year of the payment date, gapless per company. Keep that, or use the salary's business year?
  - **OTP-FUNCTIONS.** Mail goes through a small SMTP client of our own, probed and unit-tested, instead of a pinned library. Accept it?
  - **OTP-FRONTEND.** An owner of a pending company cannot finish a password reset until approval, because `App.tsx` shows the waiting page before any route. Move `/auth/set-password` ahead of that gate?
- The user list was readable anonymously until 15.09.2026. The logs since 13.09.2026 show no use, and older logs are gone. Whether that needs a data-protection assessment is the owner's call.

## Gotchas learned the hard way

- **ridy is off limits.** Its deploys reset its Caddyfile. The guard restored our section on both of ridy's deploys on 14.09.2026 (10:57 and 11:11 CEST).
- **`gh pr merge --delete-branch` switches the local checkout to the local base branch,** which may be stale. Pull right after.
- **`workflow_dispatch` workflows only become runnable once the file is on the default branch** (`main`).
- **Quoting through `ssh '…'` turns `$[` into bash arithmetic expansion.** Send scripts with `ssh host bash -s <<'EOF'` instead.
- **Caddy accepts any `@name` as a named matcher,** so a template placeholder must be an invalid directive to fail closed.
- **The `Enter passphrase for key … id_ed25519` prompt is local to your machine.** Pressing Enter falls back to the server password.
- **GoTrue v2.170.0 only rate-limits when `GOTRUE_RATE_LIMIT_HEADER` is set;** otherwise it silently does nothing.
- **Playwright applies the config's `httpCredentials` to every request context, including `request.newContext()`.** A "visitor without a login" built that way silently sends the test login. Use Node's `fetch` for anonymous checks.
- **supabase-js strips the URL hash while it creates a session from a link.** Anything that needs `type=` or `error=` must read it before the client is created; see `authRedirect` in `src/lib/supabase.ts`.
- **A single-file bind mount whose file is missing becomes an empty directory.** Mailpit then cannot read `mailpit-relay.yml` and does not start, or starts without its UI login. `deploy.sh` checks both files before a staging release.
- **"No buffer space available" / `ERR_NO_BUFFER_SPACE` on the dev machine means it ran out of sockets,** not that the host is down. On 14.09.2026 the MyPublicWiFi service held 16,000 bound sockets, and e2e, git and ssh all failed until it let them go. It came back the same day, and six agents died after five hours with `ENOTFOUND`. Stopping the service is the only real fix.
- **Mailpit logs a relay only when it fails;** success is a debug line, so a quiet log is the good case. To see what Resend did with a mail, list `GET https://api.resend.com/emails` with production's key (pass the header on stdin with `curl -H @-`) and read `last_event`. Print only the fields you need: the list holds customers' addresses.
- **A `grep` that matches nothing ends a `set -euo pipefail` script silently** — the same trap as the `.env` reads in `deploy.sh`. It hid the result of the first relay test, which had in fact been delivered.
- **On Windows, vitest rewrites the golden `.snap` files with LF line endings.** The content is byte-identical and `git diff` is empty, but with `core.autocrlf=true` git lists them as modified. Restore them with `git checkout -- src/utils/__snapshots__/` and never commit them. A `.gitattributes` line `src/utils/__snapshots__/*.snap text eol=lf` would end the churn.
- **A release copies only part of `deploy/`.** `install_release` copies the compose file, `kong.yml`, `nginx-spa.conf`, `deploy.sh`, `init-db`, the functions, the migrations and `dist`. Any other script the host runs (`set-*.sh`, `otp-housekeeping.sh`) stays at the copy installed by hand, so reinstall it when it changes.
- **Supabase grants EXECUTE on every new function to PUBLIC, anon and authenticated.** A function meant for service_role only needs all three revoked; `20260911120000` missed anon. A guard written as `auth.email() != '…'` or `auth.uid() <> …` lets an anonymous caller through, because the comparison is NULL. For every SECURITY DEFINER function a PR adds, check `has_function_privilege('anon', …)`.
- **Never delete a PR's branch before `gh pr view N --json state` says MERGED.** On 15.09.2026 a merge failed on a GitHub TLS timeout, the script deleted the branch anyway, and GitHub closed PR #11 unmerged. Pushing the head commit back and `gh pr reopen` recovered it.
- **An inline `style` beats a Tailwind class.** Most screens set their layout in `style={{…}}`, which cannot change with the screen width. A class such as `hidden md:flex` next to an inline `display` hides nothing. On 15.09.2026 that kept the landing page two to four columns wide on phones. Anything that has to follow the viewport (grid columns, padding, display) belongs in classes, not in the style object.
- **The Workflow tool does not save an agent's worktree.** When a run is cut off, commit what is on disk (as `wip:`) before relaunching; a resumed run only replays agents that had finished.

## Keeping this file honest

Every fix or feature updates, in the same PR:

- this file
- `PROGRESS.md`
- the "Project status" section of `README.md`
- the progress table in `el-professor-plan.html`
- `CLAUDE.md`, when a rule or mechanism changed
