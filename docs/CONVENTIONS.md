# GRID 공통 규칙

조원 모두(그리고 각자의 Claude Code)가 이 문서를 기준으로 작업합니다.
여기 적힌 **데이터 형식과 API 주소는 합의 없이 바꾸지 않습니다.** 바꿔야 하면 단톡방에 먼저 말하고 이 문서부터 고칩니다.

마감: **2026-11-12 (목) 18:00 제출**

---

## 1. 전체 흐름

```
[시민 폰] --QR--> web/ (Three.js 3D 복셀 맵)
                    │  POST /api/complaints
                    ▼
              backend/ (FastAPI + SQLite: grid.db)
                    │  GET /api/complaints, /api/stats, /api/ai/summary
                    ▼
              dashboard/ (Streamlit, 공무원용)

data/ (Python) : V-World SHP → web/data/voxels.json  (미리 한 번 만들어 둠)
```

## 2. 폴더와 담당

| 폴더 | 내용 | 담당 파트 |
|---|---|---|
| `data/` | SHP → 복셀 변환, 임시 맵 생성, 더미 민원, QR 생성 | 데이터 |
| `web/` | 시민용 3D 페이지 (빌드 없음, 순수 HTML/JS 모듈) | 3D 맵 ×2 |
| `backend/` | FastAPI 서버, SQLite, Bedrock AI | 백엔드 |
| `dashboard/` | Streamlit 대시보드 | 대시보드 |
| `deploy/` | 서버 설정 예시 (nginx, systemd) | 백엔드 |
| `docs/` | 이 문서, 파트별 작업 문서 | 모두 |

다른 파트 폴더의 파일을 고쳐야 하면 그 파트 담당자에게 먼저 말합니다.

## 3. 좌표계 (중요)

- 맵은 **격자(cell)** 단위입니다. 한 칸 = `meta.cell` 미터 (기본 5m).
- `x`: 서→동으로 증가 (0 ~ `meta.width-1`)
- `z`: 북→남으로 증가 (0 ~ `meta.depth-1`)
- 기준점 `meta.origin_lat`, `meta.origin_lng` = 맵의 **북서쪽 모서리**
- 격자 → 위경도 (PoC용 근사, 수 km 범위에서 오차 수 m):
  ```
  lat = origin_lat - (z + 0.5) * cell / 111320
  lng = origin_lng + (x + 0.5) * cell / (111320 * cos(origin_lat))
  ```
- 구역(zone): `meta.zone_size` 칸(기본 40칸 = 200m) 단위로 자른 이름. 열은 A, B, C… 행은 1, 2, 3…
  - 예: x=85, z=10, zone_size=40 → 열 `C`(85//40=2), 행 `1`(10//40=0) → `"C1"`
  - 실제 행정구역/블록 이름이 생기면 `meta.zones`로 덮어쓸 수 있게 확장 예정

웹(`web/js/map.js`)과 대시보드가 같은 공식을 씁니다.

## 4. `web/data/voxels.json` 형식

```json
{
  "meta": {
    "name": "원주시 무실동",
    "cell": 5,
    "width": 200, "depth": 200,
    "origin_lat": 37.3420, "origin_lng": 127.9160,
    "zone_size": 40,
    "source": "sample | vworld"
  },
  "ground": "<base64, width*depth 바이트, 행(z) 우선>",
  "buildings": [x, z, h, kind,  x, z, h, kind, ...]
}
```

- `ground` 값: `0` 잔디/빈땅, `1` 차도, `2` 인도·광장, `3` 공원·녹지, `4` 물
- `buildings`: 4개씩 끊어 읽는 평평한 배열. `h`는 블록 높이(칸 수), `kind`는 `0` 주거(아파트), `1` 단독주택, `2` 상업, `3` 공공
- 위치 하나당 기둥 하나입니다(층마다 블록을 쌓지 않음 → 모바일 성능 확보).

## 5. 민원(complaint) 데이터

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | int | 자동 증가 |
| `x`, `z` | int | 격자 좌표 |
| `lat`, `lng` | float | 웹에서 계산해 보냄 |
| `zone` | str | 예: `"C1"` |
| `type` | str | 아래 6종 중 하나 |
| `text` | str | 시민 의견, 1~200자 |
| `likes` | int | 공감 수 |
| `ai_urgency` | int \| null | AI가 매긴 긴급도 1(낮음)~3(높음), AI 꺼져 있으면 null |
| `ai_tag` | str \| null | AI가 붙인 한 단어 태그 (예: "야간안전") |
| `x2`, `z2` | int \| null | (선택) 여러 칸에 놓기의 끝점(줄) 또는 반대 모서리(네모). 한 칸 제안은 null |
| `shape` | str \| null | (선택) `"line"` 줄 / `"area"` 네모. null 이면 한 칸. 개선 제안 유형만 가능 |

**여러 칸 제안(줄·네모)** 은 민원 1건으로 저장되고, 블록이 놓일 칸은 `web/js/shape.js` `expandCells()` 와
`backend/heatmodel.py` `expand_cells()` 가 **같은 규칙**으로 펼칩니다 (유형별 간격 `STEP`, 최대 30곳).
`x`, `z`, `lat`, `lng`, `zone` 은 시작점 기준이라 대시보드·통계는 기존과 똑같이 1건으로 셉니다.
| `created_at` | str | ISO 8601, 서버 시간(KST) |
| `status` | str | 처리 상태: `received`(접수, 기본) / `working`(처리중) / `done`(처리 완료). 관리자가 바꾼다 |
| `reply` | str \| null | 시민에게 보여줄 담당자 안내(300자) |
| `status_at` | str \| null | 상태를 마지막으로 바꾼 시각 |

**제안·신고 유형 `type`** (자세한 효과 값은 `web/js/types.js`)

| 구분 | 코드 | 한글 | 시뮬레이션 효과 (영향 범위) |
|---|---|---|---|
| 열섬 줄이기 제안 | `tree` | 🌳 가로수 심기 | 녹지 +0.6 (25m) |
| | `pocketpark` | 🌿 소공원·녹지 | 녹지 +1, 포장 제거 (35m) |
| | `shade` | ⛱️ 그늘막 | 포장면 열흡수 −50% (25m) |
| | `coolfog` | 💧 쿨링포그 | 수분 +0.5 (35m) |
| | `greenroof` | 🏠 옥상녹화 | 건물 지붕 열 −70% (45m, 옥상에만) |
| | `coolpave` | 🧱 투수·차열 포장 | 포장면 열흡수 −60% (45m) |
| 환경 불편 신고 | `trash` / `odor` / `noise` / `other` | 🗑️ 쓰레기 / 😷 악취·매연 / 🔊 소음 / ❗ 기타 | 없음 (데이터 수집) |

예전 유형 `streetlight`, `bench`, `walkway` 는 이미 저장된 데이터 표시용으로만 남김 (새 등록 불가).

유형을 추가하려면 `backend/main.py`의 `TYPES`, `web/js/types.js`, `dashboard/app.py`의 `TYPE_LABELS` 세 곳을 같이 고칩니다.

## 6. API

모든 주소는 `/api/` 로 시작합니다 (nginx가 `/api`를 FastAPI로 넘김).

| 메서드 | 주소 | 설명 |
|---|---|---|
| GET | `/api/health` | `{"status":"ok"}` |
| GET | `/api/complaints?since_id=0&limit=500` | 민원 목록 (id 오름차순). `since_id`보다 큰 것만 |
| POST | `/api/complaints` | 등록. body: `{x, z, lat, lng, zone, type, text}` (+ 선택 `x2, z2, shape`, 30곳 넘으면 400) → 저장된 민원. `text`는 비워도 됨(비우면 "<유형> 요청"으로 저장). 같은 IP가 3초 안에 다시 보내면 429, 같은 IP·칸·유형을 10분 안에 다시 보내면 409 |
| POST | `/api/complaints/{id}/like` | 공감 +1 → 갱신된 민원. 같은 `X-Client-Id`(없으면 같은 IP)가 같은 민원에 다시 누르면 409 |
| GET | `/api/stats` | `{total, by_type:{}, by_zone:{}, top_zones:[{zone,count,top_type}], today}` |
| GET | `/api/ai/summary` | `{summary, generated_at, ai:true/false}` 최근 민원 요약 (5분 캐시) |
| GET | `/api/complaints/sync` | 가벼운 `[{id,status,likes,reply}]` 전체 — 시민 지도가 상태 변경·삭제를 반영할 때 |
| PATCH | `/api/complaints/{id}` | **관리자** `{status?, reply?}` → 갱신된 민원 |
| DELETE | `/api/complaints/{id}` | **관리자** 삭제 |
| GET | `/api/admin/auth` · POST `/api/admin/login` | 비밀번호 필요 여부 · `{password}` 확인 |
| GET | `/api/admin/backup` | **관리자** DB 파일 내려받기 |
| GET | `/api/qr?url=...` | 접속 QR 코드(SVG) |
| GET | `/api/config` | `{naver_key}` 네이버 지도 Client ID (비밀 아님) |
| GET | `/api/meta` | 지도 크기·구역 크기 |
| GET | `/api/env` | 실시간 `{air:{station,pm10,pm25,o3,grade,pm25_grade}, weather:{temp,humidity,wind}, updated_at, errors}` (10분 캐시, 에어코리아·기상청) |
| GET | `/api/env/history?hours=48` | `/api/env` 호출 기록 (대시보드 추이) |
| GET | `/api/priority?limit=30` | 200m 구역별 `{rank, zone, name, score, heat, heat_p90, heat_after, delta, proposals, reports, likes, top_type, lat, lng, built, paved, green}` (열섬 평균 × 시민 요구, `paved`/`green`은 0~1 토지 구성 비율) |
| GET | `/api/ai/policy` | 우선 개선 구역 TOP 3 정책 제안 `{text, ai, generated_at}` (AI 실패 시 규칙 기반) |

**관리자 API**는 요청 헤더 `X-Admin-Token: <ADMIN_PASSWORD>` 가 필요합니다 (서버 `.env` 의 `ADMIN_PASSWORD`; 비어 있으면 인증 없이 열림 = 로컬 개발용).

에러는 FastAPI 기본 형식 `{"detail": "..."}` 을 씁니다.

## 7. Git 규칙

- `main` = 서버에 배포되는 버전. **`main`에 직접 push 하지 말고** 브랜치 → PR → 다른 한 명이 확인 후 merge.
- 브랜치 이름: `part/파트-작업` 예) `map/touch-ui`, `dash/heatmap`, `data/vworld`
- 커밋은 작게, 메시지는 한국어로 무엇을 했는지: `3D맵: 모바일에서 탭/드래그 구분`
- **키·비밀번호·`.pem`·`.env`·`grid.db`는 절대 커밋 금지** (`.gitignore`에 있음)
- 마감 전날(11/11) 밤 이후엔 새 기능 금지, 버그 수정만.

## 8. 코드 스타일

- Python: 3.10+, 함수 짧게, 타입 힌트 가능하면, 주석은 한국어 OK
- JS: 빌드 도구 없이 ES 모듈(`<script type="module">`). 외부 라이브러리는 CDN 대신 `web/vendor/`에 넣어 둠(시연장 네트워크 대비)
- UI 문구는 한국어, 존댓말 짧게 ("위치를 눌러 주세요")
