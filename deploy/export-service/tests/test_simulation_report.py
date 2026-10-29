"""The simulated month's report, written by the service and read back with openpyxl.

The fixture is the payload the browser builds for an invented month
(scripts/audit-round4-fixture.mts). Everything below is computed from the
reopened bytes alone; the only numbers taken from outside the file are the
generator's counts in the sidecar, used where the file cannot know them
(how many route checks there were).
"""
import calendar
import io
import json
from pathlib import Path

import pytest
from openpyxl import load_workbook

from export_service.contract import parse_payload
from export_service.writer import build_xlsx

FIXTURES = Path(__file__).parent / "fixtures"
SHEETS = [
    "A Fahrten", "B Monatsuebersicht", "C Summe je Fahrer", "D Summe je Fahrzeug",
    "E Abgelehnt und storniert", "F Pruefung und Grenzen", "G Routenpruefung",
    "H Ereignisse", "H2 Schichtentscheidungen", "I Quelle und Einstellungen", "SIMULIERT",
]


@pytest.fixture(scope="module")
def expected():
    return json.loads((FIXTURES / "simulation_report.expected.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def book():
    raw = (FIXTURES / "simulation_report.json").read_bytes()
    data = build_xlsx(parse_payload(raw))
    return load_workbook(io.BytesIO(data))


def table(book, name):
    """Header dict per data row, keyed by the header text of row 1."""
    rows = list(book[name].iter_rows(values_only=True))
    header = list(rows[0])
    return header, [dict(zip(header, r)) for r in rows[1:]]


def cents(x):
    return round(float(x) * 100)


def test_sheet_names_and_order(book):
    assert book.sheetnames == SHEETS
    assert all(len(n) <= 31 for n in book.sheetnames)


def test_every_row_of_every_sheet_carries_the_label(book):
    for name in SHEETS[:-1]:
        rows = list(book[name].iter_rows(values_only=True))
        assert rows[0][0] == "Kennzeichnung", name
        assert len(rows) > 1, name
        for number, row in enumerate(rows[1:], 2):
            assert row[0] == "SIMULIERT", f"{name} row {number}"
    notice = list(book["SIMULIERT"].iter_rows(values_only=True))
    assert len(notice) == 1 and len(notice[0]) == 1 and notice[0][0].startswith("SIMULIERT")


def test_no_cell_is_a_formula(book):
    for sheet in book.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                assert cell.data_type != "f", f"{sheet.title}!{cell.coordinate}"


def fares(book):
    _, rides = table(book, "A Fahrten")
    return rides, sum(cents(r["Fahrpreis (EUR)"]) for r in rides if r["Status"] == "abgeschlossen")


def test_ride_fares_resum_to_b_c_d_and_the_basis(book, expected):
    rides, total = fares(book)
    assert len(rides) == expected["rides"]
    assert total == expected["fareCents"] > 0
    for name in ("B Monatsuebersicht", "C Summe je Fahrer", "D Summe je Fahrzeug"):
        _, rows = table(book, name)
        sums = [r for r in rows if r["Datum" if name.startswith("B") else ("Fahrer" if name.startswith("C") else "Fahrzeug")] == "Summe"]
        assert len(sums) == 1, name
        assert cents(sums[0]["Fahrpreise (EUR)"]) == total, name
        body = [r for r in rows if r not in sums]
        assert sum(cents(r["Fahrpreise (EUR)"]) for r in body) == total, f"{name} parts"
    _, checks = table(book, "F Pruefung und Grenzen")
    posten = {r["Posten"]: r for r in checks if r["Abschnitt"] != "Abgleich"}
    assert cents(posten["Fahrpreise (EUR)"]["Wert / Summe der Teile"]) == total
    assert cents(posten["Monatssumme Fahrpreise App + Bar (EUR)"]["Wert / Summe der Teile"]) == total
    value = lambda key: cents(posten[key]["Wert / Summe der Teile"])  # noqa: E731
    basis = total
    if posten["Trinkgeld in Grundlage"]["Wert / Summe der Teile"] == "Ja":
        basis += value("Trinkgeld (EUR)")
    if posten["Gebuehren in Grundlage"]["Wert / Summe der Teile"] == "Ja":
        basis += value("Ablehnungsgebuehren (EUR)") + value("Stornogebuehren (EUR)")
    assert value("Anspruchsberechtigte Einnahmen (EUR)") == basis
    assert value("Betrag (EUR)") + value("Rest, falls Abzug (EUR)") == basis
    assert 30 <= float(posten["Satz (%)"]["Wert / Summe der Teile"]) <= 33
    assert "weder eine Steuer noch eine Provision" in posten["Hinweis Monatsanteil"]["Wert / Summe der Teile"]
    assert all(r["Ergebnis"] == "OK" and r["Differenz"] == 0 for r in checks if r["Abschnitt"] == "Abgleich")


def test_declined_count_times_fee_equals_the_fee_total(book, expected):
    rides, _ = fares(book)
    declined = [r for r in rides if r["Status"] == "abgelehnt"]
    assert len(declined) == expected["declinedCount"] > 0
    fee = expected["declinedFeeUnitCents"]
    assert fee == 600
    total = len(declined) * fee
    assert sum(cents(r["Gebuehr (EUR)"]) for r in declined) == total == expected["declinedFeeCents"]
    assert all(r["Gebuehrenregel"] for r in declined)
    # A cancellation earns no fee unless the tenant charges one, and prints no rule.
    cancelled = [r for r in rides if r["Status"] == "storniert"]
    assert cancelled and all(cents(r["Gebuehr (EUR)"]) == 0 and r["Gebuehrenregel"] in (None, "") for r in cancelled)
    _, e_rows = table(book, "E Abgelehnt und storniert")
    assert sum(cents(r["Gebuehr gezaehlt (EUR)"]) for r in e_rows) == total
    _, b_rows = table(book, "B Monatsuebersicht")
    summe = next(r for r in b_rows if r["Datum"] == "Summe")
    assert cents(summe["Ablehnungsgebuehren (EUR)"]) == total
    _, i_rows = table(book, "I Quelle und Einstellungen")
    setting = next(r for r in i_rows if r["Angabe"] == "Einstellung declinedFeeCents")
    assert int(setting["Wert"]) == fee


def test_every_calendar_day_is_a_row_of_b(book, expected):
    _, rows = table(book, "B Monatsuebersicht")
    days = [r["Datum"] for r in rows if r["Datum"] != "Summe"]
    last = calendar.monthrange(expected["year"], expected["month"])[1]
    assert days == [f"{expected['year']}-{expected['month']:02d}-{d:02d}" for d in range(1, last + 1)]
    empty = [r for r in rows if r["Tag ohne Fahrt"] == "Ja"]
    assert empty and all(r["Auftraege"] == 0 and r["Grund"] for r in empty)


def test_g_has_one_row_per_check_and_both_statuses(book, expected):
    header, rows = table(book, "G Routenpruefung")
    assert header[0] == "Kennzeichnung" and header[1] == "Gruppierung"
    assert len(rows) == expected["routeChecks"]
    results = {r["Ergebnis"] for r in rows}
    assert {"Route passt", "Gleiche Adresse"} <= results
    assert {r["Gruppierung"] for r in rows} == {"Fahrzeug", "Fahrer"}
    assert all(r["Quelle"] for r in rows)
