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
- the company **E2E Test GmbH** with its admin `e2e-admin@example.com`, approved and with an active subscription.

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
| `forgot-password` | The reset code arrives in Mailpit with no secret in a link or the subject, a wrong code is refused with the attempts left, the right one opens the password form, and the new password signs in. Afterwards the password is put back. |
| `kong-closed-routes` | The API answers 403 from Kong on `/auth/v1/signup`, `/auth/v1/signup/`, `//auth/v1/signup`, `/auth/v1/%73ignup`, `/auth/v1/otp` and `/auth/v1/magiclink`, and `/auth/v1/settings` still answers 200 with Google, signup and autoconfirm agreeing. Needs the release with Kong's `auth-v1-closed` block on staging, and `E2E_ANON_KEY` from `npm run setup`. |

## Things to know

- **One code per address per minute.** otp-request enforces this and answers exactly as if it had sent one, so a second `forgot-password` run less than a minute after the first times out waiting for the mail.
- **Login attempts are rate-limited per client** (60 per 5 minutes on `/token`). A test that loops over logins will hit 429.
- **Tests change the E2E admin's password.** A failed run may leave it changed; `bash setup-staging.sh --reset-admin-password` puts it back.
