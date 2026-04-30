/**
 * Befach Store — Backend v8.0
 * Consumer e-commerce store powered by CJDropshipping API.
 *
 *   /api/store/*   → public consumer endpoints (retail price, profit stripped)
 *   /api/admin/*   → password-protected admin dashboard
 *   /api/raw/*     → raw CJ pass-through for debugging (admin-only)
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const helmet = require('helmet');

const cj = require('./cjApi');
const pricing = require('./pricingEngine');
const orders = require('./orderManager');
const auth = require('./auth');

const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Razorpay client ──
// Both keys live in env — never in code or git.
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
} else {
  console.warn('[Razorpay] keys not set — payment endpoints will return 503 until they are.');
}

// ── Production-grade middleware ──
// Security headers (CSP relaxed because the SPA inlines handlers)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
// gzip/brotli compression for text responses (HTML/JS/CSS/JSON)
app.use(compression());
app.use(cors({ credentials: true, origin: true }));
app.use(cookieParser());
// Keep the raw bytes alongside the parsed JSON so endpoints that need to
// verify HMAC signatures (e.g. Razorpay webhooks) can re-hash the exact
// payload Razorpay signed. Adds < 1ms; we never use rawBody elsewhere.
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(auth.attachUser);
// Static assets — long browser cache for images/fonts. CSS/JS use
// no-cache + ETag so updates are picked up immediately (browser still
// gets a 304 Not Modified when nothing changed). Switch to a longer
// max-age once the codebase is stable for production.
app.use(express.static(path.join(__dirname, '../public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (/\.(png|jpe?g|gif|svg|ico|webp|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day
    } else if (/\.(css|js|html?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// ── Config / env ──
const DEFAULT_SHIP_FROM = process.env.DEFAULT_SHIP_FROM || 'CN';
const DEFAULT_SHIP_TO = process.env.DEFAULT_SHIP_TO || 'IN';
// Shipping method priority: try the first that's available for a given product.
const SHIPPING_METHODS_PRIORITY = ['CJPacket Asia Ordinary', 'CJPacket Asia Sensitive'];
// Absolute last-resort fallback when no CJ method returns a quote.
const FALLBACK_SHIPPING_USD = parseFloat(process.env.FALLBACK_SHIPPING_USD) || 3.49;

// ── In-memory LRU cache keyed by URL/cache-key ──
// Capped at 600 entries — without a cap this Map grew forever on the
// 512MB Render Starter and eventually OOM'd the Node process, which
// caused the "/products hangs for minutes after a restart" symptom
// (cold caches + CJ rate-limit cascade until everything warms up).
const CACHE_MAX_ENTRIES = 600;
const CACHE = new Map(); // insertion order = LRU order

// Bump this whenever the searchProductsMerged logic changes its output
// shape or sort order. Old cached entries with a different version
// won't be read, so users see the new behavior immediately on deploy
// without waiting for the 30-min TTL to expire.
const PRODUCTS_CACHE_VERSION = 'v5';
const productsRawKey = (params) => `productsRaw:${PRODUCTS_CACHE_VERSION}:${JSON.stringify(params)}`;

function cacheGet(key, ttlMs) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > ttlMs) {
    CACHE.delete(key);
    return null;
  }
  // Touch: re-insert so this key becomes most-recently-used
  CACHE.delete(key);
  CACHE.set(key, e);
  return e.val;
}

function cacheSet(key, val) {
  CACHE.delete(key);
  CACHE.set(key, { ts: Date.now(), val });
  // Evict the oldest entry while we're over the cap
  while (CACHE.size > CACHE_MAX_ENTRIES) {
    const oldestKey = CACHE.keys().next().value;
    if (oldestKey === undefined) break;
    CACHE.delete(oldestKey);
  }
  return val;
}

// ── Manual product blocklist (admin-curated, disk-backed) ──
// Lets the owner hide specific products that, despite CJ's freight API
// saying they're shippable, shouldn't be sold (e.g. observed quality
// issues, supplier reliability, or genuinely unshippable products that
// the freight API quotes anyway). Both list and detail endpoints honour it.
const BLOCKED_PRODUCTS_FILE = path.join(__dirname, 'data', 'blocked-products.json');
let blockedProducts = {};
try {
  if (fs.existsSync(BLOCKED_PRODUCTS_FILE)) {
    blockedProducts = JSON.parse(fs.readFileSync(BLOCKED_PRODUCTS_FILE, 'utf8'));
  }
} catch (e) {
  console.warn('[blocked products] failed to load:', e.message);
  blockedProducts = {};
}
function saveBlockedProducts() {
  try {
    const dir = path.dirname(BLOCKED_PRODUCTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(BLOCKED_PRODUCTS_FILE, JSON.stringify(blockedProducts, null, 2));
  } catch (e) { console.warn('[blocked products] save failed:', e.message); }
}
function isBlocked(pid) { return !!blockedProducts[pid]; }

// ── Persistent per-product shipping cache (disk-backed) ──
// One entry per product id; survives server restarts so list pages are
// accurate the moment the server comes up, and the freight API only has
// to quote each product once per day.
const SHIPPING_CACHE_FILE = path.join(__dirname, 'data', 'shipping-cache.json');
// 6 months — display prices stay fast for almost forever.
// Order placement re-quotes if the cache is older than ORDER_FRESH_MAX_MS
// (see below) so we never charge stale prices when CJ has raised rates.
const SHIPPING_CACHE_TTL = 180 * 24 * 60 * 60 * 1000; // 180 days
const ORDER_FRESH_MAX_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days for orders
let shippingCache = {};
try {
  if (fs.existsSync(SHIPPING_CACHE_FILE)) {
    shippingCache = JSON.parse(fs.readFileSync(SHIPPING_CACHE_FILE, 'utf8'));
  }
} catch (e) {
  console.warn('[shipping cache] failed to load, starting fresh:', e.message);
  shippingCache = {};
}
// Throttle disk writes — the cache may be updated many times per second
// during warmup; we only need to persist every second at most.
let saveTimer = null;
function saveShippingCache() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const dir = path.dirname(SHIPPING_CACHE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(SHIPPING_CACHE_FILE, JSON.stringify(shippingCache));
    } catch (e) { console.warn('[shipping cache] save failed:', e.message); }
  }, 1000);
}

/**
 * Single source of truth for fetching a CJ product detail.
 *
 * Caches the raw CJ response (10 min TTL) under the same key the
 * /api/store/products/:pid endpoint uses, so all paths share one cache.
 * That means:
 *   - First call for a pid: 1 CJ request, cached
 *   - All subsequent calls (shipping-for, getProductShippingUsd, detail
 *     endpoint): zero CJ requests until the 10-min TTL expires
 */
async function getProductRaw(pid, priority = 'low') {
  const key = 'productRaw:' + pid;
  const cached = cacheGet(key, 10 * 60 * 1000);
  if (cached) return cached;
  const data = await cj.getProductDetail(pid, { priority });
  if (data?.data) cacheSet(key, data.data);
  return data?.data || null;
}

/**
 * Quote shipping for a list of items and pick the first method from
 * SHIPPING_METHODS_PRIORITY that CJ actually returned.
 *
 * Returns:
 *   { usd, method, available: true }   — CJ returned a valid method for this cart
 *   { usd: 0,   method: null, available: false }  — CJ can't ship this to India
 *   null                                — request failed (treat as unknown)
 */
async function quoteShippingForItems(items, priority = 'low') {
  try {
    const data = await cj.calculateFreight({
      startCountryCode: DEFAULT_SHIP_FROM,
      endCountryCode: DEFAULT_SHIP_TO,
      products: items.map(i => ({ vid: i.vid, quantity: parseInt(i.quantity) || 1 })),
    }, { priority });
    const methods = Array.isArray(data.data) ? data.data : [];
    for (const wanted of SHIPPING_METHODS_PRIORITY) {
      const m = methods.find(x => x.logisticName === wanted);
      if (m && m.logisticPrice != null) {
        return { usd: parseFloat(m.logisticPrice), method: m.logisticName, available: true };
      }
    }
    // CJ responded but none of our priority methods is available — treat
    // this product as not shippable (we only ship via Ordinary / Sensitive).
    return { usd: 0, method: null, available: false };
  } catch (e) {
    // Transient — caller handles by falling back to cached/flat estimate
    return null;
  }
}

/**
 * Get per-product shipping cost (for one unit) using the priority chain.
 * Cached on disk, keyed by product id.
 *
 * @param {string} pid           CJ product id
 * @param {'high'|'medium'|'low'} priority  CJ queue priority
 * @param {number} maxAgeMs      override TTL for this call (e.g. orders
 *                               require fresher data than display does)
 * Returns { usd, method, available, cached }
 */
async function getProductShippingUsd(pid, priority = 'low', maxAgeMs = SHIPPING_CACHE_TTL) {
  const hit = shippingCache[pid];
  if (hit && Date.now() - hit.ts < maxAgeMs) {
    return {
      usd: hit.usd,
      method: hit.method,
      available: hit.available !== false,
      cached: true,
    };
  }

  let firstVid = null;
  try {
    const raw = await getProductRaw(pid, priority);
    firstVid = raw?.variants?.[0]?.vid || null;
  } catch {}

  if (!firstVid) {
    return { usd: 0, method: null, available: false, cached: false };
  }

  const quote = await quoteShippingForItems([{ vid: firstVid, quantity: 1 }], priority);
  if (!quote) {
    return { usd: FALLBACK_SHIPPING_USD, method: 'fallback', available: true, cached: false };
  }

  shippingCache[pid] = {
    usd: quote.usd,
    method: quote.method,
    available: quote.available,
    ts: Date.now(),
  };
  saveShippingCache();
  return { ...quote, cached: false };
}

/** Cheap synchronous peek — does NOT call CJ. */
function peekShippingCache(pid) {
  const hit = shippingCache[pid];
  if (!hit || Date.now() - hit.ts > SHIPPING_CACHE_TTL) return null;
  return {
    usd: hit.usd,
    method: hit.method,
    available: hit.available !== false,
  };
}

/** Whole-cart shipping estimate used at checkout. */
async function quoteCartShippingUsd(items) {
  if (!Array.isArray(items) || !items.length) return FALLBACK_SHIPPING_USD;
  const key = 'shipCart:' + JSON.stringify(items.map(i => `${i.vid}x${i.quantity}`).sort());
  const cached = cacheGet(key, 30 * 60 * 1000);
  if (cached != null) return cached;
  const quote = await quoteShippingForItems(items);
  const usd = (quote && quote.available) ? quote.usd : FALLBACK_SHIPPING_USD;
  cacheSet(key, usd);
  return usd;
}

/**
 * Core pricing formula — the single source of truth for what a customer
 * sees.
 *
 *   true_cost = (CJ_api_wholesale × CJ_FEE_FACTOR) + CJ_shipping
 *   display   = true_cost × (1 + markup%)
 *
 * The CJ_FEE_FACTOR accounts for the ~11% service/processing fee CJ
 * adds on top of the raw API wholesale when you actually pay at order
 * time. Without it the markup would be applied to a lower base than
 * what CJ actually charges, eroding the real margin.
 */
function computeDisplayUsd(wholesaleUsd, shippingUsd) {
  const feeFactor = parseFloat(process.env.CJ_FEE_FACTOR) || 1.0;
  const wholesale = (parseFloat(wholesaleUsd) || 0) * feeFactor;
  const ship = parseFloat(shippingUsd) || 0;
  const m = pricing.getMarkupPercent() / 100;
  return Math.ceil((wholesale + ship) * (1 + m) * 100) / 100;
}

// ══════════════════════════════════════════════════════════════════
//  HEALTH
// ══════════════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  let cjOk = false;
  let cjError = null;
  try {
    await cj.ensureToken();
    cjOk = true;
  } catch (err) {
    cjError = err.message;
  }
  res.json({
    status: cjOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: '8.0',
    cj: cjOk ? 'connected' : 'disconnected',
    cjError,
    markup: pricing.getMarkupPercent() + '%',
    shipFrom: DEFAULT_SHIP_FROM,
    shipTo: DEFAULT_SHIP_TO,
    // Surface payment configuration so we can diagnose "online payment not
    // configured" without exposing the secret. "test" / "live" / "missing".
    razorpay: !razorpay
      ? 'missing'
      : (process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_live_')
        ? 'live'
        : 'test',
  });
});

// ══════════════════════════════════════════════════════════════════
//  AUTH — public registration / login / logout / me
// ══════════════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  try {
    const user = await auth.register(req.body || {});
    // Auto-login after register
    const { token } = await auth.login({ email: req.body.email, password: req.body.password });
    auth.setSessionCookie(res, token);
    res.json({ user, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { token, user } = await auth.login(req.body || {});
    auth.setSessionCookie(res, token);
    res.json({ user, token });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  auth.logout(req.sessionToken);
  auth.clearSessionCookie(res);
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: req.user });
});

app.patch('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  try {
    const updated = auth.updateProfile(req.user.id, req.body || {});
    res.json({ user: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Returns this user's orders. Logged-in users see all orders linked to them.
// ── Cart & wishlist persistence (auth-required) ──
// Both endpoints are full-replace PUT semantics: client owns the
// authoritative state and pushes the entire array on every change.
// That keeps frontend logic dead simple — no diff/patch protocol —
// at the cost of a few extra bytes per write. Cart payloads are
// tiny (4-10 items) so the overhead is negligible.

app.get('/api/auth/cart', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ cart: auth.getUserCart(req.user.id) });
});

app.put('/api/auth/cart', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  try {
    const cart = Array.isArray(req.body?.cart) ? req.body.cart : [];
    res.json({ cart: auth.setUserCart(req.user.id, cart) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/auth/wishlist', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ wishlist: auth.getUserWishlist(req.user.id) });
});

app.put('/api/auth/wishlist', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  try {
    const pids = Array.isArray(req.body?.wishlist) ? req.body.wishlist : [];
    res.json({ wishlist: auth.setUserWishlist(req.user.id, pids) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/auth/orders', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  const all = orders.getAllOrders({ page: 1, pageSize: 1000 }).orders;
  const mine = all.filter(o => o.userId === req.user.id);
  // Strip cost/profit from consumer view
  const safe = mine.map(o => ({
    id: o.id,
    status: o.status,
    grandTotal: (o.items || []).reduce((s, i) =>
      s + parseFloat(i.displayPrice || i.retailPrice || 0) * i.quantity, 0).toFixed(2),
    items: o.items.map(i => ({
      pid: i.pid, vid: i.vid, quantity: i.quantity,
      productName: i.productName, variantName: i.variantName,
      unitPrice: i.displayPrice || i.retailPrice,
    })),
    shippingAddress: o.shippingAddress,
    logisticName: o.logisticName,
    createdAt: o.createdAt,
  }));
  res.json({ orders: safe });
});

// ══════════════════════════════════════════════════════════════════
//  STORE — CONSUMER ENDPOINTS (profit/cost stripped)
// ══════════════════════════════════════════════════════════════════

// Public storefront config — currency, FX rate, brand name, ship-to default.
app.get('/api/store/config', (req, res) => {
  res.json({
    storeName: process.env.STORE_NAME || 'Befach',
    currency: process.env.STORE_CURRENCY || 'INR',
    usdToInr: parseFloat(process.env.USD_TO_INR) || 85,
    shipTo: DEFAULT_SHIP_TO,
    shipFrom: DEFAULT_SHIP_FROM,
    shippingMethods: SHIPPING_METHODS_PRIORITY,
    shippingNote: 'Shipping included in price',
  });
});

// TEMP debug: compare listV2 vs legacy list for the same query so we can
// see which endpoint returns more results. Remove once we've decided.
app.get('/api/store/_debug/compare', async (req, res) => {
  const { q, categoryId } = req.query;
  try {
    const [v2, legacy] = await Promise.all([
      cj.searchProducts({ keyWord: q, categoryId, page: 1, size: 20 }),
      cj.getProductList({ productNameEn: q, categoryId, page: 1, pageSize: 20 }),
    ]);
    const v2Total = v2.data?.total || v2.data?.totalRecords || 0;
    const v2Sample = (v2.data?.list || []).slice(0, 3).map(p => p.productNameEn || p.productName);
    const legacyTotal = legacy.data?.total || legacy.data?.totalRecords || 0;
    const legacySample = (legacy.data?.list || []).slice(0, 3).map(p => p.productNameEn || p.productName);
    res.json({
      query: { q: q || null, categoryId: categoryId || null },
      listV2: { total: v2Total, sample: v2Sample },
      legacyList: { total: legacyTotal, sample: legacySample },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Categories (cached 1h)
app.get('/api/store/categories', async (req, res) => {
  try {
    const cached = cacheGet('categories', 60 * 60 * 1000);
    if (cached) return res.json({ cached: true, data: cached });
    const data = await cj.getCategories();
    cacheSet('categories', data.data || []);
    res.json({ data: data.data || [] });
  } catch (err) {
    console.error('[Categories]', err.message);
    res.status(500).json({ error: 'Failed to load categories', detail: err.message });
  }
});

// Walk the cached category tree and return the human name for a CJ id.
// Used by the products endpoint to fall back to keyword search when
// listV2's categoryId index returns nothing — many leaf categories
// (e.g. "Woman Prescription Glasses") respond to a keyword search of
// the same name with 1000+ products but to a categoryId query with 0.
function categoryNameForId(id) {
  if (!id) return '';
  const tree = cacheGet('categories', Infinity) || [];
  for (const top of tree) {
    if (top.categoryFirstId === id) return top.categoryFirstName || '';
    for (const sec of (top.categoryFirstList || [])) {
      if (sec.categorySecondId === id) return sec.categorySecondName || '';
      for (const tri of (sec.categorySecondList || [])) {
        if (tri.categoryId === id) return tri.categoryName || '';
      }
    }
  }
  return '';
}

// ── Synthetic MRP / discount badge ────────────────────────────────
// E-commerce convention: show a struck-through "MRP" alongside the
// actual sell price with an "X% off" badge. CJ doesn't expose an MRP
// — they're a wholesale source — so we generate one deterministically
// from the product ID, picking a discount in a believable range and
// rounding the implied MRP to a "X99" / "X999" INR value.
//
// Deterministic: same product always shows the same MRP across page
// loads, so users don't see the discount jitter between visits.
function syntheticDiscountPct(pid) {
  if (!pid) return 35;
  // Cheap stable hash → bucket index. Buckets weighted toward the
  // 30–50 range that competitors typically advertise.
  let h = 0;
  const s = String(pid);
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  const buckets = [25, 28, 30, 32, 35, 37, 40, 42, 45, 47, 50, 52, 55, 58, 62];
  return buckets[Math.abs(h) % buckets.length];
}

function computeOfferPricing(pid, displayUsd) {
  if (!displayUsd || displayUsd <= 0) return null;
  const targetPct = syntheticDiscountPct(pid);
  const exactMrpUsd = displayUsd / (1 - targetPct / 100);

  // Round in INR space — that's where the user sees aesthetic numbers
  // ("₹7,999" vs the ugly "₹7,923" you'd get from raw conversion).
  const usdToInr = parseFloat(process.env.USD_TO_INR) || 85;
  const exactInr = exactMrpUsd * usdToInr;
  let step;
  if (exactInr < 100)        step = 10;
  else if (exactInr < 1000)  step = 100;
  else if (exactInr < 10000) step = 1000;
  else                       step = 10000;
  const niceInr = Math.ceil(exactInr / step) * step - 1; // X99 ending
  const niceMrpUsd = niceInr / usdToInr;

  // Recompute the displayed discount from the rounded MRP so the math
  // shown to the user is internally consistent.
  const actualDiscount = Math.max(1, Math.round((niceMrpUsd - displayUsd) / niceMrpUsd * 100));

  return {
    mrp: niceMrpUsd.toFixed(2),
    discountPercent: actualDiscount,
  };
}

// Parse a CJ listV2 response into our normalised meta shape.
function parseListV2(data, pageSize) {
  let products = [];
  let total = 0;
  let totalPages = 1;
  if (data.data?.list) {
    products = data.data.list;
    total = data.data.total || products.length;
    totalPages = Math.ceil(total / pageSize);
  } else if (data.data?.content) {
    data.data.content.forEach(group => {
      if (group.productList) products.push(...group.productList);
    });
    total = data.data.totalRecords || products.length;
    totalPages = data.data.totalPages || Math.ceil(total / pageSize);
  }
  return { products, total, totalPages };
}

// Smart keyword search that merges CJ's two product endpoints to maximize
// catalog coverage. Why both:
//
//   - /product/listV2 is precise but severely under-indexed. Probing showed
//     "earbuds" → 2 results, "watch" → 360, "glasses" → 1, while CJ's seller
//     dashboard shows thousands for those same queries.
//   - /product/list (legacy) hits the full catalog (15k+ "watch" results),
//     but for multi-word queries it does word-OR matching: "smart glasses"
//     returns 9149 because it also matches "Smart Bracelet", "Wine Glasses",
//     etc.
//
// Strategy:
//   1. Fetch both endpoints in parallel.
//   2. For multi-word queries, post-filter legacy results to those whose
//      productNameEn contains EVERY query token (case-insensitive AND).
//      This collapses "smart glasses" from 9149 fuzzy hits down to actual
//      smart-glasses products.
//   3. Union by productId, dedupe, and return.
//
// For pure category browse (no keyWord) we just use listV2 — categoryId
// filtering on the legacy endpoint is unreliable.
async function searchProductsMerged({ keyWord, categoryId, page, size }) {
  if (!keyWord) {
    const data = await cj.searchProducts({ keyWord, categoryId, page, size });
    return parseListV2(data, size);
  }

  const tokens = String(keyWord).toLowerCase().split(/\s+/).filter(Boolean);
  const isMultiWord = tokens.length > 1;
  const matchesAll = (p) => {
    const name = String(p.productNameEn || p.productName || '').toLowerCase();
    return tokens.every(t => name.includes(t));
  };

  // Pagination depth tuned for perceived latency:
  //   - size > 12 (real search page) + multi-word → 2 legacy pages
  //     ≈ 560ms on the legacy queue, parallel with listV2's 280ms.
  //     Probes showed 5 pages cost 3s cold and the marginal coverage
  //     past page 2 is small for most queries.
  //   - small sizes (home rows, related lists) → 1 page so home
  //     sections all complete in ~280ms.
  //   - single-word → 1 page (legacy already matches strictly with
  //     a single token, no need for deeper fetch).
  const isWideSearch = size > 12;
  const legacyPagesToFetch = isMultiWord && isWideSearch ? 2 : 1;
  const legacyCalls = [];
  for (let i = 0; i < legacyPagesToFetch; i++) {
    legacyCalls.push(cj.getProductList({
      productNameEn: keyWord,
      categoryId,
      page: page + i,
      pageSize: 20,
    }));
  }

  const [v2Result, ...legacyResults] = await Promise.allSettled([
    cj.searchProducts({ keyWord, categoryId, page, size }),
    ...legacyCalls,
  ]);

  const v2 = v2Result.status === 'fulfilled'
    ? parseListV2(v2Result.value, size)
    : { products: [], total: 0, totalPages: 1 };

  // Aggregate legacy items across all fetched pages. Track the page-1
  // total separately because that's the legacy index's authoritative
  // OR-matched count (later pages don't update the total).
  let legacyAllItems = [];
  let legacyRawTotal = 0;
  legacyResults.forEach((r, idx) => {
    if (r.status !== 'fulfilled') return;
    const items = r.value?.data?.list || [];
    legacyAllItems = legacyAllItems.concat(items);
    if (idx === 0) {
      legacyRawTotal = r.value?.data?.total || items.length;
    }
  });

  // Strict-AND filter both endpoints for multi-word queries. listV2's
  // elasticsearch returns category-tagged matches that don't contain
  // every keyword in the name (e.g. "Pet Glasses Dog" for "smart
  // glasses"), so we drop those too — not just legacy. If filtering
  // leaves us with too few results we fall back to unfiltered below.
  const legacyFiltered = isMultiWord ? legacyAllItems.filter(matchesAll) : legacyAllItems;
  const v2Filtered     = isMultiWord ? v2.products.filter(matchesAll)    : v2.products;

  const unionByPid = (...lists) => {
    const seen = new Set();
    const out = [];
    for (const list of lists) for (const item of list) {
      const pid = item.pid || item.id || item.productId;
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      out.push(item);
    }
    return out;
  };

  let merged = unionByPid(v2Filtered, legacyFiltered);

  // Fallback: if strict-AND filtering gave us nothing useful (CJ's catalog
  // genuinely has very few products literally named "smart glasses" —
  // most are tagged by category instead), fall back to the unfiltered
  // listV2 results so the user sees *something* relevant rather than an
  // empty page. The sort below still tries to float real matches up.
  let usedFallback = false;
  if (isMultiWord && merged.length < 4) {
    merged = unionByPid(v2Filtered, legacyFiltered, v2.products, legacyAllItems);
    usedFallback = true;
  }

  // Sort: strict name matches first regardless of source ranking. For
  // "smart glasses" this puts real smart-glasses items above pet glasses
  // that survive only via the fallback union.
  if (isMultiWord) {
    const strictMatches = [];
    const otherMatches = [];
    for (const p of merged) (matchesAll(p) ? strictMatches : otherMatches).push(p);
    merged = [...strictMatches, ...otherMatches];
  }

  // Total estimate. When we used the fallback path, the filtered counts
  // are misleadingly low — fall back to listV2 total. Otherwise scale
  // legacy total by the observed across-pages strict-match rate.
  let total;
  if (isMultiWord && !usedFallback && legacyAllItems.length > 0) {
    const matchRate = legacyFiltered.length / legacyAllItems.length;
    total = Math.max(Math.round(legacyRawTotal * matchRate), v2Filtered.length, merged.length);
  } else if (isMultiWord && usedFallback) {
    // Fallback view: total is what listV2 has + any extra strict matches.
    total = Math.max(v2.total, merged.length);
  } else {
    total = Math.max(legacyRawTotal, v2.total, merged.length);
  }

  return {
    products: merged,
    total,
    totalPages: Math.max(Math.ceil(total / size), 1),
  };
}

// Product list / search.
//
// We cache the RAW CJ product list (5 min TTL) — not the final payload —
// because shipping cache fills in the background and we want list pages
// to reflect that the moment it updates. On each request we re-bake
// shipping from the disk-backed shipping cache.
// CJ SKU shape: "CJ" + 6+ alphanumerics. Examples seen in catalog:
// "CJYD2338013", "CJYD186929102BY". When the user pastes one of these
// into search we route directly to a product-by-sku lookup instead of
// running a useless name-search keyword query (which always returns 0).
const SKU_PATTERN = /^CJ[A-Z0-9]{6,}$/i;

app.get('/api/store/products', async (req, res) => {
  try {
    const { keyWord, page, size, categoryId, strictShippable } = req.query;
    const wantStrict = strictShippable === '1' || strictShippable === 'true';
    const pageSize = Math.min(parseInt(size) || 20, 40);
    const trimmedKw = (keyWord || '').trim();

    const rawKey = productsRawKey({
      keyWord: keyWord || '', page: page || '1', size: size || '20', categoryId: categoryId || '',
    });

    // Cache for 30 min. The home page rotates keywords by day-of-year so
    // today's pick stays the same all day; product detail pages and search
    // pages also benefit from longer TTL since CJ's catalog rarely
    // changes within the day. (Was 5 min — too aggressive; users on
    // returning visits saw the cold-CJ rate-limit queue serialise and
    // perceived the site as slow.)
    let meta = cacheGet(rawKey, 30 * 60 * 1000);

    // SKU short-circuit: if the keyword looks like a CJ SKU
    // ("CJYD186929102BY", "CJYD2338013", etc.), the keyword path
    // would always return 0 — CJ's keyWord search doesn't index
    // SKUs. Instead resolve directly via /product/query?productSku=
    // and return that single product. Saves a useless multi-page
    // CJ search and lets users find anything they paste from the
    // CJ seller dashboard.
    if (!meta && trimmedKw && SKU_PATTERN.test(trimmedKw)) {
      try {
        const data = await cj.getProductBySku(trimmedKw);
        const product = data?.data;
        if (product && (product.pid || product.id || product.productId)) {
          meta = { products: [product], total: 1, totalPages: 1 };
          cacheSet(rawKey, meta);
        }
      } catch (e) {
        console.warn(`[products] SKU lookup "${trimmedKw}" failed:`, e.message);
        // Fall through to normal keyword path so a non-SKU string that
        // happens to match the regex still gets searched normally.
      }
    }

    if (!meta) {
      meta = await searchProductsMerged({
        keyWord,
        categoryId,
        page: parseInt(page) || 1,
        size: pageSize,
      });

      // CJ's listV2 categoryId index has gaps — many leaf-level categories
      // return 0 even though products clearly exist. If we got nothing AND
      // we were querying by id, retry with the category name as a keyword.
      // This recovers entire empty pages (e.g. Woman/Man Prescription
      // Glasses → 1000+ products via keyword). The merged search above
      // already calls both endpoints, so this fallback only fires when the
      // category is genuinely empty in both.
      if (meta.products.length === 0 && categoryId && !keyWord) {
        const fallbackName = categoryNameForId(categoryId);
        if (fallbackName) {
          console.log(`[products] categoryId ${categoryId} empty → retrying as keyword "${fallbackName}"`);
          try {
            const meta2 = await searchProductsMerged({
              keyWord: fallbackName,
              page: parseInt(page) || 1,
              size: pageSize,
            });
            if (meta2.products.length > 0) meta = meta2;
          } catch (e) {
            console.warn(`[products] keyword fallback failed:`, e.message);
          }
        }
      }

      cacheSet(rawKey, meta);
    }

    // For each product, decide whether to show it:
    //   1. Cached AND shippable to India → real (wholesale + shipping) × (1+markup).
    //   2. Cached AND known-unshippable  → SKIP (default). User explicitly
    //      asked not to see "Not available in your region" anywhere.
    //   3. Not cached                    → keep with fallback shipping
    //      price + queue background warm. If warming returns unshippable
    //      the frontend backfill will remove the card.
    //
    // Lenient fallback: if filtering removes EVERY product (keyword landed
    // on a row where shipping cache happens to mark all hits as
    // unshippable), we re-run the loop without the unshippable skip so
    // the section isn't empty. The frontend's backfill cleanup will prune
    // genuinely-unshippable cards as it warms each pid.
    //
    // The admin blocklist always applies, both passes.
    function buildPriced({ allowUnshippable }) {
      const out = [];
      const toWarm = [];
      for (const rawProduct of meta.products) {
        const pid = rawProduct.pid || rawProduct.id || rawProduct.productId || '';
        const wholesaleUsd = parseFloat(rawProduct.sellPrice || rawProduct.nowPrice || 0);

        if (isBlocked(pid)) continue;
        const hit = peekShippingCache(pid);
        if (!allowUnshippable && hit && hit.available === false) continue;
        if (!hit && pid) toWarm.push(pid);

        out.push({ rawProduct, pid, wholesaleUsd, hit });
      }
      return { items: out, toWarm };
    }

    let { items: pricedItems, toWarm: unwarmedToWarm } = buildPriced({ allowUnshippable: false });
    if (pricedItems.length === 0 && (meta.products || []).length > 0) {
      console.log(`[products] strict-shippable filter killed all results for keyWord="${keyWord || ''}" categoryId="${categoryId || ''}" — falling back to lenient`);
      ({ items: pricedItems, toWarm: unwarmedToWarm } = buildPriced({ allowUnshippable: true }));
    }

    const priced = [];
    for (const { rawProduct, pid, wholesaleUsd, hit } of pricedItems) {
      const knownGood = !!(hit && hit.available);
      const shippingUsd = knownGood ? hit.usd : FALLBACK_SHIPPING_USD;
      const displayUsd = computeDisplayUsd(wholesaleUsd, shippingUsd);

      // Strip sensitive fields (CJ cost, profit, etc.) before sending to consumer
      const cleaned = pricing.applyStorePricing(rawProduct);
      const offer = computeOfferPricing(pid, displayUsd);
      priced.push({
        ...cleaned,
        sellPrice: displayUsd.toFixed(2),
        price: displayUsd.toFixed(2),
        mrp: offer?.mrp,
        discountPercent: offer?.discountPercent,
        shippingMethod: knownGood ? hit.method : null,
        shippingAccurate: knownGood,
        shippingIncluded: true,
        shippingAvailable: !hit || hit.available !== false,
      });
    }

    // Fire-and-forget background warming so the next visit to this listing
    // (or to one of these products) returns from cache. Capped per page
    // to avoid blowing the daily CJ quota on a single load.
    //
    //   Free:     10/page   (~1000/day quota)
    //   Verified: 50/page   (~86400/day, 1 req/sec)
    //   Prime:   150/page   (~86400+/day, 4 req/sec) ← we are here
    //
    // The freight queue runs at low priority, so user-triggered detail
    // clicks still jump ahead.
    const WARM_PER_REQUEST = 150;
    for (const pid of unwarmedToWarm.slice(0, WARM_PER_REQUEST)) {
      getProductShippingUsd(pid, 'low').catch(() => {});
    }

    res.json({
      products: priced,
      total: meta.total,
      page: parseInt(page) || 1,
      totalPages: meta.totalPages,
      // Frontend uses this to know whether to retry without strict
      strictShippable: wantStrict,
      unverifiedCount: unwarmedToWarm.length,
    });
  } catch (err) {
    console.error('[Store Products]', err.message);
    res.status(500).json({ error: 'Failed to load products', detail: err.message });
  }
});

// Backfill endpoint: return real CJ shipping for one product.
// Frontend calls this for each card whose `shippingAccurate` was false,
// and also needs the product's wholesale price to compute the all-in
// display price with markup. Heavily cached on disk (24h TTL).
app.get('/api/store/shipping-for/:pid', async (req, res) => {
  try {
    const pid = req.params.pid;
    // Medium priority — these calls are for cards the user is currently
    // looking at, so they should jump ahead of any background warming
    // work but yield to high-priority detail clicks.
    const { usd, method, available, cached } = await getProductShippingUsd(pid, 'medium');

    if (!available) {
      return res.json({ pid, available: false });
    }

    let wholesaleUsd = 0;
    try {
      const raw = await getProductRaw(pid, 'medium');
      wholesaleUsd = parseFloat(raw?.sellPrice || raw?.variants?.[0]?.variantSellPrice || 0);
    } catch {}

    const displayUsd = computeDisplayUsd(wholesaleUsd, usd);
    const offer = computeOfferPricing(pid, displayUsd);
    res.json({
      pid,
      available: true,
      shippingUsd: usd.toFixed(2),
      method,
      displayUsd: displayUsd.toFixed(2),
      mrp: offer?.mrp,
      discountPercent: offer?.discountPercent,
      cached,
    });
  } catch (err) {
    console.error('[Shipping For]', err.message);
    res.status(500).json({ error: 'Shipping lookup failed', detail: err.message });
  }
});

// Product detail — includes variants. Cached 10 min.
// We quote real CJPacket Asia Ordinary shipping for variants[0] and assume
// the other variants have the same shipping (they're the same product,
// usually same weight). That keeps us to 1 freight-API call per product
// detail view instead of N variants × 1 call each.
app.get('/api/store/products/:pid', async (req, res) => {
  try {
    const pid = req.params.pid;
    if (isBlocked(pid)) {
      return res.status(404).json({ error: 'Product not available', code: 'BLOCKED' });
    }
    // High priority so user-clicks jump ahead of background backfill
    const raw = await getProductRaw(pid, 'high');
    if (!raw) return res.status(404).json({ error: 'Product not found' });

    const shipResult = await getProductShippingUsd(pid, 'high');
    if (!shipResult.available) {
      return res.status(404).json({
        error: 'Not available for shipping to India',
        code: 'UNSHIPPABLE',
      });
    }
    const shippingUsd = shipResult.usd;
    const shippingMethod = shipResult.method;

    const rawVariants = raw.variants || [];
    const variants = rawVariants.map(v => {
      const wholesaleUsd = parseFloat(v.variantSellPrice || 0);
      const displayUsd = computeDisplayUsd(wholesaleUsd, shippingUsd);
      // Strip any CJ-cost fields that the pricing engine would flag
      const clean = { ...v };
      delete clean.variantDiscountPrice;
      delete clean.variantDiscountPercent;
      return {
        ...clean,
        price: displayUsd.toFixed(2),
        variantSellPrice: displayUsd.toFixed(2),
        shippingUsd: shippingUsd.toFixed(2),
      };
    });

    // Top-level product display price — based on the first variant's wholesale,
    // so list (which uses product.sellPrice) and detail agree.
    const product = pricing.applyStorePricing(raw);
    const topWholesaleUsd = parseFloat(raw.variants?.[0]?.variantSellPrice || raw.sellPrice || 0);
    const topDisplayUsd = computeDisplayUsd(topWholesaleUsd, shippingUsd);

    product.sellPrice = topDisplayUsd.toFixed(2);
    product.price = topDisplayUsd.toFixed(2);
    const offer = computeOfferPricing(pid, topDisplayUsd);
    product.mrp = offer?.mrp;
    product.discountPercent = offer?.discountPercent;
    product.shippingUsd = shippingUsd.toFixed(2);
    product.shippingMethod = shippingMethod;
    product.shippingIncluded = true;
    product.available = true;
    product.variants = variants;

    res.json({ product });
  } catch (err) {
    console.error('[Store Detail]', err.message);
    res.status(500).json({ error: 'Failed to load product', detail: err.message });
  }
});

// Per-variant shipping + final display price (weight may differ between
// sizes → different rates). Frontend calls this when the user switches
// variants on the product page.
//
// Also needs the variant's wholesale price to compute the final display
// price — the client sends it as a query param (?pid=...) so we can
// fetch the detail (cached) and look up the variant's wholesale.
app.get('/api/store/shipping-for-variant/:vid', async (req, res) => {
  try {
    const vid = req.params.vid;
    const pid = req.query.pid || '';
    const key = 'shipVarFull:' + vid;
    const cached = cacheGet(key, 24 * 60 * 60 * 1000);
    if (cached) return res.json(cached);

    const quote = await quoteShippingForItems([{ vid, quantity: 1 }]);
    if (!quote || !quote.available) {
      const payload = { vid, available: false };
      cacheSet(key, payload);
      return res.json(payload);
    }

    // Look up this variant's wholesale to compute the final display price
    let wholesaleUsd = 0;
    if (pid) {
      try {
        const raw = await getProductRaw(pid, 'high');
        const v = (raw?.variants || []).find(x => x.vid === vid);
        wholesaleUsd = parseFloat(v?.variantSellPrice || 0);
      } catch {}
    }
    const displayUsd = computeDisplayUsd(wholesaleUsd, quote.usd);

    const payload = {
      vid,
      available: true,
      shippingUsd: quote.usd.toFixed(2),
      method: quote.method,
      displayUsd: displayUsd.toFixed(2),
    };
    cacheSet(key, payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stock for a specific variant. Cached 60s (inventory moves, don't cache long).
app.get('/api/store/stock/:vid', async (req, res) => {
  try {
    const cacheKey = 'stock:' + req.params.vid;
    const cached = cacheGet(cacheKey, 60 * 1000);
    if (cached) return res.json(cached);

    const data = await cj.getVariantStock(req.params.vid);
    const rows = Array.isArray(data.data) ? data.data : [];
    const total = rows.reduce((s, w) => s + (w.totalInventoryNum || w.storageNum || 0), 0);
    const payload = { vid: req.params.vid, total };
    cacheSet(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: 'Stock check failed', detail: err.message });
  }
});

// Whole-cart shipping estimate (used at checkout). Tries Ordinary then
// Sensitive; falls back to flat if neither is offered.
app.post('/api/store/shipping-estimate', async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array required' });
    }
    const usd = await quoteCartShippingUsd(items);
    res.json({ shippingUsd: usd.toFixed(2) });
  } catch (err) {
    console.error('[Shipping Estimate]', err.message);
    res.status(500).json({ error: 'Shipping estimate failed', detail: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  RAZORPAY — payment intent + signature verification + webhook
// ══════════════════════════════════════════════════════════════════

/**
 * Re-price a cart server-side (we never trust the client total).
 * Returns { totalPaise, totalUsd, items: [{...item, displayPrice}] } or
 * throws on validation errors so the caller can short-circuit.
 */
async function repriceCart(items) {
  if (!Array.isArray(items) || items.length === 0) {
    const e = new Error('items required'); e.status = 400; throw e;
  }
  let totalUsd = 0;
  const priced = [];
  for (const item of items) {
    if (!item.pid || !item.vid || !item.quantity) {
      const e = new Error('each item needs pid, vid, quantity'); e.status = 400; throw e;
    }
    if (isBlocked(item.pid)) {
      const e = new Error('Item not available'); e.status = 400; e.code = 'BLOCKED'; throw e;
    }
    const raw = await getProductRaw(item.pid, 'high');
    if (!raw) { const e = new Error(`Unknown product ${item.pid}`); e.status = 400; throw e; }
    const variant = (raw.variants || []).find(v => v.vid === item.vid);
    if (!variant) { const e = new Error(`Unknown variant ${item.vid}`); e.status = 400; throw e; }

    const shipping = await getProductShippingUsd(item.pid, 'high', ORDER_FRESH_MAX_MS);
    if (!shipping.available) {
      const e = new Error(`"${raw.productNameEn}" is not available for shipping to India`);
      e.status = 400; e.code = 'UNSHIPPABLE'; e.pid = item.pid; throw e;
    }
    const wholesale = parseFloat(variant.variantSellPrice || 0);
    const displayUsd = computeDisplayUsd(wholesale, shipping.usd);
    const lineUsd = displayUsd * parseInt(item.quantity);
    totalUsd += lineUsd;

    priced.push({
      pid: item.pid,
      vid: item.vid,
      quantity: parseInt(item.quantity),
      productName: raw.productNameEn || '',
      variantName: variant.variantNameEn || variant.variantKey || '',
      cjPrice: (wholesale * (parseFloat(process.env.CJ_FEE_FACTOR) || 1)).toFixed(2),
      apiWholesale: wholesale.toFixed(2),
      retailPrice: displayUsd.toFixed(2),
      shippingPerUnit: shipping.usd.toFixed(2),
      shippingMethod: shipping.method,
      displayPrice: displayUsd.toFixed(2),
    });
  }
  // Customer pays in INR. We store paise (integer) so we never lose
  // half-rupees to floating point.
  const usdToInr = parseFloat(process.env.USD_TO_INR) || 85;
  const totalInr = totalUsd * usdToInr;
  const totalPaise = Math.round(totalInr * 100);
  return { totalPaise, totalUsd, totalInr, priced };
}

/**
 * Create a Razorpay Order (the customer-facing payment intent).
 * The frontend calls this to start a payment, then opens Razorpay's
 * checkout modal with the returned ids. Amount is computed server-side.
 */
app.post('/api/store/payment/create-order', async (req, res) => {
  if (!razorpay) {
    return res.status(503).json({ error: 'Online payment is not configured' });
  }
  try {
    const { items } = req.body || {};
    const { totalPaise, totalInr, priced } = await repriceCart(items);
    if (totalPaise < 100) {
      return res.status(400).json({ error: 'Minimum order amount is ₹1' });
    }
    const rzOrder = await razorpay.orders.create({
      amount: totalPaise,
      currency: 'INR',
      receipt: 'BF-' + Date.now().toString(36).toUpperCase(),
      notes: {
        itemCount: String(priced.length),
        firstProduct: priced[0]?.productName?.slice(0, 60) || '',
      },
    });
    res.json({
      razorpayOrderId: rzOrder.id,
      amount: rzOrder.amount,        // paise
      amountInr: totalInr.toFixed(2),
      currency: rzOrder.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      // Echo the priced items so the frontend can show the same total
      itemsCount: priced.length,
    });
  } catch (err) {
    console.error('[Razorpay create-order]', err.message, err.code || '');
    res.status(err.status || 500).json({
      error: err.message || 'Failed to create payment',
      code: err.code,
      pid: err.pid,
    });
  }
});

/**
 * Verify Razorpay's webhook-style signature handshake.
 * Per Razorpay docs: HMAC-SHA256( razorpay_order_id + "|" + razorpay_payment_id, key_secret )
 */
function verifyRazorpaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return false;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  // timingSafeEqual requires equal-length buffers
  const a = Buffer.from(expected);
  const b = Buffer.from(razorpay_signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Razorpay webhook receiver — fires for payment.captured, payment.failed,
 * refund.created, etc. We mostly use this as a safety net: even if the
 * customer closed their browser before our /orders POST landed, this
 * webhook catches the captured payment so we can reconcile later.
 *
 * NOTE: needs the RAW request body to verify the signature. We mount this
 * with express.raw() above the global json parser via the wrapper below.
 */
app.post('/api/webhooks/razorpay', (req, res) => {
  try {
    const sig = req.headers['x-razorpay-signature'];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!sig || !secret || !req.rawBody) return res.status(200).end(); // accept silently if not configured
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    if (sig !== expected) return res.status(401).end();
    const event = req.body || {};
    console.log('[Razorpay webhook]', event.event, event.payload?.payment?.entity?.id || '');
    // For now we just log. Future: persist payment record so /orders can
    // reconcile without depending on the client's POST.
    res.status(200).end();
  } catch (err) {
    console.warn('[Razorpay webhook] error:', err.message);
    res.status(200).end(); // always 2xx so Razorpay doesn't retry forever
  }
});

// Place an order. Online payment only — the customer must have completed
// a Razorpay payment first; we verify the signature server-side before
// pushing anything to CJ.
app.post('/api/store/orders', async (req, res) => {
  try {
    const {
      customer, items, shippingAddress, logisticName, consigneeID,
      razorpay_payment_id, razorpay_order_id, razorpay_signature,
    } = req.body;
    if (!customer || !customer.name || !customer.phone) {
      return res.status(400).json({ error: 'customer.name and customer.phone required' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items required' });
    }
    if (!shippingAddress || !shippingAddress.address || !shippingAddress.city) {
      return res.status(400).json({ error: 'shippingAddress.address and city required' });
    }
    // India customs requires Aadhaar (12 digits) or PAN (10 chars). CJ
    // rejects with "Consignee ID required" if missing for Indian addresses.
    const ccode = (shippingAddress.countryCode || 'IN').toUpperCase();
    if (ccode === 'IN' && !consigneeID) {
      return res.status(400).json({
        error: 'Aadhaar or PAN is required for shipping to India (customs clearance)',
      });
    }

    // ── Payment gate: must have a verified Razorpay payment ─────────
    if (!razorpay) {
      return res.status(503).json({ error: 'Online payment is not configured on the server' });
    }
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Payment is required before placing an order' });
    }
    if (!verifyRazorpaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature })) {
      return res.status(400).json({ error: 'Payment signature mismatch — please retry payment' });
    }
    // Idempotency — if we've already created an order for this payment id,
    // return the existing one instead of double-booking with CJ.
    const existing = orders.getAllOrders({ page: 1, pageSize: 5000 }).orders
      .find(o => o.razorpay_payment_id === razorpay_payment_id);
    if (existing) {
      return res.json({ success: true, alreadyExisted: true, order: { id: existing.id, status: existing.status } });
    }
    // Re-fetch the payment from Razorpay so we know it's actually captured
    // and the amount matches what we'd charge for this cart. Without this,
    // a tampered client could re-use a tiny payment for a giant cart.
    let paymentRecord;
    try {
      paymentRecord = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (e) {
      return res.status(400).json({ error: 'Could not verify payment with Razorpay: ' + e.message });
    }
    if (paymentRecord.status !== 'captured' && paymentRecord.status !== 'authorized') {
      return res.status(400).json({ error: `Payment not captured (status: ${paymentRecord.status})` });
    }

    // Re-price server-side — never trust the cart prices from the client.
    // Formula: displayPrice = (CJ_wholesale + CJ_shipping) × (1 + markup)
    const pricedItems = [];
    const methodCounts = { 'CJPacket Asia Ordinary': 0, 'CJPacket Asia Sensitive': 0 };
    for (const item of items) {
      if (!item.pid || !item.vid || !item.quantity) {
        return res.status(400).json({ error: 'each item needs pid, vid, quantity' });
      }
      if (isBlocked(item.pid)) {
        return res.status(400).json({
          error: 'One of the items in your cart is no longer available. Please remove it and try again.',
          code: 'BLOCKED',
          pid: item.pid,
        });
      }
      const raw = await getProductRaw(item.pid, 'high');
      if (!raw) return res.status(400).json({ error: `Unknown product ${item.pid}` });
      const variant = (raw.variants || []).find(v => v.vid === item.vid);
      if (!variant) return res.status(400).json({ error: `Unknown variant ${item.vid} for product ${item.pid}` });

      // Order placement: insist on shipping data ≤7 days old. If the
      // display cache is older, we re-quote so we never charge stale
      // (potentially below-cost) prices when CJ has changed rates.
      const shipping = await getProductShippingUsd(item.pid, 'high', ORDER_FRESH_MAX_MS);
      if (!shipping.available) {
        return res.status(400).json({
          error: `"${raw.productNameEn}" is not available for shipping to India`,
          code: 'UNSHIPPABLE',
          pid: item.pid,
        });
      }
      const apiWholesale = parseFloat(variant.variantSellPrice || 0);
      const feeFactor = parseFloat(process.env.CJ_FEE_FACTOR) || 1.0;
      // True cost per unit = what CJ will actually charge us at order time
      const trueWholesale = apiWholesale * feeFactor;
      const displayPrice = computeDisplayUsd(apiWholesale, shipping.usd);
      if (methodCounts[shipping.method] != null) methodCounts[shipping.method]++;

      pricedItems.push({
        pid: item.pid,
        vid: item.vid,
        quantity: parseInt(item.quantity),
        productName: raw.productNameEn || '',
        variantName: variant.variantNameEn || variant.variantKey || '',
        // Store the TRUE wholesale (with CJ fee applied) so admin profit
        // math matches reality when the order is actually paid.
        cjPrice: trueWholesale.toFixed(2),
        apiWholesale: apiWholesale.toFixed(2),
        retailPrice: displayPrice.toFixed(2),
        shippingPerUnit: shipping.usd.toFixed(2),
        shippingMethod: shipping.method,
        displayPrice: displayPrice.toFixed(2),
      });
    }

    const chosenMethod = methodCounts['CJPacket Asia Ordinary'] > 0
      ? 'CJPacket Asia Ordinary'
      : (methodCounts['CJPacket Asia Sensitive'] > 0 ? 'CJPacket Asia Sensitive' : SHIPPING_METHODS_PRIORITY[0]);

    // Confirm Razorpay's captured amount actually matches what we'd charge
    // for this priced cart. Prevents a tampered client from paying ₹1 and
    // claiming a ₹10,000 order. We allow a small tolerance for rounding.
    const usdToInr = parseFloat(process.env.USD_TO_INR) || 85;
    const expectedTotalPaise = Math.round(
      pricedItems.reduce((s, i) => s + parseFloat(i.displayPrice) * i.quantity, 0) * usdToInr * 100
    );
    const tolerancePaise = 200; // ₹2 wiggle room for INR rounding
    if (Math.abs(paymentRecord.amount - expectedTotalPaise) > tolerancePaise) {
      return res.status(400).json({
        error: 'Payment amount does not match cart total. Please refresh and try again.',
        paid: paymentRecord.amount,
        expected: expectedTotalPaise,
      });
    }

    const order = await orders.createOrder({
      customer,
      items: pricedItems,
      shippingAddress,
      consigneeID,
      logisticName: chosenMethod,
      // Link the verified Razorpay payment so it shows up in admin and
      // protects against duplicate-order replays via the idempotency check.
      razorpay_payment_id,
      razorpay_order_id,
      paymentMethod: 'razorpay',
      paymentStatus: paymentRecord.status,
      paymentAmountPaise: paymentRecord.amount,
      // If the customer was signed in when placing the order, link it to
      // their account so it appears in their order history.
      userId: req.user?.id || null,
    });

    // Customer-facing grand total = sum of displayPrice × qty
    // (retail + per-item flat shipping). Matches what they saw in the cart.
    const grandTotal = pricedItems
      .reduce((s, i) => s + parseFloat(i.displayPrice) * i.quantity, 0)
      .toFixed(2);

    res.json({
      success: true,
      order: {
        id: order.id,
        status: order.status,
        grandTotal,
        items: order.items.map(i => ({
          pid: i.pid,
          vid: i.vid,
          quantity: i.quantity,
          productName: i.productName,
          variantName: i.variantName,
          unitPrice: i.displayPrice,  // all-in per-unit price
        })),
        shippingAddress: order.shippingAddress,
        logisticName: order.logisticName,
        shippingIncluded: true,
        createdAt: order.createdAt,
      },
    });
  } catch (err) {
    console.error('[Create Order]', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create order', detail: err.message });
  }
});

// Track order (consumer)
app.get('/api/store/orders/:id', async (req, res) => {
  try {
    const order = orders.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    let tracking = null;
    let cjStatus = null;
    if (order.cjOrderId) {
      try {
        const cjOrder = await cj.getOrderDetail(order.cjOrderId);
        if (cjOrder.data) {
          cjStatus = cjOrder.data.orderStatus;
          if (cjOrder.data.trackNumber) {
            const trackRes = await cj.trackInfo(cjOrder.data.trackNumber);
            tracking = { trackNumber: cjOrder.data.trackNumber, events: trackRes.data || [] };
          }
        }
      } catch (e) { /* swallow — tracking is best-effort */ }
    }

    // Strip profit/cost before sending to consumer. Show all-in display
    // price and a grand total that matches what they paid.
    const grandTotal = (order.items || [])
      .reduce((s, i) => s + parseFloat(i.displayPrice || i.retailPrice || 0) * i.quantity, 0)
      .toFixed(2);
    const safeOrder = {
      id: order.id,
      status: order.status,
      cjStatus,
      grandTotal,
      shippingIncluded: true,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      items: order.items.map(i => ({
        pid: i.pid,
        vid: i.vid,
        quantity: i.quantity,
        productName: i.productName,
        variantName: i.variantName,
        unitPrice: i.displayPrice || i.retailPrice,
      })),
      shippingAddress: order.shippingAddress,
      logisticName: order.logisticName,
    };
    res.json({ order: safeOrder, tracking });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get order', detail: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  ADMIN — password-protected via x-admin-password header or ?pw=
// ══════════════════════════════════════════════════════════════════
function adminAuth(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.pw;
  if (!process.env.ADMIN_PASSWORD || pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/admin/dashboard', adminAuth, (req, res) => {
  res.json(orders.getDashboardStats());
});

// Admin Customers panel — every signed-up user with an order rollup.
// Joins users.json against orders.json so the table shows lifetime
// order count + revenue per customer alongside contact info. Live
// session indicator surfaces who's currently logged in (active session).
app.get('/api/admin/users', adminAuth, (req, res) => {
  try {
    const userList = auth.listUsers();
    // Build a per-user rollup from the orders ledger
    const rollup = {};
    for (const o of orders.getAllOrders({ page: 1, pageSize: 100000 }).orders || []) {
      const uid = o.userId;
      if (!uid) continue; // guest checkout — no user account
      if (!rollup[uid]) rollup[uid] = { orderCount: 0, totalRevenue: 0, lastOrderAt: null };
      rollup[uid].orderCount += 1;
      rollup[uid].totalRevenue += parseFloat(o.productTotal || o.grandTotal || 0) || 0;
      const t = o.createdAt ? new Date(o.createdAt).getTime() : 0;
      if (t > (rollup[uid].lastOrderAt || 0)) rollup[uid].lastOrderAt = t;
    }
    const enriched = userList.map(u => ({
      ...u,
      orderCount: rollup[u.id]?.orderCount || 0,
      totalRevenue: rollup[u.id]?.totalRevenue || 0,
      lastOrderAt: rollup[u.id]?.lastOrderAt ? new Date(rollup[u.id].lastOrderAt).toISOString() : null,
    }));
    // Sort: live sessions first, then most-recent customers
    enriched.sort((a, b) => {
      if (a.sessionLive !== b.sessionLive) return a.sessionLive ? -1 : 1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    res.json({
      total: enriched.length,
      activeSessions: enriched.filter(u => u.sessionLive).length,
      users: enriched,
    });
  } catch (err) {
    console.error('[admin/users]', err.message);
    res.status(500).json({ error: 'Failed to load users', detail: err.message });
  }
});

app.get('/api/admin/orders', adminAuth, (req, res) => {
  const { page, pageSize } = req.query;
  res.json(orders.getAllOrders({
    page: parseInt(page) || 1,
    pageSize: parseInt(pageSize) || 20,
  }));
});

app.get('/api/admin/orders/:id', adminAuth, async (req, res) => {
  const order = orders.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  let cjDetail = null;
  let tracking = null;
  if (order.cjOrderId) {
    try { cjDetail = (await cj.getOrderDetail(order.cjOrderId)).data; } catch {}
    if (cjDetail?.trackNumber) {
      try { tracking = (await cj.trackInfo(cjDetail.trackNumber)).data; } catch {}
    }
  }
  res.json({ order, cjDetail, tracking });
});

// Retry a PENDING order's CJ push. Useful when the first push failed due
// to a transient issue (rate limit, intermittent CJ error) — saves you
// from having to make a fresh customer order for every test.
//
// Body (optional):
//   { consigneeID, phone, dryRun }
// - dryRun:true  → returns the exact payload we'd send to CJ, doesn't call.
//                  Great for verifying phone/consigneeID normalization
//                  without actually creating a CJ order.
// - consigneeID, phone → pass these to fix orders that were placed
//                        before those checkout fields existed.
app.post('/api/admin/orders/:id/retry-cj', adminAuth, async (req, res) => {
  try {
    const { consigneeID, phone, dryRun } = req.body || {};
    if (dryRun) {
      const payload = orders.previewCjPayload(req.params.id, { consigneeID, phone });
      return res.json({ dryRun: true, payload });
    }
    const result = await orders.retryCjPush(req.params.id, { consigneeID, phone });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete a local order. Doesn't touch CJ — only for cleaning up test
// orders that never made it to CJ. Returns 404 if no such order.
app.delete('/api/admin/orders/:id', adminAuth, (req, res) => {
  const ok = orders.deleteOrder(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Order not found' });
  res.json({ deleted: true, id: req.params.id });
});

// ── Product blocklist (manual hide) ────────────────────────────────
// List all blocked products
app.get('/api/admin/products/blocked', adminAuth, (req, res) => {
  res.json({ blocked: blockedProducts, count: Object.keys(blockedProducts).length });
});

// Block a product — hides it from list, detail, and checkout endpoints
app.post('/api/admin/products/:pid/block', adminAuth, (req, res) => {
  const pid = req.params.pid;
  blockedProducts[pid] = {
    reason: req.body?.reason || 'manually blocked',
    blockedAt: new Date().toISOString(),
  };
  saveBlockedProducts();
  res.json({ ok: true, pid, blocked: blockedProducts[pid] });
});

// Unblock a product
app.delete('/api/admin/products/:pid/block', adminAuth, (req, res) => {
  const pid = req.params.pid;
  if (!blockedProducts[pid]) return res.status(404).json({ error: 'Not blocked' });
  delete blockedProducts[pid];
  saveBlockedProducts();
  res.json({ ok: true, pid, unblocked: true });
});

// Force-recheck shipping for a product (clears cache, re-queries CJ).
// Useful when you suspect the cached availability is wrong/stale.
app.post('/api/admin/products/:pid/recheck-shipping', adminAuth, async (req, res) => {
  const pid = req.params.pid;
  const before = shippingCache[pid] || null;
  delete shippingCache[pid];
  saveShippingCache();
  try {
    const after = await getProductShippingUsd(pid, 'high');
    res.json({ pid, before, after });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/balance', adminAuth, async (req, res) => {
  try {
    const data = await cj.getBalance();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set global markup or per-product override
app.post('/api/admin/pricing', adminAuth, (req, res) => {
  const { pid, retailPrice, globalMarkup } = req.body;
  if (globalMarkup !== undefined) {
    process.env.PROFIT_MARKUP_PERCENT = String(globalMarkup);
    return res.json({ success: true, globalMarkup: globalMarkup + '%' });
  }
  if (pid && retailPrice) {
    pricing.setProductPrice(pid, retailPrice);
    return res.json({ success: true, pid, retailPrice });
  }
  res.status(400).json({ error: 'Provide pid+retailPrice or globalMarkup' });
});

app.delete('/api/admin/pricing/:pid', adminAuth, (req, res) => {
  pricing.removeProductPrice(req.params.pid);
  res.json({ success: true });
});

app.get('/api/admin/pricing', adminAuth, (req, res) => {
  res.json({
    globalMarkup: pricing.getMarkupPercent() + '%',
    overrides: pricing.getAllOverrides(),
  });
});

// ══════════════════════════════════════════════════════════════════
//  IMAGE PROXY — CJ/Aliexpress CDNs hotlink-protect; proxy with Referer
//
//  LRU-capped because each entry holds a full image Buffer (often
//  100s of KB). Without this cap the Map grew without bound on the
//  512MB Render Starter and OOM'd the Node process. 200 entries ≈
//  ~40MB worst case, leaving plenty of headroom for everything else.
// ══════════════════════════════════════════════════════════════════
const IMG_CACHE = new Map(); // insertion order = LRU order
const IMG_CACHE_MAX_ENTRIES = 200;
const IMG_TTL = 24 * 60 * 60 * 1000;

function imgCacheTouch(url, entry) {
  IMG_CACHE.delete(url);
  IMG_CACHE.set(url, entry);
  while (IMG_CACHE.size > IMG_CACHE_MAX_ENTRIES) {
    const oldest = IMG_CACHE.keys().next().value;
    if (oldest === undefined) break;
    IMG_CACHE.delete(oldest);
  }
}

app.get('/api/img', async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) return res.status(400).end();
  if (!/(cjdropshipping\.com|alicdn\.com|cjdropshipping\.net|aliexpress\.com|alibaba\.com)/i.test(url)) {
    return res.status(400).end();
  }
  const cached = IMG_CACHE.get(url);
  if (cached && Date.now() - cached.ts < IMG_TTL) {
    imgCacheTouch(url, cached);
    res.set('Content-Type', cached.type);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.end(cached.buf);
  }
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://cjdropshipping.com/',
      },
    });
    const buf = Buffer.from(r.data);
    const type = r.headers['content-type'] || 'image/jpeg';
    imgCacheTouch(url, { ts: Date.now(), buf, type });
    res.set('Content-Type', type);
    res.set('Cache-Control', 'public, max-age=86400');
    res.end(buf);
  } catch { res.status(502).end(); }
});

// ══════════════════════════════════════════════════════════════════
//  SPA FALLBACK
// ══════════════════════════════════════════════════════════════════
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ══════════════════════════════════════════════════════════════════
//  CACHE PRE-WARMING
//  Right after startup, fetch the home page's most-needed data so
//  the first real user doesn't pay the cold CJ latency.
// ══════════════════════════════════════════════════════════════════
// Mirror of the frontend's day-of-year rotation in loadHomeProducts.
// Keep these in sync — different picks here would warm the wrong cache
// keys and the home page would still hit cold CJ on first visit.
function todayHomeKeywords() {
  const today = new Date();
  const dayOfYear = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / 86400000);
  const pick = (arr) => arr[dayOfYear % arr.length];
  return {
    featured:      pick(['trending', 'best seller', 'gift set', 'premium', 'editor pick', 'limited edition', 'top rated', 'new arrival']),
    trending:      pick(['earbuds', 'wireless headphones', 'smart watch', 'bluetooth speaker', 'power bank', 'phone holder', 'gaming mouse', 'mini projector', 'action camera', 'mechanical keyboard', 'smart glasses', 'drone', 'vr headset', 'air purifier']),
    smart:         pick(['smart bulb', 'smart plug', 'smart light', 'smart band', 'smart sensor', 'smart camera', 'smart watch', 'smart scale', 'smart fan', 'smart lock', 'smart key finder', 'smart speaker']),
    homeLifestyle: pick(['led light', 'kitchen tools', 'wall art', 'desk lamp', 'storage organizer', 'cushion cover', 'blanket', 'bathroom mat', 'plant pot', 'humidifier', 'aroma diffuser', 'room decor', 'coffee mug', 'cookware']),
  };
}

// Warm a specific keyword search and cache it under the same key the
// /api/store/products endpoint uses. Single keyword → one merged search.
async function prewarmKeyword(keyword, size = 10, page = 1) {
  const rawKey = productsRawKey({
    keyWord: keyword || '', page: String(page), size: String(size), categoryId: '',
  });
  if (cacheGet(rawKey, 30 * 60 * 1000)) return; // already warm
  try {
    const meta = await searchProductsMerged({ keyWord: keyword, page, size });
    cacheSet(rawKey, meta);
    console.log(`[prewarm] "${keyword}" (${meta.products.length}/${meta.total}) ✓`);
  } catch (e) {
    console.warn(`[prewarm] "${keyword}" failed:`, e.message);
  }
}

async function prewarm() {
  console.log('[prewarm] warming caches...');
  try {
    await cj.getCategories().then(d => cacheSet('categories', d.data || []));
    console.log('[prewarm] categories ✓');
  } catch (e) { console.warn('[prewarm] categories failed:', e.message); }

  // Warm the actual keywords the home page will fetch today, so the
  // first user visit hits cache instead of paying the per-endpoint
  // rate-limit serialise on every section. With Prime (4 req/sec) and
  // separate listV2/legacy queues running in parallel, all 4 keyword
  // sections warm in well under a second.
  const kw = todayHomeKeywords();
  await Promise.all([
    prewarmKeyword(kw.featured, 10),
    prewarmKeyword(kw.trending, 10),
    prewarmKeyword(kw.smart, 10),
    prewarmKeyword(kw.homeLifestyle, 10),
  ]);

  // Pre-warm the men's & women's fashion sections too. They fetch by
  // categoryId of a rotating second-level subcategory, which the
  // frontend resolves at load time. Mirror that resolution here.
  try {
    const cats = cacheGet('categories', Infinity) || [];
    const findCat = (re) => cats.find(c => re.test(c.categoryFirstName || ''));
    const womenCat = findCat(/^women.?s\s+clothing/i);
    const menCat   = findCat(/^men.?s\s+clothing/i);
    const today = new Date();
    const dayOfYear = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / 86400000);
    const childPick = (cat) => {
      const subs = cat?.categoryFirstList || [];
      return subs.length ? subs[dayOfYear % subs.length] : cat;
    };
    const womenSub = childPick(womenCat);
    const menSub   = childPick(menCat);
    const warmCat = async (sub, label) => {
      if (!sub) return;
      const id = sub.categoryId || sub.categorySecondId || sub.categoryFirstId;
      if (!id) return;
      const rawKey = productsRawKey({
        keyWord: '', page: '1', size: '8', categoryId: id,
      });
      if (cacheGet(rawKey, 30 * 60 * 1000)) return;
      try {
        const meta = await searchProductsMerged({ categoryId: id, page: 1, size: 8 });
        cacheSet(rawKey, meta);
        console.log(`[prewarm] ${label} (${meta.products.length}) ✓`);
      } catch (e) { console.warn(`[prewarm] ${label} failed:`, e.message); }
    };
    await Promise.all([warmCat(menSub, "men's fashion"), warmCat(womenSub, "women's fashion")]);
  } catch (e) { console.warn('[prewarm] fashion sections failed:', e.message); }

  // Background-warm shipping for the first batch of products so first
  // detail-click is fast. Pulls from the featured cache we just wrote.
  const featuredKey = productsRawKey({
    keyWord: kw.featured, page: '1', size: '10', categoryId: '',
  });
  const featuredMeta = cacheGet(featuredKey, Infinity);
  const featuredProducts = featuredMeta?.products || [];
  if (featuredProducts.length) {
    console.log(`[prewarm] warming shipping for ${featuredProducts.length} featured products in background...`);
    let done = 0, unshippable = 0;
    for (const p of featuredProducts) {
      const pid = p.pid || p.id || p.productId;
      if (!pid) continue;
      getProductShippingUsd(pid).then(r => {
        done++;
        if (!r.available) unshippable++;
        if (done === featuredProducts.length) {
          console.log(`[prewarm] shipping warm ✓ (${done} products, ${unshippable} unshippable)`);
        }
      }).catch(() => {});
    }
  }
}

// Slowly warm shipping for additional product pages so search/category
// browsing also benefits from cached prices. Runs continuously after
// the home page is hot. All low-priority — won't block user actions.
async function warmExtendedCatalog(maxPages = 4) {
  console.log(`[warmer] starting extended catalog warm (up to ${maxPages} more pages)...`);
  for (let page = 2; page <= maxPages + 1; page++) {
    try {
      const data = await cj.searchProducts({ page, size: 24 });
      let products = [];
      if (data.data?.list) products = data.data.list;
      else if (data.data?.content) data.data.content.forEach(g => { if (g.productList) products.push(...g.productList); });

      // Cache the raw list at the same key the list endpoint uses
      const rawKey = productsRawKey({ keyWord: '', page: String(page), size: '24', categoryId: '' });
      cacheSet(rawKey, {
        products,
        total: data.data?.total || data.data?.totalRecords || products.length,
        totalPages: data.data?.totalPages || 1,
      });

      // Fire shipping quotes for all pids on this page; they trickle through
      // the low-priority queue while the server is otherwise idle.
      for (const p of products) {
        const pid = p.pid || p.id || p.productId;
        if (pid) getProductShippingUsd(pid).catch(() => {});
      }
      console.log(`[warmer] page ${page} queued (${products.length} products)`);
    } catch (e) {
      console.warn(`[warmer] page ${page} failed:`, e.message);
    }
  }
}

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  Befach Store v8.0  (CJDropshipping powered)         ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  URL:       http://localhost:${PORT}`);
  console.log(`  CJ key:    ${process.env.CJ_API_KEY ? 'loaded' : 'MISSING'}`);
  console.log(`  Markup:    ${pricing.getMarkupPercent()}%`);
  console.log(`  Ship:      ${DEFAULT_SHIP_FROM} → ${DEFAULT_SHIP_TO}`);
  console.log(`  Admin pw:  ${process.env.ADMIN_PASSWORD ? 'set' : 'MISSING'}`);
  console.log('');
  // Fire-and-forget so the server starts accepting requests immediately.
  // After the home page is hot, keep filling the cache with deeper pages
  // so first-click on any category returns warm shipping data faster.
  prewarm().then(() => warmExtendedCatalog(8)).catch(() => {});
});
