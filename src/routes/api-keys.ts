import crypto from "node:crypto";
import { Hono } from "hono";
import { db } from "../db/index.ts";
import { hashApiKey, requireAuth } from "../middleware/auth.ts";
import type { ApiKey, User } from "../types.ts";
import { createApiKeySchema } from "../validation.ts";

const MAX_KEYS_PER_USER = 10;
const KEY_PREFIX = "deepform_";

const apiKeys = new Hono<{ Variables: { user: User } }>();

// All endpoints require authentication
apiKeys.use("*", requireAuth);

/**
 * POST /api/auth/api-keys — Create a new API key
 */
apiKeys.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const parsed = createApiKeySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0].message }, 400);
  }

  // Check key limit
  const existing = (await db
    .selectFrom("api_keys")
    .select(db.fn.countAll().as("cnt"))
    .where("user_id", "=", user.id)
    .where("is_active", "=", 1)
    .executeTakeFirst()) as unknown as { cnt: number } | undefined;

  const count = Number(existing?.cnt ?? 0);
  if (count >= MAX_KEYS_PER_USER) {
    return c.json({ error: `API キーは最大${MAX_KEYS_PER_USER}個までです` }, 400);
  }

  // Generate key
  const rawKey = KEY_PREFIX + crypto.randomBytes(20).toString("hex");
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12);
  const id = crypto.randomUUID();

  await db
    .insertInto("api_keys")
    .values({
      id,
      user_id: user.id,
      name: parsed.data.name,
      key_hash: keyHash,
      key_prefix: keyPrefix,
    })
    .execute();

  return c.json(
    {
      id,
      name: parsed.data.name,
      key: rawKey,
      key_prefix: keyPrefix,
      created_at: new Date().toISOString(),
    },
    201,
  );
});

/**
 * GET /api/auth/api-keys — List current user's API keys
 */
apiKeys.get("/", async (c) => {
  const user = c.get("user");

  const keys = (await db
    .selectFrom("api_keys")
    .select(["id", "name", "key_prefix", "is_active", "last_used_at", "created_at", "updated_at"])
    .where("user_id", "=", user.id)
    .where("is_active", "=", 1)
    .orderBy("created_at", "desc")
    .execute()) as unknown as Array<Omit<ApiKey, "key_hash" | "user_id">>;

  return c.json({ keys });
});

/**
 * DELETE /api/auth/api-keys/:id — Revoke an API key
 */
apiKeys.delete("/:id", async (c) => {
  const user = c.get("user");
  const keyId = c.req.param("id");

  const existing = (await db
    .selectFrom("api_keys")
    .selectAll()
    .where("id", "=", keyId)
    .where("user_id", "=", user.id)
    .executeTakeFirst()) as unknown as ApiKey | undefined;

  if (!existing) {
    return c.json({ error: "API キーが見つかりません" }, 404);
  }

  await db
    .updateTable("api_keys")
    .set({ is_active: 0, updated_at: new Date().toISOString() })
    .where("id", "=", keyId)
    .execute();

  return c.json({ ok: true });
});

export { apiKeys as apiKeyRoutes };
