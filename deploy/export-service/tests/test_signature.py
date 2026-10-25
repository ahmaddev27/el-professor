"""The point of the service, asserted rather than assumed.

A file that passes through here must be written by openpyxl, and must look like
openpyxl wrote it: the creator, the order of the parts in the zip, and none of
the parts only Excel itself adds. Run against the real library, not a stub.
"""
import io
import zipfile

import pytest
from openpyxl import load_workbook

from export_service.contract import ContractError, parse_payload
from export_service.writer import build_xlsx

# What openpyxl 3.1.5 writes, in the order it writes it. If a release of the
# library reorders these, this test fails and the change is read, not skipped.
OPENPYXL_PARTS = [
    "docProps/app.xml",
    "docProps/core.xml",
    "xl/theme/theme1.xml",
    "xl/worksheets/sheet1.xml",
    "xl/styles.xml",
    "_rels/.rels",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "[Content_Types].xml",
]

EXCEL_ONLY_MARKERS = ("calcChain", "thumbnail", "printerSettings", "customXml", "metadata", "sharedStrings")


def write(*sheets):
    import json

    payload = {"version": 1, "sheets": [{"name": n, "rows": r} for n, r in sheets]}
    return build_xlsx(parse_payload(json.dumps(payload).encode()))


def parts(data):
    return zipfile.ZipFile(io.BytesIO(data))


def test_creator_is_openpyxl_and_nothing_else_is_named():
    data = write(("Belege", [["Datum", "Betrag"], ["x", 1.5]]))
    core = parts(data).read("docProps/core.xml").decode()
    assert "<dc:creator>openpyxl</dc:creator>" in core
    assert "lastModifiedBy" not in core
    assert "professor" not in core.lower()


def test_zip_entries_are_exactly_openpyxls_in_openpyxls_order():
    names = [i.filename for i in parts(write(("A", [["x"]]))).infolist()]
    assert names == OPENPYXL_PARTS


def test_no_part_that_only_excel_adds():
    names = parts(write(("A", [["x", 1]], ), ("B", [["y"]]))).namelist()
    for marker in EXCEL_ONLY_MARKERS:
        assert not any(marker in n for n in names), marker
    assert "xl/calcChain.xml" not in names


def test_every_part_is_deflated_and_the_package_has_one_sheet_part_per_sheet():
    z = parts(write(("A", [["x"]]), ("B", [["y"]])))
    assert {i.compress_type for i in z.infolist()} == {zipfile.ZIP_DEFLATED}
    assert [n for n in z.namelist() if n.startswith("xl/worksheets/")] == [
        "xl/worksheets/sheet1.xml",
        "xl/worksheets/sheet2.xml",
    ]


def test_plain_means_no_style_beyond_openpyxls_defaults():
    data = write(("A", [["Kopf", {"t": "n", "v": 1.5, "fmt": "#,##0.00"}]]))
    sheet = parts(data).read("xl/worksheets/sheet1.xml").decode()
    for absent in ("<cols", "<pane", "<autoFilter", "<mergeCell", "<sheetFormatPr customHeight"):
        assert absent not in sheet
    styles = parts(data).read("xl/styles.xml").decode()
    assert '<fonts count="1">' in styles and '<borders count="1">' in styles
    assert '<fills count="2">' in styles


def test_header_true_gives_row_one_ubers_style_and_nothing_else_is_styled():
    import json

    payload = {"version": 1, "sheets": [{"name": "A", "header": True, "rows": [["Kopf", "Zahl"], ["x", 1.5]]}]}
    data = build_xlsx(parse_payload(json.dumps(payload).encode()))
    ws = load_workbook(io.BytesIO(data))["A"]
    for cell in ws[1]:
        assert cell.font.b is True
        assert (cell.border.left.style, cell.border.right.style, cell.border.top.style, cell.border.bottom.style) == ("thin",) * 4
        assert (cell.alignment.horizontal, cell.alignment.vertical) == ("center", "top")
    for cell in ws[2]:
        assert not cell.font.b and cell.border.left.style is None and cell.alignment.horizontal is None
    sheet = parts(data).read("xl/worksheets/sheet1.xml").decode()
    for absent in ("<cols", "<pane", "<autoFilter", "<mergeCell"):
        assert absent not in sheet


def _data_cells_with_a_style(sheet_xml):
    """Cells below row 1 that carry an s attribute (a style index)."""
    import re

    return [
        cell
        for row, body in re.findall(r'<row r="(\d+)"[^>]*>(.*?)</row>', sheet_xml)
        if row != "1"
        for cell in re.findall(r"<c [^>]*>", body)
        if ' s="' in cell
    ]


def test_bare_numbers_leave_data_cells_with_no_style_index_no_numfmt_and_no_cols():
    """Uber's file: header cells s="1", data cells no s attribute, zero numFmt, no cols."""
    import json

    # Built with the header flag, as the browser sends an operational export.
    payload = {"version": 1, "sheets": [{"name": "A", "header": True, "rows": [["Datum", "Kilometer", "Betrag"], ["13.10.2026", 25880, 55.1], ["14.10.2026", 341, 0]]}]}
    data = build_xlsx(parse_payload(json.dumps(payload).encode()))
    sheet = parts(data).read("xl/worksheets/sheet1.xml").decode()
    styles = parts(data).read("xl/styles.xml").decode()
    assert _data_cells_with_a_style(sheet) == []
    assert "<numFmt " not in styles
    assert "<cols" not in sheet
    assert sheet.count(' s="1"') == 3  # exactly the three header cells
    assert 'count="2"' in styles.split("<cellXfs")[1].split(">")[0]  # the whole style table: default + header


def test_negative_control_a_number_format_or_a_style_would_be_caught():
    """The assertions above are not vacuous: put a format back and they fail."""
    import json

    payload = {"version": 1, "sheets": [{"name": "A", "header": True, "rows": [["Kopf"], [{"t": "n", "v": 55.1, "fmt": '#,##0.00\\ "€"'}]]}]}
    data = build_xlsx(parse_payload(json.dumps(payload).encode()))
    assert _data_cells_with_a_style(parts(data).read("xl/worksheets/sheet1.xml").decode()) != []
    assert "<numFmt " in parts(data).read("xl/styles.xml").decode()


def test_no_header_flag_leaves_the_sheet_unstyled():
    ws = load_workbook(io.BytesIO(write(("A", [["Kopf"]]))))["A"]
    assert not ws["A1"].font.b and ws["A1"].border.left.style is None


def test_numbers_stay_numbers_and_dates_stay_dates():
    data = write(
        (
            "A",
            [
                [
                    12.5,
                    7,
                    {"t": "n", "v": 2.049, "fmt": "#,##0.000"},
                    {"t": "n", "v": 41.47, "fmt": '#,##0.00\\ "€"'},
                    {"t": "d", "v": "2026-10-19", "fmt": "dd.mm.yyyy"},
                    {"t": "d", "v": "2026-10-19T08:30", "fmt": "dd.mm.yyyy\\ hh:mm"},
                ]
            ],
        )
    )
    cells = list(load_workbook(io.BytesIO(data))["A"][1])
    assert [c.data_type for c in cells] == ["n", "n", "n", "n", "d", "d"]
    assert cells[0].value == 12.5 and cells[1].value == 7
    assert cells[2].number_format == "#,##0.000"
    assert cells[3].number_format == '#,##0.00\\ "€"'
    assert cells[4].number_format == "dd.mm.yyyy"


@pytest.mark.parametrize(
    "text",
    [
        '=HYPERLINK("http://evil.example","x")',
        "=1+1",
        "+SUM(A1:A2)",
        "-2+3",
        "@SUM(1)",
        "\t=1+1",
        "=cmd|' /C calc'!A0",
    ],
)
def test_a_string_is_never_a_formula(text):
    data = write(("A", [[text, {"t": "s", "v": text}]]))
    sheet = parts(data).read("xl/worksheets/sheet1.xml").decode()
    assert "<f>" not in sheet and "<f " not in sheet
    cells = list(load_workbook(io.BytesIO(data))["A"][1])
    assert [c.data_type for c in cells] == ["s", "s"]
    assert [c.value for c in cells] == [text, text]


def test_markup_in_a_string_is_text():
    data = write(("A", [["<script>alert(1)</script> & <b>"]]))
    assert load_workbook(io.BytesIO(data))["A"]["A1"].value == "<script>alert(1)</script> & <b>"


@pytest.mark.parametrize("bad", ["\x00", "\x01", "\x08", "\x0b", "\x1f"])
def test_a_control_character_is_a_named_rejection_with_its_place(bad):
    with pytest.raises(ContractError) as caught:
        write(("Belege", [["ok"], ["fine", f"bad{bad}text"]]))
    error = caught.value
    assert (error.code, error.sheet, error.row, error.column) == ("illegal_character", "Belege", 2, 2)


def test_tab_newline_and_carriage_return_are_allowed_in_text():
    data = write(("A", [["a\tb\nc\rd"]]))
    # XML readers normalise a bare carriage return to a line feed; that is the
    # format, not the writer, so the comparison is on the normalised text.
    assert load_workbook(io.BytesIO(data))["A"]["A1"].value == "a\tb\nc\nd"


def test_umlauts_euro_sign_and_astral_characters_survive():
    text = "Müller-Lüdenscheidt € 50 – Fahrt 🚕"
    assert load_workbook(io.BytesIO(write(("A", [[text]]))))["A"]["A1"].value == text


def test_empty_cells_are_not_written_and_the_row_positions_hold():
    data = write(("A", [[None, "b"], [], [None, None, "c"]]))
    ws = load_workbook(io.BytesIO(data))["A"]
    assert ws["B1"].value == "b" and ws["C3"].value == "c" and ws["A1"].value is None
