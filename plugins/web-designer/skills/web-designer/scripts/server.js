#!/usr/bin/env node
/*
 * web-designer server — static file host + live design channel.
 *
 * Responsibilities:
 *   1. Serve the design root (default: designs/) over http on 127.0.0.1 only.
 *   2. Inject the client overlay <script> into *browser navigations* that return
 *      HTML — never into fetch/XHR/curl responses (see wantsInjection()).
 *   3. Speak WebSocket (hand-rolled, zero deps) with every open page: page
 *      lifecycle, element selection, text edits, screenshots, refresh.
 *   4. Expose a localhost control API under /__designer/api/* that the
 *      `web-designer` CLI drives (status, flush, wait, refresh, exec, shot).
 *
 * Events from pages land in a consuming queue: `wait` pops the next one in
 * real time, `flush` drains everything recorded so far.
 *
 * Zero dependencies. Started detached by the CLI; do not run it by hand.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PROJECT = process.env.WEB_DESIGNER_PROJECT || process.cwd();
const CONFIG_PATH = path.join(PROJECT, '.web-design.json');
const CLIENT_JS = path.join(__dirname, 'client.js');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 96 * 1024 * 1024; // screenshots arrive as one text frame
const MAX_QUEUE = 500;
const MAX_HISTORY = 500;

/* ----------------------------------------------------------------- config */

const readConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
};

const writeConfig = (patch) => {
  const next = { ...readConfig(), ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
  return next;
};

const config = readConfig();
const ROOT = path.resolve(PROJECT, config.root || 'designs');
const WANT_PORT = Number(process.env.WEB_DESIGNER_PORT || config.port || 0);

fs.mkdirSync(ROOT, { recursive: true });

/* ------------------------------------------------------------ event queue */

let seq = 0;
const queue = [];
const history = [];
const waiters = new Set();

const matches = (event, types) => !types || types.length === 0 || types.includes(event.type);

function settle(waiter, value) {
  waiters.delete(waiter);
  clearTimeout(waiter.timer);
  waiter.resolve(value);
  if (waiter.kind === 'poll') queueMicrotask(() => announceStatus());
}

const drain = () => queue.splice(0, queue.length);

function emit(type, data = {}) {
  const event = { seq: ++seq, at: new Date().toISOString(), type, ...data };
  queue.push(event);
  while (queue.length > MAX_QUEUE) queue.shift();

  // Non-consuming record, so an event stays recoverable via /history even if
  // whoever was polling for it died before it reached them.
  history.push(event);
  while (history.length > MAX_HISTORY) history.shift();

  // Collect first, drain once, then hand the SAME batch to every live poller:
  // draining per waiter would give the first one everything and the rest an
  // empty array, which reads exactly like a timeout.
  const polls = [];
  for (const waiter of [...waiters]) {
    if (waiter.kind === 'poll') {
      if (matches(event, waiter.triggers)) polls.push(waiter);
      continue;
    }
    const idx = queue.findIndex((e) => matches(e, waiter.types));
    if (idx === -1) continue;
    settle(waiter, queue.splice(idx, 1)[0]);
  }
  if (polls.length) {
    const batch = drain();
    for (const waiter of polls) settle(waiter, { events: batch, timeout: false });
  }
  return event;
}

function waitForEvent({ types, timeoutMs, peek, abortOn }) {
  const idx = queue.findIndex((e) => matches(e, types));
  if (idx !== -1) return Promise.resolve(peek ? queue[idx] : queue.splice(idx, 1)[0]);

  return new Promise((resolve) => {
    const waiter = { kind: 'wait', types, resolve };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      resolve(null);
    }, timeoutMs);
    waiters.add(waiter);
    // A client that hangs up must not leave a waiter behind to swallow events.
    if (abortOn) abortOn(() => settle(waiter, null));
  });
}

/*
 * poll = flush + wait in one call. Returns as soon as a trigger event (an edit
 * the user asked for) is queued or arrives, handing back the whole queue so the
 * assistant sees the surrounding context too.
 */
function pollForEvents({ triggers, timeoutMs, abortOn, owner, share }) {
  // One listener at a time: a newer poll takes ownership and the previous one is
  // told why it stopped, rather than two chats racing for the same request.
  if (!share) {
    for (const waiter of [...waiters]) {
      if (waiter.kind !== 'poll' || waiter.share) continue;
      settle(waiter, { events: [], evicted: { by: owner || 'another session', at: new Date().toISOString() } });
    }
  }

  if (queue.some((e) => matches(e, triggers))) return Promise.resolve({ events: drain(), timeout: false });

  return new Promise((resolve) => {
    const waiter = { kind: 'poll', triggers, share: !!share, owner, since: Date.now(), resolve };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      resolve({ events: drain(), timeout: true });
    }, timeoutMs);
    waiters.add(waiter);
    // A fresh poll means the agent is listening again, not still working.
    agent = { working: false, note: null, since: null };
    announceStatus();
    // Hung-up client: drop the waiter so it cannot consume a later request.
    if (abortOn) abortOn(() => settle(waiter, { events: [], aborted: true }));
  });
}

const pollOwners = () =>
  [...waiters]
    .filter((w) => w.kind === 'poll')
    .map((w) => ({ owner: w.owner || null, share: !!w.share, since: new Date(w.since).toISOString() }));

/* ------------------------------------------------------------- websockets */

/*
 * What the toolbar's status light reflects:
 *   red     no websocket            (client-side)
 *   yellow  server up, nobody polling
 *   green   an agent is polling and will see what you do
 *   spinner an agent is working on your last request
 * It lives here, not in the page, so it survives a refresh.
 */
let agent = { working: false, note: null, since: null };

const isListening = () => [...waiters].some((w) => w.kind === 'poll');

const statusMessage = () => ({
  type: 'status',
  listening: isListening(),
  working: agent.working,
  note: agent.note,
  since: agent.since,
});

let lastStatus = '';
function announceStatus(force) {
  const message = statusMessage();
  const fingerprint = JSON.stringify(message);
  if (!force && fingerprint === lastStatus) return;
  lastStatus = fingerprint;
  broadcast(message);
}

let clientSeq = 0;
const clients = new Map(); // id -> { id, socket, url, title, viewport, since, closed }
const pending = new Map(); // request id -> { resolve, timer }

function wsSend(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  socket.write(frame(0x1, payload));
}

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function acceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  socket.setTimeout(0);

  const client = {
    id: `c${++clientSeq}`,
    socket,
    url: null,
    title: null,
    viewport: null,
    since: new Date().toISOString(),
    closed: false,
  };
  clients.set(client.id, client);

  let buf = Buffer.alloc(0);
  let fragments = [];
  let fragOpcode = 0;
  let awaitingPong = false;

  const heartbeat = setInterval(() => {
    if (awaitingPong) return close('ping-timeout');
    awaitingPong = true;
    try {
      socket.write(frame(0x9, Buffer.alloc(0)));
    } catch {
      close('write-failed');
    }
  }, 25000);

  function close(reason) {
    if (client.closed) return;
    client.closed = true;
    clearInterval(heartbeat);
    clients.delete(client.id);
    try {
      socket.destroy();
    } catch {}
    // Nothing will ever answer this page's in-flight requests — fail them now.
    for (const [id, entry] of pending) {
      if (entry.clientId !== client.id) continue;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: `page disconnected (${reason})` });
    }
    if (reason !== 'unload') {
      emit('page.unload', { clientId: client.id, url: client.url, reason });
    }
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;

      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        const big = buf.readBigUInt64BE(off);
        if (big > BigInt(MAX_FRAME)) return close('frame-too-large');
        len = Number(big);
        off += 8;
      }
      if (len > MAX_FRAME) return close('frame-too-large');

      let mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;

      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(off + len);

      if (opcode === 0x8) return close('closed');
      if (opcode === 0x9) {
        socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) {
        awaitingPong = false;
        continue;
      }
      if (opcode === 0x0) {
        fragments.push(payload);
        if (!fin) continue;
        const full = Buffer.concat(fragments);
        fragments = [];
        if (fragOpcode === 0x1) onText(full.toString('utf8'));
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          fragOpcode = opcode;
          fragments = [payload];
          continue;
        }
        if (opcode === 0x1) onText(payload.toString('utf8'));
        continue;
      }
      return close('bad-opcode');
    }
  });

  socket.on('error', () => close('socket-error'));
  socket.on('close', () => close('socket-closed'));

  function onText(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello':
        client.url = msg.url;
        client.title = msg.title;
        client.viewport = msg.viewport;
        emit('page.open', {
          clientId: client.id,
          url: msg.url,
          title: msg.title,
          viewport: msg.viewport,
        });
        // A refreshed page must not forget that an agent is mid-task.
        wsSend(client.socket, statusMessage());
        break;
      case 'navigate':
        client.url = msg.url;
        client.title = msg.title;
        emit('page.navigate', { clientId: client.id, url: msg.url, title: msg.title });
        break;
      case 'unload':
        emit('page.unload', { clientId: client.id, url: client.url, reason: 'unload' });
        close('unload');
        break;
      case 'element.selected':
        emit('element.selected', { clientId: client.id, url: client.url, ...msg.payload });
        break;
      case 'text.edited':
        emit('text.edited', { clientId: client.id, url: client.url, ...msg.payload });
        break;
      case 'element.request':
        emit('element.request', { clientId: client.id, url: client.url, ...msg.payload });
        break;
      case 'text.cancelled':
        emit('text.cancelled', { clientId: client.id, url: client.url, ...msg.payload });
        break;
      case 'mode':
        emit('mode.changed', { clientId: client.id, mode: msg.mode });
        break;
      case 'error':
        emit('page.error', { clientId: client.id, url: client.url, message: msg.message });
        break;
      case 'result': {
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
        break;
      }
    }
  }
}

function pickClient(id) {
  if (id) return clients.get(id) || null;
  // Newest connected page wins: that is the one the user is looking at.
  let chosen = null;
  for (const client of clients.values()) chosen = client;
  return chosen;
}

function request(client, message, timeoutMs = 30000) {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    pending.set(id, { resolve, timer, clientId: client.id });
    wsSend(client.socket, { ...message, id });
  });
}

function broadcast(message) {
  let n = 0;
  for (const client of clients.values()) {
    wsSend(client.socket, message);
    n++;
  }
  return n;
}

/* ------------------------------------------------------------ http static */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/*
 * Inject only into real browser navigations. Fetch/XHR carry
 * Sec-Fetch-Dest: empty; curl carries neither Sec-Fetch-* nor a browser UA.
 * ?__designer=off opts a request out entirely (used while screenshotting).
 */
function wantsInjection(req, query) {
  if (query.get('__designer') === 'off') return false;
  if (req.headers['x-requested-with']) return false;

  const dest = req.headers['sec-fetch-dest'];
  if (dest) return dest === 'document' || dest === 'iframe' || dest === 'frame';

  const mode = req.headers['sec-fetch-mode'];
  if (mode) return mode === 'navigate';

  const accept = req.headers.accept || '';
  const ua = req.headers['user-agent'] || '';
  return accept.includes('text/html') && /Mozilla\//.test(ua);
}

const INJECT_TAG =
  '\n<script src="/__designer/client.js" data-web-designer="1" defer></script>\n';

function inject(html) {
  const lower = html.toLowerCase();
  const at = lower.lastIndexOf('</body>');
  if (at !== -1) return html.slice(0, at) + INJECT_TAG + html.slice(at);
  const head = lower.lastIndexOf('</head>');
  if (head !== -1) return html.slice(0, head) + INJECT_TAG + html.slice(head);
  return html + INJECT_TAG;
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

const json = (res, status, obj) =>
  send(res, status, JSON.stringify(obj, null, 2) + '\n', { 'Content-Type': 'application/json; charset=utf-8' });

function listing(dirPath, urlPath, entries) {
  const rows = entries
    .map((e) => {
      const href = path.posix.join(urlPath, encodeURIComponent(e.name)) + (e.isDirectory() ? '/' : '');
      return `<li><a href="${href}">${escapeHtml(e.name)}${e.isDirectory() ? '/' : ''}</a></li>`;
    })
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(urlPath)}</title>
<style>body{font:14px/1.6 ui-sans-serif,system-ui,sans-serif;margin:3rem auto;max-width:44rem;padding:0 1.5rem;color:#111}
h1{font-size:1rem;font-weight:600;color:#666;font-family:ui-monospace,monospace}
ul{list-style:none;padding:0}li{padding:.15rem 0}a{color:#0b63ce;text-decoration:none}a:hover{text-decoration:underline}
@media(prefers-color-scheme:dark){body{background:#0b0b0c;color:#e8e8ea}a{color:#7cb7ff}}</style>
</head><body><h1>${escapeHtml(urlPath)}</h1><ul>
${urlPath === '/' ? '' : '<li><a href="../">../</a></li>'}
${rows || '<li><em>empty — put your design files in ' + escapeHtml(path.relative(PROJECT, dirPath) || '.') + '/</em></li>'}
</ul></body></html>`;
}

async function serveStatic(req, res, pathname, query) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'bad request');
  }

  const target = path.resolve(ROOT, '.' + decoded);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return send(res, 403, 'forbidden');

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return send(res, 404, 'not found: ' + escapeHtml(decoded), { 'Content-Type': 'text/html; charset=utf-8' });
  }

  if (stat.isDirectory()) {
    if (!decoded.endsWith('/')) return send(res, 302, '', { Location: decoded + '/' });
    const index = path.join(target, 'index.html');
    if (fs.existsSync(index)) return serveFile(req, res, index, query);
    const entries = fs.readdirSync(target, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
    let html = listing(target, decoded, entries);
    if (wantsInjection(req, query)) html = inject(html);
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
  }

  return serveFile(req, res, target, query);
}

function serveFile(req, res, file, query) {
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';

  if ((ext === '.html' || ext === '.htm') && wantsInjection(req, query)) {
    const html = inject(fs.readFileSync(file, 'utf8'));
    return send(res, 200, html, { 'Content-Type': type });
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': fs.statSync(file).size });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

/* -------------------------------------------------------------- control api */

const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });

const clientInfo = (c) => ({ id: c.id, url: c.url, title: c.title, viewport: c.viewport, since: c.since });

async function serveApi(req, res, pathname, query) {
  const body = req.method === 'POST' ? await readBody(req) : {};
  const route = pathname.slice('/__designer/api/'.length);

  switch (route) {
    case 'status':
      return json(res, 200, {
        ok: true,
        pid: process.pid,
        port: server.address().port,
        project: PROJECT,
        root: ROOT,
        rootRelative: path.relative(PROJECT, ROOT) || '.',
        clients: [...clients.values()].map(clientInfo),
        queued: queue.length,
        waiters: waiters.size,
        historyCount: history.length,
        pollers: pollOwners(),
        listening: isListening(),
        agent,
        startedAt: STARTED_AT,
      });

    case 'flush': {
      return json(res, 200, { ok: true, events: drain() });
    }

    case 'history': {
      const limit = Math.min(Number(query.get('limit') || 50), MAX_HISTORY);
      return json(res, 200, { ok: true, events: history.slice(-limit), total: history.length });
    }

    case 'wait': {
      const types = (query.get('types') || '').split(',').map((s) => s.trim()).filter(Boolean);
      const timeoutMs = Math.min(Number(query.get('timeout') || 300000), 3600000);
      const peek = query.get('peek') === '1';
      const event = await waitForEvent({ types, timeoutMs, peek, abortOn: (fn) => res.on('close', fn) });
      if (res.writableEnded || res.destroyed) return;
      return json(res, 200, event ? { ok: true, event } : { ok: false, timeout: true });
    }

    case 'poll': {
      const raw = query.get('triggers');
      const triggers = (raw === null ? 'text.edited,element.request' : raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const timeoutMs = Math.min(Number(query.get('timeout') || 1800000), 3600000);
      const result = await pollForEvents({
        triggers,
        timeoutMs,
        abortOn: (fn) => res.on('close', fn),
        owner: query.get('owner') || null,
        share: query.get('share') === '1',
      });
      // Client hung up mid-wait: its waiter is gone, there is nobody to answer.
      if (res.writableEnded || res.destroyed) return;

      // Handing work to an agent *is* the agent starting work — flip the light
      // here rather than trusting every caller to remember to say so.
      if (result.events.length && !result.timeout && !result.stopped && !result.evicted) {
        const request = [...result.events].reverse().find((e) => e.type === 'element.request' || e.type === 'text.edited');
        agent = {
          working: true,
          note: request ? request.request || `text edit on ${request.selector}` : null,
          since: new Date().toISOString(),
        };
        announceStatus(true);
      }
      return json(res, 200, { ok: true, ...result });
    }

    case 'working': {
      agent = { working: true, note: body.note || null, since: new Date().toISOString() };
      announceStatus(true);
      return json(res, 200, { ok: true, ...agent });
    }

    case 'done': {
      agent = { working: false, note: null, since: null };
      announceStatus(true);
      return json(res, 200, { ok: true, working: false, listening: isListening() });
    }

    case 'refresh': {
      const n = broadcast({ type: 'refresh' });
      return json(res, 200, { ok: n > 0, refreshed: n });
    }

    case 'mode': {
      const n = broadcast({ type: 'mode', mode: body.mode || 'off' });
      return json(res, 200, { ok: n > 0, clients: n, mode: body.mode || 'off' });
    }

    case 'highlight': {
      const client = pickClient(body.clientId);
      if (!client) return json(res, 409, { ok: false, error: 'no page connected' });
      const out = await request(client, {
        type: 'highlight',
        selector: body.selector,
        duration: body.duration || 2500,
      });
      return json(res, out.ok ? 200 : 400, out);
    }

    case 'exec': {
      const client = pickClient(body.clientId);
      if (!client) return json(res, 409, { ok: false, error: 'no page connected' });
      const out = await request(client, { type: 'exec', code: body.code }, body.timeout || 30000);
      return json(res, out.ok ? 200 : 400, out);
    }

    case 'screenshot': {
      const client = pickClient(body.clientId);
      if (!client) return json(res, 409, { ok: false, error: 'no page connected' });
      const out = await request(
        client,
        {
          type: 'screenshot',
          selector: body.selector || null,
          full: !!body.full,
          scale: body.scale || 1,
          padding: body.padding || 0,
          allowSvgFallback: !!body.allowSvgFallback,
        },
        body.timeout || 60000,
      );
      return json(res, out.ok ? 200 : 400, out);
    }

    case 'shutdown': {
      json(res, 200, { ok: true, stopping: true });
      broadcast({ type: 'server-stopping' });

      // Answer everyone who is blocked on us before dying, so a waiting poll
      // learns the server stopped instead of just losing its socket. Anything
      // still queued goes out with that last answer rather than to /dev/null.
      const leftovers = drain();
      for (const waiter of [...waiters]) {
        if (waiter.kind === 'poll') settle(waiter, { events: leftovers, stopped: true });
        else settle(waiter, null);
      }

      writeConfig({ pid: null, stoppedAt: new Date().toISOString() });
      setTimeout(() => process.exit(0), 200); // let those responses flush
      return;
    }

    default:
      return json(res, 404, { ok: false, error: `unknown api route: ${route}` });
  }
}

/* ----------------------------------------------------------------- server */

const STARTED_AT = new Date().toISOString();

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  const pathname = parsed.pathname;
  const query = parsed.searchParams;

  try {
    if (pathname === '/__designer/client.js') {
      const body = fs.readFileSync(CLIENT_JS);
      return send(res, 200, body, { 'Content-Type': 'text/javascript; charset=utf-8' });
    }
    if (pathname.startsWith('/__designer/api/')) {
      const host = (req.headers.host || '').split(':')[0];
      if (host && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
        return json(res, 403, { ok: false, error: 'control api is localhost-only' });
      }
      return await serveApi(req, res, pathname, query);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');

    return await serveStatic(req, res, pathname, query);
  } catch (err) {
    return send(res, 500, `web-designer: ${err.message}`);
  }
});

server.on('upgrade', (req, socket) => {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  if (parsed.pathname !== '/__designer/ws') return socket.destroy();
  handleUpgrade(req, socket);
});

// Long-poll `wait` must not be cut short by Node's request timeouts.
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.timeout = 0;
server.keepAliveTimeout = 72000;

server.listen(WANT_PORT, '127.0.0.1', () => {
  const port = server.address().port;
  writeConfig({
    root: path.relative(PROJECT, ROOT) || '.',
    port,
    pid: process.pid,
    url: `http://127.0.0.1:${port}/`,
    startedAt: STARTED_AT,
    stoppedAt: null,
  });
  process.stdout.write(`web-designer ready http://127.0.0.1:${port}/ root=${ROOT} pid=${process.pid}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && WANT_PORT) {
    // Remembered port was taken by something else — fall back to an ephemeral one.
    process.stderr.write(`web-designer: port ${WANT_PORT} in use, taking an ephemeral port\n`);
    server.listen(0, '127.0.0.1');
    return;
  }
  process.stderr.write(`web-designer: ${err.stack || err.message}\n`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    writeConfig({ pid: null, stoppedAt: new Date().toISOString() });
    process.exit(0);
  });
}

process.on('uncaughtException', (err) => {
  process.stderr.write(`web-designer: uncaught ${err.stack || err.message}\n`);
});
