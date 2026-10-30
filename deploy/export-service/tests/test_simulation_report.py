"""The simulated month's two reports, written by the service and read back with openpyxl.

The fixtures are the payloads the browser builds for an invented month
(scripts/audit-round4-fixture.mts): the Fahrtenbuch report and the internal
operational report (external audit round 6). Everything below is computed
from the reopened bytes alone; the only numbers taken from outside the files
are the generator's counts in the sidecar, used where a file cannot know them
(how many route checks there were, how many orders were declined).
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
    "E Stornierungen", "F Pruefung und Grenzen", "G Routenpruefung",
    "H Ereignisse", "H2 Schichtentscheidungen", "I Quelle und Einstellungen", "SIMULIERT",
]
OPERATIONAL_SHEETS = [
    "L Leerfahrten", "M Abgelehnt intern", "N Interne Einnahmen", "O Schichtplanung",
    "I Quelle und Einstellungen", "SIMULIERT",
]
STATUSES = {"ROUTE_VERIFIED", "ROUTE_CONFLICT", "UNVERIFIABLE", "ESTIMATE_ONLY"}


@pytest.fixture(scope="module")
def expected():
    return json.loads((FIXTURES / "simulation_report.expected.json").read_text(encoding="utf-8"))


def reopen(name):
    raw = (FIXTURES / name).read_bytes()
    return load_workbook(io.BytesIO(build_xlsx(parse_payload(raw))))


@pytest.fixture(scope="module")
def book():
    return reopen("simulation_report.json")


@pytest.fixture(scope="module")
def ops():
    return reopen("operational_report.json")


def table(book, name):
    """Header dict per data row, keyed by the header text of row 1."""
    rows = list(book[name].iter_rows(values_only=True))
    header = list(rows[0])
    return header, [dict(zip(header, r)) for r in rows[1:]]


def cents(x):
    return round(float(x) * 100)


def test_sheet_names_and_order(book, ops):
    assert book.sheetnames == SHEETS
    assert ops.sheetnames == OPERATIONAL_SHEETS
    assert all(len(n) <= 31 for n in book.sheetnames + ops.sheetnames)


@pytest.mark.parametrize("which", ["book", "ops"])
def test_every_row_of_every_sheet_carries_the_label(which, request):
    workbook = request.getfixturevalue(which)
    for name in workbook.sheetnames[:-1]:
        rows = list(workbook[name].iter_rows(values_only=True))
        assert rows[0][0] == "Kennzeichnung", name
        assert len(rows) > 1, name
        for number, row in enumerate(rows[1:], 2):
            assert row[0] == "SIMULIERT", f"{name} row {number}"
    notice = list(workbook["SIMULIERT"].iter_rows(values_only=True))
    assert len(notice) == 1 and len(notice[0]) == 1 and notice[0][0].startswith("SIMULIERT")


@pytest.mark.parametrize("which", ["book", "ops"])
def test_no_cell_is_a_formula(which, request):
    for sheet in request.getfixturevalue(which).worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                assert cell.data_type != "f", f"{sheet.title}!{cell.coordinate}"


def fares(book):
    _, rides = table(book, "A Fahrten")
    return rides, sum(cents(r["Fahrpreis (EUR)"]) for r in rides if r["Status"] == "abgeschlossen")


def test_zero_declined_rows_in_the_fahrtenbuch_report(book, expected):
    """The owner's final rule of round 6: no declined order is a row, a count or a fee of the book."""
    assert expected["declinedCount"] > 0
    rides, _ = fares(book)
    assert {r["Status"] for r in rides} <= {"abgeschlossen", "storniert"}
    for sheet in book.worksheets:
        for row in sheet.iter_rows(values_only=True):
            assert "abgelehnt" not in row, sheet.title
            assert not any(isinstance(c, str) and c.startswith("AB0") for c in row), sheet.title


def test_ride_fares_resum_to_b_c_d_and_the_basis(book, expected):
    rides, total = fares(book)
    assert len(rides) == expected["reportRides"]
    assert total == expected["fareCents"] > 0
    for name in ("B Monatsuebersicht", "C Summe je Fahrer", "D Summe je Fahrzeug"):
        _, rows = table(book, name)
        key = "Datum" if name.startswith("B") else ("Fahrer" if name.startswith("C") else "Fahrzeug")
        sums = [r for r in rows if r[key] == "Summe"]
        assert len(sums) == 1, name
        assert cents(sums[0]["Fahrpreise (EUR)"]) == total, name
        body = [r for r in rows if r not in sums]
        assert sum(cents(r["Fahrpreise (EUR)"]) for r in body) == total, f"{name} parts"
        assert sum(cents(r["Stornogebuehren (EUR)"]) for r in body) == cents(sums[0]["Stornogebuehren (EUR)"]), name
        assert sum(r["Fahrten"] for r in body) == sums[0]["Fahrten"] == len(rides), name
    _, checks = table(book, "F Pruefung und Grenzen")
    posten = {r["Posten"]: r for r in checks if r["Abschnitt"] not in ("Abgleich", "Pruefung fuer den Export")}
    value = lambda key: cents(posten[key]["Wert / Summe der Teile"])  # noqa: E731
    assert value("Fahrpreise (EUR)") == total
    assert value("Monatssumme Fahrpreise App + Bar (EUR)") == total
    basis = total
    if posten["Trinkgeld in Grundlage"]["Wert / Summe der Teile"] == "Ja":
        basis += value("Trinkgeld (EUR)")
    if posten["Stornogebuehren in Grundlage"]["Wert / Summe der Teile"] == "Ja":
        basis += value("Stornogebuehren (EUR)")
    assert value("Anspruchsberechtigte Einnahmen (EUR)") == basis
    assert value("Betrag (EUR)") + value("Rest, falls Abzug (EUR)") == basis
    assert 30 <= float(posten["Satz (%)"]["Wert / Summe der Teile"]) <= 33
    assert "weder eine Steuer noch eine Provision" in posten["Hinweis Monatsanteil"]["Wert / Summe der Teile"]
    assert all(r["Ergebnis"] == "OK" and r["Differenz"] == 0 for r in checks if r["Abschnitt"] == "Abgleich")


def test_cancelled_rides_stay_with_the_company_fee_and_their_status(book, expected):
    rides, _ = fares(book)
    cancelled = [r for r in rides if r["Status"] == "storniert"]
    assert len(cancelled) == expected["cancelled"] > 0
    fee = expected["cancellationFeeUnitCents"]
    assert fee == 600
    assert all(cents(r["Stornogebuehr (EUR)"]) == fee for r in cancelled)
    assert all("Stornogebuehr berechnet" in r["Finanzstatus"] for r in cancelled)
    assert all(cents(r["Fahrpreis (EUR)"]) == 0 for r in cancelled)
    assert sum(cents(r["Stornogebuehr (EUR)"]) for r in cancelled) == expected["cancellationFeeCents"]
    _, e_rows = table(book, "E Stornierungen")
    assert len(e_rows) == len(cancelled)
    assert sum(cents(r["Stornogebuehr (EUR)"]) for r in e_rows) == expected["cancellationFeeCents"]


def test_every_calendar_day_is_a_row_of_b(book, expected):
    _, rows = table(book, "B Monatsuebersicht")
    days = [r["Datum"] for r in rows if r["Datum"] != "Summe"]
    last = calendar.monthrange(expected["year"], expected["month"])[1]
    assert days == [f"{expected['year']}-{expected['month']:02d}-{d:02d}" for d in range(1, last + 1)]
    empty = [r for r in rows if r["Tag ohne Fahrt"] == "Ja"]
    assert empty and all(r["Fahrten"] == 0 and r["Grund"] for r in empty)


def test_g_has_one_row_per_check_with_the_four_statuses(book, expected):
    header, rows = table(book, "G Routenpruefung")
    assert header[0] == "Kennzeichnung" and header[1] == "Gruppierung"
    assert len(rows) == expected["routeChecks"]
    assert {r["Status"] for r in rows} <= STATUSES
    assert {r["Gruppierung"] for r in rows} == {"Fahrzeug", "Fahrer"}
    assert all(r["Quelle"] for r in rows)
    for r in rows:
        if r["Status"] == "ROUTE_VERIFIED":
            # Re-derived from the cells: the gap holds road time, 45 s and the margin.
            assert r["Benoetigt (s)"] == r["Fahrzeit Strasse (s)"] + 45 + r["Sicherheitsreserve (s)"]
            assert r["Luecke (s)"] - r["Benoetigt (s)"] == r["Spielraum (s)"] >= 0
    counted = {s: sum(1 for r in rows if r["Status"] == s) for s in STATUSES}
    assert counted == expected["routeStatuses"]


def test_f_states_the_verdict_apart_from_generation(book, expected):
    _, checks = table(book, "F Pruefung und Grenzen")
    verify = {r["Posten"]: r for r in checks if r["Abschnitt"] == "Pruefung fuer den Export"}
    assert verify["Exportstatus"]["Wert / Summe der Teile"] == expected["verdict"]
    assert verify["Erzeugung"]["Wert / Summe der Teile"].startswith("erzeugt")
    assert "Keine abgelehnten Auftraege im Fahrtenbuch-Bericht" in verify
    assert verify["Keine abgelehnten Auftraege im Fahrtenbuch-Bericht"]["Ergebnis"] == "bestanden"
    assert expected["verdict"] in expected["fileName"]


# ── The operational report ──────────────────────────────────────────────────

LEG_FIELDS = [
    "Leerfahrt-ID", "Art", "Bezeichnung", "Lauf-ID", "Seed", "Datenart", "Mandant", "Fahrzeug-ID", "Kennzeichen",
    "Fahrer-ID", "Schicht", "Fahrt-ID vorher", "Fahrt-ID nachher", "Von", "Nach", "Abfahrt", "Ankunft",
    "Verfuegbar (s)", "Fahrzeit Strasse (s)", "Strecke (km)", "Sicherheitsreserve (s)", "Benoetigt (s)",
    "Spielraum (s)", "Routingquelle", "Pruefstatus",
]


def test_every_empty_drive_is_a_record_with_every_field(ops, expected):
    header, legs = table(ops, "L Leerfahrten")
    for field in LEG_FIELDS:
        assert field in header, field
    assert len(legs) == expected["legs"] > 0
    assert {(r["Art"], r["Bezeichnung"], r["Datenart"]) for r in legs} == {("REPOSITIONING", "LEERFAHRT", "SIMULATED")}
    assert {r["Lauf-ID"] for r in legs} == {expected["runId"]}
    assert {r["Seed"] for r in legs} == {expected["seed"]}
    assert {r["Mandant"] for r in legs} == {expected["tenantId"]}
    assert all(r["Fahrzeug-ID"] and r["Fahrer-ID"] and r["Fahrt-ID nachher"] for r in legs)
    assert {r["Pruefstatus"] for r in legs} <= STATUSES
    counted = {s: sum(1 for r in legs if r["Pruefstatus"] == s) for s in STATUSES}
    assert counted == expected["legStatuses"]
    for r in legs:
        if r["Pruefstatus"] != "ROUTE_VERIFIED":
            continue
        margin = expected["marginSeconds"] + -(-r["Fahrzeit Strasse (s)"] * expected["marginPercent"] // 100)
        assert r["Sicherheitsreserve (s)"] == margin, r["Leerfahrt-ID"]
        handling = 0 if r["Zweck"] == "Zielort zum Warteplatz" else 45
        assert r["Benoetigt (s)"] == r["Fahrzeit Strasse (s)"] + handling + margin, r["Leerfahrt-ID"]
        assert r["Verfuegbar (s)"] - r["Benoetigt (s)"] == r["Spielraum (s)"] >= 0, r["Leerfahrt-ID"]


def test_legs_point_at_rides_of_the_fahrtenbuch_and_are_none_of_them(book, ops):
    _, rides = table(book, "A Fahrten")
    ride_ids = {r["Fahrt-ID"] for r in rides}
    _, legs = table(ops, "L Leerfahrten")
    assert {r["Fahrt-ID nachher"] for r in legs} <= ride_ids
    assert {r["Fahrt-ID vorher"] for r in legs if r["Fahrt-ID vorher"]} <= ride_ids
    assert not ({r["Leerfahrt-ID"] for r in legs} & ride_ids)
    by_id = {r["Fahrt-ID"]: r for r in rides}
    for leg in legs:
        nxt = by_id[leg["Fahrt-ID nachher"]]
        assert nxt["Status"] == "abgeschlossen"
        assert nxt["Kennzeichen"] == leg["Kennzeichen"] and nxt["Fahrer-ID"] == leg["Fahrer-ID"] and nxt["Schicht"] == leg["Schicht"]


def test_declined_orders_live_only_in_the_operational_report_with_their_fee(ops, expected):
    _, declined = table(ops, "M Abgelehnt intern")
    assert len(declined) == expected["declinedCount"] > 0
    fee = expected["declinedFeeUnitCents"]
    assert all(cents(r["Ablehnungsgebuehr intern (EUR)"]) == fee for r in declined)
    assert all(r["Gebuehrenregel"] == "idle_in_shift" and "nicht im Fahrtenbuch" in r["Hinweis"] for r in declined)
    _, revenue = table(ops, "N Interne Einnahmen")
    total = next(r for r in revenue if r["Posten"] == "Abgelehnte Auftraege gesamt")
    assert total["Anzahl"] == len(declined)
    assert cents(total["Betrag (EUR)"]) == len(declined) * fee == expected["declinedFeeCents"]
    per_driver = [r for r in revenue if r["Posten"] == "Ablehnungsgebuehren je Fahrer"]
    assert sum(cents(r["Betrag (EUR)"]) for r in per_driver) == expected["declinedFeeCents"]


def test_scheduling_lists_every_shift_within_its_limits(ops):
    _, rows = table(ops, "O Schichtplanung")
    shifts = [r for r in rows if r["Art"] == "Schicht eingeplant"]
    assert shifts
    assert all(240 <= r["Dauer (min)"] <= 360 for r in shifts)
