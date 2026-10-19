"""The GoTrue verifier against a real HTTP server standing in for GoTrue."""
import json
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from export_service.auth import AuthUnavailable, GoTrueVerifier, Identity, bearer_token, identity_from_user

USER = {"id": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "aud": "authenticated"}


@pytest.mark.parametrize(
    "header,token",
    [("Bearer abc", "abc"), ("bearer abc", "abc"), ("Bearer  abc ", "abc"), ("Basic abc", None), ("Bearer", None), ("", None), (None, None)],
)
def test_bearer_token(header, token):
    assert bearer_token(header) == token


def test_an_end_user_is_accepted():
    assert identity_from_user(USER) == Identity(USER["id"])


@pytest.mark.parametrize(
    "document",
    [
        None,
        [],
        {},
        {**USER, "id": ""},
        {**USER, "id": None},
        {**USER, "role": "anon"},
        {**USER, "role": "service_role"},
        {**USER, "role": None},
        {**USER, "is_anonymous": True},
        {**USER, "banned_until": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()},
        {**USER, "banned_until": "not a date"},
    ],
)
def test_everything_that_is_not_an_end_user_is_refused(document):
    assert identity_from_user(document) is None


def test_a_ban_that_has_lapsed_does_not_refuse():
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    assert identity_from_user({**USER, "banned_until": past}) is not None


class FakeGoTrue:
    def __init__(self):
        self.seen = []
        self.status = 200
        self.body = USER
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                outer.seen.append((self.path, self.headers.get("Authorization")))
                payload = json.dumps(outer.body).encode()
                self.send_response(outer.status)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def gotrue():
    server = FakeGoTrue()
    yield server
    server.close()


def test_it_asks_gotrue_with_the_callers_own_token(gotrue):
    assert GoTrueVerifier(gotrue.url).verify("tok") == Identity(USER["id"])
    assert gotrue.seen == [("/user", "Bearer tok")]


def test_a_4xx_from_gotrue_is_a_refusal(gotrue):
    gotrue.status, gotrue.body = 401, {"msg": "invalid claim: missing sub claim"}
    assert GoTrueVerifier(gotrue.url).verify("anon") is None


def test_a_5xx_is_unavailable_not_a_refusal(gotrue):
    gotrue.status = 502
    with pytest.raises(AuthUnavailable):
        GoTrueVerifier(gotrue.url).verify("tok")


def test_unreachable_gotrue_is_unavailable():
    with pytest.raises(AuthUnavailable):
        GoTrueVerifier("http://127.0.0.1:1", timeout=0.5).verify("tok")


def test_a_positive_answer_is_cached_for_a_few_seconds_and_a_refusal_is_not(gotrue):
    now = [100.0]
    verifier = GoTrueVerifier(gotrue.url, clock=lambda: now[0])
    verifier.verify("tok")
    verifier.verify("tok")
    assert len(gotrue.seen) == 1
    now[0] += 31
    verifier.verify("tok")
    assert len(gotrue.seen) == 2
    gotrue.status = 401
    assert verifier.verify("other") is None
    assert verifier.verify("other") is None
    assert len(gotrue.seen) == 4


def test_the_cache_keeps_a_hash_never_the_token(gotrue):
    verifier = GoTrueVerifier(gotrue.url)
    verifier.verify("a-secret-token")
    assert "a-secret-token" not in repr(verifier._cache)
