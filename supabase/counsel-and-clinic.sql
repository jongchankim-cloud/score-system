-- 2026-11: 상담 기록(counsel_notes) · 학생 클리닉 신청(clinic_bookings) · 클리닉 전날 안내(pg_cron)
-- 관리자 화면은 admin-api(v18, service_role)로, 학생 화면은 clinic-book 함수(세션 쿠키 확인 후 service_role)로만 접근한다.
-- anon·authenticated에는 권한을 주지 않는다. 고치거나 지우면 data_history에 이전 값이 남는다(log_row_history).
-- 되돌리기: select cron.unschedule('clinic-remind'); drop table public.clinic_bookings; drop table public.counsel_notes;
--          (admin-api 허용 목록의 두 표, Vercel /api/clinic-book, 함수 clinic-book·clinic-remind도 함께 정리)

-- ── 상담 기록 ──
create table if not exists public.counsel_notes (
  id           serial primary key,                       -- data_history.row_id(integer)와 맞춘다
  student_id   integer not null references public.students(id) on delete cascade,
  counsel_date date not null default ((now() at time zone 'Asia/Seoul')::date),
  target       text,                                     -- 학부모 · 학생 · 기타
  method       text,                                     -- 전화 · 대면 · 문자 · 기타
  author       text,                                     -- 선생님 · 평일 조교 · 주말 조교
  content      text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists counsel_notes_student_idx on public.counsel_notes (student_id, counsel_date desc);

-- ── 학생 클리닉 신청 (한 학생 × 한 주차 = 한 건) ──
create table if not exists public.clinic_bookings (
  id           serial primary key,
  student_id   integer not null references public.students(id) on delete cascade,
  week_id      integer not null references public.weeks(id) on delete cascade,   -- 신청할 때 그 반의 '이번 주' 주차
  clinic_day   text not null check (clinic_day in ('월','화','수','목','금','토','일')),
  clinic_time  text not null check (clinic_time ~ '^[0-2][0-9]:[0-5][0-9]$'),     -- 'HH:MM' (24시간)
  clinic_at    timestamptz not null,                     -- 실제 클리닉 시작 시각 (전날 안내·변경 마감 기준)
  status       text not null default 'booked' check (status in ('booked','cancelled')),
  change_count integer not null default 0,               -- 학생이 바꾼 횟수 (문자 남용 방지 상한)
  reminded_at  timestamptz,                              -- 전날 안내를 보낸 시각 (시간을 바꾸면 비운다)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (student_id, week_id)
);
create index if not exists clinic_bookings_week_idx on public.clinic_bookings (week_id);
create index if not exists clinic_bookings_at_idx on public.clinic_bookings (clinic_at) where status = 'booked';

alter table public.counsel_notes enable row level security;
alter table public.clinic_bookings enable row level security;
revoke all on table public.counsel_notes, public.clinic_bookings from anon, authenticated;
revoke all on sequence public.counsel_notes_id_seq, public.clinic_bookings_id_seq from anon, authenticated;

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists counsel_notes_touch on public.counsel_notes;
create trigger counsel_notes_touch before update on public.counsel_notes for each row execute function public.touch_updated_at();
drop trigger if exists clinic_bookings_touch on public.clinic_bookings;
create trigger clinic_bookings_touch before update on public.clinic_bookings for each row execute function public.touch_updated_at();

drop trigger if exists counsel_notes_history on public.counsel_notes;
create trigger counsel_notes_history after delete or update on public.counsel_notes for each row execute function public.log_row_history();
drop trigger if exists clinic_bookings_history on public.clinic_bookings;
create trigger clinic_bookings_history after delete or update on public.clinic_bookings for each row execute function public.log_row_history();

-- ── 클리닉 전날 안내 예약 (2026-11-22 적용) ──
-- 매일 09:00 UTC(= 18:00 KST)에 clinic-remind 함수를 부른다. 함수는 KST 17시 전 호출은 무시하고,
-- 내일 클리닉 중 아직 안내하지 않은 신청만 원자적으로 맡아 학생·학부모께 보낸다(두 번 불려도 한 번만).
-- Authorization의 키는 공개 anon 키다(admin.html의 ANON_KEY와 같은 값) — 비밀이 아니다.
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
--   select cron.schedule('clinic-remind', '0 9 * * *', $cron$
--     select net.http_post(url := 'https://rcpzinsdocmpnfxkfbil.supabase.co/functions/v1/clinic-remind',
--       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <ANON_KEY>'),
--       body := '{}'::jsonb, timeout_milliseconds := 60000);
--   $cron$);
-- 끄기: select cron.unschedule('clinic-remind');
