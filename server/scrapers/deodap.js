/**
 * DeoDap.in Scraper v4 — With relevance filtering
 * Uses Shopify suggest API + HTML fallback, filters by query relevance
 */
const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://deodap.in';

async function scrapeDeodap(query) {
  const results = [];
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  function isRelevant(title) {
    if (!title || !queryWords.length) return false;
    const t = title.toLowerCase();
    return queryWords.some(w => t.includes(w));
  }

  // ── Attempt 1: Shopify Suggest API ──
  try {
    const apiUrl = `${BASE_URL}/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=12&resources[options][unavailable_products]=last`;
    const resp = await axios.get(apiUrl, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': BASE_URL,
      },
    });

    const products = resp.data?.resources?.results?.products || [];
    for (const p of products) {
      if (!p.title) continue;
      const raw = String(p.price || '').replace(/[^0-9.]/g, '');
      const priceNum = raw ? Math.round(parseFloat(raw)) : 999999;
      results.push({
        title: p.title,
        price: priceNum < 999999 ? `₹${priceNum.toLocaleString('en-IN')}` : 'See website',
        priceNum,
        url: p.url ? `${BASE_URL}${p.url}` : BASE_URL,
        image: p.image || '',
        source: 'DeoDap',
        sourceDomain: 'deodap.in',
        sourceFlag: '🛒',
        description: stripHtml(p.body || '').substring(0, 150),
        available: true,
      });
    }
  } catch (err) {
    console.warn('[DeoDap] Suggest API failed:', err.message);
  }

  // ── Attempt 2: HTML Search Page ──
  // Always run HTML scrape since suggest sometimes misses products
  try {
    const htmlUrl = `${BASE_URL}/search?q=${encodeURIComponent(query)}&type=product&sort_by=relevance`;
    const resp = await axios.get(htmlUrl, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
    });

    const $ = cheerio.load(resp.data);

    // Extract products from Shopify search HTML — multiple selectors
    $('[data-product-id], .product-item, .grid-product, .card-wrapper, .product-card').each((i, el) => {
      if (results.length >= 10) return false;
      const $el = $(el);
      
      const titleEl = $el.find('a.card__heading--link, .card__heading a, .product-item__title, h3 a, h2 a, .product-title').first();
      const title = titleEl.text().trim() || $el.find('a').first().attr('aria-label') || '';
      if (!title || title.length < 3) return;
      if (!isRelevant(title)) return; // ← KEY: only add relevant results
      if (results.find(r => r.title === title)) return; // dedup

      const href = titleEl.attr('href') || $el.find('a[href*="/products/"]').first().attr('href') || '';
      const url = href.startsWith('http') ? href : (href ? `${BASE_URL}${href}` : BASE_URL);

      const priceText = $el.find('.price .money, .price__sale .money, .price-item--sale, .product-price').first().text().trim()
        || $el.find('[class*="price"]').first().text().trim();
      const priceNum = extractINRPrice(priceText);

      const img = $el.find('img').first();
      let imgSrc = img.attr('src') || img.attr('data-src') || '';
      if (imgSrc.startsWith('//')) imgSrc = `https:${imgSrc}`;

      results.push({
        title,
        price: priceNum < 999999 ? `₹${priceNum.toLocaleString('en-IN')}` : (priceText || 'See website'),
        priceNum,
        url,
        image: imgSrc,
        source: 'DeoDap',
        sourceDomain: 'deodap.in',
        sourceFlag: '🛒',
        description: '',
        available: true,
      });
    });
  } catch (err) {
    console.error('[DeoDap] HTML scrape error:', err.message);
  }

  // Filter all results by relevance before returning
  const filtered = results.filter(r => isRelevant(r.title));
  
  // Deduplicate by title
  const seen = new Set();
  return filtered.filter(r => {
    const key = r.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripHtml(html) {
  return String(html).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function extractINRPrice(str) {
  if (!str) return 999999;
  const cleaned = str.replace(/[₹Rs.\s]/g, '').replace(/,/g, '');
  const nums = cleaned.match(/\d+(?:\.\d+)?/g);
  if (!nums) return 999999;
  const values = nums.map(n => parseFloat(n)).filter(n => n > 0 && n < 100000);
  if (values.length === 0) return 999999;
  return Math.round(Math.min(...values));
}

module.exports = { scrapeDeodap };
