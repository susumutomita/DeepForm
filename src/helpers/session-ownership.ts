import type { Context } from "hono";
import { db } from "../db/index.ts";
import type { AppEnv, Campaign, Session } from "../types.ts";

/**
 * セッションのオーナーシップを検証し、セッションまたはエラーレスポンスを返す。
 * オーナーのみがアクセス可能なエンドポイントで使用する。
 */
// biome-ignore lint/suspicious/noExplicitAny: Hono の Context 型パラメータ制約
export async function getOwnedSession(c: Context<AppEnv, any>): Promise<Session | Response> {
  const user = c.get("user");
  const session = (await db
    .selectFrom("sessions")
    .selectAll()
    .where("id", "=", c.req.param("id"))
    .executeTakeFirst()) as unknown as Session | undefined;
  if (!session) return c.json({ error: "セッションが見つかりません" }, 404);
  // Allow access if: owner, guest session (no user_id), or public session
  if (session.user_id && (!user || session.user_id !== user.id) && !session.is_public) {
    return c.json({ error: "アクセス権限がありません" }, 403);
  }
  return session;
}

/**
 * Response 型ガード。getOwnedSession の戻り値を判別するために使用する。
 */
export function isResponse(result: Session | Response): result is Response {
  return result instanceof Response;
}

/**
 * キャンペーン ID によるオーナーシップ検証。
 * owner_session_id 経由でセッションオーナーを確認する。
 */
// biome-ignore lint/suspicious/noExplicitAny: Hono の Context 型パラメータ制約
export async function getOwnedCampaignById(c: Context<AppEnv, any>): Promise<Campaign | Response> {
  const user = c.get("user");
  if (!user) return c.json({ error: "ログインが必要です" }, 401);
  const campaignId = c.req.param("id");
  const campaign = (await db
    .selectFrom("campaigns")
    .selectAll()
    .where("id", "=", campaignId)
    .executeTakeFirst()) as unknown as Campaign | undefined;
  if (!campaign) return c.json({ error: "キャンペーンが見つかりません" }, 404);
  if (campaign.owner_session_id) {
    const ownerSession = await db
      .selectFrom("sessions")
      .select("user_id")
      .where("id", "=", campaign.owner_session_id)
      .executeTakeFirst();
    if (!ownerSession || ownerSession.user_id !== user.id) {
      return c.json({ error: "アクセス権限がありません" }, 403);
    }
  } else {
    return c.json({ error: "アクセス権限がありません" }, 403);
  }
  return campaign;
}
