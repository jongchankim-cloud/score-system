-- 클리닉 필요 없음 자동 취소 — 2026-11-22
-- 그 주 시험을 모두 통과(커트 이상 또는 재시험 통과 체크)하고 과제를 기준(기본 90%, 관리자 '학생 클리닉 신청 설정') 이상 한
-- 학생은 클리닉 신청을 받지 않고, 이미 신청했으면 취소한다. 판정과 취소는 함수 clinic-book이 한다(isExempt).
--   - 학생 화면을 열거나 신청할 때: 그 자리에서 판정(신청 막음 · 앞으로 있을 신청 취소)
--   - 점수·과제%가 신청 뒤에 입력된 경우: 아래 예약 작업이 10분마다 clinic-book ?sweep=1 로 정리
--   - 전날 안내(clinic-remind)도 보내기 전에 한 번 정리를 부른다
-- 취소는 문자 없이 하고, 그 주 클리닉 메모의 신청 시간 줄('일요일 3시')만 지운다. 표 구조 변경은 없다.
--
-- 실행 순서: clinic-book 배포 → clinic-remind 배포 → 이 SQL (예약 작업 등록)
-- Authorization의 키는 공개 anon 키다(admin.html의 ANON_KEY와 같은 값) — 비밀이 아니다. clinic-book은 verify_jwt=false.
select cron.unschedule(jobid) from cron.job where jobname = 'clinic-pass-sweep';
select cron.schedule(
  'clinic-pass-sweep',
  '*/10 * * * *',
  $cron$
  select net.http_post(
    url := 'https://rcpzinsdocmpnfxkfbil.supabase.co/functions/v1/clinic-book?sweep=1',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjcHppbnNkb2NtcG5meGtmYmlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwMzM2NzksImV4cCI6MjA5NTYwOTY3OX0.f_HsTsM4_z2qKeMtIXZ0G8vRuXFmHkXomIdQzFFXHb0'),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cron$
);
-- 끄기(예약 작업만): select cron.unschedule('clinic-pass-sweep');
-- 규칙 자체를 끄려면 관리자 화면 '학생 클리닉 신청 설정'의 체크를 끈다(app_settings clinicBooking.v1.autoCancel.enabled=false).
