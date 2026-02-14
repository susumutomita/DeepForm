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
// Values: "prd" (default), "spec", "readiness", "none" (all free)
// Steps order: analyze → hypotheses → prd → spec → readiness
const PRO_GATE_STEPS = ["analyze", "hypotheses", "prd", "spec", "readiness", "none"] as const;
export type ProGateStep = (typeof PRO_GATE_STEPS)[number];

function parseProGate(): ProGateStep {
  const raw = (process.env.PRO_GATE || "prd").toLowerCase();
  if (PRO_GATE_STEPS.includes(raw as ProGateStep)) return raw as ProGateStep;
  console.warn(`Invalid PRO_GATE value "${raw}", falling back to "prd"`);
  return "prd";
}

export const PRO_GATE: ProGateStep = parseProGate();

/** Returns true if the given step requires Pro under the current PRO_GATE setting. */
export function requiresProForStep(step: string): boolean {
  if (PRO_GATE === "none") return false;
  const gateIndex = PRO_GATE_STEPS.indexOf(PRO_GATE);
  const stepIndex = PRO_GATE_STEPS.indexOf(step as ProGateStep);
  if (stepIndex === -1) return false;
  return stepIndex >= gateIndex;
}
