# End-to-end tests

Playwright tests that drive **staging** (`https://app.elprofessor.eu`) through a real browser. They never run against production: the config refuses any other host.

This is a separate npm package, so the app's dependencies, typecheck ratchet and CI stay untouched. The tests use the Chrome already installed on the machine; no browser is downloaded.

## First time

You need `ssh elprofessor` to work (see HANDOFF.md). From this folder:

```bash
npm install
npm run setup   # bash setup-staging.sh
```

`setup-staging.sh` is idempotent. Run it again whenever staging's data is refreshed from production. It makes sure staging has:

- a login `e2e` in front of the staging web app, next to the owner's;
- a Mailpit login `e2e`, so tests can read the mail staging sends;
- the company **E2E Test GmbH** with its admin `e2e-admin@example.com`, approved and with an active subscription;
- six password-reset accounts, `e2e-reset-1@example.com` … `e2e-reset-6@example.com`, each approved, subscribed and confirmed.

It generates every password and stores them only in `e2e/.env.local`, which is gitignored. On the host they exist only as hashes. Nothing is printed.

## Running

```bash
npm test
```

Until `mail-staging.elprofessor.eu` resolves, the suite reaches Mailpit through an SSH tunnel it opens and closes itself (`127.0.0.1:18025`).

## What is covered

| Test | Proves |
|---|---|
| `staging-protection` | Staging answers 401 without the login, `/version.txt` stays public, and with the login the sign-in page and the STAGING banner show. |
| `sign-in` | The E2E admin signs in and reaches the company overview. |
| `forgot-password` | The reset code arrives in Mailpit with no secret in a link or the subject, a wrong code is refused with the attempts left, the right one opens the password form, and the new password signs in. It runs against one of the six reset accounts, not the admin. |
| `kong-closed-routes` | The API answers 403 from Kong on `/auth/v1/signup`, `/auth/v1/signup/`, `//auth/v1/signup`, `/auth/v1/%73ignup`, `/auth/v1/otp` and `/auth/v1/magiclink`, and `/auth/v1/settings` still answers 200 with Google, signup and autoconfirm agreeing. Needs the release with Kong's `auth-v1-closed` block on staging, and `E2E_ANON_KEY` from `npm run setup`. |

## Things to know

- **Global setup warms staging first, and that is what makes the suite survive a release.** `lib/warmup.ts` loads the app shell until the SPA actually mounts, then pokes `otp-request` and `otp-verify` with a body they reject before they reach the database, the rate limits or the mailer — retrying while the gateway, rather than the app, is what answers. Four merges in a row failed without it, always on a `toBeVisible()`: the artifact shows a 502 from a cold function worker, on screen 0.45 s after the click. A longer timeout was tried twice and could not help, because the answer had already arrived. The warm-up prints a line per step, so a boot that needed more than one try stays visible instead of silently disappearing.
- **The one-time-code limits are what used to fail this suite, not slowness.** otp-request allows one code per address per minute and **five per address per hour**, and answers 202 either way so it reveals nothing about who has an account — so a run past the limit sees a successful request, no mail, and a 45 s wait that reads like a broken mailer. It was confirmed in `app_private.otp_send_events` as `email_hourly` on PR #57's merge run. Global setup therefore rotates over six seeded addresses (`lib/resetAddress.ts`), which puts the ceiling at thirty codes an hour, past the twenty-requests-per-IP limit that now binds first. A run still logs which address it took.
- **Login attempts are rate-limited per client** (60 per 5 minutes on `/token`). A test that loops over logins will hit 429.
- **No test changes the E2E admin's password any more.** `forgot-password` sets a new password on the reset account it drew, and nothing else uses that account, so there is nothing to put back and a failed run cannot leave `sign-in` depending on a restore that did not happen. `bash setup-staging.sh --reset-admin-password` is still there for an admin password changed by hand.
