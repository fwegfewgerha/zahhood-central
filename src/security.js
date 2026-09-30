import crypto from 'node:crypto';
import { config } from './config.js';
import { db, now, audit, recordLoginAttempt } from './db.js';

// ---------------------------------------------------------------
// Rate limiting
//
// In-memory sliding window, keyed per IP (or per API key / session).
// Good enough for a single-process deployment, which is what this is.
// If you ever run more than one instance, move this to Redis.
// ---------------------------------------------------------------
const buckets = new Map();

function hit(key, limit, windowMs) {
  const t = now();
  const list = buckets.get(key);
  const recent = list ? list.filter((x) => t - x < windowMs) : [];
  if (recent.length >= limit) {
    buckets.set(key, recent);
    return { allowed: false, retryAfter: Math.ceil((windowMs - (t - recent[0])) / 1000) };
  }
  recent.push(t);
  buckets.set(key, recent);
  return { allowed: true, remaining: limit - recent.length };
}

// Stop the map growing without bound.
setInterval(() => {
  const t = now();
  for (const [key, list] of buckets) {
    const recent = list.filter((x) => t - x < 3600_000);
    if (recent.length) buckets.set(key, recent);
    else buckets.delete(key);
  }
}, 600_000).unref?.();

/**
 * @param {object} opts
 * @param {number} opts.limit    requests allowed per window
 * @param {number} opts.windowMs window length
 * @param {string} opts.name     shows up in the audit log
 * @param {(req) => string} [opts.keyFn]
 */
export function rateLimit({ limit, windowMs, name, keyFn }) {
  return (req, res, next) => {
    const key = `${name}:${keyFn ? keyFn(req) : clientIpOf(req)}`;
    const result = hit(key, limit, windowMs);
    if (result.allowed) {
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      return next();
    }
    res.setHeader('Retry-After', String(result.retryAfter));
    if (req.path.startsWith('/api/')) {
      return res.status(429).json({ error: 'rate_limited', retryAfter: result.retryAfter });
    }
    return res.status(429).send('Too many requests. Slow down and try again shortly.');
  };
}

export function clientIpOf(req) {
  // Only trust X-Forwarded-For when we are explicitly told we sit behind a proxy.
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------
// CSRF defence in depth
//
// Session cookies are already SameSite=Lax, which blocks cross-site form
// posts on its own. This adds a second, independent check: any cookie-authed
// state change must carry an Origin (or Referer) belonging to this site.
//
// The game API is exempt - it authenticates with a key, carries no cookies,
// and Roblox servers do not send an Origin header.
// ---------------------------------------------------------------
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireSameOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('origin');
  const referer = req.get('referer');
  const expected = config.baseUrl;

  const ok =
    (origin && originMatches(origin, expected)) ||
    (!origin && referer && originMatches(referer, expected));

  if (!ok) {
    audit(req.user, 'security.csrf_blocked', req.path, `origin=${origin ?? 'none'} referer=${referer ?? 'none'}`, clientIpOf(req));
    return res.status(403).json({ error: 'bad_origin' });
  }
  next();
}

function originMatches(value, expected) {
  try {
    const a = new URL(value);
    const b = new URL(expected);
    return a.protocol === b.protocol && a.host === b.host;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------
// Response headers
// ---------------------------------------------------------------
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

  // Roblox thumbnails are the only third-party content the panel loads.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://cdn.discordapp.com https://*.rbxcdn.com https://www.roblox.com https://tr.rbxcdn.com",
      "connect-src 'self' ws: wss:",
      "font-src 'self' data:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; ')
  );

  if (config.baseUrl.startsWith('https://')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// ---------------------------------------------------------------
// Login throttling
//
// Counts *rejected* sign-ins per IP. Someone hammering the callback with
// stolen codes, or a non-whitelisted account retrying, gets shut out.
// ---------------------------------------------------------------
const MAX_FAILED_LOGINS = 10;
const FAILED_WINDOW_MS = 15 * 60 * 1000;

export function tooManyFailedLogins(ip) {
  if (!ip) return false;
  const since = now() - FAILED_WINDOW_MS;
  const n = db
    .prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND created_at > ?')
    .get(ip, since).n;
  return n >= MAX_FAILED_LOGINS;
}

export function noteFailedLogin({ discordId, username, ip, reason }) {
  recordLoginAttempt({ discordId, username, ip, reason });
}

// ---------------------------------------------------------------
// Startup checks
// ---------------------------------------------------------------
export function auditConfiguration() {
  const problems = [];
  const warnings = [];

  if (!process.env.SESSION_SECRET) {
    problems.push('SESSION_SECRET is not set - sessions reset on every restart and are not reproducible.');
  } else if (process.env.SESSION_SECRET.length < 32) {
    problems.push('SESSION_SECRET is shorter than 32 characters. Generate a long random one.');
  } else if (/^(change-me|secret|password|test)/i.test(process.env.SESSION_SECRET)) {
    problems.push('SESSION_SECRET still looks like a placeholder.');
  }

  if (!config.discord.ownerId) {
    problems.push('OWNER_DISCORD_ID is not set - NOBODY can become Game Owner. Set it and restart.');
  }

  if (config.isProd && !config.baseUrl.startsWith('https://')) {
    problems.push('Running in production over plain HTTP. Session cookies will not be marked Secure.');
  }

  if (!config.discord.guildId) {
    warnings.push('DISCORD_GUILD_ID is empty - anyone with a Discord account can reach the login screen.');
  }

  if (config.trustProxy && !config.isProd) {
    warnings.push('TRUST_PROXY is on outside production - X-Forwarded-For can be spoofed locally.');
  }

  return { problems, warnings };
}

/**
 * Runs at every boot: nobody may hold Game Owner unless their Discord ID is
 * the one in OWNER_DISCORD_ID. This closes the gap where a stale row, a
 * restored backup, or direct database access leaves an extra owner sitting
 * there who would never trigger the check-on-login path.
 */
export function enforceOwnerInvariant() {
  const ownerId = config.discord.ownerId;
  const holders = db.prepare("SELECT id, discord_id, discord_username FROM users WHERE role = 'game_owner'").all();

  const rogue = holders.filter((u) => !ownerId || u.discord_id !== ownerId);
  for (const u of rogue) {
    db.prepare("UPDATE users SET role = 'co_owner' WHERE id = ?").run(u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    audit(
      { id: null, discord_username: 'system', role: 'system' },
      'security.owner_invariant_demoted',
      `user:${u.id}`,
      `${u.discord_username} (${u.discord_id}) held game_owner without matching OWNER_DISCORD_ID`,
      null
    );
    console.log(`  [!]  Demoted rogue Game Owner: ${u.discord_username} (${u.discord_id})`);
  }
  return rogue.length;
}

/** Random token with a constant-time comparison helper. */
export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
