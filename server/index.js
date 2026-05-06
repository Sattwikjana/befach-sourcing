/**
 * Global Shopper — Backend v8.0
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
const searchAI = require('./searchAI');
const catalog = require('./catalogDb');

const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;
const APP_VERSION = '8.18';

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
// Bumped from 600 to accommodate the deeper category prewarm — every
// top-level category × 5 pages + every second-level × 1 page is ~150
// extra entries, plus headroom for searches and detail-page caches.
const CACHE_MAX_ENTRIES = 2000;
const CACHE = new Map(); // insertion order = LRU order

// Bump this whenever the searchProductsMerged logic changes its output
// shape or sort order. Old cached entries with a different version
// won't be read, so users see the new behavior immediately on deploy
// without waiting for the 30-min TTL to expire.
const PRODUCTS_CACHE_VERSION = 'v6';
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

// ── Persistent per-product shipping + final price cache (disk-backed) ──
// One entry per product id; survives server restarts so list pages can
// show exact all-in prices immediately after the first CJ quote.
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

const FREIGHT_QUOTE_TTL_MS = parseInt(process.env.FREIGHT_QUOTE_TTL_MS || String(60 * 60 * 1000), 10);
const productRawInFlight = new Map();
const shippingInFlight = new Map();
const freightInFlight = new Map();

function freightQuoteKey(items) {
  const products = (items || [])
    .map(i => ({
      vid: String(i.vid || ''),
      quantity: parseInt(i.quantity, 10) || 1,
    }))
    .filter(i => i.vid)
    .sort((a, b) => a.vid.localeCompare(b.vid));
  if (!products.length) return '';
  return JSON.stringify({
    from: DEFAULT_SHIP_FROM,
    to: DEFAULT_SHIP_TO,
    products,
  });
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
  if (productRawInFlight.has(pid)) return productRawInFlight.get(pid);

  const promise = (async () => {
    const data = await cj.getProductDetail(pid, { priority });
    if (data?.data) cacheSet(key, data.data);
    return data?.data || null;
  })();

  productRawInFlight.set(pid, promise);
  try {
    return await promise;
  } finally {
    productRawInFlight.delete(pid);
  }
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
  const key = freightQuoteKey(items);
  if (!key) return null;

  const cacheKey = 'freightQuote:' + key;
  const cached = cacheGet(cacheKey, FREIGHT_QUOTE_TTL_MS);
  if (cached) return cached;
  if (freightInFlight.has(key)) return freightInFlight.get(key);

  const promise = (async () => {
    const data = await cj.calculateFreight({
      startCountryCode: DEFAULT_SHIP_FROM,
      endCountryCode: DEFAULT_SHIP_TO,
      products: items.map(i => ({ vid: i.vid, quantity: parseInt(i.quantity) || 1 })),
    }, { priority });
    const methods = Array.isArray(data.data) ? data.data : [];
    // CJ's freight API systematically undercounts the actual shipping
    // we're billed by ~10–13% across the products we sampled. Compensate
    // with a multiplier so the cost we plug into pricing matches what we
    // actually pay. Default 1.13 ⇒ +13% on top of the API number.
    const shipFactor = parseFloat(process.env.SHIPPING_FEE_FACTOR) || 1.13;
    for (const wanted of SHIPPING_METHODS_PRIORITY) {
      const m = methods.find(x => x.logisticName === wanted);
      if (m && m.logisticPrice != null) {
        const adjustedUsd = parseFloat(m.logisticPrice) * shipFactor;
        const result = { usd: adjustedUsd, method: m.logisticName, available: true };
        cacheSet(cacheKey, result);
        return result;
      }
    }
    // CJ responded but none of our priority methods is available — treat
    // this product as not shippable (we only ship via Ordinary / Sensitive).
    const result = { usd: 0, method: null, available: false };
    cacheSet(cacheKey, result);
    return result;
  })();

  freightInFlight.set(key, promise);
  try {
    return await promise;
  } catch (e) {
    // Transient — caller handles by falling back to cached/flat estimate
    return null;
  } finally {
    freightInFlight.delete(key);
  }
}

/**
 * Get per-product shipping cost and, when possible, the exact final
 * display price for one unit using the priority chain. Cached on disk,
 * keyed by product id.
 *
 * @param {string} pid           CJ product id
 * @param {'high'|'medium'|'low'} priority  CJ queue priority
 * @param {number} maxAgeMs      override TTL for this call (e.g. orders
 *                               require fresher data than display does)
 * Returns { usd, method, available, cached }
 */
// Cache version. Bump this whenever the way we compute or post-process
// shipping changes (e.g. introducing SHIPPING_FEE_FACTOR). Entries
// without the current version are treated as expired so we don't serve
// stale numbers from the persistent disk volume across deploys.
//
//   v=1 (implicit): legacy entries with no factor applied
//   v=2: entries that have SHIPPING_FEE_FACTOR baked into `usd`
const SHIPPING_CACHE_VERSION = 2;

async function getProductShippingUsd(pid, priority = 'low', maxAgeMs = SHIPPING_CACHE_TTL) {
  const hit = shippingCache[pid];
  if (hit && hit.v === SHIPPING_CACHE_VERSION && Date.now() - hit.ts < maxAgeMs) {
    if (hit.available !== false && !hit.displayUsd) {
      try {
        const raw = await getProductRaw(pid, priority);
        const wholesaleUsd = parseFloat(raw?.variants?.[0]?.variantSellPrice || raw?.sellPrice || 0) || 0;
        if (wholesaleUsd > 0) {
          const displayUsd = computeDisplayUsd(wholesaleUsd, hit.usd);
          const offer = computeOfferPricing(pid, displayUsd);
          hit.wholesaleUsd = wholesaleUsd;
          hit.displayUsd = displayUsd.toFixed(2);
          hit.mrp = offer?.mrp || null;
          hit.discountPercent = offer?.discountPercent || null;
          hit.priceTs = Date.now();
          saveShippingCache();
        }
      } catch {}
    }
    return {
      usd: hit.usd,
      method: hit.method,
      available: hit.available !== false,
      wholesaleUsd: hit.wholesaleUsd,
      displayUsd: hit.displayUsd,
      mrp: hit.mrp,
      discountPercent: hit.discountPercent,
      cached: true,
    };
  }

  const inFlightKey = `${pid}:${maxAgeMs}`;
  if (shippingInFlight.has(inFlightKey)) return shippingInFlight.get(inFlightKey);

  const promise = (async () => {
    let firstVid = null;
    let firstWholesaleUsd = 0;
    let maxWholesaleUsd = 0;
    try {
      const raw = await getProductRaw(pid, priority);
      firstVid = raw?.variants?.[0]?.vid || null;
      firstWholesaleUsd = parseFloat(raw?.variants?.[0]?.variantSellPrice || raw?.sellPrice || 0) || 0;
      // Capture the MAX variant wholesale here so list pages (which only
      // get CJ's "from" price from the search API) can show a price that
      // covers any variant the customer might pick. Without this the list
      // shows the cheap-variant price and a customer who clicks Buy Now
      // on a more expensive variant gets a higher price in the cart.
      const variantPrices = (raw?.variants || [])
        .map(v => parseFloat(v.variantSellPrice || 0))
        .filter(p => p > 0);
      if (variantPrices.length) maxWholesaleUsd = Math.max(...variantPrices);
    } catch {}

    if (!firstVid) {
      return { usd: 0, method: null, available: false, cached: false };
    }

    const quote = await quoteShippingForItems([{ vid: firstVid, quantity: 1 }], priority);
    if (!quote) {
      return { usd: FALLBACK_SHIPPING_USD, method: 'fallback', available: true, cached: false };
    }

    const displayUsd = quote.available && firstWholesaleUsd > 0
      ? computeDisplayUsd(firstWholesaleUsd, quote.usd)
      : 0;
    const offer = displayUsd > 0 ? computeOfferPricing(pid, displayUsd) : null;

    shippingCache[pid] = {
      v: SHIPPING_CACHE_VERSION,
      usd: quote.usd,
      method: quote.method,
      available: quote.available,
      wholesaleUsd: firstWholesaleUsd,
      displayUsd: displayUsd ? displayUsd.toFixed(2) : null,
      mrp: offer?.mrp || null,
      discountPercent: offer?.discountPercent || null,
      maxWholesaleUsd,
      ts: Date.now(),
    };
    saveShippingCache();
    return {
      ...quote,
      wholesaleUsd: firstWholesaleUsd,
      displayUsd: displayUsd ? displayUsd.toFixed(2) : null,
      mrp: offer?.mrp || null,
      discountPercent: offer?.discountPercent || null,
      cached: false,
    };
  })();

  shippingInFlight.set(inFlightKey, promise);
  try {
    return await promise;
  } finally {
    shippingInFlight.delete(inFlightKey);
  }
}

/** Cheap synchronous peek — does NOT call CJ. */
function peekShippingCache(pid) {
  const hit = shippingCache[pid];
  // Treat any entry without the current version as expired — same
  // invalidation logic as getProductShippingUsd. The list endpoint
  // would otherwise serve stale unmultiplied shipping numbers from
  // pre-SHIPPING_FEE_FACTOR cache entries that survived deploys.
  if (!hit || hit.v !== SHIPPING_CACHE_VERSION || Date.now() - hit.ts > SHIPPING_CACHE_TTL) return null;
  return {
    usd: hit.usd,
    method: hit.method,
    available: hit.available !== false,
    wholesaleUsd: hit.wholesaleUsd,
    displayUsd: hit.displayUsd,
    mrp: hit.mrp,
    discountPercent: hit.discountPercent,
    // Optional — populated when the cache was warmed via getProductRaw
    // (i.e. when we actually saw the variants list). Used by the list
    // endpoint to show MAX variant price instead of CJ's "from" price.
    maxWholesaleUsd: typeof hit.maxWholesaleUsd === 'number' ? hit.maxWholesaleUsd : 0,
  };
}

function getShippingCacheStats() {
  const now = Date.now();
  let total = 0;
  let fresh = 0;
  let available = 0;
  let unavailable = 0;
  let priced = 0;

  for (const hit of Object.values(shippingCache || {})) {
    if (!hit || hit.v !== SHIPPING_CACHE_VERSION) continue;
    total++;
    if (now - hit.ts <= SHIPPING_CACHE_TTL) fresh++;
    if (hit.available === false) unavailable++;
    else {
      available++;
      if (parseFloat(hit.displayUsd || 0) > 0) priced++;
    }
  }

  let sizeBytes = 0;
  try {
    if (fs.existsSync(SHIPPING_CACHE_FILE)) {
      sizeBytes = fs.statSync(SHIPPING_CACHE_FILE).size;
    }
  } catch {}

  return {
    version: SHIPPING_CACHE_VERSION,
    total,
    fresh,
    available,
    unavailable,
    priced,
    sizeBytes,
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
 *   true_cost = (CJ_api_wholesale × CJ_FEE_FACTOR) + adjusted_shipping
 *   display   = true_cost × (1 + markup%)
 *
 * Two real-world correction factors are applied to API numbers BEFORE
 * markup so the displayed price matches what CJ actually bills us:
 *
 *   CJ_FEE_FACTOR (default 1.11)
 *     CJ adds an ~11% service/processing fee on top of the raw API
 *     wholesale at order time. Without this, markup applies to a lower
 *     base than reality and our margin silently shrinks.
 *
 *   SHIPPING_FEE_FACTOR (default 1.13, applied inside quoteShippingForItems)
 *     CJ's /freightCalculate API undercounts real shipping by ~10–13%.
 *     The shippingUsd argument here has already been corrected. With
 *     PROFIT_MARKUP_PERCENT=5, an unadjusted shipping number would
 *     leave us selling at a loss.
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
  const full = req.query.full === '1' || req.query.full === 'true';
  if (!full) {
    return res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: APP_VERSION,
      catalog: catalog.getLightStatus(),
    });
  }

  let cjOk = false;
  let cjError = null;
  try {
    await Promise.race([
      cj.ensureToken(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('CJ health check timeout')), 1200)),
    ]);
    cjOk = true;
  } catch (err) {
    cjError = err.message;
  }
  res.json({
    status: cjOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: APP_VERSION,
    cj: cjOk ? 'connected' : 'disconnected',
    cjError,
    markup: pricing.getMarkupPercent() + '%',
    cjFeeFactor: parseFloat(process.env.CJ_FEE_FACTOR) || 1.0,
    shippingFeeFactor: parseFloat(process.env.SHIPPING_FEE_FACTOR) || 1.13,
    shipFrom: DEFAULT_SHIP_FROM,
    shipTo: DEFAULT_SHIP_TO,
    // Surface payment configuration so we can diagnose "online payment not
    // configured" without exposing the secret. "test" / "live" / "missing".
    razorpay: !razorpay
      ? 'missing'
      : (process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_live_')
        ? 'live'
        : 'test',
    ai: searchAI.getStatus(),
    catalog: catalog.getStatus(),
    shippingCache: getShippingCacheStats(),
  });
});

app.get('/api/live', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: APP_VERSION,
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
    storeName: process.env.STORE_NAME || 'Global Shopper',
    currency: process.env.STORE_CURRENCY || 'INR',
    usdToInr: parseFloat(process.env.USD_TO_INR) || 85,
    shipTo: DEFAULT_SHIP_TO,
    shipFrom: DEFAULT_SHIP_FROM,
    shippingMethods: SHIPPING_METHODS_PRIORITY,
    shippingNote: 'Shipping included in price',
  });
});

app.get('/api/store/_debug/compare', async (req, res) => {
  const { q, categoryId } = req.query;
  try {
    const v2 = await cj.searchProducts({ keyWord: q, categoryId, page: 1, size: 20 });
    const v2Total = v2.data?.total || v2.data?.totalRecords || 0;
    const v2Sample = (v2.data?.list || []).slice(0, 3).map(p => p.productNameEn || p.productName);
    res.json({
      query: { q: q || null, categoryId: categoryId || null },
      listV2: { total: v2Total, sample: v2Sample },
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
    const categories = data.data || [];
    catalog.upsertCategories(categories);
    cacheSet('categories', categories);
    res.json({ data: categories });
  } catch (err) {
    console.error('[Categories]', err.message);
    const fallback = catalog.getCategoryTree();
    if (fallback.length) {
      cacheSet('categories', fallback);
      return res.json({ cached: true, source: 'catalog', data: fallback });
    }
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

function categoryCatalogFallbackTerms(name) {
  const label = String(name || '').trim();
  const n = label.toLowerCase();
  const terms = [];
  const add = (...items) => {
    for (const item of items) if (item) terms.push(item);
  };

  add(label);

  if (/prescription.*glass|glass|eyewear|spectacle|sunglass/.test(n)) {
    if (/prescription/.test(n)) add('reading glasses', 'blue light glasses', 'prescription glasses');
    add('smart glasses', 'sunglasses', 'glasses', 'eyewear', 'eyeglasses');
    return [...new Set(terms.filter(Boolean))];
  }

  if (/school/.test(n) && /bag|backpack/.test(n)) {
    add('school bag', 'school backpack', 'student backpack', 'kids backpack', 'backpack');
    return [...new Set(terms.filter(Boolean))];
  }

  if (/laptop|notebook|tablet|computer/.test(n) && /bag|case|cover|sleeve/.test(n)) {
    add('laptop bag', 'laptop case', 'laptop sleeve', 'notebook bag', 'computer bag', 'tablet case');
    return [...new Set(terms.filter(Boolean))];
  }

  if (/office|school|stationer/.test(n) && /suppl|stationer/.test(n)) {
    add('school supplies', 'office supplies', 'stationery', 'pencil case', 'notebook');
    return [...new Set(terms.filter(Boolean))];
  }

  if (/pet/.test(n) && /bed|mat|nest|blanket|quilt/.test(n)) {
    add('pet bed', 'dog bed', 'cat bed', 'pet mat', 'pet blanket', 'pet nest');
    return [...new Set(terms.filter(Boolean))];
  }

  if (/pet/.test(n) && /bag|carrier|travel/.test(n)) {
    add('pet carrier', 'pet travel bag', 'dog carrier', 'cat carrier');
    return [...new Set(terms.filter(Boolean))];
  }

  const isBroadWomen = /^(women'?s|woman|ladies?)\s+(clothing|fashion)$/i.test(label);
  const isBroadMen = /^(men'?s|man)\s+(clothing|fashion)$/i.test(label);
  const hasSpecificProductNoun = /shirt|blouse|dress|jacket|coat|hoodie|sweatshirt|pant|jean|short|skirt|legging|sweater|suit|set|vest|camis|bag|backpack|handbag|shoe|sandal|boot|sneaker|watch|jewel|ring|necklace|earring|bracelet|toy|pet|bowl|bed|lamp|light|projector|speaker|earphone|headphone|camera|charger|phone|case|cover|cable|power bank|laptop|tablet|printer|tool|storage|curtain|pillow|towel|makeup|hair|nail|wig|mask|razor|perfume|car|motorcycle|fishing|sport|outdoor|fitness|kitchen|garden|home/.test(n);

  if (/shirt|blouse|top|camis|vest/.test(n)) add('shirt', 'blouse', 'top');
  if (/dress/.test(n)) add('dress', 'dresses');
  if (/jacket|coat|outerwear|hoodie|sweatshirt|sweater/.test(n)) add('jacket', 'coat', 'hoodie', 'sweater');
  if (/pant|jean|short|skirt|legging|bottom/.test(n)) add('pants', 'jeans', 'shorts', 'skirt');
  if (/bag|backpack|handbag|purse|wallet/.test(n)) add('bag', 'backpack', 'handbag');
  if (/case|cover|sleeve/.test(n)) add('case', 'cover', 'sleeve');
  if (/shoe|sandal|boot|sneaker/.test(n)) add('shoes', 'sneakers', 'sandals');
  if (/watch/.test(n)) add('watch', 'smart watch');
  if (/jewel|ring|necklace|earring|bracelet/.test(n)) add('jewelry', 'ring', 'necklace', 'earrings');
  if (/pet|dog|cat/.test(n)) add('pet', 'dog', 'cat');
  if (/bed|mat|nest|blanket|quilt/.test(n)) add('bed', 'mat', 'blanket');
  if (/toy|baby|kid/.test(n)) add('toy', 'baby', 'kids');
  if (/electronic|computer|phone|tech/.test(n)) add('electronic', 'phone', 'gadget');
  if (/projector|speaker|earphone|headphone|camera|charger|cable|power bank/.test(n)) add('projector', 'speaker', 'earphones', 'camera', 'charger');
  if (/home|garden|furniture|kitchen/.test(n)) add('home', 'kitchen', 'lamp', 'garden');
  if (/health|beauty|hair|makeup|nail|wig|skin/.test(n)) add('beauty', 'hair', 'makeup', 'skincare');
  if (/sport|outdoor|fitness/.test(n)) add('sport', 'outdoor', 'fitness');

  if (isBroadWomen || (/women|woman|girl|ladies/.test(n) && !hasSpecificProductNoun)) add('dress', 'women', 'blouse', 'fashion');
  if (isBroadMen || (/\b(men|man|boy)\b/.test(n) && !hasSpecificProductNoun)) add('shirt', 'men', 'jacket', 'fashion');

  return [...new Set(terms.filter(Boolean))];
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

// Smart keyword search through CJ's current /product/listV2 endpoint.
// CJ support confirmed listV2 is now synchronized with seller dashboard
// counts, so we no longer call the deprecated /product/list endpoint.
// Re-rank a list of CJ products by a "trending + low cost" score so
// page 1 of every category surfaces bestsellers instead of CJ's mostly-
// arbitrary default order. listedNum is CJ's truest popularity signal:
// more sellers = stronger sell-through (sellers self-select for what
// works). 70% weight on popularity, 30% on cheapness — verified against
// Women's Clothing (cocktail dress with 352 listings was buried mid-
// page) and Pet Supplies (Halloween dog costume with 174 listings was
// off page 1) in CJ's default order.
function rankByTrending(products) {
  if (!products || products.length < 2) return products;

  const parsePrice = (raw) => {
    // sellPrice can be "5.50" or a range "1.09 -- 6.80" — take lower bound.
    const m = String(raw || '0').match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  };

  const stats = products.map(p => ({
    listed: parseInt(p.listedNum || p.listedShopNum || 0, 10) || 0,
    price:  parsePrice(p.sellPrice ?? p.nowPrice),
  }));
  const maxListed = Math.max(...stats.map(s => s.listed), 1);
  const valid = stats.map(s => s.price).filter(x => x > 0);
  const minPrice = valid.length ? Math.min(...valid) : 0;
  const maxPrice = valid.length ? Math.max(...valid) : 1;
  const priceRange = (maxPrice - minPrice) || 1;

  return products
    .map((p, i) => {
      const popScore = stats[i].listed / maxListed;
      const priceScore = stats[i].price > 0
        ? 1 - (stats[i].price - minPrice) / priceRange
        : 0;
      return { p, score: popScore * 0.7 + priceScore * 0.3 };
    })
    .sort((a, b) => b.score - a.score)
    .map(x => x.p);
}

async function searchProductsMerged({ keyWord, categoryId, page, size, priority = 'medium' }) {
  if (!keyWord) {
    const data = await cj.searchProducts({ keyWord, categoryId, page, size }, { priority });
    const result = parseListV2(data, size);
    result.products = rankByTrending(result.products);
    return result;
  }

  const tokens = String(keyWord).toLowerCase().split(/\s+/).filter(Boolean);
  const isMultiWord = tokens.length > 1;
  const matchesAll = (p) => {
    const name = String(p.productNameEn || p.productName || '').toLowerCase();
    return tokens.every(t => name.includes(t));
  };

  const [v2Result] = await Promise.allSettled([
    cj.searchProducts({ keyWord, categoryId, page, size }, { priority }),
  ]);

  const v2 = v2Result.status === 'fulfilled'
    ? parseListV2(v2Result.value, size)
    : { products: [], total: 0, totalPages: 1 };

  // Strict-AND filter multi-word queries. listV2's
  // elasticsearch returns category-tagged matches that don't contain
  // every keyword in the name (e.g. "Pet Glasses Dog" for "smart
  // glasses"), so we drop those. If filtering
  // leaves us with too few results we fall back to unfiltered below.
  const v2Filtered = isMultiWord ? v2.products.filter(matchesAll) : v2.products;

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

  let merged = unionByPid(v2Filtered);

  // Fallback: if strict-AND filtering gave us nothing useful (CJ's catalog
  // genuinely has very few products literally named "smart glasses" —
  // most are tagged by category instead), fall back to the unfiltered
  // listV2 results so the user sees *something* relevant rather than an
  // empty page. The sort below still tries to float real matches up.
  let usedFallback = false;
  if (isMultiWord && merged.length < 4) {
    merged = unionByPid(v2Filtered, v2.products);
    usedFallback = true;
  }

  // Sort: strict name matches first regardless of source ranking. For
  // "smart glasses" this puts real smart-glasses items above pet glasses
  // that survive only via the fallback union. Within each tier, re-rank
  // by trending+cheapness so popular bestsellers float above obscure
  // matches.
  if (isMultiWord) {
    const strictMatches = [];
    const otherMatches = [];
    for (const p of merged) (matchesAll(p) ? strictMatches : otherMatches).push(p);
    merged = [...rankByTrending(strictMatches), ...rankByTrending(otherMatches)];
  } else {
    merged = rankByTrending(merged);
  }

  let total;
  if (isMultiWord && usedFallback) {
    // Fallback view: total is what listV2 has + any extra strict matches.
    total = Math.max(v2.total, merged.length);
  } else {
    total = Math.max(v2.total, merged.length);
  }

  return {
    products: merged,
    total,
    totalPages: Math.max(Math.ceil(total / size), 1),
  };
}

function mergeProductLists(...lists) {
  const seen = new Set();
  const products = [];
  for (const list of lists) {
    for (const product of list || []) {
      const pid = product.pid || product.id || product.productId;
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      products.push(product);
    }
  }
  return products;
}

const CATEGORY_LIVE_MERGE_TIMEOUT_MS = parseInt(process.env.CATEGORY_LIVE_MERGE_TIMEOUT_MS || '700', 10);
const SEARCH_LIVE_MERGE_TIMEOUT_MS = parseInt(process.env.SEARCH_LIVE_MERGE_TIMEOUT_MS || '1200', 10);
const LIVE_ONLY_SEARCH_TIMEOUT_MS = parseInt(process.env.LIVE_ONLY_SEARCH_TIMEOUT_MS || '6000', 10);
const MY_PRODUCTS_PIN_WAIT_MS = parseInt(process.env.MY_PRODUCTS_PIN_WAIT_MS || '200', 10);
const CATALOG_WAIT_FOR_LIVE_MS = parseInt(process.env.CATALOG_WAIT_FOR_LIVE_MS || '0', 10);
const CATALOG_BACKGROUND_LIVE_REFRESH = process.env.CATALOG_BACKGROUND_LIVE_REFRESH !== 'false';
const CATALOG_CACHE_LIVE_WRITES = process.env.CATALOG_CACHE_LIVE_WRITES !== 'false';
const SEARCH_AI_WAIT_MS = parseInt(process.env.SEARCH_AI_WAIT_MS || '1000', 10);

function cacheLiveProducts(liveMeta, categoryId) {
  if (!CATALOG_CACHE_LIVE_WRITES) return;
  if (!liveMeta?.products?.length) return;
  setImmediate(() => {
    try {
      catalog.upsertProducts(liveMeta.products, {
        source: 'cj-live-search',
        categoryHint: categoryId ? { id: categoryId, name: categoryNameForId(categoryId) } : undefined,
      });
    } catch (err) {
      console.warn('[products] live cache write failed:', err.message);
    }
  });
}

function mergeCatalogAndLiveMeta(liveMeta, catalogMeta, size) {
  if (!catalogMeta?.products?.length) return { ...liveMeta, source: 'cj' };
  const products = mergeProductLists(liveMeta.products, catalogMeta.products);
  const total = Math.max(liveMeta.total || 0, catalogMeta.total || 0, products.length);
  return {
    products,
    total,
    totalPages: Math.max(Math.ceil(total / size), liveMeta.totalPages || 1, catalogMeta.totalPages || 1),
    source: 'cj+catalog',
  };
}

async function searchProductsWithCatalogExtras({ keyWord, categoryId, page, size, allowLive = true }) {
  const catalogMeta = catalog.searchProducts({ keyWord, categoryId, page, size });
  const hasCatalog = !!catalogMeta?.products?.length;

  const fetchLive = (priority = 'high') => searchProductsMerged({
    keyWord,
    categoryId,
    page,
    size,
    priority,
  }).then(liveMeta => {
    cacheLiveProducts(liveMeta, categoryId);
    return liveMeta;
  });

  const timeout = (ms) => new Promise(resolve => setTimeout(() => resolve(null), ms));

  // If SQLite has products, it is the fast customer-facing path. Give CJ a
  // short chance to contribute live results, then return the catalog either
  // way. The live request keeps filling SQLite for the next visit.
  if (hasCatalog) {
    const currentPage = parseInt(page, 10) || 1;
    const shouldTryLive = allowLive && currentPage === 1 && !catalog.isSyncRunning();
    let livePromise = null;
    if (shouldTryLive && CATALOG_BACKGROUND_LIVE_REFRESH) {
      livePromise = fetchLive('low').catch(err => {
        console.warn('[products] background live refresh failed:', err.message);
        return null;
      });
    }

    if (shouldTryLive && CATALOG_WAIT_FOR_LIVE_MS > 0) {
      livePromise = livePromise || fetchLive('high')
        .catch(err => {
          console.warn('[products] live merge failed:', err.message);
          return null;
        });

      const liveMeta = await Promise.race([
        livePromise,
        timeout(CATALOG_WAIT_FOR_LIVE_MS),
      ]);

      if (liveMeta?.products?.length) {
        return mergeCatalogAndLiveMeta(liveMeta, catalogMeta, size);
      }
    }

    return {
      ...catalogMeta,
      source: keyWord ? 'catalog-search-fast' : 'catalog-fast',
    };
  }

  // Some broad CJ category ids do not have enough category-tagged rows in
  // SQLite yet. Do a fast catalog keyword fallback before waiting on CJ live.
  if (!keyWord && categoryId) {
    const fallbackName = categoryNameForId(categoryId);
    const fallbackTerms = categoryCatalogFallbackTerms(fallbackName);
    for (const term of fallbackTerms) {
      const fallbackMeta = catalog.searchProducts({ keyWord: term, page, size });
      if (fallbackMeta?.products?.length) {
        if (allowLive) fetchLive('high').catch(err => {
          console.warn('[products] background category CJ refresh failed:', err.message);
        });
        return {
          ...fallbackMeta,
          source: 'catalog-keyword-fast',
        };
      }
    }
  }

  if (!allowLive) {
    return {
      products: [],
      total: 0,
      totalPages: 1,
      source: 'catalog-prewarm-empty',
    };
  }

  let liveMeta;
  try {
    liveMeta = await Promise.race([
      fetchLive('high'),
      timeout(LIVE_ONLY_SEARCH_TIMEOUT_MS),
    ]);
  } catch (err) {
    throw err;
  }

  if (!liveMeta) {
    return {
      products: [],
      total: 0,
      totalPages: 1,
      source: 'live-timeout',
    };
  }

  liveMeta.source = 'cj';
  return liveMeta;
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

// CJ product URLs end in "-p-<numeric pid>.html". Extract the PID so a
// pasted URL resolves directly via /product/query?pid=… — far more
// reliable than guessing parent SKUs from the variant SKU shown on the
// page (CJ's variant suffix length isn't consistent: sometimes 2
// letters, sometimes "<digit><digit><letter><letter>", etc.)
const CJ_URL_PID_RE = /cjdropshipping\.com\/product\/[^\s]*?-p-(\d+)\.html/i;

// ── My Products (curated CJ "My Products" list) ─────────────────────
// Surfaces the products the seller has explicitly added to their CJ
// account. Pinned to the top of category pages whose tree contains
// each product's leaf — so the seller's curated picks are always
// reachable from the existing nav, even when CJ's keyword index
// doesn't surface them in that category's normal listing.
async function fetchAllMyProducts() {
  const all = [];
  let pageNum = 1;
  const pageSize = 100;
  // Hard cap at 20 pages (1000 products) — sanity guard, not a real limit.
  while (pageNum <= 20) {
    const r = await cj.getMyProducts({ page: pageNum, pageSize }, { priority: 'high' });
    const rows = r?.data?.content || [];
    if (!rows.length) break;
    all.push(...rows);
    const total = r?.data?.totalRecords ?? 0;
    if (all.length >= total) break;
    pageNum++;
  }
  // Normalize to catalog product shape so buildPriced / pricing /
  // productCard all work without special-casing My Products fields.
  const normalized = all.map(p => ({
    pid: p.productId,
    productId: p.productId,
    productSku: p.sku,
    productNameEn: p.nameEn,
    productImage: p.bigImage,
    sellPrice: p.sellPrice,
    productWeight: p.weight,
  }));
  if (CATALOG_CACHE_LIVE_WRITES) {
    catalog.upsertProducts(normalized, { source: 'cj-my-products' });
  }
  return normalized;
}

async function getCachedMyProducts() {
  const KEY = 'my-products';
  const cached = cacheGet(KEY, 30 * 60 * 1000);
  if (cached) return cached;
  const products = await fetchAllMyProducts();
  cacheSet(KEY, products);
  return products;
}

// pid → leaf categoryId for each My Product. The list endpoint doesn't
// include category info, so we fetch detail per product (rate-limited
// by cjGet's queue) and cache the mapping for an hour.
async function getMyProductCategoryMap() {
  const KEY = 'my-product-category-map';
  const cached = cacheGet(KEY, 60 * 60 * 1000);
  if (cached) return cached;
  const products = await getCachedMyProducts();
  const map = {};
  for (const p of products) {
    try {
      const r = await cj.getProductDetail(p.pid);
      map[p.pid] = r?.data?.categoryId || null;
    } catch (e) {
      console.warn(`[my-products] category lookup failed for ${p.pid}:`, e.message);
      map[p.pid] = null;
    }
  }
  cacheSet(KEY, map);
  return map;
}

// All leaf categoryIds that sit under (or equal) the given rootId,
// walked from the cached top-level category tree. CJ catalog uses
// 3-level UUID-keyed categories: top → second → leaf. A product's
// detail returns its leaf categoryId, so to surface "this is in
// Bags & Shoes" we need the set of leaves underneath the top-level.
function descendantLeafIds(rootId) {
  if (!rootId) return new Set();
  const tree = cacheGet('categories', Infinity) || [];
  const out = new Set();
  for (const top of tree) {
    if (top.categoryFirstId === rootId) {
      for (const sec of (top.categoryFirstList || [])) {
        for (const t of (sec.categorySecondList || [])) out.add(t.categoryId);
      }
      return out;
    }
    for (const sec of (top.categoryFirstList || [])) {
      if (sec.categorySecondId === rootId) {
        for (const t of (sec.categorySecondList || [])) out.add(t.categoryId);
        return out;
      }
      for (const t of (sec.categorySecondList || [])) {
        if (t.categoryId === rootId) { out.add(t.categoryId); return out; }
      }
    }
  }
  return out;
}

function categoryHasChildren(id) {
  if (!id) return false;
  const tree = cacheGet('categories', Infinity) || [];
  for (const top of tree) {
    if (top.categoryFirstId === id) return (top.categoryFirstList || []).length > 0;
    for (const sec of (top.categoryFirstList || [])) {
      if (sec.categorySecondId === id) return (sec.categorySecondList || []).length > 0;
    }
  }
  return false;
}

function productSearchText(product) {
  return [
    product.productNameEn,
    product.productName,
    product.nameEn,
    product.name,
    product.productSku,
    product.sku,
    product.categoryName,
  ].filter(Boolean).join(' ').toLowerCase();
}

const CATEGORY_MATCH_STOP_WORDS = new Set([
  'and', 'with', 'for', 'the', 'new',
  'men', 'man', 'mens', 'women', 'woman', 'womens', 'lady', 'ladies',
  'girl', 'girls', 'boy', 'boys', 'kid', 'kids', 'baby', 'child', 'parent', 'couple',
]);

function keywordTokens(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(t => t.length >= 3)
    .slice(0, 8);
}

function tokenStem(token) {
  if (token.endsWith('ies') && token.length > 4) return token.slice(0, -3) + 'y';
  if (token.endsWith('es') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && token.length > 4) return token.slice(0, -1);
  return token;
}

function productWordSet(product) {
  const words = keywordTokens(productSearchText(product));
  const out = new Set(words);
  for (const word of words) out.add(tokenStem(word));
  return out;
}

function wordSetHasToken(words, token) {
  const stem = tokenStem(token);
  if (words.has(token) || words.has(stem)) return true;
  if (stem.length < 4) return false;
  for (const word of words) {
    if (word.length >= 4 && (word.startsWith(stem) || stem.startsWith(word))) return true;
  }
  return false;
}

function matchesAnyTerm(product, terms) {
  const words = productWordSet(product);
  return terms.some(term => {
    const allTokens = keywordTokens(term);
    const specificTokens = allTokens.filter(t => !CATEGORY_MATCH_STOP_WORDS.has(t));
    const tokens = specificTokens.length ? specificTokens : allTokens;
    if (!tokens.length) return false;
    return tokens.every(token => wordSetHasToken(words, token));
  });
}

function pinnedMyProductsByCategoryName(products, categoryName) {
  const terms = categoryCatalogFallbackTerms(categoryName);
  const expanded = [...terms];
  const n = String(categoryName || '').toLowerCase();
  if (/prescription.*glass|glass|eyewear|spectacle|sunglass/.test(n)) expanded.push('prescription glasses', 'eyeglasses', 'glasses', 'eyewear');
  if (/^(women'?s|woman|ladies?)\s+(clothing|fashion)$/i.test(categoryName || '')) expanded.push('dress', 'dresses', 'skirt', 'top', 'blouse', 'clothing', 'apparel');
  if (/^(men'?s|man)\s+(clothing|fashion)$/i.test(categoryName || '')) expanded.push('shirt', 'shirts', 'hoodie', 'jacket', 'pants', 'clothing', 'apparel');
  if (/bag|shoe/.test(n)) expanded.push('bag', 'backpack', 'handbag', 'shoe', 'shoes', 'sneaker', 'sandal');
  if (/school/.test(n)) expanded.push('school', 'backpack', 'bag');
  if (/electronic|tech|phone|computer/.test(n)) expanded.push('gadget', 'phone', 'charger', 'earbud', 'speaker', 'camera', 'keyboard');
  return products.filter(product => matchesAnyTerm(product, expanded));
}

async function getMyProductsForPinning() {
  const cached = cacheGet('my-products', 30 * 60 * 1000);
  if (cached) return cached;
  const refresh = getCachedMyProducts().catch(err => {
    console.warn('[my-products] quick cache refresh failed:', err.message);
    return null;
  });
  return Promise.race([
    refresh,
    new Promise(resolve => setTimeout(() => resolve(null), MY_PRODUCTS_PIN_WAIT_MS)),
  ]);
}

// Pin seller-curated CJ My Products to the first page without putting the
// customer behind a cold /product/query category-map crawl. Exact category
// matching wins when the map is already warm; otherwise we use product-name
// matching so newly added CJ My Products still appear quickly after deploy.
async function pinnedMyProductsForResults({ categoryId, keyWord, page, limit = 8 }) {
  if ((parseInt(page, 10) || 1) !== 1) return [];
  try {
    const products = await getMyProductsForPinning();
    if (!products?.length) return [];

    if (keyWord) {
      const terms = keywordTokens(keyWord);
      return products
        .filter(product => matchesAnyTerm(product, terms))
        .slice(0, limit);
    }

    if (!categoryId) return products.slice(0, limit);

    const catMap = cacheGet('my-product-category-map', 60 * 60 * 1000);
    const leafIds = descendantLeafIds(categoryId);
    if (catMap && leafIds.size) {
      const exact = products.filter(p => {
        const leaf = catMap[p.pid];
        return leaf && leafIds.has(leaf);
      });
      if (exact.length) return exact.slice(0, limit);
    }

    // Leaf categories are specific enough that fuzzy name pinning causes
    // false positives (e.g. "School Bags" matching any product with the
    // word "bag"). If the exact CJ category map is cold, skip pinning for
    // leaves and let the catalog/live result set stay clean.
    if (!categoryHasChildren(categoryId)) return [];

    const categoryName = categoryNameForId(categoryId);
    return pinnedMyProductsByCategoryName(products, categoryName).slice(0, limit);
  } catch (e) {
    console.warn('[my-products] pinning failed:', e.message);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════
//  SMART SEARCH (AI-parsed query → CJ keyword search → filtered)
// ══════════════════════════════════════════════════════════════════
//
// Takes a raw user query (English / Hindi / Hinglish, with typos and
// natural language like "blue cooling jacket under 2000") and:
//   1. Sends it to Gemini Flash via OpenRouter to extract intent
//      (clean keywords, color, gender, price range)
//   2. Searches CJ with the cleaned keywords
//   3. Filters/sorts the results by extracted attributes
//   4. Returns products + the parsed intent so the frontend can show
//      "Showing results for: Blue cooling jackets under ₹2000"
//
// Falls back to plain CJ search if AI is unavailable, over budget, or
// errors out — search always works, AI just makes it smarter.
app.get('/api/store/search/smart', async (req, res) => {
  try {
    const rawQuery = (req.query.q || '').toString().trim();
    if (!rawQuery) {
      return res.status(400).json({ error: 'Query parameter q is required' });
    }
    const page = parseInt(req.query.page) || 1;
    const pageSize = Math.min(parseInt(req.query.size) || 20, 40);

    recordRecentQuery(rawQuery);
    const fastIntent = {
      keywords: rawQuery,
      broader_keywords: rawQuery,
      category: null,
      color: null,
      gender: null,
      price_min: null,
      price_max: null,
      intent: null,
      source: 'fallback',
      fallbackReason: 'fast-path',
    };
    const intent = await Promise.race([
      searchAI.parseQuery(rawQuery).catch(() => fastIntent),
      new Promise(resolve => setTimeout(() => resolve(fastIntent), SEARCH_AI_WAIT_MS)),
    ]);
    const narrowKeywords = intent.keywords || rawQuery;
    const broaderKeywords = intent.broader_keywords || narrowKeywords;
    const usingBroader = broaderKeywords && broaderKeywords.toLowerCase() !== narrowKeywords.toLowerCase();

    // Always run the narrow search. If a different broader fallback is
    // available, run it in parallel and merge — narrow matches first
    // (more relevant) followed by broader ones (still useful, but more
    // generic). This is the fix for "women dresses" returning only 60
    // products: the narrow term matches few catalog titles literally,
    // while "women clothing" pulls in the whole category.
    const [narrowMeta, broaderMeta] = await Promise.all([
      searchProductsWithCatalogExtras({
        keyWord: narrowKeywords,
        categoryId: undefined,
        page,
        size: pageSize,
      }),
      usingBroader
        ? searchProductsWithCatalogExtras({
            keyWord: broaderKeywords,
            categoryId: undefined,
            page,
            size: pageSize,
          })
        : Promise.resolve({ products: [], total: 0, totalPages: 1 }),
    ]);

    // Merge: narrow first (relevance), then broader (de-duplicated).
    const seenPids = new Set();
    let products = [];
    for (const p of narrowMeta.products || []) {
      const pid = p.pid || p.id || p.productId;
      if (!pid || seenPids.has(pid)) continue;
      seenPids.add(pid);
      products.push(p);
    }
    for (const p of broaderMeta.products || []) {
      const pid = p.pid || p.id || p.productId;
      if (!pid || seenPids.has(pid)) continue;
      seenPids.add(pid);
      products.push(p);
    }

    // Total = sum of both totals minus the dupes. Conservative estimate
    // because we can only count overlaps within the page we fetched, but
    // good enough for the pagination UI ("Showing 1500 products" feels
    // right even if the true total is 1480).
    const rawMerged = Math.max(
      products.length,
      (narrowMeta.total || 0) + (usingBroader ? (broaderMeta.total || 0) : 0)
    );
    // Track unfiltered count so we can scale the total by the filter
    // pass-rate after gender/price filters run below — otherwise the
    // pagination UI shows 5000 products but the user sees 50 because
    // the rest got filtered.
    const beforeFilters = products.length;

    // Apply AI-extracted filters client-side (CJ doesn't support these).

    // ── Gender filter ──
    // CJ's keyword search ignores prefix words like "men" — searching
    // "men dress" returns mostly women's dresses because the title
    // matcher is loose. We post-filter using the OPPOSITE gender's
    // marker words against productNameEn + categoryName. Word-boundary
    // regex so "winter" doesn't trip "win", "lady" trips "lady" not
    // "ladybird" (intentional — that's still a lady-styled product).
    const GENDER_EXCLUDES = {
      men:    ['women', 'woman', 'ladies', 'lady', 'female', 'girl', 'girls'],
      women:  ['men', 'mens', 'gentleman', 'male', 'boy', 'boys'],
      kids:   [],     // products labelled "men" or "women" usually fit kids too
      unisex: [],     // anything goes
    };
    if (intent.gender && GENDER_EXCLUDES[intent.gender]?.length) {
      const excludes = GENDER_EXCLUDES[intent.gender];
      const excludeRegex = new RegExp(`\\b(${excludes.join('|')})\\b`, 'i');
      const before = products.length;
      products = products.filter(p => {
        const name = (p.productNameEn || p.nameEn || p.productName || '').toLowerCase();
        const cat  = (p.categoryName  || p.threeCategoryName || '').toLowerCase();
        return !excludeRegex.test(name) && !excludeRegex.test(cat);
      });
      console.log(`[smart-search] gender=${intent.gender}: ${before} → ${products.length} after filter`);
    }

    // Price filter — applied in INR using the same conversion as display.
    const usdToInr = parseFloat(process.env.USD_TO_INR) || 85;
    if (intent.price_min || intent.price_max) {
      const min = intent.price_min || 0;
      const max = intent.price_max || Number.MAX_SAFE_INTEGER;
      products = products.filter(p => {
        const usd = parseFloat(p.sellPrice || p.nowPrice || 0) || 0;
        const inr = usd * usdToInr;
        return inr >= min && inr <= max;
      });
    }

    // Strip CJ cost fields, apply pricing
    const priced = products.map(p => {
      const cleaned = pricing.applyStorePricing(p);
      const wholesaleUsd = parseFloat(p.sellPrice || p.nowPrice || 0);
      const hit = peekShippingCache(p.pid || p.id || p.productId || '');
      const shippingUsd = (hit && hit.available) ? hit.usd : FALLBACK_SHIPPING_USD;
      const cachedDisplayUsd = hit && hit.available ? parseFloat(hit.displayUsd || 0) : 0;
      const displayUsd = cachedDisplayUsd > 0
        ? cachedDisplayUsd
        : computeDisplayUsd(wholesaleUsd, shippingUsd);
      const offer = (cachedDisplayUsd > 0 && hit.mrp && hit.discountPercent)
        ? { mrp: hit.mrp, discountPercent: hit.discountPercent }
        : computeOfferPricing(p.pid || p.id || p.productId || '', displayUsd);
      return {
        ...cleaned,
        sellPrice: displayUsd.toFixed(2),
        price: displayUsd.toFixed(2),
        mrp: offer?.mrp,
        discountPercent: offer?.discountPercent,
        shippingAccurate: !!(hit && hit.available),
        shippingIncluded: true,
      };
    });

    // Scale the merged total by the filter pass-rate we observed on
    // this page. If 50% of fetched items got filtered out by gender or
    // price, the true total is roughly half of CJ's reported total.
    const filterRatio = beforeFilters > 0 ? products.length / beforeFilters : 1;
    const adjustedTotal = Math.round(rawMerged * filterRatio);

    res.json({
      products: priced,
      total: adjustedTotal,
      totalPages: Math.max(1, Math.ceil(adjustedTotal / pageSize)),
      query: rawQuery,
      intent: {
        understood: intent.intent,                   // human-readable
        keywords: intent.keywords,
        broader_keywords: intent.broader_keywords,
        category: intent.category,
        color: intent.color,
        gender: intent.gender,
        price_min: intent.price_min,
        price_max: intent.price_max,
        source: intent.source,                       // "ai" | "cache" | "fallback"
      },
    });
  } catch (err) {
    console.error('[Smart Search]', err.message);
    res.status(500).json({ error: 'Search failed', detail: err.message });
  }
});

// Lightweight typeahead — for the search bar dropdown. Returns popular
// recent search terms (in-memory, top 8). Frontend merges with its own
// localStorage history. No AI call here — would be too expensive on every
// keystroke.
const _recentQueries = [];   // most-recent first
const _recentQueriesMax = 200;
function recordRecentQuery(q) {
  if (!q) return;
  const norm = q.toLowerCase().trim();
  if (!norm || norm.length < 2) return;
  const i = _recentQueries.findIndex(x => x.q === norm);
  if (i >= 0) {
    _recentQueries[i].count++;
    _recentQueries[i].lastTs = Date.now();
  } else {
    _recentQueries.unshift({ q: norm, count: 1, lastTs: Date.now() });
    if (_recentQueries.length > _recentQueriesMax) _recentQueries.pop();
  }
}

app.get('/api/store/search/suggest', (req, res) => {
  const prefix = (req.query.q || '').toString().toLowerCase().trim();
  if (!prefix || prefix.length < 1) return res.json({ suggestions: [] });
  const matches = _recentQueries
    .filter(x => x.q.startsWith(prefix) || x.q.includes(prefix))
    .sort((a, b) => b.count - a.count || b.lastTs - a.lastTs)
    .slice(0, 8)
    .map(x => x.q);
  res.json({ suggestions: matches });
});

app.get('/api/store/products', async (req, res) => {
  try {
    const { keyWord, page, size, categoryId, strictShippable } = req.query;
    if (keyWord) recordRecentQuery(keyWord);
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

    // CJ URL paste — extract PID from ".../product/<slug>-p-<pid>.html"
    // and resolve directly. URLs are how users reliably link to a
    // specific CJ product (SKU formats vary; PIDs are stable).
    const urlMatch = trimmedKw && trimmedKw.match(CJ_URL_PID_RE);
    if (!meta && urlMatch) {
      try {
        const r = await cj.getProductDetail(urlMatch[1]);
        const product = r?.data;
        if (product && (product.pid || product.id || product.productId)) {
          meta = { products: [product], total: 1, totalPages: 1 };
          cacheSet(rawKey, meta);
        }
      } catch (e) {
        console.warn(`[products] URL→PID lookup "${urlMatch[1]}" failed:`, e.message);
      }
    }

    // SKU short-circuit: if the keyword looks like a CJ SKU
    // ("CJYD186929102BY", "CJYD2338013", etc.), the keyword path
    // would always return 0 — CJ's keyWord search doesn't index
    // SKUs. Instead resolve directly via /product/query?productSku=
    // and return that single product. Saves a useless multi-page
    // CJ search and lets users find anything they paste from the
    // CJ seller dashboard.
    // Extract the leading "CJ"-prefixed token from the paste, dropping
    // any descriptor CJ appends in its UI ("-Green English", " (50ml)",
    // " Blue / XL", etc.). Without this, "CJWJWJYZ00729-Green English"
    // fails SKU_PATTERN entirely and falls through to keyword search,
    // which returns 0 because CJ's keyWord doesn't index SKUs.
    const skuLike = (trimmedKw.match(/^CJ[A-Z0-9]+/i) || [])[0] || '';

    if (!meta && skuLike && SKU_PATTERN.test(skuLike)) {
      // Try as-is, then with trailing variant letters stripped. CJ's
      // /product/query keys on the parent SKU (e.g. "CJYD286686310"),
      // but the variant SKU shown on the product page is the parent
      // plus a 1–3 letter color/size code ("CJYD286686310JQ"). Users
      // copy the variant form, so we fall back to the parent on miss.
      const stripped = skuLike.replace(/[A-Z]{1,3}$/i, '');
      const candidates = stripped !== skuLike && SKU_PATTERN.test(stripped)
        ? [skuLike, stripped]
        : [skuLike];
      for (const sku of candidates) {
        try {
          const data = await cj.getProductBySku(sku);
          const product = data?.data;
          if (product && (product.pid || product.id || product.productId)) {
            meta = { products: [product], total: 1, totalPages: 1 };
            cacheSet(rawKey, meta);
            break;
          }
        } catch (e) {
          console.warn(`[products] SKU lookup "${sku}" failed:`, e.message);
          // Fall through to normal keyword path so a non-SKU string that
          // happens to match the regex still gets searched normally.
        }
      }
    }

    if (!meta) {
      meta = await searchProductsWithCatalogExtras({
        keyWord,
        categoryId,
        page: parseInt(page) || 1,
        size: pageSize,
      });

      // CJ's listV2 categoryId index has gaps — many leaf-level categories
      // return 0 even though products clearly exist. If we got nothing AND
      // we were querying by id, retry with the category name as a keyword.
      // This recovers entire empty pages (e.g. Woman/Man Prescription
      // Glasses → 1000+ products via keyword). This fallback only fires when
      // the category id path is genuinely empty.
      if (meta.products.length === 0 && meta.source !== 'live-timeout' && categoryId && !keyWord) {
        const fallbackName = categoryNameForId(categoryId);
        if (fallbackName) {
          console.log(`[products] categoryId ${categoryId} empty → retrying as keyword "${fallbackName}"`);
          try {
            const meta2 = await searchProductsWithCatalogExtras({
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

      if ((meta.products || []).length) cacheSet(rawKey, meta);
    }

    // Pin matching CJ My Products after cache lookup as well, otherwise a
    // cached SQLite response can hide freshly added seller-curated items.
    if ((parseInt(page, 10) || 1) === 1) {
      const pinned = await pinnedMyProductsForResults({
        categoryId,
        keyWord: trimmedKw,
        page,
        limit: 10,
      });
      if (pinned.length) {
        const merged = mergeProductLists(pinned, meta.products);
        meta = {
          ...meta,
          products: merged.slice(0, Math.max(pageSize, pinned.length)),
          total: Math.max(meta.total || 0, merged.length),
          totalPages: meta.totalPages || 1,
          source: `${meta.source || 'cj'}+my-products`,
        };
      }
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
        if ((!hit || (hit.available && !hit.displayUsd)) && pid) toWarm.push(pid);

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
      // Use CJ's "from" wholesale (= variants[0]'s wholesale) so the list
      // price matches what the customer will see when they land on the
      // detail page. The detail page now also displays variants[0]'s
      // price by default; the per-variant price refines via API call when
      // the user picks a different size.
      const cachedDisplayUsd = knownGood ? parseFloat(hit.displayUsd || 0) : 0;
      const displayUsd = cachedDisplayUsd > 0
        ? cachedDisplayUsd
        : computeDisplayUsd(wholesaleUsd, shippingUsd);

      // Strip sensitive fields (CJ cost, profit, etc.) before sending to consumer
      const cleaned = pricing.applyStorePricing(rawProduct);
      const offer = (cachedDisplayUsd > 0 && hit.mrp && hit.discountPercent)
        ? { mrp: hit.mrp, discountPercent: hit.discountPercent }
        : computeOfferPricing(pid, displayUsd);
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
    const configuredWarm = parseInt(process.env.LISTING_SHIPPING_WARM_PER_REQUEST || '0', 10);
    const WARM_PER_REQUEST = catalog.isSyncRunning() ? 0 : Math.max(0, configuredWarm);
    for (const pid of unwarmedToWarm.slice(0, WARM_PER_REQUEST)) {
      getProductShippingUsd(pid, 'low').catch(() => {});
    }

    res.json({
      products: priced,
      total: meta.total,
      page: parseInt(page) || 1,
      totalPages: meta.totalPages,
      source: meta.source || 'cj',
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
    const {
      usd, method, available, cached,
      displayUsd: cachedDisplayUsd,
      mrp: cachedMrp,
      discountPercent: cachedDiscountPercent,
    } = await getProductShippingUsd(pid, 'medium');

    if (!available) {
      return res.json({ pid, available: false });
    }

    if (parseFloat(cachedDisplayUsd || 0) > 0) {
      return res.json({
        pid,
        available: true,
        shippingUsd: usd.toFixed(2),
        method,
        displayUsd: cachedDisplayUsd,
        mrp: cachedMrp,
        discountPercent: cachedDiscountPercent,
        cached,
      });
    }

    // variants[0]'s wholesale — matches what the detail page displays as
    // the default top-level price. Customer who picks the default variant
    // sees the same number on the card, on detail load, and at checkout.
    // Variant clicks on detail re-fetch per-variant pricing accurately.
    let wholesaleUsd = 0;
    try {
      const raw = await getProductRaw(pid, 'medium');
      wholesaleUsd = parseFloat(raw?.variants?.[0]?.variantSellPrice || raw?.sellPrice || 0);
    } catch {}

    const displayUsd = computeDisplayUsd(wholesaleUsd, usd);
    const offer = computeOfferPricing(pid, displayUsd);
    if (method !== 'fallback') {
      shippingCache[pid] = {
        ...(shippingCache[pid] || {}),
        v: SHIPPING_CACHE_VERSION,
        usd,
        method,
        available: true,
        wholesaleUsd,
        displayUsd: displayUsd.toFixed(2),
        mrp: offer?.mrp || null,
        discountPercent: offer?.discountPercent || null,
        ts: shippingCache[pid]?.ts || Date.now(),
        priceTs: Date.now(),
      };
      saveShippingCache();
    }
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

    // PER-VARIANT PRICING POLICY
    // ─────────────────────────────────────────────────────────────────
    // Each variant is priced from its OWN wholesale + that variant's
    // actual shipping. The top-level product.price reflects the FIRST
    // variant (the one auto-selected on page load) so a customer who
    // hits Buy Now without picking a variant pays exactly what they saw.
    //
    // For non-default variants the variants[] array above used variants[0]'s
    // shipping as a placeholder. The frontend re-fetches the real
    // per-variant shipping (and updates the displayed price) when the user
    // clicks a different size. The cart reprice path also quotes shipping
    // per-variant so the customer is charged accurately regardless of
    // which variant they end up buying.
    const topWholesaleUsd = parseFloat(raw.variants?.[0]?.variantSellPrice || raw.sellPrice || 0);
    const product = pricing.applyStorePricing(raw);
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

    if (shippingMethod !== 'fallback') {
      shippingCache[pid] = {
        ...(shippingCache[pid] || {}),
        v: SHIPPING_CACHE_VERSION,
        usd: shippingUsd,
        method: shippingMethod,
        available: true,
        wholesaleUsd: topWholesaleUsd,
        displayUsd: topDisplayUsd.toFixed(2),
        mrp: offer?.mrp || null,
        discountPercent: offer?.discountPercent || null,
        ts: shippingCache[pid]?.ts || Date.now(),
        priceTs: Date.now(),
      };
      saveShippingCache();
    }

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
 *
 * If `opts.expectedTotalPaise` is supplied and the server-computed
 * total drifts more than 2% from it, throws a PRICE_CHANGED error so
 * the customer can be shown the new price BEFORE Razorpay opens —
 * stops the "cart said ₹100, charged ₹150" surprise when admin updates
 * prices or CJ wholesale moves mid-cart.
 */
async function repriceCart(items, opts = {}) {
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

    // CRITICAL: quote shipping for THIS specific variant, not just any
    // variant of the product. Shipping cost varies meaningfully across
    // sizes (a 4XL jacket at ~450g costs ~10% more to ship than the
    // ~300g M of the same product). Using the cached product-level
    // shipping (which is for variants[0]) would underprice every heavy
    // variant by exactly the size of our 5% margin → loss per order.
    // Fall back to the product-level cached shipping only if the per-
    // variant quote fails — better than blocking the order outright.
    let shipping;
    const variantQuote = await quoteShippingForItems(
      [{ vid: item.vid, quantity: parseInt(item.quantity) || 1 }],
      'high'
    );
    if (variantQuote && variantQuote.available) {
      shipping = { usd: variantQuote.usd, method: variantQuote.method, available: true };
    } else {
      shipping = await getProductShippingUsd(item.pid, 'high', ORDER_FRESH_MAX_MS);
    }
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

  // Price-drift gate: if the customer told us what they expected to
  // pay (cart total at the time they pressed Checkout), refuse to
  // proceed when the server's freshly-computed total differs by more
  // than 2%. The 2% slack absorbs FX rounding and the per-variant
  // shipping refresh; anything bigger is a real price change (admin
  // updated, CJ wholesale moved, override added) that the customer
  // deserves to see before paying.
  if (opts.expectedTotalPaise !== undefined && opts.expectedTotalPaise !== null) {
    const expected = parseInt(opts.expectedTotalPaise, 10);
    if (Number.isFinite(expected) && expected > 0) {
      const drift = Math.abs(totalPaise - expected) / expected;
      if (drift > 0.02) {
        const e = new Error('Prices have changed since you opened your cart');
        e.status = 409;
        e.code = 'PRICE_CHANGED';
        e.expectedTotalPaise = expected;
        e.actualTotalPaise = totalPaise;
        // Strip cost-revealing fields before throwing — the consumer
        // path may surface this object.
        e.priced = priced.map(p => ({
          pid: p.pid,
          vid: p.vid,
          quantity: p.quantity,
          productName: p.productName,
          variantName: p.variantName,
          displayPrice: p.displayPrice,
        }));
        throw e;
      }
    }
  }

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
    const { items, expectedTotalPaise } = req.body || {};
    const { totalPaise, totalInr, priced } = await repriceCart(items, { expectedTotalPaise });
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
    // PRICE_CHANGED: surface the new total + per-line prices so the
    // frontend can update the cart and the customer can review before
    // re-pressing Pay. Status 409 (Conflict) so apiPost surfaces it
    // distinctly from server errors.
    if (err.code === 'PRICE_CHANGED') {
      console.warn('[Razorpay create-order] price drift', {
        expected: err.expectedTotalPaise, actual: err.actualTotalPaise,
      });
      return res.status(409).json({
        error: err.message,
        code: 'PRICE_CHANGED',
        expectedTotalPaise: err.expectedTotalPaise,
        actualTotalPaise: err.actualTotalPaise,
        priced: err.priced,
      });
    }
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

      // Order placement: quote shipping for THIS specific variant so the
      // displayed price actually covers what CJ bills us. The
      // product-level cache is for variants[0] only; using it would
      // underprice every heavier variant by the size of our 5% margin.
      let shipping;
      const variantQuote = await quoteShippingForItems(
        [{ vid: item.vid, quantity: parseInt(item.quantity) || 1 }],
        'high'
      );
      if (variantQuote && variantQuote.available) {
        shipping = { usd: variantQuote.usd, method: variantQuote.method, available: true };
      } else {
        shipping = await getProductShippingUsd(item.pid, 'high', ORDER_FRESH_MAX_MS);
      }
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

app.get('/api/admin/catalog/status', adminAuth, (req, res) => {
  res.json(catalog.getStatus());
});

app.post('/api/admin/catalog/sync', adminAuth, (req, res) => {
  const opts = {
    targetProducts: req.body?.targetProducts,
    maxCalls: req.body?.maxCalls,
    pageSize: req.body?.pageSize,
    minDelayMs: req.body?.minDelayMs,
  };
  res.json(catalog.startSync(cj, opts));
});

app.post('/api/admin/catalog/sync/stop', adminAuth, (req, res) => {
  res.json(catalog.stopSync());
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

// ── Featured / "My Products" management ─────────────────────────────
// List the seller's curated CJ My Products. Drives the admin "Featured"
// card so the operator can see what's currently pinned.
app.get('/api/admin/my-products', adminAuth, async (req, res) => {
  try {
    const products = await getCachedMyProducts();
    res.json({ products, count: products.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk-add to CJ My Products from a free-form blob — URLs, SKUs (with
// or without variant suffix), one per line. Mixed input fine. After
// adding, invalidates the My Products cache, the per-product category
// map, and every cached /api/store/products response so the new
// pinning surfaces immediately rather than waiting for TTLs.
app.post('/api/admin/my-products/bulk-add', adminAuth, async (req, res) => {
  const text = (req.body?.text || '').toString();
  const lines = text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: 'no input' });

  const results = [];
  for (const line of lines) {
    let pid = null;
    let source = null;

    const urlMatch = line.match(CJ_URL_PID_RE);
    if (urlMatch) {
      pid = urlMatch[1];
      source = 'url';
    } else {
      // Treat as a CJ SKU paste — strip any descriptor, then try
      // as-is and with trailing variant letters stripped (matches the
      // search-by-SKU short-circuit behavior).
      const skuLike = (line.match(/^CJ[A-Z0-9]+/i) || [])[0] || '';
      if (skuLike && SKU_PATTERN.test(skuLike)) {
        const stripped = skuLike.replace(/[A-Z]{1,3}$/i, '');
        const candidates = stripped !== skuLike && SKU_PATTERN.test(stripped)
          ? [skuLike, stripped]
          : [skuLike];
        for (const sku of candidates) {
          try {
            const r = await cj.getProductBySku(sku);
            const p = r?.data;
            const found = p && (p.pid || p.id || p.productId);
            if (found) { pid = found; source = 'sku'; break; }
          } catch (_) { /* try next */ }
        }
      }
    }

    if (!pid) {
      results.push({ input: line, status: 'skipped', reason: 'no PID/SKU resolved' });
      continue;
    }

    try {
      const r = await cj.addToMyProducts(pid);
      if (r?.code === 200) {
        results.push({ input: line, pid, source, status: 'added' });
      } else if (r?.code === 100002) {
        // CJ's "already in My Products" — count as success, the user
        // wants the product pinned regardless of who added it when.
        results.push({ input: line, pid, source, status: 'already' });
      } else {
        results.push({ input: line, pid, source, status: 'cj-error', message: r?.message || `code ${r?.code}` });
      }
    } catch (e) {
      results.push({ input: line, pid, source, status: 'error', message: e.message });
    }
  }

  // Invalidate every cache that could hold a stale My Products view.
  CACHE.delete('my-products');
  CACHE.delete('my-product-category-map');
  for (const k of Array.from(CACHE.keys())) {
    if (k.startsWith('productsRaw:')) CACHE.delete(k);
  }

  // Re-warm the category map in the background so the very next
  // category-page request hits a hot cache instead of blocking on
  // ~3s of detail lookups.
  (async () => {
    try { await getMyProductCategoryMap(); } catch (e) { console.warn('[my-products] re-warm failed:', e.message); }
  })();

  const summary = {
    added:   results.filter(r => r.status === 'added').length,
    already: results.filter(r => r.status === 'already').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    errors:  results.filter(r => r.status === 'cj-error' || r.status === 'error').length,
  };
  res.json({ results, summary });
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
    fashionFinds:  pick(['co ord set', 'women dress', 'statement earrings', 'handbag', 'platform sandals', 'oversized jacket', 'party dress', 'streetwear']),
    trending:      pick(['earbuds', 'wireless headphones', 'smart watch', 'bluetooth speaker', 'power bank', 'phone holder', 'gaming mouse', 'mini projector', 'action camera', 'mechanical keyboard', 'smart glasses', 'drone', 'vr headset', 'air purifier']),
    rareFinds:     pick(['mini projector', 'smart glasses', 'portable printer', 'car vacuum', 'key finder', 'wireless microscope', 'translator device', 'label maker', 'portable blender', 'usb c dock', 'led mask', 'neck massager']),
    smart:         pick(['smart bulb', 'smart plug', 'smart light', 'smart band', 'smart sensor', 'smart camera', 'smart watch', 'smart scale', 'smart fan', 'smart lock', 'smart key finder', 'smart speaker']),
    homeLifestyle: pick(['led light', 'kitchen tools', 'wall art', 'desk lamp', 'storage organizer', 'cushion cover', 'blanket', 'bathroom mat', 'plant pot', 'humidifier', 'aroma diffuser', 'room decor', 'coffee mug', 'cookware']),
  };
}

// Warm a specific keyword search and cache it under the same key the
// /api/store/products endpoint uses. Single keyword → one merged search.
async function prewarmKeyword(keyword, size = 10, page = 1, allowLive = false) {
  const rawKey = productsRawKey({
    keyWord: keyword || '', page: String(page), size: String(size), categoryId: '',
  });
  const cached = cacheGet(rawKey, 30 * 60 * 1000);
  if (cached) return cached; // already warm
  try {
    const meta = await searchProductsWithCatalogExtras({ keyWord: keyword, page, size, allowLive });
    cacheSet(rawKey, meta);
    console.log(`[prewarm] "${keyword}" (${meta.products.length}/${meta.total}) ✓`);
    return meta;
  } catch (e) {
    console.warn(`[prewarm] "${keyword}" failed:`, e.message);
    return null;
  }
}

function queueShippingWarm(products, label) {
  const seen = new Set();
  const pids = [];
  for (const p of products || []) {
    const pid = p.pid || p.id || p.productId;
    const hit = pid ? peekShippingCache(pid) : null;
    if (!pid || seen.has(pid) || (hit && (hit.available === false || hit.displayUsd))) continue;
    seen.add(pid);
    pids.push(pid);
  }
  if (!pids.length) return;

  console.log(`[prewarm] warming exact prices for ${pids.length} ${label} in background...`);
  let done = 0;
  let unshippable = 0;
  const markDone = () => {
    if (done === pids.length) {
      console.log(`[prewarm] exact prices warm ✓ (${done} products, ${unshippable} unshippable)`);
    }
  };
  for (const pid of pids) {
    getProductShippingUsd(pid, 'low').then(r => {
      done++;
      if (!r.available) unshippable++;
      markDone();
    }).catch(() => {
      done++;
      markDone();
    });
  }
}

async function prewarm() {
  const allowLive = process.env.PREWARM_LIVE_CJ === 'true';
  console.log('[prewarm] warming caches...');
  try {
    await cj.getCategories().then(d => {
      const categories = d.data || [];
      catalog.upsertCategories(categories);
      cacheSet('categories', categories);
    });
    console.log('[prewarm] categories ✓');
  } catch (e) { console.warn('[prewarm] categories failed:', e.message); }

  if (process.env.PREWARM_MY_PRODUCTS_MAP === 'true') {
    // Optional: this can take many CJ detail calls, so keep it off during
    // normal storefront startup.
    (async () => {
      try {
        const map = await getMyProductCategoryMap();
        console.log(`[prewarm] my-products map (${Object.keys(map).length}) ✓`);
      } catch (e) { console.warn('[prewarm] my-products failed:', e.message); }
    })();
  }

  // Warm the actual keywords the home page will fetch today, so the
  // first user visit hits cache instead of paying the per-endpoint
  // rate-limit serialise on every section. With Prime (4 req/sec) and
  // separate listV2/legacy queues running in parallel, all 4 keyword
  // sections warm in well under a second.
  const kw = todayHomeKeywords();
  const keywordMetas = await Promise.all([
    prewarmKeyword(kw.featured, 10, 1, allowLive),
    prewarmKeyword(kw.fashionFinds, 10, 1, allowLive),
    prewarmKeyword(kw.trending, 10, 1, allowLive),
    prewarmKeyword(kw.rareFinds, 10, 1, allowLive),
    prewarmKeyword(kw.smart, 10, 1, allowLive),
    prewarmKeyword(kw.homeLifestyle, 10, 1, allowLive),
  ]);

  // Pre-warm the men's & women's fashion sections too. They fetch by
  // categoryId of a rotating second-level subcategory, which the
  // frontend resolves at load time. Mirror that resolution here.
  let fashionMetas = [];
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
      const cached = cacheGet(rawKey, 30 * 60 * 1000);
      if (cached) return cached;
      try {
        const meta = await searchProductsWithCatalogExtras({ categoryId: id, page: 1, size: 8, allowLive });
        cacheSet(rawKey, meta);
        console.log(`[prewarm] ${label} (${meta.products.length}) ✓`);
        return meta;
      } catch (e) {
        console.warn(`[prewarm] ${label} failed:`, e.message);
        return null;
      }
    };
    fashionMetas = await Promise.all([warmCat(menSub, "men's fashion"), warmCat(womenSub, "women's fashion")]);
  } catch (e) { console.warn('[prewarm] fashion sections failed:', e.message); }

  // Background-warm exact shipping for every home-page section, not just
  // featured. Cards still show "Calculating..." until exact shipping lands,
  // so customers never see a low estimate that later jumps upward.
  if (process.env.PREWARM_SHIPPING === 'true') {
    queueShippingWarm(
      [...keywordMetas, ...fashionMetas].flatMap(meta => meta?.products || []),
      'home-page products'
    );
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
      catalog.upsertProducts(products, { source: 'cj-warm-listV2-global' });
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

function scheduleCatalogSync() {
  if (process.env.CATALOG_AUTO_SYNC !== 'true') return;
  const delayMs = parseInt(process.env.CATALOG_AUTO_SYNC_DELAY_MS || '120000', 10);
  const intervalMs = parseInt(process.env.CATALOG_AUTO_SYNC_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);
  const start = () => {
    const result = catalog.startSync(cj, {
      targetProducts: process.env.CATALOG_SYNC_TARGET || 50000,
      maxCalls: process.env.CATALOG_SYNC_MAX_CALLS || 600,
      pageSize: process.env.CATALOG_SYNC_PAGE_SIZE || 200,
      minDelayMs: process.env.CATALOG_SYNC_MIN_DELAY_MS || 1200,
    });
    if (result.started) console.log('[catalog] background sync started');
    else console.log('[catalog] background sync already running');
  };
  setTimeout(() => {
    start();
    setInterval(start, intervalMs);
  }, delayMs);
}

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log(`║  Global Shopper v${APP_VERSION} (CJDropshipping powered)       ║`);
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
  if (process.env.PREWARM_ENABLED !== 'false') {
    const extendedWarmPages = Math.max(0, parseInt(process.env.WARM_EXTENDED_CATALOG_PAGES || '0', 10));
    const prewarmDelayMs = Math.max(0, parseInt(process.env.PREWARM_DELAY_MS || '60000', 10));
    setTimeout(() => {
      prewarm()
        .then(() => {
          if (extendedWarmPages > 0) return warmExtendedCatalog(extendedWarmPages);
          return null;
        })
        .catch(() => {});
    }, prewarmDelayMs);
    console.log(`[prewarm] scheduled in ${prewarmDelayMs}ms`);
  } else {
    console.log('[prewarm] disabled');
  }
  scheduleCatalogSync();
});
