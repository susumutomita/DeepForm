import type { ZodError } from "zod";

/**
 * Zod バリデーションエラーをカンマ区切りの文字列にフォーマットする。
 */
export function formatZodError(error: ZodError): string {
  return error.issues.map((e) => e.message).join(", ");
}

/**
 * PRD データからマークダウンを生成する。
 */
// biome-ignore lint/suspicious/noExplicitAny: PRD は動的 JSON 構造
export function generatePRDMarkdown(prd: any, theme: string): string {
  const qrLabels: Record<string, string> = {
    functionalSuitability: "機能適合性",
    performanceEfficiency: "性能効率性",
    compatibility: "互換性",
    usability: "使用性",
    reliability: "信頼性",
    security: "セキュリティ",
    maintainability: "保守性",
    portability: "移植性",
  };
  const qrSection = prd.qualityRequirements
    ? Object.entries(qrLabels)
        .map(([key, label]) => {
          const item = prd.qualityRequirements[key];
          if (!item) return "";
          return `### ${label}\n${item.description || ""}\n${(item.criteria || []).map((c: string) => `- ${c}`).join("\n")}`;
        })
        .filter(Boolean)
        .join("\n\n")
    : "";

  return `# PRD: ${theme}

## 問題定義
${prd.problemDefinition || ""}

## 対象ユーザー
${prd.targetUser || ""}

## Jobs to be Done
${(prd.jobsToBeDone || []).map((j: string, i: number) => `${i + 1}. ${j}`).join("\n")}

## コア機能（MVP）
${(prd.coreFeatures || []).map((f: any) => `### ${f.name}\n${f.description}\n\n**優先度**: ${f.priority}\n\n**受け入れ基準**:\n${(f.acceptanceCriteria || []).map((a: string) => `- ${a}`).join("\n")}\n\n**エッジケース**:\n${(f.edgeCases || []).map((e: string) => `- ${e}`).join("\n")}`).join("\n\n")}

## Non-Goals（やらないこと）
${(prd.nonGoals || []).map((n: string) => `- ${n}`).join("\n")}

## ユーザーフロー
${(prd.userFlows || []).map((f: any) => `### ${f.name}\n${(f.steps || []).map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}`).join("\n\n")}

## 非機能要件（ISO/IEC 25010）
${qrSection}

## 計測指標
| 指標 | 定義 | 目標 |
|------|------|------|
${(prd.metrics || []).map((m: any) => `| ${m.name} | ${m.definition} | ${m.target} |`).join("\n")}

## 実装制約

この PRD を実装する際、以下のルールを必ず遵守すること。

- モックデータ、ハードコードされた配列、スタブ API での実装は完了とみなさない
- すべてのデータは実際の DB/API から取得・保存すること。「見た目が動く」だけでは受け入れ基準を満たさない
- バックエンド API が未実装の場合、UI より先にバックエンドの最小実装（仮でも本物の I/O）を作ること
- 未実装の機能は UI 上で明示的に「未実装」と表示し、モックで補完してはならない
`;
}
