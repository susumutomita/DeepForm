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

/** Returns true if the given step requires Pro under the current PRO_GATE setting. */
export function requiresProForStep(step: string): boolean {
  const gate = getProGate();
  if (gate === "none") return false;
  const gateIndex = PRO_GATE_STEPS.indexOf(gate);
  const stepIndex = PRO_GATE_STEPS.indexOf(step as ProGateStep);
  if (stepIndex === -1) return false;
  return stepIndex >= gateIndex;
}
