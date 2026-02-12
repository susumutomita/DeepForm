// === DeepForm Admin Analytics Dashboard ===
import { escapeHtml } from './ui';

interface ViewsByDay {
  day: string;
  views: number;
  visitors: number;
}

interface TopPage {
  path: string;
  views: number;
  visitors: number;
}

interface TopReferer {
  referer: string;
  count: number;
}

interface RecentVisitor {
  session_fingerprint: string;
  ip_address: string;
  user_agent: string;
  user_id: string | null;
  last_seen: string;
  page_views: number;
}

interface AnalyticsStats {
  period: string;
  totalViews: number;
  uniqueVisitors: number;
  uniqueUsers: number;
  viewsByDay: ViewsByDay[];
  topPages: TopPage[];
  topReferers: TopReferer[];
  recentVisitors: RecentVisitor[];
}

let currentPeriod = '7d';

async function fetchStats(period: string): Promise<AnalyticsStats> {
  const res = await fetch(`/api/admin/analytics/stats?period=${period}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function renderBarChart(data: ViewsByDay[]): string {
  if (!data.length) return '<p class="analytics-empty">No data for this period.</p>';
  const maxViews = Math.max(...data.map(d => d.views), 1);
  const bars = data.map(d => {
    const pct = Math.round((d.views / maxViews) * 100);
    const label = d.day.slice(5); // MM-DD
    return `
      <div class="analytics-bar-group">
        <div class="analytics-bar-label">${escapeHtml(label)}</div>
        <div class="analytics-bar-track">
          <div class="analytics-bar-fill" style="width:${pct}%" title="${d.views} views, ${d.visitors} visitors"></div>
        </div>
        <div class="analytics-bar-value">${d.views}</div>
      </div>`;
  }).join('');
  return `<div class="analytics-bar-chart">${bars}</div>`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const ths = headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
  const trs = rows.map(r =>
    `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`
  ).join('');
  return `<table class="analytics-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

function truncateUA(ua: string): string {
  if (ua.length <= 60) return escapeHtml(ua);
  return `<span title="${escapeHtml(ua)}">${escapeHtml(ua.slice(0, 57))}…</span>`;
}

function renderDashboard(stats: AnalyticsStats): string {
  const periodButtons = ['24h', '7d', '30d'].map(p =>
    `<button class="analytics-period-btn ${p === stats.period ? 'active' : ''}" onclick="window.__setAnalyticsPeriod('${p}')">${p}</button>`
  ).join('');

  const topPagesRows = stats.topPages.map(p => [
    escapeHtml(p.path), String(p.views), String(p.visitors)
  ]);

  const topReferersRows = stats.topReferers.map(r => [
    escapeHtml(r.referer), String(r.count)
  ]);

  const visitorsRows = stats.recentVisitors.map(v => [
    `<code>${escapeHtml(v.session_fingerprint)}</code>`,
    escapeHtml(v.ip_address),
    truncateUA(v.user_agent),
    v.user_id ? escapeHtml(v.user_id.slice(0, 8)) + '…' : '—',
    String(v.page_views),
    escapeHtml(v.last_seen.replace('T', ' ').slice(0, 19)),
  ]);

  return `
    <div class="analytics-dashboard">
      <div class="analytics-header">
        <h2>📊 Analytics Dashboard</h2>
        <div class="analytics-period-selector">${periodButtons}</div>
      </div>

      <div class="analytics-cards">
        <div class="analytics-card">
          <div class="analytics-card-value">${stats.totalViews.toLocaleString()}</div>
          <div class="analytics-card-label">Total Views</div>
        </div>
        <div class="analytics-card">
          <div class="analytics-card-value">${stats.uniqueVisitors.toLocaleString()}</div>
          <div class="analytics-card-label">Unique Visitors</div>
        </div>
        <div class="analytics-card">
          <div class="analytics-card-value">${stats.uniqueUsers.toLocaleString()}</div>
          <div class="analytics-card-label">Logged-in Users</div>
        </div>
      </div>

      <div class="analytics-section">
        <h3>Views by Day</h3>
        ${renderBarChart(stats.viewsByDay)}
      </div>

      <div class="analytics-section">
        <h3>Top Pages</h3>
        ${topPagesRows.length
          ? renderTable(['Path', 'Views', 'Visitors'], topPagesRows)
          : '<p class="analytics-empty">No page data yet.</p>'
        }
      </div>

      <div class="analytics-section">
        <h3>Top Referers</h3>
        ${topReferersRows.length
          ? renderTable(['Referer', 'Count'], topReferersRows)
          : '<p class="analytics-empty">No referer data yet.</p>'
        }
      </div>

      <div class="analytics-section">
        <h3>Recent Visitors</h3>
        ${visitorsRows.length
          ? renderTable(['Fingerprint', 'IP', 'User Agent', 'User', 'Pages', 'Last Seen'], visitorsRows)
          : '<p class="analytics-empty">No visitor data yet.</p>'
        }
      </div>
    </div>
  `;
}

export async function showAnalytics(): Promise<void> {
  const main = document.getElementById('main-content');
  if (!main) return;

  // Hide all existing pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  // Find or create analytics container
  let container = document.getElementById('analytics-page');
  if (!container) {
    container = document.createElement('section');
    container.id = 'analytics-page';
    container.className = 'page';
    main.appendChild(container);
  }
  container.classList.add('active');
  container.innerHTML = '<div class="analytics-loading">Loading analytics…</div>';

  // Expose period setter
  (window as any).__setAnalyticsPeriod = async (period: string) => {
    currentPeriod = period;
    await showAnalytics();
  };

  try {
    const stats = await fetchStats(currentPeriod);
    container.innerHTML = renderDashboard(stats);
  } catch (e: any) {
    container.innerHTML = `
      <div class="analytics-dashboard">
        <div class="analytics-header"><h2>📊 Analytics Dashboard</h2></div>
        <div class="analytics-error">
          <p>⚠️ ${escapeHtml(e.message)}</p>
          <p>You need admin access to view analytics.</p>
        </div>
      </div>
    `;
  }
}
