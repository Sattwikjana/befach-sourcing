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

const API = '';
const app = document.getElementById('app');
const toast = document.getElementById('toast');
const serverStatus = document.getElementById('serverStatus');
const headerSearchForm = document.getElementById('headerSearchForm');
const headerSearchInput = document.getElementById('headerSearchInput');
const headerCatBtn = document.getElementById('headerCatBtn');
const catDropdown = document.getElementById('catDropdown');
const cartCountEl = document.getElementById('cartCount');

document.getElementById('footerYear').textContent = new Date().getFullYear();

// ── State ──
const state = {
  config: { storeName: 'Befach', currency: 'INR', usdToInr: 85, shipTo: 'IN', shipFrom: 'CN' },
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
async function apiGet(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text().catch(() => ''))}`);
  return res.json();
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
//  CART (localStorage)
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
  updateCartBadge();
}
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

  // Cancel any in-flight shipping backfill from the previous page so its
  // queued CJ calls free up and the new page loads fast.
  if (typeof cancelBackfill === 'function') cancelBackfill();

  document.querySelectorAll('.nav-link').forEach(el => {
    el.classList.toggle('active', el.getAttribute('href') === '#' + path);
  });

  window.scrollTo(0, 0);

  if (path === '/' || path === '') return renderHome();
  if (path === '/category') return renderAllCategories();
  if (path.startsWith('/category/')) return renderCategory(path.slice('/category/'.length), parseInt(params.get('page')) || 1);
  if (path.startsWith('/search')) return renderSearch(params.get('q') || '', parseInt(params.get('page')) || 1);
  if (path.startsWith('/product/')) return renderProduct(path.slice('/product/'.length));
  if (path === '/cart') return renderCart();
  if (path === '/checkout') return renderCheckout();
  if (path.startsWith('/order/')) return renderOrderDetail(path.slice('/order/'.length));
  if (path === '/track') return renderTrack();
  if (path === '/admin') return renderAdmin();
  if (path === '/faq') return renderFaq();
  if (path === '/login') return renderLogin();
  if (path === '/register') return renderRegister();
  if (path === '/account') return renderAccount();
  return renderHome();
}

window.addEventListener('hashchange', handleRoute);
window.addEventListener('load', handleRoute);

// Header search submit
headerSearchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = headerSearchInput.value.trim();
  if (q.length < 2) return showToast('Type at least 2 characters');
  navigate(`/search?q=${encodeURIComponent(q)}`);
});

// ══════════════════════════════════════════════════════════════
//  CATEGORIES (header strip + dropdown)
// ══════════════════════════════════════════════════════════════
const CAT_ICONS = {
  Computer: '💻', Phone: '📱', Electronic: '🔌', Home: '🏠', Garden: '🌿',
  Toy: '🧸', Sport: '⚽', Beauty: '💄', Health: '💊', Cloth: '👕',
  Women: '👗', Men: '👔', Jewel: '💍', Watch: '⌚', Bag: '👜', Shoe: '👟',
  Baby: '👶', Pet: '🐾', Car: '🚗', Tool: '🔧', Light: '💡', Kitchen: '🍳',
  Furniture: '🪑', Office: '🖨️', Outdoor: '⛺', Food: '🍕', Game: '🎮',
  Book: '📚', Bed: '🛏️', Bath: '🛁', Travel: '🧳',
};
function catIcon(name) {
  if (!name) return '📦';
  for (const [k, v] of Object.entries(CAT_ICONS)) {
    if (name.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return '📦';
}

async function loadCategories() {
  if (state.categories.length) return state.categories;
  try {
    const res = await apiGet('/api/store/categories');
    state.categories = Array.isArray(res.data) ? res.data : [];
  } catch { state.categories = []; }
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
    return `<a class="cat-dropdown-item" href="#/search?q=${encodeURIComponent(name)}">
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
    return `
      <button type="button"
              class="mega-cat-item ${idx === 0 ? 'active' : ''}"
              data-idx="${idx}"
              onclick="navigate('/search?q=${encodeURIComponent(name)}')"
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
        <a class="btn btn-primary" href="#/search?q=${encodeURIComponent(cat.categoryFirstName)}">Shop ${esc(cat.categoryFirstName)} →</a>
      </div>
    `;
    return;
  }

  rightEl.innerHTML = secondGroups.map(group => {
    const secondName = group.categorySecondName || '';
    const thirds = group.categorySecondList || [];
    return `
      <div class="mega-group">
        <a class="mega-group-head" href="#/search?q=${encodeURIComponent(secondName)}">${esc(secondName)}</a>
        <div class="mega-group-items">
          ${thirds.slice(0, 8).map(t => {
            const tName = t.categoryName || '';
            return `<a href="#/search?q=${encodeURIComponent(tName)}">${esc(tName)}</a>`;
          }).join('')}
          ${thirds.length > 8 ? `<a class="mega-more" href="#/search?q=${encodeURIComponent(secondName)}">+${thirds.length - 8} more</a>` : ''}
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
const SHIP_LS_KEY = 'befach_ship_v1';
const SHIP_LS_TTL_MS = 24 * 60 * 60 * 1000;
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
function productCard(p) {
  const pid = p.pid || p.id || p.productId || '';
  const name = p.productNameEn || p.nameEn || p.productName || 'Untitled';
  const image = parseProductImage(p);
  const listed = p.listedNum || p.listedShopNum || 0;
  const serverAccurate = p.shippingAccurate === true;

  // Decide what to show RIGHT NOW (no waiting):
  //   1. Server says price is accurate → use it
  //   2. Browser localStorage has it from a previous visit → use that
  //   3. Otherwise → show skeleton, will be backfilled
  const cachedDisplay = getCachedDisplayUsd(pid);
  let displayUsd = null;
  let accurate = false;
  if (serverAccurate) {
    displayUsd = parseFloat(p.sellPrice || p.price || 0);
    accurate = true;
  } else if (cachedDisplay != null) {
    displayUsd = cachedDisplay;
    accurate = true;
  }

  const priceHtml = accurate
    ? `<span class="product-price-now" data-card-price>${fmtINR(displayUsd)}</span>`
    : `<span class="product-price-loading" data-card-price>
         <span class="price-skeleton"></span>
       </span>`;

  return `
    <a class="product-card fade-in"
       href="#/product/${encodeURIComponent(pid)}"
       data-pid="${esc(pid)}"
       data-accurate="${accurate ? '1' : '0'}">
      <div class="product-card-img-wrap">
        <img class="product-card-img" src="${imgProxy(image)}" alt="${esc(name)}"
          loading="lazy" onerror="this.onerror=null;this.src='/img/befach_logo.png'" />
        ${listed > 50 ? '<span class="product-card-badge">🔥 Popular</span>' : ''}
      </div>
      <div class="product-card-body">
        <div class="product-card-title">${esc(name)}</div>
        <div class="product-card-prices">${priceHtml}</div>
        <div class="product-card-ship">${accurate ? 'Shipping included' : 'Calculating price…'}</div>
      </div>
    </a>
  `;
}

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

        if (data.available === false) { card.remove(); continue; }

        if (data.displayUsd) {
          // Persist for instant load on next visit
          setCachedDisplayUsd(pid, data.displayUsd);
          const priceEl = card.querySelector('[data-card-price]');
          if (priceEl) {
            priceEl.outerHTML = `<span class="product-price-now" data-card-price>${fmtINR(data.displayUsd)}</span>`;
          }
        }
        const shipEl = card.querySelector('.product-card-ship');
        if (shipEl) shipEl.textContent = 'Shipping included';
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
      <!-- Left sidebar: category list with hover-to-expand (CJ-style) -->
      <aside class="home-sidebar" id="homeSidebar">
        ${Array(14).fill('<div class="sidebar-cat skeleton" style="height:48px;margin:4px 0"></div>').join('')}
      </aside>

      <!-- Right: hero + trending + banners + for-you -->
      <div class="home-main">
        <section class="hero">
          <div class="hero-inner">
            <div class="hero-copy">
              <h1 class="hero-title">Shop the world.<br/><span class="accent">Delivered to your door.</span></h1>
              <p class="hero-sub">Millions of products sourced globally. Best prices, fast shipping, secure checkout.</p>
              <form class="hero-search" id="heroSearchForm">
                <input type="text" id="heroSearchInput" placeholder="Search earbuds, watches, LED lights..." autofocus />
                <button type="submit">Search</button>
              </form>
              <div class="hero-trust">
                <span>🚚 Fast shipping</span>
                <span>🌍 200+ countries</span>
                <span>🔄 Easy returns</span>
                <span>🔒 Secure checkout</span>
              </div>
            </div>
          </div>
        </section>

        <section class="section">
          <div class="section-head">
            <h2>Trending now</h2>
            <a href="#/search?q=trending" class="section-link">See more →</a>
          </div>
          <div class="products-grid" id="trendingGrid">${productSkeleton(10)}</div>
        </section>

        <section class="section banner-row">
          <div class="banner banner-a">
            <div>
              <h3>New arrivals</h3>
              <p>Fresh drops weekly</p>
              <a href="#/search?q=new arrivals" class="banner-cta">Shop new →</a>
            </div>
          </div>
          <div class="banner banner-b">
            <div>
              <h3>Best sellers</h3>
              <p>What the world is buying</p>
              <a href="#/search?q=best sellers" class="banner-cta">Shop now →</a>
            </div>
          </div>
        </section>

        <section class="section">
          <div class="section-head"><h2>For you</h2></div>
          <div class="products-grid" id="forYouGrid">${productSkeleton(10)}</div>
        </section>
      </div>

      <!-- Flyout panel: appears to the right of a hovered sidebar category -->
      <div class="sidebar-flyout" id="sidebarFlyout" hidden></div>
    </div>
  `;

  document.getElementById('heroSearchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = document.getElementById('heroSearchInput').value.trim();
    if (q.length < 2) return showToast('Type at least 2 characters');
    navigate(`/search?q=${encodeURIComponent(q)}`);
  });

  loadCategories().then(() => renderHomeSidebar());
  loadHomeProducts();
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
         href="#/search?q=${encodeURIComponent(name)}">
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

  // Hide the flyout when cursor leaves both the sidebar and the flyout
  const flyout = document.getElementById('sidebarFlyout');
  const hideMaybe = () => {
    setTimeout(() => {
      if (!el.matches(':hover') && !flyout.matches(':hover')) hideSidebarFlyout();
    }, 100);
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
        <a class="btn btn-primary" href="#/search?q=${encodeURIComponent(title)}">Shop ${esc(title)} →</a>
      </div>
    `;
  } else {
    flyout.innerHTML = groups.map(g => {
      const gName = g.categorySecondName || '';
      const thirds = g.categorySecondList || [];
      return `
        <div class="flyout-group">
          <a class="flyout-group-head" href="#/search?q=${encodeURIComponent(gName)}">${esc(gName)}</a>
          <div class="flyout-group-items">
            ${thirds.slice(0, 10).map(t => {
              const tName = t.categoryName || '';
              return `<a href="#/search?q=${encodeURIComponent(tName)}">${esc(tName)}</a>`;
            }).join('')}
            ${thirds.length > 10 ? `<a class="flyout-more" href="#/search?q=${encodeURIComponent(gName)}">+${thirds.length - 10} more</a>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  // Position the flyout: top-aligned with the sidebar, to its right
  const sRect = sidebar.getBoundingClientRect();
  flyout.style.top = '0';
  flyout.style.left = (sidebar.offsetWidth + 8) + 'px';
  flyout.hidden = false;
}

function hideSidebarFlyout() {
  const flyout = document.getElementById('sidebarFlyout');
  const sidebar = document.getElementById('homeSidebar');
  if (flyout) flyout.hidden = true;
  if (sidebar) sidebar.querySelectorAll('.sidebar-cat.active').forEach(el => el.classList.remove('active'));
}

async function loadHomeProducts() {
  const trendingGrid = document.getElementById('trendingGrid');
  const forYouGrid = document.getElementById('forYouGrid');
  const showErr = (el, msg) => { if (el) el.innerHTML = `<p class="muted">${esc(msg)}</p>`; };

  const fetchOnce = async () => {
    const res = await apiGet('/api/store/products?size=24&page=1');
    return res.products || [];
  };

  let products;
  try {
    products = await fetchOnce();
  } catch (err) {
    // One retry after a short pause
    try {
      await new Promise(r => setTimeout(r, 1200));
      products = await fetchOnce();
    } catch (e2) {
      showErr(trendingGrid, `Couldn't load products — refresh the page.`);
      showErr(forYouGrid, '');
      return;
    }
  }

  if (!products.length) {
    showErr(trendingGrid, 'No products available right now.');
    showErr(forYouGrid, '');
    return;
  }

  // Randomise the split so "Trending" and "For you" feel different each load,
  // but keep them stable within a single visit.
  const trending = products.slice(0, 12);
  const forYou = products.slice(12, 24);
  if (trendingGrid) trendingGrid.innerHTML = trending.map(productCard).join('');
  if (forYouGrid) forYouGrid.innerHTML = forYou.length ? forYou.map(productCard).join('') : '';
  // Backfill real CJPacket shipping for any cards that showed approximate prices
  backfillCardShipping(trendingGrid);
  backfillCardShipping(forYouGrid);
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
    return `<div class="cat-block fade-in">
      <a href="#/search?q=${encodeURIComponent(name)}" class="cat-block-head">
        <span class="cat-block-icon">${catIcon(name)}</span>
        <span class="cat-block-name">${esc(name)}</span>
      </a>
      <div class="cat-block-subs">
        ${subs.slice(0, 8).map(s => {
          const subName = s.categorySecondName || '';
          return `<a href="#/search?q=${encodeURIComponent(subName)}">${esc(subName)}</a>`;
        }).join('')}
        ${subs.length > 8 ? `<a href="#/search?q=${encodeURIComponent(name)}" class="muted">+${subs.length - 8} more</a>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
//  CATEGORY PAGE  (stub — shares search rendering)
// ══════════════════════════════════════════════════════════════
function renderCategory(categoryId, page) {
  return renderSearch('', page, { categoryId });
}

// ══════════════════════════════════════════════════════════════
//  SEARCH / CATEGORY RESULTS
// ══════════════════════════════════════════════════════════════
async function renderSearch(query, page = 1, opts = {}) {
  headerSearchInput.value = query;
  const title = query ? `Results for "${esc(query)}"` : 'Browse products';
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
    <div class="products-grid" id="searchGrid">${productSkeleton(12)}</div>
    <div class="pagination" id="pagination"></div>
  `;

  try {
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
      const baseHash = opts.categoryId ? `/category/${opts.categoryId}` : `/search?q=${encodeURIComponent(query)}`;
      const mkLink = (p) => {
        if (opts.categoryId) return `${baseHash}?page=${p}`;
        return `${baseHash}&page=${p}`;
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
    document.getElementById('searchGrid').innerHTML =
      `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>Search failed</h3><p class="muted">${esc(err.message)}</p></div>`;
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
  const selectedPriceUsd = selectedVariant ? parseFloat(selectedVariant.price || selectedVariant.variantSellPrice || priceUsd) : priceUsd;

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
               onerror="this.onerror=null;this.src='/img/befach_logo.png'" />
        </div>
        <div class="pd-thumbs">
          ${images.slice(0, 8).map((src, i) => `
            <button class="pd-thumb ${i === 0 ? 'active' : ''}" data-src="${esc(imgProxy(src))}">
              <img src="${imgProxy(src)}" alt="thumb ${i + 1}" onerror="this.style.visibility='hidden'" />
            </button>
          `).join('')}
        </div>
      </div>

      <!-- Info -->
      <div class="pd-info">
        <h1 class="pd-title">${esc(name)}</h1>
        ${sku ? `<div class="pd-sku">SKU: ${esc(sku)}</div>` : ''}

        <div class="pd-price-box">
          <div class="pd-price" id="pdPrice">${fmtINR(selectedPriceUsd)}</div>
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
          <button class="btn btn-primary btn-lg" id="pdAddCart">🛒 Add to Cart</button>
          <button class="btn btn-dark btn-lg" id="pdBuyNow">⚡ Buy Now</button>
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

    // Update vid, main image, initial price (will be refined below)
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

    // Ask server for the per-variant real display price (weight varies by size)
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
      if (hint) hint.textContent = '✅ Inclusive of taxes & shipping to India';
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
}

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
