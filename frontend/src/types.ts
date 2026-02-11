// === DeepForm Type Definitions ===

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl?: string | null;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface Fact {
  type: 'fact' | 'pain' | 'frequency' | 'workaround';
  content: string;
  severity: 'high' | 'medium' | 'low';
  evidence?: string;
}

export interface Hypothesis {
  id: string;
  title: string;
  description: string;
  supportingFacts?: string[];
  counterEvidence?: string;
  unverifiedPoints?: string[];
}

export interface CoreFeature {
  name: string;
  description: string;
  priority: string;
  acceptanceCriteria?: string[];
  edgeCases?: string[];
}

export interface UserFlow {
  name: string;
  steps?: string[];
}

export interface QualityItem {
  description?: string;
  criteria?: string[];
}

export interface QualityRequirements {
  functionalSuitability?: QualityItem;
  performanceEfficiency?: QualityItem;
  compatibility?: QualityItem;
  usability?: QualityItem;
  reliability?: QualityItem;
  security?: QualityItem;
  maintainability?: QualityItem;
  portability?: QualityItem;
  [key: string]: QualityItem | undefined;
}

export interface Metric {
  name: string;
  definition: string;
  target: string;
}

export interface PRD {
  problemDefinition?: string;
  targetUser?: string;
  jobsToBeDone?: string[];
  coreFeatures?: CoreFeature[];
  nonGoals?: string[];
  userFlows?: UserFlow[];
  qualityRequirements?: QualityRequirements;
  metrics?: Metric[];
  prdMarkdown?: string;
}

export interface ApiEndpoint {
  method: string;
  path: string;
  description?: string;
  request?: unknown;
  response?: unknown;
}

export interface Screen {
  name: string;
  path?: string;
  description?: string;
  components?: string[];
}

export interface TestCase {
  name: string;
  given?: string;
  when?: string;
  then?: string;
}

export interface TestCategory {
  category: string;
  cases?: TestCase[];
}

export interface Spec {
  projectName?: string;
  techStack?: unknown;
  apiEndpoints?: ApiEndpoint[];
  dbSchema?: string;
  screens?: Screen[];
  testCases?: TestCategory[];
  prdMarkdown?: string;
}

export interface ReadinessItem {
  id: string;
  description: string;
  priority: 'must' | 'should' | 'could';
  rationale?: string;
}

export interface ReadinessCategory {
  id: string;
  label: string;
  items: ReadinessItem[];
}

export interface ReadinessData {
  readiness?: {
    categories: ReadinessCategory[];
  };
  categories?: ReadinessCategory[];
  error?: string;
}

export interface Analysis {
  facts?: FactsData;
  hypotheses?: HypothesesData;
  prd?: PRD;
  spec?: Spec;
  readiness?: ReadinessData;
}

export interface Session {
  id: string;
  theme: string;
  status: SessionStatus;
  display_status?: SessionStatus;
  message_count: number;
  created_at: string;
  is_public: boolean;
  user_id?: string;
  mode?: 'shared' | 'normal';
  respondent_name?: string;
}

export interface SessionDetail {
  id: string;
  theme: string;
  status: SessionStatus;
  messages: Message[];
  analysis?: Analysis;
  respondent_feedback?: string;
  error?: string;
}

export type SessionStatus =
  | 'interviewing'
  | 'analyzed'
  | 'respondent_done'
  | 'hypothesized'
  | 'prd_generated'
  | 'spec_generated'
  | 'readiness_checked';

export interface FactsData {
  facts: Fact[];
  error?: string;
}

export interface HypothesesData {
  hypotheses: Hypothesis[];
  error?: string;
}

export interface PRDData {
  prd?: PRD;
  problemDefinition?: string;
  targetUser?: string;
  jobsToBeDone?: string[];
  coreFeatures?: CoreFeature[];
  nonGoals?: string[];
  userFlows?: UserFlow[];
  qualityRequirements?: QualityRequirements;
  metrics?: Metric[];
  error?: string;
}

export interface SpecData {
  spec?: Spec;
  projectName?: string;
  techStack?: unknown;
  apiEndpoints?: ApiEndpoint[];
  dbSchema?: string;
  screens?: Screen[];
  testCases?: TestCategory[];
  error?: string;
}

export interface ChatResponse {
  reply: string;
  readyForAnalysis?: boolean;
  turnCount?: number;
  isComplete?: boolean;
  error?: string;
}

export interface SharedInfo {
  theme: string;
  status: string;
  messageCount: number;
  error?: string;
}

export interface SharedStartResponse {
  reply?: string;
  alreadyStarted?: boolean;
  messages?: Message[];
  error?: string;
}

export interface CampaignInfo {
  theme: string;
  campaignId?: string;
  ownerSessionId?: string;
  respondentCount?: number;
  error?: string;
}

export interface CampaignAnalytics {
  totalSessions: number;
  completedSessions: number;
  commonFacts: Array<{ content: string; count: number; type: string; severity: string }>;
  painPoints: Array<{ content: string; count: number; severity: string }>;
  frequencyAnalysis: Array<{ content: string; count: number }>;
  keywordCounts: Record<string, number>;
}

export interface CampaignAIAnalysis {
  summary?: string;
  patterns?: Array<{
    id: string;
    title: string;
    description: string;
    frequency: string;
    severity: string;
  }>;
  insights?: Array<{
    id: string;
    content: string;
    supportingPatterns: string[];
  }>;
  recommendations?: string[];
}

export interface CampaignExport {
  campaign: {
    id: string;
    theme: string;
    createdAt: string;
    exportedAt: string;
  };
  analytics: CampaignAnalytics;
  aiAnalysis: CampaignAIAnalysis | null;
  respondents: Array<{
    sessionId: string;
    name: string;
    status: string;
    feedback: string | null;
    createdAt: string;
    facts: unknown;
  }>;
}

export interface CampaignJoinResponse {
  sessionId: string;
  theme: string;
  reply: string;
  error?: string;
}

export interface ExportIssuesRequest {
  repoOwner: string;
  repoName: string;
}

export interface GitHubRepo {
  full_name: string;
  name: string;
  owner: string;
}

export interface CreateRepoAndExportRequest {
  name: string;
  description?: string;
  isPrivate?: boolean;
}

export interface CreateRepoAndExportResponse {
  repo: { fullName: string; url: string };
  created: ExportedIssue[];
  errors: Array<{ feature: string; error: string }>;
}

export interface ExportedIssue {
  number: number;
  title: string;
  url: string;
}

export interface ExportIssuesResponse {
  created: ExportedIssue[];
  errors: Array<{ feature: string; error: string }>;
  error?: string;
}

/** All step names in the app (6 steps). */
export type StepName = 'interview' | 'facts' | 'hypotheses' | 'prd' | 'spec' | 'readiness';

/** Extend Window to hold globally-exposed functions. */
export interface DeepFormWindow extends Window {
  // Navigation
  showHome: () => void;
  showInterview: (sessionId: string) => void;

  // Sessions
  openSession: (sessionId: string, isNew?: boolean) => Promise<void>;
  loadSessions: () => Promise<void>;
  toggleVisibility: (sessionId: string, newState: boolean) => Promise<void>;
  shareSession: (sessionId: string) => Promise<void>;
  createCampaign: (sessionId: string) => Promise<void>;
  getCurrentSessionId: () => string | null;
  startNewSession: () => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;

  // Interview
  sendMessage: () => Promise<void>;
  handleChatKeydown: (event: KeyboardEvent) => void;
  runAnalysis: () => Promise<void>;
  runHypotheses: () => Promise<void>;
  runPRD: () => Promise<void>;
  runSpec: () => Promise<void>;
  runReadiness: () => Promise<void>;
  exportSpecJSON: () => void;
  exportPRDMarkdown: () => void;
  deployToExeDev: () => Promise<void>;
  openExportIssuesModal: () => void;

  // Shared / Campaign
  startSharedInterview: () => Promise<void>;
  sendSharedMessage: () => Promise<void>;
  completeSharedInterview: () => Promise<void>;
  submitSharedFeedback: () => Promise<void>;
  handleSharedKeydown: (event: KeyboardEvent) => void;
  startCampaignInterview: () => Promise<void>;
  sendCampaignMessage: () => Promise<void>;
  completeCampaignInterview: () => Promise<void>;
  submitCampaignFeedback: () => Promise<void>;

  // Campaign Analytics
  showCampaignAnalytics: (campaignId: string) => Promise<void>;

  // Auth
  logout: () => Promise<void>;

  // i18n
  setLang: (lang: string) => void;

  // UI
  toggleMobileMenu: () => void;
  toggleTheme: () => void;
  openPolicy: (key: string) => void;
  closeModal: () => void;
  activateStep: (stepName: string) => void;

  // Feedback
  openFeedbackModal: () => void;
  closeFeedbackModal: () => void;
}
