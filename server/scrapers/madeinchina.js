/**
 * Made-in-China.com Scraper
 * Verified Chinese manufacturers — strong industrial goods
 * axios + cheerio with safe fallback to a direct search link.
 */
const axios = require('axios');
const cheerio = require('cheerio');
const { buildTrending } = require('./_trending');

async function scrapeMadeInChina(query) {
  const results = [];
  const searchUrl = `https://www.made-in-china.com/products-search/hot-china-products/${encodeURIComponent(query.replace(/\s+/g, '_'))}.html`;

  try {
    const resp = await axios.get(searchUrl, {
      timeout: 18000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.made-in-china.com/',
      },
      maxRedirects: 4,
    });

    if (resp.data && resp.data.length > 1000) {
      const $ = cheerio.load(resp.data);
      const cards = $('.prod-info, .product-item, .list-node, [class*="product-card"]');
      cards.each((i, el) => {
        if (i >= 8) return false;
        const $el = $(el);
        const title = $el.find('h2, .product-name a, [class*="title"] a, a[title]').first().text().trim()
                  || $el.find('a[title]').first().attr('title') || '';
        const href = $el.find('a').first().attr('href') || '';
        const priceTxt = $el.find('[class*="price"]').first().text().trim();
        const img = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';
        if (!title || title.length < 4) return;
        let url = href;
        if (url && !url.startsWith('http')) url = `https:${url}`;
        results.push({
          title: title.substring(0, 150),
          price: priceTxt || 'Request Quote',
          priceNum: extractPrice(priceTxt),
          url: url || searchUrl,
          image: img,
          source: 'Made-in-China',
          sourceDomain: 'made-in-china.com',
          sourceFlag: '🇨🇳',
          description: 'Verified Chinese manufacturers',
          available: true,
          note: 'Prices in USD — wholesale MOQ applies',
        });
      });
    }
  } catch (err) {
    console.warn('[Made-in-China] Error:', err.message);
  }

  if (results.length === 0) {
    results.push(...buildTrending('madeinchina', query, 6));
  }
  return results;
}

function extractPrice(str) {
  if (!str) return 999999;
  const m = String(str).replace(/[,$\s]/g, '').match(/[\d.]+/);
  if (!m) return 999999;
  const n = parseFloat(m[0]);
  return isNaN(n) || n <= 0 ? 999999 : Math.round(n);
}

module.exports = { scrapeMadeInChina };
