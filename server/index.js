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

const app = express();
const PORT = process.env.PORT || 3001;

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
app.use(express.json({ limit: '1mb' }));
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

// Product list / search.
//
// We cache the RAW CJ product list (5 min TTL) — not the final payload —
// because shipping cache fills in the background and we want list pages
// to reflect that the moment it updates. On each request we re-bake
// shipping from the disk-backed shipping cache.
app.get('/api/store/products', async (req, res) => {
  try {
    const { keyWord, page, size, categoryId } = req.query;
    const rawKey = 'productsRaw:' + JSON.stringify({
      keyWord: keyWord || '', page: page || '1', size: size || '20', categoryId: categoryId || '',
    });

    let meta = cacheGet(rawKey, 5 * 60 * 1000);
    if (!meta) {
      const data = await cj.searchProducts({
        keyWord,
        page: parseInt(page) || 1,
        size: Math.min(parseInt(size) || 20, 40),
        categoryId,
      });
      let products = [];
      let total = 0;
      let totalPages = 1;
      if (data.data?.list) {
        products = data.data.list;
        total = data.data.total || products.length;
        totalPages = Math.ceil(total / (parseInt(size) || 20));
      } else if (data.data?.content) {
        data.data.content.forEach(group => {
          if (group.productList) products.push(...group.productList);
        });
        total = data.data.totalRecords || products.length;
        totalPages = data.data.totalPages || Math.ceil(total / (parseInt(size) || 20));
      }
      meta = { products, total, totalPages };
      cacheSet(rawKey, meta);
    }

    // For each product:
    //   1. Check shipping cache. If cached AND unshippable → drop it entirely.
    //   2. If cached AND shippable → compute real display price (wholesale + shipping) × (1+markup)
    //   3. If not cached → show approximate display using flat fallback and flag
    //      `shippingAccurate: false`. Frontend backfills via /shipping-for/:pid
    //      and will remove the card if it turns out to be unshippable.
    const priced = [];
    for (const rawProduct of meta.products) {
      const pid = rawProduct.pid || rawProduct.id || rawProduct.productId || '';
      const wholesaleUsd = parseFloat(rawProduct.sellPrice || rawProduct.nowPrice || 0);
      const hit = peekShippingCache(pid);

      if (hit && !hit.available) continue; // known unshippable → hide

      const shippingUsd = hit ? hit.usd : FALLBACK_SHIPPING_USD;
      const displayUsd = computeDisplayUsd(wholesaleUsd, shippingUsd);

      // Strip sensitive fields (CJ cost, profit, etc.) before sending to consumer
      const cleaned = pricing.applyStorePricing(rawProduct);
      priced.push({
        ...cleaned,
        sellPrice: displayUsd.toFixed(2),
        price: displayUsd.toFixed(2),
        shippingMethod: hit ? hit.method : null,
        shippingAccurate: !!hit,
        shippingIncluded: true,
      });
    }

    res.json({
      products: priced,
      total: meta.total,
      page: parseInt(page) || 1,
      totalPages: meta.totalPages,
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
    res.json({
      pid,
      available: true,
      shippingUsd: usd.toFixed(2),
      method,
      displayUsd: displayUsd.toFixed(2),
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

// Place an order
app.post('/api/store/orders', async (req, res) => {
  try {
    const { customer, items, shippingAddress, logisticName } = req.body;
    if (!customer || !customer.name || !customer.phone) {
      return res.status(400).json({ error: 'customer.name and customer.phone required' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items required' });
    }
    if (!shippingAddress || !shippingAddress.address || !shippingAddress.city) {
      return res.status(400).json({ error: 'shippingAddress.address and city required' });
    }

    // Re-price server-side — never trust the cart prices from the client.
    // Formula: displayPrice = (CJ_wholesale + CJ_shipping) × (1 + markup)
    const pricedItems = [];
    const methodCounts = { 'CJPacket Asia Ordinary': 0, 'CJPacket Asia Sensitive': 0 };
    for (const item of items) {
      if (!item.pid || !item.vid || !item.quantity) {
        return res.status(400).json({ error: 'each item needs pid, vid, quantity' });
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

    const order = await orders.createOrder({
      customer,
      items: pricedItems,
      shippingAddress,
      logisticName: chosenMethod,
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
app.post('/api/admin/orders/:id/retry-cj', adminAuth, async (req, res) => {
  try {
    const result = await orders.retryCjPush(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
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
async function prewarm() {
  console.log('[prewarm] warming caches...');
  try {
    await cj.getCategories().then(d => cacheSet('categories', d.data || []));
    console.log('[prewarm] categories ✓');
  } catch (e) { console.warn('[prewarm] categories failed:', e.message); }

  let homeProducts = [];
  try {
    const data = await cj.searchProducts({ page: 1, size: 24 });
    if (data.data?.list) {
      homeProducts = data.data.list;
    } else if (data.data?.content) {
      data.data.content.forEach(g => { if (g.productList) homeProducts.push(...g.productList); });
    }
    const rawKey = 'productsRaw:' + JSON.stringify({ keyWord: '', page: '1', size: '24', categoryId: '' });
    cacheSet(rawKey, {
      products: homeProducts,
      total: data.data?.total || data.data?.totalRecords || homeProducts.length,
      totalPages: data.data?.totalPages || 1,
    });
    console.log(`[prewarm] products page 1 (${homeProducts.length} items) ✓`);
  } catch (e) { console.warn('[prewarm] products failed:', e.message); }

  // Fire-and-forget shipping warming for the home products. The CJ
  // queue serializes these at low priority — user-triggered requests
  // (product detail clicks, order placement) jump ahead via the
  // priority queue.
  if (homeProducts.length) {
    console.log(`[prewarm] warming shipping for ${homeProducts.length} products in background...`);
    let done = 0, unshippable = 0;
    for (const p of homeProducts) {
      const pid = p.pid || p.id || p.productId;
      if (!pid) continue;
      getProductShippingUsd(pid).then(r => {
        done++;
        if (!r.available) unshippable++;
        if (done === homeProducts.length) {
          console.log(`[prewarm] shipping warm ✓ (${done} products, ${unshippable} unshippable filtered)`);
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
      const rawKey = 'productsRaw:' + JSON.stringify({ keyWord: '', page: String(page), size: '24', categoryId: '' });
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
  // Fire-and-forget so the server starts accepting requests immediately
  prewarm();
});
