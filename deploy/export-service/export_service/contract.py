"""The payload contract, version 1, and its validation.

The payload carries VALUES and number formats only. It has no field for a font,
a fill, a border, an alignment, a column width, a freeze pane, a filter or a
merge, so a caller cannot ask for one: formatting is literally plain, like the
files this product's customers already receive from other tools.

    {"version": 1, "sheets": [{"name": "Belege", "rows": [[Cell | null, ...], ...]}]}

    Cell = "text"                          written as a string, never a formula
         | 12.5                            written as a number
         | {"t": "s", "v": "text"}         the same string, spelled out
         | {"t": "n", "v": 12.5, "fmt": F} a number with a number format
         | {"t": "d", "v": "2026-10-19" or "2026-10-19T08:30[:00]", "fmt": F}
                                           a date or date-time, no time zone

F is one of `numberFormats` in contract.json, which the browser client keeps a
copy of; a test fails when the two lists differ.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Union

_CONTRACT = json.loads(Path(__file__).with_name("contract.json").read_text(encoding="utf-8"))

VERSION: int = _CONTRACT["version"]
CREATOR: str = _CONTRACT["creator"]
NUMBER_FORMATS: frozenset[str] = frozenset(_CONTRACT["numberFormats"])
LIMITS: dict[str, int] = _CONTRACT["limits"]

_FORBIDDEN_SHEET_CHARS = re.compile(r"[\[\]:*?/\\\x00-\x1f]")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$")


class ContractError(Exception):
    """The caller sent something this service will not write.

    `code` is stable and machine-readable; the browser turns it into a sentence
    in the user's language. Row and column are 1-based, as Excel counts them.
    """

    def __init__(
        self,
        code: str,
        detail: str = "",
        *,
        sheet: str | None = None,
        row: int | None = None,
        column: int | None = None,
    ) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail
        self.sheet = sheet
        self.row = row
        self.column = column


@dataclass(frozen=True)
class Text:
    value: str


@dataclass(frozen=True)
class Number:
    value: Union[int, float]
    fmt: str | None


@dataclass(frozen=True)
class Moment:
    value: Union[date, datetime]
    fmt: str | None


Cell = Union[Text, Number, Moment, None]


@dataclass(frozen=True)
class Sheet:
    name: str
    rows: list[list[Cell]]


@dataclass(frozen=True)
class Workbook:
    sheets: list[Sheet]


def _reject_constant(name: str) -> None:
    raise ContractError("invalid_payload", f"{name} is not a number Excel can hold")


def parse_payload(raw: bytes) -> Workbook:
    try:
        document = json.loads(raw, parse_constant=_reject_constant)
    except ContractError:
        raise
    except (ValueError, UnicodeDecodeError, RecursionError) as error:
        raise ContractError("invalid_payload", "the body is not valid JSON") from error
    return _workbook(document)


def _workbook(document: object) -> Workbook:
    if not isinstance(document, dict) or set(document) != {"version", "sheets"}:
        raise ContractError("invalid_payload", "expected exactly the keys version and sheets")
    if document["version"] != VERSION or isinstance(document["version"], bool):
        raise ContractError("unsupported_version", f"this service reads version {VERSION}")
    sheets = document["sheets"]
    if not isinstance(sheets, list) or not 1 <= len(sheets) <= LIMITS["maxSheets"]:
        raise ContractError("invalid_payload", f"between 1 and {LIMITS['maxSheets']} sheets")
    budget = [LIMITS["maxCells"]]
    parsed = [_sheet(item, budget) for item in sheets]
    _unique_names(parsed)
    return Workbook(parsed)


def _unique_names(sheets: list[Sheet]) -> None:
    seen: set[str] = set()
    for sheet in sheets:
        key = sheet.name.casefold()
        if key in seen:
            raise ContractError("invalid_sheet_name", "sheet names must be unique", sheet=sheet.name)
        seen.add(key)


def _sheet(item: object, budget: list[int]) -> Sheet:
    if not isinstance(item, dict) or set(item) != {"name", "rows"}:
        raise ContractError("invalid_payload", "a sheet has exactly the keys name and rows")
    name = _sheet_name(item["name"])
    rows = item["rows"]
    if not isinstance(rows, list) or len(rows) > LIMITS["maxRowsPerSheet"]:
        raise ContractError("too_many_rows", f"at most {LIMITS['maxRowsPerSheet']} rows", sheet=name)
    return Sheet(name, [_row(row, name, index, budget) for index, row in enumerate(rows, 1)])


def _sheet_name(name: object) -> str:
    ok = (
        isinstance(name, str)
        and 1 <= len(name) <= LIMITS["maxSheetNameLength"]
        and name.strip() == name
        and not _FORBIDDEN_SHEET_CHARS.search(name)
        and not name.startswith("'")
        and not name.endswith("'")
        and name.casefold() != "history"
    )
    if not ok:
        shown = name if isinstance(name, str) else ""
        raise ContractError("invalid_sheet_name", "not a name Excel accepts", sheet=shown[:40])
    return name  # type: ignore[return-value]


def _row(row: object, sheet: str, number: int, budget: list[int]) -> list[Cell]:
    if not isinstance(row, list) or len(row) > LIMITS["maxColumns"]:
        raise ContractError("too_many_columns", f"at most {LIMITS['maxColumns']} columns", sheet=sheet, row=number)
    budget[0] -= len(row)
    if budget[0] < 0:
        raise ContractError("too_many_cells", f"at most {LIMITS['maxCells']} cells in all", sheet=sheet, row=number)
    return [_cell(cell, sheet, number, column) for column, cell in enumerate(row, 1)]


def _cell(cell: object, sheet: str, row: int, column: int) -> Cell:
    where = {"sheet": sheet, "row": row, "column": column}
    if cell is None:
        return None
    if isinstance(cell, str):
        return _text(cell, where)
    if isinstance(cell, (int, float)) and not isinstance(cell, bool):
        return _number(cell, None, where)
    if isinstance(cell, dict):
        return _tagged(cell, where)
    raise ContractError("invalid_cell", "a cell is null, a string, a number or a tagged object", **where)


def _tagged(cell: dict, where: dict) -> Cell:
    allowed = {"s": {"t", "v"}, "n": {"t", "v", "fmt"}, "d": {"t", "v", "fmt"}}
    kind = cell.get("t")
    if not isinstance(kind, str) or kind not in allowed or not set(cell) <= allowed[kind] or "v" not in cell:
        raise ContractError("invalid_cell", "unknown or incomplete tagged cell", **where)
    fmt = _format(cell.get("fmt"), where)
    if kind == "s":
        return _text(cell["v"], where)
    if kind == "n":
        return _number(cell["v"], fmt, where)
    return _moment(cell["v"], fmt, where)


def _format(fmt: object, where: dict) -> str | None:
    if fmt is None:
        return None
    if not isinstance(fmt, str) or fmt not in NUMBER_FORMATS:
        raise ContractError("invalid_number_format", "not one of the formats in the contract", **where)
    return fmt


def _text(value: object, where: dict) -> Text:
    if not isinstance(value, str):
        raise ContractError("invalid_cell", "a string cell holds a string", **where)
    if len(value) > LIMITS["maxStringLength"]:
        raise ContractError("cell_too_long", f"Excel holds at most {LIMITS['maxStringLength']} characters", **where)
    return Text(value)


def _number(value: object, fmt: str | None, where: dict) -> Number:
    try:
        usable = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    except OverflowError:  # an integer too large for a float
        usable = False
    if not usable:
        raise ContractError("invalid_cell", "a number cell holds a finite number", **where)
    return Number(value, fmt)  # type: ignore[arg-type]


def _moment(value: object, fmt: str | None, where: dict) -> Moment:
    try:
        if isinstance(value, str) and _DATE.match(value):
            return Moment(date.fromisoformat(value), fmt)
        if isinstance(value, str) and _DATETIME.match(value):
            return Moment(datetime.fromisoformat(value), fmt)
    except ValueError:
        pass
    raise ContractError("invalid_cell", "a date is YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS]", **where)
