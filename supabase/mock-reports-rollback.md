# 모의고사 학생별 분석지 — 끄기 · 되돌리기

2026-11-01에 넣은 기능 (PR #34: https://github.com/jongchankim-cloud/score-system/pull/34).
쓰지 않기로 하면 **1단계만으로 충분**하다. 2단계는 코드와 서버에서 흔적까지 없애고 싶을 때만.

## 1단계 — 기능 끄기 (조교가 관리자 화면에서, 즉시)

모의고사 탭 → 점수 입력에서 아무 시험 선택 → 맨 아래 '학생별 분석지 (PDF)' 칸 → **분석지 기능 끄기**

- 모든 모의고사의 분석지 공개를 내린다 → 학부모·학생 화면의 '분석지 보기' 버튼이 바로 사라진다.
- 분석지 칸은 '기능 꺼짐' 한 줄로 접힌다. 올린 파일과 이미 입력된 점수는 그대로 남는다.
- '다시 켜기'로 언제든 되살린다 (공개는 시험마다 다시 눌러야 한다).
- 스위치 값: `app_settings` 의 `mockReports.enabled` = `{"enabled": false}`

## 2단계 — 완전히 되돌리기 (선택)

순서대로 한다. 어느 단계에서 멈춰도 화면은 깨지지 않게 만들어 두었다
(컬럼·보관함이 없으면 관리자 칸은 '준비 전' 안내만, 학부모 화면은 버튼 없음).

### ① 코드 (admin.html · index.html)
PR #34 페이지 아래의 **Revert** 버튼 → 생긴 되돌리기 PR을 머지.
(명령으로 할 때: `git revert -m 1 <PR #34 머지 커밋>` 후 main에 push)

### ② parent-login 함수
기능 이전 버전으로 다시 배포한다. 이전 코드는 git에 있다:
```bash
git show d823c9b:supabase/functions/parent-login/index.ts > /tmp/parent-login-index.ts
```
이 파일로 parent-login 을 배포 (verify_jwt **꺼짐** 유지 — 켜면 학부모 로그인이 막힌다).
되돌리지 않고 둬도 공개된 시험이 없으면 아무 일도 하지 않는다.

### ③ admin-api 함수
되돌릴 필요 없다. v16은 v15에 분석지 보관함 작업(`storage: {...}`)만 더한 것이라 다른 기능에 영향이 없다.

### ④ DB · 보관함 (Supabase)
1. 대시보드 → Storage → `mock-reports` → 파일 전부 삭제 → 버킷 삭제
   (SQL로 storage.objects 행만 지우면 실제 파일이 남으므로 대시보드에서 지운다)
2. SQL 편집기:
   ```sql
   alter table public.mock_exams drop column if exists report_published;
   delete from public.app_settings where key = 'mockReports.enabled';
   ```

### 자동 입력된 점수
분석지에서 읽어 넣은 점수는 실제 모의고사 점수라 되돌리지 않는다.
잘못 들어간 점수는 모의고사 점수 입력 표에서 고쳐 저장하면 된다. 이전 값은 `data_history`
(table_name = 'mock_scores')에 남아 있다 — 관리자 화면 '변경 이력' 탭은 주간 점수만 보여 주므로 SQL로 찾는다.
