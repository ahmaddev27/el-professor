# Handoff

Last updated: **15.09.2026**

Start here when you pick up this project. Read it together with [CLAUDE.md](CLAUDE.md), which holds the rules and how every mechanism works, and [PROGRESS.md](PROGRESS.md), which records what is done and what was verified. The owner-facing plan is [el-professor-plan.html](el-professor-plan.html). The older developer reference, moved out of the README in PR #18, is [Docs/TECHNICAL_REFERENCE.md](Docs/TECHNICAL_REFERENCE.md); where it disagrees with CLAUDE.md or the code, they win.

## Where things stand

- **Current work:** Phase 0 is done on staging except 0.6. Merged so far: PR #11, #16 and #14 (all of Phase 1's code), PR #15 (security fix), PR #13 (receipt foundations, steps 4.1 and 4.2), PR #17 (design system and prototype, 2.1–2.3), PR #20 (the product is named El-Professor), PR #12 (permission matrix, 3.0), PR #21 (3.8 U0 subscription conflict report), PR #22 (Google sign-in database, inert), PR #26 (NULL-safe super-admin check), PR #28 (anon revoked on five guarded RPCs), PR #30 (activation codes emailed when generated) and PR #29 (Google sign-in deploy settings, Kong closed routes and oauth-account, switched off). The release wrapper was reinstalled from PR #29 just before it merged on 16.09.2026; the previous one is kept as `/usr/local/sbin/el-professor-release.bak-20260916`. On 15.09.2026 the owner approved a restructured Phase 3 (slices 3.0–3.13: staff roles, audited reads, support sessions, a settings area, one subscription model), Google sign-in as step 1.6, and emailing each activation code when the platform admin generates it, with the validity unchanged at 2 minutes. An earlier idea from the same day, a trial code sent at approval (PR #25), was dropped by the owner and the PR closed. The plan file is the reference.
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
  - The first e2e run after a staging release can time out, because the first call to an edge function boots a fresh isolate: the forgot-password test missed its 5 s wait right after PR #30 and again right after PR #29, and passed when rerun. Its two function-backed waits now allow 20 s. Rerun a single spec with `npx playwright test forgot-password` (a name filter; a Windows path argument finds no tests).
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
