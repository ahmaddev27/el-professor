# Testprotokoll — externes Audit, Runde 3

Jeder Exit-Code unten ist **vom Befehl selbst** gelesen, nicht von einer Pipe
und nicht von einer Hintergrundmeldung. Das ist kein Formalismus: der erste
Lauf der vollen Suite wurde von der Hintergrundmeldung als „exit code 0“
gemeldet, während vitest `VITEST_EXIT=1` schrieb und zwei Dateien rot waren.
Wo ein Lauf fehlgeschlagen ist, steht er hier **mit** seinem Fehler, und
darunter der Lauf nach der Korrektur.

Datum: 27.10.2026. Zeitzone der Testläufe: `Europe/Berlin` (von
`vitest.config.ts` festgeschrieben).

---

## 1. Die Tore

| Befehl | Ergebnis | Exit |
|---|---|---|
| `npx vitest run --maxWorkers=2 --minWorkers=1` | `Test Files 303 passed \| 2 skipped (305)` / `Tests 6674 passed \| 7 skipped (6681)`, 172,95 s | **0** |
| `node scripts/typecheck-ratchet.mjs` | `typecheck: 168 errors, at the baseline.` | **0** |
| `node scripts/style-ratchet.mjs` | `styles: 4703 inline styles and 2613 hard-coded colours in 62 files, at the baseline.` | **0** |
| RLS-Kit auf dem VPS (`scripts/rls-test.mjs` im Wegwerf-Container) | `RLS assertions passed.` | **0** |
| `npx vite-node scripts/audit-round3-deliverables.mts` | Arbeitsmappe und beide Berichte geschrieben | **0** |
| `npx vite-node scripts/audit-round3-verify.mts` | `VERIFY OK — every sheet read in full, 725 rides re-summed, all cross-sheet totals agree.` | **0** |

Kein golden master hat sich bewegt.

### Einzelne Dateien

| Datei | Tests | Exit |
|---|---|---|
| `src/utils/constraintDecisionLog.test.ts` | 80 | 0 |
| `src/utils/simulatedRides/fullMonth.test.ts` | 26 | 0 |
| `src/utils/simulatedRides/revenue.test.ts` | 24 | 0 |
| `src/utils/simulatedRides/monthWorkbook.test.ts` | 25 | 0 |
| `src/utils/simulatedRides/monthlyRate.test.ts` | 12 | 0 |
| `src/utils/simulatedRides/period.test.ts` | 18 | 0 |
| `src/utils/simulatedRides/tenantSettings.test.ts` | 19 | 0 |
| `src/utils/simulatedRides/dstProbe.test.ts` | 9 | 0 |
| `src/utils/monthlyRevenueShare.test.ts` | 12 | 0 |
| `src/utils/fahrtenbuchImportParser.test.ts` | 69 | 0 |
| `src/utils/sqlComments.test.ts` | 365 | 0 |

---

## 2. Die Läufe, die fehlgeschlagen sind — und warum sie hier stehen

### 2.1 Volle Suite, erster Lauf: `VITEST_EXIT=1`

```
Test Files  2 failed | 301 passed | 2 skipped (305)
     Tests  2 failed | 6672 passed | 7 skipped (6681)
```

`src/utils/simulatedRides/readers.test.ts` — ein Inventar aller Dateien unter
`src/`, die `fahrtenbuch_trips` nennen, mit der Entscheidung zu jeder. Die neue
`tenantSettings.ts` nennt die Tabelle in einem Kommentar und stand in keiner
Zeile:

```
+   "utils/simulatedRides/tenantSettings.ts",
❯ src/utils/simulatedRides/readers.test.ts:79:19
```

Behoben durch die Inventarzeile samt Begründung, nicht durch Umformulieren des
Kommentars: das Inventar ist bewusst textuell, und eine Datei, die das
Fahrtenbuch erwähnt, soll eine Entscheidung brauchen — auch wenn die
Entscheidung „sie berührt es nicht“ lautet.

### 2.2 RLS-Kit, erster Lauf: Migration abgelehnt

```
RLS TEST FAILED
migration failed: 20261027140000_declined_trip_status.sql
ERROR:  declined status self-check 2: columns neither protected nor known to be mutable: is_simulated
```

Der Selbsttest verlangt, dass jede Spalte von `fahrtenbuch_trips` entweder vom
Unveränderlichkeits-Trigger geschützt oder als veränderlich bekannt ist.
`is_simulated` ist keines von beidem: es ist unveränderlich durch einen
**eigenen** Trigger, `fahrtenbuch_trips_keep_simulated`, den `20260922100000`
nicht kennen konnte, weil die Spalte damals nicht existierte. Behoben durch
eine dritte Liste (`c_protected_elsewhere`) **und** einen Selbsttest 2b, der
prüft, dass dieser Trigger noch da ist — sonst wäre die Liste ein Ort, an dem
eine ungeschützte Spalte verschwinden kann.

### 2.3 RLS-Kit, zweiter Lauf: NOT NULL

```
ERROR:  null value in column "month" of relation "fahrtenbuch_imports" violates not-null constraint
```

### 2.4 RLS-Kit, dritter Lauf: die Prüfung hat die Vorrichtung gemessen

```
NOTICE:  declined 1: shape ok
NOTICE:  declined 2: the checks refuse by name
NOTICE:  declined 3: the map reads one more word and no fewer
NOTICE:  declined 4: history is untouched
ERROR:  declined 5: the company's own administrator cannot see its declined rows
```

Abschnitt 5 setzte `request.jwt.claims` als JSON. `auth.uid()` liest im
`supabase/postgres`-Image nur die **einzelne** Einstellung
`request.jwt.claim.sub`. Die Verweigerung war also die Vorrichtung und nicht
die Policy. Behoben wie im übrigen Kit, zusätzlich mit `DISCARD PLANS` vor
jedem Prinzipal und mit einer Eigentümer-Kontrolle **vor** den Proben — sonst
wäre eine Null nicht von „es gab nie Zeilen“ zu unterscheiden.

### 2.5 RLS-Kit, vierter Lauf: die Kontrolle hat ihre eigene Probe entlarvet

```
ERROR:  FAIL: move control: with WITH CHECK loosened the same move SUCCEEDS, so the probe can see a leak
```

Beide Saatzeilen lagen auf `2026-08`. Das Umhängen der Zeile von Firma A auf
Firma B verletzt damit `UNIQUE (company_id, year, month)` und scheitert mit
23505 — die Kontrolle konnte also nie gelingen, **während die Verweigerungsprobe
darüber grün blieb**, weil RLS vor dem Unique-Constraint greift. Das Paar hätte
also gesund ausgesehen, und die Probe hätte einen Constraint gemessen statt der
Policy. Behoben, indem die zweite Zeile in einem anderen Monat liegt, mit der
Begründung daneben.

### 2.6 Typprüfung: drei neue Fehler, einer davon ein echter Mangel

```
typecheck: 171 errors, baseline is 168. 3 new.
```

```
src/components/FahrtenbuchImportModal.tsx(147,7): error TS2741: Property 'declined' is missing in type … but required in type 'Record<TripStatus, …>'
src/utils/simulatedRides/fullMonth.ts(386,75): error TS6133: 'settings' is declared but its value is never read.
src/utils/simulatedRides/time.ts(4,7): error TS6133: 'HOUR_MS' is declared but its value is never read.
```

Der erste ist nicht Rauschen: die Importvorschau hätte für eine abgelehnte
Fahrt **kein Etikett** gehabt. Behoben mit dem Schlüssel `imp.status.declined`
in **beiden** Wörterbüchern, über `scripts/i18n-merge.mjs`.

---

## 3. Mutationskontrollen

Jede neue Zusicherung wurde durch absichtliches Brechen des Produktionscodes
geprüft, der Lauf abgewartet, der Fehler notiert und der Code wiederhergestellt.
Der Prüfbericht der Runde 3 hat die Runde 2 genau deshalb abgelehnt — es wurde
keine Reproduktion gezeigt.

### Abschnitt 5 — das Entscheidungsprotokoll

| Mutation | Fehler |
|---|---|
| `assumed_from_notice_date` → `confirmed`, `needsHumanReview` → false | `AssertionError: expected { certainty: 'confirmed', …(3) } to deeply equal { …(4) }` — 1 failed, 79 passed |
| `'wait'` aus `PAST_EVENT_NOTE_TYPES` entfernt | `AssertionError: expected 'none' to be 'human_review'` — 1 failed, 79 passed |
| Sperrbedingung `=== 'exclude_from_plan'` → `!== 'neutral'` | `AssertionError: blitzer / explicit single day / inside: expected true to be false` |
| `valid >= asOfDate` → `>` | `expected 'hard_block' to be 'none'` |
| negative Werkstatt-Prüfung → `hard_block` | `expected 'hard_block' to be 'human_review'` — 2 failed, 78 passed |

### Abschnitt 2 — der Monatsgenerator

| Mutation | Fehler |
|---|---|
| `zeroRideDay: rides.length === 0` → `false` | `expected 0 to be greater than 0`; `expected false to be true` — 2 failed |
| `findBlockingNote(...)` → `null` in `placeShift` | `expected { id: 'note-aa', …(10) } to be null` (Ganztags- und Zeitfenster-Notiz) |
| `result.days.map(` → `result.days.filter(d => !d.zeroRideDay).map(` | `expected [ … ] to have a length of 31 but got 22` (und 30/22, 29/21, 28/20) |

### Abschnitt 3 — Erlöse und Abstimmung

| Mutation | Fehler |
|---|---|
| 100 Cent je abgelehnter Fahrt auf `fareCents` addiert | `Received "fareCents": 100` gegen 0; `expected 3200 to be 3000`; alle vier Grundlagen-Fälle, z. B. `expected 10100 to be 10000` — 7 failed |
| `revenueBasis` nimmt `cancelledSheetFareCents` auf | `expected 2320 to be 1000` |
| `totalsByVehicle`: `groupTotals(rides.slice(1), …)` | `expected 502358 to be 503419`; `Auftraege je Fahrzeug: expected 643 to be 644` — 8 failed |

### Abschnitt 4 — der Satz

| Mutation | Fehler |
|---|---|
| `BP_PER_UNIT` 10 000 → 10 001 | `expected 314169 to be 314200` (das Beispiel des Auftrags); `expected 15 to be 16` — 4 failed |
| `MAX_BASIS_CENTS` → `Number.MAX_SAFE_INTEGER` | `expected 2971475034139052n to be 2971475034139053n` (BigInt-Gegenrechnung) — 2 failed |
| Rundung `2 * remainder >= denominator` → `>` | `expected 3703 to be 3704`; `expected +0 to be 1` |

### Die Zeitumstellung

| Mutation | Fehler |
|---|---|
| alte Regel in `operatingDayIn` zurück (vier Stunden absolut abziehen) | `expected '2026-03-28' to be '2026-03-29'` (04:30 am Umstellungstag); derselbe Fehler für `operatingDayOf`; `expected '2026-10-25' to be '2026-10-24'` |

### Die Standardwerte

| Mutation | Fehler |
|---|---|
| `declinedRidesEnabled: true` in den Standardwerten | `expected true to be false` |

---

## 4. Was nicht geprüft wurde, und warum

- **Die beiden Migrationen laufen nirgends außer im Kit.** Sie sind nicht auf
  staging und nicht auf Produktion angewandt. Ein Release ist die Entscheidung
  des Eigentümers; dieser Zweig stellt sie nur bereit.
- **`tests/rls/monthly-revenue-share.sql` und `tests/rls/declined-trip-status.sql`
  sind gegen das Kit gelaufen, nicht gegen eine laufende Umgebung.** Das Kit baut
  eine Wegwerf-Datenbank aus dem Schema-Abbild der Produktion; es ist das einzige
  Tor, das dieses SQL überhaupt parst.
- **`matrix.sql` meldet `company_monthly_revenue_share` als `UNCOVERED`.** Das ist
  eine Warnung und kein Fehlschlag, damit parallele Zweige sich nicht gegenseitig
  brechen. Die Zeilen fehlen noch.
- **Kein Bildschirm liest die neue Tabelle.** Das Datenmodell, die
  Berechtigungen und die gemeinsame Rechenvorschrift sind da; ein
  Eingabeformular für den Satz ist es nicht.
- **Keine unabhängige Routenberechnung, keine Geokodierung.** Unverändert
  gegenüber Runde 2: das Blatt enthält keine Koordinaten der beiden Adressen,
  und die einzige Positionsspalte nennt den Ort des Fahrzeugs **bei
  Auftragsübermittlung**, nicht bei Fahrtende. Der Startpunkt einer Umsetzfahrt
  ist in der Quelle nie erfasst.
- **Keine Fahrerereignis-Protokolle eines echten Mandanten.** Das
  Entscheidungsprotokoll ist gegen erfundene Notizen und gegen die eigene
  Planerfunktion geprüft, nicht gegen die Akten eines Unternehmens.
- **Die Arbeitsmappe liegt nicht in git**, siehe `README.md` in diesem Ordner.
