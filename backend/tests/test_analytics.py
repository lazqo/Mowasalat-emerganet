"""Demand analytics must never write a cell that could describe one passenger."""
from datetime import datetime, timedelta, timezone

from wenak.analytics import flush_closed_buckets, record_wait

T0 = datetime(2026, 9, 21, 8, 30, tzinfo=timezone.utc)
LATER = T0 + timedelta(hours=2)


def _rows(client):
    return client.portal.call(client.app.state.db.demand_stats.find({}, {"_id": 0}).to_list, 100)


def _run(client, coro):
    return client.portal.call(lambda: coro)


def test_single_wait_never_reaches_mongo(client):
    st, s = client.app.state.store, client.app.state.settings
    _run(client, record_wait(st, s, "irbid_malka", 0, 4.0, T0))
    _run(client, flush_closed_buckets(st, client.app.state.db, s, LATER))
    assert _rows(client) == []


def test_open_hour_is_not_flushed(client):
    st, s = client.app.state.store, client.app.state.settings
    for _ in range(10):
        _run(client, record_wait(st, s, "irbid_malka", 0, 4.0, T0))
    _run(client, flush_closed_buckets(st, client.app.state.db, s, T0 + timedelta(minutes=10)))
    assert _rows(client) == []


def test_cell_at_threshold_is_written_as_segment_hour(app_client):
    with app_client(analytics_k_min=5) as c:
        st, s = c.app.state.store, c.app.state.settings
        for _ in range(5):
            _run(c, record_wait(st, s, "irbid_malka", 0, 4.4, T0))
        stats = _run(c, flush_closed_buckets(st, c.app.state.db, s, LATER))
        assert stats == {"written": 1, "merged": 0, "coarse_written": 0}
        assert _rows(c) == [{"route_id": "irbid_malka", "direction": 0, "segment": 1,
                             "bucket": "2026-09-21T08", "requests": 5}]


def test_small_cells_merge_into_daily_remainder(app_client):
    with app_client(analytics_k_min=5) as c:
        st, s = c.app.state.store, c.app.state.settings
        # 2 + 2 in different segments/hours of the same day: still below k
        for _ in range(2):
            _run(c, record_wait(st, s, "irbid_malka", 0, 1.0, T0))
        for _ in range(2):
            _run(c, record_wait(st, s, "irbid_malka", 0, 15.0, T0 + timedelta(hours=1)))
        _run(c, flush_closed_buckets(st, c.app.state.db, s, LATER + timedelta(hours=1)))
        assert _rows(c) == []
        # one more (in a later closed hour) pushes the daily remainder to k -> coarse row only
        _run(c, record_wait(st, s, "irbid_malka", 0, 9.0, T0 + timedelta(hours=3)))
        _run(c, flush_closed_buckets(st, c.app.state.db, s, LATER + timedelta(hours=3)))
        assert _rows(c) == [{"route_id": "irbid_malka", "direction": 0, "segment": "all",
                             "bucket": "2026-09-21", "requests": 5}]


def test_wait_endpoint_records_into_redis_not_mongo(client):
    r = client.post("/api/passenger/wait", json={"destination_id": "malka", "route_id": "irbid_malka",
                                                 "direction": 0, "wait_progress_km": 4.44})
    assert r.status_code == 200
    assert r.json()["wait_progress_km"] == 4.4  # coarsened to 100 m
    assert _rows(client) == []
    keys = client.portal.call(client.app.state.redis.keys, "dem:*")
    assert len(keys) == 1 and keys[0].endswith(":irbid_malka:0:1")
