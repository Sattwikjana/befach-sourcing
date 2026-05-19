/**
 * AL Suliswan — AI shopping assistant.
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

const SYSTEM_PROMPT = `You are AL Suliswan, the friendly AI shopping assistant for Global Shopper (${SITE_URL}) — an online store delivering branded products from CJ Dropshipping to customers in India and worldwide.

Your tone is warm and human, like a Flipkart or Myntra in-store sales rep. Be brief — 2 to 3 sentences max before asking the next clarifying question. NEVER write long paragraphs.

CRITICAL RULES:
1. ALWAYS use the search_products tool when the customer asks for ANY product. Do not invent product names, prices, brands, or stock claims.
2. After showing the first product, suggest MATCHING complementary items by calling search_products a second time in the same turn:
   - Top wear (shirts, polos, t-shirts) → bottoms (jeans, trousers, chinos, shorts) + accessories (belt, watch, sunglasses)
   - Bottoms (jeans, pants, shorts) → tops + shoes + belts
   - Dresses → shoes + handbag + jewelry
   - Phones / electronics → case, screen protector, charger, earphones
   - Shoes → socks + belt + bag
   - Bags → wallet + small accessories
3. Prices shown to customers are in ₹ INR. Always use the price the tool gives you.
4. End most replies with a friendly question that moves the sale forward — e.g. "Which color would you like?", "Should I find matching shoes?", "Want me to show more options?".
5. Be enthusiastic but never pushy. If the customer wants to think, say "no problem — just let me know!".
6. If a search returns no good results, acknowledge it briefly and ask for more detail ("Could you tell me which size or color?").
7. Stay strictly on-topic. If the customer asks something off-topic (politics, jokes, code, etc.), gently steer back: "Haha, let's focus on finding you something great! What were you shopping for today?".
8. NEVER make up an order status, delivery date, return policy detail, or contact email. For those, say "I'll connect you with our support team — you can reach us at help@globalshopper.in".
9. The currency shown to you is INR. Round prices to whole rupees.

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
            description: 'How many items to return (1-6). Default 4.',
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
      'X-Title': 'Global Shopper — AL Suliswan',
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
function buildSearchAdapter({ searchProductsWithCatalogExtras, mergeDeterministicSearchIntent }) {
  return async function searchCatalogForAI(query, max = 4) {
    const q = String(query || '').trim().slice(0, 80);
    if (!q) return [];
    const size = Math.max(1, Math.min(6, max || 4));
    let intent = null;
    try {
      intent = mergeDeterministicSearchIntent(q, {
        keywords: q,
        broader_keywords: q,
        category: null,
        color: null,
        gender: null,
        price_min: null,
        price_max: null,
        intent: null,
        source: 'deterministic',
      });
    } catch {}
    let meta;
    try {
      meta = await searchProductsWithCatalogExtras({
        keyWord: q,
        page: 1,
        size,
        allowLive: false, // SQLite catalog only — keeps the AI fast (catalog has 522k+ products)
        searchIntent: intent,
      });
    } catch (err) {
      console.warn('[ai] catalog search failed:', err.message);
      return [];
    }
    const items = (meta?.products || []).slice(0, size);
    return items.map(p => {
      const usd = parseFloat(p.sellPrice || p.nowPrice || p.price || 0) || 0;
      return {
        pid: String(p.pid || p.id || p.productId || ''),
        name: String(p.productNameEn || p.productName || '').slice(0, 110),
        image: p.productImage || p.bigImage || p.image || '',
        priceInr: Math.round(usd * USD_TO_INR),
        category: p.categoryName || p.threeCategoryName || '',
      };
    }).filter(x => x.pid && x.name);
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
      return { reply: "Hi! I'm AL Suliswan. What are you looking for today?", productGroups: [] };
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
        console.error('[ai] OpenRouter call failed:', err.message);
        return {
          reply: 'Sorry, I had a hiccup connecting to my brain. Could you try again in a moment?',
          productGroups,
          error: 'upstream',
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
        // Execute each requested tool call in parallel
        const toolResultMessages = await Promise.all(
          msg.tool_calls.map(async (tc) => {
            let parsed;
            try {
              parsed = JSON.parse(tc.function?.arguments || '{}');
            } catch {
              return {
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify({ error: 'Could not parse tool arguments.' }),
              };
            }

            if (tc.function?.name === 'search_products') {
              const items = await searchCatalogForAI(parsed.query, parsed.max);
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
              return {
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify({ products: summary, count: summary.length }),
              };
            }

            return {
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({ error: 'Unknown tool.' }),
            };
          })
        );
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
