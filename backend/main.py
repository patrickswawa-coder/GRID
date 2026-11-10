"""GRID 백엔드: 민원 API (FastAPI + SQLite) + Bedrock AI.

실행(로컬):  cd backend && uvicorn main:app --reload --port 8000
규칙: docs/CONVENTIONS.md 의 '5. 민원 데이터', '6. API' 를 따른다.
"""
import hashlib
import hmac
import io
import json
import os
import sqlite3
import tempfile
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse
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
# 관리자 비밀번호. 비어 있으면(로컬 개발) 관리자 기능이 인증 없이 열린다. 서버에서는 .env 에 꼭 설정할 것.
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")

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
# 처리 상태 (공무원이 대시보드에서 바꾼다)
STATUSES = {"received": "접수", "working": "처리중", "done": "처리 완료"}

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
    created_at  TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'received',
    reply       TEXT,
    status_at   TEXT
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
        # 예전에 만든 DB(상태 컬럼 없음)도 그대로 쓸 수 있게 컬럼을 덧붙인다
        have = {r[1] for r in conn.execute("PRAGMA table_info(complaints)")}
        for col, ddl in (("status", "TEXT NOT NULL DEFAULT 'received'"), ("reply", "TEXT"), ("status_at", "TEXT")):
            if col not in have:
                conn.execute(f"ALTER TABLE complaints ADD COLUMN {col} {ddl}")
        # 여러 칸 제안(줄·네모)용 끝점 — 예전 DB에도 열을 추가 (기존 행은 NULL = 한 칸)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(complaints)")}
        for col, typ in (("x2", "INTEGER"), ("z2", "INTEGER"), ("shape", "TEXT"), ("points", "TEXT")):
            if col not in cols:
                conn.execute(f"ALTER TABLE complaints ADD COLUMN {col} {typ}")
        # 장난·부적절 민원 거르기: moderation NULL=정상, 'review'=확인 필요(자동), 'hidden'=숨김(관리자), 'ok'=관리자가 확인함
        # client = 올린 기기(X-Client-Id)의 해시 — 숨겨진 글도 올린 본인 화면에는 보이게
        for col in ("moderation", "mod_reason", "client"):
            if col not in cols:
                conn.execute(f"ALTER TABLE complaints ADD COLUMN {col} TEXT")


init_db()

import envdata  # noqa: E402  실시간 대기질·기온 (/api/env)

envdata._db = db
app.include_router(envdata.router)

import heatmodel  # noqa: E402  구역별 열섬 × 시민 제안 우선순위 (/api/priority)

app.include_router(heatmodel.router)

import moderation  # noqa: E402  장난·부적절 민원 거르기 (규칙)
import geo  # noqa: E402  경위도 ↔ 지도 칸 (정확한 TM 변환, 예전 근사식은 15~38m 오차)


def map_latlng(x: int, z: int):
    """민원 위경도는 브라우저 값 대신 칸(x, z)으로 서버가 계산한다 (관리자 지도 위치가 정확하도록)."""
    return tuple(round(v, 6) for v in geo.cell_to_latlng(heatmodel._load()["meta"], x, z))


def fix_saved_latlng():
    """예전 근사식으로 저장된 민원 위경도를 칸 기준으로 다시 계산. 칸이 기준이라 몇 번 실행해도 같다."""
    if not heatmodel._load()["meta"].get("tm"):
        return
    with db() as conn:
        for r in conn.execute("SELECT id, x, z FROM complaints").fetchall():
            conn.execute("UPDATE complaints SET lat = ?, lng = ? WHERE id = ?", (*map_latlng(r[1], r[2]), r[0]))


fix_saved_latlng()


def row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d.pop("client", None)  # 기기 해시는 내보내지 않음
    if d.get("points"):  # 자유 그리기 경로는 JSON 문자열로 저장 → 목록으로
        try:
            d["points"] = json.loads(d["points"])
        except ValueError:
            d["points"] = None
    return d


# 시민 지도·통계·AI 요약·우선순위에 쓰는 민원 = 거름 장치에 걸리지 않았거나 관리자가 확인한 것
PUBLIC = "(moderation IS NULL OR moderation = 'ok')"


def client_hash(x_client_id: str | None) -> str | None:
    cid = (x_client_id or "").strip()[:64]
    return hashlib.sha256(cid.encode()).hexdigest()[:16] if cid else None


def is_admin(token: str | None) -> bool:
    if not ADMIN_PASSWORD:
        return True
    return bool(token) and hmac.compare_digest(token.encode(), ADMIN_PASSWORD.encode())


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
    text: str = Field(default="", max_length=200)  # 비워도 됨 (거리에서 QR로 빠르게 등록)
    # 선택: 여러 칸에 한 번에 놓기. shape "path"(자유 그리기, points 필요) / "area"(네모) / "line"(줄)
    # (x2, z2) = 끝점·반대 모서리. path 는 서버가 points 의 마지막 점으로 채운다
    x2: Optional[int] = Field(None, ge=0, le=5000)
    z2: Optional[int] = Field(None, ge=0, le=5000)
    shape: Optional[Literal["line", "area", "path"]] = None
    points: Optional[list[tuple[int, int]]] = Field(None, max_length=300)


class Login(BaseModel):
    password: str


class Update(BaseModel):
    status: str | None = None
    reply: str | None = Field(default=None, max_length=300)
    moderation: Optional[Literal["hidden", "ok"]] = None  # 숨기기 / 다시 보이기(확인함)


def require_admin(x_admin_token: str | None = Header(default=None)):
    """관리자 전용 API 보호. ADMIN_PASSWORD 가 비어 있으면 통과(로컬 개발)."""
    if not ADMIN_PASSWORD:
        return
    if not x_admin_token or not hmac.compare_digest(x_admin_token.encode(), ADMIN_PASSWORD.encode()):
        raise HTTPException(401, "관리자 비밀번호가 필요합니다.")


# ---------------------------------------------------------------- 도배 방지 (아주 단순)

_last_post: dict[str, float] = {}
POST_INTERVAL = float(os.getenv("POST_INTERVAL", "3"))  # 같은 IP는 3초에 1건


# 시연장·학교처럼 여러 명이 같은 와이파이(= 같은 공인 IP)를 쓰면 IP 기준 제한에 서로 걸린다.
# → 간격·중복은 기기(브라우저가 만든 X-Client-Id, 없으면 IP) 기준으로, IP 기준은 분당 상한만 넉넉하게.
IP_PER_MIN = int(os.getenv("IP_PER_MIN", "60"))
_ip_posts: dict[str, list] = {}


def check_rate(who: str, ip: str):
    t = time.time()
    if t - _last_post.get(who, 0) < POST_INTERVAL:
        raise HTTPException(429, "잠시 후 다시 시도해 주세요.")
    recent = [v for v in _ip_posts.get(ip, []) if t - v < 60]
    if IP_PER_MIN and len(recent) >= IP_PER_MIN:
        raise HTTPException(429, "등록이 너무 많아요. 잠시 후 다시 시도해 주세요.")
    _last_post[who] = t
    _ip_posts[ip] = recent + [t]


# 같은 사람(기기)이 같은 칸에 같은 유형을 짧은 시간에 반복 등록하는 것(도배)만 막는다.
DUP_WINDOW = float(os.getenv("DUP_WINDOW", "600"))  # 초
_recent: dict[tuple, float] = {}


def check_duplicate(who: str, x: int, z: int, ctype: str):
    t = time.time()
    for k in [k for k, v in _recent.items() if t - v > DUP_WINDOW]:
        del _recent[k]
    key = (who, x, z, ctype)
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
def list_complaints(since_id: int = 0, limit: int = 500, all: int = 0,
                    x_client_id: str | None = Header(default=None), x_admin_token: str | None = Header(default=None)):
    """시민: 공개 민원 + 내가 올린 것. 관리자(all=1 + 토큰): 숨김·확인 필요까지 전부."""
    limit = max(1, min(limit, 2000))
    if all and is_admin(x_admin_token):
        where, args = "id > ?", (since_id,)
    else:
        where, args = f"id > ? AND ({PUBLIC} OR client = ?)", (since_id, client_hash(x_client_id) or "-")
    with db() as conn:
        rows = conn.execute(f"SELECT * FROM complaints WHERE {where} ORDER BY id LIMIT ?", (*args, limit)).fetchall()
    return [row_to_dict(r) for r in rows]


@app.post("/api/complaints", status_code=201)
def create_complaint(body: ComplaintIn, request: Request, bg: BackgroundTasks,
                     x_client_id: str | None = Header(default=None)):
    if body.type not in TYPES:
        raise HTTPException(400, f"알 수 없는 유형입니다: {body.type}")
    # 장난·부적절 거르기 1단계(규칙): 욕설은 거절, 의미 없는 글은 받되 '확인 필요'로 숨김
    verdict, reason = moderation.check(body.text)
    if verdict == "reject":
        raise HTTPException(400, "부적절한 표현이 있어요. 고쳐서 다시 올려 주세요.")
    mod = "review" if verdict == "review" else None
    # 글 없이 유형만 골라도 등록된다. 목록·AI 요약에서 빈 칸이 되지 않게 유형 이름으로 채움
    text = body.text.strip() or f"{TYPES[body.type]} 요청"
    x2, z2, shape, points = body.x2, body.z2, body.shape, None
    if shape is None:
        x2 = z2 = None
    else:
        if body.type not in heatmodel.FIX:
            raise HTTPException(400, "여러 칸에 놓기는 개선 제안만 할 수 있어요.")
        if shape == "path":
            pts = [list(p) for p in (body.points or [])]
            if len(pts) < 2 or any(not (0 <= a <= 5000 and 0 <= b <= 5000) for a, b in pts):
                raise HTTPException(400, "지도에서 길을 그려 주세요.")
            if pts[0] != [body.x, body.z]:
                raise HTTPException(400, "그린 길의 시작점이 위치와 달라요.")
            x2, z2 = pts[-1]
            points = json.dumps(pts, separators=(",", ":"))
        elif x2 is None or z2 is None:
            raise HTTPException(400, "끝점을 골라 주세요.")
        n = len(heatmodel.expand_cells({"type": body.type, "x": body.x, "z": body.z, "x2": x2, "z2": z2, "shape": shape, "points": points}))
        if n > heatmodel.MAX_CELLS:
            raise HTTPException(400, f"범위가 너무 넓어요. 블록 {heatmodel.MAX_CELLS}개 이하로 골라 주세요.")
    ip = request.client.host if request.client else "?"
    who = (x_client_id or "")[:64] or ip  # 기기 구분 (같은 와이파이 여러 명이 서로 막히지 않게)
    check_rate(who, ip)
    check_duplicate(who, body.x, body.z, body.type)
    with _db_lock, db() as conn:
        cur = conn.execute(
            "INSERT INTO complaints (x, z, lat, lng, zone, type, text, created_at, x2, z2, shape, points,"
            " moderation, mod_reason, client) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (body.x, body.z, *map_latlng(body.x, body.z), body.zone.upper(), body.type, text, now_kst(), x2, z2, shape, points,
             mod, reason if mod else None, client_hash(x_client_id)),
        )
        new_id = cur.lastrowid
        row = conn.execute("SELECT * FROM complaints WHERE id = ?", (new_id,)).fetchone()
    if AI_ENABLED:
        # 2단계(AI): 시민이 직접 쓴 글이 있고 규칙에 안 걸렸을 때만 "진지한 요청인지"도 같이 판단
        bg.add_task(ai_classify, new_id, body.type, text, bool(body.text.strip()) and mod is None)
    return row_to_dict(row)


_liked: set[tuple] = set()


@app.post("/api/complaints/{cid}/like")
def like_complaint(cid: int, request: Request, x_client_id: str | None = Header(default=None)):
    # 한 사람이 같은 민원에 여러 번 공감하는 것 방지. 같은 와이파이(같은 IP)를 여럿이 써도 되도록
    # 브라우저가 만든 X-Client-Id 로 구분하고, 없으면 IP 로 구분한다.
    who = (x_client_id or "")[:64] or (request.client.host if request.client else "?")
    if (who, cid) in _liked:
        raise HTTPException(409, "이미 공감하셨어요.")
    with _db_lock, db() as conn:
        cur = conn.execute("UPDATE complaints SET likes = likes + 1 WHERE id = ?", (cid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "없는 민원입니다.")
        row = conn.execute("SELECT * FROM complaints WHERE id = ?", (cid,)).fetchone()
    _liked.add((who, cid))
    return row_to_dict(row)


@app.get("/api/complaints/sync")
def sync_complaints(x_client_id: str | None = Header(default=None)):
    """시민 페이지가 8초마다 부르는 가벼운 목록: 상태·공감 변경과 삭제를 반영하기 위함.
    숨겨진 민원은 여기서 빠지므로 다른 사람 지도에서는 지워진다 (올린 본인에게는 남음)."""
    with db() as conn:
        rows = conn.execute(f"SELECT id, status, likes, reply FROM complaints WHERE {PUBLIC} OR client = ? ORDER BY id",
                            (client_hash(x_client_id) or "-",)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- 관리자 (처리 상태·삭제·백업)


@app.get("/api/admin/auth")
def admin_auth():
    return {"required": bool(ADMIN_PASSWORD)}


@app.post("/api/admin/login")
def admin_login(body: Login):
    if ADMIN_PASSWORD and not hmac.compare_digest(body.password.encode(), ADMIN_PASSWORD.encode()):
        raise HTTPException(401, "비밀번호가 맞지 않아요.")
    return {"ok": True}


@app.patch("/api/complaints/{cid}")
def update_complaint(cid: int, body: Update, _=Depends(require_admin)):
    sets, args = [], []
    if body.status is not None:
        if body.status not in STATUSES:
            raise HTTPException(400, f"알 수 없는 상태입니다: {body.status}")
        sets += ["status = ?", "status_at = ?"]
        args += [body.status, now_kst()]
    if body.reply is not None:
        sets.append("reply = ?")
        args.append(body.reply.strip() or None)
    if body.moderation is not None:
        # 숨기기: 이유가 없으면 '관리자 숨김' / 다시 보이기(ok): 이후 AI 가 다시 숨기지 않음
        sets += ["moderation = ?", "mod_reason = CASE WHEN ? = 'hidden' THEN COALESCE(mod_reason, '관리자 숨김') ELSE mod_reason END"]
        args += [body.moderation, body.moderation]
    if not sets:
        raise HTTPException(400, "바꿀 내용이 없습니다.")
    with _db_lock, db() as conn:
        cur = conn.execute(f"UPDATE complaints SET {', '.join(sets)} WHERE id = ?", (*args, cid))
        if cur.rowcount == 0:
            raise HTTPException(404, "없는 민원입니다.")
        row = conn.execute("SELECT * FROM complaints WHERE id = ?", (cid,)).fetchone()
    return row_to_dict(row)


@app.delete("/api/complaints/{cid}")
def delete_complaint(cid: int, _=Depends(require_admin)):
    with _db_lock, db() as conn:
        cur = conn.execute("DELETE FROM complaints WHERE id = ?", (cid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "없는 민원입니다.")
    return {"deleted": cid}


@app.get("/api/admin/backup")
def admin_backup(bg: BackgroundTasks, _=Depends(require_admin)):
    """DB 파일을 통째로 내려받기 (행사 끝나면 서버가 삭제되므로)."""
    fd, tmp = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    src, dst = sqlite3.connect(DB_PATH), sqlite3.connect(tmp)
    try:
        src.backup(dst)
    finally:
        src.close(); dst.close()
    bg.add_task(os.remove, tmp)
    name = f"grid-backup-{datetime.now(KST):%Y%m%d_%H%M}.db"
    return FileResponse(tmp, filename=name, media_type="application/octet-stream")


@app.get("/api/qr")
def qr_svg(url: str):
    """접속 QR 코드(SVG). 대시보드의 'QR' 버튼과 인쇄용."""
    if not url.startswith(("http://", "https://")) or len(url) > 300:
        raise HTTPException(400, "http(s) 주소만 만들 수 있어요.")
    import qrcode
    from qrcode.image.svg import SvgPathImage

    img = qrcode.make(url, image_factory=SvgPathImage, box_size=10, border=2)
    buf = io.BytesIO()
    img.save(buf)
    return Response(buf.getvalue(), media_type="image/svg+xml")


@app.get("/api/stats")
def stats():
    today = datetime.now(KST).date().isoformat()
    with db() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM complaints WHERE {PUBLIC}").fetchone()[0]
        today_n = conn.execute(
            f"SELECT COUNT(*) FROM complaints WHERE {PUBLIC} AND substr(created_at, 1, 10) = ?", (today,)
        ).fetchone()[0]
        by_type = dict(conn.execute(f"SELECT type, COUNT(*) FROM complaints WHERE {PUBLIC} GROUP BY type").fetchall())
        by_zone = dict(
            conn.execute(f"SELECT zone, COUNT(*) FROM complaints WHERE {PUBLIC} GROUP BY zone ORDER BY 2 DESC").fetchall()
        )
        review = conn.execute(f"SELECT COUNT(*) FROM complaints WHERE NOT {PUBLIC}").fetchone()[0]
        top = []
        for zone, cnt in list(by_zone.items())[:5]:
            t = conn.execute(
                f"SELECT type, COUNT(*) c FROM complaints WHERE {PUBLIC} AND zone = ? GROUP BY type ORDER BY c DESC LIMIT 1",
                (zone,),
            ).fetchone()
            top.append({"zone": zone, "count": cnt, "top_type": t[0] if t else None})
    return {"total": total, "today": today_n, "by_type": by_type, "by_zone": by_zone, "top_zones": top, "hidden": review}


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


def ai_classify(cid: int, ctype: str, text: str, judge: bool = False):
    """등록된 민원에 긴급도(1~3)와 한 단어 태그를 붙인다. judge 면 장난·무관한 글인지도 판단해
    '확인 필요'로 숨긴다(관리자가 다시 보이게 할 수 있음). 실패해도 조용히 넘어간다."""
    prompt = (
        "너는 원주시 환경 민원 분류 담당이야. 아래 시민의 환경 개선 제안·불편 신고를 보고 JSON 한 줄로만 답해.\n"
        '형식: {"urgency": 1|2|3, "tag": "두~네 글자 한국어 태그", "ok": true|false, "reason": "ok 가 false 일 때만 20자 이내 이유"}\n'
        "urgency 3=건강·안전 위험(폭염 취약, 심한 악취·매연 등), 2=생활 불편, 1=개선 희망.\n"
        "ok: 동네 환경·더위·그늘·녹지·공기·소음·쓰레기·안전·시설에 관한 요청이면 짧거나 맞춤법이 틀려도, "
        "불만 섞인 말투여도 true. 명백한 장난(예: 롤러코스터·수영장·놀이공원 지어줘), 광고, 특정인 비방, "
        "동네와 무관한 글, 무의미한 글일 때만 false. 애매하면 true.\n"
        f"유형: {TYPE_NAMES.get(ctype, ctype)}\n민원: {text}"
    )
    try:
        raw = ask_model(prompt, 150)
        data = json.loads(raw[raw.find("{") : raw.rfind("}") + 1])
        urgency = int(data.get("urgency"))
        tag = str(data.get("tag", ""))[:10] or None
        if urgency not in (1, 2, 3):
            return
        flag = judge and data.get("ok") is False
        reason = ("AI: " + str(data.get("reason") or "장난·무관 의심"))[:40]
        with _db_lock, db() as conn:
            conn.execute("UPDATE complaints SET ai_urgency = ?, ai_tag = ? WHERE id = ?", (urgency, tag, cid))
            if flag:  # 관리자가 이미 판단한 글(hidden/ok)은 건드리지 않음
                conn.execute("UPDATE complaints SET moderation = 'review', mod_reason = ? WHERE id = ? AND moderation IS NULL",
                             (reason, cid))
    except Exception as e:  # AI는 부가 기능: 실패해도 서비스는 계속
        print(f"[ai_classify] skip #{cid}: {e}")


_summary_cache: dict = {"at": 0.0, "data": None}


@app.get("/api/ai/summary")
def ai_summary():
    if _summary_cache["data"] and time.time() - _summary_cache["at"] < 300:
        return _summary_cache["data"]
    with db() as conn:
        rows = conn.execute(f"SELECT zone, type, text, likes FROM complaints WHERE {PUBLIC} ORDER BY id DESC LIMIT 80").fetchall()
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
                  "자료에 없는 원인은 추측하지 마. ③ 시민 요청이 0건인 구역은 '아직 시민 요청은 없음'이라고 사실대로 써. ④ 구역 순서는 아래 자료의 순위(1위·2위·3위) 그대로 써. ⑤ '가장 높다'·'최고' 같은 비교 표현은 아래 세 구역 숫자로 확인될 때만 쓰고, 무실동 전체에서 가장 높다고 하지 마. ⑥ 열섬 지수는 '측정'이 아니라 '추정' 지표라고 표현해. "
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


# 로컬 개발용: http://localhost:8000/ 에서 web/ 을 바로 열 수 있게
if SERVE_WEB:
    app.mount("/", StaticFiles(directory=str(BASE.parent / "web"), html=True), name="web")
