/**
 * GadgetsMania.in Scraper v3
 * QuickSell store — uses their internal search via URL parameter
 * Site: https://gadgetsmania.in/?searchTerm=query
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const BASE_URL = 'https://gadgetsmania.in';

async function scrapeGadgetsMania(query) {
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

    // QuickSell search URL
    const searchUrl = `${BASE_URL}/?searchTerm=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 25000 });

    // Wait for products to render
    await page.waitForTimeout(3000);

    // Extract product data
    const products = await page.evaluate((queryStr, base) => {
      const results = [];
      const seen = new Set();
      const queryWords = queryStr.toLowerCase().split(/\s+/).filter(w => w.length > 2);

      // QuickSell stores use data attributes or specific patterns
      // Try to find product cards
      const selectors = [
        'a[data-product-id]',
        '[id*="product"] a',
        'a[href*="product"]',
        '.product a',
        'a[class*="product"]',
        'a[class*="card"]',
      ];

      const allLinks = [];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => allLinks.push(el));
      }

      // Also look for any link with an image that has a price nearby
      document.querySelectorAll('a').forEach(el => {
        const text = el.textContent || '';
        if (text.match(/₹\s*[\d,]+/) && el.querySelector('img')) {
          allLinks.push(el);
        }
      });

      for (const el of allLinks) {
        const href = el.getAttribute('href') || '';
        const url = href.startsWith('http') ? href : (href.startsWith('/') ? base + href : null);
        if (!url || !url.includes('gadgets') && !url.includes('catalog')) continue;
        if (seen.has(url)) continue;
        seen.add(url);

        const text = el.textContent?.trim() || '';
        const titleMatch = text.replace(/₹[\s\d,]+/g, '').trim().substring(0, 100);
        if (!titleMatch || titleMatch.length < 3) continue;

        const priceMatch = text.match(/₹\s*([\d,]+)/);
        let price = '';
        let priceNum = 999999;
        if (priceMatch) {
          priceNum = parseInt(priceMatch[1].replace(/,/g, ''));
          price = `₹${priceMatch[1]}`;
        }

        const img = el.querySelector('img');
        const imgSrc = img?.src || img?.getAttribute('data-src') || '';

        const titleLower = titleMatch.toLowerCase();
        const isRelevant = queryWords.some(w => titleLower.includes(w));
        if (isRelevant && results.length < 8) {
          results.push({ title: titleMatch, price, priceNum, url, image: imgSrc });
        }
      }

      return results;
    }, query, BASE_URL);

    for (const p of products) {
      results.push({
        title: p.title,
        price: p.price || 'See website',
        priceNum: p.priceNum,
        url: p.url,
        image: p.image,
        source: 'Gadgets Mania',
        sourceDomain: 'gadgetsmania.in',
        sourceFlag: '🔧',
        description: '',
        available: true,
      });
    }
  } catch (err) {
    console.error('[GadgetsMania] Error:', err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return results;
}

module.exports = { scrapeGadgetsMania };
