import { Hono } from "hono";
import { db } from "../db.ts";
import type { AppEnv } from "../types.ts";

export const billingRoutes = new Hono<AppEnv>();

// POST /billing/webhook — Stripe webhook
billingRoutes.post("/webhook", async (c) => {
  try {
    const body = await c.req.text();
    const event = JSON.parse(body);

    // Handle checkout.session.completed
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.client_reference_id;
      const customerId = session.customer;

      if (userId) {
        db.prepare(
          "UPDATE users SET plan = 'pro', stripe_customer_id = ?, plan_updated_at = datetime('now') WHERE id = ?",
        ).run(customerId, userId);
        console.log(`User ${userId} upgraded to pro`);
      }
    }

    // Handle customer.subscription.deleted (cancellation)
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      db.prepare("UPDATE users SET plan = 'free', plan_updated_at = datetime('now') WHERE stripe_customer_id = ?").run(
        customerId,
      );
      console.log(`Customer ${customerId} downgraded to free`);
    }

    return c.json({ received: true });
  } catch (e) {
    console.error("Webhook error:", e);
    return c.json({ error: "Webhook processing failed" }, 400);
  }
});

// GET /billing/plan — Get current user's plan
billingRoutes.get("/plan", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ plan: "free", loggedIn: false });

  const row = db.prepare("SELECT plan FROM users WHERE id = ?").get(user.id) as { plan: string } | undefined;
  return c.json({ plan: row?.plan || "free", loggedIn: true });
});
