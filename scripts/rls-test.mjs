#!/usr/bin/env node
/**
 * Run the RLS assertions against a throwaway database.
 *
 * Why a container and not the running stack: these assertions write. Pointing
 * them at a live database would mean creating and deleting real companies on
 * every run, and a failure half way through would leave them behind. A
 * container is also the only way the result is deterministic — nobody else is
 * changing rows underneath it.
 *
 * The fixture is production's own `--schema-only` dump, not the migration
 * chain: the chain replays 113 of 150 files, so a database built from it is not
 * the database being tested. See Docs/migration/04-CHAIN-REPLAY-RESULT.md.
 * Migrations newer than the dump are applied on top, which also proves they
 * apply cleanly to a real schema.
 *
 * After assertions.sql, every other tests/rls/*.sql file (the permission matrix
 * among them) runs once, in name order, against the same database. The seed
 * files are loaded before, not asserted. A test file that writes should run
 * inside BEGIN … ROLLBACK (matrix.sql and otp.sql do), so the files after it
 * see only the seeds.
 *
 *   node scripts/rls-test.mjs            # build, assert, tear down
 *   node scripts/rls-test.mjs --keep     # leave the container up to poke at
 *
 * Needs Docker. Exits non-zero on the first failed assertion.
 */
import { execFileSync, execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileP = promisify(execFile);

const IMAGE = 'supabase/postgres:17.6.1.170';
// Unique per run. The kit runs on a host shared by parallel work, and with a
// fixed name one run's teardown removed another run's database mid-assertion.
const NAME = process.env.RLS_TEST_CONTAINER || `ya-rls-test-${randomBytes(4).toString('hex')}`;
const PW = 'rls-test-only';
const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/schema.sql');
const TESTS = path.join(ROOT, 'tests/rls');
const KEEP = process.argv.includes('--keep');

/** Migrations that postdate the fixture dump, in filename order. */
const MIGRATIONS_AFTER = '20260908';

/** Loaded before the assertions; never run as a test file. */
const SEEDS = new Set(['seed.sql', 'roles-seed.sql']);

const PSQL = ['exec', '-i', NAME, 'psql', '-v', 'ON_ERROR_STOP=1', '-q',
              '-U', 'supabase_admin', '-d', 'postgres'];
const MAX_BUFFER = 64 * 1024 * 1024;

const sh = (args, opts = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe', ...opts });

const psqlText = (sql) =>
  execFileSync('docker', PSQL,
               { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input: sql, maxBuffer: MAX_BUFFER });

const psqlFile = (file) => psqlText(readFileSync(file, 'utf8'));

/**
 * Runs one test file and returns what it reported. psql writes NOTICE and
 * WARNING to stderr, and execFileSync discards stderr on success, so a passing
 * run would show neither the checks nor the matrix's UNCOVERED warnings.
 */
function assertFile(file) {
  const r = spawnSync('docker', PSQL,
                      { encoding: 'utf8', input: readFileSync(file, 'utf8'), maxBuffer: MAX_BUFFER });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw Object.assign(new Error(`${path.basename(file)} failed`),
                        { stderr: `${path.basename(file)}:\n${r.stdout}${r.stderr}` });
  }
  return `${r.stdout}${r.stderr}`
    .replace(/^psql:[^:]+:\d+: NOTICE:\s*/gm, '    ')
    .replace(/^psql:[^:]+:\d+: WARNING:\s*/gm, '    WARNING ');
}

function teardown() {
  try { sh(['rm', '-f', NAME]); } catch { /* already gone */ }
}

async function waitReady() {
  for (let i = 0; i < 90; i++) {
    try {
      await execFileP('docker', ['exec', NAME, 'pg_isready', '-U', 'supabase_admin', '-h', 'localhost']);
      // pg_isready answers before the image's own migrations finish; the role
      // the fixture needs is the real signal.
      const out = sh(['exec', NAME, 'psql', '-tA', '-U', 'supabase_admin', '-d', 'postgres',
                      '-c', "SELECT count(*) FROM pg_roles WHERE rolname='authenticated'"]);
      if (out.trim() === '1') return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('database never became ready');
}

function migrationsAfterFixture() {
  const dir = path.join(ROOT, 'supabase/migrations');
  return readdirSync(dir)
    .filter(f => f.endsWith('.sql') && f >= MIGRATIONS_AFTER)
    .sort()
    .map(f => path.join(dir, f));
}

/**
 * assertions.sql first, so a broken rule is reported as a broken rule before
 * it shows up as a moved matrix cell, then every other test file in name
 * order. Adding a suite needs no change here.
 */
function assertionFiles() {
  const rest = readdirSync(TESTS)
    .filter(f => f.endsWith('.sql') && f !== 'assertions.sql' && !SEEDS.has(f))
    .sort();
  return ['assertions.sql', ...rest].map(f => path.join(TESTS, f));
}

const step = (msg) => process.stdout.write(`  ${msg}\n`);

try {
  if (!existsSync(FIXTURE)) {
    throw new Error(`missing fixture ${FIXTURE} — take it with pg_dump --schema-only`);
  }

  teardown();
  step(`starting a throwaway postgres (${NAME})…`);
  sh(['run', '-d', '--name', NAME, '--cpus', '1', '--memory', '1g',
      '-e', `POSTGRES_PASSWORD=${PW}`, IMAGE]);
  await waitReady();

  step('loading the production schema fixture…');
  // The dump carries `CREATE SCHEMA public`, which supabase/postgres has
  // already created. Left as-is it aborts the load on line one under
  // ON_ERROR_STOP, so soften just that statement rather than dropping error
  // checking for the whole file.
  psqlText(
    readFileSync(FIXTURE, 'utf8')
      .replace(/^CREATE SCHEMA public;/m, 'CREATE SCHEMA IF NOT EXISTS public;'),
  );

  // The image has no storage schema (storage-api creates it at runtime), so a
  // migration that adds a bucket or a storage policy needs this to apply.
  step('providing the storage tables the fixture does not carry…');
  psqlFile(path.join(ROOT, 'tests/fixtures/storage-shim.sql'));

  const migrations = migrationsAfterFixture();
  step(`applying ${migrations.length} migrations newer than the fixture…`);
  for (const m of migrations) {
    try {
      psqlFile(m);
    } catch (err) {
      throw new Error(`migration failed: ${path.basename(m)}\n${err.stderr || err.message}`);
    }
  }

  // --schema-only means the four system roles and their 16x4 permission matrix
  // came across as empty tables. Without them current_role_permits() denies
  // everything and every assertion would pass for the wrong reason.
  step('seeding the system roles and permission matrix…');
  psqlFile(path.join(TESTS, 'roles-seed.sql'));

  step('seeding two tenants and five principals…');
  psqlFile(path.join(TESTS, 'seed.sql'));

  for (const file of assertionFiles()) {
    step(`\n  asserting ${path.basename(file)}…\n`);
    process.stdout.write(assertFile(file));
  }

  process.stdout.write('\nRLS assertions passed.\n');
} catch (err) {
  process.stderr.write(`\nRLS TEST FAILED\n${(err.stderr || err.message || '').trim()}\n`);
  process.exitCode = 1;
} finally {
  if (KEEP) {
    process.stdout.write(`\ncontainer left running as ${NAME} (--keep)\n`);
  } else {
    teardown();
  }
}
