/**
 * Yiwugo Scraper — Yiwu market (small commodities, daily essentials)
 */
const axios = require('axios');
const cheerio = require('cheerio');
const { buildTrending } = require('./_trending');

async function scrapeYiwugo(query) {
  const results = [];
  const searchUrl = `https://www.yiwugo.com/s.html?keyword=${encodeURIComponent(query)}`;

  try {
    const resp = await axios.get(searchUrl, {
      timeout: 18000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });

    if (resp.data && resp.data.length > 1000) {
      const $ = cheerio.load(resp.data);
      $('.product-list .product-item, [class*="goods-item"], .list-item').each((i, el) => {
        if (i >= 8) return false;
        const $el = $(el);
        const title = $el.find('a[title], .title a, h3').first().text().trim()
                   || $el.find('a[title]').first().attr('title') || '';
        const href = $el.find('a').first().attr('href') || '';
        const priceTxt = $el.find('[class*="price"]').first().text().trim();
        const img = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';
        if (!title || title.length < 3) return;
        let url = href;
        if (url && !url.startsWith('http')) url = `https:${url}`;
        const translateUrl = `https://translate.google.com/translate?sl=zh-CN&tl=en&u=${encodeURIComponent(url)}`;
        results.push({
          title: title.substring(0, 150),
          price: priceTxt ? `¥${priceTxt}` : 'See site',
          priceNum: extractPrice(priceTxt),
          url,
          image: img,
          source: 'Yiwugo',
          sourceDomain: 'yiwugo.com',
          sourceFlag: '🇨🇳',
          description: 'Yiwu market — small commodities, daily essentials',
          available: true,
          translateUrl,
          note: '⚠️ Prices in CNY (¥). Click 🌐 for English.',
        });
      });
    }
  } catch (err) {
    console.warn('[Yiwugo] Error:', err.message);
  }

  if (results.length === 0) {
    results.push(...buildTrending('yiwugo', query, 6));
  }
  return results;
}

function extractPrice(str) {
  if (!str) return 999999;
  const m = String(str).replace(/[,$\s¥]/g, '').match(/[\d.]+/);
  if (!m) return 999999;
  const n = parseFloat(m[0]);
  return isNaN(n) || n <= 0 ? 999999 : Math.round(n);
}

module.exports = { scrapeYiwugo };
