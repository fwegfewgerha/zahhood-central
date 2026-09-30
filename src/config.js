import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tiny .env loader so the app has no extra dependency for it.
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv();

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, ''),
  sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  sessionTtlMs: 1000 * 60 * 60 * 24 * 7,

  discord: {
    clientId: env.DISCORD_CLIENT_ID || '',
    clientSecret: env.DISCORD_CLIENT_SECRET || '',
    redirectUri: env.DISCORD_REDIRECT_URI || `${(env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '')}/auth/discord/callback`,
    guildId: env.DISCORD_GUILD_ID || '',
    ownerId: env.OWNER_DISCORD_ID || '',
    // The website owner. Outranks the Game Owner and is granted here alone.
    ginId: env.GIN_DISCORD_ID || '',
    // Bot token, used only to apply chat mutes in your Discord server.
    botToken: env.DISCORD_BOT_TOKEN || '',
  },

  roblox: {
    universeId: env.ROBLOX_UNIVERSE_ID || '',
    placeId: env.ROBLOX_PLACE_ID || '',
    openCloudKey: env.ROBLOX_OPEN_CLOUD_KEY || '',
  },

  serverTimeoutMs: Number(env.SERVER_TIMEOUT_SECONDS || 90) * 1000,
  dbPath: env.DB_PATH || path.join(ROOT, 'data', 'zahhood.db'),
  isProd: env.NODE_ENV === 'production',

  // Only turn this on when a reverse proxy really is in front of the app.
  // With it on and no proxy, anyone can spoof their IP with a header and
  // walk straight past the rate limiter.
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
};

export const SITE = {
  name: 'Zah Hood Central',
  short: 'ZHC',
  tagline: 'Everything that moves in the hood, logged.',
};

if (!config.discord.clientId || !config.discord.clientSecret) {
  console.warn('[config] Discord OAuth is not configured - nobody will be able to log in.');
  console.warn('[config] Copy .env.example to .env and fill in DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET.');
}
if (!process.env.SESSION_SECRET) {
  console.warn('[config] SESSION_SECRET is unset - using a random one. Every restart logs everyone out.');
}
