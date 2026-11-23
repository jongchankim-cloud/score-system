-- 주차 채점 결과(글) — 2026-11-22
-- 조교가 GPT 채점 결과 글을 관리자 화면(점수 입력 탭 '채점 결과 (GPT 글)')에 붙여 넣으면 학생별로 나눠 한 행씩 저장한다.
--   kind 'vocab' : 단어·해석 채점 결과 (단어 O/X · 학생 답 · 정답 · 사유, 문장 해석 원문 · 학생 해석 · 점수 · 감점 사유 · 올바른 해석)
--   kind 'omr'   : 객관식·어법·서술형 학생별 기입 답안 (객관식 내 답/정답/O·X, 어법 기입 칸, 서술형 답·점수 · 정답)
-- data(jsonb) 모양은 admin.html wrVocabData / wrOmrData 가 만들고 index.html 이 그대로 그린다.
-- 학부모 공개는 주차 시험지와 같은 스위치(weeks.report_published, supabase/week-tests.sql)를 쓴다.
--
-- 실행 순서 (반드시 이 순서):
--   1) 이 SQL 실행
--   2) admin-api v21 배포 (허용 목록에 week_results)
--   3) parent-login 배포 (weekResults 목록, GET ?result=w<주차id>)
-- 프론트(admin.html / index.html)는 전후 어느 때 배포돼도 안전하다.
--   - 1~2 전: 관리자 화면 채점 결과 칸에 '서버 준비 전' 안내만. 3 전: 학부모 화면에 버튼이 안 생긴다.
-- anon·authenticated에는 권한을 주지 않는다. 바꾸거나 지우면 data_history에 이전 값이 남는다(log_row_history).
-- 되돌리기: drop table public.week_results;  (admin-api 허용 목록 한 줄, parent-login weekResults도 함께 정리)

create table if not exists public.week_results (
  id          serial primary key,                        -- data_history.row_id(integer)와 맞춘다
  week_id     integer not null references public.weeks(id) on delete cascade,
  student_id  integer not null references public.students(id) on delete cascade,
  kind        text not null check (kind in ('vocab', 'omr')),
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (week_id, student_id, kind)                     -- 다시 올리면 같은 행을 바꾼다 (on_conflict 업서트)
);
create index if not exists week_results_student_idx on public.week_results (student_id);

alter table public.week_results enable row level security;
revoke all on table public.week_results from anon, authenticated;
revoke all on sequence public.week_results_id_seq from anon, authenticated;

-- touch_updated_at 은 supabase/counsel-and-clinic.sql 에서 만든 함수
drop trigger if exists week_results_touch on public.week_results;
create trigger week_results_touch before update on public.week_results for each row execute function public.touch_updated_at();
drop trigger if exists week_results_history on public.week_results;
create trigger week_results_history after delete or update on public.week_results for each row execute function public.log_row_history();
