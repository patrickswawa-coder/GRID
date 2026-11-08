"""GRID 백엔드: 민원 API (FastAPI + SQLite) + Bedrock AI.

실행(로컬):  cd backend && uvicorn main:app --reload --port 8000
규칙: docs/CONVENTIONS.md 의 '5. 민원 데이터', '6. API' 를 따른다.
"""
import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

KST = timezone(timedelta(hours=9))
BASE = Path(__file__).resolve().parent
DB_PATH = os.getenv("GRID_DB", str(BASE / "grid.db"))
MODEL_ID = os.getenv("MODEL_ID", "global.openai.gpt-6-sol")
AI_ENABLED = os.getenv("AI_ENABLED", "1") == "1"
# 로컬 개발 때 web/ 폴더까지 같이 서빙 (서버에서는 nginx가 web/을 서빙하므로 0)
SERVE_WEB = os.getenv("SERVE_WEB", "0") == "1"

TYPES = {
    "streetlight": "가로등",
    "bench": "벤치",
    "trash": "쓰레기통",
    "tree": "가로수·녹지",
    "walkway": "보행로 개선",
    "other": "기타",
}

app = FastAPI(title="GRID API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ---------------------------------------------------------------- DB

SCHEMA = """
CREATE TABLE IF NOT EXISTS complaints (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    x           INTEGER NOT NULL,
    z           INTEGER NOT NULL,
    lat         REAL    NOT NULL,
    lng         REAL    NOT NULL,
    zone        TEXT    NOT NULL,
    type        TEXT    NOT NULL,
    text        TEXT    NOT NULL,
    likes       INTEGER NOT NULL DEFAULT 0,
    ai_urgency  INTEGER,
    ai_tag      TEXT,
    created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_complaints_zone ON complaints(zone);
"""

_db_lock = threading.Lock()


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with db() as conn:
        conn.executescript(SCHEMA)
        conn.execute("PRAGMA journal_mode=WAL")


init_db()


def row_to_dict(row: sqlite3.Row) -> dict:
    return dict(row)


def now_kst() -> str:
    return datetime.now(KST).isoformat(timespec="seconds")


# ---------------------------------------------------------------- 모델


class ComplaintIn(BaseModel):
    x: int = Field(ge=0, le=5000)
    z: int = Field(ge=0, le=5000)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    zone: str = Field(min_length=1, max_length=20)
    type: str
    text: str = Field(min_length=1, max_length=200)


class Ask(BaseModel):
    text: str


# ---------------------------------------------------------------- 도배 방지 (아주 단순)

_last_post: dict[str, float] = {}
POST_INTERVAL = float(os.getenv("POST_INTERVAL", "3"))  # 같은 IP는 3초에 1건


def check_rate(ip: str):
    t = time.time()
    if t - _last_post.get(ip, 0) < POST_INTERVAL:
        raise HTTPException(429, "잠시 후 다시 시도해 주세요.")
    _last_post[ip] = t


# ---------------------------------------------------------------- API


@app.get("/api/health")
def health():
    return {"status": "ok", "ai": AI_ENABLED}


@app.get("/api/complaints")
def list_complaints(since_id: int = 0, limit: int = 500):
    limit = max(1, min(limit, 2000))
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM complaints WHERE id > ? ORDER BY id LIMIT ?", (since_id, limit)
        ).fetchall()
    return [row_to_dict(r) for r in rows]


@app.post("/api/complaints", status_code=201)
def create_complaint(body: ComplaintIn, request: Request, bg: BackgroundTasks):
    if body.type not in TYPES:
        raise HTTPException(400, f"알 수 없는 유형입니다: {body.type}")
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "의견을 입력해 주세요.")
    check_rate(request.client.host if request.client else "?")
    with _db_lock, db() as conn:
        cur = conn.execute(
            "INSERT INTO complaints (x, z, lat, lng, zone, type, text, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (body.x, body.z, body.lat, body.lng, body.zone.upper(), body.type, text, now_kst()),
        )
        new_id = cur.lastrowid
        row = conn.execute("SELECT * FROM complaints WHERE id = ?", (new_id,)).fetchone()
    if AI_ENABLED:
        bg.add_task(ai_classify, new_id, body.type, text)
    return row_to_dict(row)


@app.post("/api/complaints/{cid}/like")
def like_complaint(cid: int):
    with _db_lock, db() as conn:
        cur = conn.execute("UPDATE complaints SET likes = likes + 1 WHERE id = ?", (cid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "없는 민원입니다.")
        row = conn.execute("SELECT * FROM complaints WHERE id = ?", (cid,)).fetchone()
    return row_to_dict(row)


@app.get("/api/stats")
def stats():
    today = datetime.now(KST).date().isoformat()
    with db() as conn:
        total = conn.execute("SELECT COUNT(*) FROM complaints").fetchone()[0]
        today_n = conn.execute(
            "SELECT COUNT(*) FROM complaints WHERE substr(created_at, 1, 10) = ?", (today,)
        ).fetchone()[0]
        by_type = dict(conn.execute("SELECT type, COUNT(*) FROM complaints GROUP BY type").fetchall())
        by_zone = dict(
            conn.execute("SELECT zone, COUNT(*) FROM complaints GROUP BY zone ORDER BY 2 DESC").fetchall()
        )
        top = []
        for zone, cnt in list(by_zone.items())[:5]:
            t = conn.execute(
                "SELECT type, COUNT(*) c FROM complaints WHERE zone = ? GROUP BY type ORDER BY c DESC LIMIT 1",
                (zone,),
            ).fetchone()
            top.append({"zone": zone, "count": cnt, "top_type": t[0] if t else None})
    return {"total": total, "today": today_n, "by_type": by_type, "by_zone": by_zone, "top_zones": top}


# ---------------------------------------------------------------- AI (Bedrock)

_bedrock = None


def bedrock():
    global _bedrock
    if _bedrock is None:
        import boto3

        _bedrock = boto3.client("bedrock-runtime")
    return _bedrock


def ask_model(prompt: str, max_tokens: int = 512) -> str:
    res = bedrock().converse(
        modelId=MODEL_ID,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        inferenceConfig={"maxTokens": max_tokens},
    )
    return "\n".join(b["text"] for b in res["output"]["message"]["content"] if "text" in b)


def ai_classify(cid: int, ctype: str, text: str):
    """등록된 민원에 긴급도(1~3)와 한 단어 태그를 붙인다. 실패해도 조용히 넘어간다."""
    prompt = (
        "너는 원주시 민원 분류 담당이야. 아래 시민 민원을 보고 JSON 한 줄로만 답해.\n"
        '형식: {"urgency": 1|2|3, "tag": "두~네 글자 한국어 태그"}\n'
        "urgency 3=안전 위험(사고·범죄·야간 어두움 등), 2=생활 불편, 1=개선 희망.\n"
        f"유형: {TYPES.get(ctype, ctype)}\n민원: {text}"
    )
    try:
        raw = ask_model(prompt, 100)
        data = json.loads(raw[raw.find("{") : raw.rfind("}") + 1])
        urgency = int(data.get("urgency"))
        tag = str(data.get("tag", ""))[:10] or None
        if urgency not in (1, 2, 3):
            return
        with _db_lock, db() as conn:
            conn.execute("UPDATE complaints SET ai_urgency = ?, ai_tag = ? WHERE id = ?", (urgency, tag, cid))
    except Exception as e:  # AI는 부가 기능: 실패해도 서비스는 계속
        print(f"[ai_classify] skip #{cid}: {e}")


_summary_cache: dict = {"at": 0.0, "data": None}


@app.get("/api/ai/summary")
def ai_summary():
    if _summary_cache["data"] and time.time() - _summary_cache["at"] < 300:
        return _summary_cache["data"]
    with db() as conn:
        rows = conn.execute("SELECT zone, type, text, likes FROM complaints ORDER BY id DESC LIMIT 80").fetchall()
    if not rows:
        return {"summary": "아직 접수된 민원이 없습니다.", "generated_at": now_kst(), "ai": False}
    lines = [f"- [{r['zone']}] {TYPES.get(r['type'], r['type'])}: {r['text']} (공감 {r['likes']})" for r in rows]
    data = None
    if AI_ENABLED:
        prompt = (
            "다음은 원주시 무실동 시민들이 3D 지도에 남긴 최근 민원이야. 공무원에게 보고하듯 "
            "한국어로 3~4문장 요약해 줘. 민원이 몰린 구역, 가장 많은 요구, 우선 검토할 항목을 포함해.\n\n"
            + "\n".join(lines)
        )
        try:
            data = {"summary": ask_model(prompt, 400).strip(), "generated_at": now_kst(), "ai": True}
        except Exception as e:
            print(f"[ai_summary] fallback: {e}")
    if data is None:
        data = {"summary": _rule_summary(), "generated_at": now_kst(), "ai": False}
    _summary_cache.update(at=time.time(), data=data)
    return data


def _rule_summary() -> str:
    """AI를 못 쓸 때 쓰는 통계 기반 요약."""
    s = stats()
    if not s["total"]:
        return "아직 접수된 민원이 없습니다."
    top_type = max(s["by_type"].items(), key=lambda kv: kv[1])
    parts = [f"총 {s['total']}건의 민원이 접수되었습니다(오늘 {s['today']}건).",
             f"가장 많은 요청은 '{TYPES.get(top_type[0], top_type[0])}'({top_type[1]}건)입니다."]
    if s["top_zones"]:
        z = s["top_zones"][0]
        parts.append(f"민원이 가장 몰린 구역은 {z['zone']}({z['count']}건)이며 주로 "
                     f"'{TYPES.get(z['top_type'], z['top_type'])}' 요청입니다.")
    return " ".join(parts)


@app.post("/api/ai/explain")
def explain(req: Ask):
    return {"answer": ask_model(req.text[:500])}


# 로컬 개발용: http://localhost:8000/ 에서 web/ 을 바로 열 수 있게
if SERVE_WEB:
    app.mount("/", StaticFiles(directory=str(BASE.parent / "web"), html=True), name="web")
