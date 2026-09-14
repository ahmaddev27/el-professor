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
| `forgot-password` | The reset mail arrives in Mailpit, its link opens the password form, and the new password signs in. Afterwards the password is put back. |

`forgot-password` covers today's link-based reset. Phase 1 replaces the link with a one-time code, and the test is rewritten in that change.

## Things to know

- **One reset mail per account per minute.** GoTrue enforces this, so two runs less than a minute apart fail at "E-Mail versendet".
- **Login attempts are rate-limited per client** (60 per 5 minutes on `/token`). A test that loops over logins will hit 429.
- **Tests change the E2E admin's password.** A failed run may leave it changed; `bash setup-staging.sh --reset-admin-password` puts it back.
