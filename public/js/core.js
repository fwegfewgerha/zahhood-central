// ============================================================
// Zah Hood Central - shared front-end plumbing
// ============================================================

export const state = {
  me: null,
  meta: null,
  stats: null,
  staffOnline: [],
  ws: null,
  wsOpen: false,
  listeners: new Map(),
};

// ---------------- dom ----------------
export function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(3)) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ---------------- api ----------------
export async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401) {
    location.href = '/auth/discord';
    throw new Error('not_authenticated');
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (!res.ok) {
    const err = new Error(data.error || `http_${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const ERRORS = {
  missing_permission: 'Your role does not allow that.',
  not_staff: 'You are signed in, but you are not on the staff team.',
  outranked: 'That was issued by someone at or above your rank.',
  target_outranks_you: 'That person outranks you.',
  role_above_you: 'You can only hand out roles below your own.',
  cannot_change_own_role: 'You cannot change your own role.',
  cannot_suspend_yourself: 'You cannot suspend yourself.',
  slow_down: 'Slow down a second.',
  channel_forbidden: 'That room is above your rank.',
  player_not_found: 'No player with that ID has ever joined.',
  server_not_found: 'No server with that ID is known to the panel.',
  already_inactive: 'That punishment is already lifted or expired.',
  reason_required: 'A reason is required.',
  label_required: 'Give the key a name.',
  bad_discord_id: 'That is not a valid Discord user ID (17-20 digits).',
  cannot_remove_owner: 'The configured owner cannot be removed from the whitelist.',
  owner_role_is_env_only: 'Game Owner can only be set in the server environment file, never from here.',
  cannot_change_owner: 'The Game Owner’s role cannot be changed from the panel.',
  bad_color: 'Use a hex colour like #ffa32e.',
  bad_origin: 'That request was blocked as cross-site. Reload the page and try again.',
  rate_limited: 'You are going too fast. Wait a moment.',
  unknown_role: 'No such role.',
  bot_not_configured: 'The Discord bot is not set up on the server yet, so muting is unavailable.',
  discord_error: 'Discord refused the request.',
  duration_required: 'Pick how long the mute should last.',
  cannot_mute_yourself: 'You cannot mute yourself.',
  query_required: 'Type a name or user ID to search for.',
};

export function errMessage(err) {
  return ERRORS[err?.message] || err?.message || 'Something went wrong.';
}

// ---------------- toasts ----------------
export function toast(message, kind = '') {
  const node = el('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(20px)';
    setTimeout(() => node.remove(), 260);
  }, 4200);
}

// ---------------- modal ----------------
export function modal({ title, body, actions = [], onOpen }) {
  const root = document.getElementById('modal-root');
  const close = () => clear(root);

  const content = el('div', { class: 'content' });
  if (typeof body === 'string') content.innerHTML = body;
  else content.append(body);

  const footer = el('div', { class: 'footer' });
  const foot = el('footer');
  for (const a of actions) {
    foot.append(
      el(
        'button',
        {
          class: `btn ${a.kind || ''}`,
          onclick: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            try {
              const keep = await a.onClick?.(close);
              if (keep !== 'keep') close();
            } catch (err) {
              toast(errMessage(err), 'err');
              btn.disabled = false;
            }
          },
        },
        a.label
      )
    );
  }

  const box = el(
    'div',
    { class: 'modal', onclick: (e) => e.stopPropagation() },
    el('header', {}, el('h3', {}, title), el('button', { class: 'x', onclick: close }, '×')),
    content,
    actions.length ? foot : null
  );

  const back = el('div', { class: 'modal-back', onclick: close }, box);
  clear(root).append(back);
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  });
  onOpen?.(box, close);
  return close;
}

export function confirmDialog(title, message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    let settled = false;
    modal({
      title,
      body: el('p', { class: 'dim', style: { margin: 0 } }, message),
      actions: [
        { label: 'Cancel', onClick: () => { settled = true; resolve(false); } },
        {
          kind: 'danger',
          label: confirmLabel,
          onClick: () => { settled = true; resolve(true); },
        },
      ],
    });
    // Closing via Escape / backdrop resolves false.
    const observer = new MutationObserver(() => {
      if (!document.getElementById('modal-root').firstChild && !settled) {
        settled = true;
        observer.disconnect();
        resolve(false);
      }
    });
    observer.observe(document.getElementById('modal-root'), { childList: true });
  });
}

// ---------------- formatting ----------------
export function timeAgo(ms) {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 0) return 'in ' + duration(-d);
  if (d < 45_000) return 'just now';
  return duration(d) + ' ago';
}

export function duration(ms) {
  const s = Math.floor(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ${h % 24}h`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

export function playtime(seconds) {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function dateTime(ms) {
  if (!ms) return '-';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export function clock(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function n(value) {
  return (value ?? 0).toLocaleString();
}

export function can(permission) {
  return !!state.me?.permissions?.includes(permission);
}

export function roleBadge(roleKey, roleName, roleColor) {
  const r = state.meta?.roles?.find((x) => x.key === roleKey);
  const name = roleName || r?.name || roleKey || 'Unknown';
  const color = roleColor || r?.color || '#8b93a7';
  return el(
    'span',
    { class: 'pill role', style: { color, borderColor: color + '55', background: color + '18' } },
    name
  );
}

export function punishPill(p) {
  if (!p.active) return el('span', { class: 'pill mute' }, p.revokedBy ? 'lifted' : 'expired');
  const map = { ban: 'err', kick: 'warnp', warn: 'warnp', mute: 'info' };
  const label = p.type === 'ban' && p.permanent ? 'perm ban' : p.type;
  return el('span', { class: `pill ${map[p.type] || 'mute'}` }, label);
}

// ---------------- sparkline / area chart ----------------
export function lineChart(points, { color = '#ffa32e', fill = true, height = 180 } = {}) {
  const W = 800;
  const H = height;
  const pad = { l: 34, r: 10, t: 12, b: 20 };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'chart');

  if (!points.length) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', W / 2);
    t.setAttribute('y', H / 2);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('fill', '#646d84');
    t.setAttribute('font-size', '13');
    t.textContent = 'No data yet - the graph fills in once servers start reporting.';
    svg.append(t);
    return svg;
  }

  const max = Math.max(1, ...points.map((p) => p.v));
  const min = 0;
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const x = (i) => pad.l + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v) => pad.t + innerH - ((v - min) / (max - min || 1)) * innerH;

  const ns = 'http://www.w3.org/2000/svg';
  // gridlines + y labels
  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) / 3) * i;
    const gy = y(v);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', pad.l); line.setAttribute('x2', W - pad.r);
    line.setAttribute('y1', gy); line.setAttribute('y2', gy);
    line.setAttribute('stroke', '#1b2230'); line.setAttribute('stroke-width', '1');
    svg.append(line);
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', pad.l - 6); label.setAttribute('y', gy + 3.5);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('fill', '#646d84'); label.setAttribute('font-size', '10');
    label.textContent = Math.round(v);
    svg.append(label);
  }

  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');

  if (fill) {
    const gradId = `g${Math.random().toString(36).slice(2, 8)}`;
    const defs = document.createElementNS(ns, 'defs');
    const grad = document.createElementNS(ns, 'linearGradient');
    grad.setAttribute('id', gradId);
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
    const s1 = document.createElementNS(ns, 'stop');
    s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', color); s1.setAttribute('stop-opacity', '.28');
    const s2 = document.createElementNS(ns, 'stop');
    s2.setAttribute('offset', '100%'); s2.setAttribute('stop-color', color); s2.setAttribute('stop-opacity', '0');
    grad.append(s1, s2);
    defs.append(grad);
    svg.append(defs);

    const area = document.createElementNS(ns, 'path');
    area.setAttribute('d', `${d} L${x(points.length - 1)},${pad.t + innerH} L${x(0)},${pad.t + innerH} Z`);
    area.setAttribute('fill', `url(#${gradId})`);
    svg.append(area);
  }

  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.append(path);

  // time labels at the ends
  const first = document.createElementNS(ns, 'text');
  first.setAttribute('x', pad.l); first.setAttribute('y', H - 5);
  first.setAttribute('fill', '#646d84'); first.setAttribute('font-size', '10');
  first.textContent = clock(points[0].t);
  const last = document.createElementNS(ns, 'text');
  last.setAttribute('x', W - pad.r); last.setAttribute('y', H - 5);
  last.setAttribute('text-anchor', 'end');
  last.setAttribute('fill', '#646d84'); last.setAttribute('font-size', '10');
  last.textContent = clock(points[points.length - 1].t);
  svg.append(first, last);

  return svg;
}

// ---------------- websocket ----------------
/** Tell the server which page we are on, for the traffic view. */
export function reportRoute() {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: 'route', path: location.hash || '#/' }));
  } catch { /* ignore */ }
}

export function on(type, handler) {
  if (!state.listeners.has(type)) state.listeners.set(type, new Set());
  state.listeners.get(type).add(handler);
  return () => state.listeners.get(type)?.delete(handler);
}

function emit(type, payload) {
  for (const fn of state.listeners.get(type) || []) {
    try {
      fn(payload);
    } catch (err) {
      console.error('[ws handler]', type, err);
    }
  }
}

let reconnectDelay = 1000;

export function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    state.wsOpen = true;
    reconnectDelay = 1000;
    emit('_status', true);
    reportRoute();
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'stats') state.stats = msg.stats;
    if (msg.type === 'presence') state.staffOnline = msg.staff;
    emit(msg.type, msg);
    emit('*', msg);
  };

  ws.onclose = () => {
    state.wsOpen = false;
    emit('_status', false);
    setTimeout(connectSocket, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.8, 20_000);
  };

  ws.onerror = () => ws.close();
}
