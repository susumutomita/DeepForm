// === DeepForm UI Utilities ===
import { t } from './i18n';

export function showLoading(text?: string): void {
  const el = document.getElementById('loading-text');
  if (el) el.textContent = text ?? t('loading.default');
  document.getElementById('loading-overlay')?.classList.remove('hidden');
}

export function hideLoading(): void {
  document.getElementById('loading-overlay')?.classList.add('hidden');
}

export function showToast(msg: string, isError = false): void {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `toast ${isError ? 'error' : ''}`;
  setTimeout(() => { toast.className = 'toast hidden'; }, 3000);
}

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function formatDate(d: string | null): string {
  if (!d) return '';
  const date = new Date(d + 'Z');
  return date.toLocaleDateString('ja-JP', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function statusLabel(s: string): string {
  return t(`status.${s}`) || s;
}

export function factTypeLabel(type: string): string {
  return t(`factType.${type}`) || type;
}

// Chat helpers
export function addMessageToContainer(containerId: string, role: string, content: string): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  const msg = document.createElement('div');
  msg.className = `chat-msg ${role}`;
  msg.textContent = content;
  msg.setAttribute('aria-label', role === 'assistant' ? `AI: ${content}` : content);
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

export function showTypingIndicator(containerId: string): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  const msg = document.createElement('div');
  msg.className = 'chat-msg assistant typing';
  msg.id = `typing-${containerId}`;
  msg.textContent = t('chat.thinking');
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

export function removeTypingIndicator(containerId: string): void {
  document.getElementById(`typing-${containerId}`)?.remove();
}
