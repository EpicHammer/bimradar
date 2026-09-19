#!/usr/bin/env node
/* BimRadar push service: one-shot "your Bim leaves in N minutes" reminders.

Listens on 127.0.0.1:9092 behind nginx (location /push/). A client subscribes
with the browser's PushManager and POSTs {sub, watch:{lid, jid, line, dir,
stop, lead}}; this service then watches that stop's departure board and, when
the journey's REALTIME departure is <= lead minutes away, sends ONE push and
forgets the watch. Watches also expire on their own (departure passed / 6 h).

Pushes carry NO payload — that skips the whole aes128gcm encryption dance.
The message text is written to <api>/pushmsg/<sha256(endpoint)>.json and the
service worker fetches it when the empty push arrives. Auth is plain VAPID
(ES256 JWT, node:crypto). Keys are generated on first start.

Subscription endpoints are only accepted on known push-service hosts, so this
can never be used to make the server call arbitrary URLs.

Zero npm dependencies (Node >= 18). */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = 9092;
const STATE_DIR = process.env.BM_PUSH_DIR || '/var/apps/_push';
const API_DIR = process.env.BM_API_DIR || '/var/apps/eliashammer/bimradar/api';
const MSG_DIR = path.join(API_DIR, 'pushmsg');
const HAFAS_URL = 'https://verkehrsauskunft.verbundlinie.at/hamm/gate';
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)mozilla\.com$/,
                    /(^|\.)notify\.windows\.com$/, /(^|\.)push\.services\.mozilla\.com$/];
const MAX_WATCHES = 500, MAX_PER_SUB = 5, CHECK_S = 20;

const log = m => console.log(new Date().toISOString(), m);
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(MSG_DIR, { recursive: true });

// ---- VAPID ----
const keyFile = path.join(STATE_DIR, 'vapid.json');
if (!fs.existsSync(keyFile)) {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(keyFile, JSON.stringify(privateKey.export({ format: 'jwk' })), { mode: 0o600 });
  log('generated a new VAPID key pair');
}
const jwk = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
const privKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
const PUB = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
function vapidAuth(endpoint) {
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://bimradar.at' }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: privKey, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + PUB;
}
async function sendPush(endpoint) {
  const r = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { TTL: '600', Urgency: 'high', Authorization: vapidAuth(endpoint), 'Content-Length': '0' } });
  return r.status;
}

// ---- watches ----
const watchFile = path.join(STATE_DIR, 'watches.json');
let watches = [];
try { watches = JSON.parse(fs.readFileSync(watchFile, 'utf8')); } catch (e) {}
const save = () => { try { fs.writeFileSync(watchFile + '.tmp', JSON.stringify(watches)); fs.renameSync(watchFile + '.tmp', watchFile); } catch (e) {} };
const epHash = ep => crypto.createHash('sha256').update(ep).digest('hex');

async function gate(meth, req) {
  const resp = await fetch(HAFAS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ ver: '1.59', lang: 'deu', ext: 'VAO.22', auth: { type: 'AID', aid: 'wf7mcf9bv3nv8g5f' },
      client: { id: 'VAO', l: 'vs_stv', type: 'AND' }, svcReqL: [{ meth, req }] }) });
  const d = await resp.json(), L = d.svcResL || [];
  if (!L.length || (L[0].err != null && L[0].err !== 'OK')) throw new Error('HAFAS ' + (L.length ? L[0].err : 'empty'));
  return L[0].res || {};
}
async function board(lid) {
  const m = /L=(\d+)/.exec(lid);
  if (m) try {                                   // the feed poller's cached board, if fresh
    const d = JSON.parse(fs.readFileSync(path.join(API_DIR, 'board', m[1] + '.json'), 'utf8'));
    if (Date.now() - d.t < 60000) return d.res;
  } catch (e) {}
  return gate('StationBoard', { type: 'DEP', stbLoc: { lid }, maxJny: 40 });
}
// HAFAS times are Vienna local [dd]HHMMSS; this box runs UTC
function viennaSecNow() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Vienna', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date()).split(':').map(Number);
  return (p[0] % 24) * 3600 + p[1] * 60 + p[2];
}
function secsUntil(t) {
  const s = String(t), b = s.length === 8 ? s.slice(2) : s;
  let d = (+b.slice(0, 2)) * 3600 + (+b.slice(2, 4)) * 60 + (+b.slice(4, 6)) - viennaSecNow();
  if (d < -6 * 3600) d += 86400;
  return d;
}
const hhmm = t => { const s = String(t), b = s.length === 8 ? s.slice(2) : s; return b.slice(0, 2) + ':' + b.slice(2, 4); };

async function check() {
  if (!watches.length) return;
  const byLid = new Map();
  for (const w of watches) { if (!byLid.has(w.lid)) byLid.set(w.lid, []); byLid.get(w.lid).push(w); }
  const done = new Set();
  for (const [lid, list] of byLid) {
    let res = null;
    try { res = await board(lid); } catch (e) { continue; }
    for (const w of list) {
      const j = (res.jnyL || []).find(x => x.jid === w.jid);
      const st = j && j.stbStop;
      const t = st && (st.dTimeR || st.dTimeS);
      if (Date.now() - w.at > 6 * 3600e3) { done.add(w); continue; }
      if (!t) { if (Date.now() - w.at > 45 * 60e3 && !w.seen) done.add(w); continue; }
      w.seen = true;
      const left = secsUntil(t);
      if (left < -120) { done.add(w); continue; }
      if (left > w.lead * 60 + 15) continue;
      const mins = Math.max(0, Math.round(left / 60));
      const de = w.lang === 'de';
      const msg = {
        title: (de ? 'Linie ' : 'Line ') + w.line + (w.dir ? ' → ' + w.dir : ''),
        body: de ? (mins ? 'Fährt in ' + mins + ' min ab ' + w.stop + ' (' + hhmm(t) + ')' : 'Fährt jetzt ab ' + w.stop)
                 : (mins ? 'Leaves ' + w.stop + ' in ' + mins + ' min (' + hhmm(t) + ')' : 'Leaving ' + w.stop + ' now'),
        t: Date.now()
      };
      try {
        fs.writeFileSync(path.join(MSG_DIR, epHash(w.sub.endpoint) + '.json'), JSON.stringify(msg));
        const code = await sendPush(w.sub.endpoint);
        log('push ' + code + ' line ' + w.line + ' @ ' + w.stop);
      } catch (e) { log('push failed: ' + e.message); }
      done.add(w);
    }
  }
  if (done.size) { watches = watches.filter(w => !done.has(w)); save(); }
}
setInterval(() => check().catch(e => log('check failed: ' + e.message)), CHECK_S * 1000);

// ---- HTTP ----
const send = (res, code, body, type) => { res.writeHead(code, { 'Content-Type': type || 'text/plain', 'Cache-Control': 'no-store' }); res.end(body); };
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/push/key') return send(res, 200, PUB);
  if (req.method !== 'POST' || req.url !== '/push/watch') return send(res, 404, '');
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 8192) req.destroy(); else chunks.push(c); });
  req.on('end', () => {
    let b; try { b = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) { return send(res, 400, 'bad json'); }
    const sub = b && b.sub, w = b && b.watch;
    let host = ''; try { const u = new URL(sub.endpoint); if (u.protocol === 'https:') host = u.hostname; } catch (e) {}
    if (!host || !PUSH_HOSTS.some(re => re.test(host))) return send(res, 400, 'unsupported push service');
    if (!w || typeof w.lid !== 'string' || typeof w.jid !== 'string' || w.lid.length > 300 || w.jid.length > 200)
      return send(res, 400, 'bad watch');
    const mine = watches.filter(x => x.sub.endpoint === sub.endpoint);
    if (mine.some(x => x.jid === w.jid && x.lid === w.lid)) return send(res, 200, 'already watching');
    if (mine.length >= MAX_PER_SUB || watches.length >= MAX_WATCHES) return send(res, 429, 'too many reminders');
    watches.push({ sub: { endpoint: sub.endpoint }, lid: w.lid, jid: w.jid,
      line: String(w.line || '').slice(0, 12), dir: String(w.dir || '').slice(0, 60), stop: String(w.stop || '').slice(0, 60),
      lead: Math.max(1, Math.min(30, +w.lead || 3)), lang: b.lang === 'de' ? 'de' : 'en', at: Date.now() });
    save();
    log('watch + line ' + w.line + ' @ ' + w.stop + ' (' + watches.length + ' active)');
    send(res, 201, 'ok');
  });
}).listen(PORT, '127.0.0.1', () => log('push service on 127.0.0.1:' + PORT + ', ' + watches.length + ' watches restored'));
