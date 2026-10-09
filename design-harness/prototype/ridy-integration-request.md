# Reidey ↔ El-Professor — what we need from you

**To:** the Reidey team
**From:** El-Professor
**Date:** 05.10.2026 (revised — the direction changed since the first draft)
**Status:** design request. Nothing has been built on your side and nothing will be without you.

---

## 1. The shape, in one paragraph

A fleet that uses both products connects them **once, from El-Professor**: the operator clicks
**Connect Reidey**, pastes a token your dashboard issued them, and from then on El-Professor
**pulls** — the driver roster first, earnings after. The one thing that cannot be pulled is a
receipt: the driver photographs it inside your app, so we never learn it happened. That one
travels the other way.

> **Pull for everything. Push for receipts only.**

An earlier draft of this document had you pushing everything to us. That was our mistake and it
is withdrawn — pulling puts the trigger with the fleet that owns the data, and it means almost
nothing new on your side.

---

## 2. What we already read, so you do not have to re-explain it

Read-only, from the repository. No file changed, no container touched.

| | |
|---|---|
| Reidey is | a **read-only observer** of Uber's dispatch stream — "observe, don't control" |
| Stack | Laravel 13 / PHP 8.4 · MySQL 8 · Next.js 16 · Expo driver app · Node daemon · Chrome MV3 |
| Driver app | expo-router, Manrope + Tajawal, lucide, 4 tabs: `index · statistics · offers · profile` |
| Driver writes today | profile, FCM token, "offers seen", account-deletion request — nothing else |
| Driver uploads | **none** — no table, no endpoint, no image or document picker dependency |
| Auth | Sanctum SPA cookie (dashboard) · Sanctum bearer (driver) · `X-Dispatch-Secret` (daemon) |
| Abilities | `fleet-session:write`, `fleet:read` — confined by `EnsureDashboardToken`, HTTP-method aware |
| Identity | `tenants.id` / `payment_reference` (unique) / `uber_org_uuid` (indexed, not unique); `drivers.id` / `tenant_id` / `uber_driver_uuid` / `external_ids` json |
| i18n | de/en/ar, German default, Latin digits always, **RTL handled manually via `isRTL()`** |
| Money | `Intl.NumberFormat("de-DE", {style:"currency"})` in all three languages → `14,90 €` |
| Time | Europe/Berlin, week starts Monday, **fleet-day starts 04:00** |

**If any of this is wrong, tell us — it is the basis of everything below.**

---

## 3. What we need — A: on your dashboard

This is the whole of Connect, and it is the smallest part.

1. **A screen where a fleet operator issues an integration token.**
   You already mint `('driver-app-owner', ['fleet:read'])` for your own owner app and confine it
   in `EnsureDashboardToken::CONFINED_ABILITIES`. We are asking for the same thing under a second
   name — an ability the operator can create, see, label and revoke.
   *We note the trap so it is not missed: an ability that is **not** listed in
   `CONFINED_ABILITIES` is unconfined. The entry is required, not optional.*

2. **The token must be scoped to one tenant** and carry no write.

3. **Revocation**, visible to the operator. If they revoke, our pull stops and we say so in our
   panel rather than showing stale figures.

4. **Tell us which identifiers come with it** — at minimum `tenants.id`. `payment_reference` as
   well would be useful: it is your only unique human-readable tenant string, and our operator
   can read it back to confirm they connected the right fleet.

---

## 4. What we need — B: on the driver app

Only the receipt flow, and this is the expensive part. We flag the cost rather than bury it.

1. **A camera screen.** Photo only — no manual form. The driver photographs the Beleg, an AI
   agent reads it, the reading is shown as a preview, the driver corrects and confirms, and only
   then is it submitted. A clickable prototype of exactly this, in your own design language
   (palette and radii from `driver-app/src/lib/theme.ts`, de/en/ar with RTL), is attached as
   `driver-upload-flow.html`.

2. **`expo-image-picker` is a native module.** This is a native rebuild and a store submission,
   **not an OTA update**. And iOS is currently "Cannot Sell" in Germany pending Apple's DSA
   trader verification — so Android may have to ship first. That is your call, not ours.

3. **Two calls, not one** (so the reading can be checked before anything is stored):
   - `POST` the image to us → we return the extracted fields with a per-field confidence
   - the driver confirms → `POST` the confirmed values with an idempotency key

   **Why the AI read is on our side:** the receipt categories are stored identifiers in German
   payroll data (`Tanken`, `Autowäsche`, `Autozubehör`, `Öl wechseln`), and `Tanken` selects the
   receipts that feed a statutory ratio. The preview must show exactly what will be stored. You
   do not need an AI vendor for this. If you would rather do the read yourselves, say so and we
   will send the category contract instead.

4. **The outbound call is a queued job on its own queue** — following your existing job shape
   (`$tries`, `$backoff`, `$timeout` under the worker timeout, scalar ids in the constructor,
   re-fetch with `withoutGlobalScopes()`). **Never inline and nowhere near the offer path.** We
   read the 5-second accept window as sacred and are not asking you to touch it.

5. **Telling the driver the outcome.** `Driver` already uses `Notifiable` and the notifications
   table is polymorphic, so `$driver->notify(...)` works at the DB layer — but there is no
   driver-facing notifications endpoint today, so a route and a push category would be new.

6. **Strings in all three languages**, RTL handled manually via `isRTL()`.

---

## 5. What we need — C: the read API

What we would pull, in the order we need it.

| # | What | Why |
|---|---|---|
| 1 | **The driver roster for a tenant** — id, name, e-mail, phone, status, `uber_driver_uuid` | The first pull. Each driver becomes a *proposed* link that a person at the fleet confirms against their El-Professor driver. `fleet/drivers` may already be most of this. |
| 2 | **Driver earnings per period** — whatever `driver_metrics` holds, for an arbitrary date range | Today the operator types the weekly figures into El-Professor by hand. This replaces that. **The range matters:** we read that the earnings replay is pinned to the current fleet week and that `fleet_metrics` overwrites rather than keeping history — so an arbitrary, past range is the ask. |
| 3 | **Offers/trips for a range**, if you are willing | Not urgent, and we would not use it for statutory documents — see §7. |

Tell us what already exists, what is a small change, and what is not worth it.

---

## 6. Answers we need — nothing to build

1. **Is `drivers.id` stable forever?** If a driver is re-onboarded or moves fleet, does it
   change? If so, what should we key on?
2. **Can one Uber account / one person hold two tenants in Reidey?** It happens on our side —
   one address owns two companies — so we ask rather than assume.
3. **Rate limits** we must respect on the read API.
4. **Is there a staging Reidey** we can integrate against first, or production only?
5. **Are driver names in Reidey the same strings the fleet typed into El-Professor?** The roster
   match is by name, so we need to know how close they are. (Driver e-mail is not the key: 38 %
   of our drivers have one, and our largest fleet by headcount has none at all.)

---

## 7. Decisions that are yours, not ours

1. **Data protection.** Pulling a driver roster and a driver's earnings into a separate product
   is new personal-data processing. Your own rule is "detect, don't surveil". This needs a legal
   basis and an Art. 28 processor arrangement before any real driver data moves. We are not
   asking you to skip it.
2. **Erasure.** Anything we hold must plug into your `DriverEraser` and retention command, or
   your "deleted within 30 days" promise stops being true.
3. **Android first**, while iOS waits on the DSA verification.
4. **The Uber data.** We read that offers carry the *upfront quoted fare* and not a settled one,
   that the earnings window is the current fleet week with no history, and that an offer is
   dropped when ingest fails past the accept window. We are **not** asking you to change any of
   that, and we will **not** feed it into a Stundennachweis or a Fahrtenbuch — those are
   statutory documents and they will keep coming from the imported ride log. If that ever
   changes it will be a separate conversation with its own evidence.

---

## 8. What we are building on our side

So the split is clear — none of this is asked of you. Already written and tested on a branch:

- The Belegnummer is drawn on the server under a uniqueness constraint (it was generated in the
  browser, which does not survive a second writer).
- The receipt-reading endpoint is gated: a real session, the company, the role, a rate limit,
  a locked CORS origin, a capped body, and no internal error text leaving the process.
  *It had no authorization at all. We closed that before asking you for anything.*
- A per-company credential, hashed, never stored in the clear.
- A driver-link table: proposed by the partner, **confirmed by a person at the fleet**, because
  a receipt moves money and our own code records what name-matching cost us once.

Still to come: the Connect screen, the roster pull, the review screen, the receipt intake.

---

## 9. Two things to agree on early

**Money crosses as a machine value.** Both products *display* `14,90 €` and both format `de-DE`.
What travels is `"14.90"` — a dot, two decimals, no grouping. A display is not an interface.

**The day must mean the same thing.** Your fleet-day starts at 04:00 and your week starts
Monday. In El-Professor a week belongs to the month containing its Monday. If those drift, the
two products will disagree about which day a shift belongs to, and that disagreement reaches a
payroll document.

---

## 10. What we would like next

1. Your corrections to §2.
2. Answers to §6.
3. A yes or no on §3 (the token) — that alone unblocks everything else, and it is the smallest
   piece.

§4 (the app) can wait: it is the expensive one and it is blocked on a store release anyway.
