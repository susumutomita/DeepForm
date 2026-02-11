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

// --- Dark Mode Toggle ---
type Theme = 'light' | 'dark' | 'system';

function getStoredTheme(): Theme {
  return (localStorage.getItem('deepform-theme') as Theme) || 'system';
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
  updateThemeIcon(theme);
}

function updateThemeIcon(theme: Theme): void {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  btn.innerHTML = resolved === 'dark'
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  btn.setAttribute('aria-label', resolved === 'dark' ? 'ライトモードに切替' : 'ダークモードに切替');
}

export function toggleTheme(): void {
  const current = getStoredTheme();
  const isDark = current === 'dark' ||
    (current === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const next: Theme = isDark ? 'light' : 'dark';
  localStorage.setItem('deepform-theme', next);
  applyTheme(next);
}

export function initTheme(): void {
  const theme = getStoredTheme();
  applyTheme(theme);
  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getStoredTheme() === 'system') applyTheme('system');
  });
}
