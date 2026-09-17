import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// setup-staging.sh writes every value this suite needs into .env.local, which
// is gitignored. Nothing secret lives in this file or in the repository.
const envFile = resolve(process.cwd(), '.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const required = [
  'E2E_BASE_URL', 'E2E_API_URL', 'E2E_STAGING_USER', 'E2E_STAGING_PASS',
  'E2E_MAILPIT_URL', 'E2E_MAILPIT_USER', 'E2E_MAILPIT_PASS',
  'E2E_ADMIN_EMAIL', 'E2E_ADMIN_PASSWORD',
  // The seeded password-reset accounts. forgot-password spends one of five
  // hourly codes per address, so it rotates over these instead of the admin;
  // lib/resetAddress.ts explains the sizing.
  'E2E_RESET_EMAILS',
  // The warm-up in global setup sends it to the functions, which refuse a
  // request without it before they start a worker — so it is needed by every
  // run now, not only by the two specs that call the API directly.
  'E2E_ANON_KEY',
];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(`Missing ${missing.join(', ')}. Run "npm run setup" in e2e/ once; it writes e2e/.env.local.`);
}

// These tests create accounts, trigger mail and change passwords. Staging
// only: production holds real customers and sends real mail.
const baseURL = process.env.E2E_BASE_URL!;
if (new URL(baseURL).hostname !== 'app.elprofessor.eu') {
  throw new Error(`E2E_BASE_URL must be staging (https://app.elprofessor.eu), not ${baseURL}`);
}

export default defineConfig({
  testDir: './tests',
  // One worker: the tests share one test account, and GoTrue allows one
  // password-reset mail per account per minute.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  // 15 s absorbs ordinary latency to the shared VPS without hiding a real hang,
  // which the 90 s test timeout still catches.
  //
  // It is not what makes the suite survive a release, and raising it further
  // would not: the first request after one is answered *fast* by the gateway
  // rather than by the app — a 502 in ~130 ms — and no timeout can wait out an
  // answer that already came. lib/warmup.ts carries the measurements and does
  // that job in global setup instead.
  expect: { timeout: 15_000 },
  reporter: [['list']],
  globalSetup: './lib/global-setup.ts',
  use: {
    baseURL,
    channel: 'chrome', // the Chrome already installed; no browser download
    headless: true,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    // Staging sits behind Basic Auth. The origin pin keeps these credentials
    // from ever being sent to the API host or anywhere else.
    httpCredentials: {
      username: process.env.E2E_STAGING_USER!,
      password: process.env.E2E_STAGING_PASS!,
      origin: new URL(baseURL).origin,
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
