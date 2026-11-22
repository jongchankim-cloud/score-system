// name-reader / index.ts  (2026-11-22)
// 주차 시험지(스캔 PDF) 올리기에서, 쪽마다 잘라 낸 윗부분 사진의 손글씨 이름을 읽어 그 반 명단 중 누구인지 고른다.
// 관리자 화면(admin.html '// ── 주차 시험지' 블록)만 부른다 — 관리자 비밀번호를 확인한다(send-sms와 같은 방식).
// AI는 Google Gemini(상담 초안 counsel-draft와 같은 키 GEMINI_API_KEY). 이름 칸 사진과 반 명단(이름·번호)만 보낸다.
// 결과는 '제안'일 뿐이다 — 관리자 화면이 이름 칸 사진과 배정 학생을 나란히 보여 주고, 사람이 '이름 확인 완료'를 체크해야 올린다.
//
//  GET                                       → { ready }  (키가 설정됐는지만, 비밀은 내보내지 않음)
//  POST { password, roster:[{id,name}], images:[{page, data(base64 JPEG)}] }
//                                            → { results:[{ page, read, student_id|null, confidence:'high'|'medium'|'low' }] }
// 필요한 환경변수(프로젝트 공용): ADMIN_PASSWORD, GEMINI_API_KEY

const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = "gemini-flash-latest";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_IMAGES = 10;            // 한 번에 받는 쪽 수 (관리자 화면이 나눠 보낸다)
const MAX_IMAGE_B64 = 600_000;    // 쪽 하나 사진 크기 한도(base64 글자 수, 약 450KB)
const MAX_ROSTER = 120;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function safeEqual(a: string, b: string): boolean {
  const ba = new TextEncoder().encode(a), bb = new TextEncoder().encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

function prompt(roster: { id: number; name: string }[], pages: number[]): string {
  return `다음 사진들은 학원 영어 시험지 각 쪽의 윗부분을 잘라 낸 것입니다(스캔본). 학생이 손으로 쓴 이름을 읽고, 아래 반 명단에서 같은 학생을 고르세요.

반 명단 (번호: 이름):
${roster.map((s) => `${s.id}: ${s.name}`).join("\n")}

규칙:
- 사진마다 앞에 '쪽 N' 표시가 있습니다. 쪽 ${pages.join(", ")} 각각에 대해 하나씩 답하세요.
- 이름 칸이 비었거나 이름이 없는 쪽(예: 같은 학생의 둘째 쪽)이면 read는 "", id는 null, confidence는 "high".
- 이름이 있으면 read에 읽은 글자를 그대로 적고, 명단에서 같은 학생의 번호를 id에 넣으세요.
- 확실하면 "high", 글씨가 흐리거나 비슷한 이름이 있어 조금 애매하면 "medium", 거의 모르겠으면 "low".
- 명단에 맞는 학생이 없으면 id는 null, confidence는 "low".
- 명단에 없는 번호를 만들어 내지 마세요.

JSON 배열로만 답하세요: [{"page": 쪽번호, "read": "읽은 이름", "id": 번호 또는 null, "confidence": "high" | "medium" | "low"}]`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ready: !!(GEMINI_API_KEY && ADMIN_PASSWORD) });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!GEMINI_API_KEY || !ADMIN_PASSWORD) return json({ error: "missing_config" }, 500);

  let payload: { password?: unknown; roster?: unknown; images?: unknown };
  try { payload = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  if (typeof payload.password !== "string" || !safeEqual(payload.password, ADMIN_PASSWORD)) return json({ error: "unauthorized" }, 401);

  const roster = (Array.isArray(payload.roster) ? payload.roster : [])
    .filter((s: any) => s && Number.isInteger(s.id) && s.id > 0 && typeof s.name === "string" && s.name.trim())
    .map((s: any) => ({ id: s.id as number, name: String(s.name).trim().slice(0, 30) }));
  const images = (Array.isArray(payload.images) ? payload.images : [])
    .filter((im: any) => im && Number.isInteger(im.page) && im.page > 0 && typeof im.data === "string" && /^[A-Za-z0-9+/=]+$/.test(im.data));
  if (!roster.length || roster.length > MAX_ROSTER) return json({ error: "bad_roster" }, 400);
  if (!images.length || images.length > MAX_IMAGES) return json({ error: "bad_images" }, 400);
  if (images.some((im: any) => im.data.length > MAX_IMAGE_B64)) return json({ error: "image_too_large" }, 413);

  const pages = images.map((im: any) => im.page as number);
  const parts: any[] = [{ text: prompt(roster, pages) }];
  for (const im of images as any[]) {
    parts.push({ text: `쪽 ${im.page}` });
    parts.push({ inline_data: { mime_type: "image/jpeg", data: im.data } });
  }
  let res: Response;
  try {
    res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0, responseMimeType: "application/json" } }),
    });
  } catch (e) {
    console.log("Gemini 호출 예외:", String(e));
    return json({ error: "ai_unreachable" }, 502);
  }
  const text = await res.text();
  if (res.status === 429) return json({ error: "ai_busy" }, 429);
  if (res.status >= 400) {
    console.log("Gemini 실패 | 상태:", res.status, "| 응답:", text.slice(0, 300));
    return json({ error: "ai_error", status: res.status }, 502);
  }
  let arr: any[] = [];
  try {
    const data = JSON.parse(text);
    const out = (data?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text ?? "").join("");
    const parsed = JSON.parse(out);
    arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.results) ? parsed.results : []);
  } catch (e) {
    console.log("Gemini 응답 해석 실패:", String(e), text.slice(0, 300));
    return json({ error: "ai_bad_answer" }, 502);
  }
  // 명단에 없는 번호·없는 쪽은 버린다. 답이 빠진 쪽은 'low'로 채운다 → 관리자 화면에서 확인 대상
  const ids = new Set(roster.map((s) => s.id));
  const byPage = new Map<number, any>();
  for (const r of arr) {
    const page = Number(r?.page);
    if (!pages.includes(page) || byPage.has(page)) continue;
    const id = Number.isInteger(Number(r?.id)) && ids.has(Number(r.id)) ? Number(r.id) : null;
    const conf = ["high", "medium", "low"].includes(r?.confidence) ? r.confidence : "low";
    const read = typeof r?.read === "string" ? r.read.trim().slice(0, 30) : "";
    byPage.set(page, { page, read, student_id: id, confidence: id === null && read ? "low" : conf });
  }
  const results = pages.map((p) => byPage.get(p) || { page: p, read: "", student_id: null, confidence: "low", missing: true });
  return json({ results });
});
