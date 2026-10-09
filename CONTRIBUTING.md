# Working on this repository

## Why the process is strict here

This codebase produces **statutory German payroll documents** — Stundennachweise and a
corrected Fahrtenbuch — that go to a Steuerberater and, through them, to the authorities.
A wrong number does not crash anything. It gets filed.

## The safety net, as it actually is

An earlier version of this file said "there is also **no test suite**". That has not been true
for a long time, and believing it changes how carefully you work. What exists:

- **`npm run build` is a gate, not a build.** It runs, in order: the **typecheck ratchet**
  against `typecheck-baseline.json` (more errors fails, *fewer* errors also fails and asks you
  to lower the baseline in a commit), the **style ratchet** against `style-baseline.json`
  (per file, so a converted screen cannot pay for a regression elsewhere), **`vitest run`** —
  thousands of tests, including golden masters over the money and calendar paths — and only
  then `vite build`.
- **`npm run lint`** — ESLint, flat config.
- **The RLS kit is the only gate SQL ever passes.** `npm run test:rls` builds a throwaway
  database from production's schema, applies every migration and runs `tests/rls/*.sql`. It
  needs Docker and runs on the VPS; see CLAUDE.md. **CI being green says nothing about SQL** —
  a PR whose migration could not apply has sat green and mergeable.

Three things about the kit that cost time if you learn them the hard way:

- It **aborts at the first failing file**, and files sorting after it never run. A green line
  can be from an earlier run; read the verdict, not a line.
- A probe helper rolls back each write, so an assertion about an earlier probe's persistent
  effect can never pass.
- It records **today's** behaviour, holes included. When a migration moves a cell, change the
  expectation **in the same commit** and say in the PR why it moved. Never paste the actual
  line over the expected one without reading it.

## Branch model

**Every PR targets `staging`. Nothing targets `main`, ever.**

`main` is what production runs. Merging into `main` does not deploy by itself — the production
deploy is a manual button — but promoting to `main` is **the owner's act and nobody else's**.
Do not merge it, do not press Deploy, and do not treat one yes as a standing yes.

```
staging                                  ← every PR goes here
 ├── fix/<area>-<short-slug>              a defect fix
 ├── chore/<short-slug>                   tooling, docs, dead code
 ├── refactor/<short-slug>                behaviour-preserving restructure
 └── feat/<short-slug>                    new capability
```

Area prefixes in use: `security`, `rls`, `schema`, `payroll`, `planning`, `export`, `frontend`,
`mplan`, `salary`, `partner`.

### Starting work

```bash
git fetch origin staging
git switch -c fix/security-edge-fn-authz origin/staging
```

Branch off `origin/staging`, not off a local branch that may be behind. A branch cut from a
stale base will conflict on the ratchet baselines and on the status documents.

### Finishing work

```bash
npm run build && npm run lint        # both must pass
# and, for anything touching SQL, the RLS kit on the VPS
gh pr create --base staging
```

Once CI is green on a staging PR, merge it:

```bash
gh pr merge <n> --squash --delete-branch
```

**Check the merge actually happened before deleting anything.** A failed merge followed by a
branch delete has closed a PR and lost its branch. If you delete by hand, confirm the PR state
is `MERGED` first.

### The ratchets race, and they will

`typecheck-baseline.json` and `style-baseline.json` are single files that every PR can touch.
Two branches in flight will collide on them. Rebase on `staging`, re-run
`npm run typecheck:update` / `npm run styles:update`, and **read the diff** before merging — a
baseline that moves without anyone looking is how the gate stops gating.

## The other repository

Part of this work spans **Reidey**, a separate live product with its own repository. Its rule
has two halves and conflating them is a serious error in either direction:

- **Its server is off limits.** No container, no host file, no deploy, nothing that reaches its
  users.
- **Its repository is open, on a branch.** Branch off its `origin/main`, commit there, and
  **never push to `main`** — in that repository `main` is a zero-touch production deploy on
  push, including `php artisan migrate --force`. A push to it *is* a release of someone else's
  live product.

## Commit messages

Conventional Commits. The subject says what changed; the body says **why**, and — for anything
touching payroll, planning, or export — states the business rule the change was required to
preserve.

```
fix(payroll): stop Lohnart 1500 and 1501 double-counting night hours

1500 (25% steuerfrei) and 1501 (40% steuerfrei) must be mutually exclusive:
1500 = nightSec - night0to4Sec, 1501 = night0to4Sec. The previous code counted
00:00-04:00 in both buckets, inflating tax-free premium on every night shift.

Rule preserved: total premium seconds still equal total night seconds.
```

When a change corrects something an earlier commit or document got wrong, say that plainly in
the body. A correction nobody can find is a correction that gets re-made.

## Rules that override convenience

- **Never bypass a finalization check.** Documents are downloadable only after all pre-flight
  checks pass. If a check is wrong, fix the check — do not add an override.
- **Never mutate `fahrtenbuch_trips` outside an RPC.** A trigger enforces immutability on
  everything except the `assignment_*` columns, and there is no UPDATE RLS policy at all.
- **Never reassign or re-time a past trip to make hours fit a salary.** It produces a false
  statutory record, and the person it is filed against is the driver.
- **Never widen an RLS policy to make a query work.** Fix the query, or add a scoped
  `SECURITY DEFINER` RPC with an explicit company check — and remember that such an RPC runs
  past the role gate too, so it has to ask for the role itself.
- **A schema change is a migration file** in `supabase/migrations/`, timestamp-prefixed. Not an
  ad-hoc `.sql` script in the repo root — that is how the current schema drifted out of version
  control in the first place.
- **German UI text is not blanket-frozen, and it is not freely translatable either.** The UI is
  bilingual; `src/i18n/de.ts` is canonical and `en.ts` is a `Partial`. Three categories stay
  German in both languages — generated statutory documents, domain vocabulary, and money and
  date formatting — plus **anything a second consumer reads**: a string something compares,
  stores, exports or matches on is an identifier, not a label. CLAUDE.md holds the closed lists;
  read them before touching a string.
- **A figure whose load failed is not shown.** An empty list and a total of 0,00 € are claims.
  When a read fails, show the failure.

## Measuring, before you report a defect

- Read source with the file tools or `git show`, never through a pipeline that reformats it. A
  transforming instrument has twice produced a defect report about a defect that did not exist.
- "The container is up" is not "the service is ready". Check what you actually depend on.
- Two independent instruments should agree before you call something broken.

## Before opening any change for review

- [ ] `npm run build` passes (both ratchets, the full test run, then the bundle)
- [ ] `npm run lint` passes
- [ ] If it touches SQL: the **RLS kit** has been run and its verdict read
- [ ] The change touches only what its branch name claims
- [ ] If it touches money or documents: the preserved rule is stated in the commit body
- [ ] If it changes the schema: there is a migration, and the code matches it
- [ ] The status documents travel with it — `PROGRESS.md`, `HANDOFF.md`, the README status, and
      the relevant plan file. A change whose state is only in someone's head is not finished.
