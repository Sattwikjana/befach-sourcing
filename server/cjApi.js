/**
 * CJ Dropshipping API Client v2.0
 * Handles authentication, token management, and all CJ API calls.
 * API Reference: https://developers.cjdropshipping.com/en/api/api2/api/
 */

const axios = require('axios');

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

// ── Token state ──
let accessToken = null;
let refreshToken = null;
let tokenExpiryDate = null;
let refreshTokenExpiryDate = null;
// When N calls arrive at once with no token, only the first does the auth;
// the rest await this promise. Prevents a thundering herd of auth calls that
// would all race each other into CJ's 1-req/sec rate limit.
let authInFlight = null;

/**
 * Get or refresh the CJ access token.
 * Tokens are cached in memory; auto-refreshes when expired.
 */
async function ensureToken() {
  if (authInFlight) return authInFlight;
  authInFlight = _doEnsureToken().finally(() => { authInFlight = null; });
  return authInFlight;
}

async function _doEnsureToken() {
  // If token is still valid (with 1-hour buffer), reuse it
  if (accessToken && tokenExpiryDate) {
    const expiresAt = new Date(tokenExpiryDate).getTime();
    if (Date.now() < expiresAt - 3600000) {
      return accessToken;
    }
  }

  // Try refresh token first if available
  if (refreshToken && refreshTokenExpiryDate) {
    const refreshExpiry = new Date(refreshTokenExpiryDate).getTime();
    if (Date.now() < refreshExpiry - 3600000) {
      try {
        const res = await axios.post(`${CJ_BASE}/authentication/refreshAccessToken`, {
          refreshToken,
        }, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000,
        });

        if (res.data?.data?.accessToken) {
          accessToken = res.data.data.accessToken;
          tokenExpiryDate = res.data.data.accessTokenExpiryDate;
          refreshToken = res.data.data.refreshToken;
          refreshTokenExpiryDate = res.data.data.refreshTokenExpiryDate;
          console.log('[CJ Auth] Token refreshed successfully');
          return accessToken;
        }
      } catch (err) {
        console.warn('[CJ Auth] Refresh failed, will re-authenticate:', err.message);
      }
    }
  }

  // Full authentication with API key
  const apiKey = process.env.CJ_API_KEY;
  if (!apiKey) {
    throw new Error('CJ_API_KEY not set in environment');
  }

  // CJ rate-limits /authentication/getAccessToken at 1 req/sec too, so
  // retry once on 429 or a "Too Many Requests" response.
  const doAuth = async () => axios.post(
    `${CJ_BASE}/authentication/getAccessToken`,
    { apiKey },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );

  let res;
  try {
    res = await doAuth();
  } catch (err) {
    const s = err.response?.status;
    const msg = err.response?.data?.message || '';
    if (s === 429 || s >= 500 || /too many requests/i.test(msg)) {
      // Silent retry — transient
      await new Promise(r => setTimeout(r, 1500));
      res = await doAuth();
    } else {
      console.error('[CJ Auth] Authentication failed:', err.response?.data || err.message);
      throw new Error('CJ authentication failed: ' + (err.response?.data?.message || err.message));
    }
  }

  // CJ sometimes returns 200 with a rate-limit error inside the body
  if (!res.data?.data?.accessToken) {
    const bodyMsg = res.data?.message || 'Failed to get access token';
    if (/too many requests/i.test(bodyMsg)) {
      await new Promise(r => setTimeout(r, 1500));
      res = await doAuth();
    }
    if (!res.data?.data?.accessToken) {
      throw new Error('CJ authentication failed: ' + (res.data?.message || 'no token'));
    }
  }

  accessToken = res.data.data.accessToken;
  tokenExpiryDate = res.data.data.accessTokenExpiryDate;
  refreshToken = res.data.data.refreshToken;
  refreshTokenExpiryDate = res.data.data.refreshTokenExpiryDate;
  console.log('[CJ Auth] Authenticated, token expires:', tokenExpiryDate);
  return accessToken;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * True if the axios error is a rate-limit or transient server error
 * that's worth retrying.
 */
function isRetryable(err) {
  const s = err.response?.status;
  if (s === 429) return true;
  if (s >= 500 && s < 600) return true;
  return false;
}

/**
 * Per-endpoint priority queues.
 *
 * CJ rate-limits each endpoint at 1 request per second per API key.
 * Different endpoints have *independent* limits — so calls to
 * /product/listV2 and /product/getCategory can go out in parallel.
 *
 * Three priority tiers (drained in order):
 *   - 'high'   → user clicked something (product detail, order placement)
 *   - 'medium' → user is looking at this card right now (visible-card backfill)
 *   - 'low'    → background warming (prewarm, no user attached)
 *
 * Cached responses serve the vast majority of traffic; queues only
 * engage on genuine cache misses.
 */
const MIN_GAP_MS = 1050;
const queues = new Map(); // path → { high: [], medium: [], low: [], lastAt, running }

function enqueueCj(path, fn, priority = 'low') {
  let q = queues.get(path);
  if (!q) {
    q = { high: [], medium: [], low: [], lastAt: 0, running: false };
    queues.set(path, q);
  }

  return new Promise((resolve, reject) => {
    const task = { fn, resolve, reject };
    if (priority === 'high') q.high.push(task);
    else if (priority === 'medium') q.medium.push(task);
    else q.low.push(task);
    drain(q);
  });
}

async function drain(q) {
  if (q.running) return;
  q.running = true;
  try {
    while (q.high.length || q.medium.length || q.low.length) {
      const wait = MIN_GAP_MS - (Date.now() - q.lastAt);
      if (wait > 0) await sleep(wait);
      const task = q.high.shift() || q.medium.shift() || q.low.shift();
      if (!task) break;
      try {
        const result = await task.fn();
        q.lastAt = Date.now();
        task.resolve(result);
      } catch (err) {
        q.lastAt = Date.now();
        task.reject(err);
      }
    }
  } finally {
    q.running = false;
  }
}

/**
 * Make an authenticated CJ request via the priority serial queue, with
 * up to 2 retries on 429/5xx using exponential backoff.
 *
 * opts.priority: 'high' (user-triggered) or 'low' (background). Default 'low'.
 */
async function cjCall(method, path, opts = {}) {
  const token = await ensureToken();
  const baseConfig = {
    headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' },
    timeout: 20000,
  };
  const priority = opts.priority || 'low';

  const attempt = () => enqueueCj(path, () => {
    if (method === 'GET') {
      return axios.get(`${CJ_BASE}${path}`, { ...baseConfig, params: opts.params || {} });
    }
    return axios.post(`${CJ_BASE}${path}`, opts.body || {}, baseConfig);
  }, priority);

  let lastErr;
  const delays = [0, 1500, 3000];
  for (const d of delays) {
    if (d) await sleep(d);
    try {
      const res = await attempt();
      return res.data;
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
      // Silent retry — transient 429s are expected and the queue handles them.
      // We only surface the failure if ALL retries are exhausted (below).
    }
  }
  // Only log when retries genuinely failed
  console.warn(`[CJ] ${method} ${path} failed after retries (${lastErr.response?.status || lastErr.message})`);
  throw lastErr;
}

async function cjGet(path, params = {}, opts = {}) {
  return cjCall('GET', path, { params, priority: opts.priority });
}

async function cjPost(path, body = {}, opts = {}) {
  return cjCall('POST', path, { body, priority: opts.priority });
}

// ────────────────────────────────────────────────
// Product APIs
// ────────────────────────────────────────────────

/** Get product categories */
async function getCategories() {
  return cjGet('/product/getCategory');
}

/** Search products using V2 elasticsearch endpoint */
async function searchProducts({ keyWord, page = 1, size = 20, categoryId, minPrice, maxPrice, countryCode, sort }, opts = {}) {
  const params = { page, size };
  if (keyWord) params.keyWord = keyWord;
  if (categoryId) params.categoryId = categoryId;
  if (minPrice !== undefined) params.minPrice = minPrice;
  if (maxPrice !== undefined) params.maxPrice = maxPrice;
  if (countryCode) params.countryCode = countryCode;
  if (sort) params.sort = sort;
  return cjGet('/product/listV2', params, opts);
}

/** Get product list (legacy endpoint, fixed 20 per page) */
async function getProductList({ page = 1, pageSize = 20, categoryId, productNameEn }) {
  const params = { pageNum: page, pageSize };
  if (categoryId) params.categoryId = categoryId;
  if (productNameEn) params.productNameEn = productNameEn;
  return cjGet('/product/list', params);
}

/** Get product details by product ID */
async function getProductDetail(pid, opts = {}) {
  return cjGet('/product/query', { pid }, opts);
}

/** Get all variants for a product */
async function getProductVariants(pid) {
  return cjGet('/product/variant/query', { pid });
}

/** Get inventory for a variant */
async function getVariantStock(vid) {
  return cjGet('/product/stock/queryByVid', { vid });
}

/** Add a product to My Products */
async function addToMyProducts(productId) {
  return cjPost('/product/addToMyProduct', { productId });
}

/** Get my imported products */
async function getMyProducts({ page = 1, pageSize = 20, keyword }) {
  const params = { pageNum: page, pageSize };
  if (keyword) params.keyword = keyword;
  return cjGet('/product/myProduct/query', params);
}

/** Get product reviews */
async function getProductReviews(pid, { page = 1, pageSize = 10 } = {}) {
  return cjGet('/product/reviews', { pid, pageNum: page, pageSize });
}

// ────────────────────────────────────────────────
// Logistics APIs
// ────────────────────────────────────────────────

/** Calculate shipping freight */
async function calculateFreight(body, opts = {}) {
  return cjPost('/logistic/freightCalculate', body, opts);
}

/** Get tracking info for an order */
async function getTrackInfo(orderNum) {
  return cjGet('/logistic/getTrackInfo', { orderNum });
}

/** Get available shipping methods */
async function getShippingMethods(body) {
  return cjPost('/logistic/freightCalculate', body);
}

// ────────────────────────────────────────────────
// Shopping / Order APIs
// ────────────────────────────────────────────────

/** Create an order (legacy) */
async function createOrder(orderData) {
  return cjPost('/shopping/order/createOrder', orderData);
}

/** Create order V2 — supports payType (1=page, 2=balance, 3=create only) */
async function createOrderV2(orderData) {
  return cjPost('/shopping/order/createOrderV2', orderData);
}

/** Confirm an order */
async function confirmOrder(orderId) {
  const token = await ensureToken();
  const res = await axios.patch(`${CJ_BASE}/shopping/order/confirmOrder`, { orderId }, {
    headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' },
    timeout: 20000,
  });
  return res.data;
}

/** Get order details */
async function getOrderDetail(orderId) {
  return cjGet('/shopping/order/getOrderDetail', { orderId });
}

/** List orders */
async function listOrders({ page = 1, pageSize = 20 }) {
  return cjGet('/shopping/order/list', { pageNum: page, pageSize });
}

/** Get CJ wallet balance */
async function getBalance() {
  return cjGet('/shopping/pay/getBalance');
}

// ────────────────────────────────────────────────
// Advanced Logistics
// ────────────────────────────────────────────────

/** Detailed freight calculation with shipping options */
async function freightCalculateTip(body) {
  return cjPost('/logistic/freightCalculateTip', body);
}

/** Get tracking info (new endpoint) */
async function trackInfo(trackNumber) {
  return cjGet('/logistic/trackInfo', { trackNumber });
}

// ────────────────────────────────────────────────
// Warehouse APIs
// ────────────────────────────────────────────────

/** Get global warehouse list */
async function getWarehouses() {
  return cjGet('/product/globalWarehouseList');
}

module.exports = {
  ensureToken,
  getCategories,
  searchProducts,
  getProductList,
  getProductDetail,
  getProductVariants,
  getVariantStock,
  addToMyProducts,
  getMyProducts,
  getProductReviews,
  calculateFreight,
  freightCalculateTip,
  getTrackInfo,
  trackInfo,
  getShippingMethods,
  createOrder,
  createOrderV2,
  confirmOrder,
  getOrderDetail,
  listOrders,
  getBalance,
  getWarehouses,
};
