#!/usr/bin/env node
/* BimRadar visitor statistics from the nginx access log: no cookies, no
tracking code in the app, only totals are kept.

Every open app fetches /api/vehicles.json every 7 s while visible (bots and
scanners don't), so per day:
  devices   distinct devices that had the app open (hash of IP + browser,
            needs real client IPs: nginx real_ip behind Cloudflare)
  opens     page loads of the app (index.html), bots excluded
  peak      most apps open at the same time (best minute: polls / 8.6)
  hours     total time apps were open
The IPs themselves are never stored; the nginx log they come from is
rotated away after 14 days.

  node tools/stats.js            print the table (all days in the logs + stored)
  node tools/stats.js --write    also merge into the stats file (nightly timer)
Zero npm dependencies. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto');
const LOG_DIR = process.env.LOG_DIR || '/var/log/nginx';
const LOG_BASE = process.env.LOG_BASE || 'bimradar.access.log';
const OUT = process.env.STATS_FILE || '/var/apps/_stats/bimradar.json';
const POLL_S = 7;
// bots, scripts, uptime checks, security scanners and Claude's own test
// browsers; a request with no browser name at all ("-") is skipped too
const BOT = /bot|crawl|spider|scan|slurp|curl|wget|python|go-http|java\/|headless|node|axios|monitor|uptime|expanse|zgrab|httpclient|okhttp|facebookexternalhit|preview|research|claude\//i;
const LINE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) \S+ "[^"]*" "([^"]*)"/;
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' });

function parseTime(s) {            // 24/Oct/2026:14:45:48 +0000
  const m = /^(\d+)\/(\w+)\/(\d+):(\d+):(\d+):(\d+) ([+-]\d{2})(\d{2})/.exec(s);
  if (!m) return null;
  const off = (+m[7] * 60 + Math.sign(+m[7] || 1) * +m[8]) * 60000;
  return Date.UTC(+m[3], MON[m[2]], +m[1], +m[4], +m[5], +m[6]) - off;
}
function readLogs() {
  const files = fs.readdirSync(LOG_DIR).filter(f => f === LOG_BASE || f.startsWith(LOG_BASE + '.'));
  const lines = [];
  for (const f of files) {
    let buf = fs.readFileSync(path.join(LOG_DIR, f));
    if (f.endsWith('.gz')) buf = zlib.gunzipSync(buf);
    lines.push(...buf.toString('utf8').split('\n'));
  }
  return lines;
}
function count(lines) {
  const days = new Map();
  const D = d => days.get(d) || days.set(d, { devices: new Set(), opens: 0, polls: 0, perMin: new Map(), first: Infinity, last: 0 }).get(d);
  for (const ln of lines) {
    const m = LINE.exec(ln);
    if (!m) continue;
    const [, ip, ts, method, url, status, ua] = m;
    if (method !== 'GET' || !ua || ua === '-' || BOT.test(ua)) continue;
    const t = parseTime(ts);
    if (t == null) continue;
    const day = dayFmt.format(new Date(t)), d = D(day);
    d.first = Math.min(d.first, t); d.last = Math.max(d.last, t);
    const p = url.split('?')[0];
    if ((p === '/' || p === '/index.html') && status === '200' && !/deploycheck/.test(url)) d.opens++;
    if (p === '/api/vehicles.json' && (status === '200' || status === '304')) {
      d.polls++;
      d.devices.add(crypto.createHash('sha256').update(day + '|' + ip + '|' + ua).digest('base64').slice(0, 16));
      const min = Math.floor(t / 60000);
      d.perMin.set(min, (d.perMin.get(min) || 0) + 1);
    }
  }
  const out = {};
  for (const [day, d] of days) {
    const peakPolls = Math.max(0, ...d.perMin.values());
    out[day] = { devices: d.devices.size, opens: d.opens, peak: Math.round(peakPolls / (60 / POLL_S)),
      hours: +(d.polls * POLL_S / 3600).toFixed(1), complete: d.last - d.first > 23 * 3600000 };
  }
  return out;
}

const fresh = count(readLogs());
let stored = {};
try { stored = JSON.parse(fs.readFileSync(OUT, 'utf8')).days || {}; } catch (e) {}
// a day still in the logs is recounted; one already rotated away keeps its stored totals
const days = { ...stored };
for (const [k, v] of Object.entries(fresh)) if (!stored[k] || !stored[k].complete || v.complete) days[k] = v;
if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), days }, null, 1));
}
console.log('day          devices  opens  peak  hours');
for (const k of Object.keys(days).sort()) {
  const v = days[k];
  console.log(k + '  ' + String(v.devices).padStart(7) + '  ' + String(v.opens).padStart(5) + '  ' + String(v.peak).padStart(4) + '  ' +
    String(v.hours).padStart(5) + (v.complete ? '' : '   (partial day)'));
}
