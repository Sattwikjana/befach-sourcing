/**
 * IndiaMART Scraper v3 — Uses Puppeteer (JS-rendered content only)
 * Reliable product extraction with current DOM structure
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const BASE_URL = 'https://www.indiamart.com';

async function scrapeIndiaMART(query) {
  const results = [];
  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,800'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    // Block images to speed up
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    const searchUrl = `${BASE_URL}/search.mp?ss=${encodeURIComponent(query)}&src=header-search`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for products
    await page.waitForTimeout(4000);

    const items = await page.evaluate(() => {
      const results = [];
      
      // IndiaMART current structure — multiple possible containers
      const selectors = [
        '[data-list-type="products"] .bx',
        '.product-container .bx',
        '.bx.unit',
        '.impctUnit',
        '.catlistingwrap li',
        '[class*="product"] [class*="card"]',
        'li[class*="bx"]',
        '.div-prod',
        '[class*="prod-box"]',
      ];

      let cards = [];
      for (const sel of selectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 0) { cards = Array.from(found); break; }
      }

      // Fallback: look for any links with product-like structure
      if (cards.length === 0) {
        document.querySelectorAll('a[href*="indiamart.com"], a[href*="proddetail"]').forEach(a => {
          const title = a.getAttribute('title') || a.textContent?.trim();
          const href = a.href;
          if (title && title.length > 10 && href.includes('indiamart')) {
            const parent = a.closest('li, div, article') || a;
            cards.push(parent);
          }
        });
      }

      cards.slice(0, 8).forEach(card => {
        // Title
        const titleEl = card.querySelector('.pname a, [class*="pname"] a, h3 a, h2 a, [class*="title"] a, a[class*="name"]');
        const title = titleEl?.textContent?.trim() || titleEl?.getAttribute('title') || '';
        if (!title || title.length < 3) return;

        // URL
        const href = titleEl?.href || card.querySelector('a')?.href || '';

        // Price
        const priceEl = card.querySelector('[class*="price"], .prc, .price');
        const price = priceEl?.textContent?.trim() || 'Get Quote';

        // Image
        const img = card.querySelector('img');
        const imgSrc = img?.src || img?.dataset?.src || '';

        // Description
        const descEl = card.querySelector('[class*="desc"], .sdesc, p');
        const desc = descEl?.textContent?.trim() || '';

        results.push({ title, price, url: href, image: imgSrc, description: desc });
      });

      return results;
    });

    for (const item of items) {
      if (!item.title) continue;
      const priceNum = extractPrice(item.price);
      results.push({
        title: item.title,
        price: item.price || 'Get Quote',
        priceNum,
        url: item.url || BASE_URL,
        image: item.image || '',
        source: 'IndiaMART',
        sourceDomain: 'indiamart.com',
        sourceFlag: '🇮🇳',
        description: (item.description || '').substring(0, 150),
        available: true,
        note: 'B2B marketplace — contact seller for wholesale pricing',
      });
    }

    // If no products found via DOM, at least provide the search link
    if (results.length === 0) {
      results.push({
        title: `${query} — IndiaMART Wholesale Suppliers`,
        price: 'Get Quote',
        priceNum: 999999,
        url: `${BASE_URL}/search.mp?ss=${encodeURIComponent(query)}`,
        image: '',
        source: 'IndiaMART',
        sourceDomain: 'indiamart.com',
        sourceFlag: '🇮🇳',
        description: 'Click to view B2B wholesale suppliers and pricing on IndiaMART.',
        available: true,
        note: 'Click to view live supplier listings',
      });
    }

  } catch (err) {
    console.error('[IndiaMART] Error:', err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return results;
}

function extractPrice(str) {
  if (!str) return 999999;
  const m = String(str).replace(/[₹Rs.,\s]/g, '').match(/\d+/);
  if (!m) return 999999;
  const n = parseInt(m[0]);
  return isNaN(n) || n <= 0 ? 999999 : n;
}

module.exports = { scrapeIndiaMART };
