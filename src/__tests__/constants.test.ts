import { beforeEach, describe, expect, it, vi } from "vitest";
import { ANALYSIS_TYPE, INTERVIEW_STYLE } from "../constants.ts";

describe("定数の定義", () => {
  it("INTERVIEW_STYLE が正しい値を含むべき", () => {
    expect(INTERVIEW_STYLE.DEPTH).toBe("depth");
    expect(INTERVIEW_STYLE.CLAUDE_CODE).toBe("claude_code");
  });

  it("ANALYSIS_TYPE に CLAUDE_CODE_PROMPT が含まれるべき", () => {
    expect(ANALYSIS_TYPE.CLAUDE_CODE_PROMPT).toBe("claude_code_prompt");
  });
});

describe("PRO_GATE フィーチャーフラグ", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadWithGate(gate: string) {
    vi.stubEnv("PRO_GATE", gate);
    const mod = await import("../constants.ts");
    return mod.requiresProForStep;
  }

  describe("PRO_GATE=prd（デフォルト）の場合", () => {
    it("analyze は Pro 不要であるべき", async () => {
      const fn = await loadWithGate("prd");
      expect(fn("analyze")).toBe(false);
    });

    it("hypotheses は Pro 不要であるべき", async () => {
      const fn = await loadWithGate("prd");
      expect(fn("hypotheses")).toBe(false);
    });

    it("prd は Pro 必須であるべき", async () => {
      const fn = await loadWithGate("prd");
      expect(fn("prd")).toBe(true);
    });

    it("spec は Pro 必須であるべき", async () => {
      const fn = await loadWithGate("prd");
      expect(fn("spec")).toBe(true);
    });

    it("readiness は Pro 必須であるべき", async () => {
      const fn = await loadWithGate("prd");
      expect(fn("readiness")).toBe(true);
    });
  });

  describe("PRO_GATE=none の場合", () => {
    it("すべてのステップが Pro 不要であるべき", async () => {
      const fn = await loadWithGate("none");
      expect(fn("analyze")).toBe(false);
      expect(fn("hypotheses")).toBe(false);
      expect(fn("prd")).toBe(false);
      expect(fn("spec")).toBe(false);
      expect(fn("readiness")).toBe(false);
    });
  });

  describe("PRO_GATE=spec の場合", () => {
    it("prd まで Pro 不要、spec 以降は Pro 必須であるべき", async () => {
      const fn = await loadWithGate("spec");
      expect(fn("analyze")).toBe(false);
      expect(fn("hypotheses")).toBe(false);
      expect(fn("prd")).toBe(false);
      expect(fn("spec")).toBe(true);
      expect(fn("readiness")).toBe(true);
    });
  });

  describe("PRO_GATE=analyze の場合", () => {
    it("すべてのステップが Pro 必須であるべき", async () => {
      const fn = await loadWithGate("analyze");
      expect(fn("analyze")).toBe(true);
      expect(fn("hypotheses")).toBe(true);
      expect(fn("prd")).toBe(true);
      expect(fn("spec")).toBe(true);
      expect(fn("readiness")).toBe(true);
    });
  });

  describe("不正な PRO_GATE 値の場合", () => {
    it("デフォルトの none にフォールバックすべき", async () => {
      const fn = await loadWithGate("invalid_value");
      expect(fn("hypotheses")).toBe(false);
      expect(fn("prd")).toBe(false);
    });
  });

  describe("未知のステップ名の場合", () => {
    it("Pro 不要と判定すべき", async () => {
      const fn = await loadWithGate("prd");
      expect(fn("unknown_step")).toBe(false);
    });
  });
});
