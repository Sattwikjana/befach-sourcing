/**
 * Order Manager — Local order storage + CJ order creation
 */

const fs = require('fs');
const path = require('path');
const cj = require('./cjApi');

const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Normalize a phone number to the international format CJ expects.
 *   India:   "8008188807"   → "918008188807"
 *            "+91 80081 88807" → "918008188807"
 *            "918008188807" → unchanged
 *            "08008188807"  → "918008188807"
 * For other supported countries, prepend the country dialing code if the
 * number is the local-format length. Falls back to digits-only if we
 * can't recognize the format — CJ may still accept it.
 */
const COUNTRY_DIAL_CODES = {
  IN: { code: '91', localLen: 10 },
  US: { code: '1',  localLen: 10 },
  GB: { code: '44', localLen: 10 },
  CN: { code: '86', localLen: 11 },
  AE: { code: '971', localLen: 9 },
  // Add more as you expand markets
};
function normalizePhone(rawPhone, countryCode = 'IN') {
  let digits = String(rawPhone || '').replace(/[^\d]/g, '');
  const cc = COUNTRY_DIAL_CODES[countryCode] || COUNTRY_DIAL_CODES.IN;
  // Strip leading zeros (common in some formats)
  digits = digits.replace(/^0+/, '');
  // Already prefixed correctly?
  if (digits.startsWith(cc.code) && digits.length === cc.code.length + cc.localLen) {
    return digits;
  }
  // Local-length number → prepend the country code
  if (digits.length === cc.localLen) {
    return cc.code + digits;
  }
  // Otherwise return whatever we have (let CJ tell us if invalid)
  return digits;
}

function loadOrders() {
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
    }
  } catch {}
  return [];
}

function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

function generateOrderId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `BF-${ts}-${rand}`;
}

/**
 * Create a consumer order and forward to CJ
 * @param {Object} orderData - { customer, items, shippingAddress }
 * customer: { name, phone, email }
 * items: [{ pid, vid, quantity, retailPrice, cjPrice, productName }]
 * shippingAddress: { address, address2, city, province, zip, country, countryCode }
 */
async function createOrder(orderData) {
  const { customer, items, shippingAddress, logisticName, userId, consigneeID } = orderData;

  // Totals:
  //   productTotal    = what the customer paid  (sum of displayPrice × qty)
  //   cjTotal         = product cost to us       (sum of cjPrice × qty)
  //   shippingTotal   = shipping cost to us      (sum of shippingPerUnit × qty)
  //   profit          = productTotal - cjTotal - shippingTotal
  const productTotal = items.reduce((sum, i) =>
    sum + (parseFloat(i.retailPrice) * i.quantity), 0);
  const cjTotal = items.reduce((sum, i) =>
    sum + (parseFloat(i.cjPrice) * i.quantity), 0);
  const shippingTotal = items.reduce((sum, i) =>
    sum + (parseFloat(i.shippingPerUnit || 0) * i.quantity), 0);
  const profit = Math.round((productTotal - cjTotal - shippingTotal) * 100) / 100;

  const orderId = generateOrderId();

  // Build CJ order payload
  const ccode = shippingAddress.countryCode || 'IN';
  const cjOrderPayload = {
    orderNumber: orderId,
    shippingZip: shippingAddress.zip || '',
    shippingCountry: shippingAddress.country || '',
    shippingCountryCode: ccode,
    shippingProvince: shippingAddress.province || '',
    shippingCity: shippingAddress.city || '',
    shippingPhone: normalizePhone(customer.phone, ccode),
    shippingCustomerName: customer.name || '',
    shippingAddress: shippingAddress.address || '',
    shippingAddress2: shippingAddress.address2 || '',
    email: customer.email || '',
    remark: `Befach Order ${orderId}`,
    fromCountryCode: process.env.DEFAULT_SHIP_FROM || 'CN',
    logisticName: logisticName || '',
    payType: 1, // returns cjPayUrl for you to pay
    // India customs requires the recipient's Aadhaar (12 digits) or PAN
    // (10 chars). CJ rejects with "Consignee ID required" if missing.
    consigneeID: consigneeID || '',
    products: items.map(item => ({
      vid: item.vid,
      quantity: item.quantity,
    })),
  };

  let cjResponse = null;
  let cjOrderId = null;
  let cjPayUrl = null;
  let cjError = null;

  try {
    cjResponse = await cj.createOrderV2(cjOrderPayload);
    if (cjResponse?.data?.orderId) {
      cjOrderId = cjResponse.data.orderId;
      cjPayUrl = cjResponse.data.cjPayUrl;
    } else {
      // CJ returned HTTP 200 but the body indicates a rejection. Common shapes:
      //   { code: 429, message: "Too many requests", data: null }
      //   { result: false, message: "Logistic method not available", data: null }
      //   { code: 200, data: null, message: "..." }
      // Capture the message so the admin actually sees WHY it failed.
      cjError = cjResponse?.message
             || cjResponse?.data?.message
             || `CJ rejected order (code=${cjResponse?.code || '?'}, no orderId returned)`;
      console.error('[OrderManager] CJ order rejected:', JSON.stringify(cjResponse));
    }
  } catch (err) {
    cjError = err.response?.data?.message || err.message;
    console.error('[OrderManager] CJ order creation failed:', err.message);
  }

  // Save local order
  const order = {
    id: orderId,
    userId: userId || null,
    customer,
    items,
    shippingAddress,
    consigneeID: consigneeID || null,
    logisticName: logisticName || null,
    productTotal: productTotal.toFixed(2),
    cjTotal: cjTotal.toFixed(2),
    shippingTotal: shippingTotal.toFixed(2),
    profit: profit.toFixed(2),
    cjOrderId,
    cjPayUrl,
    cjError,
    status: cjOrderId ? 'CJ_CREATED' : 'PENDING',
    trackNumber: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const orders = loadOrders();
  orders.unshift(order);
  saveOrders(orders);

  return order;
}

/**
 * Get order by ID
 */
function getOrder(orderId) {
  const orders = loadOrders();
  return orders.find(o => o.id === orderId);
}

/**
 * Get all orders (with optional pagination)
 */
function getAllOrders({ page = 1, pageSize = 20 } = {}) {
  const orders = loadOrders();
  const start = (page - 1) * pageSize;
  return {
    total: orders.length,
    page,
    pageSize,
    orders: orders.slice(start, start + pageSize),
  };
}

/**
 * Update order status
 */
function updateOrderStatus(orderId, status, extra = {}) {
  const orders = loadOrders();
  const idx = orders.findIndex(o => o.id === orderId);
  if (idx === -1) return null;
  orders[idx] = { ...orders[idx], status, ...extra, updatedAt: new Date().toISOString() };
  saveOrders(orders);
  return orders[idx];
}

/**
 * Retry pushing a PENDING order to CJ. Useful when the first push failed
 * due to a transient issue (rate limit, intermittent CJ error) and we want
 * to try again without making the customer place a new order.
 */
async function retryCjPush(orderId, overrides = {}) {
  const orders = loadOrders();
  const idx = orders.findIndex(o => o.id === orderId);
  if (idx === -1) throw new Error('Order not found');
  const order = orders[idx];
  if (order.cjOrderId) {
    return { ok: false, reason: 'Order is already pushed to CJ', cjOrderId: order.cjOrderId };
  }

  // Allow the admin to pass consigneeID (Aadhaar/PAN) and an updated phone
  // when retrying an old order that was placed before those fields existed.
  const consigneeID = overrides.consigneeID ?? order.consigneeID ?? '';
  const phone = overrides.phone ?? order.customer.phone ?? '';
  const ccode = order.shippingAddress.countryCode || 'IN';

  const cjOrderPayload = {
    orderNumber: order.id,
    shippingZip: order.shippingAddress.zip || '',
    shippingCountry: order.shippingAddress.country || '',
    shippingCountryCode: ccode,
    shippingProvince: order.shippingAddress.province || '',
    shippingCity: order.shippingAddress.city || '',
    shippingPhone: normalizePhone(phone, ccode),
    shippingCustomerName: order.customer.name || '',
    shippingAddress: order.shippingAddress.address || '',
    shippingAddress2: order.shippingAddress.address2 || '',
    email: order.customer.email || '',
    remark: `Befach Order ${order.id} (retry)`,
    fromCountryCode: process.env.DEFAULT_SHIP_FROM || 'CN',
    logisticName: order.logisticName || '',
    payType: 1,
    consigneeID,
    products: order.items.map(item => ({ vid: item.vid, quantity: item.quantity })),
  };

  let cjResponse = null;
  try {
    cjResponse = await cj.createOrderV2(cjOrderPayload);
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    orders[idx] = {
      ...order,
      cjError: msg,
      updatedAt: new Date().toISOString(),
    };
    saveOrders(orders);
    return { ok: false, reason: msg, raw: err.response?.data || null };
  }

  if (cjResponse?.data?.orderId) {
    orders[idx] = {
      ...order,
      consigneeID,
      cjOrderId: cjResponse.data.orderId,
      cjPayUrl: cjResponse.data.cjPayUrl || null,
      cjError: null,
      status: 'CJ_CREATED',
      updatedAt: new Date().toISOString(),
    };
    saveOrders(orders);
    return { ok: true, cjOrderId: cjResponse.data.orderId, cjPayUrl: cjResponse.data.cjPayUrl };
  }

  // CJ returned 200 with no orderId — capture the body so we can see why
  const reason = cjResponse?.message
              || cjResponse?.data?.message
              || `CJ rejected (code=${cjResponse?.code || '?'})`;
  orders[idx] = {
    ...order,
    cjError: reason,
    updatedAt: new Date().toISOString(),
  };
  saveOrders(orders);
  return { ok: false, reason, raw: cjResponse };
}

/**
 * Get dashboard stats
 */
function getDashboardStats() {
  const orders = loadOrders();
  const totalOrders = orders.length;
  const totalRevenue = orders.reduce((s, o) => s + parseFloat(o.productTotal || 0), 0);
  const totalProductCost = orders.reduce((s, o) => s + parseFloat(o.cjTotal || 0), 0);
  const totalShipping = orders.reduce((s, o) => s + parseFloat(o.shippingTotal || 0), 0);
  const totalCost = totalProductCost + totalShipping;
  const totalProfit = orders.reduce((s, o) => s + parseFloat(o.profit || 0), 0);
  const statusCounts = {};
  orders.forEach(o => { statusCounts[o.status] = (statusCounts[o.status] || 0) + 1; });

  return {
    totalOrders,
    totalRevenue: totalRevenue.toFixed(2),
    totalProductCost: totalProductCost.toFixed(2),
    totalShipping: totalShipping.toFixed(2),
    totalCost: totalCost.toFixed(2),
    totalProfit: totalProfit.toFixed(2),
    profitMargin: totalRevenue > 0 ? ((totalProfit / totalRevenue) * 100).toFixed(1) + '%' : '0%',
    statusCounts,
    recentOrders: orders.slice(0, 5),
  };
}

module.exports = {
  createOrder,
  getOrder,
  getAllOrders,
  updateOrderStatus,
  retryCjPush,
  getDashboardStats,
};
