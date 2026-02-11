// === Campaign Analytics Dashboard ===
// Security: All user-facing dynamic strings pass through escapeHtml() which uses
// textContent-based sanitization, preventing XSS. This is consistent with the
// existing codebase pattern (see interview.ts, shared.ts).
import * as api from './api';
import type { CampaignAnalytics, CampaignAIAnalysis } from './types';
import { showToast } from './ui';

let currentCampaignId = '';
let currentAnalytics: CampaignAnalytics | null = null;
let currentAIAnalysis: CampaignAIAnalysis | null = null;

/** Escapes HTML special characters using DOM textContent (XSS-safe). */
function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function severityBadge(severity: string): string {
  const cls = severity === 'high' ? 'severity-high'
    : severity === 'low' ? 'severity-low'
    : 'severity-medium';
  // Safe: severity is escaped
  return `<span class="severity-badge ${cls}">${escapeHtml(severity)}</span>`;
}

function renderStatsCards(analytics: CampaignAnalytics): string {
  // Safe: all values are numbers (no user input)
  return `
    <div class="analytics-stats">
      <div class="stat-card">
        <div class="stat-value">${analytics.totalSessions}</div>
        <div class="stat-label">総セッション数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${analytics.completedSessions}</div>
        <div class="stat-label">完了セッション数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${analytics.commonFacts.length}</div>
        <div class="stat-label">ユニークファクト数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${analytics.painPoints.length}</div>
        <div class="stat-label">ペインポイント数</div>
      </div>
    </div>
  `;
}

function renderCommonFacts(facts: CampaignAnalytics['commonFacts']): string {
  if (facts.length === 0) return '<p class="analytics-empty">ファクトデータがありません</p>';
  // Safe: all dynamic content goes through escapeHtml
  const rows = facts.slice(0, 20).map((f) => `
    <tr>
      <td>${escapeHtml(f.content)}</td>
      <td class="analytics-count">${f.count}</td>
      <td>${escapeHtml(f.type)}</td>
      <td>${severityBadge(f.severity)}</td>
    </tr>
  `).join('');
  return `
    <table class="analytics-table">
      <thead>
        <tr><th>内容</th><th>出現数</th><th>タイプ</th><th>重要度</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderPainPoints(painPoints: CampaignAnalytics['painPoints']): string {
  if (painPoints.length === 0) return '<p class="analytics-empty">ペインポイントがありません</p>';
  // Safe: all dynamic content goes through escapeHtml
  const items = painPoints.map((p) => `
    <li class="pain-item">
      <span class="pain-content">${escapeHtml(p.content)}</span>
      <span class="pain-count">${p.count}件</span>
      ${severityBadge(p.severity)}
    </li>
  `).join('');
  return `<ul class="pain-list">${items}</ul>`;
}

function renderKeywordCounts(keywords: Record<string, number>): string {
  const sorted = Object.entries(keywords)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 30);
  if (sorted.length === 0) return '<p class="analytics-empty">キーワードデータがありません</p>';
  // Safe: all dynamic content goes through escapeHtml
  const rows = sorted.map(([word, count]) => `
    <tr>
      <td>${escapeHtml(word)}</td>
      <td class="analytics-count">${count}</td>
    </tr>
  `).join('');
  return `
    <table class="analytics-table">
      <thead><tr><th>キーワード</th><th>出現数</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderAIAnalysis(analysis: CampaignAIAnalysis): string {
  // Safe: all dynamic content goes through escapeHtml
  let html = '';
  if (analysis.summary) {
    html += `<div class="ai-summary"><p>${escapeHtml(analysis.summary)}</p></div>`;
  }
  if (analysis.patterns && analysis.patterns.length > 0) {
    html += '<h4>検出パターン</h4><div class="pattern-list">';
    for (const p of analysis.patterns) {
      html += `
        <div class="pattern-card">
          <div class="pattern-header">
            <strong>${escapeHtml(p.title)}</strong>
            ${severityBadge(p.severity)}
            <span class="pattern-freq">${escapeHtml(p.frequency)}</span>
          </div>
          <p>${escapeHtml(p.description)}</p>
        </div>
      `;
    }
    html += '</div>';
  }
  if (analysis.insights && analysis.insights.length > 0) {
    html += '<h4>横断的インサイト</h4><ul class="insight-list">';
    for (const i of analysis.insights) {
      html += `<li>${escapeHtml(i.content)}</li>`;
    }
    html += '</ul>';
  }
  if (analysis.recommendations && analysis.recommendations.length > 0) {
    html += '<h4>推奨アクション</h4><ul class="recommendation-list">';
    for (const r of analysis.recommendations) {
      html += `<li>${escapeHtml(r)}</li>`;
    }
    html += '</ul>';
  }
  return html;
}

export async function showCampaignAnalytics(campaignId: string): Promise<void> {
  currentCampaignId = campaignId;
  currentAIAnalysis = null;
  const container = document.getElementById('campaign-analytics');
  if (!container) return;

  container.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'analytics-loading';
  loading.textContent = '分析データを読み込んでいます...';
  container.appendChild(loading);

  // Hide other pages
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  container.classList.add('active');

  try {
    currentAnalytics = await api.getCampaignAnalytics(campaignId);
  } catch (e: any) {
    container.textContent = '';
    const err = document.createElement('div');
    err.className = 'analytics-error';
    err.textContent = `エラー: ${e.message}`;
    container.appendChild(err);
    return;
  }

  renderDashboard(container);
}

function renderDashboard(container: HTMLElement): void {
  if (!currentAnalytics) return;

  const aiSection = currentAIAnalysis
    ? `<div class="analytics-section">
        <h3>AI 横断分析</h3>
        ${renderAIAnalysis(currentAIAnalysis)}
      </div>`
    : '';

  // Safe: all dynamic content is either numeric or goes through escapeHtml.
  // Static HTML structure with sanitized interpolations.
  const dashboardHtml = `
    <div class="analytics-dashboard">
      <div class="analytics-header">
        <h2>キャンペーン分析ダッシュボード</h2>
        <div class="analytics-actions">
          <button class="btn btn-primary" id="btn-generate-ai">AI 横断分析を生成</button>
          <button class="btn btn-secondary" id="btn-export-json">JSON エクスポート</button>
          <button class="btn btn-secondary" id="btn-back-home">戻る</button>
        </div>
      </div>

      ${renderStatsCards(currentAnalytics)}

      ${aiSection}

      <div class="analytics-section">
        <h3>共通ファクト</h3>
        ${renderCommonFacts(currentAnalytics.commonFacts)}
      </div>

      <div class="analytics-section">
        <h3>ペインポイント（頻度順）</h3>
        ${renderPainPoints(currentAnalytics.painPoints)}
      </div>

      <div class="analytics-section">
        <h3>キーワード頻度</h3>
        ${renderKeywordCounts(currentAnalytics.keywordCounts)}
      </div>
    </div>
  `;
  container.innerHTML = dashboardHtml; // Safe: all interpolated values are escaped or numeric

  // Bind button events via addEventListener (no inline handlers)
  document.getElementById('btn-generate-ai')?.addEventListener('click', handleGenerateAI);
  document.getElementById('btn-export-json')?.addEventListener('click', handleExportJSON);
  document.getElementById('btn-back-home')?.addEventListener('click', () => {
    const w = window as any;
    if (typeof w.showHome === 'function') w.showHome();
  });
}

async function handleGenerateAI(): Promise<void> {
  const btn = document.getElementById('btn-generate-ai') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'AI 分析生成中...';
  }

  try {
    currentAIAnalysis = await api.generateCampaignAnalytics(currentCampaignId);
    showToast('AI 横断分析を生成しました');
    const container = document.getElementById('campaign-analytics');
    if (container) renderDashboard(container);
  } catch (e: any) {
    showToast(e.message, true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'AI 横断分析を生成';
    }
  }
}

async function handleExportJSON(): Promise<void> {
  try {
    const data = await api.exportCampaignAnalytics(currentCampaignId);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `campaign-${currentCampaignId}-analytics.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('エクスポートが完了しました');
  } catch (e: any) {
    showToast(e.message, true);
  }
}
