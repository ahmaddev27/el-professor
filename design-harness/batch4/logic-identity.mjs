#!/usr/bin/env node
/**
 * The proof that batch 4 changed how its screens look and nothing they do.
 *
 *   node design-harness/batch4/logic-identity.mjs            base = merge-base with origin/staging
 *   node design-harness/batch4/logic-identity.mjs --base <ref> [--verbose]
 *
 * Three checks, all against the base commit's text:
 *
 * 1. Untouched. The files that decide who may see what — App.tsx's gates and
 *    SignInRoute, AuthContext (googleSignInRefusal, the sign-in branches),
 *    SuperAdminContext, PlanContext, every module in src/lib (otpClient,
 *    adminGate's rememberedPanelPath, googleSignIn's one-time marker,
 *    authProviderSettings, oauthAccountClient), the OTP hand-off hook and the
 *    plan and pricing utilities — are byte-identical.
 *
 * 2. Verbatim blocks. For every converted file, the blocks listed below — its
 *    state, effects, queries, handlers and redirects — appear in the new file
 *    exactly as they stood, as one contiguous substring each. A block is named
 *    by its first and last line in the base file, so the list survives a
 *    rebase that moves line numbers.
 *
 * 3. Call sites. Every call the screen makes — to AuthContext, the OTP client,
 *    the session hand-off, manage-users, the database, the router — is
 *    extracted from the base file with its full argument list and must appear
 *    in the new file with the same text. This catches a call that moved out of
 *    a verbatim block into the markup (a button's onClick) and was retyped.
 *
 * `--verbose` prints, per file, the base lines outside every block: what the
 * conversion removed or rewrote, which should all be markup and styling.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;

const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const base = baseArg ?? git('merge-base', 'HEAD', 'origin/staging').trim();
const lf = text => text.replace(/\r\n/g, '\n');
const baseText = path => lf(git('show', `${base}:${path}`));
const workText = path => lf(readFileSync(join(root, path), 'utf8'));

// ─── 1. Untouched ────────────────────────────────────────────────────────────

const UNTOUCHED = [
  'src/App.tsx',
  'src/contexts/AuthContext.tsx',
  'src/contexts/SuperAdminContext.tsx',
  'src/contexts/PlanContext.tsx',
  'src/contexts/AppConfigContext.tsx',
  'src/contexts/CompanySettingsContext.tsx',
  'src/lib',
  'src/hooks',
  'src/utils/planState.ts',
  'src/utils/pricing.ts',
  'src/utils/backup.ts',
  'src/utils/excelExport.ts',
  'src/types',
  'supabase',
];

// ─── 2. Verbatim blocks, per file ────────────────────────────────────────────
// [first line, last line] as they read in the base file (trailing space ignored).

const BLOCKS = {};

// ─── 3. Call sites ───────────────────────────────────────────────────────────

const CALLS = [
  /\bsignIn\(/g, /\bsignOut\(/g, /\bcompleteSignIn\(/g, /\brequestOtp\(/g, /\bverifyOtp\(/g,
  /\bsetAuthNotice\(/g, /\bclearAuthNotice\(/g, /\brefreshProfile\(/g, /\brefreshSubscription\(/g,
  /\brefreshPlan\(/g, /\brefreshSettings\(/g, /\bupdateSettings\(/g, /\bregisterOauthCompany\(/g,
  /\bdiscardOauthAccount\(/g, /\bstartGoogleSignIn\(/g, /\bloadAuthProviderSettings\(/g,
  /\bnavigate\(/g, /\bfetch\(/g, /\bsupabase\s*\.\s*(?:from|rpc)\(/g, /\.auth\s*\.\s*\w+\(/g,
  /\.storage\s*\.\s*from\(/g, /\bexportTableToExcel\(/g, /\bcreateAndDownloadBackup\(/g,
  /\bwindow\.history\.replaceState\(/g, /\bshowToast\(/g, /\bshowError\(/g, /\bsuccess\(t\(/g,
  /\bsetConfirmModal\(/g, /\bonSave\(/g, /\bonVerified\(/g, /\bonFailure\?\.\(/g, /\bonResendFailure\?\.\(/g,
  /\bonError\?\.\(/g, /\(onSignOut \?\? signOut\)\(/g, /\bleaveToLogin\(/g, /\bfetchPreview\(/g, /\bloadData\(/g,
  /\bloadUsers\(/g, /\bfetchRoles\(/g,
];

/** The call starting at `start`, through its balanced closing parenthesis. */
function callText(text, start) {
  const open = text.indexOf('(', start);
  if (open < 0) return text.slice(start, start + 40);
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

const squash = text => text.replace(/\s+/g, ' ').trim();

// ─── Run ─────────────────────────────────────────────────────────────────────

let failures = 0;
const fail = message => {
  failures += 1;
  console.log(`  FAIL ${message}`);
};

console.log(`base ${base.slice(0, 12)}\n`);
console.log('1. untouched');
for (const path of UNTOUCHED) {
  try {
    git('diff', '--quiet', base, '--', path);
    console.log(`  ok   ${path}`);
  } catch {
    fail(`${path} differs from the base`);
  }
}

console.log('\n2. verbatim blocks and 3. call sites');
for (const [path, blocks] of Object.entries(BLOCKS)) {
  const before = baseText(path);
  const after = workText(path);
  const lines = before.split('\n').map(line => line.replace(/\s+$/, ''));
  const covered = new Array(lines.length).fill(false);
  let blockFailures = 0;

  for (const [first, last] of blocks) {
    const from = lines.indexOf(first);
    const to = from < 0 ? -1 : lines.findIndex((line, index) => index >= from && line === last);
    if (from < 0 || to < 0) {
      fail(`${path}: block "${first.trim()}" … "${last.trim()}" not found in the base`);
      blockFailures += 1;
      continue;
    }
    const block = before.split('\n').slice(from, to + 1).join('\n');
    for (let i = from; i <= to; i += 1) covered[i] = true;
    if (!after.includes(block)) {
      fail(`${path}: lines ${from + 1}–${to + 1} ("${first.trim()}") are not verbatim in the new file`);
      blockFailures += 1;
    }
  }

  // Calls: every call in the base, argument list included, must be in the new file.
  const afterSquashed = squash(after);
  const missing = [];
  let calls = 0;
  for (const pattern of CALLS) {
    for (const match of before.matchAll(pattern)) {
      const text = callText(before, match.index);
      calls += 1;
      if (!afterSquashed.includes(squash(text))) missing.push(text.split('\n')[0]);
    }
  }
  for (const text of missing) fail(`${path}: call not found in the new file: ${text}`);

  const coveredCount = covered.filter(Boolean).length;
  console.log(
    `  ${blockFailures || missing.length ? 'FAIL' : 'ok  '} ${path}: ${blocks.length} blocks, ${coveredCount} of ${lines.length} base lines verbatim; ${calls} calls, ${calls - missing.length} found`,
  );
  if (verbose) {
    let start = -1;
    for (let i = 0; i <= lines.length; i += 1) {
      const outside = i < lines.length && !covered[i] && lines[i].trim() !== '';
      if (outside && start < 0) start = i;
      if (!outside && start >= 0) {
        console.log(`         outside ${start + 1}–${i}: ${lines[start].trim().slice(0, 90)}`);
        start = -1;
      }
    }
  }
}

console.log(failures === 0 ? '\nall checks pass' : `\n${failures} failures`);
process.exitCode = failures === 0 ? 0 : 1;
