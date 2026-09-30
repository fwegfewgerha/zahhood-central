import crypto from 'node:crypto';
import { db, now } from './db.js';

/**
 * Roblox account ownership, proved the way the community has settled on:
 * the person puts a one-time phrase in their profile's About section, and we
 * read it back from Roblox's public API. Only the account holder can edit
 * that text, so a match is proof.
 *
 * It keeps working for somebody banned from the game, because the ban is
 * ours - their Roblox account is untouched and they can still edit it.
 */

const USERS_API = 'https://users.roblox.com/v1';
const THUMBS_API = 'https://thumbnails.roblox.com/v1';

/** Phrase words chosen to be unambiguous when typed or read aloud. */
const WORDS = [
  'anchor', 'badge', 'cobalt', 'dusty', 'ember', 'falcon', 'granite', 'harbor',
  'indigo', 'jagged', 'kettle', 'lantern', 'marble', 'nimble', 'orbit', 'pepper',
  'quartz', 'ribbon', 'saddle', 'timber', 'umber', 'velvet', 'walnut', 'yonder',
];

export const VERIFY_TTL_MS = 30 * 60 * 1000;

export function makeVerifyPhrase() {
  // Two different words: a repeat like "harbor-harbor" reads like a mistake
  // and invites people to type it wrong.
  const first = crypto.randomInt(WORDS.length);
  let second = crypto.randomInt(WORDS.length - 1);
  if (second >= first) second += 1;
  return `zahhood-${WORDS[first]}-${WORDS[second]}-${crypto.randomInt(1000, 9999)}`;
}

async function robloxFetch(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const err = new Error(`Roblox ${url} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Username or numeric id -> { robloxId, username, displayName } or null. */
export async function resolveUser(input) {
  const raw = String(input || '').trim().replace(/^@/, '');
  if (!raw) return null;

  if (/^\d{1,15}$/.test(raw)) {
    try {
      const u = await robloxFetch(`${USERS_API}/users/${raw}`);
      return { robloxId: u.id, username: u.name, displayName: u.displayName };
    } catch {
      // Fall back to whatever the game has already told us about them.
      const known = db.prepare('SELECT roblox_id, username FROM players WHERE roblox_id = ?').get(Number(raw));
      return known ? { robloxId: known.roblox_id, username: known.username, displayName: known.username } : null;
    }
  }

  try {
    const data = await robloxFetch(`${USERS_API}/usernames/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [raw], excludeBannedUsers: false }),
    });
    const hit = data?.data?.[0];
    if (hit) return { robloxId: hit.id, username: hit.name, displayName: hit.displayName || hit.name };
  } catch {
    /* fall through to the local table */
  }

  const local = db
    .prepare('SELECT roblox_id, username FROM players WHERE username = ? COLLATE NOCASE')
    .get(raw);
  return local ? { robloxId: local.roblox_id, username: local.username, displayName: local.username } : null;
}

/** The public profile, including the description we need to read. */
export async function getProfile(robloxId) {
  return robloxFetch(`${USERS_API}/users/${robloxId}`);
}

export async function getAvatar(robloxId) {
  try {
    const data = await robloxFetch(
      `${THUMBS_API}/users/avatar-headshot?userIds=${robloxId}&size=150x150&format=Png&isCircular=false`
    );
    return data?.data?.[0]?.imageUrl ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------
// the verification handshake
// ---------------------------------------------------------------
export function startVerification(user, target) {
  const phrase = makeVerifyPhrase();
  db.prepare(
    `UPDATE users SET roblox_verify_code = ?, roblox_verify_target = ?, roblox_verify_expires = ?
      WHERE id = ?`
  ).run(phrase, target.robloxId, now() + VERIFY_TTL_MS, user.id);
  return { phrase, expiresAt: now() + VERIFY_TTL_MS, target };
}

export function pendingVerification(user) {
  const row = db
    .prepare('SELECT roblox_verify_code, roblox_verify_target, roblox_verify_expires FROM users WHERE id = ?')
    .get(user.id);
  if (!row?.roblox_verify_code) return null;
  if (!row.roblox_verify_expires || row.roblox_verify_expires < now()) return null;
  return {
    phrase: row.roblox_verify_code,
    robloxId: row.roblox_verify_target,
    expiresAt: row.roblox_verify_expires,
  };
}

/**
 * Read the profile and look for the phrase. Returns why it failed rather than
 * a bare false, because "I pasted it and it says no" is the common case and
 * the person needs to know which part went wrong.
 */
export async function checkVerification(user) {
  const pending = pendingVerification(user);
  if (!pending) return { ok: false, error: 'no_pending_verification' };

  let profile;
  try {
    profile = await getProfile(pending.robloxId);
  } catch {
    return { ok: false, error: 'roblox_unreachable' };
  }

  const description = String(profile?.description || '');
  if (!description.trim()) {
    return { ok: false, error: 'description_empty', robloxId: pending.robloxId };
  }
  if (!description.toLowerCase().includes(pending.phrase.toLowerCase())) {
    return { ok: false, error: 'phrase_not_found', robloxId: pending.robloxId };
  }

  linkAccount(user, { robloxId: pending.robloxId, username: profile.name });

  db.prepare(
    `UPDATE users
        SET roblox_verify_code = NULL, roblox_verify_target = NULL, roblox_verify_expires = NULL
      WHERE id = ?`
  ).run(user.id);

  return { ok: true, robloxId: pending.robloxId, username: profile.name, displayName: profile.displayName };
}

/**
 * Record a proved link. Somebody may own several Roblox accounts, and every
 * one they prove is a confirmed alt of the same person - which is exactly
 * what staff need to trace a ban evader back to whoever is behind it.
 */
export function linkAccount(user, { robloxId, username }) {
  const t = now();
  db.prepare(
    `INSERT INTO roblox_links (user_id, roblox_id, roblox_username, verified_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(roblox_id) DO UPDATE SET
       user_id = excluded.user_id,
       roblox_username = excluded.roblox_username,
       verified_at = excluded.verified_at`
  ).run(user.id, robloxId, username, t);

  // Keep the most recently proved account as the account's headline one.
  db.prepare('UPDATE users SET roblox_user_id = ?, roblox_username = ?, roblox_verified_at = ? WHERE id = ?')
    .run(robloxId, username, t, user.id);
}

/** Every Roblox account this person has proved they own. */
export function linkedAccounts(user) {
  return db
    .prepare('SELECT roblox_id, roblox_username, verified_at FROM roblox_links WHERE user_id = ? ORDER BY verified_at DESC')
    .all(user.id)
    .map((r) => ({ robloxId: r.roblox_id, username: r.roblox_username, verifiedAt: r.verified_at }));
}

export function isLinked(user, robloxId) {
  return !!db
    .prepare('SELECT 1 AS x FROM roblox_links WHERE user_id = ? AND roblox_id = ?')
    .get(user.id, Number(robloxId));
}

/**
 * Who owns this Roblox account, and what else do they own?
 * This is the trace-back staff use on a player profile.
 */
export function ownerOf(robloxId) {
  const link = db
    .prepare(
      `SELECT l.*, u.id AS uid, u.discord_id, u.discord_username, u.discord_global, u.role, u.status
         FROM roblox_links l JOIN users u ON u.id = l.user_id
        WHERE l.roblox_id = ?`
    )
    .get(Number(robloxId));
  if (!link) return null;

  const siblings = db
    .prepare('SELECT roblox_id, roblox_username, verified_at FROM roblox_links WHERE user_id = ? AND roblox_id != ? ORDER BY verified_at DESC')
    .all(link.uid, Number(robloxId));

  return {
    userId: link.uid,
    discordId: link.discord_id,
    discordUsername: link.discord_global || link.discord_username,
    role: link.role,
    status: link.status,
    verifiedAt: link.verified_at,
    alsoOwns: siblings.map((s) => ({ robloxId: s.roblox_id, username: s.roblox_username, verifiedAt: s.verified_at })),
  };
}

/** Has this account proved it owns at least one Roblox user? */
export function verifiedRoblox(user) {
  const all = linkedAccounts(user);
  return all.length ? all[0] : null;
}

/** Someone else already proved they own this Roblox account. */
export function claimedByAnotherAccount(robloxId, user) {
  return db
    .prepare(
      `SELECT u.id, u.discord_username FROM roblox_links l JOIN users u ON u.id = l.user_id
        WHERE l.roblox_id = ? AND l.user_id != ?`
    )
    .get(Number(robloxId), user.id);
}
