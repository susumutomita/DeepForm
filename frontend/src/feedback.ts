// === DeepForm Feedback Modal ===
import { t } from './i18n';
import { showToast } from './ui';
import * as api from './api';

let feedbackModal: HTMLElement | null = null;
let deepdiveHistory: Array<{ role: string; content: string }> = [];
let deepdiveMode = false;

function createModal(): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'feedback-overlay';
  overlay.id = 'feedback-modal';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeFeedbackModal();
  });

  const card = document.createElement('div');
  card.className = 'feedback-card';

  // Title
  const title = document.createElement('h2');
  title.className = 'feedback-title';
  title.textContent = t('feedback.title');
  card.appendChild(title);

  // Type select
  const typeLabel = document.createElement('label');
  typeLabel.className = 'feedback-label';
  typeLabel.setAttribute('for', 'feedback-type');
  typeLabel.textContent = t('feedback.typeLabel');
  card.appendChild(typeLabel);

  const typeSelect = document.createElement('select');
  typeSelect.id = 'feedback-type';
  typeSelect.className = 'feedback-select';

  const types: Array<{ value: string; labelKey: string }> = [
    { value: 'bug', labelKey: 'feedback.typeBug' },
    { value: 'feature', labelKey: 'feedback.typeFeature' },
    { value: 'other', labelKey: 'feedback.typeOther' },
  ];
  for (const { value, labelKey } of types) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = t(labelKey);
    typeSelect.appendChild(option);
  }
  card.appendChild(typeSelect);

  // Deepdive chat area (hidden initially)
  const chatArea = document.createElement('div');
  chatArea.id = 'feedback-chat';
  chatArea.className = 'feedback-chat';
  chatArea.style.display = 'none';
  card.appendChild(chatArea);

  // Message textarea
  const msgLabel = document.createElement('label');
  msgLabel.className = 'feedback-label';
  msgLabel.setAttribute('for', 'feedback-message');
  msgLabel.textContent = t('feedback.messageLabel');
  card.appendChild(msgLabel);

  const msgArea = document.createElement('textarea');
  msgArea.id = 'feedback-message';
  msgArea.className = 'feedback-textarea';
  msgArea.placeholder = t('feedback.messagePlaceholder');
  msgArea.rows = 5;
  msgArea.maxLength = 5000;
  card.appendChild(msgArea);

  // Buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'feedback-buttons';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = t('feedback.cancel');
  cancelBtn.addEventListener('click', closeFeedbackModal);
  btnRow.appendChild(cancelBtn);

  const deepdiveBtn = document.createElement('button');
  deepdiveBtn.className = 'btn btn-accent';
  deepdiveBtn.id = 'feedback-deepdive';
  deepdiveBtn.textContent = t('feedback.deepdive');
  deepdiveBtn.addEventListener('click', handleDeepdive);
  btnRow.appendChild(deepdiveBtn);

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-primary';
  submitBtn.id = 'feedback-submit';
  submitBtn.textContent = t('feedback.submit');
  submitBtn.addEventListener('click', handleSubmit);
  btnRow.appendChild(submitBtn);

  card.appendChild(btnRow);
  overlay.appendChild(card);

  return overlay;
}

function addChatBubble(role: 'user' | 'assistant', text: string): void {
  const chatArea = document.getElementById('feedback-chat');
  if (!chatArea) return;

  const bubble = document.createElement('div');
  bubble.className = `feedback-bubble feedback-bubble-${role}`;
  bubble.textContent = text;
  chatArea.appendChild(bubble);
  chatArea.scrollTop = chatArea.scrollHeight;
}

async function handleDeepdive(): Promise<void> {
  const msgEl = document.getElementById('feedback-message') as HTMLTextAreaElement | null;
  const deepdiveBtn = document.getElementById('feedback-deepdive') as HTMLButtonElement | null;
  const chatArea = document.getElementById('feedback-chat');
  if (!msgEl) return;

  const message = msgEl.value.trim();
  if (!message) {
    showToast(t('feedback.error'), true);
    return;
  }

  // Show chat area
  if (chatArea) chatArea.style.display = 'block';
  deepdiveMode = true;

  // Add user message to chat
  addChatBubble('user', message);
  msgEl.value = '';
  msgEl.placeholder = t('feedback.deepdivePlaceholder');

  if (deepdiveBtn) deepdiveBtn.style.display = 'none';

  // Hide type select in deepdive mode
  const typeEl = document.getElementById('feedback-type') as HTMLSelectElement | null;
  const typeLabel = typeEl?.previousElementSibling as HTMLElement | null;
  if (typeEl) typeEl.style.display = 'none';
  if (typeLabel) typeLabel.style.display = 'none';

  // Change submit button to send
  const submitBtn = document.getElementById('feedback-submit') as HTMLButtonElement | null;
  if (submitBtn) submitBtn.textContent = t('feedback.send');

  try {
    const res = await api.feedbackDeepdive(message, deepdiveHistory);
    deepdiveHistory.push({ role: 'user', content: message });
    deepdiveHistory.push({ role: 'assistant', content: res.reply });

    addChatBubble('assistant', res.reply);

    if (res.done) {
      showToast(t('feedback.success'));
      msgEl.style.display = 'none';
      if (submitBtn) submitBtn.style.display = 'none';
      // Show close button
      const cancelBtn = document.querySelector('.feedback-buttons .btn-secondary') as HTMLButtonElement;
      if (cancelBtn) cancelBtn.textContent = t('feedback.close');
    }
  } catch (e: any) {
    const msg = e.message || '';
    if (msg.includes('60') || msg.includes('429')) {
      showToast(t('feedback.rateLimit'), true);
    } else {
      showToast(t('feedback.error'), true);
    }
  }
}

async function handleSubmit(): Promise<void> {
  const msgEl = document.getElementById('feedback-message') as HTMLTextAreaElement | null;
  const submitBtn = document.getElementById('feedback-submit') as HTMLButtonElement | null;
  if (!msgEl) return;

  const message = msgEl.value.trim();
  if (!message && !deepdiveMode) {
    showToast(t('feedback.error'), true);
    return;
  }

  if (submitBtn) submitBtn.disabled = true;

  try {
    if (deepdiveMode && message) {
      // Continue deepdive conversation
      const res = await api.feedbackDeepdive(message, deepdiveHistory);
      deepdiveHistory.push({ role: 'user', content: message });
      deepdiveHistory.push({ role: 'assistant', content: res.reply });

      addChatBubble('user', message);
      addChatBubble('assistant', res.reply);
      msgEl.value = '';

      if (res.done) {
        showToast(t('feedback.success'));
        msgEl.style.display = 'none';
        if (submitBtn) submitBtn.style.display = 'none';
        const cancelBtn = document.querySelector('.feedback-buttons .btn-secondary') as HTMLButtonElement;
        if (cancelBtn) cancelBtn.textContent = t('feedback.close');
      }
    } else {
      // Direct submit
      const typeEl = document.getElementById('feedback-type') as HTMLSelectElement | null;
      const type = typeEl?.value || 'other';
      await api.submitAppFeedback(type, message, window.location.pathname);
      showToast(t('feedback.success'));
      closeFeedbackModal();
    }
  } catch (e: any) {
    const msg = e.message || '';
    if (msg.includes('60') || msg.includes('429')) {
      showToast(t('feedback.rateLimit'), true);
    } else {
      showToast(t('feedback.error'), true);
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

export function openFeedbackModal(): void {
  closeFeedbackModal();
  deepdiveHistory = [];
  deepdiveMode = false;
  feedbackModal = createModal();
  document.body.appendChild(feedbackModal);
  const msg = document.getElementById('feedback-message') as HTMLTextAreaElement | null;
  if (msg) msg.focus();
}

export function closeFeedbackModal(): void {
  if (feedbackModal) {
    feedbackModal.remove();
    feedbackModal = null;
  }
}
