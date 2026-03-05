/**
 * context-builder.js — Structured handoff prompt builder
 *
 * Builds handoff prompts from raw extracted conversation data.
 * No API calls — all processing is local.
 *
 * Modes:
 *   'full'       — full transcript wrapped in template
 *   'structured' — last N messages verbatim + earlier messages as bullets (default)
 *   'manual'     — returns raw conversation text for user editing
 */

const DEFAULT_TEMPLATE = `## Conversation Thread

Please read the context below, acknowledge it briefly, and continue where we left off.

### Conversation Topic
{title}

### Context
{context}

### Most Recent Exchange
{recent}

### Immediate Next Step
{nextStep}

---
Please confirm you have the context and we'll continue.`;

/**
 * Build a handoff prompt from extracted conversation data.
 *
 * @param {Object} conversation — output from context-extractor.js extractConversation()
 * @param {Object} options
 * @param {'full'|'structured'|'manual'} options.mode
 * @param {number} options.lastNMessages — number of messages to keep verbatim in structured mode
 * @param {string|null} options.template — custom handoff template (null = default)
 * @returns {string} the handoff prompt text
 */
export function buildHandoffPrompt(conversation, options = {}) {
    const {
        mode = 'structured',
        lastNMessages = 6,
        template = null,
    } = options;

    const { title, messages, extractedAt } = conversation;

    if (!messages || messages.length === 0) {
        return `## Conversation Thread\n\nNo conversation content could be extracted. Topic: ${title || 'Unknown'}\n\nExtracted at: ${extractedAt}`;
    }

    if (mode === 'manual') {
        return buildRawTranscript(conversation);
    }

    if (mode === 'full') {
        return applyTemplate(template || DEFAULT_TEMPLATE, {
            title: title || 'Untitled conversation',
            context: buildRawTranscript(conversation),
            recent: formatMessages(messages.slice(-3)),
            nextStep: extractNextStep(messages),
        });
    }

    // mode === 'structured' (default)
    const recentMessages = messages.slice(-lastNMessages);
    const earlierMessages = messages.slice(0, Math.max(0, messages.length - lastNMessages));

    let context = '';

    if (earlierMessages.length > 0) {
        context += '**Earlier conversation summary:**\n';
        context += compressMessages(earlierMessages);
        context += '\n\n**Recent messages (verbatim):**\n';
    }

    context += formatMessages(recentMessages);

    return applyTemplate(template || DEFAULT_TEMPLATE, {
        title: title || 'Untitled conversation',
        context,
        recent: formatMessages(messages.slice(-3)),
        nextStep: extractNextStep(messages),
    });
}

/**
 * Build a plain text full transcript (used for manual mode and as fallback).
 */
function buildRawTranscript(conversation) {
    const { messages, title, extractedAt } = conversation;
    const header = `Conversation: ${title || 'Untitled'}\nExtracted: ${extractedAt}\n${'─'.repeat(50)}\n\n`;
    return header + formatMessages(messages);
}

/**
 * Format an array of messages into readable text.
 */
function formatMessages(messages) {
    return messages
        .map((m) => {
            const role = m.role === 'user' ? 'You' : 'Claude';
            return `**${role}:** ${m.content.trim()}`;
        })
        .join('\n\n');
}

/**
 * Compress earlier messages into a brief bullet-point summary.
 * Since we have no API, we extract the first sentence/line of each message.
 */
function compressMessages(messages) {
    const bullets = messages.map((m) => {
        const role = m.role === 'user' ? 'User' : 'Claude';
        const firstLine = m.content.split('\n')[0].slice(0, 120);
        const ellipsis = m.content.length > 120 ? '…' : '';
        return `• [${role}] ${firstLine}${ellipsis}`;
    });
    return bullets.join('\n');
}

/**
 * Extract the most recent user request as the "next step" hint.
 */
function extractNextStep(messages) {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) return 'Continue from where we left off.';
    const firstLine = lastUserMsg.content.split('\n')[0].slice(0, 200);
    return firstLine || 'Continue from where we left off.';
}

/**
 * Apply template variables to a template string.
 */
function applyTemplate(template, vars) {
    return template
        .replace('{title}', vars.title || '')
        .replace('{context}', vars.context || '')
        .replace('{recent}', vars.recent || '')
        .replace('{nextStep}', vars.nextStep || '');
}
