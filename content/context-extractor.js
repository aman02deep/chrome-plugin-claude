/**
 * context-extractor.js — DOM conversation scraper for claude.ai
 *
 * Injected as a content script. Exports extractConversation() to the window
 * so content.js can call it before initiating a switch.
 *
 * All selectors live in SELECTORS and can be updated via the Options page
 * without a new extension version.
 */

(function () {
    'use strict';

    // ─── Selectors (updateable via Options page) ───────────────────────────────
    // These are loaded from storage at runtime; defaults defined here as fallback.
    // Verified against live claude.ai DOM (2026-02):
    //   User messages: [data-testid="user-message"]
    //   Claude messages: .font-claude-response
    let SELECTORS = {
        messageContainer: '[data-testid="user-message"], .font-claude-response',
        humanMessage: '[data-testid="user-message"]',
        conversationTitle: 'title',
        mainContentRegion: 'main, [role="main"]',
    };

    // ─── Core extraction ───────────────────────────────────────────────────────

    function extractConversation() {
        const messages = [];
        const containers = document.querySelectorAll(SELECTORS.messageContainer);

        if (containers.length > 0) {
            containers.forEach((el) => {
                // Check by data-testid first (most reliable), then by class
                const isHuman =
                    el.getAttribute('data-testid') === 'user-message' ||
                    el.matches(SELECTORS.humanMessage);

                const role = isHuman ? 'user' : 'assistant';
                let content = el.innerText.trim();

                if (content) {
                    messages.push({ role, content });
                }
            });
        }

        // Fallback: if selectors found nothing, extract all visible text from main region
        if (messages.length === 0) {
            const mainRegion = document.querySelector(SELECTORS.mainContentRegion);
            if (mainRegion) {
                const text = mainRegion.innerText.trim();
                if (text) {
                    messages.push({ role: 'user', content: '[Fallback extraction — selectors returned 0 results]\n\n' + text });
                }
            }
        }

        // Collect file/artifact names mentioned
        const fileNames = extractFileNames();

        // Find true chat title (Claude's document.title usually just repeats the first user prompt)
        // The real generated title is usually the "active" item in the history sidebar.
        let chatTitle = document.title.replace(' - Claude', '').trim();
        const activeSidebarItem = document.querySelector('nav a[href="' + window.location.pathname + '"]');
        if (activeSidebarItem) {
            chatTitle = activeSidebarItem.innerText.trim() || chatTitle;
        }

        return {
            title: chatTitle,
            url: window.location.href,
            extractedAt: new Date().toISOString(),
            messageCount: messages.length,
            messages,
            fileNames,
        };
    }

    /**
     * Try to extract file/attachment names referenced in the conversation.
     */
    function extractFileNames() {
        const fileEls = document.querySelectorAll(
            '[data-testid="file-attachment"], [class*="attachment"], [class*="FilePreview"]'
        );
        const names = [];
        fileEls.forEach((el) => {
            const name = el.getAttribute('aria-label') || el.querySelector('[class*="filename"], [class*="name"]')?.innerText;
            if (name) names.push(name.trim());
        });
        return [...new Set(names)];
    }

    // ─── Apply selector overrides from storage ─────────────────────────────────

    function applyStoredSelectors(storedSelectors) {
        if (storedSelectors && typeof storedSelectors === 'object') {
            SELECTORS = { ...SELECTORS, ...storedSelectors };
        }
    }

    // Load selector overrides from extension storage (async, non-blocking)
    if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.get(['settings'], (result) => {
            if (result.settings?.selectors) {
                applyStoredSelectors(result.settings.selectors);
            }
        });
    }

    // ─── Expose to content.js via window ──────────────────────────────────────
    window.__CS_extractConversation = extractConversation;
    window.__CS_getSelectors = () => SELECTORS;
    window.__CS_applySelectors = applyStoredSelectors;

})();
