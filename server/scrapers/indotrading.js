/**
 * Indotrading Scraper — Indonesia's largest B2B
 */
const axios = require('axios');
const cheerio = require('cheerio');
const { buildTrending } = require('./_trending');

async function scrapeIndotrading(query) {
  const results = [];
  const searchUrl = `https://www.indotrading.com/search/?q=${encodeURIComponent(query)}`;

  try {
    const resp = await axios.get(searchUrl, {
      timeout: 18000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      },
    });

    if (resp.data && resp.data.length > 1000) {
      const $ = cheerio.load(resp.data);
      $('.product-item, [class*="product-card"], .list-product li').each((i, el) => {
        if (i >= 8) return false;
        const $el = $(el);
        const title = $el.find('a[title], h3, h4, [class*="title"]').first().text().trim()
                   || $el.find('a[title]').first().attr('title') || '';
        const href = $el.find('a').first().attr('href') || '';
        const priceTxt = $el.find('[class*="price"]').first().text().trim();
        const img = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';
        if (!title || title.length < 4) return;
        let url = href;
        if (url && !url.startsWith('http')) url = `https://www.indotrading.com${url.startsWith('/') ? '' : '/'}${url}`;
        results.push({
          title: title.substring(0, 150),
          price: priceTxt || 'Request Quote',
          priceNum: 999999,
          url,
          image: img,
          source: 'Indotrading',
          sourceDomain: 'indotrading.com',
          sourceFlag: '🇮🇩',
          description: 'Indonesia\'s largest B2B',
          available: true,
          note: 'IDR pricing — local suppliers',
        });
      });
    }
  } catch (err) {
    console.warn('[Indotrading] Error:', err.message);
  }

  if (results.length === 0) {
    results.push(...buildTrending('indotrading', query, 6));
  }
  return results;
}

module.exports = { scrapeIndotrading };
