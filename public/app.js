// === DeepForm Client ===

// IME対応: Shift+Enterで送信、Enterは改行
function handleChatKeydown(event) {
  // IME変換中は何もしない
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter' && event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

let currentSessionId = null;
let currentSession = null;

// --- Navigation ---
function showHome() {
  document.getElementById('page-home').classList.add('active');
  document.getElementById('page-interview').classList.remove('active');
  currentSessionId = null;
  loadSessions();
  history.pushState(null, '', '/');
}

function showInterview(sessionId) {
  document.getElementById('page-home').classList.remove('active');
  document.getElementById('page-interview').classList.add('active');
  currentSessionId = sessionId;
  history.pushState(null, '', `/session/${sessionId}`);
}

// --- Sessions ---
async function loadSessions() {
  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();
    const list = document.getElementById('sessions-list');
    if (sessions.length === 0) {
      list.innerHTML = '<p class="empty-state">まだセッションがありません</p>';
      return;
    }
    list.innerHTML = sessions.map(s => `
      <div class="session-card">
        <div class="session-card-info" onclick="openSession('${s.id}')">
          <h3>${escapeHtml(s.theme)}</h3>
          <div class="session-card-meta">
            <span>${s.message_count}メッセージ</span>
            <span>${formatDate(s.created_at)}</span>
            ${s.mode === 'shared' ? '<span class="shared-tag">共有済</span>' : ''}
            ${s.respondent_name ? `<span>${escapeHtml(s.respondent_name)}</span>` : ''}
          </div>
        </div>
        <div class="session-card-actions">
          <span class="status-badge status-${s.display_status || s.status}">${statusLabel(s.display_status || s.status)}</span>
          <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); shareSession('${s.id}')" title="共有URLをコピー">&#8599;</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    console.error('Failed to load sessions:', e);
  }
}

function statusLabel(s) {
  const map = {
    'interviewing': 'インタビュー中',
    'analyzed': 'ファクト抽出済',
    'respondent_done': '回答完了',
    'hypothesized': '仮説生成済',
    'prd_generated': 'PRD生成済',
    'spec_generated': '実装仕様完了',
  };
  return map[s] || s;
}

function formatDate(d) {
  if (!d) return '';
  const date = new Date(d + 'Z');
  return date.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// --- Start New Session ---
async function startNewSession() {
  const input = document.getElementById('theme-input');
  const theme = input.value.trim();
  if (!theme) {
    showToast('テーマを入力してください', true);
    return;
  }

  showLoading('セッションを作成中…');
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    input.value = '';
    await openSession(data.sessionId, true);
  } catch (e) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

// --- Open Session ---
async function openSession(sessionId, isNew = false) {
  showLoading('セッションを読み込み中…');
  try {
    const res = await fetch(`/api/sessions/${sessionId}`);
    const session = await res.json();
    if (session.error) throw new Error(session.error);

    currentSession = session;
    showInterview(sessionId);

    // Set theme
    document.getElementById('session-theme').innerHTML = `<strong>テーマ:</strong><br>${escapeHtml(session.theme)}`;

    // Render existing messages
    renderMessages(session.messages || []);

    // Render existing analysis
    if (session.analysis) {
      if (session.analysis.facts) renderFacts(session.analysis.facts);
      if (session.analysis.hypotheses) renderHypotheses(session.analysis.hypotheses);
      if (session.analysis.prd) renderPRD(session.analysis.prd);
      if (session.analysis.spec) renderSpec(session.analysis.spec);
    }

    // Show respondent feedback if present
    if (session.respondent_feedback) {
      const factsContainer = document.getElementById('facts-container');
      const feedbackEl = document.createElement('div');
      feedbackEl.className = 'respondent-feedback';
      feedbackEl.innerHTML = `<h4>回答者からのフィードバック</h4><p>${escapeHtml(session.respondent_feedback)}</p>`;
      factsContainer.parentElement.insertBefore(feedbackEl, factsContainer.nextSibling);
    }

    // Update step nav
    updateStepNav(session.status);

    // Navigate to appropriate step
    const stepMap = {
      'interviewing': 'interview',
      'analyzed': 'facts',
      'respondent_done': 'facts',
      'hypothesized': 'hypotheses',
      'prd_generated': 'prd',
      'spec_generated': 'spec',
    };
    activateStep(stepMap[session.status] || 'interview');

    // Start interview if new
    if (isNew) {
      hideLoading();
      await startInterview();
      return;
    }

    // Enable analyze button if enough messages
    const userMsgCount = (session.messages || []).filter(m => m.role === 'user').length;
    document.getElementById('btn-analyze').disabled = userMsgCount < 3;
  } catch (e) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

// --- Interview ---
async function startInterview() {
  showTypingIndicator();
  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    removeTypingIndicator();
    if (data.error) throw new Error(data.error);
    addMessage('assistant', data.reply);
  } catch (e) {
    removeTypingIndicator();
    showToast(e.message, true);
  }
}

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  addMessage('user', message);

  const btnSend = document.getElementById('btn-send');
  btnSend.disabled = true;
  showTypingIndicator();

  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    removeTypingIndicator();
    if (data.error) throw new Error(data.error);

    addMessage('assistant', data.reply);

    if (data.readyForAnalysis || data.turnCount >= 5) {
      document.getElementById('btn-analyze').disabled = false;
    }
  } catch (e) {
    removeTypingIndicator();
    showToast(e.message, true);
  } finally {
    btnSend.disabled = false;
    input.focus();
  }
}

function addMessage(role, content) {
  const container = document.getElementById('chat-container');
  const msg = document.createElement('div');
  msg.className = `chat-msg ${role}`;
  msg.textContent = content;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function showTypingIndicator() {
  const container = document.getElementById('chat-container');
  const msg = document.createElement('div');
  msg.className = 'chat-msg assistant typing';
  msg.id = 'typing-indicator';
  msg.textContent = '考え中';
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function removeTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

function renderMessages(messages) {
  const container = document.getElementById('chat-container');
  container.innerHTML = '';
  messages.forEach(m => addMessage(m.role, m.content));
}

// --- Analysis Steps ---
async function runAnalysis() {
  showLoading('AIがファクトを抽出中…');
  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    renderFacts(data);
    updateStepNav('analyzed');
    activateStep('facts');
    showToast('ファクト抽出が完了しました');
  } catch (e) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

async function runHypotheses() {
  showLoading('AIが仮説を生成中…');
  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/hypotheses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    renderHypotheses(data);
    updateStepNav('hypothesized');
    activateStep('hypotheses');
    showToast('仮説生成が完了しました');
  } catch (e) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

async function runPRD() {
  showLoading('AIがPRDを生成中…');
  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/prd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    renderPRD(data);
    updateStepNav('prd_generated');
    activateStep('prd');
    showToast('PRD生成が完了しました');
  } catch (e) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

async function runSpec() {
  showLoading('AIが実装仕様を生成中…');
  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/spec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    renderSpec(data);
    updateStepNav('spec_generated');
    activateStep('spec');
    showToast('実装仕様生成が完了しました');
  } catch (e) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

// --- Renderers ---
function renderFacts(data) {
  const container = document.getElementById('facts-container');
  const facts = data.facts || [];
  container.innerHTML = facts.map(f => `
    <div class="fact-card">
      <div class="fact-card-header">
        <span class="fact-type type-${f.type}">${factTypeLabel(f.type)}</span>
        <span class="severity severity-${f.severity}">${f.severity}</span>
      </div>
      <div class="fact-content">${escapeHtml(f.content)}</div>
      ${f.evidence ? `<div class="fact-evidence">「${escapeHtml(f.evidence)}」</div>` : ''}
    </div>
  `).join('');
}

function factTypeLabel(type) {
  const map = { fact: '事実', pain: '困りごと', frequency: '頻度', workaround: '回避策' };
  return map[type] || type;
}

function renderHypotheses(data) {
  const container = document.getElementById('hypotheses-container');
  const hypotheses = data.hypotheses || [];
  container.innerHTML = hypotheses.map(h => `
    <div class="hypothesis-card">
      <h3><span class="badge">${h.id}</span> ${escapeHtml(h.title)}</h3>
      <p class="hypothesis-desc">${escapeHtml(h.description)}</p>
      <div class="hypothesis-section">
        <strong>根拠ファクト:</strong> ${(h.supportingFacts || []).join(', ')}
      </div>
      <div class="hypothesis-section counter">
        <strong>反証:</strong> ${escapeHtml(h.counterEvidence || 'なし')}
      </div>
      <div class="hypothesis-section unverified">
        <strong>未検証ポイント:</strong>
        <ul>${(h.unverifiedPoints || []).map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
      </div>
    </div>
  `).join('');
}

function renderPRD(data) {
  const container = document.getElementById('prd-container');
  const prd = data.prd || data;

  let html = '';

  if (prd.problemDefinition) {
    html += `<div class="prd-section"><h3>問題定義</h3><p>${escapeHtml(prd.problemDefinition)}</p></div>`;
  }
  if (prd.targetUser) {
    html += `<div class="prd-section"><h3>対象ユーザー</h3><p>${escapeHtml(prd.targetUser)}</p></div>`;
  }
  if (prd.jobsToBeDone && prd.jobsToBeDone.length) {
    html += `<div class="prd-section"><h3>Jobs to be Done</h3><ul>${prd.jobsToBeDone.map(j => `<li>${escapeHtml(j)}</li>`).join('')}</ul></div>`;
  }
  if (prd.coreFeatures && prd.coreFeatures.length) {
    html += `<div class="prd-section"><h3>コア機能 (MVP)</h3>`;
    html += prd.coreFeatures.map(f => `
      <div class="feature-card">
        <h4>${escapeHtml(f.name)} <span class="priority-badge priority-${f.priority}">${f.priority}</span></h4>
        <p>${escapeHtml(f.description)}</p>
        ${f.acceptanceCriteria && f.acceptanceCriteria.length ?
          `<div class="criteria-label">受け入れ基準</div><ul>${f.acceptanceCriteria.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>` : ''}
        ${f.edgeCases && f.edgeCases.length ?
          `<div class="edge-cases"><div class="criteria-label">エッジケース</div><ul>${f.edgeCases.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>` : ''}
      </div>
    `).join('');
    html += `</div>`;
  }
  if (prd.nonGoals && prd.nonGoals.length) {
    html += `<div class="prd-section"><h3>Non-Goals</h3><ul>${prd.nonGoals.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul></div>`;
  }
  if (prd.userFlows && prd.userFlows.length) {
    html += `<div class="prd-section"><h3>ユーザーフロー</h3>`;
    html += prd.userFlows.map(f => `
      <div style="margin-bottom:12px">
        <strong>${escapeHtml(f.name)}</strong>
        <ol>${(f.steps || []).map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
      </div>
    `).join('');
    html += `</div>`;
  }
  if (prd.qualityRequirements) {
    const qr = prd.qualityRequirements;
    const qrLabels = {
      functionalSuitability: '機能適合性',
      performanceEfficiency: '性能効率性',
      compatibility: '互換性',
      usability: '使用性',
      reliability: '信頼性',
      security: 'セキュリティ',
      maintainability: '保守性',
      portability: '移植性',
    };
    html += `<div class="prd-section"><h3>非機能要件（ISO/IEC 25010）</h3><div class="quality-grid">`;
    for (const [key, label] of Object.entries(qrLabels)) {
      const item = qr[key];
      if (!item) continue;
      html += `<div class="quality-item">
        <div class="quality-label">${label}</div>
        <div class="quality-desc">${escapeHtml(item.description || '')}</div>
        ${item.criteria && item.criteria.length ? `<ul>${item.criteria.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}
      </div>`;
    }
    html += `</div></div>`;
  }

  if (prd.metrics && prd.metrics.length) {
    html += `<div class="prd-section"><h3>計測指標</h3><table style="width:100%;font-size:13px;"><tr><th>指標</th><th>定義</th><th>目標</th></tr>`;
    html += prd.metrics.map(m => `<tr><td>${escapeHtml(m.name)}</td><td>${escapeHtml(m.definition)}</td><td>${escapeHtml(m.target)}</td></tr>`).join('');
    html += `</table></div>`;
  }

  container.innerHTML = html;
}

function renderSpec(data) {
  const container = document.getElementById('spec-container');
  const spec = data.spec || data;

  let html = '';

  if (spec.projectName) {
    html += `<div class="spec-section"><h3>プロジェクト: ${escapeHtml(spec.projectName)}</h3></div>`;
  }
  if (spec.techStack) {
    html += `<div class="spec-section"><h3>技術スタック</h3><div class="code-block">${escapeHtml(JSON.stringify(spec.techStack, null, 2))}</div></div>`;
  }
  if (spec.apiEndpoints && spec.apiEndpoints.length) {
    html += `<div class="spec-section"><h3>API仕様</h3>`;
    html += spec.apiEndpoints.map(ep => `
      <div class="feature-card">
        <h4><code>${ep.method} ${ep.path}</code></h4>
        <p>${escapeHtml(ep.description || '')}</p>
        ${ep.request ? `<div class="code-block" style="margin-top:8px">Request: ${escapeHtml(JSON.stringify(ep.request, null, 2))}</div>` : ''}
        ${ep.response ? `<div class="code-block" style="margin-top:4px">Response: ${escapeHtml(JSON.stringify(ep.response, null, 2))}</div>` : ''}
      </div>
    `).join('');
    html += `</div>`;
  }
  if (spec.dbSchema) {
    html += `<div class="spec-section"><h3>DBスキーマ</h3><div class="code-block">${escapeHtml(spec.dbSchema)}</div></div>`;
  }
  if (spec.screens && spec.screens.length) {
    html += `<div class="spec-section"><h3>画面一覧</h3>`;
    html += spec.screens.map(s => `
      <div class="feature-card">
        <h4>${escapeHtml(s.name)} <code>${s.path || ''}</code></h4>
        <p>${escapeHtml(s.description || '')}</p>
        ${s.components ? `<p style="color:var(--text-dim);font-size:12px;margin-top:4px">コンポーネント: ${s.components.join(', ')}</p>` : ''}
      </div>
    `).join('');
    html += `</div>`;
  }
  if (spec.testCases && spec.testCases.length) {
    html += `<div class="spec-section"><h3>テストケース</h3>`;
    html += spec.testCases.map(tc => `
      <div style="margin-bottom:12px">
        <strong>${escapeHtml(tc.category)}</strong>
        ${(tc.cases || []).map(c => `
          <div class="feature-card">
            <h4>${escapeHtml(c.name)}</h4>
            <p><strong>Given:</strong> ${escapeHtml(c.given || '')}</p>
            <p><strong>When:</strong> ${escapeHtml(c.when || '')}</p>
            <p><strong>Then:</strong> ${escapeHtml(c.then || '')}</p>
          </div>
        `).join('')}
      </div>
    `).join('');
    html += `</div>`;
  }

  // Full JSON preview
  html += `<div class="spec-section"><h3>完全なspec.json</h3><div class="code-block" style="max-height:400px;overflow-y:auto">${escapeHtml(JSON.stringify(data, null, 2))}</div></div>`;

  container.innerHTML = html;
}

// --- Export ---
function exportSpecJSON() {
  if (!currentSession) return;
  fetch(`/api/sessions/${currentSessionId}`)
    .then(r => r.json())
    .then(data => {
      const spec = data.analysis?.spec || {};
      const text = JSON.stringify(spec, null, 2);
      navigator.clipboard.writeText(text).then(() => {
        showToast('spec.json をクリップボードにコピーしました');
      });
    });
}

function exportPRDMarkdown() {
  if (!currentSession) return;
  fetch(`/api/sessions/${currentSessionId}`)
    .then(r => r.json())
    .then(data => {
      const spec = data.analysis?.spec || {};
      const md = spec.prdMarkdown || JSON.stringify(data.analysis?.prd || {}, null, 2);
      navigator.clipboard.writeText(md).then(() => {
        showToast('PRD.md をクリップボードにコピーしました');
      });
    });
}

// --- Step Navigation ---
function activateStep(stepName) {
  // Update content visibility
  document.querySelectorAll('.step-content').forEach(el => el.classList.remove('active'));
  const stepEl = document.getElementById(`step-${stepName}`);
  if (stepEl) stepEl.classList.add('active');

  // Update sidebar
  document.querySelectorAll('.step-nav .step').forEach(el => el.classList.remove('active'));
  const navStep = document.querySelector(`.step-nav .step[data-step="${stepName}"]`);
  if (navStep) navStep.classList.add('active');
}

function updateStepNav(status) {
  const order = ['interviewing', 'analyzed', 'respondent_done', 'hypothesized', 'prd_generated', 'spec_generated'];
  // Normalize: respondent_done counts same as analyzed
  if (status === 'respondent_done') status = 'respondent_done';
  const stepNames = ['interview', 'facts', 'hypotheses', 'prd', 'spec'];
  const currentIndex = order.indexOf(status);

  stepNames.forEach((name, i) => {
    const el = document.querySelector(`.step-nav .step[data-step="${name}"]`);
    if (!el) return;
    el.classList.remove('completed');
    if (i < currentIndex) el.classList.add('completed');
  });
}

// Make step nav clickable
document.querySelectorAll('.step-nav .step').forEach(el => {
  el.addEventListener('click', () => {
    const step = el.dataset.step;
    activateStep(step);
  });
});

// --- UI Helpers ---
function showLoading(text) {
  document.getElementById('loading-text').textContent = text || 'AIが分析中…';
  document.getElementById('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

function showToast(msg, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast ${isError ? 'error' : ''}`;
  setTimeout(() => { toast.className = 'toast hidden'; }, 3000);
}

// ==========================================
// Shared Interview (Respondent-facing)
// ==========================================

let sharedToken = null;
let sharedTurnCount = 0;

function handleSharedKeydown(event) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter' && event.shiftKey) {
    event.preventDefault();
    campaignToken ? sendCampaignMessage() : sendSharedMessage();
  }
}

async function initSharedInterview(token) {
  sharedToken = token;

  // Hide all pages, show shared
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-shared').classList.add('active');

  // Hide header nav buttons
  document.querySelector('.header-nav')?.style.setProperty('display', 'none');

  try {
    const res = await fetch(`/api/shared/${token}`);
    const data = await res.json();
    if (data.error) {
      showToast('インタビューが見つかりません', true);
      return;
    }

    document.getElementById('shared-theme-title').textContent = data.theme;
    document.getElementById('shared-chat-theme').textContent = `${data.theme}`;

    // If already done, show thank you
    if (data.status === 'respondent_done') {
      showSharedScreen('shared-thanks');
      return;
    }

    // If already has messages, resume chat
    if (data.messageCount > 0) {
      await resumeSharedChat(token);
      return;
    }

    showSharedScreen('shared-welcome');
  } catch (e) {
    showToast(e.message, true);
  }
}

async function resumeSharedChat(token) {
  const res = await fetch(`/api/shared/${token}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (data.alreadyStarted && data.messages) {
    showSharedScreen('shared-chat');
    const container = document.getElementById('shared-chat-container');
    container.innerHTML = '';
    data.messages.forEach(m => {
      addSharedMessage(m.role, m.content);
    });
    sharedTurnCount = data.messages.filter(m => m.role === 'user').length;
    updateSharedProgress();
    if (sharedTurnCount >= 5) {
      document.getElementById('shared-complete-actions').style.display = 'flex';
    }
  }
}

async function startSharedInterview() {
  const name = document.getElementById('shared-name').value.trim();
  showSharedScreen('shared-chat');
  showTypingInContainer('shared-chat-container');

  try {
    const res = await fetch(`/api/shared/${sharedToken}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ respondentName: name }),
    });
    const data = await res.json();
    removeTypingFromContainer('shared-chat-container');
    if (data.error) throw new Error(data.error);

    if (data.alreadyStarted && data.messages) {
      const container = document.getElementById('shared-chat-container');
      container.innerHTML = '';
      data.messages.forEach(m => addSharedMessage(m.role, m.content));
      sharedTurnCount = data.messages.filter(m => m.role === 'user').length;
    } else {
      addSharedMessage('assistant', data.reply);
    }
    updateSharedProgress();
  } catch (e) {
    removeTypingFromContainer('shared-chat-container');
    showToast(e.message, true);
  }
}

async function sendSharedMessage() {
  const input = document.getElementById('shared-chat-input');
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  addSharedMessage('user', message);
  sharedTurnCount++;
  updateSharedProgress();

  document.getElementById('btn-shared-send').disabled = true;
  showTypingInContainer('shared-chat-container');

  try {
    const res = await fetch(`/api/shared/${sharedToken}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    removeTypingFromContainer('shared-chat-container');
    if (data.error) throw new Error(data.error);

    addSharedMessage('assistant', data.reply);

    if (data.isComplete || sharedTurnCount >= 5) {
      document.getElementById('shared-complete-actions').style.display = 'flex';
    }
  } catch (e) {
    removeTypingFromContainer('shared-chat-container');
    showToast(e.message, true);
  } finally {
    document.getElementById('btn-shared-send').disabled = false;
    input.focus();
  }
}

async function completeSharedInterview() {
  showLoading('AIがファクトを抽出中…');
  try {
    const res = await fetch(`/api/shared/${sharedToken}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    renderSharedFacts(data);
    showSharedScreen('shared-facts');
  } catch (e) {
    showToast(e.message, true);
  } finally {
    hideLoading();
  }
}

async function submitSharedFeedback() {
  const feedback = document.getElementById('shared-feedback').value.trim();

  try {
    await fetch(`/api/shared/${sharedToken}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback: feedback || null }),
    });
  } catch (e) {
    // ignore feedback save errors
  }

  showSharedScreen('shared-thanks');
}

function addSharedMessage(role, content) {
  const container = document.getElementById('shared-chat-container');
  const msg = document.createElement('div');
  msg.className = `chat-msg ${role}`;
  msg.textContent = content;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function showSharedScreen(screenId) {
  document.querySelectorAll('.shared-screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId)?.classList.add('active');
}

function updateSharedProgress() {
  const pct = Math.min(100, Math.max(10, (sharedTurnCount / 6) * 100));
  document.getElementById('shared-progress-bar').style.width = pct + '%';
}

function showTypingInContainer(containerId) {
  const container = document.getElementById(containerId);
  const msg = document.createElement('div');
  msg.className = 'chat-msg assistant typing';
  msg.id = `typing-${containerId}`;
  msg.textContent = '考え中';
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function removeTypingFromContainer(containerId) {
  const el = document.getElementById(`typing-${containerId}`);
  if (el) el.remove();
}

function renderSharedFacts(data) {
  const container = document.getElementById('shared-facts-container');
  const facts = data.facts || [];
  container.innerHTML = facts.map(f => `
    <div class="fact-card">
      <div class="fact-card-header">
        <span class="fact-type type-${f.type}">${factTypeLabel(f.type)}</span>
        <span class="severity severity-${f.severity}">${f.severity}</span>
      </div>
      <div class="fact-content">${escapeHtml(f.content)}</div>
      ${f.evidence ? `<div class="fact-evidence">「${escapeHtml(f.evidence)}」</div>` : ''}
    </div>
  `).join('');
}

// ==========================================
// Share URL generation (developer-facing)
// ==========================================

async function shareSession(sessionId) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const url = `${window.location.origin}/i/${data.shareToken}`;
    await navigator.clipboard.writeText(url);
    showToast(`共有URLをコピーしました: ${url}`);
  } catch (e) {
    showToast(e.message, true);
  }
}

// ==========================================
// Campaign (multi-respondent) functions
// ==========================================

let campaignToken = null;
let campaignSessionId = null;

async function createCampaign(sessionId) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/campaign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const url = `${window.location.origin}/c/${data.shareToken}`;
    await navigator.clipboard.writeText(url);
    showToast(t('toast.campaignUrl') || `キャンペーンURLをコピーしました: ${url}`);
  } catch (e) {
    showToast(e.message, true);
  }
}

async function initCampaignInterview(token) {
  campaignToken = token;
  // Show shared page (reuse the UI)
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-shared').classList.add('active');

  try {
    const res = await fetch(`/api/campaigns/${token}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    document.getElementById('shared-theme-title').textContent = data.theme;
  } catch (e) {
    showToast(t('toast.notFound'), true);
  }
}

async function startCampaignInterview() {
  const nameInput = document.getElementById('shared-name');
  const respondentName = nameInput ? nameInput.value.trim() : '';

  showLoading(t('loading.session'));
  try {
    const res = await fetch(`/api/campaigns/${campaignToken}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ respondentName }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    campaignSessionId = data.sessionId;
    hideLoading();

    // Switch to chat screen
    document.getElementById('shared-welcome').classList.remove('active');
    document.getElementById('shared-chat').classList.add('active');
    document.getElementById('shared-chat-theme').textContent = data.theme;

    const container = document.getElementById('shared-chat-container');
    container.innerHTML = '';
    appendChatBubble(container, 'assistant', data.reply);
  } catch (e) {
    hideLoading();
    showToast(e.message, true);
  }
}

async function sendCampaignMessage() {
  const input = document.getElementById('shared-chat-input');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';

  const container = document.getElementById('shared-chat-container');
  appendChatBubble(container, 'user', message);
  showTypingIndicator('shared-chat-container');

  try {
    const res = await fetch(`/api/campaigns/${campaignToken}/sessions/${campaignSessionId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    removeTypingIndicator('shared-chat-container');
    if (data.error) throw new Error(data.error);

    appendChatBubble(container, 'assistant', data.reply);

    if (data.isComplete) {
      document.getElementById('shared-complete-actions').style.display = 'block';
    }

    // Update progress bar
    const bar = document.getElementById('shared-progress-bar');
    if (bar) bar.style.width = `${Math.min(100, (data.turnCount / 6) * 100)}%`;
  } catch (e) {
    removeTypingIndicator('shared-chat-container');
    showToast(e.message, true);
  }
}

async function completeCampaignInterview() {
  showLoading(t('loading.facts'));
  try {
    const res = await fetch(`/api/campaigns/${campaignToken}/sessions/${campaignSessionId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    hideLoading();
    if (data.error) throw new Error(data.error);

    renderSharedFacts(data);
    document.getElementById('shared-chat').classList.remove('active');
    document.getElementById('shared-facts').classList.add('active');
  } catch (e) {
    hideLoading();
    showToast(e.message, true);
  }
}

async function submitCampaignFeedback() {
  const feedback = document.getElementById('shared-feedback')?.value?.trim() || '';
  try {
    await fetch(`/api/campaigns/${campaignToken}/sessions/${campaignSessionId}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback }),
    });
  } catch (e) { /* ignore */ }

  document.getElementById('shared-facts').classList.remove('active');
  document.getElementById('shared-thanks').classList.add('active');
}

// --- Init ---
(function init() {
  // Apply i18n translations and set active lang button
  if (typeof applyTranslations === 'function') {
    applyTranslations();
    document.querySelectorAll('.lang-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.lang === currentLang);
    });
  }

  // Check if URL is a shared interview or campaign
  const sharedMatch = window.location.pathname.match(/^\/i\/([a-z0-9]+)$/i);
  const campaignMatch = window.location.pathname.match(/^\/c\/([a-z0-9]+)$/i);
  if (campaignMatch) {
    initCampaignInterview(campaignMatch[1]);
  } else if (sharedMatch) {
    initSharedInterview(sharedMatch[1]);
  } else {
    loadSessions();
  }
})();
