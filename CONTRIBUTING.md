# Working on this repository

## Why the process is strict here

This codebase produces **statutory German payroll documents** — Stundennachweise and a
corrected Fahrtenbuch — that go to a Steuerberater and, through them, to the authorities.
A wrong number does not crash anything. It gets filed.

There is also **no test suite**. `npm run build` (TypeScript strict) and `npm run lint` are
the entire automated safety net. Everything else is discipline.

## Branch model

`main` holds the reviewed, working state. Nothing is committed directly to `main`.

Work happens on a topic branch, one branch per coherent change, merged back only when it
builds and has been checked against the rule it was supposed to preserve.

```
main
 ├── fix/<area>-<short-slug>      a defect fix
 ├── chore/<short-slug>           dead code removal, tooling, docs
 ├── refactor/<short-slug>        behaviour-preserving restructure
 └── feat/<short-slug>            new capability
```

Area prefixes used in this project: `security`, `rls`, `schema`, `payroll`, `planning`,
`export`, `frontend`.

Examples:

```
fix/security-edge-fn-authz
fix/payroll-lohnart-night-split
fix/schema-missing-tables
chore/remove-dead-modules
```

### Starting work

```bash
git switch main
git switch -c fix/security-edge-fn-authz
```

### Finishing work

```bash
npm run build && npm run lint     # both must pass
git switch main
git merge --no-ff fix/security-edge-fn-authz
```

`--no-ff` keeps each piece of work visible as a unit in the history, so a bad change can be
reverted as a unit.

## Commit messages

Conventional Commits. The subject says what changed; the body says **why**, and — for
anything touching payroll, planning, or export — states the business rule the change was
required to preserve.

```
fix(payroll): stop Lohnart 1500 and 1501 double-counting night hours

1500 (25% steuerfrei) and 1501 (40% steuerfrei) must be mutually exclusive:
1500 = nightSec - night0to4Sec, 1501 = night0to4Sec. The previous code counted
00:00-04:00 in both buckets, inflating tax-free premium on every night shift.

Rule preserved: total premium seconds still equal total night seconds.
```

## Rules that override convenience

- **Never bypass a finalization check.** Documents are downloadable only after all
  pre-flight checks pass. If a check is wrong, fix the check — do not add an override.
- **Never mutate `fahrtenbuch_trips` outside an RPC.** A DB trigger enforces immutability
  on everything except the `assignment_*` columns, and there is no UPDATE RLS policy.
- **Never translate German UI text.** Labels are fixed domain terms.
- **Never widen an RLS policy to make a query work.** Fix the query, or add a scoped
  `SECURITY DEFINER` RPC with an explicit company check.
- **A schema change is a migration file**, in `supabase/migrations/`, named with a
  timestamp prefix. Not an ad-hoc `.sql` script in the repo root — that is how the current
  schema drifted out of version control.

## Before opening any change for review

- [ ] `npm run build` passes
- [ ] `npm run lint` passes
- [ ] The change touches only what its branch name claims
- [ ] If it touches money or documents: the preserved rule is stated in the commit body
- [ ] If it changes the schema: there is a migration, and the code matches it
