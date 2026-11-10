# GRID — Claude Code 작업 지침

원주시 무실동을 3D 복셀 맵으로 보여주고, 시민이 위치를 골라 민원을 남기면 공무원 대시보드에서 통계로 보는 PoC.
**마감 2026-11-12(목) 18:00.** 새 기능보다 "시연에서 안 깨지는 것"이 우선.

## 반드시 먼저 읽기
- `docs/CONVENTIONS.md` — 좌표계, 데이터 형식, API, Git 규칙. **여기 적힌 형식/주소를 임의로 바꾸지 말 것.**
- 내 파트 문서: `docs/parts/` 안의 해당 파일

## 구조
- `web/` 시민용 페이지. 빌드 도구 없음, ES 모듈 + `web/vendor/`의 three.js r160. npm/번들러 도입 금지.
- `backend/main.py` FastAPI + SQLite(`grid.db`) + Bedrock. 테스트: `cd backend && python -m pytest -q`
- `web/admin/` 지자체 대시보드 (HTML/JS, 차트는 `web/vendor/echarts`). DB를 직접 읽지 말고 API로만.
- `data/` Python 전처리. 결과물은 `web/data/voxels.json` 하나.

## 로컬 실행
```
cd backend && SERVE_WEB=1 AI_ENABLED=0 POST_INTERVAL=0 uvicorn main:app --reload --port 8000
# → http://localhost:8000  (web/ 까지 같이 서빙)
# 대시보드 → http://localhost:8000/admin/
python data/seed_complaints.py --n 80   # 더미 민원
```
Windows PowerShell에서는 환경변수를 `$env:SERVE_WEB=1; $env:AI_ENABLED=0; uvicorn main:app --reload` 처럼 설정.

## 규칙
- 내 파트 폴더 밖 파일을 고쳐야 하면 작업 전에 사용자에게 확인받기.
- 민원 유형을 바꾸면 `backend/main.py` TYPES, `web/js/types.js` 두 곳을 같이 (대시보드는 types.js 를 그대로 씀).
- 키/비밀번호/`.env`/`*.pem`/`grid.db`/`data/raw/` 는 커밋 금지.
- 백엔드를 고쳤으면 테스트 통과 확인 후 커밋. 웹을 고쳤으면 모바일 크기(390px)에서도 확인.
- UI 문구는 짧은 한국어 존댓말.
- 커밋 메시지: `파트: 한 일` (예: `3D맵: 탭/드래그 구분 개선`). `main`에 직접 push 금지, 브랜치 → PR.
