-- 주차 시험지(학생별 스캔 PDF) — 2026-11-22
-- 모의고사 분석지(supabase/mock-reports.sql)와 같은 비공개 보관함 'mock-reports'를 쓰고,
-- 파일 경로만 w{weeks.id}/{students.id}.pdf 로 나눈다(분석지는 {mock_exams.id}/{students.id}.pdf).
--
-- 실행 순서 (반드시 이 순서):
--   1) 이 SQL 실행 (weeks.report_published 컬럼)
--   2) admin-api v19 배포 (w 경로 허용, list week_ids · remove week_id)
--   3) parent-login 배포 (weekReports 목록, GET ?report=w<주차id>)
-- 프론트(admin.html / index.html)는 전후 어느 때 배포돼도 안전하다.
--   - 1~3 전: 관리자 점수 입력 탭 시험지 칸에 '서버 준비 전' 안내만, 학부모 화면엔 변화 없음.
--   - 1~3 후에도 주차별 '학부모에게 공개'를 누르기 전까지 학부모 화면엔 버튼이 안 생긴다.

-- 주차별 공개 스위치. 기본은 비공개 — 올려 두기만 하고 검수 후 조교가 켠다.
-- weeks 에는 변경 이력 트리거가 걸려 있어 공개/비공개 전환도 data_history 에 남는다.
alter table public.weeks
  add column if not exists report_published boolean not null default false;

-- 되돌리기 (필요할 때만):
--   보관함에서 w* 폴더를 지운 뒤
--   alter table public.weeks drop column report_published;
