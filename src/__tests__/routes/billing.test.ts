import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (_c: any, next: any) => await next(),
}));

vi.mock("../../db/index.ts", async () => {
  const { createTestDb } = await import("../helpers/test-db.ts");
  return { db: createTestDb() };
});

// Mock LLM — use vi.hoisted to avoid temporal dead zone
const { mockCallClaude, mockExtractText } = vi.hoisted(() => ({
  mockCallClaude: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "月にどのくらい使う予定ですか？" }],
  }),
  mockExtractText: vi.fn().mockReturnValue("月にどのくらい使う予定ですか？"),
}));

vi.mock("../../llm.ts", () => ({
  MODEL_FAST: "claude-sonnet-4-6",
  MODEL_SMART: "claude-opus-4-6",
  callClaude: mockCallClaude,
  callClaudeStream: vi.fn(),
  extractText: mockExtractText,
}));

// Mock Stripe SDK
const { mockCheckoutCreate, mockConstructEvent } = vi.hoisted(() => ({
  mockCheckoutCreate: vi.fn().mockResolvedValue({
    url: "https://checkout.stripe.com/test_session",
  }),
  mockConstructEvent: vi.fn(),
}));

vi.mock("stripe", () => {
  return {
    default: class MockStripe {
      checkout = { sessions: { create: mockCheckoutCreate } };
      webhooks = { constructEvent: mockConstructEvent };
    },
  };
});

import { app } from "../../app.ts";
import { getRawDb } from "../helpers/test-db.ts";

const rawDb = getRawDb();

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
const TEST_EXE_USER_ID = "exe-billing-001";
const TEST_EMAIL = "billing@test.com";

async function authedRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("x-exedev-userid", TEST_EXE_USER_ID);
  headers.set("x-exedev-email", TEST_EMAIL);
  return await app.request(path, { ...options, headers });
}

async function postWebhook(body: unknown): Promise<Response> {
  return await app.request("/api/billing/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function postConsult(body: Record<string, unknown>, options: { authed?: boolean } = {}): Promise<Response> {
  const reqOptions: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  return options.authed
    ? authedRequest("/api/billing/consult", reqOptions)
    : await app.request("/api/billing/consult", reqOptions);
}

// ---------------------------------------------------------------------------
// Helper: clean tables using parameterized DELETE
// ---------------------------------------------------------------------------
function cleanTables(): void {
  for (const table of [
    "page_views",
    "auth_sessions",
    "analysis_results",
    "messages",
    "sessions",
    "feedback",
    "users",
  ]) {
    rawDb.prepare(`DELETE FROM ${table}`).run();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("課金 API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanTables();

    // Set Stripe env vars for tests
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.STRIPE_PRICE_ID = "price_test_dummy";
    delete process.env.STRIPE_WEBHOOK_SECRET;

    // Reset mock return values
    mockExtractText.mockReturnValue("月にどのくらい使う予定ですか？");
  });

  // -------------------------------------------------------------------------
  // POST /api/billing/consult — AI 接客
  // -------------------------------------------------------------------------
  describe("POST /api/billing/consult — AI 接客", () => {
    it("メッセージ空で 400 を返すこと", async () => {
      const res = await postConsult({ message: "" });
      expect(res.status).toBe(400);
    });

    it("メッセージ未指定で 400 を返すこと", async () => {
      const res = await postConsult({});
      expect(res.status).toBe(400);
    });

    it("正常なメッセージで AI レスポンスを返すこと", async () => {
      const res = await postConsult({ message: "月に5回くらい使いたい" });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.reply).toBeTruthy();
      expect(data.done).toBe(false);
      expect(data.recommendation).toBeNull();
    });

    it("history 付きで対話を継続できること", async () => {
      const res = await postConsult({
        message: "チームで使います",
        history: [
          { role: "user", content: "月に5回くらい使いたい" },
          { role: "assistant", content: "チームでお使いですか？" },
        ],
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.reply).toBeTruthy();
    });

    it("[RECOMMEND:pro] + ログイン済みで checkoutUrl が返ること", async () => {
      mockExtractText.mockReturnValueOnce("Pro がおすすめです [RECOMMEND:pro]");

      const res = await postConsult({ message: "たくさん使いたい" }, { authed: true });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.recommendation).toBe("pro");
      expect(data.checkoutUrl).toBe("https://checkout.stripe.com/test_session");
      expect(data.done).toBe(true);
    });

    it("[RECOMMEND:pro] + 未ログインで checkoutUrl が null のこと", async () => {
      mockExtractText.mockReturnValueOnce("Pro がおすすめです [RECOMMEND:pro]");

      const res = await postConsult({ message: "たくさん使いたい" });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.recommendation).toBe("pro");
      expect(data.checkoutUrl).toBeNull();
    });

    it("[RECOMMEND:free] で recommendation が free のこと", async () => {
      mockExtractText.mockReturnValueOnce("Free で十分です [RECOMMEND:free]");

      const res = await postConsult({ message: "月1回だけ" });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.recommendation).toBe("free");
      expect(data.done).toBe(true);
    });

    it("不正な JSON で 400 を返すこと", async () => {
      const res = await app.request("/api/billing/consult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/billing/checkout — Checkout Session 作成
  // -------------------------------------------------------------------------
  describe("POST /api/billing/checkout — Checkout Session 作成", () => {
    it("未認証で 401 を返すこと", async () => {
      const res = await app.request("/api/billing/checkout", { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("認証済みで checkoutUrl を返すこと", async () => {
      const res = await authedRequest("/api/billing/checkout", { method: "POST" });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.checkoutUrl).toBe("https://checkout.stripe.com/test_session");
    });

    it("STRIPE_PRICE_ID 未設定で 503 を返すこと", async () => {
      delete process.env.STRIPE_PRICE_ID;

      const res = await authedRequest("/api/billing/checkout", { method: "POST" });
      expect(res.status).toBe(503);
      const data = (await res.json()) as any;
      expect(data.error).toContain("決済サービス");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/billing/webhook — Stripe Webhook
  // -------------------------------------------------------------------------
  describe("POST /api/billing/webhook — Stripe Webhook", () => {
    it("checkout.session.completed でユーザーが pro にアップグレードされること", async () => {
      rawDb
        .prepare("INSERT INTO users (id, exe_user_id, email, plan) VALUES (?, ?, ?, ?)")
        .run("user-checkout-001", "exe-checkout-001", "checkout@test.com", "free");

      const res = await postWebhook({
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: "user-checkout-001",
            customer: "cus_abc123",
          },
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { received: boolean };
      expect(data.received).toBe(true);

      const row = rawDb
        .prepare("SELECT plan, stripe_customer_id FROM users WHERE id = ?")
        .get("user-checkout-001") as any;
      expect(row.plan).toBe("pro");
      expect(row.stripe_customer_id).toBe("cus_abc123");
    });

    it("customer.subscription.deleted でユーザーが free にダウングレードされること", async () => {
      rawDb
        .prepare("INSERT INTO users (id, exe_user_id, email, plan, stripe_customer_id) VALUES (?, ?, ?, ?, ?)")
        .run("user-sub-del-001", "exe-sub-del-001", "subdel@test.com", "pro", "cus_del456");

      const res = await postWebhook({
        type: "customer.subscription.deleted",
        data: { object: { customer: "cus_del456" } },
      });

      expect(res.status).toBe(200);
      const row = rawDb.prepare("SELECT plan FROM users WHERE id = ?").get("user-sub-del-001") as any;
      expect(row.plan).toBe("free");
    });

    it("不明なイベントでも { received: true } を返すこと", async () => {
      const res = await postWebhook({
        type: "invoice.payment_succeeded",
        data: { object: {} },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { received: boolean };
      expect(data.received).toBe(true);
    });

    it("不正な JSON で 400 を返すこと", async () => {
      const res = await app.request("/api/billing/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json {{",
      });
      expect(res.status).toBe(400);
    });

    it("client_reference_id なしでも成功するが DB 変更なし", async () => {
      rawDb
        .prepare("INSERT INTO users (id, exe_user_id, email, plan) VALUES (?, ?, ?, ?)")
        .run("user-no-ref-001", "exe-no-ref-001", "noref@test.com", "free");

      const res = await postWebhook({
        type: "checkout.session.completed",
        data: { object: { client_reference_id: null, customer: "cus_noref789" } },
      });

      expect(res.status).toBe(200);
      const row = rawDb
        .prepare("SELECT plan, stripe_customer_id FROM users WHERE id = ?")
        .get("user-no-ref-001") as any;
      expect(row.plan).toBe("free");
      expect(row.stripe_customer_id).toBeNull();
    });

    it("署名なし + WEBHOOK_SECRET 設定済みで 400 を返すこと", async () => {
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_dummy";

      const res = await app.request("/api/billing/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "checkout.session.completed", data: { object: {} } }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toContain("stripe-signature");
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/billing/plan — プラン確認
  // -------------------------------------------------------------------------
  describe("GET /api/billing/plan — プラン確認", () => {
    it("未認証で { plan: 'free', loggedIn: false } を返すこと", async () => {
      const res = await app.request("/api/billing/plan");
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.plan).toBe("free");
      expect(data.loggedIn).toBe(false);
    });

    it("認証済み free ユーザーのプランを返すこと", async () => {
      const res = await authedRequest("/api/billing/plan");
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.plan).toBe("free");
      expect(data.loggedIn).toBe(true);
    });

    it("認証済み pro ユーザーのプランを返すこと", async () => {
      await authedRequest("/api/billing/plan");
      rawDb.prepare("UPDATE users SET plan = 'pro' WHERE exe_user_id = ?").run(TEST_EXE_USER_ID);

      const res = await authedRequest("/api/billing/plan");
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.plan).toBe("pro");
      expect(data.loggedIn).toBe(true);
    });
  });
});
