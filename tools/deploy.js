#!/usr/bin/env node
/* BimRadar deploy: repo -> live web root. Run by the webhook receiver
(deploy_hook.js) whenever main moves on GitHub; safe to run by hand too.

Steps: git pull --ff-only, back up the live app files, copy the app over,
stamp the service-worker cache name with the commit sha (so every deploy is
automatically a new PWA version — nobody has to remember a manual bump),
restart the feed poller only if its source changed, then health-check the
live site and roll back index.html/sw.js if it fails.

Zero npm dependencies. After editing deploy_hook.js itself, restart the hook
service manually: sudo systemctl restart bimradar-hook */
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = '/var/apps/_repo/bimradar';
const LIVE = '/var/apps/eliashammer/bimradar';
const BACKUPS = '/var/apps/_deploy-backups/bimradar';
const LOCK = '/tmp/bimradar-deploy.lock';
const APP_FILES = [
  'index.html', 'sw.js', 'manifest.json', 'lines.json',
  'maplibre-gl.js', 'maplibre-gl.css', 'three.module.js',
  'icon-32.png', 'icon-180.png', 'icon-192.png', 'icon-512.png',
  'icon-192-maskable.png', 'icon-512-maskable.png',
  'splash-1290x2796.png', 'splash-1179x2556.png', 'splash-1170x2532.png',
  'splash-1284x2778.png', 'splash-1125x2436.png', 'splash-1242x2688.png',
  'splash-828x1792.png', 'splash-750x1334.png'
];

const log = m => console.log(new Date().toISOString(), m);
const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();

async function main() {
  // one deploy at a time; a stale lock (crashed run) expires after 2 min
  if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 120000) {
    log('another deploy is running — aborting'); process.exit(3);
  }
  fs.writeFileSync(LOCK, String(process.pid));
  try {
    log('pulling…');
    log(git('pull', '--ff-only', 'origin', 'main'));
    const sha = git('rev-parse', '--short', 'HEAD');
    log('deploying ' + sha);

    // backup current live app files (outside the web root — not publicly served)
    const bdir = path.join(BACKUPS, new Date().toISOString().replace(/[:.]/g, '-') + '-' + sha);
    fs.mkdirSync(bdir, { recursive: true });
    for (const f of APP_FILES) {
      const src = path.join(LIVE, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(bdir, f));
    }

    // copy the app over, then stamp the SW cache name with the commit sha
    for (const f of APP_FILES) fs.copyFileSync(path.join(REPO, f), path.join(LIVE, f));
    const swPath = path.join(LIVE, 'sw.js');
    const sw = fs.readFileSync(swPath, 'utf8')
      .replace(/const CACHE = '[^']+'/, "const CACHE = 'bimradar-" + sha + "'");
    fs.writeFileSync(swPath, sw);
    log('app files copied, SW cache = bimradar-' + sha);

    // the poller runs straight from the repo checkout: restart it iff its
    // content differs from what was running at the LAST deploy. (Comparing
    // before/after the pull misses pushes made from this box, where the file
    // is already new before the pull.)
    const pollerHash = require('node:crypto').createHash('sha256')
      .update(fs.readFileSync(path.join(REPO, 'tools/feed_poller.js'))).digest('hex');
    const hashFile = path.join(BACKUPS, '.poller-sha256');
    const lastHash = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf8') : null;
    if (lastHash && lastHash !== pollerHash) {
      log('feed_poller.js changed since last deploy — restarting bimradar-feed');
      execFileSync('sudo', ['-n', 'systemctl', 'restart', 'bimradar-feed']);
    }
    fs.writeFileSync(hashFile, pollerHash);

    // health check the real site; roll back the two critical files on failure
    const resp = await fetch('https://bimradar.at/?deploycheck=' + sha, { signal: AbortSignal.timeout(10000) });
    const body = await resp.text();
    if (resp.status !== 200 || !body.includes('BimRadar')) {
      log('HEALTH CHECK FAILED (' + resp.status + ') — rolling back index.html + sw.js');
      for (const f of ['index.html', 'sw.js']) {
        fs.copyFileSync(path.join(bdir, f), path.join(LIVE, f));
      }
      process.exit(2);
    }
    log('deploy ' + sha + ' OK');

    // keep the newest 20 backups
    const old = fs.readdirSync(BACKUPS).sort().slice(0, -20);
    for (const d of old) fs.rmSync(path.join(BACKUPS, d), { recursive: true, force: true });
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

main().catch(e => { log('deploy failed: ' + (e.stack || e)); fs.rmSync(LOCK, { force: true }); process.exit(1); });
