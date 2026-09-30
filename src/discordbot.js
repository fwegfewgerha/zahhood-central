import { config } from './config.js';

const API = 'https://discord.com/api/v10';

/**
 * Thin wrapper over the handful of Discord bot endpoints this panel needs.
 *
 * Everything here is deliberately anonymous from Discord's point of view:
 * the bot is the actor Discord records, and the audit-log reason is a fixed
 * string. Nothing identifying the staff member who ordered a mute ever
 * leaves this server - that stays in the site's own records.
 */

/** Discord refuses timeouts longer than 28 days. */
export const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

/** A deliberately flat reason, so the Discord audit log reveals nothing. */
const AUDIT_REASON = 'Chat moderation';

export function botConfigured() {
  return !!(config.discord.botToken && config.discord.guildId);
}

/** Why the bot cannot be used right now, or null when it is ready. */
export function botProblem() {
  if (!config.discord.botToken) return 'DISCORD_BOT_TOKEN is not set on the server.';
  if (!config.discord.guildId) return 'DISCORD_GUILD_ID is not set, so there is no server to moderate.';
  return null;
}

async function bot(path, { method = 'GET', body, audit = false } = {}) {
  const headers = {
    Authorization: `Bot ${config.discord.botToken}`,
    'Content-Type': 'application/json',
  };
  // Discord shows this string in the server's audit log, so it never names
  // the staff member. The bot is the only actor anyone can see.
  if (audit) headers['X-Audit-Log-Reason'] = AUDIT_REASON;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(data?.message || `Discord ${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.discordCode = data?.code;
    err.body = data;
    throw err;
  }
  return data;
}

/** Turn a Discord error into something a moderator can act on. */
export function explainDiscordError(err) {
  if (err.status === 401) return 'The bot token is invalid or has been reset.';
  if (err.status === 403) {
    return 'The bot lacks permission. It needs "Moderate Members", and its role must sit above the person being muted.';
  }
  if (err.status === 404 || err.discordCode === 10007) return 'That person is not a member of your Discord server.';
  if (err.status === 429) return 'Discord is rate limiting the bot. Try again shortly.';
  if (err.discordCode === 50013) return 'Missing permissions - the bot cannot moderate someone at or above its own role.';
  return err.message || 'Discord rejected the request.';
}

// ---------------------------------------------------------------
// members
// ---------------------------------------------------------------
export async function getMember(discordId) {
  return bot(`/guilds/${config.discord.guildId}/members/${discordId}`);
}

/** Look someone up by name. Needs the bot to be in the server. */
export async function searchMembers(query, limit = 10) {
  const params = new URLSearchParams({ query: String(query).slice(0, 80), limit: String(limit) });
  return bot(`/guilds/${config.discord.guildId}/members/search?${params}`);
}

export function shapeMember(m) {
  if (!m?.user) return null;
  const u = m.user;
  const avatar = u.avatar
    ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${(BigInt(u.id) >> 22n) % 6n}.png`;

  const until = m.communication_disabled_until ? Date.parse(m.communication_disabled_until) : null;

  return {
    discordId: u.id,
    username: u.username,
    displayName: m.nick || u.global_name || u.username,
    avatar,
    joinedAt: m.joined_at ? Date.parse(m.joined_at) : null,
    roles: m.roles || [],
    // Discord's own view of the timeout, which is the truth.
    timedOutUntil: until && until > Date.now() ? until : null,
  };
}

// ---------------------------------------------------------------
// timeouts
// ---------------------------------------------------------------
/**
 * Mute someone in the Discord server until `until` (a timestamp), or clear
 * the mute when `until` is null.
 */
export async function setTimeout_(discordId, until) {
  const value = until ? new Date(until).toISOString() : null;
  return bot(`/guilds/${config.discord.guildId}/members/${discordId}`, {
    method: 'PATCH',
    body: { communication_disabled_until: value },
    audit: true,
  });
}

export async function muteMember(discordId, durationMs) {
  if (!durationMs || durationMs <= 0) throw new Error('A mute needs a duration.');
  const capped = Math.min(durationMs, MAX_TIMEOUT_MS);
  const until = Date.now() + capped;
  await setTimeout_(discordId, until);
  return { until, capped: capped !== durationMs };
}

export async function unmuteMember(discordId) {
  await setTimeout_(discordId, null);
  return { until: null };
}

/** Confirms the token works and the bot is actually in the guild. */
export async function botSelfCheck() {
  if (!botConfigured()) return { ok: false, error: botProblem() };
  try {
    const me = await bot('/users/@me');
    const guild = await bot(`/guilds/${config.discord.guildId}`);
    return {
      ok: true,
      bot: { id: me.id, username: me.username },
      guild: { id: guild.id, name: guild.name },
    };
  } catch (err) {
    return { ok: false, error: explainDiscordError(err), status: err.status };
  }
}
