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
  // exe.dev 環境: プロキシのログインページへリダイレクト
  // ローカル環境: /__exe.dev/login が存在しないため案内を表示
  const isExeDev = window.location.hostname.endsWith('.exe.xyz')
    || window.location.hostname.endsWith('.exe.dev');
  if (isExeDev) {
    window.location.href = '/__exe.dev/login?redirect=' + encodeURIComponent(window.location.pathname);
  } else {
    alert(
      'ローカル環境ではexe.dev認証が使えません。\n\n'
      + '以下の環境変数を設定してサーバーを起動してください:\n'
      + '  EXEDEV_DEV_USER=dev-user-1\n'
      + '  EXEDEV_DEV_EMAIL=dev@example.com\n\n'
      + '例: EXEDEV_DEV_USER=dev-user-1 EXEDEV_DEV_EMAIL=dev@example.com npx tsx src/index.ts'
    );
  }
}
