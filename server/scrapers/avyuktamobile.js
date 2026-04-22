/**
 * AvyuktaMobile.com Scraper v4
 * Next.js store — Puppeteer + smart wait for product grid
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const BASE_URL = 'https://avyuktamobile.com';

// Map query keywords to Avyukta category slugs
const CATEGORY_MAP = {
  earbuds: 'airpods', earbud: 'airpods', tws: 'airpods', airpods: 'airpods',
  headphone: 'headphones', earphone: 'headphones', neckband: 'headphones',
  watch: 'smart-watch', smartwatch: 'smart-watch', 'smart watch': 'smart-watch',
  'ultra watch': 'ultra-smart-watch', 'series watch': 'series-smart-watch',
  speaker: 'bluetooth-speaker', bluetooth: 'bluetooth-speaker',
  powerbank: 'power-bank', 'power bank': 'power-bank',
  charger: 'car-chargers', cable: 'cable',
  'dash cam': 'dash-cam-car', dashcam: 'dash-cam-car', 'car camera': 'dash-cam-car', 
  'car dvr': 'dash-cam-car', 'dvr': 'dash-cam-car', 'car recorder': 'dash-cam-car',
  camera: 'action-cameras', 'action camera': 'action-cameras',
  drone: 'smart-drone', 'drone camera': 'smart-drone',
  trimmer: 'trimmer', clipper: 'trimmer', shaver: 'trimmer',
  projector: 'projector',
  printer: 'mini-printer',
  fan: 'fan',
  humidifier: 'humidifier',
  inverter: 'inverter',
  keyboard: 'wireless-keyboard',
  massager: 'body-massager',
  light: 'festive-and-modern-decoration-lights', 'led light': 'festive-and-modern-decoration-lights',
  tripod: 'tripod', 'gimbal': 'tripod',
  cctv: 'wi-fi-cctv-camera', 'security camera': 'wi-fi-cctv-camera',
  doorbell: 'doorbell',
};

function matchCategory(query) {
  const q = query.toLowerCase();
  // Check exact multi-word matches first
  for (const [keyword, cat] of Object.entries(CATEGORY_MAP)) {
    if (q.includes(keyword)) return cat;
  }
  return null;
}

async function scrapeAvyuktaMobile(query) {
  const results = [];
  let browser = null;

  try {
    const catSlug = matchCategory(query);
    const targetUrl = catSlug ? `${BASE_URL}/categories/${catSlug}` : null;
    
    if (!targetUrl) {
      console.log(`[AvyuktaMobile] No category match for: ${query}`);
      return results;
    }

    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--window-size=1280,900',
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });

    // Block images and fonts to speed up
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait up to 8 seconds for products to appear
    await page.waitForTimeout(5000);

    // Scroll to trigger lazy loading
    await page.evaluate(() => window.scrollBy(0, 600));
    await page.waitForTimeout(2000);

    const products = await page.evaluate((queryStr, base) => {
      const results = [];
      const seen = new Set();
      const queryWords = queryStr.toLowerCase().split(/\s+/).filter(w => w.length > 2);

      // Avyukta renders products as links/cards with price info
      // Try multiple selectors for their Next.js product grid
      const SELECTORS = [
        'a[href*="/products/"]',
        '[class*="product"] a',
        '[class*="card"] a',
        '[class*="item"] a',
      ];

      const all = new Set();
      SELECTORS.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => all.add(el));
      });

      all.forEach(el => {
        const href = el.getAttribute('href') || '';
        if (!href.includes('/products/')) return;

        const url = href.startsWith('http') ? href : `${base}${href}`;
        if (seen.has(url)) return;
        seen.add(url);

        // Get all text from the element and nearby context
        const container = el.closest('[class*="card"], [class*="product"], [class*="item"], li, article') || el;
        const allText = container.innerText || container.textContent || el.innerText || el.textContent || '';

        // Extract title by removing price patterns
        let title = allText.replace(/₹\s*[\d,]+/g, '').replace(/\d+%\s*OFF/gi, '').replace(/\/\s*piece/gi, '').trim();
        title = title.split('\n').find(s => s.trim().length > 5)?.trim() || '';
        if (!title) {
          // Try img alt
          const img = el.querySelector('img') || container.querySelector('img');
          title = img?.alt || '';
        }
        if (!title || title.length < 5) return;

        // Price
        const priceMatches = allText.match(/₹\s*([\d,]+)/g);
        let priceNum = 999999;
        let priceStr = 'See website';
        if (priceMatches && priceMatches.length > 0) {
          // Take the smallest price (sale price)
          const vals = priceMatches.map(p => parseInt(p.replace(/[₹\s,]/g, '')));
          priceNum = Math.min(...vals);
          priceStr = `₹${priceNum.toLocaleString('en-IN')}`;
        }

        // Image (re-enable images request to get URLs from data attributes)
        const img = container.querySelector('img') || el.querySelector('img');
        const imgSrc = img?.src || img?.getAttribute('data-src') || '';

        results.push({ title, price: priceStr, priceNum, url, image: imgSrc });
      });

      return results;
    }, query, BASE_URL);

    for (const p of products.slice(0, 10)) {
      results.push({
        title: p.title,
        price: p.price || 'See website',
        priceNum: p.priceNum || 999999,
        url: p.url,
        image: p.image,
        source: 'Avyukta Mobile',
        sourceDomain: 'avyuktamobile.com',
        sourceFlag: '📱',
        description: '',
        available: true,
      });
    }

    // If Puppeteer couldn't get products, at least return category link
    if (results.length === 0 && catSlug) {
      results.push({
        title: `${query} — Avyukta Mobile`,
        price: 'See website',
        priceNum: 999999,
        url: targetUrl,
        image: '',
        source: 'Avyukta Mobile',
        sourceDomain: 'avyuktamobile.com',
        sourceFlag: '📱',
        description: `Click to view ${query} products on Avyukta Mobile.`,
        available: true,
        note: 'Click to view live products',
      });
    }

  } catch (err) {
    console.error('[AvyuktaMobile] Error:', err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return results;
}

module.exports = { scrapeAvyuktaMobile };
