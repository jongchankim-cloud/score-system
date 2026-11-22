# admin.html 탭 인벤토리

11개 탭. HTML 블록과 JS 함수 블록이 **다른 순서로** 배치돼 있으므로, 탭 이름만 보고 위치를 짐작하지 말고 이 표를 쓸 것.
줄 번호는 작업 시점에 밀릴 수 있다 — 함수 이름으로 grep해 확인하고 쓰라.

| 탭 라벨 | id | HTML | JS 함수 블록 | 주요 함수 |
|---------|-----|------|-------------|----------|
| 점수 입력 | `tab-score` | 219~ | 1101~1893 | `loadScoreInputs` 1349 · `renderScoreInputs` 1783 · `saveAllScores` 1840 · `saveItemConfig` 1670 · `refreshGroupInfo` 1425 · **그룹 항목 맞추기(2026-11)** `refreshGroupInfo`의 '항목 구성이 다른 반' 경고(지금 보는 주차는 빼고 비교) 밑 버튼 `groupAdoptButtons` → `adoptGroupItemConfig('week', id)`: 그 반 항목·만점을 편집 칸으로만 불러옴(저장 안 함, `adoptedItemConfig` — 이 반에 저장된 같은 key·같은 이름의 커트는 유지), 저장 전 안내 `_itemCfgAdopted`/`adoptedNoteHtml`. 모의고사도 같은 함수('mock') · **학생별 시험지(스캔 PDF, 2026-11-22)** 점수 표 밑 `#week-test-box`, `// ── 주차 시험지` 블록: `loadWeekTestPanel`(표를 그린 뒤) · `onWeekTestFile`(PDF 여러 개 가능 — `loadWeekTestPdfs` 이름순 → 먼저 설정 단계 `_wtDoc.stage='setup'`: 파일 표에서 순서 ▲▼ `moveWeekTestFile(i, dir)`·빼기 `removeWeekTestFile`·파일별 '학생 한 명당 쪽 수' `setWeekTestPer`(0=자동, 반 인원으로 짐작 `wtGuessPer`; 정하면 각 학생 첫 쪽 `wtIsHead`만 AI/직접 고르기, 나머지는 '앞 쪽에 이어서') → 'AI로 이름 읽기 시작'/'AI 없이 직접 고르기' `startWeekTestRead(manual)`; AI 크레딧 소진(Gemini 402)이면 남은 쪽 안 보내고 안내; 학생 칸 '다른 반 학생 찾기…' `openWeekTestOther`/`pickWeekTestOther` → 그 반 같은 주 주차(`guestMatchWeek`)로 `_wtDoc.extra`, 경로 `wtPathOf`가 그 주차로; 현황 '모두 삭제' `deleteAllWeekTests`; 검토 중 'PDF 더 넣기' `addWeekTestFiles`; 쪽은 `{uid, file, pno}`, '앞 쪽에 이어서'·중복 경고는 같은 파일 안에서만, 올릴 때 학생별로 파일 순서대로 이어 붙임 `buildPdfFromPages` — 모의고사 `buildMockReportPdf`도 이걸 씀) → 쪽 윗부분(이름 칸) 사진 `ensureWeekTestCrop` → AI 이름 읽기 `readWeekTestNames`(`callNameReader` → 함수 name-reader, 8쪽씩, 429면 기다렸다 다시) → `applyWeekTestAi`(확실하면 그 학생, 앞 쪽과 같은 학생·이름 없는 쪽은 '앞 쪽에 이어서', 애매·못 찾음·이름 없음·실패는 `flag`) · 확인 관문 `weekTestIssues`(flag·같은 학생 두 곳) → '모두 확인했어요' 체크(`setWeekTestConfirmed`, 학생 칸을 바꾸면 풀림)해야 올리기 켜짐 · `uploadWeekTests`(분석지의 `buildMockReportPdf`·`putMockReport`·`reportStorage` 재사용, 경로 `w{주차id}/{학생id}.pdf`) · `setWeekTestPublished`(weeks.report_published). 점수 자동 입력 없음 |
| 점수 입력 · 자동 저장 / 다른 반 학생 입력 | `tab-score` | 점수 입력 탭 | `// ── 점수 입력 탭 자동 저장`, `// ── 다른 반 학생 점수 입력` 블록 | 칸 `change` 때 `queueScoreAutoSave` → `autoSaveScoreRow`(학생별 순서, 저장 직전 DB 재조회·충돌 확인, 바뀐 칸만 PATCH, 행 없으면 POST). 공용: `scoreFieldsOf`·`scoreDiff`·`scoreConflicts`·`scoreWritePlan`·`apiReqRetry`(429·5xx 3회 재시도). 다른 반 학생: `openGuestModal`·`guestPick`(같은 비교 그룹 → 같은 주 주차, 없으면 지금 주차 그룹·항목으로 새 주차)·`guestSave` |
| 클리닉 배정표 | `tab-clinic-schedule` | 성적 문자 탭 뒤 | `// ── 클리닉 배정표` 블록 | `loadClinicSchedule` · `parseClinicMemo` · 학년 탭 `clinicTabOf`(반 이름에 '보성' → '보성여고' 탭, 나머지는 classes.grade. 주차 뒤처짐 판정은 실제 학년끼리) · 출석 체크 `toggleClinicAttend`(scores.clinic_attend, 한 주에 한 번) · `clinicExpectedOf`(배정표 대상 판정, 전체 공지 '클리닉 미참석만 선택'에 공유) · 이름 클릭 메모 창 `openClinicMemoEdit`/`saveClinicMemoEdit`(취소·Esc는 `requestCloseClinicMemoModal` — `clinicMemoHasUnsavedChanges`로 메모·점수·재시험·과제가 바뀌었으면 확인 후 닫기) — 최근 4주 점수 표(`loadClinicMemoRetest`: 맨 윗줄=기준 주차 전 항목 입력칸+커트 미달 칸 밑 재시험 체크, 아래 3주는 보기만) · 바뀐 칸만 저장(`collectClinicMemoScores`·`collectClinicMemoRetest`, 지우면 확인, 저장 직전 재조회로 충돌 확인, 저장 시 `syncScoreTabCells`로 점수 입력 탭 같은 주차 줄도 맞춤) · **학생 클리닉 신청(2026-11)**: 신청(clinic_bookings, status=booked)이 있으면 `clinicBookingMemo`로 메모 대신 그 시간에 배치·`신청` 배지(점수 행 없는 신청은 이름만) · 메모 창에 신청 표시(`#clinic-memo-booking`) · 문자 {클리닉}=신청 시간(`clinicBookingLabel`) · 탭 맨 아래 '학생 클리닉 신청 설정' 카드(`toggleClinicBookingSettings`/`saveClinicBookingSettings`, app_settings `clinicBooking.v1` = { enabled, teacherPhone, hours: [{day,start,end}], interval, templates: { change, cancel, remind } }) · 운영 시간(모든 학년 공통) `renderClinicBookingHours`/`addClinicBookingHours`/`removeClinicBookingHours`/`onClinicBookingHoursInput`·`onClinicBookingIntervalInput`, 개수 미리보기 `updateClinicBookingHoursSummary`(`cbRowTimes` ★ clinic-book `slotsFromHours`와 같은 규칙) · 자동 취소 기준 `.cb-auto`(`#cb-auto-enabled`·`#cb-auto-hw`, `cbAutoCancelOf` ★ clinic-book `autoCancelOf`와 같은 기본값) · 문자 문구 칸 3개 `renderClinicBookingTemplates`(미리보기 `previewClinicBookingTemplate`, 칸 버튼 `insertClinicBookingVar`, `resetClinicBookingTemplate`, 기본 문구 `CB_DEFAULT_TEMPLATES` ★ clinic-book·clinic-remind 기본 문구와 같아야 함). 처음 신청은 문자 없음, 변경·취소는 학부모+선생님 |
| 주차 관리 | `tab-week` | 299~ | 939~1100 | `addWeek` 1045 · `loadWeekList` 1074 · `deleteWeek` 1084 · `renderWeekPreview` 1024 |
| 학생 관리 | `tab-student` | 338~ | 3668~3807 | `addStudent` 3668 · `loadStudentList` 3720 · `searchStudents` 3734 · `deleteStudent` 3787 · 반 이동 모달 2056~2281 · **학생 상세 화면(2026-11)** 목록 이름(`.st-name-link`) 클릭 → `openStudentInfo`: `#student-list-view`를 숨기고 `#student-detail-view`를 보인다(`history.pushState` `#student-{id}`, `popstate`·`closeStudentInfo`로 목록 복귀·스크롤 복원) → `renderStudentInfo`: 요약 칩(출석률·결석·클리닉 출석 `siAttendOf`·과제·재시험·최근 평균) · 이름 수정(`saveStudentInfoName`, 이름만 여기서 — PIN·연락처·특이사항은 목록 칸) · 주차별 성적 `renderSiWeeks` · 출결 `renderSiAttendance` · 학교 내신 `renderSiGrades`/`saveSiGrade`/`deleteSiGrade`(school_grades) · 특이사항 `saveStudentInfoNote` · 모의고사 `renderSiMocks` · 상담 기록 `renderSiCounsel`/`editSiNote`/`saveSiNote`/`deleteSiNote`(counsel_notes — 9월 시험용 counsel_drafts는 안 보임) · 반 이동·퇴원 `renderSiMoves`(data_history). 학생 외 구역은 따로 실패 표시 |
| 퇴원생 (학생 관리 하단 카드) | `tab-student` 안 `#withdrawn-card` | 학생 목록 카드 아래 | `// ── 퇴원생` 블록 | `toggleWithdrawnCard` · `refreshWithdrawnCard` · `loadWithdrawnStudents` · `toggleWithdrawnRecords` · `restoreWithdrawn` — `is_active=false` 학생만, 접혀 있으면 인원만 센다. 퇴원일은 `data_history`에서 찾음. 학생 목록·검색은 재원생만 보여준다 |
| 모의고사 | `tab-mock` | 371~ | 3211~3667 | `addMockExam` 3227 · `loadMockScoreInputs` 3292 · `saveMockScores` 3596 · `deleteMockExam` 3651 |
| 반 관리 | `tab-class` | 504~ | 2697~2830 | `loadClassList` 2697 · `addClass` 2778 · `deleteClass` 2801 · `refreshClassSelects` 2729 |
| 조교 메모 | `tab-memo` | 670~ | 3847~3910 | `addMemo` 3872 · `loadMemos` 3883 · `deleteMemo` 3905 |
| 성적 문자 발송 | `tab-score-sms` | 701~ | 2956~3210 | `loadScoreSmsTargets` 3054 · `composeScoreSms` 3102 · `sendScoreSms` 3183 · 템플릿 설정 2984~3037 · **문자 종류 전환(2026-11)** `pickScoreSmsKind`: 성적 문자 / 전체 공지(`#tab-score-sms.notice-mode`로 `.score-only`/`.notice-only` 표시 전환). 전체 공지 = `notice-class`(전체 반 포함, CLASS_SELECT_IDS 밖, `fillNoticeClassSelect`) → `loadNoticeTargets` → `renderNoticeList`·`composeNoticeSms`({이름}{반}{주차}{클리닉}) · `pickNoticeClinicMissed`(배정표와 같은 기준 주차에서 `clinicExpectedOf` && !clinic_attend만 체크) · `sendNoticeSms`. 문구는 localStorage `noticeSms.v1` |
## 탭 추가 시 손대야 하는 5곳

탭 하나를 추가하려면 아래를 **전부** 갱신해야 한다. 하나라도 빠지면 탭이 안 뜨거나 반 목록이 비어 보인다.

1. `.tab-bar` 안에 `<button class="tab-btn" onclick="switchTab('tab-xxx')">라벨</button>`
2. `<div id="tab-xxx" class="tab-content">` 블록 (`.active` 없이 — `switchTab`이 붙인다)
3. 반 선택 `<select>`를 쓴다면 그 id를 `CLASS_SELECT_IDS`(L908)에 추가 — 여기 빠지면 반 목록이 채워지지 않는다
4. `switchTab`(L915)에 해당 탭 진입 시 로더 호출 추가
5. 탭 전용 상태는 `_xxx` 접두사 전역으로, 함수 블록은 관련 탭 근처에 배치

## 문자 발송의 공통 구조

2026-11에 `tab-sms`(학부모 문자) · `tab-absent-sms`(테스트 미응시) · `tab-clinic-sms`(클리닉 미참석) · `tab-uncert`(미인증 관리) 탭을 없앴다. 문자 발송은 `tab-score-sms`(성적 문자 / 전체 공지)와 클리닉 메모 창의 개별 발송(`CLINIC_MISSED_SMS_TEMPLATE`)만 남는다.

```
반 선택 → load{X}Weeks() → 주차 선택 → load{X}Targets() → 체크박스 목록 렌더
                                                        → toggleAll{X}() 전체선택
                                                        → send{X}Sms() → postSms(messages) → SMS_FUNCTION_URL POST { password: adminPassword, messages }
```

- 수신처는 `students.phone`(학부모) / `students.student_phone`(학생) 중 선택. `_scoreSmsRecipient`(성적 문자·전체 공지 공용), `_clinicMemoSmsRecipient`(클리닉 메모 창) 전역이 이를 보관한다.
- 문자 한 건은 `{ to, text }` 형태로 `messages` 배열에 담긴다. 실제 필드명은 `sendScoreSms`·`sendNoticeSms` 등 기존 호출부를 그대로 따를 것.
- `smsByteLength`(L3015)로 길이를 계산한다 — 한글은 2바이트, SMS/LMS 경계 판단용.
- **발송 로직을 고칠 때 `sendScoreSms` · `sendNoticeSms` · `sendClinicMemoSms` 세 곳이 같은 결함을 공유하는지 반드시 확인할 것.** 복제 구조라 버그도 복제돼 있다.

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


## 학생 화면(index.html) 클리닉 신청 (2026-11)

`showResult` 끝에서 `loadClinicBooking` → `/api/clinic-book`(vercel.json rewrite → Supabase 함수 `clinic-book`, 세션 쿠키). `renderClinicBooking`(날짜 · 시 · 분 select `#cb-pick-date/hour/minute` → `onClinicPick`, 고르기만으론 저장 안 됨) · 확정 버튼 `submitClinicPick`(POST {day,time}, 변경이면 confirm — 문자 감) · 상태 `clinicPick`·`clinicPickNormalize`/`clinicPickOptions`/`clinicPickSlot`/`clinicPickFromBooking` · `cancelClinicBooking`(DELETE). 서버가 클리닉 메모(scores.clinic_memo)에 '일요일 3시'·'수요일 6시 반' 한 줄을 신청·변경·취소에 맞춰 넣고·바꾸고·지움(`syncClinicMemo`/`memoLine` — 직전 신청 줄을 찾아 바꿈, 그 주 점수 행이 없으면 안 만듦, 읽은 메모가 그대로일 때만 PATCH). 서버가 문자: 처음 신청은 없음, 변경·취소는 학부모·선생님(문구는 설정 templates, 칸 {이름}{반}{클리닉}{이전 클리닉}). 전날 안내는 `clinic-remind`(pg_cron 'clinic-remind', 매일 18:00 KST). 설정이 꺼져 있으면 카드가 안 보인다. 서버 상태 `exempt`(시험 모두 통과 + 과제 기준 이상, 2026-11-22)면 고르기 칸 없이 '이번 주는 … 클리닉이 없어요'와 `cancelledLabel`(취소된 신청 시간)만 보여 준다. POST가 409 `not_needed`로 상태를 같이 보내면 `clinicRequest`가 그 상태로 다시 그린다.

## 학생 화면(index.html) 주차 시험지 (2026-11-22)

주차 점수 카드 끝 `weekReportButtonHtml(weekId)` — `loginData.weekReports`에 있는 주차만 '📄 시험지 보기'. `openWeekReport` → `openReportLink('w'+id)`(모의고사 `openMockReport`와 같은 함수).
