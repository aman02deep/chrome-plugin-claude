/**
 * popup.js — Extension popup UI logic
 * Handles: lock/unlock, dashboard, account CRUD, settings
 */

// ─── Screen management ────────────────────────────────────────────────────────

const screens = {
    lock: document.getElementById('screen-lock'),
    dashboard: document.getElementById('screen-dashboard'),
    form: document.getElementById('screen-account-form'),
    settings: document.getElementById('screen-settings'),
};

let editingAccountId = null;

function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.add('hidden'));
    screens[name]?.classList.remove('hidden');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    const { locked } = await msg({ type: 'IS_LOCKED' });

    if (locked) {
        // Check if master password exists yet
        const data = await new Promise((res) =>
            chrome.storage.local.get(['masterPasswordHash'], res)
        );
        if (!data.masterPasswordHash) {
            document.getElementById('lock-subtitle').textContent = 'Choose a master password to get started';
            document.getElementById('hint-first-launch').style.display = '';
            document.getElementById('btn-unlock').textContent = 'Set Password & Unlock';
        }
        showScreen('lock');
    } else {
        showScreen('dashboard');
        loadDashboard();
    }

    attachEvents();
}

// ─── Message helper ───────────────────────────────────────────────────────────

function msg(payload) {
    return chrome.runtime.sendMessage(payload);
}

// ─── Events ───────────────────────────────────────────────────────────────────

function attachEvents() {
    // Lock screen
    document.getElementById('btn-unlock').addEventListener('click', handleUnlock);
    document.getElementById('master-password').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleUnlock();
    });

    // Dashboard
    document.getElementById('btn-settings').addEventListener('click', () => {
        showScreen('settings');
        loadSettings();
    });
    document.getElementById('btn-lock').addEventListener('click', async () => {
        await msg({ type: 'LOCK' });
        showScreen('lock');
        document.getElementById('master-password').value = '';
    });
    document.getElementById('btn-add-account').addEventListener('click', () => openAccountForm(null));
    document.getElementById('btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

    // Account form
    document.getElementById('btn-back-from-form').addEventListener('click', () => {
        showScreen('dashboard');
        loadDashboard();
    });
    document.getElementById('btn-save-account').addEventListener('click', handleSaveAccount);
    document.getElementById('btn-delete-account').addEventListener('click', handleDeleteAccount);

    // Settings
    document.getElementById('btn-back-from-settings').addEventListener('click', () => {
        showScreen('dashboard');
        loadDashboard();
    });
    document.getElementById('btn-save-settings').addEventListener('click', handleSaveSettings);
    document.getElementById('btn-full-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

// ─── Unlock ───────────────────────────────────────────────────────────────────

async function handleUnlock() {
    const pw = document.getElementById('master-password').value.trim();
    const errEl = document.getElementById('lock-error');
    errEl.classList.add('hidden');

    if (!pw) {
        errEl.textContent = 'Please enter a password.';
        errEl.classList.remove('hidden');
        return;
    }

    const result = await msg({ type: 'UNLOCK', password: pw });
    if (result.success) {
        document.getElementById('master-password').value = '';
        showScreen('dashboard');
        loadDashboard();
    } else {
        errEl.textContent = result.error || 'Incorrect password.';
        errEl.classList.remove('hidden');
    }
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

async function loadDashboard() {
    const { accounts = [], activeAccountId } = await msg({ type: 'GET_ACCOUNTS' });
    const { log = [] } = await msg({ type: 'GET_SWITCH_LOG' });

    // Active card
    const active = accounts.find((a) => a.id === activeAccountId);
    document.getElementById('active-dot').style.background = active?.color || '#4F46E5';
    document.getElementById('active-label').textContent = active?.label || 'No active account';
    document.getElementById('active-email').textContent = active?.emailDisplay || '';

    // Stats
    document.getElementById('stat-count').textContent = accounts.length;
    document.getElementById('stat-switches').textContent = log.length;
    const lastEntry = log[0];
    document.getElementById('stat-last').textContent = lastEntry
        ? formatRelative(lastEntry.timestamp) : '—';

    // Account list — exclude the active account (it's already shown in the top card)
    const listEl = document.getElementById('account-list');
    listEl.innerHTML = '';
    const otherAccounts = accounts.filter((a) => a.id !== activeAccountId);
    otherAccounts.forEach((a) => {
        const row = document.createElement('div');
        row.className = 'account-row';
        row.innerHTML = `
      <span class="dot" style="background:${a.color || '#4F46E5'}"></span>
      <span class="acc-label">${esc(a.label)}</span>
      <div class="acc-actions">
        <button class="acc-btn acc-btn-switch" data-id="${a.id}">Switch</button>
        <button class="acc-btn acc-btn-set-active" data-id="${a.id}" title="Mark this as the currently logged-in account (sync fix)">Set Active</button>
        <button class="acc-btn acc-btn-edit" data-id="${a.id}" title="Edit">✏️</button>
      </div>
    `;
        listEl.appendChild(row);
    });

    listEl.querySelectorAll('.acc-btn-switch').forEach((btn) => {
        btn.addEventListener('click', async () => {
            btn.textContent = '…';
            btn.disabled = true;
            const fromId = activeAccountId;
            const toId = btn.dataset.id;
            const result = await msg({ type: 'SWITCH_ACCOUNT', fromId, toId });
            if (result.error) {
                btn.textContent = 'Error';
                setTimeout(() => { btn.textContent = 'Switch'; btn.disabled = false; }, 2000);
            } else {
                window.close();
            }
        });
    });

    // Set as Active — manually corrects state when the extension is out of sync with the real session
    listEl.querySelectorAll('.acc-btn-set-active').forEach((btn) => {
        btn.addEventListener('click', async () => {
            await msg({ type: 'SET_ACTIVE_ACCOUNT', id: btn.dataset.id });
            loadDashboard();
        });
    });

    listEl.querySelectorAll('.acc-btn-edit').forEach((btn) => {
        btn.addEventListener('click', () => {
            const account = accounts.find((a) => a.id === btn.dataset.id);
            openAccountForm(account);
        });
    });
}

// ─── Account form ─────────────────────────────────────────────────────────────

function openAccountForm(account) {
    editingAccountId = account?.id || null;
    document.getElementById('form-title').textContent = account ? 'Edit Account' : 'Add Account';
    document.getElementById('field-label').value = account?.label || '';
    document.getElementById('field-email').value = account?.emailDisplay || '';
    document.getElementById('field-password').value = '';
    document.getElementById('field-color').value = account?.color || '#4F46E5';
    document.getElementById('form-error').classList.add('hidden');

    const deleteBtn = document.getElementById('btn-delete-account');
    if (account) {
        deleteBtn.classList.remove('hidden');
        deleteBtn.dataset.id = account.id;
    } else {
        deleteBtn.classList.add('hidden');
    }

    showScreen('form');
}

async function handleSaveAccount() {
    const label = document.getElementById('field-label').value.trim();
    const email = document.getElementById('field-email').value.trim();
    const password = document.getElementById('field-password').value;
    const color = document.getElementById('field-color').value;
    const errEl = document.getElementById('form-error');
    errEl.classList.add('hidden');

    if (!label) {
        errEl.textContent = 'Label is required.';
        errEl.classList.remove('hidden');
        return;
    }

    if (editingAccountId) {
        const updatePayload = { id: editingAccountId, label, color };
        if (email) updatePayload.email = email;
        if (password) updatePayload.password = password;
        const result = await msg({ type: 'UPDATE_ACCOUNT', account: updatePayload });
        if (result.error) { errEl.textContent = result.error; errEl.classList.remove('hidden'); return; }
    } else {
        const result = await msg({ type: 'ADD_ACCOUNT', account: { label, email, password, color } });
        if (result.error) { errEl.textContent = result.error; errEl.classList.remove('hidden'); return; }

        // Set as active if it's the first account
        const { accounts = [] } = await msg({ type: 'GET_ACCOUNTS' });
        if (accounts.length === 1) {
            await msg({ type: 'SET_ACTIVE_ACCOUNT', id: result.id });
        }
    }

    showScreen('dashboard');
    loadDashboard();
}

async function handleDeleteAccount() {
    if (!editingAccountId) return;
    if (!confirm('Delete this account? This cannot be undone.')) return;
    await msg({ type: 'DELETE_ACCOUNT', id: editingAccountId });
    editingAccountId = null;
    showScreen('dashboard');
    loadDashboard();
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
    const { settings } = await msg({ type: 'GET_SETTINGS' });
    document.getElementById('set-auto-detect').checked = settings.autoDetectLimit !== false;
    document.getElementById('set-auto-save').checked = settings.autoSaveContext !== false;
    document.getElementById('set-context-mode').value = settings.contextMode || 'structured';
    document.getElementById('set-lock-timeout').value = settings.autoLockMinutes || 30;
    document.getElementById('set-throttle').value = settings.switchThrottleMinutes || 10;
}

async function handleSaveSettings() {
    const { settings: current } = await msg({ type: 'GET_SETTINGS' });
    const updated = {
        ...current,
        autoDetectLimit: document.getElementById('set-auto-detect').checked,
        autoSaveContext: document.getElementById('set-auto-save').checked,
        contextMode: document.getElementById('set-context-mode').value,
        autoLockMinutes: parseInt(document.getElementById('set-lock-timeout').value) || 30,
        switchThrottleMinutes: parseInt(document.getElementById('set-throttle').value) || 10,
    };
    await msg({ type: 'SAVE_SETTINGS', settings: updated });
    showScreen('dashboard');
    loadDashboard();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatRelative(isoStr) {
    const diff = Date.now() - new Date(isoStr).getTime();
    const min = Math.floor(diff / 60_000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
init();
