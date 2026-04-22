# Befach Sourcing

Lightweight web app that searches Alibaba.com for products and shows real listings with images, prices, and direct product links — plus a one-click landed-cost calculator that drops the user into [calculator.befach.com](https://calculator.befach.com) for the full CIF + duty + GST breakdown.

## What it does

- Search any product → get real Alibaba listings with photos, prices, and direct product-detail URLs
- Each card has a **🧮 Calculate Landing Price** button that prefills the Befach landed-cost calculator with the product title
- Trust pills surface Befach's Trade Assurance (up to ₹5 Lakhs), money-back policy, and doorstep delivery
- Built-in **server-side image proxy** (`/api/img`) bypasses Alibaba's CDN hotlink protection so product images render in the browser
- **1-hour in-memory cache** so repeat searches return in ~20 ms

## Stack

- **Backend**: Node.js + Express, Server-Sent Events (SSE) for live result streaming
- **Scraper**: Puppeteer-extra + Stealth plugin against the user's installed Google Chrome (with a persistent profile so Alibaba cookies stick)
- **Frontend**: Vanilla HTML/CSS/JS — no build step

## Run locally

```bash
cd server
npm install
npm start
# → http://localhost:3001
```

### Environment

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Server port |
| `ALIBABA_VISIBLE` | unset (headless) | Set to `1` to launch Chrome visibly so a human can solve the Alibaba CAPTCHA once. Cookies persist in `~/.befach-sourcing-chrome` for future headless runs. |

## Production caveat

The current Puppeteer-based approach works on a developer laptop because (a) you can solve the Alibaba CAPTCHA in a real Chrome window, and (b) cookies persist locally. Neither of those exist on a hosted server with a datacenter IP and many concurrent users.

For production, swap the `scrapers/alibaba.js` implementation for a paid scraping API (SerpAPI's Alibaba endpoint, ScrapingBee, ScraperAPI, or Apify) — they handle rotating residential proxies + automatic CAPTCHA solving for $30–50/month.

## Project layout

```
.
├── public/                  # Static frontend (no build)
│   ├── index.html           # Header, hero, search box, trust pills
│   ├── css/styles.css       # Light theme matching befach.com
│   ├── js/app.js            # Search + SSE rendering + image proxy routing
│   ├── img/befach_logo.png  # Brand logo
│   └── data/platforms.json  # Cross-platform launcher registry (Excel-derived)
└── server/
    ├── index.js             # Express app, SSE search endpoint, image proxy
    └── scrapers/
        ├── alibaba.js       # Puppeteer-stealth + axios fast-path
        └── _trending.js     # Graceful fallback catalog
```
