import { Hono } from "hono";
import Stripe from "stripe";
import { ZodError } from "zod";
import { now } from "../db/helpers.ts";
import { db } from "../db/index.ts";
import { callClaude, extractText, MODEL_FAST } from "../llm.ts";
import { requireAuth } from "../middleware/auth.ts";
import type { AppEnv } from "../types.ts";
import { pricingConsultSchema } from "../validation.ts";

export const billingRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Stripe client (lazy init — only when STRIPE_SECRET_KEY is set)
// ---------------------------------------------------------------------------
let _stripe: Stripe | null = null;

function getStripe(): Stripe | null {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  _stripe = new Stripe(key);
  return _stripe;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PRICING_SYSTEM_PROMPT = `あなたは DeepForm のプランアドバイザーです。

## DeepForm とは
AI インタビューツール。アイデアを AI の質問に答えるだけで要件定義書に変換する。

## プラン
- お試し (初月): 全機能無料
- Free (お試し後): 月1回インタビュー、AI アプリ生成、3ヶ月の履歴
- Pro ($5/月): 無制限インタビュー、永久履歴、キャンペーン機能、優先サポート

## ルール
1. 用途を 1 つずつ質問（頻度、個人/チーム、重視すること）
2. 回答は 2〜3 文で簡潔に
3. 3 ターン以内でプラン推薦
4. 推薦時は回答末尾に [RECOMMEND:free] or [RECOMMEND:pro] を含める
5. 押し売りしない。月1回なら Free を勧める
6. ユーザーと同じ言語で回答`;

// ---------------------------------------------------------------------------
// POST /billing/consult — AI pricing advisor
// ---------------------------------------------------------------------------
billingRoutes.post("/consult", async (c) => {
  try {
    const body = await c.req.json();
    const { message, history } = pricingConsultSchema.parse(body);

    const messages: Array<{ role: "user" | "assistant"; content: string }> =
      history && Array.isArray(history) ? [...history] : [];
    messages.push({ role: "user", content: message });

    const turnCount = messages.filter((m) => m.role === "user").length;

    const systemPrompt =
      turnCount >= 3
        ? `${PRICING_SYSTEM_PROMPT}\n\nこれが最後のターンです。必ずプラン推薦を含めてください。`
        : PRICING_SYSTEM_PROMPT;

    const response = await callClaude(messages, systemPrompt, 512, MODEL_FAST);
    let reply = extractText(response);

    // Parse [RECOMMEND:free] or [RECOMMEND:pro]
    let recommendation: "free" | "pro" | null = null;
    const recommendMatch = reply.match(/\[RECOMMEND:(free|pro)\]/i);
    if (recommendMatch) {
      recommendation = recommendMatch[1].toLowerCase() as "free" | "pro";
      reply = reply.replace(/\[RECOMMEND:(free|pro)\]/gi, "").trim();
    }

    const done = turnCount >= 3 || recommendation !== null;

    // If Pro recommended + logged in → create Checkout session
    let checkoutUrl: string | undefined;
    if (recommendation === "pro") {
      const user = c.get("user");
      if (user) {
        const stripe = getStripe();
        if (stripe) {
          const priceId = process.env.STRIPE_PRICE_ID;
          if (priceId) {
            const baseUrl = new URL(c.req.url).origin;
            const session = await stripe.checkout.sessions.create({
              mode: "subscription",
              customer_email: user.email,
              client_reference_id: user.id,
              line_items: [{ price: priceId, quantity: 1 }],
              success_url: `${baseUrl}/?upgraded=true`,
              cancel_url: `${baseUrl}/#pricing`,
            });
            checkoutUrl = session.url ?? undefined;
          }
        }
      }
    }

    return c.json({ reply, recommendation, checkoutUrl: checkoutUrl ?? null, done });
  } catch (e) {
    if (e instanceof SyntaxError) return c.json({ error: "Invalid JSON" }, 400);
    if (e instanceof ZodError) {
      const msg = e.issues.map((i) => i.message).join(", ");
      return c.json({ error: msg }, 400);
    }
    console.error("Pricing consult error:", e);
    return c.json({ error: "エラーが発生しました" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /billing/checkout — Create Stripe Checkout session (auth required)
// ---------------------------------------------------------------------------
billingRoutes.post("/checkout", requireAuth, async (c) => {
  const stripe = getStripe();
  if (!stripe) {
    return c.json({ error: "決済サービスが設定されていません" }, 503);
  }

  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) {
    return c.json({ error: "決済サービスが設定されていません" }, 503);
  }

  const user = c.get("user");
  const baseUrl = new URL(c.req.url).origin;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: user.email,
    client_reference_id: user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${baseUrl}/?upgraded=true`,
    cancel_url: `${baseUrl}/#pricing`,
  });

  return c.json({ checkoutUrl: session.url });
});

// ---------------------------------------------------------------------------
// POST /billing/webhook — Stripe webhook (signature verification)
// ---------------------------------------------------------------------------
billingRoutes.post("/webhook", async (c) => {
  try {
    const body = await c.req.text();
    const stripe = getStripe();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event: Stripe.Event | { type: string; data: { object: Record<string, unknown> } };

    if (stripe && webhookSecret) {
      // Verify webhook signature
      const sig = c.req.header("stripe-signature");
      if (!sig) {
        return c.json({ error: "Missing stripe-signature header" }, 400);
      }
      event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    } else {
      // Fallback: parse without verification (dev/test)
      event = JSON.parse(body);
    }

    // Handle checkout.session.completed
    if (event.type === "checkout.session.completed") {
      const obj = event.data.object as Record<string, unknown>;
      const userId = obj.client_reference_id as string | null;
      const customerId = (obj.customer as string) ?? null;

      if (userId) {
        await db
          .updateTable("users")
          .set({
            plan: "pro",
            stripe_customer_id: customerId,
            plan_updated_at: now(),
          })
          .where("id", "=", userId)
          .execute();
        console.log(`User ${userId} upgraded to pro`);
      }
    }

    // Handle customer.subscription.deleted (cancellation)
    if (event.type === "customer.subscription.deleted") {
      const obj = event.data.object as Record<string, unknown>;
      const customerId = obj.customer as string;

      await db
        .updateTable("users")
        .set({
          plan: "free",
          plan_updated_at: now(),
        })
        .where("stripe_customer_id", "=", customerId)
        .execute();
      console.log(`Customer ${customerId} downgraded to free`);
    }

    return c.json({ received: true });
  } catch (e) {
    console.error("Webhook error:", e);
    return c.json({ error: "Webhook processing failed" }, 400);
  }
});

// ---------------------------------------------------------------------------
// GET /billing/plan — Get current user's plan
// ---------------------------------------------------------------------------
billingRoutes.get("/plan", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ plan: "free", loggedIn: false });

  const row = await db.selectFrom("users").select("plan").where("id", "=", user.id).executeTakeFirst();
  return c.json({ plan: row?.plan || "free", loggedIn: true });
});
