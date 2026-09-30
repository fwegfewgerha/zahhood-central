# Zah Hood Central

Staff panel, player database, ban system and live-stats dashboard for the **Zah Hood** Roblox
experience. Discord is the only way in. The site talks to your game over a small HTTP API, so
a ban issued on the website lands on a live server within one heartbeat.

---

## What it does

| Feature | Where |
|---|---|
| Discord-only login (optionally locked to your Discord server) | `/` |
| Live stats: players, servers, joins, FPS, ping, 24h graph | Dashboard |
| Player database with search, stats, history, notes, alt detection | Player Database |
| Warns, mutes, kicks, temp bans, permanent bans | anywhere a player appears |
| Look up any server by its ID and see exactly who is inside | Live Servers |
| Message or shut down a live server | server page |
| Staff chat with rooms gated by rank | Staff Chat |
| 13-rank staff ladder with promote / demote | Staff Team |
| Ban appeals filed by players, ruled on by staff | Appeals |
| API keys the game authenticates with | Game Connection |
| Audit log of every staff action | Audit Log |

---

## Quick start

```bash
npm install
cp .env.example .env
```

Fill in `.env` (see **Discord setup** below), then:

```bash
npm start
```

Open <http://localhost:3000>.

### Try it before wiring up Discord

```bash
node scripts/dev-seed.js
```

That creates demo staff, 64 players, punishment history, an appeal and a game API key, and
prints a `document.cookie = ...` line. Paste that into the browser console on
`http://localhost:3000`, then open `/panel` and you are signed in as the Game Owner.

To watch the dashboard move, run a fake Roblox server with the key the seeder printed:

```bash
node scripts/fake-server.js <api-key> my-test-server 12
```

It joins and drops players, sends gameplay events, and carries out any kick or ban you issue
from the panel — the same API the real Lua script uses.

### Check everything works

```bash
npm start                    # terminal 1
node scripts/smoke-test.js   # terminal 2
```

38 assertions covering auth, the heartbeat, the ban pipeline, rank enforcement and lookups.

---

## Discord setup

1. Go to <https://discord.com/developers/applications> and create an application.
2. **OAuth2 → Redirects**, add exactly: `http://localhost:3000/auth/discord/callback`
   (swap in your real domain in production — it must match `DISCORD_REDIRECT_URI`).
3. Copy the **Client ID** and **Client Secret** into `.env`.
4. Turn on Developer Mode in Discord, right-click yourself, **Copy User ID**, and put it in
   `OWNER_DISCORD_ID`. That account is promoted to **Game Owner** the first time it logs in.
5. Optional: set `DISCORD_GUILD_ID` to your Discord server's ID so only members of that server
   can sign in at all.

Everyone else who logs in starts as a plain **Member** with no access. A Co-Owner, the Creator
or the Game Owner gives them a staff role from the **Staff Team** page.

> If you leave `OWNER_DISCORD_ID` blank, the very first account to log in becomes Game Owner so
> you are never locked out. Set it properly before the site is public.

---

## The staff ladder

Rank decides everything. A higher rank can act on a lower one and never on an equal or higher one.

| Rank | Role | Gains |
|---:|---|---|
| 10 | Chat Moderator | panel, database, servers, chat, warns, mutes |
| 15 | Trial Moderator | |
| 20 | Moderator | kicks, sees everyone's punishments |
| 30 | Senior Moderator | temp bans, lifting punishments, appeals |
| 40 | Head Moderator | permanent bans, deleting chat messages, audit log |
| 50 | Administrator | admin chat room |
| 55 | Senior Administrator | |
| 60 | Head Administrator | shutting servers down |
| 65 | Community Manager | |
| 70 | **Owner Assistant** | promote / demote, suspend staff, view API keys |
| 80 | **Co-Owner** | create and revoke API keys, settings |
| 90 | **Creator** | |
| 100 | **Game Owner** | everything, including purging data |

Co-Owner, Creator and Game Owner are the only three ranks above Owner Assistant, exactly as
specified. Edit `src/roles.js` to rename roles or move a permission's threshold — it is the one
place the ladder is defined.

Guardrails that are enforced server-side, not just hidden in the UI:

- you can never assign a role at or above your own
- you can never change your own role or suspend yourself
- you can only lift a punishment issued by someone below you (or your own)
- you cannot punish a player whose linked staff account outranks you
- a chat room above your rank is not just hidden, the API refuses it

---

## Connecting the game

1. **Game Connection** page → create a key → copy it (shown once).
2. Roblox Studio → **Game Settings → Security → Allow HTTP Requests: ON**.
3. Put `roblox/ZahHoodCentral.server.lua` into **ServerScriptService**.
4. Set the two values at the top:

```lua
local CONFIG = {
    BaseUrl = "https://your-site.com",  -- no trailing slash
    ApiKey  = "zhc_live_...",
}
```

That script handles everything: it checks joiners against the ban list before they get in,
heartbeats the roster and server health every 15 seconds, executes queued kicks, bans, mutes,
announcements and shutdowns, and saves playtime and stats back on leave.

Two hooks for the rest of your game:

```lua
_G.ZahHood.logEvent("robbery", player, "Corner store")           -- shows in the activity feed
_G.ZahHood.punish(userId, name, "ban", "Exploiting", "7d", "AntiCheat")
_G.ZahHood.isMuted(player.UserId)                                 -- respect panel mutes in chat
```

Point `statsFor()` in that script at your own leaderstats or DataStore values and the player
database fills itself in.

### Game API reference

All routes are under `/api/game` and need the header `X-ZHC-Key: <your key>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/ping` | key smoke test |
| `POST` | `/heartbeat` | roster + health; **returns queued actions** |
| `POST` | `/join` | ban check before letting a player in |
| `POST` | `/leave` | save playtime and stats |
| `POST` | `/events` | batch gameplay events |
| `POST` | `/punish` | punishment issued from inside the game |
| `GET` | `/bans?since=<ms>` | full or incremental ban sync |
| `GET` | `/check/:userId` | single ban lookup |
| `GET` | `/actions?serverId=` | pull queued actions without a heartbeat |
| `POST` | `/ack` | confirm actions were carried out |

Actions are delivered until acknowledged, so a server that restarts mid-ban still applies it.

---

## How it is built

No build step, no framework. Node 22.5+ (`node:sqlite` is built in), Express and `ws`.

```
src/
  config.js       .env loading and settings
  db.js           schema + migrations on boot
  roles.js        the staff ladder and every permission threshold
  auth.js         Discord OAuth2, signed-cookie sessions, guards
  moderation.js   punishments and the outbound action queue
  stats.js        live snapshot, per-minute history, housekeeping
  apikeys.js      hashed game keys
  realtime.js     one websocket per staff member, rank-filtered
  routes/
    auth.js       login, logout, appeals
    api.js        the panel API
    game.js       the Roblox-facing API
public/           the panel (vanilla ES modules)
roblox/           the Lua script that goes in your game
scripts/          dev-seed, fake-server, smoke-test
```

Security notes worth knowing:

- Sessions are random IDs stored server-side; the cookie carries an HMAC so a forged ID is
  useless. `HttpOnly`, `SameSite=Lax`, and `Secure` once `BASE_URL` is https.
- API keys are stored as SHA-256 hashes. The plaintext is shown once at creation.
- Player IP addresses are never stored — only a salted hash, used for the alt-account hint.
- Every permission is re-checked on the server for each request.
- Websocket messages are filtered by rank before they are sent, so a Chat Moderator's browser
  never receives owners-room traffic at all.

---

## Deploying

Any host that runs Node and gives you a persistent disk for `data/zahhood.db` works
(Railway, Render, Fly, a VPS). Behind a reverse proxy:

- set `BASE_URL` to your https URL and update the Discord redirect to match
- set a long random `SESSION_SECRET` and keep it stable, or everyone gets logged out on restart
- set `NODE_ENV=production`
- make sure websockets are proxied (`/ws`)
- back up `data/zahhood.db` — it is the whole database

```bash
NODE_ENV=production BASE_URL=https://your-site.com npm start
```

---

## Notes

- Roblox headshot images load straight from Roblox and quietly hide if it is unreachable.
- A server disappears from the panel ~90 seconds after its last heartbeat
  (`SERVER_TIMEOUT_SECONDS`). Seeded demo servers go offline on that timer too — run
  `scripts/fake-server.js` if you want one that stays up.
- `ROBLOX_OPEN_CLOUD_KEY` is optional and currently unused by the app; it is there for when you
  want to push messages to live servers instantly instead of waiting for the next heartbeat.
- Delete `data/zahhood.db` to wipe everything and start clean.
