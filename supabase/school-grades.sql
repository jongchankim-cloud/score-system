-- 학교 성적(내신) 표 — 학생 관리 탭 '학생 정보' 창에서 입력·조회한다 (2026-11-21).
-- 관리자 화면은 admin-api(v17, service_role)로만 읽고 쓴다. anon·authenticated에는 권한을 주지 않는다.
-- 고치거나 지우면 다른 표처럼 data_history에 이전 값이 남는다(log_row_history).
-- 되돌리기: drop table public.school_grades;  (admin-api 허용 목록의 "school_grades"도 함께 뺀다)

create table if not exists public.school_grades (
  id          serial primary key,              -- data_history.row_id(integer)와 맞춘다
  student_id  integer not null references public.students(id) on delete cascade,
  school_year integer not null,                -- 학년도 (예: 2026)
  grade_level text,                            -- 학년 (고1·고2·고3)
  semester    smallint not null check (semester in (1, 2)),
  exam        text not null,                   -- 중간 · 기말 · 수행 등
  subject     text not null default '영어',     -- 과목 (영어, 영어Ⅰ 등)
  score       numeric,                         -- 원점수
  average     numeric,                         -- 과목 평균 (알면)
  rank_grade  text,                            -- 등급·성취도 (1~9, A~E 등 자유 입력)
  memo        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists school_grades_student_idx on public.school_grades (student_id);

alter table public.school_grades enable row level security;
revoke all on table public.school_grades from anon, authenticated;
revoke all on sequence public.school_grades_id_seq from anon, authenticated;

create or replace function public.school_grades_touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists school_grades_touch_updated_at on public.school_grades;
create trigger school_grades_touch_updated_at before update on public.school_grades
  for each row execute function public.school_grades_touch_updated_at();

drop trigger if exists school_grades_history on public.school_grades;
create trigger school_grades_history after delete or update on public.school_grades
  for each row execute function public.log_row_history();
