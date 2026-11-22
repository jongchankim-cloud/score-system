// clinic-book / index.ts  (2026-11)
// 학생·학부모 화면(index.html)의 '클리닉 신청'. 브라우저는 Vercel 도메인의 /api/clinic-book 으로만 부른다
// (vercel.json rewrite). parent-login이 발급한 세션 쿠키(parent_session)를 같은 SESSION_SECRET으로 확인해
// 그 학생의 신청만 다룬다. 저장은 clinic_bookings(supabase/counsel-and-clinic.sql), 한 학생 × 한 주차 = 한 건.
//
//  GET    (쿠키)               → { enabled, student, week, slots:[{day,time,at,label}], booking, canChange }
//  POST   { day, time } (쿠키) → 신청(문자 없음) / 시간 변경 → 학부모(students.phone) · 선생님(설정 teacherPhone)께 문자
//  DELETE (쿠키)               → 신청 취소 → 학부모 · 선생님께 문자
//  신청 · 변경 · 취소 때 그 주 클리닉 메모(scores.clinic_memo)에도 '일요일 3시'처럼 한 줄로 맞춘다(syncClinicMemo).
//
// 설정: app_settings key 'clinicBooking.v1' = { enabled, teacherPhone, hours: [{ day:'일', start:'10:00', end:'18:00' }],
//         interval: 30|60, templates: { change, cancel, remind } }
//   hours = 모든 학년 공통 운영 시간. 학생은 start부터 interval분마다, end(문 닫는 시각) 전까지의 시각 중 하나를 고른다.
//   ★ admin.html cbRowTimes와 같은 규칙(관리자 화면이 '몇 개 열리는지'를 이 규칙으로 보여준다).
//   templates = 문자 문구(관리자 화면에서 고침, 비어 있으면 기본 문구)
// 클리닉 날짜: 그 반의 '이번 주' 주차(시험일이 오늘 이전인 가장 최근 주차)의 시험 다음 날부터 7일 안에서 그 요일.
//   다음 시험 날에 지난주 클리닉이 아직 남아 있으면 그 시각이 지날 때까지 지난주를 '이번 주'로 본다.
// 시간 변경·취소는 지금 신청한 클리닉이 시작하기 전까지만 된다. 바꾼 횟수가 MAX_CHANGES를 넘으면 막는다(문자 남용 방지).
// 필요한 환경변수(프로젝트 공용): SB_URL, SB_SERVICE_ROLE, SESSION_SECRET, COOLSMS_API_KEY, COOLSMS_API_SECRET, SENDER_PHONE

const SUPABASE_URL = Deno.env.get("SB_URL")!;
const SERVICE_ROLE = Deno.env.get("SB_SERVICE_ROLE")!;
const SESSION_SECRET = Deno.env.get("SESSION_SECRET")!;
const COOLSMS_API_KEY = Deno.env.get("COOLSMS_API_KEY") ?? "";
const COOLSMS_API_SECRET = Deno.env.get("COOLSMS_API_SECRET") ?? "";
const SENDER_PHONE = Deno.env.get("SENDER_PHONE") ?? "";

const COOKIE_NAME = "parent_session";
const SETTING_KEY = "clinicBooking.v1";
const MAX_CHANGES = 10;
const DAYS = ["일", "월", "화", "수", "목", "금", "토"]; // getUTCDay() 순서
const KST = 9 * 3600 * 1000;
const DAY_MS = 86400 * 1000;
// 문자 기본 문구. 관리자가 '학생 클리닉 신청 설정'에서 고친 문구(settings.templates)가 있으면 그걸 쓴다.
// 칸: {이름} {반} {클리닉}(바꾼 시간, 취소면 취소한 시간) {이전 클리닉}(시간 변경 전 시간)
// ★ admin.html CB_DEFAULT_TEMPLATES · clinic-remind DEFAULT_REMIND와 같은 문구여야 한다(관리자 화면 미리보기가 이 문구를 보여준다).
const DEFAULT_TEMPLATES: Record<string, string> = {
  change: "[용산대성N학원 영어과]\n{이름} 학생({반}) 클리닉 시간 변경\n{이전 클리닉} → {클리닉}",
  cancel: "[용산대성N학원 영어과]\n{이름} 학생({반}) 클리닉 신청 취소\n({클리닉})",
};
function templateOf(settings: any, kind: string): string {
  const t = settings?.templates?.[kind];
  return typeof t === "string" && t.trim() ? t : DEFAULT_TEMPLATES[kind];
}
function fillTemplate(tpl: string, vals: Record<string, string>): string {
  return Object.entries(vals).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), tpl);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// ── PostgREST (service_role) ──
async function rest(path: string, init: RequestInit = {}): Promise<{ status: number; data: any }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (res.status >= 400) console.log("rest 실패 |", init.method || "GET", path.split("?")[0], "| 상태:", res.status, "| 응답:", String(text).slice(0, 300));
  return { status: res.status, data };
}

// ── 세션 쿠키 (parent-login과 같은 형식: base64url(payload).base64url(HMAC-SHA256)) ──
const enc = new TextEncoder();
function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
let keyPromise: Promise<CryptoKey> | null = null;
function hmacKey(): Promise<CryptoKey> {
  keyPromise ||= crypto.subtle.importKey("raw", enc.encode(SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return keyPromise;
}
function readCookie(req: Request): string | null {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE_NAME) return v.join("=") || null;
  }
  return null;
}
async function sessionStudentId(req: Request): Promise<number | null> {
  const token = readCookie(req);
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  let sigBytes: Uint8Array;
  try { sigBytes = b64urlDecode(sig); } catch { return null; }
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(), sigBytes, enc.encode(body)))) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!c.sid || !c.exp || c.exp * 1000 < Date.now()) return null;
    return Number(c.sid);
  } catch { return null; }
}

// ── 날짜 (모든 '날짜'는 KST 자정을 UTC 숫자로 둔 값. 실제 시각 = 그 값 + 시:분 − 9시간) ──
function todayKST(): number {
  const n = new Date(Date.now() + KST);
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}
// 'M.D' 시험일. 연도는 주차를 만든 시각에 가장 가까운 해 (admin.html testDateTime과 같은 생각)
function testDateOf(w: any): number | null {
  const m = String(w.test_date || w.label || "").match(/(\d{1,2})\s*\.\s*(\d{1,2})/);
  if (!m) return null;
  const month = parseInt(m[1]) - 1, day = parseInt(m[2]);
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const created = w.created_at ? Date.parse(w.created_at) + KST : Date.now() + KST;
  const cy = new Date(created).getUTCFullYear();
  let best: number | null = null;
  for (const dy of [-1, 0, 1]) {
    const t = Date.UTC(cy + dy, month, day);
    if (best === null || Math.abs(t - created) < Math.abs(best - created)) best = t;
  }
  return best;
}
// 시험일 다음 날부터 7일 안에서 그 요일·시각의 실제 시각(UTC ms)
function slotInstant(testDate: number, dayName: string, time: string): number | null {
  const target = DAYS.indexOf(dayName);
  const tm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time || "");
  if (target < 0 || !tm) return null;
  for (let k = 1; k <= 7; k++) {
    const d = testDate + k * DAY_MS;
    if (new Date(d).getUTCDay() === target) return d + (parseInt(tm[1]) * 60 + parseInt(tm[2])) * 60000 - KST;
  }
  return null;
}
function slotLabel(at: number): string {
  const k = new Date(at + KST);
  const h = k.getUTCHours(), mm = String(k.getUTCMinutes()).padStart(2, "0");
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${k.getUTCMonth() + 1}/${k.getUTCDate()}(${DAYS[k.getUTCDay()]}) ${ampm} ${h12}:${mm}`;
}
// 운영 시간 → 고를 수 있는 { day, time } 목록 (겹치는 시각은 한 번만)
function slotsFromHours(settings: any): { day: string; time: string }[] {
  const interval = Number(settings.interval) === 60 ? 60 : 30;
  const minutes = (t: string) => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t || ""); return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : null; };
  const seen = new Set<string>();
  const out: { day: string; time: string }[] = [];
  for (const h of Array.isArray(settings.hours) ? settings.hours : []) {
    if (!h || !DAYS.includes(h.day)) continue;
    const a = minutes(h.start), b = minutes(h.end);
    if (a === null || b === null) continue;
    for (let t = a; t < b; t += interval) {
      const time = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
      if (seen.has(h.day + time)) continue;
      seen.add(h.day + time);
      out.push({ day: h.day, time });
    }
  }
  return out;
}

// ── 문자 (send-sms와 같은 CoolSMS 호출) ──
async function smsSignature(date: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(COOLSMS_API_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(date + salt));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sendSms(to: string, text: string): Promise<boolean> {
  const num = String(to || "").replace(/[^0-9]/g, "");
  if (!num || !COOLSMS_API_KEY || !COOLSMS_API_SECRET || !SENDER_PHONE) return false;
  try {
    const date = new Date().toISOString();
    const salt = crypto.randomUUID();
    const res = await fetch("https://api.coolsms.co.kr/messages/v4/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `HMAC-SHA256 apiKey=${COOLSMS_API_KEY}, date=${date}, salt=${salt}, signature=${await smsSignature(date, salt)}`,
      },
      body: JSON.stringify({ message: { to: num, from: SENDER_PHONE, text } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.groupId) console.log("문자 실패 | 상태:", res.status, "| 코드:", body.errorCode ?? "-", "| 메시지:", body.errorMessage ?? "-");
    return !!body.groupId;
  } catch (e) {
    console.log("문자 오류:", String(e));
    return false;
  }
}

// ── 이 학생의 신청 화면 상태 ──
async function loadContext(sid: number) {
  const st = await rest(`students?id=eq.${sid}&is_active=eq.true&select=id,name,class_id,phone,student_phone,classes(name,grade)`);
  if (st.status >= 400 || !Array.isArray(st.data) || !st.data.length) return { error: "session_expired" as const };
  const student = st.data[0];
  const cls = student.classes || {};
  const [setR, wkR] = await Promise.all([
    rest(`app_settings?key=eq.${encodeURIComponent(SETTING_KEY)}&select=value`),
    rest(`weeks?class_id=eq.${student.class_id}&select=id,label,test_date,created_at`),
  ]);
  const settings = Array.isArray(setR.data) && setR.data[0] ? (setR.data[0].value || {}) : {};
  const enabled = settings.enabled === true;
  const today = todayKST();
  const now = Date.now();
  // 이번 주 = 시험일이 오늘 이전(오늘 포함)인 가장 최근 주차. 미리 만들어 둔 다음 주 주차는 건너뛴다.
  const past = (Array.isArray(wkR.data) ? wkR.data : [])
    .map((w: any) => ({ w, t: testDateOf(w) }))
    .filter((x: any) => x.t !== null && x.t <= today)
    .sort((a: any, b: any) => (b.t - a.t) || (b.w.id - a.w.id));
  let week: any = past[0] ? past[0].w : null, testDate: number | null = past[0] ? past[0].t : null;
  // 다음 시험 날(= 지난주 신청 범위의 마지막 날)에 지난주 클리닉이 아직 남아 있으면 그 주를 계속 보여준다 —
  // 그래야 오늘 잡힌 클리닉을 학생이 보고 바꾸거나 취소할 수 있다. 그 클리닉 시각이 지나면 새 주로 넘어간다.
  let booking: any = null;
  if (week) {
    const ids = past.slice(0, 2).map((x: any) => x.w.id);
    const b = await rest(`clinic_bookings?student_id=eq.${sid}&week_id=in.(${ids.join(",")})&select=*`);
    const rows = Array.isArray(b.data) ? b.data : [];
    const prev = past[1] && past[0].t === today
      ? rows.find((r: any) => r.week_id === past[1].w.id && r.status === "booked" && Date.parse(r.clinic_at) > now) : null;
    if (prev) { week = past[1].w; testDate = past[1].t; booking = prev; }
    else booking = rows.find((r: any) => r.week_id === week.id) || null;
  }
  const rawSlots = slotsFromHours(settings);
  const slots = week && testDate !== null
    ? rawSlots.map((s) => ({ day: s.day, time: s.time, at: slotInstant(testDate as number, s.day, s.time) }))
        .filter((s) => s.at !== null && (s.at as number) > now)
        .sort((a, b) => (a.at as number) - (b.at as number))
        .map((s) => ({ ...s, label: slotLabel(s.at as number), at: new Date(s.at as number).toISOString() }))
    : [];
  return { student, cls, settings, enabled, week, testDate, slots, booking };
}

function publicState(ctx: any) {
  const b = ctx.booking && ctx.booking.status === "booked" ? ctx.booking : null;
  const bAt = b ? Date.parse(b.clinic_at) : null;
  return {
    enabled: ctx.enabled,
    student: { name: ctx.student.name, class_name: ctx.cls.name || "" },
    week: ctx.week ? { id: ctx.week.id, label: ctx.week.label || ctx.week.test_date || "" } : null,
    slots: ctx.enabled ? ctx.slots : [],
    booking: b ? { day: b.clinic_day, time: b.clinic_time, at: b.clinic_at, label: slotLabel(bAt as number), past: (bAt as number) <= Date.now() } : null,
    canChange: !!(ctx.enabled && (!b || (bAt as number) > Date.now())),
    changesLeft: Math.max(0, MAX_CHANGES - (ctx.booking ? ctx.booking.change_count || 0 : 0)),
  };
}

// ── 클리닉 메모(scores.clinic_memo)에 신청 시간 한 줄 (2026-11 운영 요청) ──
// 조교가 메모에 적던 모양 그대로 '일요일 3시' · '수요일 6시 반'으로 적는다(오전·오후·날짜 없이 — 배정표 parseClinicMemo가 같은 칸으로 읽는다).
// 관리자 메모 창 · 점수 입력 탭 · 학부모 화면 '클리닉 안내'에 그대로 보인다.
// 신청하면 맨 위에 넣고, 바꾸면 직전에 신청했던 시간 줄을 지우고 새 줄을 넣고, 취소하면 그 줄만 지운다. 조교가 적은 다른 줄은 그대로.
// 그 주 점수 행이 없으면(시험을 안 본 학생) 새로 만들지 않는다 — scores 기본값이 점수 0 · 출석으로 들어가 성적·출결이 틀어진다.
// 조교가 같은 순간 메모를 고쳤을 수 있으므로, 읽은 메모가 그대로일 때만 바꾼다(아니면 다시 읽어 한 번 더).
const DAY_FULL: Record<string, string> = { "월": "월요일", "화": "화요일", "수": "수요일", "목": "목요일", "금": "금요일", "토": "토요일", "일": "일요일" };
function memoLine(day: string, time: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time || "");
  if (!m) return "";
  const h = parseInt(m[1]), mm = parseInt(m[2]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${DAY_FULL[day] || day} ${h12}시${mm === 0 ? "" : mm === 30 ? " 반" : ` ${mm}분`}`;
}
function memoWithBooking(memo: string | null, oldLine: string | null, newLine: string | null): string | null {
  const drop = new Set([oldLine, newLine].filter(Boolean).map((x) => (x as string).trim()));
  const lines = String(memo ?? "").split("\n").filter((l) => !drop.has(l.trim()));
  if (newLine) lines.unshift(newLine);
  const out = lines.join("\n").trim();
  return out ? out : null;
}
async function syncClinicMemo(sid: number, weekId: number, oldLine: string | null, newLine: string | null): Promise<"ok" | "same" | "no_row" | "failed"> {
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await rest(`scores?student_id=eq.${sid}&week_id=eq.${weekId}&select=id,clinic_memo&order=id.asc&limit=1`);
      const row = Array.isArray(r.data) ? r.data[0] : null;
      if (!row) return "no_row";
      const old: string | null = row.clinic_memo ?? null;
      const next = memoWithBooking(old, oldLine, newLine);
      if ((old ?? "").trim() === (next ?? "")) return "same";
      const cond = old === null ? "clinic_memo=is.null" : `clinic_memo=eq.${encodeURIComponent(old)}`;
      const p = await rest(`scores?id=eq.${row.id}&${cond}`, {
        method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ clinic_memo: next }),
      });
      if (p.status < 400 && Array.isArray(p.data) && p.data.length) return "ok";
      if (p.status >= 400) return "failed";
      // 0건 = 그사이 메모가 바뀜 → 다시 읽어서 한 번 더
    }
    return "failed";
  } catch (e) {
    console.log("클리닉 메모 반영 실패:", String(e));
    return "failed";
  }
}

// 시간 변경·취소만 학부모와 선생님께 알린다. 처음 신청은 문자를 보내지 않는다(2026-11 운영 요청).
async function notify(ctx: any, kind: "new" | "change" | "cancel", label: string, oldLabel?: string) {
  if (kind === "new") return { sent: 0, failed: 0 };
  const text = fillTemplate(templateOf(ctx.settings, kind), {
    "이름": ctx.student.name || "",
    "반": ctx.cls.name || "",
    "클리닉": kind === "cancel" ? (oldLabel || "") : label,
    "이전 클리닉": kind === "change" ? (oldLabel || "") : "",
  });
  const jobs: Promise<boolean>[] = [];
  if (ctx.student.phone) jobs.push(sendSms(ctx.student.phone, text));
  const teacher = String(ctx.settings.teacherPhone || "").trim();
  if (teacher) jobs.push(sendSms(teacher, text));
  const r = await Promise.all(jobs);
  return { sent: r.filter(Boolean).length, failed: r.filter((x) => !x).length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const sid = await sessionStudentId(req);
  if (!sid) return json({ error: "session_expired" }, 401);
  try {
    const ctx: any = await loadContext(sid);
    if (ctx.error) return json({ error: ctx.error }, 401);

    if (req.method === "GET") return json(publicState(ctx));

    if (!ctx.enabled) return json({ error: "closed", message: "지금은 클리닉 신청을 받지 않아요." }, 403);
    if (!ctx.week) return json({ error: "no_week", message: "이번 주 시험 주차가 아직 등록되지 않았어요." }, 409);
    const cur = ctx.booking && ctx.booking.status === "booked" ? ctx.booking : null;
    const curAt = cur ? Date.parse(cur.clinic_at) : null;
    if (cur && (curAt as number) <= Date.now()) {
      return json({ error: "past", message: "이미 시작했거나 지난 클리닉은 바꿀 수 없어요. 선생님께 직접 연락해 주세요." }, 409);
    }

    if (req.method === "DELETE") {
      if (!cur) return json({ ...publicState(ctx), sms: { sent: 0, failed: 0 } });
      const r = await rest(`clinic_bookings?id=eq.${cur.id}&status=eq.booked`, {
        method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "cancelled", reminded_at: null }),
      });
      if (r.status >= 400) return json({ error: "save_failed", message: "취소하지 못했어요. 잠시 후 다시 해 주세요." }, 502);
      const sms = await notify(ctx, "cancel", "", slotLabel(curAt as number));
      const memo = await syncClinicMemo(sid, cur.week_id, memoLine(cur.clinic_day, cur.clinic_time), null);
      ctx.booking = Array.isArray(r.data) && r.data[0] ? r.data[0] : { ...cur, status: "cancelled" };
      return json({ ...publicState(ctx), sms, memo });
    }

    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    let payload: { day?: string; time?: string };
    try { payload = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
    const slot = ctx.slots.find((s: any) => s.day === payload.day && s.time === payload.time);
    if (!slot) return json({ error: "bad_slot", message: "고를 수 없는 시간이에요. 화면을 새로고침해 주세요." }, 400);
    if (cur && cur.clinic_day === slot.day && cur.clinic_time === slot.time) return json({ ...publicState(ctx), sms: { sent: 0, failed: 0 } });
    if (ctx.booking && (ctx.booking.change_count || 0) >= MAX_CHANGES) {
      return json({ error: "too_many", message: "시간을 너무 여러 번 바꿨어요. 선생님께 직접 연락해 주세요." }, 429);
    }
    const fields = { clinic_day: slot.day, clinic_time: slot.time, clinic_at: slot.at, status: "booked", reminded_at: null };
    let saved: any = null;
    if (ctx.booking) {
      const r = await rest(`clinic_bookings?id=eq.${ctx.booking.id}`, {
        method: "PATCH", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ ...fields, change_count: (ctx.booking.change_count || 0) + 1 }),
      });
      if (r.status < 400 && Array.isArray(r.data)) saved = r.data[0];
    } else {
      const r = await rest("clinic_bookings", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ ...fields, student_id: sid, week_id: ctx.week.id }),
      });
      if (r.status < 400 && Array.isArray(r.data)) saved = r.data[0];
      else if (r.status === 409) return json({ error: "retry", message: "다른 곳에서 방금 신청했어요. 화면을 새로고침해 주세요." }, 409);
    }
    if (!saved) return json({ error: "save_failed", message: "신청하지 못했어요. 잠시 후 다시 해 주세요." }, 502);
    const sms = cur ? await notify(ctx, "change", slot.label, slotLabel(curAt as number)) : await notify(ctx, "new", slot.label);
    const memo = await syncClinicMemo(sid, saved.week_id ?? ctx.week.id, cur ? memoLine(cur.clinic_day, cur.clinic_time) : null, memoLine(slot.day, slot.time));
    ctx.booking = saved;
    return json({ ...publicState(ctx), sms, memo });
  } catch (e) {
    console.log("clinic-book 오류:", String(e));
    return json({ error: "server_error", message: "잠시 후 다시 해 주세요." }, 500);
  }
});
