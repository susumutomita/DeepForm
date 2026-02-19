import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => async (_c: any, next: any) => await next(),
}));

vi.mock("../../db/index.ts", async () => {
  const { createTestDb } = await import("../helpers/test-db.ts");
  return { db: createTestDb() };
});

vi.mock("../../llm.ts", () => ({
  MODEL_FAST: "claude-haiku-4-5-20250929",
  MODEL_SMART: "claude-sonnet-4-5-20250929",
  callClaude: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "test" }],
  }),
  callClaudeStream: vi.fn(),
  extractText: vi.fn().mockReturnValue("test"),
}));

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

// ---------------------------------------------------------------------------
// Stripe webhook helper
// ---------------------------------------------------------------------------
async function postWebhook(body: unknown): Promise<Response> {
  return await app.request("/api/billing/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------
describe("Billing API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rawDb.exec("DELETE FROM page_views");
    rawDb.exec("DELETE FROM auth_sessions");
    rawDb.exec("DELETE FROM analysis_results");
    rawDb.exec("DELETE FROM messages");
    rawDb.exec("DELETE FROM sessions");
    rawDb.exec("DELETE FROM feedback");
    rawDb.exec("DELETE FROM users");
  });

  // -------------------------------------------------------------------------
  // POST /api/billing/webhook
  // -------------------------------------------------------------------------
  describe("POST /api/billing/webhook", () => {
    it("checkout.session.completed with valid userId upgrades user to pro", async () => {
      // Given: a free user exists in the DB
      const userId = "user-checkout-001";
      rawDb
        .prepare("INSERT INTO users (id, exe_user_id, email, plan) VALUES (?, ?, ?, ?)")
        .run(userId, "exe-checkout-001", "checkout@test.com", "free");

      // When: Stripe sends checkout.session.completed
      const res = await postWebhook({
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: userId,
            customer: "cus_abc123",
          },
        },
      });

      // Then: returns 200 with { received: true }
      expect(res.status).toBe(200);
      const data = (await res.json()) as { received: boolean };
      expect(data.received).toBe(true);

      // And: user is upgraded to pro with stripe_customer_id
      const row = rawDb.prepare("SELECT plan, stripe_customer_id FROM users WHERE id = ?").get(userId) as any;
      expect(row.plan).toBe("pro");
      expect(row.stripe_customer_id).toBe("cus_abc123");
    });

    it("customer.subscription.deleted downgrades user by stripe_customer_id", async () => {
      // Given: a pro user with a stripe_customer_id
      const userId = "user-sub-del-001";
      const customerId = "cus_del456";
      rawDb
        .prepare("INSERT INTO users (id, exe_user_id, email, plan, stripe_customer_id) VALUES (?, ?, ?, ?, ?)")
        .run(userId, "exe-sub-del-001", "subdel@test.com", "pro", customerId);

      // When: Stripe sends customer.subscription.deleted
      const res = await postWebhook({
        type: "customer.subscription.deleted",
        data: {
          object: {
            customer: customerId,
          },
        },
      });

      // Then: returns 200 with { received: true }
      expect(res.status).toBe(200);
      const data = (await res.json()) as { received: boolean };
      expect(data.received).toBe(true);

      // And: user is downgraded to free
      const row = rawDb.prepare("SELECT plan FROM users WHERE id = ?").get(userId) as any;
      expect(row.plan).toBe("free");
    });

    it("unknown event type still returns { received: true }", async () => {
      const res = await postWebhook({
        type: "invoice.payment_succeeded",
        data: { object: {} },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { received: boolean };
      expect(data.received).toBe(true);
    });

    it("invalid JSON body returns 400", async () => {
      const res = await app.request("/api/billing/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json {{",
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBeTruthy();
    });

    it("checkout.session.completed with missing userId causes no DB change but still succeeds", async () => {
      // Given: a user exists
      const userId = "user-no-ref-001";
      rawDb
        .prepare("INSERT INTO users (id, exe_user_id, email, plan) VALUES (?, ?, ?, ?)")
        .run(userId, "exe-no-ref-001", "noref@test.com", "free");

      // When: checkout event has no client_reference_id
      const res = await postWebhook({
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: null,
            customer: "cus_noref789",
          },
        },
      });

      // Then: still returns success
      expect(res.status).toBe(200);
      const data = (await res.json()) as { received: boolean };
      expect(data.received).toBe(true);

      // And: user plan remains free
      const row = rawDb.prepare("SELECT plan, stripe_customer_id FROM users WHERE id = ?").get(userId) as any;
      expect(row.plan).toBe("free");
      expect(row.stripe_customer_id).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/billing/plan
  // -------------------------------------------------------------------------
  describe("GET /api/billing/plan", () => {
    it("unauthenticated request returns { plan: 'free', loggedIn: false }", async () => {
      const res = await app.request("/api/billing/plan");

      expect(res.status).toBe(200);
      const data = (await res.json()) as { plan: string; loggedIn: boolean };
      expect(data.plan).toBe("free");
      expect(data.loggedIn).toBe(false);
    });

    it("authenticated free user returns { plan: 'free', loggedIn: true }", async () => {
      const res = await authedRequest("/api/billing/plan");

      expect(res.status).toBe(200);
      const data = (await res.json()) as { plan: string; loggedIn: boolean };
      expect(data.plan).toBe("free");
      expect(data.loggedIn).toBe(true);
    });

    it("authenticated pro user returns { plan: 'pro', loggedIn: true }", async () => {
      // Given: make a first authed request so the user is created via auth middleware
      await authedRequest("/api/billing/plan");

      // Then: upgrade the user to pro in the DB
      rawDb.prepare("UPDATE users SET plan = 'pro' WHERE exe_user_id = ?").run(TEST_EXE_USER_ID);

      // When: request the plan again
      const res = await authedRequest("/api/billing/plan");

      expect(res.status).toBe(200);
      const data = (await res.json()) as { plan: string; loggedIn: boolean };
      expect(data.plan).toBe("pro");
      expect(data.loggedIn).toBe(true);
    });
  });
});
