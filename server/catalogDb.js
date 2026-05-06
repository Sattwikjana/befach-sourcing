const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_DB_PATH = path.join(DATA_DIR, 'catalog.sqlite');
const DB_PATH = process.env.CATALOG_DB_PATH || DEFAULT_DB_PATH;
const ENABLED = process.env.CATALOG_ENABLED !== 'false';

let db = null;
let prepared = null;
let syncJob = {
  running: false,
  stopRequested: false,
  startedAt: null,
  finishedAt: null,
  error: null,
  lastWarning: null,
  calls: 0,
  skipped: 0,
  upserted: 0,
  seen: 0,
  phase: 'idle',
};

let cachedStatus = null;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function ensureDb() {
  if (!ENABLED) return null;
  if (db) return db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_products (
      pid TEXT PRIMARY KEY,
      product_sku TEXT,
      name TEXT NOT NULL,
      image TEXT,
      category_id TEXT,
      category_name TEXT,
      sell_price REAL DEFAULT 0,
      listed_num INTEGER DEFAULT 0,
      product_weight REAL DEFAULT 0,
      raw_json TEXT,
      source TEXT NOT NULL DEFAULT 'cj',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_products_category
      ON catalog_products(category_id, listed_num DESC);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_active_category
      ON catalog_products(active, category_id, listed_num DESC, sell_price ASC);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_trending
      ON catalog_products(listed_num DESC, sell_price ASC);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_active_trending
      ON catalog_products(active, listed_num DESC, sell_price ASC);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_updated
      ON catalog_products(updated_at);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_sku
      ON catalog_products(product_sku);

    CREATE VIRTUAL TABLE IF NOT EXISTS catalog_products_fts
      USING fts5(pid UNINDEXED, name, category_name, product_sku, tokenize='unicode61');

    CREATE TABLE IF NOT EXISTS catalog_categories (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      level INTEGER NOT NULL,
      name TEXT NOT NULL,
      raw_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_categories_parent
      ON catalog_categories(parent_id);

    CREATE TABLE IF NOT EXISTS catalog_sync_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  prepared = {
    upsertProduct: db.prepare(`
      INSERT INTO catalog_products (
        pid, product_sku, name, image, category_id, category_name,
        sell_price, listed_num, product_weight, raw_json, source,
        active, updated_at, last_seen_at
      ) VALUES (
        @pid, @product_sku, @name, @image, @category_id, @category_name,
        @sell_price, @listed_num, @product_weight, @raw_json, @source,
        1, @now, @now
      )
      ON CONFLICT(pid) DO UPDATE SET
        product_sku = excluded.product_sku,
        name = excluded.name,
        image = excluded.image,
        category_id = COALESCE(excluded.category_id, catalog_products.category_id),
        category_name = COALESCE(excluded.category_name, catalog_products.category_name),
        sell_price = excluded.sell_price,
        listed_num = excluded.listed_num,
        product_weight = excluded.product_weight,
        raw_json = excluded.raw_json,
        source = excluded.source,
        active = 1,
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at
    `),
    deleteFts: db.prepare('DELETE FROM catalog_products_fts WHERE pid = ?'),
    insertFts: db.prepare(`
      INSERT INTO catalog_products_fts(pid, name, category_name, product_sku)
      VALUES (?, ?, ?, ?)
    `),
    upsertCategory: db.prepare(`
      INSERT INTO catalog_categories (id, parent_id, level, name, raw_json, updated_at)
      VALUES (@id, @parent_id, @level, @name, @raw_json, @now)
      ON CONFLICT(id) DO UPDATE SET
        parent_id = excluded.parent_id,
        level = excluded.level,
        name = excluded.name,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `),
    getState: db.prepare('SELECT value FROM catalog_sync_state WHERE key = ?'),
    setState: db.prepare(`
      INSERT INTO catalog_sync_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),
    leafCategories: db.prepare(`
      SELECT c.id, c.name
      FROM catalog_categories c
      WHERE NOT EXISTS (SELECT 1 FROM catalog_categories child WHERE child.parent_id = c.id)
      ORDER BY c.level DESC, c.name ASC
    `),
    allCategories: db.prepare('SELECT id, parent_id, level, name FROM catalog_categories'),
  };

  return db;
}

function isEnabled() {
  return ENABLED && !!ensureDb();
}

function parseNumber(value) {
  const match = String(value ?? '').match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

function parseProductImage(product) {
  let image = product.productImage || product.bigImage || product.image || product.productImageSet || '';
  if (typeof image === 'string' && image.trim().startsWith('[')) {
    try {
      const arr = JSON.parse(image);
      if (Array.isArray(arr) && arr.length) image = arr[0];
    } catch {}
  }
  if (Array.isArray(image) && image.length) image = image[0];
  return typeof image === 'string' ? image : '';
}

function productPid(product) {
  return String(product.pid || product.id || product.productId || '').trim();
}

function compactProductRaw(product) {
  return {
    pid: product.pid || product.id || product.productId || '',
    id: product.id || product.pid || product.productId || '',
    productId: product.productId || product.pid || product.id || '',
    productSku: product.productSku || product.sku || '',
    sku: product.sku || product.productSku || '',
    productNameEn: product.productNameEn || product.productName || product.nameEn || product.name || '',
    productName: product.productName || product.productNameEn || product.nameEn || product.name || '',
    productImage: parseProductImage(product),
    bigImage: product.bigImage || parseProductImage(product),
    sellPrice: product.sellPrice || product.nowPrice || product.price || '',
    nowPrice: product.nowPrice || product.sellPrice || product.price || '',
    categoryId: product.categoryId || product.category_id || product.thirdCategoryId || '',
    categoryName: product.categoryName || product.threeCategoryName || product.category || '',
    threeCategoryName: product.threeCategoryName || product.categoryName || '',
    listedNum: product.listedNum || product.listedShopNum || 0,
    listedShopNum: product.listedShopNum || product.listedNum || 0,
    productWeight: product.productWeight || product.weight || '',
    weight: product.weight || product.productWeight || '',
  };
}

function normalizeProduct(product, { categoryHint, source = 'cj-list' } = {}) {
  const pid = productPid(product);
  const name = String(product.productNameEn || product.productName || product.nameEn || product.name || '').trim();
  if (!pid || !name) return null;

  const categoryId = product.categoryId || product.category_id || product.thirdCategoryId || categoryHint?.id || null;
  const categoryName = product.categoryName || product.threeCategoryName || product.category || categoryHint?.name || null;
  const now = new Date().toISOString();

  return {
    pid,
    product_sku: product.productSku || product.sku || '',
    name,
    image: parseProductImage(product),
    category_id: categoryId || null,
    category_name: categoryName || null,
    sell_price: parseNumber(product.sellPrice ?? product.nowPrice ?? product.price),
    listed_num: parseInt(product.listedNum || product.listedShopNum || 0, 10) || 0,
    product_weight: parseNumber(product.productWeight ?? product.weight),
    raw_json: JSON.stringify(compactProductRaw(product)),
    source,
    now,
  };
}

const upsertManyTx = () => ensureDb().transaction((products, opts = {}) => {
  let count = 0;
  for (const product of products || []) {
    const row = normalizeProduct(product, opts);
    if (!row) continue;
    prepared.upsertProduct.run(row);
    prepared.deleteFts.run(row.pid);
    prepared.insertFts.run(row.pid, row.name, row.category_name || '', row.product_sku || '');
    count++;
  }
  return count;
});

function upsertProducts(products, opts = {}) {
  if (!isEnabled()) return 0;
  const count = upsertManyTx()(products, opts);
  cachedStatus = null;
  return count;
}

function flattenCategoryTree(tree) {
  const out = [];
  for (const top of tree || []) {
    const topId = top.categoryFirstId || top.id;
    const topName = top.categoryFirstName || top.name;
    if (!topId || !topName) continue;
    out.push({ id: topId, parent_id: null, level: 1, name: topName, raw: top });
    for (const second of top.categoryFirstList || []) {
      const secondId = second.categorySecondId || second.id;
      const secondName = second.categorySecondName || second.name;
      if (!secondId || !secondName) continue;
      out.push({ id: secondId, parent_id: topId, level: 2, name: secondName, raw: second });
      for (const third of second.categorySecondList || []) {
        const thirdId = third.categoryId || third.id;
        const thirdName = third.categoryName || third.name;
        if (!thirdId || !thirdName) continue;
        out.push({ id: thirdId, parent_id: secondId, level: 3, name: thirdName, raw: third });
      }
    }
  }
  return out;
}

const upsertCategoriesTx = () => ensureDb().transaction((tree) => {
  const now = new Date().toISOString();
  const rows = flattenCategoryTree(tree);
  for (const row of rows) {
    prepared.upsertCategory.run({
      id: row.id,
      parent_id: row.parent_id,
      level: row.level,
      name: row.name,
      raw_json: JSON.stringify(row.raw),
      now,
    });
  }
  setState('categoryTree', JSON.stringify(tree || []));
  return rows.length;
});

function upsertCategories(tree) {
  if (!isEnabled()) return 0;
  const count = upsertCategoriesTx()(tree);
  cachedStatus = null;
  return count;
}

function getState(key, fallback = null) {
  if (!isEnabled()) return fallback;
  const row = prepared.getState.get(key);
  return row ? row.value : fallback;
}

function setState(key, value) {
  if (!isEnabled()) return;
  prepared.setState.run(key, String(value), new Date().toISOString());
}

function getCategoryTree() {
  const raw = getState('categoryTree', '[]');
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

function getDescendantCategoryIds(categoryId) {
  if (!categoryId || !isEnabled()) return [];
  const rows = prepared.allCategories.all();
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.parent_id || '')) children.set(row.parent_id || '', []);
    children.get(row.parent_id || '').push(row.id);
  }
  const out = new Set([categoryId]);
  const stack = [categoryId];
  while (stack.length) {
    const id = stack.pop();
    for (const child of children.get(id) || []) {
      if (out.has(child)) continue;
      out.add(child);
      stack.push(child);
    }
  }
  return [...out];
}

function ftsQuery(input) {
  const tokens = String(input || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(t => t.length >= 2)
    .slice(0, 8);
  if (!tokens.length) return '';
  return tokens.map(t => `${t.replace(/"/g, '')}*`).join(' AND ');
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

function rowsToProducts(rows) {
  return (rows || []).map(row => {
    let raw = {};
    try { raw = JSON.parse(row.raw_json || '{}'); } catch {}
    return {
      ...raw,
      pid: row.pid,
      id: row.pid,
      productId: row.pid,
      productSku: row.product_sku || raw.productSku || raw.sku || '',
      productNameEn: row.name,
      productName: row.name,
      productImage: row.image || raw.productImage || raw.bigImage || '',
      bigImage: row.image || raw.bigImage || raw.productImage || '',
      sellPrice: row.sell_price ? String(row.sell_price) : String(raw.sellPrice || raw.nowPrice || '0'),
      nowPrice: row.sell_price ? String(row.sell_price) : String(raw.nowPrice || raw.sellPrice || '0'),
      categoryId: row.category_id || raw.categoryId || '',
      categoryName: row.category_name || raw.categoryName || raw.threeCategoryName || '',
      listedNum: row.listed_num || raw.listedNum || raw.listedShopNum || 0,
      productWeight: row.product_weight || raw.productWeight || raw.weight || 0,
      catalogSource: row.source || 'catalog',
    };
  });
}

function estimateTotal({ offset, limit, rowsLength, exactTotal }) {
  if (Number.isFinite(exactTotal)) return exactTotal;
  if (rowsLength < limit) return offset + rowsLength;
  // We no longer show result counts in the UI, so avoid expensive COUNT(*)
  // scans on 500k+ row catalogs. This keeps pagination available without
  // blocking Render's single Node process for exact totals.
  return offset + rowsLength + (limit * 25);
}

function searchProducts({ keyWord = '', categoryId = '', page = 1, size = 20, includeTotal = false } = {}) {
  if (!isEnabled()) return null;
  const dbh = ensureDb();
  const limit = Math.max(1, Math.min(parseInt(size, 10) || 20, 100));
  const currentPage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (currentPage - 1) * limit;
  const categoryIds = getDescendantCategoryIds(categoryId);
  const categorySql = categoryIds.length
    ? ` AND p.category_id IN (${placeholders(categoryIds)})`
    : '';
  const categoryArgs = categoryIds;
  const q = ftsQuery(keyWord);

  let rows;
  let total = null;
  if (q) {
    const baseArgs = [q, ...categoryArgs];
    rows = dbh.prepare(`
      SELECT p.*, bm25(catalog_products_fts) AS rank
      FROM catalog_products_fts
      JOIN catalog_products p ON p.pid = catalog_products_fts.pid
      WHERE catalog_products_fts MATCH ?
        AND p.active = 1
        ${categorySql}
      ORDER BY rank ASC, p.listed_num DESC, p.sell_price ASC
      LIMIT ? OFFSET ?
    `).all(...baseArgs, limit, offset);
    if (includeTotal) {
      total = dbh.prepare(`
        SELECT COUNT(*) AS count
        FROM catalog_products_fts
        JOIN catalog_products p ON p.pid = catalog_products_fts.pid
        WHERE catalog_products_fts MATCH ?
          AND p.active = 1
          ${categorySql}
      `).get(...baseArgs).count;
    }
  } else {
    rows = dbh.prepare(`
      SELECT p.*
      FROM catalog_products p
      WHERE p.active = 1
        ${categorySql}
      ORDER BY p.listed_num DESC, p.sell_price ASC, p.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...categoryArgs, limit, offset);
    if (includeTotal) {
      total = dbh.prepare(`
        SELECT COUNT(*) AS count
        FROM catalog_products p
        WHERE p.active = 1
          ${categorySql}
      `).get(...categoryArgs).count;
    }
  }

  if (!rows.length) return null;
  total = estimateTotal({ offset, limit, rowsLength: rows.length, exactTotal: total });
  return {
    products: rowsToProducts(rows),
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    source: 'catalog',
  };
}

function getStatus() {
  if (!isEnabled()) return { enabled: false };
  const now = Date.now();
  if (cachedStatus && now - cachedStatus.cachedAt < 30 * 1000) {
    return { ...cachedStatus.value, job: { ...syncJob } };
  }
  const dbh = ensureDb();
  let sizeBytes = 0;
  try {
    if (fs.existsSync(DB_PATH)) sizeBytes = fs.statSync(DB_PATH).size;
  } catch {}
  const productCount = dbh.prepare('SELECT COUNT(*) AS count FROM catalog_products WHERE active = 1').get().count;
  const categoryCount = dbh.prepare('SELECT COUNT(*) AS count FROM catalog_categories').get().count;
  const value = {
    enabled: true,
    dbPath: DB_PATH,
    sizeBytes,
    products: productCount,
    categories: categoryCount,
    globalPage: parseInt(getState('globalPage', '1'), 10) || 1,
    categoryIndex: parseInt(getState('categoryIndex', '0'), 10) || 0,
    categoryPage: parseInt(getState('categoryPage', '1'), 10) || 1,
    lastSyncAt: getState('lastSyncAt', null),
    job: { ...syncJob },
  };
  cachedStatus = { cachedAt: now, value };
  return value;
}

function getLightStatus() {
  if (!isEnabled()) return { enabled: false };
  let sizeBytes = 0;
  try {
    if (fs.existsSync(DB_PATH)) sizeBytes = fs.statSync(DB_PATH).size;
  } catch {}
  return {
    enabled: true,
    dbPath: DB_PATH,
    sizeBytes,
    globalPage: parseInt(getState('globalPage', '1'), 10) || 1,
    categoryIndex: parseInt(getState('categoryIndex', '0'), 10) || 0,
    categoryPage: parseInt(getState('categoryPage', '1'), 10) || 1,
    lastSyncAt: getState('lastSyncAt', null),
    job: { ...syncJob },
  };
}

function isSyncRunning() {
  return !!syncJob.running;
}

function parseListV2Products(data) {
  const products = [];
  if (Array.isArray(data?.data?.list)) products.push(...data.data.list);
  if (Array.isArray(data?.data?.content)) {
    for (const group of data.data.content) {
      if (Array.isArray(group.productList)) products.push(...group.productList);
    }
  }
  const total = data?.data?.total || data?.data?.totalRecords || products.length;
  const totalPages = data?.data?.totalPages || 1;
  return { products, total, totalPages };
}

function parseLegacyProducts(data) {
  const products = Array.isArray(data?.data?.list) ? data.data.list : [];
  const total = data?.data?.total || data?.data?.totalRecords || products.length;
  return { products, total };
}

async function syncOneCategoryPage(cj, leaves, pageSize) {
  if (!leaves.length) return { products: [], upserted: 0 };
  let idx = parseInt(getState('categoryIndex', '0'), 10) || 0;
  let page = parseInt(getState('categoryPage', '1'), 10) || 1;
  if (idx >= leaves.length) idx = 0;
  const category = leaves[idx];
  const size = Math.min(pageSize, 100);
  const data = await cj.searchProducts({ categoryId: category.id, page, size }, { priority: 'low' });
  const parsed = parseListV2Products(data);
  const upserted = upsertProducts(parsed.products, {
    categoryHint: category,
    source: 'cj-listV2-category',
  });

  const isDone = parsed.products.length === 0 || page >= parsed.totalPages || page >= 1000;
  if (isDone) {
    setState('categoryIndex', String((idx + 1) % leaves.length));
    setState('categoryPage', '1');
  } else {
    setState('categoryIndex', String(idx));
    setState('categoryPage', String(page + 1));
  }
  return { products: parsed.products, upserted, category, page };
}

function advanceCategoryCursor(leaves) {
  if (!leaves.length) return;
  let idx = parseInt(getState('categoryIndex', '0'), 10) || 0;
  if (idx >= leaves.length) idx = 0;
  setState('categoryIndex', String((idx + 1) % leaves.length));
  setState('categoryPage', '1');
}

async function syncOneGlobalPage(cj, pageSize) {
  let page = parseInt(getState('globalPage', '1'), 10) || 1;
  const data = await cj.getProductList({ page, pageSize }, { priority: 'low' });
  const parsed = parseLegacyProducts(data);
  const upserted = upsertProducts(parsed.products, { source: 'cj-list-global' });

  if (parsed.products.length < pageSize) page = 1;
  else page += 1;
  setState('globalPage', String(page));
  return { products: parsed.products, upserted, page };
}

function advanceGlobalCursor() {
  const page = parseInt(getState('globalPage', '1'), 10) || 1;
  setState('globalPage', String(page + 1));
}

function isSkippableSyncError(err) {
  const status = err?.response?.status;
  if (status === 400 || status === 404) return true;
  return /status code (400|404)/i.test(err?.message || '');
}

function syncErrorMessage(err) {
  const status = err?.response?.status;
  const apiMessage = err?.response?.data?.message || err?.response?.data?.msg;
  return [status ? `HTTP ${status}` : null, apiMessage || err?.message].filter(Boolean).join(': ');
}

async function runCatalogSync(cj, opts = {}) {
  if (!isEnabled()) return getStatus();
  const targetProducts = Math.max(1, parseInt(opts.targetProducts || process.env.CATALOG_SYNC_TARGET || 50000, 10));
  const maxCalls = Math.max(1, parseInt(opts.maxCalls || process.env.CATALOG_SYNC_MAX_CALLS || 600, 10));
  const pageSize = Math.max(20, Math.min(parseInt(opts.pageSize || process.env.CATALOG_SYNC_PAGE_SIZE || 200, 10), 200));
  const minDelayMs = Math.max(0, parseInt(opts.minDelayMs || process.env.CATALOG_SYNC_MIN_DELAY_MS || 1200, 10));

  syncJob = {
    running: true,
    stopRequested: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    lastWarning: null,
    calls: 0,
    skipped: 0,
    upserted: 0,
    seen: 0,
    phase: 'categories',
  };

  try {
    const categoryData = await cj.getCategories();
    upsertCategories(categoryData?.data || []);
    const leaves = prepared.leafCategories.all();

    while (!syncJob.stopRequested && syncJob.calls < maxCalls && syncJob.seen < targetProducts) {
      const useCategory = leaves.length && (syncJob.calls % 3 !== 2);
      syncJob.phase = useCategory ? 'category-pages' : 'global-pages';
      let result;
      try {
        result = useCategory
          ? await syncOneCategoryPage(cj, leaves, pageSize)
          : await syncOneGlobalPage(cj, pageSize);
      } catch (err) {
        if (!isSkippableSyncError(err)) throw err;
        syncJob.calls += 1;
        syncJob.skipped += 1;
        syncJob.lastWarning = syncErrorMessage(err);
        if (useCategory) advanceCategoryCursor(leaves);
        else advanceGlobalCursor();
        setState('lastSyncAt', new Date().toISOString());
        await sleep(minDelayMs);
        continue;
      }

      syncJob.calls += 1;
      syncJob.seen += result.products.length;
      syncJob.upserted += result.upserted;
      setState('lastSyncAt', new Date().toISOString());
      if (!result.products.length && !useCategory) break;
      if (syncJob.calls < maxCalls && syncJob.seen < targetProducts) await sleep(minDelayMs);
    }

    syncJob.phase = syncJob.stopRequested ? 'stopped' : 'done';
    syncJob.finishedAt = new Date().toISOString();
    return getStatus();
  } catch (err) {
    syncJob.error = err.message;
    syncJob.phase = 'failed';
    syncJob.finishedAt = new Date().toISOString();
    throw err;
  } finally {
    syncJob.running = false;
  }
}

function startSync(cj, opts = {}) {
  if (syncJob.running) return { started: false, job: { ...syncJob } };
  runCatalogSync(cj, opts).catch(err => {
    console.error('[catalog] sync failed:', err.message);
  });
  return { started: true, job: { ...syncJob } };
}

function stopSync() {
  if (syncJob.running) syncJob.stopRequested = true;
  return { job: { ...syncJob } };
}

module.exports = {
  ensureDb,
  isEnabled,
  upsertProducts,
  upsertCategories,
  getCategoryTree,
  searchProducts,
  getStatus,
  getLightStatus,
  isSyncRunning,
  runCatalogSync,
  startSync,
  stopSync,
};
