#!/usr/bin/env node
/* BimRadar feed poller (Node port of the original Python daemon).

Polls the Verbund Linie HAFAS gateway for live vehicle positions across the
Graz area every POLL_S seconds and writes them atomically to a static JSON
file that nginx serves as /api/vehicles.json. Every app user then reads the
one cached copy from bimradar.at (same origin, ~50 ms) instead of each phone
querying HAFAS directly (~1 s) — and HAFAS sees a single poller, not one per
user. The client falls back to direct HAFAS if this file is stale or missing,
so this service failing only makes the app slower, never broken.

Route-path enrichment: HAFAS positions sit ON the route polyline (measured
median 0.4 m), but a client that glides straight between two reports cuts
corners — buses appear inside building blocks. So this poller additionally
fetches each journey's polyline once (JourneyDetails, cached per jid,
throttled), and ships each vehicle's street path between its previous and
current report as "pth": [[y,x],...] microdegree intermediate vertices.
The client walks that path instead of the chord. No polyline yet (cache
warming) simply means no "pth" — the client falls back to the straight glide.

Payload: {"t": <epoch ms written>, "rect": {...}, "res": <raw HAFAS res>}
"res" is exactly what HAFAS JourneyGeoPos returns (plus "pth" per journey),
so the client ingests it with the same code path it uses for direct queries.

Zero npm dependencies — global fetch + node:fs only (Node >= 18). */
'use strict';
const fs = require('node:fs');

const HAFAS_URL = 'https://verkehrsauskunft.verbundlinie.at/hamm/gate';
const OUT = '/var/apps/eliashammer/bimradar/api/vehicles.json';
const POLL_S = 5;
const DETAILS_PER_CYCLE = 14;   // polyline fetches per cycle: warms ~170 jids/min
const POLY_RETRY_S = 300;       // a jid whose polyline fetch failed: retry after this
const EVICT_S = 180;            // forget journeys not seen for this long
// Graz + surroundings; must match PROXY_RECT in index.html
const RECT = { minLon: 15.30, maxLon: 15.60, minLat: 46.98, maxLat: 47.15 };

async function gate(meth, req) {
  const body = {
    ver: '1.59', lang: 'deu', ext: 'VAO.22',
    auth: { type: 'AID', aid: 'wf7mcf9bv3nv8g5f' },
    client: { id: 'VAO', l: 'vs_stv', type: 'AND' },
    svcReqL: [{ meth, req }]
  };
  const resp = await fetch(HAFAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const d = await resp.json();
  const L = d.svcResL || [];
  const err = L.length ? L[0].err : undefined;
  if (!L.length || (err != null && err !== 'OK')) {
    throw new Error('HAFAS err: ' + (L.length ? err : 'empty'));
  }
  return L[0].res || {};
}

/** Google encoded polyline -> [[lat, lng], ...] */
function decodePoly(s) {
  const pts = []; let i = 0, lat = 0, lng = 0;
  while (i < s.length) {
    for (let k = 0; k < 2; k++) {
      let sh = 0, res = 0, b;
      do {
        b = s.charCodeAt(i) - 63; i++;
        res |= (b & 0x1f) << sh; sh += 5;
      } while (b >= 0x20);
      const d = (res & 1) ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

/** Index + interpolation t of the polyline point nearest to pos, and its distance (m). */
function project(pos, pts) {
  const ky = 111320.0;
  const kx = 111320.0 * Math.cos(pos[0] * Math.PI / 180);
  let best = [0, 0.0, Infinity];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const px = (pos[1] - a[1]) * kx, py = (pos[0] - a[0]) * ky;
    const bx = (b[1] - a[1]) * kx, by = (b[0] - a[0]) * ky;
    const L2 = bx * bx + by * by;
    const t = L2 === 0 ? 0.0 : Math.max(0.0, Math.min(1.0, (px * bx + py * by) / L2));
    const d = Math.hypot(px - t * bx, py - t * by);
    if (d < best[2]) best = [i, t, d];
  }
  return best;
}

/** Cumulative metres along a polyline — lets us compare route progress. */
function cumDist(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const ky = 111320.0, kx = 111320.0 * Math.cos(pts[i - 1][0] * Math.PI / 180);
    cum.push(cum[i - 1] + Math.hypot((pts[i][1] - pts[i - 1][1]) * kx, (pts[i][0] - pts[i - 1][0]) * ky));
  }
  return cum;
}

/** Intermediate polyline vertices between two positions, [] if none/implausible. */
function pathBetween(prev, cur, pts) {
  const [i1, t1, d1] = project(prev, pts);
  const [i2, t2, d2] = project(cur, pts);
  if (d1 > 100 || d2 > 100) return [];                    // reports don't lie on this polyline
  if (i1 > i2 || (i1 === i2 && t1 > t2)) return [];       // backwards (or loop ambiguity) — skip
  const mids = pts.slice(i1 + 1, i2 + 1);                 // vertices strictly between the projections
  return mids.map(p => [Math.round(p[0] * 1e6), Math.round(p[1] * 1e6)]).slice(0, 24);
}

class PolyCache {
  constructor() {
    this.polys = new Map();     // jid -> [[lat,lng],...] | null (fetch failed)
    this.cums = new Map();      // jid -> cumulative metres along that polyline
    this.failedAt = new Map();  // jid -> epoch s of failed fetch
    this.seen = new Map();      // jid -> epoch s last seen in feed
  }
  want(jid) {
    if (this.polys.has(jid) && this.polys.get(jid) !== null) return false;
    return Date.now() / 1000 - (this.failedAt.get(jid) || 0) > POLY_RETRY_S;
  }
  async fetch(jid) {
    try {
      const det = await gate('JourneyDetails', { jid, getPolyline: true });
      const polyL = (det.common || {}).polyL || [];
      const enc = polyL.length ? polyL[0].crdEncYX : null;
      this.polys.set(jid, enc ? decodePoly(enc) : null);
      if (!enc) this.failedAt.set(jid, Date.now() / 1000);
    } catch (e) {
      if (!this.polys.has(jid)) this.polys.set(jid, null);
      this.failedAt.set(jid, Date.now() / 1000);
    }
  }
  evict() {
    const cut = Date.now() / 1000 - EVICT_S;
    for (const [jid, ts] of [...this.seen]) {
      if (ts < cut) {
        this.seen.delete(jid);
        this.polys.delete(jid);
        this.cums.delete(jid);
        this.failedAt.delete(jid);
      }
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const cache = new PolyCache();
  const prevPos = new Map();    // jid -> [lat, lng] of the previous cycle's report
  const prevProg = new Map();   // jid -> metres of route progress last published
  for (;;) {
    const t0 = Date.now();
    try {
      const res = await gate('JourneyGeoPos', {
        maxJny: 1000, onlyRT: false,
        rect: {
          llCrd: { x: Math.round(RECT.minLon * 1e6), y: Math.round(RECT.minLat * 1e6) },
          urCrd: { x: Math.round(RECT.maxLon * 1e6), y: Math.round(RECT.maxLat * 1e6) }
        }
      });
      const jny = (res.jnyL || []).filter(j => j.pos && j.jid);
      const now = Date.now() / 1000;
      for (const j of jny) cache.seen.set(j.jid, now);

      // warm the polyline cache, a few journeys per cycle
      let budget = DETAILS_PER_CYCLE;
      for (const j of jny) {
        if (budget <= 0) break;
        if (cache.want(j.jid)) {
          await cache.fetch(j.jid);
          budget--;
        }
      }

      // enrich: snap reports onto the route, then ship the street path
      for (const j of jny) {
        const jid = j.jid;
        let cur = [j.pos.y / 1e6, j.pos.x / 1e6];
        const pts = cache.polys.get(jid);
        // HAFAS occasionally reports layover/stand coordinates off the
        // street (buses "inside buildings"). The route polyline is truth:
        // project the report onto it and publish the snapped point.
        if (pts && pts.length >= 2) {
          const [i, t, dist] = project(cur, pts);
          if (dist <= 80) {
            const cum = cache.cums.get(jid) || (cache.cums.set(jid, cumDist(pts)), cache.cums.get(jid));
            let prog = cum[i] + t * (cum[i + 1] - cum[i]);
            const last = prevProg.get(jid);
            // HAFAS re-interpolates on delay updates and can step BACKWARDS.
            // Real trams don't reverse mid-route: hold position on small
            // regressions (jitter); accept big ones (>150 m — reroute/new leg).
            if (last != null && prog < last - 8 && last - prog < 150 && prevPos.has(jid)) {
              cur = prevPos.get(jid);
              prog = last;
            } else {
              const a = pts[i], b = pts[i + 1];
              cur = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            }
            j.pos.y = Math.round(cur[0] * 1e6);
            j.pos.x = Math.round(cur[1] * 1e6);
            prevProg.set(jid, prog);
          }
        }
        const prev = prevPos.get(jid);
        if (pts && prev && (prev[0] !== cur[0] || prev[1] !== cur[1])) {
          const mids = pathBetween(prev, cur, pts);
          if (mids.length) j.pth = mids;
        }
        prevPos.set(jid, cur);
      }
      for (const jid of [...prevPos.keys()]) {
        if (!cache.seen.has(jid)) { prevPos.delete(jid); prevProg.delete(jid); }
      }
      cache.evict();

      const payload = { t: Date.now(), rect: RECT, res };
      const tmp = OUT + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, OUT);   // atomic: readers never see a half-written file
    } catch (e) {
      // keep the last good file; the client detects staleness via "t"
      console.error('poll failed:', e && e.stack ? e.stack : e);
    }
    await sleep(Math.max(500, POLL_S * 1000 - (Date.now() - t0)));
  }
}

main();
