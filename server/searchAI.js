/**
 * AI-powered search query parser using Gemini 2.0 Flash via OpenRouter.
 *
 * Takes a raw user query (English / Hindi / Hinglish, possibly with typos
 * and natural language) and returns a structured intent that the CJ
 * search endpoint can act on:
 *
 *   parseQuery("नीली कूलिंग जैकेट under 2000")
 *     → {
 *         keywords: "blue cooling jacket",
 *         color: "blue",
 *         price_max: 2000,
 *         understood_intent: "Blue cooling jacket under ₹2000",
 *         ...
 *       }
 *
 * Cost-control features baked in:
 *   1. In-memory cache keyed by lowercased query — duplicate searches
 *      never hit the AI. Big win since user searches cluster around the
 *      same few popular phrases.
 *   2. Daily spend tracker — when ESTIMATED daily cost exceeds the cap,
 *      we stop calling AI and fall back to plain CJ keyword search.
 *      Reset at midnight UTC.
 *   3. Short max_tokens (200) and low temperature (0.1) → predictable,
 *      cheap output.
 */

const path = require('path');
const fs = require('fs');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-2.0-flash-001';

// Daily spend cap in USD. Override with OPENROUTER_DAILY_CAP_USD.
// Default $1/day = ~₹84/day = ~₹2,500/mo absolute ceiling.
const DAILY_CAP_USD = parseFloat(process.env.OPENROUTER_DAILY_CAP_USD) || 1.0;

// Gemini 2.0 Flash pricing on OpenRouter (cents per 1M tokens, approx).
//   input:  $0.075 / M tokens
//   output: $0.30  / M tokens
// We use these to estimate spend per call so the cap is meaningful even
// without scraping OpenRouter's billing page.
const PRICE_INPUT_PER_MTOK = 0.075;
const PRICE_OUTPUT_PER_MTOK = 0.30;

// Cache TTL — search query meanings don't change. 6h is a safe balance
// between cost savings and picking up genuinely new product trends.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_SIZE = 5000;

const _cache = new Map();   // key → { value, ts }
let _spendUsd = 0;          // running total today
let _spendDay = currentDayKey();

function currentDayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function rolloverIfNewDay() {
  const today = currentDayKey();
  if (today !== _spendDay) {
    _spendDay = today;
    _spendUsd = 0;
  }
}

function isOverBudget() {
  rolloverIfNewDay();
  return _spendUsd >= DAILY_CAP_USD;
}

function trackSpend(inputTokens, outputTokens) {
  rolloverIfNewDay();
  const cost =
    (inputTokens / 1_000_000) * PRICE_INPUT_PER_MTOK +
    (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_MTOK;
  _spendUsd += cost;
}

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return e.value;
}

function cacheSet(key, value) {
  _cache.set(key, { value, ts: Date.now() });
  if (_cache.size > CACHE_MAX_SIZE) {
    // Evict oldest 100 entries
    const keys = Array.from(_cache.keys()).slice(0, 100);
    for (const k of keys) _cache.delete(k);
  }
}

/**
 * System prompt — keep it tight to minimise tokens. Returns strict JSON
 * so we never have to parse natural language.
 *
 * Designed for an Indian consumer e-commerce store. Hindi/Hinglish input
 * is translated to English keywords before search.
 */
const SYSTEM_PROMPT = `You parse user search queries for an Indian e-commerce store.

Input may be English, Hindi, or Hinglish, with typos and natural language.

Return JSON ONLY (no prose), this exact shape:
{
  "keywords": "english search words to send to product API (translate Hindi → English, fix typos, keep concise)",
  "category": "clothing|electronics|home|jewelry|beauty|accessories|toys|sports|other|null",
  "color": "english color name or null",
  "gender": "men|women|kids|unisex|null",
  "price_min": number_in_INR_or_null,
  "price_max": number_in_INR_or_null,
  "intent": "1-line English summary to show user e.g. 'Blue cooling jackets under ₹2000'"
}

Rules:
- "keywords" must be 1-4 English words, the cleanest version of what to search.
- Strip price/color/gender from "keywords" — those go in their own fields.
- "frock" → "dress", "chappal" → "sandals", common India-specific synonyms.
- If query is gibberish or empty, return keywords as-is, all other fields null.`;

/**
 * Parse a user query. Returns:
 *   { keywords, category, color, gender, price_min, price_max, intent, source }
 * where source is "ai" | "cache" | "fallback".
 *
 * Never throws — falls back to a plain pass-through on any error.
 */
async function parseQuery(rawQuery) {
  const q = (rawQuery || '').trim();
  if (!q) return fallback(q, 'empty');

  const cacheKey = q.toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, source: 'cache' };

  if (!process.env.OPENROUTER_API_KEY) return fallback(q, 'no-key');
  if (isOverBudget()) return fallback(q, 'over-budget');

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://global.befach.com',
        'X-Title': 'Befach Global Store',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: q },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 200,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[searchAI] HTTP ${res.status}: ${text.slice(0, 200)}`);
      return fallback(q, 'http-error');
    }

    const data = await res.json();
    const usage = data.usage || {};
    trackSpend(usage.prompt_tokens || 0, usage.completion_tokens || 0);

    const content = data.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(content); }
    catch { return fallback(q, 'invalid-json'); }

    const result = normalise(parsed, q);
    cacheSet(cacheKey, result);
    return { ...result, source: 'ai' };
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('[searchAI] timeout');
    } else {
      console.warn('[searchAI] error:', err.message);
    }
    return fallback(q, 'error');
  }
}

/**
 * Normalise the AI response so downstream code can rely on the shape.
 * Handles missing fields, wrong types, and obvious garbage.
 */
function normalise(parsed, originalQuery) {
  const keywords = typeof parsed.keywords === 'string' && parsed.keywords.trim()
    ? parsed.keywords.trim()
    : originalQuery;
  const intent = typeof parsed.intent === 'string' ? parsed.intent.trim() : '';
  const category = typeof parsed.category === 'string' && parsed.category !== 'null'
    ? parsed.category.toLowerCase()
    : null;
  const color = typeof parsed.color === 'string' && parsed.color !== 'null'
    ? parsed.color.toLowerCase()
    : null;
  const gender = typeof parsed.gender === 'string' && parsed.gender !== 'null'
    ? parsed.gender.toLowerCase()
    : null;
  const price_min = isFiniteNumber(parsed.price_min) ? parsed.price_min : null;
  const price_max = isFiniteNumber(parsed.price_max) ? parsed.price_max : null;
  return { keywords, category, color, gender, price_min, price_max, intent };
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Used when AI is unavailable (no key, over budget, error, timeout).
 * Returns a result that downstream code can still use — the original
 * query goes straight into CJ as keywords.
 */
function fallback(query, reason) {
  return {
    keywords: query,
    category: null,
    color: null,
    gender: null,
    price_min: null,
    price_max: null,
    intent: '',
    source: 'fallback',
    fallbackReason: reason,
  };
}

/** For /api/health — surface AI status without exposing the key. */
function getStatus() {
  rolloverIfNewDay();
  return {
    enabled: !!process.env.OPENROUTER_API_KEY,
    model: MODEL,
    spendTodayUsd: Math.round(_spendUsd * 10000) / 10000,
    dailyCapUsd: DAILY_CAP_USD,
    overBudget: isOverBudget(),
    cacheSize: _cache.size,
  };
}

module.exports = { parseQuery, getStatus };
