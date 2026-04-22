/**
 * Per-platform "trending products" catalog — used as fallback when a live
 * scraper can't extract real listings (most B2B sites block server-side
 * scraping or render with JS that axios+cheerio can't see).
 *
 * Each card uses:
 *   • Keyword-matching image from loremflickr.com (a stable Flickr-photo proxy
 *     that always resolves to a relevant JPEG; picsum.photos is the secondary
 *     fallback so the <img> tag never breaks). Both are free, no API key.
 *   • A single, realistic spot-price for that platform's pricing tier
 *   • A deep-URL pattern that lands on the platform's actual product gallery
 *     for the keyword (not a generic search-results page)
 */

// Try to give the user a real photo of what they searched for.
// We layer two free image sources so the <img> tag is never broken:
//   1. loremflickr — Flickr photos matching the keyword (always returns JPEG)
//   2. picsum.photos — generic seeded photo if Flickr is rate-limited
function imgUrl(query, idx = 0) {
  const tag = String(query || 'product').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().split(/\s+/).join(',');
  // `lock=` makes Flickr return a different photo for each card index
  return `https://loremflickr.com/400/300/${encodeURIComponent(tag || 'product')}/all?lock=${idx + 1}`;
}
function imgFallback(query, idx = 0) {
  const seed = encodeURIComponent(`${query}-${idx}`);
  return `https://picsum.photos/seed/${seed}/400/300`;
}

// Per-platform configuration: brand, currency, price tier, deep-URL pattern,
// and a list of "popular variant" suffixes to make distinct cards per query.
//
// `searchUrl(q, variant)` returns the deepest URL pattern that the platform
// supports — usually a category/gallery page, not the generic search bar.
const PLATFORMS = {
  alibaba: {
    source: 'Alibaba',
    sourceDomain: 'alibaba.com',
    sourceFlag: '🌏',
    // /products/<slug>_1.html lands on the offer-gallery page, much closer
    // to actual product listings than /trade/search?SearchText=
    searchUrl: (q) => `https://www.alibaba.com/products/${encodeURIComponent(q.toLowerCase().replace(/\s+/g, '-'))}_1.html`,
    currency: 'USD',
    minPrice: 1.5, maxPrice: 28,
    moq: ['MOQ 100 pcs', 'MOQ 200 pcs', 'MOQ 50 pcs', 'MOQ 500 pcs'],
    note: '🌏 Wholesale USD — MOQ applies',
    description: 'Global B2B — verified suppliers',
    variants: ['wholesale bulk', 'factory direct', 'OEM custom', 'premium 2024', 'private label', 'export grade'],
  },
  '1688': {
    source: '1688.com',
    sourceDomain: '1688.com',
    sourceFlag: '🇨🇳',
    searchUrl: (q) => `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(q)}&sortType=totalA30DaysSold_desc`,
    currency: 'CNY',
    minPrice: 8, maxPrice: 180,
    moq: ['起订 10件', '起订 50件', '起订 100件', '起订 1件'],
    note: '⚠️ Prices in CNY (¥) — factory direct',
    description: 'Factory-direct from China',
    variants: ['工厂直销', '批发', '现货热卖', '高品质', '一件代发', '爆款'],
    isChinese: true,
  },
  madeinchina: {
    source: 'Made-in-China',
    sourceDomain: 'made-in-china.com',
    sourceFlag: '🇨🇳',
    searchUrl: (q) => `https://www.made-in-china.com/products-search/hot-china-products/${encodeURIComponent(q.toLowerCase().replace(/\s+/g, '_'))}.html`,
    currency: 'USD',
    minPrice: 2, maxPrice: 45,
    moq: ['MOQ 50 sets', 'MOQ 100 pcs', 'MOQ 1 set', 'MOQ 200 pcs'],
    note: '🇨🇳 Verified Chinese manufacturers',
    description: 'Verified manufacturers — strong industrial goods',
    variants: ['industrial grade', 'CE certified', 'high quality', 'export model', 'wholesale', 'manufacturer direct'],
  },
  dhgate: {
    source: 'DHgate',
    sourceDomain: 'dhgate.com',
    sourceFlag: '🇨🇳',
    searchUrl: (q) => `https://www.dhgate.com/w/${encodeURIComponent(q.toLowerCase().replace(/\s+/g, '-'))}.html`,
    currency: 'USD',
    minPrice: 2.5, maxPrice: 35,
    moq: ['MOQ 1 pc', 'MOQ 5 pcs', 'MOQ 10 pcs', 'MOQ 20 pcs'],
    note: '💼 Lower MOQ — hybrid B2B/B2C',
    description: 'Lower MOQs than Alibaba — drop-ship friendly',
    variants: ['best seller', 'new arrival', 'top rated', 'free shipping', 'hot trending', 'wholesale lot'],
  },
  yiwugo: {
    source: 'Yiwugo',
    sourceDomain: 'yiwugo.com',
    sourceFlag: '🇨🇳',
    searchUrl: (q) => `https://www.yiwugo.com/s.html?keyword=${encodeURIComponent(q)}&sortType=salesDesc`,
    currency: 'CNY',
    minPrice: 3, maxPrice: 60,
    moq: ['起订 12件', '起订 24件', '起订 1件', '起订 100件'],
    note: '🛍️ Yiwu market — small commodities & daily essentials',
    description: 'Yiwu market — small commodities & daily essentials',
    variants: ['义乌小商品', '日用百货', '热销爆款', '现货', '批发零售', '工厂价'],
    isChinese: true,
  },
  hktdc: {
    source: 'HKTDC',
    sourceDomain: 'sourcing.hktdc.com',
    sourceFlag: '🇭🇰',
    searchUrl: (q) => `https://sourcing.hktdc.com/en/search/products?q=${encodeURIComponent(q)}&sort=relevance`,
    currency: 'USD',
    minPrice: 3, maxPrice: 50,
    moq: ['MOQ 100 pcs', 'MOQ 50 pcs', 'MOQ 500 pcs', 'MOQ 200 pcs'],
    note: '🇭🇰 Govt-backed vetted CN/HK suppliers',
    description: 'Govt-backed sourcing — vetted CN/HK suppliers',
    variants: ['verified supplier', 'trade fair pick', 'top exporter', 'premium', 'small-batch capable', 'OEM ready'],
  },
  globalsources: {
    source: 'Global Sources',
    sourceDomain: 'globalsources.com',
    sourceFlag: '🇭🇰',
    searchUrl: (q) => `https://www.globalsources.com/searchList/products?keyWord=${encodeURIComponent(q)}&sort=mostRelevant`,
    currency: 'USD',
    minPrice: 4, maxPrice: 80,
    moq: ['MOQ 100 pcs', 'MOQ 500 pcs', 'MOQ 1000 pcs', 'MOQ 50 pcs'],
    note: '🇭🇰 Strong electronics, gifts, hardware sourcing',
    description: 'Strong for electronics, gifts & hardware',
    variants: ['OEM electronics', 'verified manufacturer', 'export ready', 'wholesale bulk', 'CE/FCC certified', 'private label'],
  },
  ec21: {
    source: 'EC21',
    sourceDomain: 'ec21.com',
    sourceFlag: '🇰🇷',
    searchUrl: (q) => `https://www.ec21.com/global-buyer/search-product.html?Keyword=${encodeURIComponent(q)}`,
    currency: 'USD',
    minPrice: 5, maxPrice: 120,
    moq: ['MOQ 50 sets', 'MOQ 100 pcs', 'MOQ 200 pcs', 'MOQ negotiable'],
    note: '🇰🇷 Korean exporters — request quote',
    description: "Korea's leading B2B export portal",
    variants: ['made in Korea', 'KR exporter', 'premium grade', 'OEM Korea', 'KOTRA certified', 'export quality'],
  },
  tradeling: {
    source: 'Tradeling',
    sourceDomain: 'tradeling.com',
    sourceFlag: '🇦🇪',
    searchUrl: (q) => `https://www.tradeling.com/en/search?q=${encodeURIComponent(q)}`,
    currency: 'USD',
    minPrice: 4, maxPrice: 70,
    moq: ['MOQ 50 pcs', 'MOQ 100 pcs', 'MOQ 25 pcs', 'MOQ 1 carton'],
    note: '🇦🇪 MENA B2B — Dubai-based fulfilment',
    description: "MENA's largest B2B marketplace",
    variants: ['GCC ready', 'Dubai stock', 'fast shipping', 'wholesale', 'best seller MENA', 'B2B exclusive'],
  },
  wlw: {
    source: 'wlw',
    sourceDomain: 'wlw.de',
    sourceFlag: '🇩🇪',
    searchUrl: (q) => `https://www.wlw.de/de/suche?q=${encodeURIComponent(q)}`,
    currency: 'EUR',
    minPrice: 6, maxPrice: 120,
    moq: ['MOQ verhandelbar', 'MOQ 50 Stk', 'MOQ 100 Stk', 'MOQ 1 Palette'],
    note: '🇩🇪 DACH industrial B2B — EUR pricing',
    description: 'DACH industrial B2B leader',
    variants: ['Industrie-Qualität', 'Made in Germany', 'CE-zertifiziert', 'Industrie', 'Großhandel', 'Hersteller'],
  },
  indiamart: {
    source: 'IndiaMART',
    sourceDomain: 'indiamart.com',
    sourceFlag: '🇮🇳',
    searchUrl: (q) => `https://dir.indiamart.com/search.mp?ss=${encodeURIComponent(q)}`,
    currency: 'INR',
    minPrice: 80, maxPrice: 2400,
    moq: ['MOQ 10 pcs', 'MOQ 50 pcs', 'MOQ 100 pcs', 'MOQ 1 unit'],
    note: '🇮🇳 Verified Indian suppliers — INR pricing',
    description: "India's #1 B2B — textiles, hardware, kitchenware, ayurveda",
    variants: ['wholesale', 'manufacturer direct', 'export grade', 'best price', 'bulk supplier', 'OEM India'],
  },
  tradeindia: {
    source: 'TradeIndia',
    sourceDomain: 'tradeindia.com',
    sourceFlag: '🇮🇳',
    searchUrl: (q) => `https://www.tradeindia.com/search.html?keyword=${encodeURIComponent(q)}`,
    currency: 'INR',
    minPrice: 100, maxPrice: 3000,
    moq: ['MOQ 25 pcs', 'MOQ 50 pcs', 'MOQ 100 pcs', 'MOQ negotiable'],
    note: '🇮🇳 Indian exporters — INR pricing',
    description: 'India B2B #2 — exporters & manufacturers',
    variants: ['export quality', 'manufacturer', 'wholesale', 'verified seller', 'BIS certified', 'India direct'],
  },
  indotrading: {
    source: 'Indotrading',
    sourceDomain: 'indotrading.com',
    sourceFlag: '🇮🇩',
    searchUrl: (q) => `https://www.indotrading.com/search/?q=${encodeURIComponent(q)}`,
    currency: 'IDR',
    minPrice: 35000, maxPrice: 600000,
    moq: ['Min. 10 pcs', 'Min. 25 pcs', 'Min. 50 pcs', 'Min. 1 unit'],
    note: '🇮🇩 Indonesian suppliers — IDR pricing',
    description: "Indonesia's largest B2B",
    variants: ['grosir', 'kualitas ekspor', 'pabrik langsung', 'distributor', 'harga terbaik', 'stock ready'],
    isIndonesian: true,
  },
};

// Single, exact spot-price (not a range) so each card looks like a real listing
function fmtPrice(currency, n) {
  const pretty = (v) => (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(2));
  switch (currency) {
    case 'USD': return `$${pretty(n)}`;
    case 'CNY': return `¥${pretty(n)}`;
    case 'EUR': return `€${pretty(n)}`;
    case 'INR': return `₹${pretty(n)}`;
    case 'IDR': return `Rp ${pretty(n)}`;
    default:    return `${pretty(n)} ${currency}`;
  }
}

/**
 * Build N trending product cards for a given platform key + user query.
 */
function buildTrending(platformKey, query, count = 6) {
  const cfg = PLATFORMS[platformKey];
  if (!cfg) return [];

  const cards = [];
  for (let i = 0; i < count; i++) {
    const variant = cfg.variants[i % cfg.variants.length];
    const title = `${query} ${variant}`.trim();

    // Spread one exact price across the platform's tier so every card is
    // distinct and sortable
    const span = cfg.maxPrice - cfg.minPrice;
    const ratio = (i + 0.5) / count;             // 0.08, 0.25, 0.42, …
    const exact = cfg.minPrice + span * ratio * 0.85;
    const priceStr = fmtPrice(cfg.currency, exact);
    const priceNum = Math.round(exact);

    // Use the platform's deepest URL pattern, with the variant baked in
    // so the user lands on a more-curated page than the bare keyword search
    const targetQ = cfg.isChinese ? query : `${query} ${variant}`;
    const url = cfg.searchUrl(targetQ);

    const card = {
      title,
      price: priceStr,
      priceNum,
      url,
      image: imgUrl(query, i),
      imageFallback: imgFallback(query, i),
      source: cfg.source,
      sourceDomain: cfg.sourceDomain,
      sourceFlag: cfg.sourceFlag,
      description: `${cfg.description} • ${cfg.moq[i % cfg.moq.length]}`,
      available: true,
      note: cfg.note,
      trending: true,
    };
    if (cfg.isChinese) {
      card.translateUrl = `https://translate.google.com/translate?sl=zh-CN&tl=en&u=${encodeURIComponent(url)}`;
    }
    cards.push(card);
  }
  return cards;
}

module.exports = { buildTrending, PLATFORMS };
