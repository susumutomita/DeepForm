// === DeepForm API Client ===
import type {
  ChatResponse, FactsData, HypothesesData, PRDData, SpecData, ReadinessData,
  Session, SessionDetail, SharedInfo, SharedStartResponse,
  CampaignInfo, CampaignJoinResponse, CampaignAnalytics,
  CampaignAIAnalysis, CampaignExport, User,
  ExportIssuesRequest, ExportIssuesResponse,
  GitHubRepo, CreateRepoAndExportRequest, CreateRepoAndExportResponse,
} from './types';

async function request<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  let data: any;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      data = await res.json();
    } catch {
      throw new Error(`HTTP ${res.status}: Invalid JSON response`);
    }
  } else {
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    throw new Error(`HTTP ${res.status}: Unexpected response format`);
  }
  if (data.error) throw new Error(data.error);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return data as T;
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function patch<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Auth
export async function checkAuthStatus(): Promise<User | null> {
  const data = await request<{ user: User | null }>('/api/auth/me');
  return data.user;
}

export function logout(): Promise<void> {
  return post('/api/auth/logout');
}

// Sessions
export function createSession(theme: string): Promise<{ sessionId: string }> {
  return post('/api/sessions', { theme });
}

export function getSessions(): Promise<Session[]> {
  return request('/api/sessions');
}

export function getSession(id: string): Promise<SessionDetail> {
  return request(`/api/sessions/${id}`);
}

export function deleteSession(id: string): Promise<void> {
  return request(`/api/sessions/${id}`, { method: 'DELETE' });
}

export function toggleVisibility(id: string, isPublic: boolean): Promise<void> {
  return patch(`/api/sessions/${id}/visibility`, { is_public: isPublic });
}

// Interview
export function startInterview(sessionId: string): Promise<{ reply: string }> {
  return post(`/api/sessions/${sessionId}/start`);
}

export function sendChat(sessionId: string, message: string): Promise<ChatResponse> {
  return post(`/api/sessions/${sessionId}/chat`, { message });
}

// Streaming versions
export interface StreamCallbacks {
  onDelta: (text: string) => void;
  onMeta?: (data: { turnCount: number }) => void;
  onDone: (data: { readyForAnalysis?: boolean; turnCount?: number }) => void;
  onError: (error: string) => void;
}

export async function startInterviewStream(sessionId: string, cb: StreamCallbacks): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/start`, {
    method: 'POST',
    headers: { 'Accept': 'text/event-stream', 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as any).error || `HTTP ${res.status}`);
  }
  await consumeSSE(res, cb);
}

export async function sendChatStream(sessionId: string, message: string, cb: StreamCallbacks): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/chat`, {
    method: 'POST',
    headers: { 'Accept': 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as any).error || `HTTP ${res.status}`);
  }
  await consumeSSE(res, cb);
}

async function consumeSSE(res: Response, cb: StreamCallbacks): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'delta') cb.onDelta(data.text);
        else if (data.type === 'meta') cb.onMeta?.(data);
        else if (data.type === 'done') cb.onDone(data);
        else if (data.type === 'error') cb.onError(data.error);
      } catch { /* skip */ }
    }
  }
}

// Analysis
export function runAnalysis(sessionId: string): Promise<FactsData> {
  return post(`/api/sessions/${sessionId}/analyze`);
}

export function runHypotheses(sessionId: string): Promise<HypothesesData> {
  return post(`/api/sessions/${sessionId}/hypotheses`);
}

export function runPRD(sessionId: string): Promise<PRDData> {
  return post(`/api/sessions/${sessionId}/prd`);
}

export function runSpec(sessionId: string): Promise<SpecData> {
  return post(`/api/sessions/${sessionId}/spec`);
}

export function runReadiness(sessionId: string): Promise<ReadinessData> {
  return post(`/api/sessions/${sessionId}/readiness`);
}

// Spec Export
export function getSpecExport(sessionId: string): Promise<{ theme: string; spec: unknown; prdMarkdown: string | null; exportedAt: string }> {
  return request(`/api/sessions/${sessionId}/spec-export`);
}

// Share
export function shareSession(sessionId: string): Promise<{ shareToken: string }> {
  return post(`/api/sessions/${sessionId}/share`);
}

export function createCampaign(sessionId: string): Promise<{ shareToken: string }> {
  return post(`/api/sessions/${sessionId}/campaign`);
}

// Shared interview
export function getShared(token: string): Promise<SharedInfo> {
  return request(`/api/shared/${token}`);
}

export function startShared(token: string, respondentName?: string): Promise<SharedStartResponse> {
  return post(`/api/shared/${token}/start`, { respondentName });
}

export function chatShared(token: string, message: string): Promise<ChatResponse> {
  return post(`/api/shared/${token}/chat`, { message });
}

export function completeShared(token: string): Promise<FactsData> {
  return post(`/api/shared/${token}/complete`);
}

export function feedbackShared(token: string, feedback: string | null): Promise<void> {
  return post(`/api/shared/${token}/feedback`, { feedback });
}

// Campaign
export function getCampaign(token: string): Promise<CampaignInfo> {
  return request(`/api/campaigns/${token}`);
}

export function joinCampaign(token: string, respondentName?: string): Promise<CampaignJoinResponse> {
  return post(`/api/campaigns/${token}/join`, { respondentName });
}

export function chatCampaign(token: string, sessionId: string, message: string): Promise<ChatResponse> {
  return post(`/api/campaigns/${token}/sessions/${sessionId}/chat`, { message });
}

export function completeCampaign(token: string, sessionId: string): Promise<FactsData> {
  return post(`/api/campaigns/${token}/sessions/${sessionId}/complete`);
}

export function feedbackCampaign(token: string, sessionId: string, feedback: string | null): Promise<void> {
  return post(`/api/campaigns/${token}/sessions/${sessionId}/feedback`, { feedback });
}

// App feedback
export function submitAppFeedback(type: string, message: string, page?: string): Promise<{ ok: boolean }> {
  return post('/api/feedback', { type, message, page });
}

// GitHub Issues export
export function exportIssues(sessionId: string, data: ExportIssuesRequest): Promise<ExportIssuesResponse> {
  return post(`/api/sessions/${sessionId}/export-issues`, data);
}

// GitHub repos
export function getGitHubRepos(): Promise<GitHubRepo[]> {
  return request('/api/github/repos');
}

// Create repo and export
export function createRepoAndExport(sessionId: string, body: CreateRepoAndExportRequest): Promise<CreateRepoAndExportResponse> {
  return post(`/api/sessions/${sessionId}/create-repo-and-export`, body);
}

// Campaign Analytics
export function getCampaignAnalytics(campaignId: string): Promise<CampaignAnalytics> {
  return request(`/api/campaigns/${campaignId}/analytics`);
}

export function generateCampaignAnalytics(campaignId: string): Promise<CampaignAIAnalysis> {
  return post(`/api/campaigns/${campaignId}/analytics/generate`);
}

export function exportCampaignAnalytics(campaignId: string): Promise<CampaignExport> {
  return request(`/api/campaigns/${campaignId}/export`);
}
