#!/usr/bin/env python3
"""BimRadar feed poller.

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
"""
import json, math, os, time, urllib.request

HAFAS_URL = 'https://verkehrsauskunft.verbundlinie.at/hamm/gate'
OUT = '/var/apps/eliashammer/bimradar/api/vehicles.json'
POLL_S = 5
DETAILS_PER_CYCLE = 14      # polyline fetches per cycle: warms ~170 jids/min
POLY_RETRY_S = 300          # a jid whose polyline fetch failed: retry after this
EVICT_S = 180               # forget journeys not seen for this long
# Graz + surroundings; must match PROXY_RECT in index.html
RECT = {'minLon': 15.30, 'maxLon': 15.60, 'minLat': 46.98, 'maxLat': 47.15}


def gate(meth, req):
    body = {'ver': '1.59', 'lang': 'deu', 'ext': 'VAO.22',
            'auth': {'type': 'AID', 'aid': 'wf7mcf9bv3nv8g5f'},
            'client': {'id': 'VAO', 'l': 'vs_stv', 'type': 'AND'},
            'svcReqL': [{'meth': meth, 'req': req}]}
    r = urllib.request.Request(HAFAS_URL, data=json.dumps(body).encode(),
                               headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(r, timeout=15) as resp:
        d = json.load(resp)
    L = d.get('svcResL') or []
    if not L or L[0].get('err') not in (None, 'OK'):
        raise RuntimeError('HAFAS err: %s' % (L[0].get('err') if L else 'empty'))
    return L[0].get('res', {})


def decode_poly(s):
    """Google encoded polyline -> [(lat, lng), ...]"""
    pts, i, lat, lng = [], 0, 0, 0
    while i < len(s):
        for k in range(2):
            sh = res = 0
            while True:
                b = ord(s[i]) - 63; i += 1
                res |= (b & 0x1f) << sh; sh += 5
                if b < 0x20: break
            d = ~(res >> 1) if res & 1 else res >> 1
            if k == 0: lat += d
            else: lng += d
        pts.append((lat / 1e5, lng / 1e5))
    return pts


def project(pos, pts):
    """Index + interpolation t of the polyline point nearest to pos, and its distance (m)."""
    ky = 111320.0
    kx = 111320.0 * math.cos(math.radians(pos[0]))
    best = (0, 0.0, float('inf'))
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        px, py = (pos[1] - a[1]) * kx, (pos[0] - a[0]) * ky
        bx, by = (b[1] - a[1]) * kx, (b[0] - a[0]) * ky
        L2 = bx * bx + by * by
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, (px * bx + py * by) / L2))
        d = math.hypot(px - t * bx, py - t * by)
        if d < best[2]: best = (i, t, d)
    return best


def path_between(prev, cur, pts):
    """Intermediate polyline vertices between two positions, [] if none/implausible."""
    i1, t1, d1 = project(prev, pts)
    i2, t2, d2 = project(cur, pts)
    if d1 > 100 or d2 > 100: return []          # reports don't lie on this polyline
    if (i1, t1) > (i2, t2): return []           # backwards (or loop ambiguity) — skip
    mids = pts[i1 + 1: i2 + 1]                  # vertices strictly between the projections
    return [[int(round(p[0] * 1e6)), int(round(p[1] * 1e6))] for p in mids][:24]


class PolyCache:
    def __init__(self):
        self.polys = {}      # jid -> [(lat,lng),...] | None (fetch failed)
        self.failed_at = {}  # jid -> epoch of failed fetch
        self.seen = {}       # jid -> epoch last seen in feed

    def want(self, jid):
        if jid in self.polys and self.polys[jid] is not None: return False
        return time.time() - self.failed_at.get(jid, 0) > POLY_RETRY_S

    def fetch(self, jid):
        try:
            det = gate('JourneyDetails', {'jid': jid, 'getPolyline': True})
            polyL = (det.get('common', {}) or {}).get('polyL') or []
            enc = polyL[0].get('crdEncYX') if polyL else None
            self.polys[jid] = decode_poly(enc) if enc else None
            if not enc: self.failed_at[jid] = time.time()
        except Exception:
            self.polys.setdefault(jid, None)
            self.failed_at[jid] = time.time()

    def evict(self):
        cut = time.time() - EVICT_S
        for jid, ts in list(self.seen.items()):
            if ts < cut:
                self.seen.pop(jid, None)
                self.polys.pop(jid, None)
                self.failed_at.pop(jid, None)


def main():
    cache = PolyCache()
    prev_pos = {}            # jid -> (lat, lng) of the previous cycle's report
    while True:
        t0 = time.time()
        try:
            res = gate('JourneyGeoPos', {
                'maxJny': 1000, 'onlyRT': False,
                'rect': {'llCrd': {'x': int(RECT['minLon'] * 1e6), 'y': int(RECT['minLat'] * 1e6)},
                         'urCrd': {'x': int(RECT['maxLon'] * 1e6), 'y': int(RECT['maxLat'] * 1e6)}}})
            jny = [j for j in res.get('jnyL', []) if j.get('pos') and j.get('jid')]
            now = time.time()
            for j in jny: cache.seen[j['jid']] = now

            # warm the polyline cache, a few journeys per cycle
            budget = DETAILS_PER_CYCLE
            for j in jny:
                if budget <= 0: break
                if cache.want(j['jid']):
                    cache.fetch(j['jid'])
                    budget -= 1

            # enrich: snap reports onto the route, then ship the street path
            for j in jny:
                jid = j['jid']
                cur = (j['pos']['y'] / 1e6, j['pos']['x'] / 1e6)
                pts = cache.polys.get(jid)
                # HAFAS occasionally reports layover/stand coordinates off the
                # street (buses "inside buildings"). The route polyline is truth:
                # project the report onto it and publish the snapped point.
                if pts and len(pts) >= 2:
                    i, t, dist = project(cur, pts)
                    if dist <= 80:
                        a, b = pts[i], pts[i + 1]
                        cur = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                        j['pos']['y'] = int(round(cur[0] * 1e6))
                        j['pos']['x'] = int(round(cur[1] * 1e6))
                prev = prev_pos.get(jid)
                if pts and prev and prev != cur:
                    mids = path_between(prev, cur, pts)
                    if mids: j['pth'] = mids
                prev_pos[jid] = cur
            for jid in list(prev_pos):
                if jid not in cache.seen: prev_pos.pop(jid, None)
            cache.evict()

            payload = {'t': int(time.time() * 1000), 'rect': RECT, 'res': res}
            tmp = OUT + '.tmp'
            with open(tmp, 'w') as f:
                json.dump(payload, f, separators=(',', ':'))
            os.replace(tmp, OUT)     # atomic: readers never see a half-written file
        except Exception as e:
            # keep the last good file; the client detects staleness via "t"
            import traceback
            print('poll failed:', e, flush=True)
            traceback.print_exc()
        time.sleep(max(0.5, POLL_S - (time.time() - t0)))


if __name__ == '__main__':
    main()
