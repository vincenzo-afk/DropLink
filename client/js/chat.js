/**
 * chat.js
 * -------
 * Pure UI layer for the room's text chat. All messages are already
 * plaintext by the time they reach this file — encryption/decryption
 * happens in webrtc.js via crypto.js. This module just renders bubbles,
 * timestamps, and does best-effort link previews.
 */

const URL_PATTERN = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/gi;
const previewCache = new Map();

function formatTimestamp(ms) {
  const date = new Date(ms);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Turn plain text into HTML with bare URLs converted to clickable links. */
function linkifyText(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(URL_PATTERN, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

function extractFirstUrl(text) {
  const matches = text.match(URL_PATTERN);
  return matches ? matches[0] : null;
}

/**
 * Appends a message bubble to the chat container.
 * @param {HTMLElement} container
 * @param {{username: string, text: string, timestamp: number, isLocal: boolean}} msg
 */
function renderMessage(container, msg) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${msg.isLocal ? 'chat-bubble--local' : 'chat-bubble--remote'}`;

  const meta = document.createElement('div');
  meta.className = 'chat-bubble__meta';
  meta.innerHTML = `<span class="chat-bubble__author">${escapeHtml(msg.username)}</span>
    <span class="chat-bubble__time">${formatTimestamp(msg.timestamp)}</span>`;

  const body = document.createElement('div');
  body.className = 'chat-bubble__body';
  body.innerHTML = linkifyText(msg.text);

  bubble.appendChild(meta);
  bubble.appendChild(body);
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;

  const url = extractFirstUrl(msg.text);
  if (url) attachLinkPreview(bubble, url);

  return bubble;
}

/** Fetches a best-effort <title> for a shared link via the server's tiny proxy. */
async function attachLinkPreview(bubbleEl, url) {
  try {
    let title = previewCache.get(url);
    if (title === undefined) {
      const res = await fetch(`/api/preview?url=${encodeURIComponent(url)}`);
      if (!res.ok) return;
      const data = await res.json();
      title = data.title;
      previewCache.set(url, title);
    }
    if (!title) return;

    const card = document.createElement('a');
    card.className = 'chat-link-preview';
    card.href = url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.innerHTML = `<span class="chat-link-preview__icon">🔗</span><span class="chat-link-preview__title">${escapeHtml(title)}</span>`;
    bubbleEl.appendChild(card);
  } catch (err) {
    // Silent failure — the raw link is already clickable.
  }
}

function renderSystemMessage(container, text) {
  const el = document.createElement('div');
  el.className = 'chat-system-message';
  el.textContent = text;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

window.DropLinkChat = { renderMessage, renderSystemMessage, formatTimestamp };
