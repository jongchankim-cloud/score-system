-- 문제지·답지 (docx, 2026-11-23)
-- 학생이 '틀린 문제 보기'에서 번호를 누르면 그 문제(지문이 다른 블록에 있으면 지문도)와 정답·해설을 글자로 보여 준다.
-- 관리자 화면(점수 입력 탭 '문제지·답지')이 문제지·답지 docx에서 본문을 꺼내 문항별로 나누고, 주차별 한 행으로 둔다.
-- 그림·보관함은 쓰지 않는다.
--   data = { v: 2, title, blocks: [본문 조각 묶음], items: { '어법:1' | '서술형:2' | ':3'(번호만): { q: [블록 번호], p: [지문], a: [해설] } },
--            explain: { '1': 블록 번호 } (해석 문장별 구문 해설) }
--   본문 조각: { t:'p', r:[[글자, 꼴]], li? } · { t:'tbl', rows:[[ [조각…] ]], sh? } — 꼴: 1 굵게 · 2 밑줄 · 4 윗첨자 · 8 기울임
-- 같은 비교 그룹 반 주차에는 같은 data를 각자 한 행으로 넣는다. 학부모 공개는 주차 시험지·채점 결과와 같은 스위치(weeks.report_published).
--
-- 실행 순서 (반드시 이 순서):
--   1) 이 SQL 실행
--   2) admin-api v22 배포 (허용 목록에 week_papers)
--   3) parent-login 배포 (weekPapers 목록, GET ?paper=w<주차id>&k=<종류>&n=<번호>)
-- 프론트는 전후 어느 때 배포돼도 안전하다(1~2 전: 관리자 칸에 '서버 준비 전' 안내, 3 전: 학생 화면에 버튼이 안 생긴다).
-- 되돌리기: drop table public.week_papers;  (admin-api 허용 목록 한 줄, parent-login weekPapers·?paper도 함께 정리)

create table if not exists public.week_papers (
  id          serial primary key,                        -- data_history.row_id(integer)와 맞춘다
  week_id     integer not null unique references public.weeks(id) on delete cascade,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.week_papers enable row level security;
revoke all on table public.week_papers from anon, authenticated;
revoke all on sequence public.week_papers_id_seq from anon, authenticated;

-- touch_updated_at 은 supabase/counsel-and-clinic.sql 에서 만든 함수
drop trigger if exists week_papers_touch on public.week_papers;
create trigger week_papers_touch before update on public.week_papers for each row execute function public.touch_updated_at();
drop trigger if exists week_papers_history on public.week_papers;
create trigger week_papers_history after delete or update on public.week_papers for each row execute function public.log_row_history();
