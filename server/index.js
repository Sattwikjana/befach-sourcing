/**
 * Befach Sourcing — Backend v5.0 (Alibaba-only)
 *
 * Single source of truth: alibaba.com. For each search we return real
 * product listings with real images, real prices, and direct product-
 * detail URLs. If Alibaba blocks the axios fast-path, we transparently
 * fall back to a headless Chromium with stealth to get the same data.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { scrapeAlibaba, closeBrowser } = require('./scrapers/alibaba');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '5.0' });
});

// ── Image proxy: alicdn.com hotlink-protects its images by checking the
// Referer header. Browser requests from our localhost get blocked. So we
// fetch the image server-side with the correct Referer and pipe it back
// to the browser. Aggressively cached.
const axios = require('axios');
const IMG_CACHE = new Map(); // url → { ts, buf, type }
const IMG_TTL_MS = 24 * 60 * 60 * 1000;

app.get('/api/img', async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    return res.status(400).end();
  }
  // Whitelist Alibaba/Aliexpress CDNs — refuse to proxy anything else
  if (!/(alicdn\.com|aliexpress|alibaba\.com)/i.test(url)) {
    return res.status(400).end();
  }

  const cached = IMG_CACHE.get(url);
  if (cached && Date.now() - cached.ts < IMG_TTL_MS) {
    res.set('Content-Type', cached.type);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.end(cached.buf);
  }

  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 12000,
      headers: {
        // Pretend we're a browser ON alibaba.com so the CDN serves the image
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://www.alibaba.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });
    const buf = Buffer.from(r.data);
    const type = r.headers['content-type'] || 'image/jpeg';
    IMG_CACHE.set(url, { ts: Date.now(), buf, type });
    res.set('Content-Type', type);
    res.set('Cache-Control', 'public, max-age=86400');
    res.end(buf);
  } catch (err) {
    res.status(502).end();
  }
});

// Kept so the platforms launcher in the UI still works if it's ever used
let PLATFORMS_CACHE = null;
app.get('/api/platforms', (req, res) => {
  try {
    if (!PLATFORMS_CACHE) {
      const p = path.join(__dirname, '..', 'public', 'data', 'platforms.json');
      PLATFORMS_CACHE = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    res.json({ count: PLATFORMS_CACHE.length, platforms: PLATFORMS_CACHE });
  } catch (e) {
    res.status(500).json({ error: 'platforms.json missing', detail: e.message });
  }
});

// ── Price normalizer ──
function normalizePrice(priceStr) {
  if (!priceStr) return 999999;
  const s = String(priceStr);
  if (/quote|request|contact|n\/a|—|see/i.test(s)) return 999999;
  const m = s.replace(/[₹Rs.,$¥€,\s]/g, '').match(/[\d.]+/);
  if (!m) return 999999;
  const n = parseFloat(m[0]);
  if (isNaN(n) || n <= 0) return 999999;
  return Math.round(n * 100) / 100;
}

// ── Best Value scorer (lowest priced = best pick) ──
function scoreAndRank(results) {
  const ranked = results
    .filter(r => r && r.title)
    .map(r => ({
      ...r,
      priceNum: r.priceNum > 0 && r.priceNum < 999999
        ? r.priceNum
        : normalizePrice(r.price),
    }));

  ranked.sort((a, b) => {
    const aPriced = a.priceNum < 999999;
    const bPriced = b.priceNum < 999999;
    if (aPriced && !bPriced) return -1;
    if (!aPriced && bPriced) return 1;
    return a.priceNum - b.priceNum;
  });

  const priced = ranked.filter(r => r.priceNum < 999999);
  if (priced.length > 0) {
    const lowest = priced[0].priceNum;
    const threshold = lowest * 1.25;
    ranked.forEach(r => {
      if (r.priceNum <= threshold && r.priceNum < 999999) r.bestValue = true;
      if (r.priceNum === lowest) r.bestPick = true;
    });
  }
  return ranked;
}

// ── Helper: run scraper with timeout & error catch ──
async function runScraper(name, fn, query, timeoutMs) {
  return new Promise(async (resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[${name}] Timeout after ${timeoutMs}ms`);
      resolve([]);
    }, timeoutMs);

    try {
      const results = await fn(query);
      clearTimeout(timer);
      resolve(Array.isArray(results) ? results : []);
    } catch (err) {
      clearTimeout(timer);
      console.error(`[${name}] Error: ${err.message}`);
      resolve([]);
    }
  });
}

// ── 1-hour in-memory cache ──
const QUERY_CACHE = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;
function cacheGet(key) {
  const e = QUERY_CACHE.get(key);
  if (!e || Date.now() - e.ts > CACHE_TTL_MS) return null;
  return e.results;
}
function cacheSet(key, results) {
  QUERY_CACHE.set(key, { ts: Date.now(), results });
}

// ── SSE Search Endpoint ──
app.post('/api/search', async (req, res) => {
  const { query, crmRef } = req.body;

  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Product name is required' });
  }

  const cleanQuery = query.trim();
  const cacheKey = cleanQuery.toLowerCase();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  send({ type: 'start', message: `🔍 Sourcing: "${cleanQuery}"`, crmRef });

  const src = { name: 'Alibaba', domain: 'alibaba.com', flag: '🌏', timeout: 45000 };

  send({
    type: 'phase',
    phase: 1,
    message: '🌏 Searching Alibaba.com…',
    sources: [{ name: src.name, domain: src.domain, flag: src.flag }],
  });
  send({ type: 'searching', source: src.name, domain: src.domain, flag: src.flag });

  // No CAPTCHA hint in the UI — Chrome runs invisibly in headless mode.
  // (The hint timer stays as a no-op variable to keep the cancel() calls
  //  below working without extra branching.)
  const captchaHint = setTimeout(() => {}, 0);

  // Cache hit?
  let results = cacheGet(cacheKey);
  if (results) {
    send({
      type: 'results', source: src.name, domain: src.domain, flag: src.flag,
      count: results.length, results, cached: true,
      message: `⚡ ${results.length} cached from Alibaba`,
    });
    clearTimeout(captchaHint);
  } else {
    // Bump the timeout because solving CAPTCHA can take ~30-60s
    results = await runScraper(src.name, scrapeAlibaba, cleanQuery, 120_000);
    clearTimeout(captchaHint);
    results = results.map(r => ({
      ...r,
      priceNum: r.priceNum && r.priceNum < 999999 ? r.priceNum : normalizePrice(r.price),
    }));
    cacheSet(cacheKey, results);

    send({
      type: 'results',
      source: src.name,
      domain: src.domain,
      flag: src.flag,
      count: results.length,
      results,
      message: results.length > 0
        ? `✅ ${results.length} products from Alibaba`
        : `❌ No products from Alibaba`,
    });
  }

  const ranked = scoreAndRank(results);

  send({
    type: 'ranked',
    results: ranked,
    totalCount: ranked.length,
    bestPickPrice: ranked.find(r => r.bestPick)?.price || null,
    message: ranked.length > 0
      ? `✅ Done! ${ranked.length} products from Alibaba.`
      : `No products found. Try a different keyword.`,
  });

  send({ type: 'done', totalCount: ranked.length });
  res.end();
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Befach Sourcing Platform v5.0 (Alibaba-only)`);
  console.log(`📍 http://localhost:${PORT}`);
});

process.on('SIGTERM', () => closeBrowser().then(() => process.exit(0)));
process.on('SIGINT',  () => closeBrowser().then(() => process.exit(0)));
