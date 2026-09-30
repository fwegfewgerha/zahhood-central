import express from 'express';
import { audit, getSetting } from '../db.js';
import { requireLogin, clientIp } from '../auth.js';
import { rateLimit, clientIpOf } from '../security.js';
import {
  resolveUser, startVerification, pendingVerification, checkVerification,
  linkedAccounts, claimedByAnotherAccount, getAvatar,
} from '../roblox.js';

export const linkRouter = express.Router();

/**
 * Proving you own a Roblox account, for anybody signed in.
 *
 * Staff do this once on their first visit so a punishment can always be
 * traced to a real person, and appellants do it so nobody can read somebody
 * else's ban. Same handshake either way, so it lives in one place.
 */
const limit = rateLimit({
  name: 'roblox-link',
  limit: 20,
  windowMs: 10 * 60_000,
  keyFn: (req) => (req.user ? `u${req.user.id}` : clientIpOf(req)),
});

linkRouter.use(requireLogin);

export function staffLinkRequired() {
  return getSetting('require_staff_roblox', '1') === '1';
}

linkRouter.get('/status', (req, res) => {
  const accounts = linkedAccounts(req.user);
  res.json({
    accounts,
    verified: accounts[0] || null,
    pending: pendingVerification(req.user),
    requiredForStaff: staffLinkRequired(),
  });
});

/** Name the account and get the phrase to put in your Roblox profile. */
linkRouter.post('/start', limit, async (req, res) => {
  const input = String(req.body?.robloxUser ?? '').trim().slice(0, 40);
  if (!input) return res.status(400).json({ error: 'roblox_user_required' });

  const target = await resolveUser(input);
  if (!target) return res.status(404).json({ error: 'roblox_user_not_found' });

  if (claimedByAnotherAccount(target.robloxId, req.user)) {
    return res.status(409).json({ error: 'roblox_already_claimed' });
  }

  const started = startVerification(req.user, target);
  audit(req.user, 'roblox.verify_start', `player:${target.robloxId}`, input, clientIp(req));

  res.json({
    phrase: started.phrase,
    expiresAt: started.expiresAt,
    target: { robloxId: target.robloxId, username: target.username, displayName: target.displayName },
    profileUrl: `https://www.roblox.com/users/${target.robloxId}/profile`,
    avatar: await getAvatar(target.robloxId),
  });
});

/** Read the profile back and confirm the phrase is there. */
linkRouter.post('/check', limit, async (req, res) => {
  const result = await checkVerification(req.user);
  if (!result.ok) {
    audit(req.user, 'roblox.verify_failed', null, result.error, clientIp(req));
    return res.status(result.error === 'roblox_unreachable' ? 502 : 400).json({ error: result.error });
  }
  audit(req.user, 'roblox.verify_ok', `player:${result.robloxId}`, result.username, clientIp(req));
  res.json({ ok: true, ...result });
});
