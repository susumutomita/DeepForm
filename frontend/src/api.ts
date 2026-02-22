// === DeepForm API Client ===
import type {
  ChatResponse, FactsData, HypothesesData, PRDData, SpecData, ReadinessData,
  Session, SessionDetail,
  CampaignInfo, CampaignJoinResponse, CampaignAnalytics,
  CampaignAIAnalysis, CampaignExport, User,
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
  if (!res.ok || data.error) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    (err as any).status = res.status;
    (err as any).upgradeUrl = data.upgradeUrl;
    (err as any).upgrade = data.upgrade;
    throw err;
  }
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

// Billing
export async function getPlan(): Promise<{ plan: string; loggedIn: boolean }> {
  return request('/api/billing/plan');
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
export function createSession(theme: string, lang?: string): Promise<{ sessionId: string }> {
  return post('/api/sessions', { theme, lang });
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
  onDone: (data: { readyForAnalysis?: boolean; turnCount?: number; choices?: string[] }) => void;
  onError: (error: string) => void;
}

export async function startInterviewStream(sessionId: string, cb: StreamCallbacks, lang?: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/start`, {
    method: 'POST',
    headers: { 'Accept': 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as any).error || `HTTP ${res.status}`);
  }
  await consumeSSE(res, cb);
}

export async function sendChatStream(sessionId: string, message: string, cb: StreamCallbacks, lang?: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/chat`, {
    method: 'POST',
    headers: { 'Accept': 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, lang }),
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
        if (data.type === 'delta') cb.onDelta(typeof data.text === 'string' ? data.text : String(data.text ?? ''));
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

// Pipeline (one-shot: facts → hypotheses → design)
export interface PipelineCallbacks {
  onStageRunning: (stage: string) => void;
  onStageStream?: (stage: string, text: string) => void;
  onStageData: (stage: string, data: any) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

export async function runPipeline(sessionId: string, cb: PipelineCallbacks): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/pipeline`, {
    method: 'POST',
    headers: { 'Accept': 'text/event-stream', 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = data as any;
    if (err.upgrade) {
      const e = new Error(err.error || `HTTP ${res.status}`);
      (e as any).status = res.status;
      (e as any).upgrade = true;
      (e as any).upgradeUrl = err.upgradeUrl;
      throw e;
    }
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          if (currentEvent === 'stream' && data.stage && data.text) {
            cb.onStageStream?.(data.stage, data.text);
          } else if (currentEvent === 'stage' || (!currentEvent && data.stage)) {
            if (data.status === 'running') cb.onStageRunning(data.stage);
            else if (data.status === 'done') cb.onStageData(data.stage, data.data);
          } else if (currentEvent === 'error' || data.error) {
            cb.onError(data.error || 'Unknown error');
          } else if (currentEvent === 'done') {
            cb.onDone();
          }
        } catch { /* skip */ }
        currentEvent = '';
      }
    }
  }
}

// GitHub Save
export function saveToGitHub(sessionId: string): Promise<{ repoUrl: string; commitSha: string; filesCommitted: string[]; isNewRepo: boolean }> {
  return post(`/api/sessions/${sessionId}/github-save`);
}

// Spec Export
export function getSpecExport(sessionId: string): Promise<{ theme: string; spec: unknown; prdMarkdown: string | null; exportedAt: string }> {
  return request(`/api/sessions/${sessionId}/spec-export`);
}

// Campaign
export function createCampaign(sessionId: string): Promise<{ shareToken: string }> {
  return post(`/api/sessions/${sessionId}/campaign`);
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

// Campaign Triage
export interface TriageFact {
  factId: string;
  type: string;
  content: string;
  severity: string;
  evidence: string;
  respondentName: string;
  respondentSessionId: string;
  selected: boolean;
}

export interface TriageState {
  facts: TriageFact[];
  selectedFactIds: string[];
}

export function getTriagedFacts(sessionId: string): Promise<TriageState> {
  return request(`/api/sessions/${sessionId}/campaign-triage`);
}

export function saveTriagedFacts(sessionId: string, selectedFactIds: string[]): Promise<{ ok: boolean }> {
  return post(`/api/sessions/${sessionId}/campaign-triage`, { selectedFactIds });
}

// App feedback
export function submitAppFeedback(type: string, message: string, page?: string): Promise<{ ok: boolean }> {
  return post('/api/feedback', { type, message, page });
}

export function feedbackDeepdive(message: string, history?: Array<{ role: string; content: string }>): Promise<{ reply: string; done: boolean }> {
  return post('/api/feedback/deepdive', { message, history });
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
