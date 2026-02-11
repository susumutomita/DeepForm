// === DeepForm Session List ===
import * as api from './api';
import { getUser } from './auth';
import { t } from './i18n';
import { formatDate, statusLabel, showToast } from './ui';
import type { DeepFormWindow } from './types';

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

function safeId(id: string): string {
  return SESSION_ID_RE.test(id) ? id : '';
}

function safeCssClass(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '');
}

export async function loadSessions(): Promise<void> {
  const list = document.getElementById('sessions-list');
  if (!list) return;
  const w = window as unknown as DeepFormWindow;
  try {
    const sessions = await api.getSessions();
    if (sessions.length === 0) {
      list.textContent = '';
      const p = document.createElement('p');
      p.className = 'empty-state';
      p.textContent = t('sessions.empty');
      list.appendChild(p);
      return;
    }
    const user = getUser();
    // Build session cards using DOM APIs to avoid XSS via inline handlers
    list.textContent = '';
    for (const s of sessions) {
      const sid = safeId(s.id);
      if (!sid) continue;

      const card = document.createElement('div');
      card.className = 'session-card';

      const info = document.createElement('div');
      info.className = 'session-card-info';
      info.dataset.sessionId = sid;
      info.addEventListener('click', () => w.openSession(sid));

      const h3 = document.createElement('h3');
      h3.textContent = s.theme;
      info.appendChild(h3);

      const meta = document.createElement('div');
      meta.className = 'session-card-meta';
      const msgSpan = document.createElement('span');
      msgSpan.textContent = `${s.message_count}メッセージ`;
      meta.appendChild(msgSpan);
      const dateSpan = document.createElement('span');
      dateSpan.textContent = formatDate(s.created_at);
      meta.appendChild(dateSpan);
      if (s.mode === 'shared') {
        const sharedSpan = document.createElement('span');
        sharedSpan.className = 'shared-tag';
        sharedSpan.textContent = t('shared.tag');
        meta.appendChild(sharedSpan);
      }
      if (s.respondent_name) {
        const nameSpan = document.createElement('span');
        nameSpan.textContent = s.respondent_name;
        meta.appendChild(nameSpan);
      }
      info.appendChild(meta);
      card.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'session-card-actions';

      if (user && s.user_id === user.id) {
        const visBtn = document.createElement('button');
        visBtn.className = 'btn-visibility btn-sm';
        visBtn.textContent = s.is_public ? '\uD83D\uDD13 ' + t('session.public') : '\uD83D\uDD12 ' + t('session.private');
        const newState = !s.is_public;
        visBtn.addEventListener('click', (e) => { e.stopPropagation(); w.toggleVisibility(sid, newState); });
        actions.appendChild(visBtn);
      }

      const badge = document.createElement('span');
      badge.className = `status-badge status-${safeCssClass(s.display_status || s.status)}`;
      badge.textContent = statusLabel(s.display_status || s.status);
      actions.appendChild(badge);

      const shareBtn = document.createElement('button');
      shareBtn.className = 'btn btn-sm btn-secondary';
      shareBtn.title = '共有URLをコピー';
      shareBtn.textContent = '\u2197';
      shareBtn.addEventListener('click', (e) => { e.stopPropagation(); w.shareSession(sid); });
      actions.appendChild(shareBtn);

      card.appendChild(actions);
      list.appendChild(card);
    }
  } catch (e) {
    console.error('Failed to load sessions:', e);
    showToast(t('toast.notFound'), true);
  }
}

export async function doToggleVisibility(sessionId: string, newState: boolean): Promise<void> {
  try {
    await api.toggleVisibility(sessionId, newState);
    await loadSessions();
  } catch (e: any) {
    showToast(e.message, true);
  }
}

export async function doShareSession(sessionId: string): Promise<void> {
  try {
    const data = await api.shareSession(sessionId);
    const url = `${window.location.origin}/i/${data.shareToken}`;
    await navigator.clipboard.writeText(url);
    showToast(`${t('toast.shareUrl')}: ${url}`);
  } catch (e: any) {
    showToast(e.message, true);
  }
}

export async function doCreateCampaign(sessionId: string): Promise<void> {
  try {
    const data = await api.createCampaign(sessionId);
    const url = `${window.location.origin}/c/${data.shareToken}`;
    await navigator.clipboard.writeText(url);
    showToast(`${t('toast.campaignUrl')}: ${url}`);
  } catch (e: any) {
    showToast(e.message, true);
  }
}
