import { WebSocketServer } from 'ws';
import { userFromRequest, publicUser } from './auth.js';
import { isStaff, rankOf } from './roles.js';
import { db } from './db.js';

let wss = null;
const clients = new Set();

/**
 * One websocket hub for the whole panel. Every staff member holds a single
 * socket and receives: staff chat, live stat ticks, and the moderation feed.
 * Messages are only ever pushed to sockets whose rank clears the gate, so a
 * Chat Moderator never receives owners-only traffic in the first place.
 */
export function initRealtime(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const user = userFromRequest(req);
    if (!user || user.suspended || !isStaff(user.role)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = user;
      ws.rank = rankOf(user.role);
      ws.isAlive = true;
      ws.connectedAt = Date.now();
      ws.lastSeen = ws.connectedAt;
      ws.sessionId = user.sid;
      ws.ip = ipOf(req);
      ws.userAgent = req.headers['user-agent'] || null;
      ws.route = '#/';
      ws.routeAt = ws.connectedAt;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'ping') {
        ws.lastSeen = Date.now();
        send(ws, { type: 'pong', t: Date.now() });
      }
      // The panel reports which page it is on so the traffic view can
      // show where each person currently is.
      if (msg.type === 'route' && typeof msg.path === 'string') {
        ws.route = msg.path.slice(0, 120);
        ws.routeAt = Date.now();
        ws.lastSeen = ws.routeAt;
        recordPageView(ws, ws.route);
      }
    });
    ws.on('close', () => {
      clients.delete(ws);
      broadcastPresence();
    });
    ws.on('error', () => {
      clients.delete(ws);
    });

    recordPageView(ws, '#/');
    send(ws, { type: 'hello', user: publicUser(ws.user), t: Date.now() });
    broadcastPresence();
  });

  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* socket is going away anyway */
      }
    }
  }, 30_000);
  heartbeat.unref?.();

  return wss;
}

function ipOf(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

/** One row per page a signed-in person opens. Skips repeats of the same page. */
function recordPageView(ws, path) {
  if (ws.lastLoggedRoute === path) return;
  ws.lastLoggedRoute = path;
  try {
    db.prepare(
      `INSERT INTO page_views (user_id, session_id, path, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(ws.user.id, ws.sessionId ?? null, path, ws.ip, ws.userAgent, Date.now());
  } catch {
    // Traffic logging must never break the socket.
  }
}

/**
 * Everyone currently connected to the website, with what they are doing.
 * Only ever served to the `traffic.view` permission.
 */
export function liveVisitors() {
  const out = [];
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    out.push({
      userId: ws.user.id,
      discordId: ws.user.discord_id,
      username: ws.user.discord_global || ws.user.discord_username,
      handle: ws.user.discord_username,
      role: ws.user.role,
      avatar: publicUser(ws.user).avatar,
      ip: ws.ip,
      userAgent: ws.userAgent,
      sessionId: ws.sessionId ? String(ws.sessionId).slice(0, 8) : null,
      connectedAt: ws.connectedAt,
      lastSeen: ws.lastSeen,
      route: ws.route,
      routeAt: ws.routeAt,
    });
  }
  return out.sort((a, b) => b.connectedAt - a.connectedAt);
}

function send(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

/** Push to every connected staff member whose rank is at least `minRank`. */
export function broadcast(payload, minRank = 0) {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.rank < minRank) continue;
    if (ws.readyState !== ws.OPEN) continue;
    try {
      ws.send(data);
    } catch {
      /* ignore */
    }
  }
}

export function broadcastToUser(userId, payload) {
  for (const ws of clients) {
    if (ws.user?.id === userId) send(ws, payload);
  }
}

/** Who is currently sitting in the panel. */
export function onlineStaff() {
  const seen = new Map();
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (!seen.has(ws.user.id)) seen.set(ws.user.id, publicUser(ws.user));
  }
  return [...seen.values()].sort((a, b) => b.rank - a.rank);
}

export function broadcastPresence() {
  broadcast({ type: 'presence', staff: onlineStaff() });
}
