# 파트 5 — 대시보드 + 시연 데이터

담당: `web/admin/`, `data/seed_complaints.py`

예전 Streamlit 대시보드(`dashboard/`)는 11/10에 `web/admin/`(HTML/JS)으로 완전히 옮기고 지웠습니다.
주소: 로컬 http://localhost:8000/admin/ · 서버 https://grid-team7.duckdns.org/admin/

## 지금 화면 (11/10)
- 한눈에 보기 6칸: 평균 열섬 지수, 지수 70 이상 면적, 제안·신고, 처리 완료율, 기온, 초미세먼지
- 먼저 손댈 곳: 5m 열섬 지도(시민 화면과 같은 계산) + 우선 개선 구역 5곳 + 정책 제안(AI/규칙)
- 분석: 열섬 × 시민 요구 산점도, 유형별 막대(ECharts), 처리 현황, 구역별 건수
- 근거: 위성 지표온도와 열섬 지수 비교 (`web/data/lst_compare.json`, `data/export_lst.py`)
- 제안·신고 목록: 상태·유형 필터, 관리자 로그인 시 처리 상태·답변·삭제, CSV

## 시연 데이터
```
# 서버에서 (기존 민원을 모두 지우고 새로 채움, 관리자 비밀번호는 .env 에서 읽음)
cd ~/GRID && .venv/bin/python data/seed_complaints.py --env-file .env --reset --n 80 --focus 5 --seed 7 --delay 1.1 --handled 0.35 --api http://127.0.0.1:8000
```
