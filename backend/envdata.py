"""실시간 환경데이터: 에어코리아 대기질 + 기상청 초단기실황(기온·습도).

GET /api/env  →  {"air": {...}, "weather": {...}, "updated_at": ...}
- 공공데이터포털 인증키: 환경변수 DATA_GO_KR_KEY (레포 맨 위 .env 에 넣으면 main.py 가 읽음)
- 10분 캐시. 호출할 때마다 env_log 테이블에 기록 → 대시보드 추이 그래프
- 키가 없거나 API가 실패하면 마지막 값(또는 null)을 돌려주고 서비스는 계속 동작
"""
import json
import math
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter

KST = timezone(timedelta(hours=9))
router = APIRouter()

# 무실동 중심 (원주시청 남쪽)
LAT, LNG = 37.3355, 127.9250
# 에어코리아 강원 측정소 중 무실동에서 가까운 순서로 시도 (AIR_STATION 으로 지정 가능)
STATION_PREF = ["반곡동(명륜동)", "중앙동(강원)", "지정면", "문막읍"]  # 실제 에어코리아 측정소 이름 (괄호 포함)

AIR_URL = "https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty"
KMA_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst"

GRADE = {"1": "좋음", "2": "보통", "3": "나쁨", "4": "매우나쁨"}

_cache = {"at": 0.0, "data": None}
_db = None  # main.py 가 db 컨텍스트 함수를 넣어 줌


def _key():
    return os.getenv("DATA_GO_KR_KEY", "").strip()


def _get_json(url, params, timeout=8):
    q = urllib.parse.urlencode(params, safe="%")
    with urllib.request.urlopen(f"{url}?{q}", timeout=timeout) as r:
        raw = r.read().decode("utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # 키 오류 등은 XML로 옴
        raise RuntimeError(raw[:200])


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def pm25_grade(v):
    if v is None:
        return None
    return "좋음" if v <= 15 else "보통" if v <= 35 else "나쁨" if v <= 75 else "매우나쁨"


def fetch_air():
    d = _get_json(AIR_URL, {"serviceKey": _key(), "returnType": "json", "numOfRows": 300, "pageNo": 1,
                            "sidoName": "강원", "ver": "1.3"})
    items = d["response"]["body"]["items"]
    by_name = {it.get("stationName"): it for it in items}
    prefer = [os.getenv("AIR_STATION")] if os.getenv("AIR_STATION") else []
    for name in prefer + STATION_PREF:
        it = by_name.get(name)
        if it and _num(it.get("pm10Value")) is not None:
            pm25 = _num(it.get("pm25Value"))
            return {
                "station": name,
                "time": it.get("dataTime"),
                "pm10": _num(it.get("pm10Value")),
                "pm25": pm25,
                "o3": _num(it.get("o3Value")),
                "no2": _num(it.get("no2Value")),
                "khai": _num(it.get("khaiValue")),
                "grade": GRADE.get(str(it.get("khaiGrade")), pm25_grade(pm25)),
                "pm25_grade": GRADE.get(str(it.get("pm25Grade1h") or it.get("pm25Grade")), pm25_grade(pm25)),
            }
    raise RuntimeError(f"원주 측정소를 찾지 못함 (강원 측정소 {len(items)}곳)")


def latlng_to_grid(lat, lng):
    """기상청 단기예보 격자(nx, ny) 변환 (기상청 제공 LCC 공식)."""
    RE, GRID, SLAT1, SLAT2, OLON, OLAT, XO, YO = 6371.00877, 5.0, 30.0, 60.0, 126.0, 38.0, 43, 136
    D = math.pi / 180.0
    re = RE / GRID
    s1, s2, ol, oa = SLAT1 * D, SLAT2 * D, OLON * D, OLAT * D
    sn = math.log(math.cos(s1) / math.cos(s2)) / math.log(math.tan(math.pi * 0.25 + s2 * 0.5) / math.tan(math.pi * 0.25 + s1 * 0.5))
    sf = math.tan(math.pi * 0.25 + s1 * 0.5) ** sn * math.cos(s1) / sn
    ro = re * sf / math.tan(math.pi * 0.25 + oa * 0.5) ** sn
    ra = re * sf / math.tan(math.pi * 0.25 + lat * D * 0.5) ** sn
    theta = lng * D - ol
    theta = (theta + math.pi) % (2 * math.pi) - math.pi
    theta *= sn
    return int(ra * math.sin(theta) + XO + 0.5), int(ro - ra * math.cos(theta) + YO + 0.5)


def fetch_weather():
    nx, ny = latlng_to_grid(LAT, LNG)
    base = datetime.now(KST) - timedelta(minutes=45)  # 매시 정각 자료는 40분쯤 올라옴
    d = _get_json(KMA_URL, {"serviceKey": _key(), "pageNo": 1, "numOfRows": 20, "dataType": "JSON",
                            "base_date": base.strftime("%Y%m%d"), "base_time": base.strftime("%H00"),
                            "nx": nx, "ny": ny})
    items = d["response"]["body"]["items"]["item"]
    v = {it["category"]: _num(it["obsrValue"]) for it in items}
    return {"temp": v.get("T1H"), "humidity": v.get("REH"), "wind": v.get("WSD"), "rain_1h": v.get("RN1"),
            "time": base.strftime("%Y-%m-%d %H:00"), "grid": [nx, ny]}


def _log(data):
    if not _db:
        return
    a, w = data.get("air") or {}, data.get("weather") or {}
    with _db() as conn:
        conn.execute(
            "INSERT INTO env_log (at, temp, humidity, pm10, pm25, o3, station) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (data["updated_at"], w.get("temp"), w.get("humidity"), a.get("pm10"), a.get("pm25"), a.get("o3"), a.get("station")),
        )


@router.get("/api/env")
def env_now():
    if _cache["data"] and time.time() - _cache["at"] < 600:
        return _cache["data"]
    prev = _cache["data"] or {}
    data = {"updated_at": datetime.now(KST).isoformat(timespec="seconds"), "errors": {}}
    if not _key():
        data.update(air=None, weather=None, errors={"key": "DATA_GO_KR_KEY 가 설정되지 않았어요"})
        return data
    for name, fn in (("air", fetch_air), ("weather", fetch_weather)):
        try:
            data[name] = fn()
        except Exception as e:  # 실패해도 직전 값 유지
            data[name] = prev.get(name)
            data["errors"][name] = str(e)[:200]
            print(f"[env] {name} 실패: {e}")
    _cache.update(at=time.time(), data=data)
    try:
        _log(data)
    except Exception as e:
        print(f"[env] 기록 실패: {e}")
    return data


@router.get("/api/env/history")
def env_history(hours: int = 48):
    if not _db:
        return []
    since = (datetime.now(KST) - timedelta(hours=max(1, min(hours, 24 * 14)))).isoformat(timespec="seconds")
    with _db() as conn:
        rows = conn.execute("SELECT * FROM env_log WHERE at >= ? ORDER BY at", (since,)).fetchall()
    return [dict(r) for r in rows]
