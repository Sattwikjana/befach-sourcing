/**
 * Pricing Engine — Applies profit markup to CJ wholesale prices.
 *
 * Two flavours of output:
 *   - applyRetailPricing / applyRetailPricingToList  → ADMIN (includes CJ cost + profit)
 *   - applyStorePricing  / applyStorePricingToList   → CONSUMER (profit stripped)
 *
 * Never send the admin flavour to public endpoints — customers could read
 * your wholesale cost and margin straight from the network tab.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const OVERRIDES_FILE = path.join(DATA_DIR, 'price-overrides.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function getMarkupPercent() {
  return parseFloat(process.env.PROFIT_MARKUP_PERCENT) || 20;
}

function loadOverrides() {
  try {
    if (fs.existsSync(OVERRIDES_FILE)) {
      return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveOverrides(overrides) {
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2));
}

/**
 * Compute retail price for a product.
 * @param {string} pid - Product ID
 * @param {number} cjPrice - CJ wholesale price (USD)
 * @returns {{ retailPrice: number, cjPrice: number, markup: string, profit: number }}
 */
function getRetailPrice(pid, cjPrice) {
  const price = parseFloat(cjPrice) || 0;
  const overrides = loadOverrides();

  let retailPrice;
  let customMarkup = false;

  if (overrides[pid] && overrides[pid].retailPrice) {
    retailPrice = parseFloat(overrides[pid].retailPrice);
    customMarkup = true;
  } else {
    const markup = getMarkupPercent();
    retailPrice = Math.ceil(price * (1 + markup / 100) * 100) / 100;
  }

  return {
    retailPrice,
    cjPrice: price,
    markup: customMarkup ? 'custom' : getMarkupPercent() + '%',
    profit: Math.round((retailPrice - price) * 100) / 100,
  };
}

/** Fields to strip before sending a product object to a consumer. */
const SENSITIVE_FIELDS = [
  'sellPrice',          // original CJ sellPrice (replaced by retail below but sometimes nested)
  'originalPrice',
  'cjPrice',
  'cjWholesalePrice',
  'wholesalePrice',
  'profitPerUnit',
  'profit',
  'markupApplied',
  'markup',
  'discountPrice',      // internal CJ promo price — not what we charge
  'discountPriceRate',
  'suggestSellPrice',
];

function stripSensitive(obj) {
  const out = { ...obj };
  for (const key of SENSITIVE_FIELDS) {
    delete out[key];
  }
  return out;
}

/**
 * ADMIN flavour — returns retail price + CJ cost + profit + markup.
 * Use for admin dashboard only.
 */
function applyRetailPricing(product) {
  const pid = product.pid || product.id || product.productId || '';
  const rawCjPrice = parseFloat(product.sellPrice || product.nowPrice || 0);
  const pricing = getRetailPrice(pid, rawCjPrice);

  return {
    ...product,
    sellPrice: pricing.retailPrice.toFixed(2),
    retailPrice: pricing.retailPrice.toFixed(2),
    cjWholesalePrice: pricing.cjPrice.toFixed(2),
    profitPerUnit: pricing.profit.toFixed(2),
    markupApplied: pricing.markup,
  };
}

function applyRetailPricingToList(products) {
  return (products || []).map(p => applyRetailPricing(p));
}

/**
 * CONSUMER flavour — returns ONLY the retail price. CJ cost, profit, and
 * markup are stripped out. Use for all public /api/store/* endpoints.
 */
function applyStorePricing(product) {
  const pid = product.pid || product.id || product.productId || '';
  const rawCjPrice = parseFloat(product.sellPrice || product.nowPrice || 0);
  const pricing = getRetailPrice(pid, rawCjPrice);
  const clean = stripSensitive(product);

  return {
    ...clean,
    sellPrice: pricing.retailPrice.toFixed(2),
    price: pricing.retailPrice.toFixed(2),
    currency: 'USD', // CJ prices are USD; frontend converts to INR for display
  };
}

function applyStorePricingToList(products) {
  return (products || []).map(p => applyStorePricing(p));
}

/**
 * Same thing but for a variant. Variants have variantSellPrice, not sellPrice.
 */
function applyStoreVariantPricing(variant) {
  const vid = variant.vid || variant.variantId || '';
  const rawCjPrice = parseFloat(variant.variantSellPrice || 0);
  const pricing = getRetailPrice(vid, rawCjPrice);

  // Drop any fields that reveal the CJ price
  const clean = { ...variant };
  delete clean.variantSellPrice;
  delete clean.variantDiscountPrice;
  delete clean.variantDiscountPercent;

  return {
    ...clean,
    price: pricing.retailPrice.toFixed(2),
    variantSellPrice: pricing.retailPrice.toFixed(2),
  };
}

function applyStoreVariantPricingToList(variants) {
  return (variants || []).map(v => applyStoreVariantPricing(v));
}

/**
 * Look up retail price for a given product+variant so we can validate
 * prices at checkout (customer can't tamper with cart to pay less).
 */
function getVariantRetailPrice(vid, cjPrice) {
  return getRetailPrice(vid, cjPrice);
}

function setProductPrice(pid, retailPrice) {
  const overrides = loadOverrides();
  overrides[pid] = { retailPrice: parseFloat(retailPrice), updatedAt: new Date().toISOString() };
  saveOverrides(overrides);
  return overrides[pid];
}

function removeProductPrice(pid) {
  const overrides = loadOverrides();
  delete overrides[pid];
  saveOverrides(overrides);
}

function getAllOverrides() {
  return loadOverrides();
}

module.exports = {
  getMarkupPercent,
  getRetailPrice,
  getVariantRetailPrice,
  applyRetailPricing,
  applyRetailPricingToList,
  applyStorePricing,
  applyStorePricingToList,
  applyStoreVariantPricing,
  applyStoreVariantPricingToList,
  setProductPrice,
  removeProductPrice,
  getAllOverrides,
};
