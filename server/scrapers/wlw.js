/**
 * Wer liefert was (wlw.de) — DACH industrial B2B leader
 */
const axios = require('axios');
const cheerio = require('cheerio');
const { buildTrending } = require('./_trending');

async function scrapeWLW(query) {
  const results = [];
  const searchUrl = `https://www.wlw.de/de/suche?q=${encodeURIComponent(query)}`;

  try {
    const resp = await axios.get(searchUrl, {
      timeout: 18000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });

    if (resp.data && resp.data.length > 1000) {
      const $ = cheerio.load(resp.data);
      $('[class*="product-card"], [class*="ProductCard"], .search-result').each((i, el) => {
        if (i >= 8) return false;
        const $el = $(el);
        const title = $el.find('h2, h3, [class*="title"]').first().text().trim() || '';
        const href = $el.find('a').first().attr('href') || '';
        const img = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';
        if (!title || title.length < 4) return;
        let url = href;
        if (url && !url.startsWith('http')) url = `https://www.wlw.de${url.startsWith('/') ? '' : '/'}${url}`;
        results.push({
          title: title.substring(0, 150),
          price: 'Request Quote',
          priceNum: 999999,
          url,
          image: img,
          source: 'wlw',
          sourceDomain: 'wlw.de',
          sourceFlag: '🇩🇪',
          description: 'DACH industrial B2B leader',
          available: true,
          note: 'EUR pricing — request quote',
        });
      });
    }
  } catch (err) {
    console.warn('[WLW] Error:', err.message);
  }

  if (results.length === 0) {
    results.push(...buildTrending('wlw', query, 6));
  }
  return results;
}

module.exports = { scrapeWLW };
