/**
 * storage.js — Typed chrome.storage.local helpers
 *
 * All data lives in chrome.storage.local (extension-sandboxed, never synced).
 * Credentials and cookies are stored encrypted — this module handles raw r/w only.
 * Encryption/decryption is the caller's responsibility.
 */

// ─── Low-level helpers ────────────────────────────────────────────────────────

async function get(keys) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(keys, (result) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(result);
        });
    });
}

async function set(items) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(items, () => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve();
        });
    });
}

async function remove(keys) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.remove(keys, () => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve();
        });
    });
}

async function clear() {
    return new Promise((resolve, reject) => {
        chrome.storage.local.clear(() => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve();
        });
    });
}

// ─── Default settings ─────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS = {
    autoDetectLimit: true,
    contextSummaryLength: 'medium',   // 'short' | 'medium' | 'long'
    contextMode: 'full',               // 'full' | 'structured' | 'manual'
    autoSaveContext: true,
    switchThrottleMinutes: 10,
    autoLockMinutes: 30,
    lastNMessages: 6,                 // messages kept verbatim in structured mode
    handoffTemplate: null,            // null = use default template
    selectors: {
        messageContainer: '[data-testid="message"], .message, .prose',
        humanMessage: '[data-testid="human-message"], .human-turn',
        rateLimitBanner: '[data-testid="rate-limit"], .rate-limit-message, .usage-limit',
        sessionExpired: '.login-page, [href*="/login"]',
    }
};

// ─── Accounts ─────────────────────────────────────────────────────────────────

/** @returns {Promise<any[]>} array of account objects (emails/passwords are still encrypted strings) */
export async function getAccounts() {
    const { accounts } = await get(['accounts']);
    return accounts || [];
}

export async function saveAccounts(accounts) {
    await set({ accounts });
}

export async function getActiveAccountId() {
    const { activeAccountId } = await get(['activeAccountId']);
    return activeAccountId || null;
}

export async function setActiveAccountId(id) {
    await set({ activeAccountId: id });
}

// ─── Master password hash ─────────────────────────────────────────────────────

export async function getMasterPasswordHash() {
    const { masterPasswordHash } = await get(['masterPasswordHash']);
    return masterPasswordHash || null;
}

export async function setMasterPasswordHash(hash) {
    await set({ masterPasswordHash: hash });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getSettings() {
    const { settings } = await get(['settings']);
    return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(settings) {
    await set({ settings });
}

// ─── Pending handoff (saved context for carry-over after switch) ───────────────

export async function getPendingHandoff() {
    const { pendingHandoff } = await get(['pendingHandoff']);
    return pendingHandoff || null;
}

export async function setPendingHandoff(handoff) {
    await set({ pendingHandoff: handoff });
}

export async function clearPendingHandoff() {
    await remove(['pendingHandoff']);
}

// ─── Switch log ───────────────────────────────────────────────────────────────

export async function getSwitchLog() {
    const { switchLog } = await get(['switchLog']);
    return switchLog || [];
}

export async function appendSwitchLog(entry) {
    const log = await getSwitchLog();
    log.unshift({ ...entry, timestamp: new Date().toISOString() });
    // Keep last 100 entries
    if (log.length > 100) log.splice(100);
    await set({ switchLog: log });
}

export async function clearSwitchLog() {
    await set({ switchLog: [] });
}

// ─── Full data export / import ────────────────────────────────────────────────

/** Export everything for encrypted backup. */
export async function exportAll() {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(null, (result) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(result);
        });
    });
}

/** Wipe everything and reimport backup data. */
export async function importAll(data) {
    await clear();
    await set(data);
}

/** Full factory reset. */
export async function wipeAll() {
    await clear();
}
