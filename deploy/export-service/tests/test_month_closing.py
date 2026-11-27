"""The simulated month's closing (FleetBook round 8, section 10), written by the service and read back.

The fixture is the payload the browser builds for an invented month that
returns to the base, with Uber's figures and real trips read
(scripts/audit-round4-fixture.mts). Everything below is computed from the
reopened bytes; the sidecar gives only what a file cannot know about itself.
"""
import io
import json
from collections import defaultdict
from pathlib import Path

import pytest
from openpyxl import load_workbook

from export_service.contract import parse_payload
from export_service.writer import build_xlsx

FIXTURES = Path(__file__).parent / "fixtures"
SHEETS = [
    "Fahrtenbuch", "Fahrerschichten", "Lohn und Arbeitszeit", "Uber Tagesabgleich",
    "Fahrzeuge und Leerfahrten", "Kalendermonat", "Pruefung und Herkunft", "SIMULIERT",
]
LABELS = {"SIMULIERT", "IMPORTIERT", "ABGELEITET"}


@pytest.fixture(scope="module")
def expected():
    return json.loads((FIXTURES / "month_closing.expected.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def book():
    raw = (FIXTURES / "month_closing.json").read_bytes()
    return load_workbook(io.BytesIO(build_xlsx(parse_payload(raw))))


def table(book, name):
    rows = list(book[name].iter_rows(values_only=True))
    header = list(rows[0])
    return header, [dict(zip(header, r)) for r in rows[1:]]


def cents(x):
    return round(float(x) * 100)


def checks_of(book):
    _, rows = table(book, "Pruefung und Herkunft")
    return {r["Angabe"]: r["Wert"] for r in rows}


def test_sheets_in_the_auditors_order_with_the_notice_last(book):
    assert book.sheetnames == SHEETS


def test_every_data_row_says_where_it_came_from_and_nothing_is_a_formula(book):
    for name in SHEETS[:-1]:
        rows = list(book[name].iter_rows(values_only=True))
        assert rows[0][0] == "Kennzeichnung", name
        assert {r[0] for r in rows[1:]} <= LABELS, name
    assert not [c for ws in book.worksheets for row in ws.iter_rows() for c in row if c.data_type == "f"]


def test_the_fahrtenbuch_holds_real_trips_as_imported_and_no_declined_order(book, expected):
    _, rides = table(book, "Fahrtenbuch")
    real = [r for r in rides if r["Kennzeichnung"] == "IMPORTIERT"]
    assert len(real) == expected["realTripsBooked"]
    assert {r["Status"] for r in rides} <= {"abgeschlossen", "storniert"}
    assert all(r["Finanzstatus"] == "wie importiert, unveraendert" for r in real)
    assert checks_of(book)["Abgelehnte echte Auftraege (nicht im Fahrtenbuch)"] == expected["realTripsDeclined"]


def test_numbers_stay_numbers(book):
    _, rides = table(book, "Fahrtenbuch")
    done = [r for r in rides if r["Status"] == "abgeschlossen"]
    assert done and all(isinstance(r["Fahrpreis (EUR)"], (int, float)) for r in done)


def test_fares_and_uber_turnover_reconcile_with_the_calendar(book, expected):
    _, rides = table(book, "Fahrtenbuch")
    _, days = table(book, "Kalendermonat")
    total = days[-1]
    assert total["Datum"] == "Summe"
    simulated = sum(cents(r["Fahrpreis (EUR)"]) for r in rides if r["Kennzeichnung"] == "SIMULIERT" and r["Status"] == "abgeschlossen")
    assert simulated == expected["simulatedFareCents"] == cents(total["Fahrpreise simuliert (EUR)"])
    _, uber = table(book, "Uber Tagesabgleich")
    counted = sum(cents(r["Umsatz (EUR, importiert)"]) for r in uber
                  if r["Zeilenart"] in ("Tag", "Woche im Monat") and isinstance(r["Umsatz (EUR, importiert)"], (int, float)))
    assert counted == expected["uberUmsatzCents"] == cents(total["Umsatz importiert (EUR)"])
    across = [r for r in uber if str(r["Zeilenart"]).startswith("Woche ueber die Monatsgrenze")]
    assert across and all(r["Status"] == "INCOMPLETE" for r in across)


def test_every_shift_returns_to_the_base_and_its_empty_km_add_up(book, expected):
    _, rows = table(book, "Fahrzeuge und Leerfahrten")
    legs = defaultdict(list)
    for r in rows:
        if r["Zeilenart"] == "Leerfahrt":
            legs[r["Schicht-ID"]].append(r)
    shifts = [r for r in rows if r["Zeilenart"] == "Schicht"]
    assert len(shifts) == expected["shifts"]
    returns = [r for r in rows if r["Zweck"] == "Rueckkehr zum Betriebssitz"]
    assert len(returns) == expected["returnLegs"] == len(shifts)
    base = expected["base"]
    assert all((r["Ziel Breite"], r["Ziel Laenge"]) == (base["lat"], base["lon"]) for r in returns)
    for s in shifts:
        assert cents(s["Leer-km"]) == sum(cents(r["Leer-km"]) for r in legs[s["Schicht-ID"]]), s["Schicht-ID"]


def test_pay_is_never_called_a_salary_and_nothing_is_booked(book):
    header, rows = table(book, "Lohn und Arbeitszeit")
    for h in header:
        if any(w in h for w in ("Lohn", "Gehalt", "Provision")) and "EUR" in h:
            assert any(w in h for w in ("Konfiguration", "simuliert", "nicht gebucht")), h
    assert all(str(r["Gebuchtes Gehalt"]).startswith("nicht gelesen") for r in rows)
    assert all(str(r["Bruttolohn"]).startswith("nicht berechnet") for r in rows)


def test_the_financial_status_is_its_own_and_the_crossing_week_keeps_it_open(book, expected):
    assert expected["financialStatus"] == "INCOMPLETE"
    checks = checks_of(book)
    assert checks["Finanzabgleich mit Uber (getrennt vom Exportstatus)"] == "INCOMPLETE"
    assert checks["Rueckkehr zum Betriebssitz am Schichtende"] == "Ja"
    assert expected["verdict"] in expected["fileName"]
