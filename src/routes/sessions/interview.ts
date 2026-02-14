import { Hono } from "hono";
import { ZodError } from "zod";
import { db } from "../../db.ts";
import { formatZodError } from "../../helpers/format.ts";
import { getOwnedSession, isResponse } from "../../helpers/session-ownership.ts";
import { callClaude, callClaudeStream, extractText } from "../../llm.ts";
import type { AppEnv } from "../../types.ts";
import { chatMessageSchema } from "../../validation.ts";

export const interviewRoutes = new Hono<AppEnv>();

// 5. POST /sessions/:id/start — Get first interview question from LLM (owner only)
interviewRoutes.post("/sessions/:id/start", async (c) => {
  try {
    const result = getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;
    const id = session.id;

    const existingMessages = db
      .prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?")
      .get(id) as unknown as {
      count: number;
    };
    if (existingMessages.count > 0) {
      return c.json({ reply: "インタビューは既に開始されています。", alreadyStarted: true });
    }

    const systemPrompt = `あなたは熟練のデプスインタビュアーです。これからユーザーの課題テーマについて深掘りインタビューを開始します。

テーマ: 「${session.theme}」

最初の質問を1つだけ聞いてください。テーマについて、まず現状の状況を理解するための質問をしてください。
共感的で親しみやすいトーンで、日本語で話してください。200文字以内で。`;

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
              db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
                id,
                "assistant",
                fullText,
              );
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
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
    const reply = extractText(response);

    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(id, "assistant", reply);

    return c.json({ reply });
  } catch (e) {
    console.error("Start interview error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// 6. POST /sessions/:id/chat — Send message, get AI reply (owner only)
interviewRoutes.post("/sessions/:id/chat", async (c) => {
  try {
    const result = getOwnedSession(c);
    if (isResponse(result)) return result;
    const session = result;
    const id = session.id;
    const body = await c.req.json();
    const { message } = chatMessageSchema.parse(body);

    // Save user message
    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(id, "user", message);
    db.prepare("UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);

    // Build conversation history
    const allMessages = db
      .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at")
      .all(id) as unknown as { role: string; content: string }[];
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
              // Save to DB
              db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
                id,
                "assistant",
                fullText,
              );
              const readyForAnalysis = fullText.includes("[READY_FOR_ANALYSIS]") || turnCount >= 8;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "done", readyForAnalysis, turnCount })}\n\n`),
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
    const reply = extractText(response);

    // Save assistant message
    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(id, "assistant", reply);

    const readyForAnalysis = reply.includes("[READY_FOR_ANALYSIS]") || turnCount >= 8;
    const cleanReply = reply.replace("[READY_FOR_ANALYSIS]", "").trim();

    return c.json({ reply: cleanReply, turnCount, readyForAnalysis });
  } catch (e) {
    if (e instanceof ZodError) return c.json({ error: formatZodError(e) }, 400);
    console.error("Chat error:", e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});
