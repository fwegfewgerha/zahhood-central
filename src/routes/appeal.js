import express from 'express';
import { db, now, audit, getSetting } from '../db.js';
import { config } from '../config.js';
import { activeBan } from '../moderation.js';
import { role as roleInfo } from '../roles.js';
import { broadcast } from '../realtime.js';
import { rateLimit, clientIpOf } from '../security.js';
import { requireLogin, clientIp } from '../auth.js';
import {
  resolveUser, startVerification, pendingVerification, checkVerification,
  verifiedRoblox, claimedByAnotherAccount, getAvatar, linkedAccounts, isLinked,
} from '../roblox.js';

export const appealRouter = express.Router();

const text = (v, max) => (v == null ? null : String(v).trim().slice(0, max));

/**
 * Appeals still start with a Discord sign-in. That is what makes the rest of
 * this safe: every lookup has a named account behind it and lands in the
 * audit log, so the form cannot be used anonymously to harvest other
 * players' ban reasons and evidence.
 *
 * Signing in does not require the whitelist - see the callback in auth.js.
 * A banned player is never whitelisted, and may have lost the Discord too.
 */
const lookupLimit = rateLimit({
  name: 'appeal-lookup',
  limit: 15,
  windowMs: 10 * 60_000,
  keyFn: (req) => (req.user ? `u${req.user.id}` : clientIpOf(req)),
});
const writeLimit = rateLimit({
  name: 'appeal-write',
  limit: 40,
  windowMs: 10 * 60_000,
  keyFn: (req) => (req.user ? `u${req.user.id}` : clientIpOf(req)),
});

const appealsOpen = () => getSetting('appeals_open', '1') === '1';
const codeRequired = () => getSetting('appeal_require_code', '0') === '1';

function threadFor(appealId) {
  return db
    .prepare('SELECT * FROM appeal_messages WHERE appeal_id = ? ORDER BY id ASC')
    .all(appealId)
    .map((m) => ({
      id: m.id,
      from: m.author_type,
      // The appellant sees a rank, never an individual staff member's name,
      // so ruling on an appeal cannot make somebody a target.
      author:
        m.author_type === 'staff'
          ? (m.author_role ? roleInfo(m.author_role).name : 'Staff')
          : m.author_name,
      roleColor: m.author_type === 'staff' && m.author_role ? roleInfo(m.author_role).color : null,
      body: m.body,
      at: m.created_at,
    }));
}

function shapeForPlayer(a) {
  const ban = db.prepare('SELECT * FROM punishments WHERE id = ?').get(a.punishment_id);
  return {
    id: a.id,
    status: a.status,
    createdAt: a.created_at,
    closedAt: a.closed_at,
    response: a.response,
    robloxId: a.roblox_id,
    username: a.roblox_username,
    ban: ban
      ? {
          reason: ban.reason,
          evidence: ban.evidence,
          issuedAt: ban.issued_at,
          expiresAt: ban.expires_at,
          permanent: ban.expires_at === null,
          active: !!ban.active,
        }
      : null,
    messages: threadFor(a.id),
  };
}

/** The appeal this signed-in person owns, if any. */
function myAppeal(user) {
  return db
    .prepare('SELECT * FROM appeals WHERE discord_id = ? ORDER BY id DESC LIMIT 1')
    .get(user.discord_id);
}

// ---------------------------------------------------------------
appealRouter.get('/config', (req, res) => {
  res.json({
    open: appealsOpen(),
    codeRequired: codeRequired(),
    signedIn: !!req.user,
    me: req.user ? { username: req.user.discord_global || req.user.discord_username } : null,
    baseUrl: config.baseUrl,
  });
});

// Everything past here needs the Discord sign-in.
appealRouter.use(requireLogin);

/** Step 1a: name the Roblox account, and get a phrase to prove it is yours. */
appealRouter.post('/verify/start', lookupLimit, async (req, res) => {
  if (!appealsOpen()) return res.status(503).json({ error: 'appeals_closed' });

  const input = text(req.body?.robloxUser, 40);
  if (!input) return res.status(400).json({ error: 'roblox_user_required' });

  const target = await resolveUser(input);
  if (!target) return res.status(404).json({ error: 'roblox_user_not_found' });

  const taken = claimedByAnotherAccount(target.robloxId, req.user);
  if (taken) return res.status(409).json({ error: 'roblox_already_claimed' });

  const started = startVerification(req.user, target);
  audit(req.user, 'appeal.verify_start', `player:${target.robloxId}`, input, clientIp(req));

  res.json({
    phrase: started.phrase,
    expiresAt: started.expiresAt,
    target: { robloxId: target.robloxId, username: target.username, displayName: target.displayName },
    profileUrl: `https://www.roblox.com/users/${target.robloxId}/profile`,
    avatar: await getAvatar(target.robloxId),
  });
});

/** Step 1b: read the profile back and confirm the phrase is there. */
appealRouter.post('/verify/check', lookupLimit, async (req, res) => {
  const result = await checkVerification(req.user);
  if (!result.ok) {
    audit(req.user, 'appeal.verify_failed', null, result.error, clientIp(req));
    const status = result.error === 'roblox_unreachable' ? 502 : 400;
    return res.status(status).json({ error: result.error });
  }
  audit(req.user, 'appeal.verify_ok', `player:${result.robloxId}`, result.username, clientIp(req));
  res.json({ ok: true, ...result });
});

appealRouter.get('/verify/status', (req, res) => {
  const accounts = linkedAccounts(req.user);
  res.json({
    verified: accounts[0] || null,
    accounts,
    pending: pendingVerification(req.user),
  });
});

/** Step 2: the ban, shown only for an account this person has proved is theirs. */
appealRouter.post('/lookup', lookupLimit, async (req, res) => {
  if (!appealsOpen()) return res.status(503).json({ error: 'appeals_closed' });

  // No verified Roblox account, no ban details. This is what stops the form
  // being used to read somebody else's reason and evidence.
  const accounts = linkedAccounts(req.user);
  if (!accounts.length) return res.status(403).json({ error: 'roblox_not_verified' });

  // Somebody may have proved several accounts, so they say which one. An
  // account they have not proved is simply not theirs to look at.
  const asked = req.body?.robloxId != null ? Number(req.body.robloxId) : null;
  if (asked !== null && !isLinked(req.user, asked)) {
    return res.status(403).json({ error: 'roblox_not_verified' });
  }

  const resolved =
    (asked !== null && accounts.find((a) => a.robloxId === asked)) ||
    accounts.find((a) => activeBan(a.robloxId)) ||
    accounts[0];

  audit(req.user, 'appeal.lookup', `player:${resolved.robloxId}`, resolved.username, clientIp(req));

  const ban = activeBan(resolved.robloxId);
  if (!ban) {
    return res.json({
      found: true, banned: false,
      robloxId: resolved.robloxId, username: resolved.username, accounts,
    });
  }

  if (codeRequired()) {
    const given = text(req.body?.code, 12);
    if (!given) return res.status(401).json({ error: 'code_required', robloxId: resolved.robloxId });
    if (!ban.appeal_code || given.toUpperCase() !== ban.appeal_code.toUpperCase()) {
      audit(req.user, 'appeal.bad_code', `player:${resolved.robloxId}`, null, clientIp(req));
      return res.status(403).json({ error: 'bad_code' });
    }
  }

  // Remember the claim so the rest of the flow does not need it again.
  const existing = db
    .prepare('SELECT * FROM appeals WHERE punishment_id = ? ORDER BY id DESC LIMIT 1')
    .get(ban.id);

  res.json({
    found: true,
    banned: true,
    robloxId: resolved.robloxId,
    username: resolved.username || ban.username,
    ban: {
      reason: ban.reason,
      evidence: ban.evidence,
      issuedAt: ban.issued_at,
      expiresAt: ban.expires_at,
      permanent: ban.expires_at === null,
    },
    existingAppeal: existing ? { id: existing.id, status: existing.status, mine: existing.discord_id === req.user.discord_id } : null,
  });
});

/** Step 2: open the appeal. Choosing to cancel simply never calls this. */
appealRouter.post('/start', writeLimit, async (req, res) => {
  if (!appealsOpen()) return res.status(503).json({ error: 'appeals_closed' });

  const accounts = linkedAccounts(req.user);
  if (!accounts.length) return res.status(403).json({ error: 'roblox_not_verified' });

  const asked = req.body?.robloxId != null ? Number(req.body.robloxId) : null;
  if (asked !== null && !isLinked(req.user, asked)) {
    return res.status(403).json({ error: 'roblox_not_verified' });
  }
  const chosen = asked !== null
    ? accounts.find((a) => a.robloxId === asked)
    : accounts.find((a) => activeBan(a.robloxId)) || accounts[0];
  const robloxId = chosen.robloxId;

  const ban = activeBan(robloxId);
  if (!ban) return res.status(400).json({ error: 'no_active_ban' });

  if (codeRequired()) {
    const given = text(req.body?.code, 12);
    if (!ban.appeal_code || !given || given.toUpperCase() !== ban.appeal_code.toUpperCase()) {
      return res.status(403).json({ error: 'bad_code' });
    }
  }

  const open = db.prepare("SELECT * FROM appeals WHERE punishment_id = ? AND status = 'pending'").get(ban.id);
  if (open) {
    if (open.discord_id && open.discord_id !== req.user.discord_id) {
      return res.status(409).json({ error: 'appeal_already_open_by_someone_else' });
    }
    return res.json({ ok: true, appealId: open.id, alreadyOpen: true });
  }

  const body = text(req.body?.body, 4000);
  if (!body || body.length < 20) return res.status(400).json({ error: 'appeal_too_short' });

  const t = now();
  const info = db
    .prepare(
      `INSERT INTO appeals (punishment_id, roblox_id, roblox_username, discord_id, body, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(ban.id, robloxId, ban.username, req.user.discord_id, body, t);

  const appealId = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO appeal_messages (appeal_id, author_type, user_id, author_name, body, created_at)
     VALUES (?, 'player', ?, ?, ?, ?)`
  ).run(appealId, req.user.id, ban.username, body, t);

  audit(req.user, 'appeal.opened', `player:${robloxId}`, `appeal:${appealId}`, clientIp(req));
  broadcast({ type: 'appeal_opened', id: appealId, username: ban.username }, 20);

  res.json({ ok: true, appealId });
});

/** The conversation, from the player's side. */
appealRouter.get('/mine', (req, res) => {
  const a = myAppeal(req.user);
  if (!a) return res.json({ appeal: null });
  db.prepare("UPDATE appeal_messages SET seen_by_player = 1 WHERE appeal_id = ? AND author_type = 'staff'")
    .run(a.id);
  res.json({ appeal: shapeForPlayer(a) });
});

appealRouter.post('/mine/message', writeLimit, (req, res) => {
  const a = myAppeal(req.user);
  if (!a) return res.status(404).json({ error: 'appeal_not_found' });
  if (a.status !== 'pending') return res.status(409).json({ error: 'appeal_closed' });

  const body = text(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: 'body_required' });

  db.prepare(
    `INSERT INTO appeal_messages (appeal_id, author_type, user_id, author_name, body, created_at)
     VALUES (?, 'player', ?, ?, ?, ?)`
  ).run(a.id, req.user.id, a.roblox_username, body, now());

  broadcast({ type: 'appeal_message', appealId: a.id, from: 'player' }, 20);
  res.json({ ok: true });
});

appealRouter.post('/mine/cancel', writeLimit, (req, res) => {
  const a = myAppeal(req.user);
  if (!a) return res.status(404).json({ error: 'appeal_not_found' });
  if (a.status !== 'pending') return res.status(409).json({ error: 'appeal_closed' });

  const t = now();
  db.prepare("UPDATE appeals SET status = 'withdrawn', closed_at = ? WHERE id = ?").run(t, a.id);
  db.prepare(
    `INSERT INTO appeal_messages (appeal_id, author_type, body, created_at)
     VALUES (?, 'system', ?, ?)`
  ).run(a.id, 'The player withdrew this appeal.', t);

  audit(req.user, 'appeal.withdrawn', `appeal:${a.id}`, null, clientIp(req));
  broadcast({ type: 'appeal_withdrawn', id: a.id }, 20);
  res.json({ ok: true });
});
