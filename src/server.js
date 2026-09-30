import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { config, SITE, ROOT } from './config.js';
import { attachUser } from './auth.js';
import { isStaff } from './roles.js';
import { authRouter, appealRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';
import { gameRouter } from './routes/game.js';
import { initRealtime } from './realtime.js';
import { startStatsLoop, sampleNow } from './stats.js';
import { keyCount } from './apikeys.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(attachUser);

// ---- routes ----
app.use('/auth', authRouter);
app.use('/api/game', gameRouter); // Roblox -> site (API key auth)
app.use('/api/appeal', appealRouter); // any logged-in user
app.use('/api', apiRouter); // panel (Discord session auth)

app.get('/healthz', (req, res) => res.json({ ok: true, name: SITE.name, t: Date.now() }));

// ---- pages ----
const pub = path.join(ROOT, 'public');
app.use(express.static(pub, { index: false, maxAge: config.isProd ? '1h' : 0 }));

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
  console.log(`${line}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[${SITE.short}] shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
