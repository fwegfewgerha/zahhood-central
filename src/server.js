import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { config, SITE, ROOT } from './config.js';
import { attachUser } from './auth.js';
import { isStaff } from './roles.js';
import { authRouter } from './routes/auth.js';
import { appealRouter } from './routes/appeal.js';
import { apiRouter } from './routes/api.js';
import { gameRouter } from './routes/game.js';
import { initRealtime } from './realtime.js';
import { startStatsLoop, sampleNow } from './stats.js';
import { keyCount } from './apikeys.js';
import {
  securityHeaders, rateLimit, requireSameOrigin, clientIpOf, auditConfiguration,
  enforceOwnerInvariant,
} from './security.js';
import { isWhitelistEnabled, db } from './db.js';

const app = express();
app.set('trust proxy', config.trustProxy ? 1 : false);
app.disable('x-powered-by');
app.disable('etag');

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(securityHeaders);
app.use(attachUser);

// ---- rate limits ----
// Starting a login is cheap to attempt, so it is the tightest.
const loginLimiter = rateLimit({ name: 'login', limit: 15, windowMs: 10 * 60_000 });
// The panel is chatty (polling, search-as-you-type) so this is generous.
const panelLimiter = rateLimit({
  name: 'panel',
  limit: 600,
  windowMs: 60_000,
  keyFn: (req) => (req.user ? `u${req.user.id}` : clientIpOf(req)),
});
// A busy game sends a lot: heartbeats plus per-join checks from many servers.
const gameLimiter = rateLimit({
  name: 'game',
  limit: 1200,
  windowMs: 60_000,
  keyFn: (req) => req.get('x-zhc-key')?.slice(-12) || clientIpOf(req),
});

// ---- routes ----
app.use('/auth', loginLimiter, authRouter);
app.use('/api/game', gameLimiter, gameRouter); // Roblox -> site (API key auth, no cookies)
app.use('/api/appeal', panelLimiter, requireSameOrigin, appealRouter); // any logged-in user
app.use('/api', panelLimiter, requireSameOrigin, apiRouter); // panel (Discord session auth)

app.get('/healthz', (req, res) => res.json({ ok: true, name: SITE.name, t: Date.now() }));

// ---- pages ----
const pub = path.join(ROOT, 'public');
/**
 * Static files.
 *
 * The panel's HTML, JavaScript and CSS are served `no-cache`, which does not
 * mean "do not cache" - it means "always ask me first". The browser keeps its
 * copy and revalidates with an ETag, so an unchanged file costs a 304 and no
 * body, while a deploy is picked up immediately.
 *
 * A long max-age here would leave everybody on stale code for an hour after
 * every deploy, which is exactly the sort of thing that looks like a bug.
 * Images and fonts, which get new names rather than new contents, may cache.
 */
app.use(
  express.static(pub, {
    index: false,
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', config.isProd ? 'public, max-age=604800' : 'no-cache');
      }
    },
  })
);

app.get('/', (req, res) => {
  if (req.user && !req.user.suspended && isStaff(req.user.role)) return res.redirect('/panel');
  res.sendFile(path.join(pub, 'index.html'));
});

app.get(['/panel', '/panel/*'], (req, res) => {
  if (!req.user) return res.redirect(`/auth/discord?next=${encodeURIComponent(req.originalUrl)}`);
  res.sendFile(path.join(pub, 'panel.html'));
});

app.get('/appeal', (req, res) => {
  if (!req.user) return res.redirect('/auth/discord?next=/appeal');
  res.sendFile(path.join(pub, 'appeal.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  res.status(404).sendFile(path.join(pub, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'server_error' });
});

// ---- boot ----
const server = http.createServer(app);
initRealtime(server);
startStatsLoop();
sampleNow();

server.listen(config.port, () => {
  const line = '='.repeat(58);
  console.log(`\n${line}`);
  console.log(`  ${SITE.name} - ${SITE.tagline}`);
  console.log(line);
  console.log(`  Panel        ${config.baseUrl}/panel`);
  console.log(`  Game API     ${config.baseUrl}/api/game`);
  console.log(`  Discord      ${config.discord.clientId ? 'configured' : 'NOT CONFIGURED - logins will fail'}`);
  console.log(`  Guild lock   ${config.discord.guildId || 'off (anyone with Discord may log in)'}`);
  console.log(`  Game keys    ${keyCount()} active`);
  const allowed = db.prepare('SELECT COUNT(*) AS n FROM whitelist').get().n;
  console.log(
    `  Whitelist    ${isWhitelistEnabled() ? `ON - ${allowed} allowed` : 'OFF - anyone with Discord may sign in'}`
  );
  console.log(`  Owner        ${config.discord.ownerId || 'NOT SET - nobody can be Game Owner'}`);
  console.log(line);

  enforceOwnerInvariant();

  const { problems, warnings } = auditConfiguration();
  for (const p of problems) console.log(`  [!]  ${p}`);
  for (const w of warnings) console.log(`  [~]  ${w}`);
  if (!problems.length && !warnings.length) console.log('  All security checks passed.');
  console.log(`${line}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[${SITE.short}] shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
