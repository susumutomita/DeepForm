/**
 * Feedback → GitHub Issue 自動作成
 *
 * フィードバック受信時に AI で分析・分類し、GitHub Issue を自動作成する。
 * 非同期で実行し、フィードバック送信のレスポンスをブロックしない。
 */
import { callClaude, extractText, MODEL_FAST } from "../llm.ts";

const REPO = process.env.FEEDBACK_GITHUB_REPO ?? "susumutomita/DeepForm";
const GITHUB_TOKEN = process.env.FEEDBACK_GITHUB_TOKEN ?? "";

interface FeedbackAnalysis {
  title: string;
  category: "bug" | "feature" | "ux" | "performance" | "other";
  priority: "high" | "medium" | "low";
  summary: string;
  actionItems: string[];
}

const LABEL_MAP: Record<string, string[]> = {
  bug: ["bug", "feedback"],
  feature: ["enhancement", "feedback"],
  ux: ["ux", "feedback"],
  performance: ["performance", "feedback"],
  other: ["feedback"],
};

const PRIORITY_LABEL: Record<string, string> = {
  high: "priority: high",
  medium: "priority: medium",
  low: "priority: low",
};

/**
 * AI でフィードバックを分析し、構造化データに変換する
 */
async function analyzeFeedback(type: string, message: string): Promise<FeedbackAnalysis> {
  const systemPrompt = `You are a product feedback analyzer for DeepForm (AI depth interview tool).
Analyze the user feedback and return a JSON object with:
- title: concise issue title (in the same language as the feedback)
- category: one of "bug", "feature", "ux", "performance", "other"
- priority: one of "high", "medium", "low"
- summary: 2-3 sentence summary of the core issue/request
- actionItems: array of specific, actionable improvement steps (in English for developer readability)

Respond ONLY with valid JSON, no markdown fences.`;

  const messages = [
    {
      role: "user" as const,
      content: `Feedback type: ${type}\n\nMessage:\n${message}`,
    },
  ];

  const response = await callClaude(messages, systemPrompt, 1024, MODEL_FAST);
  const text = extractText(response);

  try {
    return JSON.parse(text) as FeedbackAnalysis;
  } catch {
    // Fallback if AI doesn't return valid JSON
    return {
      title: message.slice(0, 80),
      category: type === "bug" ? "bug" : type === "feature" ? "feature" : "other",
      priority: "medium",
      summary: message,
      actionItems: ["Review and triage this feedback"],
    };
  }
}

/**
 * GitHub Issue を作成する
 */
async function createGitHubIssue(
  analysis: FeedbackAnalysis,
  originalMessage: string,
  feedbackType: string,
): Promise<string | null> {
  if (!GITHUB_TOKEN) {
    console.log("[feedback-to-issue] FEEDBACK_GITHUB_TOKEN not set, skipping issue creation");
    return null;
  }

  const labels = [
    ...(LABEL_MAP[analysis.category] ?? ["feedback"]),
    PRIORITY_LABEL[analysis.priority] ?? "priority: medium",
  ];

  const body = `## 📬 User Feedback (auto-generated)

**Type:** ${feedbackType}
**Category:** ${analysis.category}
**Priority:** ${analysis.priority}

### Summary
${analysis.summary}

### Original Message
> ${originalMessage.replace(/\n/g, "\n> ")}

### Action Items
${analysis.actionItems.map((item) => `- [ ] ${item}`).join("\n")}

---
*This issue was automatically created from user feedback by DeepForm’s feedback pipeline.*`;

  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      title: `[Feedback] ${analysis.title}`,
      body,
      labels,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[feedback-to-issue] GitHub API error ${res.status}: ${errText}`);
    return null;
  }

  const data = (await res.json()) as { html_url: string };
  console.log(`[feedback-to-issue] Issue created: ${data.html_url}`);
  return data.html_url;
}

/**
 * フィードバックを非同期で処理し、GitHub Issue を作成する
 * 呼び出し元をブロックしないよう fire-and-forget で実行する
 */
export function processFeedbackAsync(type: string, message: string): void {
  // Skip deepdive intermediate turns, only process final summaries and direct feedback
  if (type === "deepdive" && !message.includes("[AI Deep-dive]")) return;

  (async () => {
    try {
      const analysis = await analyzeFeedback(type, message);
      await createGitHubIssue(analysis, message, type);
    } catch (e) {
      console.error("[feedback-to-issue] Error:", e);
    }
  })();
}
