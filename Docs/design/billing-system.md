# The billing system

**Status:** design, for the owner's approval. No code, no migration, no PR.
**Date:** 25.10.2026
**Scope:** how a customer company comes to owe El-Professor money, how the money
is asked for, how it arrives, how it is recorded so that a German tax office and
the customer's own Steuerberater accept the record, and what happens when it
does not arrive.

---

## 0. How this document was produced, and what that means for trusting it

Every claim about existing behaviour below carries the file and line, or the
production query, that produced it. Read-only SQL was run against production
(`ya-mobility-db-1`) on 25.10.2026 between 18:50 and 19:16 CEST. Every legal
claim carries the primary source it was checked against — the statute text on
`gesetze-im-internet.de`, not a blog or a summary — and the handful of claims
that could **not** be reduced to statute text are marked
**`[Steuerberater]`** and must be confirmed by the owner's tax adviser before
anything is built on them.

Two statements in the brief that commissioned this document turned out to be
wrong against the primary sources, and both are corrected below rather than
repeated:

| the brief said | the statute says |
|---|---|
| invoices must be retained **10 years** (§14b) | **eight** years — §14b Abs. 1 UStG, and §26a Abs. 2 Nr. 2 UStG fines failure to keep them "für mindestens acht Jahre". Shortened from ten with effect from 2025. §147 Abs. 3 AO agrees: Buchungsbelege eight years, while Bücher and Jahresabschlüsse stay at ten. |
| the invoice number must be **gapless** | the statute requires **fortlaufend** and **einmalig** — "eine fortlaufende Nummer mit einer oder mehreren Zahlenreihen, die zur Identifizierung der Rechnung vom Rechnungsaussteller einmalig vergeben wird" (§14 Abs. 4 Nr. 4 UStG). A gap is not forbidden; a **reused** number is. Secondary sources quoting Abschnitt 14.5 Abs. 10/11 UStAE say in so many words that "eine lückenlose Abfolge der ausgestellten Rechnungsnummern ist nicht zwingend" and that several number ranges are permitted. **`[Steuerberater]`** — the BMF original could not be reached from here; confirm before relying on it. |

That difference changes the design. See §5.

And one requirement the brief did not name at all turns out to be the largest
dated obligation on the horizon. See §4.3.

---

## 1. What production actually says

### 1.1 There is no billing

```
=== invoices, every company, every year ===
INV-2026-0001 | 2026-06 | 200 | open | cash | due 2026-05-31 | created 2026-06-07 | MoveNow Fahrdienst
INV-2026-0002 | 2026-05 | 200 | open | cash | due 2026-04-30 | created 2026-06-07 | MoveNow Fahrdienst

=== company_subscriptions (the billing contract) ===
MoveNow Fahrdienst | active | starts 2026-06-07 | billing_day 1 | 200 | cash | plan row "Premium"

=== subscription_payment_audit ===
0 rows

=== subscription_coverage by source ===
manual     | active | 1      ← written today at 19:04:26, by hand
migration  | active | 14
migration  | void   | 1
```

Read the three together. **Two invoices exist in the entire product**, both for
one company, both still `open`, both with a due date *earlier than the month
they invoice* — the consequence of a timezone defect since fixed and documented
at `src/utils/invoiceDueDate.ts:1-24`, whose header names these exact two rows.
Nobody has ever been recorded as paying anything: `subscription_payment_audit`
is empty. And **one** company holds a `company_subscriptions` row, which is the
row `platform_invoice_quotes` and `GenerateInvoicesModal` iterate over — so a
billing run today would quote **one of eighteen** companies and skip the rest in
silence, because they are not in the set it reads
(`20261015160000_first_month_price.sql:440-454`: `WHERE s.status = 'active'`
over `company_subscriptions`).

Access, meanwhile, comes from somewhere else entirely: 14 of the 15 live
coverage rows are `source = 'migration'`, seeded by
`20260919150000_subscription_coverage.sql` from the three columns that existed
before it. Nobody bought them.

One more asymmetry worth naming now, because it makes `company_subscriptions`
look more load-bearing than it is: the contract row's `plan_id` points at
`subscription_plans`, of which production holds **exactly one row** ("Premium",
`monthly_price` 200) — while the price actually charged comes from
`companies.plan` plus the price book. `platform_invoice_quotes` reads the plan and
the car limit off `companies` and ignores `monthly_price` entirely
(`20261015160000:67-69` says so in the header; `:443-444` is the code). So
`subscription_plans` is vestigial except as a foreign-key target, and
`company_subscriptions` matters for `billing_day`, `payment_method`, `status` and
nothing else.

### 1.2 The intervention this document exists to retire, caught in the act

The first pass of §1.1 was run at 18:52 and showed `Smooth Fahrt GmbH` with
`subscription_status = 'expired'`, expiry 2026-09-16 — locked out. A second pass
at 19:15 showed it `active` to 2027-10-25. Between the two:

```
2026-10-25 19:04:26 | Smooth Fahrt GmbH | manual | active | grants | 2026-10-25 → 2027-10-25 | advanced
                    | note: "reopened 25.10.2026 on the owner's instruction"
```

A coverage row typed by hand, a year of access granted, no invoice, no amount,
`price_cents` NULL. The expired `migration` row beside it is the one `void` row
in the table. **This is the current billing system**: when a customer complains,
a human records a period. It is not a criticism of the operator — there is no
other lever. It is the measurement that says what has to be replaced.

After that intervention the locked-out set is:

| company | why refused by `get_active_company_id()` |
|---|---|
| AT Autovermietung GmbH | `status = 'suspended'` **and** `subscription_status = 'expired'` (2026-07-22) |
| AK 95 GmbH# | `status = 'suspended'` **and** `subscription_status = 'expired'` (2026-08-19) |
| tester | `status = 'suspended'`, expired 2026-10-13 |
| Asznee, Jaber, k, test ×3, testtesttest | `status = 'suspended'`, subscription still `active` |
| ergehrt, tester, نن | `approval_status = 'rejected'` |

Two of the real companies are therefore locked out for **two independent
reasons**, and lifting only the subscription would not readmit them. That matters
for §2.6: reactivation is not one switch today.

### 1.3 No invoice this product can produce is a valid German Rechnung

Not a judgement — a column count. Measured:

| §14 Abs. 4 UStG requires | where it would come from | production today |
|---|---|---|
| Nr. 1 seller's full name and address | the `seller` platform setting | `{"name": "El-Professor"}` and **every other field the empty string** — no street, no postal code, no city |
| Nr. 1 buyer's full name and address | `companies.address` / `postal_code` / `city` | **2 of 18** companies have any address at all (Y&A Mobility, MoveNow). `company_settings` is no better: **0 of 17** rows carry a `legal_company_name`, 2 carry a street |
| Nr. 2 seller's Steuernummer **or** USt-IdNr | the `seller` setting's `tax_number` / `vat_id` | both `""` |
| Nr. 3 Ausstellungsdatum | — | **no such column.** `subscription_invoices` has `created_at`, `due_date`, `invoice_month`, `invoice_year` and nothing that is the invoice date. The PDF prints `Erstellt am <now>` (`src/utils/subscriptionPdf.ts:220`) — the *print* date, which changes every time the file is downloaded |
| Nr. 4 fortlaufende, einmalige Nummer | `generate_invoice_number` | exists, with two defects — see §5 |
| Nr. 5 Umfang und Art der Leistung | the PDF's one line item | `"Monatliches Abonnement – <planName>"` (`subscriptionPdf.ts:151`). Thin but arguably sufficient **`[Steuerberater]`** |
| Nr. 6 Zeitpunkt der Leistung | the `Zeitraum` field | present as a month, `"Juni 2026"` |
| Nr. 7 Entgelt, nach Steuersätzen aufgeschlüsselt | — | **missing.** One `amount` column, printed once as `Gesamt` |
| Nr. 8 Steuersatz und Steuerbetrag | — | **missing entirely.** The German UI string at `src/i18n/de.ts:5037` says so out loud: *"Ein Steuersatz ist bewusst nicht dabei, weil die Rechnung heute keinen ausweist"* |
| Nr. 9 / Nr. 10 | — | not applicable (no §14b Abs. 1 Satz 5 case, no Gutschrift) |

Two further defects in the same file:

- `src/utils/subscriptionPdf.ts:123` hard-codes `'Barzahlung'` as the
  Zahlungsart, whatever `subscription_invoices.payment_method` holds.
- `src/utils/subscriptionPdf.ts:54`: `const title = isPaid ? 'Quittung' : 'Rechnung'`.
  Marking an invoice paid **retitles the document**. A Rechnung does not become a
  Quittung; the Rechnung and the receipt for it are two documents, and the
  Rechnung is the one that must satisfy §14. Keeping both from one template is
  fine; silently replacing one with the other is not.

### 1.4 The amount is a float where everything else in this codebase is cents

`subscription_invoices.amount` is `numeric` with no precision or scale (measured
on production: `data_type = numeric`, precision and scale both empty). The
browser inserts `quote.amountCents / 100`
(`src/components/GenerateInvoicesModal.tsx:131`), the invoice-apply function
converts back with `round(v_inv.amount * 100)`
(`20260919170000_subscription_invoice_coverage.sql:400`), and
`subscription_coverage.price_cents` is the only column on the money path that is
already integer cents (`20260919150000:248`). Unconstrained `numeric` is exact,
so nothing is losing a cent today — but the invoice is the one document where the
amount must be reproducible byte for byte, and it is the only amount in the
system that is not stored the way `src/utils/money.ts` stores money.

---

## 2. The money path, end to end

### 2.1 The states, and who moves each one

```
companies.approval_status   pending → approved | rejected        platform, companies.lifecycle
companies.status            active | suspended | inactive        platform, companies.lifecycle
                            | archived | deleted                 (five values since 20261015170000)
companies.plan              basic | advanced | premium           platform_company_set_plan (billing.manage)
                                                                 + derived by the recompute
company_subscriptions       the billing CONTRACT: plan, billing_day,
                            payment_method, status                platform_subscription_assign (billing.manage)
subscription_invoices       the accounting DOCUMENT                GenerateInvoicesModal → direct INSERT
                            open → paid | overdue | canceled      platform_invoice_mark_paid / _unpaid /
                                                                  _cancel / _delete (billing.manage)
subscription_coverage       the ACCESS ledger, one row per period  app_private.subscription_coverage_record
                            active | void                         and subscription_invoice_apply
companies.subscription_*    DERIVED, three columns                 app_private.recompute_company_subscription
                                                                   — the only writer
```

The three-layer separation is already right and must not be collapsed: a
**contract** says what is owed, a **document** says it was asked for, a **ledger**
says what access was bought. The gap is that only the third layer is ever
written.

### 2.2 Signup to first invoice

What happens today: signup writes `companies.status = 'active'`,
`subscription_status = 'inactive'`, `plan = 'basic'`, no trial
(`20261015170000_remove_free_trial.sql`), and `approval_status = 'pending'`. An
operator approves. The company now sees `/abo-aktivieren` and **nothing else** —
`get_active_company_id()` requires `subscription_status = 'active'`. The only way
forward is an activation code the operator generates and the customer types, or a
coverage row typed by hand as in §1.2. There is no invoice in this path at all.
Measured: 13 activation codes exist on production, 9 redeemed, and **zero**
`activation_code` coverage rows — because all nine redemptions predate the
coverage model and were folded into the `migration` rows.

What it should be:

1. Operator approves the company **and assigns the contract in the same act**:
   plan, billing cycle, billing day, payment method, car limit.
   `platform_subscription_assign(company_id, plan_id, billing_day, payment_method)`
   already exists and `AssignSubscriptionModal.tsx` already calls it. What is
   missing is that **approval does not require it**, so 17 of 18 companies have
   no contract. Make the contract a precondition of the first invoice, and make
   its absence visible on the company row rather than silent.
2. The first invoice is raised for the month the contract starts, at
   `first_month_cents` — the owner's flat 200 € — because
   `app_private.invoice_amount_cents` already answers that
   (`20261015160000:358-382`) and `platform_invoice_quotes` already computes
   `first_invoice` as "no earlier non-cancelled invoice by period"
   (`20261015160000:444-451`).
3. The invoice grants access from the moment it is raised, to two business days
   after its due date — `app_private.invoice_grace_end`, already built
   (`20260919170000:283-310`). **So a new customer gets access on the invoice,
   not on a payment.** That is a decision, not a given; see §12.
4. Payment arrives; the operator (or a bank import, or a provider webhook) marks
   it paid; the coverage row moves to cover the whole calendar month.
5. On the billing day of the next month the next invoice is raised, now at the
   per-car price from the book.

### 2.3 Monthly versus yearly

`companies.billing_cycle` holds `monthly` or `yearly` (production: 16 monthly, 2
yearly). The price book's `yearly_discount_percent` is 10. But
`app_private.invoice_amount_cents` divides the yearly price **by twelve** and
raises a monthly invoice either way (`20261015160000:377-379`, and its own
comment: *"An invoice is a month"*). So "yearly" today means *the yearly discount
applied, billed monthly* — it does not mean one invoice a year.

That is a defensible design and it is **cheaper** than real annual billing (no
part-period credit note when a fleet shrinks mid-year). It is also not what a
customer who ticked "yearly" expects. Either rename the choice to "Jahrespreis,
monatlich berechnet", or build annual invoicing properly — one invoice covering
twelve months, `period_start`/`period_end` a year apart, and then a fleet change
mid-period needs a credit note, which this product has no concept of. **Owner
decision** (§12).

### 2.4 A fleet change mid-period

The price is computed from `companies.subscription_car_limit`, **not** from the
cars actually in the fleet. Measured: Smooth Fahrt GmbH has 2 cars and a limit of
10; `tester` has a limit of 8 and no cars; the default is 5 and most companies sit
on it. So the figure the customer is billed on is an operator-typed allowance, not
a count.

That is the right choice for billing stability — a count that moves when a car is
sold would change the price mid-month — but it means **the limit must be the
thing the sales conversation is about**, and nothing in the product enforces it:
a company with a limit of 3 can add a tenth car. Either enforce the limit at
car creation, or accept that it is a billing parameter and rename it. **Owner
decision.**

Given the limit is operator-typed, a mid-period change is simple: the next
invoice prices from the new limit. No proration, no credit note. Say so
explicitly in the contract terms, because the silent alternative — proration — is
what a customer will assume.

### 2.5 A late or failed payment

Already built, and already correct: an `open` or `overdue` invoice grants access
until `app_private.invoice_grace_end(due_date)` =
`add_business_days(due_date, 2)` at midnight Europe/Berlin
(`20260919170000:215-310`). A due date of Friday answers Tuesday 00:00, so the
customer holds Friday through Monday in full.

What is **not** built: anything that tells the customer. See §7.

### 2.6 A customer who stops paying, and coming back

When the grace lapses the coverage row has ended, the recompute writes
`expired`, and `get_active_company_id()` returns NULL — every business table and
every planning RPC refuse. The account shell stays readable so
`/abo-aktivieren` and `/billing` still render (that is the whole point of the
`get_user_company_id()` / `get_active_company_id()` split).

Coming back is where today's model is wrong in a way §1.2 shows. Two things can
refuse a company independently — `companies.status = 'suspended'` and
`subscription_status = 'expired'` — and AT Autovermietung and AK 95 are both.
Marking an invoice paid lifts the second and leaves the first. So **reactivation
must be one act**: a payment recorded against an invoice should, for a company
suspended *for non-payment*, also clear the suspension. It must **not** clear a
suspension imposed for any other reason, and `companies.status` carries no reason
column — which is the missing piece. Either add `suspension_reason` to
`companies`, or keep reactivation a two-step operator act and make the panel say
both steps are needed. **Engineering choice made:** add the reason column; a
one-way door that needs a human to remember the second half is the shape that
produced §1.2.

---

## 3. How payment is actually taken — the recommendation

### 3.1 The four options, with what each costs to run

**(a) Bank transfer on invoice, reconciled by hand.** What happens today,
informally. Build cost: near zero — `platform_invoice_mark_paid(invoice_id,
amount_cents, paid_at, note)` already exists and already takes **integer cents**
(`20260919170000:554`). Run cost: an operator opens the Rechnungen tab, compares
it to the bank account, and marks arrivals — call it 10 minutes a month at six
customers, an hour at fifty. No fees, no mandate, no chargeback, no new network
dependency. **Its failure mode is the one measured in §1.2**: when nobody does
it, access drifts and somebody types a coverage row.

**(b) SEPA Direct Debit.** The German B2B norm, and genuinely the right
end-state. What it actually requires, from the primary sources:

- A **Gläubiger-Identifikationsnummer** from the Deutsche Bundesbank. Free,
  online only, one per applicant, applicant must be seated in Germany, and the
  Bundesbank states plainly that holding it **does not entitle you to collect** —
  your own bank must agree separately.
- A mandate per customer, stored, with a mandate reference, and under the **B2B
  scheme** the debtor must *confirm the mandate at their own bank before the
  first collection's due date*. The B2B scheme gives no refund right at all
  ("Refunds are not provided for under the B2B Scheme"), which is why that
  confirmation step exists. For a fleet of small Mietwagen operators, a step that
  requires each of them to visit their own bank is a conversion killer.
- The **CORE** scheme avoids that step but gives the debtor an unconditional
  eight-week refund right. For a monthly subscription that means a customer can
  claw back the last two collections at will.
- Pre-notification of each collection, `pain.008` XML generation, upload to the
  bank, and handling of R-transactions (returns, refunds, reversals) with their
  reason codes — each of which must find its invoice again and undo the access it
  granted.

Build cost: a slice of its own, several weeks. Run cost per collection: cents.
Run cost of returns: real, and it is the part that is always underestimated.

**(c) A payment provider — Stripe or Mollie.** Would bring subscriptions,
collection, dunning and VAT determination in one integration. Fees: third-party
comparisons put Stripe's SEPA debit at **€0.35 per transaction** with no
percentage, and about €20 per return; Stripe's own German pricing page could not
be reached from this environment, so **treat those figures as unverified and
check stripe.com/de/pricing before deciding**. Stripe Billing adds a percentage
of billed volume on its paid tier. PCI scope stays at SAQ-A if card data never
touches our origin.

The real cost is not the fee. It is that a provider wants to be the system of
record for subscriptions and invoices, and this product **already is** — it has
an invoice table, a numbering function, a PDF, two audited read models, a
coverage ledger and a derived access gate. Running both means reconciling two
sources of truth for the same money, which is the classic double-bookkeeping
trap. And it conflicts with the owner's own decision of 15.10.2026 that the
invoice is accounting only.

**(d) Invoice on account, with the access decision automated.** Option (a) made
rigorous: the invoice is raised by a job rather than by someone remembering to
open a modal, the grace rule already in the database decides access without a
human, dunning mails go out on a schedule, and the **only** manual step is
recording that money arrived.

### 3.2 The recommendation: (d) now, (b) later, (c) not at all

**Build (d).** The reasoning, in the order that decided it:

1. **The failure today is not that money cannot move.** Money moves — the owner
   collects it. The failure is that nothing raises an invoice and nothing closes
   access when one is unpaid. Neither of those is a payment problem, and no
   payment provider fixes either.
2. **Every option needs the invoice to be right first.** An SDD collection must
   equal the invoice amount to the cent with VAT separated; a Stripe invoice must
   either be the record or reconcile to ours. So the §14-compliant invoice is on
   the critical path whatever is chosen, and it is also the work that removes the
   legal exposure in §4. Do it first; then the payment method is an adapter
   behind one function.
3. **At this volume the integration dominates the fee.** Six real customers at
   200–350 € is roughly 1,200–2,100 € a month. A provider's fees on that are
   small in absolute terms — and so is the labour (d) replaces. What a provider
   costs is weeks of integration and a permanent second system, bought to
   automate the cheapest step.
4. **SDD's two schemes each have a disqualifying property at this stage** — B2B
   needs every customer to visit their bank, CORE gives an eight-week clawback —
   and both need a bank relationship that does not exist yet.

**Then build the cheap middle, not the expensive end.** The step after (d) is
**bank statement import**: CAMT.053 or MT940 from the bank, matched on the
invoice number in the Verwendungszweck, proposing payments for the operator to
confirm. That removes the manual step without a mandate, a provider, a fee or an
outbound network call, and it fits this codebase's idiom exactly — a parser, a
test that reads real files, and a review step before anything is written.
Only if the customer count passes roughly fifty, or a customer asks to pay by
card, does (b) or (c) earn its cost.

**Run cost of the recommendation, stated plainly:** two host cron lines (the
machinery for which is written and installed nowhere — §6), one operator session
a month of 5–10 minutes, and no fees. Plus the one obligation that does not go
away: somebody must keep the `seller` setting and each customer's address
correct, because §4 makes those the difference between an invoice and a piece of
paper.

---

## 4. German legal requirements

All of §4 is checked against the statute text. The marker **`[Steuerberater]`**
means the statute does not answer it and an adviser must.

### 4.1 §14 Abs. 4 UStG — the mandatory content

The ten items are quoted and compared against production in §1.3. The short
version: **four of the ten are missing or unreliable today** — the seller's
address and tax number (empty), the buyer's address (missing for 16 of 18
companies), the Ausstellungsdatum (no column; the PDF prints the print date), and
the VAT breakdown (no columns at all).

Who is harmed by a defective invoice matters for how urgent this is, and the
statute answers it:

- **The recipient loses the input-tax deduction.** §15 Abs. 1 Nr. 1 UStG: *"Die
  Ausübung des Vorsteuerabzugs setzt voraus, dass der Unternehmer eine nach den
  §§ 14, 14a ausgestellte Rechnung besitzt."* So the customer's Steuerberater
  rejects the invoice and the customer asks for a corrected one. That is the real
  commercial risk, and with German fleet operators it will surface on the first
  invoice.
- **The issuer can be fined for not issuing, or issuing late.** §26a Abs. 2 Nr. 1
  UStG makes failure to issue an invoice under §14 Abs. 2 Satz 2, or issuing it
  late, an Ordnungswidrigkeit with a Geldbuße up to €5,000 where done
  "vorsätzlich oder leichtfertig". §26a Abs. 2 Nr. 2 does the same for failing to
  keep one for at least eight years.
- Whether a *defective* invoice (as opposed to none) is itself fineable is not
  answered by §26a's text. **`[Steuerberater]`**

And note the deadline: §14 Abs. 2 Satz 2 obliges the invoice **within six months**
of the service being performed, for a supply to another business.

### 4.2 §14b UStG — retention

**Eight years**, beginning at the end of the calendar year in which the invoice
was issued (§14b Abs. 1). §147 Abs. 3 AO agrees for Buchungsbelege and leaves
Bücher and Jahresabschlüsse at ten. §14b Abs. 1 also requires that the invoice
keep satisfying §14 Abs. 3 Satz 1 — authenticity of origin, integrity of content
and legibility — **for the whole period**.

That last clause is the one with an engineering consequence, and it is the reason
this is not satisfied by "the row is in the database". The invoice the customer
received is a **PDF generated on demand** from the current `seller` setting, the
current `companies.address`, the current `plan` name and `new Date()`
(`src/utils/subscriptionPdf.ts:220`). Change the seller address, rename a plan,
or correct a company's address, and **every past invoice reprints differently**.
Integrity of content, over eight years, means the document must be frozen:
either the PDF is stored once and served thereafter, or every field it prints is
snapshotted onto the invoice row at issue. §9 slice 2 takes the second route,
because this stack's storage buckets are tenant-keyed and an invoice is the
platform's document, not a company's.

### 4.3 The E-Rechnung obligation — the finding the brief did not name

This is the largest dated obligation and nothing in the product addresses it.

- §14 Abs. 1 Satz 3 UStG: *"Eine elektronische Rechnung ist eine Rechnung, die in
  einem strukturierten elektronischen Format ausgestellt, übermittelt und
  empfangen wird und eine elektronische Verarbeitung ermöglicht."* A PDF is a
  **"sonstige Rechnung"** (Satz 4), not an electronic one.
- §14 Abs. 1 Satz 6 Nr. 1: the structured format must conform to *"der
  europäischen Norm für die elektronische Rechnungsstellung und der Liste der
  entsprechenden Syntaxen gemäß der Richtlinie 2014/55/EU"* — in practice
  EN 16931, i.e. XRechnung or a ZUGFeRD hybrid. Nr. 2 permits another agreed
  format only if the required data can be extracted into one that is
  interoperable with Nr. 1.
- §14 Abs. 2 Satz 2 Nr. 1: for a supply to another business where **both parties
  are established in Germany**, *"die Rechnung ist als elektronische Rechnung
  nach Absatz 1 Satz 3 und 6 auszustellen"*. All 18 production companies have
  `country = 'Deutschland'`. This rule is about El-Professor's customers, every
  one of them.
- The transitional relief is **§27 Abs. 38 UStG**, and it has a cliff:
  - **Nr. 1** — a "sonstige Rechnung" is still allowed **until 31.12.2026** for a
    supply performed after 31.12.2024 and before 1.1.2027.
  - **Nr. 2** — that is extended **through 31.12.2027** only if the *issuer's*
    Gesamtumsatz (§19 Abs. 2) in the **previous calendar year** was **not more
    than €800,000**.

So: El-Professor's turnover is far below €800,000, which means the PDF is lawful
through **31.12.2027** and unlawful from **1.1.2028** — unless §4.4 applies, in
which case the relief is permanent. **That date is fourteen months out and it is
the one deadline in this document that cannot be negotiated.** It does not block
the first slice; it does mean the invoice data must be modelled as *data*
(separate net, rate and tax; a real issue date; a frozen buyer snapshot) rather
than as PDF drawing instructions, because an EN 16931 document is generated from
fields and a PDF is not. Every slice below is shaped so that the 2028 work is a
new renderer over the same columns, not a re-modelling.

One more half, for completeness: the obligation to **receive** structured
invoices started 1.1.2025 with no transitional relief. That is about
El-Professor's own incoming invoices, not this product, and is out of scope here.

### 4.4 §19 UStG — Kleinunternehmer, and why it is the first question

§19 Abs. 1 Satz 1: the turnover *"ist steuerfrei, wenn der Gesamtumsatz nach
Absatz 2 im vorangegangenen Kalenderjahr 25 000 Euro nicht überschritten hat und
im laufenden Kalenderjahr 100 000 Euro nicht überschreitet."* Both limits must
hold. Since 2025 the turnover is genuinely **steuerfrei**, not merely untaxed.

If El-Professor is a Kleinunternehmer, three things follow and all three are
load-bearing:

1. **No VAT on any invoice.** §14 Abs. 4 Nr. 8 is then satisfied by *"im Fall
   einer Steuerbefreiung einen Hinweis darauf, dass für die Lieferung oder
   sonstige Leistung eine Steuerbefreiung gilt"* — a sentence, not a figure.
2. **A reduced content list, in §34a UStDV**: seller's and recipient's full name
   and address, the seller's Steuernummer / USt-IdNr / Kleinunternehmer-ID, the
   Ausstellungsdatum, quantity and nature of the service, the Entgelt *"in einer
   Summe"* with the §19 note, and "Gutschrift" for self-billing. Notably it does
   **not** list an invoice number.
3. **Permanent exemption from the E-Rechnung obligation.** §34a UStDV says such
   an invoice *"kann abweichend von § 14 Absatz 2 Satz 2 des Gesetzes immer als
   sonstige Rechnung"* be transmitted. The 2028 cliff in §4.3 does not apply.

And if El-Professor is **not** a Kleinunternehmer, or stops being one: 19 % VAT
under §12 Abs. 1 UStG (*"Die Steuer beträgt für jeden steuerpflichtigen Umsatz
19 Prozent der Bemessungsgrundlage"*), a full §14 Abs. 4 content list, and the
2028 e-invoice obligation.

One deliberate gap in that sentence: the §12 Abs. 2 list of reduced-rate supplies
was **not** read item by item here, so "a SaaS subscription is standard-rated at
19 %" is the expected answer and is marked **`[Steuerberater]`** rather than
asserted. It is the same discipline the rest of this section follows, and it costs
one question.

**The arithmetic the owner has to look at.** Six real customers at 200–350 €/month
is roughly 14,000–25,000 € a year — right on the €25,000 previous-year limit.
Ten customers clears it. So Kleinunternehmer status is at best a one-year answer,
and the transition is the dangerous part: once the **current-year €100,000** limit
is exceeded, the exemption stops — and *from which moment* it stops is **not
stated in §19's text**. It is administrative interpretation. **`[Steuerberater]`
— this is the single most important question to put to the adviser**, because
getting it wrong means invoices issued without VAT for turnover that owed it, and
the VAT is then owed out of the price already collected.

§19 Abs. 3 also allows a five-year irrevocable waiver (*"unwiderruflich
erklären, dass er auf die Anwendung des Absatzes 1 verzichtet"*, binding
*"mindestens für fünf Kalenderjahre"*), declarable until the end of February of
the second year following.

**Engineering consequence, and it is the reason this is in a design document at
all:** the system must support **both** regimes and a dated switch between them,
because the switch will happen. That means the VAT rate is a property **of the
invoice**, stored on the row, never read from a setting at print time — exactly
the rule `salary_cash_receipts.business_month` and `.attests` already follow in
this codebase.

### 4.5 §33 UStDV — the Kleinbetragsrechnung, and why it is not used

An invoice whose gross total does not exceed **€250** may omit the recipient's
name and address and the invoice number, showing the Entgelt and the tax as one
figure with the rate. The flat first month of 200 € would qualify; a premium
company's 350 € would not.

**Deliberately not used.** A simplification that applies to some invoices and not
others produces two document shapes, two code paths and an invoice whose validity
depends on its amount. Issue the full form always.

### 4.6 Reverse charge and non-German customers — deliberately out of scope

Measured: all 18 production companies have `country = 'Deutschland'`.

If a non-German EU business ever becomes a customer, the place of supply moves to
the recipient (§3a Abs. 2) and §14a Abs. 1 applies: the invoice must carry
*"Steuerschuldnerschaft des Leistungsempfängers"*, must give *"die
Umsatzsteuer-Identifikationsnummer des Unternehmers und die des
Leistungsempfängers"*, and must be issued **by the 15th day of the month
following** the month of supply. A Zusammenfassende Meldung under §18a would also
be due. **`[Steuerberater]`** for the ZM mechanics.

**Out of scope, with a guard rather than a silence.** Building reverse charge for
a customer base that is 18/18 German is premature. Building a **guard** is not:
invoice generation must refuse a company whose `country` is not Germany, with a
named reason, rather than quietly issuing a German-VAT invoice to a Dutch
operator. That guard is three lines and it is in slice 2.

---

## 5. Invoice numbering

### 5.1 What the statute requires, and what it does not

§14 Abs. 4 Nr. 4: *"eine fortlaufende Nummer mit einer oder mehreren Zahlenreihen,
die zur Identifizierung der Rechnung vom Rechnungsaussteller einmalig vergeben
wird (Rechnungsnummer)"*. Two properties: **fortlaufend** (sequential) and
**einmalig** (assigned once). Secondary sources quoting Abschnitt 14.5 Abs. 10/11
UStAE say a gapless sequence is explicitly *not* required and that several ranges
are permitted provided each invoice is assignable to its range and each number is
unique. **`[Steuerberater]`** to confirm the UStAE wording.

So the design target is **unique, never reused, monotonically increasing** — not
gapless. That is a materially easier target than the brief assumed, and it
matters for §5.3.

### 5.2 Two defects in the live function

Read off production, not off the migration:

```sql
CREATE OR REPLACE FUNCTION public.generate_invoice_number(p_year integer) ...
  SELECT COALESCE(MAX(CAST(SPLIT_PART(invoice_number, '-', 3) AS integer)), 0) + 1
    INTO next_seq FROM public.subscription_invoices WHERE invoice_year = p_year;
  inv_number := 'INV-' || p_year::text || '-' || LPAD(next_seq::text, 4, '0');
```

**Defect 1 — the number is reused.** The sequence is `max()` over the *surviving*
rows. `platform_invoice_delete` (`20261021120000`) deletes an unpaid invoice, and
its own header says so in as many words: *"deleting the newest invoice of a year
frees its number"*. The header's defence is that only an unpaid invoice can be
deleted so no receipt carries the number — but the **Rechnung** may already have
been downloaded and sent, and §14 Abs. 4 Nr. 4's *einmalig* is about the number,
not about whether it was paid. Two documents bearing `INV-2026-0003` is the one
thing the statute does forbid.

**Defect 2 — two callers get the same number.** There is no lock and no sequence.
`GenerateInvoicesModal` draws the number in one round trip
(`src/components/GenerateInvoicesModal.tsx:115`) and inserts in another (`:123`),
with no transaction between them. Two operators generating a month at once both
read the same `max()`. The `UNIQUE (invoice_number)` constraint catches it — and
then `src/components/GenerateInvoicesModal.tsx:138` maps `23505` to **"skipped"**,
so a company that was never invoiced is reported as already invoiced. A silent
miss, in the one screen whose job is not to miss anybody.

**Defect 3 — the setting is decorative.** `app_private.platform_settings` holds
`invoice.number_prefix = "INV"` and `number_digits = 4`, and the function reads
neither: both are literals in the body. An operator who changes the prefix
changes nothing.

**Defect 4 — one bad row kills the year.** `CAST(SPLIT_PART(...,'-',3) AS integer)`
raises `22P02` on any `invoice_number` whose third hyphen-part is not numeric. One
hand-written row and no further invoice can be numbered for that year.

### 5.3 The shape to build, reusing the prior art

`public.document_counters` (`20260914140000_salary_cash_receipts.sql:69-97`) is
the right shape and it already works:

```sql
CREATE TABLE public.document_counters (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  doc_type   text NOT NULL CHECK (doc_type ~ '^[a-z_]+$'),
  year       integer NOT NULL CHECK (year BETWEEN 2000 AND 2999),
  n          integer NOT NULL CHECK (n > 0),
  PRIMARY KEY (company_id, doc_type, year)
);
-- next_document_number(): INSERT ... ON CONFLICT DO UPDATE SET n = c.n + 1 RETURNING n
-- "The row lock the upsert takes is what serialises numbering within a company
--  and year; the rollback of a failed confirmation takes the increment with it."
```

Three things to change when copying it, each for a reason:

1. **The key is wrong for this document.** `document_counters` is keyed on the
   *company*, because a Gehaltsquittung is issued by the company. A Rechnung is
   issued by **El-Professor** — one issuer, so one series. Put it in
   `app_private.platform_document_counters (doc_type, year, n)` with no company
   column, not in the tenant table with a sentinel company id.
2. **Draw the number inside the transaction that inserts the invoice.** That
   means invoice creation becomes an RPC — `platform_invoice_raise(...)` — not a
   browser `INSERT`. This is the fix for defects 2 and 3 and it is the same move
   every other billing write already made in `20260916130000`. It also puts the
   generation behind `billing.manage` and one audit row, like its siblings.
3. **Never reuse.** With a counter table the number is consumed at issue and the
   counter does not go back when a row is deleted. That satisfies *einmalig* and
   leaves a gap — which §5.1 says is permitted. **`[Steuerberater]`** on the
   gap; if the adviser insists on gaplessness, the answer is not to reuse numbers
   but to **stop deleting invoices**: cancel them, which `platform_invoice_cancel`
   already does and which leaves the number attached to a document that says
   "storniert".

### 5.4 What to do about `platform_invoice_delete`

It shipped four days ago on the owner's request and it is the one function in the
billing set that cannot survive a correct numbering scheme unchanged. Two options:

- **Keep delete, stop reusing** (recommended): once the counter is the source of
  the number, delete frees nothing. The gap is permitted. Delete stays available
  for the real case it was built for — an invoice raised in error, for the wrong
  month or the wrong company, before anybody saw it.
- **Retire delete in favour of cancel.** Cleaner against a gapless reading of the
  law, worse for the operator, and it undoes a decision taken on 21.10.2026.

Either way the **transition** needs care: production holds two invoices,
`INV-2026-0001` and `INV-2026-0002`. Seeding the counter must take
`max(sequence)` over all rows **that have ever existed**, which nothing records —
so seed from the surviving maximum and accept that the two numbers already issued
define the floor. At two rows that is safe; it would not be at two thousand.

---

## 6. VAT

### 6.1 The columns

VAT must be stored, never computed at print time, for the §14b Abs. 3 reason in
§4.2: the document must say the same thing in eight years. Add to
`subscription_invoices`:

| column | type | why |
|---|---|---|
| `invoice_date` | `date NOT NULL` | §14 Abs. 4 Nr. 3. Today there is no such column and the PDF prints `new Date()` |
| `net_amount_cents` | `bigint NOT NULL CHECK (>= 0)` | §14 Abs. 4 Nr. 7, integer cents |
| `vat_rate_bp` | `integer NOT NULL CHECK (BETWEEN 0 AND 10000)` | the rate in **basis points** — 1900 for 19 %. Not a numeric percent: the rate has been 16 % within living memory of this product's customers, and a basis-point integer is exact |
| `vat_amount_cents` | `bigint NOT NULL CHECK (>= 0)` | §14 Abs. 4 Nr. 8, stored, not derived |
| `gross_amount_cents` | `bigint NOT NULL` | what the customer pays. `CHECK (gross = net + vat)` |
| `tax_regime` | `text NOT NULL CHECK (IN ('standard','small_business','reverse_charge'))` | which of §4.4's regimes this invoice was issued under, so the PDF prints the right note and a later change of regime cannot reword a past invoice |
| `seller_snapshot` | `jsonb NOT NULL` | the `seller` setting as it was at issue |
| `buyer_snapshot` | `jsonb NOT NULL` | the buyer's name and address as they were at issue |

`amount numeric` stays, as the gross, until every reader is moved — then it goes.
Do **not** drop it in the same migration: `platform_invoices_list`,
`platform_invoice_mark_paid`, `subscription_invoice_apply` and the PDF all read
it, and `SCHEMA_EPOCH` would have to bump.

### 6.2 The arithmetic, and the one place it lives

Prices in the book are **gross or net?** The book says `price_per_car_cents:
{basic: 2000, advanced: 4000, premium: 7000}` and `first_month_cents: 20000` —
and nothing anywhere says which. The owner said "200 Euro". **Owner decision**
(§12), and it is not cosmetic: 200 € gross at 19 % is 168,07 € net + 31,93 € VAT;
200 € net is 238,00 € gross. Customers will notice either way.

**Engineering choice made:** the book stays **net**, and gross is derived. Reasons:
the rate changes and the net price should not; a Kleinunternehmer invoice has a
net that equals the gross, so a net book works unchanged in both regimes; and
rounding is cleaner forwards (`vat = round(net * rate_bp / 10000)`) than backwards.
If the owner means 200 € gross, the migration that seeds the rate also rewrites
the book's four figures to their net equivalents — once, with the old values
recorded in the migration header.

One function computes it, in SQL, and one twin in TypeScript, held together by a
parity test exactly as `compute_plan_price` and `calcPricing` already are
(`src/utils/pricing.parity.test.ts`, `tests/rls/pricing.sql`):

```
app_private.invoice_tax(net_cents, regime, rate_bp)
  → (net_cents, vat_rate_bp, vat_amount_cents, gross_cents)
     standard        : vat = round(net * rate_bp / 10000), half away from zero
     small_business  : rate_bp = 0, vat = 0, gross = net
     reverse_charge  : rate_bp = 0, vat = 0, gross = net   (+ the §14a note)
```

Rounding: once, at the invoice total, half away from zero. Not per line — there
is one line.

### 6.3 Where the rate comes from

A new `vat` platform-settings key: `{"regime": "...", "standard_rate_bp": 1900,
"small_business_note": "...", "valid_from": "YYYY-MM-DD"}`, owner-only
(`settings.manage`), with its validator added by restating
`app_private.platform_settings_problem` carrying every existing branch character
for character — the rule `20261015160000:102` and `20260920130000` both follow,
and the only way a key may be added.

The invoice reads the setting **once, at issue**, and stores the result. Nothing
reads the setting at print time. That is the whole mechanism by which a regime
change does not reword eight years of history.

### 6.4 The two existing hazards, restated

- **`price_cents` on `subscription_coverage` is filled for invoices only**
  (`20260919170000:400`); a redemption, a manual grant and the backfill all write
  NULL, because none of them knows what the period cost. Production confirms: 15
  coverage rows, **zero** with a price. It is therefore **not** a revenue record
  and must never be summed as one.
- **`company_subscriptions.monthly_price` is a rate, not a price.** It is copied
  from `subscription_plans` when the contract is assigned; production's single
  row holds 200 while the price book would quote 350 for that company (premium,
  5 cars). `platform_invoice_quotes` already ignores it
  (`20261015160000:67-69` in the header, `:443-444` in the code). Leave it
  ignored, and stop displaying it anywhere a
  reader could take it for the price.

---

## 7. Dunning

### 7.1 What exists to build on

The notification machinery is complete and running: `notification_settings` per
company, `notification_deliveries` with a dedupe key of
`(company_id, notification_type, target_id, period_key)` where `period_key` is
**the date the notice is about, never the date of the run**, the
`notify-expiries` edge function, German wording fixed in
`supabase/functions/_shared/notification-mail.ts`, recipients resolved as the
company's active non-staff `admin` profiles with a confirmed account, and a host
cron line at 10:07 on both stacks. Two types survive
(`notification-core.ts:40-44`): `tuev_bald_ablaufend` and `tuev_abgelaufen` — the
two trial types were deleted with the trial by `20261015170000`.

### 7.2 The schedule

Counted from the invoice's `due_date`. The grace that already exists —
`add_business_days(due_date, 2)` — is the moment access closes, so the schedule
must put a warning **before** it, not after:

| when | what | to whom |
|---|---|---|
| invoice raised | the invoice, with its PDF and the payment details | the company's admins |
| due_date − 3 days | *Zahlungserinnerung*: due on X | the company's admins |
| due_date + 1 | *1. Mahnung*: overdue, access ends on `grace_end` — **named explicitly** | the company's admins |
| `grace_end` | access has ended; the invoice and how to restore it | the company's admins **and** the operator |
| due_date + 14 | *2. Mahnung* | the company's admins + the operator |
| due_date + 30 | operator decision point: suspend, write off, or escalate. **No automatic suspension** | the operator only |

Three rules in that table are load-bearing:

1. **Access closing and the second reminder are not the same event.** Access
   closes two business days after due; the reminders continue, because a customer
   locked out is precisely the one who needs to be told how to get back in.
2. **Nothing suspends a company automatically.** `companies.status = 'suspended'`
   is `companies.lifecycle`'s act, owner and support only, and it is the state
   whose reason nobody records (§2.6). Expiry already denies access; suspension
   adds nothing except a second lock somebody must remember to undo — which is
   §1.2's failure mode.
3. **Day 30 is a decision, not a step.** German B2B debt collection
   (Mahnverfahren, Verzugszinsen under §288 BGB, a Mahnbescheid) is a business
   process, not a feature. The product's job ends at telling the operator.

### 7.3 Two constraints the existing machinery imposes

- **A customer must not be able to switch its own dunning off.**
  `notification_settings` is written by the company's own administrators
  (`is_company_admin()`), which is right for a TÜV reminder and wrong for a
  Mahnung. So the dunning types must **not** be rows in `notification_settings`:
  they are unconditional, with no per-company switch, and `NotificationsPage`
  must not list them.
- **The dedupe key must be the invoice, not the day.** `period_key` for a dunning
  row is the invoice's `due_date`, and `target_id` the invoice id. Then a
  never-paid invoice is dunned once per stage rather than nightly, re-raising an
  invoice is a new occurrence, and two overlapping cron runs are safe — all of
  which the existing table gives for free. The job claims before it sends and
  never retries, so a crash loses a reminder rather than repeating it.

### 7.4 One thing to measure before shipping, not after

`notification_deliveries` carries both support-session triggers
(`refuse_read_only_context_write` and `record_support_write`) because the rule is
keyed on the policies rather than on who writes. Dunning adds one row per stage
per invoice — small. But the **mail** volume is a new charge on production's
Resend quota and reputation, and staging relays to real recipients. Dunning mail
must be tested with `@example.com` addresses only, and the first production run
watched.

---

## 8. The sweeps

### 8.1 What they are and why nothing calls them

Two functions, written and granted, called by nothing:

- `app_private.subscription_invoices_apply_all()` — `subscription_invoice_apply`
  over every invoice (`20260919170000:449-470`).
- `app_private.recompute_all_company_subscriptions()` — the recompute over every
  company (`20260919150000:449-470`).

Both headers say the omission is deliberate. The recorded blocker was a real
defect: `subscription_invoice_apply` looked up an invoice's coverage row with no
`status` filter and set it back to `active`, so a nightly sweep **re-admitted a
company an administrator had set to `expired`** through the Abo-Status modal —
every night, for any company with a paid invoice covering the current month.

**That blocker is gone.** `20260921130000_invoice_reapply_keeps_void.sql` fixed
it: a voided invoice period is revived only when its own invoice voided it
(`void_reason = 'invoice_canceled'`, and the invoice is no longer cancelled) or
when the caller is `platform_invoice_mark_paid`, the only caller passing
`p_reinstate => true`. Everything else answers `superseded` and writes nothing.
Production's ledger confirms the migration is applied.

What remains open is the lesser one, recorded as `HOLE[revival]` in
`tests/rls/subscriptions.sql` §9: an ended invoice period comes back at its **old
tier** when the invoice is marked paid, and then decides `plan` — so an owner's
`platform_company_set_plan` can be undone by a late payment. Access is unaffected;
the tier is not.

### 8.2 Install them, in this order

The blast radius is measurable, and it was measured. Replicating the recompute's
rule as a read-only SELECT over production's coverage rows:

```
tester              | stored active 2026-10-13 → expired 2026-10-13   WOULD CHANGE
every other company |                                                  same
```

**One** company would move, from `active` with a past expiry to `expired` with the
same past expiry — and `get_active_company_id()` already refuses it on the expiry
clause, so **no access changes**. The invoice sweep would create coverage rows for
the two open `MoveNow` invoices, both ending in the past, and MoveNow holds an
open-ended `migration` row that outranks them — again no access change.

So:

1. Run the simulation query again on the day (it is in this document's §8.2 and
   took one round trip), and run the two blast-radius queries HANDOFF.md carries.
2. Install on **staging** first, in the shape of
   `/etc/cron.d/el-professor-otp`: `subscription_invoices_apply_all()` then
   `recompute_all_company_subscriptions()`, in that order, because the second
   reads what the first writes.
3. Watch one staging run, then install on production with the owner's explicit
   yes — a host change, and one yes is not a standing yes.
4. Close `HOLE[revival]` **before** the sweep can reach an invoice whose payment
   is recorded by a job rather than a human. Today a payment is a deliberate
   operator act and the tier revival is visible; under automated payment it would
   not be.

**Do not** take the dry run as optional:
`BEGIN; SELECT app_private.recompute_all_company_subscriptions(); ROLLBACK;` is
the shape, as the audit purge's install used.

---

## 9. What exists versus what must be built

| machinery | state | proof |
|---|---|---|
| **access ledger** `subscription_coverage` | **exists** | `20260919150000:238-266`; 15 rows on production |
| one writer of the three derived columns | **exists** | `app_private.recompute_company_subscription`, `20260919150000:356-432` |
| wall against direct writes of the five columns | **exists** | `refuse_direct_subscription_write`, `20260920120000:150`; catalogue reader `:257` |
| coverage recorder | **exists** | `app_private.subscription_coverage_record`, `20260919150000:478-535` |
| invoice → coverage rule | **exists** | `app_private.subscription_invoice_apply`, `20260919170000:327-425` |
| grace: 2 business days after due | **exists** | `subscription_grace_business_days` / `add_business_days` / `invoice_grace_end`, `20260919170000:215-310` |
| voided period not revived by a re-apply | **exists** | `20260921130000` |
| price book in the database, one rule, two engines | **exists** | `20260916150000`; `app_private.price_book_price` `20261015160000:280`; `calcPricing` `src/utils/pricing.ts:97` |
| first month flat, then per car | **exists** | `20261015160000`; `first_month_cents: 20000` on production |
| one place an invoice amount is decided | **exists** | `app_private.invoice_amount_cents`, `20261015160000:358-382`; twin `invoiceAmountCents` `src/utils/pricing.ts:158` |
| quote per company per period, audited | **exists** | `public.platform_invoice_quotes`, `20261015160000:392-460` |
| audited billing read models | **exists** | `platform_invoices_list`, `platform_subscriptions_list`, `20260924110000` |
| billing writes as audited RPCs | **exists** | `platform_invoice_mark_paid` / `_unpaid` / `_cancel` (`20260919170000:554-760`), `_delete` (`20261021120000`), `platform_subscription_assign`, `update_company_subscription_manual` |
| mark-paid takes **integer cents** | **exists** | `platform_invoice_mark_paid(uuid, bigint, timestamptz, text)`, live signature |
| invoice PDF | **partial** | `src/utils/subscriptionPdf.ts` — draws, but see §1.3: no VAT, no issue date, hard-coded Zahlungsart, retitles when paid, reprints from current settings |
| seller block on the invoice | **partial** | `public.platform_invoice_seller()` + `invoiceSellerFields` (`src/lib/platformSettings.ts:402`) exist; the production setting is **empty but for the name** |
| buyer address on the invoice | **partial** | columns exist on `companies`; **2 of 18** populated |
| invoice numbering | **partial** | `generate_invoice_number` exists and is sequential; it **reuses** numbers, races, ignores its own settings, and dies on a malformed row — §5.2 |
| raising invoices | **partial** | `GenerateInvoicesModal` exists; it is a browser `INSERT` with no transaction, it covers only companies holding a `company_subscriptions` row (**1 of 18**), and it misreports a collision as "skipped" |
| the contract row for every customer | **missing** | 1 of 18 companies has `company_subscriptions`; nothing requires it |
| **VAT** — rate, net, tax amount, regime | **missing** | no columns on `subscription_invoices`; `src/i18n/de.ts:5037` says the omission is deliberate |
| **Ausstellungsdatum** | **missing** | no column; PDF prints `new Date()` (`subscriptionPdf.ts:220`) |
| **frozen document** (§14b integrity, 8 years) | **missing** | PDF regenerated on demand from live settings |
| **seller/buyer snapshot on the invoice** | **missing** | — |
| **automatic invoice raising** | **missing** | no job; a human opens a modal |
| **payment recording other than by hand** | **missing** | no bank import, no mandate, no provider |
| **dunning** | **missing** | notification machinery exists (§7.1); no invoice type, no schedule |
| **the sweeps installed** | **missing** | written (`20260919150000:449`, `20260919170000:449`), called by nothing; blocker cleared by `20260921130000` |
| **E-Rechnung (EN 16931)** | **missing** | lawful until 31.12.2027 under §27 Abs. 38 Nr. 2; required from 1.1.2028 unless §19/§34a applies |
| **reverse charge / non-German customers** | **missing, out of scope** | 18/18 companies `country = 'Deutschland'`; a refusal guard is in scope |
| **credit note (Storno-/Gutschrift) as a document** | **missing** | `platform_invoice_cancel` changes a status; it issues no document |
| **gapless-number counter** | **missing** | prior art `document_counters` + `next_document_number`, `20260914140000:69-97` |
| suspension reason on `companies` | **missing** | §2.6; two independent locks today, one of them reasonless |

---

## 10. The slice plan

Each slice is independently shippable, independently revertible, targets
`staging`, and carries its own migration self-check, `tests/rls/` file and
`matrix.sql` lines — because the RLS kit is the only gate that parses SQL.

Migration timestamps: the highest in flight across all branches today is
`20261025130000_seed_viewer_system_role.sql`, and
`20261025120000_company_modules.sql` is unmerged on `work/company-modules-slice1`.
**Re-check the union of `staging` and every open branch before numbering**, and
sweep `src/` for the filename too — this has collided three times.

### Slice 0 — decisions only, no code

Not a slice of work; a gate on every slice below. §12 lists it.

### Slice 1 — the invoice becomes a document (named; start here)

**Migration** (`2026102X1X0000_invoice_is_a_document.sql`):

- `ALTER TABLE public.subscription_invoices` adds `invoice_date date`,
  `net_amount_cents bigint`, `vat_rate_bp integer`, `vat_amount_cents bigint`,
  `gross_amount_cents bigint`, `tax_regime text`, `seller_snapshot jsonb`,
  `buyer_snapshot jsonb` — all **nullable at first**, with the CHECKs that can be
  written without a backfill.
- Backfill the two production rows from what is knowable: `invoice_date :=
  created_at::date`, `gross := amount`, and `tax_regime := 'legacy'` — a fourth
  regime value meaning *issued before this slice, breakdown unknown*, so nothing
  has to invent a net for a document already sent. The CHECK `gross = net + vat`
  applies only where `tax_regime <> 'legacy'`.
- New settings key `vat`, its validator added by **restating**
  `app_private.platform_settings_problem` with every existing branch carried
  character for character, plus a self-check that re-states what each old branch
  refuses. Seed it from the owner's §12 answer.
- `app_private.invoice_tax(net_cents, regime, rate_bp)` — the one arithmetic.
- `app_private.platform_document_counters (doc_type, year, n)` and
  `app_private.next_platform_document_number(doc_type, year)`, copied from
  `20260914140000:69-97`, seeded from `max(sequence)` over the surviving invoices.
- `public.platform_invoice_raise(company_id, month, year)` — `billing.manage`,
  one transaction, one audit row, draws the number from the counter, computes the
  amount from `invoice_amount_cents`, splits it with `invoice_tax`, snapshots
  seller and buyer, and **refuses** with a named reason when: no contract row, no
  seller address or tax number, no buyer address, `country <> 'Deutschland'`, an
  invoice already exists for that company and period, or the price book is
  unreadable. Every refusal is a return value, never an exception — the audit row
  must survive.
- `generate_invoice_number` keeps its signature and answers NULL, so the browser
  cannot draw a number any more; a self-check asserts nothing else calls it.

**Browser:** `GenerateInvoicesModal` calls `platform_invoice_raise` per company
instead of inserting, and reports each named refusal rather than "skipped".
`subscriptionPdf.ts` prints the stored `invoice_date`, the net/rate/VAT lines, the
regime note, and the snapshots; the `'Barzahlung'` literal and the
`isPaid ? 'Quittung'` title both go. A `'legacy'` invoice prints as it does today,
with no breakdown.

**Gates:** migration self-check (the raise function asks `billing.manage` first;
the counter never decrements; `gross = net + vat` where not legacy; the validator
still refuses every old key's old problems); `tests/rls/invoice-document.sql` —
every refusal reason, the counter under two sessions via dblink as
`tests/rls/vehicle-day-two-sessions.sql` does, and that a number is never reused
across a delete; `matrix.sql` rpc lines for `platform_invoice_raise` and the new
table; `src/utils/invoiceTax.parity.test.ts` as the twin of `invoice_tax`, pinning
both regimes from an alien rate so a formula that ignored its argument fails.

**Reversible:** the new columns are additive and nullable; reverting restores the
browser insert. No `SCHEMA_EPOCH` bump.

### Slice 2 — every customer has a contract

`platform_subscription_assign` becomes part of approval rather than a separate
modal somebody forgets: the company row carries whether a contract exists, the
panel's company list shows it, and approval offers it. Backfill is **operator
work, not a migration** — 17 companies need a plan, a car limit, a billing day
and a payment method, and only the owner knows them. The slice ships the screen
and the "no contract" badge; the owner fills it in.

Gates: `tests/rls/` lines for the badge's read; no new table.

### Slice 3 — raising invoices on a schedule

A `notify`-shaped edge function, or a plain RPC called by a host cron line, that
on the billing day raises the month's invoices through `platform_invoice_raise`
and mails each one. Dedupe is the `UNIQUE (company_id, invoice_month,
invoice_year)` that already exists. **No automatic raising for a company whose
contract or addresses are incomplete** — it answers a refusal and the operator
sees it.

Gates: `tests/rls/` for the job's authorization (service-role bearer compared in
constant time, as `notify-expiries` does); the first run on staging watched.

### Slice 4 — the sweeps

§8.2, in that order. No migration unless `HOLE[revival]` is closed in the same
slice, which it should be.

### Slice 5 — dunning

§7, on the existing notification machinery. New delivery types, no
`notification_settings` rows, dedupe on the invoice and its due date.

### Slice 6 — bank statement import (CAMT.053 / MT940)

A parser, a matcher on the invoice number in the Verwendungszweck, a review
screen, and `platform_invoice_mark_paid` as the only writer. Replaces the manual
step without a provider.

### Slice 7 — the frozen document

Store the rendered PDF once, at issue, and serve it thereafter. Needs a storage
decision: the four company buckets are tenant-keyed by the object's first folder
and an invoice is the platform's document, so this needs a bucket of its own with
policies written the way `20260920100000` writes them — read on
`get_user_company_id()`, write never from a browser. Slice 1's snapshots make
this optional rather than urgent.

### Slice 8 — EN 16931, before 1.1.2028

A second renderer over slice 1's columns, producing XRechnung (UBL or CII) or a
ZUGFeRD hybrid PDF. **Only needed if §4.4 says El-Professor is not a
Kleinunternehmer.** Nothing in slices 1–7 should be shaped in a way that makes
this a re-modelling; that is why the VAT fields are columns and not PDF
instructions.

### Which slices need a decision first

| slice | blocked on |
|---|---|
| 1 | **§12 Q1 (regime), Q2 (net or gross book), Q3 (VAT rate)** — cannot seed the `vat` key without them. Q7 (delete vs cancel) shapes the counter's self-check. |
| 2 | Q4 (what the car limit means) |
| 3 | Q5 (access on invoice or on payment) |
| 4 | the owner's yes for a host cron line, twice (staging, then production) |
| **5a** | **Q11 only** (the four expiry mails' German). Nothing else — it depends on no other slice and on no other decision. See §14, and §14.11 for why it goes ahead of slice 5. |
| 5 | Q6 (dunning wording — German, fixed in code, so it is his words) |
| 6 | which bank, and whether it exports CAMT.053 |
| 8 | Q1 |

---

## 11. What I would not build, and why

- **A payment provider integration.** §3.2. It automates the cheapest step,
  installs a second system of record for the same money, conflicts with the
  owner's "the invoice is accounting only", and leaves the §14 work still to do.
  Revisit at ~50 customers or the first card request.
- **SEPA Direct Debit now.** §3.1(b). Right end-state, wrong first step: B2B
  needs every customer to confirm a mandate at their own bank, CORE gives an
  eight-week clawback, and both need a bank relationship and an R-transaction
  handler that does not exist.
- **Real annual invoicing.** §2.3. One invoice for twelve months means a credit
  note when a fleet shrinks, and this product has no credit-note document.
  Monthly invoices at the yearly discount is strictly simpler and already built;
  what is missing is honest labelling.
- **Proration.** Follows from the above and from the car limit being an
  operator-typed allowance (§2.4). A mid-period change takes effect next month.
  Say it in the terms.
- **The §33 UStDV Kleinbetragsrechnung simplification.** §4.5. Two document
  shapes whose validity depends on the amount.
- **Reverse charge and the Zusammenfassende Meldung.** §4.6. 18/18 customers are
  German. A **refusal guard** is in scope; the mechanism is not.
- **Automatic suspension on non-payment.** §7.2 rule 2. Expiry already denies
  access; suspension adds a second lock whose reason nobody records, and
  forgetting to undo it is exactly what produced §1.2.
- **A `revenue` report summing `subscription_coverage.price_cents`.** §6.4. The
  column is populated for invoices only — zero of 15 production rows carry one —
  so such a report would print a confident and wrong number. Revenue comes from
  paid invoices.
- **Reading the VAT rate at print time.** §6.3. It would reword every past
  invoice on the day the rate or the regime changes, which §14b Abs. 3's
  integrity requirement forbids and which is the same mistake
  `salary_cash_receipts.business_month` already exists to prevent.
- **Dunning switches in `NotificationsPage`.** §7.3. A customer must not be able
  to turn off its own Mahnung.
- **Collections, Verzugszinsen, Mahnbescheid.** §7.2 rule 3. A business process,
  not a feature. The product's job ends at telling the operator on day 30.
- **A credit-note document, in slice 1.** Needed eventually — a cancelled invoice
  that was already sent should be answered by a Storno document, not only by a
  status change — but it is its own slice with its own numbering question
  (same series or a second range?), and nothing on production has been paid, so
  nothing yet needs cancelling after payment.

---

## 12. What needs the owner's decision

Each is a decision only he can take, and each blocks a named slice.

**Q1 — Kleinunternehmer or not? (§4.4) — the most important question here.**
Is El-Professor's Gesamtumsatz under §19 below €25,000 for the previous calendar
year and below €100,000 for the current one? The answer decides whether invoices
carry 19 % VAT at all, which content list applies (§14 Abs. 4 or §34a UStDV), and
whether the 1.1.2028 e-invoice obligation ever bites. **Put it to the tax adviser
together with the follow-up: from which moment does the exemption stop if the
€100,000 is crossed mid-year?** The statute does not say, and getting it wrong
means VAT owed out of money already collected.
*Blocks slice 1 and slice 8.*

**Q2 — are the price book's figures net or gross? (§6.2)**
200 € gross is 168,07 € net; 200 € net is 238,00 € gross. The recommendation is
**net**, with the book's four figures rewritten once in the migration if he meant
gross.
*Blocks slice 1.*

**Q3 — the VAT rate to seed** (19 % under §12 Abs. 1 if Q1 says standard).
*Blocks slice 1.*

**Q4 — what does `subscription_car_limit` mean? (§2.4)**
A billing allowance the operator types, or the fleet's actual size? If the former,
nothing enforces it today and the sales conversation has to be about it. If the
latter, car creation must refuse past the limit and the price moves when a car is
sold.
*Blocks slice 2.*

**Q5 — does a new customer get access on the invoice, or on the payment? (§2.2)**
Today's grace rule means an unpaid invoice grants access until two business days
after its due date — so a signup is onboarded on credit. That is friendly and it
is how the existing code already behaves; the alternative is access on the first
payment, which is safer and slower.
*Blocks slice 3.*

**Q6 — the German wording of the three dunning mails.** Fixed in code like every
other notification, so they must be his sentences.
*Blocks slice 5.*

**Q7 — keep `platform_invoice_delete`, or retire it for cancel? (§5.4)**
Recommendation: keep it, and stop reusing the number. Depends on the adviser's
answer on gaps.
*Shapes slice 1.*

**Q8 — install the two sweeps?** A host cron change, staging first, then
production, with his explicit yes each time. The measured blast radius is one
company moving from `active` with a past expiry to `expired` with the same past
expiry, and **no access change** (§8.2).

**Q9 — the two companies still locked out** (AT Autovermietung GmbH, AK 95 GmbH#).
Both are suspended *and* expired, so lifting the subscription alone will not
readmit them. Whether to readmit, invoice retrospectively, or close the accounts
is his call — and it is the same question he answered for Smooth Fahrt by hand at
19:04 today.

**Q10 — monthly or yearly, honestly labelled? (§2.3)** Rename the choice to
"Jahrespreis, monatlich berechnet", or commission real annual billing with credit
notes.

**Q11 — the German wording of the four expiry mails. (§14.11)**
Two to the customer, two to the operator, fixed in
`supabase/functions/_shared/notification-mail.ts` like every other notification,
so they must be his sentences. §14.2 bounds what the customer's two may say: they
may name the date and the activation-code path, and must not say *verlängern* or
*bezahlen*, because there is no payment path to send anyone to.
*Blocks slice 5a — and it is the only thing that blocks it.*

### Engineering choices already made, for the record

These are mine, taken on the repository's own precedents; he can overrule any of
them but none needs his input to proceed.

1. **VAT is stored on the invoice, not read at print time** — `business_month`'s
   rule from `20260919160000`.
2. **The rate is integer basis points**, not a numeric percent.
3. **One arithmetic function with a TypeScript twin and a parity test** over an
   alien rate — `compute_plan_price` / `calcPricing`'s rule.
4. **The invoice counter lives in `app_private`, keyed on `(doc_type, year)` with
   no company column**, because the issuer is El-Professor, not the customer
   (§5.3).
5. **Invoice creation becomes an RPC**, so the number is drawn inside the
   transaction that uses it — the fix for the race and for the decorative
   settings key.
6. **`tax_regime = 'legacy'`** for the two invoices already issued, so nothing has
   to invent a net amount for a document already sent.
7. **A refusal guard for non-German companies**, instead of either building
   reverse charge or staying silent (§4.6).
8. **`companies.suspension_reason`**, so reactivation can be one act (§2.6).
9. **Dunning types are unconditional**, with no `notification_settings` row
   (§7.3).
10. **Bank statement import before SEPA or a provider** as the next step after
    the invoice is correct (§3.2).
11. **The expiry reminder's two customer types are unconditional too**, extending
    choice 9 beyond dunning, for the reason in §14.6(a) — a redirect is still
    allowed, a switch is not.
12. **The operator's alert does not live in `notification_deliveries`**, because
    that table's claim refuses a suspended company and so would refuse exactly
    the two measured cases (§14.6b).
13. **The expiry window is 7 days, read off `CompanyBillingPage`'s own amber
    threshold** rather than chosen, and held to it by a parity test (§14.3).

---

## 13. Sources

**Statutes, read on `gesetze-im-internet.de` (primary) and `buzer.de` (mirror,
used where the quoting limit on the primary blocked the full list):**

- §12 UStG — https://www.gesetze-im-internet.de/ustg_1980/__12.html
- §14 UStG — https://www.gesetze-im-internet.de/ustg_1980/__14.html and
  https://www.buzer.de/14_UStG.htm
- §14a UStG — https://www.gesetze-im-internet.de/ustg_1980/__14a.html
- §14b UStG — https://www.gesetze-im-internet.de/ustg_1980/__14b.html
- §15 UStG — https://www.gesetze-im-internet.de/ustg_1980/__15.html
- §19 UStG — https://www.gesetze-im-internet.de/ustg_1980/__19.html
- §26a UStG — https://www.gesetze-im-internet.de/ustg_1980/__26a.html
- §27 UStG (Abs. 38, the e-invoice transition) —
  https://www.gesetze-im-internet.de/ustg_1980/__27.html
- §33 UStDV — https://www.gesetze-im-internet.de/ustdv_1980/__33.html
- §34a UStDV — https://www.gesetze-im-internet.de/ustdv_1980/__34a.html
- §147 AO — https://www.gesetze-im-internet.de/ao_1977/__147.html

**Administrative guidance — secondary, flagged `[Steuerberater]`:**

- Abschnitt 14.5 Abs. 10/11 UStAE on the Rechnungsnummer, quoted via
  https://www.steuerschroeder.de/steuergesetze/ustae/14.5 and
  https://www.ihk-nuernberg.de/fileadmin/IHK_Nuernberg/Recht_Steuern/Steuerrecht/Umsatzsteuer_Pflichtangaben_auf_Rechnungen_145-25.pdf
  The BMF original could not be reached from this environment.

**Payments:**

- Deutsche Bundesbank, Gläubiger-Identifikationsnummer —
  https://www.bundesbank.de/de/aufgaben/unbarer-zahlungsverkehr/serviceangebot/sepa/glaeubiger-identifikationsnummer
  and
  https://www.bundesbank.de/de/aufgaben/unbarer-zahlungsverkehr/serviceangebot/sepa/glaeubiger-identifikationsnummer/antragstellung-und-ausgabe-602954
- European Payments Council, SDD B2B Rulebook —
  https://www.europeanpaymentscouncil.eu/sites/default/files/kb/file/2024-11/EPC222-07%202025%20SDD%20B2B%20Rulebook%20version%201.0.pdf
  and the Core Rulebook —
  https://www.europeanpaymentscouncil.eu/sites/default/files/kb/file/2026-09/EPC016-06%202025%20SDD%20Core%20Rulebook%20version%201.2.pdf
- Stripe fees: **not verified.** `stripe.com` could not be fetched from this
  environment. The €0.35-per-SEPA-debit and €20-per-return figures in §3.1 are
  third-party and must be checked against Stripe's own German pricing page before
  any decision rests on them.

**Production, read-only, 25.10.2026 18:50–19:16 CEST**, via
`ssh elprofessor` → `docker exec ya-mobility-db-1 psql -U postgres`. Every query
in §1 and §8.2 is `SELECT` only; the one write visible in the data
(Smooth Fahrt's 19:04:26 coverage row) was somebody else's and is reported, not
made.

---

## 14. The subscription-expiry reminder

**Added 25.10.2026**, after §1–§13 were approved. It is numbered 14 rather than
inserted beside §7, which is where it belongs conceptually, because §10 and §12
cross-reference every section by number and renumbering would invalidate them.
Read it as §7's sibling: §7 duns an **invoice**, this duns a **coverage
period**, and §14.9 is the measurement that proves those are not the same thing.

Every claim below carries its file and line or its production query. Read-only
SQL was run against production (`ya-mobility-db-1`) on 25.10.2026.

### 14.1 There is no expiry reminder of any kind, and the partial one was deleted

```ts
// supabase/functions/_shared/notification-core.ts:40
export type NotificationType = 'tuev_bald_ablaufend' | 'tuev_abgelaufen';
```

Two types, both about a vehicle's TÜV. The two trial types went with the trial:
`20261015170000_remove_free_trial.sql:196-217` deletes their
`notification_deliveries`, `notification_recipients` and `notification_settings`
rows, narrows both CHECK constraints and patches `notification_delivery_claim`'s
`IN` list. Production's live constraint confirms it —
`CHECK (notification_type = ANY (ARRAY['tuev_bald_ablaufend','tuev_abgelaufen']))`
— so the two dead values are genuinely gone from the database, not merely from
the TypeScript. **They are not to be resurrected**; there is no trial.

What the gap costs, measured. Six of eighteen companies carry a
`subscription_expires_at` at all; twelve are open-ended and have no occurrence to
notify about:

| company | status | subscription_status | expires | invoices | active admins |
|---|---|---|---|---|---|
| AT Autovermietung GmbH | suspended | expired | 2026-07-22 | **0** | 1 |
| AK 95 GmbH# | suspended | expired | 2026-08-19 | **0** | 1 |
| tester | suspended | active | 2026-10-13 | **0** | 1 |
| Y&A Mobility | active | active | 2027-08-22 | 0 | 1 |
| Dinari Transport | active | active | 2027-09-17 | 0 | 1 |
| Smooth Fahrt GmbH | active | active | 2027-10-25 | 0 | 1 |

Three expiries are in the past. Nobody was told about any of them. And
`notification_deliveries` holds **one row in its entire history** — a TÜV
warning claimed 05.10.2026 for `period_key` 2026-11-01, settled, `mail_sent`
true, one recipient. So the machinery works, is installed, has run, and has
simply never had an expiry type to carry.

### 14.2 Both audiences, and the different job each one does

**The owner's decision, 25.10.2026: both.** The premise he stated himself is
that renewal is a manual act by the operator from the panel, and that premise is
what makes the two notifications different rather than redundant:

- **The customer** is told so the lapse is not a surprise. It **cannot** be told
  to fix it, because there is nothing to fix it with — see below.
- **The operator** is told so no company sits unreachable. This is the control
  that was missing, and §14.10 shows it is the half that would have caught both
  measured cases.

**I agree, and the asymmetry matters more than the agreement.** The operator's
alert is the load-bearing half: it is the only one of the two that fires for a
company the product has administratively blocked, and both real cases are
exactly that. A design that shipped only the customer's mail would read as
solving this and would have caught neither.

**What the customer may truthfully be told — measured, because the mail must not
instruct them to do something that does not exist.** `/abo-aktivieren` is
`ActivationPage`, and its one write is `redeem_activation_code`
(`src/pages/ActivationPage.tsx:136`). Its own German says what it is:
`'activation.subtitle'` — *"Geben Sie Ihren Aktivierungscode ein, um Ihr
Abonnement freizuschalten."* (`src/i18n/de.ts:902`) — and
`'activation.codeFromAdmin'` — *"Den Code erhalten Sie von Ihrem
Administrator"* (`:906`). `CompanyBillingPage` offers no payment path either;
its only two occurrences of *Zahlung* are the invoice table's heading
(`src/pages/CompanyBillingPage.tsx:135,143`). So:

- the mail **may** name the date access ends, name the activation-code path and
  name a contact;
- the mail **may not** say *verlängern*, *bezahlen* or *jetzt erneuern*, and may
  not link to a renewal page, because there is none. An activation code is a
  real path; a payment page is not.

### 14.3 The window is 7 days, and it is the product's own number

The TÜV window is 60 because `getTuevStatus()` already turns the badge amber at
60 (`src/types/car.ts:43`), and the rule stated at
`notification-core.ts:22-29` is that **the mail and the screen must not disagree
about the same subject on the same day.** The same derivation exists here and was
found rather than invented:

```tsx
// src/pages/CompanyBillingPage.tsx:378  (and again at :419)
<Badge tone={daysRemaining <= 7 ? 'caution' : 'positive'}>
```

The Abo-Status screen already turns the Restlaufzeit amber at **7 days**, in two
places. So `ABO_SOON_DAYS = 7`, derived from that threshold, with the same parity
discipline the two lists held in two places already follow
(`src/utils/planFeatures.test.ts`, `src/utils/rolePageKeys.test.ts`): a test
reads the threshold out of `CompanyBillingPage`'s source and fails the build when
the two part. Corroboration, not derivation: the deleted `TRIAL_SOON_DAYS` was
also 7, from `TrialBanner`'s `days <= 7`.

It is **passed into** the candidate query as an argument, never written in SQL —
`20260924100000`'s decision 2, so there is one copy of the number.

**Seven days is a short lead for a manual renewal, and the answer to that is not
a wider window.** An invoice has to be raised, sent, paid by transfer and
recorded by hand. If that does not fit, the fix is to raise the invoice earlier
on the billing day (§10 slice 3) — because a mail that fires before the screen's
own badge turns amber is precisely the disagreement the TÜV derivation exists to
prevent. If the owner wants a longer lead anyway, the threshold and the constant
move **together, in one commit**, so they stay one number.

### 14.4 `period_key` is the Berlin calendar day of `companies.subscription_expires_at`

Not the day of the run, and not the invoice's due date. Walk the cases, as
`20260924100000`'s decision 1 does for the TÜV:

- A company never renewed keeps the same `subscription_expires_at`, so its
  occurrence is one and it is mailed **once** — not nightly for three months,
  which is the failure worse than no feature.
- A company renewed gets a new expiry from
  `app_private.recompute_company_subscription`, the only writer of that column
  (`20260919150000:356-432`). That is a new occurrence, so it is warned again
  seven days before the new date and told again if that one lapses.
- The "soon" and the "lapsed" types are **separate occurrences of the same
  date**, exactly as the two TÜV types are, so a company warned at seven days is
  still told on the day access ends.
- `subscription_expires_at IS NULL` is open-ended access: **no occurrence,
  nothing mailed.** Twelve of eighteen production companies, and it is why rule 1
  of the recompute matters here.

The column is `timestamptz` and `period_key` is CHECK'd to `^\d{4}-\d{2}-\d{2}$`
(`20260924100000:170-171`), so it is the Berlin day of that instant —
`toBerlinDay()` (`notification-core.ts:96-103`) already does exactly that
reduction and already refuses a value that does not parse.

### 14.5 Four type values, and that is forced rather than chosen

Two occurrences × two audiences. The open question was whether the audience lives
in `notification_type` or in `target_id`, and the existing claim function answers
it mechanically:

```sql
-- 20260924100000_notification_delivery.sql:438-443
IF p_target_id <> p_company_id
   AND NOT EXISTS (SELECT 1 FROM public.cars v
                    WHERE v.id = p_target_id AND v.company_id = p_company_id) THEN
  RETURN NULL;
```

`target_id` must be the company or one of its cars; anything else is refused with
a silent NULL. And `period_key` is CHECK'd to a date. **So the audience cannot go
in either field, and it must go in `notification_type`** — four values, one per
audience per occurrence. Were the audience not in the type, the first row claimed
for an occurrence would make the other audience's claim return NULL, and one
audience would silently suppress the other.

Names: **`abo_bald_ablaufend`** and **`abo_abgelaufen`** for the customer, using
the product's own `Abo` vocabulary, and **`platform_abo_bald_ablaufend`** and
**`platform_abo_abgelaufen`** for the operator — in a store of their own, for the
reason in §14.6.

### 14.6 Where each audience's dedupe lives

**(a) Neither new customer type is a `notification_settings` row, and this is the
one place §7.3's rule is extended rather than applied.**

§7.3 records it for dunning: *"a customer must not be able to switch its own
dunning off."* `notification_settings` is written by the company's own
administrators under `is_company_admin()`, and the master switch is real, not
theoretical — production holds four rows across two companies, and **one of those
companies has `email_global_enabled = false`**, which `notificationEnabled()`
(`notification-core.ts:189`) honours by returning false for every type.

An expiry reminder is dunning's sibling, not the TÜV's. The TÜV warning is about
the customer's own asset and its consequence falls on the customer, so a switch
is right. The expiry notice is about the commercial relationship, its consequence
falls on **both** parties, and it lands on the operator's desk as a support call.
So both customer types are unconditional, `NotificationsPage` is untouched, and
there is no new row, no new label and no new dictionary key.

**A redirect is still allowed, because a redirect is not a switch.** Both types
go through `chooseCompanyRecipients` (`notification-recipients.ts:109-129`): the
addresses listed for that kind, else the company's single `notification_email`,
else the administrators. Both are added to
`notification_recipients_type_check` and to `RECIPIENT_KINDS`
(`notification-recipients.ts:61-65`), so a company can send its billing mail to
the Buchhaltung while the TÜV goes to the Fuhrparkleiter. The cost — a listed
address that is wrong receives nothing — is already accepted product-wide and
stated at `notification-recipients.ts:11-15`.

**(b) The operator's alert is not in `notification_deliveries` either, and the
reason is the boundary, not taste.**

Both existing entry points apply the same hard boundary —
`notification_candidates` at `20260924100000:323-326` and
`notification_delivery_claim` at `:431-436`:

```sql
WHERE c.approval_status = 'approved'
  AND c.status IN ('active', 'trial')
```

**AT Autovermietung and AK 95 are `suspended`. So the claim returns NULL for
exactly the two companies this section exists for.** Decision 3's reasoning for
that boundary is sound and is about mail *to the customer* — *"Suspension in
particular is an administrative block, and mailing through it would undo it"* —
it is simply not the operator's boundary. Putting two boundaries in one claim
function means a per-type branch in a function whose boundary is currently one
uniform rule, pinned by a self-check.

Two further reasons, each independent of the first:

- `notification_deliveries`' SELECT policy is the ordinary tenant shape, so a
  company would read the rows recording that El-Professor had been warned about
  it — and an **expired** company could not, because `get_active_company_id()`
  answers NULL, which is the absurd half: the rows it could never see are exactly
  the ones about it.
- `company_id` is `REFERENCES companies(id) ON DELETE CASCADE` (`:154`). A hard
  delete would take the record of three months of operator warnings with it.
  `target_id` deliberately carries no foreign key for precisely this reason
  (`:156-158`, *"a car deleted after its warning must not take the record of that
  warning with it"*); this is the same argument one level up.

**Engineering choice made:** `app_private.platform_alert_deliveries
(id, alert_type, subject_type, subject_id, period_key, claimed_at, settled_at,
mail_sent, recipient_count)` with `UNIQUE (alert_type, subject_type, subject_id,
period_key)`, no foreign key on `subject_id`, the four `app_private` rules of
CLAUDE.md's *`app_private`* section (REVOKE from `PUBLIC, anon, authenticated`;
its own REVOKE; `LANGUAGE plpgsql` with a pinned `search_path`; outcomes as
return values), and a claim/settle pair granted to `service_role` alone.
`subject_type` is there so a later operator alert about something that is not a
company needs no second table.

**This is "do not build a parallel system" applied, not broken.** The decision
logic stays one pure module, the claim-before-send order is the same, the edge
function is the same and the cron tick is the same. What is not reused is the
*tenant* delivery table and the *tenant* boundary, because an operator alert is
not a tenant notification.

**The one-table alternative, with its cost, so the trade is visible rather than
asserted:** keep all four types in `notification_deliveries` and give
`notification_delivery_claim` a per-type boundary — roughly six lines, with both
arms pinned by the self-check. It buys one table, one settle and one report. It
costs the cascade, the tenant SELECT, and a hole in a uniform boundary. Taken the
other way for the three reasons above; if a later reader reverses it, **the
cascade is the one that must be answered first.**

### 14.7 Where the operator's recipients come from

Platform staff sit in **no company**, so `selectActivationCodeRecipients`'
company branch cannot serve them. Measured: `app_private.platform_staff` holds
two rows on production — `super@professor.com` (`owner`, active) and
`admin@yamobility.de` (`owner`, disabled).

The precedent for reading a staff address already exists and is pinned.
`platform_staff_list` (`20260920140000:148-153`) joins `auth.users` and reads
**only** `id` and `email`, and its self-check *"fails a release that reads another
column"* (`:84-85`). But that read model is `authenticated`-only, asks
`staff.manage` and needs an `auth.uid()`; the job is a cron line holding the
service key and has none. So it needs a sibling:
`public.platform_alert_recipients()`, `service_role` only, SECURITY DEFINER, the
same two-column discipline and the same self-check copied.

**Which roles — derived, not invented.** The active staff rows that hold
**`billing.manage`**, which is `owner` and `billing`
(`20260916110000:166-167`), and which `20260923110000:310-311` asserts `support`
and `read_only` do **not** hold. That is already the capability that reads an
invoice and a subscription (`20260924110000`, decision D14), so the alert goes to
the set that may already read the money, and inventing a `billing.notify` would
decide open questions D2 and D3 by accident. The function reads the pairs out of
`app_private.platform_capability_matrix()` rather than writing the two role names
down again, so changing who may do what stays one migration replacing one
function.

A disabled row receives nothing. **A company whose only owner's account is
unconfirmed, banned or deleted receives nothing and the claim is settled with
`mail_sent = false`**, as `deliverOne` already does
(`notification-delivery.ts:205-210`), so the job does not come back to it
nightly. Measured for the three companies in §14.1: each has exactly one active
admin, and all three accounts are confirmed, unbanned and undeleted — so the
customer's half would have had a recipient in every case.

### 14.8 One mail per company, not a digest — and the point at which that changes

**Recommendation: per company, one mail per occurrence, on the claim machinery.**
It is the only shape that keeps *one mail per fact*, and it needs no new dedupe
rule. A digest's natural key is the **day of the run**, which is exactly what
decision 1 forbids, and for a good reason: a digest keyed on the day either
repeats last night's companies or needs a second rule to decide what is new.

The measured volume says this is not a close call. Three companies with a future
expiry, three with a past one, and one row in `notification_deliveries` in the
product's history. At six customers a mail each is nothing.

**When it should change, and how.** When one run would send the operator more
than roughly ten alerts — or when the customer count passes roughly fifty, the
same threshold §3.2 uses for SEPA — add the digest as a **rendering of the run,
never as a new dedupe key.** The per-company rows still claim and settle exactly
as now; the digest is built from the rows *this run* claimed and sent, in place
of N mails. The dedupe rule never becomes the day of the run, and the change is
purely additive. The realistic cause is monthly billing with every contract on
`billing_day` 1, which bunches every expiry on one date — so this is worth
re-measuring when slice 2 fills in the seventeen missing contracts.

### 14.9 How this relates to dunning — two mechanisms, settled by measurement

**The measurement that settles it: AT Autovermietung has 0 invoices. AK 95 has
0 invoices.** Production holds two invoices in total and both belong to MoveNow
(§1.1). §7.2's schedule counts every stage from an invoice's `due_date` — so
**there is no invoice to count from for either company this section exists for**,
and dunning alone would have left both cases exactly as they were. That is the
whole argument for two mechanisms rather than one.

They cannot collide in the unique constraint, because they key on different
facts:

| | dunning (§7.3) | expiry reminder (§14.4) |
|---|---|---|
| the fact | an invoice was not paid | a coverage period ends |
| `target_id` | the invoice id | the company id |
| `period_key` | the invoice's `due_date` | `companies.subscription_expires_at` |
| exists today without an invoice? | **no** | **yes** |

**The overlap, and the suppression rule.** Once slices 1–3 land, a company with
an invoice has both — and the two dates coincide, because the invoice's grace end
*is* its coverage end. Measured from the live catalogue:

```sql
-- app_private.invoice_grace_end, read from production's pg_proc
RETURN app_private.add_business_days(p_due_date,
         app_private.subscription_grace_business_days())::timestamp
         AT TIME ZONE 'Europe/Berlin';
```

So the customer would get a Mahnung naming `grace_end` and an expiry reminder
naming the same day.

- **Dunning wins, for the customer.** When the coverage row that decides access
  has `source = 'invoice'`, the customer's two expiry types stand down: the
  Mahnung already names the date, the amount and what to do, and two mails about
  one date read as a system that does not know what it has sent. The term lives
  in the pure module beside the status term, not in a SQL join — the place
  decision 3 already put the subscription question.
- **The operator's alert does not stand down.** Its job is *"no company sits
  unreachable"*, and a dunned company that never pays is precisely such a
  company. It is one mail per occurrence either way, so it is not noise.

**And the build order follows from this, not from preference.** This section needs
no invoice, no VAT, no numbering, no contract and no settings key. Dunning needs
all of them. So this is the cheaper half and it goes first.

### 14.10 What the mechanism would have done, in the two measured cases

The cheapest test of whether this design solves the problem it was written for.
Every date below is arithmetic over the measured expiry and the installed 07:10
run.

**Smooth Fahrt GmbH — expired 16.09.2026, unnoticed for five weeks.** It was
`approval_status = 'approved'` with `companies.status = 'active'` throughout
(§1.2 shows `subscription_status = 'expired'` beside an unchanged `status`), so
it is inside the customer boundary and **both** halves fire:

| date | what fires | to whom |
|---|---|---|
| 09.09.2026 | `abo_bald_ablaufend`, `period_key` 2026-09-16 | the company's admin (confirmed address, measured) |
| 09.09.2026 | `platform_abo_bald_ablaufend`, same `period_key` | the owner |
| 17.09.2026 | `abo_abgelaufen` and `platform_abo_abgelaufen`, same `period_key` | both |
| every night after | **nothing** — all four occurrences are claimed | — |
| 25.10.2026 | the hand-typed coverage row moves the expiry to 2027-10-25: a **new** occurrence, so the company is warned again on 18.10.2027 | both |

Five weeks becomes seven days of warning and one day of notice.

**AT Autovermietung GmbH — expired 22.07.2026, unnoticed for three months.**
`suspended` and `expired`, 0 invoices:

| date | what fires | to whom |
|---|---|---|
| 15.07.2026 | `platform_abo_bald_ablaufend`, `period_key` 2026-07-22 | the owner |
| 23.07.2026 | `platform_abo_abgelaufen`, same `period_key` | the owner |
| 15.07. / 23.07. | the customer's two types **only if `status` was still `active` on that day** | the company's admin, otherwise nobody |
| every night after | nothing | — |

Three months becomes one day — **and only because of §14.6(b).** Had the
operator's dedupe ridden `notification_delivery_claim`, every row above would
have returned NULL and this case would be unchanged. That is §14.6(b)'s
justification in one line.

**The customer's half of that case cannot be replayed exactly, and that is a
finding rather than a gap in the arithmetic.** It depends on when the suspension
was imposed, and `companies` records neither a reason nor a time: its only
relevant columns are `status`, `approval_status`, `rejection_reason` and
`subscription_status` (measured — there is no `suspension_reason` and no
`suspended_at`). §2.6 already names the missing reason column; **this adds that
there is no timestamp either**, so "was it suspended before or after it expired"
is unanswerable for any company today. It is a second argument for §2.6's
`suspension_reason`, and an argument for a `suspended_at` beside it.

**Two cases the brief did not name, which the same mechanism catches:**

- **AK 95 GmbH# — expired 19.08.2026**, same shape, 0 invoices: the operator is
  told on 20.08.2026 instead of two months later.
- **`tester` — `subscription_status = 'active'` with an expiry of 2026-10-13,
  twelve days in the past today.** It is §8.2's one company, and `suspended`, so
  only the operator's half fires. It is the live instance of the failure, right
  now, unresolved.

### 14.11 Where it sits in the slice plan

**Slice 5a, ahead of slice 5, and independent of slices 1–4.** It reads
`companies.subscription_expires_at`, which the recompute already maintains as its
only writer, and it needs nothing else from this document. So it is the cheapest
change here that closes the measured failure, and it is the **only slice in §10
or §14 that is not blocked on §12** — bar its wording.

**Its one decision, for §12 as Q11** (not an edit to Q6, which is dunning's): the
German wording of the four mails. Fixed in
`supabase/functions/_shared/notification-mail.ts` like every other notification —
its `switch` on `item.type` (`:73-102`) gains four cases — so they must be the
owner's sentences, and §14.2 bounds what the customer's two may say.

**Migration — one file.** Its number must be re-checked against the union of
`staging` and every open branch immediately before pushing; §10's warning has
fired three times.

- Widen `notification_deliveries_type_check` and
  `notification_recipients_type_check` by the two customer types, and patch
  `notification_delivery_claim`'s `IN` list. `20261015170000:205-217` is the
  technique, splicing the function body from the catalogue rather than restating
  it.
- `public.abo_expiry_candidates(p_soon_days integer, p_limit integer, p_after uuid)` —
  `service_role` only, SECURITY DEFINER, `SET search_path = pg_catalog, public`,
  REVOKE from `PUBLIC, anon, authenticated`. Boundary
  `approval_status = 'approved' AND status NOT IN ('archived','deleted')`,
  narrowed to `subscription_expires_at IS NOT NULL AND subscription_expires_at <
  now() + make_interval(days => p_soon_days)`, and returning the claimed rows
  from **both** stores. **`notification_candidates` is not touched** — its
  decision-3 boundary and its self-check 6 stay exactly as they are, and that is
  the main benefit of a second function over a widened one. Note in passing that
  `notification_candidates`' own narrowing is already wider than it needs to be:
  its `c.trial_end IS NOT NULL` arm (`:327`) admits **15 of 18** production
  companies every night for a column nothing reads any more. Harmless, and a
  trap — an expiry term must not be left to ride it.
- `app_private.platform_alert_deliveries` and its claim/settle pair (§14.6b).
- `public.platform_alert_recipients()` (§14.7).

**The pure module.** The arithmetic goes in `notification-core.ts` beside
`selectNotifications`, with the per-type terms where decision 3 put the
subscription question: the customer's two additionally require
`status = 'active'`, the operator's two do not, and the customer's two stand down
under §14.9's dunning rule. No Deno, `npm:` or `jsr:` import, so vitest runs it.

**Gates.**

- **Migration self-check:** the three new functions are `service_role`-only with
  a pinned `search_path` (`20260924100000:565-592`'s shape);
  `notification_candidates`' `prosrc` is **unchanged**, compared against its
  recorded text, so a release that widens it instead of adding a function fails;
  the new candidate function names neither `get_active_company_id` nor
  `platform_reads_company_data`; `platform_alert_recipients` reads no
  `auth.users` column but `id` and `email` (`20260920140000`'s self-check,
  copied); the capability it asks is `billing.manage` and is read from
  `platform_capability_matrix()`; `platform_alert_deliveries` is unreachable by
  `anon`, `authenticated` and `service_role`'s USAGE on the schema.
- **`tests/rls/abo-expiry-notifications.sql`:** the claim refuses a suspended
  company for a customer type and the operator's store admits it; the unique
  constraint refuses a second claim of one occurrence and **admits the other
  audience's**, which is §14.5's whole point; an extended expiry is a new
  occurrence; a NULL expiry yields nothing; `anon`, `authenticated` and
  `postgres` reach neither new store nor either new function; the recipient
  function answers `owner` and `billing`, not `support` or `read_only`, and skips
  a disabled row. **A mutation control on each**, per this repository's
  discipline — in particular one that removes the per-type status term and must
  be watched showing a suspended company receiving customer mail.
- **`matrix.sql`:** rpc lines for the two new `public` functions. The
  `app_private` table is outside that file's scope by construction, since it
  probes `public` and `storage` — stated here so its absence is not read as an
  omission.
- **vitest:** `notification-core` cases for all four types; the window boundary
  at exactly 7 and at 8 days; the dunning suppression; and the parity test of
  §14.3 that reads `CompanyBillingPage`'s threshold out of its source.
- **No host step, and no new cron line.** It rides the tick that already runs:
  `/etc/cron.d/el-professor-notifications`, `10 7 * * *` — **07:10**, on both
  stacks, each line guarded on its own `PROJECT_NAME` and `flock`ed. This is the
  one thing in this document that needs no new "yes" from the owner. §7.4 still
  applies: test with `@example.com` addresses only, and watch the first
  production run — on the measured data it would plan at most a handful of mails,
  and `{"mode":"dry_run"}` reads the same rows, builds the same mails and writes
  nothing (`notify-expiries/index.ts:46-52`).
- **No `SCHEMA_EPOCH` bump:** every change is additive, and the previous release
  neither reads nor writes any of it.

### 14.12 What I would not build here

- **A `notification_settings` row for either customer type.** §14.6(a). A
  reminder a customer can switch off is not a reminder, and one production
  company has already switched everything off.
- **A digest as the dedupe unit.** §14.8. Its key would be the day of the run,
  which decision 1 forbids. The digest comes later, as a rendering of a run whose
  rows are already deduped per occurrence.
- **Any mail that tells a customer to renew or to pay.** §14.2. There is no
  payment path to send them to; naming one would be a promise the product cannot
  honour.
- **Widening `notification_candidates`' boundary.** §14.11. It would mail a
  suspended company about its TÜV, which decision 3 refuses on purpose.
- **An alert about a company whose `status` is `archived` or `deleted`.** Those
  are an operator's own terminal acts, not a surprise to be reported back.
- **Automatic suspension, or automatic reactivation, on an expiry.** §7.2 rule 2
  and §2.6 already settle both; a notification must not acquire a side effect.
- **Making the wording editable from the panel.** A `mail.template.*` key means
  restating `app_private.platform_settings_problem` with every existing branch
  carried over character for character — a slice of its own, exactly as
  `20260924100000`'s *"Not in this slice"* says.

### 14.13 Three corrections to §7.1, found while measuring this

§7.1 summarises the notification machinery. Three of its claims are out of date,
and each matters to anyone building from it:

1. **The cron line is at 07:10, not 10:07.** `/etc/cron.d/el-professor-notifications`
   reads `10 7 * * *`, and cron's fields are minute then hour. (The file's own
   header comment is also stale — it says *"The production line is deliberately
   absent"* while the production line sits two lines below it, added 04.10.2026.)
2. **Recipients are a three-step precedence, not just the administrators.** Since
   `20261015140000` and `20261015100000` it is: the addresses listed for that
   kind in `notification_recipients`, else `company_settings.notification_email`,
   else the company's active non-staff `admin` profiles with a confirmed account
   (`notification-recipients.ts:109-129`). Measured on production: 4
   `notification_recipients` rows and 1 company with a `notification_email`. A
   customer-facing expiry type inherits that precedence for free, and §14.6(a)
   says it should.
3. **`notify-expiries` is three jobs behind one door, not one.** `{"job":"abrechnung"}`
   and `{"job":"uber_pull"}` ride the same function and the same tick
   (`notify-expiries/index.ts:20-35`). A fourth job is not what §14 needs — the
   expiry types are the TÜV job's own siblings and belong in its run — but anyone
   reading §7.1 should know the door is shared.
