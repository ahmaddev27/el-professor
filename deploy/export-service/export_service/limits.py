"""Per-user rate limiting, kept in this process.

One instance, one worker: the counts live in memory and a restart forgets them,
which is fine for a limit whose job is to stop a runaway button, not to meter.
"""
from __future__ import annotations

import time
from collections import deque


class RateLimiter:
    def __init__(self, per_window: int = 30, window_seconds: float = 60.0, clock=time.monotonic) -> None:
        self._per_window = per_window
        self._window = window_seconds
        self._clock = clock
        self._seen: dict[str, deque[float]] = {}

    def check(self, key: str) -> float | None:
        """None when the call may go ahead, otherwise the seconds to wait."""
        now = self._clock()
        calls = self._seen.setdefault(key, deque())
        while calls and calls[0] <= now - self._window:
            calls.popleft()
        if len(calls) >= self._per_window:
            return max(1.0, calls[0] + self._window - now)
        calls.append(now)
        if len(self._seen) > 4096:
            self._forget_idle(now)
        return None

    def _forget_idle(self, now: float) -> None:
        self._seen = {k: v for k, v in self._seen.items() if v and v[-1] > now - self._window}
