"""GRID 공무원용 대시보드 (Streamlit).

실행: streamlit run dashboard/app.py
환경변수 GRID_API (기본 http://127.0.0.1:8000) 로 백엔드 주소를 바꿀 수 있다.
데이터는 DB를 직접 읽지 않고 백엔드 API로만 가져온다 (docs/CONVENTIONS.md 6장).
"""
import os
import re
from datetime import datetime

import pandas as pd
import plotly.express as px
import pydeck as pdk
import requests
import streamlit as st

API = os.getenv("GRID_API", "http://127.0.0.1:8000")
REFRESH_SEC = 10

TYPE_LABELS = {
    "tree": "🌳 가로수 심기", "pocketpark": "🌿 소공원·녹지", "shade": "⛱️ 그늘막", "coolfog": "💧 쿨링포그",
    "greenroof": "🏠 옥상녹화", "coolpave": "🧱 투수·차열 포장",
    "trash": "🗑️ 쓰레기·무단투기", "odor": "😷 악취·매연", "noise": "🔊 소음", "other": "❗ 기타",
    # 예전 유형
    "streetlight": "💡 가로등", "bench": "🪑 벤치", "walkway": "🚶 보행로 개선",
}
TYPE_COLORS = {
    "tree": [47, 158, 68], "pocketpark": [55, 178, 77], "shade": [28, 126, 214], "coolfog": [21, 170, 191],
    "greenroof": [130, 201, 30], "coolpave": [134, 142, 150], "trash": [134, 142, 150], "odor": [156, 54, 181],
    "noise": [232, 89, 12], "other": [73, 80, 87],
    "streetlight": [245, 197, 66], "bench": [160, 103, 58], "walkway": [76, 139, 245],
}
URGENCY = {3: "🔴 높음", 2: "🟠 보통", 1: "🟢 낮음"}

st.set_page_config(page_title="GRID 환경 대시보드", page_icon="🧱", layout="wide")
st.markdown(
    "<style>div[data-testid='stMetricValue']{font-size:1.9rem} .block-container{padding-top:1.5rem}</style>",
    unsafe_allow_html=True,
)


def get(path):
    r = requests.get(API + path, timeout=15)
    r.raise_for_status()
    return r.json()


@st.cache_data(ttl=300, show_spinner=False)
def ai_policy():
    try:
        return get("/api/ai/policy")
    except Exception:
        return None


FIX_TYPES = ["tree", "pocketpark", "shade", "coolfog", "greenroof", "coolpave"]
HEAT_STOPS = [(0, (47, 158, 68)), (35, (148, 216, 45)), (55, (252, 216, 60)), (70, (252, 160, 30)), (85, (240, 80, 40)), (100, (190, 25, 45))]


def heat_rgb(v):
    """web/js/heat.js heatRGB 와 같은 색"""
    for (a, ca), (b, cb) in zip(HEAT_STOPS, HEAT_STOPS[1:]):
        if v <= b:
            t = (v - a) / (b - a)
            return [round(x + (y - x) * t) for x, y in zip(ca, cb)]
    return list(HEAT_STOPS[-1][1])


def priority_section():
    """열섬 지수(서버 계산) × 시민 제안·신고·공감 → 우선 개선 구역"""
    try:
        pr = pd.DataFrame(get("/api/priority?limit=300"))
    except Exception as e:
        st.caption(f"우선순위 계산을 불러오지 못했어요: {e}")
        return
    if pr.empty:
        return
    st.subheader("🎯 우선 개선 구역 — 열섬 위험 × 시민 요구")
    st.caption("200m 구역별 · 점수 = 열섬 지수(상위 10% 칸) 60% + 시민 요구(제안·신고·공감) 40% · "
               "'실현 시'는 그 구역 시민 개선 제안이 모두 시행됐을 때의 시뮬레이션")
    top3 = pr.head(3)
    cols = st.columns(3)
    medal = ["🥇", "🥈", "🥉"]
    for col, (_, z) in zip(cols, top3.iterrows()):
        with col.container(border=True):
            st.markdown(f"#### {medal[z['rank'] - 1]} {z['name']}")
            a, b = st.columns(2)
            a.metric("우선순위 점수", f"{z['score']:.0f}")
            b.metric("열섬 지수", f"{z['heat_p90']:.0f}", help="구역 안에서 가장 뜨거운 10% 칸의 지수")
            want = TYPE_LABELS.get(z["top_type"], "-") if z["top_type"] else "제안 없음"
            st.markdown(f"시민 제안 **{z['proposals']}건** · 신고 {z['reports']}건 · 공감 {z['likes']}  \n"
                        f"가장 많은 요청: **{want}**  \n"
                        f"제안 실현 시 구역 평균 **{z['heat']:.0f} → {z['heat_after']:.0f}**"
                        + (f" (−{z['delta']:.1f})" if z["delta"] > 0 else ""))

    left, right = st.columns([3, 2])
    with left:
        pr["color"] = pr["heat_p90"].apply(heat_rgb)
        pr["demand"] = pr["proposals"] + pr["reports"] + pr["likes"] / 2
        pr["elev"] = 15 + pr["demand"] * 25
        mp = pr[(pr["built"] > 0.02) | (pr["demand"] > 0)]
        view = pdk.ViewState(latitude=mp["lat"].mean(), longitude=mp["lng"].mean(), zoom=13.4, pitch=45, bearing=-10)
        layer = pdk.Layer("ColumnLayer", mp, get_position="[lng, lat]", get_elevation="elev", elevation_scale=1,
                          radius=70, get_fill_color="color", pickable=True, auto_highlight=True, extruded=True,
                          coverage=0.9)
        st.pydeck_chart(pdk.Deck(layers=[layer], initial_view_state=view, map_style="light",
                                 tooltip={"text": "{rank}위 {name}\n점수 {score} · 열섬 {heat_p90}\n제안 {proposals} · 신고 {reports} · 공감 {likes}"}),
                        height=380)
        st.caption("기둥 색 = 열섬 지수(초록→빨강), 기둥 높이 = 시민 요구")
    with right:
        q = pr[pr["built"] > 0.02]
        fig = px.scatter(q, x="heat_p90", y="demand", size=q["score"].clip(lower=5), color="heat_p90",
                         color_continuous_scale=["#2f9e44", "#94d82d", "#fcd83c", "#fca01e", "#f05028", "#be192d"],
                         range_color=[0, 100], hover_name="name",
                         labels={"heat_p90": "열섬 지수 (상위 10%)", "demand": "시민 요구"})
        xm, ym = 70, max(1.0, q["demand"].quantile(0.75))
        fig.add_vline(x=xm, line_dash="dot", line_color="#adb5bd")
        fig.add_hline(y=ym, line_dash="dot", line_color="#adb5bd")
        fig.add_annotation(x=97, y=q["demand"].max() * 1.05 + 0.5, text="우선 개선", showarrow=False,
                           font=dict(color="#e03131", size=13), xanchor="right")
        fig.update_layout(height=380, margin=dict(l=0, r=0, t=10, b=0), coloraxis_showscale=False)
        st.plotly_chart(fig, use_container_width=True, key="quad")

    with st.expander("📋 구역별 우선순위 표 (TOP 15)"):
        t = pr.head(15)[["rank", "name", "score", "heat_p90", "heat", "heat_after", "proposals", "reports", "likes"]]
        t.columns = ["순위", "구역", "점수", "열섬(상위10%)", "열섬 평균", "실현 시 평균", "제안", "신고", "공감"]
        st.dataframe(t, use_container_width=True, hide_index=True)
        st.download_button("우선순위 CSV", t.to_csv(index=False).encode("utf-8-sig"),
                           file_name=f"grid_우선개선구역_{datetime.now():%Y%m%d_%H%M}.csv", mime="text/csv")

    st.session_state["zone_names"] = dict(zip(pr["zone"], pr["name"]))
    st.subheader("🏛️ AI 정책 제안")
    p = ai_policy()
    if p:
        # AI가 # 머리글을 쓰면 글씨가 너무 커지므로 굵은 글씨 한 줄로 낮춘다
        st.success(re.sub(r"(?m)^#{1,6}\s*(.+?)\s*#*$", r"**\1**", p["text"]))
        st.caption(("AI 분석 (Amazon Bedrock)" if p.get("ai") else "규칙 기반 제안 (AI 미연결)") + f" · {p['generated_at']}")


@st.cache_data(ttl=300, show_spinner=False)
def ai_summary():
    try:
        return get("/api/ai/summary")
    except Exception:
        return None


st.title("🧱 GRID 환경·민원 대시보드")
st.caption("원주시 무실동 · 실시간 환경데이터와 시민이 3D 지도 위에 남긴 환경 개선 제안")

with st.sidebar:
    st.header("필터")
    sel_types = st.multiselect("제안·신고 유형", list(TYPE_LABELS)[:10], format_func=TYPE_LABELS.get, placeholder="전체 유형")
    st.caption(f"{REFRESH_SEC}초마다 자동 새로고침")
    st.caption(f"API: {API}")


def env_section():
    """에어코리아·기상청 실시간 값 + 기록 추이 (키가 없으면 안내만)."""
    try:
        env = get("/api/env")
    except Exception:
        return
    w, a = env.get("weather") or {}, env.get("air") or {}
    st.subheader("🌤️ 지금 무실동 환경")
    if not w and not a:
        st.caption("실시간 환경데이터 미연결 — 서버 .env 에 DATA_GO_KR_KEY 를 넣어 주세요.")
        return
    c = st.columns(4)
    c[0].metric("기온", f"{w['temp']:.1f}°C" if w.get("temp") is not None else "-")
    c[1].metric("습도", f"{w['humidity']:.0f}%" if w.get("humidity") is not None else "-")
    c[2].metric("초미세먼지 PM2.5", f"{a['pm25']:.0f}㎍/㎥" if a.get("pm25") is not None else "-",
                a.get("pm25_grade") or "", delta_color="off")
    c[3].metric("미세먼지 PM10", f"{a['pm10']:.0f}㎍/㎥" if a.get("pm10") is not None else "-",
                a.get("grade") or "", delta_color="off")
    st.caption(f"출처: 기상청 초단기실황 · 에어코리아 {a.get('station', '')} 측정소 · {env.get('updated_at', '')}")
    try:
        hist = pd.DataFrame(get("/api/env/history?hours=72"))
    except Exception:
        hist = pd.DataFrame()
    if len(hist) >= 2:
        hist["at"] = pd.to_datetime(hist["at"])
        fig = px.line(hist, x="at", y=["temp", "pm25"], labels={"value": "", "at": "", "variable": ""})
        fig.for_each_trace(lambda t: t.update(name={"temp": "기온(°C)", "pm25": "PM2.5(㎍/㎥)"}[t.name]))
        fig.update_layout(height=220, margin=dict(l=0, r=0, t=10, b=0), legend=dict(orientation="h", y=1.15))
        st.plotly_chart(fig, use_container_width=True, key="envhist")


@st.fragment(run_every=REFRESH_SEC)
def board():
    env_section()
    priority_section()
    st.divider()
    try:
        rows = get("/api/complaints?limit=2000")
    except Exception as e:
        st.error(f"백엔드에 연결할 수 없어요: {e}")
        return
    df = pd.DataFrame(rows)
    if df.empty:
        st.info("아직 접수된 민원이 없어요. 시민 페이지에서 첫 민원을 등록해 보세요.")
        return
    df["유형"] = df["type"].map(TYPE_LABELS).fillna(df["type"])
    df["created_at"] = pd.to_datetime(df["created_at"])
    if sel_types:
        df = df[df["type"].isin(sel_types)]
        if df.empty:
            st.warning("선택한 유형의 민원이 없어요.")
            return

    today = pd.Timestamp.now(tz=df["created_at"].dt.tz).normalize()
    by_type = df["유형"].value_counts()
    by_zone = df["zone"].value_counts()
    urgent = int((df["ai_urgency"] == 3).sum()) if "ai_urgency" in df else 0

    c = st.columns(5)
    c[0].metric("전체 민원", f"{len(df)}건")
    c[1].metric("오늘 접수", f"{int((df['created_at'] >= today).sum())}건")
    c[2].metric("최다 요청", by_type.index[0], f"{by_type.iloc[0]}건", delta_color="off")
    names = st.session_state.get("zone_names", {})
    c[3].metric("최다 구역", names.get(by_zone.index[0], by_zone.index[0]).replace(" 주변", ""), f"{by_zone.iloc[0]}건", delta_color="off")
    c[4].metric("AI 긴급 판정", f"{urgent}건")

    left, right = st.columns([3, 2])
    with left:
        st.subheader("📍 제안·신고 위치")
        df["color"] = df["type"].map(TYPE_COLORS).apply(lambda v: v if isinstance(v, list) else [120, 120, 120])
        layers = [
            pdk.Layer("HeatmapLayer", df, get_position="[lng, lat]", get_weight="1 + likes",
                      radius_pixels=45, opacity=0.55),
            pdk.Layer("ScatterplotLayer", df, get_position="[lng, lat]", get_fill_color="color",
                      get_radius=6, radius_min_pixels=4, pickable=True, stroked=True,
                      get_line_color=[255, 255, 255], line_width_min_pixels=1),
        ]
        view = pdk.ViewState(latitude=df["lat"].mean(), longitude=df["lng"].mean(), zoom=15, pitch=40)
        st.pydeck_chart(pdk.Deck(layers=layers, initial_view_state=view, map_style="light",
                                 tooltip={"text": "{유형} · 구역 {zone}\n{text}\n공감 {likes}"}),
                        height=430)
    with right:
        st.subheader("유형별 민원")
        fig = px.bar(by_type.sort_values(), orientation="h", labels={"value": "건수", "index": ""})
        fig.update_layout(showlegend=False, height=200, margin=dict(l=0, r=0, t=0, b=0), yaxis_title=None)
        st.plotly_chart(fig, use_container_width=True, key="types")

        st.subheader("민원 집중 구역 TOP 5")
        top = df.groupby("zone").agg(건수=("id", "size"), 공감=("likes", "sum"),
                                     주요요청=("유형", lambda s: s.value_counts().index[0]))
        top = top.sort_values(["건수", "공감"], ascending=False).head(5).rename_axis("구역")
        st.dataframe(top, use_container_width=True)

    st.subheader("🤖 AI 제안·신고 요약")
    s = ai_summary()
    if s:
        st.info(s["summary"])
        st.caption(("AI 요약" if s.get("ai") else "통계 기반 요약 (AI 미연결)") + f" · {s['generated_at']}")
    else:
        st.caption("요약을 불러오지 못했어요.")

    st.subheader("📋 공감 많은 제안·신고")
    show = df.sort_values(["likes", "id"], ascending=False)[["id", "유형", "zone", "text", "likes", "ai_urgency", "created_at"]]
    show = show.assign(ai_urgency=show["ai_urgency"].map(URGENCY))
    show.columns = ["번호", "유형", "구역", "내용", "공감", "AI 긴급도", "접수 시각"]
    st.dataframe(show, use_container_width=True, hide_index=True, height=320)
    st.download_button("CSV로 내려받기", show.to_csv(index=False).encode("utf-8-sig"),
                       file_name=f"grid_민원_{datetime.now():%Y%m%d_%H%M}.csv", mime="text/csv")
    st.caption(f"마지막 갱신 {datetime.now():%H:%M:%S}")


board()
