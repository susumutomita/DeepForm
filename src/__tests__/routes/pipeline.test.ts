import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (_c: any, next: any) => await next(),
}));

vi.mock("../../db/index.ts", async () => {
  const { createTestDb } = await import("../helpers/test-db.ts");
  return { db: createTestDb() };
});

vi.mock("../../llm.ts", () => ({
  MODEL_FAST: "claude-haiku-4-5-20251001",
  MODEL_SMART: "claude-sonnet-4-5-20250929",
  callClaude: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "test" }],
  }),
  callClaudeStream: vi.fn(),
  extractText: vi.fn().mockReturnValue("test"),
}));

import { app } from "../../app.ts";
import { callClaude, extractText } from "../../llm.ts";
import { getRawDb } from "../helpers/test-db.ts";

const rawDb = getRawDb();

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
const TEST_USER_ID = "test-user-001";
const TEST_EXE_USER_ID = "exe-test-001";
const TEST_EMAIL = "testuser@example.com";

async function authedRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("x-exedev-userid", TEST_EXE_USER_ID);
  headers.set("x-exedev-email", TEST_EMAIL);
  return await app.request(path, { ...options, headers });
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
function insertSession(id: string, theme: string, userId: string, extra: Record<string, any> = {}): void {
  const cols = ["id", "theme", "user_id", ...Object.keys(extra)];
  const placeholders = cols.map(() => "?").join(", ");
  rawDb
    .prepare(`INSERT INTO sessions (${cols.join(", ")}) VALUES (${placeholders})`)
    .run(id, theme, userId, ...Object.values(extra));
}

function insertMessage(sessionId: string, role: string, content: string): void {
  rawDb.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(sessionId, role, content);
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------
async function readSSE(res: Response): Promise<Array<{ event: string; data: any }>> {
  const text = await res.text();
  const events: Array<{ event: string; data: any }> = [];
  const lines = text.split("\n");
  let currentEvent = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      try {
        events.push({ event: currentEvent, data: JSON.parse(line.slice(6)) });
      } catch {
        events.push({ event: currentEvent, data: line.slice(6) });
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Mock LLM data
// ---------------------------------------------------------------------------
const mockAnalysis = JSON.stringify({
  facts: [{ id: "F1", type: "fact", content: "テスト事実", evidence: "回答", severity: "high" }],
  hypotheses: [
    {
      id: "H1",
      title: "テスト仮説",
      description: "説明",
      supportingFacts: ["F1"],
      counterEvidence: "",
      unverifiedPoints: [],
    },
  ],
});
const mockPrd = JSON.stringify({
  prd: {
    problemDefinition: "問題定義",
    targetUser: "ユーザー",
    jobsToBeDone: ["ジョブ1"],
    coreFeatures: [],
    nonGoals: [],
    userFlows: [],
    metrics: [],
  },
});
const mockSpec = JSON.stringify({
  spec: {
    projectName: "テスト",
    techStack: {},
    apiEndpoints: [],
    dbSchema: "",
    screens: [],
    testCases: [],
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("パイプライン API (POST /api/sessions/:id/pipeline)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set PRO_GATE env var
    process.env.PRO_GATE = "prd";
    // Clean all tables
    rawDb.exec("DELETE FROM page_views");
    rawDb.exec("DELETE FROM auth_sessions");
    rawDb.exec("DELETE FROM analysis_results");
    rawDb.exec("DELETE FROM messages");
    rawDb.exec("DELETE FROM sessions");
    rawDb.exec("DELETE FROM feedback");
    rawDb.exec("DELETE FROM users");
    // Insert test user (Pro plan)
    rawDb
      .prepare("INSERT INTO users (id, exe_user_id, email, display_name, plan) VALUES (?, ?, ?, ?, ?)")
      .run(TEST_USER_ID, TEST_EXE_USER_ID, TEST_EMAIL, "testuser", "pro");
    // Default mock: 3 sequential LLM calls for full pipeline
    vi.mocked(extractText).mockReturnValueOnce(mockAnalysis).mockReturnValueOnce(mockPrd).mockReturnValueOnce(mockSpec);
  });

  // -------------------------------------------------------------------------
  // 1. Successful pipeline run
  // -------------------------------------------------------------------------
  describe("正常なパイプライン実行", () => {
    it("SSE イベントストリームで全ステージを完了すること", async () => {
      // Given: メッセージ付きのセッション
      insertSession("spipe", "パイプラインテーマ", TEST_USER_ID);
      insertMessage("spipe", "assistant", "質問です");
      insertMessage("spipe", "user", "回答です");

      // When: pipeline 実行
      const res = await authedRequest("/api/sessions/spipe/pipeline", { method: "POST" });

      // Then: SSE ストリームが返る
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(res.headers.get("cache-control")).toBe("no-cache");

      const events = await readSSE(res);

      // ステージイベントを検証
      const stageEvents = events.filter((e) => e.event === "stage");
      const doneEvents = events.filter((e) => e.event === "done");

      // facts(running) -> facts(done) -> hypotheses(done) -> prd(running) -> prd(done) -> spec(running) -> spec(done)
      expect(stageEvents.length).toBe(7);
      expect(stageEvents[0].data).toEqual({ stage: "facts", status: "running" });
      expect(stageEvents[1].data.stage).toBe("facts");
      expect(stageEvents[1].data.status).toBe("done");
      expect(stageEvents[1].data.data.facts).toBeDefined();
      expect(stageEvents[2].data.stage).toBe("hypotheses");
      expect(stageEvents[2].data.status).toBe("done");
      expect(stageEvents[2].data.data.hypotheses).toBeDefined();
      expect(stageEvents[3].data).toEqual({ stage: "prd", status: "running" });
      expect(stageEvents[4].data.stage).toBe("prd");
      expect(stageEvents[4].data.status).toBe("done");
      expect(stageEvents[4].data.data.prd).toBeDefined();
      expect(stageEvents[5].data).toEqual({ stage: "spec", status: "running" });
      expect(stageEvents[6].data.stage).toBe("spec");
      expect(stageEvents[6].data.status).toBe("done");
      expect(stageEvents[6].data.data.spec).toBeDefined();

      // done イベント
      expect(doneEvents.length).toBe(1);
      expect(doneEvents[0].data).toEqual({});
    });

    it("callClaude が3回呼ばれること（analysis, PRD, spec）", async () => {
      // Given
      insertSession("spipe-calls", "テーマ", TEST_USER_ID);
      insertMessage("spipe-calls", "assistant", "質問");
      insertMessage("spipe-calls", "user", "回答");

      // When
      const res = await authedRequest("/api/sessions/spipe-calls/pipeline", { method: "POST" });
      await res.text(); // consume stream

      // Then
      expect(callClaude).toHaveBeenCalledTimes(3);
    });

    it("DB に analysis_results が facts, hypotheses, prd, spec の4行保存されること", async () => {
      // Given
      insertSession("spipe-db", "テーマ", TEST_USER_ID);
      insertMessage("spipe-db", "assistant", "質問");
      insertMessage("spipe-db", "user", "回答");

      // When
      const res = await authedRequest("/api/sessions/spipe-db/pipeline", { method: "POST" });
      await res.text(); // consume stream

      // Then: 4種類の analysis_results が保存される
      const rows = rawDb
        .prepare("SELECT type FROM analysis_results WHERE session_id = ? ORDER BY type")
        .all("spipe-db") as any[];
      const types = rows.map((r: any) => r.type).sort();
      expect(types).toEqual(["facts", "hypotheses", "prd", "spec"]);
    });

    it("セッションのステータスが spec_generated に更新されること", async () => {
      // Given
      insertSession("spipe-status", "テーマ", TEST_USER_ID);
      insertMessage("spipe-status", "assistant", "質問");
      insertMessage("spipe-status", "user", "回答");

      // When
      const res = await authedRequest("/api/sessions/spipe-status/pipeline", { method: "POST" });
      await res.text(); // consume stream

      // Then: 最終ステータスは spec_generated
      const session = rawDb.prepare("SELECT status FROM sessions WHERE id = ?").get("spipe-status") as any;
      expect(session.status).toBe("spec_generated");
    });

    it("spec に prdMarkdown が含まれること", async () => {
      // Given
      insertSession("spipe-md", "マークダウンテーマ", TEST_USER_ID);
      insertMessage("spipe-md", "assistant", "質問");
      insertMessage("spipe-md", "user", "回答");

      // When
      const res = await authedRequest("/api/sessions/spipe-md/pipeline", { method: "POST" });
      const events = await readSSE(res);

      // Then: spec done イベントに prdMarkdown が含まれる
      const specDone = events.find((e) => e.event === "stage" && e.data.stage === "spec" && e.data.status === "done");
      expect(specDone).toBeDefined();
      expect(specDone?.data.data.spec.prdMarkdown).toBeDefined();
      expect(specDone?.data.data.spec.prdMarkdown).toContain("マークダウンテーマ");
    });
  });

  // -------------------------------------------------------------------------
  // 2. Session not found
  // -------------------------------------------------------------------------
  describe("セッションが見つからない場合", () => {
    it("存在しないセッション ID で 404 を返すこと", async () => {
      // When: 存在しないセッションに pipeline を実行
      const res = await authedRequest("/api/sessions/nonexistent-id/pipeline", { method: "POST" });

      // Then: 404
      expect(res.status).toBe(404);
      const data = (await res.json()) as any;
      expect(data.error).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Not owner (403)
  // -------------------------------------------------------------------------
  describe("セッションオーナーでない場合", () => {
    const OTHER_USER_ID = "test-user-002";
    const OTHER_EXE_USER_ID = "exe-test-002";
    const OTHER_EMAIL = "otheruser@example.com";

    beforeEach(() => {
      rawDb
        .prepare("INSERT INTO users (id, exe_user_id, email, display_name, plan) VALUES (?, ?, ?, ?, ?)")
        .run(OTHER_USER_ID, OTHER_EXE_USER_ID, OTHER_EMAIL, "otheruser", "pro");
    });

    it("他人のセッションに対して 403 を返すこと", async () => {
      // Given: 他人が所有するセッション
      insertSession("spipe-other", "他人テーマ", OTHER_USER_ID);

      // When: 自分の認証で pipeline 実行
      const res = await authedRequest("/api/sessions/spipe-other/pipeline", { method: "POST" });

      // Then: 403
      expect(res.status).toBe(403);
      const data = (await res.json()) as any;
      expect(data.error).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Unauthenticated access
  // -------------------------------------------------------------------------
  describe("未認証アクセス", () => {
    it("user_id 付きのセッションに未認証でアクセスした場合 403 を返すこと", async () => {
      // Given: ユーザー所有のセッション
      insertSession("spipe-unauth", "テーマ", TEST_USER_ID);

      // When: 認証なしで pipeline 実行
      const res = await app.request("/api/sessions/spipe-unauth/pipeline", { method: "POST" });

      // Then: 403 (所有者チェックで拒否)
      expect(res.status).toBe(403);
    });

    it("ゲストセッション（user_id=null）には未認証の場合 Pro ゲートで 401 になること", async () => {
      // Given: user_id=null のゲストセッション
      rawDb
        .prepare("INSERT INTO sessions (id, theme, user_id, is_public) VALUES (?, ?, NULL, 1)")
        .run("spipe-guest", "ゲストテーマ");
      insertMessage("spipe-guest", "assistant", "質問");
      insertMessage("spipe-guest", "user", "回答");

      // When: 認証なしで pipeline 実行
      // Note: Pro gate は "prd" なので、ゲストセッションでも prd ステップで 401 になる
      const res = await app.request("/api/sessions/spipe-guest/pipeline", { method: "POST" });

      // Then: 401 (Pro gate: login required)
      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error).toContain("Login required");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Pro gate for free user
  // -------------------------------------------------------------------------
  describe("無料ユーザーの Pro ゲート", () => {
    const FREE_USER_ID = "free-user-001";
    const FREE_EXE_USER_ID = "exe-free-001";
    const FREE_EMAIL = "freeuser@example.com";

    async function freeUserRequest(path: string, options: RequestInit = {}): Promise<Response> {
      const headers = new Headers(options.headers);
      headers.set("x-exedev-userid", FREE_EXE_USER_ID);
      headers.set("x-exedev-email", FREE_EMAIL);
      return await app.request(path, { ...options, headers });
    }

    beforeEach(() => {
      rawDb
        .prepare("INSERT INTO users (id, exe_user_id, email, display_name, plan) VALUES (?, ?, ?, ?, ?)")
        .run(FREE_USER_ID, FREE_EXE_USER_ID, FREE_EMAIL, "freeuser", "free");
    });

    it("無料ユーザーがパイプライン実行時に 402 を返すこと（PRD ステップで Pro が必要）", async () => {
      // Given: 無料ユーザーのセッション
      insertSession("spipe-free", "テーマ", FREE_USER_ID);
      insertMessage("spipe-free", "assistant", "質問");
      insertMessage("spipe-free", "user", "回答");

      // When: pipeline 実行
      const res = await freeUserRequest("/api/sessions/spipe-free/pipeline", { method: "POST" });

      // Then: 402 Pro plan required
      expect(res.status).toBe(402);
      const data = (await res.json()) as any;
      expect(data.error).toContain("Pro plan required");
      expect(data.upgrade).toBe(true);
      expect(data.upgradeUrl).toBeDefined();
      expect(data.upgradeUrl).toContain(FREE_USER_ID);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Pro gate for unauthenticated user
  // -------------------------------------------------------------------------
  describe("未認証ユーザーの Pro ゲート", () => {
    it("未認証ユーザーがパイプライン実行時に 401 を返すこと", async () => {
      // Given: 公開セッション（未認証でアクセス可能だが Pro ゲートで阻止）
      insertSession("spipe-unauth-pro", "テーマ", TEST_USER_ID, { is_public: 1 });
      insertMessage("spipe-unauth-pro", "assistant", "質問");
      insertMessage("spipe-unauth-pro", "user", "回答");

      // When: 認証なしで pipeline 実行
      const res = await app.request("/api/sessions/spipe-unauth-pro/pipeline", { method: "POST" });

      // Then: 401 Login required
      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error).toContain("Login required");
      expect(data.upgrade).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 7. LLM returns non-JSON (parseJSON fallback)
  // -------------------------------------------------------------------------
  describe("LLM が非 JSON を返した場合のフォールバック", () => {
    it("パイプラインが parseJSON フォールバックで完了すること", async () => {
      // Given
      insertSession("spipe-nojson", "テーマ", TEST_USER_ID);
      insertMessage("spipe-nojson", "assistant", "質問");
      insertMessage("spipe-nojson", "user", "回答");

      // Override mocks: LLM returns non-JSON text for all 3 calls
      vi.mocked(extractText).mockReset();
      vi.mocked(extractText)
        .mockReturnValueOnce("これはJSONではありません。分析結果のテキストです。")
        .mockReturnValueOnce("PRDのプレーンテキスト結果です。")
        .mockReturnValueOnce("Specのプレーンテキスト結果です。");

      // When
      const res = await authedRequest("/api/sessions/spipe-nojson/pipeline", { method: "POST" });
      const events = await readSSE(res);

      // Then: パイプラインは完了する（done イベントがある）
      const doneEvents = events.filter((e) => e.event === "done");
      expect(doneEvents.length).toBe(1);

      // ステージイベントも全部出る
      const stageEvents = events.filter((e) => e.event === "stage");
      expect(stageEvents.length).toBe(7);

      // facts done にフォールバックデータが入る
      const factsDone = stageEvents.find((e) => e.data.stage === "facts" && e.data.status === "done");
      expect(factsDone).toBeDefined();
      expect(factsDone?.data.data.facts).toBeDefined();
      expect(factsDone?.data.data.facts.length).toBeGreaterThan(0);
      // フォールバックの場合、facts[0].id は "F1"
      expect(factsDone?.data.data.facts[0].id).toBe("F1");

      // hypotheses done にフォールバックデータが入る
      const hypDone = stageEvents.find((e) => e.data.stage === "hypotheses" && e.data.status === "done");
      expect(hypDone).toBeDefined();
      expect(hypDone?.data.data.hypotheses).toBeDefined();
      expect(hypDone?.data.data.hypotheses[0].title).toBe("parse error");

      // prd done にフォールバックデータが入る
      const prdDone = stageEvents.find((e) => e.data.stage === "prd" && e.data.status === "done");
      expect(prdDone).toBeDefined();
      expect(prdDone?.data.data.prd).toBeDefined();
      expect(prdDone?.data.data.prd.problemDefinition).toContain("PRDのプレーンテキスト");

      // DB にも保存される
      const rows = rawDb
        .prepare("SELECT type FROM analysis_results WHERE session_id = ? ORDER BY type")
        .all("spipe-nojson") as any[];
      const types = rows.map((r: any) => r.type).sort();
      expect(types).toEqual(["facts", "hypotheses", "prd", "spec"]);

      // セッションステータスも更新される
      const session = rawDb.prepare("SELECT status FROM sessions WHERE id = ?").get("spipe-nojson") as any;
      expect(session.status).toBe("spec_generated");
    });
  });

  // -------------------------------------------------------------------------
  // 8. Empty messages
  // -------------------------------------------------------------------------
  describe("メッセージが空の場合", () => {
    it("メッセージが0件でもパイプラインが実行されること", async () => {
      // Given: メッセージなしのセッション
      insertSession("spipe-empty", "空テーマ", TEST_USER_ID);

      // When
      const res = await authedRequest("/api/sessions/spipe-empty/pipeline", { method: "POST" });
      const events = await readSSE(res);

      // Then: パイプラインは完了する
      const doneEvents = events.filter((e) => e.event === "done");
      expect(doneEvents.length).toBe(1);

      // callClaude が3回呼ばれる（空のトランスクリプトでも）
      expect(callClaude).toHaveBeenCalledTimes(3);

      // DB に結果が保存される
      const rows = rawDb.prepare("SELECT type FROM analysis_results WHERE session_id = ?").all("spipe-empty") as any[];
      expect(rows.length).toBe(4);
    });
  });
});
