// === DeepForm Shared Interview & Campaign ===
import * as api from './api';
import { t } from './i18n';
import { showLoading, hideLoading, showToast, escapeHtml, factTypeLabel, addMessageToContainer, showTypingIndicator, removeTypingIndicator } from './ui';
import type { Fact } from './types';

let sharedToken: string | null = null;
let sharedTurnCount = 0;
let campaignToken: string | null = null;
let campaignSessionId: string | null = null;

export function getCampaignToken(): string | null { return campaignToken; }

function showSharedScreen(screenId: string): void {
  document.querySelectorAll('.shared-screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId)?.classList.add('active');
}

function updateSharedProgress(): void {
  const pct = Math.min(100, Math.max(10, (sharedTurnCount / 6) * 100));
  const bar = document.getElementById('shared-progress-bar');
  if (bar) bar.style.width = pct + '%';
}

function renderSharedFacts(facts: Fact[]): void {
  const container = document.getElementById('shared-facts-container');
  if (!container) return;
  container.innerHTML = facts.map(f => `
    <div class="fact-card">
      <div class="fact-card-header">
        <span class="fact-type type-${f.type}">${factTypeLabel(f.type)}</span>
        <span class="severity severity-${f.severity}">${f.severity}</span>
      </div>
      <div class="fact-content">${escapeHtml(f.content)}</div>
      ${f.evidence ? `<div class="fact-evidence">「${escapeHtml(f.evidence)}」</div>` : ''}
    </div>
  `).join('');
}

// --- Shared Interview ---
export async function initSharedInterview(token: string): Promise<void> {
  sharedToken = token;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-shared')?.classList.add('active');
  document.querySelector('.header-nav')?.setAttribute('style', 'display:none');

  try {
    const data = await api.getShared(token);
    if (data.error) { showToast(t('toast.notFound'), true); return; }
    const titleEl = document.getElementById('shared-theme-title');
    if (titleEl) titleEl.textContent = data.theme;
    const chatTheme = document.getElementById('shared-chat-theme');
    if (chatTheme) chatTheme.textContent = data.theme;

    if (data.status === 'respondent_done') { showSharedScreen('shared-thanks'); return; }
    if (data.messageCount > 0) { await resumeSharedChat(token); return; }
    showSharedScreen('shared-welcome');
  } catch (e: any) { showToast(e.message, true); }
}

async function resumeSharedChat(token: string): Promise<void> {
  const data = await api.startShared(token);
  if (data.alreadyStarted && data.messages) {
    showSharedScreen('shared-chat');
    const container = document.getElementById('shared-chat-container');
    if (container) container.innerHTML = '';
    data.messages.forEach(m => addMessageToContainer('shared-chat-container', m.role, m.content));
    sharedTurnCount = data.messages.filter(m => m.role === 'user').length;
    updateSharedProgress();
    if (sharedTurnCount >= 5) {
      const actions = document.getElementById('shared-complete-actions');
      if (actions) actions.style.display = 'flex';
    }
  }
}

export async function startSharedInterview(): Promise<void> {
  if (!sharedToken) return;
  const nameInput = document.getElementById('shared-name') as HTMLInputElement | null;
  const name = nameInput?.value.trim();
  showSharedScreen('shared-chat');
  showTypingIndicator('shared-chat-container');
  try {
    const data = await api.startShared(sharedToken, name);
    removeTypingIndicator('shared-chat-container');
    if (data.alreadyStarted && data.messages) {
      const container = document.getElementById('shared-chat-container');
      if (container) container.innerHTML = '';
      data.messages.forEach(m => addMessageToContainer('shared-chat-container', m.role, m.content));
      sharedTurnCount = data.messages.filter(m => m.role === 'user').length;
    } else if (data.reply) {
      addMessageToContainer('shared-chat-container', 'assistant', data.reply);
    }
    updateSharedProgress();
  } catch (e: any) {
    removeTypingIndicator('shared-chat-container');
    showToast(e.message, true);
  }
}

export async function sendSharedMessage(): Promise<void> {
  if (!sharedToken) return;
  const input = document.getElementById('shared-chat-input') as HTMLTextAreaElement | null;
  if (!input) return;
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  addMessageToContainer('shared-chat-container', 'user', message);
  sharedTurnCount++;
  updateSharedProgress();

  const btnSend = document.getElementById('btn-shared-send') as HTMLButtonElement | null;
  if (btnSend) btnSend.disabled = true;
  showTypingIndicator('shared-chat-container');
  try {
    const data = await api.chatShared(sharedToken, message);
    removeTypingIndicator('shared-chat-container');
    addMessageToContainer('shared-chat-container', 'assistant', data.reply);
    if (data.isComplete || sharedTurnCount >= 5) {
      const actions = document.getElementById('shared-complete-actions');
      if (actions) actions.style.display = 'flex';
    }
  } catch (e: any) {
    removeTypingIndicator('shared-chat-container');
    showToast(e.message, true);
  } finally {
    if (btnSend) btnSend.disabled = false;
    input.focus();
  }
}

export async function completeSharedInterview(): Promise<void> {
  if (!sharedToken) return;
  showLoading(t('loading.facts'));
  try {
    const data = await api.completeShared(sharedToken);
    renderSharedFacts(data.facts || []);
    showSharedScreen('shared-facts');
  } catch (e: any) { showToast(e.message, true); }
  finally { hideLoading(); }
}

export async function submitSharedFeedback(): Promise<void> {
  if (!sharedToken) return;
  const textarea = document.getElementById('shared-feedback') as HTMLTextAreaElement | null;
  const feedback = textarea?.value.trim() || null;
  try { await api.feedbackShared(sharedToken, feedback); } catch { /* ignore */ }
  showSharedScreen('shared-thanks');
}

export function handleSharedKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter' && event.shiftKey) {
    event.preventDefault();
    campaignToken ? sendCampaignMessage() : sendSharedMessage();
  }
}

// --- Campaign ---
export async function initCampaignInterview(token: string): Promise<void> {
  campaignToken = token;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-shared')?.classList.add('active');
  try {
    const data = await api.getCampaign(token);
    if (data.error) { showToast(t('toast.notFound'), true); return; }
    const titleEl = document.getElementById('shared-theme-title');
    if (titleEl) titleEl.textContent = data.theme;
  } catch (e: any) { showToast(t('toast.notFound'), true); }
}

export async function startCampaignInterview(): Promise<void> {
  if (!campaignToken) return;
  const nameInput = document.getElementById('shared-name') as HTMLInputElement | null;
  const respondentName = nameInput?.value.trim();
  showLoading(t('loading.session'));
  try {
    const data = await api.joinCampaign(campaignToken, respondentName);
    campaignSessionId = data.sessionId;
    hideLoading();
    showSharedScreen('shared-chat');
    const chatTheme = document.getElementById('shared-chat-theme');
    if (chatTheme) chatTheme.textContent = data.theme;
    const container = document.getElementById('shared-chat-container');
    if (container) container.textContent = '';
    addMessageToContainer('shared-chat-container', 'assistant', data.reply);
  } catch (e: any) { hideLoading(); showToast(e.message, true); }
}

export async function sendCampaignMessage(): Promise<void> {
  if (!campaignToken || !campaignSessionId) return;
  const input = document.getElementById('shared-chat-input') as HTMLTextAreaElement | null;
  if (!input) return;
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  addMessageToContainer('shared-chat-container', 'user', message);
  showTypingIndicator('shared-chat-container');
  try {
    const data = await api.chatCampaign(campaignToken, campaignSessionId, message);
    removeTypingIndicator('shared-chat-container');
    addMessageToContainer('shared-chat-container', 'assistant', data.reply);
    if (data.isComplete) {
      const actions = document.getElementById('shared-complete-actions');
      if (actions) actions.style.display = 'block';
    }
    const bar = document.getElementById('shared-progress-bar');
    if (bar && data.turnCount) bar.style.width = `${Math.min(100, (data.turnCount / 6) * 100)}%`;
  } catch (e: any) {
    removeTypingIndicator('shared-chat-container');
    showToast(e.message, true);
  }
}

export async function completeCampaignInterview(): Promise<void> {
  if (!campaignToken || !campaignSessionId) return;
  showLoading(t('loading.facts'));
  try {
    const data = await api.completeCampaign(campaignToken, campaignSessionId);
    renderSharedFacts(data.facts || []);
    showSharedScreen('shared-facts');
  } catch (e: any) { showToast(e.message, true); }
  finally { hideLoading(); }
}

export async function submitCampaignFeedback(): Promise<void> {
  if (!campaignToken || !campaignSessionId) return;
  const textarea = document.getElementById('shared-feedback') as HTMLTextAreaElement | null;
  const feedback = textarea?.value.trim() || null;
  try { await api.feedbackCampaign(campaignToken, campaignSessionId, feedback); } catch { /* ignore */ }
  showSharedScreen('shared-thanks');
}
