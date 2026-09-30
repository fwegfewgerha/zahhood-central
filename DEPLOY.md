# Deploying Zah Hood Central to Fly.io

Free tier, always-on, with the database on a persistent volume so nothing is
lost on restart or redeploy.

Everything in the repo is ready. What follows is the part only you can do,
because it needs your accounts.

---

## 1. Claim the domain first

Do this **before** deploying. Setting `BASE_URL` once and never changing it
means you can move hosts later without touching Discord or signing anyone out.

1. Fork <https://github.com/is-a-dev/register>
2. Create `domains/zahhood.json`:

```json
{
  "owner": {
    "username": "YOUR_GITHUB_USERNAME",
    "email": "YOUR_EMAIL"
  },
  "record": {
    "CNAME": "zahhood.fly.dev"
  }
}
```

3. Open a pull request. Merged in a day or two.

`zahhood.is-a.dev` was free when this was written. If it has gone, try
`zah-hood`, `zahhoodcentral` or `zahhood-central`.

Buying `zahhood.dev` (~$10/yr) instead works the same way — just point a
CNAME at `zahhood.fly.dev`.

---

## 2. Install flyctl and sign in

```bash
powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

Then:

```bash
fly auth signup
```

A card is required for verification even on the free allowance.

---

## 3. Create the app and its volume

From the project folder:

```bash
fly apps create zahhood
```

If that name is taken, pick another and change `app = "zahhood"` in `fly.toml`
to match.

```bash
fly volumes create zahhood_data --region iad --size 1
```

One gigabyte is far more than this database will ever need.

---

## 4. Set the secrets

These are encrypted by Fly and never stored in the repo. Copy the values from
your local `.env`:

```bash
fly secrets set DISCORD_CLIENT_ID=your_client_id
fly secrets set DISCORD_CLIENT_SECRET=your_client_secret
fly secrets set SESSION_SECRET=your_session_secret
fly secrets set GIN_DISCORD_ID=504285424462856192
fly secrets set DISCORD_GUILD_ID=1521776473365807184
fly secrets set BASE_URL=https://zahhood.is-a.dev
fly secrets set DISCORD_REDIRECT_URI=https://zahhood.is-a.dev/auth/discord/callback
```

Keep `SESSION_SECRET` the same as the one you use locally if you want your
existing sign-in to carry over. Changing it just signs everyone out once.

Leave `OWNER_DISCORD_ID` unset until you have someone to give Game Owner to.

---

## 5. Point Discord at the live URL

Developer Portal → your app → OAuth2 → **Redirects**, add:

```
https://zahhood.is-a.dev/auth/discord/callback
```

Keep the localhost one too, so you can still develop locally.

---

## 6. Deploy

```bash
fly deploy
```

Then attach the domain and let Fly issue the certificate:

```bash
fly certs add zahhood.is-a.dev
```

Check it came up:

```bash
fly logs
fly status
```

The startup banner should print `All security checks passed.`

---

## 7. First sign-in

Open <https://zahhood.is-a.dev>. You are whitelisted and `GIN_DISCORD_ID`
matches you, so you land as Gin.

The database starts empty on the volume — that is expected. To carry your
local data over instead, see below.

---

## Moving your local database up

```bash
npm run backup
fly ssh console -C "mkdir -p /data"
fly sftp shell
# then, at the prompt:
put data/backups/zahhood-<timestamp>.db /data/zahhood.db
```

Restart so it picks up the file:

```bash
fly apps restart zahhood
```

---

## Backups

```bash
# snapshot on the server, then pull it down
fly ssh console -C "node scripts/backup.js /data/backup.db"
fly sftp get /data/backup.db ./data/backups/from-fly.db
```

Fly also snapshots volumes daily on its own, but keep your own copies too —
a volume snapshot is no help if the volume is deleted.

Worth doing weekly. The whole database is one file.

---

## Moving to Railway (or anywhere) later

Nothing in this app is Fly-specific. To move:

1. `npm run backup` and pull the file down
2. Create the service on the new host, attach a volume, set `DB_PATH` to a
   path on it
3. Copy the same environment variables across
4. Upload the database file
5. Repoint the `zahhood.is-a.dev` CNAME at the new host

Because `BASE_URL` never changes, Discord needs no edits and nobody is signed
out. The move is invisible to your staff.

---

## Things to watch

**One machine only.** The database is a file on one volume. `fly scale count 2`
would give the second machine its own empty volume and split your data in two.

**Keep `auto_stop_machines = false`.** The game heartbeats every 15 seconds;
a sleeping machine means missed bans and a dead-looking dashboard.

**Free allowance.** One always-on `shared-cpu-1x` with 512MB is small, but it
is not unlimited. Watch <https://fly.io/dashboard> for the first month.
