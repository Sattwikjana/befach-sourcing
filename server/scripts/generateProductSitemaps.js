#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const catalog = require('../catalogDb');

const DEFAULT_SITE_URL = 'https://www.globalshopper.in';

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find(x => x.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function intArg(name, fallback, min, max) {
  const parsed = parseInt(arg(name, fallback), 10);
  const value = Number.isFinite(parsed) ? parsed : parseInt(fallback, 10);
  return Math.max(min, Math.min(value || min, max));
}

function siteUrl() {
  return String(process.env.SITE_URL || process.env.PUBLIC_SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, '');
}

function outDir() {
  return arg('out-dir', process.env.PRODUCT_SITEMAP_DIR || path.join(__dirname, '..', 'data', 'sitemaps'));
}

function xmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[ch]));
}

function encodeUrlPart(value) {
  return encodeURIComponent(String(value || '')).replace(/[!'()*]/g, ch =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function safeDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function parseImage(value) {
  let image = value;
  if (Array.isArray(image)) image = image[0];
  if (typeof image === 'string' && image.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(image);
      if (Array.isArray(parsed) && parsed.length) image = parsed[0];
    } catch {}
  }
  return /^https?:\/\//i.test(String(image || '').trim()) ? String(image).trim() : '';
}

function xmlUrlset(rows, baseUrl) {
  const entries = rows.map(row => {
    const loc = `${baseUrl}/product/${encodeUrlPart(row.pid)}`;
    const parts = [
      `    <loc>${xmlEscape(loc)}</loc>`,
      `    <lastmod>${xmlEscape(safeDate(row.updated_at))}</lastmod>`,
      '    <changefreq>weekly</changefreq>',
      '    <priority>0.6</priority>',
    ];
    const image = parseImage(row.image);
    if (image) {
      const imageParts = [`      <image:loc>${xmlEscape(image)}</image:loc>`];
      if (row.name) imageParts.push(`      <image:title>${xmlEscape(row.name)}</image:title>`);
      parts.push(`    <image:image>\n${imageParts.join('\n')}\n    </image:image>`);
    }
    return `  <url>\n${parts.join('\n')}\n  </url>`;
  }).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    entries,
    '</urlset>',
    '',
  ].join('\n');
}

function writeAtomic(filePath, body) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, body);
  fs.renameSync(tmpPath, filePath);
}

function newestLastmod(rows) {
  let newest = null;
  for (const row of rows) {
    const date = new Date(row.updated_at || 0);
    if (!Number.isNaN(date.getTime()) && (!newest || date > newest)) newest = date;
  }
  return (newest || new Date()).toISOString();
}

function removeStaleProductSitemaps(dir, keepNames) {
  for (const name of fs.readdirSync(dir)) {
    if (/^products-\d+\.xml$/.test(name) && !keepNames.has(name)) {
      fs.unlinkSync(path.join(dir, name));
    }
  }
}

async function main() {
  const chunkSize = intArg('chunk-size', process.env.SITEMAP_PRODUCT_CHUNK_SIZE || '5000', 1, 10000);
  const maxProductsRaw = parseInt(arg('max-products', process.env.SITEMAP_MAX_PRODUCTS || ''), 10);
  const maxProducts = Number.isFinite(maxProductsRaw) && maxProductsRaw > 0 ? maxProductsRaw : 0;
  const baseUrl = siteUrl();
  const dir = outDir();

  fs.mkdirSync(dir, { recursive: true });

  let afterPid = '';
  let page = 1;
  let productCount = 0;
  const files = [];
  const keepNames = new Set();

  while (true) {
    const remaining = maxProducts ? Math.min(chunkSize, maxProducts - productCount) : chunkSize;
    if (remaining <= 0) break;

    const rows = catalog.getSitemapProductsAfterPid({ afterPid, size: remaining });
    if (!rows.length) break;

    const name = `products-${page}.xml`;
    writeAtomic(path.join(dir, name), xmlUrlset(rows, baseUrl));
    keepNames.add(name);
    files.push({ name, count: rows.length, lastmod: newestLastmod(rows) });

    productCount += rows.length;
    afterPid = String(rows[rows.length - 1].pid || afterPid);
    page += 1;

    if (!afterPid || rows.length < remaining || (maxProducts && productCount >= maxProducts)) break;
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    siteUrl: baseUrl,
    chunkSize,
    productCount,
    files,
  };
  writeAtomic(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  removeStaleProductSitemaps(dir, keepNames);

  console.log(JSON.stringify({
    ok: true,
    outDir: dir,
    productCount,
    sitemapFiles: files.length,
    chunkSize,
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
