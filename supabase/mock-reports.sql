-- 모의고사 학생별 분석지(PDF) — 2026-11 준비, 아직 운영 DB에 실행하지 않음.
--
-- 실행 순서 (반드시 이 순서):
--   1) 이 SQL을 Supabase SQL 편집기에서 실행
--   2) admin-api 배포 (supabase/functions/admin-api, v16: 분석지 저장소 작업 추가)
--   3) parent-login 배포 (supabase/functions/parent-login: 공개된 분석지 링크)
-- 프론트(admin.html / index.html)는 이 단계 전후 어느 때 배포돼도 안전하다.
--   - 1~3 전: 관리자 화면 분석지 칸에 '서버 준비 전' 안내만 뜨고, 학부모 화면엔 아무 변화 없음.
--   - 1~3 후에도 시험별 '학부모에게 공개'를 누르기 전까지 학부모 화면엔 버튼이 안 생긴다.

-- ① 시험별 공개 스위치. 기본은 비공개 — 올려 두기만 하고 검수 후 조교가 켠다.
--    mock_exams 에는 변경 이력 트리거(mock_exams_history)가 이미 걸려 있어 공개/비공개 전환도 이력에 남는다.
alter table public.mock_exams
  add column if not exists report_published boolean not null default false;

-- ② 분석지 PDF 보관함. 비공개(public=false)이고 정책을 하나도 만들지 않으므로
--    anon/authenticated 는 읽기·쓰기 모두 불가 — service_role 을 쓰는 Edge Function 만 접근한다.
--    학부모는 parent-login 이 세션을 확인한 뒤 발급하는 5분짜리 서명 링크로만 연다.
--    파일 경로 규약: {mock_exams.id}/{students.id}.pdf
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('mock-reports', 'mock-reports', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

-- 되돌리기 (필요할 때만):
--   보관함은 대시보드 Storage 에서 비운 뒤 삭제
--   alter table public.mock_exams drop column report_published;
