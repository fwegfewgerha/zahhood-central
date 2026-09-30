import express from 'express';
import { config } from '../config.js';
import { db, now, audit, isWhitelistEnabled, isWhitelisted, getSetting } from '../db.js';
import { isStaff } from '../roles.js';
import { tooManyFailedLogins, noteFailedLogin, clientIpOf } from '../security.js';
import {
  discordAuthorizeUrl,
  consumeState,
  exchangeCode,
  discordGet,
  upsertUser,
  createSession,
  destroySession,
  entitledRole,
  clientIp,
  requireLogin,
} from '../auth.js';
import { activeBan, punishmentsFor } from '../moderation.js';

export const authRouter = express.Router();

/** Whether somebody who is not whitelisted may sign in to file an appeal. */
export function appealsOpen() {
  return getSetting('appeals_open', '1') === '1';
}

function fail(res, code, detail) {
  const url = `/?error=${encodeURIComponent(code)}${detail ? `&detail=${encodeURIComponent(detail)}` : ''}`;
  res.redirect(url);
}

// Kick off the Discord handshake.
authRouter.get('/discord', (req, res) => {
  if (!config.discord.clientId || !config.discord.clientSecret) {
    return fail(res, 'discord_not_configured');
  }
  const returnTo = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/panel';
  res.redirect(discordAuthorizeUrl(res, returnTo));
});

authRouter.get('/discord/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return fail(res, String(error));
  if (!code || !state) return fail(res, 'missing_code');

  const st = consumeState(req, res, String(state));
  if (!st.ok) return fail(res, 'bad_state');

  // Shut out an IP that keeps getting rejected.
  if (tooManyFailedLogins(clientIpOf(req))) {
    return fail(res, 'too_many_attempts');
  }

  try {
    const token = await exchangeCode(String(code));
    const profile = await discordGet('/users/@me', token.access_token);

    const ip = clientIp(req);
    // Whoever the environment file names - Gin or Game Owner - always gets
    // through the whitelist, so an empty list can never lock them out.
    const isOwner = !!entitledRole(profile.id);

    // Gate 1: the whitelist. The configured owner is always allowed through
    // so an empty list can never lock the site's own owner out.
    //
    // A banned player has to be able to reach the appeal form, and by
    // definition they are not whitelisted. So somebody who fails the
    // whitelist may still sign in when appeals are open - but only ever as
    // an ordinary member, and the panel is closed to them exactly as before.
    let appealOnly = false;
    if (isWhitelistEnabled() && !isOwner && !isWhitelisted(profile.id)) {
      const existing = db.prepare('SELECT role FROM users WHERE discord_id = ?').get(profile.id);

      // Someone holding a staff role who is no longer whitelisted has had
      // their access revoked. That must stay a hard block: letting them back
      // in "for appeals" would hand them the panel again.
      const hasStaffRole = !!existing && isStaff(existing.role);

      if (appealsOpen() && !hasStaffRole) {
        appealOnly = true;
      } else {
        noteFailedLogin({ discordId: profile.id, username: profile.username, ip, reason: 'not_whitelisted' });
        audit(null, 'security.login_rejected', `discord:${profile.id}`, `${profile.username} is not whitelisted`, ip);
        return fail(res, 'not_whitelisted');
      }
    }

    // Gate 2: optional Discord server membership.
    // Someone appealing a ban may well have been thrown out of the Discord
    // too, so this gate does not apply to them.
    if (config.discord.guildId && !appealOnly) {
      let guilds = [];
      try {
        guilds = await discordGet('/users/@me/guilds', token.access_token);
      } catch {
        return fail(res, 'guild_check_failed');
      }
      if (!guilds.some((g) => g.id === config.discord.guildId)) {
        noteFailedLogin({ discordId: profile.id, username: profile.username, ip, reason: 'not_in_guild' });
        audit(null, 'auth.rejected_not_in_guild', `discord:${profile.id}`, profile.username, ip);
        return fail(res, 'not_in_server');
      }
    }

    const user = upsertUser(profile, req);
    if (user.status !== 'active') {
      noteFailedLogin({ discordId: profile.id, username: profile.username, ip, reason: 'suspended' });
      return fail(res, 'account_suspended');
    }

    createSession(res, user, req);
    if (appealOnly) {
      audit(user, 'auth.login_appeal_only', `user:${user.id}`, null, ip);
      return res.redirect('/appeal');
    }
    res.redirect(st.returnTo || '/panel');
  } catch (err) {
    console.error('[auth] callback failed:', err.message);
    // Pass the specific reason through when we have one, so the landing page
    // can say what actually happened instead of "something went wrong".
    fail(res, err.code || 'oauth_failed', err.retryAfter ? String(Math.ceil(err.retryAfter)) : null);
  }
});

authRouter.post('/logout', (req, res) => {
  if (req.user) audit(req.user, 'auth.logout', `user:${req.user.id}`, null, clientIp(req));
  destroySession(req, res);
  res.json({ ok: true });
});

authRouter.get('/logout', (req, res) => {
  if (req.user) audit(req.user, 'auth.logout', `user:${req.user.id}`, null, clientIp(req));
  destroySession(req, res);
  res.redirect('/');
});

// ---------------------------------------------------------------
// Appeals: any logged-in Discord user can file one against a ban
// that is attached to the Roblox account they say is theirs.
// ---------------------------------------------------------------
export const appealRouter = express.Router();

appealRouter.get('/status', requireLogin, (req, res) => {
  const robloxId = req.user.roblox_user_id;
  if (!robloxId) return res.json({ linked: false });
  const ban = activeBan(robloxId);
  const mine = db
    .prepare('SELECT * FROM appeals WHERE roblox_id = ? ORDER BY created_at DESC LIMIT 10')
    .all(robloxId);
  res.json({
    linked: true,
    robloxId,
    banned: !!ban,
    ban: ban ? { id: ban.id, reason: ban.reason, expiresAt: ban.expires_at, issuedAt: ban.issued_at } : null,
    history: punishmentsFor(robloxId).length,
    appeals: mine.map((a) => ({
      id: a.id,
      status: a.status,
      body: a.body,
      createdAt: a.created_at,
      response: a.response,
      handledBy: a.handled_by_name,
    })),
  });
});

appealRouter.post('/', requireLogin, (req, res) => {
  const robloxId = req.user.roblox_user_id;
  if (!robloxId) return res.status(400).json({ error: 'link_roblox_first' });
  const body = String(req.body?.body ?? '').trim().slice(0, 4000);
  if (body.length < 20) return res.status(400).json({ error: 'appeal_too_short' });

  const ban = activeBan(robloxId);
  if (!ban) return res.status(400).json({ error: 'no_active_ban' });

  const open = db
    .prepare("SELECT id FROM appeals WHERE punishment_id = ? AND status = 'pending'")
    .get(ban.id);
  if (open) return res.status(409).json({ error: 'appeal_already_pending', id: open.id });

  const info = db
    .prepare(
      `INSERT INTO appeals (punishment_id, roblox_id, discord_id, body, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    )
    .run(ban.id, robloxId, req.user.discord_id, body, now());

  audit(req.user, 'appeal.submit', `punishment:${ban.id}`, null, clientIp(req));
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});
