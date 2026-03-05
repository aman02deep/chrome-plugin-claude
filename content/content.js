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
        <div class="csm-btn-grid">
          <button class="csm-btn csm-btn-secondary" id="csm-save-ctx">💾 Save Context</button>
          <button class="csm-btn csm-btn-secondary" id="csm-view-ctx">📋 Contexts</button>
          <button class="csm-btn csm-btn-secondary" id="csm-copy-handoff">📋 Copy Prompt</button>
          <button class="csm-btn csm-btn-secondary" id="csm-download">⬇️ Download .txt</button>
        </div>
      </div>
    `;
    }

    // buildHistoryGroupHTML is now only used inside showGroupPickerOverlay (browse mode)
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

    // --- Token & Size Estimation ---
    function estimatePromptMetrics(text) {
        if (!text) return { bytes: 0, tokens: 0, sizeStr: '0 KB', tokenStr: '0 tokens' };

        // Exact byte size using Blob
        const bytes = new Blob([text]).size;

        // Heuristic: ~4 chars per token for English/Code
        const tokens = Math.ceil(text.length / 4);

        return {
            bytes,
            tokens,
            sizeStr: formatBytes(bytes),
            tokenStr: formatTokens(tokens)
        };
    }

    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        // Use 1 decimal place max for KB/MB
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    function formatTokens(tokens) {
        if (tokens < 1000) return `${tokens} tokens`;
        // Format thousands (e.g., 4200 -> 4.2k)
        return `${(tokens / 1000).toFixed(1)}k tokens`;
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

                    if (save) {
                        let promptText = save.prompt;
                        // Dynamically build from raw conversation using the user's chosen mode.
                        // Copy All (consolidated) always uses structured regardless of this setting.
                        if (save.conversation) {
                            const mode = settings.contextMode || 'full';
                            const lastN = settings.lastNMessages || 6;
                            const template = settings.handoffTemplate || null;
                            promptText = buildHandoffPromptInline(save.conversation, { mode, lastNMessages: lastN, template, threadId: group.threadId || group.id });
                        }
                        await navigator.clipboard.writeText(promptText);
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

    function extractSessionContent(saveData, isLast, groupThreadId) {
        if (!saveData.prompt && !saveData.conversation) return '';

        // If we stored the raw conversation, dynamically build the structured context NOW
        if (saveData.conversation) {
            const mode = settings.contextMode || 'full';
            const lastN = settings.lastNMessages || 6;
            const template = settings.handoffTemplate || null;
            const rawPrompt = buildHandoffPromptInline(saveData.conversation, { mode, lastNMessages: lastN, template, threadId: groupThreadId });

            // Extract just the context parts so it fits nicely in the consolidated wrapper
            const contextMatch = rawPrompt.match(/### Context\n([\s\S]*?)(?=\n### Most Recent Exchange|\n### Immediate|\n---\n|\[CSM-Thread-ID|$)/);
            return contextMatch ? contextMatch[1].trim() : rawPrompt;
        }

        const prompt = saveData.prompt;
        if (isLast) {
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
            const content = extractSessionContent(s, isLast, group.threadId || group.id);
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
            handleSaveContext();
        });

        panel.querySelector('#csm-view-ctx')?.addEventListener('click', (e) => {
            e.stopPropagation();
            handleViewContexts();
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

        // Associate the context with this specific chat URL
        const match = window.location.pathname.match(/^\/chat\/([a-f0-9\-]+)/);
        if (match && conversation) conversation.chatId = match[1];

        // Read bridge to suggest a pre-selected group (read-only — user picks explicitly)
        const bridge = window.__CSM_handoffBridge || {};
        const FOUR_HOURS = 4 * 60 * 60 * 1000;
        const isBridgeValid = bridge.threadId && bridge.savedAt && (Date.now() - bridge.savedAt) < FOUR_HOURS;

        if (conversation) {
            // Use bridge's original title if available, otherwise current chat title
            conversation.originalTitle = (isBridgeValid ? bridge.originalTitle : null) || conversation.title || 'Untitled';
            conversation.bridgeThreadId = isBridgeValid ? bridge.threadId : null;

            // Strip leftover boilerplate from previous handoff pastes
            // We check for both the old "Continuing a Previous Session" and the new "Conversation Thread" headers
            conversation.messages = (conversation.messages || []).map((msg) => {
                let content = msg.content;
                if (msg.role === 'user' && (content.includes('## Conversation Thread') || content.includes('## Continuing a Previous Session'))) {
                    const summaryMatch = content.match(/\*\*Earlier conversation summary:\*\*\s*([\s\S]*?)\n\n\*\*Recent messages/);
                    const verbatimMatch = content.match(/\*\*Recent messages \(verbatim\):\*\*\s*([\s\S]*?)\n\n### Most Recent Exchange/);
                    const manualMatchNew = content.match(/## Conversation Thread[\s\S]*?### Context\n([\s\S]*?)\n\n### Most Recent Exchange/);
                    const manualMatchOld = content.match(/## Continuing a Previous Session[\s\S]*?### Context\n([\s\S]*?)\n\n### Most Recent Exchange/);

                    if (summaryMatch || verbatimMatch) {
                        content = (summaryMatch ? summaryMatch[1].trim() + '\n\n' : '') + (verbatimMatch ? verbatimMatch[1].trim() : '');
                    } else if (manualMatchNew) {
                        content = manualMatchNew[1].trim();
                    } else if (manualMatchOld) {
                        content = manualMatchOld[1].trim();
                    } else {
                        content = content.replace(/## Conversation Thread[\s\S]*?### Context\n/, '')
                            .replace(/## Continuing a Previous Session[\s\S]*?### Context\n/, '')
                            .replace(/### Most Recent Exchange[\s\S]*$/, '');
                    }
                }
                content = content.replace(/\[CSM-Thread-ID:.*?\]\s*$/m, '').trim();
                content = content.replace(/^\*\*You:\*\*\s*/i, '');
                content = content.replace(/^\*\*Claude:\*\*\s*/i, '');
                return { ...msg, content };
            }).filter((msg) => msg.content.trim() !== '');
        }

        const mode = settings.contextMode || 'full';
        const lastN = settings.lastNMessages || 6;
        const template = settings.handoffTemplate || null;
        // Build prompt with a placeholder threadId; the real threadId is set after user picks a group
        const prompt = buildHandoffPromptInline(conversation, { mode, lastNMessages: lastN, template, threadId: conversation?.chatId || crypto.randomUUID() });
        return { conversation, prompt };
    }

    function buildHandoffPromptInline(conversation, options) {
        const { mode = 'structured', lastNMessages = 6, template = null, threadId } = options;
        const { title, messages, originalTitle } = conversation;
        const DEFAULT_TEMPLATE = `## Conversation Thread\n\nPlease read the context below, acknowledge it briefly, and continue where we left off.\n\n### Conversation Topic\n{title}\n\n### Context\n{context}\n\n### Most Recent Exchange\n{recent}\n\n### Immediate Next Step\n{nextStep}\n\n---\nPlease confirm you have the context and we'll continue.`;

        const finalTitle = originalTitle || title || 'Untitled';

        const attachThreadId = (p) => {
            return p + `\n\n[CSM-Thread-ID: ${threadId} | Original Title: ${finalTitle}]`;
        };

        if (!messages || messages.length === 0) {
            return attachThreadId(`## Conversation Thread\n\nNo conversation content could be extracted. Topic: ${title || 'Unknown'}`);
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
        const mode = settings.contextMode || 'full';
        const { conversation, prompt } = extractAndBuildPrompt();
        if (mode === 'manual') {
            widgetOpen = false;
            document.getElementById('csm-panel')?.classList.add('csm-hidden');
            return await showManualEditor(prompt, conversation);
        }
        return { conversation, prompt, cancelled: false };
    }

    // ─── Group Picker Overlay ──────────────────────────────────────────────────

    /**
     * showGroupPickerOverlay(mode, extractedData)
     *   mode: 'save' — shows group picker so user selects where to save
     *   mode: 'browse' — shows all groups + sub-entries for copy/delete
     *   extractedData: { conversation, prompt } — only used in 'save' mode
     */
    async function showGroupPickerOverlay(mode, extractedData) {
        const existing = document.getElementById('csm-picker-overlay');
        if (existing) existing.remove();

        // Fetch current history
        const resp = await chrome.runtime.sendMessage({ type: 'GET_CONTEXT_HISTORY' });
        const history = resp.history || [];

        const overlay = document.createElement('div');
        overlay.id = 'csm-picker-overlay';
        overlay.className = 'csm-picker-overlay';

        const isSave = mode === 'save';
        const conversation = extractedData?.conversation || null;
        const promptText = extractedData?.prompt || null;

        // Determine suggested group (from bridge)
        const suggestedThreadId = conversation?.bridgeThreadId || null;

        overlay.innerHTML = `
          <div class="csm-picker-modal">
            <div class="csm-picker-header">
              <span style="font-size:20px">${isSave ? '💾' : '📋'}</span>
              <span class="csm-picker-title">${isSave ? 'Save Context' : 'Saved Contexts'}</span>
              <button class="csm-close" id="csm-picker-close">✕</button>
            </div>
            ${isSave ? `<div class="csm-picker-subtitle">Choose where to save this context, or create a new thread.</div>` : `<div class="csm-picker-subtitle">${history.length} thread${history.length !== 1 ? 's' : ''} saved</div>`}
            <div class="csm-picker-list" id="csm-picker-list">
              ${isSave ? buildPickerSaveMode(history, conversation, suggestedThreadId) : buildPickerBrowseMode(history)}
            </div>
            ${isSave ? `
            <div class="csm-picker-actions">
              <button class="csm-btn csm-btn-primary" id="csm-picker-save">💾 Save Here</button>
              <button class="csm-btn csm-btn-secondary" id="csm-picker-cancel">Cancel</button>
            </div>` : ''}
          </div>
        `;

        document.body.appendChild(overlay);

        // State for save mode
        let selectedGroupId = null; // null = new thread
        let isNewThread = true;

        // If bridge suggests a group, pre-select it
        if (isSave && suggestedThreadId) {
            const match = history.find(g => g.threadId === suggestedThreadId);
            if (match) {
                selectedGroupId = match.id;
                isNewThread = false;
                overlay.querySelector(`[data-group-id="${match.id}"]`)?.classList.add('csm-picker-selected');
                overlay.querySelector('.csm-picker-new-thread')?.classList.remove('csm-picker-selected');
            } else {
                // Bridge group not found — default to new thread
                overlay.querySelector('.csm-picker-new-thread')?.classList.add('csm-picker-selected');
            }
        } else if (isSave) {
            // Default: new thread selected
            overlay.querySelector('.csm-picker-new-thread')?.classList.add('csm-picker-selected');
        }

        // ── Event wiring ──

        overlay.querySelector('#csm-picker-close')?.addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        if (isSave) {
            // New thread row click
            const newRow = overlay.querySelector('.csm-picker-new-thread');
            newRow?.addEventListener('click', (e) => {
                if (e.target.tagName === 'INPUT') return; // Let input handle itself
                setPickerSelection(overlay, null);
                selectedGroupId = null;
                isNewThread = true;
                newRow.querySelector('.csm-picker-new-input')?.focus();
            });

            // Existing group row clicks
            overlay.querySelectorAll('.csm-picker-group-row').forEach(row => {
                row.addEventListener('click', () => {
                    selectedGroupId = row.dataset.groupId;
                    isNewThread = false;
                    setPickerSelection(overlay, row.dataset.groupId);
                });
            });

            // Save button
            overlay.querySelector('#csm-picker-save')?.addEventListener('click', async () => {
                const activeAccount = accounts.find(a => a.id === activeAccountId);
                const accountLabel = activeAccount?.label || 'Unknown account';

                let threadId, title;
                if (isNewThread || !selectedGroupId) {
                    const input = overlay.querySelector('.csm-picker-new-input');
                    title = input?.value.trim() || conversation?.originalTitle || conversation?.title || 'Untitled';
                    threadId = crypto.randomUUID();
                } else {
                    const group = history.find(g => g.id === selectedGroupId);
                    threadId = group?.threadId || selectedGroupId;
                    title = group?.title || 'Untitled';
                }

                // Rebuild prompt with the correct threadId
                const finalPrompt = promptText
                    ? promptText.replace(/\[CSM-Thread-ID:[^\]]*\]/, `[CSM-Thread-ID: ${threadId} | Original Title: ${title}]`)
                    : promptText;

                handoffPromptText = finalPrompt;

                await chrome.runtime.sendMessage({
                    type: 'SAVE_CONTEXT',
                    conversation: { ...conversation, threadId, originalTitle: title },
                    prompt: finalPrompt,
                    accountLabel,
                    explicitThreadId: threadId,
                });

                overlay.remove();
                showToast('✅ Context saved!');
            });

            overlay.querySelector('#csm-picker-cancel')?.addEventListener('click', () => overlay.remove());
        } else {
            // Browse mode — wire copy/delete buttons
            wireBrowseActions(overlay, history);
        }
    }

    function setPickerSelection(overlay, groupId) {
        overlay.querySelectorAll('.csm-picker-group-row').forEach(r => r.classList.remove('csm-picker-selected'));
        overlay.querySelector('.csm-picker-new-thread')?.classList.remove('csm-picker-selected');
        if (groupId === null) {
            overlay.querySelector('.csm-picker-new-thread')?.classList.add('csm-picker-selected');
        } else {
            overlay.querySelector(`[data-group-id="${groupId}"]`)?.classList.add('csm-picker-selected');
        }
    }

    function buildPickerSaveMode(history, conversation, suggestedThreadId) {
        const chatTitle = conversation?.originalTitle || conversation?.title || 'Untitled';
        const newThreadRow = `
          <div class="csm-picker-new-thread">
            <span class="csm-picker-new-icon">✨</span>
            <input class="csm-picker-new-input" type="text" placeholder="New thread name…" value="${escHtml(chatTitle)}" maxlength="120" />
          </div>`;

        if (!history.length) return newThreadRow;

        const groupRows = history.map(g => {
            const saveCount = g.saves?.length || 0;
            const lastSavePrompt = g.saves?.[g.saves.length - 1]?.prompt || '';
            const previewText = lastSavePrompt.substring(0, 150).replace(/\n/g, ' ') + (lastSavePrompt.length > 150 ? '…' : '');

            // Calculate consolidated metrics for the whole group
            const consolidatedPrompt = buildConsolidatedPrompt(g);
            const metrics = estimatePromptMetrics(consolidatedPrompt);

            return `
            <div class="csm-picker-group-row" data-group-id="${escHtml(g.id)}">
              <div class="csm-picker-radio"></div>
              <div class="csm-picker-group-info">
                <div class="csm-picker-group-name" title="${escHtml(g.title)}">${escHtml(g.title)}</div>
                <div class="csm-picker-group-meta">${saveCount} save${saveCount !== 1 ? 's' : ''} · ${formatRelTime(g.savedAt)} <span class="csm-picker-metrics">· ~${metrics.tokenStr} (${metrics.sizeStr})</span></div>
                ${previewText ? `<div class="csm-picker-group-preview">${escHtml(previewText)}</div>` : ''}
              </div>
            </div>`;
        }).join('');

        return newThreadRow + groupRows;
    }

    function buildPickerBrowseMode(history) {
        if (!history.length) {
            return `<div class="csm-picker-empty"><div class="csm-picker-empty-icon">📭</div>No contexts saved yet.<br>Use "💾 Save Context" to save your first one.</div>`;
        }
        return history.map(g => {
            const saveCount = g.saves?.length || 0;
            const lastSavePrompt = g.saves?.[g.saves.length - 1]?.prompt || '';
            const previewText = lastSavePrompt.substring(0, 150).replace(/\n/g, ' ') + (lastSavePrompt.length > 150 ? '…' : '');

            // Calculate consolidated metrics for the whole group
            const consolidatedPrompt = buildConsolidatedPrompt(g);
            const groupMetrics = estimatePromptMetrics(consolidatedPrompt);

            const subRows = (g.saves || []).map(s => {
                // Calculate metrics for this specific save
                const saveMetrics = estimatePromptMetrics(s.prompt);

                return `
              <div class="csm-picker-save-row">
                <span class="csm-picker-save-label">${escHtml(s.accountLabel || 'Account')} · ${formatRelTime(s.savedAt)} <span class="csm-picker-metrics sub-metrics">· ~${saveMetrics.tokenStr}</span></span>
                <div class="csm-picker-save-actions">
                  <button class="csm-hist-btn" data-action="copy-save" data-save-id="${escHtml(s.id)}">Copy</button>
                  <button class="csm-hist-btn" data-action="move-save" data-save-id="${escHtml(s.id)}" data-group-id="${escHtml(g.id)}" title="Move to another thread">Move</button>
                  <button class="csm-hist-btn csm-hist-btn-del" data-action="del-save" data-save-id="${escHtml(s.id)}" data-group-id="${escHtml(g.id)}">✕</button>
                </div>
              </div>`;
            }).join('');

            return `
            <div class="csm-picker-group-row" style="cursor:default;flex-direction:column;align-items:stretch;gap:0">
              <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px">
                <div class="csm-picker-group-info">
                  <div class="csm-picker-group-name" title="${escHtml(g.title)}">${escHtml(g.title)}</div>
                  <div class="csm-picker-group-meta">${saveCount} save${saveCount !== 1 ? 's' : ''} · ${formatRelTime(g.savedAt)} <span class="csm-picker-metrics">· ~${groupMetrics.tokenStr} (${groupMetrics.sizeStr})</span></div>
                  ${previewText ? `<div class="csm-picker-group-preview">${escHtml(previewText)}</div>` : ''}
                </div>
                <div style="display:flex;gap:4px;flex-shrink:0">
                  <button class="csm-hist-btn" data-action="rename-group" data-group-id="${escHtml(g.id)}" data-group-title="${escHtml(g.title)}">✏️</button>
                  <button class="csm-hist-btn csm-hist-btn-primary" data-action="copy-consolidated" data-group-id="${escHtml(g.id)}">📋 Copy All</button>
                  <button class="csm-hist-btn csm-hist-btn-del" data-action="del-group" data-group-id="${escHtml(g.id)}">🗑️</button>
                </div>
              </div>
              <div class="csm-picker-saves">${subRows}</div>
            </div>`;
        }).join('');
    }

    function wireBrowseActions(overlay, history) {
        overlay.__pickerHistory = history;

        overlay.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                const groupId = btn.dataset.groupId;
                const saveId = btn.dataset.saveId;
                const hist = overlay.__pickerHistory || [];

                if (action === 'copy-consolidated') {
                    const group = hist.find(g => g.id === groupId);
                    if (group) {
                        const prompt = buildConsolidatedPrompt(group);
                        await navigator.clipboard.writeText(prompt);
                        showToast('📋 Consolidated prompt copied!');
                    }
                } else if (action === 'copy-save') {
                    const group = hist.find(g => g.saves?.some(s => s.id === saveId));
                    const save = group?.saves?.find(s => s.id === saveId);
                    if (save?.prompt) {
                        await navigator.clipboard.writeText(save.prompt);
                        showToast('📋 Session prompt copied!');
                    }
                } else if (action === 'move-save') {
                    // Other groups (exclude the one the save currently belongs to)
                    const otherGroups = hist.filter(g => g.id !== groupId);
                    // Pass the option to create a new thread as well
                    const target = await showMoveTargetPicker(otherGroups);
                    if (!target) return; // user cancelled

                    const payload = { type: 'MOVE_CONTEXT_SAVE', saveId };
                    if (target.isNew) {
                        payload.newThreadTitle = target.title;
                        payload.newThreadId = crypto.randomUUID();
                    } else {
                        payload.targetGroupId = target.groupId;
                    }

                    const result = await chrome.runtime.sendMessage(payload);
                    if (result.error) { showToast('❌ ' + result.error); return; }
                    overlay.remove();
                    showGroupPickerOverlay('browse');
                    showToast('✅ Moved to thread!');
                } else if (action === 'rename-group') {
                    const currentTitle = btn.dataset.groupTitle;
                    const newTitle = prompt('Enter a new name for this thread:', currentTitle);
                    if (newTitle && newTitle.trim() !== currentTitle) {
                        await chrome.runtime.sendMessage({ type: 'RENAME_CONTEXT_GROUP', groupId, newTitle: newTitle.trim() });
                        overlay.remove();
                        showGroupPickerOverlay('browse');
                    }
                } else if (action === 'del-save') {
                    if (!confirm('Delete this session from the thread?')) return;
                    await chrome.runtime.sendMessage({ type: 'DELETE_CONTEXT', saveId });
                    overlay.remove();
                    showGroupPickerOverlay('browse');
                } else if (action === 'del-group') {
                    if (!confirm('Delete entire thread history?')) return;
                    await chrome.runtime.sendMessage({ type: 'DELETE_CONTEXT', groupId });
                    overlay.remove();
                    showGroupPickerOverlay('browse');
                }
            });
        });
    }

    /**
     * showMoveTargetPicker(groups) → Promise<{ isNew, groupId, title } | null>
     */
    function showMoveTargetPicker(groups) {
        return new Promise((resolve) => {
            const existing = document.getElementById('csm-move-picker');
            if (existing) existing.remove();

            const modal = document.createElement('div');
            modal.id = 'csm-move-picker';
            modal.className = 'csm-picker-overlay';
            modal.style.zIndex = '2147483645'; // above browse overlay

            const newThreadRow = `
              <div class="csm-picker-new-thread" style="margin-bottom:8px">
                <span class="csm-picker-new-icon">✨</span>
                <input class="csm-picker-new-input" type="text" placeholder="Create new thread…" maxlength="120" />
              </div>`;

            const groupRows = groups.map(g => {
                const saveCount = g.saves?.length || 0;
                const lastSavePrompt = g.saves?.[g.saves.length - 1]?.prompt || '';
                const previewText = lastSavePrompt.substring(0, 150).replace(/\n/g, ' ') + (lastSavePrompt.length > 150 ? '…' : '');
                return `
                <div class="csm-picker-group-row" data-group-id="${escHtml(g.id)}" style="cursor:pointer">
                  <div class="csm-picker-radio"></div>
                  <div class="csm-picker-group-info">
                    <div class="csm-picker-group-name" title="${escHtml(g.title)}">${escHtml(g.title)}</div>
                    <div class="csm-picker-group-meta">${saveCount} save${saveCount !== 1 ? 's' : ''} · ${formatRelTime(g.savedAt)}</div>
                    ${previewText ? `<div class="csm-picker-group-preview">${escHtml(previewText)}</div>` : ''}
                  </div>
                </div>`;
            }).join('');

            modal.innerHTML = `
              <div class="csm-picker-modal" style="max-height:500px">
                <div class="csm-picker-header">
                  <span style="font-size:20px">↗️</span>
                  <span class="csm-picker-title">Move to Thread</span>
                  <button class="csm-close" id="csm-move-close">✕</button>
                </div>
                <div class="csm-picker-subtitle">Select a thread or create a new one to move this save into.</div>
                <div class="csm-picker-list">${newThreadRow}${groupRows}</div>
                <div class="csm-picker-actions">
                  <button class="csm-btn csm-btn-primary" id="csm-move-confirm" style="display:none">Move to New Thread</button>
                </div>
              </div>`;

            document.body.appendChild(modal);

            const okBtn = modal.querySelector('#csm-move-confirm');
            const inputElement = modal.querySelector('.csm-picker-new-input');
            const newRowWrapper = modal.querySelector('.csm-picker-new-thread');
            let isNewSelected = false;

            modal.querySelector('#csm-move-close').addEventListener('click', () => { modal.remove(); resolve(null); });
            modal.addEventListener('click', (e) => { if (e.target === modal) { modal.remove(); resolve(null); } });

            // Handle New Thread selection
            newRowWrapper.addEventListener('click', () => {
                isNewSelected = true;
                modal.querySelectorAll('.csm-picker-group-row').forEach(r => r.classList.remove('csm-picker-selected'));
                newRowWrapper.classList.add('csm-picker-selected');
                okBtn.style.display = 'block';
                inputElement.focus();
            });

            // Handle Existing Group selection
            modal.querySelectorAll('.csm-picker-group-row').forEach(row => {
                row.addEventListener('click', () => {
                    modal.remove();
                    resolve({ isNew: false, groupId: row.dataset.groupId });
                });
                row.addEventListener('mouseenter', () => {
                    if (!isNewSelected) row.classList.add('csm-picker-selected');
                });
                row.addEventListener('mouseleave', () => {
                    if (!isNewSelected) row.classList.remove('csm-picker-selected');
                });
            });

            // Handle Confirm (New Thread)
            okBtn.addEventListener('click', () => {
                const title = inputElement.value.trim() || 'Untitled Thread';
                modal.remove();
                resolve({ isNew: true, title });
            });
        });
    }

    // ─── Actions ──────────────────────────────────────────────────────────────

    async function handleSaveContext() {
        const { conversation, prompt, cancelled } = await promptWithManualEditorIfNeeded();
        if (cancelled) return null;

        // Close widget panel before showing overlay
        widgetOpen = false;
        document.getElementById('csm-panel')?.classList.add('csm-hidden');

        await showGroupPickerOverlay('save', { conversation, prompt });
        return { prompt, conversation };
    }

    async function handleViewContexts() {
        widgetOpen = false;
        document.getElementById('csm-panel')?.classList.add('csm-hidden');
        await showGroupPickerOverlay('browse');
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
