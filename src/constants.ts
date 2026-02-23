// ---------------------------------------------------------------------------
// Session status values
// ---------------------------------------------------------------------------
export const SESSION_STATUS = {
  INTERVIEWING: "interviewing",
  ANALYZED: "analyzed",
  RESPONDENT_DONE: "respondent_done",
  HYPOTHESIZED: "hypothesized",
  PRD_GENERATED: "prd_generated",
  SPEC_GENERATED: "spec_generated",
  READINESS_CHECKED: "readiness_checked",
} as const;

// ---------------------------------------------------------------------------
// Analysis result types
// ---------------------------------------------------------------------------
export const ANALYSIS_TYPE = {
  FACTS: "facts",
  HYPOTHESES: "hypotheses",
  PRD: "prd",
  SPEC: "spec",
  READINESS: "readiness",
  CAMPAIGN_ANALYTICS: "campaign_analytics",
  CAMPAIGN_TRIAGE: "campaign_triage",
} as const;

// ---------------------------------------------------------------------------
// Admin configuration
// ---------------------------------------------------------------------------
const DEFAULT_ADMIN_EMAILS = "oyster880@gmail.com";
export const ADMIN_EMAILS: string[] = (process.env.ADMIN_EMAILS || DEFAULT_ADMIN_EMAILS)
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Pro gate feature flag
// ---------------------------------------------------------------------------
// Controls which pipeline step first requires Pro.
// Values: "none" (default, all free), "prd", "spec", "readiness"
// Steps order: analyze → hypotheses → prd → spec → readiness
const PRO_GATE_STEPS = ["analyze", "hypotheses", "prd", "spec", "readiness", "none"] as const;
export type ProGateStep = (typeof PRO_GATE_STEPS)[number];

function getProGate(): ProGateStep {
  const raw = (process.env.PRO_GATE || "none").toLowerCase();
  if (PRO_GATE_STEPS.includes(raw as ProGateStep)) return raw as ProGateStep;
  return "none";
}

// ---------------------------------------------------------------------------
// Readiness system prompt (shared between analysis.ts and pipeline.ts)
// ---------------------------------------------------------------------------
export const READINESS_SYSTEM = `You are a production quality review expert. Generate a pre-launch readiness checklist based on ISO/IEC 25010 quality characteristics from the PRD and implementation spec.

IMPORTANT: Respond in the SAME LANGUAGE as the input data.

必ず以下のJSON形式で返してください。JSON以外のテキストは含めないでください。

{
  "readiness": {
    "categories": [
      {
        "id": "functionalSuitability",
        "label": "機能適合性",
        "items": [
          {
            "id": "FS-1",
            "description": "チェック項目の説明",
            "priority": "must",
            "rationale": "なぜこのチェックが必要か"
          }
        ]
      }
    ]
  }
}

ルール：
- ISO/IEC 25010 の8品質特性すべてを網羅すること:
  1. functionalSuitability（機能適合性）
  2. performanceEfficiency（性能効率性）
  3. compatibility（互換性）
  4. usability（使用性）
  5. reliability（信頼性）
  6. security（セキュリティ）
  7. maintainability（保守性）
  8. portability（移植性）
- 各カテゴリに2〜4個の具体的なチェック項目を生成
- priority は "must"（必須）, "should"（推奨）, "could"（任意）のいずれか
- PRDの非機能要件と実装仕様に基づいた具体的な項目にすること
- 抽象的な表現は避け、テスト可能な条件を記述すること`;

/** Returns true if the given step requires Pro under the current PRO_GATE setting. */
export function requiresProForStep(step: string): boolean {
  const gate = getProGate();
  if (gate === "none") return false;
  const gateIndex = PRO_GATE_STEPS.indexOf(gate);
  const stepIndex = PRO_GATE_STEPS.indexOf(step as ProGateStep);
  if (stepIndex === -1) return false;
  return stepIndex >= gateIndex;
}
