/**
 * TradeIndia Scraper — India B2B #2
 */
const axios = require('axios');
const cheerio = require('cheerio');
const { buildTrending } = require('./_trending');

async function scrapeTradeIndia(query) {
  const results = [];
  const searchUrl = `https://www.tradeindia.com/search.html?keyword=${encodeURIComponent(query)}`;

  try {
    const resp = await axios.get(searchUrl, {
      timeout: 18000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
    });

    if (resp.data && resp.data.length > 1000) {
      const $ = cheerio.load(resp.data);
      $('.product-card, [class*="product-item"], .ti-product, .list-item').each((i, el) => {
        if (i >= 8) return false;
        const $el = $(el);
        const title = $el.find('h2, h3, [class*="title"], a[title]').first().text().trim()
                   || $el.find('a[title]').first().attr('title') || '';
        const href = $el.find('a').first().attr('href') || '';
        const priceTxt = $el.find('[class*="price"]').first().text().trim();
        const img = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';
        if (!title || title.length < 4) return;
        let url = href;
        if (url && !url.startsWith('http')) url = `https://www.tradeindia.com${url.startsWith('/') ? '' : '/'}${url}`;
        results.push({
          title: title.substring(0, 150),
          price: priceTxt || 'Request Quote',
          priceNum: extractPrice(priceTxt),
          url,
          image: img,
          source: 'TradeIndia',
          sourceDomain: 'tradeindia.com',
          sourceFlag: '🇮🇳',
          description: 'India B2B #2 — manufacturers & exporters',
          available: true,
          note: 'INR pricing — Indian suppliers',
        });
      });
    }
  } catch (err) {
    console.warn('[TradeIndia] Error:', err.message);
  }

  if (results.length === 0) {
    results.push(...buildTrending('tradeindia', query, 6));
  }
  return results;
}

function extractPrice(str) {
  if (!str) return 999999;
  const m = String(str).replace(/[₹Rs.,$\s]/g, '').match(/[\d.]+/);
  if (!m) return 999999;
  const n = parseFloat(m[0]);
  return isNaN(n) || n <= 0 ? 999999 : Math.round(n);
}

module.exports = { scrapeTradeIndia };
