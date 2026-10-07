# Operating rules — the ones that were not written down anywhere

**Written for:** whoever works on this project next, on any machine, with or without the person
who has been working on it so far. Read `CLAUDE.md` first — it is the authority on how
everything works. This file holds only the rules that were **not in the repository at all**
until 07.10.2026, and so would not survive a change of machine or a second developer.

## Why this file exists

The rules below lived in a per-project memory directory keyed on an absolute path on one
Windows laptop. That directory is never synced: a different machine, a cloud session, or a
second person starts with none of it. Sixty-eight facts were compared against the repository;
thirty-two were already here, seventeen were expired session snapshots worth nothing, four were
one person's own preferences, and **fifteen were load-bearing and missing**. Those fifteen are
below, rewritten rather than copied.

**Nothing was copied wholesale, and that matters.** Three of those memory files turned out to
contain real credentials — one holds the literal password of a platform account that can read
nineteen companies' payroll data. A naive copy would have committed it, and git does not forget.
So: **no credential, account address or user id appears in this file, and none should ever be
added to it.** A narrow pattern search found nothing and was wrong; use broad patterns, and
treat an empty result as "not proven clean".

---

## 1. Who may promote, and who may touch the host

**Every PR targets `staging`. Promoting to `main` is the owner's act and nobody else's**, as is
pressing Deploy. `CONTRIBUTING.md` carries this now; it is repeated here because it is the rule
most expensive to get wrong.

**Ask before every change to the VPS** — an `.env` key, an account, a cron file, a host script.
**One yes is not a standing yes.** This rule exists because it was broken twice: the production
deploy button was pressed without being asked for, and a host `.env` was edited on a misread of
what had been permitted.

What an agent *may* do without asking: merge a staging PR of its own once CI is green, squashed,
deleting the branch — after confirming the merge actually happened.

## 2. The Fahrtenbuch boundary

**Never add a button, an RPC or an engine function that reassigns a past trip, shifts a recorded
time, or redistributes recorded work to make hours match a salary figure.** The output is a
statutory record, and the person it is filed against is the driver: the consequence of a
convenient number is understated minimum wage and understated social contributions, for them.

Code that already does something like this is **not a precedent to extend**.

**Be precise about the scope**, because an over-broad version of this rule reads as forbidding
features the product legitimately ships. The prohibition is about **recorded or past** trips and
times. Planning a *future* month is not covered: the monthly plan deliberately offers the owner
taking surplus blocks, off by default, and that is a planning choice about work not yet done.

## 3. Host-only scripts, and the backup trap

Some scripts exist **only on the VPS** and are in no repository — the nightly backup, the
platform-admin helper, the Google sign-in switch. Two consequences:

- Their comments are a snapshot of the schema on the day they were written, and they go stale
  silently.
- **When a migration adds a schema, grep the host scripts.** The nightly backup omitted
  `app_private` for five days. A restore from those backups would have come up **looking
  healthy** while having lost the platform staff table, the platform settings and the whole
  audit log.

## 4. Reaching the host

Access is an SSH alias with a dedicated key. Three mechanical traps, each of which has cost an
hour:

- `docker compose exec -T` without `< /dev/null` **consumes the rest of a piped script**.
- A `< /dev/null` on the *ssh* line itself makes the remote command **run nothing, silently and
  successfully**.
- Pass a password over **stdin, never argv** — argv is visible in the process list.

## 5. Measure with an instrument that does not transform

- Read source with a file tool or `git show`. **Never through a pipeline that reformats it.** A
  transforming instrument has twice produced a confident report about a defect that did not
  exist.
- "The container is running" is not "the service is ready". Check the thing you actually depend
  on.
- **Two independent instruments should agree before you call something broken** — and before you
  tell the owner something is broken.
- A narrow search returning nothing is not evidence of absence. Widen it, then say which you ran.

## 6. The RLS kit's three sharp edges

- **It aborts at the first failing file**, and every file sorting after it never runs. A green
  line may be from an earlier run; read the verdict.
- **A probe helper rolls back each write**, so an assertion about an earlier probe's persistent
  effect can never pass.
- **CI being green says nothing about SQL.** A PR whose migration could not apply has sat green
  and mergeable. The kit is the only gate SQL passes, and running it is the author's job.

A fourth, learned on 06.10.2026 and worth copying: when a file must settle several unverified
readings, have each probe **record** its outcome and assert them **all at the end**. One run then
answers every question instead of the first wrong guess hiding the rest.

## 7. `raw_data_json` lists the ride's END first

For **96.8 %** of imported rides, the first timestamp in `raw_data_json` is the ride's **end**,
not its start. **Never read those timestamps by position.** Read by column name through the
resolver helpers, or use `start_at` / `end_at`, which exist for this reason.

## 8. Behaviour is either the requirement or an accident — the test

When the owner reports that something is broken and measurement says the code is right, there
are two different situations and they resolve oppositely:

- **The behaviour is the requirement** (a test pins it; the alternative would be wrong) → **the
  label is the defect.** Rename it. Words like *minimum*, *maximum*, *Mindest-*, *Höchst-*
  promise a guarantee; if the engine treats the number as a threshold, say threshold.
- **The behaviour is an accident** (nothing required it; it fell out of where a value landed) →
  **change what the control does.** Explaining it will not satisfy anyone, and should not.

And in both cases: **a control that reports a problem while naming a lever in another screen
reads as broken.** Put the lever in the report.

## 9. Attributing a failing end-to-end test

A failure has at least three plausible causes that look identical from the summary line. Before
attributing one: read the screenshot, identify the failing step, and **fetch the asset from both
the server and the dev machine** so you know which side is wrong. Attribution without a two-sided
measurement has been wrong before.

## 10. The 502 on the one-time-code endpoint

The cause is **the gateway dialling a stale container address after a release**. It is *not* a
cold worker and *not* caused by idleness — and a document in this repo said it was. A warm-up
added on that belief proves less than it claims.

---

## Three things that were deliberately left out, and why

**The production till figures.** A measurement exists of one named customer's cash balance and
of how much manual cash salary is never subtracted from it. Those are that customer's financial
figures, so whether they belong in a shared repository is the owner's decision, not this file's.
`CLAUDE.md` already records that the question is open and unanswered.

**The plan-system decisions of 17.09.2026.** Real decisions about free plans, per-plan features
and per-company limits, plus two measured facts (a column read by nothing, and a CHECK
constraint that breaks on any new plan key). They are not here because their current status needs
confirming with the owner first — some of what sat beside them has since shipped.

**Whether Fahrtenbuch work still stays off production.** An owner instruction with a time scope:
name the Fahrtenbuch commits in a release and leave them out unless asked. The README records
the state; the instruction needs confirming before it is written as a standing rule.

---

## Fifteen contradictions were found at the same time

The comparison that produced this file also found fifteen places where a memory note and the
repository disagreed. Two were dangerous enough to fix immediately, in the same commit as this
file:

- **`CONTRIBUTING.md`** claimed there was no test suite, said nothing is committed directly to
  `main`, and then instructed `git switch main` followed by `git merge --no-ff` — the one act
  that must never happen. Both `CLAUDE.md` and the README pointed at it as the authority on the
  branch model. Rewritten.
- **`CLAUDE.md`** said "no commits to [Reidey's] repository", which stopped being true on
  06.10.2026 when the owner opened it on a branch. A fresh session reading that line would refuse
  authorised work — while the half that *is* still absolute, the server, was stated no more
  firmly than the half that had changed. Now split in two.

The rest were stale notes rather than stale repository text, so they were corrected at the source
or dropped with the snapshots. **A shared document that repeats a stale claim is worse than one
that omits it** — which is the whole reason this file lists what it left out.
