---
name: score-system-map
description: score-system(용산대성N학원 영어과 성적 관리) 코드베이스의 지도. admin.html / index.html의 탭 구성, 전역 상태, api() 호출 규약, Supabase 테이블·컬럼, DOM 네이밍, 코드 관습을 담는다. admin.html이나 index.html을 읽거나 수정하기 전, 또는 "점수 입력", "문자 발송", "주차", "모의고사", "미인증", "학생 관리", "반 관리", "조교 메모", "학부모 화면", "커트라인", "재시험", "클리닉" 등 이 시스템의 기능을 언급하는 모든 작업에서 반드시 먼저 읽을 것. 어느 파일 어느 줄을 봐야 하는지 추측하지 말고 이 지도를 먼저 참조하라.
---

# score-system 코드베이스 지도

## 이 지도가 필요한 이유

이 프로젝트는 빌드 도구도, 모듈 시스템도, 테스트도 없는 **단일 파일 두 개**로 구성된다.
`admin.html` 3,913줄 · `index.html` 1,381줄, 전부 인라인 `<style>` + `<script>`.
grep 없이 "어디를 고쳐야 하는가"를 알 수 없고, 함수 하나가 168개 전역 함수 중 어디에 얽혀 있는지도 파일을 열어봐야만 안다.
이 지도는 그 탐색 비용을 없애고, 아래 "경계면" 항목으로 회귀 사고를 미리 차단한다.

## 파일 구조

| 파일 | 대상 | 규모 | 진입점 |
|------|------|------|--------|
| `admin.html` | 조교/관리자 | 3,913줄 | 비밀번호 로그인 → `initAdmin()` (L909) |
| `index.html` | 학부모/학생 | 1,381줄 | 이름+PIN 로그인 → `login()` → `showResult()` |

빌드 없음. 파일을 직접 수정하고 커밋하면 그대로 배포된다.
외부 의존성은 `index.html`의 Chart.js CDN 하나뿐 (`chart.umd.min.js@4.4.0`).

## 백엔드 (레포 밖)

Supabase Edge Function 3개. **소스는 이 레포에 없다** — 호출 계약만 지킬 것.

| 함수 | 사용처 | 역할 |
|------|--------|------|
| `admin-api` | admin.html 전체 | 비밀번호 검증 후 PostgREST를 service_role로 대행 |
| `send-sms` | admin.html 문자 탭 4종 | `{ messages: [...] }` 전송 |
| `parent-login` | index.html | 이름+PIN 검증 후 학생 데이터 **묶음 전체**를 한 번에 반환 |

`index.html`은 `admin-api`를 쓰지 않는다. 학부모 화면이 보는 모든 데이터는 `parent-login`의 응답 하나에서 나온다.
따라서 학부모 화면에 새 데이터를 노출하려면 프론트만으로는 불가능하며, `parent-login` 응답 변경이 선행돼야 한다. 이 경우 사용자에게 백엔드 변경 필요를 먼저 알릴 것.

## admin.html — API 호출 규약

모든 데이터 접근은 이 세 헬퍼를 통한다 (L843~871). `fetch`를 직접 쓰지 말 것 (문자 발송 제외).

| 헬퍼 | 반환 | 언제 쓰나 |
|------|------|----------|
| `api(path, method, body, prefer)` | 파싱된 JSON 또는 `null` | 조회, 성공 여부를 따질 필요 없는 쓰기 |
| `apiRaw(path, method, body, prefer)` | `{ ok, status }` | 저장 결과를 건별로 집계해야 할 때 (점수 저장 등) |
| `apiDelete(path)` | 없음, 실패 시 **throw** | 모든 DELETE |

`path`는 PostgREST 쿼리 문자열이다 — 예: `scores?week_id=eq.12&select=*`.

**`apiDelete`가 따로 있는 이유:** `api()`는 응답 상태를 보지 않는다. 참조 중인 점수가 남은 행을 지우면 외래키 제약으로 거부되는데, `api()`로 지우면 실패해도 성공처럼 보였다(실제 발생한 버그, L862 주석). 삭제는 반드시 `apiDelete`.

인증은 `adminPassword` 전역 변수(메모리 전용, L840)에 담겨 매 요청 body에 실린다. 401이면 `handleAuthError()`가 리로드한다.

## 데이터 모델

7개 테이블. 상세 컬럼과 관계는 `references/schema.md` 참조.

```
classes ─┬─ students ─┬─ scores ── weeks
         ├─ weeks     └─ mock_scores ── mock_exams
         └─ mock_exams
memos (독립)
```

## 탭 인벤토리

`admin.html`의 11개 탭과 담당 함수 범위는 `references/tabs.md` 참조.
탭 전환은 `switchTab(tabId)` (L915) — 점수 탭을 벗어날 때 `scoreDirty` 확인 후 경고한다.

## 가장 위험한 경계면 — 항목 설정(item_config) 이중 구현

`weeks.item_config` / `mock_exams.item_config`는 JSON 컬럼으로, 4개 채점 항목의 이름·만점·커트라인·활성 여부를 담는다.

**`admin.html`과 `index.html`이 이 규약을 각각 복제해서 구현한다.**

| 심볼 | admin.html | index.html |
|------|-----------|------------|
| `ITEM_KEYS` | L1113 | L607 |
| `DEFAULT_ITEM_CONFIG` | L1115 | L615 |
| `MOCK_ITEM_KEYS` / `DEFAULT_MOCK_ITEM_CONFIG` | L1134 / L1135 | L624 / L630 |
| `normalizeItemConfig(raw, defaults)` | L1144 | L639 |

한쪽만 고치면 관리자 화면과 학부모 화면의 점수 해석이 어긋난다. 화면에는 아무 오류도 뜨지 않고 숫자만 조용히 달라진다.
**이 심볼 중 하나라도 건드리면 반드시 양쪽 파일을 함께 수정하고, 양쪽을 나란히 놓고 비교 검증할 것.**

`item_config`가 NULL인 기존 주차는 기본값(단어25/해석30/객관식45)으로 동작해야 한다. 이 하위 호환을 깨지 말 것.

## 코드 관습

새 코드는 주변 코드와 구분되지 않아야 한다.

- **바닐라 JS, 전역 함수 선언** — `function name() {}`을 최상위에 두고 HTML `onclick`에서 직접 호출한다. 모듈·클래스·프레임워크를 도입하지 말 것.
- **CSS 변수 팔레트** — `--navy #0f1f3d`, `--gold #c8a96e`, `--cream #f8f5f0`, `--red`, `--orange`, `--green` 및 각 `-light`. 새 색을 하드코딩하지 말고 기존 변수를 쓸 것.
- **버튼 클래스** — `.btn` + `.btn-primary` / `.btn-gold` / `.btn-danger` (+ `.btn-sm`, `.btn-full`).
- **사용자 피드백** — `showToast(msg)`. 성공은 `✅ ...했어요!`, 실패는 `❌ ...`. `alert()`는 쓰지 않는다(`confirm()`은 파괴적 작업 확인에만).
- **UI 문구는 전부 한국어**, 존댓말 반말 혼용 금지 — 기존 톤("저장됐어요!")을 따를 것.
- **모듈 스코프 대용 접두사** — 탭 전용 전역 상태는 `_uncertOffset`, `_clinicRecipient`처럼 언더스코어 접두사를 쓴다.
- **주석은 한국어로, 왜 그런지를 남긴다** — 기존 주석들이 버그 재발 방지 맥락을 담고 있다(L854, L862, L1846 등). 이 주석을 지우지 말 것.
- **XSS** — 사용자 입력을 innerHTML에 넣을 때 `escapeHtml()` / `escapeAttr()` / `attrEsc()`를 쓴다.

## 알려진 결함 (건드릴 때 참고)

- `updateClassGrade`가 L2751과 L2759에 **중복 정의**돼 있다. 뒤 정의가 앞을 덮는다. 반 관리 탭 작업 시 정리 대상.
- `ANON_KEY`가 두 파일에 평문으로 박혀 있다. Supabase anon key라 설계상 공개값이지만, RLS/Edge Function 검증에 의존한다는 뜻이므로 새 테이블 접근을 프론트에서 직접 열지 말 것.

## 배포

`origin` = `github.com/jongchankim-cloud/score-system`, 기본 브랜치 `main`.
커밋 메시지는 한국어 + Conventional Commits 접두사(`feat:`, `fix:`, `refactor:`, `style:`, `chore:`, `add:`).
