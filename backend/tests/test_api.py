"""실행: cd backend && python -m pytest -q"""
import os
import sys
import tempfile
from pathlib import Path

os.environ["GRID_DB"] = str(Path(tempfile.mkdtemp()) / "test.db")
os.environ["AI_ENABLED"] = "0"
os.environ["POST_INTERVAL"] = "0"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

client = TestClient(main.app)

SAMPLE = {"x": 10, "z": 20, "lat": 37.34, "lng": 127.92, "zone": "a1", "type": "tree", "text": "여름에 그늘이 없어요"}


def test_health():
    assert client.get("/api/health").json()["status"] == "ok"


def test_create_list_like_stats():
    r = client.post("/api/complaints", json=SAMPLE)
    assert r.status_code == 201
    c = r.json()
    assert c["zone"] == "A1" and c["likes"] == 0

    assert any(x["id"] == c["id"] for x in client.get("/api/complaints").json())
    assert client.get(f"/api/complaints?since_id={c['id']}").json() == []

    assert client.post(f"/api/complaints/{c['id']}/like").json()["likes"] == 1
    assert client.post("/api/complaints/99999/like").status_code == 404

    s = client.get("/api/stats").json()
    assert s["total"] >= 1 and s["by_type"]["tree"] >= 1
    assert s["top_zones"][0]["zone"] == "A1"


def test_validation():
    assert client.post("/api/complaints", json={**SAMPLE, "type": "ufo"}).status_code == 400
    assert client.post("/api/complaints", json={**SAMPLE, "type": "bench"}).status_code == 400  # 예전 유형은 새 등록 불가
    assert client.post("/api/complaints", json={**SAMPLE, "text": ""}).status_code == 422
    assert client.post("/api/complaints", json={**SAMPLE, "text": "가" * 201}).status_code == 422


def test_summary_without_ai():
    d = client.get("/api/ai/summary").json()
    assert d["ai"] is False and "건" in d["summary"]


def test_env_without_key(monkeypatch):
    monkeypatch.delenv("DATA_GO_KR_KEY", raising=False)
    main.envdata._cache.update(at=0, data=None)
    d = client.get("/api/env").json()
    assert d["air"] is None and "key" in d["errors"]


def test_env_with_mocked_apis(monkeypatch):
    monkeypatch.setenv("DATA_GO_KR_KEY", "x")
    main.envdata._cache.update(at=0, data=None)
    air = {"response": {"body": {"items": [
        {"stationName": "춘천", "pm10Value": "10"},
        {"stationName": "반곡동(명륜동)", "dataTime": "2026-11-09 01:00", "pm10Value": "32", "pm25Value": "18",
         "o3Value": "0.021", "no2Value": "0.012", "khaiValue": "55", "khaiGrade": "2", "pm25Grade1h": "2"}]}}}
    kma = {"response": {"body": {"items": {"item": [
        {"category": "T1H", "obsrValue": "6.3"}, {"category": "REH", "obsrValue": "71"}, {"category": "WSD", "obsrValue": "1.2"}]}}}}

    def fake(url, params, timeout=8):
        return air if "Arpltn" in url else kma

    monkeypatch.setattr(main.envdata, "_get_json", fake)
    d = client.get("/api/env").json()
    assert d["air"]["station"] == "반곡동(명륜동)" and d["air"]["pm25"] == 18 and d["air"]["grade"] == "보통"
    assert d["weather"]["temp"] == 6.3 and d["weather"]["humidity"] == 71
    assert len(client.get("/api/env/history").json()) >= 1


def test_kma_grid():
    # 기상청 격자: 원주 무실동 부근은 nx 76, ny 122 근처
    nx, ny = main.envdata.latlng_to_grid(37.3355, 127.925)
    assert 74 <= nx <= 78 and 120 <= ny <= 124
