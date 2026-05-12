# Global Shopper

Global Shopper is the customer-facing ecommerce store for `globalshopper.in`.
It is a CJ Dropshipping-powered cross-border storefront for India, with a
fast local SQLite catalog, live CJ product/detail fallbacks, Razorpay checkout,
AI search, photo search, SEO pages, Meta/GTM tracking, and an Android app shell
that stays connected to the same live website.

Live site: [https://www.globalshopper.in](https://www.globalshopper.in)

## What This Repo Contains

- Customer storefront built with static HTML/CSS/vanilla JS in `public/`.
- Node.js + Express backend in `server/`.
- CJ Dropshipping API integration for product search, product details, stock,
  freight quotes, balance checks, My Products, and order creation.
- SQLite product-summary catalog on Render persistent disk for faster category
  and search browsing.
- Razorpay payment order creation and webhook handling.
- Customer auth, account, cart, wishlist, orders, returns, and tracking flows.
- Admin dashboard for orders, pricing overrides, blocked products, catalog
  status/sync controls, CJ balance, and My Products tools.
- OpenRouter/Gemini-powered smart text search and photo search.
- Meta Pixel, Meta Conversions API endpoint, Google Tag Manager, SEO metadata,
  robots, sitemap, and product sitemap generation.
- Expo React Native mobile app in `mobile/`, currently a WebView shell around
  the live website with native app packaging, deep links, camera permission for
  photo search, and push notification token registration.

## Current Production Setup

- GitHub repo: `Sattwikjana/befach-sourcing`
- Render blueprint: `render.yaml`
- Render service: `befach-store`
- Runtime: Node.js 22.x
- Region: Singapore
- Plan: Render Standard web service with a 10 GB persistent disk
- Public domain: `https://www.globalshopper.in`
- Health check: `/api/live`
- Auto deploy: enabled on pushes to `main`

The persistent disk is mounted at:

```text
/opt/render/project/src/server/data
```

That disk stores runtime data such as the SQLite catalog and local JSON stores.

## Storefront

The website is a server-backed single page storefront using clean browser URLs.
Important customer routes include:

- `/` - home page
- `/category/:id` - category and subcategory product listing
- `/search` - keyword, AI-assisted, and photo-search results
- `/product/:pid` - product detail, variants, shipping, Add to Cart, Buy Now
- `/cart`
- `/checkout`
- `/order/:id`
- `/track`
- `/account`
- `/orders`
- `/wishlist`
- `/returns`
- `/about`
- `/faq`
- `/privacy`
- `/legal`

Recent UX work is included in the current frontend:

- Premium Global Shopper branding and logo.
- Mobile-first ecommerce layout with app-style header, bottom navigation,
  account drawer, category grid, visible pagination, and mobile product CTAs.
- Desktop-only blue header theme scoped in CSS so mobile stays unchanged.
- Category and subcategory image assets in `public/img/`.
- Sub-subcategories currently display as text-only chips until final images are
  added.
- Wishlist and cart actions require sign-in.

## Backend APIs

Main API groups:

- `/api/live` and `/api/health` - health/status checks
- `/api/store/categories` - CJ category tree
- `/api/store/products` - blended catalog + CJ live product listing
- `/api/store/products/:pid` - product details
- `/api/store/search/smart` - AI-assisted text search
- `/api/store/search/photo` - photo search
- `/api/store/search/suggest` - search suggestions
- `/api/store/shipping-for/:pid` - shipping estimate by product
- `/api/store/shipping-for-variant/:vid` - shipping estimate by variant
- `/api/store/payment/create-order` - Razorpay order creation
- `/api/webhooks/razorpay` - Razorpay webhook
- `/api/store/orders` and `/api/store/orders/:id` - customer order flow
- `/api/auth/*` - register, login, logout, profile, cart, wishlist, orders
- `/api/admin/*` - password-gated admin tools
- `/api/marketing/meta-event` - optional Meta Conversions API forwarding
- `/robots.txt`, `/sitemap.xml`, `/sitemaps/*`, `/llms.txt` - SEO endpoints

## Catalog Strategy

The store uses both CJ live APIs and a local SQLite catalog:

- SQLite stores lightweight product summaries only: product ID, SKU, name,
  image URL, category, base CJ price, source, and search indexes.
- Product details, variants, stock, checkout validation, and final shipping
  estimates still refresh from CJ live.
- Search/category pages can respond from the local catalog quickly, then use CJ
  live data where needed.
- Background catalog sync is intentionally conservative so it does not take the
  store down during shopper traffic.

See [server/CATALOG.md](server/CATALOG.md) for sync commands and admin endpoints.

## Pricing And Checkout

Pricing is handled in `server/pricingEngine.js`.

The production formula is controlled by environment variables:

- `USD_TO_INR`
- `PROFIT_MARKUP_PERCENT`
- `CJ_FEE_FACTOR`
- `SHIPPING_FEE_FACTOR`
- `FALLBACK_SHIPPING_USD`
- `DEFAULT_SHIP_FROM`
- `DEFAULT_SHIP_TO`
- `SHIPPING_METHOD`

Checkout uses Razorpay for customer payment and CJ order creation for fulfillment.
CJ order payment mode is controlled by `CJ_PAY_TYPE`.

## Required Environment Variables

Set secrets in Render dashboard, not in git.

Required:

```bash
CJ_API_KEY=
ADMIN_PASSWORD=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
```

Recommended:

```bash
OPENROUTER_API_KEY=
META_CAPI_ACCESS_TOKEN=
```

Important production defaults are documented in `render.yaml`.
For local development, copy `server/.env.example` to `server/.env` and fill in
the real secrets.

## Run Locally

```bash
cd server
npm install
npm start
```

Open:

```text
http://localhost:3001
```

The frontend is served from `public/` by the Express server.

## Useful Commands

Install backend dependencies:

```bash
cd server
npm install
```

Start backend:

```bash
cd server
npm start
```

Run catalog sync manually:

```bash
cd server
npm run catalog:sync -- --target=50000 --max-calls=600 --delay-ms=1200
```

Generate product sitemaps after catalog changes:

```bash
cd server
npm run seo:sitemaps
```

Build Android app bundle:

```bash
cd mobile
npm install
npx eas login
npm run android:build
```

## Android App

The Android app lives in `mobile/`.

Current app model:

- Expo React Native app.
- Android package: `in.globalshopper.app`
- Opens `https://www.globalshopper.in` inside a WebView.
- Uses the live website for products, search, cart, wishlist, checkout, account,
  orders, tracking, FAQ, legal pages, and future website UI changes.
- Keeps native settings for Play Store delivery, splash screen, app links,
  Android back button, camera permission, and notification token registration.

See [mobile/README.md](mobile/README.md) for app build and Play Store notes.

## Project Layout

```text
.
├── public/
│   ├── index.html                 # storefront shell, tags, header, app mount
│   ├── css/styles.css             # desktop/mobile responsive ecommerce UI
│   ├── js/app.js                  # core storefront state, routes, product UI
│   ├── js/app-store.js            # account, checkout, admin, legal pages
│   └── img/                       # logo, category, and subcategory assets
├── server/
│   ├── index.js                   # Express app and API routes
│   ├── cjApi.js                   # CJ Dropshipping API client
│   ├── catalogDb.js               # SQLite catalog and sync logic
│   ├── pricingEngine.js           # retail pricing rules
│   ├── orderManager.js            # local orders + CJ order creation
│   ├── searchAI.js                # OpenRouter/Gemini search parsing
│   ├── scripts/
│   │   ├── syncCatalog.js
│   │   └── generateProductSitemaps.js
│   ├── CATALOG.md
│   └── package.json
├── mobile/
│   ├── App.tsx                    # WebView app shell
│   ├── app.json                   # Expo app/package/deep-link config
│   └── README.md
├── render.yaml                    # Render service, env defaults, disk config
└── README.md
```

## Deployment Flow

1. Push changes to GitHub `main`.
2. Render auto-deploys the `befach-store` service from `render.yaml`.
3. Render installs production dependencies from `server/package.json`.
4. Render starts the service with `npm start`.
5. Health check runs against `/api/live`.

For mobile app releases, build a new AAB with EAS only when native app config,
permissions, icon, package metadata, or Play Store artifacts change. Normal
website/product/UI changes appear inside the app automatically because the app
loads the live website.
