import { Hono } from "hono";
import { ZodError } from "zod";
import { now } from "../../db/helpers.ts";
import { db } from "../../db/index.ts";
import { formatZodError } from "../../helpers/format.ts";
import { getOwnedSession, isResponse } from "../../helpers/session-ownership.ts";
import { callClaude, callClaudeStream, extractText, MODEL_FAST } from "../../llm.ts";
import type { AppEnv } from "../../types.ts";
import { chatMessageSchema } from "../../validation.ts";

// ---------------------------------------------------------------------------
// i18n prompt helpers
// ---------------------------------------------------------------------------
type Lang = "ja" | "en" | "es" | "zh";

function resolveLang(raw?: string): Lang {
  if (raw === "en" || raw === "es" || raw === "zh") return raw;
  return "ja";
}

interface LangConfig {
  langName: string;
  otherChoice: string;
  startMsg: (theme: string) => string;
  alreadyStarted: string;
}

const LANG_LABEL: Record<Lang, LangConfig> = {
  ja: {
    langName: "日本語",
    otherChoice: "その他（自分で入力）",
    startMsg: (theme: string) => `テーマ「${theme}」についてインタビューを始めてください。`,
    alreadyStarted: "インタビューは既に開始されています。",
  },
  en: {
    langName: "English",
    otherChoice: "Other (type your own)",
    startMsg: (theme: string) => `Please start the interview about: "${theme}"`,
    alreadyStarted: "Interview has already started.",
  },
  es: {
    langName: "español",
    otherChoice: "Otro (escribir)",
    startMsg: (theme: string) => `Por favor, comienza la entrevista sobre: "${theme}"`,
    alreadyStarted: "La entrevista ya ha comenzado.",
  },
  zh: {
    langName: "中文",
    otherChoice: "其他（自己输入）",
    startMsg: (theme: string) => `请开始关于"${theme}"的访谈。`,
    alreadyStarted: "访谈已经开始。",
  },
};

function getStartMsg(lang: Lang, theme: string): string {
  return LANG_LABEL[lang].startMsg(theme);
}

function buildStartPrompt(lang: Lang, theme: string): string {
  const l = LANG_LABEL[lang];
  return `You are an expert depth interviewer. You are about to start a depth interview about the user's problem/idea.

Topic: "${theme}"

Ask exactly ONE opening question to understand the current situation.
Be empathetic and approachable. Respond in ${l.langName}.

CRITICAL FORMAT RULE — you MUST end your response with a [CHOICES] block:
[CHOICES]
Choice 1 text
Choice 2 text
Choice 3 text
${l.otherChoice}
[/CHOICES]

Never omit the [CHOICES] block. Choices should be specific to the question.
The last choice should always be "${l.otherChoice}".`;
}

function buildChatPrompt(lang: Lang, theme: string, turnCount: number): string {
  const l = LANG_LABEL[lang];
  const readyNote =
    turnCount >= 5
      ? `\nWe have gathered enough information. Ask a final summary question and add "[READY_FOR_ANALYSIS]" at the end of your reply. However, if the user still wants to share more, continue the interview.`
      : "";
  return `You are an expert depth interviewer conducting a depth interview about the user's problem/idea.

Topic: "${theme}"

Rules:
1. Ask only ONE question at a time
2. Draw out specific episodes ("Can you tell me a concrete recent example?")
3. Always ask about frequency, severity, and current workarounds
4. If the answer is vague, dig deeper ("Could you be more specific?")
5. Show empathy while probing
6. Respond in ${l.langName}
7. Your reply text MUST be under 150 characters (excluding the [CHOICES] block). Be brief.

OUTPUT FORMAT (MANDATORY — never omit):
<your short question here>

[CHOICES]
<choice 1>
<choice 2>
<choice 3>
<choice 4>
${l.otherChoice}
[/CHOICES]

The [CHOICES] block MUST appear at the very end of every response, no exceptions.
Choices should be specific and relevant to the question you just asked.
The last choice must always be "${l.otherChoice}".${readyNote}`;
}

const FALLBACK_CHOICES: Record<Lang, string[]> = {
  ja: ["はい、そうです", "いいえ、違います", "もう少し詳しく聞きたいです", "その他（自分で入力）"],
  en: ["Yes, that's right", "No, that's different", "I'd like to explain more", "Other (type your own)"],
  es: ["Sí, así es", "No, es diferente", "Me gustaría explicar más", "Otro (escribir)"],
  zh: ["是的，没错", "不是，不一样", "我想详细说明", "其他（自己输入）"],
};

export function extractChoices(text: string, lang?: Lang): { text: string; choices: string[] } {
  const match = text.match(/\[CHOICES\]([\s\S]*?)\[\/CHOICES\]/);
  if (!match) {
    // Fallback: provide default choices so the UI is never stuck
    return { text: text.trim(), choices: FALLBACK_CHOICES[lang ?? "en"] };
  }
  const choicesText = match[1].trim();
  const choices = choicesText
    .split("\n")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const cleanText = text.replace(/\[CHOICES\][\s\S]*?\[\/CHOICES\]/, "").trim();
  return { text: cleanText, choices: choices.length > 0 ? choices : FALLBACK_CHOICES[lang ?? "en"] };
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
      const lang = resolveLang((await c.req.json().catch(() => ({}))).lang);
      return c.json({ reply: LANG_LABEL[lang].alreadyStarted, alreadyStarted: true });
    }

    const body = await c.req.json().catch(() => ({}));
    const lang = resolveLang(body.lang);
    const systemPrompt = buildStartPrompt(lang, session.theme);
    const startMessages = [{ role: "user" as const, content: getStartMsg(lang, session.theme) }];

    // Streaming response
    const wantsStream = c.req.header("accept")?.includes("text/event-stream");

    if (wantsStream) {
      const { stream, getFullText } = callClaudeStream(startMessages, systemPrompt, 1024, MODEL_FAST);

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
              const { text: cleanText, choices } = extractChoices(fullText, lang);
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
    const response = await callClaude(startMessages, systemPrompt, 1024, MODEL_FAST);
    const rawReply = extractText(response);
    const { text: reply, choices } = extractChoices(rawReply, lang);

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
    const lang = resolveLang(body.lang);

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
    // Keep only recent messages to avoid context overflow (old context is in the system prompt's theme)
    const recentMessages = allMessages.slice(-10);
    const chatMessages = recentMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const turnCount = allMessages.filter((m) => m.role === "user").length;

    const systemPrompt = buildChatPrompt(lang, session.theme, turnCount);

    // Streaming response
    const wantsStream = c.req.header("accept")?.includes("text/event-stream");

    if (wantsStream) {
      const { stream, getFullText } = callClaudeStream(chatMessages, systemPrompt, 1024, MODEL_FAST);

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
              const { text: cleanText, choices } = extractChoices(fullText, lang);
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
    const response = await callClaude(chatMessages, systemPrompt, 1024, MODEL_FAST);
    const rawReply = extractText(response);
    const { text: cleanReply, choices } = extractChoices(rawReply, lang);

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
