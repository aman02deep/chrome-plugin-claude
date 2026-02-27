# Claude Session Manager — Build Walkthrough

All 4 phases built in one pass. 17 files, ~130 KB of source code.

---

## What Was Built

### File Structure
```
chrome-plugin/
├── manifest.json           MV3 manifest
├── background.js           Service worker — switch sequence, crypto, message routing
├── content/
│   ├── content.js          Floating widget UI (all phases)
│   ├── content.css         Widget styles — glassmorphism, animations
│   └── context-extractor.js  DOM conversation scraper
├── popup/
│   ├── popup.html          Multi-screen popup (lock / dashboard / form / settings)
│   ├── popup.css           Dark premium popup styles
│   └── popup.js            Popup logic
├── options/
│   ├── options.html        Full settings page (6 tabs)
│   ├── options.css         Options page styles
│   └── options.js          Options page logic
├── utils/
│   ├── crypto.js           AES-GCM + PBKDF2 (reference — imported by other utils)
│   ├── storage.js          chrome.storage.local typed helpers
│   └── context-builder.js  Handoff prompt builder (3 modes, no API)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## How to Load in Chrome

1. Open Chrome → navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select `C:\Learning\Projects\chrome-plugin`
5. The extension appears in the toolbar — click the ⚡ icon

> **Note:** If you see any manifest errors, check the **Errors** button on the extension card. The most common issue is a missing icon file — all 3 are generated and present.

---

## Getting Started

1. **Click the extension icon** → you'll see the lock screen (first launch)
2. **Set a master password** — this encrypts all your credentials. There is no recovery if you forget it
3. **Add your first account** → Dashboard → "+ Add Account"
   - Give it a label (e.g. "Personal"), your email, optionally your password, and a color
4. **Navigate to claude.ai** — the floating pill widget appears in the bottom-right corner
5. **Add a second account** in the popup, then try switching

---

## Key Features Implemented

| Feature | Where |
|---------|-------|
| AES-GCM encrypted credential storage | `utils/crypto.js`, `background.js` |
| 6-step clean session switch | `background.js` → `switchAccount()` |
| MV3-safe localStorage/sessionStorage clear | `chrome.scripting.executeScript` in `background.js` |
| Auto-lock via alarms API | `background.js` ALARM_AUTOLOCK |
| DOM conversation extraction | `content/context-extractor.js` |
| Structured handoff prompt (3 modes) | `utils/context-builder.js` + inlined in `content.js` |
| Rate limit watcher + banner | `content.js` → `startRateLimitWatcher()` |
| Session expiry detection | `content.js` → `checkSessionExpiry()` |
| Soft throttle warning modal | `content.js` → `showThrottleWarning()` |
| Post-switch handoff-ready banner | `content.js` → `showHandoffReadyBanner()` |
| Switch log (last 100 entries) | `background.js` → `appendSwitchLog()` |
| Options page (6 tabs) | `options/` directory |
| Encrypted backup import/export | `options.js` + `background.js` EXPORT_DATA/IMPORT_DATA |
| Custom handoff template + selector config | Options → Context tab + Selectors tab |
| Master password change (re-encrypts all data) | `background.js` CHANGE_MASTER_PASSWORD |

---

## Caveats & Maintenance

**DOM selectors will break** when Anthropic updates claude.ai's frontend.
Fix without reinstalling: Options page → DOM Selectors tab → update the selectors.

**Cookie restoration** works for accounts whose session tokens haven't expired.
When a stored session expires, the extension shows a manual login notice and offers to copy your email to clipboard.

**This likely violates Anthropic's ToS.** Use responsibly and at your own risk.
