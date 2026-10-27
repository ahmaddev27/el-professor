# Befundliste — externes Audit, Runde 3

Status in der Sprache des Abschnitts 9: **FIXED / STILL FAILING /
PARTIALLY FIXED / REGRESSION / UNVERIFIED / NOT TESTED / NEW**.

Regel des Auftrags, eingehalten: *„لا تقم بإغلاق قضية FIXED إلا بعد إظهار
اختبار إعادة الإنتاج والنتيجة بعد الإصلاح“* — kein FIXED ohne
Reproduktionstest und Ergebnis danach. Jedes FIXED unten nennt die Mutation,
die den Test rot macht; die Fehlertexte stehen in `Testprotokoll.md`.

---

## Die acht Punkte aus `FleetBook_Round3_Issues.csv`

### FB-HIGH-001 — verstümmelte Zeitstempel → **PARTIALLY FIXED** (unverändert)

Vorwärts behoben und belegt, historisch dauerhaft verstümmelt. Nichts an dieser
Bewertung hat sich in Runde 3 geändert, und der Grund ist unverändert
strukturell: Exportmodus `'original'` liest `raw_data_json` wörtlich, und diese
Spalte ist durch Trigger unveränderlich, also gibt jeder erneute Export der
betroffenen Zeilen dieselbe Zelle Byte für Byte zurück — **absichtlich**, weil
genau das die Aufgabe dieses Modus ist. Die alten Zeilen sind mit
`unreadable_order_transmission` markiert.

**Neu in dieser Runde:** `formatStamp` ist weiterhin die zweite Wand, und
`exportTimestamps.test.ts` läuft grün in der vollen Suite (6674 Tests, Exit 0).
Ein unabhängiger Beleg für eine Höherstufung bleibt, was er war: ein **echter**
Uber-Export, kein erzeugter, durch den Parser geschickt.

### FB-WARN-001 — Betriebstag, 04:00 gegen Mitternacht, Zeitzonen → **PARTIALLY FIXED, mit einem NEUEN Mangel darin behoben**

Der Prüfbericht führte den Punkt als UNVERIFIED. Bei der Messung fiel ein
**echter Fehler** auf, der vorher in keinem Bericht stand:

> Die Betriebstagsregel zog **vier Stunden absolute Zeit** ab und las den
> Kalendertag des Ergebnisses. Vier absolute Stunden sind an einem Tag mit
> Offsetwechsel keine vier Uhrzeit-Stunden. Eine Fahrt um 04:30 Ortszeit am
> 29.03.2026 wurde als `Datum der Fahrt` = **2026-03-28** geschrieben, während
> dieselbe Uhrzeit an jedem anderen Tag des Jahres derselbe Tag ist.

Gemessen in `dstProbe.test.ts`, behoben in `period.ts` (die Regel steht jetzt
auf der Uhr), `operatingDayOf` delegiert dorthin. **Keine gespeicherte Zeile
bewegt sich**: die Regel wird nur beim Schreiben eines erzeugten Blattes
gelesen, und `trip_date` des Ledgers ist die Spalte der Datei, wörtlich
übernommen.

Reproduktion: alte Regel zurücksetzen →
`expected '2026-03-28' to be '2026-03-29'`.

**Weiterhin offen, und weiterhin ehrlich so benannt:** Zeitzone und
Betriebstagsbeginn sind **für die Simulation** Einstellungen
(`SimulationTenantSettings`) und für das Produkt nicht. `Europe/Berlin` steht
als Konstante in rund dreißig Quelldateien und achtzehn Migrationen, und der
Lohncode läuft über lokale Kalendertage — Nacht-, Sonntags- und
Feiertagszuschläge hängen daran. Eine mandantenweite Zone würde Lohnarten und
die beiden Feiertagstabellen verschieben, also eine gesetzliche Urkunde.
**Das wird hier nicht entschieden.** Siehe FB-CONFIG-001.

### FB-WARN-002 — Fahrtbeginn vor der gebuchten Abholzeit → **STILL FAILING** (unverändert)

`Geplante Abholzeit` wird in **keine Spalte** geparst (nur in
`raw_data_json`), es gibt also keinen gespeicherten Wert zum Vergleichen. Ein
Warnhinweis bräuchte eine Parseränderung, einen **zehnten** Wert in
`review_reasons` und eine Migration, die `fahrtenbuch_trips_review_check`
erweitert — dieselbe Entscheidung, die für den neunten Wert dem Eigentümer
überlassen wurde. Unverändert seine Entscheidung, nicht meine.

### FB-WARN-003 — kurze Umsetzintervalle → **UNVERIFIED** (unverändert, und unverändert unentscheidbar)

Die Tatsachen stehen (117, 91 und 77 Sekunden, dasselbe Fahrzeug, derselbe
Fahrer). Geografisch unentscheidbar, und nicht bloß wegen eines fehlenden
Routers: **das Blatt enthält keine Koordinaten der beiden Adressen**, und die
einzige Positionsspalte nennt den Ort des Fahrzeugs **bei
Auftragsübermittlung**, nicht bei Fahrtende. Der Startpunkt der Umsetzfahrt ist
in der Quelle nie erfasst. Dafür müsste der Export des Anbieters sich ändern.

### FB-UNVERIFIED-001 — NULL-fähige Fahrer-/Fahrzeug-IDs, namensabhängiger Quellschlüssel → **PARTIALLY FIXED**

Behoben, was ohne Migration behebbar war, und es war ein echter Mangel:

> `SimDriver` trug **nur einen Namen**. Die UUID war zur Laufzeit längst
> vorhanden — `runShift` verteilt ihr `owner`-Objekt auf jede Fahrt — aber der
> Typ sagte es nicht, also gruppierte **jeder** Leser Fahrten nach dem
> **Namen**. Zwei Fahrer einer Firma mit demselben Namen verschmolzen zu einer
> Zeile einer Fahrer-Summe.

Abschnitt 5 verlangt ausdrücklich die UUID und nie den Namen allein. `id` ist
jetzt deklariert, die Summen gruppieren darüber, und `constraintDecisionLog`
ordnet Notizen ausschließlich über `drivers.id` zu — eine Notiz auf eine ID
außerhalb des Pools erzeugt eine Zeile mit `identityMatch: 'unresolved_id'`,
`effect: 'none'` und Prüfpflicht, statt über den Namen zu raten. Geprüft mit
zwei gleichnamigen Fahrern verschiedener ID.

**Nicht behoben, und weiterhin als Risiko verzeichnet:** der Fahrername geht in
`source_row_key` ein, also bekommt dieselbe Fahrt bei geändertem Namen einen
anderen Schlüssel und wird nicht als Dublette erkannt. Der verbleibende Schutz
ist der Dateihash. Das zu ändern heißt, den Schlüssel zu wechseln, und damit
die Dublettenerkennung einer gesetzlichen Urkunde — eine Migration und eine
Entscheidung des Eigentümers.

### FB-UNVERIFIED-002 — Herkunft und Simulationskennzeichnung → **STILL FAILING als Produkteigenschaft**

Unverändert: die Kennzeichnung reist über ein **zweites Blatt**, eine
**Dateinamenspräfix**, die Spalte `is_simulated` und `Props.Title` — und keine
davon ist eine Zelle im Fahrtenblatt. Das Kopieren eines einzelnen Blattes
verliert alle vier, und genau so entstand dieser Prüfauftrag.

Dem Fahrtenblatt eine Kennzeichnung je Zeile zu geben bricht die byteweise
Reproduktion des Modus `'original'` ⇒ **Entscheidung des Eigentümers**.

**Neu messbar in dieser Runde:** `audit-round3-verify.mts` liest die erzeugte
Datei aus ihren eigenen Bytes zurück und prüft die vier Marker. Ergebnis:
Blatt `SIMULIERT` vorhanden und **nicht** das erste Blatt, Präfix vorhanden,
Quellenblatt nennt die Simulation in Worten und die Generatorversion.

### FB-SEC-001 — Mandantentrennung Ende zu Ende → **PARTIALLY FIXED**

Für die neuen Objekte geprüft, mit Kontrollen: `tests/rls/declined-trip-status.sql`
und `tests/rls/monthly-revenue-share.sql` sind im Kit gelaufen (Exit 0). Beide
führen eine **Eigentümer-Kontrolle vor** den Proben und `DISCARD PLANS` vor
jedem Prinzipal, und die Verschiebeprobe hat eine **Positivkontrolle**, die bei
gelockertem `WITH CHECK` gelingen muss — diese Kontrolle hat ihre eigene Probe
entlarvt (Abschnitt 2.5 des Testprotokolls).

**Unverändert nicht geprüft:** Edge-Funktionen zur Laufzeit und der Export mit
zwei Mandanten. Für den Excel-Dienst ist die Trennung konstruktiv (kein
Datenbank-URL, kein Service-Key, kein Volume; `tests/deploy/export-service.test.ts`
bricht den Build, wenn er eines erwirbt) und nicht durch einen
Zwei-Mandanten-Test belegt.

### FB-CONFIG-001 — Zeitzonen und Betriebstagsgrenzen nicht mandantenweit → **PARTIALLY FIXED**

Für die Simulation sind beide jetzt Einstellungen, validiert, und der erzeugte
Monat schreibt auf, mit welchem Schnitt er gebaut wurde. Für das Produkt nicht,
und das ist eine bewusste Grenze, nicht eine Lücke: siehe FB-WARN-001.

---

## Neue Befunde dieser Runde

Alle drei sind **in diesem Zweig gemessen und behoben**, mit Reproduktion.

### NEW-1 — Betriebstag an der Zeitumstellung → **FIXED**

Siehe FB-WARN-001.

### NEW-2 — abgelehnte Aufträge verschoben jede spätere Schicht → **FIXED**

`declinedOrders` zog aus dem **gemeinsamen** Zufallsstrom des Generators. Jede
Ziehung verbrauchte eine Zahl, die der nächsten Schicht zugestanden hätte, also
verschob das Einschalten der Funktion **den ganzen restlichen Monat**: gemessen
bei einem Seed **778 abgeschlossene Fahrten aus gegen 749 ein**. Der Kommentar
im Modul behauptete, eine Ablehnung verschiebe keine Fahrt — das war falsch.

Jetzt ein zweiter Durchgang mit eigenem Strom, nach allen Schichten. Die
abgeschlossenen Fahrten sind mit und ohne die Funktion identisch; der Test
dafür heißt „consume no shift time“ und ist grün.

Verbleibende Kopplung, benannt statt übergangen: ein Übermittlungszeitpunkt
muss monatsweit eindeutig sein, eine Kollision wird um eine Millisekunde
weitergeschoben. Weil dieser Durchgang **zuletzt** läuft, kann eine Kollision
nur eine Ablehnung bewegen, nie eine echte Fahrt.

### NEW-3 — Fahrer-Summen gruppierten nach dem Namen → **FIXED**

Siehe FB-UNVERIFIED-001.

### NEW-4 — fehlendes Etikett für die abgelehnte Fahrt in der Importvorschau → **FIXED**

Von der Typprüfung gefunden (`TS2741`), nicht von einem Test: die Importvorschau
hätte für eine abgelehnte Fahrt kein Etikett gehabt. Schlüssel
`imp.status.declined` in beiden Wörterbüchern.

---

## Die geforderten Abschnitte 2 bis 5

| Abschnitt | Status | Belegt durch |
|---|---|---|
| 2 — voller Kalendermonat, Nulltage, echte Verfügbarkeit | **FIXED** | `fullMonth.test.ts` (28/29/30/31 Tage, Nulltage, keine Fahrt in einer Sperre, Determinismus, Herkunft); Lieferung zeigt 31 Tage mit 9 Nulltagen und 261 durch Notiz gesperrte Versuche |
| 3 — DECLINED mit 6,00 €, getrenntes Feld, kein Doppelzählen | **FIXED** | Migration `20261027170000` (dritter `trip_status`, eigene Spalte, CHECK gegen eine Gebühr auf abgeschlossener Fahrt), `revenue.test.ts`, Kit-Datei, Export-und-Rückimport über `mapTripStatus` |
| 4 — ein Monatssatz 30–33 %, PRNG mit Seed, genaue Cent-Rechnung | **FIXED** für den Simulator; **PARTIALLY FIXED** für das Produkt | `monthlyRate.test.ts` (Beispiel des Auftrags, BigInt-Gegenrechnung, 2000 Seeds), `monthlyRevenueShare.test.ts`, Migration `20261027180000`; **kein Eingabeformular**, also im Produkt noch nicht bedienbar |
| 5 — Notizen bindend nach Beweiskraft, Entscheidungsprotokoll | **FIXED** | `constraintDecisionLog.test.ts` (80 Tests, Raster 7×8×7 gegen `findBlockingNote`), `Einschraenkungen.md` |

**Zu Abschnitt 4, ausdrücklich:** Der Satz ist ein Anteil an **bereits
vorhandenem** Umsatz. Er greift auf keinen Fahrpreis zurück, er heißt nicht
Steuer und nicht Provision, und er wird nirgends gebucht. Die Grenzen 30–33 %
sind **gemessen** ein Artefakt des Prüfszenarios und keine Produktregel: der
einzige Umsatzanteil, den das Produkt kennt, ist `drivers.salary_ratio`,
`numeric(5,4)`, `CHECK 0..1`, Standard 0,5000 — und nirgends im Code gibt es ein
30–33-Band. Die Grenzen bleiben deshalb im Simulator, und der gespeicherte Satz
des Produkts ist über 0–100 % frei.
