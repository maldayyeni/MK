'use strict';
/* =====================================================================
   MK ARCADE — Rokaia vs Joe, a 2D canvas fighting game
   Flow: main menu -> character select (Rokaia / Joe) -> arena (best of 3 rounds vs the CPU) -> victory.
   Rokaia's victory is her 27.0s routine, choreographed to "victory rokaia.mp3" and looping with it.

   Sprite pipeline: load each PNG sheet -> key the white paper to transparency -> slice the frames (every pose is
   its own connected shape; grid sheets are read row by row) -> resize each sheet ONCE with high-quality
   smoothing -> draw 1:1 with imageSmoothingEnabled = false, so the art stays pixel-sharp.
   ===================================================================== */

const W = 1280, H = 720;
const GROUND = 618;          // feet line on the stage
const STAND_H = 440;         // on-screen height of a standing pose
const TICK = 1000 / 60;      // fixed simulation step
const ASSET_DIRS = ['assets/Rokaia/', '../assets/Rokaia/', './']; // first folder that has the file wins
const JOE_DIRS = ['WebGame/', '../WebGame/'];
const POCKET_MIN = 140;      // enclosed near-white areas at least this big are paper (between an arm and the waist)
const WHIP_STRETCH = [0.6, 2.4]; // how far the ponytail may compress / stretch to meet the opponent
const BODY = 55;             // hurtbox half-width around a fighter's feet line
const SONG_FILE = 'victory rokaia.mp3'; // Rokaia's victory song (same folders as her sprites)
const SONG_LOOP_S = 27.0;    // her routine is one 27.0s loop: the song is time-stretched (pitch kept) to exactly this
const JOE_SONG = 'victory.mp3';
const ROUNDS_TO_WIN = 2, ROUND_TIME = 60;

/* ---------- 1. asset manifest ---------- */
const MANIFEST = [
  { key: 'ref1',    file: 'rokaia_ref_1.png' },
  { key: 'walk',    file: 'rokaia_walk.png' },
  { key: 'jump',    file: 'rokaia_jump.png' },
  { key: 'crouch',  file: 'rokaia_crouch.png' },
  { key: 'punch',   file: 'rokaia_punch.png' },
  { key: 'block',   file: 'rokaia_block.png' },
  { key: 'hit',     file: 'rokaia_hit.png' },
  { key: 'ko',      file: 'rokaia_ko.png' },
  { key: 'cross',   file: 'move1_crossover.png' },
  { key: 'waist',   file: 'move1_batch2.png' },
  { key: 'whip1',   file: 'whip_batch1.png' },
  { key: 'whip2',   file: 'whip_batch2.png', optional: true },
  { key: 'sweep',   file: 'move3_batch.png' },
  { key: 'joeSel',  file: 'Joe selection.png', dirs: JOE_DIRS },
  { key: 'jIdle',   file: 'joe_idle.png',      dirs: JOE_DIRS },
  { key: 'jPunch',  file: 'joe_punch.png',     dirs: JOE_DIRS },
  { key: 'jKick',   file: 'joe_kick.png',      dirs: JOE_DIRS },
  { key: 'jCrouch', file: 'joe_crouch.png',    dirs: JOE_DIRS }
];
// How each sheet is cut and scaled. frames: pose count ('auto' = count the big shapes); rows: grid rows.
// Scale: h = on-screen height of the tallest frame (or of frame `fit`); scaleFrom = reuse another sheet's scale
// (sheets drawn at the same size share it, so poses match). key: false = already transparent. Processed in order.
const SHEETS = {
  walk:    { frames: 5, h: STAND_H },
  punch:   { frames: 4, scaleFrom: 'walk' },
  ko:      { frames: 3, scaleFrom: 'walk' },
  block:   { frames: 3, fit: 0, h: STAND_H },
  crouch:  { frames: 3, scaleFrom: 'block' },
  hit:     { frames: 3, scaleFrom: 'block' },
  jump:    { frames: 4, scaleFrom: 'block' },
  cross:   { frames: 8, rows: 2, fit: 0, h: STAND_H * 1.02 },
  waist:   { frames: 'auto', rows: 'auto', fit: 0, h: STAND_H, sameHeight: true }, // however many hands-on-waist poses the sheet has
  sweep:   { frames: 5, fit: 0, h: STAND_H },
  whip1:   { frames: 4, scaleFrom: 'sweep' },
  whip2:   { frames: 'auto', scaleFrom: 'sweep' },
  ref1:    { frames: 1, h: 470, pockets: false },
  joeSel:  { frames: 1, h: 470, key: false },
  jIdle:   { frames: 1, h: STAND_H * 1.04, key: false },
  jPunch:  { frames: 1, scaleFrom: 'jIdle', key: false },
  jKick:   { frames: 1, scaleFrom: 'jIdle', key: false },
  jCrouch: { frames: 1, scaleFrom: 'jIdle', key: false }
};

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
// work canvases are CPU-backed (willReadFrequently): their pixels are read back reliably and never dropped when
// the GPU is short on memory; finished sprite strips are then frozen into ImageBitmaps (see loadAll)
function mk(w, h) {
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
  c.getContext('2d', { willReadFrequently: true });
  return c;
}
const freeze = c => (window.createImageBitmap ? createImageBitmap(c).catch(() => c) : Promise.resolve(c));
function loadImage(file, dirs = ASSET_DIRS) {
  return new Promise(resolve => {
    let i = 0;
    const next = () => {
      if (i >= dirs.length) return resolve(null);
      const url = dirs[i++] + file, img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = next;
      img.src = url;
    };
    next();
  });
}

/* ---------- 2. white paper -> transparency ---------- */
// near-white connected to the border is paper; sizeable enclosed near-white areas are paper too (Rokaia wears no
// white, and eye whites / highlights are far smaller than POCKET_MIN). A 4px band along every cut edge is
// "de-matted": the white mixed into anti-aliased pixels is solved out, so no white halo is left on a dark stage.
function keyWhite(d, W0, H0, pockets) {
  const N = W0 * H0, lum = i => Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  const bg = new Uint8Array(N), q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (d[i * 4 + 3] < 8) { bg[i] = 1; q[qt++] = i; }
  const seed = i => { if (!bg[i] && lum(i) >= 228) { bg[i] = 1; q[qt++] = i; } };
  for (let x = 0; x < W0; x++) { seed(x); seed((H0 - 1) * W0 + x); }
  for (let y = 0; y < H0; y++) { seed(y * W0); seed(y * W0 + W0 - 1); }
  while (qh < qt) { const i = q[qh++], x = i % W0; if (x > 0) seed(i - 1); if (x < W0 - 1) seed(i + 1); if (i >= W0) seed(i - W0); if (i < N - W0) seed(i + W0); }
  if (pockets) {
    const seen = new Uint8Array(N);
    for (let s = 0; s < N; s++) {
      if (bg[s] || seen[s] || lum(s) < 236) continue;
      qh = qt = 0; q[qt++] = s; seen[s] = 1;
      while (qh < qt) {
        const i = q[qh++], x = i % W0;
        for (const j of [x > 0 ? i - 1 : -1, x < W0 - 1 ? i + 1 : -1, i - W0, i + W0]) if (j >= 0 && j < N && !seen[j] && !bg[j] && lum(j) >= 236) { seen[j] = 1; q[qt++] = j; }
      }
      if (qt >= POCKET_MIN) for (let k = 0; k < qt; k++) bg[q[k]] = 1;
    }
  }
  const EDGE = 4, src = new Uint8ClampedArray(d), dist = new Uint8Array(N);
  qh = qt = 0;
  for (let i = 0; i < N; i++) {
    if (bg[i]) { d[i * 4 + 3] = 0; continue; }
    const x = i % W0;
    if ((x > 0 && bg[i - 1]) || (x < W0 - 1 && bg[i + 1]) || (i >= W0 && bg[i - W0]) || (i < N - W0 && bg[i + W0])) { dist[i] = 1; q[qt++] = i; }
  }
  while (qh < qt) {
    const i = q[qh++], x = i % W0, nd = dist[i] + 1;
    if (nd > EDGE) continue;
    for (const j of [x > 0 ? i - 1 : -1, x < W0 - 1 ? i + 1 : -1, i - W0, i + W0]) if (j >= 0 && j < N && !bg[j] && !dist[j]) { dist[j] = nd; q[qt++] = j; }
  }
  for (let i = 0; i < N; i++) {
    const di = dist[i]; if (!di || src[i * 4 + 3] < 250) continue;
    const x = i % W0, y = (i - x) / W0;
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W0 || yy >= H0) continue;
      const j = yy * W0 + xx; if (bg[j] || dist[j]) continue;
      r += src[j * 4]; g += src[j * 4 + 1]; b += src[j * 4 + 2]; n++;
    }
    const c = [src[i * 4], src[i * 4 + 1], src[i * 4 + 2]], fg = n ? [r / n, g / n, b / n] : c.map(v => Math.min(v, 200));
    let a = 0, used = 0;
    for (let k = 0; k < 3; k++) { const room = 255 - fg[k]; if (room > 28) { a = Math.max(a, (255 - c[k]) / room); used++; } }
    if (!used) a = lum(i) >= 236 ? 0 : 1;
    a = clamp(a, 0, 1); if (a < .14) a = 0;
    for (let k = 0; k < 3; k++) d[i * 4 + k] = a > 0 ? clamp(a >= .98 ? c[k] : (c[k] - 255 * (1 - a)) / a, 0, 255) : 0;
    if (a > 0 && a < .98) for (let k = 0; k < 3; k++) d[i * 4 + k] = lerp(d[i * 4 + k], fg[k], .5);
    d[i * 4 + 3] = a * 255;
  }
}

/* ---------- 3. frame slicing ---------- */
// The n biggest connected shapes are the poses. Loose pieces (a ponytail tip, a ribbon end) join the nearest pose.
// Poses are ordered row by row (grid sheets), left to right. If the art doesn't separate, equal grid cells are used.
function sliceSheet(K, spec) {
  const { d, W: SW, H: SH } = K, N = SW * SH, lab = new Int32Array(N), q = new Int32Array(N), comps = [];
  for (let s = 0; s < N; s++) {
    if (lab[s] || d[s * 4 + 3] <= 40) continue;
    const L = comps.length + 1; let x0 = SW, x1 = 0, y0 = SH, y1 = 0, qh = 0, qt = 0;
    lab[s] = L; q[qt++] = s;
    while (qh < qt) {
      const i = q[qh++], x = i % SW, y = (i - x) / SW;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !lab[i - 1] && d[(i - 1) * 4 + 3] > 40) { lab[i - 1] = L; q[qt++] = i - 1; }
      if (x < SW - 1 && !lab[i + 1] && d[(i + 1) * 4 + 3] > 40) { lab[i + 1] = L; q[qt++] = i + 1; }
      if (y > 0 && !lab[i - SW] && d[(i - SW) * 4 + 3] > 40) { lab[i - SW] = L; q[qt++] = i - SW; }
      if (y < SH - 1 && !lab[i + SW] && d[(i + SW) * 4 + 3] > 40) { lab[i + SW] = L; q[qt++] = i + SW; }
    }
    comps.push({ L, x0, x1, y0, y1, n: qt });
  }
  comps.sort((a, b) => b.n - a.n);
  const n = spec.frames === 'auto' ? Math.max(1, comps.filter(c => c.n >= comps[0].n * .2).length) : spec.frames;
  const big = comps.slice(0, n);
  if (!comps.length || big.length < n || big.some(c => c.n < big[0].n * .1)) return gridSlice(K, n, spec.rows === 'auto' ? 1 : spec.rows || 1);
  big.sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const figs = [];
  if (spec.rows === 'auto') { // a new row starts wherever the vertical centres jump by more than half a figure
    const tall = Math.max(...big.map(c => c.y1 - c.y0));
    let row = [big[0]];
    for (let i = 1; i <= big.length; i++) {
      const c = big[i], prev = big[i - 1];
      if (!c || (c.y0 + c.y1) / 2 - (prev.y0 + prev.y1) / 2 > tall * .5) { figs.push(...row.sort((a, b) => a.x0 - b.x0)); row = []; }
      if (c) row.push(c);
    }
  } else {
    const rows = spec.rows || 1, per = Math.ceil(n / rows);
    for (let r = 0; r < rows; r++) figs.push(...big.slice(r * per, (r + 1) * per).sort((a, b) => a.x0 - b.x0));
  }
  const own = figs.map(f => ({ set: new Set([f.L]), x0: f.x0, x1: f.x1, y0: f.y0, y1: f.y1 }));
  for (const c of comps) {
    if (figs.includes(c) || c.n < 15) continue;
    let k = 0, best = Infinity;
    figs.forEach((f, i) => {
      const dx = Math.max(0, f.x0 - c.x1, c.x0 - f.x1), dy = Math.max(0, f.y0 - c.y1, c.y0 - f.y1);
      const cd = Math.hypot((f.x0 + f.x1 - c.x0 - c.x1) / 2, (f.y0 + f.y1 - c.y0 - c.y1) / 2);
      const score = (dx * dx + dy * dy) * 1e3 + cd;            // touching boxes: the closer centre wins
      if (score < best) { best = score; k = i; }
    });
    const o = own[k]; o.set.add(c.L);
    o.x0 = Math.min(o.x0, c.x0); o.x1 = Math.max(o.x1, c.x1); o.y0 = Math.min(o.y0, c.y0); o.y1 = Math.max(o.y1, c.y1);
  }
  return own.map(o => cutFrame(K, o.x0, o.y0, o.x1, o.y1, (x, y) => o.set.has(lab[y * SW + x])));
}
function gridSlice(K, n, rows) {
  const cols = Math.ceil(n / rows), cw = K.W / cols, ch = K.H / rows, out = [];
  for (let i = 0; i < n; i++) {
    const cx = i % cols, cy = Math.floor(i / cols);
    out.push(cutFrame(K, Math.round(cx * cw), Math.round(cy * ch), Math.round((cx + 1) * cw) - 1, Math.round((cy + 1) * ch) - 1, () => true, true));
  }
  return out;
}
// copy one pose into its own canvas (trimmed to its pixels) and measure it:
//   ax = feet centre (anchor), hand = frontmost fist (15-50% height), reach = frontmost pixel,
//   zone = the ponytail whip area: rows above 45% height, columns in front of the body's lower half
function cutFrame(K, x0, y0, x1, y1, mine, raw) {
  const { d, W: SW } = K;
  let w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (raw || !d) { // unkeyed fallback (opened from file://): the cell as it is
    const c = mk(w, h); c.getContext('2d').drawImage(K.cv, x0, y0, w, h, 0, 0, w, h);
    return { c, w, h, ax: w / 2, hand: [w * .8, h * .3], reach: w * .8, zone: null };
  }
  let tx0 = w, tx1 = -1, ty0 = h, ty1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mine(x0 + x, y0 + y) || d[((y0 + y) * SW + x0 + x) * 4 + 3] <= 40) continue;
    if (x < tx0) tx0 = x; if (x > tx1) tx1 = x; if (y < ty0) ty0 = y; if (y > ty1) ty1 = y;
  }
  if (tx1 < 0) { tx0 = 0; tx1 = w - 1; ty0 = 0; ty1 = h - 1; }
  x0 += tx0; y0 += ty0; w = tx1 - tx0 + 1; h = ty1 - ty0 + 1;
  const c = mk(w, h), g = c.getContext('2d'), im = g.createImageData(w, h), o = im.data, op = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mine(x0 + x, y0 + y)) continue;
    const i = ((y0 + y) * SW + x0 + x) * 4, j = (y * w + x) * 4;
    o[j] = d[i]; o[j + 1] = d[i + 1]; o[j + 2] = d[i + 2]; o[j + 3] = d[i + 3];
    if (d[i + 3] > 40) op[y * w + x] = 1;
  }
  g.putImageData(im, 0, 0);
  let sx = 0, n = 0;
  for (let y = Math.floor(h * .9); y < h; y++) for (let x = 0; x < w; x++) if (op[y * w + x]) { sx += x; n++; }
  const front = (r0, r1) => { let best = -1, by = 0; for (let y = Math.floor(h * r0); y < h * r1; y++) for (let x = w - 1; x > best; x--) if (op[y * w + x]) { best = x; by = y; break; } return [best < 0 ? w : best, by]; };
  const band = Math.floor(h * .45), body = front(.45, 1)[0], tip = front(0, .45)[0];
  const zone = tip > body + 24 ? { split: body + 6, band, tip } : null;
  return { c, w, h, ax: n ? sx / n : w / 2, hand: front(.15, .5), reach: front(0, 1)[0], zone };
}
function resizeHQ(c, tw, th) {
  tw = Math.max(1, Math.round(tw)); th = Math.max(1, Math.round(th));
  let cur = c, w = c.width, h = c.height;
  while (w / 2 >= tw && h / 2 >= th) {
    w = Math.ceil(w / 2); h = Math.ceil(h / 2);
    const n = mk(w, h), g = n.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, w, h); cur = n;
  }
  const n = mk(tw, th), g = n.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, tw, th);
  return n;
}
// one cut frame scaled by s (canvas + every measurement)
function sizeFrame(F, s) {
  if (Math.abs(s - 1) < .005) return F;
  const c = resizeHQ(F.c, F.w * s, F.h * s);
  return { c, w: c.width, h: c.height, ax: F.ax * s, hand: [F.hand[0] * s, F.hand[1] * s], reach: F.reach * s,
    zone: F.zone && { split: F.zone.split * s, band: F.zone.band * s, tip: F.zone.tip * s } };
}
// frames -> one strip, resized once to k (screen px per file px). Frame metrics are returned in screen px.
function buildSheet(fr, k) {
  const pad = Math.ceil(4 / k) + 2, mh = Math.max(...fr.map(F => F.h));
  const src = mk(fr.reduce((s, F) => s + F.w + pad, pad), mh), sg = src.getContext('2d');
  let x = pad;
  const pos = fr.map(F => { sg.drawImage(F.c, x, mh - F.h); const p = x; x += F.w + pad; return p; });
  const strip = resizeHQ(src, src.width * k, src.height * k);
  const frames = fr.map((F, i) => ({
    sX: Math.round(pos[i] * k), sY: Math.round((mh - F.h) * k), w: Math.round(F.w * k), h: Math.round(F.h * k),
    ax: F.ax * k, hand: [F.hand[0] * k, F.hand[1] * k], reach: F.reach * k,
    zone: F.zone && { split: Math.round(F.zone.split * k), band: Math.round(F.zone.band * k), tip: F.zone.tip * k }
  }));
  return { strip, frames, k };
}

/* ---------- 4. load + process every sheet ---------- */
const SPR = {};          // key -> { strip, frames, k }
let RAW_MODE = false;    // true when the page is opened from file:// (pixels can't be read: no keying)
async function loadAll(onProgress) {
  const loaded = {};
  await Promise.all(MANIFEST.map(async a => { loaded[a.key] = await loadImage(a.file, a.dirs); }));
  const keys = Object.keys(SHEETS);
  for (let n = 0; n < keys.length; n++) {
    const key = keys[n], spec = SHEETS[key], L = loaded[key];
    onProgress(n / keys.length);
    await new Promise(r => setTimeout(r, 0)); // let the loading bar paint
    if (!L) continue;
    const img = L.img, cv = mk(img.naturalWidth, img.naturalHeight), g = cv.getContext('2d');
    g.drawImage(img, 0, 0);
    const K = { cv, W: cv.width, H: cv.height, d: null };
    if (!RAW_MODE) {
      try {
        const id = g.getImageData(0, 0, cv.width, cv.height);
        if (spec.key !== false) { keyWhite(id.data, cv.width, cv.height, spec.pockets !== false); g.putImageData(id, 0, 0); }
        K.d = id.data;
      } catch (e) { RAW_MODE = true; }
    }
    let fr = K.d ? sliceSheet(K, spec) : gridSlice(K, typeof spec.frames === 'number' ? spec.frames : 4, spec.rows === 'auto' ? 1 : spec.rows || 1);
    if (spec.sameHeight) fr = fr.map(F => sizeFrame(F, fr[0].h / F.h)); // poses drawn at different sizes: match frame 1
    const ref = spec.scaleFrom && SPR[spec.scaleFrom];
    const k = ref ? ref.k : spec.h / (spec.fit != null ? fr[Math.min(spec.fit, fr.length - 1)].h : Math.max(...fr.map(F => F.h)));
    const sheet = buildSheet(fr, k);
    sheet.strip = await freeze(sheet.strip);
    SPR[key] = sheet;
  }
  onProgress(1);
  return MANIFEST.filter(m => !m.optional && !SPR[m.key]).map(m => m.file); // missing required files
}

/* ---------- 5. sound effects (tiny synth) ---------- */
const SFX = { ctx: null, on: true };
function sfxCtx() {
  if (!SFX.ctx) { try { SFX.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
  if (SFX.ctx.state === 'suspended') SFX.ctx.resume();
  return SFX.ctx;
}
function tone(f0, f1, dur, type = 'square', vol = .12) {
  const c = SFX.on && sfxCtx(); if (!c) return;
  const o = c.createOscillator(), g = c.createGain(), t = c.currentTime;
  o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.001, t + dur);
  o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur);
}
function noise(dur, vol = .3, freq = 1800) {
  const c = SFX.on && sfxCtx(); if (!c) return;
  const b = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  f.type = 'lowpass'; f.frequency.value = freq; g.gain.value = vol;
  s.buffer = b; s.connect(f); f.connect(g); g.connect(c.destination); s.start();
}
const sfx = {
  move: () => tone(520, 640, .06, 'square', .05),
  pick: () => { tone(330, 990, .18, 'sawtooth', .07); tone(660, 1320, .2, 'square', .04); },
  whoosh: () => noise(.12, .12, 2600),
  hit: () => { noise(.1, .45, 1600); tone(160, 60, .14, 'sine', .4); },
  heavy: () => { noise(.18, .55, 1100); tone(120, 40, .22, 'sine', .5); },
  block: () => { tone(1400, 900, .07, 'square', .06); noise(.05, .2, 4000); },
  whip: () => { noise(.09, .25, 5200); tone(1800, 500, .1, 'triangle', .06); },
  fire: () => { noise(.35, .3, 900); tone(220, 90, .3, 'sawtooth', .08); },
  ko: () => { tone(200, 40, .9, 'sawtooth', .2); noise(.6, .4, 600); },
  bell: () => { tone(880, 860, .5, 'triangle', .12); tone(1320, 1300, .4, 'sine', .06); }
};

/* ---------- 6. Rokaia's victory routine (Web Audio, song-driven choreography) ----------
   The song is decoded into an AudioBuffer, stretched to exactly 27.0s and played by a looping
   AudioBufferSourceNode (gap-free repeat). Graph: source -> analyser -> gain -> speakers.
   The song clock drives everything: sweep sections map song time straight to frames, the 4–8s block is a fixed
   six-move script, and the beat sections step on the song's tempo, landing on detected drum hits. */
// move1_crossover.png poses by the side of the screen the extended arm reaches to (right = screen-right).
// Each scripted move gathers through a crossed-arms frame, then lands on the extended pose.
const CROSS_RL = { right: [2, 4], left: [0, 6], cross: [7, 1, 3, 5, 7, 1] };
const SONG_MAP = [ // [start, end) in seconds
  { t0: 0,  t1: 4,  sheet: 'sweep', mode: 'sweep', label: 'Victory 3 Arms Sweep' },
  // exactly 6 moves, strictly alternating by screen side; they start slow and speed up with the building song
  // (move lengths in proportion to `pace`: ~0.97s for the first move down to ~0.40s for the last)
  { t0: 4,  t1: 8,  sheet: 'cross', mode: 'script', label: 'Victory 1 Crossover (R/L, building)',
    moves: ['right', 'left', 'right', 'left', 'right', 'left'], pace: [1.45, 1.25, 1.05, .9, .75, .6], gather: .3 },
  // tempo-locked: crossed, RIGHT, crossed, LEFT, … so every beat lands on the other side; it opens on crossed arms
  // (move 6 was left), so the right-reaching pose comes next and the alternation carries on
  { t0: 8,  t1: 14, sheet: 'cross', mode: 'beat', label: 'Victory 1 Crossover (on the beat)',
    order: [1, CROSS_RL.right[0], 3, CROSS_RL.left[1], 5, CROSS_RL.right[1], 7, CROSS_RL.left[0]] },
  { t0: 14, t1: 24, sheet: 'waist', mode: 'beat', label: 'Victory 1 Hands on Waist' },
  { t0: 24, t1: SONG_LOOP_S, sheet: 'sweep', mode: 'sweep', label: 'Victory 3 Arms Sweep (finale)' }
];
// share of a sweep section each frame takes: chest gather, arms start, opening, opening, full 180°.
// The full extension arrives in the last ~12% of the section, so it peaks right at 4.0s / at the 27.0s loop point.
const SWEEP_WEIGHTS = [1, 1.2, .8, .8, .5];
const SONG_BPM = 100;        // felt tempo of the song stretched to 27.0s (~107 BPM original); used until the analyser has its own reading
const BEAT_FEEL = {          // frames per beat, top speed, how early (share of the step) a detected hit may trigger it
  cross: { perBeat: 2, maxFps: 4.5, lock: .8 },   // arm out on the beat, crossover on the off-beat
  waist: { perBeat: 1, maxFps: 2.2, lock: .85 }   // one sway per main drum/bass hit
};
const MUS = {
  ctx: null, buf: null, src: null, an: null, gain: null, freq: null, wave: null, prev: null,
  ready: false, loading: null, playing: false, startAt: 0, offset: 0, dur: SONG_LOOP_S, srcDur: 0, last: 0,
  sec: -1, ord: 0, lastStep: -1, frame: 0, move: null, step: null, energy: 0, peak: .05, fluxAvg: 0, lastBeat: -1, beats: [], bpm: 0, bounce: 0
};
function loadSong() {
  if (MUS.loading) return MUS.loading;
  MUS.loading = (async () => {
    try { MUS.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return false; }
    MUS.an = MUS.ctx.createAnalyser(); MUS.an.fftSize = 1024; MUS.an.smoothingTimeConstant = .6;
    MUS.gain = MUS.ctx.createGain(); MUS.gain.gain.value = SFX.on ? 1 : 0;
    MUS.an.connect(MUS.gain); MUS.gain.connect(MUS.ctx.destination);
    MUS.freq = new Uint8Array(MUS.an.frequencyBinCount); MUS.wave = new Uint8Array(MUS.an.fftSize);
    for (const dir of ASSET_DIRS) {
      try {
        const r = await fetch(dir + encodeURIComponent(SONG_FILE));
        if (!r.ok) continue;
        const raw = await MUS.ctx.decodeAudioData(await r.arrayBuffer());
        MUS.srcDur = raw.duration;
        MUS.buf = await timeStretch(raw, Math.round(SONG_LOOP_S * raw.sampleRate));
        MUS.dur = MUS.buf.duration; MUS.ready = true;
        return true;
      } catch (e) { /* next folder */ }
    }
    return false;
  })();
  return MUS.loading;
}
// Pitch-preserving time-stretch (WSOLA): overlapping Hann-windowed grains of the song are laid out on the longer
// timeline; each grain is taken from the spot near its nominal position that best continues the previous grain
// (cross-correlation), so the waveform stays phase-continuous and the beat simply plays a little slower.
async function timeStretch(buf, outLen) {
  const ch = buf.numberOfChannels, inLen = buf.length, N = 2048, Hs = N / 2, rate = inLen / outLen, TOL = 480, L = N / 2;
  const src = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  const mono = new Float32Array(inLen); for (const s of src) for (let i = 0; i < inLen; i++) mono[i] += s[i] / ch;
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = .5 - .5 * Math.cos(2 * Math.PI * i / N); // periodic Hann
  const out = MUS.ctx.createBuffer(ch, outLen, buf.sampleRate), dst = [...Array(ch)].map((_, c) => out.getChannelData(c));
  const at = (a, i) => (i >= 0 && i < inLen ? a[i] : 0), wsum = new Float32Array(outLen);
  let prev = 0;
  for (let k = 0; k * Hs < outLen; k++) {
    let pos = 0;
    if (k) {
      const nominal = Math.round(k * Hs * rate), cont = prev + Hs; // where the last grain would naturally continue
      let best = -Infinity;
      for (let d = -TOL; d <= TOL; d += 2) {
        const p = nominal + d; if (p < 0 || p + N > inLen + N / 2) continue;
        let s = 0; for (let i = 0; i < L; i += 4) s += at(mono, p + i) * at(mono, cont + i);
        if (s > best) { best = s; pos = p; }
      }
    }
    const o = k * Hs;
    for (let i = 0; i < N && o + i < outLen; i++) wsum[o + i] += win[i];
    for (let c = 0; c < ch; c++) for (let i = 0; i < N && o + i < outLen; i++) dst[c][o + i] += at(src[c], pos + i) * win[i];
    prev = pos;
    if (k % 120 === 119) await new Promise(r => setTimeout(r, 0)); // keep the game responsive
  }
  // divide by the summed window: exact level at the very start and end too (no dip at the 27.0s loop seam)
  for (let i = 0; i < outLen; i++) { const w = Math.max(wsum[i], .05); if (w !== 1) for (let c = 0; c < ch; c++) dst[c][i] /= w; }
  for (let c = 0; c < ch; c++) for (let i = 0; i < Hs && i < outLen; i++) dst[c][i] = src[c][i]; // first half-grain is the song itself
  return out;
}
const musicTime = () => !MUS.ready ? 0 : !MUS.playing ? MUS.offset : (MUS.ctx.currentTime - MUS.startAt) % MUS.dur;
async function musicPlay(from = 0) {
  if (!(await loadSong()) || !MUS.ready) return false;
  if (MUS.ctx.state === 'suspended') await MUS.ctx.resume();
  musicStop();
  const src = MUS.ctx.createBufferSource();
  src.buffer = MUS.buf; src.loop = true; src.connect(MUS.an);           // loops seamlessly at 27.0s
  src.start(0, from); MUS.src = src; MUS.startAt = MUS.ctx.currentTime - from;
  MUS.playing = true; MUS.sec = -1; MUS.last = from;
  return true;
}
function musicStop() {
  if (MUS.src) { const s = MUS.src; MUS.src = null; try { s.stop(); } catch (e) {} }
  MUS.playing = false; MUS.offset = 0;
}
// audio analysis: overall energy (RMS, normalised to the song's own loudest moments) + onset (drum hit) detection
function analyse(t) {
  if (!MUS.an || !MUS.playing) { MUS.energy = lerp(MUS.energy, 0, .1); return false; }
  MUS.an.getByteTimeDomainData(MUS.wave); MUS.an.getByteFrequencyData(MUS.freq);
  let sq = 0; for (const v of MUS.wave) { const x = (v - 128) / 128; sq += x * x; }
  const rms = Math.sqrt(sq / MUS.wave.length);
  MUS.peak = Math.max(rms, MUS.peak * .9995, .04);
  MUS.energy = lerp(MUS.energy, clamp(rms / MUS.peak, 0, 1), .25);
  // spectral flux: how much the 40 Hz – 2.6 kHz bins rose since the last frame, against an adaptive threshold
  // (this mix keeps its bass compressed flat, so the kick/snare shows up as rises across the band)
  if (!MUS.prev) MUS.prev = new Uint8Array(MUS.freq.length);
  let flux = 0; for (let i = 1; i <= 60; i++) { const d = MUS.freq[i] - MUS.prev[i]; if (d > 0) flux += d; }
  MUS.prev.set(MUS.freq);
  const beat = flux > MUS.fluxAvg * 1.6 + 25 && (MUS.lastBeat < 0 || t - MUS.lastBeat > .24 || t < MUS.lastBeat);
  MUS.fluxAvg = lerp(MUS.fluxAvg || flux, flux, .08);
  if (beat) {
    if (MUS.lastBeat >= 0 && t > MUS.lastBeat && t - MUS.lastBeat < 1.5) { MUS.beats.push(t - MUS.lastBeat); if (MUS.beats.length > 12) MUS.beats.shift(); }
    let bpm = MUS.beats.length >= 3 ? 60 / [...MUS.beats].sort((a, b) => a - b)[MUS.beats.length >> 1] : 0;
    while (bpm > 180) bpm /= 2;                                               // the felt tempo
    if (bpm) MUS.bpm = Math.round(bpm);
    MUS.lastBeat = t;
  }
  return beat;
}
// song time -> the frame on stage (MUS.step)
function musicUpdate(dt) {
  const t = musicTime();
  if (t < MUS.last - .5) MUS.sec = -1;                      // the song looped back to 0.0s: restart the routine
  MUS.last = t;
  const beat = analyse(t);
  let si = SONG_MAP.findIndex(s => t >= s.t0 && t < s.t1); if (si < 0) si = SONG_MAP.length - 1;
  const S = SONG_MAP[si], A = SPR[S.sheet], n = A ? A.frames.length : 1;
  if (si !== MUS.sec) { MUS.sec = si; MUS.ord = 0; MUS.frame = S.order ? S.order[0] : 0; MUS.lastStep = t; }
  if (S.mode === 'sweep') {
    // one full 0° -> 180° sweep stretched exactly over the section
    const w = SWEEP_WEIGHTS.slice(0, n), tot = w.reduce((a, b) => a + b, 0);
    let u = clamp((t - S.t0) / (S.t1 - S.t0), 0, .9999) * tot, f = 0;
    while (f < n - 1 && u >= w[f]) u -= w[f++];
    MUS.frame = f;
  } else if (S.mode === 'script') {
    // fixed choreography: each move's length follows `pace` (scaled to fill the section); a move spends its first
    // `gather` share in a crossed-arms frame, then lands on and holds that side's extended pose
    const tot = S.pace.reduce((a, b) => a + b, 0), scale = (S.t1 - S.t0) / tot;
    let m = 0, start = S.t0;
    while (m < S.moves.length - 1 && t >= start + S.pace[m] * scale) start += S.pace[m++] * scale;
    const k = (t - start) / (S.pace[m] * scale), side = S.moves[m];
    const pose = CROSS_RL[side][Math.floor(m / 2) % 2], f = k < S.gather ? CROSS_RL.cross[m] : pose;
    if (f === pose && MUS.frame !== pose) MUS.bounce = 1;     // a soft settle as the pose lands
    MUS.frame = f; MUS.move = { i: m, n: S.moves.length, side };
  } else if (MUS.playing) {
    // tempo-locked: the pace comes from the song's tempo, energy only nudges it ±12%, the FPS cap keeps it steady.
    // A step waits for a detected hit once it is due, so the moves land on the drums; it never stalls.
    const B = BEAT_FEEL[S.sheet], T = 60 / (MUS.bpm || SONG_BPM);
    const iv = Math.max(T / B.perBeat * (1.12 - .24 * MUS.energy), 1 / B.maxFps), since = t - MUS.lastStep;
    if (MUS.lastStep < 0 || since < 0) MUS.lastStep = t;
    else if ((beat && since >= iv * B.lock) || since >= iv * 1.5) {
      if (S.order) { MUS.ord = (MUS.ord + 1) % S.order.length; MUS.frame = S.order[MUS.ord]; }
      else MUS.frame = (MUS.frame + 1) % n;
      MUS.lastStep = t; MUS.bounce = 1;
    }
  }
  MUS.bounce = Math.max(0, MUS.bounce - dt / 260);
  const amp = S.mode === 'script' ? 6 : S.sheet === 'cross' ? 12 : S.sheet === 'waist' ? 6 : 0; // toe-bounce
  MUS.step = { sheet: S.sheet, f: MUS.frame, lift: Math.sin(MUS.bounce * Math.PI) * amp * (.5 + MUS.energy), section: S };
}
// Joe's victory song: the original game's track on a plain looping <audio>
const JOE_MUSIC = { el: null };
function joeMusicPlay() {
  if (!JOE_MUSIC.el) { JOE_MUSIC.el = new Audio(JOE_DIRS[0] + JOE_SONG); JOE_MUSIC.el.loop = true; JOE_MUSIC.el.onerror = () => { JOE_MUSIC.el.src = JOE_DIRS[1] + JOE_SONG; }; }
  JOE_MUSIC.el.currentTime = 0; JOE_MUSIC.el.muted = !SFX.on; JOE_MUSIC.el.play().catch(() => {});
}
function joeMusicStop() { if (JOE_MUSIC.el) JOE_MUSIC.el.pause(); }
function setSound(on) {
  SFX.on = on;
  if (MUS.gain) MUS.gain.gain.setTargetAtTime(on ? 1 : 0, MUS.ctx.currentTime, .02);
  if (JOE_MUSIC.el) JOE_MUSIC.el.muted = !on;
}

/* ---------- 7. characters ---------- */
// move timings in 60 Hz ticks; lane = vertical band hit, as shares of STAND_H above the feet
// (punches + specials are high: crouching ducks them; kicks are low: blocking is the answer).
// Melee reach is a gameplay number (px in front of the feet), matched between the two so neither art size wins.
const CHARS = {
  rokaia: {
    name: 'ROKAIA', portrait: 'ref1', color: '#ff5468', style: 'Ponytail fighter',
    moves: [['J', 'Punch'], ['K', 'Ponytail snap'], ['L', 'Ponytail whip (any range)']],
    atk: {
      punch:   { start: 6, active: 5, rec: 12, dmg: 8, lane: [.55, .9], stun: 16, reach: () => 185 },
      kick:    { start: 9, active: 5, rec: 15, dmg: 9, lane: [.35, .8], stun: 18, reach: () => 235 }, // ponytail snap: mid, still hits a crouch
      special: { start: 20, active: 6, rec: 24, dmg: 18, lane: [.62, .98], stun: 30, knock: true, cool: 240, whip: true }
    }
  },
  joe: {
    name: 'JOE', portrait: 'joeSel', color: '#ffb000', style: 'Fire ninja',
    moves: [['J', 'Punch'], ['K', 'Kick'], ['L', 'Fireball']],
    atk: {
      punch:   { start: 6, active: 5, rec: 12, dmg: 8, lane: [.55, .9], stun: 16, reach: () => 190 },
      kick:    { start: 8, active: 5, rec: 16, dmg: 10, lane: [.1, .6], stun: 18, reach: () => 225 },
      special: { start: 16, active: 1, rec: 24, dmg: 14, cool: 240, fire: true, knock: true, stun: 28 }
    }
  }
};
const whipReach = (F, s) => F && F.zone ? -F.ax + F.zone.split + (F.zone.tip - F.zone.split) * s : 150;
// stretch factor so the ponytail tip lands on a target `dist` px in front of her
function whipStretch(F, dist) {
  if (!F || !F.zone) return 1;
  const base = -F.ax + F.zone.split;
  return clamp((dist - BODY * .4 - base) / Math.max(1, F.zone.tip - F.zone.split), WHIP_STRETCH[0], WHIP_STRETCH[1]);
}

class Fighter {
  constructor(id, idx, cpu) {
    this.id = id; this.C = CHARS[id]; this.idx = idx; this.cpu = cpu; this.wins = 0;
    this.reset();
  }
  reset() {
    Object.assign(this, { x: this.idx ? 900 : 380, y: GROUND, vx: 0, vy: 0, facing: this.idx ? -1 : 1, hp: 100, shown: 100,
      atk: null, stun: 0, down: 0, ko: false, cool: 0, flash: 0, walkPh: 0, blocking: false, crouch: false, walking: 0,
      ai: { t: 0, cmd: {} }, win: false, hitT: 0 });
  }
  get onGround() { return this.y >= GROUND; }
  hurt() { const top = this.crouch && this.onGround ? STAND_H * .5 : STAND_H; return { x1: this.x - BODY, x2: this.x + BODY, y1: this.y - top, y2: this.y }; }
}

/* ---------- 8. input ---------- */
const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  KeyJ: 'punch', KeyK: 'kick', KeyL: 'special', KeyI: 'block', ShiftLeft: 'block', ShiftRight: 'block'
};
const IN = { held: {}, pressed: {}, touch: {} };
const held = k => !!(IN.held[k] || IN.touch[k]);
const pressed = k => { const p = IN.pressed[k]; IN.pressed[k] = false; return !!p; };
addEventListener('keydown', e => {
  sfxCtx();
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  const a = KEYMAP[e.code];
  if (a && !IN.held[a]) IN.pressed[a] = true;
  if (a) IN.held[a] = true;
  if (!e.repeat) menuKey(e.code);
});
addEventListener('keyup', e => { const a = KEYMAP[e.code]; if (a) IN.held[a] = false; });
addEventListener('blur', () => { IN.held = {}; IN.touch = {}; });

/* ---------- 9. game state ---------- */
const G = {
  scene: 'loading', load: 0, error: null, t: 0, focus: 0, help: false, paused: false,
  pick: 0, picked: -1, pickT: 0, p: null, c: null, round: 1, phase: 'intro', phaseT: 0, timer: ROUND_TIME,
  projectiles: [], sparks: [], popups: [], shake: 0, slow: 0, banner: null, winner: null, vt: 0
};
const ROSTER = ['rokaia', 'joe'];
function goMenu() { musicStop(); joeMusicStop(); G.scene = 'menu'; G.focus = 0; G.help = false; G.paused = false; showTouch(false); }
function goSelect() { musicStop(); joeMusicStop(); G.scene = 'select'; G.picked = -1; G.paused = false; showTouch(false); loadSong(); }
function startMatch(id) {
  const cpuId = ROSTER.find(r => r !== id);
  G.p = new Fighter(id, 0, false); G.c = new Fighter(cpuId, 1, true);
  G.round = 1; G.scene = 'fight'; G.paused = false;
  startRound();
  showTouch(IS_TOUCH);
}
function startRound() {
  G.p.reset(); G.c.reset();
  IN.pressed = {};                                   // a key used in the menus doesn't fire an attack
  G.projectiles = []; G.sparks = []; G.popups = [];
  G.phase = 'intro'; G.phaseT = 0; G.timer = ROUND_TIME; G.slow = 0;
  G.banner = { text: `ROUND ${G.round}`, t: 0, len: 80 };
  sfx.bell();
}
function endRound(winner) {
  if (G.phase !== 'fight') return;
  G.phase = 'ko'; G.phaseT = 0; G.winner = winner;
  G.slow = 50; G.shake = 16;
  G.banner = { text: winner ? 'K.O.' : 'DRAW', t: 0, len: 150, red: true };
  sfx.ko();
}
function startVictory(w) {
  G.scene = 'victory'; G.vt = 0; G.focus = 0; G.winner = w; showTouch(false);
  const l = w === G.p ? G.c : G.p;
  w.x = W * .4; w.y = GROUND; w.facing = 1; l.x = W * .68; l.y = GROUND; l.facing = -1;
  if (w.id === 'rokaia') musicPlay(0); else joeMusicPlay();
}

/* ---------- 10. fighting ---------- */
function control(f, o) {
  if (!f.cpu) return { left: held('left'), right: held('right'), up: pressed('up'), down: held('down'), punch: pressed('punch'), kick: pressed('kick'), special: pressed('special'), block: held('block') };
  return cpuThink(f, o);
}
// CPU: re-decides every few ticks — close the distance, poke, block what it sees coming, duck fireballs/whips
function cpuThink(f, o) {
  const A = f.ai, dist = Math.abs(o.x - f.x), toward = o.x > f.x ? 'right' : 'left', away = toward === 'right' ? 'left' : 'right';
  const cmd = { left: false, right: false, up: false, down: false, punch: false, kick: false, special: false, block: false };
  if (A.t-- > 0) { Object.assign(cmd, A.hold); return cmd; }
  A.t = 8 + (Math.random() * 12 | 0); A.hold = {};
  const threat = G.projectiles.some(p => p.owner === o && Math.sign(f.x - p.x) === Math.sign(p.vx) && Math.abs(f.x - p.x) < 420)
    || (o.atk && o.atk.type === 'special' && o.atk.t < o.C.atk.special.start);
  const reach = Math.min(f.C.atk.punch.reach(), f.C.atk.kick.reach()) + BODY;
  const r = Math.random();
  if (threat && r < .7) { A.hold = { down: true }; A.t = 22; }
  else if (o.atk && o.atk.type !== 'special' && dist < 300 && r < .45) { A.hold = { block: true }; A.t = 16; }
  else if (dist > reach + 30) {
    if (f.cool <= 0 && r < .22) cmd.special = true;
    else if (r < .08) { cmd.up = true; A.hold = { [toward]: true }; }
    else A.hold = { [toward]: true };
  } else {
    if (r < .42) cmd.punch = true;
    else if (r < .74) cmd.kick = true;
    else if (r < .86) { A.hold = { block: true }; A.t = 14; }
    else if (r < .93 && f.cool <= 0) cmd.special = true;
    else A.hold = { [away]: true };
  }
  Object.assign(cmd, A.hold);
  return cmd;
}
function startAttack(f, type) { f.atk = { type, t: 0, hit: false }; if (type !== 'special') sfx.whoosh(); }
function updateFighter(f, o) {
  if (f.flash > 0) f.flash--;
  if (f.cool > 0) f.cool--;
  f.blocking = false; f.walking = 0;
  const canAct = G.phase === 'fight' && !f.ko;
  if (f.ko) { /* falls, stays down */ }
  else if (f.down > 0) { f.down--; f.crouch = false; }
  else if (f.stun > 0) f.stun--;
  else if (f.atk) {
    const a = f.atk, d = f.C.atk[a.type];
    a.t++;
    if (f.onGround) f.vx = 0;
    if (a.type === 'special' && d.fire && a.t === d.start) fireball(f);
    if (a.type === 'special' && d.whip && a.t === d.start) sfx.whip();
    if (!d.fire && !a.hit && a.t > d.start && a.t <= d.start + d.active) tryHit(f, o, a, d); // the fireball hits on its own
    if (a.t >= d.start + d.active + d.rec) f.atk = null;
  } else if (canAct) {
    const c = control(f, o);
    if (f.onGround) f.facing = o.x >= f.x ? 1 : -1;
    f.crouch = f.onGround && c.down;
    if (c.special && f.cool <= 0 && f.onGround) { startAttack(f, 'special'); f.cool = f.C.atk.special.cool; f.crouch = false; }
    else if (c.punch) { startAttack(f, 'punch'); f.crouch = false; }
    else if (c.kick) { startAttack(f, 'kick'); f.crouch = false; }
    else if (c.block && f.onGround) { f.blocking = true; f.vx = 0; }
    else {
      const dir = f.crouch ? 0 : (c.right ? 1 : 0) - (c.left ? 1 : 0);
      if (f.onGround) { f.vx = dir * (dir === f.facing ? 6 : 4.6); f.walking = dir; if (dir) f.walkPh += Math.abs(f.vx) * .011 * (dir === f.facing ? 1 : -1); } // ~9 walk frames / s
      if (c.up && f.onGround) { f.vy = -21; f.vx = dir * 6.5; sfx.whoosh(); }
    }
  } else if (f.onGround) f.vx *= .8;
  // physics
  if (!f.onGround || f.vy < 0) f.vy += 1.1;
  f.x += f.vx; f.y += f.vy;
  if (f.y >= GROUND) { if (f.vy > 8) shake(f.ko ? 10 : 3); f.y = GROUND; f.vy = 0; if (f.ko || f.down) f.vx *= .7; }
  f.x = clamp(f.x, 90, W - 90);
  f.shown = f.shown > f.hp ? Math.max(f.hp, f.shown - .4) : f.hp;
}
function separate(a, b) {
  if (a.ko || b.ko || Math.abs(a.y - b.y) > STAND_H * .5) return;
  const d = b.x - a.x, min = 2 * BODY + 10;
  if (Math.abs(d) < min) { const push = (min - Math.abs(d)) / 2 * (Math.sign(d) || 1); a.x = clamp(a.x - push, 90, W - 90); b.x = clamp(b.x + push, 90, W - 90); }
}
// melee / whip hit test: horizontal reach in front of the attacker + vertical lane overlap with the target's hurtbox
function tryHit(f, o, a, d) {
  const dist = (o.x - f.x) * f.facing;
  if (dist < 0) return;
  let reach;
  if (d.whip) { const F = SPR.whip1.frames[3]; reach = whipReach(F, whipStretch(F, dist)); }
  else reach = d.reach();
  const hb = o.hurt(), top = f.y - STAND_H * d.lane[1], bot = f.y - STAND_H * d.lane[0];
  if (dist - BODY > reach || bot < hb.y1 || top > hb.y2) return;
  a.hit = true;
  strike(f, o, d, f.x + f.facing * Math.min(reach, dist - BODY * .6), (Math.max(top, hb.y1) + Math.min(bot, hb.y2)) / 2);
}
function strike(f, o, d, x, y) {
  if (o.ko || G.phase !== 'fight') return;
  const guarded = o.blocking && Math.sign(f.x - o.x) === o.facing;
  if (guarded) {
    o.hp = Math.max(0, o.hp - Math.ceil(d.dmg * .15)); o.vx = -o.facing * 4; o.flash = 4;
    burst(x, y, ['#9fd4ff', '#ffffff'], 10); sfx.block(); popup('BLOCK', o.x, o.y - STAND_H - 20, '#9fd4ff', 30);
  } else {
    o.hp = Math.max(0, o.hp - d.dmg); o.atk = null; o.flash = 8; o.hitT = G.t;
    o.stun = d.stun; o.vx = -o.facing * (d.knock ? 9 : 5);
    if (d.knock) { o.vy = -9; o.down = 46; o.stun = 0; }
    burst(x, y, d.knock ? ['#fff3c4', '#ff5468', '#ffb000'] : ['#ffffff', '#ffd25a', '#ff5468'], d.knock ? 30 : 16);
    d.knock ? sfx.heavy() : sfx.hit(); shake(d.knock ? 12 : 5);
    popup(d.whip ? 'WHIPPED!' : d.fire ? 'BURNED!' : `-${d.dmg}`, o.x, o.y - STAND_H - 20, d.knock ? '#ffd25a' : '#ffffff', d.knock ? 44 : 30);
  }
  if (o.hp <= 0) { o.ko = true; o.vy = -12; o.vx = -o.facing * 8; o.stun = 0; o.down = 0; endRound(f); }
}
function fireball(f) {
  const F = SPR.jPunch.frames[0];
  G.projectiles.push({ owner: f, x: f.x + f.facing * (F.hand[0] - F.ax + 10), y: f.y - STAND_H * .68, vx: f.facing * 11, t: 0, d: f.C.atk.special });
  sfx.fire();
}
function updateProjectiles() {
  for (const p of G.projectiles) {
    p.t++; p.x += p.vx;
    if (Math.random() < .8) G.sparks.push({ x: p.x - p.vx * rand(0, 1.5), y: p.y + rand(-16, 16), vx: -p.vx * .1, vy: rand(-1.2, .4), life: rand(240, 420), max: 420, c: Math.random() < .5 ? '#ff6a1a' : '#ffc040', size: rand(4, 9), glow: true });
    const o = p.owner === G.p ? G.c : G.p, hb = o.hurt();
    if (!o.ko && p.x + 22 > hb.x1 && p.x - 22 < hb.x2 && p.y + 22 > hb.y1 && p.y - 22 < hb.y2) { p.dead = true; strike(p.owner, o, p.d, p.x, p.y); }
    if (p.x < -60 || p.x > W + 60) p.dead = true;
  }
  G.projectiles = G.projectiles.filter(p => !p.dead);
}
function fightTick() {
  const { p, c } = G;
  G.phaseT++;
  if (G.phase === 'intro') {
    if (G.phaseT === 80) { G.banner = { text: 'FIGHT!', t: 0, len: 50, red: true }; sfx.bell(); }
    if (G.phaseT >= 110) G.phase = 'fight';
  } else if (G.phase === 'fight') {
    if (G.phaseT % 60 === 0) G.timer = Math.max(0, G.timer - 1);
    if (G.timer <= 0) endRound(p.hp === c.hp ? null : p.hp > c.hp ? p : c);
  } else if (G.phase === 'ko') {
    if (G.phaseT === 100 && G.winner) { G.winner.wins++; G.winner.win = true; G.banner = { text: `${G.winner.C.name} WINS`, t: 0, len: 110 }; }
    if (G.phaseT >= 230) {
      const champ = [p, c].find(f => f.wins >= ROUNDS_TO_WIN);
      if (champ) return startVictory(champ);
      G.round++; startRound();
    }
  }
  updateFighter(p, c); updateFighter(c, p); separate(p, c);
  updateProjectiles();
}

/* ---------- 11. effects ---------- */
function shake(m) { G.shake = Math.max(G.shake, m); }
function burst(x, y, colors, n) {
  for (let i = 0; i < n; i++) { const a = rand(0, Math.PI * 2), v = rand(3, 11); G.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, life: rand(220, 480), max: 480, c: colors[i % colors.length], size: 4, grav: true }); }
}
function popup(text, x, y, c, size) { G.popups.push({ text, x, y, c, size, life: 800, max: 800 }); }
function updateFx(dt) {
  for (const s of G.sparks) { s.x += s.vx * dt / 16; s.y += s.vy * dt / 16; if (s.grav) s.vy += .25 * dt / 16; s.life -= dt; }
  G.sparks = G.sparks.filter(s => s.life > 0);
  for (const p of G.popups) { p.y -= .05 * dt; p.life -= dt; }
  G.popups = G.popups.filter(p => p.life > 0);
  G.shake = Math.max(0, G.shake - dt * .04);
  if (G.banner) { G.banner.t += dt / TICK; if (G.banner.t > G.banner.len) G.banner = null; }
}

/* ---------- 12. poses: game state -> [sheet, frame] ---------- */
function rokaiaPose(f) {
  const a = f.atk;
  if (f.ko) return f.onGround ? { s: 'ko', i: f.vy === 0 && Math.abs(f.vx) < .5 ? 2 : 1 } : { s: 'ko', i: 0 };
  if (f.down > 0) return f.onGround ? { s: f.down > 18 ? 'ko' : 'crouch', i: f.down > 18 ? 1 : 1 } : { s: 'ko', i: 0 };
  if (f.stun > 0) { const L = 16; return { s: 'hit', i: f.stun > L * .6 ? 0 : f.stun > L * .25 ? 1 : 2 }; }
  if (a) {
    const d = f.C.atk[a.type], t = a.t;
    if (a.type === 'punch') return { s: 'punch', i: t < d.start * .5 ? 0 : t <= d.start ? 1 : t <= d.start + d.active ? 2 : 3 };
    if (a.type === 'kick') return t <= d.start ? { s: 'whip1', i: 1 } : t <= d.start + d.active + 4 ? { s: 'whip1', i: 2 } : { s: 'crouch', i: 0 };
    // ponytail whip: wind up, flick, arc, full extension stretched to the opponent; recoil back to her stance
    const dist = Math.abs(G.c && G.p ? (f === G.p ? G.c : G.p).x - f.x : 400), s = whipStretch(SPR.whip1.frames[3], dist);
    if (t < 7) return { s: 'whip1', i: 0 };
    if (t < 14) return { s: 'whip1', i: 1 };
    if (t <= d.start) return { s: 'whip1', i: 2, stretch: lerp(1, s, .6) };
    if (t <= d.start + d.active) return { s: 'whip1', i: 3, stretch: s };
    const r = (t - d.start - d.active) / d.rec, W2 = SPR.whip2;
    if (W2) { const n = W2.frames.length, i = clamp(n - 1 - Math.floor(r * n), 0, n - 1); return { s: 'whip2', i, stretch: lerp(1, s, i / Math.max(1, n - 1) * .85) }; }
    return r < .45 ? { s: 'whip1', i: 2, stretch: lerp(1, s, .6) } : { s: 'whip1', i: 1 };
  }
  if (!f.onGround) return { s: 'jump', i: f.vy < -8 ? 1 : f.vy < 8 ? 2 : 3 };
  if (f.blocking) return { s: 'block', i: 1 };
  if (f.crouch) return { s: 'crouch', i: 2 };
  if (f.walking) return { s: 'walk', i: ((Math.floor(f.walkPh * 2.2) % 5) + 5) % 5 };
  if (f.win) return { s: 'sweep', i: 4 };
  return { s: 'crouch', i: 0, breathe: true };
}
function joePose(f) {
  const a = f.atk;
  if (f.ko || f.down > 0) { // knocked back onto his knees, slumped backwards (his art has no lying pose)
    const fall = f.ko ? Math.min(1, (G.t - f.hitT) / 18) : f.down > 14 ? 1 : f.down / 14;
    return { s: 'jCrouch', i: 0, rot: -.16 * fall, dim: f.ko };
  }
  if (f.stun > 0) return { s: 'jIdle', i: 0, rot: -.14 * Math.min(1, f.stun / 8) };
  if (a) {
    const d = f.C.atk[a.type], t = a.t;
    if (a.type === 'special') return t < d.start ? { s: 'jCrouch', i: 0, charge: t / d.start } : { s: 'jPunch', i: 0 };
    const key = a.type === 'punch' ? 'jPunch' : 'jKick';
    return t < d.start * .5 || t > d.start + d.active + d.rec * .6 ? { s: 'jIdle', i: 0 } : { s: key, i: 0 };
  }
  if (!f.onGround) return { s: 'jCrouch', i: 0 };
  if (f.crouch) return { s: 'jCrouch', i: 0 };
  if (f.walking) return { s: 'jIdle', i: 0, dy: -Math.abs(Math.sin(f.walkPh * 3)) * 8 };
  if (f.win) return { s: G.t % 50 < 25 ? 'jPunch' : 'jIdle', i: 0 };
  return { s: 'jIdle', i: 0, breathe: true };
}
const poseOf = f => f.id === 'rokaia' ? rokaiaPose(f) : joePose(f);

/* ---------- 13. rendering ---------- */
const cv = $('stage'), ctx = cv.getContext('2d');
let BG = null;
function buildBackground() {
  const c = mk(W, H), g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, GROUND);
  sky.addColorStop(0, '#120d1c'); sky.addColorStop(.6, '#22162e'); sky.addColorStop(1, '#3a1a2c');
  g.fillStyle = sky; g.fillRect(0, 0, W, GROUND);
  const moon = g.createRadialGradient(W * .72, 170, 10, W * .72, 170, 150);
  moon.addColorStop(0, 'rgba(255,214,170,.55)'); moon.addColorStop(.45, 'rgba(255,120,110,.15)'); moon.addColorStop(1, 'rgba(255,120,110,0)');
  g.fillStyle = moon; g.fillRect(0, 0, W, GROUND);
  g.fillStyle = 'rgba(255,220,190,.85)'; g.beginPath(); g.arc(W * .72, 170, 58, 0, 7); g.fill();
  for (let i = 0; i < 6; i++) { g.fillStyle = 'rgba(10,6,14,.55)'; g.fillRect(60 + i * 230, 90, 26, GROUND - 90); }
  g.fillStyle = 'rgba(10,6,14,.7)'; g.fillRect(0, 70, W, 26);
  for (let i = 0; i < 5; i++) {
    const x = 175 + i * 230, y = 150;
    const gl = g.createRadialGradient(x, y, 4, x, y, 60); gl.addColorStop(0, 'rgba(255,90,80,.5)'); gl.addColorStop(1, 'rgba(255,90,80,0)');
    g.fillStyle = gl; g.fillRect(x - 60, y - 60, 120, 120);
    g.fillStyle = '#c92a3c'; g.beginPath(); g.ellipse(x, y, 16, 22, 0, 0, 7); g.fill();
    g.fillStyle = '#1a0c10'; g.fillRect(x - 10, y - 26, 20, 5); g.fillRect(x - 10, y + 21, 20, 5);
  }
  const floor = g.createLinearGradient(0, GROUND, 0, H);
  floor.addColorStop(0, '#3a2430'); floor.addColorStop(1, '#140c12');
  g.fillStyle = floor; g.fillRect(0, GROUND, W, H - GROUND);
  g.strokeStyle = 'rgba(255,190,170,.07)'; g.lineWidth = 2;
  for (let x = -200; x < W + 200; x += 90) { g.beginPath(); g.moveTo(x, GROUND); g.lineTo(x + (x - W / 2) * .5, H); g.stroke(); }
  g.fillStyle = 'rgba(255,170,150,.25)'; g.fillRect(0, GROUND, W, 2);
  const vig = g.createRadialGradient(W / 2, H / 2, H * .35, W / 2, H / 2, H * .95);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
  g.fillStyle = vig; g.fillRect(0, 0, W, H);
  return c;
}
// one frame, feet at (x, y). stretch: the ponytail band in front of her is stretched horizontally (the whip);
// rot: rotation around the feet (falling over); flash: brightened copy on top (hit flash)
function drawFrame(S, F, x, y, o = {}) {
  if (!S || !F) return;
  const stretch = o.stretch || 1;
  ctx.save();
  ctx.imageSmoothingEnabled = false;          // crisp: frames are pre-resized, drawn 1:1
  ctx.translate(Math.round(x), Math.round(y));
  if (o.flip) ctx.scale(-1, 1);
  if (o.rot) { ctx.translate(0, -Math.abs(Math.sin(o.rot)) * F.ax); ctx.rotate(o.rot); } // keep the body on the floor as it tips
  if (o.scale) ctx.scale(o.scale, o.scale);
  if (o.alpha != null) ctx.globalAlpha = o.alpha;
  const ox = Math.round(-F.ax), oy = -F.h, Z = F.zone;
  const draw = () => {
    if (stretch !== 1 && Z) {
      const sp = Z.split, bd = Z.band, rw = F.w - sp;
      ctx.drawImage(S.strip, F.sX, F.sY, sp, F.h, ox, oy, sp, F.h);
      ctx.drawImage(S.strip, F.sX + sp, F.sY + bd, rw, F.h - bd, ox + sp, oy + bd, rw, F.h - bd);
      ctx.drawImage(S.strip, F.sX + sp, F.sY, rw, bd, ox + sp, oy, Math.round(rw * stretch), bd);
    } else ctx.drawImage(S.strip, F.sX, F.sY, F.w, F.h, ox, oy, F.w, F.h);
  };
  draw();
  if (o.flash) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = o.flash; draw(); }
  ctx.restore();
}
function shadow(x, w, a = .45) {
  const g = ctx.createRadialGradient(x, GROUND + 4, 4, x, GROUND + 4, w);
  g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save(); ctx.translate(x, GROUND + 4); ctx.scale(1, .18); ctx.translate(-x, -(GROUND + 4));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, GROUND + 4, w, 0, 7); ctx.fill(); ctx.restore();
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function title(text, x, y, size, fill = '#fff', stroke = '#3a0610', align = 'center') {
  ctx.save(); ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`; ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(4, size * .12); ctx.strokeStyle = stroke; ctx.strokeText(text, x, y);
  ctx.fillStyle = fill; ctx.fillText(text, x, y); ctx.restore();
}
function drawFighter(f, now) {
  const P = poseOf(f), S = SPR[P.s], F = S && S.frames[Math.min(P.i, S.frames.length - 1)];
  if (!F) return;
  const air = GROUND - f.y;
  shadow(f.x, (P.rot ? F.h * .5 : F.w * .42), .45 * Math.max(.3, 1 - air / 320));
  let y = f.y + (P.dy || 0);
  if (P.breathe) y += Math.round(Math.sin(now / 420 + f.idx * 2) * 2);
  drawFrame(S, F, f.x, y, { flip: f.facing < 0, stretch: P.stretch, rot: P.rot, flash: f.flash > 0 ? .5 : 0, alpha: P.dim ? .85 : null });
  if (P.charge) { // Joe's fireball gathering in his fists
    const hx = f.x + f.facing * 60, hy = f.y - STAND_H * .62, r = 10 + 26 * P.charge;
    const gl = ctx.createRadialGradient(hx, hy, 1, hx, hy, r * 2);
    gl.addColorStop(0, 'rgba(255,245,200,.95)'); gl.addColorStop(.4, 'rgba(255,140,30,.7)'); gl.addColorStop(1, 'rgba(255,60,0,0)');
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(hx, hy, r * 2, 0, 7); ctx.fill(); ctx.restore();
  }
  if (f.blocking) { // guard glow in front of the fighter
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = 'rgba(120,200,255,.55)'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.ellipse(f.x + f.facing * 70, f.y - STAND_H * .55, 26, STAND_H * .34, 0, f.facing > 0 ? -1.2 : Math.PI - 1.2, f.facing > 0 ? 1.2 : Math.PI + 1.2); ctx.stroke(); ctx.restore();
  }
}
function drawProjectiles() {
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const p of G.projectiles) {
    const R = 30 + Math.sin(p.t * .5) * 4, gl = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R * 1.8);
    gl.addColorStop(0, 'rgba(255,255,225,1)'); gl.addColorStop(.25, 'rgba(255,200,70,.95)'); gl.addColorStop(.6, 'rgba(255,70,15,.75)'); gl.addColorStop(1, 'rgba(150,0,0,0)');
    ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(p.x, p.y, R * 1.8, 0, 7); ctx.fill();
  }
  ctx.restore();
}
function drawFx() {
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const s of G.sparks) { ctx.globalAlpha = clamp(s.life / s.max, 0, 1); ctx.fillStyle = s.c; const z = s.size || 4; ctx.fillRect(s.x - z / 2, s.y - z / 2, z, z); }
  ctx.restore();
  for (const p of G.popups) {
    const a = clamp(p.life / p.max * 1.6, 0, 1);
    ctx.save(); ctx.globalAlpha = a; title(p.text, p.x, p.y, p.size, p.c, '#1a0508'); ctx.restore();
  }
}
// HUD: portraits, health bars, round-win pips, timer, special readiness
const AVATAR = {};
function avatar(id) {
  if (AVATAR[id]) return AVATAR[id];
  const S = SPR[CHARS[id].portrait]; if (!S) return null;
  const F = S.frames[0], c = mk(84, 84), g = c.getContext('2d'), s = 84 / Math.min(F.w, F.h * .62);
  g.imageSmoothingQuality = 'high';
  g.drawImage(S.strip, F.sX, F.sY, F.w, F.h, (84 - F.w * s) / 2, id === 'joe' ? -6 : -4, F.w * s, F.h * s);
  return (AVATAR[id] = c);
}
function drawHud() {
  for (const f of [G.p, G.c]) {
    const left = f.idx === 0, bx = left ? 128 : W - 128 - 440, by = 34;
    const av = avatar(f.id), ax = left ? 24 : W - 24 - 88;
    ctx.save();
    ctx.fillStyle = '#0c0810'; roundRect(ax, 20, 88, 88, 10); ctx.fill();
    if (av) { ctx.save(); roundRect(ax + 2, 22, 84, 84, 9); ctx.clip(); ctx.drawImage(av, ax + 2, 22); ctx.restore(); }
    ctx.strokeStyle = f.C.color; ctx.lineWidth = 3; roundRect(ax, 20, 88, 88, 10); ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,.6)'; roundRect(bx - 4, by - 4, 448, 34, 8); ctx.fill();
    const w = 440, hpW = w * f.hp / 100, shW = w * f.shown / 100;
    ctx.fillStyle = '#5a0a14'; ctx.fillRect(bx, by, w, 26);
    ctx.fillStyle = '#ffd25a'; ctx.fillRect(left ? bx : bx + w - shW, by, shW, 26);
    const hg = ctx.createLinearGradient(0, by, 0, by + 26); hg.addColorStop(0, '#7dff9a'); hg.addColorStop(1, '#1f9a48');
    ctx.fillStyle = f.hp > 30 ? hg : '#ff5468'; ctx.fillRect(left ? bx : bx + w - hpW, by, hpW, 26);
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2; ctx.strokeRect(bx, by, w, 26);
    title(f.C.name + (f.cpu ? ' · CPU' : ''), left ? bx : bx + w, by + 48, 24, '#fff', '#000', left ? 'left' : 'right');
    for (let k = 0; k < ROUNDS_TO_WIN; k++) {
      const px = left ? bx + w - 14 - k * 26 : bx + 14 + k * 26;
      ctx.beginPath(); ctx.arc(px, by + 48, 9, 0, 7); ctx.fillStyle = f.wins > k ? '#ffc85a' : 'rgba(40,10,0,.85)'; ctx.fill();
      ctx.strokeStyle = '#ffcf5a'; ctx.lineWidth = 2; ctx.stroke();
    }
    const ready = f.cool <= 0, sx = left ? bx : bx + w - 160;
    ctx.fillStyle = ready ? (G.t % 40 < 20 ? 'rgba(211,38,58,.9)' : 'rgba(150,25,40,.9)') : 'rgba(60,60,60,.8)'; roundRect(sx, by + 66, 160, 22, 6); ctx.fill();
    if (!ready) { ctx.fillStyle = 'rgba(255,200,90,.6)'; ctx.fillRect(sx, by + 84, 160 * (1 - f.cool / f.C.atk.special.cool), 4); }
    ctx.fillStyle = ready ? '#fff' : '#aaa'; ctx.font = '700 13px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(ready ? `SPECIAL READY${f.cpu ? '' : ' [L]'}` : 'SPECIAL CHARGING', sx + 80, by + 77);
    ctx.restore();
  }
  ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.6)'; roundRect(W / 2 - 46, 18, 92, 70, 10); ctx.fill(); ctx.restore();
  title(String(G.timer).padStart(2, '0'), W / 2, 50, 46, G.timer <= 10 ? '#ff5468' : '#ffc85a', '#000');
  title(`ROUND ${G.round}`, W / 2, 104, 18, '#ffb070', '#000');
}
function drawBanner() {
  const b = G.banner; if (!b) return;
  const k = b.t / b.len, a = k < .15 ? k / .15 : k > .8 ? (1 - k) / .2 : 1, sc = 1 + .4 * Math.max(0, 1 - b.t / 10);
  ctx.save(); ctx.globalAlpha = clamp(a, 0, 1); ctx.translate(W / 2, H * .42); ctx.scale(sc, sc);
  title(b.text, 0, 0, 120, b.red ? '#ff5468' : '#ffc85a', '#1a0004');
  ctx.restore();
}

/* ---------- 14. menus (drawn on the canvas, mouse / touch / keyboard) ---------- */
let BUTTONS = [];
function button(label, x, y, w, h, action, focused) {
  BUTTONS.push({ x, y, w, h, action });
  ctx.save();
  ctx.fillStyle = focused ? '#d3263a' : 'rgba(24,16,30,.85)'; roundRect(x, y, w, h, 12); ctx.fill();
  ctx.strokeStyle = focused ? '#ffd0d6' : 'rgba(255,84,104,.55)'; ctx.lineWidth = focused ? 3 : 2; ctx.stroke();
  if (focused) { ctx.shadowColor = 'rgba(255,84,104,.8)'; ctx.shadowBlur = 24; ctx.stroke(); }
  ctx.restore();
  title(label, x + w / 2, y + h / 2 + 2, Math.min(34, h * .5), '#fff', '#2a0008');
}
function menuButtons() {
  if (G.scene === 'menu') return G.help ? [() => (G.help = false)] : [goSelect, () => (G.help = true), () => setSound(!SFX.on)];
  if (G.scene === 'victory') return [() => startMatch(G.p.id), goSelect, goMenu];
  if (G.scene === 'fight' && G.paused) return [() => (G.paused = false), goMenu];
  return [];
}
function menuKey(code) {
  if (G.scene === 'loading') return;
  if (G.scene === 'fight' && !G.paused) { if (code === 'Escape' || code === 'KeyP') G.paused = true; return; }
  if (G.scene === 'select') {
    if (G.picked >= 0) return;
    if (['ArrowLeft', 'KeyA', 'ArrowRight', 'KeyD'].includes(code)) { G.pick = 1 - G.pick; sfx.move(); }
    else if (['Enter', 'Space', 'KeyJ'].includes(code)) pickFighter(G.pick);
    else if (code === 'Escape') goMenu();
    return;
  }
  const acts = menuButtons(); if (!acts.length) return;
  if (['ArrowUp', 'KeyW', 'ArrowLeft', 'KeyA'].includes(code)) { G.focus = (G.focus + acts.length - 1) % acts.length; sfx.move(); }
  else if (['ArrowDown', 'KeyS', 'ArrowRight', 'KeyD'].includes(code)) { G.focus = (G.focus + 1) % acts.length; sfx.move(); }
  else if (['Enter', 'Space', 'KeyJ'].includes(code)) { sfx.pick(); acts[clamp(G.focus, 0, acts.length - 1)](); if (G.scene !== 'menu' || !G.help) G.focus = clamp(G.focus, 0, menuButtons().length - 1); }
  else if (code === 'Escape') { if (G.scene === 'fight') G.paused = false; else if (G.help) G.help = false; else if (G.scene === 'victory') goMenu(); }
}
function pickFighter(i) { G.pick = i; G.picked = i; G.pickT = 0; sfx.pick(); }
function toCanvas(e) { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; }
cv.addEventListener('pointerdown', e => {
  sfxCtx();
  const [x, y] = toCanvas(e);
  if (G.scene === 'select' && G.picked < 0) { const i = SELECT_CARDS.findIndex(c => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h); if (i >= 0) pickFighter(i); return; }
  if (G.scene === 'fight' && !G.paused && x > W / 2 - 50 && x < W / 2 + 50 && y < 90) { G.paused = true; return; } // tap the timer to pause
  const b = BUTTONS.findIndex(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  if (b >= 0) { G.focus = b; sfx.pick(); BUTTONS[b].action(); }
});
cv.addEventListener('pointermove', e => {
  const [x, y] = toCanvas(e);
  if (G.scene === 'select' && G.picked < 0) { const i = SELECT_CARDS.findIndex(c => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h); if (i >= 0 && i !== G.pick) { G.pick = i; sfx.move(); } }
  const b = BUTTONS.findIndex(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  if (b >= 0 && b !== G.focus) G.focus = b;
});

function drawMenu(now) {
  ctx.drawImage(BG, 0, 0);
  ctx.fillStyle = 'rgba(8,5,12,.45)'; ctx.fillRect(0, 0, W, H);
  // both fighters flank the title
  const L = SPR.ref1, R = SPR.joeSel;
  if (L) { const F = L.frames[0]; ctx.save(); ctx.globalAlpha = .9; ctx.drawImage(L.strip, F.sX, F.sY, F.w, F.h, 40, H - F.h * 1.1, F.w * 1.1, F.h * 1.1); ctx.restore(); }
  if (R) { const F = R.frames[0]; ctx.save(); ctx.globalAlpha = .55; const s = .95; ctx.drawImage(R.strip, F.sX, F.sY, F.w, F.h, W - F.w * s - 10, H - F.h * s, F.w * s, F.h * s); ctx.restore();
    const fade = ctx.createLinearGradient(W - F.w * s - 10, 0, W - F.w * s + 140, 0); fade.addColorStop(0, 'rgba(18,13,28,1)'); fade.addColorStop(1, 'rgba(18,13,28,0)');
    ctx.fillStyle = fade; ctx.fillRect(W - F.w * s - 12, H - F.h * s, 160, F.h * s); }
  title('MK ARCADE', W / 2, 130, 104, '#ffc85a', '#3a0610');
  title('ROKAIA  ·  JOE', W / 2, 205, 30, '#ffd0d6', '#1a0004');
  BUTTONS = [];
  if (G.help) {
    ctx.save(); ctx.fillStyle = 'rgba(12,8,18,.92)'; roundRect(W / 2 - 330, 250, 660, 380, 16); ctx.fill(); ctx.strokeStyle = '#ff5468'; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
    const rows = [['Move', 'A / D  or  ← / →'], ['Jump', 'W  or  ↑'], ['Crouch (ducks punches + specials)', 'S  or  ↓'], ['Punch', 'J'], ['Kick / ponytail snap (hits low)', 'K'], ['Special', 'L'], ['Block (hold)', 'I  or  Shift'], ['Pause', 'Esc  (or tap the timer)']];
    ctx.save(); ctx.font = '600 20px "Segoe UI", sans-serif'; ctx.textBaseline = 'middle';
    rows.forEach(([a, b], i) => { ctx.fillStyle = '#c7bedb'; ctx.textAlign = 'left'; ctx.fillText(a, W / 2 - 300, 290 + i * 34); ctx.fillStyle = '#ffc85a'; ctx.textAlign = 'right'; ctx.fillText(b, W / 2 + 300, 290 + i * 34); });
    ctx.restore();
    button('BACK', W / 2 - 110, 562, 220, 52, () => (G.help = false), true);
    return;
  }
  const items = [['ARCADE MODE', goSelect], ['HOW TO PLAY', () => (G.help = true)], [`SOUND: ${SFX.on ? 'ON' : 'OFF'}`, () => setSound(!SFX.on)]];
  items.forEach(([label, act], i) => button(label, W / 2 - 180, 290 + i * 86, 360, 66, act, G.focus === i));
  ctx.save(); ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.font = '15px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('↑ ↓ to choose · Enter to select · or click / tap', W / 2, H - 30); ctx.restore();
}
let SELECT_CARDS = [];
function drawSelect(now) {
  ctx.drawImage(BG, 0, 0);
  ctx.fillStyle = 'rgba(8,5,12,.55)'; ctx.fillRect(0, 0, W, H);
  title('CHOOSE YOUR FIGHTER', W / 2, 70, 58, '#ffc85a', '#3a0610');
  SELECT_CARDS = [];
  ROSTER.forEach((id, i) => {
    const C = CHARS[id], S = SPR[C.portrait], cw = 440, ch = 500, x = W / 2 - 470 + i * 500, y = 120, on = G.pick === i;
    SELECT_CARDS.push({ x, y, w: cw, h: ch });
    const lift = on ? -8 : 0, flashing = G.picked === i && G.pickT < 40 && G.pickT % 8 < 4;
    ctx.save();
    if (on) { ctx.shadowColor = C.color; ctx.shadowBlur = 40; }
    const bg = ctx.createLinearGradient(0, y, 0, y + ch); bg.addColorStop(0, '#2a1622'); bg.addColorStop(1, '#0c0810');
    ctx.fillStyle = bg; roundRect(x, y + lift, cw, ch, 18); ctx.fill();
    ctx.restore();
    if (S) {
      const F = S.frames[0], s = Math.min((cw - 30) / F.w, 380 / F.h), dw = F.w * s, dh = F.h * s;
      ctx.save(); roundRect(x + 4, y + lift + 4, cw - 8, ch - 8, 15); ctx.clip();
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(S.strip, F.sX, F.sY, F.w, F.h, x + (cw - dw) / 2, y + lift + 12, dw, dh);
      if (flashing) { ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(x, y, cw, ch); }
      ctx.restore();
    }
    ctx.save(); ctx.strokeStyle = on ? C.color : 'rgba(255,255,255,.18)'; ctx.lineWidth = on ? 4 : 2; roundRect(x, y + lift, cw, ch, 18); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.fillStyle = 'rgba(8,5,12,.82)'; ctx.fillRect(x + 4, y + lift + 390, cw - 8, 106); ctx.restore();
    title(C.name, x + cw / 2, y + lift + 420, 44, '#fff', '#2a0008');
    ctx.save(); ctx.fillStyle = '#c7bedb'; ctx.font = '600 16px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`${C.style} · ` + C.moves.map(m => `${m[0]} ${m[1]}`).join(' · '), x + cw / 2, y + lift + 466, cw - 30); ctx.restore();
    if (on) { title(G.picked === i ? 'READY!' : 'P1', x + cw / 2, y + lift - 2, 30, '#fff', '#d3263a'); }
  });
  ctx.save(); ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.font = '15px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('← → to choose · Enter / J to fight · Esc for the menu · or click / tap a fighter', W / 2, H - 40); ctx.restore();
  title('VS CPU', W / 2, 370, 40, '#ffc85a', '#3a0610');
}
function drawFight(now) {
  ctx.drawImage(BG, 0, 0);
  const order = [G.p, G.c].sort((a, b) => (a.atk ? 1 : 0) - (b.atk ? 1 : 0)); // the attacker draws on top
  for (const f of order) drawFighter(f, now);
  drawProjectiles(); drawFx(); drawHud(); drawBanner();
  BUTTONS = [];
  if (G.paused) {
    ctx.fillStyle = 'rgba(6,4,10,.7)'; ctx.fillRect(0, 0, W, H);
    title('PAUSED', W / 2, 220, 90, '#ffc85a');
    button('RESUME', W / 2 - 170, 300, 340, 64, () => (G.paused = false), G.focus === 0);
    button('MAIN MENU', W / 2 - 170, 384, 340, 64, goMenu, G.focus === 1);
  }
}
function drawVictory(now) {
  ctx.drawImage(BG, 0, 0);
  const w = G.winner, l = w === G.p ? G.c : G.p;
  // the loser lies on the floor; the winner celebrates centre stage
  if (l.id === 'rokaia') { const S = SPR.ko, F = S.frames[2]; shadow(l.x, F.w * .45); drawFrame(S, F, l.x, GROUND, { flip: true }); }
  else { const S = SPR.jCrouch, F = S.frames[0]; shadow(l.x, F.w * .45); drawFrame(S, F, l.x, GROUND, { flip: true, rot: -.16, alpha: .85 }); }
  if (w.id === 'rokaia') {
    const s = MUS.step;
    if (s) { const S = SPR[s.sheet], F = S.frames[Math.min(s.f, S.frames.length - 1)]; shadow(w.x, F.w * .42); drawFrame(S, F, w.x, GROUND - (s.lift || 0)); }
    drawMusicBar();
  } else {
    const pump = Math.floor(G.vt / 700) % 2, S = SPR[pump ? 'jPunch' : 'jIdle'], F = S.frames[0];
    shadow(w.x, F.w * .42); drawFrame(S, F, w.x, GROUND - Math.abs(Math.sin(G.vt / 350)) * 6);
  }
  title(`${w.C.name} WINS!`, W / 2, 120, 92, w.C.color, '#1a0004');
  BUTTONS = [];
  ['REMATCH', 'CHARACTER SELECT', 'MAIN MENU'].forEach((label, i) => button(label, W / 2 - 540 + i * 370, H - 92, 340, 60, menuButtons()[i], G.focus === i));
}
// Rokaia's routine overlay: "05.2s / 27.0s - Active: Victory 1 Crossover" over a progress bar
function drawMusicBar() {
  const t = musicTime(), s = MUS.step, bx = W / 2 - 330, by = 178;
  ctx.save(); ctx.fillStyle = 'rgba(8,6,12,.72)'; roundRect(bx, by, 660, 54, 10); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = '700 16px "Segoe UI", sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(MUS.ready ? `${t.toFixed(1).padStart(4, '0')}s / ${MUS.dur.toFixed(1)}s - Active: ${s ? s.section.label : ''}` : 'Loading her victory song…', bx + 14, by + 8);
  const px = bx + 14, pw = 632, py = by + 36;
  ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fillRect(px, py, pw, 8);
  SONG_MAP.forEach(S => { ctx.fillStyle = 'rgba(255,255,255,.45)'; ctx.fillRect(Math.round(px + pw * S.t0 / MUS.dur), py - 3, 1, 14); });
  ctx.fillStyle = '#ff5468'; ctx.fillRect(px, py, pw * clamp(t / MUS.dur, 0, 1), 8);
  ctx.restore();
}
function drawLoading() {
  ctx.drawImage(BG, 0, 0);
  ctx.fillStyle = 'rgba(8,5,12,.6)'; ctx.fillRect(0, 0, W, H);
  title('MK ARCADE', W / 2, H / 2 - 60, 90, '#ffc85a');
  if (G.error) {
    ctx.save(); ctx.fillStyle = '#ffb347'; ctx.font = '600 18px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(G.error, W / 2, H / 2 + 40, W - 120); ctx.restore(); return;
  }
  ctx.fillStyle = 'rgba(255,255,255,.12)'; roundRect(W / 2 - 200, H / 2 + 20, 400, 14, 7); ctx.fill();
  ctx.fillStyle = '#ff5468'; roundRect(W / 2 - 200, H / 2 + 20, 400 * G.load, 14, 7); ctx.fill();
  ctx.save(); ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.font = '15px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('Preparing the fighters…', W / 2, H / 2 + 62); ctx.restore();
}

/* ---------- 15. touch controls (phones / tablets) ---------- */
const IS_TOUCH = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
function showTouch(on) { $('touch').classList.toggle('show', !!on); }
document.querySelectorAll('#touch [data-k]').forEach(b => {
  const k = b.dataset.k, tap = ['up', 'punch', 'kick', 'special'].includes(k);
  const down = e => { e.preventDefault(); sfxCtx(); b.classList.add('on'); IN.touch[k] = true; if (tap) IN.pressed[k] = true; };
  const up = e => { e.preventDefault(); b.classList.remove('on'); IN.touch[k] = false; };
  b.addEventListener('pointerdown', down); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
});

/* ---------- 16. main loop ---------- */
let last = performance.now(), acc = 0;
function frame(now) {
  requestAnimationFrame(frame);                              // first: one bad frame never stops the game
  const dt = Math.min(100, now - last); last = now;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (G.scene === 'fight' && !G.paused) {
    acc += G.slow > 0 ? dt * .35 : dt;                         // K.O. slow motion
    while (acc >= TICK) { acc -= TICK; G.t++; if (G.slow > 0) G.slow--; fightTick(); if (G.scene !== 'fight') break; }
  } else { acc = 0; G.t++; }
  if (G.scene === 'select' && G.picked >= 0 && ++G.pickT > 48) startMatch(ROSTER[G.picked]);
  if (G.scene === 'victory') { G.vt += dt; if (G.winner.id === 'rokaia') musicUpdate(dt); }
  updateFx(dt);
  ctx.save();
  if (G.shake > 0) ctx.translate(rand(-G.shake, G.shake), rand(-G.shake, G.shake) * .6);
  if (G.scene === 'loading') drawLoading();
  else if (G.scene === 'menu') drawMenu(now);
  else if (G.scene === 'select') drawSelect(now);
  else if (G.scene === 'fight') drawFight(now);
  else if (G.scene === 'victory') drawVictory(now);
  ctx.restore();
}
(async function boot() {
  BG = buildBackground();
  freeze(BG).then(b => { BG = b; });
  requestAnimationFrame(t => { last = t; frame(t); });
  try {
    const missing = await loadAll(p => { G.load = p; });
    if (missing.length) { G.error = `Missing art: ${missing.join(', ')}`; return; }
    if (RAW_MODE) { G.error = 'Open the game from a web server (or GitHub Pages): the sprites need it to remove their white backgrounds.'; return; }
  } catch (e) { console.error(e); G.error = 'Could not prepare the sprites: ' + e.message; return; }
  goMenu();
})();
