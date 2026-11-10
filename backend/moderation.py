"""장난·부적절한 민원 거르기 (규칙 기반, AI 없이 즉시 동작).

check(text) → (판정, 이유)
  ("reject", 이유)  욕설·비하·성적 표현 → 등록 거절 (400)
  ("review", 이유)  의미 없는 글(자음만, 같은 글자 반복, 자판 막치기) → 받되 '확인 필요'로 숨김
  (None, None)      통과

AI 판정(main.ai_classify)은 이 다음 단계에서 "동네 환경과 관련 있는 진지한 요청인지"를 본다.
목록은 일부러 짧게: 흔한 욕설과 그 변형만 잡고, 애매한 단어는 AI·관리자에게 맡긴다.
"""
import re

# 정규화 후(공백·숫자·특수문자 제거, 소문자) 이 문자열이 들어 있으면 거절
BAD = [
    # 욕설
    "시발", "씨발", "씨빨", "씨팔", "시팔", "쓰발", "썅", "ㅅㅂ", "ㅆㅂ", "ㅅㅃ", "ㅄ",
    "병신", "븅신", "빙신", "ㅂㅅ", "좆", "존나", "ㅈㄴ", "개새", "개색", "ㄱㅅㄲ", "ㅅㄲ",
    "닥쳐", "ㄲㅈ", "지랄", "ㅈㄹ", "미친놈", "미친년", "미친새", "ㅁㅊ", "염병", "엠창", "느금", "니애미",
    "한남충", "김치녀", "틀딱", "급식충", "fuck", "shit", "bitch",
    # 성적 표현
    "섹스", "야동", "porn",
]
# BAD 에 걸려도 실제로는 멀쩡한 낱말 (먼저 지운 뒤 검사)
# ("꺼져"는 "가로등이 꺼져 있어요", "새끼"는 "새끼 고양이" 때문에 BAD 에서 뺐다)
SAFE = ["시발점", "시발역", "시발택시"]

_strip = re.compile(r"[\s\d\W_]+", re.UNICODE)       # 공백·숫자·특수문자 (씨1발, ㅅ.ㅂ, 시 발)
_jamo = re.compile(r"[ㄱ-ㅎㅏ-ㅣ]")
_hangul = re.compile(r"[가-힣]")
_latin = re.compile(r"[a-z]")
MASH = ["asdf", "qwer", "zxcv", "sdfg", "dfgh", "hjkl", "uiop", "ㅁㄴㅇㄹ", "ㅂㅈㄷㄱ", "ㅋㅌㅊㅍ", "ㅇㄹㅇㄹ"]


def normalize(text: str) -> str:
    return _strip.sub("", text.lower())


def check(text: str):
    t = (text or "").strip()
    if not t:
        return None, None
    n = normalize(t)
    clean = n
    for w in SAFE:
        clean = clean.replace(w, "")
    for w in BAD:
        if w in clean:
            return "reject", "부적절한 표현"
    if not n:  # 특수문자·숫자만 ("!!!!", "1234")
        return ("review", "의미 없는 글") if len(t) >= 3 else (None, None)
    jamo = len(_jamo.findall(n))
    if jamo >= 2 and jamo / len(n) >= 0.5:
        return "review", "자음·모음만 있는 글"
    if re.search(r"(.)\1{4,}", n) and len(set(n)) <= 3:
        return "review", "같은 글자만 반복"
    if any(m in n for m in MASH) and not _hangul.search(n):
        return "review", "자판을 막 친 글"
    if not _hangul.search(n) and _latin.search(n) and len(n) >= 6 and not re.search(r"[aeiou]", n):
        return "review", "자판을 막 친 글"
    return None, None
