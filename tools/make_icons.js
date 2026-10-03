#!/usr/bin/env node
/* BimRadar icons + iOS launch screens, all rendered from ONE square artwork
(tools/icon-art.webp) by a headless Chromium (Edge or Chrome) - no npm deps.

  node tools/make_icons.js tools/icon-art.webp icons        # write every PNG
  node tools/make_icons.js tools/icon-art.webp out preview  # out/preview.png

Set BROWSER=/path/to/chrome if it isn't found. After changing the icons, bump
the ?v= query on them in index.html, manifest.json and sw.js so phones refetch. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const EDGE = process.env.BROWSER || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => fs.existsSync(p));
if (!EDGE) { console.error('no Chromium found: set BROWSER'); process.exit(1); }
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const [, , art, outDir, mode] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
const uri = 'data:image/' + (art.endsWith('.webp') ? 'webp' : 'png') + ';base64,' + fs.readFileSync(art).toString('base64');
function shoot(body, w, h, out, bg = 'transparent') {
  const f = path.join(os.tmpdir(), 'mk-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.html');
  fs.writeFileSync(f, `<html><head><style>html,body{margin:0;background:${bg};overflow:hidden}img{display:block}</style></head><body>${body}</body></html>`);
  const o = path.resolve(out); try { fs.unlinkSync(o); } catch (e) {}
  spawnSync(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', '--force-device-scale-factor=1',
    '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'mkp-')), '--window-size=' + w + ',' + h, '--screenshot=' + o, 'file:///' + f.split(path.sep).join('/')]);
  for (let i = 0; i < 40 && !fs.existsSync(o); i++) sleep(250);
  if (!fs.existsSync(o)) throw new Error('render failed: ' + out);
}
const CROP = +(process.env.CROP || 0);          // fraction trimmed off every edge (frames/rounded corners in the source)
const img = (s, extra = '') => { const k = 1 / (1 - 2 * CROP), o = -s * CROP * k;
  return `<div style="width:${s}px;height:${s}px;overflow:hidden;position:relative;${extra}"><img src="${uri}" style="position:absolute;left:${o}px;top:${o}px;width:${s * k}px;height:${s * k}px"></div>`; };
// maskable: the art shrunk into the safe zone over a blurred, enlarged copy of itself (no visible frame)
const masked = (s, shape = '') => `<div style="width:${s}px;height:${s}px;position:relative;overflow:hidden;${shape}"><div style="position:absolute;inset:-12%;filter:blur(${s * 0.04}px) saturate(1.1)">${img(s * 1.24)}</div><div style="position:absolute;left:${s * (1 - MASK_SCALE) / 2}px;top:${s * (1 - MASK_SCALE) / 2}px;box-shadow:0 0 ${s * 0.05}px rgba(0,0,0,.35);border-radius:${s * 0.06}px;overflow:hidden">${img(s * MASK_SCALE)}</div></div>`;
const SKY = '#1d3f73';                        // padding colour for the maskable variant (art's sky)
const MASK_SCALE = 0.86;                      // art inside the maskable canvas (safe zone = central 80% circle)

if (mode === 'preview') {
  const tile = (s, r) => img(s, `border-radius:${r};`);
  const mask = s => masked(s, 'border-radius:50%');
  const maskSq = s => masked(s, 'border-radius:24%');
  const lab = t => `<div style="font:13px sans-serif;color:#999;text-align:center;margin-top:6px">${t}</div>`;
  const col = (el, t) => `<div style="display:flex;flex-direction:column;align-items:center">${el}${lab(t)}</div>`;
  const row = bg => `<div style="display:flex;gap:26px;align-items:end;padding:22px;background:${bg}">` +
    col(tile(180, '22.5%'), 'iPhone') + col(mask(150), 'Android round') + col(maskSq(150), 'Android squircle') +
    col(tile(60, '22.5%'), 'small') + col(tile(40, '22.5%'), 'tiny') + col(img(32), 'browser tab') + `</div>`;
  const splash = `<div style="width:180px;height:390px;background:#0d0f12;border-radius:22px;display:flex;align-items:center;justify-content:center;margin:22px">${img(62, 'border-radius:14px')}</div>`;
  shoot(`<div style="display:flex"><div>${row('linear-gradient(135deg,#f3e9dc,#cfe0f2)')}${row('linear-gradient(135deg,#1b1d2b,#2b3346)')}</div>${splash}</div>`, 1000, 470, path.join(outDir, 'preview.png'), '#222');
  console.log('preview.png'); process.exit(0);
}
// app icons: 'any' icons carry rounded corners (Android shows them as-is); the
// Apple touch icon is full-bleed (iOS rounds it itself); maskable is padded
const R = '22.5%';
shoot(img(32, 'border-radius:6px'), 32, 32, path.join(outDir, 'icon-32.png'));
shoot(img(180), 180, 180, path.join(outDir, 'icon-180.png'));
for (const s of [192, 512]) {
  shoot(img(s, 'border-radius:' + R), s, s, path.join(outDir, `icon-${s}.png`));
  shoot(masked(s), s, s, path.join(outDir, `icon-${s}-maskable.png`));
}
// iOS launch screens: app background, the icon centred
for (const [w, h, dpr] of [[1290, 2796, 3], [1179, 2556, 3], [1170, 2532, 3], [1284, 2778, 3], [1125, 2436, 3], [1242, 2688, 3], [828, 1792, 2], [750, 1334, 2]]) {
  const s = Math.round(120 * dpr);
  shoot(`<div style="width:${w}px;height:${h}px;background:#0d0f12;display:flex;align-items:center;justify-content:center">${img(s, 'border-radius:' + Math.round(s * 0.225) + 'px')}</div>`, w, h, path.join(outDir, `splash-${w}x${h}.png`), '#0d0f12');
}
console.log('done');
