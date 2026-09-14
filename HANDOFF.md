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
- **Next:** 0.5, end-to-end test tooling. Then 0.6, the first production release from CI. Only the owner presses that button.
- **`main` is behind `staging`** by the Phase 0 work. Production still runs a bundle deployed before CI releases existed.

## What is live where

| | production | staging |
|---|---|---|
| web | `https://elprofessor.eu` — pre-CI bundle | `https://app.elprofessor.eu` — behind Basic Auth |
| API | `https://api.elprofessor.eu` | `https://api-staging.elprofessor.eu` |
| release record | none yet; the first CI release is step 0.6 | `/srv/PRO-staging/releases/`, `current` → `d18285f` |
| login rate limits | not yet; they arrive with 0.6 | on |
| mail | Resend | Mailpit; `mail-staging` DNS record still missing |

## Installed on the host by hand, not by CI

- `/usr/local/sbin/el-professor-release`: `deploy/ci-release.sh`. It is the only thing the CI key can run: `release`, `rollback`, `status`. Reinstall it before merging a workflow change that relies on it.
- `/usr/local/sbin/el-professor-caddy-guard` plus its systemd `.path`/`.timer`/`.service` units: `deploy/caddy/guard.sh`.
- `/srv/caddy-sites/elprofessor.caddy`: the published routes. Change them only through `deploy/caddy/publish.sh`.
- `/srv/PRO-staging/deploy/set-staging-password.sh` and `set-mailpit-password.sh`.
- Previous versions are kept in `/root/el-professor-caddy-backups/` and `/root/el-professor-release.before-rollback-*`.

Secrets never enter git:

- `/srv/PRO*/deploy/.env`
- `/root/el-professor-secrets/staging-web-auth` (current staging user: `admon`)
- `/srv/PRO-staging/deploy/mailpit-ui-auth` (placeholder user `locked` until the owner sets a login)

## Common operations

| Task | How |
|---|---|
| Deploy staging | Merge a PR into `staging`. |
| Deploy production | Merge `staging` into `main`, then Actions → Deploy → Run workflow on `main` and confirm `production`. The job refuses unless `main`'s tree is exactly what staging runs. |
| See what runs | On the host: `SSH_ORIGINAL_COMMAND="status staging" /usr/local/sbin/el-professor-release` |
| Roll back | Actions → Rollback, which is visible once `rollback.yml` is on `main`. Or on the host: `SSH_ORIGINAL_COMMAND="rollback staging" /usr/local/sbin/el-professor-release`. Undo it by deploying again. |
| Change routes | Edit `deploy/caddy/elprofessor.caddy`, then `EL_PROFESSOR_SSH=elprofessor bash deploy/caddy/publish.sh` |
| Change the staging login | `ssh -t root@159.195.205.30 /srv/PRO-staging/deploy/set-staging-password.sh` (without `-t` the prompts cannot read the password) |
| Reach the host from the dev machine | `ssh elprofessor` (dedicated key; see memory) |

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

## Keeping this file honest

Every fix or feature updates, in the same PR:

- this file
- `PROGRESS.md`
- the "Project status" section of `README.md`
- the progress table in `el-professor-plan.html`
- `CLAUDE.md`, when a rule or mechanism changed
