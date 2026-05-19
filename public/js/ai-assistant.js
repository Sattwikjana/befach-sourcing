/**
 * AL Suliswan — the floating AI shopping assistant.
 *
 * Adds a small robot button (bottom-right) to every customer-facing
 * page. Click it → chat panel slides in. The panel supports text +
 * voice input (Web Speech API), text-to-speech replies, and product
 * cards rendered inline with "View" and "Add to Cart" buttons.
 *
 * Server backend: POST /api/ai/chat  (see server/aiAssistant.js)
 */

(function () {
  'use strict';

  if (window.__aiAssistantInit) return;
  window.__aiAssistantInit = true;

  // Don't inject on admin / login / checkout — the customer is in a
  // focused flow there and we shouldn't distract them.
  function shouldHideOnRoute() {
    const p = location.pathname;
    return (
      p.startsWith('/admin') ||
      p === '/login' ||
      p === '/register' ||
      p === '/checkout'
    );
  }

  const HISTORY_KEY = 'gs_ai_chat_v1';
  const VOICE_KEY = 'gs_ai_voice_v1';
  const WELCOME = "Hi! I'm AL Suliswan, your shopping assistant. What are you looking for today? I can find products, suggest matching outfits and accessories, and help you order. 🛍️";

  let history = [];
  let isOpen = false;
  let voiceModeOn = false;
  let recognition = null;
  let listening = false;
  let pendingRequest = null;
  let utterance = null;

  // ── Restore session ──
  try {
    const raw = sessionStorage.getItem(HISTORY_KEY);
    if (raw) history = JSON.parse(raw);
    if (!Array.isArray(history)) history = [];
  } catch { history = []; }
  try {
    voiceModeOn = sessionStorage.getItem(VOICE_KEY) === '1';
  } catch {}

  function saveHistory() {
    try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-30))); } catch {}
  }
  function saveVoicePref() {
    try { sessionStorage.setItem(VOICE_KEY, voiceModeOn ? '1' : '0'); } catch {}
  }

  // ──────────────────────────────────────────────────────────────
  //  Floating button
  // ──────────────────────────────────────────────────────────────
  function injectButton() {
    if (document.getElementById('aiFloatBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'aiFloatBtn';
    btn.type = 'button';
    btn.className = 'ai-float-btn';
    btn.setAttribute('aria-label', 'Chat with AL Suliswan, your AI shopping assistant');
    btn.innerHTML = `
      <span class="ai-float-pulse" aria-hidden="true"></span>
      <img src="/img/salesrobot.png?v=20260519-ai" alt="" />
      <span class="ai-float-tip" aria-hidden="true">Ask AL!</span>
    `;
    btn.addEventListener('click', openPanel);
    document.body.appendChild(btn);
  }

  // ──────────────────────────────────────────────────────────────
  //  Chat panel
  // ──────────────────────────────────────────────────────────────
  function injectPanel() {
    if (document.getElementById('aiPanel')) return;
    const panel = document.createElement('div');
    panel.id = 'aiPanel';
    panel.className = 'ai-panel';
    panel.setAttribute('aria-hidden', 'true');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'AI Shopping Assistant');
    panel.innerHTML = `
      <header class="ai-panel-header">
        <div class="ai-panel-avatar">
          <img src="/img/salesrobot.png?v=20260519-ai" alt="" />
        </div>
        <div class="ai-panel-title">
          <strong>AL Suliswan</strong>
          <span class="ai-panel-sub">AI shopping assistant • online</span>
        </div>
        <button type="button" class="ai-panel-icon" id="aiVoiceToggle" aria-label="Toggle spoken replies" title="Toggle spoken replies">
          <span class="ai-icon-speaker"></span>
        </button>
        <button type="button" class="ai-panel-icon" id="aiPanelClose" aria-label="Close chat">✕</button>
      </header>
      <div class="ai-messages" id="aiMessages" aria-live="polite"></div>
      <form class="ai-input-bar" id="aiInputForm" autocomplete="off">
        <button type="button" class="ai-mic-btn" id="aiMicBtn" aria-label="Voice input (tap and speak)" title="Voice input">
          <span class="ai-icon-mic"></span>
        </button>
        <input type="text" id="aiInput" placeholder="Ask me anything…" maxlength="500" />
        <button type="submit" class="ai-send-btn" id="aiSendBtn" aria-label="Send">
          <span class="ai-icon-send"></span>
        </button>
      </form>
    `;
    document.body.appendChild(panel);

    document.getElementById('aiPanelClose').addEventListener('click', closePanel);
    document.getElementById('aiVoiceToggle').addEventListener('click', toggleVoiceMode);
    document.getElementById('aiMicBtn').addEventListener('click', toggleListening);
    document.getElementById('aiInputForm').addEventListener('submit', onSubmit);

    // Tap outside the panel (on the backdrop) to close
    panel.addEventListener('click', (e) => {
      if (e.target === panel) closePanel();
    });

    updateVoiceToggleUI();
    renderMessages();
  }

  function openPanel() {
    isOpen = true;
    const panel = document.getElementById('aiPanel');
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('ai-panel-open');
    // Show welcome on first open
    if (!history.length) {
      addAssistantMessage(WELCOME, []);
    }
    setTimeout(() => {
      const input = document.getElementById('aiInput');
      input?.focus();
      scrollToBottom();
    }, 60);
  }
  function closePanel() {
    isOpen = false;
    const panel = document.getElementById('aiPanel');
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('ai-panel-open');
    if (listening) toggleListening();
    if (utterance) { window.speechSynthesis?.cancel(); utterance = null; }
  }
  function togglePanel() { isOpen ? closePanel() : openPanel(); }

  // ──────────────────────────────────────────────────────────────
  //  Messages
  // ──────────────────────────────────────────────────────────────
  function renderMessages() {
    const host = document.getElementById('aiMessages');
    if (!host) return;
    host.innerHTML = history.map(renderMessageHtml).join('');
    scrollToBottom();
    // Wire up product card clicks
    host.querySelectorAll('[data-ai-action]').forEach(btn => {
      btn.addEventListener('click', onProductAction);
    });
  }

  function renderMessageHtml(msg) {
    if (msg.role === 'user') {
      return `<div class="ai-msg ai-msg-user">${escapeHtml(msg.content)}</div>`;
    }
    if (msg.role === 'assistant') {
      const groups = Array.isArray(msg.productGroups) ? msg.productGroups : [];
      const groupsHtml = groups.map(renderGroupHtml).join('');
      return `<div class="ai-msg ai-msg-bot">${linkify(escapeHtml(msg.content))}${groupsHtml}</div>`;
    }
    if (msg.role === 'typing') {
      return `<div class="ai-msg ai-msg-bot ai-msg-typing"><span></span><span></span><span></span></div>`;
    }
    return '';
  }

  function renderGroupHtml(group) {
    if (!group?.products?.length) return '';
    const label = group.purpose || group.query || 'Recommendations';
    return `
      <div class="ai-product-group">
        <div class="ai-product-group-label">${escapeHtml(capitalize(label))}</div>
        <div class="ai-product-scroller">
          ${group.products.map(renderProductCardHtml).join('')}
        </div>
      </div>
    `;
  }

  function renderProductCardHtml(p) {
    const price = p.priceInr ? `₹${formatNumber(p.priceInr)}` : '';
    return `
      <div class="ai-product-card">
        <a class="ai-product-image" href="/product/${encodeURIComponent(p.pid)}" data-ai-action="view" data-pid="${escapeAttr(p.pid)}">
          <img src="${escapeAttr(imgProxyUrl(p.image))}" alt="${escapeAttr(p.name)}" loading="lazy" onerror="this.src='/img/globalshopper.png'" />
        </a>
        <div class="ai-product-body">
          <a class="ai-product-name" href="/product/${encodeURIComponent(p.pid)}" data-ai-action="view" data-pid="${escapeAttr(p.pid)}">${escapeHtml(p.name)}</a>
          ${price ? `<div class="ai-product-price">${price}</div>` : ''}
          <a class="ai-product-cta" href="/product/${encodeURIComponent(p.pid)}" data-ai-action="view" data-pid="${escapeAttr(p.pid)}">View</a>
        </div>
      </div>
    `;
  }

  function onProductAction(e) {
    const el = e.currentTarget;
    const action = el.getAttribute('data-ai-action');
    const pid = el.getAttribute('data-pid');
    if (action === 'view' && pid) {
      e.preventDefault();
      closePanel();
      if (typeof window.navigate === 'function') {
        window.navigate('/product/' + encodeURIComponent(pid));
      } else {
        location.href = '/product/' + encodeURIComponent(pid);
      }
    }
  }

  function addUserMessage(content) {
    history.push({ role: 'user', content });
    saveHistory();
    renderMessages();
  }
  function addAssistantMessage(content, productGroups) {
    history.push({ role: 'assistant', content, productGroups: productGroups || [] });
    saveHistory();
    renderMessages();
    if (voiceModeOn) speak(content);
  }
  function showTyping() {
    const host = document.getElementById('aiMessages');
    if (!host) return;
    const node = document.createElement('div');
    node.className = 'ai-msg ai-msg-bot ai-msg-typing';
    node.id = 'aiTypingBubble';
    node.innerHTML = '<span></span><span></span><span></span>';
    host.appendChild(node);
    scrollToBottom();
  }
  function hideTyping() {
    document.getElementById('aiTypingBubble')?.remove();
  }

  function scrollToBottom() {
    const host = document.getElementById('aiMessages');
    if (host) host.scrollTop = host.scrollHeight;
  }

  // ──────────────────────────────────────────────────────────────
  //  Submit & API
  // ──────────────────────────────────────────────────────────────
  function onSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('aiInput');
    const text = input.value.trim();
    if (!text || pendingRequest) return;
    input.value = '';
    sendMessage(text);
  }

  async function sendMessage(text) {
    addUserMessage(text);
    showTyping();
    pendingRequest = true;
    // Build the payload — just user + assistant turns, no product
    // groups (those are for UI only).
    const payload = {
      messages: history
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content || '' })),
    };
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      hideTyping();
      addAssistantMessage(data.reply || "Hmm, I didn't quite catch that.", data.productGroups || []);
    } catch (err) {
      hideTyping();
      addAssistantMessage("I couldn't reach the server. Please check your connection and try again.", []);
    } finally {
      pendingRequest = false;
    }
  }

  // ──────────────────────────────────────────────────────────────
  //  Voice — Web Speech API
  // ──────────────────────────────────────────────────────────────
  function setupRecognition() {
    if (recognition) return recognition;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    recognition = new SR();
    recognition.lang = 'en-IN';
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (ev) => {
      const transcript = ev.results?.[0]?.[0]?.transcript || '';
      const input = document.getElementById('aiInput');
      if (input && transcript) {
        input.value = transcript;
        // Auto-submit voice input — feels much more natural than
        // making the user tap send after speaking.
        const form = document.getElementById('aiInputForm');
        form?.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit'));
      }
    };
    recognition.onend = () => {
      listening = false;
      updateMicUi();
    };
    recognition.onerror = (ev) => {
      listening = false;
      updateMicUi();
      if (ev.error === 'not-allowed') {
        showInlineError('Microphone permission denied. Please allow mic access in your browser settings.');
      } else if (ev.error === 'no-speech') {
        showInlineError("I didn't catch that — try again?");
      }
    };
    return recognition;
  }

  function toggleListening() {
    const r = setupRecognition();
    if (!r) {
      showInlineError("Voice input isn't supported in this browser yet. Try Chrome or the Global Shopper app.");
      return;
    }
    if (listening) {
      try { r.stop(); } catch {}
      listening = false;
    } else {
      try {
        r.start();
        listening = true;
      } catch (e) {
        listening = false;
      }
    }
    updateMicUi();
  }
  function updateMicUi() {
    const btn = document.getElementById('aiMicBtn');
    if (!btn) return;
    btn.classList.toggle('is-listening', listening);
    btn.setAttribute('aria-pressed', listening ? 'true' : 'false');
  }

  function toggleVoiceMode() {
    voiceModeOn = !voiceModeOn;
    saveVoicePref();
    updateVoiceToggleUI();
    if (!voiceModeOn) window.speechSynthesis?.cancel();
  }
  function updateVoiceToggleUI() {
    const btn = document.getElementById('aiVoiceToggle');
    if (!btn) return;
    btn.classList.toggle('is-on', voiceModeOn);
    btn.setAttribute('aria-pressed', voiceModeOn ? 'true' : 'false');
    btn.title = voiceModeOn ? 'Spoken replies: ON' : 'Spoken replies: OFF';
  }

  function speak(text) {
    if (!window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-IN';
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      window.speechSynthesis.speak(utterance);
    } catch {}
  }

  function showInlineError(msg) {
    addAssistantMessage(msg, []);
  }

  // ──────────────────────────────────────────────────────────────
  //  Util
  // ──────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function escapeAttr(s) { return escapeHtml(s); }
  function linkify(s) {
    // Convert basic newlines to <br/> for readability
    return s.replace(/\n/g, '<br/>');
  }
  function capitalize(s) {
    s = String(s || '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function formatNumber(n) {
    try { return Number(n).toLocaleString('en-IN'); } catch { return String(n); }
  }
  function imgProxyUrl(src) {
    // Use the same image proxy as the rest of the site if available.
    if (typeof window.imgProxy === 'function') {
      try { return window.imgProxy(src); } catch {}
    }
    return src || '/img/globalshopper.png';
  }

  // ──────────────────────────────────────────────────────────────
  //  Boot
  // ──────────────────────────────────────────────────────────────
  function boot() {
    if (shouldHideOnRoute()) return;
    injectButton();
    injectPanel();
  }
  function rebootIfNeeded() {
    // SPA route changes — show/hide button per route
    const existing = document.getElementById('aiFloatBtn');
    if (shouldHideOnRoute()) {
      if (existing) existing.style.display = 'none';
      const panel = document.getElementById('aiPanel');
      if (panel?.classList.contains('is-open')) closePanel();
    } else if (existing) {
      existing.style.display = '';
    } else {
      boot();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  // Re-check on every SPA navigation so the button shows/hides per route.
  // app.js dispatches a custom 'gs:route' event on every handleRoute(),
  // and we also listen to popstate as a fallback.
  window.addEventListener('gs:route', rebootIfNeeded);
  window.addEventListener('popstate', rebootIfNeeded);
})();
