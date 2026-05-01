/**
 * Befach Store — Frontend v8.0
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
  brandName: 'GCOM',
  brandTagline: 'One World. Endless Choices.',
  // Legal entity — kept on every receipt, footer, and compliance page
  // because that's the registered company that runs the store. Don't
  // rebrand this without filing a new GSTIN/IEC.
  legalName: 'BEFACH 4X PRIVATE LIMITED',
  email: 'sales@befach.com',
  phone: '+91 70570 53160',
  website: 'https://www.befach.com',
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

// ── Mobile drawer ──
const hamburgerBtn = document.getElementById('headerHamburger');
const drawerEl = document.getElementById('drawer');
const drawerBackdrop = document.getElementById('drawerBackdrop');
const drawerClose = document.getElementById('drawerClose');

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
      <a href="#/" class="drawer-link">Home</a>
      <button type="button" class="drawer-link drawer-toggle" id="drawerCatToggle">
        <span>Shop by category</span>
        <span class="drawer-chev">›</span>
      </button>
      <div class="drawer-cats" id="drawerCats" hidden>
        <span class="drawer-cats-loading muted">Loading…</span>
      </div>
      <a href="#/cart" class="drawer-link">Cart</a>
      <a href="#/wishlist" class="drawer-link">Wishlist</a>
      <a href="#/track" class="drawer-link">Track order</a>
    </div>

    ${u ? `
      <div class="drawer-section">
        <div class="drawer-section-label">My account</div>
        <a href="#/account" class="drawer-link">My profile</a>
        <a href="#/orders" class="drawer-link">My orders</a>
        <a href="#/returns" class="drawer-link">Returns &amp; refunds</a>
        <button type="button" class="drawer-link drawer-link-signout" id="drawerSignOut">Sign out</button>
      </div>
    ` : `
      <div class="drawer-section">
        <div class="drawer-section-label">Account</div>
        <a href="#/login" class="drawer-link">Sign in</a>
        <a href="#/register" class="drawer-link drawer-link-cta">Create account</a>
      </div>
    `}

    <div class="drawer-section">
      <div class="drawer-section-label">Support</div>
      <a href="#/faq" class="drawer-link">Help &amp; FAQ</a>
      <a href="#/legal" class="drawer-link">Legal &amp; compliance</a>
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
// GCOM is the customer brand; the legal entity (BEFACH 4X PRIVATE
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
    <p class="footer-line"><a href="#/legal">Legal &amp; Compliance →</a></p>
  `;
})();

// ── State ──
const state = {
  config: { storeName: 'GCOM', currency: 'INR', usdToInr: 85, shipTo: 'IN', shipFrom: 'CN' },
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

// ── Image URL handling ──
// CJ's CDN (cf.cjdropshipping.com) has no hotlink protection, so we use
// direct URLs — one fewer backend round-trip per card image. Fall back
// to the proxy only for domains that need it (Alibaba/Aliexpress).
function imgProxy(url) {
  if (!url) return '/img/befach_logo.png';
  if (url.startsWith('/')) return url;
  if (/cjdropshipping\.(com|net)/i.test(url)) return url;  // direct
  try { return '/api/img?url=' + encodeURIComponent(url); }
  catch { return '/img/befach_logo.png'; }
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
  if (!res.ok) throw new Error(data.error || data.detail || `API ${res.status}`);
  return data;
}

// ══════════════════════════════════════════════════════════════
//  CART (localStorage + server sync for signed-in users)
//  Local optimistic update + fire-and-forget push to server keeps
//  the UI snappy. On login we merge guest localStorage cart with
//  the server cart so nothing the user added before signing in
//  gets lost.
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
// server cart and merges with whatever the user had locally — keeps
// items added as a guest, takes max quantity on overlaps.
async function syncCartFromServer() {
  if (!state.user) return;
  try {
    const res = await fetch('/api/auth/cart', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    const serverCart = Array.isArray(data.cart) ? data.cart : [];
    const merged = [...state.cart];
    for (const s of serverCart) {
      const existing = merged.find(i => i.pid === s.pid && i.vid === s.vid);
      if (!existing) merged.push(s);
      else existing.quantity = Math.max(existing.quantity, s.quantity);
    }
    state.cart = merged;
    try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch {}
    updateCartBadge();
    // Push merged result back so any new local items reach the server
    pushCartToServer();
  } catch {}
}
window.syncCartFromServer = syncCartFromServer;
function updateCartBadge() {
  const n = state.cart.reduce((s, i) => s + (i.quantity || 0), 0);
  if (cartCountEl) cartCountEl.textContent = n;
}
function addToCart(item) {
  // item: { pid, vid, quantity, productName, variantName, image, priceUsd }
  const existing = state.cart.find(i => i.pid === item.pid && i.vid === item.vid);
  if (existing) {
    existing.quantity += item.quantity;
  } else {
    state.cart.push({ ...item });
  }
  saveCart();
}
function updateCartQuantity(pid, vid, qty) {
  const item = state.cart.find(i => i.pid === pid && i.vid === vid);
  if (!item) return;
  item.quantity = Math.max(1, parseInt(qty) || 1);
  saveCart();
}
function removeFromCart(pid, vid) {
  state.cart = state.cart.filter(i => !(i.pid === pid && i.vid === vid));
  saveCart();
}
function clearCart() {
  state.cart = [];
  saveCart();
}
function cartSubtotalUsd() {
  return state.cart.reduce((s, i) => s + (parseFloat(i.priceUsd) * i.quantity), 0);
}
updateCartBadge();

// ══════════════════════════════════════════════════════════════
//  WISHLIST (localStorage + server sync for signed-in users)
//  Stores product IDs only — product details are fetched on demand
//  when the user opens the wishlist page.
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
    // Union — keep everything the user had locally + everything on server
    const merged = Array.from(new Set([...state.wishlist, ...serverList]));
    state.wishlist = merged;
    try { localStorage.setItem(WISHLIST_KEY, JSON.stringify(state.wishlist)); } catch {}
    pushWishlistToServer();
    refreshWishlistButtons();
  } catch {}
}
window.syncWishlistFromServer = syncWishlistFromServer;
function isInWishlist(pid) { return Array.isArray(state.wishlist) && state.wishlist.includes(pid); }
function toggleWishlist(pid) {
  if (!pid) return false;
  if (!Array.isArray(state.wishlist)) state.wishlist = [];
  const idx = state.wishlist.indexOf(pid);
  let added;
  if (idx === -1) { state.wishlist.push(pid); added = true; }
  else            { state.wishlist.splice(idx, 1); added = false; }
  saveWishlist();
  refreshWishlistButtons();
  return added;
}
// Re-paint every wishlist heart icon on the page after a toggle so all
// instances of the same product (e.g. shown in two sections of the
// home page) update together.
function refreshWishlistButtons() {
  document.querySelectorAll('[data-wish-pid]').forEach(btn => {
    const pid = btn.getAttribute('data-wish-pid');
    btn.classList.toggle('on', isInWishlist(pid));
    btn.setAttribute('aria-pressed', isInWishlist(pid) ? 'true' : 'false');
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
function getRoute() {
  const hash = location.hash || '#/';
  const [path, queryStr] = hash.slice(1).split('?');
  const params = new URLSearchParams(queryStr || '');
  return { path, params };
}
window.navigate = function(hash) { location.hash = hash; };

function handleRoute() {
  const { path, params } = getRoute();
  state.currentPage = path;

  if (typeof cancelBackfill === 'function') cancelBackfill();

  document.querySelectorAll('.nav-link').forEach(el => {
    el.classList.toggle('active', el.getAttribute('href') === '#' + path);
  });

  // Tag the body with the current page slug so CSS can target page-specific
  // mobile UI (e.g. sticky bottom CTA bar on product / cart pages).
  const slug = path === '/' || path === ''
    ? 'home'
    : path.split('/')[1] || 'home';
  document.body.className = document.body.className
    .split(' ')
    .filter(c => !c.startsWith('page-'))
    .concat('page-' + slug)
    .join(' ');

  // Remove any sticky mobile CTA bar from the previous page; the page
  // renderer (product, cart) will inject a fresh one if it needs one.
  document.getElementById('mobileCtaBar')?.remove();

  window.scrollTo(0, 0);

  if (path === '/' || path === '') return renderHome();
  if (path === '/category') return renderAllCategories();
  if (path.startsWith('/category/')) return renderCategory(path.slice('/category/'.length), parseInt(params.get('page')) || 1, params);
  if (path.startsWith('/search')) {
    return renderSearch(
      params.get('q') || '',
      parseInt(params.get('page')) || 1,
      {
        categoryId: params.get('categoryId') || '',
        categoryName: params.get('catName') || '',
      }
    );
  }
  if (path.startsWith('/product/')) return renderProduct(path.slice('/product/'.length));
  if (path === '/cart') return renderCart();
  if (path === '/checkout') return renderCheckout();
  if (path.startsWith('/order/')) return renderOrderDetail(path.slice('/order/'.length));
  if (path === '/track') return renderTrack();
  if (path === '/admin') return renderAdmin();
  if (path === '/faq') return renderFaq();
  if (path === '/legal') return renderLegal();
  if (path === '/login') return renderLogin();
  if (path === '/register') return renderRegister();
  if (path === '/account') return renderAccount();
  if (path === '/orders') return renderOrders();
  if (path === '/wishlist') return renderWishlist();
  if (path === '/returns') return renderReturns();
  return renderHome();
}

window.addEventListener('hashchange', handleRoute);
window.addEventListener('load', handleRoute);

// Header search submit
headerSearchForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = headerSearchInput.value.trim();
  if (q.length < 2) return showToast('Type at least 2 characters');
  navigate(`/search?q=${encodeURIComponent(q)}`);
});

// ══════════════════════════════════════════════════════════════
//  CATEGORIES (header strip + dropdown)
// ══════════════════════════════════════════════════════════════
// Top-level CJ categories get a real product photo. Match by ALL keywords
// being present (case-insensitive substring) — first rule wins, so list
// the more-specific rules above the catch-alls.
const CAT_IMAGE_RULES = [
  [['home', 'improvement'],     '/img/cat-home-improvement.png'],
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
function catImage(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const [keywords, src] of CAT_IMAGE_RULES) {
    if (keywords.every(k => lower.includes(k))) return src;
  }
  return null;
}
const CAT_ICONS = {
  Computer: '💻', Phone: '📱', Electronic: '🔌', Home: '🏠', Garden: '🌿',
  Toy: '🧸', Sport: '⚽', Beauty: '💄', Health: '💊', Cloth: '👕',
  Women: '👗', Men: '👔', Jewel: '💍', Watch: '⌚', Bag: '👜', Shoe: '👟',
  Baby: '👶', Pet: '🐾', Car: '🚗', Tool: '🔧', Light: '💡', Kitchen: '🍳',
  Furniture: '🪑', Office: '🖨️', Outdoor: '⛺', Food: '🍕', Game: '🎮',
  Book: '📚', Bed: '🛏️', Bath: '🛁', Travel: '🧳',
};
function catIcon(name) {
  const img = catImage(name);
  if (img) return `<img src="${img}" alt="" class="cat-img" loading="lazy"/>`;
  if (!name) return '📦';
  for (const [k, v] of Object.entries(CAT_ICONS)) {
    if (name.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return '📦';
}

// Build a hash link for a CJ category at any nesting level. Uses CJ's
// real categoryId so list pages get the exact products in that category
// (a keyword search on the name returns wrong/no results — e.g. "Smart
// glasses" or "Woman Prescription Glasses" match almost nothing as a
// keyword, but their categoryId returns the actual catalog).
function categoryHref(item) {
  if (!item) return '#/';
  const name = (item.categoryName || item.categorySecondName || item.categoryFirstName || '').trim();
  const id = item.categoryId || item.categorySecondId || item.categoryFirstId || '';
  if (id) return `#/category/${encodeURIComponent(id)}?name=${encodeURIComponent(name)}`;
  return `#/search?q=${encodeURIComponent(name)}`;
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
    return `
      <button type="button"
              class="mega-cat-item ${idx === 0 ? 'active' : ''}"
              data-idx="${idx}"
              onclick="location.hash='${href.slice(1)}'"
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

// ══════════════════════════════════════════════════════════════
//  PRODUCT CARD
// ══════════════════════════════════════════════════════════════
function productCard(p, idx) {
  const pid = p.pid || p.id || p.productId || '';
  const name = p.productNameEn || p.nameEn || p.productName || 'Untitled';
  const image = parseProductImage(p);
  const listed = p.listedNum || p.listedShopNum || 0;
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
       href="#/product/${encodeURIComponent(pid)}"
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
          onerror="this.onerror=null;this.src='/img/befach_logo.png'" />
        ${listed > 50 ? '<span class="product-card-badge">🔥 Popular</span>' : ''}
        ${showOffer ? `<span class="product-card-discount">${discountPct}% OFF</span>` : ''}
        <button type="button"
                class="product-card-wish ${inWishlist ? 'on' : ''}"
                data-wish-pid="${esc(pid)}"
                aria-label="Add to wishlist"
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
          <span class="product-price-now" data-card-price>${fmtINR(displayUsd)}</span>
          ${showOffer ? `<span class="product-price-mrp" data-card-mrp>${fmtINR(mrpUsd)}</span>` : ''}
          ${showOffer ? `<span class="product-price-save">${discountPct}% off</span>` : ''}
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
  const added = toggleWishlist(pid);
  showToast(added ? '♥ Added to wishlist' : 'Removed from wishlist');
};
// Same handler for the wishlist button on the product detail page —
// just doesn't need preventDefault since the button isn't inside a
// link there. Updates the label so the user gets clear feedback.
window._pdWishToggle = function(btn) {
  const pid = btn?.getAttribute('data-wish-pid');
  if (!pid) return;
  const added = toggleWishlist(pid);
  const label = btn.querySelector('.btn-wish-pd-label');
  if (label) label.textContent = added ? 'Saved' : 'Wishlist';
  showToast(added ? '♥ Added to wishlist' : 'Removed from wishlist');
};

/**
 * Backfill real shipping for any cards with approximate prices.
 *
 * Concurrency = 4 because user-clicks use the server's HIGH priority
 * queue and jump ahead of these LOW priority backfills. Aborts on
 * route change so abandoned pages don't keep CJ calls in flight.
 *
 * Successful backfills are stored in localStorage so the next visit
 * is instant — no server roundtrip, no skeleton.
 */
let currentBackfillAbort = null;
function cancelBackfill() {
  if (currentBackfillAbort) {
    try { currentBackfillAbort.abort(); } catch {}
    currentBackfillAbort = null;
  }
}

async function backfillCardShipping(gridEl) {
  if (!gridEl) return;
  cancelBackfill();
  const abort = new AbortController();
  currentBackfillAbort = abort;

  const pending = Array.from(gridEl.querySelectorAll('.product-card[data-accurate="0"]'));
  if (!pending.length) return;

  const CONCURRENCY = 4;
  const queue = pending.slice();

  async function worker() {
    while (queue.length) {
      if (abort.signal.aborted) return;
      const card = queue.shift();
      const pid = card.getAttribute('data-pid');
      if (!pid) continue;
      try {
        const res = await fetch(`/api/store/shipping-for/${encodeURIComponent(pid)}`, {
          signal: abort.signal,
        });
        if (!res.ok) continue;
        const data = await res.json();
        if (abort.signal.aborted || !card.isConnected) continue;

        if (data.available === false) {
          // Unshippable to India — drop the card from the grid so the
          // user never clicks through to the "Not available in your
          // region" page. The server's product list endpoint already
          // skips known-unshippable items, but on a cold cache the
          // first request lets them through; this catches them.
          card.remove();
          continue;
        }

        if (data.displayUsd) {
          // Persist for instant load on next visit
          setCachedDisplayUsd(pid, data.displayUsd);
          const priceEl = card.querySelector('[data-card-price]');
          if (priceEl) priceEl.textContent = fmtINR(data.displayUsd);
          // MRP scales with the refined price — server returns the new
          // strike-through value so the discount % stays consistent
          // after backfill.
          const mrpEl = card.querySelector('[data-card-mrp]');
          if (mrpEl && data.mrp) mrpEl.textContent = fmtINR(data.mrp);
        }
        card.setAttribute('data-accurate', '1');
      } catch (e) {
        if (e.name === 'AbortError') return;
        // Swallow — card keeps its skeleton; user can refresh.
      }
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
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
        <!-- HERO (compact) — premium global imports, doorstep delivery -->
        <section class="home-hero home-hero-compact">
          <div class="home-hero-inner">
            <div class="home-hero-copy">
              <span class="home-hero-eyebrow">Curated from across the globe</span>
              <h1 class="home-hero-title">The world's makers. <span class="accent">Your doorstep.</span></h1>
              <p class="home-hero-sub">Premium products, hand-picked from artisans and ateliers in 200+ countries — delivered to India in 10–15 days.</p>
              <form class="home-hero-search" id="heroSearchForm">
                <input type="text" id="heroSearchInput" placeholder="Search dresses, watches, lighting, fragrances..." autocomplete="off" />
                <button type="submit" aria-label="Search">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>
                  <span>Search</span>
                </button>
              </form>
              <div class="home-hero-stats">
                <div><strong>200+</strong><span>Countries</span></div>
                <div><strong>10–15</strong><span>Days to your door</span></div>
                <div><strong>Premium</strong><span>Quality, every order</span></div>
              </div>
            </div>
            <div class="home-hero-art" aria-hidden="true">
              <div class="home-hero-globe">🌍</div>
              <span class="home-hero-orbit home-hero-orbit-1">📦</span>
              <span class="home-hero-orbit home-hero-orbit-2">✈️</span>
              <span class="home-hero-orbit home-hero-orbit-3">🛍️</span>
              <span class="home-hero-orbit home-hero-orbit-4">✨</span>
            </div>
          </div>
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

        <!-- PROMO BANNERS -->
        <section class="promo-blocks">
          <a href="#/search?q=women dress" class="promo-big">
            <div class="promo-big-bg" style="background-image:url('/img/cat-women-clothing.png')"></div>
            <div class="promo-big-copy">
              <span class="promo-eyebrow">SUMMER COLLECTION</span>
              <h2>Women's Fashion</h2>
              <p>Up to 65% OFF on premium picks</p>
              <span class="promo-cta">Shop Women →</span>
            </div>
          </a>
          <div class="promo-stack">
            <a href="#/search?q=smart watch" class="promo-small promo-tech">
              <div class="promo-small-bg" style="background-image:url('/img/cat-electronics.png')"></div>
              <div class="promo-small-copy">
                <span class="promo-eyebrow">TECH DEALS</span>
                <h3>Smart Gadgets</h3>
                <p>Affordable. Smart.</p>
                <span class="promo-cta">Shop →</span>
              </div>
            </a>
            <a href="#/search?q=men shirt" class="promo-small promo-men">
              <div class="promo-small-bg" style="background-image:url('/img/cat-men-clothing.png')"></div>
              <div class="promo-small-copy">
                <span class="promo-eyebrow">MEN'S FASHION</span>
                <h3>Up to 40% Off</h3>
                <p>Premium styles</p>
                <span class="promo-cta">Shop →</span>
              </div>
            </a>
          </div>
        </section>

        <!-- FEATURED PRODUCTS -->
        <section class="section">
          <div class="section-head">
            <h2 class="section-title">Featured Products</h2>
            <a href="#/search?q=trending" class="section-link" id="featuredMore">View all →</a>
          </div>
          <div class="products-grid" id="featuredGrid">${productSkeleton(10)}</div>
        </section>

        <!-- MEN'S FASHION -->
        <section class="fashion-section">
          <div class="fashion-banner fashion-banner-men">
            <div class="fashion-banner-bg" style="background-image:url('/img/cat-men-clothing.png')"></div>
            <div class="fashion-banner-copy">
              <span class="fashion-eyebrow">MEN'S COLLECTION</span>
              <h2>Men's Fashion</h2>
              <p>Premium styles, sourced globally</p>
              <a class="fashion-cta" href="#/search?q=men shirt">Shop Now →</a>
            </div>
          </div>
          <div class="products-grid fashion-grid" id="menGrid">${productSkeleton(8)}</div>
        </section>

        <!-- TRENDING TECH & GADGETS -->
        <section class="section">
          <div class="section-head">
            <h2 class="section-title">🔥 Trending Tech &amp; Gadgets</h2>
            <a href="#/search?q=earbuds" class="section-link" id="trendingMore">View all →</a>
          </div>
          <div class="products-grid" id="trendingGrid">${productSkeleton(10)}</div>
        </section>

        <!-- WOMEN'S FASHION -->
        <section class="fashion-section">
          <div class="fashion-banner fashion-banner-women">
            <div class="fashion-banner-bg" style="background-image:url('/img/cat-women-clothing.png')"></div>
            <div class="fashion-banner-copy">
              <span class="fashion-eyebrow">WOMEN'S COLLECTION</span>
              <h2>Women's Fashion</h2>
              <p>Hand-picked from worldwide suppliers</p>
              <a class="fashion-cta" href="#/search?q=women dress">Shop Now →</a>
            </div>
          </div>
          <div class="products-grid fashion-grid" id="womenGrid">${productSkeleton(8)}</div>
        </section>

        <!-- SMART GADGETS -->
        <section class="section">
          <div class="section-head">
            <h2 class="section-title">⚡ Smart Gadgets</h2>
            <a href="#/search?q=smart" class="section-link" id="smartMore">View all →</a>
          </div>
          <div class="products-grid" id="smartGrid">${productSkeleton(10)}</div>
        </section>

        <!-- HOME & LIFESTYLE -->
        <section class="section">
          <div class="section-head">
            <h2 class="section-title">🏠 Home &amp; Lifestyle</h2>
            <a href="#/search?q=led light" class="section-link" id="homeLifestyleMore">View all →</a>
          </div>
          <div class="products-grid" id="homeLifestyleGrid">${productSkeleton(10)}</div>
        </section>
      </div>

      <!-- Sidebar hover-flyout panel (positioned absolute over main area) -->
      <div class="sidebar-flyout" id="sidebarFlyout" hidden></div>
    </div>
  `;

  const heroInput = document.getElementById('heroSearchInput');
  document.getElementById('heroSearchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = heroInput.value.trim();
    if (q.length < 2) return showToast('Type at least 2 characters');
    navigate(`/search?q=${encodeURIComponent(q)}`);
  });

  loadCategories().then(() => renderHomeSidebar());
  loadHomeProducts();
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
    men:           document.getElementById('menGrid'),
    women:         document.getElementById('womenGrid'),
    trending:      document.getElementById('trendingGrid'),
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
  const trendingPool = [
    'earbuds', 'wireless headphones', 'smart watch', 'bluetooth speaker',
    'power bank', 'phone holder', 'gaming mouse', 'mini projector',
    'action camera', 'mechanical keyboard', 'smart glasses', 'drone',
    'vr headset', 'air purifier',
  ];
  const smartPool = [
    'smart bulb', 'smart plug', 'smart light', 'smart band',
    'smart sensor', 'smart camera', 'smart watch', 'smart scale',
    'smart fan', 'smart lock', 'smart key finder', 'smart speaker',
  ];
  const homePool = [
    'led light', 'kitchen tools', 'wall art', 'desk lamp', 'storage organizer',
    'cushion cover', 'blanket', 'bathroom mat', 'plant pot', 'humidifier',
    'aroma diffuser', 'room decor', 'coffee mug', 'cookware',
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

  // Pick a child of the top-level women/men category so each daily load
  // surfaces a different slice (Dresses one day, Tops the next, etc.)
  // rather than always landing on whatever CJ orders first.
  const childPick = (cat) => {
    const subs = cat?.categoryFirstList || [];
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
    { grid: grids.featured,      kind: 'kw',  keywords: candidates(featuredPool), size: 10, moreId: 'featuredMore',      label: 'featured products' },
    { grid: grids.men,           kind: 'cat', cat: menChild   || menCat,          size: 8,  moreId: null,                label: "men's fashion" },
    { grid: grids.trending,      kind: 'kw',  keywords: candidates(trendingPool), size: 10, moreId: 'trendingMore',      label: 'tech & gadgets' },
    { grid: grids.women,         kind: 'cat', cat: womenChild || womenCat,        size: 8,  moreId: null,                label: "women's fashion" },
    { grid: grids.smart,         kind: 'kw',  keywords: candidates(smartPool),    size: 10, moreId: 'smartMore',         label: 'smart gadgets' },
    { grid: grids.homeLifestyle, kind: 'kw',  keywords: candidates(homePool),     size: 10, moreId: 'homeLifestyleMore', label: 'home & lifestyle' },
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
          if (link) link.href = `#/search?q=${encodeURIComponent(chosenKeyword)}`;
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
    <div class="breadcrumb"><a href="#/">Home</a> <span>›</span> <span class="current">All Categories</span></div>
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
      </a>
      <div class="cat-block-groups">
        ${subs.map(s => {
          const subName = s.categorySecondName || '';
          const thirds = s.categorySecondList || [];
          const subHref = categoryHref(s);
          return `<div class="cat-block-group">
            <a class="cat-block-group-head" href="${subHref}">${esc(subName)}</a>
            ${thirds.length ? `<div class="cat-block-group-items">
              ${thirds.map(t => `<a href="${categoryHref(t)}">${esc(t.categoryName || '')}</a>`).join('')}
            </div>` : ''}
          </div>`;
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
  const children = findCategoryChildren(categoryId);
  return renderSearch('', page, { categoryId, categoryName: name, categoryChildren: children });
}

// Find the immediate children of a given category id at any nesting level.
// Lets the category page surface chips for "Tops / Dresses / Accessories"
// when the user clicks a broad parent like "Women's Clothing", instead of
// being stuck on whatever CJ returns first for the parent id.
function findCategoryChildren(id) {
  for (const cat of state.categories || []) {
    if (cat.categoryFirstId === id) return cat.categoryFirstList || [];
    for (const sec of cat.categoryFirstList || []) {
      if (sec.categorySecondId === id) return sec.categorySecondList || [];
    }
  }
  return [];
}

// ══════════════════════════════════════════════════════════════
//  SEARCH / CATEGORY RESULTS
// ══════════════════════════════════════════════════════════════
async function renderSearch(query, page = 1, opts = {}) {
  // If the user typed a query, keep it visible in the search box even when a
  // category scope is also applied. Pure category browse (no query) clears
  // the input so the user isn't fooled into thinking they typed the name.
  if (headerSearchInput) headerSearchInput.value = (opts.categoryName && !query) ? '' : query;
  let title;
  if (query && opts.categoryName) {
    title = `Results for "${esc(query)}" in ${esc(opts.categoryName)}`;
  } else if (opts.categoryName) {
    title = esc(opts.categoryName);
  } else if (query) {
    title = `Results for "${esc(query)}"`;
  } else {
    title = 'Browse products';
  }
  const childChips = (opts.categoryChildren || []).length ? `
    <nav class="subcategory-strip" aria-label="Subcategories">
      ${opts.categoryChildren.map(c => {
        const cname = c.categoryName || c.categorySecondName || c.categoryFirstName || '';
        return `<a class="subcat-chip" href="${categoryHref(c)}">${esc(cname)}</a>`;
      }).join('')}
    </nav>
  ` : '';

  app.innerHTML = `
    <div class="breadcrumb">
      <a href="#/">Home</a> <span>›</span>
      <span class="current">${title}</span>
    </div>
    <div class="search-header">
      <div>
        <h1 class="page-title">${title}</h1>
        <div class="muted" id="searchCount">Loading...</div>
      </div>
    </div>
    ${childChips}
    <div class="products-grid" id="searchGrid">${productSkeleton(12)}</div>
    <div class="pagination" id="pagination"></div>
  `;

  try {
    // Always show every product CJ returns (minus the admin blocklist). The
    // server fills in real India shipping where it's been quoted, and the
    // fallback estimate everywhere else. Backfill refines prices in the
    // background as warming completes.
    const qs = new URLSearchParams({ page: String(page), size: '20' });
    if (query) qs.set('keyWord', query);
    if (opts.categoryId) qs.set('categoryId', opts.categoryId);
    const res = await apiGet('/api/store/products?' + qs.toString());

    const products = res.products || [];
    const total = res.total || 0;
    const totalPages = res.totalPages || 1;

    document.getElementById('searchCount').textContent = `${total.toLocaleString('en-IN')} products`;
    const grid = document.getElementById('searchGrid');
    if (!products.length) {
      grid.innerHTML = `<div class="empty-state">
        <div class="empty-icon">🔍</div>
        <h3>No products found</h3>
        <p class="muted">Try a different keyword or browse all categories.</p>
        <a class="btn btn-primary" href="#/category">Browse categories</a>
      </div>`;
      return;
    }
    grid.innerHTML = products.map(productCard).join('');
    backfillCardShipping(grid);

    const pag = document.getElementById('pagination');
    if (totalPages > 1) {
      // Three modes: pure category browse, search-within-category, or pure search.
      let baseHash;
      if (opts.categoryId && query) {
        baseHash = `/search?q=${encodeURIComponent(query)}&categoryId=${encodeURIComponent(opts.categoryId)}${opts.categoryName ? `&catName=${encodeURIComponent(opts.categoryName)}` : ''}`;
      } else if (opts.categoryId) {
        baseHash = `/category/${opts.categoryId}${opts.categoryName ? `?name=${encodeURIComponent(opts.categoryName)}` : ''}`;
      } else {
        baseHash = `/search?q=${encodeURIComponent(query)}`;
      }
      const mkLink = (p) => {
        const sep = baseHash.includes('?') ? '&' : '?';
        return `${baseHash}${sep}page=${p}`;
      };
      const start = Math.max(1, page - 2);
      const end = Math.min(totalPages, page + 2);
      let html = '';
      html += `<a class="page-btn ${page <= 1 ? 'disabled' : ''}" href="#${mkLink(Math.max(1, page - 1))}">‹ Prev</a>`;
      for (let i = start; i <= end; i++) {
        html += `<a class="page-btn ${i === page ? 'active' : ''}" href="#${mkLink(i)}">${i}</a>`;
      }
      html += `<a class="page-btn ${page >= totalPages ? 'disabled' : ''}" href="#${mkLink(Math.min(totalPages, page + 1))}">Next ›</a>`;
      pag.innerHTML = html;
    }
  } catch (err) {
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
        <a class="btn btn-primary" href="#/">← Back to store</a>
      </div>`;
    return;
  }
  const p = res.product;
  if (!p) { app.innerHTML = '<div class="empty-state"><h3>Product not found</h3></div>'; return; }

  // Cache this product's price for the next visit's list-page (so the
  // card displays instantly instead of showing a skeleton + backfilling).
  if (p.sellPrice) setCachedDisplayUsd(pid, p.sellPrice);

  const name = p.productNameEn || 'Product';
  const sku = p.productSku || '';
  const priceUsd = parseFloat(p.price || p.sellPrice || 0);
  const bigImg = p.bigImage || '';
  const category = p.categoryName || '';
  const weight = p.productWeight || '';
  const desc = p.description || '';
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
  if (!images.length) images = ['/img/befach_logo.png'];

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
    <div class="breadcrumb">
      <a href="#/">Home</a> <span>›</span>
      ${category ? `<a href="#/search?q=${encodeURIComponent(category.split('/')[0].trim())}">${esc(category.split('/')[0].trim())}</a><span>›</span>` : ''}
      <span class="current">${esc(name.slice(0, 60))}${name.length > 60 ? '…' : ''}</span>
    </div>

    <div class="product-detail fade-in">
      <!-- Gallery -->
      <div class="pd-gallery">
        <div class="pd-main-wrap">
          <img class="pd-main-img" id="pdMainImg" src="${imgProxy(images[0])}" alt="${esc(name)}"
               width="600" height="600"
               fetchpriority="high" decoding="async"
               onerror="this.onerror=null;this.src='/img/befach_logo.png'" />
        </div>
        <div class="pd-thumbs">
          ${images.slice(0, 8).map((src, i) => `
            <button class="pd-thumb ${i === 0 ? 'active' : ''}" data-src="${esc(imgProxy(src))}">
              <img src="${imgProxy(src)}" alt="thumb ${i + 1}" width="80" height="80"
                   loading="lazy" decoding="async"
                   onerror="this.style.visibility='hidden'" />
            </button>
          `).join('')}
        </div>
      </div>

      <!-- Info -->
      <div class="pd-info">
        <h1 class="pd-title">${esc(name)}</h1>
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
            <button type="button" id="pdQtyMinus">−</button>
            <input type="number" id="pdQty" value="1" min="1" max="999" />
            <button type="button" id="pdQtyPlus">+</button>
          </div>
          <div class="pd-stock" id="pdStock">Checking stock…</div>
        </div>

        <div class="pd-actions">
          <button class="btn btn-primary btn-lg" id="pdAddCart">Add to Cart</button>
          <button class="btn btn-dark btn-lg" id="pdBuyNow">Buy Now</button>
          <button type="button"
                  class="btn-wish-pd ${isInWishlist(pid) ? 'on' : ''}"
                  data-wish-pid="${esc(pid)}"
                  aria-label="Save to wishlist"
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

    // Update vid, main image, and price from the variant data already
    // loaded with the product detail. We used to fire an extra round-trip
    // to /api/store/shipping-for-variant here to get a per-variant
    // shipping quote — but on cold cache that call goes to CJ's API and
    // can take 1–3s, leaving the user staring at a "Updating price for
    // this variant…" spinner that sometimes never resolves. Since the
    // detail endpoint already returns each variant's display price using
    // the MAX-variant policy, the local data is accurate enough; the
    // server still re-prices at checkout to the actual variant cost.
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
    if (hint) hint.textContent = '✅ Inclusive of taxes & shipping to India';
    document.getElementById('pdAddCart').disabled = false;
    document.getElementById('pdBuyNow').disabled = false;
    checkVariantStock(current.vid);
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

  // Add to cart
  document.getElementById('pdAddCart').onclick = () => {
    if (!current.vid) return showToast('Please pick a variant');
    const qty = parseInt(qtyInput.value) || 1;
    addToCart({
      pid: current.pid,
      vid: current.vid,
      quantity: qty,
      productName: current.name,
      variantName: current.variantName,
      image: current.image,
      priceUsd: current.priceUsd.toString(),
    });
    showToast(`✅ Added ${qty} × ${current.name.slice(0, 30)} to cart`);
  };

  // Buy now
  document.getElementById('pdBuyNow').onclick = () => {
    if (!current.vid) return showToast('Please pick a variant');
    const qty = parseInt(qtyInput.value) || 1;
    addToCart({
      pid: current.pid, vid: current.vid, quantity: qty,
      productName: current.name, variantName: current.variantName,
      image: current.image, priceUsd: current.priceUsd.toString(),
    });
    navigate('/checkout');
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
    onClick: () => {
      const qty = parseInt(qtyInput.value) || 1;
      addToCart({
        pid: current.pid, vid: current.vid, quantity: qty,
        productName: current.name, variantName: current.variantName,
        image: current.image, priceUsd: current.priceUsd.toString(),
      });
      showToast(`✅ Added to cart`);
    },
    label: '🛒 Add to Cart',
    priceLabel: 'incl. shipping',
  });
}

/**
 * Inject (or refresh) the sticky bottom CTA bar. CSS controls visibility:
 * only shows on mobile via body.page-product / body.page-cart selectors.
 */
function installMobileCtaBar({ getPrice, getDisabled, onClick, label, priceLabel }) {
  document.getElementById('mobileCtaBar')?.remove();
  const bar = document.createElement('div');
  bar.className = 'mobile-cta-bar';
  bar.id = 'mobileCtaBar';
  bar.innerHTML = `
    <div class="mobile-cta-price">
      <span>${esc(priceLabel || '')}</span>
      <strong data-mcta-price>${fmtINR(getPrice())}</strong>
    </div>
    <button class="mobile-cta-btn" data-mcta-btn>${esc(label)}</button>
  `;
  document.body.appendChild(bar);
  const btn = bar.querySelector('[data-mcta-btn]');
  btn.disabled = !!(getDisabled && getDisabled());
  btn.onclick = onClick;
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
    btn.disabled = !!(getDisabled && getDisabled());
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
          <button class="pd-swatch ${active}" data-attr-idx="${attrIdx}" data-attr-value="${esc(val)}" title="${esc(val)}">
            <img src="${esc(imgProxy(img))}" alt="${esc(val)}" onerror="this.style.display='none'"/>
            <span class="pd-swatch-check">✓</span>
          </button>
        `;
      }
      return `
        <button class="pd-size-btn ${active}" data-attr-idx="${attrIdx}" data-attr-value="${esc(val)}">
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
