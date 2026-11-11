# 사용한 오픈소스와 데이터

열받을지도의 코드는 [MIT 라이선스](LICENSE)입니다. 아래 오픈소스와 공공데이터를 함께 씁니다. 각 라이선스 원문은 표의 위치에 있습니다.

## 웹 화면에 포함된 것 (`web/vendor/`)

| 이름 | 버전 | 쓰는 곳 | 라이선스 | 원문 |
| --- | --- | --- | --- | --- |
| [three.js](https://threejs.org) | r160 | 3D 복셀 지도 렌더링, 지도 조작(MapControls) | MIT | `web/vendor/THREE_LICENSE` |
| [Apache ECharts](https://echarts.apache.org) | 5.5.1 | 지자체 대시보드 차트 | Apache-2.0 | `web/vendor/echarts/LICENSE`, `NOTICE` |
| [Pretendard](https://github.com/orioncactus/pretendard) | Variable, 동적 서브셋 | 화면 글꼴 | SIL OFL 1.1 | `web/vendor/fonts/pretendard/LICENSE.txt` |
| [Galmuri11](https://github.com/quiple/galmuri) | Bold, 숫자·영문 서브셋 | 열섬 숫자, GRID 로고 | SIL OFL 1.1 | `web/vendor/fonts/GALMURI-OFL.md` |
| [Lucide](https://lucide.dev) | 1.71.0 아이콘 일부 | 버튼·유형 아이콘 (`web/js/icons.js`, 페이지 안 SVG) | ISC | 아래 '라이선스 원문' |

## 서버·데이터 처리 (설치해서 씀, 저장소에 포함 안 됨)

| 이름 | 쓰는 곳 | 라이선스 |
| --- | --- | --- |
| FastAPI, Uvicorn | 백엔드 API 서버 | MIT, BSD-3-Clause |
| boto3 | Amazon Bedrock 호출 | Apache-2.0 |
| NumPy | 열섬 지수 계산 | BSD-3-Clause |
| GeoPandas, Shapely, pyproj | 공간데이터 → 복셀 지도 변환 | BSD-3-Clause, BSD-3-Clause, MIT |
| rasterio, SciPy, pystac-client, planetary-computer | 위성 표면온도 받기·보정 (선택) | BSD-3-Clause, BSD-3-Clause, Apache-2.0, MIT |
| qrcode | QR 포스터 만들기 | BSD |
| pytest, httpx | 테스트 | MIT, BSD-3-Clause |

## 데이터

데이터는 각 제공처의 이용 약관을 따릅니다. 원본 파일(`data/raw/`)은 저장소에 올리지 않고, 변환 결과(`web/data/voxels.json`, `labels.json`)만 포함합니다.

| 데이터 | 제공 | 쓰는 곳 |
| --- | --- | --- |
| GIS건물통합정보, 연속지적도, 도로명주소 건물 | 국토교통부 브이월드·국가공간정보포털 | 3D 지도, 바닥 종류 |
| Landsat 8·9 Collection 2 Level-2 표면온도 | USGS (Microsoft Planetary Computer 경유) | 열섬 지수 가중치 보정 |
| 초단기실황 (기온·습도) | 기상청 (공공데이터포털 API) | 실시간 기온 |
| 대기오염정보 (미세먼지) | 한국환경공단 에어코리아 (공공데이터포털 API) | 실시간 미세먼지 |

## 라이선스 원문: Lucide (ISC)

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
