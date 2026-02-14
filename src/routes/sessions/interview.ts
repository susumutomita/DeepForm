import { Hono } from "hono";
import { ZodError } from "zod";
import { now } from "../../db/helpers.ts";
import { db } from "../../db/index.ts";
import { formatZodError } from "../../helpers/format.ts";
import { getOwnedSession, isResponse } from "../../helpers/session-ownership.ts";
import { callClaude, callClaudeStream, extractText } from "../../llm.ts";
import type { AppEnv } from "../../types.ts";
import { chatMessageSchema } from "../../validation.ts";

function extractChoices(text: string): { text: string; choices: string[] } {
  const match = text.match(/\[CHOICES\]([\s\S]*?)\[\/CHOICES\]/);
  if (!match) return { text: text.trim(), choices: [] };
  const choicesText = match[1].trim();
  const choices = choicesText
    .split("\n")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const cleanText = text.replace(/\[CHOICES\][\s\S]*?\[\/CHOICES\]/, "").trim();
  return { text: cleanText, choices };
}

export const interviewRoutes = new Hono<AppEnv>();

// 5. POST /sessions/:id/start — Get first interview question from LLM (owner only)
interviewRoutes.post("/sessions/:id/start", async (c) => {
  try {
    const result = await getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;
    const id = session.id;

    const existingMessages = await db
      .selectFrom("messages")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("session_id", "=", id)
      .executeTakeFirstOrThrow();
    if (Number(existingMessages.count) > 0) {
      return c.json({ reply: "インタビューは既に開始されています。", alreadyStarted: true });
    }

    const systemPrompt = `あなたは熟練のデプスインタビュアーです。これからユーザーの課題テーマについて深掘りインタビューを開始します。

テーマ: 「${session.theme}」

最初の質問を1つだけ聞いてください。テーマについて、まず現状の状況を理解するための質問をしてください。
共感的で親しみやすいトーンで、日本語で話してください。

重要: 質問の後に、ユーザーが選べる回答の選択肢を3〜5個提示してください。
選択肢は以下の形式で質問文の最後に付けてください:
[CHOICES]
選択肢1のテキスト
選択肢2のテキスト
選択肢3のテキスト
[/CHOICES]

選択肢は具体的で、異なる状況や回答パターンをカバーするようにしてください。
最後の選択肢は「その他（自分で入力）」にしてください。`;

    const startMessages = [
      { role: "user" as const, content: `テーマ「${session.theme}」についてインタビューを始めてください。` },
    ];

    // Streaming response
    const wantsStream = c.req.header("accept")?.includes("text/event-stream");

    if (wantsStream) {
      const { stream, getFullText } = callClaudeStream(startMessages, systemPrompt, 512);

      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            stream.on("data", (chunk: Buffer | string) => {
              const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "delta", text })}\n\n`));
            });
            stream.on("end", () => {
              const fullText = getFullText();
              const { text: cleanText, choices } = extractChoices(fullText);
              db.insertInto("messages")
                .values({ session_id: id, role: "assistant", content: cleanText })
                .execute()
                .catch((err) => console.error("Failed to save message:", err));
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done", choices })}\n\n`));
              controller.close();
            });
            stream.on("error", (err: Error) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`));
              controller.close();
            });
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        },
      );
    }

    // Non-streaming fallback
    const response = await callClaude(startMessages, systemPrompt, 512);
    const rawReply = extractText(response);
    const { text: reply, choices } = extractChoices(rawReply);

    await db.insertInto("messages").values({ session_id: id, role: "assistant", content: reply }).execute();

    return c.json({ reply, choices });
  } catch (e) {
    console.error("Start interview error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 6. POST /sessions/:id/chat — Send message, get AI reply (owner only)
interviewRoutes.post("/sessions/:id/chat", async (c) => {
  try {
    const result = await getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;
    const id = session.id;
    const body = await c.req.json();
    const { message } = chatMessageSchema.parse(body);

    // Save user message
    await db.insertInto("messages").values({ session_id: id, role: "user", content: message }).execute();
    await db.updateTable("sessions").set({ updated_at: now() }).where("id", "=", id).execute();

    // Build conversation history
    const allMessages = await db
      .selectFrom("messages")
      .select(["role", "content"])
      .where("session_id", "=", id)
      .orderBy("created_at")
      .execute();
    const chatMessages = allMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const turnCount = allMessages.filter((m) => m.role === "user").length;

    const systemPrompt = `あなたは熟練のデプスインタビュアーです。ユーザーの課題テーマについて深掘りインタビューを行います。

テーマ: 「${session.theme}」

ルール：
1. 一度に1つの質問だけ聞く
2. 具体的なエピソードを引き出す（「最近あった具体例を教えてください」）
3. 頻度・困り度・現在の回避策を必ず聞く
4. 抽象的な回答には「具体的には？」で掘り下げる
5. 共感を示しながら深掘りする
6. 日本語で回答する
7. 回答は簡潔に、200文字以内で

重要: 質問の後に、ユーザーが選べる回答の選択肢を3〜5個提示してください。
選択肢は以下の形式で質問文の最後に付けてください:
[CHOICES]
選択肢1のテキスト
選択肢2のテキスト
選択肢3のテキスト
[/CHOICES]

選択肢は具体的で、異なる状況や回答パターンをカバーするようにしてください。
最後の選択肢は「その他（自分で入力）」にしてください。

${turnCount >= 5 ? "十分な情報が集まりました。最後にまとめの質問をして、回答の最後に「[READY_FOR_ANALYSIS]」タグを付けてください。ただし、ユーザーがまだ話したそうなら続けてください。" : ""}`;

    // Streaming response
    const wantsStream = c.req.header("accept")?.includes("text/event-stream");

    if (wantsStream) {
      const { stream, getFullText } = callClaudeStream(chatMessages, systemPrompt, 1024);

      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            // Send turnCount metadata first
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "meta", turnCount })}\n\n`));

            stream.on("data", (chunk: Buffer | string) => {
              const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "delta", text })}\n\n`));
            });
            stream.on("end", () => {
              const fullText = getFullText();
              const { text: cleanText, choices } = extractChoices(fullText);
              db.insertInto("messages")
                .values({ session_id: id, role: "assistant", content: cleanText })
                .execute()
                .catch((err) => console.error("Failed to save message:", err));
              const readyForAnalysis = cleanText.includes("[READY_FOR_ANALYSIS]") || turnCount >= 8;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "done", readyForAnalysis, turnCount, choices })}\n\n`),
              );
              controller.close();
            });
            stream.on("error", (err: Error) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`));
              controller.close();
            });
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        },
      );
    }

    // Non-streaming fallback
    const response = await callClaude(chatMessages, systemPrompt, 1024);
    const rawReply = extractText(response);
    const { text: cleanReply, choices } = extractChoices(rawReply);

    await db
      .insertInto("messages")
      .values({
        session_id: id,
        role: "assistant",
        content: cleanReply.replace("[READY_FOR_ANALYSIS]", "").trim(),
      })
      .execute();

    const readyForAnalysis = rawReply.includes("[READY_FOR_ANALYSIS]") || turnCount >= 8;

    return c.json({
      reply: cleanReply.replace("[READY_FOR_ANALYSIS]", "").trim(),
      turnCount,
      readyForAnalysis,
      choices,
    });
  } catch (e) {
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Chat error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});
