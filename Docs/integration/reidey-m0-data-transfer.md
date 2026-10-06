# M0 — the Reidey ↔ El-Professor data transfer: the factual record

**Written for:** the owner, to decide; a lawyer or DPO, to draft from; and the next engineer, to
implement the erasure rule. Milestone M0 of
[reidey-integration-plan.html](../../reidey-integration-plan.html).

**What this is.** The measured record of what personal data would move between the two products,
in which direction, for what purpose, and what must exist before any of it moves. Plus German
text ready to be reviewed and pasted, and the erasure rule as a technical specification.

**What this is not.** Legal advice. Where a statute is named below it is named as *something a
lawyer must confirm*, never as a conclusion — and §2.4 records that the citations in the
milestone sheet were mine and are grounded in neither repository.

Everything marked **[MEASURED]** was read in a file at a line. Everything marked **[READING]** is
an inference from PostgreSQL or framework semantics that **was never executed** — this codebase's
own CLAUDE.md records three occasions where such a reading was confidently wrong in both
directions, so each one is a test to write, not a fact to rely on.

---

## 1. The legal roles are already settled, by Reidey's own policy

**[MEASURED]** `frontend/src/app/(marketing)/datenschutz/page.tsx:45-58`, §2 *Auftragsverarbeitung*:

> Reidey wird von Flottenbetreibern eingesetzt, um ihre eigenen Fahrer zu verwalten.
> Personenbezogene Daten der Fahrer verarbeiten wir ausschließlich im Auftrag und nach Weisung
> des jeweiligen Flottenbetreibers gemäß Art. 28 DSGVO. **Datenschutzrechtlich Verantwortlicher
> für diese Fahrerdaten ist der jeweilige Flottenbetreiber; Reidey ist insoweit
> Auftragsverarbeiter.**

So the shape is not an open question:

| | |
|---|---|
| **Controller** for driver data | the fleet operator (the customer) |
| **Processor** | Reidey, for the data it holds |
| **Processor** | El-Professor, for the data it holds |
| **The transfer** | processor → processor, **on the controller's instruction** |

It is **not** a sub-processor chain: the fleet chooses El-Professor itself, and instructs Reidey to
hand data to it. That distinction decides which paper is needed — an instruction and an Art. 28
arrangement, not a sub-processor appointment under Art. 28(2) by Reidey.

**To confirm with a lawyer:** whether a controller instructing one processor to transfer to another
processor it also engaged needs the instruction in writing in the AVV, or whether a documented
instruction suffices.

---

## 2. What must exist before the first real pull

M0 is a gate because there is no Reidey test environment: the owner decided on 06.10.2026 not to
build one, so **the first roster pull runs against Reidey's production and reads real drivers.**
There is no rehearsal step between here and real personal data.

### 2.1 There is no AVV — and both policies say there is **[MEASURED]**

Reidey's policy asserts one exists:

> Grundlage der Zusammenarbeit ist ein Auftragsverarbeitungsvertrag (AV-Vertrag), der Gegenstand,
> Umfang, Zweck sowie die technischen und organisatorischen Maßnahmen der Verarbeitung regelt.

A search of the whole Reidey repository for an AV-Vertrag, a DPA, a template, a sub-processor list,
an Art. 30 Verarbeitungsverzeichnis or any acceptance step at signup returns **nothing**. The only
occurrence of the words "AV-Vertrag" is that sentence.

**This is pre-existing and larger than this integration** — it is the basis on which Reidey already
processes every fleet's driver data. But it blocks M1, because a processor-to-processor transfer on
the controller's instruction has nothing to attach to without it.

### 2.2 The 30-day deletion promise is published and nothing enforces it **[MEASURED]**

The driver app's own confirmation dialog, in all three languages
(`driver-app/src/lib/i18n.ts:199, 396, 593`):

> Wir melden dich auf allen Geräten ab, stoppen alle Benachrichtigungen und **löschen deine
> Kontodaten innerhalb von 30 Tagen**.

What `POST /api/v1/driver/account/deletion-request` actually does
(`AccountDeletionService.php:30-39, 71-91`): deletes the driver's device tokens and Sanctum
sessions, writes one audit row, and sends a synchronous mail to `ALERT_EMAIL` **if that variable is
set**, swallowing any failure. It does not call `DriverEraser`, queues no job, sets no
pending-deletion flag, and **no scheduled job reads those audit rows**. Erasure is a human running
`drivers:erase`. The driver can sign in again with a fresh e-mail code.

And every retention period is **off by default** (`RetentionPolicy.php:12-14`): *"Every period is
OFF until the owner sets it: an empty / zero value means 'keep forever'."* No migration, seeder or
config sets any of the seven keys.

**Why it belongs in M0:** this integration creates a **second copy** of driver data, in a second
product. A promise nothing enforces over one copy will not enforce itself over two.

### 2.3 The recipient lists on both sides are wrong, each in its own way

**Reidey. [MEASURED]** `datenschutz/page.tsx:144-195` §5 lists **six** recipients (Firebase, the
mail provider, Sentry, OpenStreetMap tiles, Nominatim/OSRM, the proxy provider). El-Professor is
not among them, and the driver app links to that page from **three** places, one of them before
sign-in (`app/login.tsx:158-166`).

The list is **neither explicitly closed nor explicitly open** — no `nur`, `ausschließlich`,
`abschließend` and no `insbesondere`, `u. a.` is attached to it. It reads as presenting those six
as the providers in use, so a seventh needs its own bullet and a new `Stand` (currently
`24.09.2026`).

> **A correction of my own text.** The milestone sheet said this list was *exhaustive*. That was
> too strong, and the sheet now says what was measured instead.

**Worse, and not ours:** the Reidey homepage FAQ (`faq-section.tsx:17-18`) publicly answers
*"Welche Daten werden gespeichert?"* with **"Keine Weitergabe an Dritte."** That already contradicts
their own §5 with its six recipients, before this integration adds anything.

**El-Professor. [MEASURED]** `legal.privacy` and `legal.impressum` are `{}` on production, so
`/datenschutz` and `/impressum` render their "not entered yet" state. Google sign-in went live on
04.10.2026 ahead of them although those pages were its stated precondition. And the landing page
claims *"alle Daten werden in der EU gespeichert und verarbeitet"* while the repo records a Resend
domain in region `ap-northeast-1` (Tokyo) and the browser contacts jsDelivr and zippopotam.us.

### 2.4 The statutes I cited are grounded in neither repository

The milestone sheet cites **§147 AO** and **§17 MiLoG** as the grounds on which a payroll record
must survive a driver's erasure.

**[MEASURED]: no code, migration, comment or document in either repository states a retention period
or cites §147 AO, GoBD or Aufbewahrungsfrist.** The only occurrences of those two citations are the
line in the milestone sheet — mine — and one audit sentence. Their sources are outside both repos.

They are plausible and they are the usual grounds, but they are **my unverified assumption**, so
this document treats them as the question to put to a lawyer:

> For a German Mietwagen/taxi fleet, which records must be kept and for how long — the
> Stundennachweis, the Fahrtenbuch, the Gehaltsquittung, the Beleg — and on what ground? That
> answer is what the erasure rule in §5 must be built on, and it is currently guessed.

---

## 3. The data map, with the 06.10 decisions applied

### 3.1 Pull — the driver roster (Reidey → El-Professor)

What the endpoint returns today **[MEASURED]** (`ElProfessorController.php:76, 82-91`): `id`,
`name`, `email`, `phone`, `employment_type`, `uber_driver_uuid`, `activated_at`,
`roster_removed_at` — and it has **no filter on `roster_removed_at`**, so drivers removed from the
fleet are included.

What the purpose actually needs: a person at the fleet looks at a list of Reidey drivers and says
"this one is our Max Mustermann". That needs a **stable key** and a **name**, and an e-mail only
where two drivers share a name.

**Proposed payload, following this product's own reduced-column precedent:**

| field | why | kept after the link is confirmed? |
|---|---|---|
| `id` | the stable key the link is made on | yes — it is the link |
| `name` | what the human matches on | no — only shown while proposing |
| `email` | disambiguates two drivers of the same name | no — shown only when names collide |

**Dropped from today's payload:** `phone` (nothing matches on it), `employment_type` (El-Professor
has its own), `uber_driver_uuid` (an identifier for a third platform, with no purpose here),
`activated_at`, and **removed drivers** — sending drivers Reidey's own retention is about to erase
has no purpose, and a link whose driver stops appearing is flagged on the review screen rather than
carried as a column.

Measured, for the e-mail question: **38 % of El-Professor's drivers have an e-mail at all** (20 of
53 across 6 companies), and within a company both names and e-mails are currently unique — by small
numbers, not by a constraint.

### 3.2 Push — a note (Reidey → El-Professor)

**Decision of 06.10.2026:** `sick` / `vacation` / `off` **do not cross**. They are Art. 9
special-category data (health, or adjacent to it), the planning exclusion they drive is the
operator's own decision anyway, and keeping them out removes special-category data from the
transfer entirely. The operator enters them in El-Professor as before.

So the seven types that cross are `general`, `blitzer`, `accident`, `kontrolle`, `breakdown`,
`wait`, `other`.

> **A correction of my own reasoning, and it changes a decision the owner approved.** I recommended
> that the note's free text should not cross either, on the grounds that "the type and the date
> range are enough to drive the planning constraint". That is true **of the three absence types** —
> and those are now excluded. For the remaining seven the text **is** the content: an `accident` or
> a `blitzer` note with no text carries nothing a fleet can act on. I reasoned from the absence
> case and applied it to all ten.
>
> **Revised recommendation:** the text crosses for the seven. The residual risk is that free text
> can contain anything, health details included — mitigated by one line on the capture screen
> telling the driver what not to write, and by the review step, where a human reads it before it
> enters the books. **This needs the owner's agreement, because it reverses part of what he
> approved on my advice.**

**Open on this point:** the two submission tables as committed still accept all ten note types and
a free `note_text` **[MEASURED]** (`20261005140000`), so the migration contradicts the decision and
must be narrowed in M3.

### 3.3 Push — a receipt (Reidey → El-Professor)

`date`, `amount`, `category` (one of the four literal German values or null), `description` (free
text), `payment_method`, and the **photograph**.

The photograph is the sensitive item: a Beleg can show more than the purchase, and it would be the
first image El-Professor ever stores. Its handling is specified in M4 of the sheet — its own bucket
with a MIME and size limit and a role gate, EXIF stripped by re-encoding on the device and refused
server-side, a path derived from the company id rather than accepted from the request, and a stated
retention.

---

## 4. Pre-existing versus added — kept separate on purpose

A compliance audit of either product is not this document's job, and mixing the two would make this
unusable. Three buckets:

### A. What this integration adds — mine to get right

1. A second copy of driver identity (id, name, and sometimes e-mail) in El-Professor.
2. Driver-authored content crossing a product boundary: notes, receipts, and receipt photographs.
3. A new recipient on each side's privacy page.
4. A new erasure surface: whatever El-Professor holds must answer a driver's Art. 17 request.

### B. Pre-existing, and it blocks M1

1. **No AVV exists** while both policies say one does (§2.1).
2. **The 30-day promise is published and unenforced** (§2.2), and this integration doubles what it
   would have to cover.
3. **The statutory retention grounds are guessed**, by me (§2.4) — and the erasure rule cannot be
   written without them.

### C. Pre-existing, noted once, not this integration's scope

Reidey: the FAQ's "Keine Weitergabe an Dritte" against its own §5; retention entirely off; several
data categories held but not named in the policy (licence number, pseudonym, Uber e-mail/UUID/
picture/rating/trip count, employment type, `driver_metrics` earnings and acceptance rates, login
timestamps, device model and OS); the controller block names a trade name, an e-mail and a phone
with no legal form or address; an Art. 33 assessment noted as an owner action with no recorded
outcome; Cloudflare, the hosting provider, Expo's update service and any offsite backup are not
named in §5.

El-Professor: both legal pages empty on production; the EU-storage claim against a Tokyo Resend
region; and §5 below.

---

## 5. The erasure rule — and our side is broken in both directions

This is the part of M0 that becomes code, and the measurement changed what it has to do.

### 5.1 There is no per-driver erasure in El-Professor at all **[MEASURED]**

No RPC, no function, no screen, no data-subject-access export. The only driver removal is a bare
trash button — `DriversManagement.tsx:264-275` → `FahrerPage.tsx:77-86` →
`useDatabase.ts:271-290`, a plain `supabase.from('drivers').delete()` — **with no confirmation
step**, under a toast reading *"Der Fahrer wurde erfolgreich entfernt"*.

### 5.2 It destroys records the fleet must keep **[MEASURED, with committed tests]**

`ON DELETE CASCADE` carries a driver's deletion into `salaries` → `salary_payments`,
`salary_cash_receipts`, `saved_stundennachweise`, `driver_notes`, `car_driver_assignments`,
`driver_month_budget` and the `historical_reconciliation_*` children. Committed kit tests assert
this (`tests/rls/support-write-audit.sql:1109-1124`, `tests/rls/salary-cash.sql:517-528`).

So pressing that button destroys the Gehaltsquittungen, the salary records and the stored
Stundennachweise — which are precisely the documents §2.4's question is about.

### 5.3 And it does not erase **[MEASURED]**

What survives a driver's deletion: `receipts.driver_name` and `income.driver_name` (plain text, no
FK), `fahrtenbuch_trips.assigned_driver_name` and `original_driver_*` (SET NULL leaves the name),
`fahrtenbuch_assignment_audit`, `monthly_planning_manual_exceptions.assigned_driver_name`,
`historical_driver_hour_targets.driver_name`, `planning_finalizations.driver_summary_json`,
`fahrtenbuch_trips.raw_data_json`, **every storage object** (the Stundennachweis PDFs stay in
`stundennachweise-pdfs`), and the audit-log copies.

### 5.4 It probably cannot run at all for a real driver **[READING — write the test]**

`fahrtenbuch_trips.original_driver_id` is `ON DELETE SET NULL` (`schema.sql:5588`), and
`protect_fahrtenbuch_immutable_fields` raises on any change to that column
(`20260922100000:857-905`). PostgreSQL performs the SET NULL as an UPDATE, which fires the BEFORE
UPDATE trigger — so deleting a driver who is the original driver of any trip should fail. Staging
carries `original_driver_id` on **13,959 of 13,981 trips**, so that is the normal case, not the
edge.

The only two deletions in the kit use drivers with no trips, which is why nothing has caught it.

**Two more of the same kind:** a confirmed `partner_driver_links` row has
`CHECK ((status = 'linked') = (driver_id IS NOT NULL))` against `ON DELETE SET NULL`, so a linked
driver should be undeletable; and an accepted `partner_receipt_submissions` row has the same shape
against its `receipt_id`, so an accepted submission should pin its Beleg.

**Three tests to write before anything is designed on top of this.** Each is small and each
answers a question that is currently a guess.

### 5.5 The rule the integration needs

Two classes, separated by whether the record is one the fleet must keep:

| | action |
|---|---|
| **Erase** | the proposed identity on a link row, `raw_payload`, free text, and the receipt photograph in storage |
| **Restrict** (Art. 18) | the statutory record — the accepted Beleg, the Stundennachweis, the Gehaltsquittung — marked restricted with the ground recorded **on the row**, not deleted |
| **Propagate** | Reidey's `DriverEraser` and retention command must reach `elprofessor_submissions`, or the copy there outlives the original |

Nothing of this exists on either side today.

---

## 6. German text to review and paste

Drafts. A lawyer reviews them; the owner pastes them. Both need the `Stand` date bumped.

### 6.1 Reidey — add to §5 *Empfänger und Weitergabe*

> • **Lohn- und Nachweisverarbeitung durch El-Professor:** Setzt ein Flottenbetreiber zusätzlich
> die Software El-Professor zur Lohn- und Nachweisführung ein, übermitteln wir auf seine Weisung
> die zur Zuordnung erforderlichen Stammdaten seiner Fahrer (interne Fahrer-Kennung, Name und
> — soweit zur Unterscheidung erforderlich — E-Mail-Adresse) sowie die von den Fahrern in der
> Reidey-App selbst eingereichten Belege (Fotos) und betrieblichen Notizen. Verantwortlicher
> bleibt der Flottenbetreiber; beide Anbieter handeln als Auftragsverarbeiter auf seine Weisung.
> Angaben zu Krankheit, Urlaub oder Abwesenheit werden **nicht** übermittelt.

### 6.2 Reidey — add to §3 *Erhobene Daten und Zwecke*

> **Von Fahrern eingereichte Belege und Notizen** — Fotografie eines Belegs sowie die vom Fahrer
> angegebenen Felder (Datum, Betrag, Belegart, Zahlungsart) und betriebliche Notizen mit Art,
> Zeitraum und Freitext. Zweck: Weiterleitung an die vom Flottenbetreiber eingesetzte Lohn- und
> Nachweissoftware zur Prüfung und Verbuchung durch den Flottenbetreiber. Diese Daten verarbeiten
> wir im Auftrag des Flottenbetreibers (siehe Ziffer 2).

### 6.3 El-Professor — `legal.privacy`, the paragraph for this transfer

> **Datenübernahme aus Reidey.** Nutzt Ihr Unternehmen zusätzlich die Dispositionssoftware Reidey,
> kann es die beiden Systeme verbinden. Übernommen werden dann die zur Zuordnung erforderlichen
> Stammdaten der Fahrer (Kennung, Name und soweit erforderlich E-Mail-Adresse) sowie die von den
> Fahrern in der Reidey-App eingereichten Belege und betrieblichen Notizen. Die Verbindung wird
> von Ihrem Unternehmen selbst hergestellt und kann jederzeit widerrufen werden; verantwortlich
> für diese Daten bleibt Ihr Unternehmen.

**Not covered by these drafts, and needed anyway:** the rest of `legal.privacy`, which is `{}` on
production. This integration is not the reason that page is empty, and it cannot be the whole of
what fills it.

---

## 7. The gate — what M0 must deliver before M1 starts

| | | who |
|---|---|---|
| 1 | The legal roles written down as §1 states them | engineering — **done, in this document** |
| 2 | An AVV that exists, and a documented controller instruction for the transfer | owner + lawyer |
| 3 | The statutory-retention answer of §2.4 | lawyer |
| 4 | §6.1 and §6.2 reviewed and live on Reidey, with a new `Stand` | owner |
| 5 | §6.3 reviewed and live in `legal.privacy`, which also stops being `{}` | owner |
| 6 | The three deletion tests of §5.4 written and run | engineering |
| 7 | The owner's answer on §3.2 — does the note text cross for the seven types? | owner |
| 8 | A decision on §2.2: what makes the 30-day promise true, for both copies | owner |

Items 2, 3, 4, 5, 7 and 8 are not engineering work and will not be done by writing code. Items 1
and 6 are, and 6 is the one that should start immediately — it needs no lawyer and it answers three
questions that are currently guesses.
