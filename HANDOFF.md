# Handoff

Last updated: **14.09.2026**

Start here when you pick up this project. Read it together with [CLAUDE.md](CLAUDE.md), which holds the rules and how every mechanism works, and [PROGRESS.md](PROGRESS.md), which records what is done and what was verified. The owner-facing plan is [el-professor-plan.html](el-professor-plan.html).

## Where things stand

- **Current work:** Phase 0 of the requirements plan (releases, rollback, staging protection).
- **Done on staging:**
  - 0.1 login rate limits, PR #2.
  - 0.2 kept releases and rollback, PR #3. Rollback was exercised on the host.
  - 0.3 production gate, PR #3. It takes effect once the code reaches `main`.
  - 0.4 staging web login, PR #5.
- **0.5, end-to-end test tooling, PR #7:** `e2e/` (Playwright with the installed Chrome, Mailpit helper, `setup-staging.sh`). Its first run found a live bug, fixed in the same PR: a password-reset or invite link signed the user straight back out when they had not used the app for 20 minutes. `AuthContext` now treats a session whose `last_sign_in_at` is under 5 minutes old as fresh, and `authRedirect` in `src/lib/supabase.ts` keeps the link type that supabase-js strips from the hash.
- **Next:** 0.6, the first production release from CI. Only the owner presses that button.
- **In progress since 14.09.2026, as a background workflow:** Phases 1–4 are being built in parallel worktrees.
  - Branches: `phase1/otp-db`, `phase1/otp-functions`, `phase1/otp-frontend`, `phase2/design-system`, `phase3/rls-baseline`, then `phase3/platform-authority`, and `phase4/receipt-foundations`.
  - Each branch ends in a reviewed PR into `staging`. Nothing from the agents is merged or deployed automatically.
  - Merge them one at a time, and run `cd e2e && npm test` after each staging deploy. Merge the OTP branches in order: `otp-db`, `otp-functions`, `otp-frontend`.
  - The first run (`wf_ce583f7b-774`) was cut off by a session restart. Its uncommitted work was saved as one `wip:` commit per branch, and a second run continues from those commits. All three OTP streams follow the contract kept at `C:\Users\ahmad\.claude\plans\otp-contract-wf_ce583f7b-774.md`, outside the repo.
- **Staging mail reaches real recipients** (owner's decision, 14.09.2026). Mailpit keeps a copy of every message and relays it through production's Resend account, except mail to `@example.com`. Branch `phase0/staging-mail-relay`; its settings file was provisioned on the host before the merge.
- **`main` is behind `staging`** by the Phase 0 work. Production still runs a bundle deployed before CI releases existed.

## What is live where

| | production | staging |
|---|---|---|
| web | `https://elprofessor.eu` — pre-CI bundle | `https://app.elprofessor.eu` — behind Basic Auth |
| API | `https://api.elprofessor.eu` | `https://api-staging.elprofessor.eu` |
| release record | none yet; the first CI release is step 0.6 | `/srv/PRO-staging/releases/`, `current` → `831de37` |
| login rate limits | not yet; they arrive with 0.6 | on |
| mail | Resend | Mailpit, relaying to Resend except `@example.com`; `mail-staging` DNS record still missing |

## Installed on the host by hand, not by CI

- `/usr/local/sbin/el-professor-release`: `deploy/ci-release.sh`. It is the only thing the CI key can run: `release`, `rollback`, `status`. Reinstall it before merging a workflow change that relies on it.
- `/usr/local/sbin/el-professor-caddy-guard` plus its systemd `.path`/`.timer`/`.service` units: `deploy/caddy/guard.sh`.
- `/srv/caddy-sites/elprofessor.caddy`: the published routes. Change them only through `deploy/caddy/publish.sh`.
- `/srv/PRO-staging/deploy/set-staging-password.sh`, `set-mailpit-password.sh` and `set-staging-mail-relay.sh`.
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
- **"No buffer space available" / `ERR_NO_BUFFER_SPACE` on the dev machine means it ran out of sockets,** not that the host is down. On 14.09.2026 the MyPublicWiFi service held 16,000 bound sockets, and e2e, git and ssh all failed until it let them go.
- **The Workflow tool does not save an agent's worktree.** When a run is cut off, commit what is on disk (as `wip:`) before relaunching; a resumed run only replays agents that had finished.

## Keeping this file honest

Every fix or feature updates, in the same PR:

- this file
- `PROGRESS.md`
- the "Project status" section of `README.md`
- the progress table in `el-professor-plan.html`
- `CLAUDE.md`, when a rule or mechanism changed
