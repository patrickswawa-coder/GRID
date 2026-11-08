# 파트 1 — 데이터 (V-World → 복셀 맵, QR)

담당 폴더: `data/`  결과물: `web/data/voxels.json`

지금은 `make_sample_map.py`가 만든 **가짜 무실동**이 들어가 있음. 이걸 진짜로 바꾸는 게 이 파트의 핵심.

## 할 일
- [ ] **11/8** V-World(vworld.kr) 회원가입 → 인증키 신청 (서비스 URL에 서버 주소 입력)
- [ ] **11/9** 건물 데이터 받기: V-World 데이터 다운로드 → 'GIS건물통합정보' → 강원특별자치도 원주시 SHP
  - 받은 파일은 `data/raw/`에 (git에 안 올라감)
- [ ] **11/9** 컬럼 확인: `python data/build_voxels.py --buildings data/raw/파일.shp --inspect`
  - 층수 / 높이 / 용도 컬럼 이름 확인 후 `--floors-col`, `--height-col`, `--use-col` 지정
- [ ] **11/9** 무실동 범위 정하기: 카카오맵·네이버지도에서 서·남·동·북 경위도 확인 → `--bbox`
  - 너무 크면 폰이 버벅임. **1~1.5km 정사각형** 정도로 (원주시청·무실동 아파트 단지가 들어오게)
- [ ] **11/10** 도로·공원·하천 SHP도 받아서 `--roads --parks --water` 추가 (없으면 건물만이라도)
- [ ] **11/10** 변환 결과를 3D 맵 담당과 같이 확인: 건물 위치가 실제 지도와 맞는지 (좌우·상하 뒤집힘 체크)
- [ ] **11/11** QR 생성: `python data/make_qr.py https://서버주소/` → 발표자료에 넣기

## 참고
- 변환 결과 파일 크기 목표: 2MB 이하 (지금 샘플은 99KB)
- 좌표 규칙은 `docs/CONVENTIONS.md` 3장. `meta.origin_lat/lng` = 북서쪽 모서리
- 건물 정보에 층수가 없으면 2층으로 처리됨
- `seed_complaints.py`는 맵을 바꾼 뒤 다시 돌려야 민원이 새 맵의 길 위에 찍힘 (`backend/grid.db` 삭제 후)
