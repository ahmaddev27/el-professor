from export_service.limits import RateLimiter


def test_window_slides_and_reports_the_wait():
    now = [0.0]
    limiter = RateLimiter(per_window=2, window_seconds=10, clock=lambda: now[0])
    assert limiter.check("u") is None
    now[0] = 1
    assert limiter.check("u") is None
    wait = limiter.check("u")
    assert wait is not None and 8.5 <= wait <= 9.5
    now[0] = 10.5
    assert limiter.check("u") is None


def test_users_do_not_share_a_budget():
    limiter = RateLimiter(per_window=1)
    assert limiter.check("a") is None and limiter.check("b") is None
    assert limiter.check("a") is not None
