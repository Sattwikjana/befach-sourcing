/**
 * 1688.com Scraper v3
 * Chinese B2B — uses axios with cheerio (faster than Puppeteer)
 * Always returns at least a direct search link
 */
const axios = require('axios');
const cheerio = require('cheerio');
const { buildTrending } = require('./_trending');

async function scrape1688(query) {
  const results = [];

  try {
    const searchUrl = `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(query)}&sortType=totalA30DaysSold_desc`;

    const resp = await axios.get(searchUrl, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://s.1688.com/',
      },
      maxRedirects: 5,
    });

    const $ = cheerio.load(resp.data);

    // Multiple selector strategies for 1688
    const selectors = [
      '.offer-list-row > li',
      '.sm-offer-list > li',
      '[class*="offer-item"]',
      '[class*="product-item"]',
      '.list-item',
    ];

    for (const sel of selectors) {
      const items = $(sel);
      if (items.length === 0) continue;

      items.each((i, el) => {
        if (i >= 8) return false;
        const $el = $(el);

        const titleEl = $el.find('.title a, h2 a, [class*="title"] a, a[class*="title"]').first();
        const title = titleEl.text().trim() || $el.find('a').first().attr('title') || '';
        const href = titleEl.attr('href') || $el.find('a').first().attr('href') || '';
        const priceEl = $el.find('.price em, [class*="price"] em, .price, [class*="price"]').first();
        const priceText = priceEl.text().trim();
        const img = $el.find('img').first();
        const imgSrc = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || '';
        const moqEl = $el.find('[class*="quantity"], [class*="min-order"]').first();
        const moq = moqEl.text().trim();

        if (!title || title.length < 3) return;

        let url = href || '';
        if (url && !url.startsWith('http')) url = `https:${url}`;
        if (!url) return;

        const priceNum = priceText ? Math.round(parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0) : 0;
        const translateUrl = `https://translate.google.com/translate?sl=zh-CN&tl=en&u=${encodeURIComponent(url)}`;

        results.push({
          title,
          price: priceText ? `¥${priceText}` : 'See website',
          priceNum: priceNum > 0 ? priceNum : 999999,
          url,
          image: imgSrc,
          source: '1688.com',
          sourceDomain: '1688.com',
          sourceFlag: '🇨🇳',
          description: moq ? `Min. Order: ${moq}` : 'Factory-direct from China.',
          available: true,
          translateUrl,
          note: '⚠️ Prices in CNY (¥). Click 🌐 for English.',
        });
      });

      if (results.length > 0) break;
    }

    // Extract from JSON data if no HTML products found
    if (results.length === 0) {
      const html = resp.data;
      const jsonMatch = html.match(/var\s+offerList\s*=\s*(\[[\s\S]*?\]);/) ||
                        html.match(/"offerList"\s*:\s*(\[[\s\S]*?\])/);
      if (jsonMatch) {
        try {
          const items = JSON.parse(jsonMatch[1]);
          items.slice(0, 8).forEach(item => {
            const url = item.detailUrl || item.offer_url || '';
            const title = item.subjectTrans || item.subject || '';
            if (title && url) {
              results.push({
                title,
                price: item.price ? `¥${item.price}` : 'See website',
                priceNum: item.price ? Math.round(parseFloat(item.price)) : 999999,
                url: url.startsWith('http') ? url : `https:${url}`,
                image: item.imgUrl || '',
                source: '1688.com',
                sourceDomain: '1688.com',
                sourceFlag: '🇨🇳',
                description: 'Factory-direct pricing from China.',
                available: true,
                translateUrl: `https://translate.google.com/translate?sl=zh-CN&tl=en&u=${encodeURIComponent(url)}`,
                note: '⚠️ Prices in CNY (¥). Click 🌐 for English.',
              });
            }
          });
        } catch {}
      }
    }

  } catch (err) {
    console.error('[1688] Error:', err.message);
  }

  if (results.length === 0) {
    results.push(...buildTrending('1688', query, 6));
  }

  return results;
}

module.exports = { scrape1688 };
