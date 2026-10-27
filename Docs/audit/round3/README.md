# Externes Audit, Runde 3 — Lieferumfang

Abschnitt 9 des Prüfauftrags verlangt unter anderem eine XLSX-Datei für einen
vollen Kalendermonat. **Diese Datei liegt nicht in git, und das ist kein
Versäumnis.**

## Warum die Arbeitsmappe nicht eingecheckt ist

`.gitignore` ignoriert `*.xlsx`, `*.xls`, `*.csv` und `SIMULIERT_*.xlsx`
**überall** im Repository, und nur ein Pfad unter `tests/fixtures/` ist
ausdrücklich ausgenommen. Diese Regel steht dort, weil genau das zweimal
schiefgegangen ist: am 22.10.2026 hat ein `git add -A` 898 KB mit dem echten
Fahrtenexport eines Kunden nach staging gebracht, und am 26.10.2026 lag ein
echter Fahrtenbuch-Export in einem Unterordner, den die damals nur auf das
Wurzelverzeichnis beschränkte Regel nicht erfasst hätte. **Dieses Repository ist
öffentlich.**

Eine Ausnahme für `Docs/audit/round3/` einzutragen würde genau die Lücke wieder
öffnen, gegen die die Regel geschrieben wurde — der nächste Mensch, der hier
eine Datei ablegt, weiß von dieser Begründung nichts. Die Regel wird deshalb
nicht aufgeweicht; das ist eine Entscheidung des Eigentümers und nicht die
eines Prüfauftrags.

## Was stattdessen hier liegt, und warum es mehr zeigt

Der Prüfbericht der Runde 3 lautete *AUDIT INCOMPLETE — INSUFFICIENT EVIDENCE*,
mit der Begründung, es sei **kein Code, kein Diff und kein Rohprotokoll**
vorgelegt worden. Ein deterministischer Generator plus ein unabhängiger Prüfer
beantworten genau diesen Vorwurf, und eine Binärdatei tut es nicht.

| Datei | Inhalt |
|---|---|
| `Finanzbericht.txt` | Aufträge, Erlöse, Bemessungsgrundlage, Satz, Betrag, Rest, Abstimmung der Teilsummen, Zeitraum und Prüfungen |
| `Einschraenkungen.md` | Das Entscheidungsprotokoll zu Abschnitt 5: Ereignis, Quelle, Sicherheit, Zeitraum, Wirkung |
| `../../../scripts/audit-round3-deliverables.mts` | erzeugt beides und die Arbeitsmappe |
| `../../../scripts/audit-round3-verify.mts` | liest die erzeugte Arbeitsmappe **aus ihren eigenen Bytes** zurück und rechnet nach |

## Die Arbeitsmappe selbst erzeugen

```bash
npx vite-node scripts/audit-round3-deliverables.mts   # schreibt sie in diesen Ordner
npx vite-node scripts/audit-round3-verify.mts         # liest sie zurück und prüft sie
```

Der Seed ist festgeschrieben (`20261027`), die Eingaben sind erfunden, also ist
die Datei bei jedem Lauf dieselbe. Gemessen am 27.10.2026:

```
SIMULIERT_Monatsbericht_2026-10_20261027.xlsx (540610 bytes)
days 31, zero-ride 9, shifts 65, rides 725
blocked by a driver note 261
completed 697, declined 18, cancelled 10
fares 8.144,76 EUR (per-day sum 8.144,76 EUR, equal)
basis 8.252,76 EUR, rate 32,01 %, amount 2.641,71 EUR, remainder 5.611,05 EUR
constraints 11, violations 0, generator full-month/1.0.0
```

Und der Prüfer, der nichts aus dem Generator importiert:

```
VERIFY OK — every sheet read in full, 725 rides re-summed, all cross-sheet totals agree.
```

## Alle Eingaben sind erfunden

Keine Zeile dieser Lieferung nennt einen Menschen, einen Ort oder ein Fahrzeug,
das existiert. Die Fahrer heißen „Fahrer 1“ bis „Fahrer 3“, die Kennzeichen sind
nicht zulassungsfähig, und die Adressen liegen in „40210 Demostadt“ an einer
„Teststrasse“. Die Zahlen sind deshalb eine Vorführung der Verarbeitungskette
und **keine Messung eines Unternehmens** — die Arbeitsmappe sagt das auf ihrem
eigenen Quellen-Blatt, und der Finanzbericht in seinen ersten Zeilen.
