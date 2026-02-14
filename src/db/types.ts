import type { Generated } from "kysely";

// ---------------------------------------------------------------------------
// Table interfaces — mirror the existing SQLite schema exactly
// ---------------------------------------------------------------------------

export interface SessionTable {
  id: string;
  theme: string;
  status: Generated<string>; // DEFAULT 'interviewing'
  mode: Generated<string>; // DEFAULT 'self'
  share_token: string | null;
  respondent_name: string | null;
  respondent_feedback: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  campaign_id: string | null;
  user_id: string | null;
  is_public: Generated<number>; // 0/1 for SQLite compat
  interview_style: Generated<string>; // DEFAULT 'depth'
  deploy_token: string | null;
}

export interface MessageTable {
  id: Generated<number>;
  session_id: string;
  role: string;
  content: string;
  created_at: Generated<string>;
}

export interface AnalysisResultTable {
  id: Generated<number>;
  session_id: string;
  type: string;
  data: string;
  created_at: Generated<string>;
}

export interface CampaignTable {
  id: string;
  theme: string;
  owner_session_id: string | null;
  share_token: string;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface UserTable {
  id: string;
  exe_user_id: string;
  email: string;
  display_name: string | null;
  github_id: number | null;
  github_token: string | null;
  avatar_url: string | null;
  plan: Generated<string>; // DEFAULT 'free'
  stripe_customer_id: string | null;
  plan_updated_at: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface AuthSessionTable {
  id: string;
  user_id: string;
  created_at: Generated<string>;
  expires_at: string;
}

export interface FeedbackTable {
  id: Generated<number>;
  user_id: string | null;
  type: string;
  message: string;
  page: string | null;
  ip_address: string | null;
  created_at: Generated<string>;
}

export interface PageViewTable {
  id: Generated<number>;
  path: string;
  method: Generated<string>; // DEFAULT 'GET'
  status_code: number | null;
  referer: string | null;
  user_agent: string | null;
  ip_address: string | null;
  country: string | null;
  user_id: string | null;
  session_fingerprint: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  created_at: Generated<string>;
}

// ---------------------------------------------------------------------------
// Database — union of all tables
// ---------------------------------------------------------------------------

export interface Database {
  sessions: SessionTable;
  messages: MessageTable;
  analysis_results: AnalysisResultTable;
  campaigns: CampaignTable;
  users: UserTable;
  auth_sessions: AuthSessionTable;
  feedback: FeedbackTable;
  page_views: PageViewTable;
}
