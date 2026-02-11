// === DeepForm API Client ===
import type {
  ChatResponse, FactsData, HypothesesData, PRDData, SpecData,
  Session, SessionDetail, SharedInfo, SharedStartResponse,
  CampaignInfo, CampaignJoinResponse, User,
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
