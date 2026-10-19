"""The HTTP surface: POST /workbook and GET /healthz.

Order of a workbook request, cheapest refusal first and nothing read before the
caller is known: who is asking (GoTrue), how often, the declared size, the body
(streamed against a cap), the contract, then openpyxl on a worker thread under a
deadline. Every answer carries X-Request-Id, and an error is
`{"error": {"code", "request_id", ...}}` with a stable code the browser maps to a
sentence. A cell's content is never logged.
"""
from __future__ import annotations

import asyncio
import logging
import os
import threading
import uuid
from typing import Any

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from .auth import AuthUnavailable, GoTrueVerifier, Verifier, bearer_token
from .contract import LIMITS, ContractError, parse_payload
from .limits import RateLimiter
from .writer import build_xlsx

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
BUILD_DEADLINE_SECONDS = 30.0
MAX_CONCURRENT_BUILDS = 2

log = logging.getLogger("export_service")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


class Refusal(Exception):
    def __init__(self, status: int, code: str, headers: dict[str, str] | None = None, **fields: Any) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.headers = headers or {}
        self.fields = fields


def create_app(verifier: Verifier | None = None, limiter: RateLimiter | None = None) -> Starlette:
    verifier = verifier or GoTrueVerifier(os.environ.get("GOTRUE_URL", "http://auth:9999"))
    limiter = limiter or RateLimiter()
    slots = threading.BoundedSemaphore(MAX_CONCURRENT_BUILDS)

    async def healthz(_: Request) -> Response:
        return JSONResponse({"status": "ok"}, headers={"Cache-Control": "no-store"})

    async def workbook(request: Request) -> Response:
        request_id = uuid.uuid4().hex
        try:
            identity = await _authenticate(request, verifier)
            _throttle(limiter, identity.user_id)
            raw = await _read_body(request)
            data = await _build(raw, slots)
        except Refusal as refusal:
            return _error(request_id, refusal)
        except ContractError as error:
            return _error(request_id, _from_contract(error))
        except Exception:  # noqa: BLE001 - the one place that must not leak a traceback
            log.exception("request %s failed", request_id)
            return _error(request_id, Refusal(500, "internal"))
        log.info("request %s ok bytes_in=%d bytes_out=%d", request_id, len(raw), len(data))
        return Response(
            data,
            media_type=XLSX_MIME,
            headers={
                "Content-Disposition": 'attachment; filename="export.xlsx"',
                "Cache-Control": "no-store",
                "X-Request-Id": request_id,
            },
        )

    return Starlette(
        routes=[Route("/healthz", healthz, methods=["GET"]), Route("/workbook", workbook, methods=["POST"])],
    )


async def _authenticate(request: Request, verifier: Verifier):
    token = bearer_token(request.headers.get("authorization"))
    if token is None:
        raise Refusal(401, "unauthorized")
    try:
        identity = await run_in_threadpool(verifier.verify, token)
    except AuthUnavailable as error:
        log.warning("authentication unavailable: %s", error)
        raise Refusal(503, "auth_unavailable", {"Retry-After": "5"}) from error
    if identity is None:
        raise Refusal(401, "unauthorized")
    return identity


def _throttle(limiter: RateLimiter, user_id: str) -> None:
    wait = limiter.check(user_id)
    if wait is not None:
        seconds = str(int(wait) + 1)
        raise Refusal(429, "rate_limited", {"Retry-After": seconds}, retry_after=int(seconds))


async def _read_body(request: Request) -> bytes:
    limit = LIMITS["maxBodyBytes"]
    if not request.headers.get("content-type", "").lower().startswith("application/json"):
        raise Refusal(415, "unsupported_media_type")
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise Refusal(413, "payload_too_large", limit=limit)
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise Refusal(413, "payload_too_large", limit=limit)
        chunks.append(chunk)
    return b"".join(chunks)


async def _build(raw: bytes, slots: threading.BoundedSemaphore) -> bytes:
    if not slots.acquire(blocking=False):
        raise Refusal(503, "busy", {"Retry-After": "3"})

    def work() -> bytes:
        try:
            return build_xlsx(parse_payload(raw))
        finally:
            slots.release()

    try:
        return await asyncio.wait_for(run_in_threadpool(work), BUILD_DEADLINE_SECONDS)
    except asyncio.TimeoutError as error:
        raise Refusal(504, "timeout") from error


def _from_contract(error: ContractError) -> Refusal:
    fields = {k: v for k, v in (("sheet", error.sheet), ("row", error.row), ("column", error.column)) if v is not None}
    return Refusal(422, error.code, **fields)


def _error(request_id: str, refusal: Refusal) -> JSONResponse:
    body = {"error": {"code": refusal.code, "request_id": request_id, **refusal.fields}}
    headers = {"X-Request-Id": request_id, "Cache-Control": "no-store", **refusal.headers}
    return JSONResponse(body, status_code=refusal.status, headers=headers)


app = create_app()
