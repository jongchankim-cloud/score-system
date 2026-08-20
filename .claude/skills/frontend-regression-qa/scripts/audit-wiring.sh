#!/usr/bin/env bash
# 정적 배선 감사: 브라우저를 켜지 않고 잡을 수 있는 경계면 결함을 찾는다.
#  1) on*= 속성이 호출하는데 정의가 없는 함수
#  2) getElementById로 읽는데 HTML에 없는 id
#  3) 반 선택 select인데 CLASS_SELECT_IDS 미등록 (admin.html)
#  4) admin.html ↔ index.html 항목설정 규약 불일치
#  5) 중복 정의된 함수
# 결과는 "후보"다. 문자열로 동적 생성되는 id/핸들러 때문에 오탐이 날 수 있으니 눈으로 확인할 것.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
sec() { printf '\n== %s ==\n' "$1"; }
# hit이 파이프라인 서브셸에서 불리므로 변수 대신 파일로 발견 여부를 누적한다
HITS=$(mktemp /tmp/qa-hits-XXXX)
trap 'rm -f "$HITS"' EXIT
hit() { echo "  $1"; echo "$1" >> "$HITS"; }

# CLASS_SELECT_IDS에 의도적으로 넣지 않는 select (별도 로직이 채운다)
CLASS_SELECT_EXCEPTIONS="move-target-class"

for f in admin.html index.html; do
  [ -f "$f" ] || continue
  defs=$(grep -oE '^[[:space:]]*(async +)?function +[A-Za-z0-9_]+' "$f" | grep -oE '[A-Za-z0-9_]+$' | sort -u)

  sec "$f: 정의 없는 핸들러"
  # 이름 뒤에 '('가 붙은 호출만 본다 → onchange="scoreDirty=true" 같은 대입문 오탐 제거
  grep -oE 'on[a-z]+="[A-Za-z0-9_]+\(' "$f" | grep -oE '[A-Za-z0-9_]+\($' | tr -d '(' | sort -u \
    | grep -vwE 'if|for|while|switch|return|function|alert|confirm|prompt|console|parseInt|parseFloat' \
    | while read -r fn; do grep -qx "$fn" <<<"$defs" || hit "미정의: $fn()"; done

  sec "$f: HTML에 없는 id"
  ids=$(grep -oE 'id="[A-Za-z0-9_-]+"' "$f" | sed 's/id="//;s/"//' | sort -u)
  grep -oE "getElementById\(['\"][A-Za-z0-9_-]+" "$f" | grep -oE "[A-Za-z0-9_-]+$" | sort -u \
    | while read -r id; do grep -qx "$id" <<<"$ids" || hit "없음: #$id"; done

  sec "$f: 중복 정의 함수"
  grep -oE '^[[:space:]]*(async +)?function +[A-Za-z0-9_]+' "$f" | grep -oE '[A-Za-z0-9_]+$' \
    | sort | uniq -d | while read -r fn; do hit "중복: $fn()"; done
done

if [ -f admin.html ]; then
  sec "CLASS_SELECT_IDS 배선"
  reg=$(grep -A2 'CLASS_SELECT_IDS' admin.html | grep -oE "'[a-z0-9-]+'" | tr -d "'" | sort -u)
  ids=$(grep -oE 'id="[A-Za-z0-9_-]+"' admin.html | sed 's/id="//;s/"//' | sort -u)
  while read -r id; do grep -qx "$id" <<<"$ids" || hit "등록됐지만 HTML에 없음: #$id"; done <<<"$reg"
  grep -oE 'select id="[a-z0-9-]+-class"' admin.html | grep -oE '"[a-z0-9-]+"' | tr -d '"' | sort -u \
    | while read -r id; do
        grep -qx "$id" <<<"$reg" && continue
        grep -qw "$id" <<<"$CLASS_SELECT_EXCEPTIONS" && continue
        hit "반 select인데 CLASS_SELECT_IDS 누락: #$id"
      done
fi

if [ -f admin.html ] && [ -f index.html ]; then
  sec "항목설정 규약 admin ↔ index 대조"
  # const NAME = [ ... ]; 블록만 정확히 떼어내 비교 (index.html은 prettier 포맷이라 줄바꿈이 다름)
  extract() { awk -v n="$2" '$0 ~ ("const +" n " *=") {on=1} on {print} on && /\];/ {exit}' "$1" \
      | grep -oE "(word|reading|mc|item[1-4])_score|max: *[0-9]+|max: *null|cut: *[a-z0-9]+|active: *(true|false)" | tr -d ' ' | tr '\n' ' '; }
  for sym in ITEM_KEYS DEFAULT_ITEM_CONFIG MOCK_ITEM_KEYS DEFAULT_MOCK_ITEM_CONFIG; do
    a=$(extract admin.html "$sym"); i=$(extract index.html "$sym")
    if [ "$a" = "$i" ] && [ -n "$a" ]; then echo "  일치: $sym"
    else hit "불일치: $sym"; echo "    admin: ${a:-<추출실패>}"; echo "    index: ${i:-<추출실패>}"; fi
  done
fi
printf '\n'
if [ -s "$HITS" ]; then
  echo "발견 $(wc -l < "$HITS" | tr -d ' ')건 — 위 항목을 확인할 것"
  exit 1
fi
echo "감사 통과 — 발견 항목 없음"
exit 0
