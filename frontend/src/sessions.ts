// === DeepForm Session List ===
import * as api from './api';
import { getUser } from './auth';
import { t } from './i18n';
import { escapeHtml, formatDate, statusLabel, showToast } from './ui';

export async function loadSessions(): Promise<void> {
  const list = document.getElementById('sessions-list');
  if (!list) return;
  try {
    const sessions = await api.getSessions();
    if (sessions.length === 0) {
      list.innerHTML = `<p class="empty-state">${t('sessions.empty')}</p>`;
      return;
    }
    const user = getUser();
    list.innerHTML = sessions.map(s => `
      <div class="session-card">
        <div class="session-card-info" onclick="window.openSession('${s.id}')">
          <h3>${escapeHtml(s.theme)}</h3>
          <div class="session-card-meta">
            <span>${s.message_count}メッセージ</span>
            <span>${formatDate(s.created_at)}</span>
            ${s.mode === 'shared' ? `<span class="shared-tag">${t('shared.tag')}</span>` : ''}
            ${s.respondent_name ? `<span>${escapeHtml(s.respondent_name)}</span>` : ''}
          </div>
        </div>
        <div class="session-card-actions">
          ${user && s.user_id === user.id ? `<button class="btn-visibility btn-sm" onclick="event.stopPropagation(); window.toggleVisibility('${s.id}', ${!s.is_public})">${s.is_public ? '\uD83D\uDD13 ' + t('session.public') : '\uD83D\uDD12 ' + t('session.private')}</button>` : ''}
          <span class="status-badge status-${s.display_status || s.status}">${statusLabel(s.display_status || s.status)}</span>
          <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); window.shareSession('${s.id}')" title="\u5171\u6709URL\u3092\u30b3\u30d4\u30fc">&#8599;</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    console.error('Failed to load sessions:', e);
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
