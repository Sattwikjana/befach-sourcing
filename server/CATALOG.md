# SQLite Catalog

The storefront can keep a local CJ product-summary catalog in
`server/data/catalog.sqlite`. Render mounts this directory on the
persistent disk, so the catalog survives deploys and restarts.

## What Is Stored

- Product ID, SKU, name, image URL, category, base CJ price, listed count.
- Category tree from CJ.
- Search indexes for fast keyword/category browsing.

Images are not downloaded. Product details, variants, stock, shipping, and
checkout validation still come from CJ live.

## Render Defaults

`render.yaml` enables:

- Standard web service plan.
- 10GB persistent disk.
- Daily background catalog sync.
- First phase target of 50,000 product summaries.
- 1.2 second delay between sync calls, staying below the 86,400/day pace.

## Manual Commands

Run a bounded sync from a shell:

```bash
cd server
npm run catalog:sync -- --target=50000 --max-calls=600 --delay-ms=1200
```

Trigger from the admin API:

```bash
curl -X POST "https://www.globalshopper.in/api/admin/catalog/sync?pw=ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"targetProducts":50000,"maxCalls":600,"minDelayMs":1200}'
```

Check status:

```bash
curl "https://www.globalshopper.in/api/admin/catalog/status?pw=ADMIN_PASSWORD"
```

Stop a running sync:

```bash
curl -X POST "https://www.globalshopper.in/api/admin/catalog/sync/stop?pw=ADMIN_PASSWORD"
```
