// 화면 둘러보기 (온보딩): 화면 요소를 하나씩 밝게 비추고 옆에 짧은 설명을 띄운다.
// steps: [{ el: () => Element | DOMRect-like | null, title, text }] — el 이 없거나 화면에 안 보이면 그 단계는 건너뛴다.
const $ = (s) => document.querySelector(s);

let state = null;

function rectOf(step) {
  const t = step.el();
  if (!t) return null;
  if (t instanceof Element) {
    if (t.hidden || t.closest("[hidden]")) return null;
    const r = t.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { left: r.left, top: r.top, width: r.width, height: r.height, round: step.round };
  }
  return { ...t, round: step.round };
}

function visibleSteps(steps) {
  return steps.filter((s) => rectOf(s));
}

function place() {
  if (!state) return;
  const { steps, i, hole, tip } = state;
  const r = rectOf(steps[i]);
  if (!r) return next(1); // 화면이 바뀌어 사라졌으면 다음으로
  const pad = 6;
  Object.assign(hole.style, {
    left: r.left - pad + "px", top: r.top - pad + "px",
    width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px",
    borderRadius: r.round ? "50%" : "16px",
  });
  const s = steps[i];
  tip.querySelector(".tour-n").textContent = `${i + 1} / ${steps.length}`;
  tip.querySelector(".tour-title").textContent = s.title;
  tip.querySelector(".tour-text").textContent = typeof s.text === "function" ? s.text() : s.text;
  tip.querySelector(".tour-prev").hidden = i === 0;
  tip.querySelector(".tour-next").textContent = i === steps.length - 1 ? "시작하기" : "다음";

  // 설명 카드: 대상 아래에 자리가 있으면 아래, 없으면 위. 화면 밖으로 나가지 않게.
  const W = innerWidth, H = innerHeight, M = 12, gap = 14;
  tip.style.maxWidth = Math.min(320, W - M * 2) + "px";
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  const below = r.top + r.height + pad + gap;
  const top = below + th < H - M ? below : Math.max(M, r.top - pad - gap - th);
  const left = Math.min(W - M - tw, Math.max(M, r.left + r.width / 2 - tw / 2));
  tip.style.top = top + "px";
  tip.style.left = left + "px";
}

function next(d) {
  if (!state) return;
  const j = state.i + d;
  if (j < 0) return;
  if (j >= state.steps.length) return end();
  state.i = j;
  place();
}

function end() {
  if (!state) return;
  const { root, onDone } = state;
  removeEventListener("resize", place);
  removeEventListener("keydown", onKey);
  root.remove();
  state = null;
  onDone?.();
}

function onKey(e) {
  if (e.key === "Escape") end();
  else if (e.key === "ArrowRight") next(1);
  else if (e.key === "ArrowLeft") next(-1);
}

export function tourActive() {
  return !!state;
}

export function startTour(allSteps, onDone) {
  if (state) end();
  const steps = visibleSteps(allSteps);
  if (!steps.length) return onDone?.();
  const root = document.createElement("div");
  root.className = "tour";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "화면 둘러보기");
  root.innerHTML = `<div class="tour-hole"></div>
    <div class="tour-tip" role="document">
      <div class="tour-top"><span class="tour-n"></span><button type="button" class="tour-skip">건너뛰기</button></div>
      <b class="tour-title"></b>
      <p class="tour-text"></p>
      <div class="tour-actions"><button type="button" class="tour-prev ghost">이전</button><button type="button" class="tour-next primary">다음</button></div>
    </div>`;
  document.body.append(root);
  state = { steps, i: 0, root, hole: root.querySelector(".tour-hole"), tip: root.querySelector(".tour-tip"), onDone };
  root.querySelector(".tour-skip").onclick = end;
  root.querySelector(".tour-prev").onclick = () => next(-1);
  root.querySelector(".tour-next").onclick = () => next(1);
  addEventListener("resize", place);
  addEventListener("keydown", onKey);
  place();
}

