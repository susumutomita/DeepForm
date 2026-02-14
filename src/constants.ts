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
