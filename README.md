# GRID — 3D 복셀 기반 시민 참여형 공간 민원 플랫폼

원주시 무실동을 마인크래프트 같은 3D 복셀 지도로 보여주고, 시민이 QR로 접속해 개선이 필요한 위치에
**가로등·벤치·쓰레기통·가로수·보행로** 블록을 놓는 방식으로 민원을 남깁니다.
모인 민원은 공무원용 대시보드에서 유형별·구역별 통계와 히트맵, AI 요약으로 확인합니다.

```
시민 폰 ──QR──▶ web/ (Three.js 3D 맵) ──POST──▶ backend/ (FastAPI + SQLite + Bedrock AI)
                                                        │
                                   dashboard/ (Streamlit) ◀── GET
data/ : V-World SHP ──▶ web/data/voxels.json (미리 변환)
```

- 공통 규칙(데이터 형식·API·Git): [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md)
- 일정과 파트별 할 일: [`docs/PLAN.md`](docs/PLAN.md), [`docs/parts/`](docs/parts)
- Claude Code 지침: [`CLAUDE.md`](CLAUDE.md)

## 처음 받았을 때 (5분)

Python 3.10 이상 필요.

```bash
git clone https://github.com/patrickswawa-coder/GRID.git
cd GRID
python -m venv .venv
# Mac/Linux: source .venv/bin/activate     Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt -r dashboard/requirements.txt
```

데이터 파트만 추가로: `pip install -r data/requirements.txt`

## 로컬에서 돌려보기

터미널 1 — 백엔드 + 시민 페이지
```bash
cd backend
# Mac/Linux
SERVE_WEB=1 AI_ENABLED=0 POST_INTERVAL=0 uvicorn main:app --reload --port 8000
# Windows PowerShell
$env:SERVE_WEB="1"; $env:AI_ENABLED="0"; $env:POST_INTERVAL="0"; uvicorn main:app --reload --port 8000
```
→ 브라우저에서 http://localhost:8000

터미널 2 — 더미 민원 넣기 (선택)
```bash
cd data && python seed_complaints.py --n 80
```

터미널 3 — 대시보드
```bash
streamlit run dashboard/app.py
```
→ http://localhost:8501

같은 와이파이의 폰으로 보려면 `uvicorn ... --host 0.0.0.0` 으로 띄우고 `http://내PC IP:8000` 접속.

## 지금 상태 (11/8 기준)

| 기능 | 상태 |
|---|---|
| 3D 복셀 맵 (임시 샘플 맵) | ✅ 동작 — 실제 V-World 데이터로 교체 필요 |
| 지도 탭 → 유형 선택 → 의견 → 등록 | ✅ |
| 다른 시민 민원 표시, 공감 | ✅ (8초마다 새로고침) |
| 민원 API + SQLite + 테스트 | ✅ |
| AI 긴급도 분류 / 요약 (Bedrock) | ✅ 코드 있음 — 서버에서 모델 ID 확인 필요. AI 없으면 통계 요약으로 대체 |
| Streamlit 대시보드 | ✅ 지표·히트맵·유형/구역 통계·AI 요약·CSV |
| 실제 무실동 맵 변환기 | ✅ 코드 있음 — SHP 받아서 실행 필요 |
| 서버 배포 (7조 서버 32.190.9.9) | 📝 `deploy/README.md` — 접속 후 한 줄로 설정 |
| QR 코드 | 📝 `python data/make_qr.py https://서버주소/` |

## 서버 배포

`deploy/README.md` 참고. 요약: `main`에 merge → 서버에서 `./deploy.sh`.
