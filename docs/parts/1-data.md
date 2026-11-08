# 파트 1 — 데이터 (V-World → 복셀 맵, QR)

담당 폴더: `data/`  결과물: `web/data/voxels.json`

**11/8 완료: 실제 무실동 맵 적용됨** (V-World GIS건물통합정보 2026-10-09 + 도로명주소 건물 2026-10 + 연속지적도형정보 2026-10-08, 강원)

GIS건물통합정보에 빠진 아파트(휴먼시아·우미린·세영리첼·부영·LH8단지·더샵 등 188동)는 도로명주소 건물로 채움.

다시 만들 때 (원본 SHP는 레포 맨 위 폴더에, git에는 안 올라감):
```
python data/clip_buildings.py AL_D010_51_20261009.shp     # → data/raw/muksil_buildings.gpkg
python data/clip_parcels.py "AL_D002_51_*.shp"            # → data/raw/muksil_parcels.gpkg
python data/clip_buildings.py TL_SPBD_BULD_51_202610.shp data/raw/muksil_juso_buildings.gpkg   # 도로명주소 건물
python data/build_voxels.py --buildings data/raw/muksil_buildings.gpkg --extra-buildings data/raw/muksil_juso_buildings.gpkg --parcels data/raw/muksil_parcels.gpkg
python data/build_labels.py --buildings data/raw/muksil_buildings.gpkg --extra-buildings data/raw/muksil_juso_buildings.gpkg   # 이름표 (직접 추가: data/landmarks_custom.csv)
```
- 건물: 층수 A26, 높이 A16, 용도 A9 / 지적도: 지목은 A5 끝 글자(대·도·임·공·천…)
- 범위: 127.9125~127.9380, 37.3260~37.3455 (무실동 전체), 5m 격자 448×438

## 할 일
- [x] **11/8** V-World(vworld.kr) 회원가입 → 인증키 신청 (서비스 URL에 서버 주소 입력)
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
