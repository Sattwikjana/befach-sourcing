/**
 * WholesellersIndia.in Scraper v3
 * QuickSell-based store — uses Puppeteer to render and search
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const BASE_URL = 'https://www.wholesellerindia.in';

async function scrapeWholesellersIndia(query) {
  const results = [];
  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });

    // Try searching their site
    const searchUrl = `${BASE_URL}/?searchTerm=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    await page.waitForTimeout(3000);

    // Try to click search if there's a search bar
    try {
      const searchInput = await page.$('input[type="search"], input[placeholder*="search"], input[placeholder*="Search"]');
      if (searchInput) {
        await searchInput.click();
        await searchInput.type(query, { delay: 50 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3000);
      }
    } catch {}

    const products = await page.evaluate((queryStr, base) => {
      const results = [];
      const seen = new Set();
      const queryWords = queryStr.toLowerCase().split(/\s+/).filter(w => w.length > 2);

      document.querySelectorAll('a').forEach(el => {
        const text = el.textContent?.trim() || '';
        const img = el.querySelector('img');
        const priceMatch = text.match(/₹\s*([\d,]+)/);

        if (!img || !priceMatch) return;

        const href = el.getAttribute('href') || '';
        const url = href.startsWith('http') ? href : (href.startsWith('/') ? base + href : base);

        if (seen.has(url)) return;
        seen.add(url);

        const titleText = text.replace(/₹[\s\d,.%OFFoff]+/gi, '').trim().substring(0, 120);
        if (!titleText || titleText.length < 5) return;

        const titleLower = titleText.toLowerCase();
        const isRelevant = queryWords.some(w => titleLower.includes(w));

        if (isRelevant && results.length < 8) {
          const priceNum = parseInt(priceMatch[1].replace(/,/g, ''));
          results.push({
            title: titleText,
            price: `₹${priceMatch[1]}`,
            priceNum,
            url,
            image: img.src || img.getAttribute('data-src') || '',
          });
        }
      });
      return results;
    }, query, BASE_URL);

    for (const p of products) {
      results.push({
        title: p.title,
        price: p.price || 'See website',
        priceNum: p.priceNum || 999999,
        url: p.url,
        image: p.image,
        source: 'Wholesellers India',
        sourceDomain: 'wholesellerindia.in',
        sourceFlag: '🏪',
        description: '',
        available: true,
      });
    }
  } catch (err) {
    console.error('[WholesellersIndia] Error:', err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return results;
}

module.exports = { scrapeWholesellersIndia };
