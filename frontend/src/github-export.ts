// === DeepForm GitHub Issues Export (OAuth-based) ===
import * as api from './api';
import { isLoggedIn } from './auth';
import { getCurrentSessionId } from './interview';
import { showToast } from './ui';
import type { GitHubRepo } from './types';

let modalEl: HTMLElement | null = null;
let cachedRepos: GitHubRepo[] | null = null;

function createLabel(text: string, htmlFor: string): HTMLLabelElement {
  const label = document.createElement('label');
  label.htmlFor = htmlFor;
  label.textContent = text;
  label.style.cssText = 'display:block;font-size:0.85rem;margin-bottom:4px;font-weight:500';
  return label;
}

function createInput(type: string, id: string, placeholder: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = type;
  input.id = id;
  input.placeholder = placeholder;
  input.style.cssText = 'width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:0.9rem;background:var(--bg-secondary);color:var(--text-primary)';
  return input;
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
  closeBtn.setAttribute('aria-label', '\u9589\u3058\u308B');
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
  desc.textContent = 'PRD \u306e\u30b3\u30a2\u6a5f\u80fd\u3092 GitHub Issues \u3068\u3057\u3066\u4f5c\u6210\u3057\u307e\u3059\u3002';
  desc.style.cssText = 'color:var(--text-secondary);margin:0 0 20px;font-size:0.9rem';
  content.appendChild(desc);

  // Form
  const form = document.createElement('div');
  form.id = 'github-export-form';

  // Tab selector: existing repo vs new repo
  const tabBar = document.createElement('div');
  tabBar.style.cssText = 'display:flex;gap:0;margin-bottom:16px;border:1px solid var(--border);border-radius:6px;overflow:hidden';
  const tabExisting = document.createElement('button');
  tabExisting.id = 'tab-existing';
  tabExisting.textContent = '\u65e2\u5b58\u30ea\u30dd\u30b8\u30c8\u30ea';
  tabExisting.type = 'button';
  tabExisting.style.cssText = 'flex:1;padding:8px;border:none;cursor:pointer;font-size:0.85rem;background:var(--accent);color:#fff';
  const tabNew = document.createElement('button');
  tabNew.id = 'tab-new';
  tabNew.textContent = '\u65b0\u898f\u4f5c\u6210';
  tabNew.type = 'button';
  tabNew.style.cssText = 'flex:1;padding:8px;border:none;cursor:pointer;font-size:0.85rem;background:var(--bg-secondary);color:var(--text-secondary)';
  tabBar.appendChild(tabExisting);
  tabBar.appendChild(tabNew);
  form.appendChild(tabBar);

  // --- Existing repo panel ---
  const existingPanel = document.createElement('div');
  existingPanel.id = 'panel-existing';

  const repoGroup = document.createElement('div');
  repoGroup.style.marginBottom = '16px';
  repoGroup.appendChild(createLabel('\u30ea\u30dd\u30b8\u30c8\u30ea\u3092\u9078\u629e', 'gh-repo-select'));
  const repoSelect = document.createElement('select');
  repoSelect.id = 'gh-repo-select';
  repoSelect.style.cssText = 'width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:0.9rem;background:var(--bg-secondary);color:var(--text-primary)';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = '\u8aad\u307f\u8fbc\u307f\u4e2d...';
  repoSelect.appendChild(defaultOpt);
  repoGroup.appendChild(repoSelect);
  existingPanel.appendChild(repoGroup);
  form.appendChild(existingPanel);

  // --- New repo panel ---
  const newPanel = document.createElement('div');
  newPanel.id = 'panel-new';
  newPanel.style.display = 'none';

  const nameGroup = document.createElement('div');
  nameGroup.style.marginBottom = '12px';
  nameGroup.appendChild(createLabel('\u30ea\u30dd\u30b8\u30c8\u30ea\u540d', 'gh-new-name'));
  nameGroup.appendChild(createInput('text', 'gh-new-name', '\u4f8b: my-project'));
  newPanel.appendChild(nameGroup);

  const descGroup = document.createElement('div');
  descGroup.style.marginBottom = '12px';
  descGroup.appendChild(createLabel('\u8aac\u660e (\u4efb\u610f)', 'gh-new-desc'));
  descGroup.appendChild(createInput('text', 'gh-new-desc', '\u30ea\u30dd\u30b8\u30c8\u30ea\u306e\u8aac\u660e'));
  newPanel.appendChild(descGroup);

  const privGroup = document.createElement('div');
  privGroup.style.cssText = 'margin-bottom:16px;display:flex;align-items:center;gap:8px';
  const privCheck = document.createElement('input');
  privCheck.type = 'checkbox';
  privCheck.id = 'gh-new-private';
  const privLabel = document.createElement('label');
  privLabel.htmlFor = 'gh-new-private';
  privLabel.textContent = 'Private \u30ea\u30dd\u30b8\u30c8\u30ea';
  privLabel.style.fontSize = '0.85rem';
  privGroup.appendChild(privCheck);
  privGroup.appendChild(privLabel);
  newPanel.appendChild(privGroup);
  form.appendChild(newPanel);

  // Tab switching
  tabExisting.addEventListener('click', () => {
    existingPanel.style.display = '';
    newPanel.style.display = 'none';
    tabExisting.style.background = 'var(--accent)';
    tabExisting.style.color = '#fff';
    tabNew.style.background = 'var(--bg-secondary)';
    tabNew.style.color = 'var(--text-secondary)';
  });
  tabNew.addEventListener('click', () => {
    existingPanel.style.display = 'none';
    newPanel.style.display = '';
    tabNew.style.background = 'var(--accent)';
    tabNew.style.color = '#fff';
    tabExisting.style.background = 'var(--bg-secondary)';
    tabExisting.style.color = 'var(--text-secondary)';
  });

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
  submitBtn.textContent = 'Issues \u3092\u4f5c\u6210';
  submitBtn.addEventListener('click', () => handleExport());
  form.appendChild(submitBtn);

  content.appendChild(form);
  el.appendChild(content);

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

async function loadRepos(): Promise<void> {
  const select = document.getElementById('gh-repo-select') as HTMLSelectElement | null;
  if (!select) return;

  if (cachedRepos) {
    populateSelect(select, cachedRepos);
    return;
  }

  select.innerHTML = '';
  const loading = document.createElement('option');
  loading.value = '';
  loading.textContent = '\u8aad\u307f\u8fbc\u307f\u4e2d...';
  select.appendChild(loading);

  try {
    cachedRepos = await api.getGitHubRepos();
    populateSelect(select, cachedRepos);
  } catch (e: unknown) {
    select.innerHTML = '';
    const errOpt = document.createElement('option');
    errOpt.value = '';
    errOpt.textContent = e instanceof Error ? e.message : '\u30ea\u30dd\u30b8\u30c8\u30ea\u306e\u53d6\u5f97\u306b\u5931\u6557';
    select.appendChild(errOpt);
  }
}

function populateSelect(select: HTMLSelectElement, repos: GitHubRepo[]): void {
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = `-- \u30ea\u30dd\u30b8\u30c8\u30ea\u3092\u9078\u629e (${repos.length}\u4ef6) --`;
  select.appendChild(placeholder);
  for (const repo of repos) {
    const opt = document.createElement('option');
    opt.value = repo.full_name;
    opt.textContent = repo.full_name;
    select.appendChild(opt);
  }
}

export function openExportIssuesModal(): void {
  const sessionId = getCurrentSessionId();
  if (!sessionId) {
    showToast('\u30bb\u30c3\u30b7\u30e7\u30f3\u304c\u9078\u629e\u3055\u308c\u3066\u3044\u307e\u305b\u3093', true);
    return;
  }
  if (!isLoggedIn()) {
    showToast('GitHub Issues \u3078\u306e\u30a8\u30af\u30b9\u30dd\u30fc\u30c8\u306b\u306f\u30ed\u30b0\u30a4\u30f3\u304c\u5fc5\u8981\u3067\u3059', true);
    return;
  }

  const modal = ensureModal();

  // Reset
  const progressEl = modal.querySelector('#github-export-progress') as HTMLElement | null;
  const resultsEl = modal.querySelector('#github-export-results') as HTMLElement | null;
  const submitBtn = modal.querySelector('#gh-export-btn') as HTMLButtonElement | null;
  if (progressEl) progressEl.classList.add('hidden');
  if (resultsEl) { resultsEl.classList.add('hidden'); resultsEl.innerHTML = ''; }
  if (submitBtn) submitBtn.disabled = false;

  // Reset to existing tab
  const tabExisting = modal.querySelector('#tab-existing') as HTMLElement | null;
  if (tabExisting) tabExisting.click();

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Load repos
  loadRepos();
}

function renderResults(
  resultsEl: HTMLElement,
  created: Array<{ number: number; title: string; url: string }>,
  errors: Array<{ feature: string; error: string }>,
  repoUrl?: string,
): void {
  resultsEl.innerHTML = '';
  resultsEl.classList.remove('hidden');

  if (repoUrl) {
    const repoLink = document.createElement('p');
    repoLink.style.cssText = 'margin:0 0 12px;font-size:0.9rem';
    const a = document.createElement('a');
    a.href = repoUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.style.color = 'var(--accent)';
    a.textContent = `\u30ea\u30dd\u30b8\u30c8\u30ea: ${repoUrl.replace('https://github.com/', '')}`;
    repoLink.appendChild(a);
    resultsEl.appendChild(repoLink);
  }

  if (created.length > 0) {
    const section = document.createElement('div');
    section.style.marginBottom = '12px';
    const heading = document.createElement('p');
    heading.style.cssText = 'font-size:0.85rem;color:var(--text-secondary);margin:0 0 8px';
    heading.textContent = `\u4f5c\u6210\u3055\u308c\u305f Issue (${created.length}\u4ef6)`;
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
    heading.textContent = `\u30a8\u30e9\u30fc (${errors.length}\u4ef6)`;
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

  const existingPanel = document.getElementById('panel-existing');
  const isNewRepo = existingPanel?.style.display === 'none';

  const progressEl = document.getElementById('github-export-progress');
  const progressText = document.getElementById('github-export-progress-text');
  const resultsEl = document.getElementById('github-export-results');
  const submitBtn = document.getElementById('gh-export-btn') as HTMLButtonElement | null;

  if (submitBtn) submitBtn.disabled = true;
  if (progressEl) progressEl.classList.remove('hidden');
  if (progressText) progressText.textContent = 'GitHub Issues \u3092\u4f5c\u6210\u4e2d...';
  if (resultsEl) { resultsEl.classList.add('hidden'); resultsEl.innerHTML = ''; }

  try {
    if (isNewRepo) {
      const nameInput = document.getElementById('gh-new-name') as HTMLInputElement | null;
      const descInput = document.getElementById('gh-new-desc') as HTMLInputElement | null;
      const privCheck = document.getElementById('gh-new-private') as HTMLInputElement | null;
      const name = nameInput?.value.trim() || '';
      if (!name) { showToast('\u30ea\u30dd\u30b8\u30c8\u30ea\u540d\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044', true); return; }

      if (progressText) progressText.textContent = '\u30ea\u30dd\u30b8\u30c8\u30ea\u3092\u4f5c\u6210\u4e2d...';

      const result = await api.createRepoAndExport(sessionId, {
        name,
        description: descInput?.value.trim() || undefined,
        isPrivate: privCheck?.checked,
      });

      if (progressEl) progressEl.classList.add('hidden');
      if (resultsEl) renderResults(resultsEl, result.created, result.errors, result.repo.url);
      cachedRepos = null; // invalidate cache
      if (result.created.length > 0) showToast(`${result.created.length}\u4ef6\u306e Issue \u3092\u4f5c\u6210\u3057\u307e\u3057\u305f`);
    } else {
      const select = document.getElementById('gh-repo-select') as HTMLSelectElement | null;
      const repoValue = select?.value.trim() || '';
      if (!repoValue) { showToast('\u30ea\u30dd\u30b8\u30c8\u30ea\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044', true); return; }
      const [repoOwner, repoName] = repoValue.split('/');

      const result = await api.exportIssues(sessionId, { repoOwner, repoName });

      if (progressEl) progressEl.classList.add('hidden');
      if (resultsEl) renderResults(resultsEl, result.created, result.errors);
      if (result.created.length > 0) showToast(`${result.created.length}\u4ef6\u306e Issue \u3092\u4f5c\u6210\u3057\u307e\u3057\u305f`);
      if (result.errors.length > 0 && result.created.length === 0) showToast('Issue \u306e\u4f5c\u6210\u306b\u5931\u6557\u3057\u307e\u3057\u305f', true);
    }
  } catch (e: unknown) {
    if (progressEl) progressEl.classList.add('hidden');
    showToast(e instanceof Error ? e.message : String(e), true);
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
