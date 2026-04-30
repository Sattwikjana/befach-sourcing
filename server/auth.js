/**
 * Auth module — user registration, login, and session management.
 *
 * Storage is file-based (data/users.json, data/sessions.json) to match
 * the rest of the app's storage strategy. When you migrate to a real
 * database, this is the file to swap out.
 *
 * Sessions are 30-day random tokens stored in an httpOnly cookie
 * (`befach_sid`). Passwords are bcrypt-hashed (10 rounds).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const COOKIE_NAME = 'befach_sid';
const SESSION_DAYS = 30;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── File-backed stores ──
function loadJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
}
function saveJson(file, val) {
  try { fs.writeFileSync(file, JSON.stringify(val, null, 2)); }
  catch (e) { console.warn(`[auth] save ${file} failed:`, e.message); }
}

let users = loadJson(USERS_FILE, []);
let sessions = loadJson(SESSIONS_FILE, {});

// Throttle session writes (writes happen on every login)
let sessionSaveTimer = null;
function persistSessions() {
  if (sessionSaveTimer) return;
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    saveJson(SESSIONS_FILE, sessions);
  }, 1000);
}

// ── Validation ──
function validEmail(s) { return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function validName(s) { return typeof s === 'string' && s.trim().length >= 2 && s.length <= 60; }
function validPhone(s) { return typeof s === 'string' && s.replace(/\D/g, '').length >= 7; }
function validPassword(s) { return typeof s === 'string' && s.length >= 6 && s.length <= 100; }

// ── Public-safe user shape ──
function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

// ── Register ──
async function register({ email, password, name, phone }) {
  email = (email || '').trim().toLowerCase();
  name = (name || '').trim();
  phone = (phone || '').trim();

  if (!validEmail(email)) throw new Error('Please enter a valid email');
  if (!validPassword(password)) throw new Error('Password must be at least 6 characters');
  if (!validName(name)) throw new Error('Please enter your name');
  if (phone && !validPhone(phone)) throw new Error('Please enter a valid phone number');

  if (users.find(u => u.email === email)) {
    throw new Error('An account with this email already exists');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: 'U-' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    email,
    name,
    phone,
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveJson(USERS_FILE, users);
  return publicUser(user);
}

// ── Login ──
async function login({ email, password }) {
  email = (email || '').trim().toLowerCase();
  if (!validEmail(email) || !password) throw new Error('Email and password required');

  const user = users.find(u => u.email === email);
  if (!user) throw new Error('Wrong email or password');

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new Error('Wrong email or password');

  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  sessions[token] = { userId: user.id, expires };
  persistSessions();

  return { token, user: publicUser(user) };
}

// ── Resolve session token → user ──
function userForToken(token) {
  if (!token) return null;
  const s = sessions[token];
  if (!s) return null;
  if (s.expires < Date.now()) {
    delete sessions[token];
    persistSessions();
    return null;
  }
  const u = users.find(x => x.id === s.userId);
  return publicUser(u);
}

function logout(token) {
  if (token && sessions[token]) {
    delete sessions[token];
    persistSessions();
  }
}

// ── Update profile (name, phone, address) ──
function updateProfile(userId, patch) {
  const u = users.find(x => x.id === userId);
  if (!u) throw new Error('User not found');
  if (patch.name !== undefined) {
    if (!validName(patch.name)) throw new Error('Invalid name');
    u.name = patch.name.trim();
  }
  if (patch.phone !== undefined) {
    if (patch.phone && !validPhone(patch.phone)) throw new Error('Invalid phone');
    u.phone = (patch.phone || '').trim();
  }
  if (patch.address !== undefined) {
    // Free-form address object — stored as-is for the checkout pre-fill
    u.address = patch.address || null;
  }
  saveJson(USERS_FILE, users);
  return publicUser(u);
}

// ── Per-user cart & wishlist persistence ──
// Stored alongside the user record in users.json. Keeps cart & saved
// products synced across devices: a customer who adds something on
// their laptop sees it on their phone too as soon as they sign in.
// Cart shape: [{ pid, vid, productName, image, priceUsd, quantity, ... }]
// Wishlist:   [pid, pid, ...]
function getUserCart(userId) {
  const u = users.find(x => x.id === userId);
  return u?.cart || [];
}
function setUserCart(userId, cart) {
  const u = users.find(x => x.id === userId);
  if (!u) throw new Error('User not found');
  u.cart = Array.isArray(cart) ? cart.slice(0, 100) : [];
  saveJson(USERS_FILE, users);
  return u.cart;
}
function getUserWishlist(userId) {
  const u = users.find(x => x.id === userId);
  return u?.wishlist || [];
}
function setUserWishlist(userId, pids) {
  const u = users.find(x => x.id === userId);
  if (!u) throw new Error('User not found');
  u.wishlist = Array.isArray(pids) ? pids.filter(p => typeof p === 'string').slice(0, 500) : [];
  saveJson(USERS_FILE, users);
  return u.wishlist;
}

// ── List users for the admin Customers panel ──
// Returns every registered account (without passwords) plus a count of
// active sessions so admins can see who's currently signed in.
function listUsers() {
  // Build a map of userId → most recent session expiry to figure out
  // which accounts are currently logged in (session not yet expired).
  const liveSessionByUser = new Map();
  for (const [, s] of Object.entries(sessions)) {
    if (!s || s.expires < Date.now()) continue;
    const prev = liveSessionByUser.get(s.userId);
    if (!prev || s.expires > prev) liveSessionByUser.set(s.userId, s.expires);
  }
  return users.map(u => ({
    ...publicUser(u),
    sessionLive: liveSessionByUser.has(u.id),
    sessionExpiresAt: liveSessionByUser.get(u.id) || null,
  }));
}

// ── Express middleware: attaches req.user if logged in ──
function attachUser(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME] ||
                req.headers.authorization?.replace(/^Bearer\s+/i, '');
  req.sessionToken = token || null;
  req.user = token ? userForToken(token) : null;
  next();
}

// ── Cookie helpers ──
function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}
function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

module.exports = {
  register,
  login,
  logout,
  userForToken,
  updateProfile,
  getUserCart,
  setUserCart,
  getUserWishlist,
  setUserWishlist,
  listUsers,
  attachUser,
  setSessionCookie,
  clearSessionCookie,
  COOKIE_NAME,
};
