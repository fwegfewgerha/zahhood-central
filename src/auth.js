import crypto from 'node:crypto';
import { config } from './config.js';
import { db, now, newId, audit } from './db.js';
import { can, isStaff, permissionsFor, role as roleInfo, PROTECTED_ROLES } from './roles.js';

const COOKIE = 'zhc_sid';
const STATE_COOKIE = 'zhc_state';
const DISCORD_API = 'https://discord.com/api/v10';

// ---------------------------------------------------------------
// cookies
// ---------------------------------------------------------------
export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, maxAgeMs) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (maxAgeMs != null) bits.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  if (config.baseUrl.startsWith('https://')) bits.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(bits.join('; '));
  res.setHeader('Set-Cookie', list);
}

function clearCookie(res, name) {
  setCookie(res, name, '', 0);
}

// Sessions are a random id stored server-side; the cookie carries
// `id.hmac` so a stolen-but-unsigned id is useless.
function sign(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

function verifySigned(raw) {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return null;
  const id = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = sign(id);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return id;
}

// ---------------------------------------------------------------
// sessions
// ---------------------------------------------------------------
export function createSession(res, user, req) {
  const id = newId(32);
  const created = now();
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    user.id,
    created,
    created + config.sessionTtlMs,
    created,
    clientIp(req),
    req.headers['user-agent'] || null
  );
  setCookie(res, COOKIE, `${id}.${sign(id)}`, config.sessionTtlMs);
  return id;
}

export function destroySession(req, res) {
  const id = verifySigned(parseCookies(req)[COOKIE]);
  if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  clearCookie(res, COOKIE);
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

/** Idle timeout: a session untouched for this long is dead even if not expired. */
const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

export function userFromRequest(req) {
  const id = verifySigned(parseCookies(req)[COOKIE]);
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT s.id AS sid, s.expires_at, s.user_agent AS session_ua, s.last_used_at, u.*
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`
    )
    .get(id);
  if (!row) return null;

  const t = now();
  if (row.expires_at < t) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }

  // Idle expiry.
  if (row.last_used_at && t - row.last_used_at > IDLE_TIMEOUT_MS) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }

  // Bind the session to the browser that created it. A cookie lifted onto a
  // different client is rejected rather than silently accepted.
  const ua = req.headers['user-agent'] || '';
  if (row.session_ua && row.session_ua !== ua) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    audit(row, 'security.session_ua_mismatch', `user:${row.id}`, null, clientIp(req));
    return null;
  }

  db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(t, id);

  if (row.status !== 'active') return { ...row, suspended: true };
  return row;
}

export function touchUser(userId) {
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), userId);
}

// ---------------------------------------------------------------
// express middleware
// ---------------------------------------------------------------
export function attachUser(req, res, next) {
  req.user = userFromRequest(req);
  if (req.user && !req.user.suspended) touchUser(req.user.id);
  next();
}

/** API guard: must be signed in through Discord. */
export function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not_authenticated', login: '/auth/discord' });
  if (req.user.suspended) return res.status(403).json({ error: 'account_suspended' });
  next();
}

/** API guard: must be signed in AND hold a staff role. */
export function requireStaff(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not_authenticated', login: '/auth/discord' });
  if (req.user.suspended) return res.status(403).json({ error: 'account_suspended' });
  if (!isStaff(req.user.role)) return res.status(403).json({ error: 'not_staff' });
  next();
}

/** API guard for a specific permission. */
export function requirePerm(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'not_authenticated', login: '/auth/discord' });
    if (req.user.suspended) return res.status(403).json({ error: 'account_suspended' });
    if (!can(req.user.role, permission)) {
      return res.status(403).json({ error: 'missing_permission', permission });
    }
    next();
  };
}

export function publicUser(u) {
  if (!u) return null;
  const r = roleInfo(u.role);
  return {
    id: u.id,
    discordId: u.discord_id,
    username: u.discord_global || u.discord_username,
    handle: u.discord_username,
    avatar: avatarUrl(u),
    role: u.role,
    roleName: r.name,
    roleColor: r.color,
    rank: r.rank,
    staff: r.staff,
    robloxId: u.roblox_user_id,
    robloxUsername: u.roblox_username,
    permissions: permissionsFor(u.role),
    lastLogin: u.last_login_at,
  };
}

export function avatarUrl(u) {
  if (u.discord_avatar) {
    const ext = u.discord_avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${u.discord_id}/${u.discord_avatar}.${ext}?size=128`;
  }
  const index = (BigInt(u.discord_id) >> 22n) % 6n;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

// ---------------------------------------------------------------
// Discord OAuth2
// ---------------------------------------------------------------
export function discordAuthorizeUrl(res, returnTo) {
  const state = newId(16);
  setCookie(res, STATE_COOKIE, `${state}.${sign(state)}|${returnTo || '/panel'}`, 10 * 60 * 1000);
  const params = new URLSearchParams({
    client_id: config.discord.clientId,
    redirect_uri: config.discord.redirectUri,
    response_type: 'code',
    scope: config.discord.guildId ? 'identify guilds' : 'identify',
    state,
    prompt: 'none',
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

export function consumeState(req, res, given) {
  const raw = parseCookies(req)[STATE_COOKIE];
  clearCookie(res, STATE_COOKIE);
  if (!raw) return { ok: false };
  const [signed, returnTo] = raw.split('|');
  const state = verifySigned(signed);
  if (!state || state !== given) return { ok: false };
  return { ok: true, returnTo: returnTo && returnTo.startsWith('/') ? returnTo : '/panel' };
}

export async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: config.discord.clientId,
    client_secret: config.discord.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.discord.redirectUri,
  });
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`discord token exchange failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function discordGet(pathname, accessToken) {
  const res = await fetch(`${DISCORD_API}${pathname}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`discord ${pathname} failed (${res.status})`);
  return res.json();
}

/**
 * Create or refresh the local account for a Discord user.
 * The configured OWNER_DISCORD_ID is promoted to game_owner automatically,
 * and the very first account ever created is promoted too so the panel is
 * never left with nobody who can administer it.
 */
export function upsertUser(profile, req) {
  const t = now();
  const existing = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(profile.id);

  if (existing) {
    db.prepare(
      `UPDATE users SET discord_username = ?, discord_global = ?, discord_avatar = ?, last_login_at = ?, last_seen_at = ?
        WHERE id = ?`
    ).run(profile.username, profile.global_name || null, profile.avatar || null, t, t, existing.id);
  } else {
    db.prepare(
      `INSERT INTO users (discord_id, discord_username, discord_global, discord_avatar, role, created_at, last_login_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(profile.id, profile.username, profile.global_name || null, profile.avatar || null, 'member', t, t, t);
  }

  let user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(profile.id);

  // The two top ranks are granted by ONE thing only: an exact match on an ID
  // in the server's environment file. There is no "first account wins"
  // fallback, and the panel API refuses to assign either of them, so the only
  // way to hold one is to have access to the server's .env.
  //
  // Gin (the website owner) outranks Game Owner, and wins if both match.
  const isGin = !!config.discord.ginId && config.discord.ginId === profile.id;
  const isConfiguredOwner =
    !isGin && !!config.discord.ownerId && config.discord.ownerId === profile.id;

  const entitled = isGin ? 'gin' : isConfiguredOwner ? 'game_owner' : null;

  if (entitled && user.role !== entitled) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(entitled, user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    audit(
      { id: null, discord_username: 'system', role: 'system' },
      'staff.bootstrap_owner',
      `user:${user.id}`,
      isGin ? 'matched GIN_DISCORD_ID' : 'matched OWNER_DISCORD_ID',
      clientIp(req)
    );
  }

  // Holding a protected rank without matching its ID gets you demoted on
  // sight - covers a changed .env or a tampered database row.
  if (!entitled && PROTECTED_ROLES.has(user.role)) {
    const held = user.role;
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('co_owner', user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    audit(
      { id: null, discord_username: 'system', role: 'system' },
      'security.owner_mismatch_demoted',
      `user:${user.id}`,
      `held ${held} without matching its configured Discord ID`,
      clientIp(req)
    );
  }

  audit(user, 'auth.login', `user:${user.id}`, null, clientIp(req));
  return user;
}
