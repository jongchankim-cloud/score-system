# 데이터 모델 (Supabase / PostgREST)

프론트 코드에서 역추적한 스키마다. 마이그레이션 파일이 레포에 없으므로 이 문서가 유일한 스키마 기록이며,
실제 DB와 어긋날 수 있다. 새 컬럼을 가정하기 전에 실제 응답을 `select=*`로 확인할 것.

## 목차
- [classes](#classes) · [students](#students) · [weeks](#weeks) · [scores](#scores)
- [mock_exams](#mock_exams) · [mock_scores](#mock_scores) · [memos](#memos)
- [item_config JSON 규약](#item_config-json-규약)
- [비교 그룹(group_id) 규약](#비교-그룹group_id-규약)
- [삭제 순서 (외래키)](#삭제-순서-외래키)

## classes
반. `id, name, grade, day, time`
`day`는 한글 요일 문자열('월'~'일'), `DAY_INDEX`(L959)로 숫자 변환된다. `time`은 NULL 허용.

## students
`id, name, pin, phone, student_phone, class_id, is_active, note`
- `phone` = 학부모 번호, `student_phone` = 학생 번호. **문자 발송 탭에서 수신처를 고르는 근거**이므로 둘을 혼동하지 말 것.
- `is_active=false`는 퇴원/휴원 처리. 대부분의 조회가 `is_active=eq.true`로 필터한다.
- `pin`은 index.html 학부모 로그인 인증값.

## weeks
주차(주간 테스트). `id, class_id, test_date, label, group_id, item_config, memo`
- `label`이 화면에 보이는 이름, `test_date`는 정렬·기준일 계산용.
- `memo`는 그 주차 전체에 붙는 메모(학생별 아님).

## scores
주차별 학생 성적. 한 학생 × 한 주차 = 한 행.

| 컬럼 | 의미 |
|------|------|
| `student_id`, `week_id` | 복합 키 역할 (DB 제약 여부는 미확인 — 코드가 직접 중복 방지) |
| `word_score`, `reading_score`, `mc_score`, `item4_score` | 채점 항목 4슬롯. `ITEM_KEYS`와 1:1 |
| `retest_pass` | JSON. `{ "word_score": true, ... }` 통과한 재시험 항목만. 없으면 NULL |
| `no_homework` | 그 주차에 과제 자체가 없었음 |
| `homework_rate` | 과제 수행률(정수). `no_homework`면 NULL |
| `homework_eval`, `hw_cert` | 과제 평가 / 과제 인증 문자열 |
| `attendance` | 출석 |
| `clinic_target`, `clinic_attend`, `clinic_memo` | 클리닉 대상 여부 / 참석 / 메모 |

**저장 방식(`saveAllScores` L1840):** `week_id`로 기존 행을 조회해 `existMap`을 만들고,
있으면 PATCH(`student_id`, `week_id` 제외), 없으면 POST. 비활성 항목 컬럼은 payload에서 빠지므로 기존 값이 보존된다.
이 "비활성 항목은 건드리지 않는다" 규칙을 깨면 항목을 껐다 켰을 때 과거 점수가 날아간다.

## mock_exams
모의고사. `id, class_id, exam_date, label, group_id, item_config`

## mock_scores
`id, exam_id, student_id, item1_score~item4_score, score, absent, memo, retest_pass`
- `score`는 **레거시 총점 컬럼이지만 계속 채운다.** 학부모 화면이 항목 컬럼 없이도 총점·평균을 계산할 수 있게 하기 위함(L3605 주석). 항목 점수를 저장할 때 합계를 반드시 `score`에도 넣을 것.
- `absent=true`면 모든 항목 점수와 `retest_pass`를 NULL로 통일한다. 점수와 미응시가 동시에 남지 않게 하는 불변식이다.

## memos
조교 메모. `id, author, content, created_at` — 다른 테이블과 무관한 독립 게시판.

## item_config JSON 규약

```json
{ "items": [ { "key": "word_score", "label": "단어", "max": 25, "cut": null, "active": true }, ... ] }
```

- 항상 4개 슬롯. `key`는 `ITEM_KEYS`(주차) 또는 `MOCK_ITEM_KEYS`(모의고사)의 고정 순서.
- `active: false`인 슬롯은 화면에서 숨기고 저장에서 제외한다 (삭제가 아니라 보존).
- `cut`은 커트라인. 미달 시 학부모 화면에 표시되고 재시험 체크박스가 나타난다(`isBelowCut` L1164).
- **NULL이면 기본값으로 동작** — 기존 주차 하위 호환. `normalizeItemConfig(raw, defaults)`가 이 정규화를 담당하며 admin/index 양쪽에 복제돼 있다.

## 비교 그룹(group_id) 규약

여러 반이 같은 시험을 볼 때 `group_id`를 공유해 그룹 평균·석차를 계산한다.
`weeks`와 `mock_exams` 양쪽에 있다. 그룹 조회는 `?group_id=eq.{id}`.
관련 함수: `refreshGroupInfo`(L1425), `refreshMockGroupInfo`(L3414), `renderGroupEditor`(L1513), `saveGroupEdit`(L1611).
그룹 편집은 주차/모의고사 두 종류를 `GROUP_KINDS`(L1481) + `kind` 인자로 공용 처리한다.

## 삭제 순서 (외래키)

자식 행이 남아 있으면 부모 삭제가 거부된다. 반드시 안쪽부터 지울 것.

```
반 삭제:      mock_scores → mock_exams → scores → weeks → students → classes
주차 삭제:    scores → weeks
모의고사 삭제: mock_scores → mock_exams
학생 삭제:    scores + mock_scores → students
```

`deleteClass`(L2801), `deleteStudent`(L3787), `deleteWeek`(L1084), `deleteMockExam`(L3651)이 이 순서를 구현한다.
새 자식 테이블이 생기면 이 네 함수 전부를 갱신해야 한다.
