export interface Session {
  id: string;
  theme: string;
  status:
    | "interviewing"
    | "analyzed"
    | "respondent_done"
    | "hypothesized"
    | "prd_generated"
    | "spec_generated"
    | "readiness_checked";
  mode: "self" | "shared" | "campaign_respondent";
  share_token: string | null;
  respondent_name: string | null;
  respondent_feedback: string | null;
  created_at: string;
  updated_at: string;
  campaign_id: string | null;
  user_id?: string | null;
  is_public?: number;
}

export interface Message {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface AnalysisResult {
  id: number;
  session_id: string;
  type: "facts" | "hypotheses" | "prd" | "spec" | "campaign_analytics" | "readiness";
  data: string;
  created_at: string;
}

export interface CampaignAnalytics {
  totalSessions: number;
  completedSessions: number;
  commonFacts: Array<{ content: string; count: number; type: string; severity: string }>;
  painPoints: Array<{ content: string; count: number; severity: string }>;
  frequencyAnalysis: Array<{ content: string; count: number }>;
  keywordCounts: Record<string, number>;
}

export interface Campaign {
  id: string;
  theme: string;
  owner_session_id: string | null;
  share_token: string;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  exe_user_id: string;
  email: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Fact {
  id: string;
  type: "fact" | "pain" | "frequency" | "workaround";
  content: string;
  evidence: string;
  severity: "high" | "medium" | "low";
}

export interface Hypothesis {
  id: string;
  title: string;
  description: string;
  supportingFacts: string[];
  counterEvidence: string;
  unverifiedPoints: string[];
}
