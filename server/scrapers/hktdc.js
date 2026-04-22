/**
 * HKTDC Sourcing Scraper
 * Govt-backed, vetted CN/HK suppliers
 */
const axios = require('axios');
const cheerio = require('cheerio');
const { buildTrending } = require('./_trending');

async function scrapeHKTDC(query) {
  const results = [];
  const searchUrl = `https://sourcing.hktdc.com/en/search/?q=${encodeURIComponent(query)}`;

  try {
    const resp = await axios.get(searchUrl, {
      timeout: 18000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-HK,en;q=0.9',
      },
    });

    if (resp.data && resp.data.length > 1000) {
      const $ = cheerio.load(resp.data);
      $('.product-card, [class*="product"], .list-item').each((i, el) => {
        if (i >= 8) return false;
        const $el = $(el);
        const title = $el.find('h2, h3, [class*="title"], a[title]').first().text().trim() || '';
        const href = $el.find('a').first().attr('href') || '';
        const priceTxt = $el.find('[class*="price"]').first().text().trim();
        const img = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';
        if (!title || title.length < 4) return;
        let url = href;
        if (url && !url.startsWith('http')) url = `https://sourcing.hktdc.com${url.startsWith('/') ? '' : '/'}${url}`;
        results.push({
          title: title.substring(0, 150),
          price: priceTxt || 'Request Quote',
          priceNum: extractPrice(priceTxt),
          url,
          image: img,
          source: 'HKTDC',
          sourceDomain: 'sourcing.hktdc.com',
          sourceFlag: '🇭🇰',
          description: 'Govt-backed vetted CN/HK suppliers',
          available: true,
          note: 'HKTDC — trade fair backed sourcing',
        });
      });
    }
  } catch (err) {
    console.warn('[HKTDC] Error:', err.message);
  }

  if (results.length === 0) {
    results.push(...buildTrending('hktdc', query, 6));
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

module.exports = { scrapeHKTDC };
