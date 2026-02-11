// === DeepForm Auth (Login with exe.dev) ===
import * as api from './api';
import type { User } from './types';

let currentUser: User | null = null;

export function getUser(): User | null {
  return currentUser;
}

export function isLoggedIn(): boolean {
  return currentUser !== null;
}

export async function checkAuth(): Promise<void> {
  try {
    currentUser = await api.checkAuthStatus();
  } catch {
    currentUser = null;
  }
  updateAuthUI();
}

export function updateAuthUI(): void {
  const loginBtn = document.getElementById('login-btn');
  const userInfo = document.getElementById('user-info');
  const userName = document.getElementById('user-name');

  if (currentUser) {
    if (loginBtn) loginBtn.style.display = 'none';
    if (userInfo) userInfo.style.display = 'flex';
    if (userName) userName.textContent = currentUser.displayName ?? currentUser.email;
  } else {
    if (loginBtn) loginBtn.style.display = 'inline-flex';
    if (userInfo) userInfo.style.display = 'none';
  }
}

export async function doLogout(): Promise<void> {
  try {
    await api.logout();
  } catch { /* ignore - cleanup must continue */ }
  try {
    await fetch('/__exe.dev/logout', { method: 'POST' });
  } catch { /* ignore */ }
  currentUser = null;
  updateAuthUI();
  window.location.reload();
}

export function redirectToLogin(): void {
  window.location.href = '/__exe.dev/login?redirect=' + encodeURIComponent(window.location.pathname);
}
