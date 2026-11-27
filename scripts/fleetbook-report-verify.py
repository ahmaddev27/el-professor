"""Read the files of a simulated month back and check them, from their own bytes.

    python scripts/fleetbook-report-verify.py <SIMULIERT_Monatsbericht_….xlsx> <SIMULIERT_Betriebsbericht_….xlsx>
    python scripts/fleetbook-report-verify.py <SIMULIERT_Monatsabschluss_….xlsx>

External audit round 6. The month comes as two files: the Fahrtenbuch report
(passenger rides and cancellations) and the internal operational report (empty
drives, declined orders, scheduling). This script imports nothing from the
generator and nothing from JavaScript: it opens both files with openpyxl and
recomputes, in integer cents and on absolute instants (Europe/Berlin through
zoneinfo):

  - the label on every data row of every sheet, and no formula anywhere;
  - zero declined orders in the Fahrtenbuch report, in any sheet, by status
    and by id, and every one of them in the operational report;
  - the money of the report's own scope: fares, tips and cancellation fees of
    A re-summed against B, C, D; the cancellation fee per row against the
    company setting in I; the basis, amount, remainder and rate of F;
  - the calendar: every day of the month a row of B, 24 h or 23/25;
  - overlaps: no vehicle and no driver (by id) holds two rides at once;
  - shifts at most 360 minutes (no universal floor since Round 8: a shift is
    as long as its driver's plan), the last ride by the planned end, one shift
    per driver id and day, and the rest between them, from H2, O and I;
  - TÜV and confirmed full-day blocks, read from H and H2;
  - the route sheet G: one row per consecutive completed pair, its gap
    recomputed from A, and for a verified pair road + 45 s + margin <= gap;
  - every empty drive of L: it names a completed ride of A with the same
    vehicle, driver and shift, its margin is recomputed from the options in I,
    and a verified one fits its window;
  - the verdict in F is not VALIDATED while a pair is estimated, unverifiable
    or in conflict;
  - round 8, the return to the base: when I says "Ja", every shift with a
    completed ride ends with exactly one drive from its last ride's Zielort to
    the base coordinates of I, and when "Nein", no shift has one. A last
    drop-off at the base itself is recorded too, as a drive of nothing, so the
    rule has no exception a reader could not see.

The Monatsabschluss (round 8, section 10) is checked on its own: the seven
sheets and the notice, a label of SIMULIERT, IMPORTIERT or ABGELEITET on every
row, no declined order in its Fahrtenbuch, the fares and Uber's turnover
re-summed against the calendar total, every shift's empty kilometres against
its drives, the return drives against the base of sheet 7, every pay header
saying it is configuration, simulated or not booked, and the verdict in the
file name equal to sheet 7's.

One line per check; a check it cannot make says so and is never counted as
passed. Exit 1 when any check fails.
"""
import calendar
import json
import math
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from openpyxl import load_workbook

BERLIN = ZoneInfo("Europe/Berlin")
UTC = ZoneInfo("UTC")
REPORT_SHEETS = [
    "A Fahrten", "B Monatsuebersicht", "C Summe je Fahrer", "D Summe je Fahrzeug",
    "E Stornierungen", "F Pruefung und Grenzen", "G Routenpruefung",
    "H Ereignisse", "H2 Schichtentscheidungen", "I Quelle und Einstellungen", "SIMULIERT",
]
OPERATIONAL_SHEETS = [
    "L Leerfahrten", "M Abgelehnt intern", "N Interne Einnahmen", "O Schichtplanung",
    "I Quelle und Einstellungen", "SIMULIERT",
]
STATUSES = {"ROUTE_VERIFIED", "ROUTE_CONFLICT", "UNVERIFIABLE", "ESTIMATE_ONLY"}
HANDLING = 45
RETURN_PURPOSE = "letzter Zielort zurueck zum Betriebssitz"
CLOSING_SHEETS = [
    "Fahrtenbuch", "Fahrerschichten", "Lohn und Arbeitszeit", "Uber Tagesabgleich",
    "Fahrzeuge und Leerfahrten", "Kalendermonat", "Pruefung und Herkunft", "SIMULIERT",
]
CLOSING_LABELS = {"SIMULIERT", "IMPORTIERT", "ABGELEITET"}
VERDICTS = ("VALIDATED_FOR_EXPORT", "VERIFICATION_INCOMPLETE", "NOT_VALIDATED")


def cents(x):
    return round(float(x) * 100) if x not in (None, "") else 0


def instant(text):
    """'2026-10-25 02:30:00.123' on the Berlin clock, as an absolute UTC instant; None when not a time."""
    if not isinstance(text, str) or len(text) < 19:
        return None
    wall = datetime.strptime(text[:19], "%Y-%m-%d %H:%M:%S")
    millis = int(text[20:23]) if len(text) >= 23 and text[19] == "." else 0
    local = wall.replace(tzinfo=BERLIN, fold=0)
    back = local.astimezone(UTC).astimezone(BERLIN).replace(tzinfo=None)
    if back != wall:
        return None
    return local.astimezone(UTC) + timedelta(milliseconds=millis)


def table(book, name):
    rows = list(book[name].iter_rows(values_only=True))
    header = list(rows[0])
    return header, [dict(zip(header, r)) for r in rows[1:]]


class Checks:
    def __init__(self):
        self.lines, self.failures = [], []

    def __call__(self, ok, what, detail=""):
        self.lines.append(f"{'ok  ' if ok else 'FAIL'} {what}{'  ' + detail if detail else ''}")
        if not ok:
            self.failures.append(what)

    def info(self, text):
        self.lines.append(f"info {text}")


def labels(check, book, sheets, which):
    for name in sheets[:-1]:
        rows = list(book[name].iter_rows(values_only=True))
        bad = [i + 2 for i, r in enumerate(rows[1:]) if r[0] != "SIMULIERT"]
        check(rows[0][0] == "Kennzeichnung" and not bad, f"{which}: label on every row of {name}", f"{len(rows) - 1} rows")
    formulas = sum(1 for ws in book.worksheets for row in ws.iter_rows() for c in row if c.data_type == "f")
    check(formulas == 0, f"{which}: no formula anywhere", f"{formulas} formula cells")


def settings_of(book):
    _, rows = table(book, "I Quelle und Einstellungen")
    return {r["Angabe"]: r["Wert"] for r in rows}


def verify(report_path, ops_path):
    check = Checks()
    book = load_workbook(report_path, read_only=False)
    ops = load_workbook(ops_path, read_only=False)
    check(book.sheetnames == REPORT_SHEETS, "report: sheets and their order", " | ".join(book.sheetnames))
    check(ops.sheetnames == OPERATIONAL_SHEETS, "operational: sheets and their order", " | ".join(ops.sheetnames))
    labels(check, book, REPORT_SHEETS, "report")
    labels(check, ops, OPERATIONAL_SHEETS, "operational")
    source = settings_of(book)
    check(source == settings_of(ops), "both files carry the same source sheet (run id, seed, settings)",
          f"run {source.get('Lauf-ID')}")

    # ── A: the report's rides ────────────────────────────────────────────────
    _, rides = table(book, "A Fahrten")
    by_id = {r["Fahrt-ID"]: r for r in rides}
    done = [r for r in rides if r["Status"] == "abgeschlossen"]
    cancelled = [r for r in rides if r["Status"] == "storniert"]
    check([r["Nr"] for r in rides] == list(range(1, len(rides) + 1)), "A: row numbers 1..n without gap", f"{len(rides)} rides")
    check(len(by_id) == len(rides), "A: every Fahrt-ID unique")
    check({r["Status"] for r in rides} <= {"abgeschlossen", "storniert"}, "A: only completed and cancelled rides",
          json.dumps(Counter(r["Status"] for r in rides)))

    _, declined = table(ops, "M Abgelehnt intern")
    declined_ids = {r["Fahrt-ID"] for r in declined}
    leaks = []
    for ws in book.worksheets:
        for row in ws.iter_rows(values_only=True):
            if "abgelehnt" in row or any(isinstance(c, str) and c in declined_ids for c in row):
                leaks.append(ws.title)
    check(not leaks, "report: zero declined orders, by status and by id, in every sheet",
          f"{len(declined)} declined kept in M; leaks in {sorted(set(leaks))}")

    fare = sum(cents(r["Fahrpreis (EUR)"]) for r in done)
    tips = sum(cents(r["Trinkgeld (EUR)"]) for r in done)
    storno = sum(cents(r["Stornogebuehr (EUR)"]) for r in cancelled)
    charged = source.get("Einstellung cancellationFeeEnabled") == "Ja"
    unit = int(source.get("Einstellung cancellationFeeCents") or 0)
    expected_fee = unit if charged else 0
    check(all(cents(r["Stornogebuehr (EUR)"]) == expected_fee and cents(r["Fahrpreis (EUR)"]) == 0 for r in cancelled),
          "A: every cancellation carries the company fee and no fare", f"{len(cancelled)} x {expected_fee} cents")
    check(all(r["Finanzstatus"] for r in rides), "A: every ride states its financial status")
    check(all(cents(r["Stornogebuehr (EUR)"]) == 0 for r in done), "A: no completed ride carries a cancellation fee")

    for name, key in (("B Monatsuebersicht", "Datum"), ("C Summe je Fahrer", "Fahrer"), ("D Summe je Fahrzeug", "Fahrzeug")):
        _, rows = table(book, name)
        total = [r for r in rows if r[key] == "Summe"]
        parts = [r for r in rows if r[key] != "Summe"]
        ok = len(total) == 1
        for col, want in (("Fahrpreise (EUR)", fare), ("Trinkgeld (EUR)", tips), ("Stornogebuehren (EUR)", storno)):
            check(ok and cents(total[0][col]) == want == sum(cents(r[col]) for r in parts), f"{col} of A = Summe of {name} = its parts",
                  f"{want / 100:.2f} EUR")
        check(ok and total[0]["Fahrten"] == len(rides) == sum(r["Fahrten"] for r in parts), f"rides of A = Summe of {name} = its parts")
    _, e_rows = table(book, "E Stornierungen")
    check(len(e_rows) == len(cancelled) and sum(cents(r["Stornogebuehr (EUR)"]) for r in e_rows) == storno,
          "cancellations of A = sheet E", f"{len(e_rows)} rows, {storno / 100:.2f} EUR")

    # ── F: basis, share, verdict ─────────────────────────────────────────────
    _, f_rows = table(book, "F Pruefung und Grenzen")
    posten = {r["Posten"]: r["Wert / Summe der Teile"] for r in f_rows if r["Abschnitt"] == "Einnahmengrundlage und Monatsanteil"}
    verify_rows = {r["Posten"]: r for r in f_rows if r["Abschnitt"] == "Pruefung fuer den Export"}
    check(all(r["Ergebnis"] == "OK" and r["Differenz"] == 0 for r in f_rows if r["Abschnitt"] == "Abgleich"),
          "F: every reconciliation line is OK")
    basis = fare + (tips if posten.get("Trinkgeld in Grundlage") == "Ja" else 0)
    basis += storno if posten.get("Stornogebuehren in Grundlage") == "Ja" else 0
    check(cents(posten.get("Anspruchsberechtigte Einnahmen (EUR)")) == basis, "F: basis re-derived from A, no decline fee in it",
          f"{basis / 100:.2f} EUR")
    if "Satz (%)" in posten:
        amount, rest = cents(posten["Betrag (EUR)"]), cents(posten["Rest, falls Abzug (EUR)"])
        rate = float(posten["Satz (%)"])
        bp = round(rate * 100)
        check(amount + rest == basis, "F: amount + remainder = basis", f"{amount / 100:.2f} + {rest / 100:.2f}")
        check(bp in (3000, 3100, 3200, 3300) and amount == (basis * bp + 5000) // 10000,
              "F: rate is 30, 31, 32 or 33 % and amount = basis x rate", f"{rate} %")
    else:
        check(False, "F: the monthly share is in the file", "no 'Satz (%)' line")
    verdict = verify_rows.get("Exportstatus", {}).get("Wert / Summe der Teile")
    check(verdict in ("VALIDATED_FOR_EXPORT", "VERIFICATION_INCOMPLETE", "NOT_VALIDATED"), "F: states a verdict", str(verdict))
    check(str(verdict) in str(report_path), "the verdict is in the file name", str(verdict))

    # ── B: the calendar ──────────────────────────────────────────────────────
    _, b_rows = table(book, "B Monatsuebersicht")
    days = [r for r in b_rows if r["Datum"] != "Summe"]
    first = days[0]["Datum"]
    year, month = int(first[:4]), int(first[5:7])
    expected_days = [f"{year}-{month:02d}-{d:02d}" for d in range(1, calendar.monthrange(year, month)[1] + 1)]
    check([r["Datum"] for r in days] == expected_days, "B: every calendar day is a row", f"{len(days)} days")
    odd = {r["Datum"]: r["Stunden"] for r in days if r["Stunden"] != 24}
    check(all(h in (23, 25) for h in odd.values()), "B: a day is 24 h, or 23/25 on a clock change", json.dumps(odd))
    zero = [r for r in days if r["Tag ohne Fahrt"] == "Ja"]
    check(all(r["Fahrten"] == 0 and r["Grund"] for r in zero), "B: every zero-ride day has no ride and a reason", f"{len(zero)} days")

    # ── overlaps and shifts ──────────────────────────────────────────────────
    unreadable = [r["Fahrt-ID"] for r in done if not (instant(r["Fahrtbeginn"]) and instant(r["Fahrtende"]))]
    check(not unreadable, "A: every completed ride has a readable start and end", f"{len(unreadable)} unreadable")

    def overlaps(key):
        groups = defaultdict(list)
        for r in done:
            s, e = instant(r["Fahrtbeginn"]), instant(r["Fahrtende"])
            if s and e:
                groups[r[key]].append((s, e))
        return sum(sum(1 for a, b in zip(sorted(v), sorted(v)[1:]) if b[0] < a[1]) for v in groups.values())
    check(overlaps("Kennzeichen") == 0, "no vehicle holds two rides at once")
    check(overlaps("Fahrer-ID") == 0, "no driver (by id) holds two rides at once")

    _, decisions = table(book, "H2 Schichtentscheidungen")
    accepted = [d for d in decisions if str(d["Ergebnis"]).startswith("eingeplant")]
    lengths = [(instant(d["Schichtende"] + ".000") - instant(d["Schichtbeginn"] + ".000")).total_seconds() / 60 for d in accepted]
    outside = [round(m) for m in lengths if m <= 0 or m > 360]
    check(accepted and not outside, "H2: every accepted shift is longer than 0 and at most 360 minutes",
          f"{len(accepted)} shifts, min {round(min(lengths))} max {round(max(lengths))}" if lengths else "no shift")
    _, planning = table(ops, "O Schichtplanung")
    planned = [r for r in planning if r["Art"] == "Schicht eingeplant"]
    spans = [(r, instant(r["Beginn"]), instant(r["Geplantes Ende"]), instant(r["Ende"])) for r in planned]
    unreadable = [r["Schicht"] for r, b, p, e in spans if not (b and p and e)]
    too_long = [r["Schicht"] for r, b, p, e in spans if b and p and (p - b).total_seconds() / 60 > 360]
    late = [r["Schicht"] for r, b, p, e in spans if p and e and e > p]
    check(len(planned) == len(accepted) and not unreadable and not too_long and not late,
          "O: the same shifts, each planned for at most 360 minutes, the last ride by its planned end",
          f"{len(planned)} shifts; {len(unreadable)} unreadable, {len(too_long)} over 360, {len(late)} ending late")
    per_day = Counter((r["Fahrer-ID"], str(r["Tag"])) for r in planned)
    twice = sorted(k for k, n in per_day.items() if n > 1)
    check(all(r["Fahrer-ID"] for r in planned) and not twice, "O: every shift names its driver id, at most one per driver and day",
          f"{len(per_day)} driver-days" + (f"; twice: {twice[:3]}" if twice else ""))
    rest = settings_of(book).get("Option minDriverRestMinutes")
    if isinstance(rest, (int, float)):
        by_driver = defaultdict(list)
        for r, b, p, e in spans:
            if b and p:
                by_driver[r["Fahrer-ID"]].append((b, p))
        short_rest = sum(1 for v in by_driver.values() for a, b in zip(sorted(v), sorted(v)[1:])
                         if (b[0] - a[1]).total_seconds() / 60 < rest)
        check(short_rest == 0, f"O: at least {rest} minutes of rest between two shifts of one driver",
              f"{short_rest} pairs short")
    else:
        check(False, "O: rest between two shifts of one driver", "cannot be checked: I names no Option minDriverRestMinutes")

    blocked_days = {(r["Kennzeichen"], str(r["Tag"])) for r in decisions if r.get("Code") == "vehicle_tuev_expired"}
    on_blocked = [r["Fahrt-ID"] for r in done if (r["Kennzeichen"], str(r["Datum der Fahrt"])) in blocked_days]
    check(not on_blocked, "no ride of a vehicle on a day its TÜV had expired", f"{len(blocked_days)} vehicle-days blocked")

    _, events = table(book, "H Ereignisse")

    def window(text):
        parts = str(text or "").split(" bis ")
        if len(parts) != 2 or len(parts[0]) != 10 or len(parts[1]) != 10:
            return None
        a = datetime.strptime(parts[0], "%Y-%m-%d").replace(tzinfo=BERLIN)
        b = (datetime.strptime(parts[1], "%Y-%m-%d") + timedelta(days=1)).replace(tzinfo=BERLIN)
        return a, b
    confirmed = [e for e in events if e.get("Betrifft") == "Fahrer" and e.get("Quelle") == "driver_note"
                 and e.get("Sicherheit") == "bestaetigt" and e.get("Wirkung") == "hard_block"]
    inside = []
    for e in confirmed:
        w = window(e.get("Zeitraum"))
        if w is None:
            check(False, "a confirmed block with clock times", "not checked by this script")
            continue
        for r in done:
            s_, e_ = instant(r["Fahrtbeginn"]), instant(r["Fahrtende"])
            if r["Fahrer"] == e.get("Bezeichnung") and s_ and e_ and s_ < w[1] and e_ > w[0]:
                inside.append(r["Fahrt-ID"])
    check(not inside, "no ride of a driver inside a confirmed full-day block", f"{len(confirmed)} blocks")
    review = Counter(d["Code"] for d in decisions if d["Ergebnis"] == "eingeplant, zu pruefen")
    check.info(f"shifts accepted for human review, by cause: {json.dumps(review)}")

    # ── G: the route check ───────────────────────────────────────────────────
    margin_s = int(source.get("Option repositioningMarginSeconds") or 0)
    margin_p = float(source.get("Option repositioningMarginPercent") or 0)

    def margin(road):
        return margin_s + math.ceil(road * margin_p / 100)

    _, g_rows = table(book, "G Routenpruefung")
    pairs = set()
    for key in ("Kennzeichen", "Fahrer-ID"):
        groups = defaultdict(list)
        for r in done:
            groups[r[key]].append((instant(r["Fahrtbeginn"]), r["Fahrt-ID"]))
        for spans in groups.values():
            spans.sort()
            pairs |= {(key, a[1], b[1]) for a, b in zip(spans, spans[1:])}
    check(len(g_rows) == len(pairs), "G: one row per consecutive completed pair (vehicle and driver)",
          f"{len(g_rows)} rows, {len(pairs)} pairs")
    status = Counter(r["Status"] for r in g_rows)
    check(set(status) <= STATUSES, "G: only the four statuses", json.dumps(status))
    gap_wrong, fit_wrong = [], []
    for r in g_rows:
        a, b = by_id.get(r["Fahrt-ID frueher"]), by_id.get(r["Fahrt-ID spaeter"])
        if not (a and b):
            gap_wrong.append(r["Fahrt-ID frueher"])
            continue
        gap = round((instant(b["Fahrtbeginn"]) - instant(a["Fahrtende"])).total_seconds())
        if gap != r["Luecke (s)"]:
            gap_wrong.append(r["Fahrt-ID frueher"])
        if r["Status"] == "ROUTE_VERIFIED":
            need = r["Fahrzeit Strasse (s)"] + HANDLING + margin(r["Fahrzeit Strasse (s)"])
            if need != r["Benoetigt (s)"] or gap < need:
                fit_wrong.append(r["Fahrt-ID frueher"])
    check(not gap_wrong, "G: every gap recomputed from A's own times", f"{len(gap_wrong)} differ")
    check(not fit_wrong, "G: every verified pair holds road + 45 s + margin", f"{len(fit_wrong)} do not")
    same_shift_bad = [r for r in g_rows if r["Gleiche Schicht"] == "Ja" and r["Status"] in ("ROUTE_CONFLICT", "UNVERIFIABLE")]
    check(not same_shift_bad, "G: no conflict and no unverifiable pair inside a shift", f"{len(same_shift_bad)}")
    open_pairs = status.get("ROUTE_CONFLICT", 0) + status.get("UNVERIFIABLE", 0) + status.get("ESTIMATE_ONLY", 0)
    check(not (open_pairs and verdict == "VALIDATED_FOR_EXPORT"), "F: not VALIDATED while a pair is open",
          f"{open_pairs} open pairs, verdict {verdict}")

    # ── L: the empty drives ──────────────────────────────────────────────────
    _, legs = table(ops, "L Leerfahrten")
    leg_status = Counter(r["Pruefstatus"] for r in legs)
    check(set(leg_status) <= STATUSES, "L: only the four statuses", json.dumps(leg_status))
    check({(r["Art"], r["Bezeichnung"], r["Datenart"]) for r in legs} == {("REPOSITIONING", "LEERFAHRT", "SIMULATED")},
          "L: every record is a simulated REPOSITIONING / LEERFAHRT", f"{len(legs)} legs")
    check({r["Lauf-ID"] for r in legs} == {source.get("Lauf-ID")}, "L: one run id, the source sheet's")
    orphan, owner_wrong, leg_bad = [], [], []
    returns_home = source.get("Rueckkehr zum Betriebssitz am Schichtende")
    base_point = (source.get("Betriebssitz Breite"), source.get("Betriebssitz Laenge"))
    home_legs = [leg for leg in legs if leg["Zweck"] == RETURN_PURPOSE]
    for leg in home_legs:
        prev = by_id.get(leg["Fahrt-ID vorher"]) if leg["Fahrt-ID vorher"] else None
        if not prev or prev["Status"] != "abgeschlossen":
            orphan.append(leg["Leerfahrt-ID"])
            continue
        if (prev["Kennzeichen"], prev["Fahrer-ID"], prev["Schicht"]) != (leg["Kennzeichen"], leg["Fahrer-ID"], leg["Schicht"]):
            owner_wrong.append(leg["Leerfahrt-ID"])
        if leg["Von"] != prev["Zielort"] or (leg["Nach Breite"], leg["Nach Laenge"]) != base_point or leg["Fahrt-ID nachher"]:
            leg_bad.append(leg["Leerfahrt-ID"])
        if leg["Pruefstatus"] == "ROUTE_VERIFIED":
            road = leg["Fahrzeit Strasse (s)"]
            need = road + margin(road)
            arrive, depart = instant(leg["Ankunft"]), instant(leg["Abfahrt"])
            if need != leg["Benoetigt (s)"] or leg["Verfuegbar (s)"] < need or not (arrive and depart) \
                    or round((arrive - depart).total_seconds()) != road or depart != instant(prev["Fahrtende"]):
                leg_bad.append(leg["Leerfahrt-ID"])
    check(returns_home in ("Ja", "Nein"), "I: says whether shifts return to the base", str(returns_home))
    last_ride = {}
    for r in done:
        if r["Schicht"] not in last_ride or instant(r["Fahrtbeginn"]) > instant(last_ride[r["Schicht"]]["Fahrtbeginn"]):
            last_ride[r["Schicht"]] = r
    home_by_shift = Counter(leg["Schicht"] for leg in home_legs)
    if returns_home == "Ja":
        missing = [s for s in last_ride if home_by_shift.get(s, 0) != 1]
        wrong_start = [leg["Leerfahrt-ID"] for leg in home_legs if leg["Fahrt-ID vorher"] != last_ride.get(leg["Schicht"], {}).get("Fahrt-ID")]
        check(not missing, "L: every shift with a completed ride returns to the base exactly once", f"{len(missing)} of {len(last_ride)} do not")
        check(not wrong_start, "L: every return starts at its shift's last completed ride", f"{len(wrong_start)} do not")
    else:
        check(not home_legs, "L: no return to the base in a month that does not return", f"{len(home_legs)} returns")
    for leg in legs:
        if leg["Zweck"] == RETURN_PURPOSE:
            continue
        nxt = by_id.get(leg["Fahrt-ID nachher"])
        if not nxt or nxt["Status"] != "abgeschlossen":
            orphan.append(leg["Leerfahrt-ID"])
            continue
        if (nxt["Kennzeichen"], nxt["Fahrer-ID"], nxt["Schicht"]) != (leg["Kennzeichen"], leg["Fahrer-ID"], leg["Schicht"]):
            owner_wrong.append(leg["Leerfahrt-ID"])
        if leg["Zweck"] != "Zielort zum Warteplatz" and leg["Nach"] != nxt["Abholort"]:
            leg_bad.append(leg["Leerfahrt-ID"])
        prev = by_id.get(leg["Fahrt-ID vorher"]) if leg["Fahrt-ID vorher"] else None
        if leg["Zweck"] in ("Zielort zum Warteplatz",) and (not prev or leg["Von"] != prev["Zielort"]):
            leg_bad.append(leg["Leerfahrt-ID"])
        if leg["Pruefstatus"] == "ROUTE_VERIFIED":
            road = leg["Fahrzeit Strasse (s)"]
            handling = 0 if leg["Zweck"] == "Zielort zum Warteplatz" else HANDLING
            need = road + handling + margin(road)
            arrive = instant(leg["Ankunft"])
            depart = instant(leg["Abfahrt"])
            if need != leg["Benoetigt (s)"] or leg["Verfuegbar (s)"] < need or not (arrive and depart) \
                    or round((arrive - depart).total_seconds()) != road:
                leg_bad.append(leg["Leerfahrt-ID"])
    check(not orphan, "L: every leg ends at a completed ride of A", f"{len(orphan)} do not")
    check(not owner_wrong, "L: every leg carries its ride's vehicle, driver and shift", f"{len(owner_wrong)} differ")
    check(not leg_bad, "L: every verified leg's places, arrival and margin re-derive and fit", f"{len(set(leg_bad))} do not")
    with_road = [r for r in legs if r["Fahrzeit Strasse (s)"] not in (None, "")]
    preferred = [r for r in with_road if r["Im Wunschfenster 2-5 min"] == "Ja"]
    check.info(f"{len(preferred)} of {len(with_road)} legs with a route are 2-5 minutes; "
               f"longest {max((r['Fahrzeit Strasse (s)'] for r in with_road), default=0)} s; "
               f"{sum(float(r['Strecke (km)'] or 0) for r in with_road):.1f} empty km")

    # ── M, N: declined orders, internal ──────────────────────────────────────
    fee_unit = int(source.get("Einstellung declinedFeeCents") or 0)
    check(all(cents(r["Ablehnungsgebuehr intern (EUR)"]) == fee_unit and r["Gebuehrenregel"] == "idle_in_shift" for r in declined),
          "M: every declined order carries the decline fee and its rule", f"{len(declined)} x {fee_unit} cents")
    _, revenue = table(ops, "N Interne Einnahmen")
    total = next((r for r in revenue if r["Posten"] == "Abgelehnte Auftraege gesamt"), None)
    check(total is not None and total["Anzahl"] == len(declined) and cents(total["Betrag (EUR)"]) == len(declined) * fee_unit,
          "N: the internal total equals M", f"{len(declined) * fee_unit / 100:.2f} EUR, not in the Fahrtenbuch")

    summary = {
        "report": report_path, "operational": ops_path, "verdict": verdict, "runId": source.get("Lauf-ID"),
        "rides": len(rides), "completed": len(done), "cancelled": len(cancelled), "declinedInternal": len(declined),
        "fareCents": fare, "tipCents": tips, "cancellationFeeCents": storno, "declinedFeeCentsInternal": len(declined) * fee_unit,
        "routeChecks": len(g_rows), "routeStatuses": dict(status), "legs": len(legs), "legStatuses": dict(leg_status),
        "shifts": len(accepted), "days": len(days), "zeroRideDays": len(zero),
    }
    return check, summary


def verify_closing(path):
    check = Checks()
    book = load_workbook(path, read_only=False)
    check(book.sheetnames == CLOSING_SHEETS, "closing: sheets and their order", " | ".join(book.sheetnames))
    for name in CLOSING_SHEETS[:-1]:
        rows = list(book[name].iter_rows(values_only=True))
        bad = [i + 2 for i, r in enumerate(rows[1:]) if r[0] not in CLOSING_LABELS]
        check(rows[0][0] == "Kennzeichnung" and not bad, f"closing: a source label on every row of {name}",
              f"{len(rows) - 1} rows, {json.dumps(Counter(r[0] for r in rows[1:]))}")
    formulas = sum(1 for ws in book.worksheets for row in ws.iter_rows() for c in row if c.data_type == "f")
    check(formulas == 0, "closing: no formula anywhere", f"{formulas} formula cells")
    _, info = table(book, "Pruefung und Herkunft")
    facts = {r["Angabe"]: r["Wert"] for r in info}

    _, rides = table(book, "Fahrtenbuch")
    statuses = Counter(r["Status"] for r in rides)
    check(set(statuses) <= {"abgeschlossen", "storniert"}, "1: only completed and cancelled rides, no declined order", json.dumps(statuses))
    real = [r for r in rides if r["Kennzeichnung"] == "IMPORTIERT"]
    check(all(r["Finanzstatus"] == "wie importiert, unveraendert" for r in real), "1: every real trip as imported", f"{len(real)} real trips")
    ids = [r["Fahrt-ID"] for r in rides]
    check(len(set(ids)) == len(ids), "1: every Fahrt-ID unique", f"{len(ids)} rides")
    real_days = {(r["Fahrer-ID"], r["Betriebstag"]) for r in real}
    over = [r["Fahrt-ID"] for r in rides if r["Kennzeichnung"] == "SIMULIERT" and (r["Fahrer-ID"], r["Betriebstag"]) in real_days]
    check(not over, "1: no simulated ride on a driver-day that holds real trips", f"{len(over)} rides")

    _, days = table(book, "Kalendermonat")
    total = days[-1] if days else {}
    check(total.get("Datum") == "Summe", "6: the last row is the total")
    month_days = [r for r in days if isinstance(r.get("Datum"), str) and r["Datum"][:4].isdigit()]
    if month_days:
        y, m = int(month_days[0]["Datum"][:4]), int(month_days[0]["Datum"][5:7])
        check([r["Datum"] for r in month_days] == [f"{y}-{m:02d}-{d:02d}" for d in range(1, calendar.monthrange(y, m)[1] + 1)],
              "6: one row per calendar day, none missing", f"{len(month_days)} days")
    sim = sum(cents(r["Fahrpreis (EUR)"]) for r in rides if r["Kennzeichnung"] == "SIMULIERT" and r["Status"] == "abgeschlossen")
    check(sim == cents(total.get("Fahrpreise simuliert (EUR)")), "1 = 6: simulated fares", f"{sim / 100:.2f} EUR")
    if all(isinstance(r["Fahrpreis (EUR)"], (int, float)) for r in real):
        actual = sum(cents(r["Fahrpreis (EUR)"]) for r in real if r["Status"] == "abgeschlossen")
        check(actual == cents(total.get("Fahrpreise echt (EUR, importiert)")), "1 = 6: real fares", f"{actual / 100:.2f} EUR")
    else:
        check.info("1 = 6: a real fare is unreadable, the real total is not compared")
    for col in [c for c in total if c and c not in ("Kennzeichnung", "Datum", "Wochentag", "Tag ohne Aktivitaet") and isinstance(total[c], (int, float))]:
        parts = [r[col] for r in days[:-1] if isinstance(r.get(col), (int, float))]
        step = 1 if "(EUR" not in col else 100
        check(round(sum(parts) * step) == round(total[col] * step), f"6: the total of {col} is the sum of its rows")

    _, uber = table(book, "Uber Tagesabgleich")
    read = facts.get("Pruefsumme Uber-Zahlen") != "nicht gelesen"
    counted_rows = [r for r in uber if r["Zeilenart"] in ("Tag", "Woche im Monat")]
    if read:
        umsatz = sum(cents(r["Umsatz (EUR, importiert)"]) for r in counted_rows if isinstance(r["Umsatz (EUR, importiert)"], (int, float)))
        check(umsatz == cents(total.get("Umsatz importiert (EUR)")), "4 = 6: Uber turnover inside the month", f"{umsatz / 100:.2f} EUR")
    else:
        check(all(r["Umsatz (EUR, importiert)"] == "nicht gelesen" for r in counted_rows),
              "4: Uber not read, and no row pretends a figure")
    # The gap (D1, 27.11.2026) is shown, never closed: Umsatz minus simulated and real fares, on every day with figures.
    gap_header = "Differenz Umsatz - Fahrpreise (EUR, angezeigt, nicht ausgeglichen)"
    gap_rows = [r for r in uber if r["Zeilenart"] == "Tag" and isinstance(r.get(gap_header), (int, float))]
    wrong_gap = [r for r in gap_rows if cents(r[gap_header]) != cents(r["Umsatz (EUR, importiert)"])
                 - cents(r["Simulierte Fahrpreise (EUR, nicht tatsaechlich)"])
                 - (0 if r["Echte Fahrpreise (EUR, importiert)"] in ("", None) else cents(r["Echte Fahrpreise (EUR, importiert)"]))]
    check(gap_header in (uber[0] if uber else {}) and not wrong_gap, "4: the gap is Umsatz minus simulated and real fares",
          f"{len(gap_rows)} days, {len(wrong_gap)} wrong")
    across = [r for r in uber if str(r["Zeilenart"]).startswith("Woche ueber die Monatsgrenze")]
    check(all(r["Status"] == "INCOMPLETE" for r in across), "4: a week across the month boundary stays INCOMPLETE", f"{len(across)} weeks")
    failed = [r for r in uber if r["Status"] == "FAILED"]
    open_rows = [r for r in uber if r["Status"] in ("FAILED", "INCOMPLETE")]
    status = facts.get("Finanzabgleich mit Uber (getrennt vom Exportstatus)")
    check(not open_rows or status in ("INCOMPLETE", "FAILED"), "7: the financial status is not settled while a row of 4 is open",
          f"{len(open_rows)} open rows, status {status}")
    check(not failed or status == "FAILED", "7: a FAILED row of 4 fails the financial status", f"{len(failed)}")
    # RECONCILED exists since D1 (27.11.2026): the month may read it only when every row of 4 does.
    statuses = ("RECONCILED", "CONFIGURATION_REQUIRED", "INCOMPLETE", "FAILED")
    check(status in statuses and all(r["Status"] in statuses for r in uber), "7: every status is one of the four", str(status))
    unsettled = [r for r in uber if r["Status"] != "RECONCILED"]
    check(status != "RECONCILED" or not unsettled, "7: RECONCILED only when every row of 4 is",
          f"{len(unsettled)} rows not reconciled, status {status}")

    _, vehicles = table(book, "Fahrzeuge und Leerfahrten")
    legs = defaultdict(list)
    for r in vehicles:
        if r["Zeilenart"] == "Leerfahrt":
            legs[r["Schicht-ID"]].append(r)
    shifts = [r for r in vehicles if r["Zeilenart"] == "Schicht"]
    km_wrong = [s["Schicht-ID"] for s in shifts if isinstance(s["Leer-km"], (int, float))
                and cents(s["Leer-km"]) != sum(cents(r["Leer-km"]) for r in legs[s["Schicht-ID"]])]
    check(not km_wrong, "5: every shift's empty km is the sum of its drives", f"{len(km_wrong)} of {len(shifts)} differ")
    _, shift_rows = table(book, "Fahrerschichten")
    check(len(shift_rows) == len(shifts), "2 = 5: one row per shift in both", f"{len(shift_rows)} / {len(shifts)}")
    returns_home = facts.get("Rueckkehr zum Betriebssitz am Schichtende")
    base = (facts.get("Betriebssitz Breite"), facts.get("Betriebssitz Laenge"))
    home = [r for r in vehicles if r["Zweck"] == "Rueckkehr zum Betriebssitz"]
    check(returns_home in ("Ja", "Nein"), "7: says whether shifts return to the base", str(returns_home))
    with_rides = {r["Schicht"] for r in rides if r["Kennzeichnung"] == "SIMULIERT" and r["Status"] == "abgeschlossen"}
    if returns_home == "Ja":
        per_shift = Counter(r["Schicht-ID"] for r in home)
        missing = [s for s in with_rides if per_shift.get(s, 0) != 1]
        check(not missing, "5: every shift with a completed ride returns to the base exactly once", f"{len(missing)} of {len(with_rides)} do not")
        off_base = [r["Leerfahrt-ID"] for r in home if (r["Ziel Breite"], r["Ziel Laenge"]) != base]
        check(not off_base, "5: every return ends at the base of sheet 7", f"{len(off_base)} do not")
        last = {s: max(rs, key=lambda r: instant(r["Abfahrt"]) or instant("1970-01-01 00:00:00")) for s, rs in legs.items()}
        not_last = [r["Leerfahrt-ID"] for r in home if last[r["Schicht-ID"]]["Leerfahrt-ID"] != r["Leerfahrt-ID"]]
        check(not not_last, "5: the return is the shift's last drive", f"{len(not_last)} are not")
    else:
        check(not home, "5: no return to the base in a month that does not return", f"{len(home)} returns")

    header, _ = table(book, "Lohn und Arbeitszeit")
    loose = [h for h in header if h and any(w in h for w in ("Lohn", "Gehalt", "Provision")) and "EUR" in h
             and not any(w in h for w in ("Konfiguration", "simuliert", "nicht gebucht"))]
    check(not loose, "3: every pay figure says configuration, simulated, or computed and not booked", "; ".join(loose))

    verdict = str(facts.get("Exportstatus") or "").split(" - ")[0]
    named = next((v for v in VERDICTS if v in Path(path).name), None)
    check(verdict in VERDICTS and verdict == named, "7 = file name: the export verdict", f"{verdict} / {named}")
    estimate = facts.get("Routing") == "nur Schaetzung"
    check(estimate == ("ESTIMATE_ONLY" in Path(path).name), "7 = file name: an estimate says so in the name")
    summary = {
        "closing": path, "verdict": verdict, "financialStatus": status, "rides": len(rides), "realTrips": len(real),
        "shifts": len(shifts), "returns": len(home), "days": len(month_days),
    }
    return check, summary


def main(argv):
    # The console's code page is not UTF-8 everywhere (Windows: cp1252, cp1256); the report is German.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if len(argv) == 2 and "Monatsabschluss" in Path(argv[1]).name:
        check, summary = verify_closing(argv[1])
    elif len(argv) == 3:
        check, summary = verify(argv[1], argv[2])
    else:
        print(__doc__)
        return 2
    print("\n".join(check.lines))
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print("VERIFY FAILED: " + "; ".join(check.failures) if check.failures else "VERIFY OK")
    return 1 if check.failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
