/**
 * Befach Sourcing — Frontend v3.0
 * Google-style single search + live SSE multi-marketplace results
 * Each product card links to the original product and includes a
 * landed-cost-to-India calculator link (calculator.befach.com).
 */

const API_BASE = '';
const CALC_URL = 'https://calculator.befach.com';
let allResults = [];
let rankedResults = [];
let currentQuery = '';

// ── DOM Refs ──
const searchForm = document.getElementById('searchForm');
const searchBtn = document.getElementById('searchBtn');
const productNameInput = document.getElementById('productName');

const progressSection = document.getElementById('progressSection');
const progressSites = document.getElementById('progressSites');
const progressQuery = document.getElementById('progressQuery');

const resultsSection = document.getElementById('resultsSection');
const resultsBySource = document.getElementById('resultsBySource');
const resultsMeta = document.getElementById('resultsMeta');
const emptyState = document.getElementById('emptyState');

const trendingGrid = document.getElementById('trendingGrid');
const trendingSection = document.getElementById('trendingSection');

const platformsSection = document.getElementById('platformsSection');
const platformsGrid = document.getElementById('platformsGrid');
const countryFilter = document.getElementById('countryFilter');
const platformsCount = document.getElementById('platformsCount');

const toast = document.getElementById('toast');
const serverStatus = document.getElementById('serverStatus');

// ── Single source: Alibaba.com (simplified Alibaba-only mode) ──
const SOURCES = [
  { key: 'Alibaba', domain: 'alibaba.com', flag: '🌏' },
];

// ── Country flag map for platform cards ──
const COUNTRY_FLAGS = {
  'United States':'🇺🇸','China':'🇨🇳','Hong Kong':'🇭🇰','Vietnam':'🇻🇳','Malaysia':'🇲🇾',
  'Singapore':'🇸🇬','Indonesia':'🇮🇩','South Korea':'🇰🇷','United Arab Emirates':'🇦🇪',
  'Saudi Arabia':'🇸🇦','Russia':'🇷🇺','United Kingdom':'🇬🇧','Germany':'🇩🇪','France':'🇫🇷',
  'Italy':'🇮🇹','Spain':'🇪🇸','Netherlands':'🇳🇱','Belgium':'🇧🇪','Poland':'🇵🇱',
  'Sweden':'🇸🇪','Austria':'🇦🇹','Australia':'🇦🇺',
};

// ── Trending products — all searched on Alibaba.com ──
const TRENDING = [
  { emoji: '🎧', name: 'TWS Wireless Earbuds',  query: 'tws wireless earbuds',       source: 'Alibaba' },
  { emoji: '⌚', name: 'Smart Watch',            query: 'smart watch',                source: 'Alibaba' },
  { emoji: '🔋', name: '20000mAh Power Bank',   query: '20000mah power bank',        source: 'Alibaba' },
  { emoji: '💡', name: 'LED Strip Lights',      query: 'rgb led strip lights',       source: 'Alibaba' },
  { emoji: '🔌', name: 'USB-C Fast Charger',    query: 'usb c fast charger 65w',     source: 'Alibaba' },
  { emoji: '🎮', name: 'Gaming Controller',     query: 'wireless gaming controller', source: 'Alibaba' },
  { emoji: '🖥️', name: 'Portable Monitor',      query: 'portable monitor 15.6 inch', source: 'Alibaba' },
  { emoji: '📱', name: 'Phone Case (Bulk)',     query: 'silicone phone case bulk',   source: 'Alibaba' },
  { emoji: '🎙️', name: 'Wireless Microphone',   query: 'wireless lavalier microphone', source: 'Alibaba' },
  { emoji: '🏠', name: 'Smart Home Plug',       query: 'smart home wifi plug',       source: 'Alibaba' },
  { emoji: '🧴', name: 'Skincare / Cosmetics',  query: 'cosmetics skincare serum',   source: 'Alibaba' },
  { emoji: '👟', name: 'Sports Sneakers',       query: 'sports sneakers wholesale',  source: 'Alibaba' },
];

// ── Health Check ──
let backendOnline = false;
async function checkServerHealth() {
  try {
    const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      backendOnline = true;
      serverStatus.className = 'status-pill online';
      serverStatus.querySelector('.status-text').textContent = 'Online';
      hideOfflineBanner();
    } else throw new Error();
  } catch {
    backendOnline = false;
    serverStatus.className = 'status-pill offline';
    serverStatus.querySelector('.status-text').textContent = 'Offline';
    showOfflineBanner();
  }
}
function showOfflineBanner() {
  let b = document.getElementById('offlineBanner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'offlineBanner';
    b.className = 'offline-banner';
    b.innerHTML = `
      <strong>⚠️ Backend server is not running.</strong>
      Open a terminal, then run:
      <code>cd "/path/to/Sourcing/server" &amp;&amp; npm run dev</code>
      and visit <a href="http://localhost:3001" target="_blank">http://localhost:3001</a> (not the file directly).
    `;
    document.body.prepend(b);
  }
}
function hideOfflineBanner() {
  const b = document.getElementById('offlineBanner');
  if (b) b.remove();
}
checkServerHealth();
setInterval(checkServerHealth, 15000);

// Warn if running from file:// — cannot call API
if (location.protocol === 'file:') {
  showOfflineBanner();
  const b = document.getElementById('offlineBanner');
  if (b) b.innerHTML = `<strong>⚠️ You opened this file directly.</strong>
    The search backend is only reachable via <code>http://localhost:3001</code>.
    Start it with <code>cd server &amp;&amp; npm run dev</code> and open that URL in your browser.`;
}

// ── Toast ──
function showToast(msg, duration = 3000) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 300);
  }, duration);
}

// ── Render Trending ──
function renderTrending() {
  trendingGrid.innerHTML = TRENDING.map(t => `
    <button class="trending-card" data-query="${escHtml(t.query)}">
      <div class="trending-emoji">${t.emoji}</div>
      <div class="trending-name">${escHtml(t.name)}</div>
      <div class="trending-source"><span class="dot"></span>${escHtml(t.source)}</div>
    </button>
  `).join('');

  trendingGrid.querySelectorAll('.trending-card').forEach(btn => {
    btn.addEventListener('click', () => {
      productNameInput.value = btn.dataset.query;
      doSearch();
    });
  });
}
renderTrending();

// ── Reset ──
function resetResults() {
  allResults = [];
  rankedResults = [];
  resultsBySource.innerHTML = '';
  progressSites.innerHTML = '';
  progressSection.classList.add('hidden');
  resultsSection.classList.add('hidden');
  emptyState.classList.add('hidden');
}

// ── Progress Card ──
function updateProgressCard(sourceName, status, count = 0) {
  const id = `progress-${sourceName.replace(/[\s.]/g, '-')}`;
  const card = document.getElementById(id);
  if (!card) return;

  card.className = `site-status-card ${status}`;
  const badge = card.querySelector('.site-status-badge');
  const msg = card.querySelector('.site-status-msg');

  if (status === 'searching') {
    badge.className = 'site-status-badge badge-searching';
    badge.textContent = 'Searching…';
    msg.textContent = 'Fetching live…';
  } else if (status === 'found') {
    badge.className = 'site-status-badge badge-found';
    badge.textContent = `${count} found`;
    msg.textContent = `${count} product${count !== 1 ? 's' : ''}`;
  } else if (status === 'not-found') {
    badge.className = 'site-status-badge badge-none';
    badge.textContent = 'None';
    msg.textContent = 'No matches';
  } else if (status === 'error') {
    badge.className = 'site-status-badge badge-error';
    badge.textContent = 'Error';
    msg.textContent = 'Failed to fetch';
  }
}

function addProgressCard(src) {
  const id = `progress-${src.key.replace(/[\s.]/g, '-')}`;
  if (document.getElementById(id)) return;
  const card = document.createElement('div');
  card.className = 'site-status-card';
  card.id = id;
  card.innerHTML = `
    <div class="site-status-icon">${src.flag}</div>
    <div class="site-status-info">
      <div class="site-status-name">${src.key}</div>
      <div class="site-status-msg">${src.domain}</div>
    </div>
    <span class="site-status-badge badge-pending">Pending</span>
  `;
  progressSites.appendChild(card);
}

// ── Badge class for source ──
function getSourceBadgeClass(domain) {
  if (!domain) return 'badge-india-source';
  const d = domain.toLowerCase();
  // China cluster
  if (/1688|made-in-china|dhgate|yiwugo/.test(d)) return 'badge-china-source';
  // Global / multi-country
  if (/alibaba|globalsources|hktdc|tradeling|ec21|wlw|indotrading/.test(d)) return 'badge-global-source';
  // India default
  return 'badge-india-source';
}

// ── Render Product Card ──
// IMPORTANT: passes through the scraper-provided `product.url` and `product.price`
// unchanged, so product link + price reflect the live source. Adds a landed-cost
// calculator link below the description.
function renderProductCard(product) {
  const isChina = product.sourceDomain?.includes('1688');
  const badgeClass = getSourceBadgeClass(product.sourceDomain);

  // Visual fallback chain: try product.image (proxied) → imageFallback → gradient tile.
  // alicdn.com hotlink-protects: load through our /api/img proxy so the
  // server fetches with the correct Referer header.
  const colorSeed = simpleHash(product.title || product.source || 'x');
  const grad = gradientFromSeed(colorSeed);
  const gradFallback = `<div class="product-img-fallback" style="background:${grad};">
    <div class="product-img-fallback-text">${escHtml(String(product.title || '').substring(0, 60))}</div>
  </div>`;
  const gradFallbackEsc = JSON.stringify(gradFallback).replace(/"/g, '&quot;');
  const proxiedSrc = proxyImageUrl(product.image);
  const fallbackUrl = product.imageFallback ? escHtml(product.imageFallback) : '';
  const onErr = fallbackUrl
    ? `if(this.dataset.f!=='1'){this.dataset.f='1';this.src='${fallbackUrl}';}else{this.outerHTML=${gradFallbackEsc};}`
    : `this.outerHTML=${gradFallbackEsc};`;
  const imageHtml = proxiedSrc
    ? `<img src="${escHtml(proxiedSrc)}" alt="${escHtml(product.title)}" loading="lazy"
        referrerpolicy="no-referrer" onerror="${onErr}" />`
    : gradFallback;

  let valueBadgeHtml = '';
  if (product.bestPick) valueBadgeHtml = `<div class="best-pick-badge">🏆 Best Pick</div>`;
  else if (product.bestValue) valueBadgeHtml = `<div class="best-value-badge">💰 Best Value</div>`;

  const descText = product.description
    ? escHtml(String(product.description).substring(0, 120))
    : '';
  const descHtml = descText ? `<div class="product-desc">${descText}</div>` : '';

  const noteHtml = product.note
    ? `<div class="product-note">${escHtml(product.note)}</div>` : '';

  const translateBtn = (isChina && product.translateUrl)
    ? `<a href="${escHtml(product.translateUrl)}" target="_blank" rel="noopener" class="btn-translate" title="Translate to English">🌐</a>` : '';

  const priceClass = product.bestPick ? 'product-price best-pick-price' : 'product-price';

  // Build calculator link with prefilled query for context (opens in new tab)
  const calcHref = `${CALC_URL}?utm_source=befach-sourcing&product=${encodeURIComponent(product.title || '')}`;

  return `
    <div class="product-card${product.bestPick ? ' card-best-pick' : ''}">
      <div class="product-image-wrap">
        ${imageHtml}
        <span class="product-source-badge ${badgeClass}">${product.sourceFlag || ''} ${escHtml(product.source || '')}</span>
        ${valueBadgeHtml}
      </div>
      <div class="product-body">
        <div class="product-title">${escHtml(product.title)}</div>
        <div class="product-meta">
          <div class="${priceClass}">${escHtml(product.price || 'See site')}</div>
          <div class="product-domain">${escHtml(product.sourceDomain || '')}</div>
        </div>
        ${descHtml}
        ${noteHtml}
        <a href="${escHtml(calcHref)}" target="_blank" rel="noopener" class="product-calc-link" title="Calculate landing price (CIF + duty + GST + delivery)">
          🧮 Calculate Landing Price →
        </a>
        <div class="product-actions">
          <a href="${escHtml(product.url)}" target="_blank" rel="noopener" class="btn-view-product">
            View Product
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7h10M8 3l4 4-4 4" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </a>
          ${translateBtn}
        </div>
      </div>
    </div>`;
}

// ── Render All Ranked Results ──
function renderRankedResults(ranked) {
  resultsBySource.innerHTML = '';

  // Group by source
  const bySource = {};
  ranked.forEach(r => {
    if (!bySource[r.source]) bySource[r.source] = [];
    bySource[r.source].push(r);
  });

  // Sort sources by lowest price
  const sourceOrder = Object.entries(bySource).sort(([, a], [, b]) => {
    const aMin = Math.min(...a.map(r => r.priceNum || 999999));
    const bMin = Math.min(...b.map(r => r.priceNum || 999999));
    return aMin - bMin;
  });

  for (const [source, items] of sourceOrder) {
    const isGlobal = items[0]?.sourceDomain?.includes('alibaba') || items[0]?.sourceDomain?.includes('1688');
    const flag = items[0]?.sourceFlag || '📦';
    const countClass = isGlobal ? 'global' : 'indian';

    const section = document.createElement('div');
    section.className = 'source-group';
    section.innerHTML = `
      <div class="source-group-header">
        <div class="source-group-label">
          <span class="source-flag">${flag}</span>
          ${escHtml(source)}
        </div>
        <span class="source-count ${countClass}">${items.length} result${items.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="products-grid">${items.map(renderProductCard).join('')}</div>
    `;
    resultsBySource.appendChild(section);
  }
}

// ── HTML escape ──
function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Route hotlink-protected Alibaba images through our own /api/img proxy.
// loremflickr/picsum/data: URLs pass through untouched.
function proxyImageUrl(url) {
  if (!url) return '';
  if (/(alicdn\.com|aliexpress|alibaba\.com)/i.test(url)) {
    return `/api/img?url=${encodeURIComponent(url)}`;
  }
  return url;
}

// ── Image fallback helpers (stable per-product gradient) ──
function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function gradientFromSeed(seed) {
  const palette = [
    ['#FF6B35', '#E8440A'], ['#4F46E5', '#7C3AED'], ['#0EA5E9', '#2563EB'],
    ['#16A34A', '#0F766E'], ['#F59E0B', '#DC2626'], ['#EC4899', '#BE185D'],
    ['#14B8A6', '#0E7490'], ['#8B5CF6', '#5B21B6'], ['#F97316', '#9A3412'],
  ];
  const [a, b] = palette[seed % palette.length];
  return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
}

// ── Main Search ──
async function doSearch() {
  const query = (productNameInput.value || '').trim();
  if (query.length < 2) {
    productNameInput.focus();
    showToast('Enter a product name to search');
    return;
  }

  if (!backendOnline) {
    // Retry health check once before giving up
    await checkServerHealth();
    if (!backendOnline) {
      showToast('⚠️ Backend offline. Run: cd server && npm run dev', 6000);
      showOfflineBanner();
      return;
    }
  }

  resetResults();
  currentQuery = query;

  // Alibaba-only mode: hide trending while searching. The cross-platform
  // launcher grid is intentionally not rendered anymore.
  trendingSection.classList.add('hidden');

  // UI loading state
  searchBtn.disabled = true;
  searchBtn.querySelector('.btn-text').classList.add('hidden');
  searchBtn.querySelector('.btn-loading').classList.remove('hidden');

  // Show progress
  progressSection.classList.remove('hidden');
  progressQuery.textContent = `"${query}"`;
  SOURCES.forEach(addProgressCard);
  progressSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const response = await fetch(`${API_BASE}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, specification: '', crmRef: '' }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (response.status === 404) {
        showToast('⚠️ /api/search not found — make sure you opened http://localhost:3001 (not the file directly)', 6000);
      } else {
        showToast(`Error ${response.status}: ${err.error || 'Search failed'}`, 5000);
      }
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        let event;
        try { event = JSON.parse(jsonStr); } catch { continue; }
        handleSSEEvent(event);
      }
    }
  } catch (err) {
    console.error('Search error:', err);
    showToast(`⚠️ Connection failed. Is the backend running? (cd server && npm run dev)`, 6000);
    showOfflineBanner();
    backendOnline = false;
    serverStatus.className = 'status-pill offline';
    serverStatus.querySelector('.status-text').textContent = 'Offline';
  } finally {
    searchBtn.disabled = false;
    searchBtn.querySelector('.btn-text').classList.remove('hidden');
    searchBtn.querySelector('.btn-loading').classList.add('hidden');
  }
}

function handleSSEEvent(event) {
  switch (event.type) {
    case 'start':
    case 'phase_skip':
      break;

    case 'message':
      showToast(event.message || '', 8000);
      // Also show inline above the progress card
      if (event.message) {
        let banner = document.getElementById('captchaBanner');
        if (!banner) {
          banner = document.createElement('div');
          banner.id = 'captchaBanner';
          banner.className = 'captcha-banner';
          progressSection.prepend(banner);
        }
        banner.textContent = event.message;
      }
      break;

    case 'phase':
      // Server announces full source list — rebuild the progress grid to match.
      if (Array.isArray(event.sources) && event.sources.length) {
        progressSites.innerHTML = '';
        event.sources.forEach(s => addProgressCard({ key: s.name, domain: s.domain, flag: s.flag }));
      }
      break;

    case 'searching':
      // Lazily add a progress card if the source wasn't announced yet
      if (!document.getElementById(`progress-${event.source.replace(/[\s.]/g, '-')}`)) {
        addProgressCard({ key: event.source, domain: event.domain || '', flag: event.flag || '🌐' });
      }
      updateProgressCard(event.source, 'searching');
      break;

    case 'results': {
      const count = event.count || 0;
      updateProgressCard(event.source, count > 0 ? 'found' : 'not-found', count);
      if (count > 0) {
        allResults.push(...(event.results || []));
        if (resultsSection.classList.contains('hidden')) {
          resultsSection.classList.remove('hidden');
        }
        const srcCount = new Set(allResults.map(r => r.source)).size;
        resultsMeta.textContent = `Searching… ${allResults.length} found across ${srcCount} sources so far`;
      }
      break;
    }

    case 'ranked': {
      // Clear captcha banner once results arrive
      const cb = document.getElementById('captchaBanner');
      if (cb) cb.remove();
      rankedResults = event.results || [];
      resultsBySource.innerHTML = '';

      if (rankedResults.length > 0) {
        renderRankedResults(rankedResults);
        resultsSection.classList.remove('hidden');
        emptyState.classList.add('hidden');

        const bestPick = rankedResults.find(r => r.bestPick);
        const srcCount = new Set(rankedResults.map(r => r.source)).size;
        const priceInfo = bestPick ? ` · Lowest price: ${bestPick.price} (${bestPick.source})` : '';
        resultsMeta.textContent = `${rankedResults.length} products across ${srcCount} sources${priceInfo}`;

        resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      break;
    }

    case 'done':
      if (allResults.length === 0) {
        emptyState.classList.remove('hidden');
        resultsSection.classList.add('hidden');
        showToast('No products found. Try different search terms.');
      }
      break;
  }
}

// ── Platforms launcher disabled in Alibaba-only mode ──
let PLATFORMS = [];
let activeCountry = 'All';

async function loadPlatforms() {
  // No-op in Alibaba-only mode — we no longer render the 227-platform grid.
  if (platformsSection) platformsSection.classList.add('hidden');
}

function renderCountryFilter() {
  if (!countryFilter) return;
  const countries = ['All', ...Array.from(new Set(PLATFORMS.map(p => p.country))).sort()];
  countryFilter.innerHTML = countries.map(c => `
    <button class="country-chip${c === activeCountry ? ' active' : ''}" data-country="${escHtml(c)}">
      ${c === 'All' ? '🌍' : (COUNTRY_FLAGS[c] || '🏳️')} ${escHtml(c)}
      <span class="country-count">${c === 'All' ? PLATFORMS.length : PLATFORMS.filter(p => p.country === c).length}</span>
    </button>
  `).join('');
  countryFilter.querySelectorAll('.country-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      activeCountry = btn.dataset.country;
      renderCountryFilter();
      renderPlatformsForQuery(currentQuery);
    });
  });
}

function buildSearchUrl(tmpl, q) {
  return tmpl.replace('{q}', encodeURIComponent(q || ''));
}

function renderPlatformsForQuery(query) {
  if (!platformsGrid || !PLATFORMS.length || !query) {
    if (platformsSection) platformsSection.classList.add('hidden');
    return;
  }
  const list = activeCountry === 'All'
    ? PLATFORMS
    : PLATFORMS.filter(p => p.country === activeCountry);

  platformsGrid.innerHTML = list.map(p => {
    const url = buildSearchUrl(p.searchUrlTemplate, query);
    const flag = COUNTRY_FLAGS[p.country] || '🌐';
    const isDirect = !p.searchUrlTemplate.startsWith('https://www.google.com/search');
    return `
      <a href="${escHtml(url)}" target="_blank" rel="noopener" class="platform-card" title="${escHtml(p.notes || '')}">
        <div class="platform-card-head">
          <span class="platform-flag">${flag}</span>
          <span class="platform-badge ${p.type === 'B2B' ? 'b2b' : p.type === 'B2C' ? 'b2c' : 'both'}">${escHtml(p.type || '—')}</span>
        </div>
        <div class="platform-name">${escHtml(p.name)}</div>
        <div class="platform-host">${escHtml(p.host || '')}</div>
        <div class="platform-cta">
          ${isDirect ? 'Search on this site →' : 'Google site search →'}
        </div>
      </a>`;
  }).join('');
  platformsSection.classList.remove('hidden');
}

loadPlatforms();

// ── Events ──
searchForm.addEventListener('submit', (e) => { e.preventDefault(); doSearch(); });

// Show trending again if user clears search
productNameInput.addEventListener('input', () => {
  if (!productNameInput.value.trim()) {
    trendingSection.classList.remove('hidden');
    if (platformsSection) platformsSection.classList.add('hidden');
  }
});

// Keyboard shortcut
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doSearch();
  if (e.key === '/' && document.activeElement !== productNameInput) {
    e.preventDefault();
    productNameInput.focus();
  }
});
