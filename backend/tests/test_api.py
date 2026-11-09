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


def test_priority():
    client.post("/api/complaints", json={**SAMPLE, "x": 300, "z": 300, "type": "tree"})
    client.post("/api/complaints", json={**SAMPLE, "x": 302, "z": 301, "type": "shade"})
    z = client.get("/api/priority?limit=5").json()
    assert len(z) >= 1 and z[0]["rank"] == 1 and "score" in z[0] and "name" in z[0]
    hit = [r for r in client.get("/api/priority?limit=300").json() if r["proposals"] >= 2]
    assert hit and hit[0]["heat_after"] <= hit[0]["heat"]
    p = client.get("/api/ai/policy").json()
    assert p["ai"] is False and "1위" in p["text"]


def test_priority_uses_zone_mean_and_no_arbitrary_ties():
    # 시민 요구가 같으면(요구 0인 구역끼리) 열섬 '구역 평균'이 높은 곳이 위에 있어야 한다.
    # (예전: 상위 10% 지수가 100에서 포화 → 평균 49 구역이 3위로 올라가던 문제)
    rows = main.heatmodel.priority([])
    assert all(rows[i]["heat"] >= rows[i + 1]["heat"] for i in range(len(rows) - 1))
    for r in rows[:5]:
        assert 0 <= r["paved"] <= 1 and 0 <= r["green"] <= 1


def test_duplicate_same_cell_same_type_blocked():
    body = {**SAMPLE, "x": 123, "z": 45, "type": "shade"}
    assert client.post("/api/complaints", json=body).status_code == 201
    assert client.post("/api/complaints", json=body).status_code == 409
    # 다른 유형이나 다른 칸은 그대로 등록됨
    assert client.post("/api/complaints", json={**body, "type": "tree"}).status_code == 201
    assert client.post("/api/complaints", json={**body, "x": 124}).status_code == 201


def test_meta():
    m = client.get("/api/meta").json()
    assert m["zone_size"] > 0 and m["width"] > 0 and m["depth"] > 0


def _new(**kw):
    r = client.post("/api/complaints", json={**SAMPLE, "x": 400 + kw.pop("dx", 0), "z": 400, **kw})
    assert r.status_code == 201
    return r.json()


def test_status_reply_delete_and_sync(monkeypatch):
    monkeypatch.setattr(main, "ADMIN_PASSWORD", "")  # 비밀번호 없으면 통과
    c = _new(dx=1)
    assert c["status"] == "received" and c["reply"] is None
    r = client.patch(f"/api/complaints/{c['id']}", json={"status": "working", "reply": "현장 확인 중입니다"})
    assert r.status_code == 200 and r.json()["status"] == "working" and r.json()["reply"] == "현장 확인 중입니다"
    assert r.json()["status_at"]
    assert client.patch(f"/api/complaints/{c['id']}", json={"status": "bogus"}).status_code == 400
    assert client.patch(f"/api/complaints/{c['id']}", json={}).status_code == 400
    assert client.patch("/api/complaints/99999", json={"status": "done"}).status_code == 404
    assert any(x["id"] == c["id"] and x["status"] == "working" for x in client.get("/api/complaints/sync").json())
    assert client.delete(f"/api/complaints/{c['id']}").status_code == 200
    assert client.delete(f"/api/complaints/{c['id']}").status_code == 404
    assert all(x["id"] != c["id"] for x in client.get("/api/complaints/sync").json())


def test_admin_password(monkeypatch):
    monkeypatch.setattr(main, "ADMIN_PASSWORD", "pw123")
    c = _new(dx=2)
    assert client.get("/api/admin/auth").json() == {"required": True}
    assert client.post("/api/admin/login", json={"password": "no"}).status_code == 401
    assert client.post("/api/admin/login", json={"password": "pw123"}).status_code == 200
    assert client.patch(f"/api/complaints/{c['id']}", json={"status": "done"}).status_code == 401
    assert client.delete(f"/api/complaints/{c['id']}").status_code == 401
    assert client.get("/api/admin/backup").status_code == 401
    h = {"X-Admin-Token": "pw123"}
    assert client.patch(f"/api/complaints/{c['id']}", json={"status": "done"}, headers=h).status_code == 200
    b = client.get("/api/admin/backup", headers=h)
    assert b.status_code == 200 and b.content.startswith(b"SQLite format 3")
    assert client.delete(f"/api/complaints/{c['id']}", headers=h).status_code == 200


def test_like_once_per_client():
    c = _new(dx=3)
    a, b = {"X-Client-Id": "aaa"}, {"X-Client-Id": "bbb"}
    assert client.post(f"/api/complaints/{c['id']}/like", headers=a).status_code == 200
    assert client.post(f"/api/complaints/{c['id']}/like", headers=a).status_code == 409
    assert client.post(f"/api/complaints/{c['id']}/like", headers=b).json()["likes"] == 2  # 같은 IP여도 다른 사람


def test_qr_and_config():
    r = client.get("/api/qr", params={"url": "http://32.190.9.9/"})
    assert r.status_code == 200 and b"<svg" in r.content
    assert client.get("/api/qr", params={"url": "javascript:alert(1)"}).status_code == 400
    assert "naver_key" in client.get("/api/config").json()
    assert client.post("/api/ai/explain", json={"text": "x"}).status_code in (404, 405)  # 제거됨


def test_old_db_is_migrated(tmp_path, monkeypatch):
    import sqlite3
    p = tmp_path / "old.db"
    con = sqlite3.connect(p)
    con.execute("CREATE TABLE complaints (id INTEGER PRIMARY KEY AUTOINCREMENT, x INT, z INT, lat REAL, lng REAL, zone TEXT, type TEXT, text TEXT, likes INT DEFAULT 0, ai_urgency INT, ai_tag TEXT, created_at TEXT)")
    con.execute("INSERT INTO complaints (x,z,lat,lng,zone,type,text,created_at) VALUES (1,1,0,0,'A1','tree','옛 민원','2026-01-01')")
    con.commit(); con.close()
    monkeypatch.setattr(main, "DB_PATH", str(p))
    main.init_db()
    with main.db() as conn:
        assert conn.execute("SELECT status FROM complaints").fetchone()[0] == "received"


def test_multi_line_and_area():
    import heatmodel
    line = {**SAMPLE, "x": 100, "z": 100, "x2": 112, "z2": 100, "shape": "line", "text": "통학로 전체에 가로수"}
    r = client.post("/api/complaints", json=line)
    assert r.status_code == 201
    c = r.json()
    assert (c["x2"], c["z2"], c["shape"]) == (112, 100, "line")
    assert heatmodel.expand_cells(c) == [(100, 100), (103, 100), (106, 100), (109, 100), (112, 100)]
    area = {**SAMPLE, "type": "pocketpark", "x": 50, "z": 50, "x2": 58, "z2": 54, "shape": "area"}
    assert client.post("/api/complaints", json=area).status_code == 201
    assert heatmodel.expand_cells(area) == [(50, 50), (54, 50), (58, 50), (50, 54), (54, 54), (58, 54)]
    # 한 칸 제안은 끝점이 와도 무시
    one = client.post("/api/complaints", json={**SAMPLE, "x": 70, "z": 70, "x2": 90, "z2": 90}).json()
    assert one["x2"] is None and one["shape"] is None


def test_multi_validation():
    base = {**SAMPLE, "x": 200, "z": 200, "x2": 210, "z2": 200}
    assert client.post("/api/complaints", json={**base, "shape": "circle"}).status_code == 422
    assert client.post("/api/complaints", json={**base, "shape": "line", "x2": None}).status_code == 400
    assert client.post("/api/complaints", json={**base, "shape": "line", "type": "trash"}).status_code == 400
    too_big = {**base, "shape": "area", "x2": 260, "z2": 260}
    assert client.post("/api/complaints", json=too_big).status_code == 400


def test_text_optional():
    # 거리에서 QR로 들어온 시민이 유형만 골라 등록하는 경우
    r = client.post("/api/complaints", json={**SAMPLE, "x": 77, "z": 88, "text": "  "})
    assert r.status_code == 201 and r.json()["text"] == "가로수 심기 요청"


def test_path_freehand():
    import heatmodel
    pts = [[100, 300], [100, 310], [112, 310]]  # ㄱ자 길
    r = client.post("/api/complaints", json={**SAMPLE, "x": 100, "z": 300, "shape": "path", "points": pts, "text": "골목 따라 가로수"})
    assert r.status_code == 201
    c = r.json()
    assert c["points"] == pts and (c["x2"], c["z2"]) == (112, 310) and c["shape"] == "path"
    cells = heatmodel.expand_cells(c)
    assert cells[0] == (100, 300) and cells[-1] == (111, 310) and len(cells) == 8
    # 우선순위 계산(DB에서 문자열로 읽음)도 같은 칸
    assert heatmodel.expand_cells({**c, "points": __import__("json").dumps(pts)}) == cells


def test_path_validation():
    base = {**SAMPLE, "x": 400, "z": 400, "shape": "path"}
    assert client.post("/api/complaints", json={**base, "points": [[400, 400]]}).status_code == 400
    assert client.post("/api/complaints", json={**base, "points": [[1, 1], [5, 5]]}).status_code == 400  # 시작점 불일치
    long_path = [[400, 400 + i] for i in range(0, 200, 5)]  # 195칸 → 가로수 66곳, 50곳 넘음
    assert client.post("/api/complaints", json={**base, "points": long_path}).status_code == 400
    assert client.post("/api/complaints", json={**base, "points": [[400, 400]] * 301}).status_code == 422


def test_latlng_from_cell_not_browser():
    # 브라우저가 보낸 위경도(예전 근사식 등)는 무시하고 칸(x, z)으로 서버가 정확히 계산
    import geo
    r = client.post("/api/complaints", json={**SAMPLE, "x": 409, "z": 3, "lat": 1.0, "lng": 2.0, "type": "coolfog"})
    assert r.status_code == 201
    lat, lng = geo.cell_to_latlng(main.heatmodel._load()["meta"], 409, 3)
    assert abs(r.json()["lat"] - lat) < 1e-6 and abs(r.json()["lng"] - lng) < 1e-6


def test_same_wifi_different_people_not_blocked(monkeypatch):
    # 시연장: 같은 IP(같은 와이파이)에서 여러 사람이 같은 QR 자리에 같은 유형을 등록해도 막히지 않아야 함
    monkeypatch.setattr(main, "POST_INTERVAL", 3)
    body = {**SAMPLE, "x": 321, "z": 54, "type": "shade"}
    a, b = {"X-Client-Id": "judge-a"}, {"X-Client-Id": "judge-b"}
    assert client.post("/api/complaints", json=body, headers=a).status_code == 201
    assert client.post("/api/complaints", json=body, headers=b).status_code == 201
    # 같은 기기가 바로 또 보내면 간격 제한(429), 간격이 지나도 같은 칸·유형이면 중복(409)
    assert client.post("/api/complaints", json=body, headers=a).status_code == 429
    monkeypatch.setattr(main, "POST_INTERVAL", 0)
    assert client.post("/api/complaints", json=body, headers=a).status_code == 409
