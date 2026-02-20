// === DeepForm Campaign Interview ===
import * as api from './api';
import { t } from './i18n';
import { showLoading, hideLoading, showToast, escapeHtml, factTypeLabel, addMessageToContainer, showTypingIndicator, removeTypingIndicator } from './ui';
import type { Fact } from './types';

let campaignToken: string | null = null;
let campaignSessionId: string | null = null;

export function getCampaignToken(): string | null { return campaignToken; }

function showSharedScreen(screenId: string): void {
  document.querySelectorAll('.shared-screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId)?.classList.add('active');
}

function renderSharedFacts(facts: Fact[]): void {
  const container = document.getElementById('shared-facts-container');
  if (!container) return;
  container.innerHTML = facts.map(f => `
    <div class="fact-card">
      <div class="fact-card-header">
        <span class="fact-type type-${f.type}">${factTypeLabel(f.type)}</span>
        <span class="severity severity-${f.severity.replace(/[^a-zA-Z0-9_-]/g, '')}">${escapeHtml(f.severity)}</span>
      </div>
      <div class="fact-content">${escapeHtml(f.content)}</div>
      ${f.evidence ? `<div class="fact-evidence">「${escapeHtml(f.evidence)}」</div>` : ''}
    </div>
  `).join('');
}

export function handleCampaignKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter' && event.shiftKey) {
    event.preventDefault();
    sendCampaignMessage();
  }
}

function showSharedChoices(containerId: string, choices: string[]): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  const choicesDiv = document.createElement('div');
  choicesDiv.className = 'chat-choices';
  for (const choice of choices) {
    if (choice.includes('その他') || choice.includes('自分で入力')) {
      const btn = document.createElement('button');
      btn.className = 'chat-choice-btn chat-choice-other';
      btn.textContent = '✏️ ' + choice;
      btn.addEventListener('click', () => {
        removeSharedChoices(containerId);
        const input = document.getElementById('shared-chat-input') as HTMLTextAreaElement | null;
        if (input) input.focus();
      });
      choicesDiv.appendChild(btn);
    } else {
      const btn = document.createElement('button');
      btn.className = 'chat-choice-btn';
      btn.textContent = choice;
      btn.addEventListener('click', () => {
        sendCampaignMessageWithText(choice);
      });
      choicesDiv.appendChild(btn);
    }
  }
  container.appendChild(choicesDiv);
  container.scrollTop = container.scrollHeight;
}

function removeSharedChoices(containerId: string): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.chat-choices').forEach(el => el.remove());
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
    if (titleEl) {
      // Truncate long themes to keep the welcome card readable
      const maxLen = 120;
      titleEl.textContent = data.theme.length > maxLen
        ? data.theme.slice(0, maxLen) + '…'
        : data.theme;
    }
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
    if (data.choices?.length) {
      showSharedChoices('shared-chat-container', data.choices);
    }
  } catch (e: any) { hideLoading(); showToast(e.message, true); }
}

async function sendCampaignMessageWithText(text: string): Promise<void> {
  if (!campaignToken || !campaignSessionId) return;
  const input = document.getElementById('shared-chat-input') as HTMLTextAreaElement | null;
  if (input) input.value = '';
  removeSharedChoices('shared-chat-container');
  addMessageToContainer('shared-chat-container', 'user', text);
  showTypingIndicator('shared-chat-container');
  try {
    const data = await api.chatCampaign(campaignToken, campaignSessionId, text);
    removeTypingIndicator('shared-chat-container');
    addMessageToContainer('shared-chat-container', 'assistant', data.reply);
    if (data.choices?.length) {
      showSharedChoices('shared-chat-container', data.choices);
    }
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

export async function sendCampaignMessage(): Promise<void> {
  if (!campaignToken || !campaignSessionId) return;
  const input = document.getElementById('shared-chat-input') as HTMLTextAreaElement | null;
  if (!input) return;
  const message = input.value.trim();
  if (!message) return;
  await sendCampaignMessageWithText(message);
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
