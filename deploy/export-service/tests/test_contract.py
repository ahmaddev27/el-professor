import json

import pytest

from export_service.contract import LIMITS, NUMBER_FORMATS, ContractError, parse_payload


def parse(document):
    return parse_payload(json.dumps(document).encode())


def sheet(rows, name="A"):
    return {"version": 1, "sheets": [{"name": name, "rows": rows}]}


def code(document):
    with pytest.raises(ContractError) as caught:
        parse(document)
    return caught.value


def test_a_minimal_workbook_parses():
    workbook = parse(sheet([["a", 1, None, {"t": "n", "v": 2, "fmt": "#,##0"}]]))
    assert workbook.sheets[0].name == "A"


@pytest.mark.parametrize(
    "bad",
    [
        [],
        "x",
        {"version": 1},
        {"version": 1, "sheets": [], },
        {"version": 2, "sheets": [{"name": "A", "rows": []}]},
        {"version": True, "sheets": [{"name": "A", "rows": []}]},
        {"version": 1, "sheets": [{"name": "A", "rows": []}], "style": {}},
        {"version": 1, "sheets": [{"name": "A", "rows": [], "widths": [10]}]},
    ],
)
def test_the_shape_is_closed(bad):
    code(bad)


def test_header_is_the_one_optional_sheet_key_and_only_true():
    base = {"name": "A", "rows": []}
    assert parse({"version": 1, "sheets": [{**base, "header": True}]}).sheets[0].header is True
    assert parse({"version": 1, "sheets": [base]}).sheets[0].header is False
    for bad in (False, 1, "true", None):
        assert code({"version": 1, "sheets": [{**base, "header": bad}]}).code == "invalid_payload"


@pytest.mark.parametrize("key", ["font", "fill", "border", "alignment", "width", "freeze", "autofilter", "merge", "style"])
def test_there_is_no_field_for_formatting(key):
    assert code(sheet([[{"t": "n", "v": 1, key: "x"}]])).code == "invalid_cell"


@pytest.mark.parametrize(
    "name",
    ["", "a" * 32, "a/b", "a\\b", "a?b", "a*b", "a:b", "a[b", "a]b", " a", "a ", "'a", "a'", "History", "history", "a\x00b"],
)
def test_sheet_names_excel_would_refuse(name):
    assert code(sheet([], name)).code == "invalid_sheet_name"


def test_sheet_names_are_unique_ignoring_case():
    document = {"version": 1, "sheets": [{"name": "Abc", "rows": []}, {"name": "aBC", "rows": []}]}
    assert code(document).code == "invalid_sheet_name"


def test_an_unknown_number_format_is_refused_so_a_caller_cannot_inject_one():
    assert code(sheet([[{"t": "n", "v": 1, "fmt": '0;[Red]"x"'}]])).code == "invalid_number_format"


def test_every_listed_format_is_accepted():
    for fmt in NUMBER_FORMATS:
        parse(sheet([[{"t": "n", "v": 1, "fmt": fmt}]]))


@pytest.mark.parametrize("value", [True, False, [], {}, "x"])
def test_a_number_cell_holds_a_number(value):
    assert code(sheet([[{"t": "n", "v": value}]])).code == "invalid_cell"


@pytest.mark.parametrize("raw", [b"NaN", b"Infinity", b"-Infinity", b"1e999"])
def test_non_finite_numbers_are_refused(raw):
    body = b'{"version":1,"sheets":[{"name":"A","rows":[[' + raw + b"]]}]}"
    with pytest.raises(ContractError):
        parse_payload(body)


def test_a_huge_integer_is_refused_not_a_crash():
    body = b'{"version":1,"sheets":[{"name":"A","rows":[[1' + b"0" * 400 + b"]]}]}"
    with pytest.raises(ContractError):
        parse_payload(body)


def test_a_boolean_is_not_a_cell():
    assert code(sheet([[True]])).code == "invalid_cell"


@pytest.mark.parametrize("value", ["2026-13-01", "19.10.2026", "2026-10-19T25:00", "2026-10-19T08:30+02:00", 5, None])
def test_dates_are_iso_without_a_zone(value):
    assert code(sheet([[{"t": "d", "v": value}]])).code == "invalid_cell"


def test_error_carries_sheet_row_and_column_one_based():
    error = code(sheet([["ok"], ["ok", True]], "Belege"))
    assert (error.sheet, error.row, error.column) == ("Belege", 2, 2)


def test_a_cell_longer_than_excel_holds_is_refused():
    assert code(sheet([["x" * (LIMITS["maxStringLength"] + 1)]])).code == "cell_too_long"
    parse(sheet([["x" * LIMITS["maxStringLength"]]]))


def test_cell_budget_is_global_across_sheets():
    row = [None] * LIMITS["maxColumns"]
    rows = [row] * (LIMITS["maxCells"] // LIMITS["maxColumns"] + 2)
    assert code(sheet(rows)).code == "too_many_cells"


def test_column_and_row_caps():
    assert code(sheet([[None] * (LIMITS["maxColumns"] + 1)])).code == "too_many_columns"
    assert code(sheet([[]] * (LIMITS["maxRowsPerSheet"] + 1))).code == "too_many_rows"


def test_not_json_is_a_named_rejection():
    with pytest.raises(ContractError) as caught:
        parse_payload(b"\xff\xfe not json")
    assert caught.value.code == "invalid_payload"


def test_deep_nesting_is_a_rejection_not_a_crash():
    with pytest.raises(ContractError):
        parse_payload(b"[" * 100000)
