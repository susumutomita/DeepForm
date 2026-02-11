// === DeepForm GitHub Issues Export ===
import * as api from './api';
import { getCurrentSessionId } from './interview';
import { escapeHtml, showToast } from './ui';

let modalEl: HTMLElement | null = null;

function createInput(type: string, id: string, placeholder: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = type;
  input.id = id;
  input.placeholder = placeholder;
  input.style.cssText = 'width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:0.9rem;background:var(--bg-secondary);color:var(--text-primary)';
  return input;
}

function createLabel(text: string, htmlFor: string): HTMLLabelElement {
  const label = document.createElement('label');
  label.htmlFor = htmlFor;
  label.textContent = text;
  label.style.cssText = 'display:block;font-size:0.85rem;margin-bottom:4px;font-weight:500';
  return label;
}

function ensureModal(): HTMLElement {
  if (modalEl) return modalEl;

  const el = document.createElement('div');
  el.id = 'github-export-modal';
  el.className = 'modal-overlay hidden';

  const content = document.createElement('div');
  content.className = 'modal-content';
  content.style.maxWidth = '480px';

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.setAttribute('aria-label', '閉じる');
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', () => closeExportModal());
  content.appendChild(closeBtn);

  // Title
  const title = document.createElement('h2');
  title.textContent = 'Export to GitHub Issues';
  title.style.margin = '0 0 16px';
  content.appendChild(title);

  // Description
  const desc = document.createElement('p');
  desc.textContent = 'PRD のコア機能を GitHub Issues として作成します。';
  desc.style.cssText = 'color:var(--text-secondary);margin:0 0 20px;font-size:0.9rem';
  content.appendChild(desc);

  // Form
  const form = document.createElement('div');
  form.id = 'github-export-form';

  // Repo input
  const repoGroup = document.createElement('div');
  repoGroup.style.marginBottom = '12px';
  repoGroup.appendChild(createLabel('リポジトリ (owner/repo)', 'gh-repo'));
  repoGroup.appendChild(createInput('text', 'gh-repo', '例: myorg/myrepo'));
  form.appendChild(repoGroup);

  // PAT input
  const patGroup = document.createElement('div');
  patGroup.style.marginBottom = '16px';
  patGroup.appendChild(createLabel('GitHub Personal Access Token', 'gh-pat'));
  patGroup.appendChild(createInput('password', 'gh-pat', 'ghp_xxxx...'));
  const patHint = document.createElement('p');
  patHint.textContent = 'PAT はサーバーに保存されません。repo スコープが必要です。';
  patHint.style.cssText = 'color:var(--text-tertiary);font-size:0.78rem;margin:4px 0 0';
  patGroup.appendChild(patHint);
  form.appendChild(patGroup);

  // Progress
  const progress = document.createElement('div');
  progress.id = 'github-export-progress';
  progress.className = 'hidden';
  progress.style.marginBottom = '16px';
  const progressText = document.createElement('p');
  progressText.id = 'github-export-progress-text';
  progressText.style.cssText = 'font-size:0.85rem;color:var(--text-secondary)';
  progress.appendChild(progressText);
  form.appendChild(progress);

  // Results
  const results = document.createElement('div');
  results.id = 'github-export-results';
  results.className = 'hidden';
  results.style.marginBottom = '16px';
  form.appendChild(results);

  // Submit button
  const submitBtn = document.createElement('button');
  submitBtn.id = 'gh-export-btn';
  submitBtn.className = 'btn btn-primary';
  submitBtn.style.width = '100%';
  submitBtn.textContent = 'Issues を作成';
  submitBtn.addEventListener('click', () => handleExport());
  form.appendChild(submitBtn);

  content.appendChild(form);
  el.appendChild(content);

  // Close on overlay click
  el.addEventListener('click', (e) => {
    if (e.target === el) closeExportModal();
  });

  document.body.appendChild(el);
  modalEl = el;
  return el;
}

function closeExportModal(): void {
  modalEl?.classList.add('hidden');
  document.body.style.overflow = '';
}

export function openExportIssuesModal(): void {
  const sessionId = getCurrentSessionId();
  if (!sessionId) {
    showToast('セッションが選択されていません', true);
    return;
  }

  const modal = ensureModal();

  // Reset form state
  const repoInput = modal.querySelector('#gh-repo') as HTMLInputElement | null;
  const patInput = modal.querySelector('#gh-pat') as HTMLInputElement | null;
  const progressEl = modal.querySelector('#github-export-progress') as HTMLElement | null;
  const resultsEl = modal.querySelector('#github-export-results') as HTMLElement | null;
  const submitBtn = modal.querySelector('#gh-export-btn') as HTMLButtonElement | null;

  if (repoInput) repoInput.value = '';
  if (patInput) patInput.value = '';
  if (progressEl) progressEl.classList.add('hidden');
  if (resultsEl) {
    resultsEl.classList.add('hidden');
    while (resultsEl.firstChild) resultsEl.removeChild(resultsEl.firstChild);
  }
  if (submitBtn) submitBtn.disabled = false;

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  repoInput?.focus();
}

function renderResults(resultsEl: HTMLElement, created: Array<{ number: number; title: string; url: string }>, errors: Array<{ feature: string; error: string }>): void {
  while (resultsEl.firstChild) resultsEl.removeChild(resultsEl.firstChild);
  resultsEl.classList.remove('hidden');

  if (created.length > 0) {
    const section = document.createElement('div');
    section.style.marginBottom = '12px';

    const heading = document.createElement('p');
    heading.style.cssText = 'font-size:0.85rem;color:var(--text-secondary);margin:0 0 8px';
    heading.textContent = `作成された Issue (${created.length}件)`;
    section.appendChild(heading);

    const list = document.createElement('ul');
    list.style.cssText = 'list-style:none;padding:0;margin:0';
    for (const issue of created) {
      const li = document.createElement('li');
      li.style.marginBottom = '6px';
      const link = document.createElement('a');
      link.href = issue.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.style.cssText = 'color:var(--accent);text-decoration:none;font-size:0.9rem';
      link.textContent = `#${issue.number} ${issue.title}`;
      li.appendChild(link);
      list.appendChild(li);
    }
    section.appendChild(list);
    resultsEl.appendChild(section);
  }

  if (errors.length > 0) {
    const section = document.createElement('div');

    const heading = document.createElement('p');
    heading.style.cssText = 'font-size:0.85rem;color:var(--error);margin:0 0 8px';
    heading.textContent = `エラー (${errors.length}件)`;
    section.appendChild(heading);

    const list = document.createElement('ul');
    list.style.cssText = 'list-style:none;padding:0;margin:0';
    for (const err of errors) {
      const li = document.createElement('li');
      li.style.cssText = 'margin-bottom:4px;font-size:0.85rem;color:var(--text-secondary)';
      li.textContent = `${err.feature}: ${err.error}`;
      list.appendChild(li);
    }
    section.appendChild(list);
    resultsEl.appendChild(section);
  }
}

async function handleExport(): Promise<void> {
  const sessionId = getCurrentSessionId();
  if (!sessionId) return;

  const repoInput = document.getElementById('gh-repo') as HTMLInputElement | null;
  const patInput = document.getElementById('gh-pat') as HTMLInputElement | null;
  const progressEl = document.getElementById('github-export-progress') as HTMLElement | null;
  const progressText = document.getElementById('github-export-progress-text') as HTMLElement | null;
  const resultsEl = document.getElementById('github-export-results') as HTMLElement | null;
  const submitBtn = document.getElementById('gh-export-btn') as HTMLButtonElement | null;

  if (!repoInput || !patInput) return;

  const repoValue = repoInput.value.trim();
  const token = patInput.value.trim();

  // Validate repo format
  const repoParts = repoValue.split('/');
  if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
    showToast('リポジトリは owner/repo 形式で入力してください', true);
    return;
  }
  if (!token) {
    showToast('GitHub PAT を入力してください', true);
    return;
  }

  const [repoOwner, repoName] = repoParts;

  // Show progress
  if (submitBtn) submitBtn.disabled = true;
  if (progressEl) progressEl.classList.remove('hidden');
  if (progressText) progressText.textContent = 'GitHub Issues を作成中...';
  if (resultsEl) {
    resultsEl.classList.add('hidden');
    while (resultsEl.firstChild) resultsEl.removeChild(resultsEl.firstChild);
  }

  try {
    const result = await api.exportIssues(sessionId, { repoOwner, repoName, token });

    // Clear PAT from memory
    patInput.value = '';

    if (progressEl) progressEl.classList.add('hidden');

    // Show results
    if (resultsEl) {
      renderResults(resultsEl, result.created, result.errors);
    }

    if (result.created.length > 0) {
      showToast(`${result.created.length}件の Issue を作成しました`);
    }
    if (result.errors.length > 0 && result.created.length === 0) {
      showToast('Issue の作成に失敗しました', true);
    }
  } catch (e: unknown) {
    if (progressEl) progressEl.classList.add('hidden');
    const message = e instanceof Error ? e.message : String(e);
    showToast(message, true);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

/** Render the export button into the given container. */
export function renderExportButton(container: HTMLElement): void {
  const existing = container.querySelector('#btn-export-issues');
  if (existing) return;

  const btn = document.createElement('button');
  btn.id = 'btn-export-issues';
  btn.className = 'btn btn-secondary btn-lg';
  btn.style.marginTop = '8px';
  btn.textContent = 'Export to GitHub Issues';
  btn.addEventListener('click', () => openExportIssuesModal());
  container.appendChild(btn);
}
