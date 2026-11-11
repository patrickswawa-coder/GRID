// 제안·신고 유형 — docs/CONVENTIONS.md 5장, backend/main.py TYPES 와 같게 유지 (대시보드 web/admin 도 이 파일을 씀)
//
// group "fix"  : 열섬을 줄이는 개선 제안 → effect 로 시뮬레이션 (heat.js buildMods)
// group "report": 환경 불편 신고 (시뮬레이션 효과 없음, 데이터로만 수집)
//
// effect: size = 영향 범위(칸, 정사각형 한 변, 1칸=5m)
//         green = 녹지 추가(0~1), water = 수분·증발냉각(0~1),
//         impCut = 포장면 열 흡수 감소(0~1), roofCut = 건물 지붕 열 감소(0~1, 건물 칸에만)
export const TYPES = [
  { code: "tree", ico: "tree-deciduous", example: "통학로에 그늘이 없어요", label: "가로수 심기", icon: "🌳", color: "#2f9e44", group: "fix",
    desc: "길가에 나무 그늘", effect: { size: 5, green: 0.6 } },
  { code: "pocketpark", ico: "trees", example: "빈 주차장이 늘 뜨거워요", label: "소공원·녹지", icon: "🌿", color: "#37b24d", group: "fix",
    desc: "빈 땅·주차장을 작은 숲으로", effect: { size: 7, green: 1, impCut: 1 } },
  { code: "shade", ico: "parasol", example: "신호 기다릴 때 너무 더워요", label: "그늘막", icon: "⛱️", color: "#1c7ed6", group: "fix",
    desc: "횡단보도·정류장 그늘", effect: { size: 5, impCut: 0.5 } },
  { code: "coolfog", ico: "droplets", example: "상가 거리가 한낮에 너무 뜨거워요", label: "쿨링포그", icon: "💧", color: "#15aabf", group: "fix",
    desc: "물 안개로 기온 낮추기", effect: { size: 7, water: 0.5 } },
  { code: "greenroof", ico: "sprout", example: "옥상이 여름마다 달궈져요", label: "옥상녹화", icon: "🏠", color: "#82c91e", group: "fix",
    desc: "건물 옥상에 정원 (옥상을 눌러요)", effect: { size: 9, roofCut: 0.7 }, roofOnly: true },
  { code: "coolpave", ico: "grid-2x2", example: "보도블록이 너무 뜨거워요", label: "투수·차열 포장", icon: "🧱", color: "#adb5bd", group: "fix",
    desc: "물이 스미고 덜 뜨거운 바닥", effect: { size: 9, impCut: 0.6 } },
  { code: "trash", ico: "trash-2", label: "쓰레기·무단투기", icon: "🗑️", color: "#868e96", group: "report", desc: "" },
  { code: "odor", ico: "wind", label: "악취·매연", icon: "😷", color: "#9c36b5", group: "report", desc: "" },
  { code: "noise", ico: "volume-2", label: "소음", icon: "🔊", color: "#e8590c", group: "report", desc: "" },
  { code: "other", ico: "circle-alert", label: "기타", icon: "❗", color: "#495057", group: "report", desc: "" },
];

// 예전 유형 (이미 등록된 민원 표시용, 새로 선택은 안 됨)
const LEGACY = [
  { code: "streetlight", ico: "lightbulb", label: "가로등", icon: "💡", color: "#f5c542", group: "report" },
  { code: "bench", ico: "armchair", label: "벤치", icon: "🪑", color: "#a0673a", group: "report" },
  { code: "walkway", ico: "footprints", label: "보행로 개선", icon: "🚶", color: "#4c8bf5", group: "report" },
];

export const TYPE_BY_CODE = Object.fromEntries([...TYPES, ...LEGACY].map((t) => [t.code, t]));
export const FIX_TYPES = TYPES.filter((t) => t.group === "fix");
export const REPORT_TYPES = TYPES.filter((t) => t.group === "report");
