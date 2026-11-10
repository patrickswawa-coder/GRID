# 파트 4 — 백엔드 + AI + 서버 배포

담당: `backend/`, `deploy/`, `deploy.sh`

현재: 민원 등록/목록/공감/통계 API, SQLite, 3초 도배 방지, 등록 시 Bedrock으로 긴급도·태그 자동 분류(백그라운드),
`/api/ai/summary` 요약(5분 캐시, AI 실패 시 통계 요약). 테스트 4개 통과.

## 할 일 (우선순위 순)
- [ ] **11/9** 서버에 현재 버전 배포 (`deploy/README.md` 순서대로) → 폰에서 서버 주소로 접속 확인
- [ ] **11/9** `MODEL_ID` 확인: 서버에서 `curl -X POST localhost:8000/api/ai/explain -H 'Content-Type: application/json' -d '{"text":"안녕"}'`
  - 안 되면 Bedrock 콘솔에서 쓸 수 있는 모델 ID로 `.env` 또는 systemd `Environment=MODEL_ID=...` 수정
- [ ] **11/10** AI 분류 프롬프트 다듬기 (`ai_classify`) — 실제 민원 10개 넣어보고 결과 확인
- [x] ~~Streamlit도 서버에 올리기~~ → 대시보드는 `web/admin/` 으로 옮겨 필요 없음 (11/10, `dashboard/` 삭제)
- [ ] **11/11** 시연 전 DB 초기화/백업 방법 정리 (`grid.db` 복사), 더미 데이터 다시 넣기
- [ ] (여유) 대시보드용 `/api/stats`에 우선순위 점수 추가 (건수 + 공감 + 긴급도)

## 참고
- 테스트: `cd backend && python -m pytest -q` — 고칠 때마다 통과 확인
- 환경변수: `GRID_DB`, `MODEL_ID`, `AI_ENABLED`(1/0), `POST_INTERVAL`(초), `SERVE_WEB`(로컬만 1)
- API 형식은 CONVENTIONS 6장. 바꾸면 웹·대시보드 담당에게 먼저 알리기
