import { Hono } from "hono";
import { now } from "../db/helpers.ts";
import { db } from "../db/index.ts";
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
      const subscription = event.data.object;
      const customerId = subscription.customer;

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

// GET /billing/plan — Get current user's plan
billingRoutes.get("/plan", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ plan: "free", loggedIn: false });

  const row = await db.selectFrom("users").select("plan").where("id", "=", user.id).executeTakeFirst();
  return c.json({ plan: row?.plan || "free", loggedIn: true });
});
