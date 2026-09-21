def test_root_and_health(client):
    assert client.get("/api/").json()["service"] == "Wenak"
    h = client.get("/api/health").json()
    assert h["status"] == "ok" and h["redis"] is True


def test_destinations_have_no_coordinates(client):
    r = client.get("/api/destinations")
    assert r.status_code == 200
    ids = {d["id"] for d in r.json()}
    assert {"irbid", "malka", "sama_rousan", "kufr_soum", "habras", "umm_qais", "beit_ras", "hatim"} <= ids
    for d in r.json():
        assert set(d.keys()) == {"id", "name_ar", "name_en"}


def test_routes_shape(client):
    routes = client.get("/api/routes").json()
    assert [r["id"] for r in routes] == ["irbid_malka", "irbid_sama_rousan", "irbid_kufr_soum", "irbid_habras", "irbid_umm_qais"]
    for rt in routes:
        assert len(rt["directions"]) == 2
        out, inb = rt["directions"]
        assert out["direction"] == 0 and inb["direction"] == 1
        assert out["origin_id"] == "irbid" and inb["destination_id"] == "irbid"
        assert out["total_km"] == inb["total_km"] > 5
        assert out["served"][0]["progress_km"] == 0.0
        assert abs(out["served"][-1]["progress_km"] - out["total_km"]) < 1e-6
        # inbound mirrors outbound
        assert [s["stop_id"] for s in inb["served"]] == [s["stop_id"] for s in reversed(out["served"])]
        for s in out["served"]:
            assert "lat" not in s and "lon" not in s


def test_corridor_geojson_served_for_phone_projection(client):
    fc = client.get("/api/routes/irbid_malka/corridor").json()
    assert fc["type"] == "FeatureCollection"
    line = [f for f in fc["features"] if f["geometry"]["type"] == "LineString"]
    assert len(line) == 1 and len(line[0]["geometry"]["coordinates"]) > 100
    assert client.get("/api/routes/nope/corridor").status_code == 404
