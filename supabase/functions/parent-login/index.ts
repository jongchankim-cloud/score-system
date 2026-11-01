// parent-login / index.ts
//
// 브라우저는 Vercel 도메인의 /api/parent-login 으로만 호출한다 (vercel.json rewrite).
// 세션은 HttpOnly 쿠키(parent_session)로 관리하므로 JS는 토큰을 읽을 수 없고,
// 같은 도메인의 성적 화면·단어 사이트·지문 사이트가 쿠키를 함께 쓴다.
//
//  POST   { name, pin } → PIN 검증, 쿠키 발급, 성적 데이터, vocab_key(단어 사이트 기록용 학생 키)
//  GET    (쿠키)        → 세션 검증, 성적 데이터, vocab_key (새로고침·뒤로 가기·다른 페이지)
//  DELETE               → 쿠키 삭제 (로그아웃)
//  GET ?report=<시험id> (쿠키) → 공개된 본인 모의고사 분석지 PDF의 5분짜리 서명 링크 { url }
//
// vocab_key 는 PIN 을 확인한 POST 에서만 단어 사이트 DB 에 받아, 서명된 세션 토큰에 넣어 둔다.
// 그래서 자동 입장(GET)에서도 PIN 없이 단어 사이트 기록을 이어 쓸 수 있다.

const SUPABASE_URL = Deno.env.get("SB_URL")!;
const SERVICE_ROLE = Deno.env.get("SB_SERVICE_ROLE")!;
const SESSION_SECRET = Deno.env.get("SESSION_SECRET")!; // supabase secrets set SESSION_SECRET=...
// 단어 사이트 DB 연결 (없으면 vocab_key 없이 로그인만 된다)
const VOCAB_URL = Deno.env.get("VOCAB_URL") || "";
const VOCAB_ANON = Deno.env.get("VOCAB_ANON") || "";
const VOCAB_BRIDGE_SECRET = Deno.env.get("VOCAB_BRIDGE_SECRET") || "";
const SESSION_TTL_SEC = 60 * 60 * 12; // 12시간
const COOKIE_NAME = "parent_session";
// 모의고사 학생별 분석지 (2026-11, supabase/mock-reports.sql). 경로: {mock_exams.id}/{students.id}.pdf
const REPORT_BUCKET = "mock-reports";
const REPORT_LINK_SEC = 300; // 학부모가 받는 링크 유효 시간 — 문자·카톡으로 퍼져도 곧 열리지 않게

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

async function rest(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function json(obj: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...extra },
  });
}

// ── 쿠키 ──

function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_SEC}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(req: Request): string | null {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE_NAME) return rest.join("=") || null;
  }
  return null;
}

// ── 세션 토큰 (HMAC-SHA256 서명, 형식: base64url(payload).base64url(sig)) ──

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

let keyPromise: Promise<CryptoKey> | null = null;
function hmacKey(): Promise<CryptoKey> {
  keyPromise ||= crypto.subtle.importKey(
    "raw",
    enc.encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return keyPromise;
}

async function issueToken(studentId: number, vocabKey: string | null): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const body = b64url(enc.encode(JSON.stringify({ sid: studentId, vk: vocabKey, exp })));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(body)),
  );
  return `${body}.${b64url(sig)}`;
}

// 유효하면 student id 와 vocab_key, 아니면 null
async function readToken(token: string): Promise<{ sid: number; vk: string | null } | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  let sigBytes: Uint8Array;
  try {
    sigBytes = b64urlDecode(sig);
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(),
    sigBytes,
    enc.encode(body),
  );
  if (!ok) return null;
  let claims: { sid?: number; vk?: string | null; exp?: number };
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (!claims.sid || !claims.exp || claims.exp * 1000 < Date.now()) return null;
  return { sid: claims.sid, vk: claims.vk || null };
}

// ── 단어 사이트 학생 키 ──
// PIN 을 방금 확인한 뒤에만 부른다. 실패하면 null — 성적 로그인은 그대로 된다.
// 단어 DB 의 session_student_key 가 공유 비밀값을 확인하므로, 아무나 키를 받을 수 없다.
async function vocabKeyFor(name: string, pin: string): Promise<string | null> {
  if (!VOCAB_URL || !VOCAB_ANON || !VOCAB_BRIDGE_SECRET) return null;
  try {
    const res = await fetch(`${VOCAB_URL}/rest/v1/rpc/session_student_key`, {
      method: "POST",
      headers: {
        apikey: VOCAB_ANON,
        Authorization: `Bearer ${VOCAB_ANON}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_name: name, p_phone: pin, p_bridge: VOCAB_BRIDGE_SECRET }),
    });
    if (!res.ok) return null;
    const key = await res.json();
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

// ── 모의고사 분석지 ──
// 서명 링크 여러 개를 한 번에 만든다. 파일이 없는 경로는 signedURL 없이 돌아온다.
async function signReports(paths: string[], expiresIn: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!paths.length) return out;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${REPORT_BUCKET}`, {
    method: "POST",
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn, paths }),
  });
  if (!res.ok) return out;
  const rows = await res.json();
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const u = r?.signedURL || r?.signedUrl;
    if (r?.path && u && !r.error) out[r.path] = `${SUPABASE_URL}/storage/v1${u}`;
  }
  return out;
}

// 학부모 화면에 '분석지 보기' 버튼을 띄울 시험 id 목록.
// 조교가 '학부모에게 공개'(mock_exams.report_published)를 켠 시험 중 이 학생 파일이 있는 것만.
// 컬럼·보관함이 아직 없거나 오류가 나도 로그인은 그대로 되도록 빈 목록으로 넘긴다.
async function publishedReportExamIds(student: any): Promise<number[]> {
  try {
    const pub = await rest(
      `mock_exams?class_id=eq.${student.class_id}&report_published=is.true&select=id`,
    );
    if (!Array.isArray(pub) || !pub.length) return [];
    const paths = pub.map((e: any) => `${e.id}/${student.id}.pdf`);
    const signed = await signReports(paths, 60);
    return pub.map((e: any) => e.id).filter((id: number) => signed[`${id}/${student.id}.pdf`]);
  } catch {
    return [];
  }
}

// ── 학생 성적 데이터 묶음 (기존 로직 그대로) ──

async function loadStudentData(student: any) {
  // item_config: 주차별 채점 항목(사용 여부/이름/만점/커트라인) 설정
  const weeks = await rest(
    `weeks?class_id=eq.${student.class_id}&order=id.asc&select=id,label,test_date,group_id,item_config`,
  ) || [];

  let myScores: any[] = [];
  if (weeks.length) {
    const weekIds = weeks.map((w: any) => w.id).join(",");
    // select=* 이므로 item4_score는 컬럼이 존재하면 자동 포함됨
    myScores = await rest(
      `scores?student_id=eq.${student.id}&week_id=in.(${weekIds})&select=*`,
    ) || [];
  }

  const groupWeekMap: Record<string, number[]> = {};
  const groupIds = [...new Set(weeks.map((w: any) => w.group_id).filter(Boolean))];
  let rankWeekIds: number[] = weeks.map((w: any) => w.id);
  if (groupIds.length) {
    const inList = groupIds.map((g) => encodeURIComponent(g as string)).join(",");
    const groupWeeks = await rest(
      `weeks?group_id=in.(${inList})&select=id,group_id`,
    ) || [];
    rankWeekIds = groupWeeks.map((w: any) => w.id);
    for (const gw of groupWeeks) {
      (groupWeekMap[gw.group_id] ||= []).push(gw.id);
    }
  }
  let rankScores: any[] = [];
  if (rankWeekIds.length) {
    const ids = rankWeekIds.join(",");
    // 항목 점수 컬럼을 모두 포함해야 석차/평균을 항목 기준으로 계산할 수 있음.
    // 일부만 넣으면 클라이언트가 total_score 폴백으로 동작하여 4번째 항목이 석차에 반영되지 않음.
    rankScores = await rest(
      `scores?week_id=in.(${ids})&select=week_id,word_score,reading_score,mc_score,item4_score,total_score, item_scores`,
    ) || [];
  }

  // [변경] item_config 추가: 모의고사도 주차처럼 시험별 항목(이름/만점/커트라인)을 쓴다.
  // 없으면 학부모 화면이 예전처럼 '점수' 1개(만점 100)로 표시한다.
  const exams = await rest(
    `mock_exams?class_id=eq.${student.class_id}&order=id.asc&select=id,label,exam_date,group_id,item_config`,
  ) || [];
  const mockGroupExamMap: Record<string, number[]> = {};
  let myMockScores: any[] = [];
  let mockRankScores: any[] = [];
  if (exams.length) {
    const examIds = exams.map((e: any) => e.id).join(",");
    myMockScores = await rest(
      `mock_scores?student_id=eq.${student.id}&exam_id=in.(${examIds})&select=*`,
    ) || [];

    const mockGroupIds = [...new Set(exams.map((e: any) => e.group_id).filter(Boolean))];
    let rankExamIds: number[] = exams.map((e: any) => e.id);
    if (mockGroupIds.length) {
      const inList = mockGroupIds.map((g) => encodeURIComponent(g as string)).join(",");
      const groupExams = await rest(
        `mock_exams?group_id=in.(${inList})&select=id,group_id`,
      ) || [];
      rankExamIds = groupExams.map((e: any) => e.id);
      for (const ge of groupExams) {
        (mockGroupExamMap[ge.group_id] ||= []).push(ge.id);
      }
    }
    if (rankExamIds.length) {
      const ids = rankExamIds.join(",");
      // [변경] 모의고사 항목 점수 컬럼 포함. score(항목 합계)는 폴백용으로 유지.
      mockRankScores = await rest(
        `mock_scores?exam_id=in.(${ids})&select=exam_id,score,item1_score,item2_score,item3_score,item4_score, item_scores`,
      ) || [];
    }
  }

  return {
    student: { id: student.id, name: student.name, class_id: student.class_id, classes: student.classes },
    weeks,
    myScores,
    rankScores,
    groupWeekMap,
    exams,
    myMockScores,
    mockRankScores,
    mockGroupExamMap,
    mockReports: await publishedReportExamIds(student),
  };
}

// ── 요청 처리 ──

const STUDENT_SELECT = "select=id,name,class_id,classes(name)";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // 로그아웃: 쿠키 삭제
  if (req.method === "DELETE") {
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  }

  // 세션 복원: 쿠키 토큰 검증 후 학생이 아직 재원 중인지 확인
  if (req.method === "GET") {
    const token = readCookie(req);
    const sess = token ? await readToken(token) : null;
    if (!sess) return json({ error: "session_expired" }, 401);
    const rows = await rest(`students?id=eq.${sess.sid}&is_active=eq.true&${STUDENT_SELECT}`);
    if (!rows || !rows.length) {
      return json({ error: "session_expired" }, 401, { "Set-Cookie": clearCookie() });
    }
    // 분석지 열기: 링크는 누를 때마다 새로 만든다 (로그인 응답에 넣으면 12시간 세션 중에 만료된다).
    // 같은 반 시험 + 공개된 시험 + 본인 파일일 때만 — 시험 id를 바꿔 넣어도 남의 분석지는 못 연다.
    const reportParam = new URL(req.url).searchParams.get("report");
    if (reportParam !== null) {
      const examId = Number(reportParam);
      if (!Number.isInteger(examId) || examId <= 0) return json({ error: "bad_report" }, 400);
      const st = rows[0];
      const exam = await rest(
        `mock_exams?id=eq.${examId}&class_id=eq.${st.class_id}&report_published=is.true&select=id`,
      );
      if (!Array.isArray(exam) || !exam.length) return json({ error: "report_not_found" }, 404);
      const path = `${examId}/${st.id}.pdf`;
      const signed = await signReports([path], REPORT_LINK_SEC);
      if (!signed[path]) return json({ error: "report_not_found" }, 404);
      return json({ url: signed[path] });
    }
    return json({ ...(await loadStudentData(rows[0])), vocab_key: sess.vk });
  }

  // 최초 로그인: 이름 + PIN 검증 후 쿠키 발급
  if (req.method === "POST") {
    let payload: { name?: string; pin?: string };
    try {
      payload = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const name = (payload.name || "").trim();
    const pin = (payload.pin || "").trim();
    if (!name || !pin) return json({ error: "missing_credentials" }, 400);

    const students = await rest(
      `students?name=eq.${encodeURIComponent(name)}&pin=eq.${encodeURIComponent(pin)}&is_active=eq.true&${STUDENT_SELECT}`,
    );
    if (!students || !students.length) {
      return json({ error: "invalid_credentials" }, 401);
    }
    const student = students[0];
    const vocabKey = await vocabKeyFor(name, pin);
    const token = await issueToken(student.id, vocabKey);
    return json({ ...(await loadStudentData(student)), vocab_key: vocabKey }, 200, {
      "Set-Cookie": sessionCookie(token),
    });
  }

  return json({ error: "method_not_allowed" }, 405);
});
