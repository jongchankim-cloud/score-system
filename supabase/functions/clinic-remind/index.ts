// clinic-remind / index.ts  (2026-11)
// 클리닉 전날 안내 문자. DB 예약 작업(pg_cron 'clinic-remind', 매일 18:00 KST)이 부른다.
// 내일(KST) 클리닉이 잡힌 신청(clinic_bookings, status=booked) 중 아직 안내하지 않은 것만 골라
// 학생(students.student_phone)과 학부모(students.phone)께 보낸다. 번호가 같으면 한 번만.
//
// 같은 안내가 두 번 가지 않게: 보내기 전에 reminded_at을 '아직 비어 있는 행만' 채워 그 행만 맡는다(원자적 선점).
// 학생이 시간을 바꾸면 clinic-book이 reminded_at을 비우므로, 바뀐 시간이 내일이면 다시 안내된다.
// 아무나 불러도 해가 없게: KST 17시 전에는 아무것도 하지 않는다(내일 안내를 너무 일찍 보내지 않게).
// 문구: 관리자 화면 '학생 클리닉 신청 설정'에서 고친 문구(app_settings 'clinicBooking.v1'.templates.remind), 비어 있으면 기본 문구.
// 필요한 환경변수(프로젝트 공용): SB_URL, SB_SERVICE_ROLE, COOLSMS_API_KEY, COOLSMS_API_SECRET, SENDER_PHONE

const SUPABASE_URL = Deno.env.get("SB_URL")!;
const SERVICE_ROLE = Deno.env.get("SB_SERVICE_ROLE")!;
const COOLSMS_API_KEY = Deno.env.get("COOLSMS_API_KEY") ?? "";
const COOLSMS_API_SECRET = Deno.env.get("COOLSMS_API_SECRET") ?? "";
const SENDER_PHONE = Deno.env.get("SENDER_PHONE") ?? "";

const KST = 9 * 3600 * 1000;
const DAY_MS = 86400 * 1000;
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const EARLIEST_HOUR_KST = 17;
const SETTING_KEY = "clinicBooking.v1";
// ★ admin.html CB_DEFAULT_TEMPLATES.remind와 같은 문구여야 한다. 칸: {이름} {반} {클리닉}
const DEFAULT_REMIND = "[용산대성N학원 영어과]\n내일 {클리닉} {이름} 학생 영어 클리닉이 있습니다.\n늦지 않게 와 주세요.";
function fillTemplate(tpl: string, vals: Record<string, string>): string {
  return Object.entries(vals).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), tpl);
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

async function rest(path: string, init: RequestInit = {}): Promise<{ status: number; data: any }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (res.status >= 400) console.log("rest 실패 |", init.method || "GET", path.split("?")[0], "| 상태:", res.status, "| 응답:", String(text).slice(0, 300));
  return { status: res.status, data };
}

function slotLabel(at: number): string {
  const k = new Date(at + KST);
  const h = k.getUTCHours(), mm = String(k.getUTCMinutes()).padStart(2, "0");
  return `${k.getUTCMonth() + 1}/${k.getUTCDate()}(${DAYS[k.getUTCDay()]}) ${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}:${mm}`;
}

const enc = new TextEncoder();
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

Deno.serve(async (_req) => {
  const nowK = new Date(Date.now() + KST);
  if (nowK.getUTCHours() < EARLIEST_HOUR_KST) return json({ skipped: "too_early" });
  const todayK = Date.UTC(nowK.getUTCFullYear(), nowK.getUTCMonth(), nowK.getUTCDate());
  const from = new Date(todayK + DAY_MS - KST).toISOString();       // 내일 0시(KST)
  const to = new Date(todayK + 2 * DAY_MS - KST).toISOString();     // 모레 0시(KST)
  const stamp = new Date().toISOString();
  // 내일 클리닉 중 아직 안내하지 않은 것을 맡는다 — 이 PATCH가 돌려준 행만 보낸다(두 번 불려도 한 번만 간다)
  const claim = await rest(
    `clinic_bookings?status=eq.booked&reminded_at=is.null&clinic_at=gte.${encodeURIComponent(from)}&clinic_at=lt.${encodeURIComponent(to)}&select=id,student_id,clinic_at`,
    { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ reminded_at: stamp }) },
  );
  if (claim.status >= 400 || !Array.isArray(claim.data)) return json({ error: "claim_failed" }, 502);
  if (!claim.data.length) return json({ bookings: 0, sent: 0, failed: 0 });
  const ids = [...new Set(claim.data.map((b: any) => b.student_id))];
  const [st, setR] = await Promise.all([
    rest(`students?id=in.(${ids.join(",")})&is_active=eq.true&select=id,name,phone,student_phone,classes(name)`),
    rest(`app_settings?key=eq.${encodeURIComponent(SETTING_KEY)}&select=value`),
  ]);
  const saved = Array.isArray(setR.data) && setR.data[0] ? setR.data[0].value?.templates?.remind : null;
  const tpl = typeof saved === "string" && saved.trim() ? saved : DEFAULT_REMIND;
  const byId: Record<number, any> = {};
  (Array.isArray(st.data) ? st.data : []).forEach((s: any) => { byId[s.id] = s; });
  let sent = 0, failed = 0;
  for (const b of claim.data) {
    const s = byId[b.student_id];
    if (!s) continue; // 퇴원한 학생
    const text = fillTemplate(tpl, { "이름": s.name || "", "반": s.classes?.name || "", "클리닉": slotLabel(Date.parse(b.clinic_at)) });
    const nums = [...new Set([s.student_phone, s.phone].map((n: string) => String(n || "").replace(/[^0-9]/g, "")).filter(Boolean))];
    for (const n of nums) { (await sendSms(n, text)) ? sent++ : failed++; }
  }
  console.log("클리닉 전날 안내 | 신청", claim.data.length, "건 | 성공", sent, "| 실패", failed);
  return json({ bookings: claim.data.length, sent, failed });
});
