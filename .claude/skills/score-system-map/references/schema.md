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

## data_history (변경 이력) — 2026-09 도입

`scores`·`students`·`weeks`·`mock_scores`·`mock_exams`·`classes` 행이 **UPDATE 또는 DELETE** 될 때, DB 트리거(`log_row_history`)가
직전 행을 통째로 여기에 남긴다. 8.31 주차의 과제%·과제평가·클리닉 메모가 옛 화면 저장으로 통째로 지워진 사고 이후 도입.

`id, table_name, row_id, op('UPDATE'|'DELETE'), old_row(jsonb), new_row(jsonb, DELETE면 NULL), changed_at`

- 값이 하나도 안 바뀐 UPDATE는 기록하지 않는다 (같은 화면 반복 저장으로 이력이 불지 않도록).
- RLS 켜짐 + anon/authenticated 권한 없음 → 프론트(admin-api 경유 포함)에서는 보이지 않고, Supabase 대시보드/SQL(service_role)로만 조회한다.
- **복구 절차 (예: 어떤 주차의 과제 칸이 빈 값으로 덮어써졌을 때):**
  ```sql
  -- 1) 사고 시각 직전의 값을 찾는다 (week_id, 시각은 상황에 맞게)
  select row_id, old_row->>'homework_eval', old_row->>'clinic_memo', changed_at
  from data_history where table_name='scores' and (old_row->>'week_id')::int = 76
  order by changed_at desc;
  -- 2) 해당 이력의 old_row로 되돌린다 (컬럼별로 명시)
  update scores s set homework_rate = (h.old_row->>'homework_rate')::int,
                      homework_eval = h.old_row->>'homework_eval',
                      clinic_memo   = h.old_row->>'clinic_memo'
  from data_history h where h.table_name='scores' and h.row_id = s.id and h.id = <이력 id>;
  ```
  되돌리는 UPDATE 자체도 이력에 남으므로 잘못 되돌려도 다시 되돌릴 수 있다.
- 이력은 삭제하지 않는다. 용량이 문제 되면 `changed_at`이 오래된 것부터 지운다 (Free 플랜 500MB 기준 수년치 여유).
- Supabase Free 플랜이라 플랫폼 백업은 없다. 이 이력이 유일한 되돌리기 수단이다.

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
