// === DeepForm Policy Modal ===

import privacyMd from './content/privacy.md?raw';
import termsMd from './content/terms.md?raw';
import securityMd from './content/security.md?raw';

const policies: Record<string, string> = {
  privacy: privacyMd,
  terms: termsMd,
  security: securityMd,
};

function mdToHtml(md: string): string {
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^(?!<[hulo])(\S.+)$/gm, '<p>$1</p>')
    .replace(/\n{2,}/g, '');
}

let modalEl: HTMLElement | null = null;

function ensureModal(): HTMLElement {
  if (modalEl) return modalEl;
  const el = document.createElement('div');
  el.id = 'policy-modal';
  el.className = 'modal-overlay hidden';
  el.innerHTML = `
    <div class="modal-content policy-page">
      <button class="modal-close" onclick="window.closeModal()" aria-label="\u9589\u3058\u308b">&times;</button>
      <div id="modal-body"></div>
    </div>
  `;
  el.addEventListener('click', (e) => {
    if (e.target === el) closeModal();
  });
  document.body.appendChild(el);
  modalEl = el;
  return el;
}

export function openPolicy(key: string): void {
  const md = policies[key];
  if (!md) return;
  const modal = ensureModal();
  const body = modal.querySelector('#modal-body');
  if (body) body.innerHTML = mdToHtml(md);
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

export function closeModal(): void {
  modalEl?.classList.add('hidden');
  document.body.style.overflow = '';
}
