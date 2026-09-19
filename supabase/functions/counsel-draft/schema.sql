-- counsel-draft / schema.sql
-- 상담 준비 탭(admin.html #tab-counsel)이 쓰는 초안 보관 표.
-- 이 파일은 Supabase에서 실행해야 반영된다(레포는 사본 보관용 — admin-api/index.ts와 같은 규약).
--
-- 설계 원칙
--  1. ai_draft(AI 원문)와 edited_draft(교사 수정본)를 절대 같은 칸에 쓰지 않는다.
--     "AI가 뭐라고 썼는지"와 "교사가 무엇을 고쳤는지"가 둘 다 남아야 검토함이 성립한다.
--  2. facts(근거)를 같이 저장한다. 나중에 점수가 바뀌어도 "그때 무엇을 근거로 썼는지"가 남는다.
--  3. 이 표는 성적이 아니므로 data_history 트리거 대상에 넣지 않는다.
--
-- 지금은 테스트 환경이라 FK 제약과 RLS를 일부러 걸지 않았다.
-- 운영에 올릴 때 확인할 것:
--   - student_id/class_id에 FK를 걸면 admin.html의 deleteStudent / deleteClass 삭제 순서에
--     counsel_drafts 선삭제를 반드시 추가해야 한다(안 하면 학생 삭제가 FK 제약으로 거부된다).
--   - 접근은 admin-api(service_role 대행)만 하므로 RLS는 그때 anon 차단 정책과 함께 켠다.

create table if not exists public.counsel_drafts (
  id                uuid primary key default gen_random_uuid(),
  -- students(id) / classes(id)를 가리킨다. 두 표의 id는 bigint이므로 타입을 맞춘다.
  -- (FK 제약은 위 주석대로 아직 걸지 않는다)
  student_id        bigint      not null,
  class_id          bigint,
  -- 조회한 주차 id 목록. weeks.id가 bigint이므로 bigint[]로 둔다
  -- (기획서 표기는 int[]였지만 weeks.id 타입과 어긋나면 나중에 조인이 깨진다).
  -- 주차 날짜(test_date/label)는 'M.D' 문자열이고 연도가 없어서 기간을 날짜 범위로 쓸 수 없다.
  -- 그래서 기간은 "최근 N주차"의 주차 id 목록으로만 표현한다.
  period_weeks      bigint[]    not null default '{}',
  -- 조회한 사실 묶음(점수·과제·재시험 원값). 합계·커트라인 판정은 넣지 않는다.
  facts             jsonb       not null default '{}'::jsonb,
  ai_draft          text,
  edited_draft      text,
  ai_model          text,
  ai_prompt_version int         not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  status            text        not null default 'pending',
  teacher_notes     text,
  constraint counsel_drafts_status_chk
    check (status in ('pending', 'approved', 'rejected'))
);

comment on table  public.counsel_drafts            is '상담 준비 탭: AI 초안 / 교사 수정본 / 승인 상태 보관';
comment on column public.counsel_drafts.period_weeks is '조회한 weeks.id 목록 (최근 N주차)';
comment on column public.counsel_drafts.facts        is '초안 근거로 쓴 사실 묶음 (점수/과제/재시험 원값)';
comment on column public.counsel_drafts.ai_draft     is 'AI 생성 원문 — 덮어쓰지 않는다';
comment on column public.counsel_drafts.edited_draft is '교사 수정본';
comment on column public.counsel_drafts.status       is 'pending | approved | rejected';

-- 학생별 최신 초안 조회(상담 준비 탭의 기본 조회축)
create index if not exists counsel_drafts_student_created_idx
  on public.counsel_drafts (student_id, created_at desc);

-- 반 단위 검토함 목록
create index if not exists counsel_drafts_class_created_idx
  on public.counsel_drafts (class_id, created_at desc);

-- 검토 대기 목록
create index if not exists counsel_drafts_status_idx
  on public.counsel_drafts (status, created_at desc);

-- updated_at 자동 갱신. PATCH할 때마다 프론트가 직접 넣지 않아도 되도록 트리거로 둔다.
create or replace function public.counsel_drafts_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists counsel_drafts_touch_updated_at on public.counsel_drafts;
create trigger counsel_drafts_touch_updated_at
  before update on public.counsel_drafts
  for each row execute function public.counsel_drafts_touch_updated_at();
