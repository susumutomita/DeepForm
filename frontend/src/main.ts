// === DeepForm Frontend Entry Point ===
import './style.css';
import { applyTranslations, setLang, currentLang } from './i18n';
import { checkAuth, doLogout, isLoggedIn, redirectToLogin } from './auth';
import { loadSessions, doToggleVisibility, doShareSession, doCreateCampaign } from './sessions';
import {
  showHome, openSession, sendMessage, handleChatKeydown,
  doRunAnalysis, doRunHypotheses, doRunPRD, doRunSpec,
  exportSpecJSON, exportPRDMarkdown, doDeployToExeDev, activateStep,
} from './interview';
import {
  initSharedInterview, initCampaignInterview,
  startSharedInterview, sendSharedMessage, completeSharedInterview, submitSharedFeedback,
  startCampaignInterview, sendCampaignMessage, completeCampaignInterview, submitCampaignFeedback,
  handleSharedKeydown,
} from './shared';
import { showToast, toggleTheme, initTheme } from './ui';
import { openPolicy, closeModal } from './modal';
import { openFeedbackModal, closeFeedbackModal } from './feedback';
import { openExportIssuesModal } from './github-export';
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
w.shareSession = doShareSession;
w.createCampaign = doCreateCampaign;
w.sendMessage = sendMessage;
w.handleChatKeydown = handleChatKeydown;
w.runAnalysis = doRunAnalysis;
w.runHypotheses = doRunHypotheses;
w.runPRD = doRunPRD;
w.runSpec = doRunSpec;
w.exportSpecJSON = exportSpecJSON;
w.exportPRDMarkdown = exportPRDMarkdown;
w.deployToExeDev = doDeployToExeDev;
w.openExportIssuesModal = openExportIssuesModal;
w.activateStep = activateStep;
w.logout = doLogout;
w.setLang = setLang;

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

// Shared / Campaign
w.startSharedInterview = startSharedInterview;
w.sendSharedMessage = sendSharedMessage;
w.completeSharedInterview = completeSharedInterview;
w.submitSharedFeedback = submitSharedFeedback;
w.handleSharedKeydown = handleSharedKeydown;
w.startCampaignInterview = startCampaignInterview;
w.sendCampaignMessage = sendCampaignMessage;
w.completeCampaignInterview = completeCampaignInterview;
w.submitCampaignFeedback = submitCampaignFeedback;

// Start new session (with auth check)
w.startNewSession = async () => {
  if (!isLoggedIn()) {
    showToast(t('auth.loginRequired'), true);
    setTimeout(() => redirectToLogin(), 1500);
    return;
  }
  const input = document.getElementById('theme-input') as HTMLTextAreaElement | null;
  if (!input) return;
  const theme = input.value.trim();
  if (!theme) { showToast(t('toast.enterTheme'), true); return; }

  try {
    const data = await api.createSession(theme);
    input.value = '';
    await openSession(data.sessionId, true);
  } catch (e: any) {
    if (e.message.includes('ログイン')) {
      showToast(t('auth.loginRequired'), true);
      setTimeout(() => redirectToLogin(), 1500);
    } else {
      showToast(e.message, true);
    }
  }
};

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

  // Step nav clicks
  document.querySelectorAll('.step-nav .step').forEach(el => {
    el.addEventListener('click', () => {
      const step = (el as HTMLElement).dataset.step;
      if (step) activateStep(step);
    });
  });

  // Route
  const path = window.location.pathname;
  const sharedMatch = path.match(/^\/i\/([a-z0-9]+)$/i);
  const campaignMatch = path.match(/^\/c\/([a-z0-9]+)$/i);
  const sessionMatch = path.match(/^\/session\/([a-z0-9-]+)$/i);

  if (campaignMatch) {
    await initCampaignInterview(campaignMatch[1]);
  } else if (sharedMatch) {
    await initSharedInterview(sharedMatch[1]);
  } else if (sessionMatch) {
    await openSession(sessionMatch[1]);
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
