import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock static file serving to avoid filesystem access in tests
vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (_c: any, next: any) => await next(),
}));

// node:sqlite でテスト用 DB を作成
vi.mock("../../db/index.ts", async () => {
  const { createTestDb } = await import("../helpers/test-db.ts");
  return { db: createTestDb() };
});

// Mock LLM
vi.mock("../../llm.ts", () => ({
  MODEL_FAST: "claude-haiku-4-5-20251001",
  MODEL_SMART: "claude-sonnet-4-5-20250929",
  callClaude: vi.fn(),
  extractText: vi.fn(),
}));

import { app } from "../../app.ts";
import { callClaude, extractText } from "../../llm.ts";
import { getRawDb } from "../helpers/test-db.ts";

const rawDb = getRawDb();

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
const _TEST_USER_ID = "test-user-001";
const TEST_EXE_USER_ID = "exe-test-001";
const TEST_EMAIL = "testuser@example.com";
const OTHER_EXE_USER_ID = "exe-test-002";
const OTHER_EMAIL = "otheruser@example.com";

type SQLInputValue = null | number | bigint | string;

async function authedRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("x-exedev-userid", TEST_EXE_USER_ID);
  headers.set("x-exedev-email", TEST_EMAIL);
  return await app.request(path, { ...options, headers });
}

async function otherUserRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("x-exedev-userid", OTHER_EXE_USER_ID);
  headers.set("x-exedev-email", OTHER_EMAIL);
  return await app.request(path, { ...options, headers });
}

function setupUserAndSession(): { userId: string; sessionId: string } {
  const userId = `usr-${Date.now()}`;
  const sessionId = `sess-${Date.now()}`;

  (rawDb.prepare("INSERT INTO users (id, exe_user_id, email, plan) VALUES (?, ?, ?, ?)") as any).run(
    ...([userId, TEST_EXE_USER_ID, TEST_EMAIL, "pro"] as SQLInputValue[]),
  );

  (rawDb.prepare("INSERT INTO sessions (id, theme, status, mode, user_id) VALUES (?, ?, ?, ?, ?)") as any).run(
    ...([sessionId, "テスト課題", "prd_generated", "self", userId] as SQLInputValue[]),
  );

  // Insert PRD data
  const prdData = JSON.stringify({
    prd: {
      problemDefinition: "テスト問題定義",
      targetUser: "テスト対象ユーザー",
      qualityRequirements: {
        performanceEfficiency: {
          description: "大量のコストデータ処理とレポート生成の高速化",
          criteria: [
            "12ヶ月分のコストデータ取得・分析処理が30秒以内で完了",
            "PDFレポート生成が10秒以内に完了",
            "ダッシュボードの初期表示が3秒以内",
          ],
        },
      },
      coreFeatures: [
        {
          name: "レポート生成",
          description: "コストレポートの自動生成",
          priority: "must",
          acceptanceCriteria: ["月次レポートが自動生成されること"],
        },
      ],
      metrics: [{ name: "処理速度", definition: "API応答時間", target: "2秒以内" }],
    },
  });

  (rawDb.prepare("INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)") as any).run(
    ...([sessionId, "prd", prdData] as SQLInputValue[]),
  );

  return { userId, sessionId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Clear all tables
  (rawDb.prepare("DELETE FROM analysis_results") as any).run();
  (rawDb.prepare("DELETE FROM messages") as any).run();
  (rawDb.prepare("DELETE FROM sessions") as any).run();
  (rawDb.prepare("DELETE FROM users") as any).run();
  vi.clearAllMocks();
});

describe("POST /api/sessions/:id/prd/suggest", () => {
  it("returns 3 AI-suggested alternatives", async () => {
    const { sessionId } = setupUserAndSession();

    (callClaude as any).mockResolvedValue({
      content: [{ type: "text", text: '["5秒以内", "15秒以内", "30秒以内"]' }],
    });
    (extractText as any).mockReturnValue('["5秒以内", "15秒以内", "30秒以内"]');

    const res = await authedRequest(`/api/sessions/${sessionId}/prd/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "10秒以内",
        context: "PDFレポート生成が10秒以内に完了",
        sectionType: "qualityRequirements",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.suggestions).toHaveLength(3);
    expect(data.suggestions).toEqual(["5秒以内", "15秒以内", "30秒以内"]);
  });

  it("returns 401 for unauthenticated requests", async () => {
    const { sessionId } = setupUserAndSession();

    const res = await app.request(`/api/sessions/${sessionId}/prd/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "10秒以内",
        context: "PDFレポート生成が10秒以内に完了",
        sectionType: "qualityRequirements",
      }),
    });

    expect(res.status).toBe(403);
  });

  it("returns 403 for non-owner", async () => {
    const { sessionId } = setupUserAndSession();

    // Create other user
    (rawDb.prepare("INSERT INTO users (id, exe_user_id, email, plan) VALUES (?, ?, ?, ?)") as any).run(
      ...(["other-user", OTHER_EXE_USER_ID, OTHER_EMAIL, "pro"] as SQLInputValue[]),
    );

    const res = await otherUserRequest(`/api/sessions/${sessionId}/prd/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "10秒以内",
        context: "PDFレポート生成が10秒以内に完了",
        sectionType: "qualityRequirements",
      }),
    });

    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid input", async () => {
    const { sessionId } = setupUserAndSession();

    const res = await authedRequest(`/api/sessions/${sessionId}/prd/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "",
        context: "some context",
        sectionType: "qualityRequirements",
      }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent session", async () => {
    setupUserAndSession();

    const res = await authedRequest("/api/sessions/nonexistent/prd/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "test",
        context: "some context",
        sectionType: "qualityRequirements",
      }),
    });

    expect(res.status).toBe(404);
  });

  it("pads suggestions to 3 when AI returns fewer", async () => {
    const { sessionId } = setupUserAndSession();

    (callClaude as any).mockResolvedValue({
      content: [{ type: "text", text: '["5秒"]' }],
    });
    (extractText as any).mockReturnValue('["5秒"]');

    const res = await authedRequest(`/api/sessions/${sessionId}/prd/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "10秒",
        context: "PDFレポート生成が10秒以内に完了",
        sectionType: "qualityRequirements",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.suggestions).toHaveLength(3);
  });
});

describe("POST /api/sessions/:id/prd/apply", () => {
  it("applies a suggestion (non-custom) with simple text replacement", async () => {
    const { sessionId } = setupUserAndSession();

    const res = await authedRequest(`/api/sessions/${sessionId}/prd/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "10秒以内",
        newText: "5秒以内",
        context: "PDFレポート生成が10秒以内に完了",
        sectionType: "qualityRequirements",
        isCustomInput: false,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.applied).toBe(true);
    expect(data.updatedText).toBe("PDFレポート生成が5秒以内に完了");

    // Verify DB was updated
    const prdRow = (rawDb.prepare("SELECT data FROM analysis_results WHERE session_id = ? AND type = ?") as any).get(
      sessionId,
      "prd",
    ) as { data: string };
    const prdData = JSON.parse(prdRow.data);
    expect(prdData.prd.qualityRequirements.performanceEfficiency.criteria[1]).toContain("5秒以内");
  });

  it("applies custom input when validated as relevant", async () => {
    const { sessionId } = setupUserAndSession();

    // First call: validation (relevant)
    // Second call: rewrite
    (callClaude as any)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"relevant": true}' }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "PDFレポート生成が20秒以内に完了" }],
      });
    (extractText as any)
      .mockReturnValueOnce('{"relevant": true}')
      .mockReturnValueOnce("PDFレポート生成が20秒以内に完了");

    const res = await authedRequest(`/api/sessions/${sessionId}/prd/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "10秒以内",
        newText: "20秒",
        context: "PDFレポート生成が10秒以内に完了",
        sectionType: "qualityRequirements",
        isCustomInput: true,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.applied).toBe(true);
    expect(data.updatedText).toBe("PDFレポート生成が20秒以内に完了");
    // Claude was called twice (validation + rewrite)
    expect(callClaude).toHaveBeenCalledTimes(2);
  });

  it("rejects custom input when Claude returns unparseable validation response", async () => {
    const { sessionId } = setupUserAndSession();

    (callClaude as any).mockResolvedValue({
      content: [{ type: "text", text: "I cannot validate this" }],
    });
    (extractText as any).mockReturnValue("I cannot validate this");

    const res = await authedRequest(`/api/sessions/${sessionId}/prd/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "10秒以内",
        newText: "something",
        context: "PDFレポート生成が10秒以内に完了",
        sectionType: "qualityRequirements",
        isCustomInput: true,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.applied).toBe(false);
    expect(data.reason).toContain("検証に失敗");
  });

  it("rejects custom input when validated as irrelevant", async () => {
    const { sessionId } = setupUserAndSession();

    (callClaude as any).mockResolvedValue({
      content: [
        { type: "text", text: '{"relevant": false, "reason": "入力された内容は性能に関する要件と関連がありません。"}' },
      ],
    });
    (extractText as any).mockReturnValue(
      '{"relevant": false, "reason": "入力された内容は性能に関する要件と関連がありません。"}',
    );

    const res = await authedRequest(`/api/sessions/${sessionId}/prd/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "10秒以内",
        newText: "バナナ",
        context: "PDFレポート生成が10秒以内に完了",
        sectionType: "qualityRequirements",
        isCustomInput: true,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.applied).toBe(false);
    expect(data.reason).toContain("関連がありません");
  });

  it("returns 401 for unauthenticated requests", async () => {
    const { sessionId } = setupUserAndSession();

    const res = await app.request(`/api/sessions/${sessionId}/prd/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "test",
        newText: "new",
        context: "context",
        sectionType: "qualityRequirements",
        isCustomInput: false,
      }),
    });

    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid sectionType", async () => {
    const { sessionId } = setupUserAndSession();

    const res = await authedRequest(`/api/sessions/${sessionId}/prd/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "test",
        newText: "new",
        context: "context",
        sectionType: "invalidSection",
        isCustomInput: false,
      }),
    });

    expect(res.status).toBe(400);
  });

  it("persists changes to DB after successful apply", async () => {
    const { sessionId } = setupUserAndSession();

    await authedRequest(`/api/sessions/${sessionId}/prd/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "30秒以内",
        newText: "15秒以内",
        context: "12ヶ月分のコストデータ取得・分析処理が30秒以内で完了",
        sectionType: "qualityRequirements",
        isCustomInput: false,
      }),
    });

    const prdRow = (rawDb.prepare("SELECT data FROM analysis_results WHERE session_id = ? AND type = ?") as any).get(
      sessionId,
      "prd",
    ) as { data: string };
    const prdData = JSON.parse(prdRow.data);
    expect(prdData.prd.qualityRequirements.performanceEfficiency.criteria[0]).toContain("15秒以内");
    expect(prdData.prd.qualityRequirements.performanceEfficiency.criteria[0]).not.toContain("30秒以内");
  });

  it("allows multiple edits (edit is repeatable)", async () => {
    const { sessionId } = setupUserAndSession();

    // First edit: 10秒 → 5秒
    await authedRequest(`/api/sessions/${sessionId}/prd/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "10秒以内",
        newText: "5秒以内",
        context: "PDFレポート生成が10秒以内に完了",
        sectionType: "qualityRequirements",
        isCustomInput: false,
      }),
    });

    // Second edit: 5秒 → 3秒
    const res2 = await authedRequest(`/api/sessions/${sessionId}/prd/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "5秒以内",
        newText: "3秒以内",
        context: "PDFレポート生成が5秒以内に完了",
        sectionType: "qualityRequirements",
        isCustomInput: false,
      }),
    });

    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2.applied).toBe(true);
    expect(data2.updatedText).toBe("PDFレポート生成が3秒以内に完了");

    // Verify DB reflects latest edit
    const prdRow = (rawDb.prepare("SELECT data FROM analysis_results WHERE session_id = ? AND type = ?") as any).get(
      sessionId,
      "prd",
    ) as { data: string };
    const prdData = JSON.parse(prdRow.data);
    expect(prdData.prd.qualityRequirements.performanceEfficiency.criteria[1]).toContain("3秒以内");
  });
});
