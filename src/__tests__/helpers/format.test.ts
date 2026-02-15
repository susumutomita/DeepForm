import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatZodError, generatePRDMarkdown } from "../../helpers/format.ts";

describe("formatZodError", () => {
  it("単一エラーをフォーマットすべき", () => {
    const result = z.object({ name: z.string() }).safeParse({});
    if (result.success) throw new Error("should fail");
    const formatted = formatZodError(result.error);
    expect(typeof formatted).toBe("string");
    expect(formatted.length).toBeGreaterThan(0);
  });

  it("複数エラーをカンマ区切りで結合すべき", () => {
    const result = z.object({ name: z.string(), age: z.number() }).safeParse({});
    if (result.success) throw new Error("should fail");
    const formatted = formatZodError(result.error);
    // Zod generates one message per issue, formatZodError joins them
    expect(result.error.issues.length).toBe(2);
    const expected = result.error.issues.map((e) => e.message).join(", ");
    expect(formatted).toBe(expected);
  });
});

describe("generatePRDMarkdown", () => {
  const fullPrd = {
    problemDefinition: "ユーザーがタスク管理に困っている",
    targetUser: "20代のエンジニア",
    jobsToBeDone: ["タスクを素早く追加したい", "進捗を可視化したい"],
    coreFeatures: [
      {
        name: "タスク追加",
        description: "ワンクリックでタスクを追加",
        priority: "must",
        acceptanceCriteria: ["ボタン押下で追加される"],
        edgeCases: ["空文字の場合エラー表示"],
      },
    ],
    nonGoals: ["チャット機能", "カレンダー連携"],
    userFlows: [{ name: "タスク追加フロー", steps: ["ボタンを押す", "テキストを入力", "保存する"] }],
    qualityRequirements: {
      functionalSuitability: { description: "機能適合性", criteria: ["全パスが正常完了"] },
      usability: { description: "使用性", criteria: ["初回ユーザーが操作完了できる"] },
    },
    metrics: [{ name: "DAU", definition: "日次アクティブユーザー数", target: "1000" }],
  };

  it("全セクションを含むマークダウンを生成すべき", () => {
    const md = generatePRDMarkdown(fullPrd, "タスク管理アプリ");
    expect(md).toContain("# PRD: タスク管理アプリ");
    expect(md).toContain("## 問題定義");
    expect(md).toContain("ユーザーがタスク管理に困っている");
    expect(md).toContain("## 対象ユーザー");
    expect(md).toContain("20代のエンジニア");
    expect(md).toContain("## Jobs to be Done");
    expect(md).toContain("1. タスクを素早く追加したい");
    expect(md).toContain("## コア機能（MVP）");
    expect(md).toContain("### タスク追加");
    expect(md).toContain("**受け入れ基準**:");
    expect(md).toContain("- ボタン押下で追加される");
    expect(md).toContain("**エッジケース**:");
    expect(md).toContain("- 空文字の場合エラー表示");
    expect(md).toContain("## Non-Goals（やらないこと）");
    expect(md).toContain("- チャット機能");
    expect(md).toContain("## ユーザーフロー");
    expect(md).toContain("### タスク追加フロー");
    expect(md).toContain("1. ボタンを押す");
    expect(md).toContain("## 非機能要件（ISO/IEC 25010）");
    expect(md).toContain("### 機能適合性");
    expect(md).toContain("### 使用性");
    expect(md).toContain("## 計測指標");
    expect(md).toContain("| DAU | 日次アクティブユーザー数 | 1000 |");
    expect(md).toContain("## 実装制約");
  });

  it("空フィールドでもエラーなく生成すべき", () => {
    const md = generatePRDMarkdown({}, "テスト");
    expect(md).toContain("# PRD: テスト");
    expect(md).toContain("## 問題定義");
  });

  it("qualityRequirements が未定義でも生成すべき", () => {
    const md = generatePRDMarkdown({ problemDefinition: "test" }, "テスト");
    expect(md).toContain("## 非機能要件（ISO/IEC 25010）");
  });

  it("ISO/IEC 25010 の8品質特性ラベルを正しく出力すべき", () => {
    const prd = {
      qualityRequirements: {
        functionalSuitability: { description: "d1", criteria: ["c1"] },
        performanceEfficiency: { description: "d2", criteria: ["c2"] },
        compatibility: { description: "d3", criteria: ["c3"] },
        usability: { description: "d4", criteria: ["c4"] },
        reliability: { description: "d5", criteria: ["c5"] },
        security: { description: "d6", criteria: ["c6"] },
        maintainability: { description: "d7", criteria: ["c7"] },
        portability: { description: "d8", criteria: ["c8"] },
      },
    };
    const md = generatePRDMarkdown(prd, "test");
    expect(md).toContain("### 機能適合性");
    expect(md).toContain("### 性能効率性");
    expect(md).toContain("### 互換性");
    expect(md).toContain("### 使用性");
    expect(md).toContain("### 信頼性");
    expect(md).toContain("### セキュリティ");
    expect(md).toContain("### 保守性");
    expect(md).toContain("### 移植性");
  });
});
