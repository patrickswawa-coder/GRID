// 민원 유형 — docs/CONVENTIONS.md 5장과 반드시 같게 유지
export const TYPES = [
  { code: "streetlight", label: "가로등", icon: "💡", color: "#f5c542" },
  { code: "bench", label: "벤치", icon: "🪑", color: "#a0673a" },
  { code: "trash", label: "쓰레기통", icon: "🗑️", color: "#3f8f5a" },
  { code: "tree", label: "가로수·녹지", icon: "🌳", color: "#2f9e44" },
  { code: "walkway", label: "보행로 개선", icon: "🚶", color: "#4c8bf5" },
  { code: "other", label: "기타", icon: "❗", color: "#e8590c" },
];
export const TYPE_BY_CODE = Object.fromEntries(TYPES.map((t) => [t.code, t]));
