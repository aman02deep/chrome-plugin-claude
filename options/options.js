/**
 * options.js — Full options page logic
 * Tabs: Accounts, Context, Selectors, Security, Switch Log, Data
 */

// ─── Tab navigation ───────────────────────────────────────────────────────────

document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab').forEach((t) => { t.classList.remove('active'); t.classList.add('hidden'); });
        btn.classList.add('active');
        const target = document.getElementById(btn.dataset.tab);
        if (target) { target.classList.remove('hidden'); target.classList.add('active'); }

        // Load tab-specific data
        const tab = btn.dataset.tab;
        if (tab === 'tab-accounts') loadAccounts();
        else if (tab === 'tab-context') loadContextSettings();
        else if (tab === 'tab-selectors') loadSelectors();
        else if (tab === 'tab-security') loadSecuritySettings();
        else if (tab === 'tab-log') loadSwitchLog();
    });
});

// ─── Message helper ───────────────────────────────────────────────────────────

function msg(payload) {
    return chrome.runtime.sendMessage(payload);
}

function esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function showMsg(id, type) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 3000);
}

// ─── Accounts tab ─────────────────────────────────────────────────────────────

let editingId = null;

async function loadAccounts() {
    const resp = await msg({ type: 'GET_ACCOUNTS' });

    if (resp.error) {
        document.getElementById('accounts-locked').classList.remove('hidden');
        document.getElementById('accounts-table-wrap').style.display = 'none';
        return;
    }

    document.getElementById('accounts-locked').classList.add('hidden');
    document.getElementById('accounts-table-wrap').style.display = '';

    const { accounts = [], activeAccountId } = resp;
    const tbody = document.getElementById('accounts-tbody');
    const emptyEl = document.getElementById('accounts-empty');

    if (accounts.length === 0) {
        tbody.innerHTML = '';
        emptyEl.classList.remove('hidden');
        return;
    }

    emptyEl.classList.add('hidden');
    tbody.innerHTML = accounts.map((a) => `
    <tr>
      <td><span class="acc-color-dot" style="background:${esc(a.color || '#4F46E5')}"></span></td>
      <td>${esc(a.label)}${a.id === activeAccountId ? ' <span style="color:#818cf8;font-size:10px;font-weight:700">(active)</span>' : ''}</td>
      <td>${esc(a.emailDisplay || '—')}</td>
      <td>${formatDate(a.lastUsed)}</td>
      <td>
        <button class="table-btn btn-edit" data-id="${a.id}">Edit</button>
        <button class="table-btn table-btn-danger btn-del" data-id="${a.id}" style="margin-left:6px">Delete</button>
      </td>
    </tr>
  `).join('');

    tbody.querySelectorAll('.btn-edit').forEach((btn) => {
        btn.addEventListener('click', () => {
            const a = accounts.find((acc) => acc.id === btn.dataset.id);
            openAccountForm(a);
        });
    });

    tbody.querySelectorAll('.btn-del').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!confirm('Delete this account? This cannot be undone.')) return;
            await msg({ type: 'DELETE_ACCOUNT', id: btn.dataset.id });
            loadAccounts();
        });
    });
}

function openAccountForm(account) {
    editingId = account?.id || null;
    document.getElementById('account-form-title').textContent = account ? 'Edit Account' : 'Add Account';
    document.getElementById('acc-label').value = account?.label || '';
    document.getElementById('acc-email').value = account?.emailDisplay || '';
    document.getElementById('acc-password').value = '';
    document.getElementById('acc-color').value = account?.color || '#4F46E5';
    document.getElementById('acc-form-error').classList.add('hidden');

    const delBtn = document.getElementById('btn-delete-acc');
    if (account) { delBtn.classList.remove('hidden'); delBtn.dataset.id = account.id; }
    else delBtn.classList.add('hidden');

    document.getElementById('account-form-wrap').classList.remove('hidden');
    document.getElementById('acc-label').focus();
}

document.getElementById('btn-add-account').addEventListener('click', () => openAccountForm(null));

document.getElementById('btn-cancel-acc').addEventListener('click', () => {
    document.getElementById('account-form-wrap').classList.add('hidden');
    editingId = null;
});

document.getElementById('btn-save-acc').addEventListener('click', async () => {
    const label = document.getElementById('acc-label').value.trim();
    const email = document.getElementById('acc-email').value.trim();
    const password = document.getElementById('acc-password').value;
    const color = document.getElementById('acc-color').value;
    const errEl = document.getElementById('acc-form-error');
    errEl.classList.add('hidden');

    if (!label) { errEl.textContent = 'Label is required.'; errEl.classList.remove('hidden'); return; }

    if (editingId) {
        const payload = { id: editingId, label, color };
        if (email) payload.email = email;
        if (password) payload.password = password;
        const r = await msg({ type: 'UPDATE_ACCOUNT', account: payload });
        if (r.error) { errEl.textContent = r.error; errEl.classList.remove('hidden'); return; }
    } else {
        const r = await msg({ type: 'ADD_ACCOUNT', account: { label, email, password, color } });
        if (r.error) { errEl.textContent = r.error; errEl.classList.remove('hidden'); return; }
    }

    document.getElementById('account-form-wrap').classList.add('hidden');
    editingId = null;
    loadAccounts();
});

document.getElementById('btn-delete-acc').addEventListener('click', async () => {
    if (!editingId) return;
    if (!confirm('Delete this account? Cannot be undone.')) return;
    await msg({ type: 'DELETE_ACCOUNT', id: editingId });
    document.getElementById('account-form-wrap').classList.add('hidden');
    editingId = null;
    loadAccounts();
});

// ─── Context tab ──────────────────────────────────────────────────────────────

const DEFAULT_TEMPLATE = `## Continuing a Previous Session\n\nI've reached my usage limit on another account and I'm continuing our conversation here. Please read the context below, acknowledge it briefly, and continue where we left off.\n\n### Conversation Topic\n{title}\n\n### Context\n{context}\n\n### Most Recent Exchange\n{recent}\n\n### Immediate Next Step\n{nextStep}\n\n---\nPlease confirm you have the context and we'll continue.`;

async function loadContextSettings() {
    // ── Context history (grouped) ─────────────────────────
    const { history } = await msg({ type: 'GET_CONTEXT_HISTORY' });
    const listEl = document.getElementById('ctx-history-list');
    const emptyEl = document.getElementById('ctx-history-empty');
    listEl.innerHTML = '';

    if (!history || history.length === 0) {
        emptyEl.classList.remove('hidden');
    } else {
        emptyEl.classList.add('hidden');

        history.forEach((group) => {
            const card = document.createElement('div');
            card.className = 'card ctx-history-entry';
            card.style.cssText = 'margin-bottom:16px;';

            const saveRows = (group.saves || []).map((s) => `
              <tr>
                <td style="font-size:12px;color:var(--text2)">${esc(s.accountLabel || 'Account')}</td>
                <td style="font-size:11px;color:var(--text3)">${formatDate(s.savedAt)}</td>
                <td>
                  <button class="table-btn ctx-copy-save-btn" data-prompt="${encodeURIComponent(s.prompt || '')}" style="margin-right:4px">📋 Copy</button>
                  <button class="table-btn table-btn-danger ctx-del-save-btn" data-save-id="${esc(s.id)}" data-group-id="${esc(group.id)}">✕</button>
                </td>
              </tr>
            `).join('');

            card.innerHTML = `
              <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px;gap:12px">
                <div>
                  <div style="font-weight:700;font-size:14px;color:var(--text)">${esc(group.title)}</div>
                  <div style="font-size:11px;color:var(--text3);margin-top:2px">${(group.saves || []).length} session${(group.saves || []).length !== 1 ? 's' : ''} · last saved ${formatDate(group.savedAt)}</div>
                </div>
                <div style="display:flex;gap:6px;flex-shrink:0">
                  <button class="btn btn-primary ctx-copy-all-btn" style="padding:6px 12px;font-size:12px" data-group-id="${esc(group.id)}">📋 Copy All</button>
                  <button class="table-btn table-btn-danger ctx-del-group-btn" data-group-id="${esc(group.id)}">🗑️ Delete</button>
                </div>
              </div>
              <table class="data-table" style="margin-bottom:8px">
                <thead><tr><th>Account</th><th>Saved</th><th>Actions</th></tr></thead>
                <tbody>${saveRows}</tbody>
              </table>
              <div class="success-msg ctx-copy-ok hidden" style="margin-top:4px">✅ Copied!</div>
            `;
            listEl.appendChild(card);
        });

        // Store for copy-all handler
        window.__CSM_optionsHistory = history;

        listEl.querySelectorAll('.ctx-copy-all-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const groupId = btn.dataset.groupId;
                const group = (window.__CSM_optionsHistory || []).find(g => g.id === groupId);
                if (!group) return;
                const prompt = buildConsolidatedPromptOptions(group);
                await navigator.clipboard.writeText(prompt);
                const ok = btn.closest('.ctx-history-entry').querySelector('.ctx-copy-ok');
                ok.textContent = '✅ Consolidated prompt copied!';
                ok.classList.remove('hidden');
                setTimeout(() => ok.classList.add('hidden'), 2500);
            });
        });

        listEl.querySelectorAll('.ctx-copy-save-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const prompt = decodeURIComponent(btn.dataset.prompt);
                await navigator.clipboard.writeText(prompt);
                const ok = btn.closest('.ctx-history-entry').querySelector('.ctx-copy-ok');
                ok.textContent = '✅ Session prompt copied!';
                ok.classList.remove('hidden');
                setTimeout(() => ok.classList.add('hidden'), 2000);
            });
        });

        listEl.querySelectorAll('.ctx-del-save-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this session from the thread?')) return;
                await msg({ type: 'DELETE_CONTEXT', saveId: btn.dataset.saveId });
                loadContextSettings();
            });
        });

        listEl.querySelectorAll('.ctx-del-group-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete entire thread history? This cannot be undone.')) return;
                await msg({ type: 'DELETE_CONTEXT', groupId: btn.dataset.groupId });
                loadContextSettings();
            });
        });
    }

    // ── Settings ─────────────────────────────────────────
    const { settings } = await msg({ type: 'GET_SETTINGS' });
    if (!settings) return;
    document.getElementById('ctx-mode').value = settings.contextMode || 'structured';
    document.getElementById('ctx-last-n').value = settings.lastNMessages || 6;
    document.getElementById('ctx-template').value = settings.handoffTemplate || '';
}

function extractSessionContentOpts(prompt, fullContent) {
    if (!prompt) return '';
    if (fullContent) {
        // ### Context already contains summary bullets + Recent messages verbatim.
        // Stop before ### Most Recent Exchange to avoid duplicating.
        const contextMatch = prompt.match(/### Context\n([\s\S]*?)(?=\n### Most Recent Exchange|\n### Immediate|\n---\n|\[CSM-Thread-ID|$)/);
        if (contextMatch) return contextMatch[1].trim();
        return prompt
            .replace(/^## Continuing a Previous Session[\s\S]*?### Context\n/, '### Context\n')
            .replace(/### Most Recent Exchange[\s\S]*$/, '')
            .replace(/\[CSM-Thread-ID:[^\]]*\]\s*$/, '')
            .replace(/---\nPlease confirm[\s\S]*$/, '')
            .trim();
    } else {
        const match = prompt.match(/### Context\n([\s\S]*?)(?=\n### Most Recent Exchange|\n---\n|$)/);
        return match ? match[1].trim() : prompt.slice(0, 800) + '…';
    }
}

function buildConsolidatedPromptOptions(group) {
    const sessions = group.saves || [];
    if (!sessions.length) return '';
    const sessionSections = sessions.map((s, i) => {
        const isLast = i === sessions.length - 1;
        const label = `Session ${i + 1} — ${s.accountLabel} (${formatDate(s.savedAt)})`;
        const content = extractSessionContentOpts(s.prompt, isLast);
        return isLast
            ? `### ${label} ← MOST RECENT\n${content}`
            : `### ${label}\n${content}`;
    }).join('\n\n---\n\n');
    return `## Continuing a Previous Session (${sessions.length} sessions)\n\nI've reached my usage limit on another account and I'm continuing our conversation here. Please read the full context below, acknowledge it briefly, and continue where we left off.\n\n### Conversation Thread\n${group.title}\n\n${sessionSections}`;
}



document.getElementById('btn-clear-ctx-history')?.addEventListener('click', async () => {
    if (!confirm('Clear all saved context history? This cannot be undone.')) return;
    await msg({ type: 'CLEAR_CONTEXT_HISTORY' });
    loadContextSettings();
});

document.getElementById('btn-save-context-settings').addEventListener('click', async () => {
    const { settings: current } = await msg({ type: 'GET_SETTINGS' });
    const updated = {
        ...current,
        contextMode: document.getElementById('ctx-mode').value,
        lastNMessages: parseInt(document.getElementById('ctx-last-n').value) || 6,
        handoffTemplate: document.getElementById('ctx-template').value.trim() || null,
    };
    await msg({ type: 'SAVE_SETTINGS', settings: updated });
    showMsg('ctx-saved', 'success');
});

document.getElementById('btn-reset-template').addEventListener('click', () => {
    document.getElementById('ctx-template').value = DEFAULT_TEMPLATE;
});

// ─── Selectors tab ────────────────────────────────────────────────────────────

const DEFAULT_SELECTORS = {
    messageContainer: '[data-testid="user-message"], .font-claude-response',
    humanMessage: '[data-testid="user-message"]',
    rateLimitBanner: '[data-testid="rate-limit-message"], .rate-limit, [class*="UsageLimitBanner"], [class*="rate-limit"]',
    sessionExpired: 'form[action*="/login"], [class*="LoginPage"]',
};

async function loadSelectors() {
    const { settings } = await msg({ type: 'GET_SETTINGS' });
    const sel = settings.selectors || DEFAULT_SELECTORS;
    document.getElementById('sel-message-container').value = sel.messageContainer || DEFAULT_SELECTORS.messageContainer;
    document.getElementById('sel-human-message').value = sel.humanMessage || DEFAULT_SELECTORS.humanMessage;
    document.getElementById('sel-rate-limit').value = sel.rateLimitBanner || DEFAULT_SELECTORS.rateLimitBanner;
    document.getElementById('sel-session-expired').value = sel.sessionExpired || DEFAULT_SELECTORS.sessionExpired;
}

document.getElementById('btn-save-selectors').addEventListener('click', async () => {
    const { settings: current } = await msg({ type: 'GET_SETTINGS' });
    const updated = {
        ...current,
        selectors: {
            messageContainer: document.getElementById('sel-message-container').value.trim(),
            humanMessage: document.getElementById('sel-human-message').value.trim(),
            rateLimitBanner: document.getElementById('sel-rate-limit').value.trim(),
            sessionExpired: document.getElementById('sel-session-expired').value.trim(),
        },
    };
    await msg({ type: 'SAVE_SETTINGS', settings: updated });
    showMsg('sel-saved', 'success');
});

document.getElementById('btn-reset-selectors').addEventListener('click', () => {
    document.getElementById('sel-message-container').value = DEFAULT_SELECTORS.messageContainer;
    document.getElementById('sel-human-message').value = DEFAULT_SELECTORS.humanMessage;
    document.getElementById('sel-rate-limit').value = DEFAULT_SELECTORS.rateLimitBanner;
    document.getElementById('sel-session-expired').value = DEFAULT_SELECTORS.sessionExpired;
});

// ─── Security tab ─────────────────────────────────────────────────────────────

async function loadSecuritySettings() {
    const { settings } = await msg({ type: 'GET_SETTINGS' });
    document.getElementById('sec-lock-timeout').value = settings.autoLockMinutes || 30;
}

document.getElementById('btn-change-pw').addEventListener('click', async () => {
    const oldPw = document.getElementById('sec-old-pw').value;
    const newPw = document.getElementById('sec-new-pw').value;
    const confirmPw = document.getElementById('sec-confirm-pw').value;
    const errEl = document.getElementById('sec-error');
    const sucEl = document.getElementById('sec-success');
    errEl.classList.add('hidden');
    sucEl.classList.add('hidden');

    if (!oldPw || !newPw) { errEl.textContent = 'All fields are required.'; errEl.classList.remove('hidden'); return; }
    if (newPw !== confirmPw) { errEl.textContent = 'New passwords do not match.'; errEl.classList.remove('hidden'); return; }
    if (newPw.length < 8) { errEl.textContent = 'New password must be at least 8 characters.'; errEl.classList.remove('hidden'); return; }

    const result = await msg({ type: 'CHANGE_MASTER_PASSWORD', oldPassword: oldPw, newPassword: newPw });
    if (result.error) { errEl.textContent = result.error; errEl.classList.remove('hidden'); }
    else {
        sucEl.classList.remove('hidden');
        document.getElementById('sec-old-pw').value = '';
        document.getElementById('sec-new-pw').value = '';
        document.getElementById('sec-confirm-pw').value = '';
    }
});

document.getElementById('btn-save-lock').addEventListener('click', async () => {
    const { settings: current } = await msg({ type: 'GET_SETTINGS' });
    await msg({ type: 'SAVE_SETTINGS', settings: { ...current, autoLockMinutes: parseInt(document.getElementById('sec-lock-timeout').value) || 30 } });
    showMsg('lock-saved', 'success');
});

// ─── Switch log tab ───────────────────────────────────────────────────────────

async function loadSwitchLog() {
    const { log = [] } = await msg({ type: 'GET_SWITCH_LOG' });
    const tbody = document.getElementById('log-tbody');
    const emptyEl = document.getElementById('log-empty');
    const tableEl = document.getElementById('log-table');

    if (log.length === 0) {
        emptyEl.classList.remove('hidden');
        tableEl.style.display = 'none';
        return;
    }

    emptyEl.classList.add('hidden');
    tableEl.style.display = '';
    tbody.innerHTML = log.map((entry) => `
    <tr>
      <td>${formatDate(entry.timestamp)}</td>
      <td>${esc(entry.fromLabel || entry.fromId || '—')}</td>
      <td>${esc(entry.toLabel || entry.toId || '—')}</td>
    </tr>
  `).join('');
}

document.getElementById('btn-clear-log').addEventListener('click', async () => {
    if (!confirm('Clear the entire switch log?')) return;
    await msg({ type: 'CLEAR_SWITCH_LOG' });
    loadSwitchLog();
});

// ─── Data tab ─────────────────────────────────────────────────────────────────

document.getElementById('btn-export').addEventListener('click', async () => {
    const { data } = await msg({ type: 'EXPORT_DATA' });
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `csm-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
});

document.getElementById('btn-import').addEventListener('click', async () => {
    const file = document.getElementById('import-file').files[0];
    const errEl = document.getElementById('import-error');
    const sucEl = document.getElementById('import-success');
    errEl.classList.add('hidden');
    sucEl.classList.add('hidden');

    if (!file) { errEl.textContent = 'Select a backup file first.'; errEl.classList.remove('hidden'); return; }

    try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!confirm('This will replace ALL current data. Continue?')) return;
        const r = await msg({ type: 'IMPORT_DATA', data });
        if (r.error) { errEl.textContent = r.error; errEl.classList.remove('hidden'); }
        else sucEl.classList.remove('hidden');
    } catch (e) {
        errEl.textContent = 'Invalid backup file: ' + e.message;
        errEl.classList.remove('hidden');
    }
});

document.getElementById('btn-wipe').addEventListener('click', async () => {
    if (!confirm('⚠️ Permanently delete ALL data? This cannot be undone.')) return;
    if (!confirm('Are you absolutely sure? All accounts and credentials will be deleted.')) return;
    await msg({ type: 'WIPE_DATA' });
    alert('All data wiped. Close this page and reopen the extension to start fresh.');
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
loadAccounts();
