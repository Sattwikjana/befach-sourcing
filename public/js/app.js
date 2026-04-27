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

// ── Mobile drawer ──
const hamburgerBtn = document.getElementById('headerHamburger');
const drawerEl = document.getElementById('drawer');
const drawerBackdrop = document.getElementById('drawerBackdrop');
const drawerClose = document.getElementById('drawerClose');
const drawerCatToggle = document.getElementById('drawerCatToggle');
const drawerCatsEl = document.getElementById('drawerCats');

function openDrawer() {
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

// Expandable categories accordion inside the drawer
drawerCatToggle?.addEventListener('click', () => {
  if (!drawerCatsEl) return;
  const open = !drawerCatsEl.hidden;
  drawerCatsEl.hidden = open;
  drawerCatToggle.classList.toggle('open', !open);
});

/** Called by loadCategories() once the category list is ready. */
function populateDrawerCategories() {
  if (!drawerCatsEl) return;
  const cats = state.categories || [];
  if (!cats.length) {
    drawerCatsEl.innerHTML = '<span class="drawer-cats-loading muted">Categories unavailable</span>';
    return;
  }
  drawerCatsEl.innerHTML = cats.map(cat => {
    const name = cat.categoryFirstName || '';
    return `
      <a class="drawer-cat-link" href="${categoryHref(cat)}">
        <span class="drawer-cat-icon">${catIcon(name)}</span>
        <span class="drawer-cat-name">${esc(name)}</span>
      </a>
    `;
  }).join('');
  // Re-attach close handler to the freshly-injected links
  drawerCatsEl.querySelectorAll('a').forEach(a => a.addEventListener('click', closeDrawer));
}

// Close drawer whenever any direct link is clicked
drawerEl?.querySelectorAll('a').forEach(a => a.addEventListener('click', closeDrawer));

window.openDrawer = openDrawer;
window.closeDrawer = closeDrawer;
window.populateDrawerCategories = populateDrawerCategories;
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
  if (path === '/login') return renderLogin();
  if (path === '/register') return renderRegister();
  if (path === '/account') return renderAccount();
  return renderHome();
}

window.addEventListener('hashchange', handleRoute);
window.addEventListener('load', handleRoute);

// Header search submit
headerSearchForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = headerSearchInput.value.trim();
  if (q.length < 2) return showToast('Type at least 2 characters');
  if (typeof closeSearchSuggest === 'function') closeSearchSuggest();
  navigate(`/search?q=${encodeURIComponent(q)}`);
});

// ══════════════════════════════════════════════════════════════
//  SEARCH TYPEAHEAD (Google / CJ-style live suggestions dropdown)
//  Wired on every search input via setupSearchSuggest(inputEl).
//  - Debounces input by ~220ms before hitting /api/store/products
//  - Caches each query for 60s so re-typing is instant
//  - Mixes a few category matches (local) with product hits (server)
//  - Keyboard: ↑/↓ to highlight, Enter to open, Esc to close
// ══════════════════════════════════════════════════════════════
const SUGGEST_DEBOUNCE_MS = 220;
const SUGGEST_CACHE = new Map();
const SUGGEST_CACHE_TTL = 60_000;
let activeSuggestDropdown = null;
function closeSearchSuggest() {
  if (activeSuggestDropdown) activeSuggestDropdown.hidden = true;
}
window.closeSearchSuggest = closeSearchSuggest;

function setupSearchSuggest(inputEl) {
  if (!inputEl || inputEl._suggestWired) return;
  inputEl._suggestWired = true;

  const dropdown = document.createElement('div');
  dropdown.className = 'search-suggest';
  dropdown.hidden = true;
  document.body.appendChild(dropdown);

  let activeIdx = -1;
  let currentResults = [];
  let lastReqId = 0;
  let debounceTimer = null;

  const positionDropdown = () => {
    const r = inputEl.getBoundingClientRect();
    dropdown.style.left = r.left + 'px';
    dropdown.style.top = (r.bottom + 4) + 'px';
    dropdown.style.width = Math.max(r.width, 280) + 'px';
  };

  const close = () => {
    dropdown.hidden = true;
    activeIdx = -1;
    activeSuggestDropdown = null;
  };

  const updateActiveHighlight = () => {
    dropdown.querySelectorAll('.suggest-item').forEach((el, i) => {
      el.classList.toggle('active', i === activeIdx);
    });
    const active = dropdown.querySelector('.suggest-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  };

  const renderItems = (items) => {
    currentResults = items;
    activeIdx = -1;
    if (!items.length) {
      dropdown.innerHTML = '<div class="suggest-empty">No matches. Press Enter to search anyway.</div>';
    } else {
      // Row layout (Flipkart-style):
      //   [icon/thumb 44]  [main text \n subtitle]  [arrow]
      // Scope rows use a magnifier icon + ↖ arrow ("fill the search box"),
      // product rows use a thumbnail + › arrow ("open product").
      const arrowFill = `<svg class="suggest-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M17 7L7 17M7 7h10v10"/></svg>`;
      const arrowOpen = `<svg class="suggest-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6"/></svg>`;
      const magnifier = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>`;

      dropdown.innerHTML = items.map((item, idx) => {
        if (item.type === 'scope') {
          return `<a class="suggest-item suggest-scope" data-idx="${idx}" href="${item.href}">
            <span class="suggest-icon-box">${magnifier}</span>
            <div class="suggest-text">
              <div class="suggest-main"><strong>${esc(item.query)}</strong> <span class="suggest-phrase">${esc(item.displayPhrase)}</span></div>
              <div class="suggest-sub">in ${esc(item.scopeName)}</div>
            </div>
            ${arrowFill}
          </a>`;
        }
        if (item.type === 'category') {
          return `<a class="suggest-item suggest-cat" data-idx="${idx}" href="${item.href}">
            <span class="suggest-icon-box suggest-emoji">${catIcon(item.name)}</span>
            <div class="suggest-text">
              <div class="suggest-main">${esc(item.name)}</div>
              <div class="suggest-sub">Browse category</div>
            </div>
            ${arrowFill}
          </a>`;
        }
        const priceHtml = item.priceUsd > 0
          ? `<div class="suggest-sub suggest-price">${fmtINR(item.priceUsd)}</div>`
          : '';
        return `<a class="suggest-item suggest-product" data-idx="${idx}" href="${item.href}">
          <img class="suggest-thumb" src="${imgProxy(item.image)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"/>
          <div class="suggest-text">
            <div class="suggest-main">${esc(item.name)}</div>
            ${priceHtml}
          </div>
          ${arrowOpen}
        </a>`;
      }).join('');
    }
    positionDropdown();
    dropdown.hidden = false;
    activeSuggestDropdown = dropdown;
  };

  const fetchSuggestions = async (q) => {
    const cached = SUGGEST_CACHE.get(q);
    if (cached && Date.now() - cached.ts < SUGGEST_CACHE_TTL) return cached.items;

    const reqId = ++lastReqId;
    const items = [];
    const ql = q.toLowerCase();

    // The category tree drives both scope suggestions and direct matches.
    // If the user types before the tree finished loading, await it.
    if (!state.categories || !state.categories.length) {
      try { await loadCategories(); } catch {}
    }

    // ── 1. Department ("scope") suggestions, Flipkart-style:
    //   bold:  "shirt"
    //   sub:   "for Men"   (linked to Men's Clothing category)
    // The display phrase reads naturally next to the query in the row.
    const SCOPE_PRIORITY = [
      { display: 'for Men',         name: "Men's Clothing" },
      { display: 'for Women',       name: "Women's Clothing" },
      { display: 'for Kids',        name: "Toys, Kids & Babies" },
      { display: 'in Electronics',  name: "Consumer Electronics" },
      { display: 'in Watches',      name: "Jewelry & Watches" },
      { display: 'in Bags & Shoes', name: "Bags & Shoes" },
      { display: 'in Beauty',       name: "Health, Beauty & Hair" },
      { display: 'in Phones',       name: "Phones & Accessories" },
    ];
    const cats = state.categories || [];
    const findCatByName = (n) => cats.find(c =>
      (c.categoryFirstName || '').toLowerCase() === n.toLowerCase()
    );
    let scopeCount = 0;
    for (const scope of SCOPE_PRIORITY) {
      // Don't offer "shirt for men" if the user literally typed "men's clothing"
      if (scope.name.toLowerCase().includes(ql)) continue;
      const cat = findCatByName(scope.name);
      if (!cat?.categoryFirstId) continue;
      items.push({
        type: 'scope',
        query: q,
        displayPhrase: scope.display,
        scopeName: cat.categoryFirstName,
        href: `#/search?q=${encodeURIComponent(q)}&categoryId=${encodeURIComponent(cat.categoryFirstId)}&catName=${encodeURIComponent(cat.categoryFirstName)}`,
      });
      if (++scopeCount >= 3) break;
    }

    // ── 2. Direct category-name matches (sub-categories like "Glasses",
    // "Shoes" etc.) — useful when the query IS a category name.
    const seen = new Set();
    let directCatCount = 0;
    for (const cat of cats) {
      const fName = cat.categoryFirstName || '';
      if (fName.toLowerCase().includes(ql) && !seen.has(fName)) {
        items.push({ type: 'category', name: fName, href: categoryHref(cat) });
        seen.add(fName);
        if (++directCatCount >= 2) break;
      }
      if (directCatCount >= 2) break;
      for (const sec of cat.categoryFirstList || []) {
        const sName = sec.categorySecondName || '';
        if (sName.toLowerCase().includes(ql) && !seen.has(sName)) {
          items.push({ type: 'category', name: sName, href: categoryHref(sec) });
          seen.add(sName);
          if (++directCatCount >= 2) break;
        }
        if (directCatCount >= 2) break;
        for (const t of sec.categorySecondList || []) {
          const tName = t.categoryName || '';
          if (tName.toLowerCase().includes(ql) && !seen.has(tName)) {
            items.push({ type: 'category', name: tName, href: categoryHref(t) });
            seen.add(tName);
            if (++directCatCount >= 2) break;
          }
        }
        if (directCatCount >= 2) break;
      }
      if (directCatCount >= 2) break;
    }

    // Product matches from CJ via the cached /products endpoint
    try {
      const res = await fetch(`/api/store/products?keyWord=${encodeURIComponent(q)}&size=6&page=1`);
      if (reqId !== lastReqId) return null; // stale, drop
      if (res.ok) {
        const data = await res.json();
        const products = (data.products || []).slice(0, 6).map(p => ({
          type: 'product',
          name: p.productNameEn || p.nameEn || p.productName || 'Untitled',
          image: parseProductImage(p),
          priceUsd: parseFloat(p.sellPrice || p.price || 0),
          href: '#/product/' + encodeURIComponent(p.pid || p.id || p.productId || ''),
        }));
        items.push(...products);
      }
    } catch {}

    SUGGEST_CACHE.set(q, { items, ts: Date.now() });
    return items;
  };

  inputEl.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = inputEl.value.trim();
    if (q.length < 2) { close(); return; }
    debounceTimer = setTimeout(async () => {
      const items = await fetchSuggestions(q);
      if (items === null) return;
      renderItems(items);
    }, SUGGEST_DEBOUNCE_MS);
  });

  inputEl.addEventListener('focus', () => {
    if (currentResults.length && inputEl.value.trim().length >= 2) {
      positionDropdown();
      dropdown.hidden = false;
      activeSuggestDropdown = dropdown;
    }
  });

  inputEl.addEventListener('keydown', (e) => {
    if (dropdown.hidden || !currentResults.length) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = (activeIdx + 1) % currentResults.length;
      updateActiveHighlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = (activeIdx - 1 + currentResults.length) % currentResults.length;
      updateActiveHighlight();
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      const item = currentResults[activeIdx];
      location.hash = item.href.replace(/^#/, '');
      close();
    }
  });

  // Outside click closes
  document.addEventListener('click', (e) => {
    if (e.target === inputEl || dropdown.contains(e.target)) return;
    close();
  });

  // Selecting a suggestion closes the dropdown (the link itself navigates)
  dropdown.addEventListener('click', (e) => {
    if (e.target.closest('.suggest-item')) close();
  });

  window.addEventListener('scroll', () => { if (!dropdown.hidden) positionDropdown(); }, { passive: true });
  window.addEventListener('resize', () => { if (!dropdown.hidden) positionDropdown(); });
}
window.setupSearchSuggest = setupSearchSuggest;

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
          ${thirds.slice(0, 8).map(t => {
            const tName = t.categoryName || '';
            return `<a href="${categoryHref(t)}">${esc(tName)}</a>`;
          }).join('')}
          ${thirds.length > 8 ? `<a class="mega-more" href="${groupHref}">+${thirds.length - 8} more</a>` : ''}
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
// Bumped to v2 when the global markup changed (20% → 50%) so returning
// visitors don't keep seeing old prices from their localStorage cache.
const SHIP_LS_KEY = 'befach_ship_v2';
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
function productCard(p) {
  const pid = p.pid || p.id || p.productId || '';
  const name = p.productNameEn || p.nameEn || p.productName || 'Untitled';
  const image = parseProductImage(p);
  const listed = p.listedNum || p.listedShopNum || 0;
  const serverAccurate = p.shippingAccurate === true;

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
        <div class="product-card-prices">
          <span class="product-price-now" data-card-price>${fmtINR(displayUsd)}</span>
        </div>
        <div class="product-card-ship">Shipping included</div>
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
          if (priceEl) priceEl.textContent = fmtINR(data.displayUsd);
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
            <h2>🔥 Trending tech &amp; gadgets</h2>
            <a href="#/search?q=earbuds" class="section-link" id="trendingMore">See more →</a>
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
          <div class="section-head">
            <h2>💎 Style &amp; jewellery picks</h2>
            <a href="#/search?q=watch" class="section-link" id="forYouMore">See more →</a>
          </div>
          <div class="products-grid" id="forYouGrid">${productSkeleton(10)}</div>
        </section>

        <section class="section">
          <div class="section-head">
            <h2>🏠 Home &amp; lifestyle</h2>
            <a href="#/search?q=led light" class="section-link" id="homeLifestyleMore">See more →</a>
          </div>
          <div class="products-grid" id="homeLifestyleGrid">${productSkeleton(10)}</div>
        </section>
      </div>

      <!-- Flyout panel: appears to the right of a hovered sidebar category -->
      <div class="sidebar-flyout" id="sidebarFlyout" hidden></div>
    </div>
  `;

  const heroInput = document.getElementById('heroSearchInput');
  document.getElementById('heroSearchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = heroInput.value.trim();
    if (q.length < 2) return showToast('Type at least 2 characters');
    closeSearchSuggest();
    navigate(`/search?q=${encodeURIComponent(q)}`);
  });
  setupSearchSuggest(heroInput);

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
            ${thirds.slice(0, 10).map(t => {
              const tName = t.categoryName || '';
              return `<a href="${categoryHref(t)}">${esc(tName)}</a>`;
            }).join('')}
            ${thirds.length > 10 ? `<a class="flyout-more" href="${gHref}">+${thirds.length - 10} more</a>` : ''}
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
  const homeLifestyleGrid = document.getElementById('homeLifestyleGrid');
  const showErr = (el, msg) => { if (el) el.innerHTML = `<p class="muted">${esc(msg)}</p>`; };

  // Three themed sections — each fires its own /api/store/products call with
  // a different keyword, so the rows are visually distinct (different
  // products, different vibes). Keywords rotate by day-of-year so the home
  // page feels fresh every visit instead of showing the same items forever.
  const today = new Date();
  const dayOfYear = Math.floor(
    (today - new Date(today.getFullYear(), 0, 0)) / 86400000
  );
  const pick = (arr) => arr[dayOfYear % arr.length];

  const trendingPool = [
    'earbuds', 'wireless headphones', 'smart watch', 'bluetooth speaker',
    'power bank', 'phone holder', 'gaming mouse', 'mini projector',
    'action camera', 'mechanical keyboard', 'smart glasses', 'drone',
    'vr headset', 'air purifier',
  ];
  const stylePool = [
    'watch', 'sunglasses', 'necklace', 'bracelet', 'ring', 'earrings',
    'handbag', 'wallet', 'hair clip', 'pendant', 'silk scarf', 'leather belt',
    'mens watch', 'womens jewellery',
  ];
  const homePool = [
    'led light', 'kitchen tools', 'wall art', 'desk lamp', 'storage organizer',
    'cushion cover', 'blanket', 'bathroom mat', 'plant pot', 'humidifier',
    'aroma diffuser', 'room decor', 'coffee mug', 'cookware',
  ];

  const sections = [
    { grid: trendingGrid,       keyword: pick(trendingPool), label: 'tech & gadgets',     moreId: 'trendingMore' },
    { grid: forYouGrid,         keyword: pick(stylePool),    label: 'style & jewellery',  moreId: 'forYouMore' },
    { grid: homeLifestyleGrid,  keyword: pick(homePool),     label: 'home & lifestyle',   moreId: 'homeLifestyleMore' },
  ];

  // Point each section's "See more →" link at the same keyword we're
  // showing in the row, so navigation matches what the user sees.
  sections.forEach(s => {
    const link = document.getElementById(s.moreId);
    if (link) link.href = `#/search?q=${encodeURIComponent(s.keyword)}`;
  });

  // Fire all three in parallel (different endpoints don't share rate limit
  // here — they're all on /product/listV2, which the server queue serialises,
  // but the cache hit on subsequent loads makes this near-instant).
  await Promise.all(sections.map(async (s) => {
    if (!s.grid) return;
    try {
      const res = await apiGet(`/api/store/products?keyWord=${encodeURIComponent(s.keyword)}&size=12&page=1`);
      const products = res.products || [];
      if (!products.length) {
        showErr(s.grid, `No ${s.label} products available right now.`);
        return;
      }
      s.grid.innerHTML = products.map(productCard).join('');
      backfillCardShipping(s.grid);
    } catch (err) {
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
      <div class="cat-block-subs">
        ${subs.slice(0, 8).map(s => {
          const subName = s.categorySecondName || '';
          return `<a href="${categoryHref(s)}">${esc(subName)}</a>`;
        }).join('')}
        ${subs.length > 8 ? `<a href="${catHref}" class="muted">+${subs.length - 8} more</a>` : ''}
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
