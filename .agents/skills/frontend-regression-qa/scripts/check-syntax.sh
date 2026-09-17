#!/usr/bin/env bash
# 인라인 <script> 블록을 추출해 node --check로 구문 검증한다.
# 빌드가 없는 프로젝트라 구문 오류는 브라우저에서만 드러난다 — 그 전에 잡는 게 목적.
# 사용: check-syntax.sh [파일...]   (인자 없으면 admin.html index.html)
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
files=("$@"); [ ${#files[@]} -eq 0 ] && files=(admin.html index.html)
fail=0
for f in "${files[@]}"; do
  [ -f "$f" ] || { echo "SKIP $f (없음)"; continue; }
  tmp=$(mktemp /tmp/qa-XXXX.js)
  # src= 속성이 있는 <script>(CDN)는 제외하고 인라인 본문만 모은다
  awk '/<script>/{on=1;next} /<\/script>/{on=0;next} on' "$f" > "$tmp"
  if [ ! -s "$tmp" ]; then echo "SKIP $f (인라인 script 없음)"; rm -f "$tmp"; continue; fi
  if node --check "$tmp" 2>/tmp/qa-err; then
    echo "OK   $f  ($(wc -l < "$tmp" | tr -d ' ')줄)"
  else
    echo "FAIL $f"; sed 's/^/     /' /tmp/qa-err; fail=1
  fi
  rm -f "$tmp"
done
exit $fail
