/**
 * content.js — Floating UI widget injected into claude.ai
 *
 * Responsibilities:
 *  - Render the floating pill / expanded panel
 *  - Context save, copy to clipboard, download as .txt
 *  - Rate limit DOM watcher → alert badge + banner
 *  - Session expiry detection
 *  - Soft throttle warning on rapid switching
 *  - Post-switch "handoff prompt ready" banner
 */

(function () {
    'use strict';

    // ─── State ────────────────────────────────────────────────────────────────
    let accounts = [];
    let activeAccountId = null;
    let settings = {};
    let widgetOpen = false;
    let rateLimitDetected = false;
    let handoffPromptText = null;
    let lastSwitchTime = 0;
    let pendingFromId = null;

    const SELECTORS_DEFAULT = {
        rateLimitBanner: '[data-testid="rate-limit-message"], .rate-limit, [class*="UsageLimitBanner"], [class*="rate-limit"]',
        sessionExpired: 'form[action*="/login"], [class*="LoginPage"]',
    };

    // ─── Init ─────────────────────────────────────────────────────────────────

    async function init() {
        // Small delay to let the page fully settle
        await sleep(1200);
        await loadState();
        buildWidget();
        startRateLimitWatcher();
        checkForPendingHandoff();
        checkSessionExpiry();

        // Listen for background messages
        chrome.runtime.onMessage.addListener(handleBackgroundMessage);
    }

    async function loadState() {
        try {
            const resp = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNTS' });
            if (!resp.error) {
                accounts = resp.accounts || [];
                activeAccountId = resp.activeAccountId || null;
            }
            const settingsResp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
            if (!settingsResp.error) settings = settingsResp.settings || {};
        } catch (e) {
            // Extension might be locked — widget shows lock state
        }
    }

    function handleBackgroundMessage(msg) {
        if (msg.type === 'SWITCH_NEEDS_LOGIN') {
            showManualLoginBanner(msg.account);
        } else if (msg.type === 'HANDOFF_READY') {
            showHandoffReadyBanner();
        } else if (msg.type === 'LOCKED') {
            accounts = [];
            activeAccountId = null;
            updatePill();
            // Close panel if open
            widgetOpen = false;
            document.getElementById('csm-panel')?.classList.add('csm-hidden');
        } else if (msg.type === 'UNLOCKED') {
            // Service worker was re-unlocked (e.g. user entered master password in popup)
            // Reload state and refresh the widget so it shows the correct account again
            loadState().then(() => {
                updatePill();
                if (widgetOpen) refreshPanel();
            });
        }
    }

    // ─── Widget structure ─────────────────────────────────────────────────────

    function buildWidget() {
        if (document.getElementById('csm-widget')) return;

        const widget = document.createElement('div');
        widget.id = 'csm-widget';
        widget.innerHTML = buildPillHTML();
        document.body.appendChild(widget);

        widget.querySelector('#csm-pill').addEventListener('click', togglePanel);
    }

    function buildPillHTML() {
        const active = accounts.find((a) => a.id === activeAccountId);
        const color = active?.color || '#4F46E5';
        const label = active?.label || 'No account';
        return `
      <div id="csm-pill" title="Claude Session Manager">
        <span class="csm-dot" style="background:${color}"></span>
        <span class="csm-label">${escHtml(label)}</span>
        <span class="csm-icon">⚡</span>
      </div>
      <div id="csm-panel" class="csm-panel csm-hidden">
        ${buildPanelHTML()}
      </div>
    `;
    }

    function buildPanelHTML() {
        const active = accounts.find((a) => a.id === activeAccountId);
        const color = active?.color || '#4F46E5';
        const label = active?.label || (accounts.length === 0 ? 'Locked' : 'No account');
        const isLocked = accounts.length === 0;

        if (isLocked) {
            return `
      <div class="csm-panel-header">
        <span class="csm-dot" style="background:#6b7280"></span>
        <span class="csm-panel-title">Locked</span>
        <button class="csm-close" id="csm-close">✕</button>
      </div>
      <div class="csm-section" style="text-align:center;padding:24px 16px">
        <div style="font-size:36px;margin-bottom:12px">🔐</div>
        <div style="font-weight:600;color:var(--csm-text);margin-bottom:8px">Extension Locked</div>
        <div style="font-size:12px;color:var(--csm-text2);line-height:1.5">
          Click the ⚡ extension icon in your toolbar<br>and enter your master password to unlock.
        </div>
      </div>
    `;
        }

        const accountItems = accounts.map((a) => {
            const isActive = a.id === activeAccountId;
            return `
        <div class="csm-account-item ${isActive ? 'csm-account-active' : ''}" 
             data-id="${a.id}" 
             title="${isActive ? 'Active account' : 'Switch to ' + escHtml(a.label)}">
          <span class="csm-dot" style="background:${a.color || '#4F46E5'}"></span>
          <span class="csm-account-label">${escHtml(a.label)}</span>
          ${isActive ? '<span class="csm-badge-active">active</span>' : '<button class="csm-switch-btn" data-id="' + a.id + '">Switch</button>'}
        </div>
      `;
        }).join('');

        return `
      <div class="csm-panel-header">
        <span class="csm-dot" style="background:${color}"></span>
        <span class="csm-panel-title">${escHtml(label)}</span>
        <button class="csm-close" id="csm-close">✕</button>
      </div>

      <div class="csm-section">
        <div class="csm-section-label">ACCOUNTS</div>
        <div id="csm-account-list">
          ${accountItems || '<div class="csm-empty">No accounts added yet.<br>Open the extension popup to add accounts.</div>'}
        </div>
      </div>

      <div class="csm-section">
        <div class="csm-section-label">CONTEXT</div>
        <div class="csm-btn-row">
          <button class="csm-btn csm-btn-secondary" id="csm-save-ctx">💾 Save Context</button>
          <button class="csm-btn csm-btn-secondary" id="csm-copy-handoff">📋 Copy Prompt</button>
          <button class="csm-btn csm-btn-secondary" id="csm-download">⬇️ Download .txt</button>
        </div>
      </div>

      <button class="csm-btn csm-btn-primary" id="csm-switch-save">
        🔄 Switch + Save Context
      </button>
    `;
    }

    function updatePill() {
        const pill = document.getElementById('csm-pill');
        if (!pill) return;
        const isLocked = accounts.length === 0;
        const active = accounts.find((a) => a.id === activeAccountId);
        const color = isLocked ? '#6b7280' : (active?.color || '#4F46E5');
        const label = isLocked ? 'Locked' : (active?.label || 'No account');
        const icon = isLocked ? '🔐' : (rateLimitDetected ? '⚠️' : '⚡');
        pill.innerHTML = `
      <span class="csm-dot" style="background:${color}"></span>
      <span class="csm-label">${escHtml(label)}</span>
      <span class="csm-icon">${icon}</span>
    `;
        const widget = document.getElementById('csm-widget');
        if (widget) {
            widget.classList.toggle('csm-rate-limit', rateLimitDetected);
        }
    }

    function refreshPanel() {
        const panel = document.getElementById('csm-panel');
        if (!panel) return;
        panel.innerHTML = buildPanelHTML();
        attachPanelEvents();
    }

    // ─── Panel toggle ─────────────────────────────────────────────────────────

    function togglePanel() {
        const panel = document.getElementById('csm-panel');
        if (!panel) return;
        widgetOpen = !widgetOpen;
        panel.classList.toggle('csm-hidden', !widgetOpen);
        if (widgetOpen) {
            loadState().then(() => refreshPanel());
        }
    }

    function attachPanelEvents() {
        const panel = document.getElementById('csm-panel');
        if (!panel) return;

        panel.querySelector('#csm-close')?.addEventListener('click', (e) => {
            e.stopPropagation();
            widgetOpen = false;
            panel.classList.add('csm-hidden');
        });

        panel.querySelectorAll('.csm-switch-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const toId = btn.dataset.id;
                handleSwitch(toId, false);
            });
        });

        panel.querySelector('#csm-save-ctx')?.addEventListener('click', (e) => {
            e.stopPropagation();
            handleSaveContext(false);
        });

        panel.querySelector('#csm-copy-handoff')?.addEventListener('click', (e) => {
            e.stopPropagation();
            handleCopyHandoff();
        });

        panel.querySelector('#csm-download')?.addEventListener('click', (e) => {
            e.stopPropagation();
            handleDownload();
        });

        panel.querySelector('#csm-switch-save')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const nextAccount = accounts.find((a) => a.id !== activeAccountId);
            if (nextAccount) handleSwitch(nextAccount.id, true);
            else showToast('⚠️ No other account to switch to. Add one in the popup.');
        });
    }

    // ─── Context extraction ───────────────────────────────────────────────────

    function extractAndBuildPrompt() {
        if (typeof window.__CS_extractConversation !== 'function') {
            return { conversation: null, prompt: 'Could not extract conversation — please try again.' };
        }
        const conversation = window.__CS_extractConversation();
        const mode = settings.contextMode || 'structured';
        const lastN = settings.lastNMessages || 6;
        const template = settings.handoffTemplate || null;
        const prompt = buildHandoffPromptInline(conversation, { mode, lastNMessages: lastN, template });
        return { conversation, prompt };
    }

    // Inlined version of context-builder.js (content scripts can't import ES modules)
    function buildHandoffPromptInline(conversation, options) {
        const { mode = 'structured', lastNMessages = 6, template = null } = options;
        const { title, messages, extractedAt } = conversation;
        const DEFAULT_TEMPLATE = `## Continuing a Previous Session\n\nI've reached my usage limit on another account and I'm continuing our conversation here. Please read the context below, acknowledge it briefly, and continue where we left off.\n\n### Conversation Topic\n{title}\n\n### Context\n{context}\n\n### Most Recent Exchange\n{recent}\n\n### Immediate Next Step\n{nextStep}\n\n---\nPlease confirm you have the context and we'll continue.`;

        if (!messages || messages.length === 0) {
            return `## Continuing a Previous Session\n\nNo conversation content could be extracted. Topic: ${title || 'Unknown'}`;
        }

        const fmt = (msgs) => msgs.map((m) => `**${m.role === 'user' ? 'You' : 'Claude'}:** ${m.content.trim()}`).join('\n\n');
        const compress = (msgs) => msgs.map((m) => `• [${m.role === 'user' ? 'User' : 'Claude'}] ${m.content.split('\n')[0].slice(0, 120)}${m.content.length > 120 ? '…' : ''}`).join('\n');
        const nextStep = () => {
            const last = [...messages].reverse().find((m) => m.role === 'user');
            return last ? last.content.split('\n')[0].slice(0, 200) : 'Continue where we left off.';
        };
        const apply = (tmpl, vars) => tmpl.replace('{title}', vars.title).replace('{context}', vars.context).replace('{recent}', vars.recent).replace('{nextStep}', vars.nextStep);

        if (mode === 'manual') return fmt(messages);

        if (mode === 'full') {
            return apply(template || DEFAULT_TEMPLATE, {
                title: title || 'Untitled', context: fmt(messages), recent: fmt(messages.slice(-3)), nextStep: nextStep(),
            });
        }

        // structured
        const recent = messages.slice(-lastNMessages);
        const earlier = messages.slice(0, Math.max(0, messages.length - lastNMessages));
        let context = '';
        if (earlier.length > 0) {
            context += '**Earlier conversation summary:**\n' + compress(earlier) + '\n\n**Recent messages (verbatim):**\n';
        }
        context += fmt(recent);
        return apply(template || DEFAULT_TEMPLATE, {
            title: title || 'Untitled', context, recent: fmt(messages.slice(-3)), nextStep: nextStep(),
        });
    }

    // ─── Manual Editor ────────────────────────────────────────────────────────

    function showManualEditor(initialText, conversation) {
        return new Promise((resolve) => {
            const existing = document.getElementById('csm-editor-modal');
            if (existing) existing.remove();

            const modal = document.createElement('div');
            modal.id = 'csm-editor-modal';
            modal.className = 'csm-modal-overlay';
            modal.innerHTML = `
        <div class="csm-modal csm-modal-large">
          <div class="csm-modal-title">Edit Context (Manual Mode)</div>
          <div class="csm-modal-body" style="text-align:left;margin-bottom:12px;font-size:12px;">
            Trim and edit the conversation text before it is carried over.
          </div>
          <textarea id="csm-editor-textarea" spellcheck="false"></textarea>
          <div class="csm-modal-actions" style="margin-top:16px;">
            <button class="csm-btn csm-btn-primary" id="csm-editor-save">Save & Continue</button>
            <button class="csm-btn csm-btn-secondary" id="csm-editor-cancel">Cancel</button>
          </div>
        </div>
      `;
            document.body.appendChild(modal);

            const textarea = modal.querySelector('#csm-editor-textarea');
            textarea.value = initialText || '';

            const close = () => {
                modal.remove();
                resolve({ cancelled: true });
            };

            modal.querySelector('#csm-editor-cancel').addEventListener('click', close);
            modal.querySelector('#csm-editor-save').addEventListener('click', () => {
                modal.remove();
                resolve({ conversation, prompt: textarea.value, cancelled: false });
            });

            textarea.focus();
        });
    }

    async function promptWithManualEditorIfNeeded() {
        const mode = settings.contextMode || 'structured';
        const { conversation, prompt } = extractAndBuildPrompt();
        if (mode === 'manual') {
            widgetOpen = false;
            document.getElementById('csm-panel')?.classList.add('csm-hidden');
            return await showManualEditor(prompt, conversation);
        }
        return { conversation, prompt, cancelled: false };
    }

    // ─── Actions ──────────────────────────────────────────────────────────────

    async function handleSaveContext(silent = false) {
        const { conversation, prompt, cancelled } = await promptWithManualEditorIfNeeded();
        if (cancelled) return null;

        handoffPromptText = prompt;
        await chrome.runtime.sendMessage({ type: 'SAVE_CONTEXT', conversation, prompt });
        if (!silent) showToast('✅ Context saved!');
        return prompt;
    }

    async function handleCopyHandoff() {
        let prompt = handoffPromptText;
        if (!prompt) {
            const res = await promptWithManualEditorIfNeeded();
            if (res.cancelled) return;
            prompt = res.prompt;
            handoffPromptText = prompt;
            await chrome.runtime.sendMessage({ type: 'SAVE_CONTEXT', conversation: null, prompt });
        }
        await navigator.clipboard.writeText(prompt);
        showToast('📋 Handoff prompt copied to clipboard!');
    }

    async function handleDownload() {
        const { conversation, prompt, cancelled } = await promptWithManualEditorIfNeeded();
        if (cancelled) return;

        handoffPromptText = prompt;
        const blob = new Blob([prompt], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const title = conversation?.title || 'claude-context';
        a.href = url;
        a.download = `${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_handoff.txt`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('⬇️ Context downloaded!');
    }

    async function handleSwitch(toId, autoSaveContext) {
        if (!activeAccountId) {
            showToast('⚠️ No active account set. Please select the current account in the popup.');
            return;
        }
        if (toId === activeAccountId) return;

        // Soft throttle check
        const now = Date.now();
        const throttleMs = (settings.switchThrottleMinutes || 10) * 60_000;
        if (lastSwitchTime && (now - lastSwitchTime) < throttleMs) {
            const proceed = await showThrottleWarning();
            if (!proceed) return;
        }

        // Save context first
        if (autoSaveContext || settings.autoSaveContext) {
            const saveRes = await handleSaveContext(true);
            if (saveRes === null) return; // User cancelled manual editor
        }

        lastSwitchTime = now;
        pendingFromId = activeAccountId;

        showToast('🔄 Switching account…', 3000);

        try {
            const result = await chrome.runtime.sendMessage({
                type: 'SWITCH_ACCOUNT',
                fromId: activeAccountId,
                toId,
            });
            if (result.error) showToast('❌ Switch failed: ' + result.error);
        } catch (e) {
            showToast('❌ Switch error: ' + e.message);
        }
    }

    // ─── Rate limit watcher ───────────────────────────────────────────────────

    function startRateLimitWatcher() {
        let watchInterval = null;

        function check() {
            const sel = settings?.selectors?.rateLimitBanner || SELECTORS_DEFAULT.rateLimitBanner;
            const el = document.querySelector(sel);
            if (el && !rateLimitDetected) {
                rateLimitDetected = true;
                updatePill();
                showRateLimitBanner();
            }
        }

        // Initial check
        check();

        // Poll every 5 seconds (MutationObserver would be more efficient but polling is simpler + reliable)
        watchInterval = setInterval(check, 5000);

        // Also use MutationObserver for faster detection
        const observer = new MutationObserver(check);
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function showRateLimitBanner() {
        const existing = document.getElementById('csm-rate-banner');
        if (existing) return;

        const banner = document.createElement('div');
        banner.id = 'csm-rate-banner';
        banner.className = 'csm-banner csm-banner-warning';
        banner.innerHTML = `
      <span>⚠️ Rate limit reached — switch account?</span>
      <div class="csm-banner-actions">
        <button class="csm-banner-btn csm-banner-btn-primary" id="csm-rate-switch">Switch Now</button>
        <button class="csm-banner-btn" id="csm-rate-dismiss">Dismiss</button>
      </div>
    `;
        document.body.appendChild(banner);

        banner.querySelector('#csm-rate-switch').addEventListener('click', () => {
            banner.remove();
            const nextAccount = accounts.find((a) => a.id !== activeAccountId);
            if (nextAccount) handleSwitch(nextAccount.id, true);
            else showToast('⚠️ No other account to switch to. Add one in the popup.');
        });

        banner.querySelector('#csm-rate-dismiss').addEventListener('click', () => {
            banner.remove();
        });
    }

    // ─── Session expiry detection ─────────────────────────────────────────────

    function checkSessionExpiry() {
        const sel = settings?.selectors?.sessionExpired || SELECTORS_DEFAULT.sessionExpired;
        // Check if we've been redirected to a login page
        if (window.location.href.includes('/login') || document.querySelector(sel)) {
            const active = accounts.find((a) => a.id === activeAccountId);
            showManualLoginBanner(active || { label: 'Your account' });
        }
    }

    function showManualLoginBanner(account) {
        const existing = document.getElementById('csm-login-banner');
        if (existing) return;

        const banner = document.createElement('div');
        banner.id = 'csm-login-banner';
        banner.className = 'csm-banner csm-banner-info';
        banner.innerHTML = `
      <span>🔑 Session expired for <strong>${escHtml(account.label || 'account')}</strong> — please sign in manually.</span>
      ${account.email ? `<button class="csm-banner-btn csm-banner-btn-primary" id="csm-copy-email">Copy Email</button>` : ''}
      <button class="csm-banner-btn" id="csm-login-dismiss">Dismiss</button>
    `;
        document.body.appendChild(banner);

        banner.querySelector('#csm-copy-email')?.addEventListener('click', async () => {
            await navigator.clipboard.writeText(account.email || account.emailDisplay || '');
            showToast('📋 Email copied!');
        });

        banner.querySelector('#csm-login-dismiss').addEventListener('click', () => {
            banner.remove();
        });
    }

    // ─── Post-switch handoff banner ───────────────────────────────────────────

    async function checkForPendingHandoff() {
        const resp = await chrome.runtime.sendMessage({ type: 'GET_PENDING_HANDOFF' });
        if (resp.handoff) {
            handoffPromptText = resp.handoff.prompt;
            showHandoffReadyBanner();
        }
    }

    function showHandoffReadyBanner() {
        const existing = document.getElementById('csm-handoff-banner');
        if (existing) return;

        const banner = document.createElement('div');
        banner.id = 'csm-handoff-banner';
        banner.className = 'csm-banner csm-banner-success';
        banner.innerHTML = `
      <span>📋 Handoff prompt ready — paste it as your first message</span>
      <div class="csm-banner-actions">
        <button class="csm-banner-btn csm-banner-btn-primary" id="csm-handoff-copy">Copy Prompt</button>
        <button class="csm-banner-btn" id="csm-handoff-dismiss">Dismiss</button>
      </div>
    `;
        document.body.appendChild(banner);

        const autoDismiss = setTimeout(() => banner.remove(), 60_000);

        banner.querySelector('#csm-handoff-copy').addEventListener('click', async () => {
            if (handoffPromptText) {
                await navigator.clipboard.writeText(handoffPromptText);
                showToast('📋 Copied! Paste as your first message.');
                banner.remove();
                clearTimeout(autoDismiss);
                await chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_HANDOFF' });
            }
        });

        banner.querySelector('#csm-handoff-dismiss').addEventListener('click', () => {
            banner.remove();
            clearTimeout(autoDismiss);
        });
    }

    // ─── Soft throttle ────────────────────────────────────────────────────────

    function showThrottleWarning() {
        return new Promise((resolve) => {
            const existing = document.getElementById('csm-throttle-modal');
            if (existing) existing.remove();

            const modal = document.createElement('div');
            modal.id = 'csm-throttle-modal';
            modal.className = 'csm-modal-overlay';
            modal.innerHTML = `
        <div class="csm-modal">
          <div class="csm-modal-icon">⚠️</div>
          <div class="csm-modal-title">Switching Frequently</div>
          <div class="csm-modal-body">You're switching accounts faster than usual. Switching frequently may flag your accounts. Do you want to continue?</div>
          <div class="csm-modal-actions">
            <button class="csm-btn csm-btn-primary" id="csm-throttle-yes">Yes, Switch</button>
            <button class="csm-btn csm-btn-secondary" id="csm-throttle-no">Cancel</button>
          </div>
        </div>
      `;
            document.body.appendChild(modal);

            modal.querySelector('#csm-throttle-yes').addEventListener('click', () => {
                modal.remove();
                resolve(true);
            });
            modal.querySelector('#csm-throttle-no').addEventListener('click', () => {
                modal.remove();
                resolve(false);
            });
        });
    }

    // ─── Toast ────────────────────────────────────────────────────────────────

    function showToast(message, duration = 2500) {
        const existing = document.getElementById('csm-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'csm-toast';
        toast.className = 'csm-toast';
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => toast.classList.add('csm-toast-visible'), 10);
        setTimeout(() => {
            toast.classList.remove('csm-toast-visible');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // ─── Utils ────────────────────────────────────────────────────────────────

    function escHtml(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    // ─── Boot ─────────────────────────────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
