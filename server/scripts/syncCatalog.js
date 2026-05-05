#!/usr/bin/env node

require('dotenv').config();

const cj = require('../cjApi');
const catalog = require('../catalogDb');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find(x => x.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function main() {
  const result = await catalog.runCatalogSync(cj, {
    targetProducts: arg('target', process.env.CATALOG_SYNC_TARGET || 50000),
    maxCalls: arg('max-calls', process.env.CATALOG_SYNC_MAX_CALLS || 600),
    pageSize: arg('page-size', process.env.CATALOG_SYNC_PAGE_SIZE || 200),
    minDelayMs: arg('delay-ms', process.env.CATALOG_SYNC_MIN_DELAY_MS || 1200),
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
