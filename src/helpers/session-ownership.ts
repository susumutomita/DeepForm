import type { Context } from "hono";
import { db } from "../db.ts";
import type { AppEnv, Campaign, Session } from "../types.ts";

/**
 * セッションのオーナーシップを検証し、セッションまたはエラーレスポンスを返す。
 * オーナーのみがアクセス可能なエンドポイントで使用する。
 */
// biome-ignore lint/suspicious/noExplicitAny: Hono の Context 型パラメータ制約
export function getOwnedSession(c: Context<AppEnv, any>): Session | Response {
  const user = c.get("user");
  if (!user) return c.json({ error: "ログインが必要です" }, 401);
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(c.req.param("id")) as unknown as
    | Session
    | undefined;
  if (!session) return c.json({ error: "セッションが見つかりません" }, 404);
  if (session.user_id !== user.id) return c.json({ error: "アクセス権限がありません" }, 403);
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
export function getOwnedCampaignById(c: Context<AppEnv, any>): Campaign | Response {
  const user = c.get("user");
  if (!user) return c.json({ error: "ログインが必要です" }, 401);
  const campaignId = c.req.param("id");
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId) as unknown as
    | Campaign
    | undefined;
  if (!campaign) return c.json({ error: "キャンペーンが見つかりません" }, 404);
  if (campaign.owner_session_id) {
    const ownerSession = db
      .prepare("SELECT user_id FROM sessions WHERE id = ?")
      .get(campaign.owner_session_id) as unknown as { user_id: string | null } | undefined;
    if (!ownerSession || ownerSession.user_id !== user.id) {
      return c.json({ error: "アクセス権限がありません" }, 403);
    }
  } else {
    return c.json({ error: "アクセス権限がありません" }, 403);
  }
  return campaign;
}
