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


def _load_dotenv(path: Path):
    """레포 맨 위 .env 의 KEY=VALUE 를 환경변수로 (이미 있는 값은 덮어쓰지 않음)."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


_load_dotenv(BASE.parent / ".env")
DB_PATH = os.getenv("GRID_DB", str(BASE / "grid.db"))
MODEL_ID = os.getenv("MODEL_ID", "global.anthropic.claude-haiku-4-5-20251001-v1:0")  # 7조 서버 안내 기준 추천 모델
AI_ENABLED = os.getenv("AI_ENABLED", "1") == "1"
# 로컬 개발 때 web/ 폴더까지 같이 서빙 (서버에서는 nginx가 web/을 서빙하므로 0)
SERVE_WEB = os.getenv("SERVE_WEB", "0") == "1"

TYPES = {
    # 열섬 줄이기 개선 제안
    "tree": "가로수 심기",
    "pocketpark": "소공원·녹지",
    "shade": "그늘막",
    "coolfog": "쿨링포그",
    "greenroof": "옥상녹화",
    "coolpave": "투수·차열 포장",
    # 환경 불편 신고
    "trash": "쓰레기·무단투기",
    "odor": "악취·매연",
    "noise": "소음",
    "other": "기타",
}
# 예전 유형 (이미 저장된 데이터 표시용, 새 등록은 불가)
LEGACY_TYPES = {"streetlight": "가로등", "bench": "벤치", "walkway": "보행로 개선"}
TYPE_NAMES = {**TYPES, **LEGACY_TYPES}

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
CREATE TABLE IF NOT EXISTS env_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL, temp REAL, humidity REAL, pm10 REAL, pm25 REAL, o3 REAL, station TEXT
);
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

import envdata  # noqa: E402  실시간 대기질·기온 (/api/env)

envdata._db = db
app.include_router(envdata.router)

import heatmodel  # noqa: E402  구역별 열섬 × 시민 제안 우선순위 (/api/priority)

app.include_router(heatmodel.router)


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


# 같은 사람(IP)이 같은 칸에 같은 유형을 짧은 시간에 반복 등록하는 것(도배)만 막는다.
# 시연장처럼 여러 명이 같은 와이파이(같은 IP)를 써도 서로 다른 칸·유형은 막히지 않게 일부러 좁게 잡음.
DUP_WINDOW = float(os.getenv("DUP_WINDOW", "600"))  # 초
_recent: dict[tuple, float] = {}


def check_duplicate(ip: str, x: int, z: int, ctype: str):
    t = time.time()
    for k in [k for k, v in _recent.items() if t - v > DUP_WINDOW]:
        del _recent[k]
    key = (ip, x, z, ctype)
    if DUP_WINDOW and key in _recent:
        raise HTTPException(409, "이미 같은 곳에 같은 제안을 하셨어요. 공감 버튼을 눌러 주세요.")
    _recent[key] = t


# ---------------------------------------------------------------- API


@app.get("/api/health")
def health():
    return {"status": "ok", "ai": AI_ENABLED}


@app.get("/api/config")
def config():
    """관리자 페이지용 공개 설정. 네이버 지도 Client ID 는 브라우저에 노출되는 값이라 내려줘도 된다
    (Client Secret 은 절대 여기에 두지 말 것)."""
    return {"naver_key": os.getenv("NAVER_MAP_KEY", "").strip()}


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
    ip = request.client.host if request.client else "?"
    check_rate(ip)
    check_duplicate(ip, body.x, body.z, body.type)
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
        "너는 원주시 환경 민원 분류 담당이야. 아래 시민의 환경 개선 제안·불편 신고를 보고 JSON 한 줄로만 답해.\n"
        '형식: {"urgency": 1|2|3, "tag": "두~네 글자 한국어 태그"}\n'
        "urgency 3=건강·안전 위험(폭염 취약, 심한 악취·매연 등), 2=생활 불편, 1=개선 희망.\n"
        f"유형: {TYPE_NAMES.get(ctype, ctype)}\n민원: {text}"
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
    lines = [f"- [{r['zone']}] {TYPE_NAMES.get(r['type'], r['type'])}: {r['text']} (공감 {r['likes']})" for r in rows]
    data = None
    if AI_ENABLED:
        prompt = (
            "다음은 원주시 무실동 시민들이 3D 열섬 지도 위에 남긴 최근 환경 개선 제안과 불편 신고야. 공무원에게 보고하듯 "
            "한국어로 3~4문장 요약해 줘. 제안이 몰린 구역, 가장 많은 요구(가로수·그늘막 등), 폭염·대기 관점에서 우선 검토할 항목을 포함해.\n\n"
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
             f"가장 많은 요청은 '{TYPE_NAMES.get(top_type[0], top_type[0])}'({top_type[1]}건)입니다."]
    if s["top_zones"]:
        z = s["top_zones"][0]
        parts.append(f"민원이 가장 몰린 구역은 {z['zone']}({z['count']}건)이며 주로 "
                     f"'{TYPE_NAMES.get(z['top_type'], z['top_type'])}' 요청입니다.")
    return " ".join(parts)


_policy_cache: dict = {"key": None, "data": None}


@app.get("/api/ai/policy")
def ai_policy():
    """우선 개선 구역 TOP 3 → 공무원용 정책 제안 (AI, 실패 시 규칙 기반)."""
    top = heatmodel.api_priority(limit=3)
    key = tuple((z["zone"], z["proposals"], z["reports"], z["likes"]) for z in top)
    if _policy_cache["key"] == key and _policy_cache["data"]:
        return _policy_cache["data"]
    lines = []
    for z in top:
        kinds = ", ".join(f"{TYPE_NAMES.get(t, t)} {n}건" for t, n in sorted(z["types"].items(), key=lambda kv: -kv[1])) or "없음"
        lines.append(f"{z['rank']}위 {z['name']}: 열섬 지수 평균 {z['heat']}(가장 뜨거운 10% 칸 {z['heat_p90']}), "
                     f"토지 구성 포장면·지붕 {z.get('paved', 0) * 100:.0f}%·건물 {z['built'] * 100:.0f}%·녹지 {z.get('green', 0) * 100:.0f}%, "
                     f"시민 제안 {z['proposals']}건·신고 {z['reports']}건·공감 {z['likes']}, 요청 내역 [{kinds}], "
                     f"제안 실현 시 평균 {z['heat']}→{z['heat_after']}")
    data = None
    if AI_ENABLED and top:
        prompt = ("너는 원주시 기후·환경 정책 담당 주무관을 돕는 분석가야. 아래는 무실동 200m 구역별 열섬 위험 지수(0~100, 높을수록 뜨거움)와 "
                  "시민이 3D 지도에 남긴 환경 개선 제안 분석 결과야. 열섬 지수는 실측 기온이 아니라 포장면·건물·녹지·물 비율로 계산한 추정 지표야. "
                  "우선 개선 구역 3곳 각각에 대해 '왜 우선인지'와 "
                  "'구체적 사업 제안(예: 가로수 식재, 그늘막, 쿨링포그, 옥상녹화, 투수포장)'을 한 문단씩, 마지막에 한 줄 총평. "
                  "규칙: ① 숫자는 아래 자료에 있는 것만 쓰고, 추정 사업비나 없는 통계는 만들지 마. "
                  "② '왜 우선인지'는 아래 자료(열섬 지수, 토지 구성, 시민 요청)로만 설명해. 교통량·차량 정체·유동 인구·인구 구성처럼 "
                  "자료에 없는 원인은 추측하지 마. ③ 시민 요청이 0건인 구역은 '아직 시민 요청은 없음'이라고 사실대로 써. "
                  "한국어, 보고서 문체. "
                  "문서 제목이나 # 머리글은 쓰지 말고, 각 구역은 '**1순위: 구역 이름**' 처럼 굵은 글씨 한 줄로 시작해. "
                  "구역마다 3문장 이내로 짧게.\n\n" + "\n".join(lines))
        try:
            data = {"text": ask_model(prompt, 1500).strip(), "generated_at": now_kst(), "ai": True}
        except Exception as e:
            print(f"[ai_policy] fallback: {e}")
    if data is None:
        if not top:
            text = "분석할 구역이 없습니다."
        else:
            parts = []
            for z in top:
                rec = TYPE_NAMES.get(z["top_type"], "가로수 심기") if z["top_type"] in heatmodel.FIX else "가로수 심기·그늘막"
                parts.append(f"{z['rank']}위 {z['name']} — 구역 평균 열섬 지수 {z['heat']}로 높고 시민 제안 {z['proposals']}건이 모였습니다. "
                             f"'{rec}' 중심 사업을 우선 검토하면 구역 평균 지수가 {z['heat']}→{z['heat_after']}로 낮아질 것으로 추정됩니다.")
            text = "\n\n".join(parts)
        data = {"text": text, "generated_at": now_kst(), "ai": False}
    _policy_cache.update(key=key, data=data)
    return data


@app.post("/api/ai/explain")
def explain(req: Ask):
    return {"answer": ask_model(req.text[:500])}


# 로컬 개발용: http://localhost:8000/ 에서 web/ 을 바로 열 수 있게
if SERVE_WEB:
    app.mount("/", StaticFiles(directory=str(BASE.parent / "web"), html=True), name="web")
