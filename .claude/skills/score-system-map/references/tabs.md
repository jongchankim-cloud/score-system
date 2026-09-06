# admin.html 탭 인벤토리

11개 탭. HTML 블록과 JS 함수 블록이 **다른 순서로** 배치돼 있으므로, 탭 이름만 보고 위치를 짐작하지 말고 이 표를 쓸 것.
줄 번호는 작업 시점에 밀릴 수 있다 — 함수 이름으로 grep해 확인하고 쓰라.

| 탭 라벨 | id | HTML | JS 함수 블록 | 주요 함수 |
|---------|-----|------|-------------|----------|
| 점수 입력 | `tab-score` | 219~ | 1101~1893 | `loadScoreInputs` 1349 · `renderScoreInputs` 1783 · `saveAllScores` 1840 · `saveItemConfig` 1670 · `refreshGroupInfo` 1425 |
| 주차 관리 | `tab-week` | 299~ | 939~1100 | `addWeek` 1045 · `loadWeekList` 1074 · `deleteWeek` 1084 · `renderWeekPreview` 1024 |
| 학생 관리 | `tab-student` | 338~ | 3668~3807 | `addStudent` 3668 · `loadStudentList` 3720 · `searchStudents` 3734 · `deleteStudent` 3787 · 반 이동 모달 2056~2281 |
| 모의고사 | `tab-mock` | 371~ | 3211~3667 | `addMockExam` 3227 · `loadMockScoreInputs` 3292 · `saveMockScores` 3596 · `deleteMockExam` 3651 |
| 학부모 문자 발송 | `tab-sms` | 463~ | 2831~2955 | `loadSmsTargets` 2842 · `makeSmsText` 2885 · `sendAllSms` 2920 |
| 반 관리 | `tab-class` | 504~ | 2697~2830 | `loadClassList` 2697 · `addClass` 2778 · `deleteClass` 2801 · `refreshClassSelects` 2729 |
| 미인증 관리 | `tab-uncert` | 547~ | 1887~2055 (①) + 2411~2512 (②) | ① `loadUncertGrid` 1894 · `renderUncertGrid` 1917 · `saveUncertGrid` 2010 ② `loadStudentSmsTargets` 2422 · `sendStudentSms` 2485 |
| 테스트 미응시 문자 발송 | `tab-absent-sms` | 628~ | 2282~2410 | `loadAbsentTargets` 2298 · `sendAbsentSms` 2384 |
| 조교 메모 | `tab-memo` | 670~ | 3847~3910 | `addMemo` 3872 · `loadMemos` 3883 · `deleteMemo` 3905 |
| 성적 문자 발송 | `tab-score-sms` | 701~ | 2956~3210 | `loadScoreSmsTargets` 3054 · `composeScoreSms` 3102 · `sendScoreSms` 3183 · 템플릿 설정 2984~3037 |
| 변경 이력 · 되돌리기 | `tab-history` | 배정표 탭 뒤 | `// ── 변경 이력` 블록 | `loadHistory` · `restoreHistoryEntry` · `restoreHistoryUpTo` — `data_history`(읽기 전용) 조회, 되돌리기는 scores PATCH/POST |
| 클리닉 배정표 | `tab-clinic-schedule` | 클리닉 문자 탭 뒤 | `// ── 클리닉 배정표` 블록 | `loadClinicSchedule` · `parseClinicMemo` |
| 클리닉 미참석 문자 발송 | `tab-clinic-sms` | 763~ | 2513~2696 | `loadClinicSmsTargets` 2536 · `sendClinicSms` 2617 · `saveClinicGrid` 2658 |

## 탭 추가 시 손대야 하는 5곳

탭 하나를 추가하려면 아래를 **전부** 갱신해야 한다. 하나라도 빠지면 탭이 안 뜨거나 반 목록이 비어 보인다.

1. `.tab-bar` 안에 `<button class="tab-btn" onclick="switchTab('tab-xxx')">라벨</button>`
2. `<div id="tab-xxx" class="tab-content">` 블록 (`.active` 없이 — `switchTab`이 붙인다)
3. 반 선택 `<select>`를 쓴다면 그 id를 `CLASS_SELECT_IDS`(L908)에 추가 — 여기 빠지면 반 목록이 채워지지 않는다
4. `switchTab`(L915)에 해당 탭 진입 시 로더 호출 추가
5. 탭 전용 상태는 `_xxx` 접두사 전역으로, 함수 블록은 관련 탭 근처에 배치

## 문자 발송 탭 4종의 공통 구조

`tab-sms` / `tab-absent-sms` / `tab-clinic-sms` / `tab-score-sms`와 `tab-uncert`의 ②는 같은 골격을 각자 복제한 것이다.

```
반 선택 → load{X}Weeks() → 주차 선택 → load{X}Targets() → 체크박스 목록 렌더
                                                        → toggleAll{X}() 전체선택
                                                        → send{X}Sms() → SMS_FUNCTION_URL POST { messages }
```

- 수신처는 `students.phone`(학부모) / `students.student_phone`(학생) 중 선택. `_clinicRecipient`, `_scoreSmsRecipient` 전역이 이를 보관한다.
- 문자 한 건은 `{ to, text }` 형태로 `messages` 배열에 담긴다. 실제 필드명은 `sendAllSms`(L2920) 등 기존 호출부를 그대로 따를 것.
- `smsByteLength`(L3015)로 길이를 계산한다 — 한글은 2바이트, SMS/LMS 경계 판단용.
- **한 탭의 발송 로직을 고칠 때 나머지 3~4곳이 같은 결함을 공유하는지 반드시 확인할 것.** 복제 구조라 버그도 복제돼 있다.

## index.html 화면 흐름

```
login-section  ── login() ─→ parent-login ─→ loginData(전체 묶음)
result-section ── showResult()
   ├─ result-name / result-class      학생 정보
   ├─ summary-grid (cum-avg, cum-best) 누적 요약
   ├─ chart-card / score-chart         Chart.js 추이 그래프
   ├─ period-select                    기간 필터
   ├─ score-content                    주차별 성적 상세
   └─ mock-score-section               모의고사 성적
```

전역 상태: `currentStudent`, `currentWeeks`, `allScores`, `chartInstance`, `loginData`, `weekConfigMap`.
`chartInstance`는 재렌더 전 반드시 `destroy()` — 안 하면 차트가 겹쳐 그려진다.
