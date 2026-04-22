/**
 * Global Sources Scraper
 * Strong electronics, gifts, hardware sourcing
 */
const axios = require('axios');
const cheerio = require('cheerio');
const { buildTrending } = require('./_trending');

async function scrapeGlobalSources(query) {
  const results = [];
  const searchUrl = `https://www.globalsources.com/searchList/products?keyWord=${encodeURIComponent(query)}`;

  try {
    const resp = await axios.get(searchUrl, {
      timeout: 18000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (resp.data && resp.data.length > 1000) {
      const $ = cheerio.load(resp.data);
      $('.product-list .product-item, [class*="product-card"], .gs-product').each((i, el) => {
        if (i >= 8) return false;
        const $el = $(el);
        const title = $el.find('a[title], h3, .product-title').first().attr('title')
                   || $el.find('h3, .product-title').first().text().trim() || '';
        const href = $el.find('a').first().attr('href') || '';
        const priceTxt = $el.find('[class*="price"]').first().text().trim();
        const img = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';
        if (!title || title.length < 4) return;
        let url = href;
        if (url && !url.startsWith('http')) url = `https://www.globalsources.com${url.startsWith('/') ? '' : '/'}${url}`;
        results.push({
          title: title.substring(0, 150),
          price: priceTxt || 'Request Quote',
          priceNum: extractPrice(priceTxt),
          url,
          image: img,
          source: 'Global Sources',
          sourceDomain: 'globalsources.com',
          sourceFlag: '🇭🇰',
          description: 'Verified CN/HK suppliers — electronics & hardware',
          available: true,
          note: 'Prices in USD — wholesale MOQ applies',
        });
      });
    }
  } catch (err) {
    console.warn('[GlobalSources] Error:', err.message);
  }

  if (results.length === 0) {
    results.push(...buildTrending('globalsources', query, 6));
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

module.exports = { scrapeGlobalSources };
