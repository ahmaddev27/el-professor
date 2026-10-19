# Excel export service

Writes every operational Excel file El-Professor produces, with Python's
`openpyxl`. The companies that receive these files check the writer, so the
files must be written by openpyxl and by nothing else. This is the owner's
decision of 19.10.2026 and it is not reopened here.

The browser posts the rows it already holds; the service answers the same rows
as an `.xlsx`. Formatting is plain, like the files the same companies get from
other tools (headers in row 1, data from row 2): values, numbers as numbers, and a number format where a value needs
one. No fonts, fills, borders, alignment, widths, freeze panes, filters or
merges, and the payload has no field to ask for any of them.

## The rule this service's safety rests on

**This service has no database connection, no service-role key, no JWT secret
and no volume. A user can only receive what they sent.**

That is the whole authorization model: there is nothing here to authorize
against, because there is nothing here to read. The moment this service is given
a database connection or a service-role key (or any path to data it was not
handed in the request), that argument is gone and every route needs real
authorization, row by row, as the edge functions have. Do not add either without
redoing that analysis first. `tests/deploy/export-service.test.ts` fails the
build if the compose service gains a credential, a volume or a published port.

It also cannot mint tokens: it does not hold `JWT_SECRET`. To learn who a caller
is it asks GoTrue (`GET /auth/v1/user`, from inside the Docker network, with the
caller's own bearer token). That also catches a banned account and a revoked
session, which a local signature check would not.

## What it accepts

`POST /workbook` with `Authorization: Bearer <a signed-in user's access token>`
and `Content-Type: application/json`:

```json
{"version": 1, "sheets": [{"name": "Belege", "rows": [
  ["Datum", "Betrag"],
  ["19.10.2026", {"t": "n", "v": 41.47, "fmt": "#,##0.00\\ \"€\""}]
]}]}
```

A cell is `null` (nothing written), a string (always written as a string, never a
formula, whatever it starts with), a number, or a tagged object:
`{"t":"s","v":…}`, `{"t":"n","v":…,"fmt":…}`, `{"t":"d","v":"2026-10-19","fmt":…}`.
`fmt` must be one of `numberFormats` in `export_service/contract.json`; the
browser keeps a copy of that list in `src/lib/workbookContract.ts` and a test
fails when the two differ. The same file holds the limits.

A sheet may carry `"header": true` (the only optional sheet key, and only `true`): row 1 then gets the one style the header cells of Uber's own files have, bold with a thin border on all four sides, centred horizontally and top-aligned. It is the only styling the contract can ask for.

`GET /healthz` answers `{"status":"ok"}` with no token.

The anon key is a token this stack signed and ships in the browser bundle, so
the gateway's own token check proves nothing here. A token that is not an end
user's (no `sub`, role other than `authenticated`, anonymous, banned) is a 401.

## Answers

200 is the workbook. Every other answer is
`{"error": {"code": …, "request_id": …, "sheet"?, "row"?, "column"?}}` with a
stable `code`, and every answer carries `X-Request-Id`. A cell's content is never
logged.

| status | codes | meaning |
|---|---|---|
| 401 | `unauthorized` | no token, or not an end user's token |
| 413 | `payload_too_large` | over 8 MiB |
| 415 | `unsupported_media_type` | not `application/json` |
| 422 | `invalid_payload`, `invalid_cell`, `invalid_sheet_name`, `invalid_number_format`, `unsupported_version`, `cell_too_long`, `too_many_rows`, `too_many_columns`, `too_many_cells`, `illegal_character` | the content cannot be written; sheet, row and column are 1-based and name the cell |
| 429 | `rate_limited` | 30 per user per minute; `Retry-After` says when |
| 503 | `busy`, `auth_unavailable` | two builds already running, or GoTrue could not be asked |
| 504 | `timeout` | a build took over 30 s |
| 500 | `internal` | a bug; the `request_id` finds it in the log |

## Two hazards openpyxl brings

- **Formula injection.** openpyxl treats a string starting with `=` as a formula.
  Every string cell is written with an explicit string type, so a Beleg
  description of `=HYPERLINK(...)` is data. Tested with `=`, `+`, `-`, `@` and a
  leading tab.
- **Control characters.** openpyxl raises on them; the service turns that into
  `illegal_character` naming the cell, never a 500.

## The signature, asserted

`tests/test_signature.py` writes real files and asserts `dc:creator` is
`openpyxl`, that the zip entries are exactly openpyxl's, in its order, and that
no part only Excel itself adds (`calcChain.xml`, thumbnails, printer settings,
custom XML, shared strings) is present.

## Run the tests

```
pip install --require-hashes --only-binary=:all: --no-deps -r requirements.txt
pip install -r requirements-dev.txt
python -m pytest tests
```

CI runs these (`.github/workflows/pr-checks.yml`, job `export-service`).

## Deploying

It is the one image in the stack that is built, not pulled. `deploy/deploy.sh`
builds it from the release archive before anything else changes and refuses the
release if the build fails; afterwards it probes `/export/v1/workbook` through the
gateway with the anon key and expects this service's own 401. Kong routes
`/export/v1/` to it (`deploy/kong.yml`), so Caddy is untouched. No host port.
The base image is pinned by digest and the packages by hash; to move either,
change `Dockerfile` or regenerate `requirements.txt` and say why in the commit.
