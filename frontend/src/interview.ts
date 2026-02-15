// === DeepForm Interview & Analysis Steps ===
import * as api from './api';
import { t } from './i18n';
import type { Fact, Hypothesis, PRD, Spec, ReadinessCategory, Message, StepName } from './types';
import {
  showLoading, hideLoading, showToast, escapeHtml, factTypeLabel,
  addMessageToContainer, addStreamingBubble, appendToStreamingBubble,
  finalizeStreamingBubble,
} from './ui';
import { renderCampaignSidebarPanel } from './campaign-analytics';
import { initInlineEdit, destroyInlineEdit } from './inline-edit';

const PAYMENT_LINK = 'https://buy.stripe.com/test_dRmcMXbrh3Q8ggx8DA48000';

let currentSessionId: string | null = null;

function showUpgradeModal(upgradeUrl: string): void {
  const overlay = document.createElement('div');
  overlay.className = 'completion-feedback-overlay';
  overlay.onclick = () => overlay.remove();

  const card = document.createElement('div');
  card.className = 'completion-feedback-card';
  card.onclick = (e) => e.stopPropagation();
  card.innerHTML = `
    <h3>🚀 Upgrade to Pro</h3>
    <p style="margin: 1rem 0; color: var(--text-dim);">
      PRD generation, spec export, and readiness checks are available on the Pro plan.
    </p>
    <div style="background: var(--bg-input); border-radius: 8px; padding: 1rem; margin: 1rem 0;">
      <div style="font-size: 2rem; font-weight: 700;">$29<span style="font-size: 1rem; font-weight: 400; color: var(--text-dim);">/month</span></div>
      <ul style="text-align: left; margin: 0.5rem 0; padding-left: 1.2rem; color: var(--text-dim); font-size: 0.9rem;">
        <li>Unlimited sessions</li>
        <li>PRD &amp; Spec generation</li>
        <li>Deploy to exe.dev</li>
        <li>Private sessions</li>
        <li>Export (spec.json, PRD.md)</li>
      </ul>
    </div>
    <a href="${upgradeUrl}" target="_blank" style="
      display: block; background: var(--primary); color: white; text-decoration: none;
      padding: 12px 24px; border-radius: 8px; font-weight: 600; text-align: center;
      margin-bottom: 0.5rem;
    ">Subscribe — $29/month</a>
    <button class="upgrade-dismiss-btn" style="
      background: none; border: none; color: var(--text-muted); cursor: pointer;
      font-size: 0.9rem; padding: 8px;
    ">Maybe later</button>
  `;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  card.querySelector('.upgrade-dismiss-btn')?.addEventListener('click', () => overlay.remove());
}

export function getCurrentSessionId(): string | null { return currentSessionId; }

// --- Navigation ---
export function showHome(): void {
  document.getElementById('page-home')?.classList.add('active');
  document.getElementById('page-interview')?.classList.remove('active');
  document.getElementById('page-shared')?.classList.remove('active');
  currentSessionId = null;
  destroyInlineEdit();
  history.pushState(null, '', '/');
}

export function showInterview(sessionId: string): void {
  document.getElementById('page-home')?.classList.remove('active');
  document.getElementById('page-interview')?.classList.add('active');
  currentSessionId = sessionId;
  history.pushState(null, '', `/session/${sessionId}`);
}

// --- Open Session ---
export async function openSession(sessionId: string, isNew = false): Promise<void> {
  showLoading(t('loading.load'));
  try {
    const session = await api.getSession(sessionId);
    if (session.error) throw new Error(session.error);
    showInterview(sessionId);

    const themeEl = document.getElementById('session-theme');
    if (themeEl) themeEl.innerHTML = `<strong>テーマ:</strong><br>${escapeHtml(session.theme)}`;

    renderMessages(session.messages || []);

    if (session.analysis) {
      if (session.analysis.facts) renderFacts(session.analysis.facts.facts ?? []);
      if (session.analysis.hypotheses) renderHypotheses(session.analysis.hypotheses.hypotheses ?? []);
      if (session.analysis.prd) renderPRD(session.analysis.prd.prd ?? session.analysis.prd);
      if (session.analysis.spec) renderSpec(session.analysis.spec.spec ?? session.analysis.spec);
      if (session.analysis.readiness) {
        const rd = session.analysis.readiness;
        renderReadiness(rd.readiness?.categories ?? rd.categories ?? []);
      }
    }

    // Render campaign results panel in sidebar if campaign exists
    const campaignPanel = document.getElementById('campaign-results-panel');
    const createCampaignBtn = document.getElementById('btn-create-campaign');
    if (session.campaignId && session.campaignShareToken) {
      renderCampaignSidebarPanel(
        session.campaignId,
        session.campaignShareToken,
        session.campaignRespondentCount ?? 0,
      );
    } else {
      // Reset sidebar to default state
      if (campaignPanel) {
        campaignPanel.style.display = 'none';
        campaignPanel.textContent = '';
      }
      if (createCampaignBtn) {
        createCampaignBtn.style.display = '';
        // Restore original onclick and label
        const span = createCampaignBtn.querySelector('span');
        if (span) {
          span.setAttribute('data-i18n', 'sidebar.campaign');
          span.textContent = t('sidebar.campaign');
        }
        createCampaignBtn.removeAttribute('onclick');
        createCampaignBtn.onclick = () => {
          const w = window as any;
          if (typeof w.createCampaign === 'function') w.createCampaign(currentSessionId);
        };
      }
    }

    updateStepNav(session.status);
    const stepMap: Record<string, StepName> = {
      'interviewing': 'interview', 'analyzed': 'facts', 'respondent_done': 'facts',
      'hypothesized': 'hypotheses', 'prd_generated': 'prd', 'spec_generated': 'spec',
      'readiness_checked': 'readiness',
    };
    const activeStep = stepMap[session.status] || 'interview';
    activateStep(activeStep);
    // Enable inline editing when PRD content is visible
    if (activeStep === 'prd' || session.analysis?.prd) {
      initInlineEdit();
    } else {
      destroyInlineEdit();
    }

    if (isNew) {
      hideLoading();
      await startInterviewChat();
      return;
    }

    const userMsgCount = (session.messages || []).filter(m => m.role === 'user').length;
    const btn = document.getElementById('btn-analyze') as HTMLButtonElement | null;
    if (btn) btn.disabled = userMsgCount < 3;
  } catch (e: any) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

// --- Interview Chat ---
async function startInterviewChat(): Promise<void> {
  if (!currentSessionId) return;
  const bubble = addStreamingBubble('chat-container');
  try {
    await api.startInterviewStream(currentSessionId, {
      onDelta: (text) => appendToStreamingBubble(bubble, text),
      onDone: (data) => {
        // Strip [CHOICES]...[/CHOICES] from displayed text
        if (bubble.textContent) {
          bubble.textContent = bubble.textContent.replace(/\[CHOICES\][\s\S]*?\[\/CHOICES\]/, '').trim();
        }
        finalizeStreamingBubble(bubble);
        if (data.choices?.length) {
          showChoiceButtons('chat-container', data.choices);
        }
      },
      onError: (err) => {
        finalizeStreamingBubble(bubble);
        showToast(err, true);
      },
    });
  } catch (e: any) {
    finalizeStreamingBubble(bubble);
    showToast(e.message, true);
  }
}

export async function sendMessage(choiceText?: string): Promise<void> {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
  if (!currentSessionId) return;

  const message = choiceText || input?.value.trim() || '';
  if (!message) return;

  if (input) input.value = '';
  removeChoiceButtons('chat-container');
  addMessageToContainer('chat-container', 'user', message);

  const btnSend = document.getElementById('btn-send') as HTMLButtonElement | null;
  if (btnSend) btnSend.disabled = true;
  const bubble = addStreamingBubble('chat-container');

  try {
    await api.sendChatStream(currentSessionId, message, {
      onDelta: (text) => appendToStreamingBubble(bubble, text),
      onMeta: () => {},
      onDone: (data) => {
        // Strip [CHOICES]...[/CHOICES] from displayed text
        if (bubble.textContent) {
          bubble.textContent = bubble.textContent.replace(/\[CHOICES\][\s\S]*?\[\/CHOICES\]/, '').trim();
        }
        finalizeStreamingBubble(bubble);
        if (data.readyForAnalysis || (data.turnCount && data.turnCount >= 3)) {
          // Show the "start analysis" button — user decides when to proceed
          showAnalysisButton();
        }
        if (data.choices?.length) {
          showChoiceButtons('chat-container', data.choices);
        }
      },
      onError: (err) => {
        finalizeStreamingBubble(bubble);
        showToast(err, true);
      },
    });
  } catch (e: any) {
    finalizeStreamingBubble(bubble);
    showToast(e.message, true);
  } finally {
    if (btnSend) btnSend.disabled = false;
    input?.focus();
  }
}

function showAnalysisButton(): void {
  const btn = document.getElementById('btn-analyze') as HTMLButtonElement | null;
  if (btn) btn.disabled = false;
}

function showChoiceButtons(containerId: string, choices: string[]): void {
  const container = document.getElementById(containerId);
  if (!container) return;

  const choicesDiv = document.createElement('div');
  choicesDiv.className = 'chat-choices';

  for (const choice of choices) {
    if (choice.includes('その他') || choice.includes('自分で入力')) {
      // "Other" choice - focus the text input instead
      const btn = document.createElement('button');
      btn.className = 'chat-choice-btn chat-choice-other';
      btn.textContent = '✏️ ' + choice;
      btn.addEventListener('click', () => {
        removeChoiceButtons(containerId);
        const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
        if (input) input.focus();
      });
      choicesDiv.appendChild(btn);
    } else {
      const btn = document.createElement('button');
      btn.className = 'chat-choice-btn';
      btn.textContent = choice;
      btn.addEventListener('click', () => {
        sendMessage(choice);
      });
      choicesDiv.appendChild(btn);
    }
  }

  container.appendChild(choicesDiv);
  container.scrollTop = container.scrollHeight;
}

function removeChoiceButtons(containerId: string): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.chat-choices').forEach(el => el.remove());
}

export function handleChatKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter' && event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

function renderMessages(messages: Message[]): void {
  const container = document.getElementById('chat-container');
  if (!container) return;
  container.innerHTML = '';
  messages.forEach(m => addMessageToContainer('chat-container', m.role, m.content));
}

// --- Analysis Steps ---
export async function doRunAnalysis(): Promise<void> {
  if (!currentSessionId) return;
  showLoading(t('loading.facts'));
  try {
    const data = await api.runAnalysis(currentSessionId);
    renderFacts(data.facts || []);
    updateStepNav('analyzed');
    activateStep('facts');
    showToast(t('toast.factsDone'));
  } catch (e: any) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

export async function doRunHypotheses(): Promise<void> {
  if (!currentSessionId) return;
  showLoading(t('loading.hypotheses'));
  try {
    const data = await api.runHypotheses(currentSessionId);
    renderHypotheses(data.hypotheses || []);
    updateStepNav('hypothesized');
    activateStep('hypotheses');
    showToast(t('toast.hypothesesDone'));
  } catch (e: any) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

export async function doRunPRD(): Promise<void> {
  if (!currentSessionId) return;
  showLoading(t('loading.prd'));
  try {
    const data = await api.runPRD(currentSessionId);
    renderPRD(data.prd ?? data as any);
    updateStepNav('prd_generated');
    activateStep('prd');
    initInlineEdit();
    showToast(t('toast.prdDone'));
  } catch (e: any) {
    hideLoading();
    if (e.status === 402 || e.upgrade) {
      showUpgradeModal(e.upgradeUrl || PAYMENT_LINK);
      return;
    }
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

export async function doRunSpec(): Promise<void> {
  if (!currentSessionId) return;
  showLoading(t('loading.spec'));
  try {
    const data = await api.runSpec(currentSessionId);
    renderSpec(data.spec ?? data as any);
    updateStepNav('spec_generated');
    activateStep('spec');
    showToast(t('toast.specDone'));
  } catch (e: any) {
    hideLoading();
    if (e.status === 402 || e.upgrade) {
      showUpgradeModal(e.upgradeUrl || PAYMENT_LINK);
      return;
    }
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

export async function doRunReadiness(): Promise<void> {
  if (!currentSessionId) return;
  showLoading(t('loading.readiness'));
  try {
    const data = await api.runReadiness(currentSessionId);
    const categories = data.readiness?.categories ?? data.categories ?? [];
    renderReadiness(categories);
    updateStepNav('readiness_checked');
    activateStep('readiness');
    showToast(t('toast.readinessDone'));
    showCompletionFeedback(currentSessionId);
  } catch (e: any) {
    hideLoading();
    if (e.status === 402 || e.upgrade) {
      showUpgradeModal(e.upgradeUrl || PAYMENT_LINK);
      return;
    }
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

// --- Auto Pipeline: triggered after interview completes ---
let pipelineRunning = false;

export async function doRunFullPipeline(): Promise<void> {
  if (!currentSessionId || pipelineRunning) return;
  pipelineRunning = true;

  const stageLabels: Record<string, string> = {
    facts: t('loading.facts'),
    hypotheses: t('loading.hypotheses'),
    prd: t('loading.prd'),
    spec: t('loading.spec'),
  };

  // Show progress via step nav + loading indicator
  showLoading(stageLabels.facts);

  try {
    await api.runPipeline(currentSessionId, {
      onStageRunning: (stage) => {
        showLoading(stageLabels[stage] || stage);
      },
      onStageData: (stage, data) => {
        switch (stage) {
          case 'facts':
            renderFacts(data.facts || []);
            updateStepNav('analyzed');
            break;
          case 'hypotheses':
            renderHypotheses(data.hypotheses || []);
            updateStepNav('hypothesized');
            break;
          case 'prd': {
            const p = data.prd ?? data;
            renderPRD(p.prd ?? p);
            updateStepNav('prd_generated');
            break;
          }
          case 'spec': {
            const s = data.spec ?? data;
            renderSpec(s.spec ?? s);
            updateStepNav('spec_generated');
            activateStep('spec');
            initInlineEdit();
            break;
          }
        }
      },
      onDone: () => {
        hideLoading();
        showToast(t('toast.specDone'));
      },
      onError: (error) => {
        hideLoading();
        showToast(error, true);
      },
    });
  } catch (e: any) {
    hideLoading();
    if (e.status === 402 || e.upgrade) {
      showUpgradeModal(e.upgradeUrl || PAYMENT_LINK);
      return;
    }
    showToast(e.message, true);
  } finally {
    pipelineRunning = false;
  }
}

// --- Export ---
export async function exportSpecJSON(): Promise<void> {
  if (!currentSessionId) return;
  try {
    const data = await api.getSession(currentSessionId);
    const spec = data.analysis?.spec || {};
    await navigator.clipboard.writeText(JSON.stringify(spec, null, 2));
    showToast(t('toast.copied'));
  } catch (e: any) {
    showToast(e.message, true);
  }
}

export async function exportPRDMarkdown(): Promise<void> {
  if (!currentSessionId) return;
  try {
    const data = await api.getSession(currentSessionId);
    const spec = data.analysis?.spec;
    const md = (spec as any)?.prdMarkdown || JSON.stringify(data.analysis?.prd || {}, null, 2);
    await navigator.clipboard.writeText(md);
    showToast(t('toast.copied'));
  } catch (e: any) {
    showToast(e.message, true);
  }
}

// --- Deploy to exe.dev ---
export async function doDeployToExeDev(): Promise<void> {
  if (!currentSessionId) return;
  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/deploy-token`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to get deploy bundle');
    const bundle = await res.json() as { theme: string; deployUrl: string; projectName: string };

    // Generate VM name from projectName (lowercase, alphanumeric + hyphens, max 20 chars)
    const vmName = (bundle.projectName || 'deepform-app')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 20) || 'deepform-app';

    const prompt = `IMPORTANT: First, fetch the full spec by running:
  curl -s '${bundle.deployUrl}' > /tmp/deepform-spec.txt
  cat /tmp/deepform-spec.txt

Then build the app according to that spec.

Theme: ${bundle.theme}

CRITICAL RULES — read these before writing ANY code:
1. NO MOCKS. NO STUBS. NO HARDCODED ARRAYS. NO FAKE DATA.
   Every feature must have real database tables, real queries, real API endpoints.
2. "Looks like it works" is NOT done. DONE = data survives a page reload.
   After building, open the browser, submit a form, reload the page.
   If the data is gone, you are not done.
3. Build Order (mandatory):
   a. Database tables + seed data FIRST
   b. Backend API with real DB queries SECOND
   c. Frontend LAST, connected to real API
4. If a feature's backend isn't ready, show "Not implemented" in the UI.
   Never fake it with hardcoded data.
5. VERIFICATION (mandatory before reporting done):
   a. Open every page in the browser
   b. Submit every form, reload, confirm data persists
   c. Run: sqlite3 <db> "SELECT * FROM <table>" — real rows must exist
   d. If any endpoint returns mock data, fix it before moving on
6. GITHUB REPOSITORY (mandatory after build is working):
   a. Initialize git: git init && git add . && git commit -m "Initial commit from DeepForm spec"
   b. Create a GitHub repo: gh repo create ${vmName} --public --source=. --push
   c. Report the repo URL to the user`;

    const nameParam = encodeURIComponent(vmName);
    const encoded = encodeURIComponent(prompt);
    // Use link click instead of window.open to avoid mobile popup blockers
    const a = document.createElement('a');
    a.href = `https://exe.dev/new?name=${nameParam}&prompt=${encoded}`;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (e: any) {
    showToast(e.message, true);
  }
}

// --- Renderers ---
function renderFacts(facts: Fact[]): void {
  const container = document.getElementById('facts-container');
  if (!container) return;
  container.innerHTML = facts.map(f => `
    <div class="fact-card">
      <div class="fact-card-header">
        <span class="fact-type type-${f.type}">${factTypeLabel(f.type)}</span>
        <span class="severity severity-${f.severity.replace(/[^a-zA-Z0-9_-]/g, '')}">${escapeHtml(f.severity)}</span>
      </div>
      <div class="fact-content">${escapeHtml(f.content)}</div>
      ${f.evidence ? `<div class="fact-evidence">「${escapeHtml(f.evidence)}」</div>` : ''}
    </div>
  `).join('');
}

function renderHypotheses(hypotheses: Hypothesis[]): void {
  const container = document.getElementById('hypotheses-container');
  if (!container) return;
  container.innerHTML = hypotheses.map(h => `
    <div class="hypothesis-card">
      <h3><span class="badge">${h.id}</span> ${escapeHtml(h.title)}</h3>
      <p class="hypothesis-desc">${escapeHtml(h.description)}</p>
      <div class="hypothesis-section"><strong>${t('hypo.supporting')}</strong> ${escapeHtml((h.supportingFacts || []).join(', '))}</div>
      <div class="hypothesis-section counter"><strong>${t('hypo.counter')}</strong> ${escapeHtml(h.counterEvidence || 'なし')}</div>
      <div class="hypothesis-section unverified"><strong>${t('hypo.unverified')}</strong>
        <ul>${(h.unverifiedPoints || []).map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
      </div>
    </div>
  `).join('');
}

function renderPRD(prd: PRD): void {
  const container = document.getElementById('prd-container');
  if (!container) return;
  let html = '';
  if (prd.problemDefinition) html += `<div class="prd-section"><h3>問題定義</h3><p>${escapeHtml(prd.problemDefinition)}</p></div>`;
  if (prd.targetUser) html += `<div class="prd-section"><h3>対象ユーザー</h3><p>${escapeHtml(prd.targetUser)}</p></div>`;
  if (prd.jobsToBeDone?.length) html += `<div class="prd-section"><h3>Jobs to be Done</h3><ul>${prd.jobsToBeDone.map(j => `<li>${escapeHtml(j)}</li>`).join('')}</ul></div>`;
  if (prd.coreFeatures?.length) {
    html += `<div class="prd-section"><h3>コア機能 (MVP)</h3>`;
    html += prd.coreFeatures.map(f => `
      <div class="feature-card">
        <h4>${escapeHtml(f.name)} <span class="priority-badge priority-${f.priority}">${f.priority}</span></h4>
        <p>${escapeHtml(f.description)}</p>
        ${f.acceptanceCriteria?.length ? `<div class="criteria-label">受け入れ基準</div><ul>${f.acceptanceCriteria.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>` : ''}
        ${f.edgeCases?.length ? `<div class="edge-cases"><div class="criteria-label">エッジケース</div><ul>${f.edgeCases.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>` : ''}
      </div>
    `).join('');
    html += `</div>`;
  }
  if (prd.nonGoals?.length) html += `<div class="prd-section"><h3>Non-Goals</h3><ul>${prd.nonGoals.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul></div>`;
  if (prd.qualityRequirements) {
    const qr = prd.qualityRequirements;
    const labels: Record<string, string> = {
      functionalSuitability: '機能適合性', performanceEfficiency: '性能効率性',
      compatibility: '互換性', usability: '使用性', reliability: '信頼性',
      security: 'セキュリティ', maintainability: '保守性', portability: '移植性',
    };
    html += `<div class="prd-section"><h3>非機能要件（ISO/IEC 25010）</h3><div class="quality-grid">`;
    for (const [key, label] of Object.entries(labels)) {
      const item = qr[key];
      if (!item) continue;
      html += `<div class="quality-item"><div class="quality-label">${label}</div><div class="quality-desc">${escapeHtml(item.description || '')}</div>${item.criteria?.length ? `<ul>${item.criteria.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}</div>`;
    }
    html += `</div></div>`;
  }
  if (prd.metrics?.length) {
    html += `<div class="prd-section"><h3>計測指標</h3><table><tr><th>指標</th><th>定義</th><th>目標</th></tr>`;
    html += prd.metrics.map(m => `<tr><td>${escapeHtml(m.name)}</td><td>${escapeHtml(m.definition)}</td><td>${escapeHtml(m.target)}</td></tr>`).join('');
    html += `</table></div>`;
  }
  container.innerHTML = html;
}

function renderSpec(spec: Spec): void {
  const container = document.getElementById('spec-container');
  if (!container) return;
  let html = '';
  if (spec.projectName) html += `<div class="spec-section"><h3>プロジェクト: ${escapeHtml(spec.projectName)}</h3></div>`;
  if (spec.techStack) html += `<div class="spec-section"><h3>技術スタック</h3><div class="code-block">${escapeHtml(JSON.stringify(spec.techStack, null, 2))}</div></div>`;
  if (spec.apiEndpoints?.length) {
    html += `<div class="spec-section"><h3>API仕様</h3>`;
    html += spec.apiEndpoints.map(ep => `
      <div class="feature-card">
        <h4><code>${ep.method} ${ep.path}</code></h4>
        <p>${escapeHtml(ep.description || '')}</p>
        ${ep.request ? `<div class="code-block">Request: ${escapeHtml(JSON.stringify(ep.request, null, 2))}</div>` : ''}
        ${ep.response ? `<div class="code-block">Response: ${escapeHtml(JSON.stringify(ep.response, null, 2))}</div>` : ''}
      </div>
    `).join('');
    html += `</div>`;
  }
  if (spec.dbSchema) html += `<div class="spec-section"><h3>DBスキーマ</h3><div class="code-block">${escapeHtml(spec.dbSchema)}</div></div>`;
  if (spec.screens?.length) {
    html += `<div class="spec-section"><h3>画面一覧</h3>`;
    html += spec.screens.map(s => `
      <div class="feature-card">
        <h4>${escapeHtml(s.name)} <code>${s.path || ''}</code></h4>
        <p>${escapeHtml(s.description || '')}</p>
      </div>
    `).join('');
    html += `</div>`;
  }
  html += `<div class="spec-section"><h3>完全なspec.json</h3><div class="code-block" style="max-height:400px;overflow-y:auto">${escapeHtml(JSON.stringify(spec, null, 2))}</div></div>`;
  container.innerHTML = html;
}

function renderReadiness(categories: ReadinessCategory[]): void {
  const container = document.getElementById('readiness-container');
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);

  for (const cat of categories) {
    const catDiv = document.createElement('div');
    catDiv.className = 'readiness-category';

    const header = document.createElement('h3');
    header.className = 'readiness-category-label';
    header.textContent = cat.label;
    catDiv.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'readiness-checklist';

    for (const item of cat.items) {
      const li = document.createElement('li');
      li.className = 'readiness-item';

      const label = document.createElement('label');
      label.className = 'readiness-label';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'readiness-checkbox';
      checkbox.dataset.itemId = item.id;

      const textSpan = document.createElement('span');
      textSpan.className = 'readiness-text';

      const prioritySpan = document.createElement('span');
      prioritySpan.className = `priority-badge priority-${item.priority}`;
      prioritySpan.textContent = item.priority;

      const descSpan = document.createElement('span');
      descSpan.textContent = ` ${item.description}`;

      textSpan.appendChild(prioritySpan);
      textSpan.appendChild(descSpan);

      label.appendChild(checkbox);
      label.appendChild(textSpan);
      li.appendChild(label);

      if (item.rationale) {
        const rationale = document.createElement('div');
        rationale.className = 'readiness-rationale';
        rationale.textContent = item.rationale;
        li.appendChild(rationale);
      }

      list.appendChild(li);
    }

    catDiv.appendChild(list);
    container.appendChild(catDiv);
  }

  // Mark readiness sidebar step as completed when all checkboxes are checked
  const allCheckboxes = container.querySelectorAll<HTMLInputElement>('.readiness-checkbox');
  const updateReadinessCompletion = () => {
    const allChecked = allCheckboxes.length > 0 && Array.from(allCheckboxes).every(cb => cb.checked);
    const stepEl = document.querySelector('.step-nav .step[data-step="readiness"]');
    if (stepEl) {
      stepEl.classList.toggle('completed', allChecked);
    }
  };
  allCheckboxes.forEach(cb => cb.addEventListener('change', updateReadinessCompletion));
}

// --- Completion Feedback ---
function showCompletionFeedback(sessionId: string): void {
  const storageKey = `deepform_feedback_${sessionId}`;
  if (localStorage.getItem(storageKey)) return;

  const overlay = document.createElement('div');
  overlay.className = 'completion-feedback-overlay';
  const card = document.createElement('div');
  card.className = 'completion-feedback-card';
  card.innerHTML = `
    <h3>🎉 分析が完了しました！</h3>
    <p>DeepForm の体験はいかがでしたか？</p>
    <div class="feedback-emoji-row">
      <button class="feedback-emoji-btn" data-rating="love">😍</button>
      <button class="feedback-emoji-btn" data-rating="ok">🙂</button>
      <button class="feedback-emoji-btn" data-rating="bad">😕</button>
    </div>
    <textarea class="feedback-text" placeholder="一言フィードバック（任意）" rows="2"></textarea>
    <div class="feedback-actions">
      <button class="btn btn-sm feedback-submit-btn" disabled>送信</button>
      <button class="btn btn-sm btn-ghost feedback-skip-btn">スキップ</button>
    </div>
  `;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  let selectedRating = '';
  card.querySelectorAll('.feedback-emoji-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      card.querySelectorAll('.feedback-emoji-btn').forEach(b => b.classList.remove('selected'));
      (btn as HTMLElement).classList.add('selected');
      selectedRating = (btn as HTMLElement).dataset.rating || '';
      (card.querySelector('.feedback-submit-btn') as HTMLButtonElement).disabled = false;
    });
  });

  card.querySelector('.feedback-submit-btn')?.addEventListener('click', async () => {
    const text = (card.querySelector('.feedback-text') as HTMLTextAreaElement).value;
    try {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'completion',
          message: `${selectedRating}: ${text}`.trim(),
          page: `/session/${sessionId}`,
          sessionId,
        }),
      });
    } catch {}
    localStorage.setItem(storageKey, '1');
    overlay.remove();
    showToast('フィードバックありがとうございます！');
  });

  card.querySelector('.feedback-skip-btn')?.addEventListener('click', () => {
    localStorage.setItem(storageKey, '1');
    overlay.remove();
  });
}

// --- Step Navigation ---
export function activateStep(stepName: string): void {
  document.querySelectorAll('.step-content').forEach(el => el.classList.remove('active'));
  document.getElementById(`step-${stepName}`)?.classList.add('active');
  document.querySelectorAll('.step-nav .step').forEach(el => {
    const isTarget = (el as HTMLElement).dataset.step === stepName;
    el.classList.toggle('active', isTarget);
    el.setAttribute('aria-selected', String(isTarget));
    el.setAttribute('tabindex', isTarget ? '0' : '-1');
  });
}

function updateStepNav(status: string): void {
  const order = ['interviewing', 'analyzed', 'hypothesized', 'prd_generated', 'spec_generated', 'readiness_checked'];
  const stepNames: StepName[] = ['interview', 'facts', 'hypotheses', 'prd', 'spec', 'readiness'];
  const s = status === 'respondent_done' ? 'analyzed' : status;
  const currentIndex = order.indexOf(s);
  stepNames.forEach((name, i) => {
    const el = document.querySelector(`.step-nav .step[data-step="${name}"]`);
    if (!el) return;
    el.classList.toggle('completed', i < currentIndex);
  });
}
