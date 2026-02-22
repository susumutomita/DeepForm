// === Pricing AI Chat Widget ===
import { consultPricing } from './api';
import { isLoggedIn } from './auth';
import { t } from './i18n';

let chatHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
let isSending = false;

/** Initialize the pricing chat widget with a static greeting. */
export function initPricingChat(): void {
  const messagesEl = document.getElementById('pricing-chat-messages');
  if (!messagesEl) return;

  // Reset state
  chatHistory = [];
  messagesEl.textContent = '';

  // Show greeting (static, no API call)
  appendMessage('assistant', t('pricing.consult.greeting'));

  // Bind collapsible toggle
  const toggleBtn = document.getElementById('pricing-consult-toggle');
  const container = document.getElementById('pricing-consult');
  toggleBtn?.addEventListener('click', () => {
    container?.classList.toggle('open');
  });

  // Bind send button
  const sendBtn = document.getElementById('pricing-chat-send');
  sendBtn?.addEventListener('click', sendPricingMessage);

  // Bind Enter to send (Shift+Enter for newline reserved for future textarea)
  const input = document.getElementById('pricing-chat-input') as HTMLInputElement | null;
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPricingMessage();
    }
  });
}

async function sendPricingMessage(): Promise<void> {
  if (isSending) return;

  const input = document.getElementById('pricing-chat-input') as HTMLInputElement | null;
  if (!input) return;

  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  appendMessage('user', message);

  isSending = true;
  const thinkingEl = showThinking();

  try {
    const data = await consultPricing(message, chatHistory);

    // Add user message to history (before response)
    chatHistory.push({ role: 'user', content: message });

    removeThinking(thinkingEl);
    appendMessage('assistant', data.reply);
    chatHistory.push({ role: 'assistant', content: data.reply });

    // Handle recommendation
    if (data.recommendation === 'pro') {
      if (data.checkoutUrl) {
        appendCheckoutButton(data.checkoutUrl);
      } else if (!isLoggedIn()) {
        appendLoginPrompt();
      }
    } else if (data.recommendation === 'free') {
      appendFreeMessage();
    }

    // Disable input if conversation is done
    if (data.done) {
      disableInput();
    }
  } catch (e: any) {
    removeThinking(thinkingEl);
    appendMessage('assistant', e.message || 'Error');
  } finally {
    isSending = false;
  }
}

function appendMessage(role: 'user' | 'assistant', text: string): void {
  const messagesEl = document.getElementById('pricing-chat-messages');
  if (!messagesEl) return;

  const bubble = document.createElement('div');
  bubble.className = `pricing-msg pricing-msg-${role}`;
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showThinking(): HTMLElement {
  const messagesEl = document.getElementById('pricing-chat-messages');
  const el = document.createElement('div');
  el.className = 'pricing-msg pricing-msg-assistant pricing-thinking';
  el.textContent = '...';
  messagesEl?.appendChild(el);
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function removeThinking(el: HTMLElement): void {
  el.remove();
}

function appendCheckoutButton(url: string): void {
  const messagesEl = document.getElementById('pricing-chat-messages');
  if (!messagesEl) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'pricing-action';

  const btn = document.createElement('a');
  btn.href = url;
  btn.className = 'btn btn-primary pricing-checkout-btn';
  btn.textContent = t('pricing.consult.checkout');
  btn.target = '_blank';
  btn.rel = 'noopener';

  wrapper.appendChild(btn);
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendLoginPrompt(): void {
  const messagesEl = document.getElementById('pricing-chat-messages');
  if (!messagesEl) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'pricing-action';

  const msg = document.createElement('p');
  msg.className = 'pricing-login-msg';
  msg.textContent = t('pricing.consult.loginFirst');
  wrapper.appendChild(msg);

  const btn = document.createElement('a');
  btn.href = '/api/auth/github';
  btn.className = 'btn btn-secondary pricing-login-btn';
  btn.textContent = t('guest.notice.login');
  wrapper.appendChild(btn);

  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendFreeMessage(): void {
  const messagesEl = document.getElementById('pricing-chat-messages');
  if (!messagesEl) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'pricing-action';

  const msg = document.createElement('p');
  msg.className = 'pricing-free-msg';
  msg.textContent = t('pricing.consult.freeOk');
  wrapper.appendChild(msg);

  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function disableInput(): void {
  const input = document.getElementById('pricing-chat-input') as HTMLInputElement | null;
  const btn = document.getElementById('pricing-chat-send') as HTMLButtonElement | null;
  if (input) input.disabled = true;
  if (btn) btn.disabled = true;
}
