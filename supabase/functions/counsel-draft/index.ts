// counsel-draft / index.ts
// 상담 준비 탭(admin.html #tab-counsel)의 AI 초안 생성 함수.
// 한 학생 × 최근 N주차의 "사실"을 모아 Gemini에 넘기고, 받은 초안을 counsel_drafts에 남긴다.
// 이 파일은 Supabase Edge Function 배포본의 사본이다 (admin-api/index.ts와 같은 규약).
//   배포: supabase functions deploy counsel-draft
//   필요 환경변수: SB_URL, SB_SERVICE_ROLE, GEMINI_API_KEY, (선택) ADMIN_PASSWORD
//
// admin-api에 얹지 않은 이유: admin-api는 "비밀번호 확인 후 PostgREST를 그대로 대행한다"는
// 단일 책임을 지키고 있다. 모델 호출을 그 안에 넣으면 그 성질이 깨진다.
//
// ★ 계산은 하지 않는다 ★
// 합계·커트라인 미달(재시험 대상) 판정·평균·석차는 여기서 절대 계산하지 않는다.
// 그 계산은 admin.html의 itemVal / isBelowCut / mockRowTotal / normalizeItemConfig가
// 학부모 화면(index.html)과 같은 기준으로 하고 있고, 여기서 같은 식을 다시 쓰면
// 두 숫자가 조용히 어긋난다(이 코드베이스에서 가장 비싼 회귀 유형).
// 이 함수는 DB에 적힌 값을 그대로 옮기고, 항목 이름표만 붙인다.

const SUPABASE_URL = Deno.env.get("SB_URL")!;
const SERVICE_ROLE = Deno.env.get("SB_SERVICE_ROLE")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
// 설정돼 있으면 admin.html이 보내는 관리자 비밀번호를 확인한다(admin-api와 같은 값).
// 설정하지 않으면 검증을 건너뛴다 — 테스트 환경 편의. 운영에서는 반드시 설정할 것.
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "";

const GEMINI_MODEL = "gemini-flash-latest";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const AI_MODEL_NAME = "gemini-flash";
const AI_PROMPT_VERSION = 1;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

// ── PostgREST 조회 (service_role)
async function rest<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  if (res.status >= 400) {
    console.log("조회 실패 | path:", path, "| 상태:", res.status, "| 응답:", text.slice(0, 400));
    throw new Error(`rest_${res.status}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

async function restInsert<T = unknown>(table: string, row: unknown): Promise<T | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  const text = await res.text();
  if (res.status >= 400) {
    console.log("저장 실패 | table:", table, "| 상태:", res.status, "| 응답:", text.slice(0, 400));
    throw new Error(`insert_${res.status}`);
  }
  const parsed = text ? JSON.parse(text) : null;
  return Array.isArray(parsed) ? (parsed[0] ?? null) : parsed;
}

// ── 항목 이름표
// scores의 1~4번 항목은 물리 컬럼, 5번째 이상은 item_scores jsonb에 들어 있다(admin.html itemVal과 같은 배치).
// 여기서는 값을 "읽기"만 한다 — 활성/비활성 판정이나 커트라인 비교는 하지 않는다.
const ITEM_COLUMNS: Record<string, string> = {
  item1: "word_score",
  item2: "reading_score",
  item3: "mc_score",
  item4: "item4_score",
};
// item_config가 NULL인 옛 주차를 위한 표시용 이름(계산값이 아니라 이름표다).
const ITEM_FALLBACK_LABEL: Record<string, string> = {
  item1: "단어",
  item2: "해석",
  item3: "객관식",
  item4: "추가 항목",
};

type ScoreRow = Record<string, unknown>;

function rawItemValue(row: ScoreRow, key: string): unknown {
  // key는 이미 컬럼명 (word_score, reading_score, mc_score 등)
  if (row[key] !== undefined) return row[key];
  // 5번째 이상 추가 항목은 item_scores jsonb에서 조회
  const extra = (row.item_scores ?? {}) as Record<string, unknown>;
  return extra[key];
}

// weeks.item_config에 적힌 순서·이름표만 가져온다. 없으면 물리 컬럼 4개를 기본 순서로 본다.
// item_config 구조: { items: [{key, label, max, active, ...}, ...] }
function itemLabels(itemConfig: unknown): Array<{ key: string; label: string; max: unknown; active: boolean }> {
  const config = itemConfig && typeof itemConfig === "object" ? (itemConfig as Record<string, unknown>) : null;
  const items = Array.isArray(config?.items) ? config.items : null;

  if (!items) {
    // 레거시 주차 (설정 미저장): 물리 컬럼 4개를 기본으로
    return [
      { key: 'word_score', label: '단어', max: null, active: true },
      { key: 'reading_score', label: '해석', max: null, active: true },
      { key: 'mc_score', label: '객관식', max: null, active: true },
      { key: 'item4_score', label: '추가 항목', max: null, active: false },
    ];
  }

  return items
    .filter((it) => it && typeof it === "object")
    .map((it) => {
      const o = it as Record<string, unknown>;
      const key = String(o.key ?? "");
      return {
        key,
        label: String(o.label ?? ITEM_FALLBACK_LABEL[key] ?? key),
        max: o.max ?? null,
        active: o.active === false ? false : true,
      };
    })
    .filter((it) => it.key !== "");
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

// ── 사실 수집
async function collectFacts(studentId: number, classId: number, weekIds: number[]) {
  const [studentRows, classRows, weekRows] = await Promise.all([
    rest<ScoreRow[]>(`students?id=eq.${studentId}&select=id,name,class_id`),
    rest<ScoreRow[]>(`classes?id=eq.${classId}&select=id,name`),
    rest<ScoreRow[]>(
      `weeks?id=in.(${weekIds.join(",")})&order=id.desc&select=id,label,test_date,item_config,created_at`,
    ),
  ]);
  const student = Array.isArray(studentRows) ? studentRows[0] : null;
  const klass = Array.isArray(classRows) ? classRows[0] : null;
  const weeks = Array.isArray(weekRows) ? weekRows : [];
  if (!student) throw new Error("student_not_found");

  // 여러 주차 점수는 항상 한 번의 in.() 조회로 받는다(주차별 개별 호출 금지 — 기존 코드 관습).
  const scoreRows = weeks.length
    ? await rest<ScoreRow[]>(
      `scores?student_id=eq.${studentId}&week_id=in.(${weeks.map((w) => w.id).join(",")})&select=*`,
    )
    : [];
  const scores = Array.isArray(scoreRows) ? scoreRows : [];
  const byWeek = new Map<unknown, ScoreRow>();
  scores.forEach((s) => byWeek.set(s.week_id, s));

  const scoreFacts: unknown[] = [];
  const assignmentFacts: unknown[] = [];
  const retakeFacts: unknown[] = [];

  for (const w of weeks) {
    const weekLabel = String(w.label ?? w.test_date ?? w.id);
    const row = byWeek.get(w.id);
    if (!row) {
      scoreFacts.push({ week: weekLabel, recorded: false, items: [] });
      continue;
    }

    const items = itemLabels(w.item_config)
      .filter((it) => it.active)
      .map((it) => ({ label: it.label, value: rawItemValue(row, it.key), max: it.max }))
      .filter((it) => !isEmpty(it.value));

    scoreFacts.push({
      week: weekLabel,
      recorded: true,
      items,
      attendance: row.attendance ?? null,
      // total_score는 DB 생성 컬럼이므로 계산이 아니라 조회다. 없으면 null.
      total_score: row.total_score ?? null,
    });

    assignmentFacts.push({
      week: weekLabel,
      homework_rate: row.homework_rate ?? null,   // 과제 완료율(%)
      homework_eval: row.homework_eval ?? null,   // 과제 평가
      no_homework: row.no_homework ?? null,       // 과제 미제출 여부
      hw_cert: row.hw_cert ?? null,               // 과제 인증
    });

    // retest_pass에 적힌 것만 옮긴다. "재시험 대상이었는지"는 커트라인 비교 결과이므로
    // 여기서 판정하지 않는다(admin.html isBelowCut의 몫). 비활성 항목은 제외한다.
    const pass = (row.retest_pass ?? {}) as Record<string, unknown>;
    const activeLabels = itemLabels(w.item_config).filter((it) => it.active);
    const labelOf = new Map(activeLabels.map((it) => [it.key, it.label]));
    const passed = activeLabels.filter((it) => pass[it.key] === true).map((it) => it.label);
    const notPassed = activeLabels.filter((it) => pass[it.key] === false).map((it) => it.label);
    if (passed.length || notPassed.length) {
      retakeFacts.push({
        week: weekLabel,
        recorded_count: passed.length + notPassed.length,
        passed,
        not_passed: notPassed,
      });
    }
  }

  return {
    student: { id: student.id, name: student.name },
    class: { id: klass?.id ?? classId, name: klass?.name ?? "" },
    period: { week_count: weeks.length, week_ids: weeks.map((w) => w.id), week_labels: weeks.map((w) => String(w.label ?? w.test_date ?? w.id)) },
    scores: scoreFacts,
    assignments: assignmentFacts,
    retakes: retakeFacts,
    // 이 함수가 무엇을 하지 않았는지 남긴다 — 나중에 근거를 다시 볼 때 오해를 막는다.
    note: "합계·커트라인(재시험 대상) 판정·평균·석차는 이 사실 묶음에 없습니다. 그 계산은 관리자 화면이 담당합니다.",
  };
}

// ── 프롬프트
function mdTable(rows: Record<string, unknown>[], cols: string[]): string {
  if (!rows.length) return "(기록 없음)";
  const head = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) =>
    `| ${cols.map((c) => {
      const v = r[c];
      if (v === null || v === undefined || v === "") return "-";
      return String(v);
    }).join(" | ")} |`
  );
  return [head, sep, ...body].join("\n");
}

function factsToPrompt(facts: Awaited<ReturnType<typeof collectFacts>>): string {
  const scoreRows = (facts.scores as Record<string, unknown>[]).map((s) => ({
    "주차": s.week,
    "점수": Array.isArray(s.items) && s.items.length
      ? (s.items as Record<string, unknown>[])
        .map((it) => `${it.label} ${it.value}${isEmpty(it.max) ? "" : "/" + it.max}`).join(", ")
      : "기록 없음",
    "출석": s.attendance === false ? "결석" : (s.attendance === true ? "출석" : "-"),
  }));
  const asgRows = (facts.assignments as Record<string, unknown>[]).map((a) => ({
    "주차": a.week,
    "완료율": isEmpty(a.homework_rate) ? "-" : `${a.homework_rate}%`,
    "평가": a.homework_eval ?? "-",
    "미제출": a.no_homework === true ? "있음" : (a.no_homework === false ? "없음" : "-"),
  }));
  const retakeRows = (facts.retakes as Record<string, unknown>[]).map((r) => ({
    "주차": r.week,
    "기록된 재시험": r.recorded_count,
    "통과": Array.isArray(r.passed) && r.passed.length ? (r.passed as string[]).join(", ") : "-",
    "미통과": Array.isArray(r.not_passed) && r.not_passed.length ? (r.not_passed as string[]).join(", ") : "-",
  }));

  return `학생: ${facts.student.name}, 반: ${facts.class.name}
조회 기간: 최근 ${facts.period.week_count}주차

점수 기록:
${mdTable(scoreRows, ["주차", "점수", "출석"])}

과제:
${mdTable(asgRows, ["주차", "완료율", "평가", "미제출"])}

재시험:
${mdTable(retakeRows, ["주차", "기록된 재시험", "통과", "미통과"])}

위 사실을 바탕으로 학부모에게 보낼 상담 메시지 초안을 작성해줘.
- 객관적 사실만 포함
- 원인 추측은 금지
- 개선 제안은 피함
- 존댓말, 150자 내외
- 표에 없는 숫자(합계, 평균, 석차, 등수)는 만들어내지 말 것
- 본문만 출력 (머리말·꼬리말·설명 없이)`;
}

// ── Gemini 호출. 실패해도 던지지 않고 이유를 문자열로 돌려준다(사용자가 수동 작성할 수 있어야 한다).
async function callGemini(prompt: string): Promise<{ draft: string; error: string | null }> {
  if (!GEMINI_API_KEY) return { draft: "", error: "GEMINI_API_KEY가 설정되지 않았습니다." };
  try {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const text = await res.text();
    if (res.status >= 400) {
      console.log("Gemini 실패 | 상태:", res.status, "| 응답:", text.slice(0, 400));
      return { draft: "", error: `AI 응답 오류 (${res.status})` };
    }
    const data = JSON.parse(text);
    const parts = data?.candidates?.[0]?.content?.parts;
    const draft = Array.isArray(parts)
      ? parts.map((p: { text?: string }) => p?.text ?? "").join("").trim()
      : "";
    if (!draft) {
      const reason = data?.candidates?.[0]?.finishReason ?? data?.promptFeedback?.blockReason ?? "empty";
      return { draft: "", error: `AI가 초안을 만들지 못했습니다 (${reason})` };
    }
    return { draft, error: null };
  } catch (e) {
    console.log("Gemini 호출 예외:", String(e));
    return { draft: "", error: `AI 호출 실패: ${String(e)}` };
  }
}

// ── 요청 검증
function parseIds(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "number" ? x : parseInt(String(x), 10)))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let payload: {
    password?: string;
    student_id?: unknown;
    class_id?: unknown;
    period_weeks?: unknown;
  };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (ADMIN_PASSWORD && (!payload.password || !safeEqual(String(payload.password), ADMIN_PASSWORD))) {
    return json({ error: "unauthorized" }, 401);
  }

  const studentId = parseInt(String(payload.student_id ?? ""), 10);
  const classId = parseInt(String(payload.class_id ?? ""), 10);
  const weekIds = parseIds(payload.period_weeks);

  if (!Number.isSafeInteger(studentId) || studentId <= 0) {
    return json({ error: "invalid_student_id" }, 400);
  }
  if (!Number.isSafeInteger(classId) || classId <= 0) {
    return json({ error: "invalid_class_id" }, 400);
  }
  if (!weekIds.length) {
    return json({ error: "invalid_period_weeks" }, 400);
  }
  if (weekIds.length > 24) {
    return json({ error: "too_many_weeks" }, 400);
  }

  // 1) 사실 수집 — 여기가 실패하면 초안을 만들 수 없으므로 그대로 오류를 알린다.
  //    (화면을 빈 표로 채우지 않기 위해 프론트는 이 오류를 문구로 띄운다)
  let facts: Awaited<ReturnType<typeof collectFacts>>;
  try {
    facts = await collectFacts(studentId, classId, weekIds);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    return json({
      id: null,
      ai_draft: "",
      facts: null,
      status: "pending",
      error: msg === "student_not_found" ? "학생을 찾을 수 없습니다." : `기록 조회 실패: ${msg}`,
    }, msg === "student_not_found" ? 404 : 502);
  }

  // 2) AI 호출 — 실패해도 사실은 돌려준다(교사가 직접 쓸 수 있어야 한다).
  const { draft, error } = await callGemini(factsToPrompt(facts));

  // 3) 초안 보관. AI가 실패해도 행은 남긴다 — 교사 수정본을 저장할 대상(id)이 필요하다.
  let draftId: string | null = null;
  let saveError: string | null = null;
  try {
    const saved = await restInsert<{ id: string }>("counsel_drafts", {
      student_id: studentId,
      class_id: classId,
      period_weeks: facts.period.week_ids,
      facts,
      ai_draft: draft || null,
      ai_model: AI_MODEL_NAME,
      ai_prompt_version: AI_PROMPT_VERSION,
      status: "pending",
    });
    draftId = saved?.id ?? null;
  } catch (e) {
    saveError = `초안 저장 실패: ${String(e instanceof Error ? e.message : e)}`;
  }

  return json({
    id: draftId,
    ai_draft: draft,
    facts,
    status: "pending",
    ai_model: AI_MODEL_NAME,
    ai_prompt_version: AI_PROMPT_VERSION,
    // 하나라도 문제가 있으면 여기에 담긴다. 프론트는 error가 있으면 재시도 버튼을 띄운다.
    error: error ?? saveError,
    error_message: error ?? saveError,
  });
});
