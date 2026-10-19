import io
import json
import threading
import time
import zipfile

import pytest
from starlette.testclient import TestClient

from export_service import main
from export_service.auth import AuthUnavailable, Identity
from export_service.contract import LIMITS
from export_service.limits import RateLimiter

GOOD = {"version": 1, "sheets": [{"name": "A", "rows": [["x", 1]]}]}
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class FakeVerifier:
    """The tokens GoTrue would tell apart, without GoTrue."""

    def __init__(self):
        self.calls = 0

    def verify(self, token):
        self.calls += 1
        if token == "down":
            raise AuthUnavailable("down")
        return {"user-a": Identity("a"), "user-b": Identity("b")}.get(token)


def client(**kwargs):
    app = main.create_app(kwargs.pop("verifier", FakeVerifier()), kwargs.pop("limiter", RateLimiter()))
    return TestClient(app, raise_server_exceptions=False)


def post(c, body=None, token="user-a", content_type="application/json", **headers):
    if body is None:
        body = json.dumps(GOOD)
    h = {"Content-Type": content_type, **headers}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return c.post("/workbook", content=body, headers=h)


def test_healthz_needs_no_token_and_says_nothing_else():
    r = client().get("/healthz")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


def test_a_signed_in_user_gets_a_workbook_written_by_openpyxl():
    r = post(client())
    assert r.status_code == 200
    assert r.headers["content-type"] == XLSX
    assert r.headers["cache-control"] == "no-store" and r.headers["x-request-id"]
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert b"<dc:creator>openpyxl</dc:creator>" in z.read("docProps/core.xml")


@pytest.mark.parametrize("token", [None, "", "anon-key", "garbage"])
def test_no_token_or_a_token_that_is_not_an_end_users_is_401(token):
    r = post(client(), token=token)
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthorized"
    # deploy.sh's probe greps the wire form of this answer; tests/deploy pins its side.
    assert '"code":"unauthorized"' in r.text


def test_the_body_is_not_read_for_an_unauthenticated_caller():
    # An oversized body from a caller who is not signed in is a 401, not a 413.
    big = "x" * (LIMITS["maxBodyBytes"] + 10)
    assert post(client(), body=big, token="anon-key").status_code == 401


def test_a_scheme_other_than_bearer_is_401():
    r = client().post("/workbook", content=json.dumps(GOOD), headers={"Content-Type": "application/json", "Authorization": "Basic user-a"})
    assert r.status_code == 401


def test_gotrue_being_down_is_503_not_401():
    r = post(client(), token="down")
    assert r.status_code == 503 and r.json()["error"]["code"] == "auth_unavailable"
    assert r.headers["retry-after"]


def test_wrong_media_type_is_415():
    assert post(client(), content_type="text/plain").status_code == 415


def test_an_oversized_declared_body_is_413():
    r = post(client(), body="x" * (LIMITS["maxBodyBytes"] + 1))
    assert r.status_code == 413 and r.json()["error"]["code"] == "payload_too_large"


def test_an_oversized_streamed_body_is_413():
    def chunks():
        for _ in range(LIMITS["maxBodyBytes"] // 65536 + 2):
            yield b"x" * 65536

    r = client().post("/workbook", content=chunks(), headers={"Content-Type": "application/json", "Authorization": "Bearer user-a"})
    assert r.status_code == 413


def test_contract_violations_are_422_with_a_code_and_a_place():
    body = json.dumps({"version": 1, "sheets": [{"name": "Belege", "rows": [["ok"], ["ok", True]]}]})
    r = post(client(), body=body)
    assert r.status_code == 422
    assert r.json()["error"] == {"code": "invalid_cell", "request_id": r.headers["x-request-id"], "sheet": "Belege", "row": 2, "column": 2}


def test_an_illegal_character_is_422_naming_the_cell():
    body = json.dumps({"version": 1, "sheets": [{"name": "Belege", "rows": [["a"], ["b", "x\u0001y"]]}]})
    r = post(client(), body=body)
    assert r.status_code == 422
    error = r.json()["error"]
    assert (error["code"], error["sheet"], error["row"], error["column"]) == ("illegal_character", "Belege", 2, 2)


def test_rate_limit_is_per_user_with_retry_after():
    c = client(limiter=RateLimiter(per_window=2, window_seconds=60))
    assert [post(c).status_code for _ in range(3)] == [200, 200, 429]
    refused = post(c)
    assert refused.json()["error"]["code"] == "rate_limited" and int(refused.headers["retry-after"]) >= 1
    assert post(c, token="user-b").status_code == 200


def test_concurrency_cap_answers_503_busy(monkeypatch):
    gate = threading.Event()
    entered = threading.Semaphore(0)
    real = main.build_xlsx

    def slow(workbook):
        entered.release()
        gate.wait(5)
        return real(workbook)

    monkeypatch.setattr(main, "build_xlsx", slow)
    c = client(limiter=RateLimiter(per_window=100))
    results = []
    threads = [threading.Thread(target=lambda: results.append(post(c).status_code)) for _ in range(main.MAX_CONCURRENT_BUILDS)]
    for t in threads:
        t.start()
    for _ in threads:
        assert entered.acquire(timeout=5)
    extra = post(c)
    gate.set()
    for t in threads:
        t.join()
    assert extra.status_code == 503 and extra.json()["error"]["code"] == "busy"
    assert results == [200] * main.MAX_CONCURRENT_BUILDS
    assert post(c).status_code == 200  # the slots came back


def test_a_build_past_its_deadline_is_504_and_frees_its_slot(monkeypatch):
    real = main.build_xlsx
    real_deadline = main.BUILD_DEADLINE_SECONDS
    monkeypatch.setattr(main, "BUILD_DEADLINE_SECONDS", 0.2)
    monkeypatch.setattr(main, "build_xlsx", lambda w: (time.sleep(0.6), real(w))[1])
    c = client(limiter=RateLimiter(per_window=100))
    r = post(c)
    assert r.status_code == 504 and r.json()["error"]["code"] == "timeout"
    time.sleep(0.8)
    # The deadline goes back with the build. This last request is the "frees its
    # slot" half of the name; left at 0.2 s it instead measures how fast a real
    # openpyxl build runs on the machine, which is not this test's subject and
    # not a property the service promises. That is what failed it on a loaded CI
    # runner on 19.10.2026 (504 where 200 was expected, the other 132 passing)
    # while it passed on every other run.
    monkeypatch.setattr(main, "build_xlsx", real)
    monkeypatch.setattr(main, "BUILD_DEADLINE_SECONDS", real_deadline)
    assert post(c).status_code == 200


def test_an_unexpected_failure_is_500_with_a_request_id_and_no_traceback(monkeypatch):
    def boom(_):
        raise RuntimeError("secret internals /srv/app")

    monkeypatch.setattr(main, "build_xlsx", boom)
    r = post(client())
    assert r.status_code == 500
    assert "secret" not in r.text and "Traceback" not in r.text
    assert r.json()["error"]["request_id"] == r.headers["x-request-id"]


def test_content_never_reaches_the_log(caplog):
    caplog.set_level("INFO")
    body = json.dumps({"version": 1, "sheets": [{"name": "A", "rows": [["GEHEIMER-INHALT-4711"]]}]})
    post(client(), body=body)
    assert "GEHEIMER-INHALT-4711" not in caplog.text


def test_only_post_on_workbook():
    c = client()
    assert c.get("/workbook").status_code == 405
    assert c.get("/nothing").status_code == 404
