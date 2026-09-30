#!/usr/bin/env node
/* BimRadar tests — run by tools/deploy.js BEFORE anything is copied live, and
by CI. The app is one HTML file with no module system, so the pure functions
are lifted out of the source by name (brace matching) and evaluated in a vm
sandbox. No dependencies.   node tools/test.js */
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const poller = fs.readFileSync(path.join(root, 'tools/feed_poller.js'), 'utf8').replace(/\r\n/g, '\n');

let failed = 0, passed = 0;
const ok = (cond, name) => { if (cond) passed++; else { failed++; console.error('FAIL  ' + name); } };
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);

function lift(src, name) {                       // "function name(...) {...}" or "const name = ...;"
  let i = src.search(new RegExp('(async\\s+)?function ' + name + '\\s*\\('));
  if (i >= 0) {
    let k = src.indexOf('{', src.indexOf(')', i)), depth = 0;
    for (; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) break; }
    return src.slice(i, k + 1);
  }
  i = src.search(new RegExp('const ' + name + ' = '));
  if (i < 0) throw new Error('cannot find ' + name);
  return src.slice(i, src.indexOf(';\n', i) + 1);
}
const box = (src, names, prelude) => {
  const ctx = vm.createContext({ Math, Date, String, Number, JSON, console });
  vm.runInContext((prelude || '') + '\n' + names.map(n => lift(src, n)).join('\n') +
    '\nthis.__x = {' + names.join(',') + '};', ctx);
  return ctx.__x;
};

// ---- 0. everything parses ----
for (const [label, code] of [['index.html inline script', script], ['sw.js', fs.readFileSync(path.join(root, 'sw.js'), 'utf8')]]) {
  try { new vm.Script(code); ok(true, label + ' parses'); } catch (e) { ok(false, label + ' parses: ' + e.message); }
}

// ---- 1. HAFAS time helpers ----
const T = box(script, ['hafasTime', 'hafasMins', 'delayOf', 'hafasSec', 'relSec2']);
ok(T.hafasTime('153000') === '15:30', 'hafasTime HHMMSS');
ok(T.hafasTime('01003000') === '00:30', 'hafasTime ddHHMMSS');
ok(T.hafasTime(null) === null, 'hafasTime null');
ok(T.hafasMins('01001500') === 1440 + 15, 'hafasMins day offset');
ok(T.delayOf({ dTimeS: '120000', dTimeR: '120400' }) === 4, 'delay +4');
ok(T.delayOf({ dTimeS: '235900', dTimeR: '01000200' }) === 3, 'delay across midnight');
ok(T.delayOf({ dTimeS: '120000' }) === null, 'delay without RT');
ok(T.hafasSec('010000') === 3600, 'hafasSec');
ok(T.relSec2('000020', 23 * 3600 + 59 * 60 + 40) === 40, 'relSec2 wraps midnight forward');
ok(T.relSec2('120000', 12 * 3600 + 30) === -30, 'relSec2 past');

// ---- 2. the timetable motion model ----
{
  const ctx = vm.createContext({ Math, String });
  vm.runInContext('let __now = 0; const secNow = () => __now;\n' +
    ['hafasSec', 'relSec2', 'easeSS', 'modelTargetD'].map(n => lift(script, n)).join('\n') +
    '\nthis.at = (s, m) => { __now = s; return modelTargetD(m); };', ctx);
  const plan = { st: [{ d: 0, a: '115900', p: '120000' }, { d: 400, a: '120100', p: '120120' }, { d: 700, a: '120300', p: null }] };
  const H = 12 * 3600;
  ok(ctx.at(H - 10, plan) === 0, 'model: dwelling before first departure');
  ok(near(ctx.at(H + 30, plan), 200, 1), 'model: mid-drive is the eased midpoint');
  ok(ctx.at(H + 70, plan) === 400, 'model: dwelling at the middle stop');
  ok(ctx.at(H + 400, plan) === 700, 'model: past the plan clamps to the last stop');
  let prev = -1, mono = true;
  for (let s = H - 30; s < H + 260; s += 2) { const d = ctx.at(s, plan); if (d < prev - 1e-9) mono = false; prev = d; }
  ok(mono, 'model: position never decreases as the clock advances');
  ok(ctx.at(H, { st: [{ d: 0, a: null, p: null }, { d: 300, a: null, p: null }] }) === null, 'model: no times -> null (glide fallback)');
  let maxStep = 0; prev = ctx.at(H, plan);
  for (let s = H + 1; s <= H + 60; s++) { const d = ctx.at(s, plan); maxStep = Math.max(maxStep, d - prev); prev = d; }
  ok(maxStep < 15, 'model: plausible peak speed (' + maxStep.toFixed(1) + ' m/s)');
}

// ---- 3. classification ----
const K = box(script, ['lineName', 'kindOf']);
ok(K.kindOf({ prodCtx: { catOutL: 'Straßenbahn', line: '7' } }) === 'tram', 'kindOf tram');
ok(K.kindOf({ prodCtx: { catOutL: 'Nachtbus', line: 'N3' } }) === 'night', 'kindOf night outranks type');
ok(K.kindOf({ prodCtx: { catOutL: 'S-Bahn', line: 'S1' } }) === 'train', 'kindOf S-Bahn');
ok(K.kindOf({ prodCtx: { catOutL: 'Stadtbus', line: '40' } }) === 'bus', 'kindOf bus');
ok(K.lineName({ prodCtx: { line: 'xxx' }, nameS: 'RJX 164' }) === 'RJX 164', 'lineName long-distance fallback');

// ---- 4. polyline decoding (client + poller agree) ----
const D = box(script, ['decodePath']);
const P = box(poller, ['decodePoly', 'cumDist', 'project', 'slicePoly', 'pathBetween']);
const enc = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';                 // Google's reference example
const pts = D.decodePath(enc), pp = P.decodePoly(enc);
ok(pts.length === 3 && near(pts[0].lat, 38.5, 1e-5) && near(pts[2].lng, -126.453, 1e-5), 'decodePath reference polyline');
ok(pp.length === 3 && near(pp[1][0], 40.7, 1e-5) && near(pp[1][1], -120.95, 1e-5), 'poller decodePoly agrees');

// ---- 5. poller geometry ----
const line = [[47.07, 15.43], [47.07, 15.44], [47.07, 15.45]];      // ~760 m per segment, due east
const cum = P.cumDist(line);
ok(near(cum[2], 2 * cum[1], 0.5) && cum[1] > 700 && cum[1] < 800, 'cumDist');
const pr = P.project([47.0701, 15.435], line);
ok(pr[0] === 0 && near(pr[1], 0.5, 0.01) && pr[2] > 5 && pr[2] < 20, 'project onto segment');
const sl = P.slicePoly(line, cum, cum[1] * 0.5, cum[1] * 1.5);
ok(sl.length === 3 && near(sl[0][1], 15.435, 1e-4) && near(sl[2][1], 15.445, 1e-4), 'slicePoly interpolates both ends');
ok(P.pathBetween([47.07, 15.431], [47.07, 15.449], line).length === 1, 'pathBetween ships the middle vertex');
ok(P.pathBetween([47.07, 15.449], [47.07, 15.431], line).length === 0, 'pathBetween refuses to go backwards');

// ---- 6. i18n: every i18('...') key that should be German has an entry ----
{
  const m = script.match(/const DE = (\{[\s\S]*?\n {4}\});/);
  ok(!!m, 'DE dictionary found');
  if (m) {
    const DE = JSON.parse(m[1]);
    const used = new Set([...script.matchAll(/i18\('((?:[^'\\]|\\.)*)'\)/g)].map(x => JSON.parse('"' + x[1].replace(/"/g, '\\"') + '"')));
    const missing = [...used].filter(k => DE[k] == null);
    ok(missing.length === 0, 'untranslated i18 keys: ' + JSON.stringify(missing));
  }
}

// ---- 7. departure reminders: check() against a stubbed disk, HAFAS and push service ----
async function pushTests() {
  const src = fs.readFileSync(path.join(root, 'tools/push_server.js'), 'utf8').replace(/\r\n/g, '\n');
  const ctx = vm.createContext({ Math, Date, String, Number, JSON, console });
  vm.runInContext(
    'let watches = [], __now = 0, __files = {}, __hafas = null, __calls = [], __pushes = [];\n' +
    'const viennaSecNow = () => __now, API_DIR = "/api", MSG_DIR = "/api/pushmsg", epHash = s => s, log = () => {}, save = () => {};\n' +
    'const path = { join: (...a) => a.join("/") };\n' +
    'const fs = { readFileSync: f => { if (!(f in __files)) throw new Error("ENOENT " + f); return __files[f]; }, writeFileSync: () => {} };\n' +
    'const gate = async (meth, req) => { __calls.push(req); return __hafas(req); };\n' +
    'const sendPush = async ep => { __pushes.push(ep); return 201; };\n' +
    ['secsUntil', 'hhmm', 'board', 'check'].map(n => lift(src, n)).join('\n') +
    '\nthis.run = async (w, files, hafas, now) => { watches = w; __files = files; __hafas = hafas; __now = now; __calls = []; __pushes = [];' +
    ' await check(); return { left: watches.length, calls: __calls, pushes: __pushes }; };', ctx);
  const H = 12 * 3600, now = Date.now();
  const dep = (jid, t) => ({ jid, stbStop: { dTimeS: t } });
  const watch = (lid, jid, lead, ageS) => ({ sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/x' },
    lid, jid, line: '4', dir: '', stop: 'Graz Jakominiplatz', lead, lang: 'en', at: now - ageS * 1000 });
  const hub = 'A=1@O=Graz Jakominiplatz@L=460304700@';
  // the poller caches only the next 12 departures: at a hub that is ~5 minutes
  const cached = { '/api/board/460304700.json': JSON.stringify({ t: now,
    res: { jnyL: Array.from({ length: 12 }, (_, k) => dep('near' + k, '1205' + String(k).padStart(2, '0'))) } }) };
  const full = () => ({ jnyL: [dep('near0', '120500'), dep('far', '121200')] });

  let r = await ctx.run([watch('A=1@L=999999999@', 'x', 3, 7 * 3600)], {}, () => { throw new Error('HAFAS LOCATION'); }, H);
  ok(r.left === 0, 'push: a 7 h old watch expires even when its board cannot be fetched');
  r = await ctx.run([watch(hub, 'far', 13, 60)], cached, full, H);
  ok(r.pushes.length === 1 && r.calls.length === 1 && r.calls[0].maxJny === 40,
    'push: a journey beyond the cached board is looked up on the full HAFAS board');
  r = await ctx.run([watch(hub, 'near3', 13, 60)], cached, full, H);
  ok(r.pushes.length === 1 && r.calls.length === 0, 'push: a journey on the fresh cached board does not hit HAFAS');
}

pushTests().catch(e => ok(false, 'push tests threw: ' + e.message)).then(() => {
  console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
