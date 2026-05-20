/**
 * Miki — AI shopping assistant.
 * Calls OpenRouter (OpenAI-compatible API) with tool-calling so the
 * model can search our catalog in real time and recommend products +
 * complementary items (a polo shirt → matching jeans → matching belt).
 *
 * Required env vars on the server:
 *   OPENROUTER_API_KEY   — your OpenRouter key (https://openrouter.ai/keys)
 *   AI_MODEL             — optional. Defaults to openai/gpt-4o-mini.
 *                          Any tool-capable OpenRouter model works.
 *
 * No external SDK — uses global fetch (Node 18+).
 */

'use strict';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-4o-mini';
const SITE_URL = (process.env.SITE_URL || 'https://www.globalshopper.in').replace(/\/+$/, '');
const USD_TO_INR = parseFloat(process.env.USD_TO_INR || '85');

// Approximate token budget — we cap conversation history to roughly the
// last 14 turns so long sessions don't blow the model's context window
// or our wallet.
const MAX_HISTORY = 14;
const MAX_USER_MSG_LEN = 600;

const SYSTEM_PROMPT = `You are Miki, the friendly personal shopping assistant for Global Shopper (${SITE_URL}) — an online store delivering branded products from CJ Dropshipping to customers in India and worldwide.

Your tone is warm and human, like a Flipkart or Myntra in-store sales rep. Be brief — 2 to 3 sentences max before asking the next clarifying question. NEVER write long paragraphs.

CRITICAL RULES:
0. PRESENT EVERY PRODUCT the tool returned — never cherry-pick just one. If search_products returned 4 items, the customer should see and hear about all 4. The card carousel renders them; your job is to introduce the set ("I found 4 options that match — quick rundown:"), give a one-line nudge per product, then ask which one they want. Don't pick a favourite for them.
1. ALWAYS use the search_products tool when the customer asks for ANY product. Do not invent product names, prices, brands, or stock claims. Default to max=5 so the customer has a good spread.
1a. PICK CONCRETE SEARCH TERMS. The catalog search is keyword-based, not AI. Vague words like "gadgets", "stuff", "things", "items", "products" return almost nothing. When the customer says something broad, translate it into specific product types and call search_products multiple times in the same turn (each call gets its own labelled card row in the UI):
   - "smart gadgets" → search "smartwatch", "wireless earbuds", "smart speaker"
   - "electronics" → search "headphones", "power bank", "phone charger"
   - "kitchen stuff" → search "kitchen knife", "non-stick pan", "water bottle"
   - "decoration" → search "wall art", "fairy lights", "vase"
   Use the singular product noun, not the category name.
2. After showing the first set, suggest MATCHING complementary items by calling search_products a second time in the same turn:
   - Top wear (shirts, polos, t-shirts) → bottoms (jeans, trousers, chinos, shorts) + accessories (belt, watch, sunglasses)
   - Bottoms (jeans, pants, shorts) → tops + shoes + belts
   - Dresses → shoes + handbag + jewelry
   - Phones / electronics → case, screen protector, charger, earphones
   - Shoes → socks + belt + bag
   - Bags → wallet + small accessories
3. Prices shown to customers are in ₹ INR and are ALREADY INCLUSIVE of taxes and shipping to India — the customer pays exactly what you quote. Always use the priceInr field the tool gives you; never invent or estimate a price.
4. End most replies with a friendly question that moves the sale forward — e.g. "Which color would you like?", "Should I find matching shoes?", "Want me to show more options?".
5. Be enthusiastic but never pushy. If the customer wants to think, say "no problem — just let me know!".
6. If a search returns no good results, acknowledge it briefly and ask for more detail ("Could you tell me which size or color?").
7. Stay strictly on-topic. If the customer asks something off-topic (politics, jokes, code, etc.), gently steer back: "Haha, let's focus on finding you something great! What were you shopping for today?".
8. NEVER make up an order status, delivery date, return policy detail, or contact email. For those, say "I'll connect you with our support team — you can reach us at help@globalshopper.in".
9. The currency shown to you is INR. Round prices to whole rupees.
10. REPLY IN PLAIN TEXT. Do NOT use markdown — no **bold**, no _italics_, no # headings, no - bullets. The chat UI doesn't render markdown, so those characters show up as literal junk. Just write naturally, like a person texting.

You speak English by default but match the customer's language if they write in Hindi, Hinglish, or another Indian language.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_products',
      description:
        'Search the Global Shopper catalog for real products in stock. ' +
        'Returns up to N items with PID, name, image, and INR price. ' +
        'Use this whenever the customer mentions a product or you want to suggest one. ' +
        'You can call this multiple times in a single turn to suggest complementary items.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Plain-English product description. Use English words even if the customer typed in Hindi. ' +
              'Examples: "men polo shirt", "blue jeans women", "leather belt", "wireless earphones", ' +
              '"running shoes black", "saree red silk".',
          },
          max: {
            type: 'integer',
            description: 'How many items to return (1-6). Default 5. Use 5 unless the customer asked for a specific number — variety helps them pick.',
            minimum: 1,
            maximum: 6,
          },
          purpose: {
            type: 'string',
            description:
              'Why you are searching — useful to label the result group in the UI. ' +
              'Examples: "polo shirts", "matching jeans", "complementary belt", "alternative colors".',
          },
        },
        required: ['query'],
      },
    },
  },
];

// ──────────────────────────────────────────────────────────────────
//  OpenRouter HTTP plumbing
// ──────────────────────────────────────────────────────────────────
async function callOpenRouter(messages) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('AI_DISABLED');
  }
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      // OpenRouter etiquette — these show up in their dashboard
      'HTTP-Referer': SITE_URL,
      // Plain ASCII only — HTTP headers are ByteString. The em-dash
      // we previously used here (U+2014) crashed fetch() with
      // "character at index 15 has a value of 8212 which is greater
      // than 255". Hyphen-minus is fine.
      'X-Title': 'Global Shopper - Miki',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.7,
      max_tokens: 700,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Surface the upstream status + first 300 chars of the body so
    // misconfiguration (401 invalid key, 402 no credits, 404 unknown
    // model, etc.) is visible in Render logs.
    console.error(`[ai] OpenRouter ${res.status}: ${body.slice(0, 300)}`);
    const err = new Error(`OpenRouter ${res.status}`);
    err.upstream = res.status;
    err.upstreamBody = body.slice(0, 300);
    throw err;
  }
  return res.json();
}

// Validate the configured key against OpenRouter's /auth/key endpoint
// without sending any tokens. Returns { ok, status, info }. Used by
// the /api/ai/probe diagnostic route so admins can verify their
// Render env var without enabling a costly chat round-trip.
async function probeAuth() {
  if (!OPENROUTER_API_KEY) return { ok: false, reason: 'no_key' };
  try {
    const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
    });
    const body = await res.json().catch(() => ({}));
    return {
      ok: res.ok,
      status: res.status,
      // OpenRouter returns { data: { label, usage, limit, ... } } when valid.
      info: body?.data || body,
    };
  } catch (err) {
    return { ok: false, reason: 'network', message: err.message };
  }
}

// ──────────────────────────────────────────────────────────────────
//  Catalog search adapter — calls the same function the rest of the
//  site uses so the AI never sees a different inventory than the
//  customer would see by typing in the search bar.
// ──────────────────────────────────────────────────────────────────
function buildSearchAdapter({ catalog, pricing, getDisplayUsdForProduct }) {
  // Pure SQLite path. No live CJ fetch, no async I/O beyond SQLite
  // (which is synchronous via better-sqlite3). This was originally
  // calling the storefront's full searchProductsWithCatalogExtras
  // wrapper, but that helper has an "if no local rows then call CJ"
  // fallback which can crash the Node process when the CJ token
  // rotates mid-request or when the catalog index doesn't match.
  // The AI doesn't need that complexity — a direct SQLite hit on
  // 522k+ products is far simpler and never escalates to live calls.
  return function searchCatalogForAI(query, max = 5) {
    try {
      const q = String(query || '').trim().slice(0, 80);
      if (!q) return [];
      const size = Math.max(1, Math.min(6, max || 5));
      let rawItems = (catalog.searchProducts({ keyWord: q, page: 1, size })?.products || []);

      // Catalog FTS uses AND between tokens, so "smart gadgets" needs
      // BOTH words in the product title — and almost nothing has the
      // word "gadgets" in it. Fall back to the longest single token
      // (the most-specific word) when the AND search is thin.
      if (rawItems.length < 3) {
        const tokens = q.split(/\s+/).filter(t => t.length > 2);
        if (tokens.length > 1) {
          const broader = tokens.slice().sort((a, b) => b.length - a.length)[0];
          const seenPids = new Set(rawItems.map(p => String(p.pid || p.id || p.productId || '')));
          const extras = (catalog.searchProducts({ keyWord: broader, page: 1, size: 6 })?.products || [])
            .filter(p => !seenPids.has(String(p.pid || p.id || p.productId || '')));
          rawItems = rawItems.concat(extras).slice(0, size);
        }
      }

      const items = rawItems.slice(0, size);
      return items.map(p => {
        // PRICE: matches the product detail page exactly (so the
        // customer doesn't see one number from the AI and a higher
        // one when they tap "View"). Two-tier lookup:
        //
        //   1. If we have a cached shipping quote for this PID (from
        //      a prior visit or an admin-run shipping refresh), use
        //      the full (wholesale + shipping) × (1 + markup) — that's
        //      computeDisplayUsd, the same call the detail page makes.
        //   2. Otherwise fall back to applyStorePricing (wholesale ×
        //      markup, no shipping). Slight under-quote vs. detail,
        //      but it's the storefront list-view price so still
        //      consistent with at least one place on the site.
        let usd = 0;
        try {
          const displayUsd = typeof getDisplayUsdForProduct === 'function'
            ? getDisplayUsdForProduct(p)
            : null;
          if (displayUsd != null && Number.isFinite(displayUsd) && displayUsd > 0) {
            usd = displayUsd;
          } else if (pricing && typeof pricing.applyStorePricing === 'function') {
            const priced = pricing.applyStorePricing(p);
            usd = parseFloat(priced.sellPrice || priced.price || priced.nowPrice || 0) || 0;
          } else {
            usd = parseFloat(p.sellPrice || p.nowPrice || p.price || 0) || 0;
          }
        } catch {
          usd = parseFloat(p.sellPrice || p.nowPrice || p.price || 0) || 0;
        }
        return {
          pid: String(p.pid || p.id || p.productId || ''),
          name: String(p.productNameEn || p.productName || '').slice(0, 110),
          image: p.productImage || p.bigImage || p.image || '',
          priceInr: Math.round(usd * USD_TO_INR),
          category: p.categoryName || p.threeCategoryName || '',
        };
      }).filter(x => x.pid && x.name);
    } catch (err) {
      // Never let a search failure crash the whole chat — return
      // empty results and let the AI tell the customer it couldn't
      // find anything for that query.
      console.warn('[ai] catalog search failed:', err.message);
      return [];
    }
  };
}

// ──────────────────────────────────────────────────────────────────
//  Main chat entrypoint
// ──────────────────────────────────────────────────────────────────
function buildChat(deps) {
  const searchCatalogForAI = buildSearchAdapter(deps);

  return async function aiChat({ messages }) {
    // ── Validate + sanitise client-provided history ──
    if (!Array.isArray(messages) || !messages.length) {
      return { reply: "Hi! I'm Miki. What are you looking for today?", productGroups: [] };
    }
    const cleaned = messages
      .filter(m => m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant'))
      .slice(-MAX_HISTORY)
      .map(m => ({
        role: m.role,
        content: String(m.content || '').slice(0, MAX_USER_MSG_LEN),
      }))
      .filter(m => m.content);

    if (!cleaned.length) {
      return { reply: 'Could you say that again? I missed it.', productGroups: [] };
    }

    // ── Build the conversation we send to OpenRouter ──
    const fullMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...cleaned,
    ];

    const productGroups = [];

    // Up to 3 tool-call iterations — first call may search, second may
    // call complementary search, third lets the AI write the final
    // reply. More than that and we bail out to keep latency bounded.
    for (let iter = 0; iter < 3; iter++) {
      let completion;
      try {
        completion = await callOpenRouter(fullMessages);
      } catch (err) {
        if (err.message === 'AI_DISABLED') {
          return {
            reply:
              'The AI assistant is currently being set up. Please use the search bar at the top to find products — or reach out at help@globalshopper.in.',
            productGroups: [],
            error: 'disabled',
          };
        }
        console.error('[ai] OpenRouter call failed:', err.message, err.upstreamBody || '');
        return {
          reply: 'Sorry, I had a hiccup connecting to my brain. Could you try again in a moment?',
          productGroups,
          error: 'upstream',
          // Surface upstream diagnostics in non-production debug callers.
          // Safe to expose — no secrets in OpenRouter's standard error
          // bodies (they describe the failure reason, not your key).
          upstreamStatus: err.upstream || null,
          upstreamBody: err.upstreamBody ? err.upstreamBody.slice(0, 240) : null,
        };
      }

      const choice = completion?.choices?.[0];
      const msg = choice?.message;
      if (!msg) {
        return {
          reply: "I'm a bit confused — could you rephrase?",
          productGroups,
        };
      }

      // Push the assistant turn (may contain tool_calls) so the next
      // OpenRouter call sees the full sequence.
      const assistantTurn = { role: 'assistant', content: msg.content || '' };
      if (msg.tool_calls?.length) {
        assistantTurn.tool_calls = msg.tool_calls;
      }
      fullMessages.push(assistantTurn);

      if (msg.tool_calls && msg.tool_calls.length) {
        // Execute each requested tool call sequentially. Sequential
        // (not Promise.all) so a sluggish SQLite query for one tool
        // call doesn't pile concurrent calls on the same DB handle —
        // typical chat turn calls 1-2 tools max, latency is fine.
        const toolResultMessages = [];
        for (const tc of msg.tool_calls) {
          try {
            let parsed;
            try {
              parsed = JSON.parse(tc.function?.arguments || '{}');
            } catch {
              toolResultMessages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify({ error: 'Could not parse tool arguments.' }),
              });
              continue;
            }

            if (tc.function?.name === 'search_products') {
              const items = searchCatalogForAI(parsed.query, parsed.max);
              productGroups.push({
                query: parsed.query,
                purpose: parsed.purpose || parsed.query,
                products: items,
              });
              // Give the model a compact view so it doesn't fixate
              // on URLs / images it doesn't need.
              const summary = items.map(p => ({
                pid: p.pid,
                name: p.name,
                priceInr: p.priceInr,
                category: p.category,
              }));
              toolResultMessages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify({ products: summary, count: summary.length }),
              });
            } else {
              toolResultMessages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify({ error: 'Unknown tool.' }),
              });
            }
          } catch (err) {
            // Belt-and-braces — even if something inside the tool
            // execution throws unexpectedly, return a tool-result
            // so OpenRouter's loop stays coherent.
            console.warn('[ai] tool execution failed:', err.message);
            toolResultMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({ error: 'Tool execution failed.' }),
            });
          }
        }
        fullMessages.push(...toolResultMessages);
        continue; // Loop — give the model another chance to answer with tool data
      }

      // No more tool calls → final reply
      return {
        reply: (msg.content || '').trim() || 'How can I help?',
        // Keep at most the 3 most-recent search groups in the UI so we
        // don't dump 20 cards on the customer.
        productGroups: productGroups.slice(-3),
      };
    }

    return {
      reply: 'Let me know what you want to focus on and I can take it from there!',
      productGroups: productGroups.slice(-3),
    };
  };
}

module.exports = {
  buildChat,
  AI_MODEL,
  probeAuth,
  isConfigured: () => !!OPENROUTER_API_KEY,
};
