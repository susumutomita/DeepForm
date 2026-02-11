// inline-edit.ts
import { showToast } from './ui';
import { getCurrentSessionId } from './interview';

// Types
interface SuggestResponse {
  suggestions: string[];
}

interface ApplyResponse {
  updatedText?: string;
  applied: boolean;
  reason?: string;
}

let activePopup: HTMLElement | null = null;
let selectionChangeTimer: ReturnType<typeof setTimeout> | null = null;

// Initialize: attach listeners for both mouse and touch
export function initInlineEdit(): void {
  // Mouse (desktop)
  document.addEventListener('mouseup', handleTextSelection);
  document.addEventListener('mousedown', handleClickOutside);
  // Touch (mobile) — selectionchange fires after long-press selection
  document.addEventListener('selectionchange', handleSelectionChange);
  // Close popup on touch outside
  document.addEventListener('touchstart', handleTouchOutside);
}

export function destroyInlineEdit(): void {
  document.removeEventListener('mouseup', handleTextSelection);
  document.removeEventListener('mousedown', handleClickOutside);
  document.removeEventListener('selectionchange', handleSelectionChange);
  document.removeEventListener('touchstart', handleTouchOutside);
  if (selectionChangeTimer) clearTimeout(selectionChangeTimer);
  closePopup();
}

function handleClickOutside(e: MouseEvent): void {
  if (activePopup && !activePopup.contains(e.target as Node)) {
    closePopup();
  }
}

function handleTouchOutside(e: TouchEvent): void {
  if (activePopup && !activePopup.contains(e.target as Node)) {
    closePopup();
  }
}

// Debounced selectionchange handler for mobile touch selection
function handleSelectionChange(): void {
  if (selectionChangeTimer) clearTimeout(selectionChangeTimer);
  selectionChangeTimer = setTimeout(() => {
    // Only trigger on touch devices (avoid double-firing on desktop)
    if (!('ontouchstart' in window)) return;
    handleTextSelection();
  }, 500);
}

function handleTextSelection(_e: MouseEvent): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) {
    return; // No text selected
  }

  const selectedText = selection.toString().trim();
  if (selectedText.length < 2 || selectedText.length > 200) return; // Too short or too long

  // Check if selection is within the PRD container
  const prdContainer = document.getElementById('prd-container');
  if (!prdContainer) return;

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  if (!prdContainer.contains(commonAncestor)) return;

  // Get the full text of the parent element for context
  const parentElement = commonAncestor.nodeType === Node.TEXT_NODE
    ? commonAncestor.parentElement
    : commonAncestor as HTMLElement;
  if (!parentElement) return;

  // Determine section type from closest parent
  const sectionType = detectSectionType(parentElement, prdContainer);

  // Get context (the full text of the nearest list item or paragraph)
  const contextElement = parentElement.closest('li')
    || parentElement.closest('p')
    || parentElement.closest('td')
    || parentElement;
  const context = contextElement?.textContent?.trim() || selectedText;

  // Get position for popup
  const rect = range.getBoundingClientRect();

  // Show popup
  showSuggestionPopup(selectedText, context, sectionType, rect, range);
}

function detectSectionType(el: HTMLElement, container: HTMLElement): string {
  // Walk up from element to find which PRD section we're in
  let current: HTMLElement | null = el;
  while (current && current !== container) {
    // Check quality-grid (non-functional requirements)
    if (current.classList?.contains('quality-item') || current.classList?.contains('quality-grid')) {
      return 'qualityRequirements';
    }
    // Check if inside a feature card
    if (current.classList?.contains('feature-card')) {
      // Check if in edge cases sub-section
      const edgeCases = current.querySelector('.edge-cases');
      if (edgeCases && edgeCases.contains(el)) return 'edgeCases';
      return 'acceptanceCriteria';
    }
    // Check metrics table
    if (current.tagName === 'TABLE' || current.tagName === 'TR' || current.tagName === 'TD') {
      return 'metrics';
    }
    current = current.parentElement;
  }
  return 'other';
}

async function showSuggestionPopup(
  selectedText: string,
  context: string,
  sectionType: string,
  rect: DOMRect,
  range: Range,
): Promise<void> {
  closePopup(); // Close any existing popup

  const sessionId = getCurrentSessionId();
  if (!sessionId) return;

  // Create popup
  const popup = document.createElement('div');
  popup.className = 'inline-edit-popup';
  popup.innerHTML = `
    <div class="inline-edit-loading">
      <div class="inline-edit-spinner"></div>
      <span>候補を生成中…</span>
    </div>
  `;

  // Position popup below the selection
  const scrollTop = window.scrollY || document.documentElement.scrollTop;
  const scrollLeft = window.scrollX || document.documentElement.scrollLeft;
  popup.style.position = 'absolute';
  popup.style.top = `${rect.bottom + scrollTop + 4}px`;
  popup.style.left = `${rect.left + scrollLeft}px`;
  popup.style.zIndex = '9999';

  document.body.appendChild(popup);
  activePopup = popup;

  // Fetch suggestions
  try {
    const res = await fetch(`/api/sessions/${sessionId}/prd/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedText, context, sectionType }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data: SuggestResponse = await res.json();

    if (!activePopup) return; // Popup was closed while loading

    // Render suggestions
    const suggestions = data.suggestions || [];
    popup.innerHTML = `
      <ul class="inline-edit-list">
        ${suggestions.map(s => `
          <li class="inline-edit-option${s === selectedText ? ' current' : ''}" data-value="${escapeAttr(s)}">
            <span class="inline-edit-option-text">${escapeHtmlInline(s)}</span>
            ${s === selectedText ? '<span class="inline-edit-check">✓</span>' : ''}
          </li>
        `).join('')}
      </ul>
      <div class="inline-edit-custom">
        <input type="text" class="inline-edit-input" placeholder="任意の値" />
      </div>
    `;

    // Reposition if needed (to avoid going off-screen)
    repositionPopup(popup, rect);

    // Event handlers for suggestion clicks
    popup.querySelectorAll('.inline-edit-option').forEach(li => {
      li.addEventListener('click', async () => {
        const newText = (li as HTMLElement).dataset.value || '';
        if (newText === selectedText) {
          closePopup();
          return;
        }
        // Disable all options while applying
        popup.querySelectorAll('.inline-edit-option').forEach(opt =>
          (opt as HTMLElement).style.pointerEvents = 'none',
        );
        (li as HTMLElement).style.opacity = '0.6';
        await applyEdit(sessionId, selectedText, newText, context, sectionType, false, range);
      });
    });

    // Event handler for custom input
    const input = popup.querySelector('.inline-edit-input') as HTMLInputElement;
    if (input) {
      input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const customValue = input.value.trim();
          if (!customValue) return;
          input.disabled = true;
          await applyEdit(sessionId, selectedText, customValue, context, sectionType, true, range);
        }
      });
    }
  } catch (_err: unknown) {
    if (activePopup) {
      popup.innerHTML = `<div class="inline-edit-error">提案の取得に失敗しました</div>`;
    }
  }
}

async function applyEdit(
  sessionId: string,
  selectedText: string,
  newText: string,
  context: string,
  sectionType: string,
  isCustomInput: boolean,
  _range: Range,
): Promise<void> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/prd/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedText, newText, context, sectionType, isCustomInput }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data: ApplyResponse = await res.json();

    if (data.applied && data.updatedText) {
      // Find the element containing the context and update it
      updatePRDText(context, data.updatedText);
      showToast('要件を更新しました');
    } else if (!data.applied && data.reason) {
      showToast(data.reason, true);
    }
  } catch (_err: unknown) {
    showToast('更新に失敗しました', true);
  } finally {
    closePopup();
  }
}

function updatePRDText(oldContext: string, newContext: string): void {
  const prdContainer = document.getElementById('prd-container');
  if (!prdContainer) return;

  // Walk through all text-containing elements to find the one with oldContext
  const elements = prdContainer.querySelectorAll('li, p, td, .quality-desc');
  for (const el of elements) {
    if (el.textContent?.trim() === oldContext) {
      el.textContent = newContext;
      // Add a brief highlight animation
      el.classList.add('inline-edit-updated');
      setTimeout(() => el.classList.remove('inline-edit-updated'), 2000);
      return;
    }
  }

  // Fallback: try partial match
  for (const el of elements) {
    const text = el.textContent || '';
    if (text.includes(oldContext)) {
      el.textContent = text.replace(oldContext, newContext);
      el.classList.add('inline-edit-updated');
      setTimeout(() => el.classList.remove('inline-edit-updated'), 2000);
      return;
    }
  }
}

function closePopup(): void {
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
  }
}

function repositionPopup(popup: HTMLElement, triggerRect: DOMRect): void {
  const popupRect = popup.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Adjust horizontal position if going off-screen to the right
  if (popupRect.right > viewportWidth - 16) {
    const scrollLeft = window.scrollX || document.documentElement.scrollLeft;
    popup.style.left = `${viewportWidth - popupRect.width - 16 + scrollLeft}px`;
  }

  // Adjust horizontal position if going off-screen to the left
  if (popupRect.left < 16) {
    const scrollLeft = window.scrollX || document.documentElement.scrollLeft;
    popup.style.left = `${16 + scrollLeft}px`;
  }

  // If popup would go below viewport, show above the selection instead
  if (popupRect.bottom > viewportHeight - 16) {
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    popup.style.top = `${triggerRect.top + scrollTop - popupRect.height - 4}px`;
  }
}

function escapeHtmlInline(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
