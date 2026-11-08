"""GRID 공무원용 대시보드 (Streamlit).

실행: streamlit run dashboard/app.py
환경변수 GRID_API (기본 http://127.0.0.1:8000) 로 백엔드 주소를 바꿀 수 있다.
데이터는 DB를 직접 읽지 않고 백엔드 API로만 가져온다 (docs/CONVENTIONS.md 6장).
"""
import os
from datetime import datetime

import pandas as pd
import plotly.express as px
import pydeck as pdk
import requests
import streamlit as st

API = os.getenv("GRID_API", "http://127.0.0.1:8000")
REFRESH_SEC = 10

TYPE_LABELS = {
    "streetlight": "💡 가로등", "bench": "🪑 벤치", "trash": "🗑️ 쓰레기통",
    "tree": "🌳 가로수·녹지", "walkway": "🚶 보행로 개선", "other": "❗ 기타",
}
TYPE_COLORS = {
    "streetlight": [245, 197, 66], "bench": [160, 103, 58], "trash": [63, 143, 90],
    "tree": [47, 158, 68], "walkway": [76, 139, 245], "other": [232, 89, 12],
}
URGENCY = {3: "🔴 높음", 2: "🟠 보통", 1: "🟢 낮음"}

st.set_page_config(page_title="GRID 민원 대시보드", page_icon="🧱", layout="wide")
st.markdown(
    "<style>div[data-testid='stMetricValue']{font-size:1.9rem} .block-container{padding-top:1.5rem}</style>",
    unsafe_allow_html=True,
)


def get(path):
    r = requests.get(API + path, timeout=15)
    r.raise_for_status()
    return r.json()


@st.cache_data(ttl=300, show_spinner=False)
def ai_summary():
    try:
        return get("/api/ai/summary")
    except Exception:
        return None


st.title("🧱 GRID 민원 대시보드")
st.caption("원주시 무실동 · 시민이 3D 지도 위에 직접 남긴 공간 민원")

with st.sidebar:
    st.header("필터")
    sel_types = st.multiselect("민원 유형", list(TYPE_LABELS), format_func=TYPE_LABELS.get, placeholder="전체 유형")
    st.caption(f"{REFRESH_SEC}초마다 자동 새로고침")
    st.caption(f"API: {API}")


@st.fragment(run_every=REFRESH_SEC)
def board():
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
    c[3].metric("최다 구역", by_zone.index[0], f"{by_zone.iloc[0]}건", delta_color="off")
    c[4].metric("AI 긴급 판정", f"{urgent}건")

    left, right = st.columns([3, 2])
    with left:
        st.subheader("📍 민원 위치 분포")
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

    st.subheader("🤖 AI 민원 요약")
    s = ai_summary()
    if s:
        st.info(s["summary"])
        st.caption(("AI 요약" if s.get("ai") else "통계 기반 요약 (AI 미연결)") + f" · {s['generated_at']}")
    else:
        st.caption("요약을 불러오지 못했어요.")

    st.subheader("📋 공감 많은 민원")
    show = df.sort_values(["likes", "id"], ascending=False)[["id", "유형", "zone", "text", "likes", "ai_urgency", "created_at"]]
    show = show.assign(ai_urgency=show["ai_urgency"].map(URGENCY))
    show.columns = ["번호", "유형", "구역", "내용", "공감", "AI 긴급도", "접수 시각"]
    st.dataframe(show, use_container_width=True, hide_index=True, height=320)
    st.download_button("CSV로 내려받기", show.to_csv(index=False).encode("utf-8-sig"),
                       file_name=f"grid_민원_{datetime.now():%Y%m%d_%H%M}.csv", mime="text/csv")
    st.caption(f"마지막 갱신 {datetime.now():%H:%M:%S}")


board()
