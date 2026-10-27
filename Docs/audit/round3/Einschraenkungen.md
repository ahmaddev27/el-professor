# Entscheidungsprotokoll der Einschränkungen (Audit Abschnitt 5)

SIMULIERT – Diese Fahrten wurden vom Fahrtengenerator erzeugt. Es sind keine echten Fahrten. Nicht als Nachweis, Fahrtenbuch oder Lohngrundlage verwenden.

Zeilen: 11 | harte Sperren: 4 | nur Prüfung: 3 | ohne Wirkung: 4
Fenster aus dem Eingangsdatum der Notiz abgeleitet: 1 | nicht zuordenbare ID: 1

Sicherheit "assumed_from_notice_date" heißt: die Notiz nennt keinen eigenen
Zeitraum, deshalb stammt das Fenster aus `note_date`. Diese Spalte wird mit
`now()` vorbelegt, ist also der Zeitpunkt der Erfassung und nicht der des
Ereignisses. Die Sperre gilt unverändert weiter und wird gemeldet, nicht
stillschweigend verschoben.

| Subjekt | ID | Bezeichnung | Ereignis | Quelle | Sicherheit | Wirkung | Von | Bis | Zeit | Aus Eingangsdatum | Prüfung nötig | Begründung |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| driver | 22222222-2222-4222-8222-222222222201 | Fahrer 1 | Urlaub | driver_note | confirmed | hard_block | 2026-10-12 | 2026-10-18 | ganztägig | nein | nein | Bestätigtes sperrendes Ereignis mit eigenem Zeitraum |
| driver | 22222222-2222-4222-8222-222222222201 | Fahrer 1 | Blitzer | driver_note | reported | human_review | 2026-10-05 | 2026-10-05 | ganztägig | nein | ja | Vergangenes Ereignis - keine Sperre, nur zur menschlichen Prüfung |
| driver | 22222222-2222-4222-8222-222222222202 | Fahrer 2 | Krank | driver_note | assumed_from_notice_date | hard_block | 2026-10-22 | 2026-10-22 | ganztägig | ja | ja | Sperre aus dem Eingangsdatum der Notiz abgeleitet, nicht aus dem Zeitpunkt des Ereignisses - bitte Zeitraum prüfen |
| driver | 22222222-2222-4222-8222-222222222202 | Fahrer 2 | Allgemeine Notiz | driver_note | reported | none |  |  | ganztägig | nein | nein | Neutrale Notiz - keine Planungswirkung |
| driver | 22222222-2222-4222-8222-222222222203 | Fahrer 3 | Keine Nachtschicht | legacy_driver_text | reported | hard_block |  |  | ganztägig | nein | ja | Wiederkehrende Regel aus dem freien Notizfeld - sperrt, ist aber nur aus Text erkannt |
| driver | 22222222-2222-4222-8222-2222222299ff |  | Nicht verfügbar | driver_note | confirmed | none | 2026-10-09 | 2026-10-09 | ganztägig | nein | ja | Notiz verweist auf eine Fahrer-ID, die nicht im Planungspool ist - keine automatische Zuordnung |
| vehicle | 11111111-1111-4111-8111-111111111101 | XX-TEST-1 | TÜV | vehicle_tuev | confirmed | none | 2027-04-30 |  | ganztägig | nein | nein | TÜV am Stichtag gültig |
| vehicle | 11111111-1111-4111-8111-111111111102 | XX-TEST-2 | TÜV | vehicle_tuev | confirmed | hard_block | 2026-09-30 |  | ganztägig | nein | nein | TÜV am Stichtag abgelaufen - Fahrzeug darf nicht eingesetzt werden |
| vehicle | 11111111-1111-4111-8111-111111111103 | XX-TEST-3 | TÜV | vehicle_tuev | reported | human_review |  |  | ganztägig | nein | ja | Kein TÜV-Datum erfasst - weder gültig noch abgelaufen belegt |
| vehicle | 11111111-1111-4111-8111-111111111101 | XX-TEST-1 | Werkstatt-Prüfung positive | vehicle_werkstatt_check | reported | none | 2026-10-06 | 2026-10-06 | ganztägig | nein | nein | Werkstatt-Prüfung ohne Befund - keine Planungswirkung |
| vehicle | 11111111-1111-4111-8111-111111111102 | XX-TEST-2 | Werkstatt-Prüfung negativ | vehicle_werkstatt_check | reported | human_review | 2026-10-13 | 2026-10-13 | ganztägig | nein | ja | Negative Werkstatt-Prüfung - keine Sperre, da kein Ausfallzeitraum erfasst ist |
