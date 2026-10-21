'use strict';
/* =====================================================================
   ROKAIA — 2D canvas sprite animation engine
   Pipeline: load each PNG sheet -> key the white paper to transparency -> slice the frames (every pose is its own
   connected shape; grid sheets are read row by row) -> resize each sheet ONCE with high-quality smoothing ->
   draw 1:1 with imageSmoothingEnabled = false, so the art stays pixel-sharp on the stage.
   Playback runs on a timeline of steps: one frame each, lasting 1 / FPS, plus any heartbeat holds (victory poses)
   or extra time (hit-stop, recovery). The ponytail whip builds its timeline live from the opponent distance.
   ===================================================================== */

const W = 1280, H = 720;
const GROUND = 618;          // feet line on the stage
const STAND_H = 440;         // on-screen height of a standing pose
const HERO_X = 330;          // Rokaia's feet
const ASSET_DIRS = ['../assets/Rokaia/', './', 'assets/']; // first folder that has the file wins
const POCKET_MIN = 140;      // enclosed near-white areas at least this big are paper (between an arm and the waist)
const WHIP_STRETCH = [0.6, 2.4]; // how far the ponytail may compress / stretch to meet the opponent
const OPP_BODY = 62;         // opponent hurtbox half-width around their feet line
const SONG_FILE = 'victory rokaia.mp3'; // victory song (same folders as the sprites)
const SONG_LOOP_S = 27.0;    // the routine is one 27.0s loop: the song is time-stretched (pitch kept) to exactly this

/* ---------- 1. asset manifest (14 files) ---------- */
const MANIFEST = [
  { key: 'ref0',   file: 'rokaia_ref_0.png',    label: 'Full body reference' },
  { key: 'ref1',   file: 'rokaia_ref_1.png',    label: 'Close-up portrait' },
  { key: 'walk',   file: 'rokaia_walk.png',     label: 'Walk cycle' },
  { key: 'jump',   file: 'rokaia_jump.png',     label: 'Jump sequence' },
  { key: 'crouch', file: 'rokaia_crouch.png',   label: 'Crouch stance' },
  { key: 'punch',  file: 'rokaia_punch.png',    label: 'Punch attack' },
  { key: 'block',  file: 'rokaia_block.png',    label: 'Defensive guard' },
  { key: 'hit',    file: 'rokaia_hit.png',      label: 'Hit reaction' },
  { key: 'ko',     file: 'rokaia_ko.png',       label: 'Knockout' },
  { key: 'cross',  file: 'move1_crossover.png', label: 'Victory 1 · crossover' },
  { key: 'waist',  file: 'move1_batch2.png',    label: 'Victory 1 · hands on waist' },
  { key: 'whip1',  file: 'whip_batch1.png',     label: 'Ponytail whip · extension' },
  { key: 'whip2',  file: 'whip_batch2.png',     label: 'Ponytail whip · recoil' },
  { key: 'sweep',  file: 'move3_batch.png',     label: 'Victory 3 · arms sweep' },
  { key: 'joeSel', file: 'Joe selection.png',   label: 'Joe · character select', dirs: ['../WebGame/', './', 'WebGame/'] }
];

// How each sheet is cut and scaled. frames: pose count ('auto' = count the big shapes); rows: grid rows.
// Scale: h = on-screen height of the tallest frame (or of frame `fit`); scaleFrom = reuse another sheet's scale
// (sheets drawn at the same size share it, so poses match). Processed in this order.
const SHEETS = {
  walk:   { frames: 5, h: STAND_H },
  punch:  { frames: 4, scaleFrom: 'walk' },
  ko:     { frames: 3, scaleFrom: 'walk' },
  block:  { frames: 3, fit: 0, h: STAND_H },
  crouch: { frames: 3, scaleFrom: 'block' },
  hit:    { frames: 3, scaleFrom: 'block' },
  jump:   { frames: 4, scaleFrom: 'block' },
  cross:  { frames: 8, rows: 2, fit: 0, h: STAND_H * 1.02 },
  waist:  { frames: 8, rows: 2, fit: 0, h: STAND_H },
  sweep:  { frames: 5, fit: 0, h: STAND_H },
  whip1:  { frames: 4, scaleFrom: 'sweep' },
  whip2:  { frames: 'auto', scaleFrom: 'sweep' },
  ref0:   { frames: 1, h: STAND_H * 1.1 },
  ref1:   { frames: 1, h: 560, pockets: false, portrait: true },
  joeSel: { frames: 1, h: 540, key: false, portrait: true }   // photo card on a dark backdrop: shown as it is
};
// fighters on the select panel: portrait sheet + the stage view it opens
const FIGHTERS = [
  { id: 'rokaia', name: 'ROKAIA', sheet: 'ref1', anim: 'ref1', tag: 'Ponytail whip' },
  { id: 'joe', name: 'JOE', sheet: 'joeSel', anim: 'refJoe', tag: 'Fire ninja' }
];

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => t * t * (3 - 2 * t);
const rand = (a, b) => a + Math.random() * (b - a);
function mk(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }

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
  const rows = spec.rows || 1;
  let n = spec.frames === 'auto' ? Math.max(1, comps.filter(c => c.n >= comps[0].n * .2).length) : spec.frames;
  const big = comps.slice(0, n);
  if (!comps.length || big.length < n || big.some(c => c.n < big[0].n * .1)) return gridSlice(K, typeof n === 'number' ? n : 1, rows);
  // order: row by row (by vertical centre), then left to right
  big.sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const per = Math.ceil(n / rows), figs = [];
  for (let r = 0; r < rows; r++) figs.push(...big.slice(r * per, (r + 1) * per).sort((a, b) => a.x0 - b.x0));
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
//   ax = feet centre (anchor), hand = frontmost fist (15-50% height),
//   zone = the ponytail whip area: rows above 45% height, columns in front of the body's lower half
function cutFrame(K, x0, y0, x1, y1, mine, raw) {
  const { d, W: SW } = K;
  let w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (raw || !d) { // unkeyed fallback (opened from file://): the cell as it is
    const c = mk(w, h); c.getContext('2d').drawImage(K.cv, x0, y0, w, h, 0, 0, w, h);
    return { c, w, h, ax: w / 2, hand: [w * .8, h * .3], zone: null };
  }
  // trim to the opaque pixels
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
  return { c, w, h, ax: n ? sx / n : w / 2, hand: front(.15, .5), zone };
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
// frames -> one strip, resized once to k (screen px per file px). Frame metrics are returned in screen px.
function buildSheet(fr, k) {
  const pad = Math.ceil(4 / k) + 2, mh = Math.max(...fr.map(F => F.h));
  const src = mk(fr.reduce((s, F) => s + F.w + pad, pad), mh), sg = src.getContext('2d');
  let x = pad;
  const pos = fr.map(F => { sg.drawImage(F.c, x, mh - F.h); const p = x; x += F.w + pad; return p; });
  const strip = resizeHQ(src, src.width * k, src.height * k);
  const frames = fr.map((F, i) => ({
    sX: Math.round(pos[i] * k), sY: Math.round((mh - F.h) * k), w: Math.round(F.w * k), h: Math.round(F.h * k),
    ax: F.ax * k, hand: [F.hand[0] * k, F.hand[1] * k],
    zone: F.zone && { split: Math.round(F.zone.split * k), band: Math.round(F.zone.band * k), tip: F.zone.tip * k }
  }));
  return { strip, frames, k };
}

/* ---------- 4. load + process every sheet ---------- */
const SPR = {};          // key -> { strip, frames, k, url }
const ASSET_STATE = {};  // key -> 'ok' | 'missing'
let RAW_MODE = false;    // true when the page is opened from file:// (pixels can't be read: no keying)

async function loadAll(onProgress) {
  const loaded = {};
  await Promise.all(MANIFEST.map(async a => { loaded[a.key] = await loadImage(a.file, a.dirs); }));
  let done = 0;
  for (const key of Object.keys(SHEETS)) {
    const spec = SHEETS[key], L = loaded[key];
    onProgress(`Processing ${MANIFEST.find(m => m.key === key).file}…`, ++done / Object.keys(SHEETS).length);
    await new Promise(r => setTimeout(r, 0)); // let the loading text paint
    if (!L) { ASSET_STATE[key] = 'missing'; continue; }
    const img = L.img, cv = mk(img.naturalWidth, img.naturalHeight), g = cv.getContext('2d');
    g.drawImage(img, 0, 0);
    let K = { cv, W: cv.width, H: cv.height, d: null };
    if (!RAW_MODE) {
      try {
        const id = g.getImageData(0, 0, cv.width, cv.height);
        if (spec.key !== false) { keyWhite(id.data, cv.width, cv.height, spec.pockets !== false); g.putImageData(id, 0, 0); }
        K.d = id.data;
      }
      catch (e) { RAW_MODE = true; }
    }
    const fr = K.d ? sliceSheet(K, spec) : gridSlice(K, typeof spec.frames === 'number' ? spec.frames : 4, spec.rows || 1);
    const ref = spec.scaleFrom && SPR[spec.scaleFrom];
    const k = ref ? ref.k : spec.h / (spec.fit != null ? fr[Math.min(spec.fit, fr.length - 1)].h : Math.max(...fr.map(F => F.h)));
    SPR[key] = Object.assign(buildSheet(fr, k), { url: L.url });
    ASSET_STATE[key] = 'ok';
  }
}

/* ---------- 5. animations: timelines of steps ---------- */
// step: { sheet, f, beats (heartbeat holds, victory only), extra (ms), tag, bounce (toe-bounce px), dy (jump lift),
//         strike ('whip' | 'punch': hit check on entering), stretch (share of the whip stretch applied) }
const seq = (sheet, list, extra = {}) => list.map(f => Object.assign({ sheet, f }, typeof extra === 'function' ? extra(f) : extra));
const ANIMS = [
  { id: 'idle', label: 'Idle · fighting stance', group: 'Movement', fps: 8, loop: true, needs: ['crouch'],
    hint: 'Her guard stance (crouch frame 1) with a slow breathing bob.', build: () => [{ sheet: 'crouch', f: 0, breathe: true, extra: 1400 }] },
  { id: 'walk', label: 'Walk cycle', group: 'Movement', fps: 9, loop: true, needs: ['walk'], scroll: true,
    hint: '5-frame stride; the floor scrolls so the walk reads as travel.', build: () => seq('walk', [0, 1, 2, 3, 4]) },
  { id: 'jump', label: 'Jump', group: 'Movement', fps: 7, loop: true, needs: ['jump'],
    hint: 'Take-off squat, rise, tuck at the apex, landing reach. Height is eased between frames.',
    build: () => [{ sheet: 'jump', f: 0, dy: 0, extra: 120 }, { sheet: 'jump', f: 1, dy: -150 }, { sheet: 'jump', f: 2, dy: -215 }, { sheet: 'jump', f: 3, dy: -70 }, { sheet: 'crouch', f: 1, dy: 0, extra: 140, tag: 'land' }] },
  { id: 'crouch', label: 'Crouch', group: 'Movement', fps: 8, loop: true, needs: ['crouch'],
    hint: 'Stance → squat → low kneeling guard, then back up.',
    build: () => [{ sheet: 'crouch', f: 0, extra: 300 }, { sheet: 'crouch', f: 1 }, { sheet: 'crouch', f: 2, extra: 700, tag: 'low' }, { sheet: 'crouch', f: 1 }] },
  { id: 'punch', label: 'Punch', group: 'Combat', fps: 12, loop: true, needs: ['punch'], opp: true,
    hint: 'Strike registers on frame 3 (full extension) if her fist reaches the training partner.',
    build: () => [{ sheet: 'punch', f: 0 }, { sheet: 'punch', f: 1 }, { sheet: 'punch', f: 2, strike: 'punch', extra: 90, tag: 'hit' }, { sheet: 'punch', f: 3, extra: 260 }] },
  { id: 'block', label: 'Block · defensive guard', group: 'Combat', fps: 8, loop: true, needs: ['block'],
    hint: 'Guard up, brace (crossed forearms), recover.', build: () => [{ sheet: 'block', f: 0, extra: 250 }, { sheet: 'block', f: 1, extra: 450, tag: 'brace' }, { sheet: 'block', f: 2, extra: 250 }] },
  { id: 'hit', label: 'Hit reaction', group: 'Combat', fps: 9, loop: true, needs: ['hit'],
    hint: 'Impact, head snap, recovery to guard.', build: () => [{ sheet: 'hit', f: 0 }, { sheet: 'hit', f: 1, extra: 120 }, { sheet: 'hit', f: 2, extra: 500 }] },
  { id: 'ko', label: 'Knockout', group: 'Combat', fps: 5, loop: true, needs: ['ko'],
    hint: 'Falling back, down on one knee, collapsed.', build: () => [{ sheet: 'ko', f: 0 }, { sheet: 'ko', f: 1, extra: 250 }, { sheet: 'ko', f: 2, extra: 1500, tag: 'down' }] },
  { id: 'whip', label: 'Special · Ponytail Whip', group: 'Special', fps: 14, loop: true, needs: ['whip1'], opp: true, whip: true,
    hint: 'whip_batch1 extends (stretched to the opponent distance); on the peak hit it switches to whip_batch2 played N → 0 and settles back into her stance.',
    build: buildWhip },
  { id: 'v1cross', label: 'Victory 1 · Crossover', group: 'Victory', fps: 5, loop: true, victory: true, needs: ['cross'],
    hint: 'Hand-to-head crossover. Every arm extension holds 1 heartbeat; every side switch breathes 1 heartbeat, with a toe-bounce.',
    build: () => crossSteps() },
  { id: 'v1waist', label: 'Victory 1 · Hands on Waist', group: 'Victory', fps: 5, loop: true, victory: true, needs: ['waist'],
    hint: 'Hands on hips, swaying back and forth; the lean extremes hold, each pass ends with a breath.',
    build: () => waistSteps() },
  { id: 'v1full', label: 'Victory 1 · Full Routine', group: 'Victory', fps: 5, loop: true, victory: true, needs: ['cross', 'waist'],
    hint: 'Crossover, a breath, then the hands-on-waist sway.', build: () => [...crossSteps(), ...waistSteps()] },
  { id: 'v3sweep', label: 'Victory 3 · Arms Sweep', group: 'Victory', fps: 5, loop: true, victory: true, needs: ['sweep'],
    hint: 'Arms open from the chest in a 0° → 180° sweep: hold as they start, hold at full extension, breathe before the next sweep.',
    build: () => [
      { sheet: 'sweep', f: 0, beats: 1, tag: 'breath' },
      { sheet: 'sweep', f: 1, beats: 1, tag: 'start' },
      { sheet: 'sweep', f: 2 },
      { sheet: 'sweep', f: 3 },
      { sheet: 'sweep', f: 4, beats: 2, tag: 'peak + breath' }] },
  { id: 'music', label: 'Victory Music · Synced Routine', group: 'Victory', fps: 5, loop: true, victory: true, music: true, needs: ['sweep', 'cross', 'waist'],
    hint: `Driven by "${SONG_FILE}": intro sweep (0–4s), crossover (4–14s, 2 frames per beat, max 4.5 FPS) and hands-on-waist (14–24s, 1 sway per drum hit, max 2.2 FPS) locked to the song's tempo, then a 3-second finale sweep peaking at 27.0s. ←/→ seek 1s.`,
    build: () => musicSections().map((s, i) => ({ sheet: s.sheet, f: 0, tag: s.part, t0: s.t0, t1: s.t1, sec: i })) },
  { id: 'ref0', label: 'Reference · full body', group: 'Reference', fps: 1, loop: true, needs: ['ref0'], ref: true,
    hint: 'rokaia_ref_0.png', build: () => [{ sheet: 'ref0', f: 0, extra: 1000 }] },
  { id: 'ref1', label: 'Character select · Rokaia', group: 'Reference', fps: 1, loop: true, needs: ['ref1'], ref: true, portrait: true, fighter: 'rokaia',
    hint: 'rokaia_ref_1.png — close-up portrait', build: () => [{ sheet: 'ref1', f: 0, extra: 1000 }] },
  { id: 'refJoe', label: 'Character select · Joe', group: 'Reference', fps: 1, loop: true, needs: ['joeSel'], ref: true, portrait: true, fighter: 'joe',
    hint: 'WebGame/Joe selection.png — his character-select portrait', build: () => [{ sheet: 'joeSel', f: 0, extra: 1000 }] }
];
// crossover: frames alternate arm-out (peak) / crossed gather (side switch)
function crossSteps() {
  return seq('cross', [0, 1, 2, 3, 4, 5, 6, 7], f => f % 2 === 0 ? { beats: 1, tag: 'peak', bounce: 5 } : { beats: 1, tag: 'breath', bounce: 11 });
}
// hands on waist: neutral, lean, turn, settle — the two extremes of each pass hold, the pass ends with a breath
function waistSteps() {
  const tags = ['', 'peak', 'peak', 'breath', '', 'peak', 'peak', 'breath'];
  return seq('waist', [0, 1, 2, 3, 4, 5, 6, 7], f => tags[f] ? { beats: 1, tag: tags[f], sway: true } : { sway: true });
}
// ponytail whip: extend (batch 1) -> peak hit -> recoil (batch 2, played N -> 0) -> back into her stance
function buildWhip() {
  const w1 = SPR.whip1.frames.length, steps = [];
  for (let i = 0; i < w1; i++) {
    const last = i === w1 - 1;
    steps.push({ sheet: 'whip1', f: i, stretch: last ? 1 : i === w1 - 2 ? .6 : 0, strike: last ? 'whip' : null, extra: last ? 110 : 0, tag: last ? 'hit' : 'extend' });
  }
  if (SPR.whip2) { // instant switch to the recoil sheet, reversed
    const n = SPR.whip2.frames.length;
    for (let i = n - 1; i >= 0; i--) steps.push({ sheet: 'whip2', f: i, stretch: n > 1 ? i / (n - 1) * .85 : 0, tag: 'recoil' });
  } else {     // whip_batch2.png not supplied yet: retract by playing batch 1 backwards
    for (let i = w1 - 2; i >= 0; i--) steps.push({ sheet: 'whip1', f: i, stretch: i === w1 - 2 ? .6 : 0, tag: 'recoil' });
  }
  if (SPR.crouch) steps.push({ sheet: 'crouch', f: 0, extra: 550, tag: 'stance', breathe: true });
  return steps;
}

/* ---------- 6. player state ---------- */
const P = { anim: null, steps: [], i: 0, t: 0, playing: true, loop: true, fps: 12, beatMs: 600, holds: true };
const FX = { sparks: [], popups: [], shake: 0, scroll: 0, flash: 0 };
const OPP = { hitT: -1, x: 0 };
const UI = { dist: 520, guides: false, showOpp: true, lastStrike: null };

const baseMs = () => 1000 / P.fps;
const holdMs = s => (P.anim && P.anim.victory && P.holds ? (s.beats || 0) * P.beatMs : 0);
const stepMs = s => baseMs() + holdMs(s) + (s.extra || 0);
const curStep = () => P.steps[P.i];

function selectAnim(id, keepFps) {
  const A = ANIMS.find(a => a.id === id) || ANIMS[0];
  if (!A.music) musicPause();                                   // the song belongs to the synced routine
  P.anim = A; P.steps = A.build(); P.i = 0; P.t = 0; P.playing = A.music ? MUS.playing : true;
  if (A.music) { MUS.sec = -1; musicUpdate(0); }
  if (!keepFps) setFps(A.fps);
  FX.sparks.length = 0; FX.popups.length = 0; OPP.hitT = -1;
  enterStep(true);
  syncUI();
}
function enterStep() {
  const s = curStep(); if (!s) return;
  if (P.anim.music) { renderTimeline(); return; }
  if (holdMs(s) > 0) pulseBeat();
  if (s.strike === 'whip') whipStrike();
  if (s.strike === 'punch') punchStrike();
  renderTimeline();
}
function advance(dir = 1) {
  const n = P.steps.length;
  let i = P.i + dir;
  if (i >= n) { if (!P.loop) { P.playing = false; syncPlay(); return false; } i = 0; }
  if (i < 0) i = P.loop ? n - 1 : 0;
  P.i = i; P.t = 0;
  if (dir > 0) enterStep(); else renderTimeline();
  return true;
}
function update(dt) {
  if (P.anim && P.anim.music) musicUpdate(dt);                 // the song clock drives the routine
  else if (P.playing && P.steps.length) {
    P.t += dt;
    let guard = 0;
    while (P.t >= stepMs(curStep()) && guard++ < 50) {
      const over = P.t - stepMs(curStep());
      if (!advance(1)) { P.t = stepMs(curStep()); break; }
      P.t = over;
    }
  }
  if (P.anim && P.anim.scroll && P.playing) FX.scroll = (FX.scroll + dt * .22) % 80;
  for (const p of FX.sparks) { p.x += p.vx * dt / 16; p.y += p.vy * dt / 16; p.vy += .25 * dt / 16; p.life -= dt; }
  FX.sparks = FX.sparks.filter(p => p.life > 0);
  for (const p of FX.popups) { p.y -= .05 * dt; p.life -= dt; }
  FX.popups = FX.popups.filter(p => p.life > 0);
  FX.shake = Math.max(0, FX.shake - dt * .04);
  FX.flash = Math.max(0, FX.flash - dt);
}

/* ---------- 7. whip + punch mechanics ---------- */
const oppX = () => HERO_X + UI.dist;
// stretch factor for a whip frame so the ponytail tip lands on the opponent's body
function whipStretchFor(F) {
  if (!F || !F.zone) return 1;
  const split = HERO_X - F.ax + F.zone.split, tip = HERO_X - F.ax + F.zone.tip, target = oppX() - OPP_BODY * .4;
  return clamp((target - split) / Math.max(1, tip - split), WHIP_STRETCH[0], WHIP_STRETCH[1]);
}
function whipPeak() { const F = SPR.whip1 && SPR.whip1.frames[SPR.whip1.frames.length - 1]; return F; }
function whipTipX(F, s) { return HERO_X - F.ax + F.zone.split + (F.zone.tip - F.zone.split) * s; }
function whipStrike() {
  const F = whipPeak(); if (!F || !F.zone) return;
  const s = whipStretchFor(F), tip = whipTipX(F, s), hit = tip >= oppX() - OPP_BODY;
  registerStrike(hit, tip, GROUND - F.h + F.zone.band * .35, 'WHIP!');
}
function punchStrike() {
  const F = SPR.punch.frames[2], fist = HERO_X - F.ax + F.hand[0], hit = fist >= oppX() - OPP_BODY;
  registerStrike(hit, fist, GROUND - F.h + F.hand[1], 'HIT!');
}
function registerStrike(hit, x, y, word) {
  UI.lastStrike = hit ? 'hit' : 'miss';
  if (!(P.anim.opp && UI.showOpp)) { UI.lastStrike = null; syncWhipStats(); return; }
  if (hit) {
    OPP.hitT = performance.now(); FX.shake = 10; FX.flash = 90;
    for (let i = 0; i < 26; i++) { const a = rand(0, Math.PI * 2), v = rand(3, 11); FX.sparks.push({ x, y, vx: Math.cos(a) * v - 2, vy: Math.sin(a) * v - 2, life: rand(220, 480), max: 480, c: Math.random() < .5 ? '#fff3c4' : '#ff5468' }); }
    FX.popups.push({ text: word, x: x + 10, y: y - 40, life: 800, max: 800, c: '#ffd25a' });
  } else {
    FX.popups.push({ text: 'MISS', x, y: y - 30, life: 700, max: 700, c: '#9aa3b8' });
  }
  syncWhipStats();
}

/* ---------- 7b. victory music: Web Audio playback + song-driven choreography ----------
   The song is decoded into an AudioBuffer and played by a looping AudioBufferSourceNode (gap-free repeat).
   Graph: source -> analyser -> gain (sound toggle) -> speakers; the analyser sits before the gain, so the
   choreography keeps reacting to the music while the sound is muted.
   The song clock (AudioContext time) drives everything: sweep sections map song time straight to frames;
   beat sections advance at an energy-scaled FPS and snap to the next frame on each detected bass beat. */
// move1_crossover.png poses by the side of the screen the extended arm reaches to (right = screen-right).
// Each scripted move gathers through a crossed-arms frame, then lands on the extended pose.
const CROSS_RL = { right: [2, 4], left: [0, 6], cross: [7, 1, 3, 5, 7, 1] };
const SONG_MAP = [ // [start, end) in seconds; the last section runs to the end of the track
  { t0: 0,  t1: 4,        sheet: 'sweep', mode: 'sweep', label: 'Victory 3 Arms Sweep', part: 'Intro' },
  { t0: 4,  t1: 8,        sheet: 'cross', mode: 'script', label: 'Victory 1 Crossover (R/L)', part: 'Main beat · R/L',
    moves: ['right', 'left', 'right', 'left', 'right', 'left'], gather: .3 },  // exactly 6 moves, strictly alternating
  { t0: 8,  t1: 14,       sheet: 'cross', mode: 'beat',  label: 'Victory 1 Crossover', part: 'Main beat',
    // frame order (not sheet order): crossed, RIGHT, crossed, LEFT, … by screen side; after move 6 (left) it
    // starts on crossed arms, so the right-reaching pose comes next and the alternation carries on
    order: [1, CROSS_RL.right[0], 3, CROSS_RL.left[1], 5, CROSS_RL.right[1], 7, CROSS_RL.left[0]] },
  { t0: 14, t1: 24,       sheet: 'waist', mode: 'beat',  label: 'Victory 1 Hands on Waist', part: 'Bridge' },
  { t0: 24, t1: SONG_LOOP_S, sheet: 'sweep', mode: 'sweep', label: 'Victory 3 Arms Sweep', part: 'Finale' }
];
// share of a sweep section each frame takes: chest gather, arms start (held), opening, opening, full 180°.
// The full extension arrives in the last ~12% of the section, so it peaks right at 4.0s / at the 27.0s loop point.
const SWEEP_WEIGHTS = [1, 1.2, .8, .8, .5];
// beat sections: frames per beat, top speed, and how early (share of the step) a detected hit may trigger the step
const SONG_BPM = 100;        // felt tempo of the song stretched to 27.0s (~107 BPM original); used until the analyser has its own reading
const BEAT_FEEL = {
  cross: { perBeat: 2, maxFps: 4.5, lock: .8 },   // arm out on the beat, crossover on the off-beat: ~3.6 FPS
  waist: { perBeat: 1, maxFps: 2.2, lock: .85 }   // one sway per main drum/bass hit: ~1.8 FPS
};
const MUS = {
  ctx: null, buf: null, src: null, an: null, gain: null, freq: null, wave: null, el: null,
  ready: false, loading: null, playing: false, muted: false, startAt: 0, offset: 0, dur: 0, last: 0,
  sec: -1, lastStep: -1, frame: 0, step: null, energy: 0, peak: .05, bassAvg: 0, lastBeat: -1, beats: [], bpm: 0, bounce: 0, fpsNow: 0
};
const musicSections = () => SONG_MAP.map(s => ({ ...s, t1: Math.min(s.t1, MUS.dur || s.t1) })).filter(s => s.t1 > s.t0);

function loadSong() {
  if (MUS.loading) return MUS.loading;
  MUS.loading = (async () => {
    MUS.ctx = new (window.AudioContext || window.webkitAudioContext)();
    MUS.an = MUS.ctx.createAnalyser(); MUS.an.fftSize = 1024; MUS.an.smoothingTimeConstant = .6;
    MUS.gain = MUS.ctx.createGain(); MUS.gain.gain.value = MUS.muted ? 0 : 1;
    MUS.an.connect(MUS.gain); MUS.gain.connect(MUS.ctx.destination);
    MUS.freq = new Uint8Array(MUS.an.frequencyBinCount); MUS.wave = new Uint8Array(MUS.an.fftSize);
    for (const dir of ASSET_DIRS) {
      try {
        const r = await fetch(dir + encodeURIComponent(SONG_FILE));
        if (!r.ok) continue;
        const raw = await MUS.ctx.decodeAudioData(await r.arrayBuffer());
        MUS.srcDur = raw.duration;
        $('musicStatus').textContent = `Stretching ${SONG_FILE} to ${SONG_LOOP_S.toFixed(1)}s…`;
        MUS.buf = await timeStretch(raw, Math.round(SONG_LOOP_S * raw.sampleRate));
        MUS.dur = MUS.buf.duration; MUS.ready = true; MUS.url = dir + SONG_FILE;
        return true;
      } catch (e) { /* next folder (or file:// — fall back to an <audio> element below) */ }
    }
    for (const dir of ASSET_DIRS) { // fallback: media element (loops with a tiny gap; analyser may read silence on file://)
      const el = new Audio(dir + encodeURIComponent(SONG_FILE));
      const ok = await new Promise(res => { el.onloadedmetadata = () => res(true); el.onerror = () => res(false); });
      if (!ok) continue;
      MUS.srcDur = el.duration; el.preservesPitch = true; el.playbackRate = el.duration / SONG_LOOP_S; // same 27.0s loop
      el.loop = P.loop; MUS.el = el; MUS.dur = SONG_LOOP_S; MUS.ready = true; MUS.url = dir + SONG_FILE;
      MUS.ctx.createMediaElementSource(el).connect(MUS.an);
      return true;
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
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = .5 - .5 * Math.cos(2 * Math.PI * i / N); // periodic Hann: 50% overlaps sum to 1
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
    if (k % 120 === 119) await new Promise(r => setTimeout(r, 0)); // keep the page responsive
  }
  // divide by the summed window: exact level at the very start and end too (no dip at the 27.0s loop seam)
  for (let i = 0; i < outLen; i++) { const w = Math.max(wsum[i], .05); if (w !== 1) for (let c = 0; c < ch; c++) dst[c][i] /= w; }
  for (let c = 0; c < ch; c++) for (let i = 0; i < Hs && i < outLen; i++) dst[c][i] = src[c][i]; // first half-grain is the song itself (grain 0 starts at 0)
  return out;
}
function musicTime() {
  if (!MUS.ready) return 0;
  if (MUS.el) return MUS.el.currentTime / MUS.el.playbackRate;
  if (!MUS.playing) return MUS.offset;
  const t = MUS.ctx.currentTime - MUS.startAt;
  return P.loop ? t % MUS.dur : Math.min(t, MUS.dur);
}
async function musicPlay() {
  if (!(await loadSong())) { $('musicStatus').textContent = `${SONG_FILE} not found`; return; }
  if (MUS.ctx.state === 'suspended') await MUS.ctx.resume();
  if (MUS.playing) return;
  if (MUS.el) { MUS.el.loop = P.loop; await MUS.el.play(); }
  else {
    const src = MUS.ctx.createBufferSource();
    src.buffer = MUS.buf; src.loop = P.loop; src.connect(MUS.an);
    const off = MUS.offset >= MUS.dur ? 0 : MUS.offset;
    src.onended = () => { if (MUS.src === src && !src.loop) { MUS.playing = false; MUS.offset = MUS.dur; P.playing = false; syncPlay(); syncMusic(); } };
    src.start(0, off); MUS.src = src; MUS.startAt = MUS.ctx.currentTime - off;
  }
  MUS.playing = true; P.playing = true; syncPlay(); syncMusic();
}
function musicPause() {
  if (!MUS.playing) return;
  MUS.offset = musicTime(); MUS.playing = false;
  if (MUS.el) MUS.el.pause();
  else if (MUS.src) { const s = MUS.src; MUS.src = null; try { s.stop(); } catch (e) {} }
  P.playing = false; syncPlay(); syncMusic();
}
function musicSeek(t) {
  if (!MUS.ready) return;
  t = clamp(t, 0, Math.max(0, MUS.dur - .01));
  MUS.sec = -1; // re-enter the section (resets its beat counter)
  if (MUS.el) { MUS.el.currentTime = t; return; }
  const was = MUS.playing;
  if (was) musicPause();
  MUS.offset = t;
  if (was) musicPlay();
}
function setLoopMusic() { if (MUS.src) MUS.src.loop = P.loop; if (MUS.el) MUS.el.loop = P.loop; }
function setMuted(m) { MUS.muted = m; if (MUS.gain) MUS.gain.gain.setTargetAtTime(m ? 0 : 1, MUS.ctx.currentTime, .02); syncMusic(); }

// audio analysis: overall energy (RMS, normalised to the song's own loudest moments) + bass-onset beats
function analyse(t) {
  if (!MUS.an || !MUS.playing) { MUS.energy = lerp(MUS.energy, 0, .1); return false; }
  MUS.an.getByteTimeDomainData(MUS.wave); MUS.an.getByteFrequencyData(MUS.freq);
  let sq = 0; for (const v of MUS.wave) { const x = (v - 128) / 128; sq += x * x; }
  const rms = Math.sqrt(sq / MUS.wave.length);
  MUS.peak = Math.max(rms, MUS.peak * .9995, .04);
  MUS.energy = lerp(MUS.energy, clamp(rms / MUS.peak, 0, 1), .25);
  // onsets by spectral flux: how much the 40 Hz – 2.6 kHz bins rose since the last frame, against an adaptive
  // threshold (this mix keeps its bass compressed flat, so the kick/snare shows up as rises across the band)
  if (!MUS.prev) MUS.prev = new Uint8Array(MUS.freq.length);
  let flux = 0; for (let i = 1; i <= 60; i++) { const d = MUS.freq[i] - MUS.prev[i]; if (d > 0) flux += d; }
  MUS.prev.set(MUS.freq);
  const thr = MUS.fluxAvg * 1.6 + 25;
  const beat = flux > thr && (MUS.lastBeat < 0 || t - MUS.lastBeat > .24 || t < MUS.lastBeat);
  MUS.fluxAvg = lerp(MUS.fluxAvg || flux, flux, .08);
  if (beat) {
    if (MUS.lastBeat >= 0 && t > MUS.lastBeat && t - MUS.lastBeat < 1.5) { MUS.beats.push(t - MUS.lastBeat); if (MUS.beats.length > 12) MUS.beats.shift(); }
    let bpm = MUS.beats.length >= 3 ? 60 / [...MUS.beats].sort((a, b) => a - b)[MUS.beats.length >> 1] : 0;
    while (bpm > 180) bpm /= 2;                                               // report the felt tempo
    if (bpm) MUS.bpm = Math.round(bpm);
    MUS.lastBeat = t;
  }
  return beat;
}
// song time -> the frame on stage
function musicUpdate(dt) {
  const t = musicTime(), secs = musicSections(); if (!secs.length) return;
  if (t < MUS.last - .5) MUS.sec = -1;                      // the song looped back to 0.0s: restart the routine
  MUS.last = t;
  const beat = analyse(t);
  let si = secs.findIndex(s => t >= s.t0 && t < s.t1); if (si < 0) si = secs.length - 1;
  const S = secs[si], A = SPR[S.sheet], n = A ? A.frames.length : 1;
  if (si !== MUS.sec) { MUS.sec = si; MUS.ord = 0; MUS.frame = S.order ? S.order[0] : 0; MUS.lastStep = t; P.i = si; renderTimeline(); }
  if (S.mode === 'sweep') {
    // one full 0° -> 180° sweep stretched exactly over the section
    const w = SWEEP_WEIGHTS.slice(0, n), tot = w.reduce((a, b) => a + b, 0);
    let u = clamp((t - S.t0) / (S.t1 - S.t0), 0, .9999) * tot, f = 0;
    while (f < n - 1 && u >= w[f]) u -= w[f++];
    MUS.frame = f; MUS.fpsNow = n / (S.t1 - S.t0);
  } else if (S.mode === 'script') {
    // fixed choreography: the section is split evenly into its moves (4s / 6 = 0.67s each); every move spends its
    // first `gather` share in a crossed-arms frame, then lands on and holds that side's extended pose
    const D = (S.t1 - S.t0) / S.moves.length, u = (t - S.t0) / D;
    const m = clamp(Math.floor(u), 0, S.moves.length - 1), side = S.moves[m];
    const pose = CROSS_RL[side][Math.floor(m / 2) % 2], f = u - m < S.gather ? CROSS_RL.cross[m] : pose;
    if (f === pose && MUS.frame !== pose) { MUS.bounce = 1; pulseBeat(); }  // a soft settle as the pose lands
    MUS.frame = f; MUS.move = { i: m, n: S.moves.length, side }; MUS.fpsNow = 2 / D;
  } else if (MUS.playing) {
    // tempo-locked: the pace comes from the song's tempo (BEAT_FEEL frames per beat), energy only nudges it ±12%
    // and the section's FPS cap keeps it steady. A frame change waits for a detected hit once it is due, so the
    // moves land on the drums; if no hit comes it steps anyway, so the dance never stalls.
    const B = BEAT_FEEL[S.sheet], T = 60 / (MUS.bpm || SONG_BPM);
    const iv = Math.max(T / B.perBeat * (1.12 - .24 * MUS.energy), 1 / B.maxFps), since = t - MUS.lastStep;
    if (MUS.lastStep < 0 || since < 0) MUS.lastStep = t;
    else if ((beat && since >= iv * B.lock) || since >= iv * 1.5) {
      if (S.order) { MUS.ord = (MUS.ord + 1) % S.order.length; MUS.frame = S.order[MUS.ord]; }
      else MUS.frame = (MUS.frame + 1) % n;
      MUS.lastStep = t; MUS.bounce = 1; pulseBeat();
    }
    MUS.fpsNow = 1 / iv;
  }
  MUS.bounce = Math.max(0, MUS.bounce - dt / 260);
  const amp = S.mode === 'script' ? 6 : S.sheet === 'cross' ? 12 : S.sheet === 'waist' ? 6 : 0; // toe-bounce on the beat
  MUS.step = { sheet: S.sheet, f: MUS.frame, lift: Math.sin(MUS.bounce * Math.PI) * amp * (.5 + MUS.energy), section: S, n };
  syncMusicMeter();
}

/* ---------- 8. rendering ---------- */
const cv = $('stage'), ctx = cv.getContext('2d');
let BG = null, OPP_SPR = null;

function buildBackground() {
  const c = mk(W, H), g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, GROUND);
  sky.addColorStop(0, '#120d1c'); sky.addColorStop(.6, '#22162e'); sky.addColorStop(1, '#3a1a2c');
  g.fillStyle = sky; g.fillRect(0, 0, W, GROUND);
  // paper lanterns + a big moon for the dojo mood
  const moon = g.createRadialGradient(W * .72, 170, 10, W * .72, 170, 150);
  moon.addColorStop(0, 'rgba(255,214,170,.55)'); moon.addColorStop(.45, 'rgba(255,120,110,.15)'); moon.addColorStop(1, 'rgba(255,120,110,0)');
  g.fillStyle = moon; g.fillRect(0, 0, W, GROUND);
  g.fillStyle = 'rgba(255,220,190,.85)'; g.beginPath(); g.arc(W * .72, 170, 58, 0, 7); g.fill();
  for (let i = 0; i < 6; i++) { // back wall pillars
    const x = 60 + i * 230;
    g.fillStyle = 'rgba(10,6,14,.55)'; g.fillRect(x, 90, 26, GROUND - 90);
  }
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
  g.fillStyle = 'rgba(255,170,150,.25)'; g.fillRect(0, GROUND, W, 2);
  const vig = g.createRadialGradient(W / 2, H / 2, H * .35, W / 2, H / 2, H * .95);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
  g.fillStyle = vig; g.fillRect(0, 0, W, H);
  return c;
}
// training partner: Rokaia's stance + hit frames, recoloured cool grey-blue so the two read apart
function buildOpponent() {
  const tint = S => {
    if (!S || RAW_MODE) return S;
    const c = mk(S.strip.width, S.strip.height), g = c.getContext('2d'); g.drawImage(S.strip, 0, 0);
    const id = g.getImageData(0, 0, c.width, c.height), d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const l = .3 * d[i] + .59 * d[i + 1] + .11 * d[i + 2];
      d[i] = lerp(d[i], l * .7, .7); d[i + 1] = lerp(d[i + 1], l * .82, .7); d[i + 2] = lerp(d[i + 2], l * 1.15 + 12, .7);
    }
    g.putImageData(id, 0, 0);
    return Object.assign({}, S, { strip: c });
  };
  return { stance: tint(SPR.crouch), hit: tint(SPR.hit) };
}

function drawFrame(S, F, x, y, o = {}) {
  if (!S || !F) return;
  const sc = o.scale || 1, stretch = o.stretch || 1;
  ctx.save();
  ctx.imageSmoothingEnabled = false;          // crisp: frames are pre-resized, drawn 1:1
  ctx.translate(Math.round(x), Math.round(y));
  if (o.flip) ctx.scale(-1, 1);
  if (sc !== 1) ctx.scale(sc, sc);
  if (o.alpha != null) ctx.globalAlpha = o.alpha;
  const ox = Math.round(-F.ax), oy = -F.h, Z = F.zone;
  if (stretch !== 1 && Z) {
    // the ponytail whip: everything left of the split + the body below the band as drawn; the band in front of
    // her is stretched horizontally so the tip meets the opponent
    const sp = Z.split, bd = Z.band, rw = F.w - sp;
    ctx.drawImage(S.strip, F.sX, F.sY, sp, F.h, ox, oy, sp, F.h);
    ctx.drawImage(S.strip, F.sX + sp, F.sY + bd, rw, F.h - bd, ox + sp, oy + bd, rw, F.h - bd);
    ctx.drawImage(S.strip, F.sX + sp, F.sY, rw, bd, ox + sp, oy, Math.round(rw * stretch), bd);
  } else {
    ctx.drawImage(S.strip, F.sX, F.sY, F.w, F.h, ox, oy, F.w, F.h);
  }
  if (o.flash) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = o.flash; ctx.drawImage(S.strip, F.sX, F.sY, F.w, F.h, ox, oy, F.w, F.h); }
  ctx.restore();
}
function shadow(x, w, a = .45) {
  const g = ctx.createRadialGradient(x, GROUND + 4, 4, x, GROUND + 4, w);
  g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save(); ctx.translate(x, GROUND + 4); ctx.scale(1, .18); ctx.translate(-x, -(GROUND + 4));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, GROUND + 4, w, 0, 7); ctx.fill(); ctx.restore();
}

function render(now) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (FX.shake > 0) ctx.translate(rand(-FX.shake, FX.shake), rand(-FX.shake, FX.shake) * .6);
  if (BG) ctx.drawImage(BG, 0, 0);
  if (P.anim && P.anim.scroll) { // floor boards slide back while walking
    ctx.strokeStyle = 'rgba(255,190,170,.08)'; ctx.lineWidth = 2;
    for (let x = -80 + (80 - FX.scroll); x < W + 80; x += 80) { ctx.beginPath(); ctx.moveTo(x, GROUND); ctx.lineTo(x - 140, H); ctx.stroke(); }
  }
  const A = P.anim, s = A && A.music ? MUS.step : curStep();
  if (!s || !A) return;
  const S = SPR[s.sheet], F = S && S.frames[Math.min(s.f, S.frames.length - 1)];
  const dur = A.music ? 1 : stepMs(s), k = A.music ? 0 : clamp(P.t / dur, 0, 1), base = baseMs();

  if (A.ref) { drawReference(S, F); drawHud(s, A, dur); return; }

  // training partner (whip / punch)
  const showOpp = A.opp && UI.showOpp && OPP_SPR && OPP_SPR.stance;
  if (showOpp) drawOpponent(now);

  // hero
  let y = GROUND, scale = 1, x = HERO_X;
  if (s.dy != null) { const nx = P.steps[(P.i + 1) % P.steps.length]; y += lerp(s.dy, nx.dy != null ? nx.dy : 0, ease(k)); }
  if (s.bounce && P.anim.victory) { const t = clamp(P.t / Math.min(dur, 420), 0, 1); y -= Math.sin(Math.PI * t) * s.bounce; } // toe-bounce
  if (s.breathe) y += Math.round(Math.sin(now / 420) * 2);
  if (s.lift) y -= s.lift;                                     // music: toe-bounce on each beat
  if (!A.music && holdMs(s) > 0 && P.t > base) { const ht = (P.t - base) / holdMs(s); scale = 1 + .012 * Math.max(0, 1 - ht * 4); } // heartbeat thump
  const lift = GROUND - y;
  shadow(x, F ? F.w * .42 : 90, lift > 0 ? .45 * Math.max(.25, 1 - lift / 300) : .45);
  let stretch = 1;
  if (A.whip && F && F.zone && s.stretch) stretch = lerp(1, whipStretchFor(whipPeak()), s.stretch);
  drawFrame(S, F, x, y, { scale, stretch });

  if (UI.guides) drawGuides(S, F, x, y, stretch);
  drawFx();
  if (FX.flash > 0) { ctx.fillStyle = `rgba(255,240,220,${FX.flash / 90 * .18})`; ctx.fillRect(0, 0, W, H); }
  drawHud(s, A, dur);
}
function drawOpponent(now) {
  const ox = oppX(), since = OPP.hitT < 0 ? Infinity : now - OPP.hitT, HIT_LEN = 620;
  shadow(ox, 90);
  if (since < HIT_LEN && OPP_SPR.hit) {
    const i = Math.min(2, Math.floor(since / HIT_LEN * 3)), F = OPP_SPR.hit.frames[i];
    const push = Math.sin(Math.min(1, since / 260) * Math.PI / 2) * 26 * (1 - since / HIT_LEN);
    drawFrame(OPP_SPR.hit, F, ox + push, GROUND, { flip: true, flash: since < 90 ? .55 : 0 });
  } else {
    drawFrame(OPP_SPR.stance, OPP_SPR.stance.frames[0], ox, GROUND + Math.round(Math.sin(now / 380) * 1.5), { flip: true });
  }
}
function drawReference(S, F) {
  if (!F) return;
  if (P.anim.portrait) {
    // character-select card: portrait in a glowing frame with a name plate
    const fi = FIGHTERS.find(f => f.id === P.anim.fighter), cw = F.w + 40, ch = F.h + 40, cx = W / 2 - cw / 2, cy = H / 2 - ch / 2 - 14;
    ctx.save();
    ctx.shadowColor = 'rgba(255,84,104,.55)'; ctx.shadowBlur = 30;
    const bg = ctx.createLinearGradient(0, cy, 0, cy + ch); bg.addColorStop(0, '#2a1622'); bg.addColorStop(1, '#0c0810');
    ctx.fillStyle = bg; roundRect(cx, cy, cw, ch, 14); ctx.fill();
    ctx.shadowBlur = 0; ctx.strokeStyle = '#ff5468'; ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();
    drawFrame(S, F, W / 2 - F.w / 2 + F.ax, cy + 20 + F.h);
    if (fi) {
      ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#d3263a'; roundRect(W / 2 - 130, cy + ch - 24, 260, 48, 8); ctx.fill();
      ctx.font = '900 34px Impact, "Arial Black", sans-serif'; ctx.fillStyle = '#fff'; ctx.lineWidth = 5; ctx.strokeStyle = '#3a0610';
      ctx.strokeText(fi.name, W / 2, cy + ch); ctx.fillText(fi.name, W / 2, cy + ch);
      ctx.restore();
    }
  } else {
    shadow(W / 2, F.w * .45);
    drawFrame(S, F, W / 2, GROUND);
  }
}
function drawGuides(S, F, x, y, stretch) {
  ctx.save(); ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(80,220,255,.9)'; ctx.beginPath(); ctx.moveTo(x - 14, y); ctx.lineTo(x + 14, y); ctx.moveTo(x, y - 14); ctx.lineTo(x, y + 6); ctx.stroke();
  if (F) { ctx.strokeStyle = 'rgba(80,220,255,.35)'; ctx.strokeRect(Math.round(x - F.ax) + .5, y - F.h + .5, F.w, F.h); }
  if (F && F.zone && P.anim.whip) {
    const sx = x - F.ax + F.zone.split, tip = x - F.ax + F.zone.split + (F.zone.tip - F.zone.split) * stretch;
    ctx.strokeStyle = 'rgba(255,200,90,.9)'; ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(sx, y - F.h); ctx.lineTo(sx, y - F.h + F.zone.band); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(tip, y - F.h - 10); ctx.lineTo(tip, y - F.h + F.zone.band); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (P.anim.opp && UI.showOpp) { ctx.strokeStyle = 'rgba(255,90,100,.8)'; ctx.strokeRect(oppX() - OPP_BODY + .5, GROUND - STAND_H + .5, OPP_BODY * 2, STAND_H); }
  ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.moveTo(0, GROUND + .5); ctx.lineTo(W, GROUND + .5); ctx.stroke();
  ctx.restore();
}
function drawFx() {
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const p of FX.sparks) { ctx.globalAlpha = clamp(p.life / p.max, 0, 1); ctx.fillStyle = p.c; ctx.fillRect(p.x - 2, p.y - 2, 4, 4); }
  ctx.restore();
  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  for (const p of FX.popups) {
    const a = clamp(p.life / p.max * 1.6, 0, 1), sc = 1 + .25 * Math.max(0, (p.life - p.max + 140) / 140);
    ctx.globalAlpha = a; ctx.font = `900 ${Math.round(46 * sc)}px Impact, "Arial Black", sans-serif`;
    ctx.lineWidth = 7; ctx.strokeStyle = '#1a0508'; ctx.strokeText(p.text, p.x, p.y); ctx.fillStyle = p.c; ctx.fillText(p.text, p.x, p.y);
  }
  ctx.restore();
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
// real-time frame counter + hold indicator, drawn on top of the stage
function drawHud(s, A, dur) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const S = SPR[s.sheet], file = MANIFEST.find(m => m.key === s.sheet).file;
  ctx.save();
  ctx.fillStyle = 'rgba(8,6,12,.72)'; roundRect(20, 18, 340, 86, 10); ctx.fill();
  ctx.strokeStyle = 'rgba(255,84,104,.5)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = '#9a90ad'; ctx.font = '700 13px "Segoe UI", sans-serif'; ctx.textBaseline = 'top';
  ctx.fillText(A.label.toUpperCase(), 36, 30);
  ctx.fillStyle = '#ffffff'; ctx.font = '900 34px Impact, "Arial Black", sans-serif';
  const txt = A.music ? `FRAME ${s.f + 1} / ${s.n}` : `FRAME ${P.i + 1} / ${P.steps.length}`; ctx.fillText(txt, 36, 50);
  ctx.fillStyle = '#9a90ad'; ctx.font = '12px ui-monospace, Consolas, monospace';
  ctx.fillText(`${file} · #${s.f + 1}/${S ? S.frames.length : '?'}`, 36, 88);
  // right side: fps + hold badge with a progress ring
  const hold = A.music ? 0 : holdMs(s), base = baseMs(), inHold = hold > 0 && P.t > base;
  ctx.fillStyle = 'rgba(8,6,12,.72)'; roundRect(W - 230, 18, 210, 58, 10); ctx.fill();
  ctx.fillStyle = '#ffc85a'; ctx.font = '900 24px Impact, "Arial Black", sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(A.music ? `${MUS.fpsNow.toFixed(1)} FPS` : `${P.fps} FPS`, W - 214, 28);
  ctx.fillStyle = '#9a90ad'; ctx.font = '12px "Segoe UI", sans-serif';
  ctx.fillText(A.music ? (MUS.playing ? (s.section.mode === 'beat' ? `beat-synced${MUS.bpm ? ' · ' + MUS.bpm + ' BPM' : ''}`
      : s.section.mode === 'script' && MUS.move ? `move ${MUS.move.i + 1}/${MUS.move.n} · ${MUS.move.side} hand` : 'song-timed sweep') : 'music paused')
    : P.playing ? (P.loop ? 'playing · loop' : 'playing') : 'paused', W - 214, 56);
  if (A.music) { drawMusicBar(s); ctx.restore(); return; }
  if (s.tag) {
    ctx.fillStyle = inHold ? '#ff5468' : '#c7bedb'; ctx.font = '700 12px "Segoe UI", sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(s.tag.toUpperCase(), W - 70, 56);
  }
  if (hold > 0) {
    const cx = W - 46, cy = 47, prog = inHold ? (P.t - base) / hold : 0;
    ctx.strokeStyle = 'rgba(255,84,104,.25)'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(cx, cy, 16, 0, 7); ctx.stroke();
    if (inHold) { ctx.strokeStyle = '#ff5468'; ctx.beginPath(); ctx.arc(cx, cy, 16, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = inHold ? '#ff5468' : 'rgba(255,84,104,.5)'; ctx.font = '18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('♥', cx, cy + 1);
  }
  // step progress bar
  ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(20, H - 14, W - 40, 4);
  ctx.fillStyle = '#ff5468'; ctx.fillRect(20, H - 14, (W - 40) * ((P.i + clamp(P.t / dur, 0, 1)) / P.steps.length), 4);
  if (RAW_MODE) {
    ctx.fillStyle = 'rgba(255,179,71,.95)'; ctx.font = '700 13px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('Opened from file:// — white keying and frame measuring need a local web server', W / 2, H - 40);
  }
  ctx.restore();
}
// music overlay: "05.2s / 28.0s - Active: Victory 1 Crossover", section-marked progress bar, energy meter
function drawMusicBar(s) {
  const t = musicTime(), dur = MUS.dur || 1, secs = musicSections();
  const bx = 380, bw = W - 380 - 250, by = 26;
  ctx.fillStyle = 'rgba(8,6,12,.72)'; roundRect(bx, 18, bw, 58, 10); ctx.fill();
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = '#ffffff'; ctx.font = '700 17px "Segoe UI", sans-serif';
  const label = MUS.ready ? `${t.toFixed(1).padStart(4, '0')}s / ${dur.toFixed(1)}s - Active: ${s.section.label}` : 'Press "Play Victory Music" to start the song';
  ctx.fillText(label, bx + 14, by);
  const px = bx + 14, pw = bw - 28, py = by + 30;
  ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fillRect(px, py, pw, 8);
  secs.forEach((S, i) => {
    const x0 = px + pw * S.t0 / dur, x1 = px + pw * S.t1 / dur;
    ctx.fillStyle = i === MUS.sec ? 'rgba(255,84,104,.35)' : 'rgba(255,255,255,.05)'; ctx.fillRect(x0, py, x1 - x0, 8);
    ctx.fillStyle = 'rgba(255,255,255,.45)'; ctx.fillRect(Math.round(x0), py - 3, 1, 14);
  });
  ctx.fillStyle = '#ff5468'; ctx.fillRect(px, py, pw * clamp(t / dur, 0, 1), 8);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(Math.round(px + pw * clamp(t / dur, 0, 1)) - 1, py - 4, 3, 16);
  // energy meter under the stage progress line
  ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(20, H - 14, W - 40, 4);
  ctx.fillStyle = '#ff5468'; ctx.fillRect(20, H - 14, (W - 40) * clamp(t / dur, 0, 1), 4);
  ctx.fillStyle = 'rgba(255,200,90,.85)'; ctx.fillRect(20, H - 22, 160 * MUS.energy, 4);
  ctx.fillStyle = '#9a90ad'; ctx.font = '11px "Segoe UI", sans-serif'; ctx.textBaseline = 'bottom'; ctx.fillText('ENERGY', 188, H - 17);
}

/* ---------- 9. dashboard ---------- */
function setFps(v) { P.fps = clamp(Math.round(v), 1, 60); $('fps').value = P.fps; $('fpsOut').textContent = `${P.fps} FPS`; }
function syncPlay() { $('btnPlay').innerHTML = P.playing ? '&#9208;' : '&#9654;'; $('btnPlay').title = P.playing ? 'Pause (Space)' : 'Play (Space)'; }
function syncUI() {
  $('animSelect').value = P.anim.id;
  $('animHint').textContent = P.anim.hint || '';
  $('whipCard').classList.toggle('disabled', !P.anim.opp);
  $('btnLoop').classList.toggle('on', P.loop);
  syncPlay(); syncWhipStats(); renderTimeline(); syncMusic();
  document.querySelectorAll('.fighter').forEach(b => b.classList.toggle('on', b.dataset.id === (P.anim.fighter || 'rokaia') && !!P.anim.fighter));
}
function syncWhipStats() {
  $('distOut').textContent = `${UI.dist} px`;
  const F = whipPeak();
  if (F && F.zone) {
    const s = whipStretchFor(F), tip = whipTipX(F, s), reach = tip >= oppX() - OPP_BODY;
    $('whipStretch').textContent = `${s.toFixed(2)}×`;
    $('whipReach').textContent = reach ? 'in range' : 'too far';
    $('whipReach').className = reach ? 'hit' : 'miss';
  }
  const r = $('whipResult');
  r.textContent = UI.lastStrike ? UI.lastStrike.toUpperCase() : '—';
  r.className = UI.lastStrike || '';
}
function renderTimeline() {
  const el = $('timeline');
  if (el.dataset.anim !== P.anim.id || el.children.length !== P.steps.length) {
    el.dataset.anim = P.anim.id; el.innerHTML = '';
    P.steps.forEach((s, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (s.beats ? ' hold' : '') + (s.strike ? ' hit' : '');
      const beats = s.beats ? ` ♥${s.beats > 1 ? '×' + s.beats : ''}` : '';
      if (P.anim.music) { // song sections: click to jump there
        b.className = 'chip section';
        b.innerHTML = `<b>${s.t0}–${isFinite(s.t1) ? s.t1.toFixed(s.t1 % 1 ? 1 : 0) : 'end'}s</b><span class="tag">${s.tag} · ${s.sheet}</span>`;
        b.title = `${MANIFEST.find(m => m.key === s.sheet).file}`;
        b.onclick = () => musicSeek(s.t0);
      } else {
        b.innerHTML = `<b>${i + 1}</b><span class="tag">${(s.tag || s.sheet)}${beats}</span>`;
        b.title = `${MANIFEST.find(m => m.key === s.sheet).file} · frame ${s.f + 1}`;
        b.onclick = () => { P.playing = false; P.i = i; P.t = 0; enterStep(); syncPlay(); };
      }
      el.append(b);
    });
  }
  [...el.children].forEach((c, i) => c.classList.toggle('now', i === P.i));
  const now = el.children[P.i];
  if (now) { const l = now.offsetLeft - el.offsetLeft, r = l + now.offsetWidth; if (l < el.scrollLeft || r > el.scrollLeft + el.clientWidth) el.scrollLeft = l - 40; }
}
let beatTimer = 0;
function pulseBeat() {
  const b = $('beat'); b.classList.add('pulse'); clearTimeout(beatTimer); beatTimer = setTimeout(() => b.classList.remove('pulse'), 160);
}
function buildSelect() {
  const sel = $('animSelect'); sel.innerHTML = '';
  const groups = {};
  ANIMS.forEach(a => {
    if (!groups[a.group]) { groups[a.group] = document.createElement('optgroup'); groups[a.group].label = a.group; sel.append(groups[a.group]); }
    const o = document.createElement('option'), ok = a.needs.every(k => SPR[k]);
    o.value = a.id; o.textContent = a.label + (ok ? '' : ' (missing art)'); o.disabled = !ok;
    groups[a.group].append(o);
  });
}
// fighter select panel: one portrait card per fighter; clicking opens that fighter's character-select view
function buildFighters() {
  const box = $('fighters'); box.innerHTML = '';
  FIGHTERS.forEach(fi => {
    const S = SPR[fi.sheet], b = document.createElement('button');
    b.type = 'button'; b.className = 'fighter'; b.dataset.id = fi.id; b.disabled = !S;
    const c = mk(120, 120), g = c.getContext('2d');
    if (S) { // fill the square with the portrait's upper part (the face)
      const F = S.frames[0], s = Math.max(120 / F.w, 120 / Math.min(F.h, F.w * 1.05));
      g.imageSmoothingQuality = 'high'; g.drawImage(S.strip, F.sX, F.sY, F.w, F.h, (120 - F.w * s) / 2, 0, F.w * s, F.h * s);
    }
    b.append(c);
    const n = document.createElement('span'); n.className = 'fighter-name'; n.textContent = fi.name;
    const t = document.createElement('span'); t.className = 'fighter-tag'; t.textContent = S ? fi.tag : 'missing art';
    b.append(n, t);
    b.onclick = () => selectAnim(fi.anim);
    box.append(b);
  });
}
function buildAssetList() {
  const ul = $('assetList'); ul.innerHTML = '';
  let found = 0;
  MANIFEST.forEach(m => {
    const st = ASSET_STATE[m.key], S = SPR[m.key], li = document.createElement('li');
    if (st === 'ok') found++;
    const note = st === 'ok' ? `${S.frames.length} frame${S.frames.length > 1 ? 's' : ''}` : m.key === 'whip2' ? 'missing → batch 1 reversed' : 'missing';
    li.innerHTML = `<span title="${m.label}">${m.file}</span><span class="${st === 'ok' ? 'ok' : 'missing'}">${st === 'ok' ? '✓ ' : '⚠ '}${note}</span>`;
    ul.append(li);
  });
  $('assetCount').textContent = `${found} / ${MANIFEST.length}`;
}
function wireControls() {
  $('animSelect').onchange = e => selectAnim(e.target.value);
  // in the synced routine the transport drives the song: play/pause it, ←/→ seek one second, restart = 0.0s
  $('btnPlay').onclick = () => {
    if (P.anim.music) return MUS.playing ? musicPause() : musicPlay();
    P.playing = !P.playing; if (P.playing && !P.loop && P.i === P.steps.length - 1 && P.t >= stepMs(curStep())) { P.i = 0; P.t = 0; enterStep(); } syncPlay();
  };
  $('btnFwd').onclick = () => { if (P.anim.music) return musicSeek(musicTime() + 1); P.playing = false; advance(1); syncPlay(); };
  $('btnBack').onclick = () => { if (P.anim.music) return musicSeek(musicTime() - 1); P.playing = false; advance(-1); syncPlay(); };
  $('btnLoop').onclick = () => { P.loop = !P.loop; $('btnLoop').classList.toggle('on', P.loop); setLoopMusic(); };
  $('btnRestart').onclick = () => { if (P.anim.music) { musicSeek(0); if (!MUS.playing) musicPlay(); return; } P.i = 0; P.t = 0; P.playing = true; OPP.hitT = -1; enterStep(); syncPlay(); };
  $('btnMusic').onclick = () => {
    if (P.anim.music && MUS.playing) return musicPause();
    if (!P.anim.music) selectAnim('music');
    musicPlay();
  };
  $('btnSound').onclick = () => setMuted(!MUS.muted);
  $('fps').oninput = e => setFps(+e.target.value);
  $('btnDefaultFps').onclick = () => setFps(P.anim.fps);
  $('btnSlowMo').onclick = () => {
    P.holds = true; $('holdsOn').checked = true;
    P.beatMs = 600; $('beatMs').value = 600; syncBeat();
    if (!P.anim.victory) selectAnim('v1full', true);
    setFps(4);
  };
  $('beatMs').oninput = e => { P.beatMs = +e.target.value; syncBeat(); };
  $('holdsOn').onchange = e => { P.holds = e.target.checked; };
  $('dist').oninput = e => { UI.dist = +e.target.value; syncWhipStats(); };
  $('showGuides').onchange = e => { UI.guides = e.target.checked; };
  $('showOpp').onchange = e => { UI.showOpp = e.target.checked; };
  addEventListener('keydown', e => {
    if (e.target.tagName === 'SELECT' || (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range')) return;
    if (e.code === 'Space') { e.preventDefault(); $('btnPlay').click(); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); $('btnFwd').click(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); $('btnBack').click(); }
    else if (e.code === 'KeyL') $('btnLoop').click();
    else if (e.code === 'KeyR') $('btnRestart').click();
    else if (/^Digit[1-9]$/.test(e.code)) { const opts = [...$('animSelect').options].filter(o => !o.disabled), o = opts[+e.code.slice(5) - 1]; if (o) selectAnim(o.value); }
  });
}
function syncMusic() {
  const on = P.anim && P.anim.music && MUS.playing;
  $('btnMusic').innerHTML = on ? '&#9208; Pause Victory Music' : '&#9654; Play Victory Music';
  $('btnMusic').classList.toggle('playing', on);
  $('btnSound').innerHTML = MUS.muted ? '&#128263; Sound off' : '&#128266; Sound on';
  $('btnSound').classList.toggle('on', !MUS.muted);
  if (MUS.ready) $('musicStatus').textContent = `${SONG_FILE} · ${MUS.srcDur.toFixed(1)}s stretched to ${MUS.dur.toFixed(1)}s (pitch kept) · ${P.loop ? 'loops' : 'plays once'}`;
  if (P.anim && P.anim.music && MUS.ready && P.steps.some(s => !isFinite(s.t1))) { // song length known: finale ends at the real end
    P.steps = P.anim.build(); $('timeline').dataset.anim = ''; renderTimeline();
  }
}
let meterT = 0;
function syncMusicMeter() {
  const now = performance.now(); if (now - meterT < 120) return; meterT = now;
  $('musicEnergy').style.width = `${Math.round(MUS.energy * 100)}%`;
  $('musicBpm').textContent = MUS.bpm ? `${MUS.bpm} BPM` : '—';
  $('musicFps').textContent = `${MUS.fpsNow.toFixed(1)} FPS`;
  $('musicTime').textContent = MUS.ready ? `${musicTime().toFixed(1)}s / ${MUS.dur.toFixed(1)}s` : '—';
}
function syncBeat() { $('beatOut').textContent = `${P.beatMs} ms`; $('beatLabel').textContent = `${P.beatMs} ms · ${Math.round(60000 / P.beatMs)} BPM`; }

/* ---------- 10. boot ---------- */
let last = performance.now();
function frame(now) {
  const dt = Math.min(100, now - last); last = now;
  update(dt); render(now);
  requestAnimationFrame(frame);
}
(async function boot() {
  ctx.imageSmoothingEnabled = false;
  BG = buildBackground();
  ctx.drawImage(BG, 0, 0);
  wireControls(); syncBeat();
  try {
    await loadAll((msg, p) => { $('loadingText').textContent = `${msg} (${Math.round(p * 100)}%)`; });
  } catch (e) {
    console.error(e); $('loadingText').textContent = 'Could not process the sprite sheets: ' + e.message; return;
  }
  buildAssetList(); buildSelect(); buildFighters();
  const first = ANIMS.find(a => a.needs.every(k => SPR[k]));
  if (!first) { $('loadingText').textContent = 'No Rokaia sprite sheets found next to the engine or in ../assets/Rokaia/.'; return; }
  OPP_SPR = buildOpponent();
  $('loading').classList.add('hidden');
  selectAnim(SPR.whip1 ? 'whip' : first.id);
  requestAnimationFrame(t => { last = t; frame(t); });
})();
