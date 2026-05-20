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
  const WELCOME = "Hi, I'm Miki — your personal shopping assistant. Tell me what you're looking for and I'll find matching products, suggest outfits, accessories, and help you place the order.";

  // Inline SVG icon library — replaces the emoji glyphs (🎤 🔈 🔊 ➤)
  // that didn't match our brand polish. All icons use currentColor
  // so CSS controls fill/stroke.
  const ICONS = {
    mic: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="9" y1="22" x2="15" y2="22"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="3" x2="21" y2="21"/><path d="M9 7v3a3 3 0 0 0 5.12 2.12"/><path d="M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M5 11a7 7 0 0 0 12 4.65"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="9" y1="22" x2="15" y2="22"/></svg>',
    volumeOn: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
    volumeOff: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l14-7-7 14-2-5-5-2z"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    dot: '<span class="ai-dot"></span>',
  };

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
    btn.setAttribute('aria-label', 'Chat with Miki, your shopping assistant');
    btn.innerHTML = `
      <span class="ai-float-pulse" aria-hidden="true"></span>
      <img src="/img/salesrobot.png?v=20260519-miki" alt="" />
      <span class="ai-float-tip" aria-hidden="true">Ask Miki</span>
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
    panel.setAttribute('aria-label', 'Miki — shopping assistant');
    panel.innerHTML = `
      <header class="ai-panel-header">
        <div class="ai-panel-avatar">
          <span class="ai-avatar-ring" aria-hidden="true"></span>
          <img src="/img/salesrobot.png?v=20260519-miki" alt="" />
        </div>
        <div class="ai-panel-title">
          <strong>Miki</strong>
          <span class="ai-panel-sub"><span class="ai-status-dot" aria-hidden="true"></span> Personal shopping assistant</span>
        </div>
        <button type="button" class="ai-panel-icon" id="aiVoiceToggle" aria-label="Toggle spoken replies" title="Toggle spoken replies">
          ${ICONS.volumeOff}
        </button>
        <button type="button" class="ai-panel-icon ai-panel-close-btn" id="aiPanelClose" aria-label="Close chat">${ICONS.close}</button>
      </header>
      <div class="ai-messages" id="aiMessages" aria-live="polite"></div>
      <form class="ai-input-bar" id="aiInputForm" autocomplete="off">
        <button type="button" class="ai-mic-btn" id="aiMicBtn" aria-label="Voice input (tap and speak)" title="Voice input">${ICONS.mic}</button>
        <div class="ai-input-wrap">
          <input type="text" id="aiInput" placeholder="Ask me anything…" maxlength="500" />
        </div>
        <button type="submit" class="ai-send-btn" id="aiSendBtn" aria-label="Send">${ICONS.send}</button>
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
    if (isOpen) return;
    isOpen = true;
    const panel = document.getElementById('aiPanel');
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('ai-panel-open');

    // Push a marker into the browser history so the hardware back
    // button (Android) closes Miki FIRST instead of navigating away
    // from the SPA. The popstate listener (installed in boot()) pops
    // it back when fired. We never call history.pushState on subsequent
    // re-opens of the same instance — only when transitioning from
    // closed → open — so the back stack stays clean.
    try {
      window.history.pushState({ aiPanel: true }, '');
    } catch {}

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
  // skipHistory=true when popstate is unwinding our own pushed state
  // (don't call history.back() in that case — we're already going back).
  function closePanel(skipHistory) {
    if (!isOpen) return;
    isOpen = false;
    const panel = document.getElementById('aiPanel');
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('ai-panel-open');
    if (listening) toggleListening();
    if (utterance) { window.speechSynthesis?.cancel(); utterance = null; }

    // If the close was initiated by the user (X button / backdrop tap /
    // navigate-to-product card click), pop our pushed history state so
    // hitting back AGAIN doesn't replay the open/close cycle. When
    // popstate fired and called us, skipHistory=true and we skip this.
    if (!skipHistory) {
      try {
        if (window.history.state && window.history.state.aiPanel) {
          window.history.back();
        }
      } catch {}
    }
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
    // Replace "Calculating…" placeholders with real prices, and drop
    // any card CJ says isn't shippable to India. Runs async.
    setTimeout(() => backfillAIProductPrices(host), 80);
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
    const priceText = p.priceInr ? `₹${formatNumber(p.priceInr)}` : '';
    const accurate = p.priceAccurate === true;
    // When the server didn't have a real cached shipping quote for
    // this PID, render "Calculating…" instead of an estimate. The
    // backfill call (kicked off below in backfillAIProductPrices)
    // will swap in the real price within ~500 ms-2 s.
    const priceHtml = priceText
      ? (accurate
          ? `<div class="ai-product-price" data-card-price>${priceText}</div>`
          : `<div class="ai-product-price ai-product-price-calc" data-card-price>Calculating…</div>`)
      : '<div class="ai-product-price ai-product-price-calc" data-card-price>Calculating…</div>';
    return `
      <div class="ai-product-card" data-pid="${escapeAttr(p.pid)}" data-accurate="${accurate ? '1' : '0'}">
        <a class="ai-product-image" href="/product/${encodeURIComponent(p.pid)}" data-ai-action="view" data-pid="${escapeAttr(p.pid)}">
          <img src="${escapeAttr(imgProxyUrl(p.image))}" alt="${escapeAttr(p.name)}" loading="lazy" onerror="this.src='/img/globalshopper.png'" />
        </a>
        <div class="ai-product-body">
          <a class="ai-product-name" href="/product/${encodeURIComponent(p.pid)}" data-ai-action="view" data-pid="${escapeAttr(p.pid)}">${escapeHtml(p.name)}</a>
          ${priceHtml}
          <a class="ai-product-cta" href="/product/${encodeURIComponent(p.pid)}" data-ai-action="view" data-pid="${escapeAttr(p.pid)}">View</a>
        </div>
      </div>
    `;
  }

  // Polls /api/store/shipping-for for any product card in the chat
  // that's currently showing "Calculating…", then swaps the placeholder
  // with the exact INR price (or removes the card if CJ says it's not
  // shippable to India). Rate-limited so we don't burst the API.
  let aiBackfillBusy = false;
  let aiBackfillQueue = [];
  async function backfillAIProductPrices(scope) {
    const root = scope || document.getElementById('aiMessages');
    if (!root) return;
    const pending = Array.from(root.querySelectorAll('.ai-product-card[data-accurate="0"]'))
      .map(card => ({ card, pid: card.getAttribute('data-pid') }))
      .filter(x => x.pid);
    if (!pending.length) return;
    aiBackfillQueue.push(...pending);
    if (aiBackfillBusy) return;
    aiBackfillBusy = true;
    while (aiBackfillQueue.length) {
      const { card, pid } = aiBackfillQueue.shift();
      if (!card.isConnected) continue;
      try {
        const res = await fetch(`/api/store/shipping-for/${encodeURIComponent(pid)}`);
        if (!res.ok) continue;
        const data = await res.json().catch(() => ({}));
        if (!card.isConnected) continue;
        // Unshippable → remove the card entirely so the customer
        // never clicks through to "Not available in your region".
        if (data.available === false) { card.remove(); continue; }
        if (data.displayUsd) {
          const usd = parseFloat(data.displayUsd);
          const inr = Math.round(usd * 85);
          const priceEl = card.querySelector('[data-card-price]');
          if (priceEl) {
            priceEl.textContent = '₹' + (inr.toLocaleString ? inr.toLocaleString('en-IN') : String(inr));
            priceEl.classList.remove('ai-product-price-calc');
          }
          card.setAttribute('data-accurate', '1');
        }
      } catch {}
      // Gentle throttle so we don't pile concurrent shipping calls
      // (each one hits CJ in the worst case).
      await new Promise(r => setTimeout(r, 250));
    }
    aiBackfillBusy = false;
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
    updateMicIcon();
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
    btn.innerHTML = voiceModeOn ? ICONS.volumeOn : ICONS.volumeOff;
  }
  function updateMicIcon() {
    const btn = document.getElementById('aiMicBtn');
    if (!btn) return;
    btn.innerHTML = listening ? ICONS.micOff : ICONS.mic;
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
    // Convert basic newlines to <br/> for readability.
    // Also strip leftover markdown the model may emit despite the
    // system-prompt instruction — render **bold** as <strong>, **__
    // and other markup as plain text so the customer never sees
    // literal asterisks in the chat.
    let out = String(s || '');
    // **bold** → <strong>bold</strong>  (only when paired)
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    // Stray single asterisks left after the pair pass — just remove
    out = out.replace(/(^|\s)\*(?=\S)|(?<=\S)\*(?=\s|$)/g, '$1');
    // Hash-mark headings → bold lines
    out = out.replace(/^#{1,3}\s+(.*)$/gm, '<strong>$1</strong>');
    // Newlines → <br/>
    return out.replace(/\n/g, '<br/>');
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

  // Hardware back button (Android) and browser back arrow both fire
  // popstate. If Miki's panel is open, intercept it: close the panel
  // and bail out of any further routing. We also let rebootIfNeeded
  // run for normal SPA route changes when the panel ISN'T open.
  window.addEventListener('popstate', (event) => {
    if (isOpen) {
      // Pass skipHistory=true so closePanel doesn't double-pop the
      // stack (we're already in a popstate handler).
      closePanel(true);
      return;
    }
    rebootIfNeeded(event);
  });
})();
