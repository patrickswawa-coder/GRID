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

SAMPLE = {"x": 10, "z": 20, "lat": 37.34, "lng": 127.92, "zone": "a1", "type": "streetlight", "text": "밤에 너무 어두워요"}


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
    assert s["total"] >= 1 and s["by_type"]["streetlight"] >= 1
    assert s["top_zones"][0]["zone"] == "A1"


def test_validation():
    assert client.post("/api/complaints", json={**SAMPLE, "type": "ufo"}).status_code == 400
    assert client.post("/api/complaints", json={**SAMPLE, "text": ""}).status_code == 422
    assert client.post("/api/complaints", json={**SAMPLE, "text": "가" * 201}).status_code == 422


def test_summary_without_ai():
    d = client.get("/api/ai/summary").json()
    assert d["ai"] is False and "건" in d["summary"]
