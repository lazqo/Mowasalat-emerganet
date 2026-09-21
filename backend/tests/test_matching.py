from wenak.matching import approaching_buses, waiting_ahead


def _trip(km, speed=40, name="bus-a"):
    return {"progress_km": str(km), "speed_kmh": str(speed), "pseudonym": name}


def test_bus_states_and_eta():
    out = approaching_buses([_trip(0), _trip(8.9, name="bus-b"), _trip(8.0, 60, "bus-c")], passenger_km=9.0, destination_km=20.0)
    assert [b.pseudonym for b in out] == ["bus-b", "bus-c", "bus-a"]
    assert out[0].state == "very_near" and out[1].state == "near" and out[2].state == "coming"
    assert out[2].eta_min == round(9.0 / 40 * 60)


def test_bus_past_passenger_or_destination_is_hidden():
    assert approaching_buses([_trip(9.6)], 9.0, 20.0) == []
    assert approaching_buses([_trip(9.4)], 9.0, 20.0)[0].distance_km == 0.0
    assert approaching_buses([_trip(12.0)], 15.0, 11.0) == []


def test_driver_buckets():
    waits = [{"state": "waiting", "wait_progress_km": "5.0"}, {"state": "waiting", "wait_progress_km": "5.1"},
             {"state": "waiting", "wait_progress_km": "9.0"}, {"state": "waiting", "wait_progress_km": "3.0"}]
    out = waiting_ahead(waits, bus_km=4.0)
    assert [(b.distance_km, b.count) for b in out] == [(0.9, 1), (1.2, 1), (5.1, 1)]
