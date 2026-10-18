/**
 * Authentication: scrypt password hashing, opaque session tokens in HTTP-only
 * cookies (only a SHA-256 hash of the token is stored), CSRF protection and a
 * small sign-in rate limiter. Uses only node:crypto.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { nowIso } from './db.js';

const scrypt = promisify(scryptCb);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_COOKIE = 'cb_session';
export const CSRF_HEADER = 'x-campusbridge-request';

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash to compare against when the email is unknown, so timing does not reveal which emails exist. */
let dummyHash = null;
export async function dummyVerify(password) {
  dummyHash ??= await hashPassword('not-a-real-password-0');
  await verifyPassword(password, dummyHash);
  return false;
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function createSession(db, userId, ttlHours) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + ttlHours * 3_600_000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, nowIso(), expires);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  return { token, expires };
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function userForToken(db, token) {
  if (!token || token.length > 100) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), nowIso());
  return row ? { id: row.id, email: row.email, name: row.name, createdAt: row.created_at } : null;
}

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token, { secure, maxAgeSeconds }) {
  const attrs = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearedCookie({ secure }) {
  return sessionCookie('', { secure, maxAgeSeconds: 0 });
}

/**
 * CSRF defence for every state-changing request: the browser must send our
 * custom header (which a cross-site form cannot set) and, when present, an
 * Origin that matches the allowed origins. SameSite=Lax cookies add a second layer.
 */
export function csrfGuard(allowedOrigins) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get(CSRF_HEADER) !== '1') return res.status(403).json({ error: 'Request blocked: missing security header.' });
    const origin = req.get('origin');
    if (origin && !allowedOrigins(req).includes(origin)) return res.status(403).json({ error: 'Request blocked: unexpected origin.' });
    next();
  };
}

/** Fixed-window limiter for failed sign-ins, keyed by IP and by email. */
export function createLoginLimiter({ max = 5, windowMs = 15 * 60_000 } = {}) {
  const hits = new Map();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.until < now) hits.delete(k);
  };
  return {
    blocked(keys) {
      sweep();
      return keys.some((k) => (hits.get(k)?.count ?? 0) >= max);
    },
    fail(keys) {
      const now = Date.now();
      for (const k of keys) {
        const h = hits.get(k);
        if (!h || h.until < now) hits.set(k, { count: 1, until: now + windowMs });
        else h.count += 1;
      }
    },
    reset(keys) {
      for (const k of keys) hits.delete(k);
    },
  };
}
