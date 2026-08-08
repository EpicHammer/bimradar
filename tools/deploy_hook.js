#!/usr/bin/env node
/* BimRadar GitHub webhook receiver.

Listens on 127.0.0.1:9091 behind nginx (https://bimradar.at/deploy-hook).
GitHub POSTs here on every push; requests are authenticated by the
X-Hub-Signature-256 HMAC (shared secret in HOOK_SECRET, from the systemd
EnvironmentFile — never in the repo). A push to main triggers tools/deploy.js;
anything else is acknowledged and ignored. Deploys are serialized: if one is
running when the next push lands, a single re-run is queued.

Zero npm dependencies. */
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const path = require('node:path');

const PORT = 9091;
const SECRET = process.env.HOOK_SECRET;
const DEPLOY = path.join(__dirname, 'deploy.js');
if (!SECRET) { console.error('HOOK_SECRET is not set'); process.exit(1); }

const log = m => console.log(new Date().toISOString(), m);
let running = false, pending = false;

function runDeploy(reason) {
  if (running) { pending = true; log('deploy already running — queued (' + reason + ')'); return; }
  running = true;
  log('deploy started (' + reason + ')');
  execFile('node', [DEPLOY], { timeout: 180000 }, (err, stdout, stderr) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    log(err ? 'deploy FAILED: ' + err.message : 'deploy finished');
    running = false;
    if (pending) { pending = false; runDeploy('queued push'); }
  });
}

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/deploy-hook')) {
    res.writeHead(200); res.end('ok'); return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/deploy-hook')) {
    res.writeHead(404); res.end(); return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', c => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const sig = req.headers['x-hub-signature-256'] || '';
    const want = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) {
      log('rejected: bad signature from ' + (req.headers['x-forwarded-for'] || req.socket.remoteAddress));
      res.writeHead(401); res.end('bad signature'); return;
    }
    const event = req.headers['x-github-event'];
    let payload = {};
    try { payload = JSON.parse(body.toString()); } catch (e) {}
    if (event === 'ping') { log('ping from GitHub OK'); res.writeHead(200); res.end('pong'); return; }
    if (event === 'push' && payload.ref === 'refs/heads/main') {
      res.writeHead(202); res.end('deploying');
      runDeploy('push ' + String(payload.after || '').slice(0, 7) + ' by ' + (payload.pusher && payload.pusher.name));
      return;
    }
    log('ignored: ' + event + ' ' + (payload.ref || ''));
    res.writeHead(200); res.end('ignored');
  });
}).listen(PORT, '127.0.0.1', () => log('hook listening on 127.0.0.1:' + PORT));
