-- 문제지·답지 (2026-11-23)
-- 학생이 '틀린 문제 보기'에서 번호를 누르면 그 문제(지문이 다른 곳에 있으면 지문도)와 정답·해설을 그림으로 보여 준다.
-- 관리자 화면(점수 입력 탭 '문제지·답지')이 글자 PDF에서 문항 위치를 찾아 그림으로 잘라
-- 비공개 보관함 'mock-reports'의 q{weeks.id}/{이름}.jpg 에 올리고, 어느 문항이 어느 그림인지는 이 표에 주차별 한 행으로 둔다.
--   data = { v, title, items: { '어법:1' | '서술형:2' | ':3'(번호만): { q: [그림], p: [지문 그림], a: [해설 그림] } }, size: { 이름: [w, h] } }
--   folder = 그림이 있는 폴더 q{folder} (그 문제지를 올린 주차 id). 같은 비교 그룹 반 주차는 같은 folder를 함께 쓴다.
-- 학부모 공개는 주차 시험지·채점 결과와 같은 스위치(weeks.report_published).
--
-- 실행 순서 (반드시 이 순서):
--   1) 이 SQL 실행 (표 + 보관함에 image/jpeg 허용)
--   2) admin-api v22 배포 (q 경로 · 허용 목록에 week_papers)
--   3) parent-login 배포 (weekPapers 목록, GET ?paper=w<주차id>&k=<종류>&n=<번호>)
-- 프론트는 전후 어느 때 배포돼도 안전하다(1~2 전: 관리자 칸에 '서버 준비 전' 안내, 3 전: 학생 화면에 버튼이 안 생긴다).
-- 되돌리기: drop table public.week_papers; 보관함에서 q* 폴더 삭제; 버킷 allowed_mime_types를 '{application/pdf}'로.

create table if not exists public.week_papers (
  id          serial primary key,                        -- data_history.row_id(integer)와 맞춘다
  week_id     integer not null unique references public.weeks(id) on delete cascade,
  folder      integer not null,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists week_papers_folder_idx on public.week_papers (folder);

alter table public.week_papers enable row level security;
revoke all on table public.week_papers from anon, authenticated;
revoke all on sequence public.week_papers_id_seq from anon, authenticated;

-- touch_updated_at 은 supabase/counsel-and-clinic.sql 에서 만든 함수
drop trigger if exists week_papers_touch on public.week_papers;
create trigger week_papers_touch before update on public.week_papers for each row execute function public.touch_updated_at();
drop trigger if exists week_papers_history on public.week_papers;
create trigger week_papers_history after delete or update on public.week_papers for each row execute function public.log_row_history();

-- 문제지 그림(JPEG)도 같은 비공개 보관함에 둔다
update storage.buckets
   set allowed_mime_types = array(select distinct unnest(coalesce(allowed_mime_types, '{}') || array['application/pdf', 'image/jpeg']))
 where id = 'mock-reports';
