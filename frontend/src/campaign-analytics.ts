// === Campaign Analytics Dashboard ===
// Security: All user-facing dynamic strings pass through escapeHtml() which uses
// textContent-based sanitization, preventing XSS. This is consistent with the
// existing codebase pattern (see interview.ts, shared.ts).
import * as api from './api';
import type { CampaignAnalytics, CampaignAIAnalysis } from './types';
import { showToast } from './ui';
import { t } from './i18n';

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

/**
 * Render a compact campaign summary in the sidebar panel.
 * Called from interview.ts when opening a session that has a campaign.
 * Security: All dynamic strings pass through escapeHtml() (textContent-based).
 */
export async function renderCampaignSidebarPanel(
  campaignId: string,
  shareToken: string,
  respondentCount: number,
): Promise<void> {
  const panel = document.getElementById('campaign-results-panel');
  if (!panel) return;

  panel.style.display = 'block';

  // Update the campaign button to "copy share URL" (preserve <span> for i18n)
  const createBtn = document.getElementById('btn-create-campaign') as HTMLButtonElement | null;
  if (createBtn) {
    const span = createBtn.querySelector('span');
    if (span) {
      span.textContent = 'URL をコピー';
      span.removeAttribute('data-i18n');
    }
    createBtn.removeAttribute('onclick');
    createBtn.onclick = () => {
      const url = `${window.location.origin}/c/${shareToken}`;
      navigator.clipboard.writeText(url).then(() => {
        showToast('URLをコピーしました');
      });
    };
  }

  if (respondentCount === 0) {
    // Safe: no user input, static text only
    panel.innerHTML = [
      '<div class="campaign-panel-empty">',
      '<div class="campaign-panel-count">まだ回答がありません</div>',
      '<p class="campaign-panel-hint">共有URLを送って回答を集めましょう</p>',
      '</div>',
    ].join('');
    return;
  }

  panel.textContent = '読み込み中...';

  try {
    const analytics = await api.getCampaignAnalytics(campaignId);
    currentCampaignId = campaignId;
    currentAnalytics = analytics;

    // Safe: all dynamic content goes through escapeHtml
    const topPainPoints = analytics.painPoints
      .slice(0, 3)
      .map((p) => `<li>${escapeHtml(p.content)} <span class="campaign-panel-badge">${p.count}人</span></li>`)
      .join('');

    const topFacts = analytics.commonFacts
      .filter((f) => f.type !== 'pain')
      .slice(0, 3)
      .map((f) => `<li>${escapeHtml(f.content)} <span class="campaign-panel-badge">${f.count}人</span></li>`)
      .join('');

    // Safe: all interpolated values are either escaped or numeric
    const parts = [
      '<div class="campaign-panel-header">',
      `<strong>${analytics.completedSessions}人が回答済み</strong>`,
      '</div>',
    ];
    if (topPainPoints) {
      parts.push(
        '<div class="campaign-panel-section">',
        '<div class="campaign-panel-label">よくある困りごと</div>',
        `<ul class="campaign-panel-list">${topPainPoints}</ul>`,
        '</div>',
      );
    }
    if (topFacts) {
      parts.push(
        '<div class="campaign-panel-section">',
        '<div class="campaign-panel-label">共通のファクト</div>',
        `<ul class="campaign-panel-list">${topFacts}</ul>`,
        '</div>',
      );
    }
    parts.push(
      '<button class="btn btn-sm btn-accent campaign-panel-triage" id="btn-triage-facts">',
      escapeHtml(t('triage.button')),
      '</button>',
      '<button class="btn btn-sm btn-secondary campaign-panel-more" id="btn-show-full-analytics">',
      '全回答を見る →',
      '</button>',
    );

    panel.innerHTML = parts.join(''); // Safe: all dynamic content escaped via escapeHtml

    document.getElementById('btn-triage-facts')?.addEventListener('click', () => {
      const w = window as any;
      const sessionId = typeof w.getCurrentSessionId === 'function' ? w.getCurrentSessionId() : null;
      if (sessionId) openTriageModal(sessionId);
    });

    document.getElementById('btn-show-full-analytics')?.addEventListener('click', () => {
      showCampaignAnalyticsInStep(campaignId);
    });
  } catch (e: any) {
    panel.textContent = e.message;
  }
}

/**
 * Show full campaign analytics inside the interview page as a step content.
 * Security: Delegates to renderDashboardInline which uses escapeHtml for all user content.
 */
export async function showCampaignAnalyticsInStep(campaignId: string): Promise<void> {
  const container = document.getElementById('campaign-analytics-container');
  if (!container) return;

  // Activate the step
  document.querySelectorAll('.step-content').forEach((el) => el.classList.remove('active'));
  document.getElementById('step-campaign-analytics')?.classList.add('active');

  if (currentAnalytics && currentCampaignId === campaignId) {
    renderDashboardInline(container, currentAnalytics);
    return;
  }

  container.textContent = '分析データを読み込んでいます...';

  try {
    currentCampaignId = campaignId;
    currentAnalytics = await api.getCampaignAnalytics(campaignId);
    renderDashboardInline(container, currentAnalytics);
  } catch (e: any) {
    container.textContent = `エラー: ${e.message}`;
  }
}

/**
 * Render analytics dashboard inline (within the interview page step).
 * Security: All dynamic content goes through escapeHtml or is numeric.
 */
function renderDashboardInline(container: HTMLElement, analytics: CampaignAnalytics): void {
  // Safe: all render functions use escapeHtml for user-facing strings
  const parts = [
    renderStatsCards(analytics),
    '<div class="analytics-section"><h3>共通ファクト</h3>',
    renderCommonFacts(analytics.commonFacts),
    '</div>',
    '<div class="analytics-section"><h3>ペインポイント（頻度順）</h3>',
    renderPainPoints(analytics.painPoints),
    '</div>',
    '<div class="analytics-section"><h3>キーワード頻度</h3>',
    renderKeywordCounts(analytics.keywordCounts),
    '</div>',
  ];
  container.innerHTML = parts.join(''); // Safe: all interpolated values escaped
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
        <h2>フィードバック分析ダッシュボード</h2>
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

// ---------------------------------------------------------------------------
// Campaign Triage UI
// ---------------------------------------------------------------------------

/**
 * Open triage modal for selecting campaign facts to include in PRD.
 * Security: All dynamic content goes through escapeHtml() which uses
 * textContent-based sanitization, preventing XSS. This is consistent with the
 * existing codebase pattern (see renderDashboard, renderCampaignSidebarPanel).
 */
export async function openTriageModal(sessionId: string): Promise<void> {
  // Remove existing modal if any
  document.querySelector('.triage-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'triage-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const modal = document.createElement('div');
  modal.className = 'triage-modal';
  modal.addEventListener('click', (e) => e.stopPropagation());

  // Safe: escapeHtml uses textContent-based sanitization
  const headerHtml = `<div class="triage-header"><h3>${escapeHtml(t('triage.title'))}</h3><p class="triage-desc">${escapeHtml(t('triage.desc'))}</p></div>`;
  const loadingHtml = `<div class="triage-loading">${escapeHtml(t('loading.default'))}</div>`;
  modal.innerHTML = headerHtml + loadingHtml; // Safe: all dynamic content escaped via escapeHtml
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  try {
    const data = await api.getTriagedFacts(sessionId);

    if (data.facts.length === 0) {
      modal.querySelector('.triage-loading')!.textContent = t('triage.noFacts');
      return;
    }

    // Build the fact list with checkboxes
    const selectedSet = new Set(data.selectedFactIds);

    // Safe: all user-facing content goes through escapeHtml (textContent-based)
    const factsHtml = data.facts.map((f) => {
      const checked = selectedSet.has(f.factId) ? 'checked' : '';
      return [
        `<label class="triage-fact-item">`,
        `<input type="checkbox" class="triage-checkbox" data-fact-id="${escapeHtml(f.factId)}" ${checked}>`,
        `<div class="triage-fact-body">`,
        `<div class="triage-fact-meta">`,
        `<span class="fact-type type-${escapeHtml(f.type)}">${escapeHtml(f.type)}</span>`,
        `<span class="severity-badge severity-${escapeHtml(f.severity)}">${escapeHtml(f.severity)}</span>`,
        `<span class="triage-respondent">${escapeHtml(f.respondentName)}</span>`,
        `</div>`,
        `<div class="triage-fact-content">${escapeHtml(f.content)}</div>`,
        f.evidence ? `<div class="triage-fact-evidence">${escapeHtml(f.evidence)}</div>` : '',
        `</div></label>`,
      ].join('');
    }).join('');

    const selectedCount = selectedSet.size;
    // Safe: all interpolated values go through escapeHtml or are numeric
    modal.innerHTML = [
      `<div class="triage-header">`,
      `<h3>${escapeHtml(t('triage.title'))}</h3>`,
      `<p class="triage-desc">${escapeHtml(t('triage.desc'))}</p>`,
      `</div>`,
      `<div class="triage-toolbar">`,
      `<button class="btn btn-sm btn-secondary" id="triage-select-all">${escapeHtml(t('triage.selectAll'))}</button>`,
      `<button class="btn btn-sm btn-secondary" id="triage-deselect-all">${escapeHtml(t('triage.deselectAll'))}</button>`,
      `<span class="triage-count" id="triage-count">${selectedCount} ${escapeHtml(t('triage.selectedCount'))}</span>`,
      `</div>`,
      `<div class="triage-fact-list">${factsHtml}</div>`,
      `<div class="triage-actions">`,
      `<button class="btn btn-accent" id="triage-save">${escapeHtml(t('triage.save'))}</button>`,
      `</div>`,
    ].join(''); // Safe: all dynamic content escaped via escapeHtml

    // Update count on checkbox change
    const updateCount = () => {
      const checked = modal.querySelectorAll<HTMLInputElement>('.triage-checkbox:checked').length;
      const countEl = modal.querySelector('#triage-count');
      if (countEl) countEl.textContent = `${checked} ${t('triage.selectedCount')}`;
    };

    modal.querySelectorAll('.triage-checkbox').forEach((cb) => {
      cb.addEventListener('change', updateCount);
    });

    // Select all / deselect all
    modal.querySelector('#triage-select-all')?.addEventListener('click', () => {
      modal.querySelectorAll<HTMLInputElement>('.triage-checkbox').forEach((cb) => { cb.checked = true; });
      updateCount();
    });
    modal.querySelector('#triage-deselect-all')?.addEventListener('click', () => {
      modal.querySelectorAll<HTMLInputElement>('.triage-checkbox').forEach((cb) => { cb.checked = false; });
      updateCount();
    });

    // Save button — persist triage and trigger pipeline re-run
    modal.querySelector('#triage-save')?.addEventListener('click', async () => {
      const saveBtn = modal.querySelector('#triage-save') as HTMLButtonElement;
      saveBtn.disabled = true;
      saveBtn.textContent = t('triage.saving');

      const ids = Array.from(modal.querySelectorAll<HTMLInputElement>('.triage-checkbox:checked'))
        .map((cb) => cb.dataset.factId!)
        .filter(Boolean);

      try {
        await api.saveTriagedFacts(sessionId, ids);
        showToast(t('triage.saved'));
        overlay.remove();

        // Trigger pipeline re-run to regenerate PRD with selected facts
        const w = window as any;
        if (typeof w.runFullPipeline === 'function') {
          w.runFullPipeline();
        }
      } catch (e: any) {
        showToast(e.message, true);
        saveBtn.disabled = false;
        saveBtn.textContent = t('triage.save');
      }
    });
  } catch (e: any) {
    const loadingEl = modal.querySelector('.triage-loading');
    if (loadingEl) loadingEl.textContent = `Error: ${e.message}`;
  }
}
