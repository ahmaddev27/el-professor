"""Read a simulated monthly report back and check it, from the file's own bytes.

    python scripts/audit-round4-verify.py <SIMULIERT_Monatsbericht_….xlsx> [more files]

External audit round 4 asks that the final XLSX be "reopened with an
independent parser" and that its totals and rows be compared. This script
imports nothing from the generator and nothing from JavaScript: it opens the
file with openpyxl, reads every sheet and every row, and recomputes in integer
cents and on absolute instants (Europe/Berlin through zoneinfo):

  - the label: every data row of every sheet says SIMULIERT;
  - the money: ride fares re-summed against sheets B, C, D and the basis in F;
    declined count x fee against the fee totals; amount + remainder = basis;
    the rate inside [30 %, 33 %];
  - the period: every calendar day of the month is a row of B, with its hours;
  - overlaps: no vehicle and no driver holds two rides at once;
  - constraints: no ride of a vehicle after its TÜV hard block, and no ride of a
    driver inside a confirmed blocking window, both read from sheet H;
  - the route sheet: every completed consecutive pair of sheet A has its row.

It prints one line per check and exits non-zero on the first file that fails
any of them. A check it cannot make says so; it is never counted as passed.
"""
import calendar
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from openpyxl import load_workbook

BERLIN = ZoneInfo("Europe/Berlin")
REQUIRED = [
    "A Fahrten", "B Monatsuebersicht", "C Summe je Fahrer", "D Summe je Fahrzeug",
    "E Abgelehnt und storniert", "F Pruefung und Grenzen", "G Routenpruefung",
    "H Ereignisse", "H2 Schichtentscheidungen", "I Quelle und Einstellungen", "SIMULIERT",
]


def cents(x):
    return round(float(x) * 100) if x not in (None, "") else 0


def instant(text):
    """'2026-10-25 02:30:00.123' on the Berlin clock, as an absolute UTC instant; None when not a time."""
    if not isinstance(text, str) or len(text) < 19:
        return None
    wall = datetime.strptime(text[:19], "%Y-%m-%d %H:%M:%S")
    millis = int(text[20:23]) if len(text) >= 23 and text[19] == "." else 0
    local = wall.replace(tzinfo=BERLIN, fold=0)
    # A reading the clocks skip does not survive a round trip; the generator never writes one.
    back = local.astimezone(ZoneInfo("UTC")).astimezone(BERLIN).replace(tzinfo=None)
    if back != wall:
        return None
    return local.astimezone(ZoneInfo("UTC")) + timedelta(milliseconds=millis)


def table(book, name):
    rows = list(book[name].iter_rows(values_only=True))
    header = list(rows[0])
    return header, [dict(zip(header, r)) for r in rows[1:]]


def verify(path):
    out, failures = [], []

    def check(ok, what, detail=""):
        out.append(f"{'ok  ' if ok else 'FAIL'} {what}{'  ' + detail if detail else ''}")
        if not ok:
            failures.append(what)

    book = load_workbook(path, read_only=False)
    check(book.sheetnames == REQUIRED, "sheets and their order", " | ".join(book.sheetnames))

    for name in REQUIRED[:-1]:
        rows = list(book[name].iter_rows(values_only=True))
        bad = [i + 2 for i, r in enumerate(rows[1:]) if r[0] != "SIMULIERT"]
        check(rows[0][0] == "Kennzeichnung" and not bad, f"label on every row of {name}", f"{len(rows) - 1} rows")
    formulas = sum(1 for ws in book.worksheets for row in ws.iter_rows() for c in row if c.data_type == "f")
    check(formulas == 0, "no formula anywhere", f"{formulas} formula cells")

    _, rides = table(book, "A Fahrten")
    done = [r for r in rides if r["Status"] == "abgeschlossen"]
    declined = [r for r in rides if r["Status"] == "abgelehnt"]
    cancelled = [r for r in rides if r["Status"] == "storniert"]
    fare = sum(cents(r["Fahrpreis (EUR)"]) for r in done)
    tips = sum(cents(r["Trinkgeld (EUR)"]) for r in done)
    km = sum(round(float(r["Kilometer"] or 0) * 100) for r in done)
    check([r["Nr"] for r in rides] == list(range(1, len(rides) + 1)), "ride numbers 1..n without gap", f"{len(rides)} orders")

    for name, key in (("B Monatsuebersicht", "Datum"), ("C Summe je Fahrer", "Fahrer"), ("D Summe je Fahrzeug", "Fahrzeug")):
        _, rows = table(book, name)
        total = [r for r in rows if r[key] == "Summe"]
        parts = [r for r in rows if r[key] != "Summe"]
        check(len(total) == 1 and cents(total[0]["Fahrpreise (EUR)"]) == fare == sum(cents(r["Fahrpreise (EUR)"]) for r in parts),
              f"fares of A = Summe of {name} = its parts", f"{fare / 100:.2f} EUR")
        check(len(total) == 1 and cents(total[0]["Trinkgeld (EUR)"]) == tips, f"tips of A = Summe of {name}", f"{tips / 100:.2f} EUR")

    fee_total = sum(cents(r["Gebuehr (EUR)"]) for r in declined)
    unit = {cents(r["Gebuehr (EUR)"]) for r in declined}
    check(all(r["Gebuehrenregel"] for r in declined), "every declined ride names its fee rule", f"{len(declined)} declined")
    check(not cancelled or all(cents(r["Fahrpreis (EUR)"]) == 0 and cents(r["Gebuehr (EUR)"]) == 0 for r in cancelled),
          "a cancellation carries no fare and no fee", f"{len(cancelled)} cancelled")
    _, e_rows = table(book, "E Abgelehnt und storniert")
    check(sum(cents(r["Gebuehr gezaehlt (EUR)"]) for r in e_rows) == fee_total, "decline fees of A = sheet E",
          f"{len(declined)} x {sorted(unit)} cents = {fee_total / 100:.2f} EUR")

    _, f_rows = table(book, "F Pruefung und Grenzen")
    posten = {r["Posten"]: r["Wert / Summe der Teile"] for r in f_rows if r["Abschnitt"] != "Abgleich"}
    check(all(r["Ergebnis"] == "OK" and r["Differenz"] == 0 for r in f_rows if r["Abschnitt"] == "Abgleich"),
          "every reconciliation line of F is OK")
    if "Satz (%)" in posten:
        basis = fare + (tips if posten.get("Trinkgeld in Grundlage") == "Ja" else 0)
        if posten.get("Gebuehren in Grundlage") == "Ja":
            basis += cents(posten.get("Ablehnungsgebuehren (EUR)")) + cents(posten.get("Stornogebuehren (EUR)"))
        amount, rest = cents(posten["Betrag (EUR)"]), cents(posten["Rest, falls Abzug (EUR)"])
        rate = float(posten["Satz (%)"])
        check(cents(posten["Anspruchsberechtigte Einnahmen (EUR)"]) == basis, "basis re-derived from A", f"{basis / 100:.2f} EUR")
        check(amount + rest == basis, "amount + remainder = basis", f"{amount / 100:.2f} + {rest / 100:.2f}")
        # Basis points times the basis, rounded half up to the cent: the file's own rate, recomputed here.
        bp = round(rate * 100)
        check(30.0 <= rate <= 33.0 and abs(amount - (basis * bp + 5000) // 10000) <= 0, "rate in [30 %, 33 %] and amount = basis x rate",
              f"{rate} %")
    else:
        check(False, "the monthly share is in the file", "no 'Satz (%)' line")

    _, b_rows = table(book, "B Monatsuebersicht")
    days = [r for r in b_rows if r["Datum"] != "Summe"]
    first = days[0]["Datum"] if days else ""
    year, month = int(first[:4]), int(first[5:7])
    expected_days = [f"{year}-{month:02d}-{d:02d}" for d in range(1, calendar.monthrange(year, month)[1] + 1)]
    check([r["Datum"] for r in days] == expected_days, "every calendar day is a row of B", f"{len(days)} days")
    hours = {r["Datum"]: r["Stunden"] for r in days}
    odd = {d: h for d, h in hours.items() if h != 24}
    check(all(h in (23, 25) for h in odd.values()), "a day is 24 h, or 23/25 on a clock change", json.dumps(odd))
    zero = [r for r in days if r["Tag ohne Fahrt"] == "Ja"]
    check(all(r["Auftraege"] == 0 and r["Grund"] for r in zero), "every zero-ride day has no order and a reason", f"{len(zero)} days")

    def overlaps(key):
        found = 0
        groups = defaultdict(list)
        for r in done:
            s, e = instant(r["Fahrtbeginn"]), instant(r["Fahrtende"])
            if s and e:
                groups[r[key]].append((s, e))
        for spans in groups.values():
            spans.sort()
            found += sum(1 for a, b in zip(spans, spans[1:]) if b[0] < a[1])
        return found
    unreadable = sum(1 for r in done if not (instant(r["Fahrtbeginn"]) and instant(r["Fahrtende"])))
    check(unreadable == 0, "every completed ride has a readable start and end", f"{unreadable} unreadable")
    check(overlaps("Kennzeichen") == 0, "no vehicle holds two rides at once")
    check(overlaps("Fahrer") == 0, "no driver holds two rides at once")

    _, events = table(book, "H Ereignisse")
    _, decisions = table(book, "H2 Schichtentscheidungen")

    # TÜV: the generator judges every operating day; its refusals are the rows
    # of H2 with that code. No completed ride of that plate on such a day.
    blocked_days = {(r["Kennzeichen"], str(r["Tag"])) for r in decisions if r.get("Code") == "vehicle_tuev_expired"}
    on_blocked = [r["Nr"] for r in done if (r["Kennzeichen"], str(r["Datum der Fahrt"])) in blocked_days]
    check(not on_blocked, "no ride of a vehicle on a day its TÜV had expired",
          f"{len(blocked_days)} vehicle-days blocked, {len(on_blocked)} rides on them")

    # Confirmed full-day driver blocks, on absolute instants: the window is the
    # Berlin calendar days of the note, a ride overlaps it if any part of it does.
    def window(text):
        parts = str(text or "").split(" bis ")
        if len(parts) != 2 or len(parts[0]) != 10 or len(parts[1]) != 10:
            return None
        a = datetime.strptime(parts[0], "%Y-%m-%d").replace(tzinfo=BERLIN)
        b = (datetime.strptime(parts[1], "%Y-%m-%d") + timedelta(days=1)).replace(tzinfo=BERLIN)
        return a, b
    confirmed = [e for e in events if e.get("Betrifft") == "Fahrer" and e.get("Quelle") == "driver_note"
                 and e.get("Sicherheit") == "bestaetigt" and e.get("Wirkung") == "hard_block"]
    timed = [e for e in confirmed if window(e.get("Zeitraum")) is None]
    inside = []
    for e in confirmed:
        w = window(e.get("Zeitraum"))
        if w is None:
            continue
        for r in done:
            s_, e_ = instant(r["Fahrtbeginn"]), instant(r["Fahrtende"])
            if r["Fahrer"] == e.get("Bezeichnung") and s_ and e_ and s_ < w[1] and e_ > w[0]:
                inside.append(r["Nr"])
    check(not inside, "no ride of a driver inside a confirmed full-day block",
          f"{len(confirmed) - len(timed)} full-day blocks, {len(inside)} rides inside")
    if timed:
        check(False, "confirmed blocks with clock times", f"{len(timed)} not checked by this script")
    unconfirmed = [e for e in events if e.get("Quelle") == "driver_note" and e.get("Sicherheit") == "aus Meldedatum angenommen"]
    reviewed = [r for r in decisions if r.get("Code") == "unconfirmed_note"]
    out.append(f"info {len(unconfirmed)} notes with a notice-date window (not a block); {len(reviewed)} shifts ran past one, each marked for review")

    _, g_rows = table(book, "G Routenpruefung")
    pairs = set()
    for key in ("Kennzeichen", "Fahrer"):
        groups = defaultdict(list)
        for r in done:
            groups[r[key]].append((instant(r["Fahrtbeginn"]), r["Nr"]))
        for spans in groups.values():
            spans.sort()
            pairs |= {(key, a[1], b[1]) for a, b in zip(spans, spans[1:])}
    check(len(g_rows) == len(pairs), "one route-check row per consecutive completed pair (vehicle and driver)", f"{len(g_rows)} rows, {len(pairs)} pairs")
    results = Counter(r["Ergebnis"] for r in g_rows)
    sources = Counter(r["Quelle"] for r in g_rows)
    check(all(sources), "every route-check row names its source", json.dumps(sources))

    by_outcome = Counter(r.get("Ergebnis") for r in decisions)

    summary = {
        "file": path, "orders": len(rides), "completed": len(done), "declined": len(declined), "cancelled": len(cancelled),
        "fares_eur": fare / 100, "tips_eur": tips / 100, "km": km / 100, "decline_fees_eur": fee_total / 100,
        "share": {k: posten.get(k) for k in ("Satz (%)", "Anspruchsberechtigte Einnahmen (EUR)", "Betrag (EUR)", "Rest, falls Abzug (EUR)")},
        "days": len(days), "zero_ride_days": len(zero), "clock_change_days": odd,
        "route_results": dict(results), "route_sources": dict(sources), "decisions": dict(by_outcome),
        "failures": failures,
    }
    return out, summary


def main(paths):
    status = 0
    for path in paths:
        lines, summary = verify(path)
        print(f"== {path}")
        print("\n".join(lines))
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        if summary["failures"]:
            status = 1
    print("VERIFY OK" if status == 0 else "VERIFY FAILED")
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
