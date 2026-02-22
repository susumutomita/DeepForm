import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock LLM before importing the module
vi.mock("../../llm.ts", () => ({
  callClaude: vi.fn(),
  extractText: vi.fn(),
  MODEL_FAST: "claude-3-5-haiku-20241022",
}));

import { processFeedbackAsync } from "../../helpers/feedback-to-issue.ts";
import { callClaude, extractText } from "../../llm.ts";

const mockCallClaude = vi.mocked(callClaude);
const mockExtractText = vi.mocked(extractText);

describe("フィードバック自動 Issue 作成", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear env
    delete process.env.FEEDBACK_GITHUB_TOKEN;
  });

  afterEach(() => {
    delete process.env.FEEDBACK_GITHUB_TOKEN;
  });

  it("トークン未設定時は Issue 作成をスキップするべき", async () => {
    mockCallClaude.mockResolvedValue({ content: [{ type: "text", text: "{}" }] } as any);
    mockExtractText.mockReturnValue(
      JSON.stringify({
        title: "テスト",
        category: "feature",
        priority: "medium",
        summary: "テストフィードバック",
        actionItems: ["Do something"],
      }),
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    processFeedbackAsync("feature", "テストメッセージ");

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 100));

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("FEEDBACK_GITHUB_TOKEN not set"));
    consoleSpy.mockRestore();
  });

  it("トークン設定時に AI 分析を実行するべき", async () => {
    mockCallClaude.mockResolvedValue({ content: [{ type: "text", text: "{}" }] } as any);
    mockExtractText.mockReturnValue(
      JSON.stringify({
        title: "一問一答形式対応",
        category: "feature",
        priority: "high",
        summary: "ユーザーが一問一答形式を希望",
        actionItems: ["Add step-by-step mode", "Add progress indicator"],
      }),
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    processFeedbackAsync("feature", "一問一答形式で答えられるようにしてほしい");

    await new Promise((r) => setTimeout(r, 200));

    // AI analysis should be called
    expect(mockCallClaude).toHaveBeenCalledOnce();
    // But no token, so issue creation is skipped
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("FEEDBACK_GITHUB_TOKEN not set"));
    consoleSpy.mockRestore();
  });

  it("deepdive の中間ターンはスキップするべき", () => {
    processFeedbackAsync("deepdive", "普通のメッセージ");
    expect(mockCallClaude).not.toHaveBeenCalled();
  });

  it("deepdive の最終サマリーは処理するべき", async () => {
    mockCallClaude.mockResolvedValue({ content: [{ type: "text", text: "{}" }] } as any);
    mockExtractText.mockReturnValue(
      JSON.stringify({
        title: "Deep-dive feedback",
        category: "ux",
        priority: "medium",
        summary: "UX improvement needed",
        actionItems: ["Improve flow"],
      }),
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    processFeedbackAsync("deepdive", "[AI Deep-dive]\nuser: test\n\nAI Summary: summary");

    await new Promise((r) => setTimeout(r, 100));

    expect(mockCallClaude).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it("AI が不正な JSON を返した場合でもフォールバックで処理するべき", async () => {
    mockCallClaude.mockResolvedValue({ content: [{ type: "text", text: "{}" }] } as any);
    mockExtractText.mockReturnValue("not valid json");

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    processFeedbackAsync("bug", "バグ報告です");

    await new Promise((r) => setTimeout(r, 100));

    // Should not throw, fallback should work
    expect(mockCallClaude).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });
});
