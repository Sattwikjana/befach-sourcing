/**
 * Global Shopper — Frontend v8.0
 * Hash-routed SPA over the /api/store/* consumer endpoints.
 *
 * Pages:
 *   #/                        home (hero + categories + trending)
 *   #/category                all categories
 *   #/category/:id            products in one category
 *   #/search?q=...&page=...   search results
 *   #/product/:pid            product detail with variant picker + Add to Cart
 *   #/cart                    cart
 *   #/checkout                address + shipping method + review + place order
 *   #/order/:id               order confirmation + tracking
 *   #/track                   generic "enter your order id" page
 *   #/admin                   password-gated admin dashboard
 */

'use strict';

// ══════════════════════════════════════════════════════════════
//  CORE HELPERS
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
//  COMPANY INFO — single source of truth.
//  Edit this block to update the footer, the /#/legal page, and the
//  hero byline all at once.
// ══════════════════════════════════════════════════════════════
const COMPANY_INFO = {
  // Customer-facing brand. Tagline used across hero / footer / drawer.
  brandName: 'Global Shopper',
  brandTagline: 'One World. Endless Choices.',
  // Legal entity — kept on every receipt, footer, and compliance page
  // because that's the registered company that runs the store. Don't
  // rebrand this without filing a new GSTIN/IEC.
  legalName: 'BEFACH 4X PRIVATE LIMITED',
  email: 'sales@befach.com',
  phone: '+91 70570 53160',
  website: 'https://globalshopper.in',
  founded: '2018',
  registeredAddress: '3rd floor, Luxor Park, Banjara Hills Road No. 3, opp. LV Prasad Bus Stand, BNR Colony, Venkat Nagar, Banjara Hills, Hyderabad, Telangana 500034, India',
  gstin: '36AAHCB9338E1ZK',
  iec: 'AAHCB9338E',
  // CIN is stored for CJ verification / legal records only — NOT
  // rendered on the public site by intent. Keep this value here so
  // the email reply to CJ has it ready.
  cin: 'U74999TG2018PTC125809',
  cjUserId: 'CJ5344586',
};
// Expose so the rest of the app (and inline boot script) can read it
window.COMPANY_INFO = COMPANY_INFO;

const API = '';
const app = document.getElementById('app');
const toast = document.getElementById('toast');
const serverStatus = document.getElementById('serverStatus');
const headerSearchForm = document.getElementById('headerSearchForm');
const headerSearchInput = document.getElementById('headerSearchInput');
const headerCatBtn = document.getElementById('headerCatBtn');
const catDropdown = document.getElementById('catDropdown');
const photoSearchInput = document.getElementById('photoSearchInput');
const headerPhotoSearchBtn = document.getElementById('headerPhotoSearchBtn');

// ── Mobile drawer ──
const hamburgerBtn = document.getElementById('headerHamburger');
const drawerEl = document.getElementById('drawer');
const drawerBackdrop = document.getElementById('drawerBackdrop');
const drawerClose = document.getElementById('drawerClose');
const DEFAULT_PAGE_TITLE = 'Global Shopper - One World. Endless Choices.';
let stopHomeUspCarousel = null;

const HOME_USP_SLIDES = [
  {
    src: '/img/hero/global-usp-1.jpg',
    href: '/search?q=global%20products',
    label: 'Explore global products and endless choices',
    alt: 'Global Shopper campaign banner: Bored of the same? Global products, endless choices.'
  },
  {
    src: '/img/hero/global-usp-2.jpg',
    href: '/search?q=global%20shopping',
    label: 'Upgrade your shopping with global products',
    alt: 'Global Shopper campaign banner: Upgrade your shopping with global products delivered to you.'
  },
  {
    src: '/img/hero/global-usp-3.jpg',
    href: '/search?q=trending%20global',
    label: 'Shop trending global products now in India',
    alt: 'Global Shopper campaign banner: Trending in US, now in India.'
  },
  {
    src: '/img/hero/global-usp-4.jpg',
    href: '/search?q=shop%20the%20world',
    label: 'Shop the world from US, Korea and more',
    alt: 'Global Shopper campaign banner: Shop the world from US, Korea and more.'
  },
  {
    src: '/img/hero/global-usp-5.jpg',
    href: '/search?q=premium%20global%20products',
    label: 'Start shopping what is possible globally',
    alt: 'Global Shopper campaign banner: Stop settling for what is available, start shopping what is possible.'
  }
];

function cleanDisplayName(name) {
  return String(name || '')
    .replace(/\s*&\s*/g, ' & ')
    .replace(/\s+/g, ' ')
    .trim();
}

function setPageTitle(title) {
  document.title = title || DEFAULT_PAGE_TITLE;
}

function openDrawer() {
  // Make sure the drawer reflects the latest auth state every time
  // it opens — fixes the "Sign in shows after logging in" bug where
  // the drawer markup was static and got out of sync with state.
  renderDrawer();
  drawerEl?.classList.add('open');
  drawerBackdrop?.classList.add('show');
  document.body.style.overflow = 'hidden';
}
function closeDrawer() {
  drawerEl?.classList.remove('open');
  drawerBackdrop?.classList.remove('show');
  document.body.style.overflow = '';
}
hamburgerBtn?.addEventListener('click', openDrawer);
drawerClose?.addEventListener('click', closeDrawer);
drawerBackdrop?.addEventListener('click', closeDrawer);

function initMobileHeaderAutoHide() {
  const header = document.getElementById('appHeader');
  const mobileQuery = window.matchMedia('(max-width: 860px)');
  let lastY = Math.max(0, window.scrollY || 0);
  let ticking = false;

  const syncHeaderHeight = () => {
    if (mobileQuery.matches && header) {
      document.documentElement.style.setProperty('--app-header-height', `${Math.ceil(header.offsetHeight)}px`);
    } else {
      document.documentElement.style.removeProperty('--app-header-height');
    }
  };

  const shouldKeepHeaderVisible = () => {
    const active = document.activeElement;
    return !mobileQuery.matches ||
      window.scrollY < 90 ||
      drawerEl?.classList.contains('open') ||
      (active && header?.contains(active));
  };

  const reveal = () => document.body.classList.remove('mobile-header-hidden');
  const update = () => {
    const y = Math.max(0, window.scrollY || 0);
    const delta = y - lastY;

    if (shouldKeepHeaderVisible()) {
      reveal();
    } else if (delta > 8) {
      document.body.classList.add('mobile-header-hidden');
    } else if (delta < -8) {
      reveal();
    }

    lastY = y;
    ticking = false;
  };

  window.addEventListener('scroll', () => {
    if (!ticking) {
      window.requestAnimationFrame(update);
      ticking = true;
    }
  }, { passive: true });

  window.addEventListener('resize', () => {
    syncHeaderHeight();
    lastY = Math.max(0, window.scrollY || 0);
    if (!mobileQuery.matches) reveal();
  }, { passive: true });

  if (mobileQuery.addEventListener) {
    mobileQuery.addEventListener('change', () => {
      syncHeaderHeight();
      reveal();
    });
  }

  if (header && 'ResizeObserver' in window) {
    new ResizeObserver(syncHeaderHeight).observe(header);
  }
  header?.addEventListener('focusin', reveal);
  header?.addEventListener('pointerdown', reveal, { passive: true });
  syncHeaderHeight();
}

initMobileHeaderAutoHide();

/**
 * Build the entire drawer body fresh, based on the current auth state.
 * Called when the drawer opens and whenever auth state changes
 * (login, logout, user fetch). The markup is sectioned (Shop / Account /
 * Support) with no emoji, no clutter — premium typography-only look.
 */
function renderDrawer() {
  const body = document.getElementById('drawerBody');
  if (!body) return;
  const u = state.user;
  const firstName = u ? esc(((u.name || u.email || 'You').split(' ')[0])) : '';
  const initial = u ? esc((u.name || u.email || 'U').slice(0, 1).toUpperCase()) : '';

  body.innerHTML = `
    ${u ? `
      <div class="drawer-user-card">
        <span class="drawer-user-avatar">${initial}</span>
        <div class="drawer-user-meta">
          <span class="drawer-user-greeting">Hi, ${firstName}</span>
          <span class="drawer-user-email">${esc(u.email || '')}</span>
        </div>
      </div>
    ` : ''}

    <div class="drawer-section">
      <a href="/" class="drawer-link">Home</a>
      <button type="button" class="drawer-link drawer-toggle" id="drawerCatToggle">
        <span>Shop by category</span>
        <span class="drawer-chev">›</span>
      </button>
      <div class="drawer-cats" id="drawerCats" hidden>
        <span class="drawer-cats-loading muted">Loading…</span>
      </div>
      <a href="${u ? '/cart' : '/login?redirect=%2Fcart'}" class="drawer-link">Cart</a>
      <a href="${u ? '/wishlist' : '/login?redirect=%2Fwishlist'}" class="drawer-link">Wishlist</a>
      <a href="/track" class="drawer-link">Track order</a>
    </div>

    ${u ? `
      <div class="drawer-section">
        <div class="drawer-section-label">My account</div>
        <a href="/account" class="drawer-link">My profile</a>
        <a href="/orders" class="drawer-link">My orders</a>
        <a href="/returns" class="drawer-link">Returns &amp; refunds</a>
        <button type="button" class="drawer-link drawer-link-signout" id="drawerSignOut">Sign out</button>
      </div>
    ` : `
      <div class="drawer-section">
        <div class="drawer-section-label">Account</div>
        <a href="/login" class="drawer-link">Sign in</a>
        <a href="/register" class="drawer-link drawer-link-cta">Create account</a>
      </div>
    `}

      <div class="drawer-section drawer-about-section">
        <div class="drawer-section-label">About &amp; support</div>
        <div class="drawer-about-card">
          <strong>${esc(COMPANY_INFO.brandName)}</strong>
          <span>${esc(COMPANY_INFO.brandTagline)}</span>
          <p>Premium global products delivered to India in 10–15 days.</p>
          <small>Operated by ${esc(COMPANY_INFO.legalName)}</small>
        </div>
        <a href="/about" class="drawer-link">About us</a>
        <a href="/faq" class="drawer-link">Shipping, returns &amp; FAQ</a>
        <a href="/privacy" class="drawer-link">Privacy policy</a>
        <a href="/legal" class="drawer-link">Legal &amp; compliance</a>
      </div>
  `;

  // Wire the categories accordion
  const catToggle = document.getElementById('drawerCatToggle');
  const catBody = document.getElementById('drawerCats');
  catToggle?.addEventListener('click', () => {
    if (!catBody) return;
    const open = !catBody.hidden;
    catBody.hidden = open;
    catToggle.classList.toggle('open', !open);
  });

  // Sign-out
  document.getElementById('drawerSignOut')?.addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch {}
    state.user = null;
    if (typeof updateAuthSlot === 'function') updateAuthSlot();
    showToast('Signed out');
    closeDrawer();
    navigate('/');
  });

  // Close drawer on any link click
  body.querySelectorAll('a').forEach(a => a.addEventListener('click', closeDrawer));

  // Refresh the nested category tree if it's already loaded
  if (typeof populateDrawerCategories === 'function') populateDrawerCategories();
}

/** Refresh the full category tree inside the drawer's category accordion.
 *  Called by loadCategories() once data is ready, and by renderDrawer()
 *  on each open. Renders the same tree the desktop sidebar shows so
 *  every CJ subcategory is reachable on mobile. */
function populateDrawerCategories() {
  const drawerCatsEl = document.getElementById('drawerCats');
  if (!drawerCatsEl) return;
  const cats = state.categories || [];
  if (!cats.length) {
    drawerCatsEl.innerHTML = '<span class="drawer-cats-loading muted">Categories unavailable</span>';
    return;
  }
  drawerCatsEl.innerHTML = cats.map((cat, idx) => {
    const name = cat.categoryFirstName || '';
    const groups = cat.categoryFirstList || [];
    const groupsHtml = groups.map(g => {
      const gName = g.categorySecondName || '';
      const thirds = g.categorySecondList || [];
      const thirdsHtml = thirds.map(t => `
        <a class="drawer-cat-third" href="${categoryHref(t)}">${esc(t.categoryName || '')}</a>
      `).join('');
      return `
        <div class="drawer-cat-group">
          <a class="drawer-cat-second" href="${categoryHref(g)}">${esc(gName)}</a>
          ${thirdsHtml ? `<div class="drawer-cat-thirds">${thirdsHtml}</div>` : ''}
        </div>
      `;
    }).join('');
    return `
      <div class="drawer-cat-row">
        <button type="button" class="drawer-cat-top" data-idx="${idx}">
          <span class="drawer-cat-icon">${catIcon(name)}</span>
          <span class="drawer-cat-name">${esc(name)}</span>
          ${groups.length ? '<span class="drawer-cat-chev">▾</span>' : ''}
        </button>
        <a class="drawer-cat-shop" href="${categoryHref(cat)}">Shop all ${esc(name)} →</a>
        ${groupsHtml ? `<div class="drawer-cat-groups" hidden>${groupsHtml}</div>` : ''}
      </div>
    `;
  }).join('');

  // Tap a top-level row to toggle its second/third-level children
  drawerCatsEl.querySelectorAll('.drawer-cat-top').forEach(btn => {
    btn.addEventListener('click', () => {
      const groups = btn.parentElement.querySelector('.drawer-cat-groups');
      if (!groups) return;
      const open = !groups.hidden;
      groups.hidden = open;
      btn.classList.toggle('open', !open);
    });
  });

  // Any leaf link closes the drawer
  drawerCatsEl.querySelectorAll('a').forEach(a => a.addEventListener('click', closeDrawer));
}

// Drawer brand-link closes the drawer when tapped (it links to /)
document.getElementById('drawerBrandLink')?.addEventListener('click', closeDrawer);

window.openDrawer = openDrawer;
window.closeDrawer = closeDrawer;
window.renderDrawer = renderDrawer;
window.populateDrawerCategories = populateDrawerCategories;
const cartCountEl = document.getElementById('cartCount');

document.getElementById('footerYear').textContent = new Date().getFullYear();

// Populate the "Operating Entity" footer column from COMPANY_INFO.
// Global Shopper is the customer brand; the legal entity (BEFACH 4X PRIVATE
// LIMITED) shows here for compliance — GST invoices, IEC, registered
// address all need to be visible to the buyer.
(function populateFooterCompany() {
  const el = document.getElementById('footerCompany');
  if (!el) return;
  const c = COMPANY_INFO;
  el.innerHTML = `
    <h4>Operating Entity</h4>
    <p class="footer-line"><strong>${c.legalName}</strong></p>
    <p class="footer-line"><strong>Registered Office</strong><br/>${c.registeredAddress}</p>
    <p class="footer-line"><strong>GSTIN:</strong> ${c.gstin}</p>
    <p class="footer-line"><strong>IEC:</strong> ${c.iec}</p>
    <p class="footer-line">
      <a href="mailto:${c.email}">${c.email}</a><br/>
      <a href="tel:${c.phone.replace(/\s+/g,'')}">${c.phone}</a>
    </p>
    <p class="footer-line">
      <a href="/privacy">Privacy Policy →</a><br/>
      <a href="/legal">Legal &amp; Compliance →</a>
    </p>
  `;
})();

// ── State ──
const state = {
  config: { storeName: 'Global Shopper', currency: 'INR', usdToInr: 85, shipTo: 'IN', shipFrom: 'CN' },
  categories: [],
  cart: loadCart(),
  user: null,            // populated by loadCurrentUser() on boot
  currentPage: '',
};

// ── DOM / string helpers ──
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showToast(msg, duration = 2400) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), duration);
}

function currentReturnPath() {
  const path = `${location.pathname || '/'}${location.search || ''}`;
  return path && path !== '/login' && path !== '/register' ? path : '/';
}

function requireSignIn(action = 'continue', redirect = currentReturnPath()) {
  const safeRedirect = (redirect && redirect.startsWith('/') && !redirect.startsWith('//'))
    ? redirect
    : '/';
  showToast(`Please sign in to ${action}.`, 3200);
  navigate(`/login?redirect=${encodeURIComponent(safeRedirect)}`);
  return false;
}
window.requireSignIn = requireSignIn;

async function registerMobilePushToken(detail = {}) {
  const token = (detail && typeof detail.token === 'string') ? detail.token.trim() : '';
  const force = detail.force === true;
  if (!token || (!force && (registerMobilePushToken._lastSentToken === token || registerMobilePushToken._inflightToken === token))) return;
  registerMobilePushToken._inflightToken = token;
  try {
    const res = await fetch('/api/mobile/push-token', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        platform: detail.platform || 'android',
        appVersion: detail.appVersion || '',
        userAgent: navigator.userAgent || ''
      })
    });
    if (res.ok) registerMobilePushToken._lastSentToken = token;
  } catch (err) {
    console.warn('push token registration failed', err);
  } finally {
    if (registerMobilePushToken._inflightToken === token) registerMobilePushToken._inflightToken = '';
  }
}

window.registerMobilePushToken = registerMobilePushToken;
window.addEventListener('globalshopper:push-token', event => registerMobilePushToken(event.detail || {}));
if (window.__GLOBAL_SHOPPER_PUSH_TOKEN__) {
  registerMobilePushToken({ token: window.__GLOBAL_SHOPPER_PUSH_TOKEN__, platform: 'android' });
}

function productSkeleton(count = 8) {
  return Array(count).fill(`
    <div class="product-card skeleton">
      <div class="skeleton-img"></div>
      <div class="skeleton-text"></div>
      <div class="skeleton-text short"></div>
      <div class="skeleton-price"></div>
    </div>
  `).join('');
}

// ── Money (USD from backend → INR on display) ──
function fmtINR(usdAmount) {
  const inr = Number(usdAmount) * (state.config.usdToInr || 85);
  if (!isFinite(inr)) return '—';
  // Indian comma grouping: 1,23,456
  return '₹' + Math.round(inr).toLocaleString('en-IN');
}
function fmtINRDecimal(usdAmount) {
  const inr = Number(usdAmount) * (state.config.usdToInr || 85);
  if (!isFinite(inr)) return '—';
  return '₹' + inr.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function analyticsValueUsd(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.max(0, Number(n.toFixed(2))) : 0;
}

function analyticsValueInrFromUsd(value) {
  return Math.round(analyticsValueUsd(value) * (state.config.usdToInr || 85));
}

function analyticsItemFromProduct(p, quantity = 1) {
  const pid = p?.pid || p?.id || p?.productId || '';
  const name = p?.productNameEn || p?.nameEn || p?.productName || p?.name || 'Product';
  return {
    item_id: String(pid),
    item_name: String(name).slice(0, 120),
    item_category: cleanDisplayName(p?.categoryName || p?.category || ''),
    price: analyticsValueInrFromUsd(p?.sellPrice || p?.price || p?.displayUsd || 0),
    quantity: Math.max(1, parseInt(quantity, 10) || 1)
  };
}

function analyticsItemFromCart(item) {
  return {
    item_id: String(item.pid || ''),
    item_variant: String(item.vid || ''),
    item_name: String(item.productName || 'Product').slice(0, 120),
    item_variant_name: String(item.variantName || '').slice(0, 80),
    price: analyticsValueInrFromUsd(item.priceUsd || 0),
    quantity: Math.max(1, parseInt(item.quantity, 10) || 1)
  };
}

function marketingEventId(eventName) {
  return `gs_${eventName}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function sendMetaCapiEvent(metaEvent, ecommerce, metaPayload, eventId) {
  if (!metaEvent || !eventId) return;
  const capiPayload = {
    event_name: metaEvent,
    event_id: eventId,
    event_source_url: location.href,
    value: metaPayload.value || 0,
    currency: metaPayload.currency || 'INR',
    content_ids: metaPayload.content_ids || [],
    content_name: metaPayload.content_name || '',
    content_type: metaPayload.content_type || 'product',
    search_string: metaPayload.search_string || '',
    num_items: metaPayload.num_items || 0,
    transaction_id: ecommerce.transaction_id || '',
    items: Array.isArray(ecommerce.items) ? ecommerce.items.slice(0, 20) : []
  };

  try {
    const body = JSON.stringify(capiPayload);
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon('/api/marketing/meta-event', blob);
      return;
    }
    fetch('/api/marketing/meta-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true
    }).catch(() => {});
  } catch {}
}

function trackEcommerceEvent(eventName, payload = {}) {
  try {
    const eventId = payload.event_id || marketingEventId(eventName);
    const ecommerce = { currency: 'INR', ...payload, event_id: eventId };
    if (window.dataLayer && typeof window.dataLayer.push === 'function') {
      window.dataLayer.push({ ecommerce: null });
      window.dataLayer.push({ event: eventName, ecommerce });
    }

    if (typeof window.fbq === 'function') {
      const items = Array.isArray(ecommerce.items) ? ecommerce.items : [];
      const first = items[0] || {};
      const valueInr = Number.isFinite(ecommerce.value) ? ecommerce.value : 0;
      const metaMap = {
        view_item: 'ViewContent',
        add_to_cart: 'AddToCart',
        begin_checkout: 'InitiateCheckout',
        purchase: 'Purchase',
        search: 'Search',
        add_to_wishlist: 'AddToWishlist'
      };
      const metaEvent = metaMap[eventName];
      if (metaEvent) {
        const metaPayload = {
          content_ids: items.map(item => item.item_id).filter(Boolean),
          content_name: first.item_name || ecommerce.search_term || '',
          content_type: 'product',
          value: valueInr,
          currency: 'INR',
          search_string: ecommerce.search_term || undefined,
          num_items: items.reduce((sum, item) => sum + (parseInt(item.quantity, 10) || 1), 0)
        };
        window.fbq('track', metaEvent, metaPayload, { eventID: eventId });
        sendMetaCapiEvent(metaEvent, ecommerce, metaPayload, eventId);
      }
    }
  } catch (err) {
    console.warn('analytics event failed', eventName, err);
  }
}

function cartValueInr() {
  return Math.round(cartSubtotalUsd() * (state.config.usdToInr || 85));
}

function sanitizeHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  template.content.querySelectorAll('script,style,iframe,object,embed,link,meta,svg').forEach(node => node.remove());
  template.content.querySelectorAll('*').forEach(node => {
    [...node.attributes].forEach(attr => {
      const name = attr.name.toLowerCase();
      const value = attr.value || '';
      if (name.startsWith('on') || name === 'style' || /^javascript:/i.test(value)) {
        node.removeAttribute(attr.name);
      }
    });
  });
  return template.innerHTML;
}

let currentVitalsRoute = '';
let routeCls = 0;
let routeLcp = 0;

function flushRouteVitals() {
  if (!currentVitalsRoute || (!routeCls && !routeLcp)) return;
  if (window.dataLayer && typeof window.dataLayer.push === 'function') {
    window.dataLayer.push({
      event: 'web_vitals',
      page_path: currentVitalsRoute,
      cls: Number(routeCls.toFixed(4)),
      lcp_ms: Math.round(routeLcp || 0)
    });
  }
}

function resetRouteVitals() {
  flushRouteVitals();
  currentVitalsRoute = location.pathname + location.search;
  routeCls = 0;
  routeLcp = 0;
}

function initWebVitalsObservers() {
  if (!('PerformanceObserver' in window) || initWebVitalsObservers.done) return;
  initWebVitalsObservers.done = true;
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) routeLcp = entry.startTime || routeLcp;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) routeCls += entry.value || 0;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushRouteVitals();
  });
}
initWebVitalsObservers();

// ── Image URL handling ──
// CJ's CDN (cf.cjdropshipping.com) has no hotlink protection, so we use
// direct URLs — one fewer backend round-trip per card image. Fall back
// to the proxy only for domains that need it (Alibaba/Aliexpress).
function imgProxy(url) {
  if (!url) return '/img/globalshopper.png';
  if (url.startsWith('/')) return url;
  if (/cjdropshipping\.(com|net)/i.test(url)) return url;  // direct
  try { return '/api/img?url=' + encodeURIComponent(url); }
  catch { return '/img/globalshopper.png'; }
}

// ── Fetch helpers ──
// 25s timeout: covers a slow CJ pre-warm but still fails fast enough that
// the user gets a "Retry" button rather than staring at skeletons forever.
async function apiGet(path, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text().catch(() => ''))}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error("Server is busy — please try again in a moment");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
async function apiPost(path, body, extraHeaders = {}) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Attach status + parsed body so callers can branch on err.code
    // (e.g. PRICE_CHANGED) and display the new prices the server sent.
    const err = new Error(data.error || data.detail || `API ${res.status}`);
    err.status = res.status;
    err.code = data.code;
    err.data = data;
    throw err;
  }
  return data;
}

function fileToImageDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//i.test(file.type || '')) {
      reject(new Error('Please choose a product photo'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the photo'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not open the photo'));
      img.onload = () => {
        const maxEdge = 900;
        const scale = Math.min(1, maxEdge / Math.max(img.width || maxEdge, img.height || maxEdge));
        const width = Math.max(1, Math.round((img.width || maxEdge) * scale));
        const height = Math.max(1, Math.round((img.height || maxEdge) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        let quality = 0.74;
        let out = canvas.toDataURL('image/jpeg', quality);
        while (out.length > 1_700_000 && quality > 0.46) {
          quality -= 0.08;
          out = canvas.toDataURL('image/jpeg', quality);
        }
        if (out.length > 1_950_000) {
          reject(new Error('Photo is too large. Please choose a smaller image.'));
          return;
        }
        resolve(out);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function setPhotoSearchBusy(isBusy) {
  document.querySelectorAll('[data-photo-search]').forEach(btn => {
    btn.disabled = isBusy;
    btn.classList.toggle('is-busy', isBusy);
    btn.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  });
}

function openPhotoSearchPicker() {
  if (!photoSearchInput) return showToast('Photo search is not available here');
  photoSearchInput.value = '';
  photoSearchInput.click();
}

function getPhotoSearchPayload(key, query) {
  if (!key) return null;
  try {
    const payload = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (!payload || !Array.isArray(payload.products)) return null;
    if (Date.now() - (payload.cachedAt || 0) > 10 * 60 * 1000) return null;
    if (query && payload.query && payload.query.toLowerCase() !== query.toLowerCase()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function runPhotoSearch(file) {
  if (runPhotoSearch.busy) return;
  runPhotoSearch.busy = true;
  setPhotoSearchBusy(true);
  try {
    showToast('Reading photo...');
    const imageDataUrl = await fileToImageDataUrl(file);
    showToast('Finding similar products...');
    const res = await apiPost('/api/store/search/photo', { imageDataUrl, page: 1, size: 40 });
    const query = (res.query || res.intent?.understood || res.intent?.keywords || '').trim();
    if (!query) throw new Error('Could not identify the product in this photo');

    const key = `photo-search:${Date.now()}`;
    sessionStorage.setItem(key, JSON.stringify({ ...res, cachedAt: Date.now() }));
    showToast(`Photo matched: ${query}`, 2600);
    navigate(`/search?q=${encodeURIComponent(query)}&photo=${encodeURIComponent(key)}`);
  } catch (err) {
    showToast(err.message || 'Photo search failed. Please try another image.', 4200);
  } finally {
    setPhotoSearchBusy(false);
    runPhotoSearch.busy = false;
    if (photoSearchInput) photoSearchInput.value = '';
  }
}

// ══════════════════════════════════════════════════════════════
//  CART (account-only)
//  LocalStorage is just a signed-in cache for the current device; the
//  server-side account cart is authoritative. Signed-out visitors are
//  sent to login before anything can be added.
// ══════════════════════════════════════════════════════════════
const CART_KEY = 'befach_cart_v1';

function loadCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch {}
  pushCartToServer();
  updateCartBadge();
}
function clearGuestCartStorage() {
  state.cart = [];
  try { localStorage.removeItem(CART_KEY); } catch {}
  updateCartBadge();
}
window.clearGuestCartStorage = clearGuestCartStorage;
// Push the current cart to the server. Debounced 300ms so a flurry
// of quantity-stepper clicks doesn't fire ten requests.
let _cartPushTimer = null;
function pushCartToServer() {
  if (!state.user) return;
  if (_cartPushTimer) clearTimeout(_cartPushTimer);
  _cartPushTimer = setTimeout(() => {
    _cartPushTimer = null;
    fetch('/api/auth/cart', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cart: state.cart }),
    }).catch(() => {});
  }, 300);
}
// Called after auth state is established (loadCurrentUser). Pulls the
// server cart and replaces the local cache to avoid cross-account leakage.
async function syncCartFromServer() {
  if (!state.user) return;
  try {
    const res = await fetch('/api/auth/cart', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    const serverCart = Array.isArray(data.cart) ? data.cart : [];
    state.cart = serverCart;
    try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch {}
    updateCartBadge();
  } catch {}
}
window.syncCartFromServer = syncCartFromServer;
function updateCartBadge() {
  const n = state.user ? state.cart.reduce((s, i) => s + (i.quantity || 0), 0) : 0;
  if (cartCountEl) cartCountEl.textContent = n;
  // Mobile bottom-nav cart badge — hide entirely when 0 so empty
  // carts don't show a "0" pill.
  const mbn = document.getElementById('mbnCartBadge');
  if (mbn) {
    mbn.textContent = n > 99 ? '99+' : String(n);
    mbn.setAttribute('data-empty', n > 0 ? 'false' : 'true');
  }
}
function addToCart(item) {
  if (!state.user) return requireSignIn('add items to your cart');
  // item: { pid, vid, quantity, productName, variantName, image, priceUsd }
  const existing = state.cart.find(i => i.pid === item.pid && i.vid === item.vid);
  if (existing) {
    existing.quantity += item.quantity;
  } else {
    state.cart.push({ ...item });
  }
  saveCart();
  trackEcommerceEvent('add_to_cart', {
    value: Math.round(analyticsValueUsd(item.priceUsd || 0) * (state.config.usdToInr || 85) * (item.quantity || 1)),
    items: [analyticsItemFromCart(item)]
  });
  return true;
}
function updateCartQuantity(pid, vid, qty) {
  if (!state.user) return requireSignIn('manage your cart', '/cart');
  const item = state.cart.find(i => i.pid === pid && i.vid === vid);
  if (!item) return;
  item.quantity = Math.max(1, parseInt(qty) || 1);
  saveCart();
}
function removeFromCart(pid, vid) {
  if (!state.user) return requireSignIn('manage your cart', '/cart');
  state.cart = state.cart.filter(i => !(i.pid === pid && i.vid === vid));
  saveCart();
}
function clearCart() {
  if (!state.user) return requireSignIn('manage your cart', '/cart');
  state.cart = [];
  saveCart();
}
function cartSubtotalUsd() {
  return state.cart.reduce((s, i) => s + (parseFloat(i.priceUsd) * i.quantity), 0);
}
updateCartBadge();

// ══════════════════════════════════════════════════════════════
//  WISHLIST (account-only)
//  Stores product IDs only. The server-side account wishlist is
//  authoritative; signed-out visitors are sent to login before saving.
// ══════════════════════════════════════════════════════════════
const WISHLIST_KEY = 'gcom_wishlist_v1';
state_wishlistInit();
function state_wishlistInit() {
  try {
    const raw = localStorage.getItem(WISHLIST_KEY);
    state.wishlist = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(state.wishlist)) state.wishlist = [];
  } catch { state.wishlist = []; }
}
function saveWishlist() {
  try { localStorage.setItem(WISHLIST_KEY, JSON.stringify(state.wishlist)); } catch {}
  pushWishlistToServer();
}
function clearGuestWishlistStorage() {
  state.wishlist = [];
  try { localStorage.removeItem(WISHLIST_KEY); } catch {}
  refreshWishlistButtons();
}
window.clearGuestWishlistStorage = clearGuestWishlistStorage;
let _wishlistPushTimer = null;
function pushWishlistToServer() {
  if (!state.user) return;
  if (_wishlistPushTimer) clearTimeout(_wishlistPushTimer);
  _wishlistPushTimer = setTimeout(() => {
    _wishlistPushTimer = null;
    fetch('/api/auth/wishlist', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wishlist: state.wishlist }),
    }).catch(() => {});
  }, 300);
}
async function syncWishlistFromServer() {
  if (!state.user) return;
  try {
    const res = await fetch('/api/auth/wishlist', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    const serverList = Array.isArray(data.wishlist) ? data.wishlist : [];
    state.wishlist = Array.from(new Set(serverList));
    try { localStorage.setItem(WISHLIST_KEY, JSON.stringify(state.wishlist)); } catch {}
    refreshWishlistButtons();
  } catch {}
}
window.syncWishlistFromServer = syncWishlistFromServer;
function isInWishlist(pid) { return !!state.user && Array.isArray(state.wishlist) && state.wishlist.includes(pid); }
function toggleWishlist(pid) {
  if (!pid) return false;
  if (!state.user) return requireSignIn('save products to your wishlist');
  if (!Array.isArray(state.wishlist)) state.wishlist = [];
  const idx = state.wishlist.indexOf(pid);
  let added;
  if (idx === -1) { state.wishlist.push(pid); added = true; }
  else            { state.wishlist.splice(idx, 1); added = false; }
  saveWishlist();
  refreshWishlistButtons();
  if (added) {
    trackEcommerceEvent('add_to_wishlist', {
      items: [{ item_id: String(pid), quantity: 1 }]
    });
  }
  return added;
}
// Re-paint every wishlist heart icon on the page after a toggle so all
// instances of the same product (e.g. shown in two sections of the
// home page) update together.
function refreshWishlistButtons() {
  document.querySelectorAll('[data-wish-pid]').forEach(btn => {
    const pid = btn.getAttribute('data-wish-pid');
    const active = isInWishlist(pid);
    btn.classList.toggle('on', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.setAttribute('aria-label', active ? 'Remove from wishlist' : 'Add to wishlist');
  });
}
window.toggleWishlist = toggleWishlist;
window.isInWishlist = isInWishlist;
window.refreshWishlistButtons = refreshWishlistButtons;

// Expose for inline handlers
window.addToCart = addToCart;
window.updateCartQuantity = updateCartQuantity;
window.removeFromCart = removeFromCart;
window.clearCart = clearCart;

// ══════════════════════════════════════════════════════════════
//  HEALTH / CONFIG
// ══════════════════════════════════════════════════════════════
async function loadConfig() {
  try {
    const cfg = await apiGet('/api/store/config');
    Object.assign(state.config, cfg);
  } catch (err) {
    console.warn('Config load failed', err.message);
  }
}

async function checkHealth() {
  try {
    const res = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      serverStatus.className = 'status-pill ' + (data.status === 'ok' ? 'online' : 'degraded');
      serverStatus.title = data.status === 'ok' ? 'Connected to CJ' : 'Degraded: ' + (data.cjError || 'unknown');
    } else throw new Error();
  } catch {
    serverStatus.className = 'status-pill offline';
    serverStatus.title = 'Server offline';
  }
}

// ══════════════════════════════════════════════════════════════
//  ROUTER
// ══════════════════════════════════════════════════════════════
// Read the current route from the History API (pathname + querystring).
// We migrated off hash-based routing — location.hash is no longer the
// source of truth. The inline script in index.html silently redirects
// any incoming /#/foo URLs to /foo via replaceState before this runs.
function getRoute() {
  const path = location.pathname || '/';
  const params = new URLSearchParams(location.search);
  return { path, params };
}

let marketingInitialPageViewSeen = false;
function trackMarketingPageView() {
  // Meta Pixel and GTM already send the first page view from index.html.
  // This SPA needs explicit events only after client-side navigation.
  if (!marketingInitialPageViewSeen) {
    marketingInitialPageViewSeen = true;
    return;
  }

  if (window.dataLayer && typeof window.dataLayer.push === 'function') {
    window.dataLayer.push({
      event: 'virtual_page_view',
      page_path: location.pathname + location.search,
      page_location: location.href,
      page_title: document.title,
    });
  }

  if (typeof window.fbq === 'function') {
    window.fbq('track', 'PageView');
  }
}

function enhanceRenderedPage() {
  document.querySelectorAll('.breadcrumb').forEach(nav => {
    nav.setAttribute('aria-label', 'Breadcrumb');
    nav.setAttribute('role', 'navigation');
    nav.querySelectorAll('.current').forEach(el => el.setAttribute('aria-current', 'page'));
    nav.querySelectorAll('span').forEach(el => {
      if ((el.textContent || '').trim() === '›') el.setAttribute('aria-hidden', 'true');
    });
  });

  document.querySelectorAll('button:not([aria-label])').forEach(btn => {
    const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text && btn.title) btn.setAttribute('aria-label', btn.title);
    if (!text && btn.classList.contains('drawer-close')) btn.setAttribute('aria-label', 'Close menu');
    if (!text && btn.classList.contains('pd-thumb')) btn.setAttribute('aria-label', 'View product image');
    if (!text && btn.classList.contains('product-card-wish')) btn.setAttribute('aria-label', 'Save to wishlist');
    if (!text && btn.classList.contains('header-photo-btn')) btn.setAttribute('aria-label', 'Search by photo');
    if (!text && btn.classList.contains('header-search-btn')) btn.setAttribute('aria-label', 'Search');
  });

  document.querySelectorAll('img:not([alt])').forEach(img => {
    img.setAttribute('alt', '');
  });
}

// Programmatic navigation. Accepts a clean path like "/cart" or
// "/search?q=foo" — never a "#/cart". Pushes a new history entry and
// triggers the route handler manually since pushState doesn't fire a
// popstate event.
window.navigate = function(href) {
  if (!href) return;
  // Tolerate callers that still pass "#/foo" or "/#/foo" (defensive)
  if (href.indexOf('#/') === 0) href = href.slice(1);
  else if (href.indexOf('/#/') === 0) href = href.slice(2);
  if (href === location.pathname + location.search) {
    // Same URL — just re-run the route handler (e.g. user clicked
    // the same nav link to refresh the page)
    handleRoute();
    return;
  }
  history.pushState(null, '', href);
  handleRoute();
};

function handleRoute() {
  const { path, params } = getRoute();
  state.currentPage = path;
  resetRouteVitals();

  if (typeof cancelBackfill === 'function') cancelBackfill();
  if (typeof stopHomeUspCarousel === 'function') {
    stopHomeUspCarousel();
    stopHomeUspCarousel = null;
  }
  document.body.classList.remove('mobile-header-hidden');

  document.querySelectorAll('.nav-link').forEach(el => {
    el.classList.toggle('active', el.getAttribute('href') === path);
  });

  // Tag the body with the current page slug so CSS can target page-specific
  // mobile UI (e.g. sticky bottom CTA bar on product / cart pages).
  const slug = path === '/' || path === ''
    ? 'home'
    : path.split('/')[1] || 'home';
  document.documentElement.dataset.page = slug;
  document.body.className = document.body.className
    .split(' ')
    .filter(c => !c.startsWith('page-'))
    .concat('page-' + slug)
    .join(' ');

  // Remove any sticky mobile CTA bar from the previous page; the page
  // renderer (product, cart) will inject a fresh one if it needs one.
  document.getElementById('mobileCtaBar')?.remove();

  window.scrollTo(0, 0);

  const finish = (rendered) => Promise.resolve(rendered)
    .catch(err => {
      console.error('route render failed', err);
      app.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>Something went wrong</h3><p class="muted">${esc(err.message || 'Please retry.')}</p><button class="btn btn-primary" onclick="location.reload()">Retry</button></div>`;
    })
    .finally(() => {
      enhanceRenderedPage();
      trackMarketingPageView();
    });

  if (path === '/' || path === '') {
    setPageTitle(DEFAULT_PAGE_TITLE);
    return finish(renderHome());
  }
  if (path === '/category') {
    setPageTitle('All Categories | Global Shopper');
    return finish(renderAllCategories());
  }
  if (path.startsWith('/category/')) return finish(renderCategory(path.slice('/category/'.length), parseInt(params.get('page')) || 1, params));
  if (path.startsWith('/search')) {
    return finish(renderSearch(
      params.get('q') || '',
      parseInt(params.get('page')) || 1,
      {
        categoryId: params.get('categoryId') || '',
        categoryName: params.get('catName') || '',
        photoKey: params.get('photo') || '',
      }
    ));
  }
  if (path.startsWith('/product/')) {
    setPageTitle('Product | Global Shopper');
    return finish(renderProduct(path.slice('/product/'.length)));
  }
  if (path === '/cart') { setPageTitle('Cart | Global Shopper'); return finish(renderCart()); }
  if (path === '/checkout') { setPageTitle('Checkout | Global Shopper'); return finish(renderCheckout()); }
  if (path.startsWith('/order/')) { setPageTitle('Order Tracking | Global Shopper'); return finish(renderOrderDetail(path.slice('/order/'.length))); }
  if (path === '/track') { setPageTitle('Track Order | Global Shopper'); return finish(renderTrack()); }
  if (path === '/admin') { setPageTitle('Admin | Global Shopper'); return finish(renderAdmin()); }
  if (path === '/about') { setPageTitle('About Global Shopper | Global Shopper'); return finish(renderAbout()); }
  if (path === '/faq') { setPageTitle('Shipping & Returns FAQ | Global Shopper'); return finish(renderFaq()); }
  if (path === '/privacy') { setPageTitle('Privacy Policy | Global Shopper'); return finish(renderPrivacy()); }
  if (path === '/legal') { setPageTitle('Legal & Compliance | Global Shopper'); return finish(renderLegal()); }
  if (path === '/login') { setPageTitle('Login | Global Shopper'); return finish(renderLogin()); }
  if (path === '/register') { setPageTitle('Create Account | Global Shopper'); return finish(renderRegister()); }
  if (path === '/account') { setPageTitle('Account | Global Shopper'); return finish(renderAccount()); }
  if (path === '/orders') { setPageTitle('My Orders | Global Shopper'); return finish(renderOrders()); }
  if (path === '/wishlist') { setPageTitle('Wishlist | Global Shopper'); return finish(renderWishlist()); }
  if (path === '/returns') { setPageTitle('Returns & Refunds | Global Shopper'); return finish(renderReturns()); }
  setPageTitle(DEFAULT_PAGE_TITLE);
  return finish(renderHome());
}

// popstate fires on back/forward buttons (and on hash changes for the
// inline migration shim — though once the URL is clean it won't fire
// on regular link clicks since we intercept those). load fires once on
// initial page render.
window.addEventListener('popstate', handleRoute);
window.addEventListener('load', handleRoute);

// ── Global click interceptor for internal links ──
// Catches any <a href="/foo"> click and routes it client-side via
// pushState instead of letting the browser do a full page reload.
// External links, mailto:, tel:, anchors (#foo), modifier-key clicks
// (cmd+click for new tab), and target=_blank links all pass through
// untouched so default browser behaviour is preserved.
document.addEventListener('click', function(e) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.defaultPrevented) return;
  const a = e.target.closest && e.target.closest('a');
  if (!a) return;
  if (a.getAttribute('target') === '_blank') return;
  const href = a.getAttribute('href');
  if (!href) return;
  // Skip external schemes and pure-anchor links
  if (
    href.startsWith('http://') || href.startsWith('https://') ||
    href.startsWith('mailto:') || href.startsWith('tel:') ||
    href.startsWith('#')
  ) return;
  // Internal SPA route — handle via pushState
  e.preventDefault();
  navigate(href);
});

// Header search submit
headerSearchForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = headerSearchInput.value.trim();
  if (q.length < 2) return showToast('Type at least 2 characters');
  hideSearchSuggestions();
  closeHeaderSearchToggle();
  navigate(`/search?q=${encodeURIComponent(q)}`);
});

// ── Mobile header search toggle ──
// Mobile hides the inline .header-search bar by default; the
// #headerSearchToggle button reveals it as a second row beneath the
// top header strip. Clicking the icon adds .header-search-open to the
// .header element (CSS un-hides the form) and focuses the input.
// Submitting / Escape / clicking outside closes it again.
const headerSearchToggle = document.getElementById('headerSearchToggle');
const appHeaderEl = document.getElementById('appHeader');

function openHeaderSearchToggle() {
  if (!appHeaderEl) return;
  appHeaderEl.classList.add('header-search-open');
  headerSearchToggle?.setAttribute('aria-expanded', 'true');
  // Defer focus so the CSS transition kicks in first — feels smoother
  // and avoids iOS scrolling the page weirdly when the input takes focus.
  setTimeout(() => headerSearchInput?.focus(), 60);
}
function closeHeaderSearchToggle() {
  if (!appHeaderEl) return;
  appHeaderEl.classList.remove('header-search-open');
  headerSearchToggle?.setAttribute('aria-expanded', 'false');
  hideSearchSuggestions?.();
}
headerSearchToggle?.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = appHeaderEl?.classList.contains('header-search-open');
  if (isOpen) closeHeaderSearchToggle();
  else openHeaderSearchToggle();
});
// Esc closes the bar
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && appHeaderEl?.classList.contains('header-search-open')) {
    closeHeaderSearchToggle();
  }
});
// Clicking outside the search form / icon closes it. Use mousedown so the
// click that submits the form doesn't trigger close → re-open race.
document.addEventListener('mousedown', (e) => {
  if (!appHeaderEl?.classList.contains('header-search-open')) return;
  if (e.target.closest('#headerSearchForm') || e.target.closest('#headerSearchToggle')) return;
  closeHeaderSearchToggle();
});
headerPhotoSearchBtn?.addEventListener('click', openPhotoSearchPicker);
photoSearchInput?.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) runPhotoSearch(file);
});

// ── Search autocomplete dropdown ──
// Shows 4-8 suggestions: recent searches when input is empty, then a mix
// of popular server-side queries (matching prefix) and user's own
// localStorage history once they start typing. Pure UI sugar — no AI
// calls per keystroke. Debounced to 200ms so we don't hammer the suggest
// endpoint while the user is mid-type.
let _suggestEl = null;
let _suggestTimer = null;
let _suggestActiveIdx = -1;

function ensureSuggestEl() {
  if (_suggestEl) return _suggestEl;
  if (!headerSearchForm) return null;
  _suggestEl = document.createElement('div');
  _suggestEl.className = 'search-suggest';
  _suggestEl.setAttribute('role', 'listbox');
  _suggestEl.hidden = true;
  // Position relative to the search form's container
  headerSearchForm.style.position = 'relative';
  headerSearchForm.appendChild(_suggestEl);
  return _suggestEl;
}

function hideSearchSuggestions() {
  if (_suggestEl) _suggestEl.hidden = true;
  _suggestActiveIdx = -1;
}

function renderSuggestions(items, prefix) {
  const el = ensureSuggestEl();
  if (!el) return;
  if (!items.length) { el.hidden = true; return; }
  el.innerHTML = items.map((s, i) => {
    const isRecent = s.recent;
    const icon = isRecent
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>'
      : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>';
    return `<button type="button" class="search-suggest-item" role="option" data-suggest="${esc(s.text)}">${icon}<span>${esc(s.text)}</span></button>`;
  }).join('');
  el.hidden = false;
  el.querySelectorAll('.search-suggest-item').forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const q = btn.getAttribute('data-suggest');
      if (headerSearchInput) headerSearchInput.value = q;
      hideSearchSuggestions();
      navigate(`/search?q=${encodeURIComponent(q)}`);
    });
  });
}

async function updateSuggestions(prefix) {
  prefix = (prefix || '').toLowerCase().trim();
  const recent = getRecentSearches().map(t => ({ text: t, recent: true }));

  // Empty input → just show recent
  if (!prefix) {
    renderSuggestions(recent.slice(0, 6), '');
    return;
  }

  // Filter recent by prefix first (instant)
  const recentMatches = recent
    .filter(r => r.text.toLowerCase().includes(prefix))
    .slice(0, 4);

  try {
    const res = await fetch(`/api/store/search/suggest?q=${encodeURIComponent(prefix)}`);
    const data = await res.json();
    const popular = (data.suggestions || [])
      .filter(s => !recentMatches.some(r => r.text.toLowerCase() === s.toLowerCase()))
      .slice(0, 8 - recentMatches.length)
      .map(t => ({ text: t, recent: false }));
    renderSuggestions([...recentMatches, ...popular], prefix);
  } catch {
    renderSuggestions(recentMatches, prefix);
  }
}

if (headerSearchInput) {
  headerSearchInput.addEventListener('focus', () => updateSuggestions(headerSearchInput.value));
  headerSearchInput.addEventListener('input', (e) => {
    clearTimeout(_suggestTimer);
    _suggestTimer = setTimeout(() => updateSuggestions(e.target.value), 200);
  });
  headerSearchInput.addEventListener('blur', () => {
    // Delay so click on a suggestion fires before we hide
    setTimeout(hideSearchSuggestions, 150);
  });
  headerSearchInput.addEventListener('keydown', (e) => {
    if (!_suggestEl || _suggestEl.hidden) return;
    const items = _suggestEl.querySelectorAll('.search-suggest-item');
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _suggestActiveIdx = Math.min(_suggestActiveIdx + 1, items.length - 1);
      items.forEach((b, i) => b.classList.toggle('active', i === _suggestActiveIdx));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _suggestActiveIdx = Math.max(_suggestActiveIdx - 1, 0);
      items.forEach((b, i) => b.classList.toggle('active', i === _suggestActiveIdx));
    } else if (e.key === 'Enter' && _suggestActiveIdx >= 0) {
      e.preventDefault();
      const q = items[_suggestActiveIdx].getAttribute('data-suggest');
      if (headerSearchInput) headerSearchInput.value = q;
      hideSearchSuggestions();
      navigate(`/search?q=${encodeURIComponent(q)}`);
    } else if (e.key === 'Escape') {
      hideSearchSuggestions();
    }
  });
}

// ══════════════════════════════════════════════════════════════
//  CATEGORIES (header strip + dropdown)
// ══════════════════════════════════════════════════════════════
// Top-level CJ categories get a real product photo. Match by ALL keywords
// being present (case-insensitive substring) — first rule wins, so list
// the more-specific rules above the catch-alls.
const CATEGORY_IMAGE_VERSION = '20260510a';
const CAT_IMAGE_RULES = [
  [['men', 'bag'],              '/img/subcat-bags-men-bags.png', ['bag']],
  [['men', 'backpack'],         '/img/subcat-bags-men-bags.png', ['bag']],
  [['men', 'wallet'],           '/img/subcat-bags-men-bags.png', ['bag']],
  [['men', 'briefcase'],        '/img/subcat-bags-men-bags.png', ['bag']],
  [['women', 'shoe'],           '/img/subcat-bags-women-shoes.png', ['bag']],
  [['women', 'heel'],           '/img/subcat-bags-women-shoes.png', ['bag']],
  [['women', 'sandal'],         '/img/subcat-bags-women-shoes.png', ['bag']],
  [['women', 'flat'],           '/img/subcat-bags-women-shoes.png', ['bag']],
  [['heel'],                    '/img/subcat-bags-women-shoes.png', ['bag']],
  [['sandal'],                  '/img/subcat-bags-women-shoes.png', ['bag']],
  [['flat'],                    '/img/subcat-bags-women-shoes.png', ['bag']],
  [['women', 'bag'],            '/img/subcat-bags-women-bags-luggage.png', ['bag']],
  [['handbag'],                 '/img/subcat-bags-women-bags-luggage.png', ['bag']],
  [['luggage'],                 '/img/subcat-bags-women-bags-luggage.png', ['bag']],
  [['travel'],                  '/img/subcat-bags-women-bags-luggage.png', ['bag']],
  [['tote'],                    '/img/subcat-bags-women-bags-luggage.png', ['bag']],
  [['men', 'shoe'],             '/img/subcat-bags-men-shoes.png', ['bag']],
  [['men', 'sneaker'],          '/img/subcat-bags-men-shoes.png', ['bag']],
  [['men', 'loafer'],           '/img/subcat-bags-men-shoes.png', ['bag']],
  [['sneaker'],                 '/img/subcat-bags-men-shoes.png', ['bag']],
  [['loafer'],                  '/img/subcat-bags-men-shoes.png', ['bag']],
  [['shoe'],                    '/img/subcat-bags-women-shoes.png', ['bag']],
  [['bag'],                     '/img/subcat-bags-women-bags-luggage.png', ['bag']],
  [['bedding'],                 '/img/subcat-home-bedding-textiles.png', ['home']],
  [['bed'],                     '/img/subcat-home-bedding-textiles.png', ['home']],
  [['textile'],                 '/img/subcat-home-bedding-textiles.png', ['home']],
  [['bath'],                    '/img/subcat-home-bedding-textiles.png', ['home']],
  [['craft'],                   '/img/subcat-home-crafts-sewing.png', ['home']],
  [['sewing'],                  '/img/subcat-home-crafts-sewing.png', ['home']],
  [['needle'],                  '/img/subcat-home-crafts-sewing.png', ['home']],
  [['musical'],                 '/img/subcat-home-musical-instruments.png', ['home']],
  [['instrument'],              '/img/subcat-home-musical-instruments.png', ['home']],
  [['party'],                   '/img/subcat-home-party-supplies.png', ['home']],
  [['festival'],                '/img/subcat-home-party-supplies.png', ['home']],
  [['event'],                   '/img/subcat-home-party-supplies.png', ['home']],
  [['kitchen'],                 '/img/subcat-home-kitchen-dining.png', ['home']],
  [['dining'],                  '/img/subcat-home-kitchen-dining.png', ['home']],
  [['bar'],                     '/img/subcat-home-kitchen-dining.png', ['home']],
  [['tableware'],               '/img/subcat-home-kitchen-dining.png', ['home']],
  [['cookware'],                '/img/subcat-home-kitchen-dining.png', ['home']],
  [['storage'],                 '/img/subcat-home-storage-organization.png', ['home']],
  [['organizer'],               '/img/subcat-home-storage-organization.png', ['home']],
  [['organization'],            '/img/subcat-home-storage-organization.png', ['home']],
  [['basket'],                  '/img/subcat-home-storage-organization.png', ['home']],
  [['engagement', 'ring'],       '/img/subcat-jewelry-rings.png', ['jewelr']],
  [['ring'],                     '/img/subcat-jewelry-rings.png', ['jewelr']],
  [['fashion', 'jewelr'],        '/img/subcat-jewelry-fashion-jewelry.png', ['jewelr']],
  [['earring'],                  '/img/subcat-jewelry-fashion-jewelry.png', ['jewelr']],
  [['necklace'],                 '/img/subcat-jewelry-fine-jewelry.png', ['jewelr']],
  [['pendant'],                  '/img/subcat-jewelry-fine-jewelry.png', ['jewelr']],
  [['bracelet'],                 '/img/subcat-jewelry-fine-jewelry.png', ['jewelr']],
  [['fine', 'jewelr'],           '/img/subcat-jewelry-fine-jewelry.png', ['jewelr']],
  [['jewelry', 'set'],           '/img/subcat-jewelry-fine-jewelry.png', ['jewelr']],
  [['men', 'watch'],             '/img/subcat-jewelry-men-watches.png', ['jewelr']],
  [['women', 'watch'],           '/img/subcat-jewelry-women-watches.png', ['jewelr']],
  [['watch'],                    '/img/subcat-jewelry-women-watches.png', ['jewelr']],
  [['nail'],                     '/img/subcat-health-nail-art-tools.png', ['health']],
  [['health', 'care'],           '/img/subcat-health-health-care.png', ['health']],
  [['supplement'],               '/img/subcat-health-health-care.png', ['health']],
  [['vitamin'],                  '/img/subcat-health-health-care.png', ['health']],
  [['hair', 'accessor'],         '/img/subcat-health-hair-accessories.png', ['health']],
  [['hair', 'clip'],             '/img/subcat-health-hair-accessories.png', ['health']],
  [['braid'],                    '/img/subcat-health-braiding-hair.png', ['health']],
  [['synthetic', 'hair'],        '/img/subcat-health-braiding-hair.png', ['health']],
  [['skin'],                     '/img/subcat-health-skin-care.png', ['health']],
  [['facial'],                   '/img/subcat-health-skin-care.png', ['health']],
  [['bundle'],                   '/img/subcat-health-hair-bundles.png', ['health']],
  [['human', 'hair'],            '/img/subcat-health-hair-bundles.png', ['health']],
  [['hair', 'extension'],        '/img/subcat-health-hair-bundles.png', ['health']],
  [['makeup'],                   '/img/subcat-health-makeup.png', ['health']],
  [['cosmetic'],                 '/img/subcat-health-makeup.png', ['health']],
  [['wig'],                      '/img/subcat-health-wigs.png', ['health']],
  [['beauty', 'tool'],           '/img/subcat-health-beauty-tools.png', ['health']],
  [['tool'],                     '/img/subcat-health-beauty-tools.png', ['health']],
  [['hair'],                     '/img/subcat-health-hair-accessories.png', ['health']],
  [['pet', 'toy'],               '/img/subcat-pet-toys.png', ['pet']],
  [['toy'],                      '/img/subcat-pet-toys.png', ['pet']],
  [['drinking'],                 '/img/subcat-pet-feeding.png', ['pet']],
  [['feeding'],                  '/img/subcat-pet-feeding.png', ['pet']],
  [['food'],                     '/img/subcat-pet-feeding.png', ['pet']],
  [['bowl'],                     '/img/subcat-pet-feeding.png', ['pet']],
  [['outdoor'],                  '/img/subcat-pet-outdoor-supplies.png', ['pet']],
  [['leash'],                    '/img/subcat-pet-outdoor-supplies.png', ['pet']],
  [['bird'],                     '/img/subcat-pet-bird-supplies.png', ['pet']],
  [['fish'],                     '/img/subcat-pet-fish-aquatic.png', ['pet']],
  [['aquatic'],                  '/img/subcat-pet-fish-aquatic.png', ['pet']],
  [['aquarium'],                 '/img/subcat-pet-fish-aquatic.png', ['pet']],
  [['apparel'],                  '/img/subcat-pet-apparel.png', ['pet']],
  [['clothing'],                 '/img/subcat-pet-apparel.png', ['pet']],
  [['collar'],                   '/img/subcat-pet-collars-harnesses.png', ['pet']],
  [['harness'],                  '/img/subcat-pet-collars-harnesses.png', ['pet']],
  [['accessor'],                 '/img/subcat-pet-collars-harnesses.png', ['pet']],
  [['groom'],                    '/img/subcat-pet-grooming.png', ['pet']],
  [['furniture'],                '/img/subcat-pet-furniture.png', ['pet']],
  [['bed'],                      '/img/subcat-pet-furniture.png', ['pet']],
  [['pet'],                      '/img/subcat-pet-general.png', ['pet']],
  [['school', 'bag'],            '/img/subcat-kids-bags-shoes.png', ['toy']],
  [['backpack'],                 '/img/subcat-kids-bags-shoes.png', ['toy']],
  [['bag'],                      '/img/subcat-kids-bags-shoes.png', ['toy']],
  [['shoe'],                     '/img/subcat-kids-bags-shoes.png', ['toy']],
  [['sandal'],                   '/img/subcat-kids-bags-shoes.png', ['toy']],
  [['boy'],                      '/img/subcat-kids-boys-clothing.png', ['toy']],
  [['boys'],                     '/img/subcat-kids-boys-clothing.png', ['toy']],
  [['girl'],                     '/img/subcat-kids-girls-clothing.png', ['toy']],
  [['girls'],                    '/img/subcat-kids-girls-clothing.png', ['toy']],
  [['baby', 'clothing'],         '/img/subcat-kids-baby-clothing.png', ['toy']],
  [['romper'],                   '/img/subcat-kids-baby-clothing.png', ['toy']],
  [['onesie'],                   '/img/subcat-kids-baby-clothing.png', ['toy']],
  [['maternity'],                '/img/subcat-kids-baby-essentials.png', ['toy']],
  [['diaper'],                   '/img/subcat-kids-baby-essentials.png', ['toy']],
  [['feeding'],                  '/img/subcat-kids-baby-essentials.png', ['toy']],
  [['baby', 'care'],             '/img/subcat-kids-baby-essentials.png', ['toy']],
  [['baby', 'essential'],        '/img/subcat-kids-baby-essentials.png', ['toy']],
  [['educational'],              '/img/subcat-kids-toys.png', ['toy']],
  [['puzzle'],                   '/img/subcat-kids-toys.png', ['toy']],
  [['block'],                    '/img/subcat-kids-toys.png', ['toy']],
  [['doll'],                     '/img/subcat-kids-toys.png', ['toy']],
  [['toy'],                      '/img/subcat-kids-toys.png', ['toy']],
  [['kid'],                      '/img/subcat-kids-toys.png', ['toy']],
  [['baby'],                     '/img/subcat-kids-baby-essentials.png', ['toy']],
  [['mobile', 'phone', 'accessor'], '/img/subcat-phones-accessories.png'],
  [['phone', 'case'],               '/img/subcat-phones-cases.png'],
  [['mobile', 'case'],              '/img/subcat-phones-cases.png'],
  [['phone', 'part'],               '/img/subcat-phones-parts.png'],
  [['mobile', 'part'],              '/img/subcat-phones-parts.png'],
  [['mobile', 'phone'],             '/img/subcat-phones-mobile-phones.png'],
  [['accessor', 'part'],            '/img/subcat-electronics-accessories-parts.png'],
  [['portable', 'audio'],           '/img/subcat-electronics-portable-audio-video.png'],
  [['portable', 'video'],           '/img/subcat-electronics-portable-audio-video.png'],
  [['home', 'audio'],               '/img/subcat-electronics-home-audio-video.png'],
  [['home', 'video'],               '/img/subcat-electronics-home-audio-video.png'],
  [['smart', 'electronic'],         '/img/subcat-electronics-smart-electronics.png'],
  [['camera', 'photo'],             '/img/subcat-electronics-camera-photo.png'],
  [['video', 'game'],               '/img/subcat-electronics-video-games.png'],
  [['men', 'underwear'],            '/img/subcat-men-underwear-sleepwear.png'],
  [['men', 'sleepwear'],            '/img/subcat-men-underwear-sleepwear.png'],
  [['men', 'outerwear'],            '/img/subcat-men-outerwear-jackets.png'],
  [['men', 'jacket'],               '/img/subcat-men-outerwear-jackets.png'],
  [['men', 'accessor'],             '/img/subcat-men-accessories.png'],
  [['men', 'bottom'],               '/img/subcat-men-bottoms.png'],
  [['men', 'pants'],                '/img/subcat-men-bottoms.png'],
  [['men', 'top'],                  '/img/subcat-men-tops-tees.png'],
  [['men', 'tee'],                  '/img/subcat-men-tops-tees.png'],
  [['men', 'shirt'],                '/img/subcat-men-tops-tees.png'],
  [['men', 'hat'],                  '/img/subcat-men-hats-caps.png'],
  [['men', 'cap'],                  '/img/subcat-men-hats-caps.png'],
  [['women', 'couple', 'parent'],   '/img/subcat-women-couple-parent-child.png'],
  [['women', 'parent', 'child'],    '/img/subcat-women-couple-parent-child.png'],
  [['women', 'tops', 'sets'],       '/img/subcat-women-tops-sets.png'],
  [['women', 'bottom'],             '/img/subcat-women-bottoms.png'],
  [['women', 'outerwear'],          '/img/subcat-women-outerwear-jackets.png'],
  [['women', 'jacket'],             '/img/subcat-women-outerwear-jackets.png'],
  [['women', 'wedding'],            '/img/subcat-women-weddings-events.png'],
  [['women', 'event'],              '/img/subcat-women-weddings-events.png'],
  [['women', 'accessor'],           '/img/subcat-women-accessories.png'],
  [['home', 'improvement'],     '/img/cat-home-improvement.png'],
  [['audio'],                   '/img/cat-electronics.png'],
  [['gadget'],                  '/img/cat-electronics.png'],
  [['smart'],                   '/img/cat-electronics.png'],
  [['all', 'categories'],       '/img/cat-computers-office.png'],
  [['home'],                    '/img/cat-home-garden.png'],
  [['health'],                  '/img/cat-health-beauty.png'],
  [['beauty'],                  '/img/cat-health-beauty.png'],
  [['jewelr'],                  '/img/cat-jewelry-watches.png'],
  [['watch'],                   '/img/cat-jewelry-watches.png'],
  [['women'],                   '/img/cat-women-clothing.png'],
  [['men'],                     '/img/cat-men-clothing.png'],
  [['pet'],                     '/img/cat-pet-supplies.png'],
  [['bag'],                     '/img/cat-bags-shoes.png'],
  [['shoe'],                    '/img/cat-bags-shoes.png'],
  [['toy'],                     '/img/cat-toys-kids.png'],
  [['kid'],                     '/img/cat-toys-kids.png'],
  [['baby'],                    '/img/cat-toys-kids.png'],
  [['sport'],                   '/img/cat-sports-outdoors.png'],
  [['outdoor'],                 '/img/cat-sports-outdoors.png'],
  [['consumer', 'electronic'],  '/img/cat-electronics.png'],
  [['electronic'],              '/img/cat-electronics.png'],
  [['auto'],                    '/img/cat-automobiles.png'],
  [['motorcycle'],              '/img/cat-automobiles.png'],
  [['phone'],                   '/img/cat-phones-accessories.png'],
  [['computer'],                '/img/cat-computers-office.png'],
  [['office'],                  '/img/cat-computers-office.png'],
];
function categoryKeywordMatches(lower, keyword) {
  if (keyword === 'men') return /\b(men|mens|men['’]s|man)\b/.test(lower);
  if (keyword === 'women') return /\b(women|womens|women['’]s|woman)\b/.test(lower);
  return lower.includes(keyword);
}
function allCategoryKeywordsMatch(lower, keywords) {
  return keywords.every(k => categoryKeywordMatches(lower, k));
}
function catImage(name, contextName = '') {
  if (!name) return null;
  const lower = (name || '').toLowerCase();
  const contextLower = (contextName || '').toLowerCase();
  for (const [keywords, src, contextKeywords = []] of CAT_IMAGE_RULES) {
    if (contextKeywords.length && !allCategoryKeywordsMatch(contextLower, contextKeywords)) continue;
    const gender = keywords.includes('men') ? 'men' : (keywords.includes('women') ? 'women' : null);
    if (gender && keywords.length > 1) {
      if (!categoryKeywordMatches(contextLower, gender) && !categoryKeywordMatches(lower, gender)) continue;
      if (allCategoryKeywordsMatch(lower, keywords.filter(k => k !== gender))) return `${src}?v=${CATEGORY_IMAGE_VERSION}`;
    } else if (allCategoryKeywordsMatch(lower, keywords)) {
      return `${src}?v=${CATEGORY_IMAGE_VERSION}`;
    }
  }
  return null;
}
const CAT_ART_PALETTES = [
  ['#EFF6FF', '#2563EB', '#0F172A'],
  ['#FFF7ED', '#F97316', '#7C2D12'],
  ['#FDF2F8', '#DB2777', '#831843'],
  ['#ECFDF5', '#059669', '#064E3B'],
  ['#F5F3FF', '#7C3AED', '#2E1065'],
  ['#FEFCE8', '#CA8A04', '#713F12'],
  ['#F0FDFA', '#0D9488', '#134E4A'],
  ['#EEF2FF', '#4F46E5', '#1E1B4B'],
];
function hashString(s) {
  let h = 0;
  const text = String(s || 'global shopper');
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function categoryGeneratedArt(name) {
  const h = hashString(name);
  const [light, accent, dark] = CAT_ART_PALETTES[h % CAT_ART_PALETTES.length];
  const rotate = (h % 9) - 4;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
      <defs>
        <linearGradient id="g" x1="16" y1="10" x2="146" y2="152" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="${light}"/>
          <stop offset="0.62" stop-color="#FFFFFF"/>
          <stop offset="1" stop-color="${light}"/>
        </linearGradient>
        <filter id="s" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="${dark}" flood-opacity=".18"/>
        </filter>
        <linearGradient id="p" x1="36" y1="34" x2="124" y2="130" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#FFFFFF"/>
          <stop offset="1" stop-color="${light}"/>
        </linearGradient>
      </defs>
      <rect width="160" height="160" rx="34" fill="url(#g)"/>
      <circle cx="122" cy="34" r="34" fill="${accent}" opacity=".16"/>
      <circle cx="28" cy="132" r="44" fill="${accent}" opacity=".10"/>
      <path d="M21 45c30-22 60-25 91-8 16 9 27 8 38-1" fill="none" stroke="${accent}" stroke-opacity=".18" stroke-width="10" stroke-linecap="round"/>
      <g transform="rotate(${rotate} 80 82)" filter="url(#s)">
        <rect x="40" y="44" width="82" height="78" rx="21" fill="url(#p)" stroke="#FFFFFF" stroke-width="3"/>
        <rect x="55" y="58" width="48" height="8" rx="4" fill="${accent}" opacity=".22"/>
        <rect x="55" y="74" width="64" height="34" rx="13" fill="${accent}" opacity=".16"/>
        <circle cx="112" cy="52" r="14" fill="#fff"/>
        <circle cx="112" cy="52" r="7" fill="${accent}" opacity=".42"/>
      </g>
      <path d="M51 122h58" stroke="${dark}" stroke-opacity=".10" stroke-width="7" stroke-linecap="round"/>
    </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}
function categoryVisualSrc(name, contextName = '') {
  const photo = catImage(name, contextName);
  return photo || categoryGeneratedArt(name);
}
function catIcon(name, contextName = '') {
  return `<img src="${categoryVisualSrc(name, contextName)}" alt="" class="cat-img" width="70" height="70" loading="lazy" decoding="async"/>`;
}

const HOME_CATEGORY_SHORTCUTS = [
  { id: 'mobileWomenCat', label: "Women's Clothing", match: /^women.?s\s+clothing/i, fallback: '/search?q=women dress', artName: "Women's Clothing" },
  { id: 'mobileMenCat', label: "Men's Clothing", match: /^men.?s\s+clothing/i, fallback: '/search?q=men shirt', artName: "Men's Clothing" },
  { id: 'mobileGadgetsCat', label: 'Consumer Electronics', match: /consumer.*electronic|electronic/i, fallback: '/search?q=smart watch', artName: 'Consumer Electronics' },
  { id: 'mobileAudioCat', label: 'Phones & Accessories', match: /phone/i, fallback: '/search?q=headphones', artName: 'Phones & Accessories' },
  { id: 'mobileWatchesCat', label: 'Jewelry & Watches', match: /jewel|watch/i, fallback: '/search?q=watch', artName: 'Jewelry & Watches' },
  { id: 'mobileBeautyCat', label: 'Health, Beauty & Hair', match: /health|beauty/i, fallback: '/search?q=makeup organizer', artName: 'Health, Beauty & Hair' },
  { id: 'mobileBagsCat', label: 'Bags & Shoes', match: /bag|shoe/i, fallback: '/search?q=handbag', artName: 'Bags & Shoes' },
  { id: 'mobileHomeCat', label: 'Home, Garden & Furniture', match: /home.*garden|garden|furniture/i, fallback: '/search?q=kitchen tools', artName: 'Home, Garden & Furniture' },
  { id: 'mobileKidsCat', label: 'Toys, Kids & Babies', match: /toy|kid|bab/i, fallback: '/search?q=kids toy', artName: 'Toys, Kids & Babies' },
  { id: 'mobileSportsCat', label: 'Sports & Outdoors', match: /sport|outdoor/i, fallback: '/search?q=sports', artName: 'Sports & Outdoors' },
  { id: 'mobilePetsCat', label: 'Pet Supplies', match: /pet/i, fallback: '/search?q=pet supplies', artName: 'Pet Supplies' },
  { id: 'mobileAutoCat', label: 'Automobiles & Motorcycles', match: /automobile|motorcycle|auto/i, fallback: '/search?q=car accessories', artName: 'Automobiles & Motorcycles' },
  { id: 'mobileHomeImproveCat', label: 'Home Improvement', match: /home\s*improvement|improvement|hardware|tools/i, fallback: '/search?q=home improvement', artName: 'Home Improvement' },
];
function findTopCategory(match) {
  if (!match) return null;
  return (state.categories || []).find(c => match.test(c.categoryFirstName || '')) || null;
}
function renderMobileCategoryShortcuts() {
  return HOME_CATEGORY_SHORTCUTS.map(item => {
    const cat = findTopCategory(item.match);
    const href = cat ? categoryHref(cat) : item.fallback;
    const artName = cat ? (cat.categoryFirstName || item.artName) : item.artName;
    const label = cat ? (cat.categoryFirstName || item.label) : item.label;
    return `<a id="${item.id}" href="${href}">
      <img src="${categoryVisualSrc(artName)}" alt="" width="70" height="70" loading="lazy" />
      <span>${esc(label)}</span>
    </a>`;
  }).join('');
}

// Build a hash link for a CJ category at any nesting level. Uses CJ's
// real categoryId so list pages get the exact products in that category
// (a keyword search on the name returns wrong/no results — e.g. "Smart
// glasses" or "Woman Prescription Glasses" match almost nothing as a
// keyword, but their categoryId returns the actual catalog).
function categoryHref(item) {
  if (!item) return '/';
  const name = (item.categoryName || item.categorySecondName || item.categoryFirstName || '').trim();
  const id = item.categoryId || item.categorySecondId || item.categoryFirstId || '';
  if (id) return `/category/${encodeURIComponent(id)}?name=${encodeURIComponent(name)}`;
  return `/search?q=${encodeURIComponent(name)}`;
}

async function loadCategories() {
  if (state.categories.length) {
    if (typeof populateDrawerCategories === 'function') populateDrawerCategories();
    return state.categories;
  }
  try {
    const res = await apiGet('/api/store/categories');
    state.categories = Array.isArray(res.data) ? res.data : [];
  } catch { state.categories = []; }
  // Populate the mobile drawer accordion as soon as categories are ready
  if (typeof populateDrawerCategories === 'function') populateDrawerCategories();
  return state.categories;
}

// Header "All" button opens a dropdown of all top-level categories
headerCatBtn?.addEventListener('click', async (e) => {
  e.stopPropagation();
  await loadCategories();
  const isOpen = !catDropdown.hidden;
  if (isOpen) { catDropdown.hidden = true; return; }
  catDropdown.innerHTML = state.categories.map(cat => {
    const name = cat.categoryFirstName || '';
    return `<a class="cat-dropdown-item" href="${categoryHref(cat)}">
      <span>${catIcon(name)}</span>${esc(name)}
    </a>`;
  }).join('');
  const rect = headerCatBtn.getBoundingClientRect();
  catDropdown.style.left = rect.left + 'px';
  catDropdown.style.top = (rect.bottom + 4) + 'px';
  catDropdown.hidden = false;
});
document.addEventListener('click', (e) => {
  if (catDropdown && !catDropdown.hidden && !catDropdown.contains(e.target)) {
    catDropdown.hidden = true;
  }
});

// ══════════════════════════════════════════════════════════════
//  MEGA-MENU CATEGORIES (home page)
//  Two-pane layout:
//    left  = list of all top-level categories with icons (first is active)
//    right = selected category's second-level groups, each with a list
//            of third-level categories (click → search results)
// ══════════════════════════════════════════════════════════════
function renderMegaCategories() {
  const leftEl = document.getElementById('megaCatsLeft');
  const rightEl = document.getElementById('megaCatsRight');
  if (!leftEl || !rightEl) return;

  const cats = state.categories || [];
  if (!cats.length) {
    leftEl.innerHTML = '';
    rightEl.innerHTML = '<p class="muted" style="padding:20px">Could not load categories.</p>';
    return;
  }

  // Left pane: list of top-level categories
  leftEl.innerHTML = cats.map((cat, idx) => {
    const name = cat.categoryFirstName || '';
    const href = categoryHref(cat);
    // categoryHref now returns clean paths (e.g. /category/123?name=Foo)
    // so we use navigate() directly instead of writing to location.hash.
    return `
      <button type="button"
              class="mega-cat-item ${idx === 0 ? 'active' : ''}"
              data-idx="${idx}"
              onclick="navigate('${href.replace(/'/g, "\\'")}')"
              onmouseenter="megaSelect(${idx})">
        <span class="mega-cat-icon">${catIcon(name)}</span>
        <span class="mega-cat-name">${esc(name)}</span>
        <span class="mega-cat-chev">›</span>
      </button>
    `;
  }).join('');

  // Default-render the first category on the right
  megaSelect(0);
}

// Render the right panel for a given top-level category index
window.megaSelect = function(idx) {
  const leftEl = document.getElementById('megaCatsLeft');
  const rightEl = document.getElementById('megaCatsRight');
  if (!leftEl || !rightEl) return;

  const cat = state.categories[idx];
  if (!cat) return;

  // Update left pane active state
  leftEl.querySelectorAll('.mega-cat-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-idx') === String(idx));
  });

  const secondGroups = cat.categoryFirstList || [];
  if (!secondGroups.length) {
    rightEl.innerHTML = `
      <div class="mega-empty">
        <p>Browse all <strong>${esc(cat.categoryFirstName)}</strong> products</p>
        <a class="btn btn-primary" href="${categoryHref(cat)}">Shop ${esc(cat.categoryFirstName)} →</a>
      </div>
    `;
    return;
  }

  rightEl.innerHTML = secondGroups.map(group => {
    const secondName = group.categorySecondName || '';
    const thirds = group.categorySecondList || [];
    const groupHref = categoryHref(group);
    return `
      <div class="mega-group">
        <a class="mega-group-head" href="${groupHref}">${esc(secondName)}</a>
        <div class="mega-group-items">
          ${thirds.map(t => {
            const tName = t.categoryName || '';
            return `<a href="${categoryHref(t)}">${esc(tName)}</a>`;
          }).join('')}
        </div>
      </div>
    `;
  }).join('');
};

// ══════════════════════════════════════════════════════════════
//  PER-PRODUCT SHIPPING/PRICE CACHE (localStorage, 24h)
//  When the server backfills a price for a product, we remember it on
//  the user's device. Returning visitors see prices INSTANTLY without
//  any backfill — same TTL as the server-side disk cache so they stay
//  in sync.
// ══════════════════════════════════════════════════════════════
// Bump this whenever the pricing formula changes so returning visitors
// don't keep seeing stale prices from their localStorage cache (6mo TTL).
//   v1 → v2: 20% → 50% markup
//   v2 → v3: 50% → 65% markup (compensates for CJ shipping API gap)
// Bumped v3 → v4 to invalidate stale prices that were cached before
// SHIPPING_FEE_FACTOR was introduced. The 6-month TTL means cached
// prices stick around far too long when the pricing formula changes,
// so any change to how the display price is computed should bump this.
const SHIP_LS_KEY = 'befach_ship_v4';
const SHIP_LS_TTL_MS = 180 * 24 * 60 * 60 * 1000;  // 6 months
let _shipCache = null;
function _loadShipCache() {
  if (_shipCache) return _shipCache;
  try { _shipCache = JSON.parse(localStorage.getItem(SHIP_LS_KEY) || '{}'); }
  catch { _shipCache = {}; }
  return _shipCache;
}
function _saveShipCache() {
  try { localStorage.setItem(SHIP_LS_KEY, JSON.stringify(_shipCache || {})); } catch {}
}
function getCachedDisplayUsd(pid) {
  const c = _loadShipCache();
  const e = c[pid];
  if (!e || Date.now() - e.ts > SHIP_LS_TTL_MS) return null;
  return e.displayUsd;
}
function setCachedDisplayUsd(pid, displayUsd) {
  const c = _loadShipCache();
  c[pid] = { displayUsd: parseFloat(displayUsd), ts: Date.now() };
  // Trim to last 500 entries to keep storage bounded
  const keys = Object.keys(c);
  if (keys.length > 500) {
    keys.sort((a, b) => c[a].ts - c[b].ts);
    for (let i = 0; i < keys.length - 500; i++) delete c[keys[i]];
  }
  _saveShipCache();
}

// ── Recent searches (localStorage) ──
// Stored most-recent first, max 10. Surfaced in the header search bar
// dropdown for one-click re-running of past queries.
const RECENT_SEARCHES_KEY = 'befach_recent_searches_v1';
function getRecentSearches() {
  try { return JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || '[]'); }
  catch { return []; }
}
function pushRecentSearch(q) {
  const trimmed = (q || '').trim();
  if (!trimmed || trimmed.length < 2) return;
  let list = getRecentSearches().filter(x => x.toLowerCase() !== trimmed.toLowerCase());
  list.unshift(trimmed);
  if (list.length > 10) list = list.slice(0, 10);
  try { localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list)); } catch {}
}
function clearRecentSearches() {
  try { localStorage.removeItem(RECENT_SEARCHES_KEY); } catch {}
}

// ══════════════════════════════════════════════════════════════
//  PRODUCT CARD
// ══════════════════════════════════════════════════════════════
function productCard(p, idx) {
  const pid = p.pid || p.id || p.productId || '';
  const name = p.productNameEn || p.nameEn || p.productName || 'Untitled';
  const image = parseProductImage(p);
  const serverAccurate = p.shippingAccurate === true;
  const aboveFold = typeof idx === 'number' && idx < 8;

  // Always show SOMETHING — never a skeleton. The server already returns a
  // usable price (using a flat fallback shipping for products it hasn't
  // warmed yet). Backfill silently refines it once CJ returns real
  // shipping. Cached localStorage value wins if present (fastest + accurate).
  const cachedDisplay = getCachedDisplayUsd(pid);
  let displayUsd = parseFloat(p.sellPrice || p.price || 0) || 0;
  let accurate = false;
  if (serverAccurate) {
    accurate = true;
  } else if (cachedDisplay != null) {
    displayUsd = cachedDisplay;
    accurate = true;
  }

  // Synthetic "MRP / X% off" — server attaches a deterministic strike-
  // through price and discount badge per product. If for some reason
  // the server didn't include them (older cache entry), skip the
  // strike-through; the real price still shows.
  const mrpUsd = parseFloat(p.mrp || 0) || 0;
  const discountPct = parseInt(p.discountPercent, 10) || 0;
  const showOffer = mrpUsd > displayUsd && discountPct > 0;

  const inWishlist = isInWishlist(pid);

  return `
    <a class="product-card fade-in"
       href="/product/${encodeURIComponent(pid)}"
       data-pid="${esc(pid)}"
       data-accurate="${accurate ? '1' : '0'}"
       data-mrp="${mrpUsd}"
       data-discount="${discountPct}">
      <div class="product-card-img-wrap">
        <img class="product-card-img" src="${imgProxy(image)}" alt="${esc(name)}"
          width="400" height="400"
          loading="${aboveFold ? 'eager' : 'lazy'}"
          fetchpriority="${aboveFold ? 'high' : 'low'}"
          decoding="async"
          onerror="this.onerror=null;this.src='/img/globalshopper.png'" />
        <button type="button"
                class="product-card-wish ${inWishlist ? 'on' : ''}"
                data-wish-pid="${esc(pid)}"
                aria-label="${inWishlist ? 'Remove from wishlist' : 'Add to wishlist'}"
                aria-pressed="${inWishlist ? 'true' : 'false'}"
                onclick="event.preventDefault(); event.stopPropagation(); window._cardWishToggle(this)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/>
          </svg>
        </button>
      </div>
      <div class="product-card-body">
        <div class="product-card-title">${esc(name)}</div>
        <div class="product-card-prices">
          ${accurate
            ? `<span class="product-price-now" data-card-price>${fmtINR(displayUsd)}</span>`
            : `<span class="product-price-calc" data-card-price aria-label="Calculating final price">Calculating…</span>`
          }
          ${accurate && showOffer ? `<span class="product-price-mrp" data-card-mrp>${fmtINR(mrpUsd)}</span>` : `<span class="product-price-mrp" data-card-mrp hidden></span>`}
          ${accurate && showOffer ? `<span class="product-price-save" data-card-save>${discountPct}% off</span>` : `<span class="product-price-save" data-card-save hidden></span>`}
        </div>
        <div class="product-card-ship">Shipping included</div>
      </div>
    </a>
  `;
}

// Click handler for the heart-button on every product card. Stops the
// click from bubbling up to the surrounding <a> (which would navigate
// to the product detail page). Toggles wishlist state and shows a
// short confirmation toast.
window._cardWishToggle = function(btn) {
  const pid = btn?.getAttribute('data-wish-pid');
  if (!pid) return;
  if (!state.user) return requireSignIn('save products to your wishlist');
  const added = toggleWishlist(pid);
  showToast(added ? '♥ Added to wishlist' : 'Removed from wishlist');
};
// Same handler for the wishlist button on the product detail page —
// just doesn't need preventDefault since the button isn't inside a
// link there. Updates the label so the user gets clear feedback.
window._pdWishToggle = function(btn) {
  const pid = btn?.getAttribute('data-wish-pid');
  if (!pid) return;
  if (!state.user) return requireSignIn('save products to your wishlist');
  const added = toggleWishlist(pid);
  const label = btn.querySelector('.btn-wish-pd-label');
  if (label) label.textContent = added ? 'Saved' : 'Wishlist';
  showToast(added ? '♥ Added to wishlist' : 'Removed from wishlist');
};

/**
 * Backfill real shipping for cards that are waiting on exact prices.
 *
 * Global concurrency = 4 across the whole page. Home renders several
 * sections in parallel, so a shared queue prevents later sections from
 * canceling earlier ones while keeping user-clicks ahead in the server's
 * high-priority queue. Aborts on route change so abandoned pages don't
 * keep CJ calls in flight.
 *
 * Successful backfills are stored in localStorage so the next visit
 * is instant — no server roundtrip, no skeleton.
 */
let currentBackfillAbort = null;
let priceBackfillQueue = [];
let priceBackfillRunning = 0;
let priceBackfillSeen = new Set();
const PRICE_BACKFILL_CONCURRENCY = 2;

function cancelBackfill() {
  if (currentBackfillAbort) {
    try { currentBackfillAbort.abort(); } catch {}
    currentBackfillAbort = null;
  }
  priceBackfillQueue = [];
  priceBackfillRunning = 0;
  priceBackfillSeen = new Set();
}

async function backfillOneCardPrice(card, abort) {
  const pid = card.getAttribute('data-pid');
  if (!pid || abort.signal.aborted || !card.isConnected) return;

  try {
    const res = await fetch(`/api/store/shipping-for/${encodeURIComponent(pid)}`, {
      signal: abort.signal,
    });
    if (!res.ok) return;
    const data = await res.json();
    if (abort.signal.aborted || !card.isConnected) return;

    if (data.available === false) {
      // Unshippable to India — drop the card from the grid so the user
      // never clicks through to the "Not available in your region" page.
      card.remove();
      return;
    }

    if (data.displayUsd) {
      // Persist for instant load on next visit.
      setCachedDisplayUsd(pid, data.displayUsd);
      const priceEl = card.querySelector('[data-card-price]');
      if (priceEl) {
        priceEl.textContent = fmtINR(data.displayUsd);
        priceEl.classList.remove('product-price-calc');
        priceEl.classList.add('product-price-now');
        priceEl.removeAttribute('aria-label');
      }

      const mrpUsd = parseFloat(card.getAttribute('data-mrp')) || 0;
      const discountPct = parseInt(card.getAttribute('data-discount'), 10) || 0;
      const showOffer = (data.mrp || mrpUsd) > parseFloat(data.displayUsd) && discountPct > 0;
      const mrpEl = card.querySelector('[data-card-mrp]');
      const saveEl = card.querySelector('[data-card-save]');
      if (showOffer) {
        if (mrpEl) {
          mrpEl.textContent = fmtINR(data.mrp || mrpUsd);
          mrpEl.removeAttribute('hidden');
        }
        if (saveEl) {
          saveEl.textContent = `${discountPct}% off`;
          saveEl.removeAttribute('hidden');
        }
      }
    }
    card.setAttribute('data-accurate', '1');
  } catch (e) {
    if (e.name === 'AbortError') return;
    // Swallow — card keeps waiting for an exact price.
  }
}

function pumpPriceBackfillQueue() {
  const abort = currentBackfillAbort;
  if (!abort || abort.signal.aborted) return;

  while (priceBackfillRunning < PRICE_BACKFILL_CONCURRENCY && priceBackfillQueue.length) {
    const card = priceBackfillQueue.shift();
    if (!card || !card.isConnected) continue;

    priceBackfillRunning++;
    backfillOneCardPrice(card, abort).finally(() => {
      priceBackfillRunning = Math.max(0, priceBackfillRunning - 1);
      if (abort === currentBackfillAbort && !abort.signal.aborted) {
        pumpPriceBackfillQueue();
      }
    });
  }
}

function backfillCardShipping(gridEl) {
  if (!gridEl || !gridEl.isConnected) return;
  if (!currentBackfillAbort || currentBackfillAbort.signal.aborted) {
    currentBackfillAbort = new AbortController();
  }

  const pending = Array.from(gridEl.querySelectorAll('.product-card[data-accurate="0"]'));
  for (const card of pending) {
    const pid = card.getAttribute('data-pid');
    if (!pid || priceBackfillSeen.has(pid)) continue;
    priceBackfillSeen.add(pid);
    priceBackfillQueue.push(card);
  }
  pumpPriceBackfillQueue();
}

function parseProductImage(p) {
  let image = p.productImage || p.bigImage || '';
  if (typeof image === 'string' && image.startsWith('[')) {
    try { const arr = JSON.parse(image); if (Array.isArray(arr) && arr.length) image = arr[0]; } catch {}
  }
  if (Array.isArray(image) && image.length) image = image[0];
  return typeof image === 'string' ? image : '';
}

// ══════════════════════════════════════════════════════════════
//  HOME
// ══════════════════════════════════════════════════════════════
async function renderHome() {
  app.innerHTML = `
    <div class="home-layout">
      <!-- Left sidebar: persistent CJ-style category list with hover-flyout -->
      <aside class="home-sidebar" id="homeSidebar">
        ${Array(14).fill('<div class="sidebar-cat skeleton" style="height:48px;margin:4px 0"></div>').join('')}
      </aside>

      <div class="home-main">
        <section class="home-usp-carousel" id="homeUspCarousel" aria-label="Global Shopper offers" aria-roledescription="carousel" tabindex="0">
          <div class="home-usp-viewport">
            <div class="home-usp-track">
              ${HOME_USP_SLIDES.map((slide, index) => `
                <a class="home-usp-slide${index === 0 ? ' is-active' : ''}" href="${slide.href}" aria-label="${esc(slide.label)}" aria-hidden="${index === 0 ? 'false' : 'true'}" tabindex="${index === 0 ? '0' : '-1'}">
                  <img src="${slide.src}?v=20260512usp" alt="${esc(slide.alt)}" width="1920" height="1080" loading="${index === 0 ? 'eager' : 'lazy'}" decoding="async"${index === 0 ? ' fetchpriority="high"' : ''} />
                </a>
              `).join('')}
            </div>
          </div>
          <div class="home-usp-dots" role="tablist" aria-label="Choose promotional slide">
            ${HOME_USP_SLIDES.map((slide, index) => `
              <button class="home-usp-dot${index === 0 ? ' is-active' : ''}" type="button" role="tab" aria-selected="${index === 0 ? 'true' : 'false'}" aria-label="Show slide ${index + 1}: ${esc(slide.label)}" data-usp-dot="${index}"></button>
            `).join('')}
          </div>
        </section>

        <section class="mobile-shop-strip" id="mobileShopStrip" aria-label="Featured departments">
          ${renderMobileCategoryShortcuts()}
        </section>

        <!-- TRUST BADGES -->
        <section class="trust-row">
          <div class="trust-item">
            <div class="trust-icon">✦</div>
            <div class="trust-text"><strong>Premium Quality</strong><span>Every order, hand-checked</span></div>
          </div>
          <div class="trust-item">
            <div class="trust-icon">✈</div>
            <div class="trust-text"><strong>10–15 Day Delivery</strong><span>Tracked, all the way home</span></div>
          </div>
          <div class="trust-item">
            <div class="trust-icon">🛡</div>
            <div class="trust-text"><strong>Secure Checkout</strong><span>Razorpay-backed payments</span></div>
          </div>
          <div class="trust-item">
            <div class="trust-icon">✿</div>
            <div class="trust-text"><strong>Concierge Care</strong><span>Real humans, 24/7</span></div>
          </div>
        </section>

        <!-- FEATURED PRODUCTS -->
        <section class="section home-product-rail">
          <div class="section-head">
            <div>
              <span class="section-kicker">Fresh today</span>
              <h2 class="section-title">Global finds picked for you</h2>
            </div>
            <a href="/search?q=trending" class="section-link" id="featuredMore">View all →</a>
          </div>
          <div class="products-grid" id="featuredGrid">${productSkeleton(10)}</div>
        </section>

        <!-- EYE-CATCHING FASHION -->
        <section class="section home-product-rail">
          <div class="section-head">
            <div>
              <span class="section-kicker">Looks people notice</span>
              <h2 class="section-title">Top fashionable picks</h2>
            </div>
            <a href="/search?q=co ord set" class="section-link" id="fashionFindsMore">View all →</a>
          </div>
          <div class="products-grid" id="fashionFindsGrid">${productSkeleton(10)}</div>
        </section>

        <!-- MEN'S FASHION -->
        <section class="section home-product-rail">
          <div class="section-head">
            <div>
              <span class="section-kicker">Everyday style</span>
              <h2 class="section-title">Men's clothing picks</h2>
            </div>
            <a href="/search?q=men shirt" class="section-link" id="menMore">View all →</a>
          </div>
          <div class="products-grid" id="menGrid">${productSkeleton(8)}</div>
        </section>

        <!-- TRENDING TECH & GADGETS -->
        <section class="section home-product-rail">
          <div class="section-head">
            <div>
              <span class="section-kicker">Fast-moving tech</span>
              <h2 class="section-title">Electronics & accessories</h2>
            </div>
            <a href="/search?q=headphones" class="section-link" id="trendingMore">View all →</a>
          </div>
          <div class="products-grid" id="trendingGrid">${productSkeleton(10)}</div>
        </section>

        <!-- HARD TO FIND IN INDIA -->
        <section class="section home-product-rail">
          <div class="section-head">
            <div>
              <span class="section-kicker">Not everywhere locally</span>
              <h2 class="section-title">Hard-to-find global gadgets</h2>
            </div>
            <a href="/search?q=mini projector" class="section-link" id="rareFindsMore">View all →</a>
          </div>
          <div class="products-grid" id="rareFindsGrid">${productSkeleton(10)}</div>
        </section>

        <!-- WOMEN'S FASHION -->
        <section class="section home-product-rail">
          <div class="section-head">
            <div>
              <span class="section-kicker">Style picks</span>
              <h2 class="section-title">Women's clothing picks</h2>
            </div>
            <a href="/search?q=women dress" class="section-link" id="womenMore">View all →</a>
          </div>
          <div class="products-grid" id="womenGrid">${productSkeleton(8)}</div>
        </section>

        <!-- SMART GADGETS -->
        <section class="section home-product-rail">
          <div class="section-head">
            <div>
              <span class="section-kicker">Clever upgrades</span>
              <h2 class="section-title">Smart gadgets</h2>
            </div>
            <a href="/search?q=smart" class="section-link" id="smartMore">View all →</a>
          </div>
          <div class="products-grid" id="smartGrid">${productSkeleton(10)}</div>
        </section>

        <!-- HOME & LIFESTYLE -->
        <section class="section home-product-rail">
          <div class="section-head">
            <div>
              <span class="section-kicker">Useful imports</span>
              <h2 class="section-title">Home, tools & lifestyle</h2>
            </div>
            <a href="/search?q=power tool" class="section-link" id="homeLifestyleMore">View all →</a>
          </div>
          <div class="products-grid" id="homeLifestyleGrid">${productSkeleton(10)}</div>
        </section>
      </div>

      <!-- Sidebar hover-flyout panel (positioned absolute over main area) -->
      <div class="sidebar-flyout" id="sidebarFlyout" hidden></div>
    </div>
  `;

  initHomeUspCarousel();

  loadCategories().then(() => {
    renderHomeSidebar();
    const mobileStrip = document.getElementById('mobileShopStrip');
    if (mobileStrip) mobileStrip.innerHTML = renderMobileCategoryShortcuts();
  });
  loadHomeProducts();
}

function initHomeUspCarousel() {
  if (typeof stopHomeUspCarousel === 'function') {
    stopHomeUspCarousel();
    stopHomeUspCarousel = null;
  }

  const root = document.getElementById('homeUspCarousel');
  if (!root) return;

  const track = root.querySelector('.home-usp-track');
  const slides = Array.from(root.querySelectorAll('.home-usp-slide'));
  const dots = Array.from(root.querySelectorAll('.home-usp-dot'));
  if (!track || slides.length < 2) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let activeIndex = 0;
  let timer = null;
  let pointerStartX = 0;
  let pointerCurrentX = 0;
  let isDragging = false;

  const stopTimer = () => {
    if (timer) window.clearInterval(timer);
    timer = null;
  };

  const startTimer = () => {
    if (reduceMotion) return;
    stopTimer();
    timer = window.setInterval(() => setSlide(activeIndex + 1), 5200);
  };

  const setSlide = (nextIndex) => {
    activeIndex = (nextIndex + slides.length) % slides.length;
    track.style.transform = `translate3d(${-activeIndex * 100}%, 0, 0)`;
    slides.forEach((slide, index) => {
      slide.classList.toggle('is-active', index === activeIndex);
      slide.setAttribute('aria-hidden', index === activeIndex ? 'false' : 'true');
      slide.tabIndex = index === activeIndex ? 0 : -1;
    });
    dots.forEach((dot, index) => {
      dot.classList.toggle('is-active', index === activeIndex);
      dot.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
    });
  };

  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    isDragging = true;
    pointerStartX = event.clientX;
    pointerCurrentX = event.clientX;
    stopTimer();
    root.classList.add('is-dragging');
    root.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (!isDragging) return;
    pointerCurrentX = event.clientX;
  };

  const onPointerEnd = (event) => {
    if (!isDragging) return;
    isDragging = false;
    root.classList.remove('is-dragging');
    if (root.hasPointerCapture?.(event.pointerId)) {
      root.releasePointerCapture(event.pointerId);
    }
    const delta = pointerCurrentX - pointerStartX;
    if (Math.abs(delta) > 44) setSlide(activeIndex + (delta < 0 ? 1 : -1));
    startTimer();
  };

  dots.forEach(dot => {
    dot.addEventListener('click', () => {
      const index = Number(dot.dataset.uspDot || 0);
      setSlide(index);
      startTimer();
    });
  });

  root.addEventListener('mouseenter', stopTimer);
  root.addEventListener('mouseleave', startTimer);
  root.addEventListener('focusin', stopTimer);
  root.addEventListener('focusout', startTimer);
  root.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      setSlide(activeIndex + 1);
      startTimer();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setSlide(activeIndex - 1);
      startTimer();
    }
  });
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerEnd);
  root.addEventListener('pointercancel', onPointerEnd);

  setSlide(0);
  startTimer();
  stopHomeUspCarousel = stopTimer;
}

// Horizontal circular-icon category strip on the home page.
// Shows every top-level CJ category. Hovering an icon opens a full-width
// mega-flyout with all second/third-level subcategories — same data the
// All Categories page uses. Clicks on the icon itself go to the category
// listing; clicks inside the flyout drill straight to the subcategory.
function renderCategoryStrip() {
  const el = document.getElementById('catStrip');
  if (!el) return;
  const cats = state.categories || [];
  if (!cats.length) {
    el.innerHTML = '<p class="muted" style="padding:12px">Categories unavailable</p>';
    return;
  }
  el.innerHTML = cats.map((cat, idx) => {
    const name = cat.categoryFirstName || '';
    return `<a class="cat-strip-item" data-idx="${idx}" href="${categoryHref(cat)}">
      <div class="cat-strip-icon">${catIcon(name)}</div>
      <span class="cat-strip-name">${esc(name)}</span>
    </a>`;
  }).join('');

  const flyout = document.getElementById('catStripFlyout');
  el.querySelectorAll('.cat-strip-item').forEach(item => {
    item.addEventListener('mouseenter', () => showCatStripFlyout(parseInt(item.getAttribute('data-idx'))));
    item.addEventListener('focus',      () => showCatStripFlyout(parseInt(item.getAttribute('data-idx'))));
  });

  // Hide the flyout when cursor leaves both the strip and the flyout
  const maybeHide = () => {
    setTimeout(() => {
      if (!el.matches(':hover') && !flyout?.matches(':hover')) hideCatStripFlyout();
    }, 120);
  };
  el.addEventListener('mouseleave', maybeHide);
  flyout?.addEventListener('mouseleave', maybeHide);
}

function showCatStripFlyout(idx) {
  const flyout = document.getElementById('catStripFlyout');
  if (!flyout) return;
  const cat = state.categories[idx];
  if (!cat) return;

  const groups = cat.categoryFirstList || [];
  const title = cat.categoryFirstName || '';

  if (!groups.length) {
    flyout.innerHTML = `
      <div class="cat-strip-flyout-empty">
        <p>Browse all <strong>${esc(title)}</strong> products</p>
        <a class="btn btn-primary" href="${categoryHref(cat)}">Shop ${esc(title)} →</a>
      </div>
    `;
  } else {
    flyout.innerHTML = `
      <div class="cat-strip-flyout-head">
        <h3>${esc(title)}</h3>
        <a class="cat-strip-flyout-allbtn" href="${categoryHref(cat)}">View all in ${esc(title)} →</a>
      </div>
      <div class="cat-strip-flyout-grid">
        ${groups.map(g => {
          const gName = g.categorySecondName || '';
          const thirds = g.categorySecondList || [];
          const gHref = categoryHref(g);
          return `
            <div class="cat-strip-flyout-group">
              <a class="cat-strip-flyout-group-head" href="${gHref}">${esc(gName)}</a>
              ${thirds.length ? `<div class="cat-strip-flyout-group-items">
                ${thirds.map(t => `<a href="${categoryHref(t)}">${esc(t.categoryName || '')}</a>`).join('')}
              </div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }
  flyout.hidden = false;
}

function hideCatStripFlyout() {
  const flyout = document.getElementById('catStripFlyout');
  if (flyout) flyout.hidden = true;
}

// ── Left-sidebar category list with hover-to-expand subcategory flyout ──
function renderHomeSidebar() {
  const el = document.getElementById('homeSidebar');
  if (!el) return;
  const cats = state.categories || [];
  if (!cats.length) {
    el.innerHTML = '<p class="muted" style="padding:12px">Could not load categories.</p>';
    return;
  }
  el.innerHTML = cats.map((cat, idx) => {
    const name = cat.categoryFirstName || '';
    return `
      <a class="sidebar-cat"
         data-idx="${idx}"
         href="${categoryHref(cat)}">
        <span class="sidebar-cat-icon">${catIcon(name)}</span>
        <span class="sidebar-cat-name">${esc(name)}</span>
        <span class="sidebar-cat-chev">›</span>
      </a>
    `;
  }).join('');

  el.querySelectorAll('.sidebar-cat').forEach(item => {
    item.addEventListener('mouseenter', () => showSidebarFlyout(parseInt(item.getAttribute('data-idx'))));
    item.addEventListener('focus', () => showSidebarFlyout(parseInt(item.getAttribute('data-idx'))));
  });

  // Hide the flyout when cursor leaves both the sidebar and the flyout.
  // 250ms grace so a slow mouse moving across the grid-gap between them
  // doesn't trigger a premature hide. Combined with the flush positioning
  // below (left = sidebar.offsetWidth, no +8 gap), there's no longer a
  // no-hover dead zone for the cursor to cross — same UX as CJ.
  const flyout = document.getElementById('sidebarFlyout');
  const hideMaybe = () => {
    setTimeout(() => {
      if (!el.matches(':hover') && !flyout.matches(':hover')) hideSidebarFlyout();
    }, 250);
  };
  el.addEventListener('mouseleave', hideMaybe);
  flyout?.addEventListener('mouseleave', hideMaybe);
}

function showSidebarFlyout(idx) {
  const flyout = document.getElementById('sidebarFlyout');
  const sidebar = document.getElementById('homeSidebar');
  if (!flyout || !sidebar) return;
  const cat = state.categories[idx];
  if (!cat) return;

  // Mark active sidebar row
  sidebar.querySelectorAll('.sidebar-cat').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-idx') === String(idx));
  });

  const groups = cat.categoryFirstList || [];
  const title = cat.categoryFirstName || '';

  if (!groups.length) {
    flyout.innerHTML = `
      <div class="flyout-empty">
        <p>Browse all <strong>${esc(title)}</strong> products</p>
        <a class="btn btn-primary" href="${categoryHref(cat)}">Shop ${esc(title)} →</a>
      </div>
    `;
  } else {
    flyout.innerHTML = groups.map(g => {
      const gName = g.categorySecondName || '';
      const thirds = g.categorySecondList || [];
      const gHref = categoryHref(g);
      return `
        <div class="flyout-group">
          <a class="flyout-group-head" href="${gHref}">${esc(gName)}</a>
          <div class="flyout-group-items">
            ${thirds.map(t => {
              const tName = t.categoryName || '';
              return `<a href="${categoryHref(t)}">${esc(tName)}</a>`;
            }).join('')}
          </div>
        </div>
      `;
    }).join('');
  }

  // Position the flyout flush against the sidebar's right edge. The
  // .home-layout grid has a 20px gap between sidebar and main content,
  // and earlier we added another 8px on top — together that left the
  // cursor crossing ~28px of dead zone where neither sidebar nor flyout
  // was hovered, and the flyout would hide before the user reached it.
  // Sticking the flyout exactly at sidebar.offsetWidth (= sidebar's
  // right edge in the relative parent) makes it abut the sidebar with
  // no gap, matching CJ's seller-portal mega-menu UX.
  flyout.style.top = '0';
  flyout.style.left = sidebar.offsetWidth + 'px';
  flyout.hidden = false;
}

function hideSidebarFlyout() {
  const flyout = document.getElementById('sidebarFlyout');
  const sidebar = document.getElementById('homeSidebar');
  if (flyout) flyout.hidden = true;
  if (sidebar) sidebar.querySelectorAll('.sidebar-cat.active').forEach(el => el.classList.remove('active'));
}

async function loadHomeProducts() {
  const grids = {
    featured:      document.getElementById('featuredGrid'),
    fashionFinds:  document.getElementById('fashionFindsGrid'),
    men:           document.getElementById('menGrid'),
    women:         document.getElementById('womenGrid'),
    trending:      document.getElementById('trendingGrid'),
    rareFinds:     document.getElementById('rareFindsGrid'),
    smart:         document.getElementById('smartGrid'),
    homeLifestyle: document.getElementById('homeLifestyleGrid'),
  };
  const showErr = (el, msg) => { if (el) el.innerHTML = `<p class="muted">${esc(msg)}</p>`; };

  // Keywords rotate by day-of-year so the home page refreshes daily
  // instead of showing the same items forever.
  const today = new Date();
  const dayOfYear = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / 86400000);
  const pick = (arr) => arr[dayOfYear % arr.length];

  const featuredPool = [
    'trending', 'best seller', 'gift set', 'premium',
    'editor pick', 'limited edition', 'top rated', 'new arrival',
  ];
  const fashionFindsPool = [
    'co ord set', 'women dress', 'statement earrings', 'handbag',
    'platform sandals', 'oversized jacket', 'party dress', 'streetwear',
  ];
  const trendingPool = [
    'headphones', 'tv', 'monitor', 'tablet', 'camera',
    'soundbar', 'home theater', 'projector', 'laptop stand',
    'webcam', 'usb hub', 'docking station', 'wireless charger', 'streaming stick',
  ];
  const rareFindsPool = [
    'mini projector', 'smart glasses', 'portable printer', 'car vacuum',
    'key finder', 'wireless microscope', 'translator device', 'label maker',
    'portable blender', 'usb c dock', 'led mask', 'neck massager',
  ];
  const smartPool = [
    'smart bulb', 'smart plug', 'smart light', 'smart band',
    'smart sensor', 'smart camera', 'smart watch', 'smart scale',
    'smart fan', 'smart lock', 'smart key finder', 'smart speaker',
  ];
  const homePool = [
    'power tool', 'drill', 'tool kit', 'tape measure', 'screwdriver set',
    'hardware', 'door lock', 'led work light', 'cordless drill',
    'utility knife', 'wrench set', 'storage rack', 'cable organizer', 'led strip',
  ];

  // Make sure we have the CJ category tree before fetching fashion rows.
  // The Men's/Women's Fashion sections fetch by *categoryId* — keyword search
  // returned pet sunglasses, kids glasses, etc. when "women sunglasses" was
  // the rotating pick because both endpoints' name-matching is too loose.
  // CategoryId fetches stay inside the actual Women's Clothing / Men's
  // Clothing trees on CJ, so the rows reflect what the user expects.
  await loadCategories();
  const findCat = (re) => (state.categories || []).find(c => re.test(c.categoryFirstName || ''));
  // Anchor with ^ — without it, "men" matched the "men" *inside* "wo**men**'s
  // Clothing", so the men's row got dressed and bridal gowns instead of shirts.
  const womenCat = findCat(/^women.?s\s+clothing/i) || findCat(/^women/i);
  const menCat   = findCat(/^men.?s\s+clothing/i)   || findCat(/^men\b/i);

  // Point the fashion row "View all" links at the actual Men's /
  // Women's Clothing category page instead of a narrow keyword search.
  const setHref = (id, cat) => {
    if (!cat) return;
    const el = document.getElementById(id);
    if (el) el.href = categoryHref(cat);
  };
  setHref('menMore',    menCat);
  setHref('womenMore',  womenCat);

  const mobileStrip = document.getElementById('mobileShopStrip');
  if (mobileStrip) mobileStrip.innerHTML = renderMobileCategoryShortcuts();

  // Pick a child of the top-level women/men category so each daily load
  // surfaces a different slice (Dresses one day, Tops the next, etc.)
  // rather than always landing on whatever CJ orders first.
  //
  // Skip narrow accessory subcategories (Hats, Belts, Ties, Socks,
  // Underwear...) — landing on "Hats & Caps" filled the Men's Fashion
  // row with only baseball caps and beanies, which doesn't read as
  // "men's clothing" at a glance. Stays inside actual garment subs.
  const ACCESSORY_RE = /(hat|cap|beanie|belt|tie|scarf|glove|sock|stocking|underwear|sleepwear|nightwear|swimwear|swimsuit|lingerie|jewel|watch|bag|wallet|sunglass|eyewear|accessor)/i;
  const childPick = (cat) => {
    const subs = (cat?.categoryFirstList || []).filter(s => {
      const name = s.categorySecondName || '';
      return !ACCESSORY_RE.test(name);
    });
    return subs.length ? subs[dayOfYear % subs.length] : null;
  };
  const womenChild = childPick(womenCat);
  const menChild   = childPick(menCat);

  // Up to 3 candidate keywords per keyword-based section. If the first
  // returns 0 (e.g. shipping cache flagged everything as unshippable
  // for that specific keyword today), we transparently retry with the
  // next pool entry instead of showing a broken-looking empty state.
  // Cycles through the pool starting at today's day-of-year offset.
  const candidates = (pool, count = 3) =>
    Array.from({ length: count }, (_, i) => pool[(dayOfYear + i) % pool.length]);

  // 6 sections — restored Smart Gadgets now that Prime gives us 4 req/sec
  // (was dropped at 1 req/sec because each section adds ~280ms to the
  // listV2 queue, vs 900ms before — even cold loads stay under 2s).
  const sections = [
    { grid: grids.featured,      kind: 'kw',  keywords: candidates(featuredPool),      size: 10, moreId: 'featuredMore',      label: 'featured products' },
    { grid: grids.fashionFinds,  kind: 'kw',  keywords: candidates(fashionFindsPool),  size: 10, moreId: 'fashionFindsMore',  label: 'fashion finds' },
    { grid: grids.men,           kind: 'cat', cat: menChild   || menCat,               size: 8,  moreId: null,                label: "men's fashion" },
    { grid: grids.trending,      kind: 'kw',  keywords: candidates(trendingPool),      size: 10, moreId: 'trendingMore',      label: 'consumer electronics' },
    { grid: grids.rareFinds,     kind: 'kw',  keywords: candidates(rareFindsPool),     size: 10, moreId: 'rareFindsMore',     label: 'hard-to-find gadgets' },
    { grid: grids.women,         kind: 'cat', cat: womenChild || womenCat,             size: 8,  moreId: null,                label: "women's fashion" },
    { grid: grids.smart,         kind: 'kw',  keywords: candidates(smartPool),         size: 10, moreId: 'smartMore',         label: 'smart gadgets' },
    { grid: grids.homeLifestyle, kind: 'kw',  keywords: candidates(homePool),          size: 10, moreId: 'homeLifestyleMore', label: 'home improvement' },
  ];

  // Point keyword-based section "View all →" links at the keyword we
  // ended up *displaying* (set further down once a candidate succeeds).
  // The fashion sections have hard-coded hrefs already.

  // Hide a section's container outright when nothing is available — empty
  // "No X products available right now" copy looks like a broken site.
  // We walk up to the .section / .fashion-section ancestor and remove it.
  function hideSectionGracefully(gridEl) {
    if (!gridEl) return;
    const sec = gridEl.closest('.section, .fashion-section');
    if (sec) sec.remove();
  }

  // Fire all sections in parallel.
  await Promise.all(sections.map(async (s) => {
    if (!s.grid) return;
    try {
      let products = [];
      let chosenKeyword = null;

      if (s.kind === 'cat') {
        if (!s.cat) { hideSectionGracefully(s.grid); return; }
        const id = s.cat.categoryId || s.cat.categorySecondId || s.cat.categoryFirstId || '';
        const res = await apiGet(`/api/store/products?categoryId=${encodeURIComponent(id)}&size=${s.size}&page=1`);
        products = res.products || [];
      } else {
        // Try each candidate keyword in order, stop at the first that
        // returns at least 4 products (gives us a populated row).
        for (const kw of s.keywords) {
          const res = await apiGet(`/api/store/products?keyWord=${encodeURIComponent(kw)}&size=${s.size}&page=1`);
          const got = res.products || [];
          if (got.length >= 4) { products = got; chosenKeyword = kw; break; }
          if (got.length > products.length) { products = got; chosenKeyword = kw; }
        }
        // Update the "View all →" link to point at the keyword we
        // actually displayed.
        if (chosenKeyword && s.moreId) {
          const link = document.getElementById(s.moreId);
          if (link) link.href = `/search?q=${encodeURIComponent(chosenKeyword)}`;
        }
      }

      if (!products.length) {
        // All candidates empty — pull the section so the home page
        // doesn't show a sad "No X available" notice.
        hideSectionGracefully(s.grid);
        return;
      }
      s.grid.innerHTML = products.map(productCard).join('');
      backfillCardShipping(s.grid);
    } catch (err) {
      // Network error or unexpected response — keep the section visible
      // but show a short message so the user knows it's not their fault.
      showErr(s.grid, `Couldn't load ${s.label} — refresh the page.`);
    }
  }));
}

// ══════════════════════════════════════════════════════════════
//  ALL CATEGORIES PAGE
// ══════════════════════════════════════════════════════════════
async function renderAllCategories() {
  app.innerHTML = `
    <h1 class="page-title">All Categories</h1>
    <div id="allCatsGrid" class="categories-grid-full">
      ${Array(16).fill('<div class="category-card skeleton" style="height:120px"></div>').join('')}
    </div>
  `;
  await loadCategories();
  const grid = document.getElementById('allCatsGrid');
  if (!state.categories.length) { grid.innerHTML = '<p class="muted">No categories available.</p>'; return; }
  grid.innerHTML = state.categories.map(cat => {
    const name = cat.categoryFirstName || '';
    const subs = (cat.categoryFirstList || []);
    const catHref = categoryHref(cat);
    return `<div class="cat-block fade-in">
      <a href="${catHref}" class="cat-block-head">
        <span class="cat-block-icon">${catIcon(name)}</span>
        <span class="cat-block-name">${esc(name)}</span>
        <span class="cat-block-action">Shop all</span>
      </a>
      <div class="cat-block-groups">
        ${subs.map(s => {
          const subName = s.categorySecondName || '';
          const thirds = s.categorySecondList || [];
          const subHref = categoryHref(s);
          return `<a class="cat-sub-card" href="${subHref}">
            <span class="cat-sub-card-img">${catIcon(subName, name)}</span>
            <span class="cat-sub-card-name">${esc(subName)}</span>
            ${thirds.length ? `<span class="cat-sub-card-meta">${thirds.length} options</span>` : ''}
          </a>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
//  CATEGORY PAGE  (stub — shares search rendering)
// ══════════════════════════════════════════════════════════════
async function renderCategory(categoryId, page, params) {
  const name = params?.get('name') || '';
  // Make sure the category tree is loaded before we look up children
  await loadCategories();
  const childInfo = findCategoryChildren(categoryId);
  return renderSearch('', page, {
    categoryId,
    categoryName: name,
    categoryChildren: childInfo.children,
    categoryChildLevel: childInfo.level,
  });
}

// Find the immediate children of a given category id at any nesting level.
// Lets the category page surface chips for "Tops / Dresses / Accessories"
// when the user clicks a broad parent like "Women's Clothing", instead of
// being stuck on whatever CJ returns first for the parent id.
function findCategoryChildren(id) {
  for (const cat of state.categories || []) {
    if (cat.categoryFirstId === id) {
      return { children: cat.categoryFirstList || [], level: 'second' };
    }
    for (const sec of cat.categoryFirstList || []) {
      if (sec.categorySecondId === id) {
        return { children: sec.categorySecondList || [], level: 'third' };
      }
    }
  }
  return { children: [], level: '' };
}

// ══════════════════════════════════════════════════════════════
//  SEARCH / CATEGORY RESULTS
// ══════════════════════════════════════════════════════════════
async function renderSearch(query, page = 1, opts = {}) {
  // If the user typed a query, keep it visible in the search box even when a
  // category scope is also applied. Pure category browse (no query) clears
  // the input so the user isn't fooled into thinking they typed the name.
  if (headerSearchInput) headerSearchInput.value = (opts.categoryName && !query) ? '' : query;
  let rawTitle;
  if (query && opts.categoryName) {
    rawTitle = `Results for "${query}" in ${cleanDisplayName(opts.categoryName)}`;
  } else if (opts.categoryName) {
    rawTitle = cleanDisplayName(opts.categoryName);
  } else if (query) {
    rawTitle = `Results for "${query}"`;
  } else {
    rawTitle = 'Browse products';
  }
  const title = esc(rawTitle);
  if (opts.categoryName && !query) setPageTitle(`${cleanDisplayName(opts.categoryName)} Online | Global Shopper`);
  else if (query) setPageTitle(`Search results for ${query} | Global Shopper`);
  else setPageTitle('Browse Products | Global Shopper');
  const categoryChildren = opts.categoryChildren || [];
  const childChips = categoryChildren.length
    ? (opts.categoryChildLevel === 'third'
      ? `<nav class="subcategory-strip subcategory-text-strip" aria-label="Sub-subcategories">
          ${categoryChildren.map(c => {
            const cname = c.categoryName || c.categorySecondName || c.categoryFirstName || '';
            return `<a class="subcat-chip" href="${categoryHref(c)}">${esc(cname)}</a>`;
          }).join('')}
        </nav>`
      : `<nav class="subcategory-strip subcategory-visual-strip" aria-label="Subcategories">
          ${categoryChildren.map(c => {
            const cname = c.categoryName || c.categorySecondName || c.categoryFirstName || '';
            return `<a class="subcat-chip subcat-visual-card" href="${categoryHref(c)}">
              <span class="subcat-visual-img">${catIcon(cname, opts.categoryName || '')}</span>
              <span class="subcat-visual-name">${esc(cname)}</span>
            </a>`;
          }).join('')}
        </nav>`)
    : '';

  // Read sort state from URL.
  const urlParams = new URLSearchParams(location.search);
  const filterSort = urlParams.get('sort') || 'relevance';

  app.innerHTML = `
    <!-- Breadcrumb removed by request: the page title (h1) below already
         identifies where the user is, and the hamburger drawer carries
         the full category tree. The trail was eating ~40px of vertical
         space on mobile above the sort dropdown for no extra information. -->
    <div class="search-header">
      <div>
        <h1 class="page-title">${title}</h1>
        <div id="intentPill"></div>
      </div>
      <div class="search-toolbar">
        <select class="search-sort" id="searchSort" aria-label="Sort results">
          <option value="relevance" ${filterSort === 'relevance' ? 'selected' : ''}>Sort: Relevance</option>
          <option value="price_asc" ${filterSort === 'price_asc' ? 'selected' : ''}>Price: Low to High</option>
          <option value="price_desc" ${filterSort === 'price_desc' ? 'selected' : ''}>Price: High to Low</option>
        </select>
      </div>
    </div>
    ${childChips}
    <div class="search-layout search-layout-no-filters">
      <div class="search-results">
        <div class="products-grid" id="searchGrid">${productSkeleton(12)}</div>
        <div class="pagination" id="pagination"></div>
      </div>
    </div>
  `;

  function applySort() {
    const sort = document.getElementById('searchSort').value;
    const params = new URLSearchParams();
    if (opts.categoryId && query) {
      params.set('q', query);
      params.set('categoryId', opts.categoryId);
      if (opts.categoryName) params.set('catName', opts.categoryName);
      if (sort !== 'relevance') params.set('sort', sort);
      navigate(`/search?${params}`);
    } else if (opts.categoryId) {
      const params = new URLSearchParams();
      if (opts.categoryName) params.set('name', opts.categoryName);
      if (sort !== 'relevance') params.set('sort', sort);
      const suffix = params.toString() ? `?${params}` : '';
      navigate(`/category/${opts.categoryId}${suffix}`);
    } else if (query) {
      params.set('q', query);
      if (sort !== 'relevance') params.set('sort', sort);
      navigate(`/search?${params}`);
    }
  }
  document.getElementById('searchSort').onchange = applySort;

  try {
    // Use the smart search endpoint when there's a free-text query (and no
    // categoryId — for category browse the simpler /api/store/products is
    // fine since the category itself is the filter). Smart endpoint runs
    // the query through Gemini Flash to extract intent, then searches CJ
    // with cleaned keywords. Falls back to plain search internally if AI
    // is unavailable.
    let res;
    // size=40 is CJ's per-page max — bumped from 20 so category browse
    // and search results show twice as many products per page. Pairs
    // with the deep-walk prewarm so even page 5 loads instantly from
    // cache. Customer can paginate further; deep pages hit CJ live.
    const photoPayload = page === 1 ? getPhotoSearchPayload(opts.photoKey, query) : null;
    if (photoPayload) {
      res = photoPayload;
    } else if (query && !opts.categoryId) {
      const smartQs = new URLSearchParams({ q: query, page: String(page), size: '40' });
      res = await apiGet('/api/store/search/smart?' + smartQs.toString());
    } else {
      const qs = new URLSearchParams({ page: String(page), size: '40' });
      if (query) qs.set('keyWord', query);
      if (opts.categoryId) qs.set('categoryId', opts.categoryId);
      res = await apiGet('/api/store/products?' + qs.toString());
    }

    // Persist to recent searches whenever a free-text search runs
    if (query) pushRecentSearch(query);

    let products = res.products || [];

    if (filterSort === 'price_asc') {
      products.sort((a, b) => parseFloat(a.price || 0) - parseFloat(b.price || 0));
    } else if (filterSort === 'price_desc') {
      products.sort((a, b) => parseFloat(b.price || 0) - parseFloat(a.price || 0));
    }

    if (query) {
      trackEcommerceEvent('search', {
        search_term: query,
        items: products.slice(0, 12).map(p => analyticsItemFromProduct(p))
      });
    }

    const totalPages = res.totalPages || 1;

    // "Showing results for: blue cooling jacket under ₹2000" pill
    const intent = res.intent;
    if (intent && intent.understood && intent.source !== 'fallback') {
      const pillEl = document.getElementById('intentPill');
      if (pillEl) {
        pillEl.innerHTML = `
          <span class="intent-pill" title="AI understood your search">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
            Showing results for: <strong>${esc(intent.understood)}</strong>
          </span>
        `;
      }
    }

    const grid = document.getElementById('searchGrid');
    const pag = document.getElementById('pagination');
    if (pag) pag.innerHTML = '';
    if (!products.length) {
      grid.innerHTML = `<div class="empty-state">
        <div class="empty-icon">🔍</div>
        <h3>No products found</h3>
        <p class="muted">Try a different keyword or browse all categories.</p>
        <a class="btn btn-primary" href="/category">Browse categories</a>
      </div>`;
      return;
    }
    grid.innerHTML = products.map(productCard).join('');
    backfillCardShipping(grid);

    if (pag && totalPages > 1) {
      // Three modes: pure category browse, search-within-category, or pure search.
      let baseHash;
      if (opts.categoryId && query) {
        baseHash = `/search?q=${encodeURIComponent(query)}&categoryId=${encodeURIComponent(opts.categoryId)}${opts.categoryName ? `&catName=${encodeURIComponent(opts.categoryName)}` : ''}`;
      } else if (opts.categoryId) {
        baseHash = `/category/${opts.categoryId}${opts.categoryName ? `?name=${encodeURIComponent(opts.categoryName)}` : ''}`;
      } else {
        baseHash = `/search?q=${encodeURIComponent(query)}`;
      }
      // Carry the active sort into every page link.
      const filterParams = [];
      if (filterSort && filterSort !== 'relevance') filterParams.push(`sort=${filterSort}`);
      const filterSuffix = filterParams.length ? `&${filterParams.join('&')}` : '';
      const mkLink = (p) => {
        const sep = baseHash.includes('?') ? '&' : '?';
        return `${baseHash}${sep}page=${p}${filterSuffix}`;
      };
      const start = Math.max(1, page - 2);
      const end = Math.min(totalPages, page + 2);
      let html = '';
      // mkLink returns clean paths (e.g. "/search?q=foo&page=2"); no
      // leading "#" needed since we're on History API routing now.
      html += `<a class="page-btn ${page <= 1 ? 'disabled' : ''}" href="${mkLink(Math.max(1, page - 1))}">‹ Prev</a>`;
      for (let i = start; i <= end; i++) {
        html += `<a class="page-btn ${i === page ? 'active' : ''}" href="${mkLink(i)}">${i}</a>`;
      }
      html += `<a class="page-btn ${page >= totalPages ? 'disabled' : ''}" href="${mkLink(Math.min(totalPages, page + 1))}">Next ›</a>`;
      if (page < totalPages) {
        html += `<a class="load-more-btn" href="${mkLink(page + 1)}">Load more products</a>`;
      }
      pag.innerHTML = html;
    }
  } catch (err) {
    const pag = document.getElementById('pagination');
    if (pag) pag.innerHTML = '';
    document.getElementById('searchGrid').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <h3>Couldn't load products</h3>
        <p class="muted">${esc(err.message)}</p>
        <button class="btn btn-primary" onclick="location.reload()">Retry</button>
      </div>`;
  }
}

// ══════════════════════════════════════════════════════════════
//  PRODUCT DETAIL
// ══════════════════════════════════════════════════════════════
async function renderProduct(pid) {
  app.innerHTML = `<div class="loading-wrap"><div class="spinner"></div><p>Loading product...</p></div>`;

  let res;
  try {
    res = await apiGet(`/api/store/products/${encodeURIComponent(pid)}`);
  } catch (err) {
    // Server returns 404 with error code UNSHIPPABLE for products CJ can't
    // route to India. Give the customer a clear message instead of a raw error.
    const isUnshippable = /UNSHIPPABLE|shipping to India/i.test(err.message);
    app.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${isUnshippable ? '🚫' : '⚠️'}</div>
        <h3>${isUnshippable ? 'Not available in your region' : 'Product not found'}</h3>
        <p class="muted">${isUnshippable
          ? "Sorry, we can't ship this product to India right now. Please check out other items."
          : esc(err.message)}</p>
        <a class="btn btn-primary" href="/">← Back to store</a>
      </div>`;
    return;
  }
  const p = res.product;
  if (!p) { app.innerHTML = '<div class="empty-state"><h3>Product not found</h3></div>'; return; }

  // Cache this product's price for the next visit's list-page (so the
  // card displays instantly instead of showing a skeleton + backfilling).
  if (p.sellPrice) setCachedDisplayUsd(pid, p.sellPrice);

  const name = p.productNameEn || 'Product';
  setPageTitle(`${name.slice(0, 90)} | Global Shopper`);
  const sku = p.productSku || '';
  const priceUsd = parseFloat(p.price || p.sellPrice || 0);
  const bigImg = p.bigImage || '';
  const category = p.categoryName || '';
  const weight = p.productWeight || '';
  const desc = sanitizeHtml(p.description || '');
  const variants = Array.isArray(p.variants) ? p.variants : [];

  // Parse image array
  let images = [];
  if (Array.isArray(p.productImageSet)) images = p.productImageSet;
  else if (typeof p.productImage === 'string' && p.productImage.startsWith('[')) {
    try { images = JSON.parse(p.productImage); } catch {}
  } else if (typeof p.productImage === 'string' && p.productImage) {
    images = [p.productImage];
  }
  if (!images.length && bigImg) images = [bigImg];
  if (!images.length) images = ['/img/globalshopper.png'];

  // Default selected variant = first one
  const selectedVariant = variants[0] || null;
  // Use the product-level (MAX-variant) price for the initial display so a
  // customer who clicks "Buy Now" without picking a variant never sees a
  // price below what they'll actually be charged. The displayed number
  // updates to the chosen variant's real price as soon as they pick one.
  // priceUsd is product.sellPrice from the server, which now reflects the
  // most expensive variant — see server/index.js computeDisplayUsd notes.
  const selectedPriceUsd = priceUsd > 0
    ? priceUsd
    : (selectedVariant ? parseFloat(selectedVariant.price || selectedVariant.variantSellPrice || 0) : 0);

  app.innerHTML = `
    <div class="product-detail fade-in">
      <!-- Title: shown above the image on mobile and beside it on desktop
           (via CSS grid-template-areas). Moved out of .pd-info so a single
           grid layout can place it differently per breakpoint without
           duplicating markup or hurting SEO. The old breadcrumb above this
           block was removed — it duplicated the category nav available in
           the hamburger drawer and pushed the product image down on mobile. -->
      <h1 class="pd-title">${esc(name)}</h1>

      <!-- Gallery -->
      <div class="pd-gallery">
        <div class="pd-main-wrap">
          <img class="pd-main-img" id="pdMainImg" src="${imgProxy(images[0])}" alt="${esc(name)}"
               width="600" height="600"
               fetchpriority="high" decoding="async"
               onerror="this.onerror=null;this.src='/img/globalshopper.png'" />
        </div>
        <div class="pd-thumbs">
          ${images.slice(0, 8).map((src, i) => `
            <button class="pd-thumb ${i === 0 ? 'active' : ''}" data-src="${esc(imgProxy(src))}" aria-label="View ${esc(name)} image ${i + 1}">
              <img src="${imgProxy(src)}" alt="${esc(name)} image ${i + 1}" width="80" height="80"
                   loading="lazy" decoding="async"
                   onerror="this.style.visibility='hidden'" />
            </button>
          `).join('')}
        </div>
      </div>

      <!-- Info -->
      <div class="pd-info">
        ${sku ? `<div class="pd-sku">SKU: ${esc(sku)}</div>` : ''}

        <div class="pd-price-box">
          <div class="pd-price-row">
            <span class="pd-price" id="pdPrice">${fmtINR(selectedPriceUsd)}</span>
            ${(p.mrp && parseFloat(p.mrp) > selectedPriceUsd && p.discountPercent) ? `
              <span class="pd-price-mrp">${fmtINR(p.mrp)}</span>
              <span class="pd-price-save">${p.discountPercent}% off</span>
            ` : ''}
          </div>
          <div class="pd-price-hint">✅ Inclusive of taxes &amp; shipping to India</div>
        </div>

        ${variants.length > 1 ? renderVariantPicker(variants, selectedVariant) : ''}

        <div class="pd-qty-row">
          <label for="pdQty">Quantity</label>
          <div class="pd-qty">
            <button type="button" id="pdQtyMinus" aria-label="Decrease quantity">−</button>
            <input type="number" id="pdQty" value="1" min="1" max="999" aria-label="Quantity" />
            <button type="button" id="pdQtyPlus" aria-label="Increase quantity">+</button>
          </div>
          <div class="pd-stock" id="pdStock">Checking stock…</div>
        </div>

        <div class="pd-actions">
          <button class="btn btn-primary btn-lg" id="pdAddCart">Add to Cart</button>
          <button class="btn btn-dark btn-lg" id="pdBuyNow">Buy Now</button>
          <button type="button"
                  class="btn-wish-pd ${isInWishlist(pid) ? 'on' : ''}"
                  data-wish-pid="${esc(pid)}"
                  aria-label="${isInWishlist(pid) ? 'Remove from wishlist' : 'Save to wishlist'}"
                  aria-pressed="${isInWishlist(pid) ? 'true' : 'false'}"
                  onclick="window._pdWishToggle(this)">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/>
            </svg>
            <span class="btn-wish-pd-label">Wishlist</span>
          </button>
        </div>

        <div class="pd-meta">
          ${category ? `<div>📁 ${esc(category)}</div>` : ''}
          ${weight ? `<div>⚖️ ${esc(weight)} g</div>` : ''}
          <div>🚚 Ships to India · delivery in 10–15 days</div>
        </div>
      </div>
    </div>

    ${desc ? `
      <section class="section">
        <h2 class="section-title-plain">Product description</h2>
        <div class="pd-description">${desc}</div>
      </section>
    ` : ''}
  `;

  trackEcommerceEvent('view_item', {
    value: Math.round((selectedPriceUsd || 0) * (state.config.usdToInr || 85)),
    items: [analyticsItemFromProduct({
      ...p,
      pid,
      productNameEn: name,
      sellPrice: selectedPriceUsd,
      categoryName: category
    })]
  });

  // ── Wire up interactivity ──
  let current = {
    pid,
    name,
    image: images[0],
    vid: selectedVariant?.vid || '',
    variantName: selectedVariant?.variantNameEn || selectedVariant?.variantKey || '',
    priceUsd: selectedPriceUsd,
  };

  // Thumbnails
  document.querySelectorAll('.pd-thumb').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pd-thumb').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('pdMainImg').src = btn.getAttribute('data-src');
    });
  });

  // ── Variant selector (CJ-style Color / Size rows) ──
  const parsedVariants = parseVariantAttributes(variants);
  const currentSelection = parsedVariants
    ? (parsedVariants.splitParts[0] || []).slice()
    : [];

  // Apply a selection: find the matching variant and update the UI.
  async function applySelection(newSel) {
    if (!parsedVariants) return;
    // If the new combination doesn't match a real variant, pick a fallback:
    // the first variant whose first-attribute matches (e.g. same color).
    let variant = parsedVariants.variantByKey[newSel.join('|')];
    if (!variant) {
      const firstMatch = variants.find(v => {
        const parts = (v.variantKey || '').split('-').map(s => s.trim());
        return parts[0] === newSel[0];
      });
      if (firstMatch) {
        variant = firstMatch;
        const parts = (firstMatch.variantKey || '').split('-').map(s => s.trim());
        for (let i = 0; i < newSel.length; i++) newSel[i] = parts[i] || newSel[i];
      }
    }
    if (!variant) variant = variants[0];

    currentSelection.length = 0;
    currentSelection.push(...newSel);

    // Paint selected state across all buttons
    document.querySelectorAll('.pd-attr-row').forEach((row, idx) => {
      const val = currentSelection[idx];
      row.querySelectorAll('.pd-swatch, .pd-size-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-attr-value') === val);
      });
      const labelEl = row.querySelector('[data-current-value]');
      if (labelEl) labelEl.textContent = `(${val || ''})`;
    });

    // Update vid, main image, and show the variant's tentative price
    // immediately (using variants[0]'s shipping). Then fire an API call
    // to refine the price using THIS variant's actual shipping cost —
    // critical because heavier sizes (4XL etc.) have higher shipping,
    // and a customer who picks 4XL must see (and pay) the higher price
    // or we lose money on every heavy-variant sale at our 5% margin.
    current.vid = variant.vid || '';
    current.variantName = variant.variantNameEn || variant.variantKey || '';
    current.priceUsd = parseFloat(variant.price || variant.variantSellPrice || 0);
    if (variant.variantImage) {
      current.image = variant.variantImage;
      document.getElementById('pdMainImg').src = imgProxy(variant.variantImage);
    }
    const priceEl = document.getElementById('pdPrice');
    const hint = document.querySelector('.pd-price-hint');
    priceEl.textContent = fmtINR(current.priceUsd);
    checkVariantStock(current.vid);

    // Refine price with per-variant accurate shipping. Cache hit returns
    // in <100ms; cold-cache CJ call can take 1–3s, hence the spinner.
    if (hint) hint.textContent = 'Updating price for this variant…';
    try {
      const r = await apiGet(`/api/store/shipping-for-variant/${encodeURIComponent(current.vid)}?pid=${encodeURIComponent(pid)}`);
      if (r.available === false) {
        priceEl.textContent = 'Not available';
        if (hint) hint.textContent = "🚫 This variant can't be shipped to India.";
        document.getElementById('pdAddCart').disabled = true;
        document.getElementById('pdBuyNow').disabled = true;
        return;
      }
      if (r.displayUsd) {
        current.priceUsd = parseFloat(r.displayUsd);
        priceEl.textContent = fmtINR(current.priceUsd);
      }
      document.getElementById('pdAddCart').disabled = false;
      document.getElementById('pdBuyNow').disabled = false;
      if (hint) hint.textContent = '✅ Inclusive of taxes & shipping to India';
    } catch {
      // Network/timeout — leave the tentative price in place. Server
      // reprices accurately at checkout regardless.
      if (hint) hint.textContent = '✅ Inclusive of taxes & shipping to India';
      document.getElementById('pdAddCart').disabled = false;
      document.getElementById('pdBuyNow').disabled = false;
    }
  }

  // Wire up the color swatches + size buttons
  document.querySelectorAll('.pd-swatch, .pd-size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const attrIdx = parseInt(btn.getAttribute('data-attr-idx'));
      const val = btn.getAttribute('data-attr-value');
      const next = currentSelection.slice();
      next[attrIdx] = val;
      applySelection(next);
    });
  });

  // Qty
  const qtyInput = document.getElementById('pdQty');
  document.getElementById('pdQtyMinus').onclick = () => { qtyInput.value = Math.max(1, parseInt(qtyInput.value) - 1 || 1); };
  document.getElementById('pdQtyPlus').onclick = () => { qtyInput.value = parseInt(qtyInput.value) + 1 || 2; };

  function addCurrentProductToCart(showAddedToast = true) {
    if (!current.vid) return showToast('Please pick a variant');
    const qty = parseInt(qtyInput.value) || 1;
    if (!addToCart({
      pid: current.pid,
      vid: current.vid,
      quantity: qty,
      productName: current.name,
      variantName: current.variantName,
      image: current.image,
      priceUsd: current.priceUsd.toString(),
    })) return;
    if (showAddedToast) showToast(`Added ${qty} × ${current.name.slice(0, 30)} to cart`);
    return true;
  }

  // Add to cart
  document.getElementById('pdAddCart').onclick = () => {
    addCurrentProductToCart(true);
  };

  // Buy now
  document.getElementById('pdBuyNow').onclick = () => {
    if (addCurrentProductToCart(false)) navigate('/checkout');
  };

  // Initial stock check
  if (current.vid) checkVariantStock(current.vid);

  // ── Sticky bottom CTA bar (mobile only — CSS hides it on desktop) ──
  // Mirrors the desktop "Add to Cart" / "Buy Now" buttons but stays
  // pinned to the bottom of the viewport so customers don't have to
  // scroll back up. Updates price + state when variant changes.
  installMobileCtaBar({
    getPrice: () => current.priceUsd,
    getDisabled: () => !current.vid || document.getElementById('pdAddCart')?.disabled,
    priceLabel: 'incl. shipping',
    actions: [
      {
        label: 'Add to Cart',
        className: 'mobile-cta-btn-cart',
        onClick: () => addCurrentProductToCart(true),
      },
      {
        label: 'Buy Now',
        className: 'mobile-cta-btn-buy',
        onClick: () => {
          if (addCurrentProductToCart(false)) navigate('/checkout');
        },
      },
    ],
  });
}

/**
 * Inject (or refresh) the sticky bottom CTA bar. CSS controls visibility:
 * only shows on mobile via body.page-product / body.page-cart selectors.
 */
function installMobileCtaBar({ getPrice, getDisabled, onClick, label, priceLabel, actions }) {
  document.getElementById('mobileCtaBar')?.remove();
  const bar = document.createElement('div');
  bar.className = 'mobile-cta-bar';
  bar.id = 'mobileCtaBar';
  const actionList = (Array.isArray(actions) && actions.length)
    ? actions
    : [{ label: label || 'Continue', onClick }];
  bar.innerHTML = `
    <div class="mobile-cta-price">
      <span>${esc(priceLabel || '')}</span>
      <strong data-mcta-price>${fmtINR(getPrice())}</strong>
    </div>
    <div class="mobile-cta-actions ${actionList.length === 1 ? 'single' : ''}">
      ${actionList.map((action, idx) => `
        <button class="mobile-cta-btn ${esc(action.className || '')}" data-mcta-action="${idx}">
          ${esc(action.label || 'Continue')}
        </button>
      `).join('')}
    </div>
  `;
  document.body.appendChild(bar);
  const buttons = [...bar.querySelectorAll('[data-mcta-action]')];
  const syncButtons = () => {
    const globallyDisabled = !!(getDisabled && getDisabled());
    buttons.forEach((btn, idx) => {
      const action = actionList[idx] || {};
      btn.disabled = globallyDisabled || !!(action.getDisabled && action.getDisabled());
    });
  };
  buttons.forEach((btn, idx) => {
    const action = actionList[idx] || {};
    btn.onclick = action.onClick || onClick;
  });
  syncButtons();
  // Refresh the price/disabled state every 250ms — cheap, and tracks
  // variant changes without us having to plumb events everywhere.
  if (window._mctaTimer) clearInterval(window._mctaTimer);
  window._mctaTimer = setInterval(() => {
    if (!document.getElementById('mobileCtaBar')) {
      clearInterval(window._mctaTimer);
      window._mctaTimer = null;
      return;
    }
    const priceEl = bar.querySelector('[data-mcta-price]');
    if (priceEl) priceEl.textContent = fmtINR(getPrice());
    syncButtons();
  }, 250);
}
window.installMobileCtaBar = installMobileCtaBar;

// ══════════════════════════════════════════════════════════════
//  VARIANT PARSING + PICKER (CJ-style Color / Size rows)
// ══════════════════════════════════════════════════════════════

/**
 * Parse a list of variants into a structured attribute map.
 * CJ variants have keys like "Gray-M", "Red-XL", "Blue-S".
 *
 * Returns:
 *   {
 *     attrNames:  ["Color", "Size"],
 *     attrValues: [["Gray", "White"], ["M", "L", "XL", "XXL"]],
 *     variantByKey: { "Gray|M": {...variant}, "White|L": {...variant}, ... },
 *     imageByColor: { "Gray": "https://...jpg", "White": "https://...jpg" },
 *   }
 */
function parseVariantAttributes(variants) {
  // Split each variantKey by '-' into parts. Assume positions are consistent
  // across variants (CJ guarantees this).
  const splitParts = variants.map(v => {
    const key = (v.variantKey || v.variantNameEn || '').trim();
    return key.split('-').map(s => s.trim()).filter(Boolean);
  });
  if (!splitParts.length) return null;
  const numAttrs = Math.max(...splitParts.map(p => p.length));
  if (numAttrs < 1) return null;

  // Attribute names — labels for the picker rows.
  // 1 attr is usually Size OR Color; 2 is Color + Size; 3+ we fall back
  // to generic labels. The first attribute is usually Color (has an image).
  let attrNames;
  if (numAttrs === 1) attrNames = ['Option'];
  else if (numAttrs === 2) attrNames = ['Color', 'Size'];
  else attrNames = Array.from({ length: numAttrs }, (_, i) => `Option ${i + 1}`);

  // Unique values at each position (preserving first-seen order)
  const attrValues = attrNames.map(() => []);
  splitParts.forEach(parts => {
    parts.forEach((val, i) => {
      if (i < attrNames.length && !attrValues[i].includes(val)) {
        attrValues[i].push(val);
      }
    });
  });

  // Index variants by their joined key ("Gray|M")
  const variantByKey = {};
  variants.forEach((v, i) => {
    const parts = splitParts[i];
    if (parts.length === numAttrs) {
      variantByKey[parts.join('|')] = v;
    }
  });

  // Pick one image per first-attribute value (usually color). Prefer the
  // variant's own image; fall back to the product image.
  const imageByFirst = {};
  variants.forEach((v, i) => {
    const first = splitParts[i][0];
    if (first && !imageByFirst[first] && v.variantImage) {
      imageByFirst[first] = v.variantImage;
    }
  });

  return { attrNames, attrValues, variantByKey, imageByFirst, splitParts, numAttrs };
}

/**
 * Render a CJ-style variant picker. Returns an HTML string with rows
 * for each attribute. If parsing fails, returns an empty string (the
 * page will fall back to the default variant without a picker).
 */
function renderVariantPicker(variants, selectedVariant) {
  const parsed = parseVariantAttributes(variants);
  if (!parsed) return '';
  const { attrNames, attrValues, imageByFirst, numAttrs } = parsed;

  // Figure out which values are selected initially — the first variant is
  // the default, so split its key.
  const sel = (selectedVariant?.variantKey || '').split('-').map(s => s.trim());

  const rows = attrNames.map((name, attrIdx) => {
    const values = attrValues[attrIdx];
    const currentVal = sel[attrIdx] || values[0];
    const useSwatch = attrIdx === 0 && numAttrs >= 2 && Object.keys(imageByFirst).length > 1;

    const valuesHtml = values.map(val => {
      const active = val === currentVal ? 'active' : '';
      if (useSwatch) {
        const img = imageByFirst[val] || '';
        return `
          <button class="pd-swatch ${active}" data-attr-idx="${attrIdx}" data-attr-value="${esc(val)}" title="${esc(val)}" aria-label="Select ${esc(val)}">
            <img src="${esc(imgProxy(img))}" alt="${esc(val)}" width="48" height="48" loading="lazy" decoding="async" onerror="this.style.display='none'"/>
            <span class="pd-swatch-check">✓</span>
          </button>
        `;
      }
      return `
        <button class="pd-size-btn ${active}" data-attr-idx="${attrIdx}" data-attr-value="${esc(val)}" aria-label="Select ${esc(val)}">
          ${esc(val)}
        </button>
      `;
    }).join('');

    return `
      <div class="pd-attr-row" data-attr-idx="${attrIdx}">
        <div class="pd-attr-label">
          <span class="pd-attr-name">${esc(name)}</span>
          <span class="pd-attr-value" data-current-value>(${esc(currentVal || '')})</span>
        </div>
        <div class="pd-attr-choices ${useSwatch ? 'pd-swatches' : 'pd-sizes'}">
          ${valuesHtml}
        </div>
      </div>
    `;
  }).join('');

  // Hidden element to stash the parsed data so the click handler can use it
  return `
    <div class="pd-variants" data-variants-json="${esc(JSON.stringify({ attrNames, attrValues, numAttrs }))}">
      ${rows}
    </div>
  `;
}

async function checkVariantStock(vid) {
  const el = document.getElementById('pdStock');
  if (!el) return;
  el.className = 'pd-stock loading';
  el.textContent = 'Checking stock…';
  try {
    const r = await apiGet(`/api/store/stock/${encodeURIComponent(vid)}`);
    const n = r.total || 0;
    if (n > 100) { el.className = 'pd-stock in'; el.textContent = `✅ In stock (${n.toLocaleString('en-IN')} units)`; }
    else if (n > 0) { el.className = 'pd-stock low'; el.textContent = `⚠️ Only ${n} left`; }
    else { el.className = 'pd-stock out'; el.textContent = '❌ Out of stock'; }
  } catch {
    el.className = 'pd-stock'; el.textContent = '';
  }
}

// ══════════════════════════════════════════════════════════════
//  CART, CHECKOUT, ORDER, TRACK, ADMIN, FAQ
//  (in app-store.js)
// ══════════════════════════════════════════════════════════════

// Boot sequence is moved to the very end of app-store.js so that all
// functions from BOTH scripts (loadCurrentUser, renderLogin, etc.) are
// defined before boot() tries to call them. Order matters: app.js loads
// first, app-store.js loads second, then boot runs.
