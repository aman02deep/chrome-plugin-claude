/**
 * background.js — MV3 Service Worker
 *
 * Handles:
 *  - Full 6-step clean account switch sequence
 *  - Cookie save/restore (encrypted)
 *  - Auto-lock via chrome.alarms
 *  - Message routing from content script + popup
 */

// ─── In-memory state (cleared when service worker sleeps) ─────────────────────
let _cryptoKey = null;       // AES-GCM CryptoKey — derived from master password on unlock
let _isLocked = true;

// ─── Constants ────────────────────────────────────────────────────────────────
const CLAUDE_URL = 'https://claude.ai';
const COOKIE_DOMAIN = 'claude.ai';
const ALARM_AUTOLOCK = 'autoLock';
const ALARM_THROTTLE = 'switchThrottle';

// ─── Crypto helpers (inline — no ES module imports in service workers) ─────────

const PBKDF2_ITERATIONS = 310_000;

function bufToB64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64ToBuf(b64) {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
}

async function deriveKeyFromPassword(password) {
    const enc = new TextEncoder();
    const salt = enc.encode('claude-session-manager-aes-salt-v1');
    const keyMaterial = await crypto.subtle.importKey(
        'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

async function hashMasterPassword(password) {
    const enc = new TextEncoder();
    const fixedSalt = enc.encode('claude-session-manager-salt-v1');
    const keyMaterial = await crypto.subtle.importKey(
        'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    const derived = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: fixedSalt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        true, ['encrypt']
    );
    const exported = await crypto.subtle.exportKey('raw', derived);
    return bufToB64(exported);
}

async function encryptString(plaintext, key) {
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
    return bufToB64(iv.buffer) + ':' + bufToB64(ciphertext);
}

async function decryptString(encoded, key) {
    const [ivB64, ciphertextB64] = encoded.split(':');
    const iv = b64ToBuf(ivB64);
    const ciphertext = b64ToBuf(ciphertextB64);
    const dec = new TextDecoder();
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return dec.decode(plain);
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

function storageGet(keys) {
    return new Promise((res, rej) =>
        chrome.storage.local.get(keys, (r) => chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res(r))
    );
}

function storageSet(items) {
    return new Promise((res, rej) =>
        chrome.storage.local.set(items, () => chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res())
    );
}

async function getAccounts() {
    const { accounts } = await storageGet(['accounts']);
    return accounts || [];
}

async function getSettings() {
    const { settings } = await storageGet(['settings']);
    return {
        autoDetectLimit: true,
        switchThrottleMinutes: 10,
        autoLockMinutes: 30,
        ...settings
    };
}

async function appendSwitchLog(entry) {
    const { switchLog } = await storageGet(['switchLog']);
    const log = switchLog || [];
    log.unshift({ ...entry, timestamp: new Date().toISOString() });
    if (log.length > 100) log.splice(100);
    await storageSet({ switchLog: log });
}

// ─── Broadcast to all Claude tabs ────────────────────────────────────────────

async function broadcastToClaudeTabs(message) {
    const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => { });
    }
    // Also notify popup (in case it's open)
    chrome.runtime.sendMessage(message).catch(() => { });
}

// ─── Auto-lock ────────────────────────────────────────────────────────────────

async function scheduleAutoLock() {
    const settings = await getSettings();
    const minutes = settings.autoLockMinutes || 30;
    await chrome.alarms.clear(ALARM_AUTOLOCK);
    chrome.alarms.create(ALARM_AUTOLOCK, { delayInMinutes: minutes });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_AUTOLOCK) {
        _cryptoKey = null;
        _isLocked = true;
        // Notify all open Claude tabs + popup
        broadcastToClaudeTabs({ type: 'LOCKED' });
    }
});

// ─── Cookie management ────────────────────────────────────────────────────────

async function getAllClaudeCookies() {
    const cookies = await chrome.cookies.getAll({ domain: COOKIE_DOMAIN });
    return cookies;
}

async function removeAllClaudeCookies() {
    const cookies = await getAllClaudeCookies();
    await Promise.all(
        cookies.map((c) =>
            chrome.cookies.remove({
                url: `https://${c.domain.replace(/^\./, '')}${c.path}`,
                name: c.name,
            })
        )
    );
}

async function injectCookies(cookies) {
    for (const c of cookies) {
        const details = {
            url: `https://${c.domain.replace(/^\./, '')}${c.path}`,
            name: c.name,
            value: c.value,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite,
        };
        if (!c.session && c.expirationDate) {
            details.expirationDate = c.expirationDate;
        }
        try {
            await chrome.cookies.set(details);
        } catch (e) {
            console.warn('[CSM] Cookie inject failed for', c.name, e.message);
        }
    }
}

// ─── Active tab helper ────────────────────────────────────────────────────────

async function getActiveClaudeTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const claudeTab = tabs.find((t) => t.url && t.url.startsWith(CLAUDE_URL));
    return claudeTab || tabs[0] || null;
}

// ─── Account switch sequence ──────────────────────────────────────────────────

async function switchAccount(fromId, toId) {
    if (_isLocked || !_cryptoKey) {
        throw new Error('Extension is locked. Unlock first.');
    }

    const accounts = await getAccounts();
    const fromAccount = accounts.find((a) => a.id === fromId);
    const toAccount = accounts.find((a) => a.id === toId);

    if (!toAccount) throw new Error('Target account not found');

    const tab = await getActiveClaudeTab();
    if (!tab) throw new Error('No active Claude tab found');
    const tabId = tab.id;

    // ── Step 1: Context is saved by content script before this is called ────────

    // ── Step 2: Save current session cookies (encrypted) ────────────────────────
    const cookies = await getAllClaudeCookies();
    if (fromAccount && cookies.length > 0) {
        const encryptedCookies = await encryptString(JSON.stringify(cookies), _cryptoKey);
        const updatedAccounts = accounts.map((a) =>
            a.id === fromId
                ? { ...a, sessionCookies: encryptedCookies, lastSwitch: new Date().toISOString() }
                : a
        );
        await storageSet({ accounts: updatedAccounts });
    }

    // ── Step 3: Remove all claude.ai cookies ────────────────────────────────────
    await removeAllClaudeCookies();

    // ── Step 4: Clear localStorage + sessionStorage via scripting ────────────────
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                localStorage.clear();
                sessionStorage.clear();
            },
        });
    } catch (e) {
        console.warn('[CSM] Storage clear failed (tab may be navigating):', e.message);
    }

    // ── Step 5: Navigate tab fresh ───────────────────────────────────────────────
    await chrome.tabs.update(tabId, { url: CLAUDE_URL });

    // ── Step 6: Inject new session cookies after navigation ──────────────────────
    // Wait for the tab to finish loading, then inject cookies
    const waitForLoad = () =>
        new Promise((resolve) => {
            function listener(updatedTabId, changeInfo) {
                if (updatedTabId === tabId && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            }
            chrome.tabs.onUpdated.addListener(listener);
            // Safety timeout — 15 seconds
            setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }, 15_000);
        });

    await waitForLoad();

    // Check for stored cookies for target account
    const freshAccounts = await getAccounts();
    const freshTarget = freshAccounts.find((a) => a.id === toId);

    if (freshTarget?.sessionCookies) {
        try {
            const cookieJson = await decryptString(freshTarget.sessionCookies, _cryptoKey);
            const storedCookies = JSON.parse(cookieJson);
            await injectCookies(storedCookies);

            // Update active account BEFORE reload so content script reads the correct state on load
            await storageSet({ activeAccountId: toId });
            const finalAccounts = await getAccounts();
            const updatedFinal = finalAccounts.map((a) =>
                a.id === toId ? { ...a, lastUsed: new Date().toISOString() } : a
            );
            await storageSet({ accounts: updatedFinal });

            // Reload so the injected cookies take effect
            await chrome.tabs.reload(tabId);
        } catch (e) {
            console.error('[CSM] Cookie injection failed:', e);
            // Notify content script to show manual login banner
            chrome.tabs.sendMessage(tabId, {
                type: 'SWITCH_NEEDS_LOGIN',
                account: { label: freshTarget.label, email: freshTarget.email },
            }).catch(() => { });
        }
    } else {
        // No stored cookies — update active account then show manual login notice
        await storageSet({ activeAccountId: toId });
        const finalAccounts = await getAccounts();
        const updatedFinal = finalAccounts.map((a) =>
            a.id === toId ? { ...a, lastUsed: new Date().toISOString() } : a
        );
        await storageSet({ accounts: updatedFinal });

        const waitAgain = () =>
            new Promise((resolve) => {
                function listener2(updatedTabId, changeInfo) {
                    if (updatedTabId === tabId && changeInfo.status === 'complete') {
                        chrome.tabs.onUpdated.removeListener(listener2);
                        resolve();
                    }
                }
                chrome.tabs.onUpdated.addListener(listener2);
                setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener2); resolve(); }, 10_000);
            });
        await waitAgain();

        chrome.tabs.sendMessage(tabId, {
            type: 'SWITCH_NEEDS_LOGIN',
            account: { label: freshTarget?.label || 'Account', email: freshTarget?.emailDisplay || '' },
        }).catch(() => { });
    }

    // Log the switch
    await appendSwitchLog({
        fromId,
        toId,
        fromLabel: fromAccount?.label || fromId,
        toLabel: toAccount?.label || toId,
    });

    // Reset auto-lock timer
    await scheduleAutoLock();

    return { success: true };
}

// ─── Post-login cookie capture ────────────────────────────────────────────────

// When the user completes a manual login and claude.ai loads, save their fresh cookies
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    if (!tab.url || !tab.url.startsWith(CLAUDE_URL)) return;
    if (_isLocked || !_cryptoKey) return;

    const { activeAccountId, pendingManualLogin } = await storageGet(['activeAccountId', 'pendingManualLogin']);
    if (!pendingManualLogin) return;

    // Save fresh cookies for the newly logged-in account
    const cookies = await getAllClaudeCookies();
    if (cookies.length === 0) return;

    const accounts = await getAccounts();
    const encryptedCookies = await encryptString(JSON.stringify(cookies), _cryptoKey);
    const updated = accounts.map((a) =>
        a.id === activeAccountId ? { ...a, sessionCookies: encryptedCookies } : a
    );
    await storageSet({ accounts: updated, pendingManualLogin: false });

    // Notify content script: handoff prompt is ready (if one was saved)
    const { pendingHandoff } = await storageGet(['pendingHandoff']);
    if (pendingHandoff) {
        chrome.tabs.sendMessage(tabId, { type: 'HANDOFF_READY' }).catch(() => { });
    }
});

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse).catch((err) => {
        sendResponse({ error: err.message });
    });
    return true; // keep channel open for async response
});

async function handleMessage(message, sender) {
    switch (message.type) {

        case 'UNLOCK': {
            const { password } = message;
            const { masterPasswordHash } = await storageGet(['masterPasswordHash']);

            if (!masterPasswordHash) {
                // First launch — set master password
                const hash = await hashMasterPassword(password);
                await storageSet({ masterPasswordHash: hash });
                _cryptoKey = await deriveKeyFromPassword(password);
                _isLocked = false;
                await scheduleAutoLock();
                // Notify all open Claude tabs to refresh their widget state
                broadcastToClaudeTabs({ type: 'UNLOCKED' });
                return { success: true, firstLaunch: true };
            }

            const inputHash = await hashMasterPassword(password);
            if (inputHash !== masterPasswordHash) {
                return { success: false, error: 'Incorrect password' };
            }

            _cryptoKey = await deriveKeyFromPassword(password);
            _isLocked = false;
            await scheduleAutoLock();
            // Notify all open Claude tabs to refresh their widget state
            broadcastToClaudeTabs({ type: 'UNLOCKED' });
            return { success: true };
        }

        case 'LOCK': {
            _cryptoKey = null;
            _isLocked = true;
            await chrome.alarms.clear(ALARM_AUTOLOCK);
            return { success: true };
        }

        case 'IS_LOCKED': {
            return { locked: _isLocked };
        }

        case 'GET_ACCOUNTS': {
            if (_isLocked) return { error: 'Locked' };
            const accounts = await getAccounts();
            // Return accounts with decrypted display info (email only)
            const display = await Promise.all(
                accounts.map(async (a) => {
                    let emailDisplay = '';
                    try {
                        if (a.email && _cryptoKey) emailDisplay = await decryptString(a.email, _cryptoKey);
                    } catch { }
                    return { ...a, emailDisplay, email: undefined, password: undefined, sessionCookies: undefined };
                })
            );
            const { activeAccountId } = await storageGet(['activeAccountId']);
            return { accounts: display, activeAccountId };
        }

        case 'ADD_ACCOUNT': {
            if (_isLocked) return { error: 'Locked' };
            const { label, email, password, color } = message.account;
            const encEmail = email ? await encryptString(email, _cryptoKey) : '';
            const encPass = password ? await encryptString(password, _cryptoKey) : '';
            const id = crypto.randomUUID();
            const accounts = await getAccounts();
            accounts.push({
                id,
                label,
                email: encEmail,
                password: encPass,
                color: color || '#4F46E5',
                lastUsed: null,
                lastSwitch: null,
                sessionCookies: null,
            });
            await storageSet({ accounts });
            return { success: true, id };
        }

        case 'UPDATE_ACCOUNT': {
            if (_isLocked) return { error: 'Locked' };
            const { id, label, email, password, color } = message.account;
            const accounts = await getAccounts();
            const updated = await Promise.all(accounts.map(async (a) => {
                if (a.id !== id) return a;
                const encEmail = email !== undefined ? await encryptString(email, _cryptoKey) : a.email;
                const encPass = password !== undefined ? await encryptString(password, _cryptoKey) : a.password;
                return { ...a, label: label || a.label, color: color || a.color, email: encEmail, password: encPass };
            }));
            await storageSet({ accounts: updated });
            return { success: true };
        }

        case 'DELETE_ACCOUNT': {
            if (_isLocked) return { error: 'Locked' };
            const accounts = await getAccounts();
            const filtered = accounts.filter((a) => a.id !== message.id);
            await storageSet({ accounts: filtered });
            return { success: true };
        }

        case 'SET_ACTIVE_ACCOUNT': {
            if (_isLocked) return { error: 'Locked' };
            await storageSet({ activeAccountId: message.id });
            return { success: true };
        }

        case 'SWITCH_ACCOUNT': {
            if (_isLocked) return { error: 'Locked' };
            const result = await switchAccount(message.fromId, message.toId);
            return result;
        }

        case 'SAVE_CONTEXT': {
            const { conversation, prompt, accountLabel } = message;
            const chatId = conversation?.chatId || null;
            const threadId = conversation?.threadId || chatId || null;
            const title = conversation?.originalTitle || conversation?.title || 'Untitled';

            const subEntry = {
                id: crypto.randomUUID(),
                accountLabel: accountLabel || 'Unknown account',
                chatId,
                prompt,
                savedAt: new Date().toISOString(),
            };

            // Save as latest pendingHandoff (used by the post-switch banner)
            await storageSet({ pendingHandoff: { threadId, title, prompt } });

            // Load history and migrate any old flat format entries
            const { contextHistory } = await storageGet(['contextHistory']);
            const history = (contextHistory || []).map(h => {
                // Migrate old flat entries (no saves array) to new grouped format
                if (!h.saves) {
                    return { id: h.id, threadId: h.threadId || h.chatId || h.id, title: h.title, savedAt: h.savedAt, saves: [{ id: h.id + '-s0', accountLabel: 'Account A', chatId: h.chatId, prompt: h.prompt, savedAt: h.savedAt }] };
                }
                return h;
            });

            // Find existing group by threadId or create new one
            const groupIdx = threadId ? history.findIndex(h => h.threadId === threadId) : -1;
            if (groupIdx !== -1) {
                // Append sub-entry to existing group and move to top
                const group = history.splice(groupIdx, 1)[0];
                group.savedAt = subEntry.savedAt;
                group.saves.push(subEntry);
                history.unshift(group);
            } else {
                // New group
                history.unshift({
                    id: crypto.randomUUID(),
                    threadId: threadId || subEntry.id,
                    title,
                    savedAt: subEntry.savedAt,
                    saves: [subEntry],
                });
            }

            if (history.length > 50) history.splice(50);
            await storageSet({ contextHistory: history });
            return { success: true };
        }

        case 'GET_PENDING_HANDOFF': {
            const { pendingHandoff } = await storageGet(['pendingHandoff']);
            return { handoff: pendingHandoff };
        }

        case 'GET_CONTEXT_HISTORY': {
            const { contextHistory } = await storageGet(['contextHistory']);
            // Migrate and return
            const history = (contextHistory || []).map(h => {
                if (!h.saves) {
                    return { id: h.id, threadId: h.threadId || h.chatId || h.id, title: h.title, savedAt: h.savedAt, saves: [{ id: h.id + '-s0', accountLabel: 'Account A', chatId: h.chatId, prompt: h.prompt, savedAt: h.savedAt }] };
                }
                return h;
            });
            return { history };
        }

        case 'DELETE_CONTEXT': {
            const { groupId, saveId } = message;
            const { contextHistory } = await storageGet(['contextHistory']);
            let history = contextHistory || [];

            if (saveId) {
                // Delete a specific sub-entry
                history = history.map(g => ({ ...g, saves: g.saves.filter(s => s.id !== saveId) }))
                    .filter(g => g.saves.length > 0);
            } else if (groupId) {
                // Delete entire group
                history = history.filter(g => g.id !== groupId);
            }

            await storageSet({ contextHistory: history });
            const { pendingHandoff } = await storageGet(['pendingHandoff']);
            if (pendingHandoff?.id === groupId || pendingHandoff?.id === saveId) {
                await storageSet({ pendingHandoff: null });
            }
            return { success: true };
        }

        case 'CLEAR_CONTEXT_HISTORY': {
            await storageSet({ contextHistory: [], pendingHandoff: null });
            return { success: true };
        }

        case 'GET_SETTINGS': {
            const settings = await getSettings();
            return { settings };
        }

        case 'SAVE_SETTINGS': {
            await storageSet({ settings: message.settings });
            // Reschedule auto-lock if timeout changed
            if (message.settings.autoLockMinutes && !_isLocked) {
                await scheduleAutoLock();
            }
            return { success: true };
        }

        case 'GET_SWITCH_LOG': {
            const { switchLog } = await storageGet(['switchLog']);
            return { log: switchLog || [] };
        }

        case 'CLEAR_SWITCH_LOG': {
            await storageSet({ switchLog: [] });
            return { success: true };
        }

        case 'EXPORT_DATA': {
            if (_isLocked) return { error: 'Locked' };
            return new Promise((res, rej) =>
                chrome.storage.local.get(null, (data) =>
                    chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res({ data })
                )
            );
        }

        case 'IMPORT_DATA': {
            if (_isLocked) return { error: 'Locked' };
            await new Promise((res, rej) =>
                chrome.storage.local.clear(() => chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res())
            );
            await new Promise((res, rej) =>
                chrome.storage.local.set(message.data, () => chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res())
            );
            return { success: true };
        }

        case 'WIPE_DATA': {
            _cryptoKey = null;
            _isLocked = true;
            await chrome.alarms.clear(ALARM_AUTOLOCK);
            await new Promise((res, rej) =>
                chrome.storage.local.clear(() => chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res())
            );
            return { success: true };
        }

        case 'CHANGE_MASTER_PASSWORD': {
            if (_isLocked) return { error: 'Locked' };
            const { oldPassword, newPassword } = message;
            // Verify old password
            const { masterPasswordHash } = await storageGet(['masterPasswordHash']);
            const oldHash = await hashMasterPassword(oldPassword);
            if (oldHash !== masterPasswordHash) return { error: 'Incorrect current password' };

            // Re-encrypt all accounts with new key
            const oldKey = _cryptoKey;
            const newKey = await deriveKeyFromPassword(newPassword);

            const accounts = await getAccounts();
            const reEncrypted = await Promise.all(accounts.map(async (a) => {
                let email = '', password = '';
                try { if (a.email) email = await decryptString(a.email, oldKey); } catch { }
                try { if (a.password) password = await decryptString(a.password, oldKey); } catch { }
                let cookies = null;
                try {
                    if (a.sessionCookies) {
                        const plain = await decryptString(a.sessionCookies, oldKey);
                        cookies = await encryptString(plain, newKey);
                    }
                } catch { }
                return {
                    ...a,
                    email: email ? await encryptString(email, newKey) : a.email,
                    password: password ? await encryptString(password, newKey) : a.password,
                    sessionCookies: cookies,
                };
            }));

            const newHash = await hashMasterPassword(newPassword);
            await storageSet({ accounts: reEncrypted, masterPasswordHash: newHash });
            _cryptoKey = newKey;
            await scheduleAutoLock();
            return { success: true };
        }

        default:
            return { error: `Unknown message type: ${message.type}` };
    }
}
