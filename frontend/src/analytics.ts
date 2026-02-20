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

interface KPIData {
  period: string;
  users: { total: number; pro: number };
  sessions: {
    inPeriod: number;
    total: number;
    guest: number;
    byStatus: Array<{ status: string; count: number }>;
  };
  funnel: {
    pageViews: number;
    sessionsCreated: number;
    interviewStarted: number;
    specReached: number;
  };
  avgMessagesPerSession: number;
  countries: Array<{ country: string; views: number; visitors: number }>;
}

interface CountryInfo { flag: string; name: string }

const COUNTRY_MAP: Record<string, CountryInfo> = {
  JP: { flag: '\uD83C\uDDEF\uD83C\uDDF5', name: 'Japan' },
  US: { flag: '\uD83C\uDDFA\uD83C\uDDF8', name: 'US' },
  DE: { flag: '\uD83C\uDDE9\uD83C\uDDEA', name: 'Germany' },
  CH: { flag: '\uD83C\uDDE8\uD83C\uDDED', name: 'Switzerland' },
  IN: { flag: '\uD83C\uDDEE\uD83C\uDDF3', name: 'India' },
  GE: { flag: '\uD83C\uDDEC\uD83C\uDDEA', name: 'Georgia' },
  NL: { flag: '\uD83C\uDDF3\uD83C\uDDF1', name: 'Netherlands' },
  AU: { flag: '\uD83C\uDDE6\uD83C\uDDFA', name: 'Australia' },
  SG: { flag: '\uD83C\uDDF8\uD83C\uDDEC', name: 'Singapore' },
  RO: { flag: '\uD83C\uDDF7\uD83C\uDDF4', name: 'Romania' },
  ES: { flag: '\uD83C\uDDEA\uD83C\uDDF8', name: 'Spain' },
  CN: { flag: '\uD83C\uDDE8\uD83C\uDDF3', name: 'China' },
  GB: { flag: '\uD83C\uDDEC\uD83C\uDDE7', name: 'UK' },
  CA: { flag: '\uD83C\uDDE8\uD83C\uDDE6', name: 'Canada' },
  FR: { flag: '\uD83C\uDDEB\uD83C\uDDF7', name: 'France' },
  BR: { flag: '\uD83C\uDDE7\uD83C\uDDF7', name: 'Brazil' },
  KR: { flag: '\uD83C\uDDF0\uD83C\uDDF7', name: 'Korea' },
  IT: { flag: '\uD83C\uDDEE\uD83C\uDDF9', name: 'Italy' },
  PK: { flag: '\uD83C\uDDF5\uD83C\uDDF0', name: 'Pakistan' },
  NO: { flag: '\uD83C\uDDF3\uD83C\uDDF4', name: 'Norway' },
  IE: { flag: '\uD83C\uDDEE\uD83C\uDDEA', name: 'Ireland' },
  PT: { flag: '\uD83C\uDDF5\uD83C\uDDF9', name: 'Portugal' },
  HK: { flag: '\uD83C\uDDED\uD83C\uDDF0', name: 'Hong Kong' },
  TR: { flag: '\uD83C\uDDF9\uD83C\uDDF7', name: 'Turkey' },
};

function countryLabel(code: string): string {
  const info = COUNTRY_MAP[code];
  return info ? `${info.flag} ${info.name}` : code;
}

let currentPeriod = '7d';
let currentTab: 'kpi' | 'traffic' | 'visitors' = 'kpi';

async function fetchStats(period: string): Promise<AnalyticsStats> {
  const res = await fetch(`/api/admin/analytics/stats?period=${period}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchKPIs(period: string): Promise<KPIData> {
  const res = await fetch(`/api/admin/analytics/kpis?period=${period}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function renderBarChart(data: ViewsByDay[]): string {
  if (!data.length) return '<p class="analytics-empty">No data.</p>';
  const max = Math.max(...data.map(d => d.views), 1);
  return `<div class="analytics-bar-chart">${data.map(d => {
    const pct = Math.round((d.views / max) * 100);
    return `<div class="analytics-bar-group">
      <div class="analytics-bar-label">${escapeHtml(d.day.slice(5))}</div>
      <div class="analytics-bar-track"><div class="analytics-bar-fill" style="width:${pct}%" title="${d.views} views"></div></div>
      <div class="analytics-bar-value">${d.views}</div>
    </div>`;
  }).join('')}</div>`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const ths = headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
  const trs = rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<div class="table-scroll"><table class="analytics-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

function pct(part: number, total: number): string {
  if (total === 0) return '\u2014';
  return `${Math.round((part / total) * 100)}%`;
}

function renderFunnel(funnel: KPIData['funnel'] & { pageViews: number }): string {
  const steps = [
    { label: 'Page Views', value: funnel.pageViews, rate: '' },
    { label: 'Session Created', value: funnel.sessionsCreated, rate: pct(funnel.sessionsCreated, funnel.pageViews) },
    { label: 'Interview Started', value: funnel.interviewStarted, rate: pct(funnel.interviewStarted, funnel.sessionsCreated) },
    { label: 'Spec Reached', value: funnel.specReached, rate: pct(funnel.specReached, funnel.interviewStarted) },
  ];
  const maxVal = Math.max(...steps.map(s => s.value), 1);
  return `<div class="funnel-chart">${steps.map(s => {
    const w = Math.max(Math.round((s.value / maxVal) * 100), 8);
    return `<div class="funnel-step"><div class="funnel-bar" style="width:${w}%">
      <span class="funnel-label">${escapeHtml(s.label)}</span>
      <span class="funnel-value">${s.value.toLocaleString()}${s.rate ? ` (${s.rate})` : ''}</span>
    </div></div>`;
  }).join('')}</div>`;
}

function renderCountries(countries: KPIData['countries']): string {
  if (!countries.length) return '<p class="analytics-empty">No country data.</p>';
  const max = Math.max(...countries.map(c => c.visitors), 1);
  return `<div class="country-chart">${countries.map(c => {
    const w = Math.round((c.visitors / max) * 100);
    return `<div class="country-row">
      <div class="country-name">${countryLabel(c.country)}</div>
      <div class="country-bar-track"><div class="country-bar-fill" style="width:${w}%"></div></div>
      <div class="country-value">${c.visitors}</div>
    </div>`;
  }).join('')}</div>`;
}

function renderKPITab(stats: AnalyticsStats, kpis: KPIData): string {
  const funnel = { ...kpis.funnel, pageViews: Number(stats.totalViews) };
  return `
    <div class="analytics-cards">
      <div class="analytics-card"><div class="analytics-card-value">${Number(kpis.users.total)}</div><div class="analytics-card-label">Users</div></div>
      <div class="analytics-card"><div class="analytics-card-value">${Number(kpis.users.pro)}</div><div class="analytics-card-label">Pro</div></div>
      <div class="analytics-card"><div class="analytics-card-value">${Number(kpis.sessions.inPeriod)}</div><div class="analytics-card-label">Sessions (${escapeHtml(kpis.period)})</div></div>
      <div class="analytics-card"><div class="analytics-card-value">${kpis.avgMessagesPerSession}</div><div class="analytics-card-label">Avg Msgs</div></div>
      <div class="analytics-card"><div class="analytics-card-value">${pct(Number(kpis.funnel.specReached), Number(kpis.funnel.interviewStarted))}</div><div class="analytics-card-label">Spec Rate</div></div>
      <div class="analytics-card"><div class="analytics-card-value">${pct(Number(kpis.sessions.guest), Number(kpis.sessions.total))}</div><div class="analytics-card-label">Guest Rate</div></div>
    </div>
    <div class="analytics-section"><h3>Conversion Funnel</h3>${renderFunnel(funnel)}</div>
    <div class="analytics-section"><h3>Countries</h3>${renderCountries(kpis.countries)}</div>
    <div class="analytics-section"><h3>Views by Day</h3>${renderBarChart(stats.viewsByDay)}</div>
  `;
}

function renderTrafficTab(stats: AnalyticsStats): string {
  return `
    <div class="analytics-cards">
      <div class="analytics-card"><div class="analytics-card-value">${stats.totalViews.toLocaleString()}</div><div class="analytics-card-label">Views</div></div>
      <div class="analytics-card"><div class="analytics-card-value">${stats.uniqueVisitors.toLocaleString()}</div><div class="analytics-card-label">Visitors</div></div>
      <div class="analytics-card"><div class="analytics-card-value">${stats.uniqueUsers.toLocaleString()}</div><div class="analytics-card-label">Logged-in</div></div>
    </div>
    <div class="analytics-section"><h3>Top Pages</h3>
      ${stats.topPages.length ? renderTable(['Path', 'Views', 'Visitors'], stats.topPages.map(p => [escapeHtml(p.path), String(p.views), String(p.visitors)])) : '<p class="analytics-empty">No data.</p>'}
    </div>
    <div class="analytics-section"><h3>Top Referers</h3>
      ${stats.topReferers.length ? renderTable(['Referer', 'Count'], stats.topReferers.map(r => [escapeHtml(r.referer), String(r.count)])) : '<p class="analytics-empty">No data.</p>'}
    </div>
  `;
}

function renderVisitorsTab(stats: AnalyticsStats): string {
  const rows = stats.recentVisitors.map(v => [
    `<code>${escapeHtml(v.session_fingerprint)}</code>`,
    v.user_id ? escapeHtml(v.user_id.slice(0, 8)) + '\u2026' : '\u2014',
    String(v.page_views),
    escapeHtml((v.user_agent || '').slice(0, 40)),
    escapeHtml(v.last_seen.replace('T', ' ').slice(5, 16)),
  ]);
  return `<div class="analytics-section"><h3>Recent Visitors</h3>
    ${rows.length ? renderTable(['FP', 'User', 'PV', 'UA', 'Seen'], rows) : '<p class="analytics-empty">No data.</p>'}
  </div>`;
}

function renderDashboard(stats: AnalyticsStats, kpis: KPIData): string {
  const periodBtns = ['24h', '7d', '30d'].map(p =>
    `<button class="analytics-period-btn ${p === stats.period ? 'active' : ''}" onclick="window.__setAnalyticsPeriod('${p}')">${p}</button>`
  ).join('');
  const tabBtns = [
    { id: 'kpi', label: 'KPI' },
    { id: 'traffic', label: 'Traffic' },
    { id: 'visitors', label: 'Visitors' },
  ].map(t =>
    `<button class="analytics-tab-btn ${t.id === currentTab ? 'active' : ''}" onclick="window.__setAnalyticsTab('${t.id}')">${t.label}</button>`
  ).join('');

  let content = '';
  if (currentTab === 'kpi') content = renderKPITab(stats, kpis);
  else if (currentTab === 'traffic') content = renderTrafficTab(stats);
  else content = renderVisitorsTab(stats);

  return `<div class="analytics-dashboard">
    <div class="analytics-header">
      <h2>\uD83D\uDCCA Analytics</h2>
      <div class="analytics-controls">
        <div class="analytics-tab-selector">${tabBtns}</div>
        <div class="analytics-period-selector">${periodBtns}</div>
      </div>
    </div>
    ${content}
  </div>`;
}

export async function showAnalytics(): Promise<void> {
  const main = document.getElementById('main-content');
  if (!main) return;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  let container = document.getElementById('analytics-page');
  if (!container) {
    container = document.createElement('section');
    container.id = 'analytics-page';
    container.className = 'page';
    main.appendChild(container);
  }
  container.classList.add('active');
  container.innerHTML = '<div class="analytics-loading">Loading\u2026</div>';

  (window as any).__setAnalyticsPeriod = async (p: string) => { currentPeriod = p; await showAnalytics(); };
  (window as any).__setAnalyticsTab = async (t: string) => { currentTab = t as typeof currentTab; await showAnalytics(); };

  try {
    const [stats, kpis] = await Promise.all([fetchStats(currentPeriod), fetchKPIs(currentPeriod)]);
    container.innerHTML = renderDashboard(stats, kpis);
  } catch (e: any) {
    container.innerHTML = `<div class="analytics-dashboard">
      <div class="analytics-header"><h2>\uD83D\uDCCA Analytics</h2></div>
      <div class="analytics-error"><p>\u26A0\uFE0F ${escapeHtml(e.message)}</p><p>Admin access required.</p></div>
    </div>`;
  }
}
