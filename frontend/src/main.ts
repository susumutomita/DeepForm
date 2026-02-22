// === DeepForm Frontend Entry Point ===
import './style.css';
import { applyTranslations, setLang, currentLang } from './i18n';
import { checkAuth, doLogout, isLoggedIn } from './auth';
import { loadSessions, doToggleVisibility, doCreateCampaign } from './sessions';
import {
  showHome, openSession, sendMessage, handleChatKeydown,
  doRunAnalysis, doRunHypotheses, doRunPRD, doRunSpec, doRunReadiness, doRunFullPipeline,
  exportSpecJSON, exportPRDMarkdown, doDeployToExeDev, doSaveToGitHub, activateStep,
  getCurrentSessionId,
} from './interview';
import { initInlineEdit, destroyInlineEdit } from './inline-edit';
import {
  initCampaignInterview,
  startCampaignInterview, sendCampaignMessage, completeCampaignInterview, submitCampaignFeedback,
  handleCampaignKeydown,
} from './shared';
import { showToast, toggleTheme, initTheme } from './ui';
import { openPolicy, closeModal } from './modal';
import { openFeedbackModal, closeFeedbackModal } from './feedback';
import { showCampaignAnalytics } from './campaign-analytics';
import { showAnalytics } from './analytics';
import { t } from './i18n';
import { renderPrivacyPolicy } from './pages/privacy';
import { renderTerms } from './pages/terms';
import { renderSecurityPolicy } from './pages/security';
import * as api from './api';
import type { DeepFormWindow } from './types';

const w = window as unknown as DeepFormWindow;

// --- Global function bindings for HTML onclick handlers ---
w.showHome = () => { showHome(); loadSessions(); };
w.openSession = openSession;
w.loadSessions = loadSessions;
w.toggleVisibility = doToggleVisibility;
w.createCampaign = doCreateCampaign;
w.getCurrentSessionId = getCurrentSessionId;
w.sendMessage = sendMessage;
w.handleChatKeydown = handleChatKeydown;
w.runAnalysis = doRunAnalysis;
w.runHypotheses = doRunHypotheses;
w.runPRD = doRunPRD;
w.runSpec = doRunSpec;
w.runReadiness = doRunReadiness;
w.runFullPipeline = doRunFullPipeline;
w.exportSpecJSON = exportSpecJSON;
w.exportPRDMarkdown = exportPRDMarkdown;
w.deployToExeDev = doDeployToExeDev;
w.saveToGitHub = doSaveToGitHub;
w.activateStep = activateStep;
w.logout = doLogout;
w.setLang = (lang: string) => { setLang(lang); loadSessions(); };

// Navigation / Delete
w.showInterview = (sessionId: string) => openSession(sessionId);
w.deleteSession = async (sessionId: string) => {
  try {
    await api.deleteSession(sessionId);
    showHome();
    await loadSessions();
  } catch (e: any) {
    showToast(e.message, true);
  }
};

// Campaign Analytics
w.showCampaignAnalytics = showCampaignAnalytics;

// Campaign
w.startCampaignInterview = startCampaignInterview;
w.sendCampaignMessage = sendCampaignMessage;
w.completeCampaignInterview = completeCampaignInterview;
w.submitCampaignFeedback = submitCampaignFeedback;
w.handleCampaignKeydown = handleCampaignKeydown;

// Start new session (guest access allowed)
w.startNewSession = async () => {
  const input = document.getElementById('theme-input') as HTMLTextAreaElement | null;
  if (!input) return;
  const theme = input.value.trim();
  if (!theme) { showToast(t('toast.enterTheme'), true); return; }

  if (!isLoggedIn()) {
    showGuestNotice(theme);
    return;
  }

  try {
    const data = await api.createSession(theme, currentLang);
    input.value = '';
    await openSession(data.sessionId, true);
  } catch (e: any) {
    showToast(e.message, true);
  }
};

function showGuestNotice(theme: string): void {
  const existing = document.getElementById('login-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'login-modal';
  overlay.className = 'feedback-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const card = document.createElement('div');
  card.className = 'feedback-card';
  card.style.textAlign = 'center';
  card.style.maxWidth = '440px';

  const title = document.createElement('h2');
  title.className = 'feedback-title';
  title.textContent = t('guest.notice.title');
  card.appendChild(title);

  const desc = document.createElement('p');
  desc.style.color = 'var(--text-dim)';
  desc.style.marginBottom = '20px';
  desc.style.lineHeight = '1.7';
  desc.style.fontSize = '14px';
  desc.textContent = t('guest.notice.desc');
  card.appendChild(desc);

  const warn = document.createElement('p');
  warn.style.color = 'var(--accent)';
  warn.style.fontWeight = '600';
  warn.style.fontSize = '13px';
  warn.style.marginBottom = '24px';
  warn.textContent = t('guest.notice.warn');
  card.appendChild(warn);

  // Continue without login
  const guestBtn = document.createElement('button');
  guestBtn.className = 'btn btn-primary';
  guestBtn.style.width = '100%';
  guestBtn.style.padding = '14px 24px';
  guestBtn.textContent = t('guest.notice.continue');
  guestBtn.addEventListener('click', async () => {
    overlay.remove();
    try {
      const data = await api.createSession(theme, currentLang);
      const input = document.getElementById('theme-input') as HTMLTextAreaElement | null;
      if (input) input.value = '';
      await openSession(data.sessionId, true);
    } catch (e: any) {
      showToast(e.message, true);
    }
  });
  card.appendChild(guestBtn);

  // Login button
  const loginBtn = document.createElement('a');
  loginBtn.href = '/api/auth/github';
  loginBtn.className = 'btn btn-secondary';
  loginBtn.style.display = 'inline-flex';
  loginBtn.style.alignItems = 'center';
  loginBtn.style.gap = '8px';
  loginBtn.style.justifyContent = 'center';
  loginBtn.style.width = '100%';
  loginBtn.style.marginTop = '12px';
  loginBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg> ${t('guest.notice.login')}`;
  card.appendChild(loginBtn);

  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// Mobile menu
w.toggleTheme = toggleTheme;
w.openPolicy = openPolicy;
w.closeModal = closeModal;
w.openFeedbackModal = openFeedbackModal;
w.closeFeedbackModal = closeFeedbackModal;

w.toggleMobileMenu = () => {
  const nav = document.getElementById('header-nav');
  const btn = document.querySelector('.hamburger-btn');
  if (!nav || !btn) return;
  const isOpen = nav.classList.toggle('open');
  btn.setAttribute('aria-expanded', String(isOpen));
};

// --- Init ---
async function init(): Promise<void> {
  // Theme
  initTheme();

  // i18n
  applyTranslations();
  document.querySelectorAll<HTMLElement>('.lang-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === currentLang);
  });
  document.documentElement.lang = currentLang;

  // Auth
  await checkAuth();

  // Plan badge in header
  try {
    const planData = await api.getPlan();
    const userInfo = document.getElementById('user-info');
    if (userInfo && planData.loggedIn) {
      const existing = userInfo.querySelector('.plan-badge');
      if (existing) existing.remove();
      const badge = document.createElement('span');
      badge.className = 'plan-badge';
      if (planData.plan === 'pro') {
        badge.textContent = 'PRO';
        badge.style.cssText = 'background: var(--primary); color: white; font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; font-weight: 700; margin-left: 6px;';
      } else {
        badge.textContent = 'Free';
        badge.style.cssText = 'background: var(--bg-input); color: var(--text-dim); font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; font-weight: 600; margin-left: 6px;';
      }
      userInfo.appendChild(badge);
    }
  } catch {
    // Plan check is non-critical
  }

  // Step nav clicks
  document.querySelectorAll('.step-nav .step').forEach(el => {
    el.addEventListener('click', () => {
      const step = (el as HTMLElement).dataset.step;
      if (step) {
        activateStep(step);
        // Initialize/destroy inline edit based on active step
        if (step === 'prd') {
          initInlineEdit();
        } else {
          destroyInlineEdit();
        }
      }
    });
  });

  // Route
  const path = window.location.pathname;
  const campaignMatch = path.match(/^\/c\/([a-z0-9-]+)$/i);
  const sessionMatch = path.match(/^\/session\/([a-z0-9-]+)$/i);

  if (campaignMatch) {
    await initCampaignInterview(campaignMatch[1]);
  } else if (sessionMatch) {
    await openSession(sessionMatch[1]);
  } else if (path === '/analytics') {
    await showAnalytics();
  } else if (path === '/privacy' || path === '/terms' || path === '/security') {
    // Policy pages use hardcoded static HTML from compile-time constants, not user input
    const pageContent = path === '/privacy' ? renderPrivacyPolicy()
      : path === '/terms' ? renderTerms()
      : renderSecurityPolicy();
    const main = document.getElementById('main-content');
    if (main) {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      const div = document.createElement('section');
      div.className = 'page active';
      div.innerHTML = pageContent; // Safe: content is hardcoded static HTML, not user input
      main.appendChild(div);
    }
  } else {
    await loadSessions();
  }
}

init().catch((e) => {
  console.error('Failed to initialize DeepForm:', e);
});
