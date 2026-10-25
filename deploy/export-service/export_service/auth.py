"""Who may ask this service for a file.

The gateway's own token check proves a caller holds a token this stack signed.
The anon key is such a token and ships in the browser bundle, so that proves
nothing here. This service therefore asks GoTrue, with the caller's own token,
who the caller is:

  - no signature secret lives in this container (a service that held JWT_SECRET
    could mint service_role tokens, and this one holds no credentials at all);
  - GoTrue also refuses a revoked session and reports a banned account, which a
    local signature check would not.

The answer is cached for a few seconds per token so a user pressing Export
repeatedly does not become a GoTrue request each time. The cache holds only the
hash of a token, never the token.
"""
from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

CACHE_SECONDS = 30
CACHE_MAX_ENTRIES = 1024


class AuthUnavailable(Exception):
    """GoTrue could not be asked. Not the caller's fault, and not a refusal."""


@dataclass(frozen=True)
class Identity:
    user_id: str


class Verifier(Protocol):
    def verify(self, token: str) -> Identity | None:
        """The caller's identity, or None when the token is not an end user's."""


def bearer_token(header: str | None) -> str | None:
    if not header:
        return None
    scheme, _, token = header.partition(" ")
    token = token.strip()
    return token if scheme.lower() == "bearer" and token else None


def identity_from_user(document: object, now: datetime | None = None) -> Identity | None:
    """GoTrue's `GET /user` answer, judged.

    An end user has a `sub` (GoTrue's `id`), the `authenticated` role, is not an
    anonymous account and is not banned. The anon and service keys fail the
    first of these inside GoTrue itself; the role check is the second wall.
    """
    if not isinstance(document, dict):
        return None
    user_id = document.get("id")
    if not isinstance(user_id, str) or not user_id:
        return None
    if document.get("role") != "authenticated" or document.get("is_anonymous") is True:
        return None
    if _is_banned(document.get("banned_until"), now or datetime.now(timezone.utc)):
        return None
    return Identity(user_id)


def _is_banned(value: object, now: datetime) -> bool:
    if not value:
        return False
    if not isinstance(value, str):
        return True
    try:
        until = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return True
    if until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    return until > now


class GoTrueVerifier:
    def __init__(self, base_url: str, timeout: float = 3.0, clock=time.monotonic) -> None:
        self._url = base_url.rstrip("/") + "/user"
        self._timeout = timeout
        self._clock = clock
        self._cache: dict[str, tuple[float, Identity]] = {}

    def verify(self, token: str) -> Identity | None:
        key = hashlib.sha256(token.encode("utf-8")).hexdigest()
        cached = self._cache.get(key)
        if cached and cached[0] > self._clock():
            return cached[1]
        identity = self._ask(token)
        if identity is not None:
            self._remember(key, identity)
        return identity

    def _remember(self, key: str, identity: Identity) -> None:
        if len(self._cache) >= CACHE_MAX_ENTRIES:
            now = self._clock()
            self._cache = {k: v for k, v in self._cache.items() if v[0] > now}
            if len(self._cache) >= CACHE_MAX_ENTRIES:
                self._cache.clear()
        self._cache[key] = (self._clock() + CACHE_SECONDS, identity)

    def _ask(self, token: str) -> Identity | None:
        request = urllib.request.Request(self._url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:  # noqa: S310
                document = json.loads(response.read(65536))
        except urllib.error.HTTPError as error:
            if 400 <= error.code < 500:
                return None
            raise AuthUnavailable(f"GoTrue answered {error.code}") from error
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            raise AuthUnavailable("GoTrue could not be reached") from error
        return identity_from_user(document)
