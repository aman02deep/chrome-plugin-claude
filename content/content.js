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
    let lastSavedConversation = null; // Tracks the most recently saved conversation for bridge writing on switch

    const SELECTORS_DEFAULT = {
        rateLimitBanner: '[data-testid="rate-limit-message"], .rate-limit, [class*="UsageLimitBanner"], [class*="rate-limit"]',
        sessionExpired: 'form[action*="/login"], [class*="LoginPage"]',
    };

    // ─── Init ─────────────────────────────────────────────────────────────────

    async function init() {
        // Small delay to let the page fully settle
        await sleep(1200);
        await loadState();
        await loadHandoffBridge();
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

    // ─── Handoff Bridge (cross-account Thread ID storage) ─────────────────────

    async function loadHandoffBridge() {
        try {
            const result = await chrome.storage.local.get(['__csmHandoffBridge']);
            const b = result.__csmHandoffBridge || {};
            const FOUR_HOURS = 4 * 60 * 60 * 1000;
            if (b.savedAt && (Date.now() - b.savedAt) < FOUR_HOURS) {
                window.__CSM_handoffBridge = b;
            } else {
                // Bridge is stale or missing — discard
                window.__CSM_handoffBridge = {};
                if (b.savedAt) chrome.storage.local.remove(['__csmHandoffBridge']);
            }
        } catch (e) {
            window.__CSM_handoffBridge = {};
        }
    }

    async function saveHandoffBridge(threadId, originalTitle, chatId) {
        const bridge = { threadId, originalTitle, sourceChatId: chatId, savedAt: Date.now() };
        window.__CSM_handoffBridge = bridge;
        try {
            await chrome.storage.local.set({ __csmHandoffBridge: bridge });
        } catch (e) { /* non-critical */ }
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

      <div class="csm-section">
        <div class="csm-section-label">CONTEXT HISTORY <span id="csm-history-count" style="opacity:0.5;font-weight:400;font-size:10px"></span></div>
        <div id="csm-history-list"><div class="csm-empty">Loading…</div></div>
      </div>
    `;
    }

    function buildHistoryGroupHTML(group) {
        const relTime = formatRelTime(group.savedAt);
        const saveCount = group.saves?.length || 0;
        const subRows = (group.saves || []).map((s, i) => `
          <div class="csm-history-save" data-save-id="${escHtml(s.id)}" data-group-id="${escHtml(group.id)}">
            <span class="csm-history-save-label">${escHtml(s.accountLabel || 'Account')} · ${formatRelTime(s.savedAt)}</span>
            <div class="csm-history-save-actions">
              <button class="csm-hist-btn" data-action="edit-save" data-save-id="${escHtml(s.id)}" title="Edit this session's prompt before copying">Edit</button>
              <button class="csm-hist-btn" data-action="copy-save" data-save-id="${escHtml(s.id)}" title="Copy this session's prompt">Copy</button>
              <button class="csm-hist-btn csm-hist-btn-del" data-action="del-save" data-save-id="${escHtml(s.id)}" data-group-id="${escHtml(group.id)}" title="Delete this session">✕</button>
            </div>
          </div>
        `).join('');

        return `
        <div class="csm-history-group" data-group-id="${escHtml(group.id)}">
          <div class="csm-history-group-header">
            <span class="csm-history-group-title" title="${escHtml(group.title)}">${escHtml(group.title)}</span>
            <div class="csm-history-group-meta">${saveCount} save${saveCount !== 1 ? 's' : ''} · ${relTime}</div>
            <div class="csm-history-group-actions">
              <button class="csm-hist-btn csm-hist-btn-primary" data-action="copy-consolidated" data-group-id="${escHtml(group.id)}" title="Copy merged prompt from all sessions">📋 Copy All</button>
              <button class="csm-hist-btn csm-hist-btn-del" data-action="del-group" data-group-id="${escHtml(group.id)}" title="Delete entire thread">🗑️</button>
            </div>
          </div>
          <div class="csm-history-saves">${subRows}</div>
        </div>`;
    }

    function formatRelTime(isoStr) {
        if (!isoStr) return '';
        const diff = Date.now() - new Date(isoStr).getTime();
        const min = Math.floor(diff / 60_000);
        if (min < 1) return 'just now';
        if (min < 60) return `${min}m ago`;
        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr}h ago`;
        return `${Math.floor(hr / 24)}d ago`;
    }

    async function loadHistoryIntoPanel() {
        const listEl = document.getElementById('csm-history-list');
        const countEl = document.getElementById('csm-history-count');
        if (!listEl) return;

        const resp = await chrome.runtime.sendMessage({ type: 'GET_CONTEXT_HISTORY' });
        const history = resp.history || [];
        if (countEl) countEl.textContent = history.length ? `(${history.length})` : '';

        if (!history.length) {
            listEl.innerHTML = '<div class="csm-empty">No context saved yet.</div>';
            return;
        }

        listEl.innerHTML = history.map(buildHistoryGroupHTML).join('');

        // Store saves lookup for copy handlers
        window.__CSM_historyData = history;

        listEl.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                const groupId = btn.dataset.groupId;
                const saveId = btn.dataset.saveId;
                const allHistory = window.__CSM_historyData || [];

                if (action === 'copy-consolidated') {
                    const group = allHistory.find(g => g.id === groupId);
                    if (group) {
                        const prompt = buildConsolidatedPrompt(group);
                        await navigator.clipboard.writeText(prompt);
                        showToast('📋 Consolidated prompt copied! Paste into new chat.');
                    }
                } else if (action === 'copy-save') {
                    const group = allHistory.find(g => g.saves?.some(s => s.id === saveId));
                    const save = group?.saves?.find(s => s.id === saveId);
                    if (save?.prompt) {
                        await navigator.clipboard.writeText(save.prompt);
                        showToast('📋 Session prompt copied!');
                    }
                } else if (action === 'edit-save') {
                    const group = allHistory.find(g => g.saves?.some(s => s.id === saveId));
                    const save = group?.saves?.find(s => s.id === saveId);
                    if (save?.prompt) {
                        widgetOpen = false;
                        document.getElementById('csm-panel')?.classList.add('csm-hidden');
                        const res = await showEditSaveModal(save.prompt);
                        if (res.action === 'copy') {
                            await navigator.clipboard.writeText(res.prompt);
                            showToast('📋 Edited prompt copied to clipboard!');
                        } else if (res.action === 'save') {
                            await chrome.runtime.sendMessage({ type: 'UPDATE_CONTEXT_PROMPT', saveId, prompt: res.prompt });
                            showToast('💾 Changes saved!');
                        }
                    }
                } else if (action === 'del-save') {
                    if (!confirm('Delete this session from the thread?')) return;
                    await chrome.runtime.sendMessage({ type: 'DELETE_CONTEXT', saveId });
                    loadHistoryIntoPanel();
                } else if (action === 'del-group') {
                    if (!confirm('Delete entire thread history?')) return;
                    await chrome.runtime.sendMessage({ type: 'DELETE_CONTEXT', groupId });
                    loadHistoryIntoPanel();
                }
            });
        });
    }

    function extractSessionContent(prompt, fullContent) {
        if (!prompt) return '';
        if (fullContent) {
            // ### Context already contains the summary bullets + Recent messages verbatim.
            // Stop before ### Most Recent Exchange to avoid duplicating that content.
            const contextMatch = prompt.match(/### Context\n([\s\S]*?)(?=\n### Most Recent Exchange|\n### Immediate|\n---\n|\[CSM-Thread-ID|$)/);
            if (contextMatch) return contextMatch[1].trim();
            // Fallback: strip outer template noise
            return prompt
                .replace(/^## Continuing a Previous Session[\s\S]*?### Context\n/, '### Context\n')
                .replace(/### Most Recent Exchange[\s\S]*$/, '')
                .replace(/\[CSM-Thread-ID:[^\]]*\]\s*$/, '')
                .replace(/---\nPlease confirm[\s\S]*$/, '')
                .trim();
        } else {
            // Older sessions: just the Context section up to Most Recent Exchange
            const match = prompt.match(/### Context\n([\s\S]*?)(?=\n### Most Recent Exchange|\n---\n|$)/);
            return match ? match[1].trim() : prompt.slice(0, 800) + '\u2026';
        }
    }

    function buildConsolidatedPrompt(group) {
        const sessions = group.saves || [];
        if (!sessions.length) return '';

        const sessionSections = sessions.map((s, i) => {
            const isLast = i === sessions.length - 1;
            const label = `Session ${i + 1} \u2014 ${s.accountLabel} (${formatRelTime(s.savedAt)})`;
            const content = extractSessionContent(s.prompt, isLast);
            return isLast
                ? `### ${label} \u2190 MOST RECENT\n${content}`
                : `### ${label}\n${content}`;
        }).join('\n\n---\n\n');

        return `## Continuing a Previous Session (${sessions.length} sessions)\n\nI've reached my usage limit on another account and I'm continuing our conversation here. Please read the full context below, acknowledge it briefly, and continue where we left off.\n\n### Conversation Thread\n${group.title}\n\n${sessionSections}`;
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
            loadState().then(() => {
                refreshPanel();
                loadHistoryIntoPanel();
            });
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

    }

    // ─── Context extraction ───────────────────────────────────────────────────

    function extractAndBuildPrompt() {
        if (typeof window.__CS_extractConversation !== 'function') {
            return { conversation: null, prompt: 'Could not extract conversation — please try again.' };
        }
        const conversation = window.__CS_extractConversation();

        // Associate the context with this specific chat UI to prevent duplicates
        const match = window.location.pathname.match(/^\/chat\/([a-f0-9\-]+)/);
        if (match && conversation) {
            conversation.chatId = match[1];
        }

        // Thread ID & Original Title come from storage (written by the previous account's save).
        // We read synchronously from a cached copy held in memory (set at page load).
        // See: loadHandoffBridge() called during init.
        const bridge = window.__CSM_handoffBridge || {};
        const FOUR_HOURS = 4 * 60 * 60 * 1000;
        const isBridgeValid = bridge.threadId &&
            bridge.sourceChatId &&
            bridge.savedAt &&
            (Date.now() - bridge.savedAt) < FOUR_HOURS;
        let threadId, originalTitle;

        const chatId = conversation?.chatId;
        // Bridge is usable if it's valid AND either:
        //   (a) not yet consumed by any chat, OR
        //   (b) already consumed by THIS specific chat (repeated saves on same chat)
        const bridgeUsable = isBridgeValid &&
            bridge.sourceChatId !== chatId &&
            (!bridge.consumedByChatId || bridge.consumedByChatId === chatId);

        if (bridgeUsable) {
            // Inherit thread from previous account's context
            threadId = bridge.threadId;
            originalTitle = bridge.originalTitle;
            // Mark bridge as consumed by this chat so OTHER chats don't inherit it
            if (!bridge.consumedByChatId) {
                const consumed = { ...bridge, consumedByChatId: chatId };
                window.__CSM_handoffBridge = consumed;
                chrome.storage.local.set({ __csmHandoffBridge: consumed });
            }
        } else {
            // Different chat or no/stale bridge — fresh group anchored to this chatId
            threadId = chatId || crypto.randomUUID();
            originalTitle = (isBridgeValid ? bridge.originalTitle : null) || conversation?.title || 'Untitled';
        }

        if (conversation) {
            conversation.threadId = threadId;
            conversation.originalTitle = originalTitle;

            // Strip leftover boilerplate from previous handoff pastes
            conversation.messages = (conversation.messages || []).map((msg) => {
                let content = msg.content;

                if (msg.role === 'user' && content.includes('## Continuing a Previous Session')) {
                    const summaryMatch = content.match(/\*\*Earlier conversation summary:\*\*\s*([\s\S]*?)\n\n\*\*Recent messages/);
                    const verbatimMatch = content.match(/\*\*Recent messages \(verbatim\):\*\*\s*([\s\S]*?)\n\n### Most Recent Exchange/);
                    const manualMatch = content.match(/## Continuing a Previous Session[\s\S]*?### Context\n([\s\S]*?)\n\n### Most Recent Exchange/);

                    if (summaryMatch || verbatimMatch) {
                        content = (summaryMatch ? summaryMatch[1].trim() + '\n\n' : '') +
                            (verbatimMatch ? verbatimMatch[1].trim() : '');
                    } else if (manualMatch) {
                        content = manualMatch[1].trim();
                    } else {
                        content = content.replace(/## Continuing a Previous Session[\s\S]*?### Context\n/, '')
                            .replace(/### Most Recent Exchange[\s\S]*$/, '');
                    }
                }

                content = content.replace(/\[CSM-Thread-ID:.*?\]\s*$/m, '').trim();
                content = content.replace(/^\*\*You:\*\*\s*/i, '');
                content = content.replace(/^\*\*Claude:\*\*\s*/i, '');

                return { ...msg, content };
            }).filter((msg) => msg.content.trim() !== '');
        }

        const mode = settings.contextMode || 'structured';
        const lastN = settings.lastNMessages || 6;
        const template = settings.handoffTemplate || null;
        const prompt = buildHandoffPromptInline(conversation, { mode, lastNMessages: lastN, template, threadId });
        return { conversation, prompt };
    }

    // Inlined version of context-builder.js (content scripts can't import ES modules)
    function buildHandoffPromptInline(conversation, options) {
        const { mode = 'structured', lastNMessages = 6, template = null, threadId } = options;
        const { title, messages, originalTitle } = conversation;
        const DEFAULT_TEMPLATE = `## Continuing a Previous Session\n\nI've reached my usage limit on another account and I'm continuing our conversation here. Please read the context below, acknowledge it briefly, and continue where we left off.\n\n### Conversation Topic\n{title}\n\n### Context\n{context}\n\n### Most Recent Exchange\n{recent}\n\n### Immediate Next Step\n{nextStep}\n\n---\nPlease confirm you have the context and we'll continue.`;

        const finalTitle = originalTitle || title || 'Untitled';

        const attachThreadId = (p) => {
            return p + `\n\n[CSM-Thread-ID: ${threadId} | Original Title: ${finalTitle}]`;
        };

        if (!messages || messages.length === 0) {
            return attachThreadId(`## Continuing a Previous Session\n\nNo conversation content could be extracted. Topic: ${title || 'Unknown'}`);
        }

        const fmt = (msgs) => msgs.map((m) => `**${m.role === 'user' ? 'You' : 'Claude'}:** ${m.content.trim()}`).join('\n\n');
        const compress = (msgs) => msgs.map((m) => `• [${m.role === 'user' ? 'User' : 'Claude'}] ${m.content.split('\n')[0].slice(0, 120)}${m.content.length > 120 ? '…' : ''}`).join('\n');
        const nextStep = () => {
            const last = [...messages].reverse().find((m) => m.role === 'user');
            return last ? last.content.split('\n')[0].slice(0, 200) : 'Continue where we left off.';
        };
        const apply = (tmpl, vars) => tmpl.replace('{title}', vars.title).replace('{context}', vars.context).replace('{recent}', vars.recent).replace('{nextStep}', vars.nextStep);

        if (mode === 'manual') return attachThreadId(fmt(messages));

        if (mode === 'full') {
            return attachThreadId(apply(template || DEFAULT_TEMPLATE, {
                title: title || 'Untitled', context: fmt(messages), recent: fmt(messages.slice(-3)), nextStep: nextStep(),
            }));
        }

        // structured
        const recent = messages.slice(-lastNMessages);
        const earlier = messages.slice(0, Math.max(0, messages.length - lastNMessages));
        let context = '';
        if (earlier.length > 0) {
            context += '**Earlier conversation summary:**\n' + compress(earlier) + '\n\n**Recent messages (verbatim):**\n';
        }
        context += fmt(recent);
        return attachThreadId(apply(template || DEFAULT_TEMPLATE, {
            title: title || 'Untitled', context, recent: fmt(messages.slice(-3)), nextStep: nextStep(),
        }));
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

    function showEditSaveModal(initialText) {
        return new Promise((resolve) => {
            const existing = document.getElementById('csm-editor-modal');
            if (existing) existing.remove();

            const modal = document.createElement('div');
            modal.id = 'csm-editor-modal';
            modal.className = 'csm-modal-overlay';
            modal.innerHTML = `
        <div class="csm-modal csm-modal-large">
          <div class="csm-modal-title">Edit Session Context</div>
          <div class="csm-modal-body" style="text-align:left;margin-bottom:12px;font-size:12px;">
            Clean up this session's prompt text before copying it or saving it permanently.
          </div>
          <textarea id="csm-editor-textarea" spellcheck="false"></textarea>
          <div class="csm-modal-actions" style="margin-top:16px;">
            <button class="csm-btn csm-btn-primary" id="csm-editor-copy">📋 Copy</button>
            <button class="csm-btn csm-btn-secondary" id="csm-editor-save" style="flex:1.5;">💾 Save Changes</button>
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
            modal.querySelector('#csm-editor-copy').addEventListener('click', () => {
                modal.remove();
                resolve({ prompt: textarea.value, action: 'copy' });
            });
            modal.querySelector('#csm-editor-save').addEventListener('click', () => {
                modal.remove();
                resolve({ prompt: textarea.value, action: 'save' });
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

    // writeBridge=true only when called as part of an explicit account handoff (Switch+Save)
    async function handleSaveContext(silent = false, writeBridge = false) {
        const { conversation, prompt, cancelled } = await promptWithManualEditorIfNeeded();
        if (cancelled) return null;

        handoffPromptText = prompt;
        const activeAccount = accounts.find(a => a.id === activeAccountId);
        const accountLabel = activeAccount?.label || 'Unknown account';
        await chrome.runtime.sendMessage({ type: 'SAVE_CONTEXT', conversation, prompt, accountLabel });
        // Always track the last saved conversation so switch can write the bridge
        if (conversation?.threadId) lastSavedConversation = conversation;
        if (writeBridge && conversation?.threadId) {
            await saveHandoffBridge(conversation.threadId, conversation.originalTitle, conversation.chatId);
        }
        if (!silent) showToast('\u2705 Context saved!');
        return { prompt, conversation };
    }

    async function handleCopyHandoff() {
        let prompt = handoffPromptText;
        let savedConversation = null;
        if (!prompt) {
            const res = await promptWithManualEditorIfNeeded();
            if (res.cancelled) return;
            prompt = res.prompt;
            savedConversation = res.conversation;
            handoffPromptText = prompt;
            await chrome.runtime.sendMessage({ type: 'SAVE_CONTEXT', conversation: savedConversation, prompt });
        }
        // Write bridge so the next account can inherit this thread's ID
        if (savedConversation?.threadId) {
            await saveHandoffBridge(savedConversation.threadId, savedConversation.originalTitle, savedConversation.chatId);
        }
        await navigator.clipboard.writeText(prompt);
        showToast('\ud83d\udccb Handoff prompt copied to clipboard!');
    }

    async function handleDownload() {
        const { conversation, prompt, cancelled } = await promptWithManualEditorIfNeeded();
        if (cancelled) return;

        handoffPromptText = prompt;
        // Write bridge so the next account can inherit this thread's ID
        if (conversation?.threadId) {
            await saveHandoffBridge(conversation.threadId, conversation.originalTitle, conversation.chatId);
        }
        const blob = new Blob([prompt], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const title = conversation?.originalTitle || conversation?.title || 'claude-context';
        a.href = url;
        a.download = `${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_handoff.txt`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('\u2b07\ufe0f Context downloaded!');
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

        // Bridge + optional save
        if (lastSavedConversation?.threadId) {
            // User already saved manually this session — just write the bridge, no duplicate save
            await saveHandoffBridge(lastSavedConversation.threadId, lastSavedConversation.originalTitle, lastSavedConversation.chatId);
        } else if (autoSaveContext) {
            // Only auto-save when user explicitly clicks "Switch + Save Context" (autoSaveContext=true)
            // Plain "Switch" never auto-saves — user must click Save Context manually first
            const saveRes = await handleSaveContext(true, true);
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
