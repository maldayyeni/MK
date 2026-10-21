'use strict';
/* =====================================================================
   CONSTANTS
   ===================================================================== */
const W = 1280, H = 720;           // internal resolution
const STAGE_W = 2400;              // world width
const GROUND = 650;                // feet line (screen/world y)
const FH = 360;                    // nominal fighter height (hitboxes)
const MAX_HP = 30;
const GRAV = 0.95, SPEED = 6.2, JUMP_V = 19.5;
// The camera rests over the whole stage (volcano_stage.png fills the canvas), so the stage's left/right edges ARE the
// canvas edges: each fighter is bounded to them on its own (inset by EDGE_PAD so the whole body stays on screen).
// There is no limit on how far apart the fighters may be.
const CAM0 = (STAGE_W - W) / 2;    // resting camera position (world x of the canvas' left edge)
const EDGE_PAD = 185;              // ~half a fighter's widest standing pose (walk / idle), so they stay fully on screen
const X_MIN = CAM0 + EDGE_PAD, X_MAX = CAM0 + W - EDGE_PAD;
const BUFFER = 7;                  // input buffer frames
const COUNTDOWN = 3;               // seconds before each round: 3… 2… 1… FIGHT!

// perspective floor
const HORIZON = 300, FLOOR_TOP = 560, FOCAL = 1100, TEX_RES = 1.25, TEX_PAD = 250;
const PAR = { sky: .04, far: .12, vol: .25, mid: .5, fg: 1.35 };

const ATK = {
  punch:    { start: 5, active: 4, rec: 9,  reach: [20, 150], y: [0.80, 0.62], stun: 14, push: 6, dmg: 1 }, // high: ducks under it
  kick:     { start: 8, active: 5, rec: 13, reach: [20, 180], y: [0.58, 0.10], stun: 18, push: 9, dmg: 2 }, // exactly 2x punch
  // mid-air attacks (Jump + Punch / Jump + Kick): aimed by the direction held; they end on landing
  airPunch: { start: 3, active: 10, rec: 8, reach: [10, 160], y: [0.85, 0.35], stun: 14, push: 6, dmg: 1 },
  airKick:  { start: 4, active: 16, rec: 8, reach: [10, 175], y: [0.50, -0.10], stun: 18, push: 9, dmg: 2 }, // diving kick
  // Punch + Kick together: leap forward and smash down from above (hits crouching opponents too)
  overhead: { start: 6, active: 60, rec: 10, reach: [0, 175], y: [1.15, 0.0], stun: 22, push: 11, dmg: 3, leapV: 15, leapX: 7 },
  special:  { fire: 20, total: 44 }
};
const COMBO_WINDOW = 4; // frames: Punch and Kick pressed this close together = overhead jump attack
const usesFist = type => type === 'punch' || type === 'airPunch';
// both attack buttons pressed (buffered) within COMBO_WINDOW frames of each other
function comboPressed(p) {
  const a = pressedAt[p].punch, b = pressedAt[p].kick;
  return a !== undefined && b !== undefined && Math.abs(a - b) <= COMBO_WINDOW && G.frame - Math.min(a, b) <= BUFFER;
}

const cvs = document.getElementById('game');
const ctx = cvs.getContext('2d');
const $ = id => document.getElementById(id);

/* =====================================================================
   HELPERS
   ===================================================================== */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
function seeded(s) { s = s % 2147483647; if (s <= 0) s += 2147483646; return () => (s = s * 16807 % 2147483647) / 2147483647; }
function mk(w, h) { const c = document.createElement('canvas'); c.width = Math.ceil(w); c.height = Math.ceil(h); return c; }
const lw = f => Math.ceil(W + (STAGE_W - W) * f) + 8;

function loadImg(base) {
  const exts = ['jpg', 'png', 'webp', 'jpeg'];
  return new Promise(res => {
    let i = 0; const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => { if (++i < exts.length) img.src = base + '.' + exts[i]; else res(null); };
    img.src = base + '.' + exts[0];
  });
}
// every game asset lives in assets/game/ (Rokaia's in assets/Rokaia/, Joe's select card in WebGame/);
// names are relative to that folder
const GAME_DIR = 'assets/game/';
// exact local filenames, tried in order (first one that loads wins)
function loadImgFile(names) {
  return new Promise(res => {
    let i = 0; const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => { if (++i < names.length) img.src = encodeURI(GAME_DIR + names[i]); else res(null); };
    img.src = encodeURI(GAME_DIR + names[0]);
  });
}

/* ---------- procedural noise (value noise, fbm, ridged, voronoi) ---------- */
const PERM = (() => {
  const p = new Uint8Array(512), r = seeded(1337), a = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  for (let i = 0; i < 512; i++) p[i] = a[i & 255];
  return p;
})();
const h2 = (ix, iy) => PERM[PERM[ix & 255] + (iy & 255)] / 255;
const h2b = (ix, iy) => PERM[PERM[(ix + 97) & 255] + ((iy + 31) & 255)] / 255;
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = h2(ix, iy), b = h2(ix + 1, iy), c = h2(ix, iy + 1), d = h2(ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, o = 5) {
  let s = 0, a = .5, f = 1, n = 0;
  for (let i = 0; i < o; i++) { s += a * vnoise(x * f + i * 17.3, y * f + i * 9.1); n += a; a *= .5; f *= 2.03; }
  return s / n;
}
function ridged(x, y, o = 5) {
  let s = 0, a = .5, f = 1, n = 0;
  for (let i = 0; i < o; i++) { let v = 1 - Math.abs(vnoise(x * f + i * 31.7, y * f + i * 7.3) * 2 - 1); v *= v; s += a * v; n += a; a *= .5; f *= 2.1; }
  return s / n;
}
let VF1 = 0, VF2 = 0, VID = 0;
function voronoi(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y); VF1 = 9; VF2 = 9;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = ix + i, cy = iy + j, px = cx + .12 + .76 * h2(cx, cy), py = cy + .12 + .76 * h2b(cx, cy);
    const d = Math.hypot(px - x, py - y);
    if (d < VF1) { VF2 = VF1; VF1 = d; VID = h2(cx + 7, cy + 3); } else if (d < VF2) VF2 = d;
  }
}

/* ---------- colour helpers ---------- */
const _cc = {};
const rgbOf = h => _cc[h] || (_cc[h] = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
function shade(h, k) { const c = rgbOf(h); return `rgb(${Math.min(255, c[0] * k) | 0},${Math.min(255, c[1] * k) | 0},${Math.min(255, c[2] * k) | 0})`; }
function warmShade(h, k) { const c = rgbOf(h); return `rgb(${Math.min(255, c[0] * k * .55 + 150 * k) | 0},${Math.min(255, c[1] * k * .55 + 55 * k) | 0},${Math.min(255, c[2] * k * .55 + 18 * k) | 0})`; }

/* =====================================================================
   AUDIO (synthesized, no files needed)
   ===================================================================== */
let AC = null, noiseBuf = null, soundOn = true;
function initAudio() {
  try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === 'suspended') AC.resume(); } catch (e) { AC = null; }
}
/* ---------- mix: SFX bus (1.0) + combat-music bus (0.25 while fighting) ----------
   Every synthesized sound goes through the SFX bus and is tracked, so the final K.O. can cut it dead; the combat
   music has its own bus, kept low so punches, kicks and hits sit clearly on top. Victory songs (victory.mp3 /
   Rokaia's) bypass both and play at full master volume, alone. */
const MIX = { sfx: null, music: null, active: new Set(), COMBAT: .25, cutDone: false };
function sfxBus() {
  if (!MIX.sfx) { MIX.sfx = AC.createGain(); MIX.sfx.gain.value = 1; MIX.sfx.connect(AC.destination); }
  return MIX.sfx;
}
// once the match is decided (final K.O.) and through the victory + game-over screens, fight sounds are silent
const matchDecided = () => G.phase === 'victory' || G.phase === 'gameover'
  || (G.phase === 'roundEnd' && G.winnerIdx >= 0 && fighters[G.winnerIdx] && fighters[G.winnerIdx].wins >= 2);
const track = n => { MIX.active.add(n); n.onended = () => MIX.active.delete(n); };
function cutAllSfx() { for (const n of MIX.active) { try { n.stop(); } catch (e) {} } MIX.active.clear(); }
function tone(f, d, type = 'square', v = .12, f2 = null, delay = 0) {
  if (!AC || !soundOn || matchDecided()) return;
  const t = AC.currentTime + delay, o = AC.createOscillator(), g = AC.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
  g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g).connect(sfxBus()); o.start(t); o.stop(t + d + .03); track(o);
}
function noise(d, v = .3, freq = 1000, ftype = 'lowpass', f2 = null, delay = 0) {
  if (!AC || !soundOn || matchDecided()) return;
  if (!noiseBuf) {
    noiseBuf = AC.createBuffer(1, AC.sampleRate * 1.5, AC.sampleRate);
    const ch = noiseBuf.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  }
  const t = AC.currentTime + delay, s = AC.createBufferSource(), fl = AC.createBiquadFilter(), g = AC.createGain();
  s.buffer = noiseBuf; fl.type = ftype; fl.frequency.setValueAtTime(freq, t);
  if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + d);
  g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  s.connect(fl).connect(g).connect(sfxBus()); s.start(t); s.stop(t + d + .03); track(s);
}
// the ring bell at "FIGHT!": three metallic strikes (inharmonic partials, long ring) at FULL volume
function ringBell() {
  if (!AC || !soundOn || matchDecided()) return;
  const partials = [[1, .5], [2.76, .28], [5.4, .14], [8.93, .08]], f0 = 640;
  for (let k = 0; k < 3; k++) {
    const t = AC.currentTime + k * .28, dur = k === 2 ? 2.2 : .9;
    for (const [m, v] of partials) {
      const o = AC.createOscillator(), g = AC.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(f0 * m, t);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v * 1.0, t + .004); g.gain.exponentialRampToValueAtTime(.0001, t + dur / m ** .35);
      o.connect(g).connect(sfxBus()); o.start(t); o.stop(t + dur + .05); track(o);
    }
  }
}
// combat music: a procedural fight loop (kick, snare, hats, driving minor bass) scheduled ahead on the audio clock,
// on its own bus at MIX.COMBAT (0.25) while the fight is on, silent otherwise
const BGM = { on: false, next: 0, step: 0, BPM: 132 };
const BGM_BASS = [45, 45, 57, 45, 48, 45, 50, 52, 45, 45, 57, 45, 43, 45, 47, 48]; // MIDI notes, A minor riff
const midiHz = n => 440 * Math.pow(2, (n - 69) / 12);
function musicBus() {
  if (!MIX.music) { MIX.music = AC.createGain(); MIX.music.gain.value = 0; MIX.music.connect(AC.destination); }
  return MIX.music;
}
function bgmVoice(t, i) {
  const out = musicBus(), sixteenth = 60 / BGM.BPM / 4;
  const hit = (freq, f2, dur, v, type) => { const o = AC.createOscillator(), g = AC.createGain(); o.type = type; o.frequency.setValueAtTime(freq, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.0001, t + dur); o.connect(g).connect(out); o.start(t); o.stop(t + dur + .02); };
  const hiss = (dur, v, freq, ftype) => { if (!noiseBuf) return; const s = AC.createBufferSource(), fl = AC.createBiquadFilter(), g = AC.createGain(); s.buffer = noiseBuf; fl.type = ftype; fl.frequency.value = freq; g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.0001, t + dur); s.connect(fl).connect(g).connect(out); s.start(t, Math.random()); s.stop(t + dur + .02); };
  if (i % 4 === 0 || i === 10) hit(150, 45, .22, .9, 'sine');                 // kick
  if (i === 4 || i === 12) { hiss(.16, .55, 1800, 'bandpass'); hit(220, 160, .08, .25, 'triangle'); } // snare
  if (i % 2 === 1) hiss(.04, .18, 7000, 'highpass');                          // hats
  hit(midiHz(BGM_BASS[i]), null, sixteenth * .9, .32, 'sawtooth');            // bass
  if (i % 8 === 0) hit(midiHz(BGM_BASS[i] + 24), midiHz(BGM_BASS[i] + 24) * .98, sixteenth * 3.5, .07, 'square'); // stab
}
function bgmStart() {
  if (!AC || BGM.on) return;
  if (!noiseBuf) noise(.001, 0);                               // (builds the shared noise buffer)
  BGM.on = true; BGM.next = AC.currentTime + .05; BGM.step = 0;
  const g = musicBus().gain; g.cancelScheduledValues(AC.currentTime); g.setTargetAtTime(soundOn ? MIX.COMBAT : 0, AC.currentTime, .25);
}
function bgmStop(hard) {
  if (!BGM.on || !AC) { BGM.on = false; return; }
  BGM.on = false;
  const g = musicBus().gain; g.cancelScheduledValues(AC.currentTime);
  if (hard) g.setValueAtTime(0, AC.currentTime); else g.setTargetAtTime(0, AC.currentTime, .08);
}
function bgmPump() { // keep ~0.2s of the loop scheduled ahead of the audio clock
  if (!BGM.on || !AC) return;
  const sixteenth = 60 / BGM.BPM / 4;
  while (BGM.next < AC.currentTime + .2) { bgmVoice(BGM.next, BGM.step); BGM.next += sixteenth; BGM.step = (BGM.step + 1) % 16; }
}
// what should be heard right now, from the (synced) game phase — runs every frame on the host and an online guest
function audioDirector() {
  if (!AC) return;
  const fighting = G.phase === 'fight' && !matchDecided();
  if (fighting && !BGM.on) bgmStart(); else if (!fighting && BGM.on) bgmStop(G.phase === 'roundEnd' || matchDecided());
  bgmPump();
  if (matchDecided()) { if (!MIX.cutDone) { MIX.cutDone = true; cutAllSfx(); bgmStop(true); } } // final K.O.: dead silence, then the victory song
  else MIX.cutDone = false;
}
const sfx = {
  whoosh: () => noise(.13, .14, 2600, 'bandpass', 700),
  hit:    () => { noise(.09, .5, 1800, 'lowpass', 300); tone(150, .12, 'sine', .5, 50); },
  heavy:  () => { noise(.16, .6, 1300, 'lowpass', 200); tone(110, .18, 'sine', .6, 40); },
  block:  () => { tone(1500, .07, 'square', .06, 900); noise(.05, .25, 4000, 'highpass'); },
  jump:   () => tone(300, .12, 'sine', .08, 520),
  land:   () => noise(.12, .25, 400, 'lowpass', 100),
  fire:   () => { noise(.75, .4, 300, 'lowpass', 2600); tone(90, .55, 'sawtooth', .12, 220); },
  toss:   () => { noise(.28, .38, 3200, 'bandpass', 500); tone(520, .18, 'triangle', .1, 180); },
  cock:   () => { tone(2300, .03, 'square', .08); tone(1500, .04, 'square', .08, null, .08); },
  gun:    () => { noise(.4, .9, 6000, 'lowpass', 200); tone(70, .25, 'square', .3, 30); },
  boom:   () => { noise(.8, .7, 900, 'lowpass', 60); tone(60, .6, 'sine', .6, 25); },
  beep:   () => tone(520, .18, 'square', .12),
  bell:   () => ringBell(),                       // ring bell before the round: full volume
  fight:  () => { tone(392, .15, 'sawtooth', .15); tone(523, .15, 'sawtooth', .15, null, .12); tone(784, .5, 'sawtooth', .18, null, .24); },
  ko:     () => { tone(220, 1.2, 'sawtooth', .2, 55); noise(1, .4, 600, 'lowpass', 80); },
  win:    () => [523, 659, 784, 1046].forEach((f, i) => tone(f, .28, 'triangle', .16, null, i * .13))
};
for (const k of Object.keys(sfx)) { const fn = sfx[k]; sfx[k] = () => { fn(); emit('s', [k]); }; }

/* ---------- music: victory.mp3 (pre-loaded) ---------- */
const MUSIC = { victory: null, ready: false, bgm: null /* hook for a future match track */ };
function preloadMusic() {
  const a = new Audio();
  a.preload = 'auto';
  a.addEventListener('canplaythrough', () => { MUSIC.ready = true; }, { once: true });
  a.addEventListener('error', () => { MUSIC.ready = false; console.warn('victory.mp3 could not be loaded — the victory sequence will run on its own timer.'); });
  a.src = GAME_DIR + 'victory.mp3';
  a.load();
  MUSIC.victory = a;
}
// mobile browsers only allow audio started from a tap/click: "unlock" the element on the first gesture
let musicUnlocked = false;
function unlockMusic() {
  if (musicUnlocked || !MUSIC.victory) return;
  musicUnlocked = true;
  const a = MUSIC.victory; a.muted = true;
  const p = a.play();
  const done = () => { if (G.phase !== 'victory') { a.pause(); try { a.currentTime = 0; } catch (e) {} } a.muted = !soundOn; };
  p && p.then ? p.then(done, done) : done();
}
['pointerdown', 'keydown', 'touchstart'].forEach(t => addEventListener(t, unlockMusic, { capture: true, passive: true }));
function stopMatchMusic() { if (MUSIC.bgm) { MUSIC.bgm.pause(); } }
// the match winner's dance song: ROKAIA has her own (27s loop, victory rokaia.mp3), everyone else victory.mp3
const winnerDances = () => { const w = typeof fighters !== 'undefined' && fighters[G.winnerIdx]; return !!(w && w.char && w.char.dance); };
function playVictoryMusic() {
  stopMatchMusic();
  if (winnerDances()) { rkPlay(0); return; }
  const a = MUSIC.victory; if (!a) return;
  a.muted = !soundOn;
  try { a.currentTime = 0; } catch (e) {}
  const p = a.play(); p && p.catch && p.catch(() => {}); // blocked/missing -> sequence falls back to its own clock
}
function stopVictoryMusic() { rkStop(); const a = MUSIC.victory; if (a) { a.loop = false; a.pause(); try { a.currentTime = 0; } catch (e) {} } }
const victoryMusicPlaying = () => { const a = MUSIC.victory; return !!a && !a.paused && !a.ended && a.currentTime > 0; };

/* =====================================================================
   INPUT
   ===================================================================== */
const KEYMAP = {
  KeyW: [0, 'jump'], KeyS: [0, 'crouch'], KeyA: [0, 'left'], KeyD: [0, 'right'],
  KeyL: [0, 'punch'], KeyK: [0, 'kick'], KeyJ: [0, 'block'], KeyF: [0, 'special'],
  ArrowUp: [1, 'jump'], ArrowDown: [1, 'crouch'], ArrowLeft: [1, 'left'], ArrowRight: [1, 'right'],
  Numpad1: [1, 'punch'], KeyN: [1, 'punch'], Numpad2: [1, 'kick'], KeyM: [1, 'kick'],
  Numpad0: [1, 'block'], KeyB: [1, 'block'], Numpad3: [1, 'special'], KeyV: [1, 'special']
};
// fallback by printed key, so letters still work if the browser reports an unusual e.code
const KEYALIAS = { w: 'KeyW', s: 'KeyS', a: 'KeyA', d: 'KeyD', l: 'KeyL', k: 'KeyK', j: 'KeyJ', f: 'KeyF', n: 'KeyN', m: 'KeyM', b: 'KeyB', v: 'KeyV' };
const held = [{}, {}];            // player -> action -> Set of input sources (keys, touch buttons, network)
const pressedAt = [{}, {}];       // action -> frame it was pressed (input buffer)
function isHeld(p, act) { const s = held[p][act]; return !!s && s.size > 0; }
function consume(p, act, buf = BUFFER) { const t = pressedAt[p][act]; if (t !== undefined && G.frame - t <= buf) { delete pressedAt[p][act]; return true; } return false; }
function clearBuffers() { pressedAt[0] = {}; pressedAt[1] = {}; }
function press(p, act, src) {
  const s = held[p][act] || (held[p][act] = new Set());
  if (s.has(src)) return;
  s.add(src);
  if (NET.role === 'guest') { netSend({ t: 'k', a: act, d: 1 }); return; }
  pressedAt[p][act] = G.frame;
}
function release(p, act, src) {
  const s = held[p][act];
  if (!s || !s.delete(src)) return;
  if (NET.role === 'guest' && s.size === 0) netSend({ t: 'k', a: act, d: 0 });
}
function releaseAllLocal() {
  for (let p = 0; p < 2; p++) for (const act in held[p]) for (const src of [...held[p][act]]) if (src !== 'net') release(p, act, src);
}
function keyInfo(e) {
  const code = KEYMAP[e.code] ? e.code : KEYALIAS[(e.key || '').toLowerCase()];
  const m = code && KEYMAP[code];
  if (!m) return null;
  // online: either key set controls your own fighter
  return { p: NET.role === 'local' ? m[0] : NET.me, act: m[1], src: 'key:' + code };
}
addEventListener('keydown', e => {
  const k = keyInfo(e);
  if (k) { e.preventDefault(); if (!e.repeat) press(k.p, k.act, k.src); }
  if (e.code === 'Enter' && G.phase === 'gameover') requestRestart();
});
addEventListener('keyup', e => { const k = keyInfo(e); if (k) { e.preventDefault(); release(k.p, k.act, k.src); } });
addEventListener('blur', releaseAllLocal);

/* =====================================================================
   CINEMATIC VOLCANIC ARENA (pre-rendered, per-pixel lit layers)
   ===================================================================== */
const L = {};
const CONES = [
  { cx: 844, crY: 168, crW: 66, k: .064, p: 1.35, main: true },
  { cx: 215, crY: 335, crW: 38, k: .095, p: 1.3 },
  { cx: 1430, crY: 305, crW: 44, k: .085, p: 1.32 }
];
const CRATER_SCREEN_X = CONES[0].cx - (STAGE_W - W) / 2 * PAR.vol; // crater x on screen at centred camera

function genSky() {
  const w = lw(PAR.sky), sw = Math.ceil(w / 2), shh = H / 2;
  const c = mk(sw, shh), g = c.getContext('2d'), id = g.createImageData(sw, shh), d = id.data;
  const stops = [[0, [8, 2, 7]], [.22, [34, 7, 12]], [.42, [88, 18, 16]], [.58, [178, 52, 24]], [.68, [246, 118, 52]], [.8, [255, 152, 82]], [1, [255, 152, 82]]];
  const vx = CRATER_SCREEN_X + (STAGE_W - W) / 2 * PAR.sky;
  for (let y = 0; y < shh; y++) {
    const Y = y * 2, t = Y / H;
    let k = 0; while (stops[k + 1][0] < t) k++;
    const s0 = stops[k], s1 = stops[k + 1], tt = (t - s0[0]) / (s1[0] - s0[0]);
    const br = lerp(s0[1][0], s1[1][0], tt), bg = lerp(s0[1][1], s1[1][1], tt), bb = lerp(s0[1][2], s1[1][2], tt);
    for (let x = 0; x < sw; x++) {
      const X = x * 2;
      const wx = fbm(X * .0016, Y * .004, 3);
      const n = fbm(X * .0021 + wx * 1.9, Y * .0066 + wx * .7, 5);
      const dens = smooth(.43, .7, n) * (1 - smooth(340, 480, Y) * .75);
      const dxv = (X - vx) / 430, dyv = (Y - 300) / 270, gl = Math.exp(-(dxv * dxv + dyv * dyv));
      const lit = clamp(smooth(40, 440, Y) * .55 + gl * .95, 0, 1), self = .55 + .45 * (1 - dens);
      const cr = 20 + 225 * lit * self, cg = 7 + 80 * lit * self, cb = 10 + 30 * lit;
      let r = br + (cr - br) * dens * .92, gg = bg + (cg - bg) * dens * .92, b = bb + (cb - bb) * dens * .92;
      r += 255 * gl * .32; gg += 130 * gl * .32; b += 50 * gl * .25;
      const i = (y * sw + x) * 4;
      d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  g.putImageData(id, 0, 0);
  L.sky = mk(w, H); const g2 = L.sky.getContext('2d'); g2.imageSmoothingQuality = 'high'; g2.drawImage(c, 0, 0, w, H);
}

// generic per-pixel lit terrain: tops[] silhouette, detail(x,y) height field, light(x,y,N) -> rgb
function litTerrain(w, tops, detail, S, colorFn) {
  const c = mk(w, H), g = c.getContext('2d'), id = g.createImageData(w, H), d = id.data;
  for (let x = 0; x < w; x++) {
    const ty = tops[x];
    for (let y = Math.max(0, Math.floor(ty)); y < H; y++) {
      const a = clamp(y - ty + 1, 0, 1);
      if (a <= 0) continue;
      const D = detail(x, y), dx = detail(x + 1, y) - D, dy = detail(x, y + 1) - D;
      let nx = -dx * S, ny = -dy * S, nz = 1; const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
      const col = colorFn(x, y, nx, ny, nz, D, y - ty);
      const i = (y * w + x) * 4;
      d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255 * a;
    }
  }
  g.putImageData(id, 0, 0);
  return c;
}
const OUT = [0, 0, 0];

function genFar() {
  const w = lw(PAR.far), tops = new Float32Array(w + 2);
  for (let x = 0; x < w + 2; x++) tops[x] = 585 - Math.pow(ridged(x * .0019 + 4.2, 2.7, 5), 1.35) * 380;
  const vxs = CRATER_SCREEN_X + (STAGE_W - W) / 2 * PAR.far;
  L.far = litTerrain(w, tops, (x, y) => ridged(x * .007, y * .011, 4), 16, (x, y, nx, ny, nz, D, re) => {
    const d1 = Math.max(0, nx * .25 + ny * .55 + nz * .8), d2 = Math.max(0, -nx * .35 - ny * .75 + nz * .56);
    const low = smooth(tops[x], 585, y), vp = Math.exp(-Math.pow((x - vxs) / 520, 2)), alb = .7 + .5 * D;
    const wi = d1 * (.25 + .45 * low + .35 * vp);
    let r = alb * (22 + 255 * wi + 70 * d2 * .5), g = alb * (9 + 92 * wi + 42 * d2 * .5), b = alb * (12 + 42 * wi + 80 * d2 * .5);
    const hz = .42 + .38 * low;
    r = lerp(r, 160, hz); g = lerp(g, 54, hz); b = lerp(b, 34, hz);
    if (re < 4) { const k = (1 - re / 4) * (.3 + .7 * vp); r += 255 * k; g += 140 * k; b += 70 * k; }
    OUT[0] = r; OUT[1] = g; OUT[2] = b; return OUT;
  });
}

function coneY(c, x) {
  const dist = Math.abs(x - c.cx);
  if (dist < c.crW) return c.crY + 4 * (dist / c.crW) ** 2 + (vnoise(x * .15, 3) - .5) * 4;
  return c.crY + c.k * Math.pow(dist - c.crW, c.p) + (fbm(x * .03, c.cx, 3) - .5) * 18 * Math.min(1, (dist - c.crW) / 120);
}

function genVolcano() {
  const w = lw(PAR.vol), tops = new Float32Array(w + 2), owner = new Int8Array(w + 2);
  for (let x = 0; x < w + 2; x++) {
    let best = 1e9, bi = 0;
    CONES.forEach((c, i) => { const y = coneY(c, x); if (y < best) { best = y; bi = i; } });
    tops[x] = best; owner[x] = bi;
  }
  const uOf = (x, y) => { const c = CONES[owner[clamp(x, 0, w + 1)]]; const hw = c.crW + Math.pow(Math.max(0, y - c.crY) / c.k, 1 / c.p); return clamp((x - c.cx) / Math.max(hw, 1), -1, 1); };
  const M = CONES[0];
  L.vol = litTerrain(w, tops, (x, y) => {
    const u = uOf(x, y);
    return ridged(u * 7 + owner[clamp(x, 0, w + 1)] * 13, y * .011, 4) * .9 + fbm(x * .03, y * .03, 2) * .25;
  }, 9, (x, y, nx, ny, nz, D, re) => {
    const u = uOf(x, y);
    // macro cone normal + detail
    let Nx = nx + u * .85, Ny = ny - .22, Nz = nz * Math.sqrt(Math.max(.08, 1 - u * u));
    const nl = Math.hypot(Nx, Ny, Nz); Nx /= nl; Ny /= nl; Nz /= nl;
    // crater light (point light above crater)
    let lx = M.cx - x, ly = M.crY - 30 - y, lz = 140; const ld = Math.hypot(lx, ly, lz);
    const ic = 1.5 / (1 + (ld / 260) ** 2);
    const dc = Math.max(0, (Nx * lx + Ny * ly + Nz * lz) / ld) * ic;
    const low = smooth(tops[x], 575, y);
    const d1 = Math.max(0, Nx * .2 + Ny * .6 + Nz * .77) * (.2 + .55 * low);
    const d2 = Math.max(0, -Nx * .35 - Ny * .75 + Nz * .56) * .45;
    const wi = dc + d1, alb = .75 + .45 * D;
    let r = alb * .34 * (45 + 420 * wi + 90 * d2), g = alb * .2 * (40 + 330 * wi + 70 * d2), b = alb * .19 * (45 + 160 * wi + 120 * d2);
    const hz = .16 + .32 * low;
    r = lerp(r, 145, hz); g = lerp(g, 48, hz); b = lerp(b, 30, hz);
    const cd = Math.hypot(x - M.cx, y - M.crY) / 70; const em = Math.exp(-cd * cd) * 1.2;
    r += 255 * em; g += 150 * em; b += 60 * em;
    if (re < 3) { const k = (1 - re / 3) * (.35 + ic * .6); r += 255 * k; g += 120 * k; b += 50 * k; }
    OUT[0] = r; OUT[1] = g; OUT[2] = b; return OUT;
  });
  // glowing lava rivers
  const g = L.vol.getContext('2d'), rr = seeded(77);
  g.globalCompositeOperation = 'lighter'; g.lineCap = 'round'; g.lineJoin = 'round';
  CONES.forEach((c, ci) => {
    const n = c.main ? 6 : 2;
    for (let k = 0; k < n; k++) {
      const side = k % 2 ? 1 : -1; let x = c.cx + side * c.crW * (.3 + rr() * .6), y = c.crY + 4;
      const endY = c.crY + (560 - c.crY) * (.35 + rr() * .55), pts = [[x, y]];
      let vx = side * (.6 + rr());
      while (y < endY) { y += 5; vx += (rr() - .5) * .9; vx = clamp(vx, side > 0 ? .2 : -3.2, side > 0 ? 3.2 : -.2); x += vx; if (y > coneY(c, x) + 2) pts.push([x, y]); }
      const passes = [[26, 'rgba(255,60,0,.10)'], [14, 'rgba(255,80,10,.25)'], [6, 'rgba(255,120,30,.75)'], [2.2, 'rgba(255,230,150,.9)']];
      for (const [lwid, col] of passes) {
        g.strokeStyle = col;
        for (let i = 1; i < pts.length; i++) {
          const t = i / pts.length; g.lineWidth = lwid * (1 - t * .75) * (c.main ? 1 : .7);
          g.beginPath(); g.moveTo(pts[i - 1][0], pts[i - 1][1]); g.lineTo(pts[i][0], pts[i][1]); g.stroke();
        }
      }
    }
  });
  g.globalCompositeOperation = 'source-over';
}

function genMid() {
  const w = lw(PAR.mid), tops = new Float32Array(w + 2), LAKE = 516;
  for (let x = 0; x < w + 2; x++) {
    const m = ridged(x * .0031 + 9.3, 5.5, 4), s = Math.pow(vnoise(x * .028, 2.2), 7) * 110;
    tops[x] = Math.max(250, 540 - Math.pow(m, 1.7) * 260 - s);
  }
  const c = litTerrain(w, tops, (x, y) => ridged(x * .032, y * .007, 4) * .8 + fbm(x * .05, y * .05, 2) * .3, 11, (x, y, nx, ny, nz, D, re) => {
    const base = smooth(LAKE - 90, LAKE + 10, y);
    const d1 = Math.max(0, nx * .1 + ny * .65 + nz * .75) * (.35 + 1.3 * base);
    const d2 = Math.max(0, -nx * .3 - ny * .8 + nz * .52) * .35;
    const alb = .7 + .5 * D;
    let r = alb * .24 * (40 + 520 * d1 + 110 * d2), g = alb * .15 * (34 + 300 * d1 + 90 * d2), b = alb * .15 * (40 + 120 * d1 + 150 * d2);
    r = lerp(r, 120, .12); g = lerp(g, 40, .12); b = lerp(b, 28, .12);
    if (re < 3) { const k = (1 - re / 3) * .5; r += 220 * k; g += 90 * k; b += 50 * k; }
    OUT[0] = r; OUT[1] = g; OUT[2] = b; return OUT;
  });
  // lava lake behind the cliffs
  const lake = mk(w, H - LAKE), lg = lake.getContext('2d'), id = lg.createImageData(w, H - LAKE), d = id.data;
  for (let y = 0; y < H - LAKE; y++) for (let x = 0; x < w; x++) {
    const crust = fbm(x * .018, y * .09 + 4, 4), bright = 1 - smooth(.36, .56, crust), core = 1 - smooth(.25, .4, crust);
    const i = (y * w + x) * 4;
    d[i] = 110 + 145 * bright; d[i + 1] = 18 + 110 * bright + 90 * core; d[i + 2] = 6 + 30 * bright + 60 * core; d[i + 3] = 255;
  }
  lg.putImageData(id, 0, 0);
  L.mid = mk(w, H); const g = L.mid.getContext('2d');
  g.drawImage(lake, 0, LAKE);
  g.drawImage(c, 0, 0);
  // lava falls
  g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
  const rr = seeded(5); L.falls = [];
  for (let k = 0; k < 7; k++) {
    let best = 0, bx = 0;
    for (let t = 0; t < 30; t++) { const x = (rr() * (w - 100) + 50) | 0; const s = LAKE - tops[x]; if (s > best) { best = s; bx = x; } }
    if (best < 90) continue;
    L.falls.push({ x: bx, y0: tops[bx] + 6 });
    const passes = [[30, 'rgba(255,60,0,.10)'], [12, 'rgba(255,90,10,.35)'], [5, 'rgba(255,170,60,.8)'], [1.6, 'rgba(255,240,170,.9)']];
    for (const [lwid, col] of passes) {
      g.strokeStyle = col; g.lineWidth = lwid; g.beginPath(); g.moveTo(bx, tops[bx] + 6);
      for (let y = tops[bx] + 6; y < LAKE + 4; y += 6) g.lineTo(bx + Math.sin(y * .05 + k) * 3, y);
      g.stroke();
    }
  }
  // lake glow line on cliff bases
  const gr = g.createLinearGradient(0, LAKE - 40, 0, LAKE + 10);
  gr.addColorStop(0, 'rgba(255,90,20,0)'); gr.addColorStop(1, 'rgba(255,110,30,.45)');
  g.fillStyle = gr; g.fillRect(0, LAKE - 40, w, 50);
  g.globalCompositeOperation = 'source-over';
  L.lakeY = LAKE;
}

function floorP(y) { return (y - HORIZON) / (GROUND - HORIZON); }

function genFloor() {
  const TW = Math.ceil((STAGE_W + TEX_PAD * 2) * TEX_RES), TH = H - FLOOR_TOP;
  L.floor = mk(TW, TH); L.floorGlow = mk(TW, TH);
  const g = L.floor.getContext('2d'), gg = L.floorGlow.getContext('2d');
  const id = g.createImageData(TW, TH), d = id.data, ig = gg.createImageData(TW, TH), dg = ig.data;
  const zNear = FOCAL / floorP(H), zFar = FOCAL / floorP(FLOOR_TOP), S = 64;
  for (let r = 0; r < TH; r++) {
    const p = floorP(FLOOR_TOP + r + .5), z = FOCAL / p, zf = (z - zNear) / (zFar - zNear);
    for (let x = 0; x < TW; x++) {
      const u = x / TEX_RES - TEX_PAD;
      voronoi(u / S, z / S);
      const crack = (VF2 - VF1) * S, edge = smooth(0, 4.5, crack);
      const det = fbm(u * .05, z * .05, 3), tone = .7 + .55 * VID;
      const bevel = smooth(4, 14, crack);
      let k = tone * (.65 + .7 * det) * (.3 + .7 * edge) * (.85 + .25 * bevel);
      let R = 62 * k, G = 38 * k, B = 33 * k;
      const lm = smooth(.46, .6, fbm(u * .004 + 3, z * .006, 3));
      let e = (1 - smooth(0, 3.4, crack)) * lm, e2 = (1 - smooth(0, 16, crack)) * lm * .4;
      // outside stage = lava sea
      const o = u < 0 ? -u : u > STAGE_W ? u - STAGE_W : 0;
      if (o > 0) {
        const lv = smooth(4, 26, o), crust = fbm(u * .03, z * .05, 4), br = 1 - smooth(.38, .56, crust);
        R = lerp(R, 120 + 135 * br, lv); G = lerp(G, 22 + 120 * br, lv); B = lerp(B, 8 + 40 * br, lv);
        e = Math.max(e, lv * br * .9); e2 = Math.max(e2, lv * .5);
      }
      // far edge lit by lava lake, distance haze
      const wf = smooth(.75, 1, zf);
      R *= 1 + wf * 1.1; G *= 1 + wf * .5; B *= 1 + wf * .2;
      R = lerp(R, 120, zf * .3); G = lerp(G, 40, zf * .3); B = lerp(B, 28, zf * .3);
      R += 200 * e * .5; G += 70 * e * .5; B += 20 * e * .5;
      const i = (r * TW + x) * 4;
      d[i] = R; d[i + 1] = G; d[i + 2] = B; d[i + 3] = 255;
      const ge = Math.min(1, e + e2);
      dg[i] = 255; dg[i + 1] = 110 + 120 * e; dg[i + 2] = 30 + 60 * e; dg[i + 3] = ge * 255;
    }
  }
  g.putImageData(id, 0, 0); gg.putImageData(ig, 0, 0);
}

function genForeground() {
  const w = lw(PAR.fg), hh = 110, c = mk(w, hh), g = c.getContext('2d'), r = seeded(41);
  for (let i = 0; i < w / 260; i++) {
    const x = r() * w, rw = 60 + r() * 160, rh = 18 + r() * 46;
    const gr = g.createLinearGradient(0, hh - rh, 0, hh);
    gr.addColorStop(0, '#2a0d08'); gr.addColorStop(.2, '#120404'); gr.addColorStop(1, '#050101');
    g.fillStyle = gr; g.beginPath(); g.moveTo(x - rw, hh);
    for (let k = 0; k <= 12; k++) { const t = k / 12; g.lineTo(x - rw + t * rw * 2, hh - Math.sin(t * Math.PI) * rh * (.75 + r() * .4)); }
    g.closePath(); g.fill();
    g.strokeStyle = 'rgba(255,110,40,.55)'; g.lineWidth = 2; g.stroke();
  }
  L.fg = mk(w, hh); const g2 = L.fg.getContext('2d');
  if (typeof g2.filter === 'string') g2.filter = 'blur(3px)';
  g2.drawImage(c, 0, 0);
}

function genPillar() {
  const pw = 130, ph = 560, c = mk(pw, ph), g = c.getContext('2d');
  const body = (x0, x1, y0, y1) => {
    const gr = g.createLinearGradient(x0, 0, x1, 0);
    gr.addColorStop(0, '#2c1210'); gr.addColorStop(.25, '#160707'); gr.addColorStop(.6, '#0a0303'); gr.addColorStop(.92, '#3a1208'); gr.addColorStop(1, '#ff7a30');
    g.fillStyle = gr; g.fillRect(x0, y0, x1 - x0, y1 - y0);
  };
  body(22, 108, 30, ph - 40); body(6, 124, 0, 34); body(4, 126, ph - 44, ph);
  // per-pixel rock grain
  const id = g.getImageData(0, 0, pw, ph), d = id.data;
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const i = (y * pw + x) * 4; if (!d[i + 3]) continue;
    const n = .7 + .6 * ridged(x * .05, y * .02, 3);
    d[i] *= n; d[i + 1] *= n; d[i + 2] *= n;
  }
  g.putImageData(id, 0, 0);
  // runes
  g.shadowColor = '#ff4a00'; g.shadowBlur = 16; g.strokeStyle = 'rgba(255,150,50,.95)'; g.lineWidth = 3; g.lineCap = 'round';
  g.beginPath();
  for (let y = 70; y < ph - 90; y += 58) { g.moveTo(52, y); g.lineTo(78, y + 14); g.lineTo(52, y + 28); g.moveTo(65, y + 2); g.lineTo(65, y + 32); }
  g.stroke(); g.shadowBlur = 0;
  L.pillar = c;
}

function genSprites() {
  const glow = (size, stops) => { const c = mk(size, size), g = c.getContext('2d'), gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2); stops.forEach(s => gr.addColorStop(s[0], s[1])); g.fillStyle = gr; g.fillRect(0, 0, size, size); return c; };
  L.ember = glow(32, [[0, 'rgba(255,240,200,1)'], [.25, 'rgba(255,170,60,.9)'], [.6, 'rgba(255,80,10,.25)'], [1, 'rgba(255,40,0,0)']]);
  L.bokeh = glow(64, [[0, 'rgba(255,150,60,.55)'], [.7, 'rgba(255,110,40,.4)'], [.85, 'rgba(255,90,30,.15)'], [1, 'rgba(255,60,0,0)']]);
  L.flare = glow(256, [[0, 'rgba(255,230,160,.9)'], [.15, 'rgba(255,150,60,.55)'], [.5, 'rgba(255,70,10,.15)'], [1, 'rgba(255,40,0,0)']]);
  // lit smoke puffs
  L.smoke = []; L.smokeLit = [];
  for (let v = 0; v < 3; v++) {
    const s = 160, a = mk(s, s), b = mk(s, s), ga = a.getContext('2d'), gb = b.getContext('2d');
    const ia = ga.createImageData(s, s), ib = gb.createImageData(s, s);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const dx = (x - s / 2) / (s / 2), dy = (y - s / 2) / (s / 2), rr = Math.hypot(dx, dy);
      const n = fbm(x * .035 + v * 10, y * .035 + v * 5, 5);
      const al = clamp((n - .3) * 2.4, 0, 1) * smooth(1, .35, rr);
      const i = (y * s + x) * 4, shadeK = .6 + .5 * n;
      ia.data[i] = 42 * shadeK; ia.data[i + 1] = 30 * shadeK; ia.data[i + 2] = 30 * shadeK; ia.data[i + 3] = al * 235;
      const under = smooth(-.2, .9, dy);
      ib.data[i] = 255; ib.data[i + 1] = 110 + 40 * n; ib.data[i + 2] = 40; ib.data[i + 3] = al * under * 200;
    }
    ga.putImageData(ia, 0, 0); gb.putImageData(ib, 0, 0);
    L.smoke.push(a); L.smokeLit.push(b);
  }
  // tileable fog strip
  const fw = 1024, fh = 170, f = mk(fw, fh), fg = f.getContext('2d'), fi = fg.createImageData(fw, fh);
  for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
    const t = x / fw, n = fbm(x * .006, y * .022, 4) * (1 - t) + fbm((x - fw) * .006, y * .022, 4) * t;
    const al = clamp((n - .38) * 2.2, 0, 1) * Math.sin(Math.PI * y / fh);
    const i = (y * fw + x) * 4; fi.data[i] = 150; fi.data[i + 1] = 66; fi.data[i + 2] = 48; fi.data[i + 3] = al * 190;
  }
  fg.putImageData(fi, 0, 0); L.fog = f;
}

function buildArena() {
  // with the painted volcano_stage.png only the shared FX sprites (glows, embers, smoke) are needed
  if (STAGE.bg) genSprites();
  else { genSky(); genFar(); genVolcano(); genMid(); genFloor(); genForeground(); genPillar(); genSprites(); }
  L.bloom = mk(W / 8, H / 8); L.bloomG = L.bloom.getContext('2d');
  L.bloomOK = typeof L.bloomG.filter === 'string';
}

/* =====================================================================
   FIGHTER ANIMATION BATCHES + invisible rig
   Each animation is one PNG in this folder: a single pose, or a horizontal strip of frames (a "batch").
   Art on a solid white background is keyed out automatically at load (flood fill of the near-white paper
   from the image border + enclosed pure-white gaps, then a de-matte that removes the white rim) — white
   areas INSIDE the figure, like Moe's shirt, are kept. Already-transparent PNGs work too.
   Frame slicing: every frame gets its source offset sX (and width) at load. The cut between two frames is the
   emptiest column near the even split (frames in these strips aren't evenly spaced — a fixed width / frames
   slice would cut the roundhouse's foot off); if that can't be done, plain sX = i * width / frames is used.
   Each animation is resized ONCE, with high-quality smoothing, so its tallest frame is its gameplay height,
   and drawn 1:1 with smoothing OFF: smooth downscaling of the high-res art, crisp pixel edges on screen.
   The rig below is no longer drawn: it only drives pose timing. Each frame the current frame's measured
   fist / foot overwrite the rig's hand / ankle, so hit sparks, trails and projectile spawns match the art.
   ===================================================================== */
const SK = { spine: 112, ua: 72, fa: 70, th: 92, sh: 90 };
const OX = 500, OY = 560;   // origin of the fighter's offscreen canvas (feet)
const STAND_H = FH * 1.12;  // standing height = hurtbox top
const CROUCH_H = FH * .64;  // ducking height: below the special lane, like the crouch hurtbox
const MONTAGE_MULT = 1.4;   // game-over screen: winner drawn this much larger (pre-rendered at that size)
const ANIM_V = '1';         // bump when you replace images so browsers that cached the old ones fetch the new files

// Animation data: combat state -> horizontal batch file + number of frames (each frame's sX is measured at load).
//   file:   tried in order — the first one present is used (so e.g. moe_jump.png or moe_jump_batch.png both work)
//   frames: frame count (an array = per file in the list); h: on-screen height of the tallest frame
//   use:    subset of frames; faces: -1 when the art looks left
//   detach: effect pixels (the thrown energy / heart) cut OUT of those frames so the projectile can take over
//   projectile: { frame } — build the projectile sprite from what was cut out of that frame
// A missing animation borrows another (ANIM_FALLBACK) until its file is added — no code change needed.

// ---------- PLAYER 1: MOE ----------
const MOE_ANIM = {
  idle:       { file: ['moe_idle.png'],                                             frames: 1, h: STAND_H },
  walk:       { file: ['moe_walk_sequence.png'],                                    frames: 5, h: STAND_H,
                pockets: { region: [.2, .8, .58, 1], lum: 236 } },   // clear the white gap enclosed between his legs (below the cuffs)
  punch:      { file: ['moe_punch_batch.png', 'moe_punch.png'],                     frames: [4, 1], h: STAND_H },
  kick:       { file: ['moe_kick_batch.png', 'moe_kick.png'],                       frames: [4, 1], h: STAND_H },
  roundhouse: { file: ['moe_kick_roundhouse.png', 'moe_kick_roundhouse_batch.png'], frames: 4, h: STAND_H },
  jump:       { file: ['moe_jump.png', 'moe_jump_batch.png'],                       frames: 4, h: FH * 1.08 },
  crouch:     { file: ['moe_jump.png', 'moe_jump_batch.png'],                       frames: 4, use: [0], h: CROUCH_H }, // take-off squat = duck
  specials:   { file: ['moe_combat_specials.png'],                                  frames: 3, h: STAND_H }, // 0 charge, 1 knocked back, 2 dizzy
  launch:     { file: ['moe_special_launch.png'],                                   frames: 4, h: STAND_H, detach: { frames: [2, 3], effect: 'energy' } },
  // victory: turn forward, spin the gun, gun up, adjust the bowtie. This art is cropped at mid-thigh, so it is drawn
  // with the head at standing height (lift), the cut edge faded out, and a ground-slam smoke bank over the legs
  victory:    { file: ['moe_victory_agent.png', 'moe_victory_gun.png'],             frames: 4, h: STAND_H * .72, lift: STAND_H * .31, fadeBottom: .14, legSmoke: true },
  projectile: { file: ['moe_projectile_energy.png'],                                frames: 1, w: 250 }      // the energy blast in flight
};
function moeFrame(st, f, spr) {
  switch (st.s) {
    case 'walk': return ['walk', ((Math.floor(f.walkPh * .5) % 5) + 5) % 5];
    case 'crouch': return ['crouch', 0];
    case 'punch': case 'kick': return [st.s, st.ph === 'wind' ? (st.k < .5 ? 0 : 1) : st.ph === 'strike' ? 2 : 3];
    case 'airPunch': return ['punch', 2];
    case 'airKick': return ['kick', 2];
    case 'overhead': return f.vy < 0 ? ['jump', 1] : ['roundhouse', f.vy < 5 ? 0 : f.vy < 12 ? 1 : 2]; // spinning roundhouse smash
    case 'slam': return ['roundhouse', 2];
    case 'jumpRise': return ['jump', 1];
    case 'jumpApex': return ['jump', 2];
    case 'jumpFall': return ['jump', 3];
    case 'special': return spr.own.launch ? ['launch', st.i] : ['specials', 0]; // energy projectile spawns on frame 3
    case 'stun': return ['specials', 2];
    case 'hitAir': case 'down': return ['specials', 1];
    case 'victory': return spr.own.victory ? ['victory', st.i] : ['launch', 1]; // agent celebration (power pose if the file is missing)
    case 'defeat': return ['specials', 2];                                     // loses: dizzy, hand on head
    default: return ['idle', 0];
  }
}

// ---------- PLAYER 2: ROMANA ----------
const ROMANA_ANIM = {
  idle:     { file: ['romana_idle.png'],                                    frames: 1, h: STAND_H, faces: -1 }, // this file looks left
  walk:     { file: ['romana_walk_sequence.png', 'romana_walk.png'],         frames: [4, 1], h: STAND_H,
              pockets: { region: [0, .5, .03, .5], lum: 238, maxPx: 3000 } }, // white flecks trapped in her curl tips (back of the hair only)
  punch:    { file: ['romana_punch_batch.png', 'romana_punch.png'],          frames: [4, 1], h: STAND_H },
  kick:     { file: ['romana_kick_batch.png', 'romana_kick.png'],            frames: [4, 1], h: STAND_H },
  jump:     { file: ['romana_jump_batch.png', 'romana_jump.png'],            frames: 4, h: FH * 1.08 },
  crouch:   { file: ['romana_jump_batch.png', 'romana_crouch.png'],          frames: [4, 1], use: [0], h: CROUCH_H }, // squat = duck
  launch:   { file: ['romana_special_launch.png'],                           frames: 4, h: STAND_H,
              detach: { frames: [2], effect: 'heart' }, projectile: { frame: 2, w: 260 } },              // heart blast leaves on frame 3
  hitBody:  { file: ['romana_hit_bodyblow.png'],                             frames: 4, h: STAND_H },     // punched: doubles over
  hitHead:  { file: ['romana_hit_headrecoil.png'],                           frames: 4, h: STAND_H },     // kicked: head snaps back
  stun:     { file: ['romana_stun_loop.png'],                                frames: 4, h: STAND_H },     // wobbly, dizzy loop
  victory:  { file: ['romana_victory_kiss.png'],                             frames: 4, h: STAND_H }      // land, face camera, pucker, kiss
};
function romanaFrame(st, f, spr) {
  const loop4 = () => Math.floor(G.frame / 9) % 4;
  switch (st.s) {
    case 'walk': return ['walk', ((Math.floor(f.walkPh * .45) % 4) + 4) % 4];
    case 'crouch': return ['crouch', 0];
    case 'punch': case 'kick': return [st.s, st.ph === 'wind' ? (st.k < .5 ? 0 : 1) : st.ph === 'strike' ? 2 : 3];
    case 'airPunch': return ['punch', 2];
    case 'airKick': return ['kick', 2];
    case 'overhead': return f.vy < 0 ? ['jump', 1] : ['kick', 2];
    case 'slam': return ['kick', 2];
    case 'jumpRise': return ['jump', 1];
    case 'jumpApex': return ['jump', 2];
    case 'jumpFall': return ['jump', 3];
    case 'special': return ['launch', st.i];                                  // heart blast spawns on frame 3
    case 'stun':                                                              // hit reaction: punch -> body blow, kick -> head recoil
      return [st.hit === 'head' && spr.own.hitHead ? 'hitHead' : 'hitBody', st.i];
    case 'hitAir': return [spr.own.hitHead ? 'hitHead' : 'hitBody', 2];
    case 'down': return ['hitBody', 1];
    case 'victory': return ['victory', st.i];
    case 'defeat': return spr.own.stun ? ['stun', loop4()] : ['hitBody', 3];   // vulnerable dizzy loop
    default: return ['idle', 0];
  }
}
// ---------- JOE ---------- (one pose per file; a joe_jump.png is picked up automatically if added)
const JOE_ANIM = {
  idle:   { file: ['joe_idle.png'],                    frames: 1, h: STAND_H },
  walk:   { file: ['joe_walk.png', 'joe_idle.png'],    frames: 1, h: STAND_H },
  punch:  { file: ['joe_punch.png'],                   frames: 1, h: FH * 1.1 },
  kick:   { file: ['joe_kick.png'],                    frames: 1, h: FH * 1.08 },
  crouch: { file: ['joe_crouch.png'],                  frames: 1, h: CROUCH_H },
  jump:   { file: ['joe_jump.png', 'joe_crouch.png'],  frames: 1, h: FH * .98 }
};
function joeFrame(st, f) {
  switch (st.s) {
    case 'walk': return [Math.sin(f.walkPh) > 0 ? 'walk' : 'idle', 0];
    case 'crouch': return ['crouch', 0];
    case 'punch': case 'kick': return [st.ph === 'wind' && st.k < .4 ? 'idle' : st.ph === 'recover' && st.k > .6 ? 'idle' : st.s, 0];
    case 'airPunch': case 'special': return ['punch', 0];                   // fireball thrown from the punch pose
    case 'airKick': case 'overhead': case 'slam': return ['kick', 0];
    case 'jumpRise': case 'jumpApex': case 'jumpFall': return ['jump', 0];
    case 'defeat': return ['crouch', 0];                                      // beaten: down on one knee beside the winner
    default: return ['idle', 0];
  }
}

// ---------- LULU ---------- every sheet looks left (faces: -1) and prints captions under the frames (caption: dropped).
// The 1774x887 sheets share one drawing scale: LULU_K maps them to the idle art's size (head-to-feet ~ STAND_H).
const LULU_K = STAND_H / 700;
const LULU_ANIM = {
  idle:     { file: ['lulu_idle.png'],    frames: 1, h: STAND_H, faces: -1 },
  walk:     { file: ['lulu_walk.png'],    frames: 4, k: LULU_K, faces: -1, caption: true },
  jump:     { file: ['lulu_jump.png'],    frames: 4, k: LULU_K, faces: -1, caption: true },        // take-off, rise, apex, fall
  crouch:   { file: ['lulu_crouch.png'],  frames: 3, h: CROUCH_H, fit: 2, faces: -1, caption: true }, // drop, mid, low guard (= duck)
  punch:    { file: ['lulu_punch.png'],   frames: 4, k: LULU_K, faces: -1, caption: true },
  kick:     { file: ['lulu_kick.png'],    frames: 4, k: LULU_K, faces: -1, caption: true },
  // wind-up, launch, arc, catch. Frame 2 of this sheet looks the other way (mirror), and the painted shuriken
  // wave of frames 2 + 3 is wiped (the real, flying shuriken takes over); the shuriken held in frames 1 + 4 stays
  shuriken: { file: ['lulu_special.png'], frames: 4, k: LULU_K, faces: -1, caption: true, mirror: [1], loose: 3000,
              erase: [{ r: [748, 280, 918, 465] }, { r: [665, 280, 748, 465], blue: true },     // frame 2: thrown wave + glow
                      { r: [800, 80, 1400, 240] }, { r: [800, 240, 935, 360], blue: true },     // frame 3: arc over her head,
                      { r: [1295, 190, 1392, 500], blue: true }] },                             //   down to her hand + behind her
  block:    { file: ['lulu_block.png'],   frames: 3, k: LULU_K, faces: -1 },                         // guard, brace, guard
  hit:      { file: ['lulu_hit.png'],     frames: 3, k: LULU_K, faces: -1, caption: true },          // impact, stagger, recover
  ko:       { file: ['lulu_ko.png'],      frames: 3, k: LULU_K, faces: -1, caption: true },          // falling, ground impact, rest
  victory:  { file: ['lulu_victory.png'], frames: 4, k: LULU_K, faces: -1, caption: true }           // Gangnam Style dance
};
const SHURIKEN = { T: 110, reach: 700, rise: 190 }; // flight time (frames), max distance out, how high the return arc climbs
const shurikenReturning = f => projectiles.some(p => p.type === 'shuriken' && p.owner === f && p.t > SHURIKEN.T * .86);
function luluFrame(st, f) {
  switch (st.s) {
    case 'walk': return ['walk', ((Math.floor(f.walkPh * .45) % 4) + 4) % 4];
    case 'crouch': return ['crouch', 2];                                     // low ducking guard: under the special lane
    case 'block': return ['block', f.flash > 0 ? 1 : 0];
    case 'punch': case 'kick': return [st.s, st.ph === 'wind' ? (st.k < .5 ? 0 : 1) : st.ph === 'strike' ? 2 : 3];
    case 'airPunch': return ['punch', 2];
    case 'airKick': return ['kick', 2];
    case 'overhead': return f.vy < 0 ? ['jump', 1] : ['kick', 2];
    case 'slam': return ['kick', 2];
    case 'jumpRise': return ['jump', 1];
    case 'jumpApex': return ['jump', 2];
    case 'jumpFall': return ['jump', 3];
    case 'special': return ['shuriken', [0, 0, 1, 2][st.i]];                 // the shuriken leaves on the launch frame
    case 'stun': return ['hit', [0, 1, 1, 2][st.i]];
    case 'hitAir': return ['ko', 0];                                         // collapse / falling
    // knocked down: flat on the floor for the whole down time, then up through the crouch sheet in order —
    // low kneel, mid squat, rising — and only then back to her fighting stance
    case 'down': return f.knock === 'rise' ? ['crouch', f.knockT > 14 ? 2 : f.knockT > 7 ? 1 : 0] : ['ko', f.ko ? 2 : 1];
    case 'victory': return ['victory', st.i < 1 ? 0 : [1, 2, 3, 2][Math.floor(G.frame / 14) % 4]]; // dance loop
    case 'defeat': return G.phase === 'roundEnd' ? ['hit', 2] : ['ko', 2];
    default: return shurikenReturning(f) ? ['shuriken', 3] : ['idle', 0];  // catches the returning shuriken
  }
}

// ---------- ROKAIA ---------- (sheets in assets/Rokaia/, all looking right, no captions)
// Heights are set from her standing frames so every sheet matches: whip frames are drawn in a crouched lean (.8),
// the crouch sheet's first frame (her guard stance, ponytail up) is the idle.
const RK_DIR = '../Rokaia/';
const ROKAIA_ANIM = {
  idle:    { file: [RK_DIR + 'rokaia_crouch.png'], frames: 3, use: [0], h: STAND_H * 1.11 },
  walk:    { file: [RK_DIR + 'rokaia_walk.png'],   frames: 5, h: STAND_H },
  jump:    { file: [RK_DIR + 'rokaia_jump.png'],   frames: 4, h: STAND_H * 1.06 },
  crouch:  { file: [RK_DIR + 'rokaia_crouch.png'], frames: 3, use: [2], h: CROUCH_H },          // low kneeling guard = duck
  // J = punch is her ponytail hair whip (snap up, lash forward, recoil); K = kick is her own 6-frame high kick
  punch:   { file: [RK_DIR + 'whip_batch1.png'],   frames: 4, use: [0, 1, 2, 1], fit: 0, h: STAND_H * .8 },
  kick:    { file: [RK_DIR + 'rokaia_kick.png'],   frames: 6, fit: 0, h: STAND_H },   // guard, chamber, extension, re-chamber, set down, guard
  launch:  { file: [RK_DIR + 'whip_batch1.png'],   frames: 4, fit: 0, h: STAND_H * .8 },        // ponytail whip special
  block:   { file: [RK_DIR + 'rokaia_block.png'],  frames: 3, fit: 0, h: STAND_H },
  hit:     { file: [RK_DIR + 'rokaia_hit.png'],    frames: 3, h: STAND_H },
  ko:      { file: [RK_DIR + 'rokaia_ko.png'],     frames: 3, h: STAND_H * 1.06 },
  victory: { file: [RK_DIR + 'move3_batch.png'],   frames: 5, fit: 0, h: STAND_H },             // 0° -> 180° arms sweep
  dCross:  { file: [RK_DIR + 'move1_crossover.png'], frames: 8, rows: 2, fit: 0, h: STAND_H * 1.02 }, // dance: crossover grid
  dWaist:  { file: [RK_DIR + 'move1_batch2.png'],  frames: 'auto', fit: 0, h: STAND_H, sameHeight: true } // dance: hands on waist
};
function rokaiaFrame(st, f) {
  switch (st.s) {
    case 'dance': return RK.step ? [RK.step.anim, RK.step.f] : ['victory', 0];   // match win: the music-synced routine
    case 'walk': return ['walk', ((Math.floor(f.walkPh * .5) % 5) + 5) % 5];
    case 'crouch': return ['crouch', 0];
    case 'block': return ['block', f.flash > 0 ? 1 : 0];
    case 'punch': return ['punch', st.ph === 'wind' ? (st.k < .5 ? 0 : 1) : st.ph === 'strike' ? 2 : 3]; // hair whip
    case 'kick': return ['kick', st.ph === 'wind' ? (st.k < .5 ? 0 : 1) : st.ph === 'strike' ? 2 : st.k < .34 ? 3 : st.k < .67 ? 4 : 5];
    case 'airPunch': return ['punch', 2];
    case 'airKick': return ['kick', 2];
    case 'overhead': return f.vy < 0 ? ['jump', 1] : ['kick', 2];
    case 'slam': return ['kick', 2];
    case 'jumpRise': return ['jump', 1];
    case 'jumpApex': return ['jump', 2];
    case 'jumpFall': return ['jump', 3];
    case 'special': return ['launch', [0, 1, 3, 2][st.i]];                    // full extension as the lash leaves
    case 'stun': return ['hit', [0, 1, 1, 2][st.i]];
    case 'hitAir': return ['ko', 0];
    case 'down': return f.knock === 'rise' ? ['crouch', 0] : ['ko', f.ko ? 2 : 1];
    case 'victory': return ['victory', Math.min(st.i, 4)];
    case 'defeat': return G.phase === 'roundEnd' ? ['hit', 2] : ['ko', 2];
    default: return ['idle', 0];
  }
}

/* ---------- ROKAIA's match victory: a 27.0s dance looping with "victory rokaia.mp3" ----------
   The song is decoded, time-stretched (pitch kept) to exactly 27.0s and played by a looping AudioBufferSourceNode
   (gap-free repeat): source -> analyser -> gain -> speakers. The song clock drives the routine: sweep sections map
   song time straight to frames, the 4–8s block is a fixed six-move script that speeds up, and the beat sections step
   on the song's tempo, landing on the drum hits the analyser detects. */
const RK_SONG = 'assets/Rokaia/victory rokaia.mp3', RK_LOOP = 27.0;
// move1_crossover.png poses by the side of the screen the extended arm reaches to (right = screen-right);
// each scripted move gathers through a crossed-arms frame, then lands on the extended pose
const CROSS_RL = { right: [2, 4], left: [0, 6], cross: [7, 1, 3, 5, 7, 1] };
const RK_MAP = [ // [start, end) in seconds
  { t0: 0,  t1: 4,  anim: 'victory', mode: 'sweep', label: 'Victory 3 Arms Sweep' },
  // exactly 6 moves, strictly alternating by screen side, unhurried: they build only gently (~0.75s down to ~0.6s a
  // move, no rushed finish), and each pose is held a little longer after a short crossed-arms gather
  { t0: 4,  t1: 8,  anim: 'dCross', mode: 'script', label: 'Victory 1 Crossover (R/L, building)',
    moves: ['right', 'left', 'right', 'left', 'right', 'left'], pace: [1.12, 1.06, 1.0, .96, .94, .92], gather: .24, bounce: 4 },
  // tempo-locked: crossed, RIGHT, crossed, LEFT, … so every beat lands on the other side (opens crossed: move 6 was left)
  { t0: 8,  t1: 10, anim: 'dCross', mode: 'beat', label: 'Victory 1 Crossover (on the beat)',
    order: [1, CROSS_RL.right[0], 3, CROSS_RL.left[1], 5, CROSS_RL.right[1], 7, CROSS_RL.left[0]] },
  // 10–14s: the same alternation, slightly slower (feel: dCrossSlow) so each pose settles onto a drum hit before
  // the 14s hands-on-waist groove; `cont` carries the R/L order on from 8–10s instead of restarting it
  { t0: 10, t1: 14, anim: 'dCross', mode: 'beat', label: 'Victory 1 Crossover (settling into the groove)', feel: 'dCrossSlow', cont: true,
    order: [1, CROSS_RL.right[0], 3, CROSS_RL.left[1], 5, CROSS_RL.right[1], 7, CROSS_RL.left[0]] },
  { t0: 14, t1: 24, anim: 'dWaist', mode: 'beat', label: 'Victory 1 Hands on Waist' },
  { t0: 24, t1: RK_LOOP, anim: 'victory', mode: 'sweep', label: 'Victory 3 Arms Sweep (finale)' }
];
const RK_SWEEP = [1, 1.2, .8, .8, .5];   // full extension in the last ~12%: it peaks right at 4.0s / at 27.0s
const RK_BPM = 100;                      // felt tempo of the stretched song; used until the analyser has a reading
const RK_FEEL = {
  dCross: { perBeat: 2, maxFps: 4.5, lock: .8 },        // 8–10s: arm out on the beat, crossover on the off-beat
  dCrossSlow: { perBeat: 1.5, maxFps: 3, lock: .85 },   // 10–14s: ~25% slower, each step waits for a drum hit
  dWaist: { perBeat: 1, maxFps: 2.2, lock: .85 }        // 14–24s: one sway per main drum/bass hit
};
const RK = {
  ctx: null, buf: null, src: null, an: null, gain: null, freq: null, wave: null, prev: null, loading: null, ready: false,
  playing: false, startAt: 0, dur: RK_LOOP, last: 0, sec: -1, ord: 0, lastStep: -1, frame: 0, step: null, beat: false,
  energy: 0, peak: .05, fluxAvg: 0, lastBeat: -1, beats: [], bpm: 0, bounce: 0, t: 0
};
function rkLoad() {
  if (RK.loading) return RK.loading;
  RK.loading = (async () => {
    try {
      RK.ctx = new (window.AudioContext || window.webkitAudioContext)();
      RK.an = RK.ctx.createAnalyser(); RK.an.fftSize = 1024; RK.an.smoothingTimeConstant = .6;
      RK.gain = RK.ctx.createGain(); RK.gain.gain.value = soundOn ? 1 : 0;
      RK.an.connect(RK.gain); RK.gain.connect(RK.ctx.destination);
      RK.freq = new Uint8Array(RK.an.frequencyBinCount); RK.wave = new Uint8Array(RK.an.fftSize);
      const r = await fetch(encodeURI(RK_SONG)); if (!r.ok) return false;
      const raw = await RK.ctx.decodeAudioData(await r.arrayBuffer());
      RK.buf = await rkStretch(raw, Math.round(RK_LOOP * raw.sampleRate));
      RK.dur = RK.buf.duration; RK.ready = true;
      return true;
    } catch (e) { console.warn('Rokaia victory song unavailable:', e); return false; }
  })();
  return RK.loading;
}
['pointerdown', 'keydown', 'touchstart'].forEach(t => addEventListener(t, () => { if (SPRITES.rokaia) rkLoad(); }, { capture: true, passive: true, once: true }));
// Pitch-preserving time-stretch (WSOLA): Hann-windowed grains of the song are laid out on the longer timeline; each is
// taken from the spot near its nominal position that best continues the previous grain (cross-correlation)
async function rkStretch(buf, outLen) {
  const ch = buf.numberOfChannels, inLen = buf.length, N = 2048, Hs = N / 2, rate = inLen / outLen, TOL = 480, L = N / 2;
  const src = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  const mono = new Float32Array(inLen); for (const s of src) for (let i = 0; i < inLen; i++) mono[i] += s[i] / ch;
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = .5 - .5 * Math.cos(2 * Math.PI * i / N);
  const out = RK.ctx.createBuffer(ch, outLen, buf.sampleRate), dst = [...Array(ch)].map((_, c) => out.getChannelData(c));
  const at = (a, i) => (i >= 0 && i < inLen ? a[i] : 0), wsum = new Float32Array(outLen);
  let prev = 0;
  for (let k = 0; k * Hs < outLen; k++) {
    let pos = 0;
    if (k) {
      const nominal = Math.round(k * Hs * rate), cont = prev + Hs;
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
    if (k % 120 === 119) await new Promise(r => setTimeout(r, 0));
  }
  for (let i = 0; i < outLen; i++) { const w = Math.max(wsum[i], .05); if (w !== 1) for (let c = 0; c < ch; c++) dst[c][i] /= w; } // no dip at the seam
  for (let c = 0; c < ch; c++) for (let i = 0; i < Hs && i < outLen; i++) dst[c][i] = src[c][i];
  return out;
}
const rkTime = () => RK.playing ? (RK.ctx.currentTime - RK.startAt) % RK.dur : RK.t;
async function rkPlay(from = 0) {
  rkStop(); RK.want = true; RK.t = from; RK.sec = -1; RK.last = from;
  if (!(await rkLoad()) || !RK.want) return;               // no song: the routine still runs on its own clock (rkUpdate)
  if (RK.ctx.state === 'suspended') { try { await RK.ctx.resume(); } catch (e) {} }
  if (RK.ctx.state !== 'running' || !RK.want) return;      // audio not allowed yet: keep dancing on the silent clock
  RK.gain.gain.value = soundOn ? 1 : 0;
  const src = RK.ctx.createBufferSource();
  src.buffer = RK.buf; src.loop = true; src.connect(RK.an);  // loops seamlessly at 27.0s
  const off = RK.t % RK.dur;
  src.start(0, off); RK.src = src; RK.startAt = RK.ctx.currentTime - off; RK.playing = true;
}
function rkStop() {
  RK.want = false;
  if (RK.src) { const s = RK.src; RK.src = null; try { s.stop(); } catch (e) {} }
  RK.playing = false;
}
function rkAnalyse(t) {
  if (!RK.an || !RK.playing) { RK.energy = lerp(RK.energy, .5, .05); return false; }
  RK.an.getByteTimeDomainData(RK.wave); RK.an.getByteFrequencyData(RK.freq);
  let sq = 0; for (const v of RK.wave) { const x = (v - 128) / 128; sq += x * x; }
  const rms = Math.sqrt(sq / RK.wave.length);
  RK.peak = Math.max(rms, RK.peak * .9995, .04);
  RK.energy = lerp(RK.energy, clamp(rms / RK.peak, 0, 1), .25);
  // spectral flux (rises across 40 Hz – 2.6 kHz) against an adaptive threshold: the kick / snare hits
  if (!RK.prev) RK.prev = new Uint8Array(RK.freq.length);
  let flux = 0; for (let i = 1; i <= 60; i++) { const d = RK.freq[i] - RK.prev[i]; if (d > 0) flux += d; }
  RK.prev.set(RK.freq);
  const beat = flux > RK.fluxAvg * 1.6 + 25 && (RK.lastBeat < 0 || t - RK.lastBeat > .24 || t < RK.lastBeat);
  RK.fluxAvg = lerp(RK.fluxAvg || flux, flux, .08);
  if (beat) {
    if (RK.lastBeat >= 0 && t > RK.lastBeat && t - RK.lastBeat < 1.5) { RK.beats.push(t - RK.lastBeat); if (RK.beats.length > 12) RK.beats.shift(); }
    let bpm = RK.beats.length >= 3 ? 60 / [...RK.beats].sort((a, b) => a - b)[RK.beats.length >> 1] : 0;
    while (bpm > 180) bpm /= 2;
    if (bpm) RK.bpm = Math.round(bpm);
    RK.lastBeat = t;
  }
  return beat;
}
// song time -> Rokaia's dance frame (RK.step); runs every rendered frame while she is the match winner
function rkUpdate(dt) {
  const spr = SPRITES.rokaia; if (!spr) return;
  if (!RK.playing) RK.t = (RK.t + dt / 1000) % RK.dur;      // silent fallback clock
  const t = rkTime();
  if (t < RK.last - .5) RK.sec = -1;                         // the song looped back to 0.0s: restart the routine
  RK.last = t;
  const beat = rkAnalyse(t);
  let si = RK_MAP.findIndex(s => t >= s.t0 && t < s.t1); if (si < 0) si = RK_MAP.length - 1;
  const S = RK_MAP[si], A = spr[S.anim], n = A ? A.frames.length : 1;
  if (si !== RK.sec) {
    const carry = S.cont && RK.sec === si - 1;                // continue the previous section's R/L order
    RK.sec = si; if (!carry) { RK.ord = 0; RK.frame = S.order ? S.order[0] : 0; } RK.lastStep = t;
  }
  RK.beat = false;
  if (S.mode === 'sweep') {
    const w = RK_SWEEP.slice(0, n), tot = w.reduce((a, b) => a + b, 0);
    let u = clamp((t - S.t0) / (S.t1 - S.t0), 0, .9999) * tot, f = 0;
    while (f < n - 1 && u >= w[f]) u -= w[f++];
    RK.frame = f;
  } else if (S.mode === 'script') {
    const tot = S.pace.reduce((a, b) => a + b, 0), scale = (S.t1 - S.t0) / tot;
    let m = 0, start = S.t0;
    while (m < S.moves.length - 1 && t >= start + S.pace[m] * scale) start += S.pace[m++] * scale;
    const k = (t - start) / (S.pace[m] * scale), side = S.moves[m];
    const pose = CROSS_RL[side][Math.floor(m / 2) % 2], f = k < S.gather ? CROSS_RL.cross[m] : pose;
    if (f === pose && RK.frame !== pose) { RK.bounce = 1; RK.beat = true; }
    RK.frame = f;
  } else {
    const B = RK_FEEL[S.feel || S.anim], T = 60 / (RK.bpm || RK_BPM);
    const iv = Math.max(T / B.perBeat * (1.12 - .24 * RK.energy), 1 / B.maxFps), since = t - RK.lastStep;
    if (RK.lastStep < 0 || since < 0) RK.lastStep = t;
    else if ((beat && since >= iv * B.lock) || since >= iv * 1.5) {
      if (S.order) { RK.ord = (RK.ord + 1) % S.order.length; RK.frame = S.order[RK.ord]; }
      else RK.frame = (RK.frame + 1) % n;
      RK.lastStep = t; RK.bounce = 1; RK.beat = true;
    }
  }
  RK.bounce = Math.max(0, RK.bounce - dt / 260);
  const amp = S.bounce != null ? S.bounce : S.anim === 'dCross' ? 12 : S.anim === 'dWaist' ? 6 : 0; // toe-bounce
  RK.step = { anim: S.anim, f: Math.min(RK.frame, n - 1), lift: Math.sin(RK.bounce * Math.PI) * amp * (.5 + RK.energy), section: S, t };
}
// ROKAIA's special: a ponytail lash that cracks forward along the special lane (same lane / hit radius as the others)
const WHIP_LASH = { speed: 34, life: 22 };

/* ---------- ROSTER: every selectable fighter ----------
   special: 'gun' = MOE's energy blast, 'flower' = ROMANA's heart blast, 'fire' = JOE's fireball (all share the same lane,
   speed rules and 10 damage). Any two can meet, including mirror matches. */
const ROSTER = {
  moe:    { id: 'moe', name: 'MOE', base: 'moe', anims: MOE_ANIM, frame: moeFrame, idle: { speed: .045, amp: 1 }, victoryFrom: 3.8,
            color: '#ff6a2a', special: 'gun', specialName: 'ENERGY BLAST!', hud: 'BLAST', hitWord: 'ZAPPED!', hitColor: '#ff3030', tag: 'Secret agent' },
  joe:    { id: 'joe', name: 'JOE', base: 'joe', anims: JOE_ANIM, frame: joeFrame, idle: { speed: .06, amp: 2 }, victoryFrom: 3.8,
            portrait: '../../WebGame/Joe selection.png', avatar: [.4, .06, .24],   // select card: his character-select photo
            color: '#ffb000', special: 'fire', specialName: 'FIREBALL!', hud: 'FIRE', hitWord: 'BURNED!', hitColor: '#ff6a2a', tag: 'Fire ninja' },
  romana: { id: 'romana', name: 'ROMANA', base: 'romana', anims: ROMANA_ANIM, frame: romanaFrame, idle: { speed: .08, amp: 2.5 }, victoryFrom: 2.95,
            color: '#ff4a7a', special: 'flower', specialName: 'HEART BLAST!', hud: 'HEART', hitWord: 'HEARTBROKEN!', hitColor: '#ff4a6a', tag: 'Royal heartbreaker' },
  lulu:   { id: 'lulu', name: 'LULU', base: 'lulu', anims: LULU_ANIM, frame: luluFrame, idle: { speed: .07, amp: 2 }, victoryFrom: 3.8,
            portrait: 'lulu_portrait.png', avatar: [.36, .01, .33], lieArt: true, // select-card art; head crop [x, y, size] of it
            cleanWhite: { region: [0, 1, 0, 1], lum: 230, minPx: 30, headY: .22, minPxHead: 120 },          // wears no white: clear every trapped gap
            color: '#4aa8ff', special: 'shuriken', specialName: 'SHURIKEN WAVE!', hud: 'SHURIKEN', hitWord: 'SLICED!', hitColor: '#3aa0ff', tag: 'Shuriken ninja' },
  rokaia: { id: 'rokaia', name: 'ROKAIA', base: 'rokaia', anims: ROKAIA_ANIM, frame: rokaiaFrame, idle: { speed: .06, amp: 1.5 }, victoryFrom: 3.8,
            portrait: RK_DIR + 'rokaia_ref_1.png', avatar: [.3, .04, .42], lieArt: true, dance: true, // match win: 27s music dance
            cleanWhite: { region: [0, 1, 0, 1], lum: 230, minPx: 30, headY: .22, minPxHead: 120 },          // wears no white: clear every trapped gap
            color: '#ff3a5a', special: 'whip', specialName: 'PONYTAIL WHIP!', hud: 'WHIP', hitWord: 'WHIPPED!', hitColor: '#ff4a5a', tag: 'Ponytail fighter' }
};
const ROSTER_ORDER = ['moe', 'joe', 'romana', 'lulu', 'rokaia'];
const CHARACTERS = ROSTER_ORDER.map(k => ROSTER[k]);
const SPRITES = {};   // id -> loaded animations (filled at startup)
const SLOT_KEYS = ['F', 'NUM3/V'];
// build the two fighters for the chosen characters (P1 left, P2 right)
function makeFighters(p1, p2) {
  fighters = [p1, p2].map((id, idx) => {
    const C = ROSTER[id] || ROSTER.moe;
    return new Fighter({ idx, name: C.name, spr: SPRITES[C.id], char: C, color: C.color, special: C.special, specialKey: SLOT_KEYS[idx], charId: C.id });
  });
  fighters[0].reset(STAGE_W / 2 - 280); fighters[1].reset(STAGE_W / 2 + 280);
  MATCH.chars = [fighters[0].charId, fighters[1].charId];
}
const MATCH = { chars: ['moe', 'romana'] };

// white background -> transparency on a canvas (no-op for pixels that are already transparent)
function keyWhite(d, W0, H0) {
  const N = W0 * H0, lum = i => Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  const bg = new Uint8Array(N), q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (d[i * 4 + 3] < 8) bg[i] = 1;      // already transparent
  // 1) near-white connected to the image border = paper
  const seed = i => { if (!bg[i] && lum(i) >= 228) { bg[i] = 1; q[qt++] = i; } };
  for (let x = 0; x < W0; x++) { seed(x); seed((H0 - 1) * W0 + x); }
  for (let y = 0; y < H0; y++) { seed(y * W0); seed(y * W0 + W0 - 1); }
  for (let i = 0; i < N; i++) if (bg[i] && d[i * 4 + 3] < 8) q[qt++] = i;  // grow from existing transparency too
  while (qh < qt) { const i = q[qh++], x = i % W0; if (x > 0) seed(i - 1); if (x < W0 - 1) seed(i + 1); if (i >= W0) seed(i - W0); if (i < N - W0) seed(i + W0); }
  // 2) (no "enclosed white" pass) ONLY white that is connected to the image's outer edge is background. White that
  //    is enclosed by the figure — Moe's shirt, collars, cuffs — is part of the outfit and always stays solid white.
  // 3) halo-free edges: within EDGE px of the paper, solve "pixel = colour·α + white·(1-α)" using nearby solid
  //    pixels as the true colour, and store the clean colour with that α (the white rim disappears)
  const EDGE = 4, src = new Uint8ClampedArray(d), dist = new Uint8Array(N);
  qh = qt = 0;
  for (let i = 0; i < N; i++) {
    if (bg[i]) { d[i * 4 + 3] = 0; continue; }
    const x = i % W0;
    if ((x > 0 && bg[i - 1]) || (x < W0 - 1 && bg[i + 1]) || (i >= W0 && bg[i - W0]) || (i < N - W0 && bg[i + W0])) { dist[i] = 1; q[qt++] = i; }
  }
  while (qh < qt) {
    const i = q[qh++], x = i % W0, nd = dist[i] + 1;
    if (nd > EDGE + 1) continue;
    for (const j of [x > 0 ? i - 1 : -1, x < W0 - 1 ? i + 1 : -1, i - W0, i + W0]) if (j >= 0 && j < N && !bg[j] && !dist[j]) { dist[j] = nd; q[qt++] = j; }
  }
  for (let i = 0; i < N; i++) {
    const di = dist[i]; if (!di || di > EDGE) continue;
    if (src[i * 4 + 3] < 250) continue;               // already soft-edged by the artist: keep as is
    const x = i % W0, y = (i - x) / W0;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W0 || yy >= H0) continue;
      const j = yy * W0 + xx; if (bg[j] || (dist[j] && dist[j] <= EDGE)) continue;
      r += src[j * 4]; gg += src[j * 4 + 1]; b += src[j * 4 + 2]; n++;
    }
    const c = [src[i * 4], src[i * 4 + 1], src[i * 4 + 2]];
    const fg = n ? [r / n, gg / n, b / n] : c.map(v => Math.min(v, 200));
    let a = 0, used = 0;
    for (let k = 0; k < 3; k++) { const room = 255 - fg[k]; if (room > 28) { a = Math.max(a, (255 - c[k]) / room); used++; } }
    if (!used) a = lum(i) >= 236 ? 0 : 1;               // body itself is near-white (shirt cuff): keep unless it is paper
    a = clamp(a, 0, 1);
    if (a < .14) a = 0;
    for (let k = 0; k < 3; k++) d[i * 4 + k] = a > 0 ? clamp(a >= .98 ? c[k] : (c[k] - 255 * (1 - a)) / a, 0, 255) : 0;
    if (a > 0 && a < .98) for (let k = 0; k < 3; k++) d[i * 4 + k] = lerp(d[i * 4 + k], fg[k], .5);
    d[i * 4 + 3] = a * 255;
  }
}
// key a file once (animations sharing a file reuse it) -> { cv: keyed canvas facing right, d: its pixels, W, H }
const KEYED = {};
function keyedFile(img, name, faces, erase) {
  const key = name + '|' + faces;
  if (KEYED[key]) return KEYED[key];
  const W0 = img.naturalWidth, H0 = img.naturalHeight, cv = mk(W0, H0), g = cv.getContext('2d');
  if (faces < 0) { g.translate(W0, 0); g.scale(-1, 1); }   // normalise: every frame faces right
  g.drawImage(img, 0, 0); g.setTransform(1, 0, 0, 1, 0, 0);
  const id = g.getImageData(0, 0, W0, H0);                 // throws when opened as file:// (caller reports it)
  if (erase) eraseRegions(id.data, W0, H0, erase, faces < 0);
  keyWhite(id.data, W0, H0);
  g.putImageData(id, 0, 0);
  return (KEYED[key] = { cv, d: id.data, W: W0, H: H0, flip: faces < 0 });
}
// painted effects that a projectile takes over (LULU's shuriken in her throw frames), wiped before keying.
// Rects are in the ORIGINAL file's pixels: [x0, y0, x1, y1]; blue: only the glowing blue effect pixels inside it
// (skin, hair, the navy gloves and the white paper are kept), otherwise everything inside it goes
function eraseRegions(d, W0, H0, list, flipped) {
  for (const E of list) {
    const [ax, y0, bx, y1] = E.r, x0 = flipped ? W0 - 1 - bx : ax, x1 = flipped ? W0 - 1 - ax : bx;
    for (let y = Math.max(0, y0); y <= Math.min(H0 - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(W0 - 1, x1); x++) {
      const i = (y * W0 + x) * 4;
      if (!E.blue || (d[i + 2] > 200 && d[i + 2] - d[i] > 50) || (d[i + 2] > 225 && d[i + 2] - d[i] > 18)) d[i + 3] = 0; // core + pale glow
    }
  }
}
// Frame slicing. Every figure in a batch is a connected shape: the n biggest shapes are the frames (left to right,
// each frame's sX = its left edge in the file). Smaller loose pieces join a frame — a thrown effect (energy / heart,
// see EFFECT) joins the figure on its LEFT that threw it, anything else the nearest figure. Each frame keeps only its
// own pixels, so art that overlaps a neighbour's columns never bleeds across. If the art has fewer separate shapes
// than frames, it falls back to equal-width slices (sX = i * width / frames).
function sliceFrames(K, n, effect, caption, loose, rows = 1) {
  const { d, W, H } = K, N = W * H, lab = new Int32Array(N), q = new Int32Array(N), comps = [], E = effect && EFFECT[effect];
  const cls = new Uint8Array(N); // 2 = effect-coloured pixel, 1 = anything else opaque (they never join one shape)
  for (let i = 0; i < N; i++) if (d[i * 4 + 3] > 40) cls[i] = E && E.cls(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) ? 2 : 1;
  for (let s = 0; s < N; s++) {
    if (lab[s] || !cls[s]) continue;
    const L = comps.length + 1, C = cls[s]; let x0 = W, x1 = 0, y0 = H, y1 = 0, qh = 0, qt = 0;
    lab[s] = L; q[qt++] = s;
    while (qh < qt) {
      const i = q[qh++], x = i % W, y = (i - x) / W;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !lab[i - 1] && cls[i - 1] === C) { lab[i - 1] = L; q[qt++] = i - 1; }
      if (x < W - 1 && !lab[i + 1] && cls[i + 1] === C) { lab[i + 1] = L; q[qt++] = i + 1; }
      if (y > 0 && !lab[i - W] && cls[i - W] === C) { lab[i - W] = L; q[qt++] = i - W; }
      if (y < H - 1 && !lab[i + W] && cls[i + W] === C) { lab[i + W] = L; q[qt++] = i + W; }
    }
    if (qt >= 15) comps.push({ L, x0, x1, y0, y1, n: qt, fx: C === 2 ? 1 : 0 });
  }
  if (n === 'auto') { // as many frames as there are big shapes (at least 20% of the biggest)
    const nf = comps.filter(c => !c.fx), big = Math.max(0, ...nf.map(c => c.n));
    n = Math.max(1, nf.filter(c => c.n >= big * .2).length);
  }
  // two neighbouring frames whose art touches (an energy ring brushing the next frame's shoe) form one over-wide
  // shape: split it at its emptiest column(s) near the even sub-splits (a grid sheet: per row)
  const slot = W / Math.ceil(n / rows);
  for (const c of [...comps]) {
    const parts = Math.round((c.x1 - c.x0 + 1) / slot);
    if (n < 2 || parts < 2 || c.x1 - c.x0 + 1 < 1.35 * slot) continue;
    const cw = c.x1 - c.x0 + 1, col = new Uint32Array(cw);
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (lab[y * W + x] === c.L) col[x - c.x0]++;
    const cuts = [];
    for (let p = 1; p < parts; p++) {
      const mid = cw * p / parts, r = cw / parts * .3; let best = Math.round(mid), bv = Infinity;
      for (let x = Math.round(mid - r); x <= Math.round(mid + r); x++) if (x > 0 && x < cw && col[x] + Math.abs(x - mid) * 1e-3 < bv) { bv = col[x] + Math.abs(x - mid) * 1e-3; best = x; }
      cuts.push(c.x0 + best);
    }
    cuts.push(c.x1 + 1);
    let prev = c.x0;
    cuts.forEach((cut, p) => {
      const part = p === 0 ? c : { L: comps.length + 1 + p, x0: W, x1: 0, y0: H, y1: 0, n: 0, fx: c.fx };
      if (p) { comps.push(part); part.L = comps.length; }
      let x0 = W, x1 = 0, y0 = H, y1 = 0, cnt = 0;
      for (let y = c.y0; y <= c.y1; y++) for (let x = prev; x < cut; x++) {
        const i = y * W + x; if (lab[i] !== c.L) continue;
        if (p) lab[i] = part.L;
        cnt++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      Object.assign(part, { x0, x1, y0, y1, n: cnt });
      prev = cut;
    });
  }
  let figs = comps.filter(c => !c.fx).sort((a, b) => b.n - a.n).slice(0, n).sort((a, b) => a.x0 - b.x0); // figures: never an effect
  if (rows > 1) { // grid sheet: row by row (by vertical centre), each row left to right
    const per = Math.ceil(n / rows), byY = [...figs].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    figs = [];
    for (let r = 0; r < rows; r++) figs.push(...byY.slice(r * per, (r + 1) * per).sort((a, b) => a.x0 - b.x0));
  }
  if (figs.length < n || figs[0] && figs.some(f => f.n < .12 * Math.max(...figs.map(g => g.n)))) { // shapes touch: equal slices
    return Array.from({ length: n }, (_, i) => { const a = Math.round(W * i / n), b = Math.round(W * (i + 1) / n);
      return cutFrame(K, (x, y) => x >= a && x < b && d[(y * W + x) * 4 + 3] > 40, a, 0, b - 1, H - 1); });
  }
  const own = figs.map(f => ({ set: new Set([f.L]), fx: new Set(), x0: f.x0, x1: f.x1, y0: f.y0, y1: f.y1 }));
  const nearest = c => { let k = 0, bd = Infinity; figs.forEach((f, i) => { const dx = Math.max(0, f.x0 - c.x1, c.x0 - f.x1), dy = Math.max(0, f.y0 - c.y1, c.y0 - f.y1), dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; k = i; } }); return k; };
  const add = (c, k, isFx) => { const o = own[k]; o.set.add(c.L); if (isFx) o.fx.add(c.L); o.x0 = Math.min(o.x0, c.x0); o.x1 = Math.max(o.x1, c.x1); o.y0 = Math.min(o.y0, c.y0); o.y1 = Math.max(o.y1, c.y1); };
  const fxBoxes = [];
  for (const c of comps) { // 1) effect shapes: held inside a figure's box -> that figure; thrown -> the nearest figure behind it
    if (figs.includes(c) || !c.fx) continue;
    const cx = (c.x0 + c.x1) / 2;
    let k = figs.findIndex(f => c.x0 >= f.x0 - 4 && c.x1 <= f.x1 + 4);
    if (k < 0) { let bx = -Infinity; figs.forEach((f, i) => { const fc = (f.x0 + f.x1) / 2; if (fc < cx && fc > bx) { bx = fc; k = i; } }); }
    if (k < 0) k = nearest(c);
    add(c, k, true); fxBoxes.push([c, k]);
  }
  for (const c of comps) { // 2) other loose pieces: inside an effect (its outline / white-hot core) -> with it; else nearest figure
    if (figs.includes(c) || c.fx) continue;
    const cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2;
    const hit = fxBoxes.find(([e]) => cx >= e.x0 - 8 && cx <= e.x1 + 8 && cy >= e.y0 - 8 && cy <= e.y1 + 8);
    const k = hit ? hit[1] : nearest(c);
    if (caption && !hit && (c.y0 > figs[k].y1 - 2 || c.y1 > figs[k].y1 + 2)) continue; // caption text under the feet: dropped
    if (loose && !hit && c.n < loose) continue;             // small specks left over from a wiped effect: dropped
    hit ? add(c, k, true) : add(c, k, false);
  }
  return own.map(o => cutFrame(K, (x, y) => o.set.has(lab[y * W + x]), o.x0, o.y0, o.x1, o.y1, (x, y) => o.fx.has(lab[y * W + x])));
}
// copy one frame's own pixels into its own canvas and measure it:
// feet centre (anchor), frontmost fist (12-50% of the height) and frontmost foot (5-80%)
function cutFrame(K, mine, x0, y0, x1, y1, isFx) {
  const { d, W } = K, w = x1 - x0 + 1, h = y1 - y0 + 1, c = mk(w, h), g = c.getContext('2d'), im = g.createImageData(w, h), o = im.data, op = new Uint8Array(w * h);
  const fx = new Uint8Array(w * h); // pixels of loose effect shapes (the thrown energy / heart)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mine(x0 + x, y0 + y)) continue;
    const i = ((y0 + y) * W + x0 + x) * 4, j = (y * w + x) * 4;
    o[j] = d[i]; o[j + 1] = d[i + 1]; o[j + 2] = d[i + 2]; o[j + 3] = d[i + 3];
    if (d[i + 3] > 40) op[y * w + x] = 1;
    if (isFx && isFx(x0 + x, y0 + y)) fx[y * w + x] = 1;
  }
  g.putImageData(im, 0, 0);
  let sx = 0, n = 0;
  for (let y = Math.floor(h * .88); y < h; y++) for (let x = 0; x < w; x++) if (op[y * w + x]) { sx += x; n++; }
  const front = (f0, f1) => {
    let best = null;
    for (let y = Math.floor(h * f0); y <= h * f1 && y < h; y++) for (let x = w - 1; x >= 0; x--) if (op[y * w + x]) { if (!best || x > best[0]) best = [x, y]; break; }
    return best ? [best[0] - 12 * h / 400, best[1]] : [w, h * .3];
  };
  return { c, data: o, fx, x0, y0, w, h, ax: n ? sx / n : w / 2, hand: front(.12, .5), foot: front(.05, .8) };
}
// high-quality resize (halving steps when shrinking a lot, then the exact size)
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
// visual effects painted into launch frames, picked out by colour and cut loose (see `detach` in the animation data):
//   energy = MOE's blue-white blast, heart = ROMANA's orange-gold heart. Only the front part of the frame is searched
//   (the effect is in front of the hands), starting from strongly coloured pixels and growing into its glow.
// cls = the effect's core colour: those pixels form their own shapes when slicing frames, so a thrown effect that
// touches the next frame's figure (the heart brushing frame 4's hair) never gets glued to it
const EFFECT = {
  energy: { front: .55, cls: (r, g, b) => b > r + 20 && b > 120,
            seed: (r, g, b) => b > r + 30 && b > 150, grow: (r, g, b) => b >= r + 6 || Math.min(r, g, b) > 205 },
  // orange / gold fire: green well above blue (skin has green only ~30-45 above blue, so arms and legs are left alone)
  heart:  { front: .5,  cls: (r, g, b) => r > 205 && g > 100 && g - b > 65,
            seed: (r, g, b) => r > 220 && g > 120 && b < 110 && g - b > 75,
            grow: (r, g, b) => (r > 205 && g > 100 && g - b > 65) || Math.min(r, g, b) > 232 }
};
function effectMask(F, effect) {
  const d = F.data, E = EFFECT[effect], w = F.w, h = F.h, m = new Uint8Array(w * h), q = new Int32Array(w * h);
  const at = (x, y) => (y * w + x) * 4, xmin = Math.floor(w * E.front);
  let qh = 0, qt = 0;
  for (let y = 0; y < h; y++) for (let x = xmin; x < w; x++) { const i = at(x, y); if (d[i + 3] > 40 && E.seed(d[i], d[i + 1], d[i + 2])) { m[y * w + x] = 1; q[qt++] = y * w + x; } }
  if (F.fx) for (let j = 0; j < w * h; j++) if (F.fx[j] && !m[j]) { m[j] = 1; q[qt++] = j; } // loose effect shapes, outline and all
  while (qh < qt) {
    const j = q[qh++], x = j % w, y = (j - x) / w;
    for (const [xx, yy] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (xx < xmin || yy < 0 || xx >= w || yy >= h) continue;
      const jj = yy * w + xx, i = at(xx, yy);
      if (!m[jj] && d[i + 3] > 20 && E.grow(d[i], d[i + 1], d[i + 2])) { m[jj] = 1; q[qt++] = jj; }
    }
  }
  const out = new Uint8Array(m); // 1px dilation: take the soft glow edge along
  for (let y = 1; y < h - 1; y++) for (let x = Math.max(1, xmin); x < w - 1; x++) if (!m[y * w + x] && (m[y * w + x - 1] || m[y * w + x + 1] || m[(y - 1) * w + x] || m[(y + 1) * w + x])) out[y * w + x] = 1;
  return out;
}
// Enclosed white "pockets" (paper trapped between Moe's legs or inside Romana's curl tips) can't be reached by the
// border flood fill. Inside one animation's chosen region (fractions of the frame: [x0, x1, y0, y1]) every white area
// that lies completely within the region is made fully transparent, and the light rim around it is softened.
// Regions are chosen per animation so white clothing (shirt, cuffs, collar) and faces / sparkles are never touched.
function clearPockets(F, o) {
  const { w, h, data: d } = F, N = w * h, lum = j => Math.min(d[j * 4], d[j * 4 + 1], d[j * 4 + 2]);
  const x0 = Math.floor(o.region[0] * w), x1 = Math.ceil(o.region[1] * w), y0 = Math.floor(o.region[2] * h), y1 = Math.ceil(o.region[3] * h);
  const seen = new Uint8Array(N), q = new Int32Array(N), cleared = new Uint8Array(N), maxPx = o.maxPx || Infinity;
  const white = j => d[j * 4 + 3] >= 128 && lum(j) >= o.lum;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const s = y * w + x; if (seen[s] || !white(s)) continue;
    let qh = 0, qt = 0, inside = true; q[qt++] = s; seen[s] = 1;
    while (qh < qt) {
      const i = q[qh++], xx = i % w, yy = (i - xx) / w;
      if (xx < x0 || xx >= x1 || yy < y0 || yy >= y1) inside = false;
      for (const j of [xx > 0 ? i - 1 : -1, xx < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < N && !seen[j] && white(j)) { seen[j] = 1; q[qt++] = j; }
    }
    // minPx: tiny spots stay; in the head band (top headY of the frame, where eye whites and teeth are) the limit
    // is minPxHead (s is the pocket's first pixel in row order, i.e. its top row)
    const minPx = o.headY != null && y < h * o.headY ? o.minPxHead : (o.minPx || 0);
    if (!inside || qt > maxPx || qt < minPx) continue;
    for (let k = 0; k < qt; k++) { d[q[k] * 4 + 3] = 0; cleared[q[k]] = 1; }
  }
  // soften the pale anti-aliased rim around each cleared pocket (2px) so no white outline is left behind
  for (let pass = 0; pass < 2; pass++) for (let j = 0; j < N; j++) {
    if (cleared[j] || d[j * 4 + 3] === 0) continue;
    const x = j % w;
    if (!((x > 0 && cleared[j - 1]) || (x < w - 1 && cleared[j + 1]) || (j >= w && cleared[j - w]) || (j < N - w && cleared[j + w]))) continue;
    const L = lum(j); if (L < 170) continue;
    d[j * 4 + 3] = Math.round(d[j * 4 + 3] * clamp((255 - L) / 85, 0, 1)); cleared[j] = 2;
  }
  F.c.getContext('2d').putImageData(new ImageData(d, w, h), 0, 0);
}
// keyed batch -> animation: frames cut + measured, packed side by side and resized once (gameplay + game-over size).
// Result: { strip, big, frames: [{ sX, sY, w, h, ax, hand, foot, big: { sX, sY, w, h } }], proj? } — all in on-screen px
// one frame mirrored on its own (a sheet whose frames don't all look the same way), re-measured
function mirrorFrame(F) {
  const { w, h } = F, d = new Uint8ClampedArray(w * h * 4), fx = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = y * w + x, t = y * w + w - 1 - x;
    d.set(F.data.subarray(s * 4, s * 4 + 4), t * 4); fx[t] = F.fx[s];
  }
  return Object.assign(cutFrame({ d, W: w }, () => true, 0, 0, w - 1, h - 1, (x, y) => fx[y * w + x]), { x0: F.x0, y0: F.y0 });
}
// one cut frame scaled by s (its canvas + measurements); used to bring poses drawn at different sizes to one height
function sizeFrame(F, s) {
  if (Math.abs(s - 1) < .005) return F;
  const c = resizeHQ(F.c, F.w * s, F.h * s);
  return { ...F, c, w: c.width, h: c.height, ax: F.ax * s, hand: [F.hand[0] * s, F.hand[1] * s], foot: [F.foot[0] * s, F.foot[1] * s] };
}
function buildAnim(K, spec, nFrames) {
  let fr = sliceFrames(K, nFrames, spec.detach && spec.detach.effect, spec.caption, spec.loose, spec.rows);
  if (K.flip && fr.length > 1) fr.reverse();              // a left-facing sheet was mirrored: frame 1 is now on the right
  if (spec.mirror) spec.mirror.forEach(i => { if (fr[i]) fr[i] = mirrorFrame(fr[i]); });
  if (spec.pockets) fr.forEach(F => clearPockets(F, spec.pockets));
  if (spec.sameHeight) fr = fr.map(F => sizeFrame(F, fr[0].h / F.h)); // e.g. the 2-pose hands-on-waist sheet (after cleaning: it resizes the canvas)
  if (spec.use) fr = spec.use.map(i => fr[Math.min(i, fr.length - 1)]);
  // scale: k (screen px per file px) when given, else the tallest frame — or frame `fit` — is h tall (or the widest is w)
  const k = spec.k || (spec.w ? spec.w / Math.max(...fr.map(F => F.w)) : spec.h / (spec.fit != null ? fr[spec.fit].h : Math.max(...fr.map(F => F.h))));
  const mh = Math.max(...fr.map(F => F.h)), pad = Math.ceil(6 / (k * MONTAGE_MULT)) + 2; // keep frames apart after resizing
  const src = mk(fr.reduce((s, F) => s + F.w + pad, pad), mh), sg = src.getContext('2d');
  let x = pad;
  let proj = null;
  const pos = fr.map((F, i) => {
    sg.drawImage(F.c, x, mh - F.h);
    if (spec.fadeBottom) { // art cropped above the feet: fade the cut edge out instead of a hard line
      const fb = F.h * spec.fadeBottom, gr = sg.createLinearGradient(0, mh - fb, 0, mh);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
      sg.save(); sg.globalCompositeOperation = 'destination-out'; sg.fillStyle = gr; sg.fillRect(x, mh - fb, F.w, fb); sg.restore();
    }
    if (spec.detach && spec.detach.frames.includes(i)) {
      // cut the thrown effect out of this frame (the projectile carries it from here on)
      const m = effectMask(F, spec.detach.effect), id = sg.getImageData(x, mh - F.h, F.w, F.h);
      let bx0 = F.w, bx1 = -1, by0 = F.h, by1 = -1;
      for (let j = 0; j < m.length; j++) if (m[j]) {
        id.data[j * 4 + 3] = 0;
        const xx = j % F.w, yy = (j - xx) / F.w; if (xx < bx0) bx0 = xx; if (xx > bx1) bx1 = xx; if (yy < by0) by0 = yy; if (yy > by1) by1 = yy;
      }
      sg.putImageData(id, x, mh - F.h);
      if (spec.projectile && spec.projectile.frame === i && bx1 > bx0) { // ...and keep it as the projectile sprite
        const pw = bx1 - bx0 + 1, ph = by1 - by0 + 1, pc = mk(pw, ph), pg = pc.getContext('2d'), pd = pg.createImageData(pw, ph);
        for (let yy = 0; yy < ph; yy++) for (let xx = 0; xx < pw; xx++) {
          if (!m[(by0 + yy) * F.w + bx0 + xx]) continue;
          const si = ((by0 + yy) * F.w + bx0 + xx) * 4, di = (yy * pw + xx) * 4;
          pd.data[di] = F.data[si]; pd.data[di + 1] = F.data[si + 1]; pd.data[di + 2] = F.data[si + 2]; pd.data[di + 3] = F.data[si + 3];
        }
        pg.putImageData(pd, 0, 0);
        const ps = spec.projectile.w / pw, c = resizeHQ(pc, pw * ps, ph * ps);
        proj = { c, w: c.width, h: c.height, px: pw };
      }
    }
    const p = x; x += F.w + pad; return p;
  });
  const strip = resizeHQ(src, src.width * k, src.height * k), kb = k * MONTAGE_MULT, big = resizeHQ(src, src.width * kb, src.height * kb);
  const rect = (F, p, s) => ({ sX: Math.round(p * s), sY: Math.round((mh - F.h) * s), w: Math.round(F.w * s), h: Math.round(F.h * s) });
  const frames = fr.map((F, i) => ({
    ...rect(F, pos[i], k), ax: F.ax * k, hand: [F.hand[0] * k, F.hand[1] * k], foot: [F.foot[0] * k, F.foot[1] * k],
    srcX: F.x0, big: rect(F, pos[i], kb) // srcX = the frame's sX in the original batch file
  }));
  return { strip, big, frames, k, proj, lift: spec.lift || 0, legSmoke: !!spec.legSmoke };
}
const ANIM_FALLBACK = {
  walk: 'idle', crouch: 'idle', punch: 'idle', kick: 'idle', roundhouse: 'kick', jump: 'crouch', specials: 'idle',
  launch: 'specials', hitBody: 'idle', hitHead: 'hitBody', stun: 'hitBody', victory: 'idle'
};
async function loadCharacter(C) {
  const out = { from: {}, own: {} }; // own[name] = that animation's own file was found (not a fallback)
  await Promise.all(Object.entries(C.anims).map(async ([name, spec]) => {
    for (let fi = 0; fi < spec.file.length; fi++) {
      const file = spec.file[fi], img = await loadImgFile([`${file}?v=${ANIM_V}`, file]);
      if (!img) continue;
      const n = Array.isArray(spec.frames) ? spec.frames[fi] : spec.frames;
      // characters that wear no white (cleanWhite) get every enclosed white gap cleared in every frame
      const sp = C.cleanWhite && !spec.pockets ? { ...spec, pockets: C.cleanWhite } : spec;
      out[name] = buildAnim(keyedFile(img, file, spec.faces || 1, spec.erase), sp, n); out.own[name] = true;
      out.from[name] = `${file} (${n} frame${n > 1 ? 's' : ''}, sX ${out[name].frames.map(F => F.srcX).join('/')})`;
      return;
    }
    out.from[name] = `MISSING ${spec.file.join(' / ')}`;
  }));
  if (!out.idle) throw new Error(`${C.base}_idle.png could not be loaded`);
  for (const name of Object.keys(ANIM_FALLBACK)) if (!out[name]) { // missing animation: borrow the closest one
    let src = ANIM_FALLBACK[name]; while (src && !out[src]) src = ANIM_FALLBACK[src];
    out[name] = out[src || 'idle']; if (C.anims[name]) out.from[name] += ` → using ${src || 'idle'}`;
  }
  if (out.own.launch && out.launch.proj) out.heart = out.launch.proj; // ROMANA: the heart cut out of launch frame 3
  if (C.portrait) { // select-screen art (keyed like the sheets, cropped to the figure)
    const img = await loadImgFile([`${C.portrait}?v=${ANIM_V}`, C.portrait]);
    if (img) { const K = keyedFile(img, C.portrait, 1), F = cutFrame(K, (x, y) => K.d[(y * K.W + x) * 4 + 3] > 0, 0, 0, K.W - 1, K.H - 1); out.portrait = { c: K.cv, W: K.W, H: K.H, F }; }
  }
  out.standH = out.idle.frames[0].h;
  console.info(`${C.base} animations:\n` + Object.entries(out.from).map(([k, v]) => `  ${k}: ${v}`).join('\n'));
  return out;
}
const loadPoses = () => Promise.all(CHARACTERS.map(loadCharacter));

// victory animations play slowly, with the key frames held: seconds per frame (the last frame holds to the end).
// Moe: turn & draw · GUN SPIN · gun up · BOWTIE + WINK;  Romana: land · face camera · pucker · BLOW A KISS
const VICTORY_HOLD = { match: [.9, 1.1, 1.1], round: [.65, .75, .75] };
function holdFrame(t, holds) { let i = 0; while (i < holds.length && t >= holds[i]) t -= holds[i++]; return Math.max(0, i); }
// combat state from synced data only (host and online guest agree); each character maps it to [animation, frame]
function pickState(f) {
  const a = f.action;
  if (f.vpose === 'victory') return { s: 'victory', i: G.phase === 'roundEnd'
    ? holdFrame((G.timer - 70) / 60, VICTORY_HOLD.round)                             // round win: from "WINS ROUND!"
    : holdFrame((G.vt || 0) - f.char.victoryFrom, VICTORY_HOLD.match) };           // match win: timed to the song
  if (f.vpose === 'defeat') return { s: 'defeat' };
  if (f.vpose === 'dance') return { s: 'dance' };              // ROKAIA's music-synced match victory
  if (f.vpose) return { s: f.vpose === 'rise' ? 'jumpRise' : f.vpose === 'slam' ? 'slam' : 'crouch' };
  if (f.knock === 'air') return { s: 'hitAir' };
  if (f.knock !== 'none') return { s: 'down' };
  if (f.stun > 0) { // hit reaction: punches -> body blow, kicks -> head recoil
    // ONE reaction per strike: it is timed from the moment the strike landed (not re-derived from the stun counter
    // every frame), so it plays impact -> stagger -> recover exactly once and holds the recover frame until the stun
    // ends. A new strike restarts it only once the current one is past its peak (no flicker on quick follow-ups).
    // The start is detected locally (stun rising), so an online guest plays the same single reaction.
    const t = f.hitType || 'punch', len = (ATK[t] && ATK[t].stun) || 14;
    const rose = f.react && f.stun > f.react.last, past = f.react && G.frame - f.react.t0 >= f.react.len * .5;
    if (!f.react || (rose && past)) f.react = { t0: G.frame, len: Math.max(len, f.stun) };
    f.react.last = f.stun;
    return { s: 'stun', hit: usesFist(t) ? 'body' : 'head', i: clamp(Math.floor((G.frame - f.react.t0) / f.react.len * 4), 0, 3) };
  }
  f.react = null;
  if (a) {
    const d = ATK[a.type];
    if (a.type === 'punch' || a.type === 'kick') {
      if (a.t <= d.start) return { s: a.type, ph: 'wind', k: a.t / d.start };
      if (a.t <= d.start + d.active) return { s: a.type, ph: 'strike', k: 0 };
      return { s: a.type, ph: 'recover', k: (a.t - d.start - d.active) / d.rec };
    }
    if (a.type === 'airPunch' || a.type === 'airKick') return a.t <= d.start + d.active + d.rec * .5 ? { s: a.type } : { s: 'jumpFall' };
    if (a.type === 'overhead') return a.t <= d.start ? { s: 'crouch' } : { s: 'overhead' };
    if (a.type === 'special') { // 4 launch frames; the projectile is fired (ATK.special.fire) as frame 3 starts
      const F0 = ATK.special.fire;
      return { s: 'special', i: a.t < F0 - 10 ? 0 : a.t < F0 ? 1 : a.t < F0 + 12 ? 2 : 3 };
    }
  }
  if (!f.onGround) return { s: f.vy < -9 ? 'jumpRise' : f.vy < 6 ? 'jumpApex' : 'jumpFall' };
  if (f.blocking) return { s: 'block' }; // fighters without block art fall back to their idle pose
  if (f.crouching) return { s: 'crouch' };
  if (f.walking) return { s: 'walk' };
  return { s: 'idle' };
}
// current animation frame + a small whole-pixel idle breathing offset (MOE: slower and smaller)
function frameOf(f) {
  const st = pickState(f), [anim, i] = f.char.frame(st, f, f.spr), A = f.spr[anim] || f.spr.idle;
  const F = A.frames[Math.min(i, A.frames.length - 1)], I = f.char.idle;
  const bob = (anim === 'idle' && f.onGround && !f.action && f.knock === 'none'
    ? Math.round(Math.sin((G.frame + f.idx * 40) * I.speed * (f.win ? 3 : 1)) * I.amp * (f.win ? 2.5 : 1)) : 0) - Math.round(A.lift || 0)
    - (st.s === 'dance' && RK.step ? Math.round(RK.step.lift) : 0); // dance toe-bounce
  // with real hit-reaction art the fighter flies back upright (no rotation); a borrowed idle pose is tipped over instead.
  // Art that already lies on the ground (lieArt: LULU's KO frames) is never rotated.
  const noRot = (st.s === 'hitAir' && A !== f.spr.idle) || (!!f.char.lieArt && st.s === 'down');
  return { A, F, anim, pose: anim, state: st.s, bob, noRot, sx: 1, sy: 1 };
}
// slice the current frame out of its animation strip and draw it with the feet at (0,0); smoothing off = crisp edges
function drawAnimFrame(g, A, F, dx = 0, dy = 0, big = false) {
  const S = big ? F.big : F, img = big ? A.big : A.strip, ax = big ? F.ax * MONTAGE_MULT : F.ax;
  g.imageSmoothingEnabled = false;
  g.drawImage(img, S.sX, S.sY, S.w, S.h, Math.round(-ax) + dx, -S.h + dy, S.w, S.h);
}
// frame pixel (on-screen size) -> fighter-local point (x forward, y up from the feet = negative)
const spritePt = (fr, p) => [p[0] - fr.F.ax, p[1] - fr.F.h + fr.bob];
const P = o => Object.assign({ hx: 0, hy: -166, torso: .1, head: 0, fh: [44, -8], bh: [36, 6], ff: [50, 0], bf: [-54, 0] }, o);
function lerpPose(a, b, t) {
  const r = {};
  for (const k in b) { const v = b[k]; r[k] = Array.isArray(v) ? [lerp(a[k][0], v[0], t), lerp(a[k][1], v[1], t)] : lerp(a[k], v, t); }
  return r;
}
function ik(a, t, l1, l2, s) {
  let dx = t[0] - a[0], dy = t[1] - a[1], d = Math.hypot(dx, dy);
  const mx = l1 + l2 - .5;
  if (d > mx) { dx *= mx / d; dy *= mx / d; d = mx; }
  if (d < 1) d = 1;
  const ang = Math.atan2(dy, dx), al = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  return [[a[0] + Math.cos(ang + s * al) * l1, a[1] + Math.sin(ang + s * al) * l1], [a[0] + dx, a[1] + dy]];
}
function solveRig(p) {
  const ct = Math.cos(p.torso), st = Math.sin(p.torso);
  const at = (x, y) => [p.hx + x * ct - y * st, p.hy + x * st + y * ct];
  const R = { torso: p.torso };
  R.hip = [p.hx, p.hy];
  R.neck = at(0, -SK.spine);
  R.shF = at(14, -SK.spine + 16); R.shB = at(-18, -SK.spine + 18);
  [R.elF, R.hF] = ik(R.shF, [R.shF[0] + p.fh[0], R.shF[1] + p.fh[1]], SK.ua, SK.fa, 1);
  [R.elB, R.hB] = ik(R.shB, [R.shB[0] + p.bh[0], R.shB[1] + p.bh[1]], SK.ua, SK.fa, 1);
  R.hipF = [p.hx + 9, p.hy]; R.hipB = [p.hx - 9, p.hy];
  [R.knF, R.anF] = ik(R.hipF, [p.ff[0], p.ff[1] - 10], SK.th, SK.sh, -1);
  [R.knB, R.anB] = ik(R.hipB, [p.bf[0], p.bf[1] - 10], SK.th, SK.sh, -1);
  R.headAng = p.torso * .55 + p.head;
  R.chin = [R.neck[0] + Math.sin(R.headAng) * 13 + 5, R.neck[1] - Math.cos(R.headAng) * 13];
  return R;
}

/* ---------- pose selection ---------- */
function actionExt(a) {
  if (!a || a.type === 'special') return 0;
  const d = ATK[a.type];
  if (a.t <= d.start) return a.t / d.start * .3;
  if (a.t <= d.start + d.active) return 1;
  return Math.max(0, 1 - (a.t - d.start - d.active) / d.rec);
}
// victory ground-slam key poses
const VPOSE = {
  crouch: P({ hy: -138, torso: .32, head: .15, fh: [34, 58], bh: [14, 66], ff: [52, 0], bf: [-58, 0] }),
  rise:   P({ hy: -178, torso: -.12, head: .25, fh: [20, -132], bh: [-2, -124], ff: [34, -46], bf: [-30, -34] }),
  slam:   P({ hy: -172, torso: .4, head: -.1, fh: [112, 36], bh: [100, 58], ff: [44, -34], bf: [-40, -14] }),
  land:   P({ hy: -118, torso: .55, head: -.25, fh: [96, 120], bh: [72, 126], ff: [64, 0], bf: [-74, 0] })
};
function targetPose(f) {
  if (f.vpose && VPOSE[f.vpose]) return VPOSE[f.vpose];
  const t = G.frame + f.idx * 40, a = f.action;
  if (f.knock !== 'none') return P({ torso: -.25, head: -.3, fh: [-20, 80], bh: [-50, 60], ff: [56, -18], bf: [6, -30] });
  if (f.stun > 0) { const k = f.stun / 18; return P({ hx: -12 * k, hy: -166, torso: -.34 * k, head: -.35 * k, fh: [-4, 62], bh: [-30, 56], ff: [50, 0], bf: [-52, 0] }); }
  if (a) {
    if (a.type === 'punch') {
      const d = ATK.punch, e = actionExt(a);
      if (a.t <= d.start) return P({ torso: .04, hx: -4, fh: [22, 26], bh: [28, 36], ff: [44, 0], bf: [-50, 0] });
      return P({ hx: 12 * e, torso: .1 + .2 * e, head: -.1 * e, fh: [lerp(44, 140, e), lerp(22, -6, e)], bh: [lerp(30, 14, e), lerp(40, 52, e)], ff: [46 + 12 * e, 0], bf: [-50, 0] });
    }
    if (a.type === 'kick') {
      const d = ATK.kick, e = actionExt(a);
      if (!f.onGround) return lerpPose(P({ hy: -172, ff: [40, -80], bf: [-26, -50] }), P({ hy: -170, torso: -.3, fh: [36, -6], bh: [-24, 40], ff: [168, -86], bf: [-34, -40] }), e);
      const chamber = P({ hx: -4, torso: -.12, fh: [34, 16], bh: [16, 40], ff: [58, -116], bf: [-34, 0] });
      const ext = P({ hx: -14, torso: -.45, head: .25, fh: [30, 34], bh: [6, 54], ff: [176, -150], bf: [-40, 0] });
      if (a.t <= d.start) return lerpPose(P({ ff: [44, 0], bf: [-44, 0] }), chamber, a.t / d.start);
      return lerpPose(chamber, ext, e);
    }
    if (a.type === 'special') {
      if (f.special === 'flower') {
        if (a.t < ATK.special.fire) return P({ hx: -12, hy: -162, torso: -.22, head: .12, fh: [-74, -46], bh: [44, 14], ff: [54, 0], bf: [-60, 0] }); // wind-up: flower cocked back over the shoulder
        return P({ hx: 18, hy: -164, torso: .3, head: -.1, fh: [140, 16], bh: [-22, 46], ff: [62, 0], bf: [-64, 0] }); // hard throw down the special lane
      }
      if (a.t < 8) return P({ fh: [36, 34], bh: [20, 40] });
      return P({ hy: -172, torso: -.04, head: .04, fh: [136, 34], bh: [112, 44], ff: [44, 0], bf: [-50, 0] }); // gun aimed down the special lane
    }
  }
  if (f.win) { const b = Math.abs(Math.sin(t * .12)); return P({ hy: -174 - b * 6, torso: -.05, head: .2, fh: [10, -138], bh: [26, 40], ff: [30, 0], bf: [-30, 0] }); }
  if (f.blocking) return P({ hy: -160, torso: -.08, head: .18, fh: [34, -30], bh: [46, -14], ff: [50, 0], bf: [-58, 0] });
  if (f.crouching) { const b = Math.sin(t * .1); return P({ hy: -74 + b * 2, torso: .92, head: -.7, fh: [42, -6 + b * 2], bh: [30, 8], ff: [62, 0], bf: [-70, 0] }); }
  if (!f.onGround) {
    return f.vy < 3 ? P({ hy: -176, torso: .08, fh: [42, -6], bh: [20, 10], ff: [36, -72], bf: [-20, -50] })
                    : P({ hy: -172, torso: .04, fh: [46, 6], bh: [24, 24], ff: [40, -26], bf: [-36, -16] });
  }
  if (f.walking) {
    const ph = f.walkPh, s = Math.sin(ph), c = Math.cos(ph);
    return P({ hy: -168 - Math.abs(s) * 5, torso: .14, fh: [44 - 8 * s, -6], bh: [36 + 8 * s, 8], ff: [40 + 28 * s, -Math.max(0, c) * 18], bf: [-44 - 28 * s, -Math.max(0, -c) * 18] });
  }
  const b = Math.sin(t * .08);
  return P({ hy: -166 + b * 2.5, torso: .1 + b * .015, fh: [44, -8 + b * 3], bh: [36, 6 + b * 3] });
}

/* ---------- fighter render to its own offscreen canvas ---------- */
function bodyRotation(f) {
  if (f.knock === 'air') return -Math.min(1, f.airT / 20) * Math.PI / 2;
  if (f.knock === 'down') return -Math.PI / 2;
  if (f.knock === 'rise') return -Math.PI / 2 * (f.knockT / 22);
  return 0;
}
function renderFighter(f) {
  const g = f.g, R = f.R, rot = f.fr && f.fr.noRot ? 0 : bodyRotation(f), lift = -Math.abs(Math.sin(rot)) * 26;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, f.cv.width, f.cv.height);
  g.save(); g.translate(OX, OY + lift); g.scale(f.facing, 1); if (rot) g.rotate(rot);
  // current animation frame: feet anchor at the origin (art faces right; g.scale(facing) flips it)
  const fr = f.fr;
  if (fr) {
    // whole-pixel position, drawn 1:1 (frames were resized once at load) — the pixels are never resampled
    // (hit reaction is a straight recoil, not a rotation)
    const recoil = f.stun > 0 ? -Math.round(10 * f.stun / 18) : 0;
    g.imageSmoothingEnabled = false; // already resized with high quality at load: draw 1:1, pixel-crisp
    drawAnimFrame(g, fr.A, fr.F, recoil, fr.bob); // slice this state's frame out of its batch strip
  }
  // special props
  const a = f.action;
  // (MOE's special is drawn by his energy-charge frame + the energy-blast projectile art, so no gun prop)
  // specials are drawn by the launch frames themselves (energy / heart in the art); the old props only as a fallback
  if (a && a.type === 'special' && !f.spr.own.launch) {
    if (f.special === 'flower') drawFlowerHeld(g, R, a);
    else if (f.special === 'fire') drawFireCharge(g, R, a);           // JOE: fireball gathering in his fist
    else if (f.special === 'gun' && !f.spr.projectile) drawGun(g, R, a);
  }
  if (f.blocking) drawShield(g, R);
  g.restore();
  // scene lighting: warm lava bounce from below, smoky shadow from above
  g.globalCompositeOperation = 'source-atop';
  let gr = g.createLinearGradient(0, OY + 10, 0, OY - 300);
  gr.addColorStop(0, 'rgba(255,95,25,.34)'); gr.addColorStop(.45, 'rgba(255,95,25,.06)'); gr.addColorStop(.8, 'rgba(30,0,10,.05)'); gr.addColorStop(1, 'rgba(30,0,10,.22)');
  g.fillStyle = gr; g.fillRect(0, 0, f.cv.width, f.cv.height);
  // rim light from the volcano side
  const vx = CRATER_SCREEN_X + cam.x - f.x; // >0 volcano is to the right
  gr = g.createLinearGradient(OX - 120, 0, OX + 120, 0);
  const rim = 'rgba(255,140,60,.22)', none = 'rgba(255,140,60,0)';
  gr.addColorStop(0, vx < 0 ? rim : none); gr.addColorStop(.3, none); gr.addColorStop(.7, none); gr.addColorStop(1, vx >= 0 ? rim : none);
  g.fillStyle = gr; g.fillRect(0, 0, f.cv.width, f.cv.height);
  // (no hit-flash overlay: a fighter who gets hit is drawn normally — the reaction animation shows the hit)
  g.globalCompositeOperation = 'source-over';
}
function drawShield(g, R) {
  const pulse = .75 + .25 * Math.sin(G.frame * .3), cx = R.hF[0] + 26, cy = R.hF[1] + 30;
  g.save(); g.globalCompositeOperation = 'lighter';
  g.strokeStyle = `rgba(120,210,255,${.8 * pulse})`; g.lineWidth = 5; g.shadowColor = '#4ab8ff'; g.shadowBlur = 18;
  g.beginPath(); g.arc(cx - 60, cy, 130, -.95, .95); g.stroke();
  g.fillStyle = `rgba(80,170,255,${.10 * pulse})`; g.beginPath(); g.arc(cx - 60, cy, 130, -.95, .95); g.closePath(); g.fill();
  g.restore();
}
function drawFireCharge(g, R, a) {
  const k = a.t < 20 ? a.t / 20 : Math.max(0, 1 - (a.t - 20) / 8);
  if (k <= 0) return;
  const x = R.hF[0], y = R.hF[1], r = 54 * k; // in the fighter's measured fist
  g.save(); g.globalCompositeOperation = 'lighter';
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, 'rgba(255,240,180,.95)'); gr.addColorStop(.4, 'rgba(255,90,10,.7)'); gr.addColorStop(1, 'rgba(200,0,0,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.restore();
}
// red flower on a green stem; stem base at (0,0), bloom at the +x end
function drawFlower(g, k = 1) {
  g.lineCap = 'round';
  g.strokeStyle = shade('#2f7a2a', k); g.lineWidth = 5; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(30, 4, 62, 0); g.stroke();
  g.strokeStyle = 'rgba(160,230,120,.6)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(4, -1.5); g.quadraticCurveTo(30, 2, 60, -1.5); g.stroke();
  // leaves
  g.fillStyle = shade('#3c9a32', k); g.strokeStyle = 'rgba(10,40,10,.7)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(26, 2); g.quadraticCurveTo(34, 22, 48, 16); g.quadraticCurveTo(40, 6, 26, 2); g.fill(); g.stroke();
  g.beginPath(); g.moveTo(40, 0); g.quadraticCurveTo(46, -18, 58, -14); g.quadraticCurveTo(50, -4, 40, 0); g.fill(); g.stroke();
  // green sepals / pedicel cup under the bloom
  g.fillStyle = shade('#2a6a22', k);
  g.beginPath(); g.moveTo(58, 0); g.lineTo(70, -9); g.lineTo(66, 0); g.lineTo(70, 9); g.closePath(); g.fill();
  // bloom: layered red petals
  const cx = 80, cy = 0;
  for (let i = 0; i < 7; i++) {
    const an = i / 7 * Math.PI * 2;
    const gr = g.createRadialGradient(cx, cy, 2, cx + Math.cos(an) * 10, cy + Math.sin(an) * 10, 20);
    gr.addColorStop(0, shade('#ff5a6a', k)); gr.addColorStop(.6, shade('#d8122a', k)); gr.addColorStop(1, shade('#7a0012', k));
    g.fillStyle = gr; g.beginPath(); g.ellipse(cx + Math.cos(an) * 10, cy + Math.sin(an) * 10, 15, 10, an, 0, 7); g.fill();
    g.strokeStyle = 'rgba(70,0,10,.6)'; g.lineWidth = 1; g.stroke();
  }
  g.fillStyle = shade('#b0001c', k); g.beginPath(); g.arc(cx, cy, 9, 0, 7); g.fill();
  g.strokeStyle = 'rgba(255,170,180,.7)'; g.lineWidth = 1.6; g.beginPath(); g.arc(cx, cy, 5.5, .4, 4.6); g.stroke();
}
// Romana's special: pulls out the flower (held at the bottom of its stem) and winds up to throw it
function drawFlowerHeld(g, R, a) {
  if (a.t >= ATK.special.fire) return; // it has left her hand
  const ang = Math.atan2(R.hF[1] - R.elF[1], R.hF[0] - R.elF[0]), s = Math.min(1, a.t / 6);
  g.save(); g.translate(R.hF[0], R.hF[1]); g.rotate(ang); g.scale(1.25 * s, 1.25 * s);
  drawFlower(g); // stem base sits in the sprite's fist
  g.restore();
}
function drawGun(g, R, a) {
  if (a.t < 6 || a.t > 42) return;
  const ang = Math.atan2(R.hF[1] - R.elF[1], R.hF[0] - R.elF[0]);
  g.save(); g.translate(R.hF[0], R.hF[1]); g.rotate(ang);
  if (a.t > ATK.special.fire && a.t < ATK.special.fire + 8) g.rotate(-.35 * (1 - (a.t - ATK.special.fire) / 8)); // recoil
  g.scale(1.6, 1.6); // BIG gun
  g.fillStyle = '#2a2a2e'; g.fillRect(4, -16, 56, 14);
  g.fillStyle = '#5a5a64'; g.fillRect(4, -16, 56, 4);
  g.fillStyle = '#18181b'; g.fillRect(56, -14, 8, 9);
  g.fillStyle = '#44444c'; g.fillRect(14, -20, 30, 4); // top rail
  g.strokeStyle = '#18181b'; g.lineWidth = 2; g.beginPath(); g.arc(20, -1, 6, 0, Math.PI); g.stroke(); // trigger guard
  g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 1.2; g.strokeRect(4, -16, 56, 14); // grip is hidden inside the sprite's fist
  if (a.t >= 10 && a.t < ATK.special.fire) { g.strokeStyle = 'rgba(255,30,30,.6)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(64, -10); g.lineTo(560, -10); g.stroke(); }
  if (a.t >= ATK.special.fire && a.t < ATK.special.fire + 5) {
    g.globalCompositeOperation = 'lighter'; g.fillStyle = '#fff6b0'; g.beginPath();
    for (let i = 0; i < 10; i++) { const an = i / 10 * Math.PI * 2, rr = i % 2 ? 12 : 34; g.lineTo(72 + Math.cos(an) * rr * 1.4, -9 + Math.sin(an) * rr * .7); }
    g.closePath(); g.fill();
  }
  g.restore();
}
// local rig point -> world
const toWorld = (f, p) => [f.x + f.facing * p[0], f.y + p[1]];

/* =====================================================================
   GAME STATE
   ===================================================================== */
const G = {
  vt: 0, vClock: null, vStart: 0, vSlam: false, vSpecial: false, // victory sequence
  phase: 'menu', frame: 0, timer: 0, round: 1, hitStop: 0,
  shake: 0, shakeMag: 0, fightBanner: 0, flash: 0, winnerIdx: -1
};
const cam = { x: (STAGE_W - W) / 2 };
let fighters = [], projectiles = [], particles = [], popups = [], embers = [], smoke = [], bombs = [], ash = [], bokeh = [];

class Fighter {
  constructor(o) {
    Object.assign(this, o); this.wins = 0; this.specialUsed = false;
    this.cv = mk(1000, 640); this.g = this.cv.getContext('2d');
    this.g.imageSmoothingEnabled = false; // crisp, nearest-neighbour sprite pixels
  }
  reset(x) {
    Object.assign(this, {
      x, y: GROUND, vx: 0, vy: 0, onGround: true, hp: MAX_HP, hpShown: MAX_HP, action: null, stun: 0,
      knock: 'none', knockT: 0, airT: 0, ko: false, blocking: false, walking: false, flash: 0, win: false,
      walkPh: 0, cloakSway: 0, trail: [], vpose: null, crouching: false, hitType: null
    });
    this.facing = x < STAGE_W / 2 ? 1 : -1;
    this.pose = P({}); this.R = solveRig(this.pose);
  }
  get invuln() { return this.knock !== 'none' || this.ko; }
  // standing: feet to top of the photo head.
  // crouching: top drops below the standing-punch band (0.62 FH) -> standing punches whiff; kicks (low) still connect.
  // airborne: bottom lifts above the ground-kick band (0.58 FH) -> standing/ground kicks whiff; punches can still connect.
  hurtbox() {
    let y1 = this.y - (this.spr ? this.spr.standH : FH * 1.12), y2 = this.y; // top of the head in the art
    if (this.crouching && this.onGround && !this.action) y1 = this.y - FH * .58;
    else if (!this.onGround && this.knock === 'none') y2 = this.y - FH * .62;
    return { x1: this.x - 55, x2: this.x + 55, y1, y2 };
  }
}

function startMatch() {
  stopVictoryMusic();
  $('over').classList.add('hidden'); $('start').classList.add('hidden');
  fighters.forEach(f => { f.wins = 0; f.specialUsed = false; });
  G.round = 1; startRound();
}
function startRound() {
  fighters[0].reset(STAGE_W / 2 - 280);
  fighters[1].reset(STAGE_W / 2 + 280);
  fighters.forEach(f => { f.specialUsed = false; }); // special is once per ROUND: READY again each round
  projectiles = []; popups = [];
  cam.x = (STAGE_W - W) / 2;
  G.fightBanner = 0; G.winnerIdx = -1; G.hitStop = 0; G.timer = 0; G.introDone = 0;
  clearBuffers();
  if (G.round === 1 && SKY_DROP_INTRO) { // optional SKY-DROP intro — both fall from high above the screen onto their marks
    G.phase = 'intro';
    fighters.forEach(f => { f.y = GROUND - INTRO_DROP; f.vy = 0; f.onGround = false; f.vpose = null; f.landT = 0; });
  } else { G.phase = 'countdown'; sfx.beep(); }
}
/* ---------- pre-fight sky-drop: fall, slam onto the ground, a short landing frame, idle, then 3-2-1-FIGHT ---------- */
const INTRO_DROP = 1000, INTRO_LAND = 16, INTRO_HOLD = 24; // drop height (px), landing-frame time, pause before countdown
// after character select the 3-2-1 countdown starts straight away; set true to bring back the sky-drop entrance
const SKY_DROP_INTRO = false;
function updateIntro() {
  G.timer++;
  for (const f of fighters) {
    const o = fighters[1 - f.idx]; f.facing = o.x >= f.x ? 1 : -1;
    if (!f.onGround) {
      f.vy = Math.min(f.vy + GRAV * 1.15, 36); f.y += f.vy;
      if (f.y >= GROUND) { // impact
        f.y = GROUND; f.vy = 0; f.onGround = true; f.vpose = 'land'; f.landT = INTRO_LAND;
        dust(f.x, 34); burst(f.x, GROUND - 10, 24, ['#fff3c0', '#ffb030', '#ff4a10'], 9); shake(12, 14); sfx.land();
      }
    } else if (f.vpose === 'land' && --f.landT <= 0) f.vpose = null; // snap to idle
    animateFighter(f);
  }
  if (fighters.every(f => f.onGround && !f.vpose)) {
    if (!G.introDone) G.introDone = G.timer;
    if (G.timer - G.introDone >= INTRO_HOLD) { G.introDone = 0; G.phase = 'countdown'; G.timer = 0; sfx.beep(); } // controls unlock after FIGHT!
  }
}
function endRound(winner) {
  if (G.phase !== 'fight') return;
  G.phase = 'roundEnd'; G.timer = 0; G.winnerIdx = fighters.indexOf(winner);
  winner.wins++; projectiles = [];
  G.hitStop = 18; sfx.ko(); // (no screen flash on the KO hit)
}
function gameOver() {
  G.phase = 'gameover'; // winner holds the last victory frame, loser keeps the defeat loop behind the game-over screen
  showGameOver();
  if (!victoryMusicPlaying() && !winnerDances()) sfx.win(); // victory.mp3 (or Rokaia's song) keeps playing under the game-over screen
}

/* ---------- final-match victory sequence (timed to victory.mp3) ----------
   seconds:  0 zoom on winner + letterbox | .45 "WINNER!" over the winner | .9 winner's SPECIAL MOVE
             2.0 crouch | 2.3 HIGH LEAP | 2.75 slam down | 2.95 GROUND BREAK | 3.8 victory animation (close-up)
             | 9.0 game-over screen (long enough for the held frames of the victory animation, see VICTORY_HOLD) */
const VICTORY_LEN = 9.0, SPECIAL_T = .9, CROUCH_T = 2.0, LEAP_T = 2.3, APEX_T = 2.75, SLAM_T = 2.95, LEAP_H = 240;
function startVictory() {
  const w0 = fighters[G.winnerIdx], l0 = fighters[1 - G.winnerIdx];
  Object.assign(G, { phase: 'victory', timer: 0, vt: 0, vClock: null, vStart: 0, vSlam: false, vSpecial: false,
    vSide: Math.sign(l0.x - w0.x) || (w0.x < cam.x + W / 2 ? 1 : -1) }); // the loser stays on this side of the winner
  projectiles = [];
  releaseAllLocal(); clearBuffers(); held[1] = {};   // freeze both players' input — the loser can't move anymore
  playVictoryMusic();                                // stops any match music, starts victory.mp3
}
// clock = the song's playback position, so every beat of the sequence lines up with the music.
// If the music can't play (blocked / missing), fall back to a frame timer after half a second.
function victoryClock() {
  const a = MUSIC.victory, playing = victoryMusicPlaying();
  if (G.vClock === 'audio') return playing ? a.currentTime : G.vt + 1 / 60;
  if (G.vClock === null) {
    if (playing) { G.vClock = 'audio'; return a.currentTime; }
    if (G.timer < 30) return 0;
    G.vClock = 'timer'; G.vStart = G.timer;
  }
  return (G.timer - G.vStart) / 60;
}
function updateVictory() {
  G.timer++;
  const vt = G.vt = victoryClock(), w = fighters[G.winnerIdx], l = fighters[1 - G.winnerIdx];
  w.facing = l.x >= w.x ? 1 : -1; w.stun = 0; w.blocking = false; w.walking = false; w.vx = 0; w.knock = 'none';
  if (w.char.dance) { // ROKAIA: her 27s routine from the first second (the frames come from rkUpdate, run every render)
    w.action = null; w.vpose = 'dance'; w.y = GROUND; w.onGround = true; w.vy = 0; w.win = true;
    if (l.knock === 'air') { l.airT++; l.vy += GRAV; l.y += l.vy; l.x += l.vx; if (l.y >= GROUND) { l.y = GROUND; l.vy = 0; l.onGround = true; l.knock = 'down'; } }
    if (l.knock === 'down' && vt >= 1.6) { l.knock = 'none'; l.vpose = 'defeat'; l.stun = 0; l.y = GROUND; l.onGround = true; l.vx = 0; l.facing = w.x >= l.x ? 1 : -1; }
    for (const f of fighters) if (f.flash > 0) f.flash--;
    centreWinner(w); pullLoserIn(w, l); animateFighter(w); animateFighter(l);
    if (vt >= VICTORY_LEN) gameOver();
    return;
  }
  // 1) winner's special move (cosmetic — the opponent is already down)
  if (vt >= SPECIAL_T && !G.vSpecial) {
    G.vSpecial = true; w.action = { type: 'special', t: 0, hit: true };
    popup(w.char.specialName, w.x, w.y - FH - 80, w.color, 48);
    if (w.special === 'gun') sfx.cock();
  }
  if (w.action) { w.action.t++; if (w.action.t === ATK.special.fire) fireSpecial(w); if (w.action.t >= ATK.special.total) w.action = null; }
  for (const p of projectiles) { p.t++; if (p.type === 'shuriken') p.dead = stepShuriken(p); else p.x += p.vx; if (p.type === 'whip' && p.t > WHIP_LASH.life) p.dead = true; fireTrail(p); }
  projectiles = projectiles.filter(p => !p.dead && p.x > -100 && p.x < STAGE_W + 100);
  // 2) high leap and ground slam: crouch -> leap -> slam down -> ground break
  let h = 0, vp = null;
  if (!w.action) {
    if (vt >= CROUCH_T && vt < LEAP_T) vp = 'crouch';
    else if (vt >= LEAP_T && vt < APEX_T) { vp = 'rise'; const p = (vt - LEAP_T) / (APEX_T - LEAP_T); h = LEAP_H * (1 - (1 - p) * (1 - p)); }
    else if (vt >= APEX_T && vt < SLAM_T) { vp = 'slam'; const p = (vt - APEX_T) / (SLAM_T - APEX_T); h = LEAP_H * (1 - p * p); }
    else if (vt >= SLAM_T && vt < SLAM_T + .75) vp = 'land';
  }
  // winner's own victory animation, synced to the song (MOE: gun celebration from 3.8s; ROMANA: the kiss starts
  // with her slam landing). The frame comes from G.vt, which the host streams, so an online guest sees the same.
  if (!w.action && vt >= w.char.victoryFrom && (vp === null || vp === 'land')) vp = 'victory';
  w.vpose = vp; w.y = GROUND - h; w.onGround = h <= 0; w.vy = vp === 'rise' ? -8 : vp === 'slam' ? 18 : 0;
  if (vt >= SLAM_T && !G.vSlam) {
    G.vSlam = true;
    const ix = w.x + w.facing * 60;
    burst(ix, GROUND - 20, 90, ['#fff3c0', '#ffb030', '#ff4a10', '#ffffff'], 17);
    starburst(ix, GROUND - 50, 240, '#ffd23a');
    debris(ix, 34); dust(w.x + w.facing * 40, 44); shake(24, 34); sfx.boom(); G.flash = 10;
    popup('BOOM!', ix, GROUND - 140, '#ffd23a', 60);
  }
  w.win = vt >= 3.8;
  // loser finishes falling, then gets up into their defeat loop (ROMANA: wobbly dizzy stun; MOE: dazed, hand on head)
  if (l.knock === 'air') { l.airT++; l.vy += GRAV; l.y += l.vy; l.x += l.vx; if (l.y >= GROUND) { l.y = GROUND; l.vy = 0; l.onGround = true; l.knock = 'down'; } }
  if (l.knock === 'down' && vt >= 1.6) { l.knock = 'none'; l.vpose = 'defeat'; l.stun = 0; l.y = GROUND; l.onGround = true; l.vx = 0; l.facing = w.x >= l.x ? 1 : -1; }
  for (const f of fighters) if (f.flash > 0) f.flash--;
  centreWinner(w);                                 // the shot is centred on the winner...
  pullLoserIn(w, l);                               // ...with the defeated opponent right beside them
  animateFighter(w); animateFighter(l);
  if (vt >= VICTORY_LEN) gameOver();
}
function showGameOver() {
  const w = fighters[G.winnerIdx], l = fighters[1 - G.winnerIdx];
  $('goWinner').textContent = `${w.name} WINS THE MATCH!`;
  $('goScore').textContent = `ROUNDS ${w.wins} – ${l.wins}`;
  $('btnRestart').textContent = NET.role === 'guest' ? 'Request Rematch' : 'Restart Match';
  $('over').classList.remove('hidden');
  startMontage();
}

/* ---------- game-over screen: the winner, enlarged and airborne, chains every attack & jump pose ----------
   The pose shown comes from the victory song's playback position (so host and guest stay in step and the moves
   ride the music); bass hits from the song (WebAudio analyser) add a pulse, a white flash and a starburst. */
const MONTAGE_ANIMS = ['jump', 'punch', 'kick', 'roundhouse', 'launch', 'victory']; // each animation's frames in turn
const MONTAGE_FPS = 9;
// the winner's montage: every frame of each attack / jump / special / victory animation they have art for
function montageSeq(spr) {
  const seq = [], seen = new Set();
  for (const name of MONTAGE_ANIMS) {
    const A = spr[name]; if (!A || !spr.own[name] || seen.has(A)) continue; seen.add(A); // only animations with their own art
    const n = A.frames.length;
    // attacks flash by; the victory animation is held so it can be watched (MONTAGE_VICTORY_HOLD seconds a frame)
    for (let i = 0; i < n; i++) seq.push([name, i, name === 'victory' ? (i === n - 1 ? MONTAGE_VICTORY_HOLD * 1.8 : MONTAGE_VICTORY_HOLD) : 1 / MONTAGE_FPS]);
  }
  if (!seq.length) seq.push(['idle', 0, 1]);
  seq.total = seq.reduce((s, e) => s + e[2], 0);
  return seq;
}
const MONTAGE_VICTORY_HOLD = .38;
const GO = { t0: 0, lastK: -1, lastClock: 0, ghosts: [], fx: [], an: null, data: null, avg: 0, pulse: 0, lastBeat: -1, cv: null };
function startMontage() {
  Object.assign(GO, { t0: performance.now(), lastK: -1, lastClock: 0, ghosts: [], fx: [], pulse: 0, lastBeat: -1, seq: null });
  if (MUSIC.victory) MUSIC.victory.loop = true; // keep the song (and the montage) going on the game-over screen
  if (!GO.cv) GO.cv = mk(W, H);
  // tap the song for beat detection (only possible once the audio engine is running; otherwise a steady fallback beat)
  if (!GO.an && AC && AC.state === 'running' && MUSIC.victory) {
    try {
      const src = AC.createMediaElementSource(MUSIC.victory), an = AC.createAnalyser();
      an.fftSize = 256; an.smoothingTimeConstant = .35; src.connect(an); an.connect(AC.destination);
      GO.an = an; GO.data = new Uint8Array(an.frequencyBinCount);
    } catch (e) { console.warn('Beat analyser unavailable:', e); }
  }
}
function drawMontage() {
  const w = fighters[G.winnerIdx]; if (!w || !w.spr) return;
  const g = $('goStage').getContext('2d'), playing = victoryMusicPlaying();
  const clock = playing ? MUSIC.victory.currentTime : (performance.now() - GO.t0) / 1000;
  // beat: bass energy jump in the song, or a steady 120 bpm when the analyser isn't available
  let beat = false;
  if (GO.an && playing) {
    GO.an.getByteFrequencyData(GO.data);
    let e = 0; for (let i = 1; i < 10; i++) e += GO.data[i]; e /= 9 * 255;
    // onset = a sudden rise in bass energy above its running average (works for loud, bass-heavy mixes too)
    if (e - (GO.prevE || 0) > .045 && e >= GO.avg - .02 && clock - GO.lastBeat > .24) { beat = true; GO.lastBeat = clock; }
    GO.prevE = e; GO.avg = lerp(GO.avg, e, .05);
  } else if (Math.floor(clock * 2) !== Math.floor(GO.lastClock * 2)) beat = true;
  if (clock < GO.lastClock) GO.lastK = -1; // song looped
  GO.lastClock = clock;
  const dance = winnerDances() && RK.step;                               // ROKAIA: her 27s routine, not the montage
  if (dance) beat = RK.beat;
  GO.pulse = beat ? 1 : GO.pulse * .9;
  let pose, fi, k, flip, lift, x, y;
  if (dance) {
    [pose, fi] = [RK.step.anim, RK.step.f]; k = pose + fi; flip = 1;
    x = W / 2; y = Math.round(650 - RK.step.lift * MONTAGE_MULT);
  } else {
    const seq = GO.seq || (GO.seq = montageSeq(w.spr));
    const loop = Math.floor(clock / seq.total);
    let t = clock - loop * seq.total; k = 0;
    while (k < seq.length - 1 && t >= seq[k][2]) t -= seq[k++][2];
    [pose, fi] = seq[k];
    flip = loop % 2 ? -1 : 1;                                            // turn around every full loop
    lift = pose === 'jump' ? 70 : pose === 'crouch' ? 40 : 0;            // jumps float higher
    x = Math.round(W / 2 + Math.sin(clock * 1.1) * 46); y = Math.round(640 - lift + Math.sin(clock * 2.3) * 20);
  }
  const A = w.spr[pose], F = A.frames[Math.min(fi, A.frames.length - 1)];
  const s = MONTAGE_MULT;                                                // gameplay px -> game-over px (pre-rendered)
  const tilt = 0;                                                        // no rotation: keeps the art crisp
  // new frame: leave an afterimage; strike frames throw a starburst from the fist / foot
  if (k !== GO.lastK) {
    if (GO.lastK >= 0 && GO.prev) GO.ghosts.push({ ...GO.prev, a: .42 });
    if ((pose === 'punch' || pose === 'kick' || pose === 'roundhouse') && fi === Math.min(2, A.frames.length - 1)) {
      const p = pose === 'punch' ? F.hand : F.foot;
      GO.fx.push({ x: x + flip * (p[0] - F.ax) * s, y: y + (p[1] - F.h) * s, t: 0, size: 150 });
    }
    GO.lastK = k;
  }
  GO.prev = { A, F, x, y, flip, tilt };
  if (beat) GO.fx.push({ x: x + rand(-180, 180), y: y - F.h * s * rand(.3, .9), t: 0, size: rand(60, 110) });
  g.clearRect(0, 0, W, H);
  // backdrop: rotating speed rays + a pulsing aura in the winner's colour
  g.save(); g.globalCompositeOperation = 'lighter';
  const cy = y - F.h * s * .5;
  for (let r = 0; r < 18; r++) {
    const a = r / 18 * Math.PI * 2 + clock * .5, wd = .05;
    g.fillStyle = `rgba(255,190,90,${.06 + .06 * GO.pulse})`; g.beginPath(); g.moveTo(x, cy);
    g.lineTo(x + Math.cos(a - wd) * 1100, cy + Math.sin(a - wd) * 1100); g.lineTo(x + Math.cos(a + wd) * 1100, cy + Math.sin(a + wd) * 1100); g.fill();
  }
  const aura = g.createRadialGradient(x, cy, 20, x, cy, 360 + 60 * GO.pulse);
  aura.addColorStop(0, w.color + 'aa'); aura.addColorStop(.5, w.color + '33'); aura.addColorStop(1, w.color + '00');
  g.fillStyle = aura; g.fillRect(0, 0, W, H);
  g.restore();
  // afterimages
  const drawF = (gg, o) => { gg.save(); gg.translate(o.x, o.y); gg.scale(o.flip, 1); drawAnimFrame(gg, o.A, o.F, 0, 0, true); gg.restore(); };
  for (const gh of GO.ghosts) { g.globalAlpha = gh.a; drawF(g, gh); gh.a *= .82; }
  g.globalAlpha = 1; GO.ghosts = GO.ghosts.filter(gh => gh.a > .04);
  // the winner, with a white flash on each beat
  const c = GO.cv.getContext('2d'); c.clearRect(0, 0, W, H); drawF(c, GO.prev);
  if (GO.pulse > .05) { c.globalCompositeOperation = 'source-atop'; c.fillStyle = `rgba(255,255,255,${.45 * GO.pulse})`; c.fillRect(0, 0, W, H); c.globalCompositeOperation = 'source-over'; }
  g.drawImage(GO.cv, 0, 0);
  // starbursts
  g.save(); g.globalCompositeOperation = 'lighter';
  for (const p of GO.fx) {
    const t = p.t / 14, R = p.size * (.4 + .8 * Math.min(1, t * 2)), r = R * .36;
    g.globalAlpha = Math.max(0, 1 - t); g.save(); g.translate(p.x, p.y); g.rotate(t * .6);
    g.fillStyle = '#ffd23a'; g.beginPath();
    for (let j = 0; j < 24; j++) { const a = j / 24 * Math.PI * 2, rr = j % 2 ? r : R * (j % 4 ? .8 : 1); g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
    g.closePath(); g.fill(); g.fillStyle = '#fff'; g.beginPath(); g.arc(0, 0, r * (1 - t * .6), 0, 7); g.fill(); g.restore();
    p.t++;
  }
  g.restore(); GO.fx = GO.fx.filter(p => p.t < 14);
}

/* =====================================================================
   COMBAT
   ===================================================================== */
function startAction(f, type) {
  f.action = { type, t: 0, hit: false };
  if (type === 'special') {
    f.specialUsed = true;
    popup(f.char.specialName, f.x, f.y - FH - 80, f.color, 44);
    if (f.special === 'gun') sfx.cock();
  } else sfx.whoosh();
}

function tryHit(a, d, act, data) {
  const e1 = a.x + a.facing * data.reach[0], e2 = a.x + a.facing * data.reach[1];
  const hx1 = Math.min(e1, e2), hx2 = Math.max(e1, e2);
  const hy1 = a.y - FH * data.y[0], hy2 = a.y - FH * data.y[1];
  const b = d.hurtbox();
  if (hx1 < b.x2 && hx2 > b.x1 && hy1 < b.y2 && hy2 > b.y1) {
    act.hit = true;
    if (d.invuln) return;
    const tip = toWorld(a, usesFist(act.type) ? a.R.hF : a.R.anF);
    const px = clamp(tip[0], b.x1, b.x2), py = clamp(tip[1], b.y1 + 10, b.y2 - 10);
    landHit(a, d, act.type, data, px, py);
  }
}

function landHit(a, d, type, data, px, py) {
  if (G.phase !== 'fight') return;
  if (d.blocking) { // block: standard hits deal 0 damage
    d.x += a.facing * 12; clampX(d);
    burst(px, py, 14, ['#9fe8ff', '#ffffff', '#4ab8ff'], 7);
    popup('BLOCK', px, py - 30, '#8fdcff', 26);
    sfx.block(); G.hitStop = 3;
    return;
  }
  const dmg = data.dmg || 1, heavy = dmg >= 2;
  d.hp = Math.max(0, d.hp - dmg);
  d.stun = data.stun; d.vx = a.facing * data.push; d.flash = 12; d.action = null;
  d.hitType = type; // which reaction to play: punches -> body blow, kicks -> head recoil
  // impact: starburst + sparks + white flash + screen shake, all scaled by the hit's damage
  starburst(px, py, 46 + 22 * dmg, heavy ? '#ffd23a' : '#fff3c0');
  burst(px, py, 16 + 10 * dmg, ['#ffffff', '#ffe08a', '#ff7a1a', '#ff2a10'], 8 + 2 * dmg);
  popup(`-${dmg}`, px, py - 20, '#ffdc5a', 26 + 6 * dmg);
  if (type === 'overhead') popup('OVERHEAD!', d.x, d.y - FH - 60, a.color, 40);
  heavy ? sfx.heavy() : sfx.hit();
  G.hitStop = 3 + dmg; shake(4 + 3 * dmg, 6 + 3 * dmg); // (no screen flash on hits)
  if (d.hp <= 0) knockdown(a, d, true);
  else if (type === 'overhead') knockdown(a, d, false); // the overhead smash floors the opponent
}

function specialHit(p, d) {
  if (G.phase !== 'fight') return;
  const a = p.owner;
  d.hp = Math.max(0, d.hp - 10);
  d.flash = 16; d.action = null; d.stun = 0;
  starburst(p.x, p.y, 120, p.type === 'flower' ? '#ff6a8a' : p.type === 'fire' ? '#ffb030' : p.type === 'shuriken' ? '#7cc4ff' : p.type === 'whip' ? '#ff4a5a' : '#fff6b0');
  burst(p.x, p.y, 60, p.type === 'flower' ? ['#ff2a40', '#ff8a9a', '#ffffff', '#3aa040'] : p.type === 'fire' ? ['#fff3c0', '#ffb030', '#ff4a10', '#a00000']
    : p.type === 'shuriken' ? ['#ffffff', '#9fd4ff', '#3a8cff', '#0a2a9a'] : p.type === 'whip' ? ['#ffffff', '#ff4a5a', '#3a2018', '#ffd25a']
    : ['#ffffff', '#fff2a0', '#ff3020', '#8a0000'], 14);
  popup(a.char.hitWord, d.x, d.y - FH - 70, a.char.hitColor, 50);
  popup('-10', d.x, d.y - FH * .7, '#ffdc5a', 40);
  sfx.boom(); G.hitStop = 10; shake(16, 22); // (no screen flash on special hits)
  knockdown(a, d, d.hp <= 0);
}

function knockdown(a, d, isKO) {
  // the knockdown replaces any hit-stun from the same strike: the stun can't count down on the floor, so leaving
  // it set played a second hurt animation after getting up
  d.knock = 'air'; d.airT = 0; d.onGround = false; d.vy = -11; d.vx = a.facing * 8; d.blocking = false; d.action = null; d.stun = 0; d.react = null;
  if (isKO) { d.ko = true; endRound(a); }
}

// Both specials fly in the SAME lane with the SAME hit radius, so they are dodged identically:
//  - crouching hurtbox top = 0.58 FH (209px)  < lane - radius (286px)  -> duck under it
//    (crouch poses are drawn 230px tall, so the shot visibly clears their heads)
//  - airborne hurtbox bottom = jump height + 0.62 FH (223px) > lane + radius (314px) once ~91px up -> jump over it
//  - standing poses are 403px tall, and the lane sits near fist height for the gun / flower
// (the visuals stay big; only the collision uses SPECIAL_HIT_R)
const SPECIAL_LANE = 300, SPECIAL_HIT_R = 14;
function fireSpecial(f) {
  const R = f.R, y = f.y - SPECIAL_LANE;
  if (f.special === 'flower') {
    const [x] = toWorld(f, [R.hF[0] + 30, 0]);
    projectiles.push({ type: 'flower', owner: f, x, y, vx: f.facing * 15, r: SPECIAL_HIT_R, t: 0 });
    sfx.toss();
  } else if (f.special === 'fire') { // JOE: fireball thrown from the punching fist
    const [x] = toWorld(f, [R.hF[0] + 30, 0]);
    projectiles.push({ type: 'fire', owner: f, x, y, vx: f.facing * 12.5, r: SPECIAL_HIT_R, t: 0 });
    sfx.fire();
  } else if (f.special === 'whip') { // ROKAIA: ponytail lash cracking forward from her head along the special lane
    const [x] = toWorld(f, [40, 0]);
    projectiles.push({ type: 'whip', owner: f, x, y, vx: f.facing * WHIP_LASH.speed, r: SPECIAL_HIT_R, t: 0, x0: x });
    sfx.toss(); sfx.whoosh();
  } else if (f.special === 'shuriken') { // LULU: boomerang shuriken wave thrown from her launching hand (path: stepShuriken)
    const [x] = toWorld(f, [R.hF[0] + 20, 0]), dir = f.facing;
    const D = clamp(dir > 0 ? X_MAX + 140 - x : x - (X_MIN - 140), 260, SHURIKEN.reach); // turns back before leaving the stage
    projectiles.push({ type: 'shuriken', owner: f, x, y, vx: dir * D * Math.PI / SHURIKEN.T, r: SPECIAL_HIT_R, t: 0, x0: x, y0: y, dir, D });
    sfx.toss(); sfx.whoosh();
  } else {
    const ang = Math.atan2(R.hF[1] - R.elF[1], R.hF[0] - R.elF[0]);
    const [x] = toWorld(f, [R.hF[0] + Math.cos(ang) * 110, 0]); // muzzle of the big gun
    projectiles.push({ type: 'bullet', owner: f, x, y, vx: f.facing * 36, r: SPECIAL_HIT_R, t: 0 });
    burst(x, y, 18, ['#ffffff', '#fff2a0', '#ffb020'], 8);
    sfx.gun(); shake(6, 6);
  }
}

/* =====================================================================
   UPDATE
   ===================================================================== */
// each fighter is kept inside the stage edges independently — never relative to the other fighter
function clampX(f) { f.x = clamp(f.x, X_MIN, X_MAX); }

function updateFighter(f, o, canAct) {
  const p = f.idx;
  if (f.flash > 0) f.flash--;
  f.walking = false; f.blocking = false; f.crouching = false;

  if (f.knock === 'air') f.airT++;
  else if (f.knock === 'down') { if (!f.ko && --f.knockT <= 0) { f.knock = 'rise'; f.knockT = 22; } }
  else if (f.knock === 'rise') { if (--f.knockT <= 0) f.knock = 'none'; }
  else if (f.stun > 0) f.stun--;
  else {
    if (f.onGround && !f.action) f.facing = o.x >= f.x ? 1 : -1;
    if (canAct && !f.action) {
      // special has priority and works on its own key alone (even while holding block / moving);
      // a longer buffer means a press just before landing still fires
      if (f.onGround && !f.specialUsed && consume(p, 'special', 24)) startAction(f, 'special');
      else if (isHeld(p, 'block') && f.onGround) { f.blocking = true; f.vx = 0; }
      else {
        const crouch = f.onGround && isHeld(p, 'crouch');   // ducking: can't walk, but can still jump or attack
        const dir = crouch ? 0 : (isHeld(p, 'right') ? 1 : 0) - (isHeld(p, 'left') ? 1 : 0);
        if (f.onGround) { f.vx = dir * SPEED * (dir === f.facing ? 1 : .8); f.walking = dir !== 0; f.crouching = crouch; }
        else f.vx = clamp(f.vx + dir * .3, -SPEED, SPEED);
        if (f.onGround && consume(p, 'jump')) { f.vy = -JUMP_V; f.onGround = false; f.crouching = false; sfx.jump(); }
        if (f.onGround) {
          // Punch + Kick together = overhead jump attack; otherwise a normal punch / kick
          if (comboPressed(p)) { consume(p, 'punch'); consume(p, 'kick'); startAction(f, 'overhead'); }
          else if (consume(p, 'punch')) startAction(f, 'punch');
          else if (consume(p, 'kick')) startAction(f, 'kick');
        } else {
          // Jump + Punch / Jump + Kick: mid-air attack aimed by the direction held (no direction = at the opponent)
          const air = consume(p, 'kick') ? 'airKick' : consume(p, 'punch') ? 'airPunch' : null;
          if (air) {
            f.facing = dir || (o.x >= f.x ? 1 : -1);
            startAction(f, air);
            if (air === 'airKick') { f.vx = f.facing * 8.5; f.vy = Math.max(f.vy, 6); } // dive kick toward the chosen side
            else f.vx = f.facing * Math.max(Math.abs(f.vx), 3);                        // air punch drifts the same way
          }
        }
        if (f.action) f.crouching = false; // attacking stands you back up
      }
    } else if (!canAct && f.onGround) f.vx = 0;
  }

  // action timeline
  const a = f.action;
  if (a) {
    a.t++;
    if (f.onGround) f.vx = 0;
    if (a.type === 'special') {
      if ((f.special === 'fire' || f.special === 'shuriken') && a.t < ATK.special.fire && a.t % 2 === 0) { // energy gathering in the hands
        const [hx, hy] = toWorld(f, [(f.R.hF[0] + f.R.hB[0]) / 2, (f.R.hF[1] + f.R.hB[1]) / 2]);
        particles.push({ x: hx + rand(-40, 40), y: hy + rand(-40, 40), vx: 0, vy: 0, tx: hx, ty: hy, life: 14, max: 14, size: rand(4, 8), color: f.special === 'fire' ? '#ff7a1a' : '#5ab0ff', pull: true });
      }
      if (a.t === ATK.special.fire) fireSpecial(f);
      if (a.t >= ATK.special.total) f.action = null;
    } else if (a.type === 'overhead') {
      const d = ATK.overhead;
      if (a.t === d.start + 1) { f.vy = -d.leapV; f.vx = f.facing * d.leapX; f.onGround = false; sfx.jump(); }
      if (!a.hit && !f.onGround && a.t > d.start && f.vy > -6) tryHit(f, o, a, d); // strikes on the way down
      if (a.t >= d.start + d.active + d.rec) f.action = null;
    } else {
      const d = ATK[a.type];
      // pressing the other attack button during a ground punch / kick's wind-up turns it into the overhead
      if ((a.type === 'punch' || a.type === 'kick') && a.t <= COMBO_WINDOW && canAct && consume(p, a.type === 'punch' ? 'kick' : 'punch', COMBO_WINDOW)) {
        f.action = null; startAction(f, 'overhead');
      } else {
        if (!a.hit && a.t > d.start && a.t <= d.start + d.active) tryHit(f, o, a, d);
        if (a.t >= d.start + d.active + d.rec) f.action = null;
      }
    }
  }

  // physics
  if (!f.onGround) f.vy += GRAV;
  f.px = f.x;                       // where this fighter stood before its own move (separate() may undo just this step)
  f.x += f.vx; f.y += f.vy;
  if (f.y >= GROUND) {
    if (!f.onGround) {
      if (f.knock === 'air') { f.knock = 'down'; f.knockT = 70; shake(6, 8); dust(f.x - f.facing * 120, 18); sfx.land(); }
      else dust(f.x, 6);
      const la = f.action;
      if (la && (la.type === 'overhead' || la.type === 'airPunch' || la.type === 'airKick')) { // air attacks end on landing
        if (la.type === 'overhead') { shake(8, 10); dust(f.x + f.facing * 50, 22); sfx.land(); }
        f.action = null; f.vx = 0;
      }
    }
    f.y = GROUND; f.vy = 0; f.onGround = true;
  }
  if (f.onGround && (f.stun > 0 || f.knock !== 'none')) f.vx *= .82;
  clampX(f);
  animateFighter(f);
}

// purely visual: runs on the host after simulation, and on an online guest from snapshots
function animateFighter(f) {
  const a = f.action;
  f.hpShown = f.hpShown > f.hp ? Math.max(f.hp, f.hpShown - .15) : f.hp;
  if (f.walking) f.walkPh += Math.abs(f.vx) * .05 * Math.sign(f.vx * f.facing || 1);
  f.cloakSway = lerp(f.cloakSway, clamp(-f.vx * f.facing * 2.2 + (f.onGround ? 0 : f.vy * .6), -18, 18) + Math.sin(G.frame * .05 + f.idx) * 2, .12);
  const tp = targetPose(f), snappy = a && a.type !== 'special';
  f.pose = lerpPose(f.pose, tp, snappy ? .55 : f.vpose ? .42 : .25);
  f.R = solveRig(f.pose);
  // pick the sprite and snap the rig's fist / foot / head-top to where the art actually has them
  if (f.spr) {
    const fr = f.fr = frameOf(f), hand = spritePt(fr, fr.F.hand);
    f.R.hF = hand; f.R.elF = [hand[0] - 60, hand[1]]; // forearm level: gun / flower point straight ahead
    if (a && a.type === 'special' && f.special === 'flower' && a.t < ATK.special.fire) f.R.elF = [hand[0] + 25, hand[1] + 55]; // wind-up: flower cocked up and back
    f.R.anF = spritePt(fr, fr.F.foot);
    f.topY = fr.pose === 'crouch' && f.onGround ? -fr.F.h : -f.spr.standH;
  }
  // strike trail (fist / foot) in world space
  if (a && a.type !== 'special' && a.t > ATK[a.type].start - 2) f.trail.push(toWorld(f, usesFist(a.type) ? f.R.hF : f.R.anF));
  else f.trail.length = 0;
  if (f.trail.length > 6) f.trail.shift();
}

// Bodies are solid, but a fighter NEVER moves the other one: whoever steps into the opponent this frame is simply
// stopped where they stood (only their own step is undone). Jumping over and walking away are always free.
function separate() {
  const [a, b] = fighters, MIN = 95;
  if (a.knock !== 'none' || b.knock !== 'none') return;
  if (Math.abs(a.y - b.y) > FH * .5) return;
  if (Math.abs(b.x - a.x) >= MIN) return;
  for (const [f, o] of [[a, b], [b, a]]) {
    if (f.px === undefined) continue;
    if (Math.abs(o.x - f.x) < Math.abs(o.x - f.px)) f.x = f.px; // f closed the gap itself -> undo f's own step
  }
}

// LULU's shuriken: flies out along the special lane (slowing as it goes), turns, climbs into a curved arc on the way
// back and homes in on her hand wherever she is now. Returns true once she catches it.
function stepShuriken(p) {
  const u = p.t / SHURIKEN.T, o = p.owner, px = p.x, py = p.y;
  let x = p.x0 + p.dir * p.D * Math.sin(Math.PI * Math.min(u, 1));
  let y = p.y0 - SHURIKEN.rise * Math.sin(Math.PI * clamp((u - .4) / .6, 0, 1));
  const [hx, hy] = toWorld(o, o.R ? o.R.hF : [60, -SPECIAL_LANE]), w = smooth(.62, 1, u);
  x = lerp(x, hx, w); y = lerp(y, hy, w);
  p.x = x; p.y = y; p.vx = x - px; // vx = this frame's step (an online guest extrapolates with it)
  return u >= 1 || (u > .7 && Math.hypot(x - hx, y - hy) < 30);
}
function updateProjectiles() {
  for (const p of projectiles) {
    p.t++;
    if (p.type === 'shuriken') {
      if (stepShuriken(p)) { p.dead = true; burst(p.x, p.y, 16, ['#ffffff', '#9fd4ff', '#3a8cff'], 6); sfx.block(); continue; } // caught
    } else p.x += p.vx;
    fireTrail(p);
    const t = fighters[1 - p.owner.idx], b = t.hurtbox();
    if (!p.hit && !t.invuln && p.x + p.r > b.x1 && p.x - p.r < b.x2 && p.y + p.r > b.y1 && p.y - p.r < b.y2) {
      if (p.type === 'shuriken') p.hit = true; else p.dead = true; // the shuriken hits once and keeps flying back to Lulu
      specialHit(p, t);
    }
    if (p.x < -100 || p.x > STAGE_W + 100) p.dead = true;
    if (p.type === 'whip' && p.t > WHIP_LASH.life) p.dead = true;   // the lash has a reach, it doesn't fly on
  }
  if (projectiles.length === 2 && projectiles[0].owner !== projectiles[1].owner) {
    const [p, q] = projectiles;
    if (Math.abs(p.x - q.x) < p.r + q.r + 20 && Math.abs(p.y - q.y) < p.r + q.r + 20) {
      p.dead = q.dead = true; burst((p.x + q.x) / 2, (p.y + q.y) / 2, 50, ['#fff', '#ffb030', '#ff4a10'], 12); sfx.boom(); shake(10, 12);
    }
  }
  projectiles = projectiles.filter(p => !p.dead);
}
function fireTrail(p) {
  if (p.type === 'whip') { // ROKAIA's lash: loose hair strands and red ribbon flecks shed along its path
    if (p.t % 2 === 0) particles.push({ x: p.x - p.vx * rand(.2, 1), y: p.y + rand(-14, 14), vx: -p.vx * rand(.03, .08), vy: rand(-.6, .6), life: rand(10, 18) | 0, max: 18, size: rand(3, 6), color: Math.random() < .7 ? '#2a1610' : '#d3263a' });
    return;
  }
  if (p.type === 'shuriken') { // LULU's shuriken wave: blue wisps streaming off the spinning blades
    for (let i = 0; i < 2; i++) particles.push({ x: p.x + rand(-26, 26), y: p.y + rand(-26, 26), vx: -p.vx * rand(.05, .2), vy: rand(-.8, .8), life: rand(12, 22) | 0, max: 22, size: rand(5, 11), color: Math.random() < .5 ? '#3a8cff' : '#9fd4ff', glow: true });
    return;
  }
  if (p.type === 'fire') { // JOE's fireball: a stream of flames behind it
    for (let i = 0; i < 3; i++) particles.push({ x: p.x - p.vx * rand(0, 1.5), y: p.y + rand(-18, 18), vx: -p.vx * rand(.05, .2), vy: rand(-1.5, .5), life: rand(14, 26) | 0, max: 26, size: rand(6, 14), color: Math.random() < .5 ? '#ff5a10' : '#ffb030', glow: true });
    return;
  }
  if (p.type !== 'flower' || p.t % 3) return;
  if (p.owner.spr && p.owner.spr.heart) { // heart blast: trail of golden sparks
    particles.push({ x: p.x - p.vx * rand(1, 2.5), y: p.y + rand(-30, 30), vx: -p.vx * rand(.05, .15), vy: rand(-1.2, .6), life: rand(16, 26) | 0, max: 26, size: rand(5, 10), color: Math.random() < .6 ? '#ffb030' : '#ff6a3a', glow: true });
    return;
  }
  // loose petals shed by the spinning flower
  particles.push({ x: p.x - p.vx * rand(0, 1), y: p.y + rand(-16, 16), vx: -p.vx * rand(.05, .15), vy: rand(-1, .8), grav: .06, life: rand(26, 40) | 0, max: 40, size: rand(4, 7), color: Math.random() < .7 ? '#e0142c' : '#ff6a7a', petal: true, spin: rand(-.3, .3) });
}

function update() {
  G.frame++;
  if (G.phase === 'menu' || G.phase === 'gameover') { updateAmbient(); return; }
  if (G.phase === 'intro') { updateIntro(); updateCosmetics(); return; }

  if (G.phase === 'countdown') {
    G.timer++;
    if (G.timer >= COUNTDOWN * 60) { G.phase = 'fight'; G.fightBanner = 70; clearBuffers(); sfx.bell(); sfx.fight(); } // "FIGHT!": ring bell at full volume
    else if (G.timer % 60 === 0) sfx.beep();
  }
  if (G.fightBanner > 0) G.fightBanner--;
  if (G.phase === 'victory') { updateVictory(); if (G.flash > 0) G.flash--; updateCosmetics(); return; }

  if (G.hitStop > 0) G.hitStop--;
  else {
    const canAct = G.phase === 'fight';
    updateFighter(fighters[0], fighters[1], canAct);
    updateFighter(fighters[1], fighters[0], canAct);
    separate();
    updateProjectiles();
  }

  if (G.phase === 'roundEnd') {
    G.timer++;
    const w = fighters[G.winnerIdx];
    pullLoserIn(w, fighters[1 - G.winnerIdx]);    // keep both in frame for the K.O. / "WINS ROUND" moment
    if (G.timer === 70) {
      if (w.wins >= 2) startVictory();          // final round: cinematic victory synced to victory.mp3
      else { w.win = true; sfx.win(); }
    }
    if (G.phase === 'roundEnd' && G.timer >= 70 && w.wins < 2) { // round win: winner celebrates, loser gets up dazed
      const l = fighters[1 - G.winnerIdx];
      if (w.onGround && !w.action) w.vpose = 'victory';
      if (l.knock === 'down') { l.knock = 'none'; l.vpose = 'defeat'; l.stun = 0; l.y = GROUND; l.onGround = true; l.vx = 0; l.facing = w.x >= l.x ? 1 : -1; }
    }
    if (G.phase === 'roundEnd' && G.timer >= 260) { G.round++; startRound(); }
  }
  if (G.flash > 0) G.flash--;
  updateCosmetics();
}

// online guest: no simulation, just animate what the host's snapshots say
function guestUpdate() {
  G.frame++;
  if (G.phase === 'menu' || G.phase === 'gameover') { updateAmbient(); return; }
  // snapshots arrive ~30/s with network jitter: glide toward the latest host position, move projectiles in between
  if (!netStalled() && !NET.hostHidden && !NET.reconnectUntil) {
    for (const f of fighters) if (f.netX !== undefined) { f.x += (f.netX - f.x) * .5; f.y += (f.netY - f.y) * .5; }
    for (const p of projectiles) p.x += p.vx;
  }
  fighters.forEach(animateFighter);
  projectiles.forEach(fireTrail);
  updateCosmetics();
}

function updateCosmetics() {
  // the camera rests over the whole stage — the fighters' bounds are the stage edges, so both are always in view and
  // the camera never limits or moves a fighter. After a KO, framing the winner + loser is done by the victory zoom
  // (victoryZoom) and pullLoserIn — never during live play.
  cam.x += (CAM0 - cam.x) * .12;
  if (G.shake > 0) G.shake--;

  for (const p of particles) {
    if (p.pull) { p.x += (p.tx - p.x) * .2; p.y += (p.ty - p.y) * .2; }
    else { p.x += p.vx; p.y += p.vy; p.vy += p.grav || 0; p.vx *= .96; }
    p.life--;
  }
  particles = particles.filter(p => p.life > 0);
  for (const p of popups) { p.t++; p.y -= .8; }
  popups = popups.filter(p => p.t < p.life);
  updateAmbient();
}

function updateAmbient() {
  if (!embers.length) {
    for (let i = 0; i < 150; i++) embers.push(newEmber(true));
    for (let i = 0; i < 50; i++) ash.push({ x: rand(0, W), y: rand(0, H), vy: rand(.3, .9), ph: rand(0, 600), s: rand(1, 2.4) });
    for (let i = 0; i < 14; i++) bokeh.push({ x: rand(0, W * 1.6), y: rand(80, H), r: rand(14, 40), vy: -rand(.15, .5), ph: rand(0, 600), a: rand(.25, .6) });
  }
  for (const e of embers) { e.y += e.vy; e.x += Math.sin((G.frame + e.ph) * .03) * .5 + e.vx; if (e.y < -10) Object.assign(e, newEmber(false)); }
  for (const a of ash) { a.y += a.vy; a.x += Math.sin((G.frame + a.ph) * .02) * .6 + .2; if (a.y > H + 5) { a.y = -5; a.x = rand(0, W); } }
  for (const b of bokeh) { b.y += b.vy; if (b.y < -50) { b.y = H + 50; b.x = rand(0, W * 1.6); } }
  if (STAGE.bg) { updateStageFx(); return; } // painted stage: crater FX + beasts (the rest is for the procedural arena)
  const c = CONES[0];
  if (G.frame % 9 === 0) smoke.push({ x: c.cx + rand(-30, 30), y: c.crY - 6, vx: rand(.15, .45), vy: rand(-.75, -.45), s: rand(.6, .9), life: 0, max: rand(700, 950), v: (Math.random() * 3) | 0, rot: rand(0, 6), vr: rand(-.003, .003) });
  for (const s of smoke) { s.x += s.vx; s.y += s.vy; s.vy *= .9985; s.s += .0028; s.life++; s.rot += s.vr; }
  smoke = smoke.filter(s => s.life < s.max && s.y > -300);
  if (Math.random() < .02) for (let k = 0; k < 10; k++) bombs.push({ x: c.cx + rand(-20, 20), y: c.crY, vx: rand(-2.6, 2.6), vy: rand(-7, -3.5), life: 90 });
  for (const b of bombs) { b.x += b.vx; b.y += b.vy; b.vy += .12; b.life--; }
  bombs = bombs.filter(b => b.life > 0 && b.y < 600);
}
function newEmber(any) { return { x: rand(0, W + 200), y: any ? rand(0, H) : H + 10, vy: -rand(.5, 1.8), vx: rand(-.2, .4), s: rand(3, 9), ph: rand(0, 600), d: rand(.4, 1.1) }; }

// visual / audio events are mirrored to an online guest
function emit(name, args) { if (NET.role === 'host') NET.ev.push([name, args]); }
function burst(x, y, n, colors, spd) {
  emit('b', [x, y, n, colors, spd]);
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2), s = rand(spd * .3, spd);
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, grav: .25, life: rand(12, 28) | 0, max: 28, size: rand(2, 5), color: colors[i % colors.length], spark: true });
  }
}
// arcade impact starburst: a spiky star that pops out and fades, plus a white core flash
function starburst(x, y, size, color) {
  emit('sb', [x, y, size, color]);
  particles.push({ x, y, vx: 0, vy: 0, life: 13, max: 13, size, color, star: true, rot: rand(0, Math.PI) });
}
function dust(x, n) {
  emit('d', [x, n]);
  for (let i = 0; i < n; i++) particles.push({ x: x + rand(-50, 50), y: GROUND - 4, vx: rand(-2.5, 2.5), vy: rand(-1.8, -.3), life: rand(18, 34) | 0, max: 34, size: rand(6, 14), color: '#5a3a30', dust: true });
}
// rock chunks thrown up by the victory ground slam
function debris(x, n) {
  emit('r', [x, n]);
  const cols = ['#2a1410', '#3a1c12', '#1a0a08', '#4a2416'];
  for (let i = 0; i < n; i++) particles.push({ x: x + rand(-50, 50), y: GROUND - 6, vx: rand(-7.5, 7.5), vy: rand(-15, -5), grav: .55, life: rand(36, 54) | 0, max: 54, size: rand(5, 13), color: cols[i % cols.length], rock: true, spin: rand(-.3, .3) });
}
function popup(text, x, y, color, size) { emit('p', [text, x, y, color, size]); popups.push({ text, x, y, color, size, t: 0, life: 60 }); }
function shake(mag, t) { emit('k', [mag, t]); G.shakeMag = mag; G.shake = t; }

/* =====================================================================
   RENDER
   ===================================================================== */
// victory camera: zoom in on the winner (with a punch at the ground slam), never exposing the frame edges
/* ---------- KO / victory framing: winner AND loser always fully on screen ----------
   1) once the loser has landed, they're eased in to at most FRAME_GAP from the winner (host simulation; synced)
   2) the camera centres on the pair, and the victory zoom never zooms in further than both still fit */
const FRAME_GAP = 430;   // max centre-to-centre distance once the round is over
// a fighter's horizontal on-screen extent in world px — stretched out behind them while lying down
function fighterExtent(f) {
  const lying = f.knock === 'down' || f.knock === 'rise' || (f.knock === 'air' && !(f.fr && f.fr.noRot));
  if (lying) return f.facing > 0 ? [f.x - 430, f.x + 130] : [f.x - 130, f.x + 430];
  const F = f.fr && f.fr.F;                                     // the actual frame on screen (a high kick reaches far)
  if (F) return f.facing > 0 ? [f.x - F.ax, f.x - F.ax + F.w] : [f.x + F.ax - F.w, f.x + F.ax];
  return [f.x - 200, f.x + 200];
}
function pairFrame() {
  const a = fighterExtent(fighters[0]), b = fighterExtent(fighters[1]);
  const L = Math.min(a[0], b[0]) - 30, R = Math.max(a[1], b[1]) + 30;
  return { L, R, cx: (L + R) / 2, span: R - L };
}
// victory: the winner eases to the middle of the arena, so the camera can sit centred on them with the zoom
// (the painted arena is exactly one screen wide: centring a winner who finished at a wall would show past its edge)
function centreWinner(w) {
  if (!w.onGround) return;
  const mid = cam.x + W / 2;
  if (Math.abs(mid - w.x) > 1) w.x += (mid - w.x) * .05;
}
function pullLoserIn(w, l) {
  if (!l.onGround || l.knock === 'air') return;           // let the knockback flight play out first
  const d = l.x - w.x, side = Math.sign(d) || 1, gap = G.phase === 'victory' ? VICTORY_CLOSE_GAP : FRAME_GAP;
  if (G.phase === 'victory') { // right beside the winner, on the side they were knocked to — never on top of them
    const s = G.vSide || side, target = w.x + s * gap;
    if (Math.abs(target - l.x) > 1) { l.x += (target - l.x) * .07; l.vx = 0; }
  } else if (Math.abs(d) > gap) { l.x += (w.x + side * gap - l.x) * .07; l.vx = 0; }
  // a body lying at a stage edge would stick out of the frame: ease it in until it is fully on screen
  const [a, b] = fighterExtent(l), lo = cam.x + 24, hi = cam.x + W - 24;
  if (a < lo) l.x += (lo - a) * .12; else if (b > hi) l.x -= (b - hi) * .12;
}
function victoryZoom() {
  if (G.phase !== 'victory' || G.winnerIdx < 0) return null;
  const w = fighters[G.winnerIdx], vt = G.vt || 0;
  const punch = smooth(SLAM_T - .05, SLAM_T + .03, vt) * (1 - smooth(SLAM_T + .03, SLAM_T + .5, vt));
  const air = clamp((GROUND - w.y) / 140, 0, 1);            // pull the zoom back during the high leap
  const PF = pairFrame();
  // celebration close-up: once the winner's victory animation starts, ease into a closer medium shot of both
  // (heads to knees) so the details — Moe's gun draw / spin / bowtie, Romana's kiss — read big and clear
  const cel = smooth(w.char.victoryFrom - .4, w.char.victoryFrom + .9, vt);
  const zWant = lerp(1 + (.22 * smooth(0, 1.1, vt) + .08 * punch) * (1 - .9 * air), VICTORY_CLOSE_Z, cel);
  // the camera is CENTRED ON THE WINNER; it zooms in only as far as the loser, eased in right beside them, still
  // fits fully on that side of the frame (half the view must reach from the winner past the loser's far edge)
  const half = Math.max(w.x - PF.L, PF.R - w.x);
  // ...and only as far as both stay fully visible top to bottom too: heads under the top letterbox AND the floor
  // (where a knocked-out loser lies) above the bottom one
  const top = Math.min(...fighters.map(f => f.y - (f.spr ? f.spr.standH : FH))) - 44, floor = GROUND + 40;
  const z = Math.max(1, Math.min(zWant, W / (2 * half), (H - 170) / (floor - top)));
  const vw = W / z;
  const a = clamp((w.x - cam.x) - vw / 2, 0, W - vw);  // a = left edge of the view (kept inside the arena)
  // vertical: keep the winner's feet just above the bottom letterbox and follow the leap upward; in the close-up,
  // anchor the top of both heads (incl. dizzy stars / tiara) just under the top letterbox instead
  const tyFeet = 636 - z * w.y;
  const tyHeads = Math.min(84 - z * top, H - 86 - z * floor);   // heads in, floor never cut off
  return [-a * z, clamp(lerp(tyFeet, tyHeads, cel), H - z * H, 0), z];
}
const VICTORY_CLOSE_Z = 1.55;  // celebration zoom (both fighters still side by side, heads to about the knees)
const VICTORY_CLOSE_GAP = 310; // ...for which the loser is eased in to this distance: right beside the winner
// ground break: glowing cracks radiating from the slam point, staying until the game-over screen
const CRACKS = (() => {
  const r = seeded(4242), out = [];
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2 + r() * .4, pts = [[0, 0]], len = 120 + r() * 240;
    let x = 0, z = 0;
    for (let s = 1; s <= 7; s++) { const d = len / 7; x += Math.cos(a) * d + (r() - .5) * 26; z += Math.sin(a) * d + (r() - .5) * 26; pts.push([x, z]); }
    out.push(pts);
  }
  return out;
})();
function drawGroundBreak() {
  const vt = G.vt; if (vt < SLAM_T) return;
  const w = fighters[G.winnerIdx], cx = w.x - cam.x + w.facing * 60, grow = smooth(SLAM_T, SLAM_T + .18, vt);
  const glow = .55 + .45 * (1 - smooth(SLAM_T, SLAM_T + 1.5, vt)) + .1 * Math.sin(G.frame * .2);
  const P2 = (p, k) => [cx + p[0] * k, GROUND + 4 + p[1] * k * .17]; // project onto the floor plane
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // crater
  ctx.fillStyle = 'rgba(10,2,2,.85)'; ctx.beginPath(); ctx.ellipse(cx, GROUND + 4, 95 * grow, 18 * grow, 0, 0, 7); ctx.fill();
  for (const [lw, col, comp] of [[7, 'rgba(12,3,2,.95)', 'source-over'], [3, `rgba(255,120,30,${glow})`, 'lighter'], [1.2, `rgba(255,230,150,${glow})`, 'lighter']]) {
    ctx.globalCompositeOperation = comp; ctx.strokeStyle = col; ctx.lineWidth = lw;
    for (const pts of CRACKS) {
      const n = Math.max(1, Math.round(pts.length * grow));
      ctx.beginPath(); pts.slice(0, n).forEach((p, i) => { const [x, y] = P2(p, 1); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = `rgba(255,150,50,${glow})`; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(cx, GROUND + 4, 95 * grow, 18 * grow, 0, 0, 7); ctx.stroke();
  ctx.restore();
}

function render() {
  const sh = G.shake > 0 ? G.shakeMag * (G.shake / 20) : 0;
  const sx = rand(-sh, sh), sy = rand(-sh, sh), VZ = victoryZoom(), victory = G.phase === 'victory';
  ctx.save(); ctx.translate(sx, sy);
  if (VZ) { ctx.translate(VZ[0], VZ[1]); ctx.scale(VZ[2], VZ[2]); }
  drawArena();
  if (G.phase !== 'menu') {
    if (victory) { drawGroundBreak(); drawVictoryRays(); }
    fighters.forEach(renderFighter);
    // draw order: once a round is decided the WINNER is always in front (their victory move is never hidden behind
    // the loser); during the fight, whoever is attacking or posing draws on top
    const decided = G.winnerIdx >= 0 && (G.phase === 'roundEnd' || G.phase === 'victory' || G.phase === 'gameover');
    const order = decided ? [fighters[1 - G.winnerIdx], fighters[G.winnerIdx]]
      : [...fighters].sort((a, b) => (a.action || a.vpose ? 1 : 0) - (b.action || b.vpose ? 1 : 0));
    order.forEach(drawShadow);
    // sprites go on with smoothing OFF (crisp pixels, also under the victory zoom); the painted arena, perspective
    // floor and bloom keep smoothing ON, because those are stretched textures that would turn blocky
    ctx.imageSmoothingEnabled = false;
    order.forEach(f => { ctx.drawImage(f.cv, Math.round(f.x - cam.x - OX), Math.round(f.y - OY)); drawTrail(f); });
    ctx.imageSmoothingEnabled = true;
    fighters.forEach(f => { if (f.fr && f.fr.A.legSmoke) drawLegSmoke(f); });
    if (victory) drawShockwave();
    drawProjectiles();
    drawParticles();
  }
  drawForeground();
  ctx.restore();
  drawPost();
  if (G.phase !== 'menu') {
    ctx.save(); ctx.translate(sx, sy);
    if (VZ) { ctx.translate(VZ[0], VZ[1]); ctx.scale(VZ[2], VZ[2]); }
    const clean = victory || G.phase === 'gameover'; // victory + game over: no bars or HUD over the scene (it shows
    if (!clean) fighters.forEach(drawOverhead);     // through the see-through game-over screen behind the dance)
    drawPopups(); ctx.restore();
    if (!clean) drawHUD();
    drawBanners();
    drawNetBanner();
  }
  if (G.flash > 0) { ctx.fillStyle = `rgba(255,240,220,${G.flash / 30})`; ctx.fillRect(0, 0, W, H); }
}

// online status: lag / reconnect / host paused, plus a one-time "enable sound" hint for a guest who joined by link
function drawNetBanner() {
  if (NET.role === 'local') return;
  const now = performance.now(), secs = NET.reconnectUntil ? Math.max(0, Math.ceil((NET.reconnectUntil - now) / 1000)) : 0;
  let msg = '';
  if (NET.role === 'host') {
    if (NET.reconnectUntil) msg = `Player 2 disconnected — waiting for them to reconnect… ${secs}s`;
    else if (netStalled() && IN_MATCH()) msg = 'Player 2’s connection is lagging — fight paused';
  } else {
    if (NET.reconnectUntil) msg = `Connection lost — reconnecting to Player 1… ${secs}s`;
    else if (NET.hostHidden) msg = 'Player 1 switched away from the game — paused';
    else if (netStalled() && IN_MATCH()) msg = 'Connection lagging — waiting for Player 1…';
  }
  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (msg) {
    ctx.font = 'bold 26px "Segoe UI", Arial, sans-serif';
    const w = ctx.measureText(msg).width + 48;
    ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(W / 2 - w / 2, H / 2 - 30, w, 60);
    ctx.strokeStyle = '#ffcf5a'; ctx.lineWidth = 2; ctx.strokeRect(W / 2 - w / 2, H / 2 - 30, w, 60);
    ctx.fillStyle = '#ffe9b0'; ctx.fillText(msg, W / 2, H / 2);
  }
  if (NET.role === 'guest' && (!AC || AC.state !== 'running') && IN_MATCH()) {
    ctx.font = '18px "Segoe UI", Arial, sans-serif'; ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(W / 2 - 170, H - 64, 340, 32);
    ctx.fillStyle = '#ffd9a8'; ctx.fillText('🔈 Click or tap anywhere to turn on sound', W / 2, H - 48);
  }
  ctx.restore();
}
// browsers only allow sound after a user gesture — a guest who joined by link may never click a button
['pointerdown', 'keydown', 'touchstart'].forEach(t => addEventListener(t, () => initAudio(), { capture: true, passive: true }));

// lingering smoke & dust from the ground slam, banked around the winner's legs (covers art that is cropped at the
// thighs). Local to that fighter (±~210px), so it never reaches the opponent standing FRAME_GAP away.
const LEG_SMOKE = [[-150, -95, 150, 0], [-70, -125, 175, 1], [20, -110, 165, 2], [110, -90, 150, 0], [-110, -40, 190, 1], [0, -55, 210, 2], [100, -40, 185, 0], [-40, -15, 170, 1], [60, -10, 160, 2]];
function drawLegSmoke(f) {
  const x0 = f.x - cam.x, cut = f.y - (f.fr.A.lift || 0), t = G.frame * .012;
  ctx.save();
  // solid dust core from just above the cut edge down to the floor, so no gap ever shows the cropped legs
  const cy = (cut + f.y) / 2 + 8, ry = (f.y - cut) / 2 + 46;
  ctx.save(); ctx.translate(x0, cy); ctx.scale(1, ry / 200);
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 200);
  core.addColorStop(0, 'rgba(46,26,22,.98)'); core.addColorStop(.62, 'rgba(46,26,22,.93)'); core.addColorStop(1, 'rgba(46,26,22,0)');
  ctx.fillStyle = core; ctx.beginPath(); ctx.arc(0, 0, 200, 0, 7); ctx.fill(); ctx.restore();
  for (const [dx, dy, sz, v] of LEG_SMOKE) {
    const k = sz * (1 + .06 * Math.sin(t * 2 + dx)), px = x0 + dx * .9 + Math.sin(t + dy) * 8, py = cut + (f.y - cut) * .55 + dy * .6;
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.save(); ctx.translate(px, py); ctx.rotate(t * .3 + dx * .01);
    ctx.drawImage(L.smoke[v], -k / 2, -k / 2, k, k); ctx.drawImage(L.smoke[(v + 1) % 3], -k * .4, -k * .4, k * .8, k * .8); // billowy edge
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = .55;                 // lava light from the cracks below
    ctx.drawImage(L.smokeLit[v], -k / 2, -k / 2, k, k);
    ctx.restore();
  }
  ctx.restore();
}

function drawVictoryRays() {
  const w = fighters[G.winnerIdx], vt = G.vt, k = smooth(.3, 1.2, vt) * (1 + .6 * smooth(SLAM_T, SLAM_T + .1, vt) * (1 - smooth(SLAM_T + .1, SLAM_T + 1, vt)));
  if (k <= 0) return;
  const cx = w.x - cam.x, cy = w.y - 200, R = 900;
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 14; i++) {
    const a = i / 14 * Math.PI * 2 + G.frame * .004, wd = .07 + .03 * Math.sin(i * 1.7 + G.frame * .03);
    const gr = ctx.createRadialGradient(cx, cy, 20, cx, cy, R);
    gr.addColorStop(0, `rgba(255,215,120,${.16 * k})`); gr.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a - wd) * R, cy + Math.sin(a - wd) * R); ctx.lineTo(cx + Math.cos(a + wd) * R, cy + Math.sin(a + wd) * R);
    ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = .55 * k; ctx.drawImage(L.flare, cx - 300, cy - 300, 600, 600);
  ctx.restore();
}
function drawShockwave() {
  const vt = G.vt; if (vt < SLAM_T || vt > SLAM_T + .9) return;
  const w = fighters[G.winnerIdx], p = (vt - SLAM_T) / .9, x = w.x - cam.x + w.facing * 50;
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const [delay, col] of [[0, '255,210,110'], [.12, '255,120,40']]) {
    const q = clamp((p - delay) / (1 - delay), 0, 1), r = 30 + 720 * q;
    if (q <= 0) continue;
    ctx.strokeStyle = `rgba(${col},${(1 - q) * .9})`; ctx.lineWidth = 18 * (1 - q) + 2;
    ctx.beginPath(); ctx.ellipse(x, GROUND + 2, r, r * .16, 0, 0, Math.PI * 2); ctx.stroke();
  }
  // ground glow at impact
  ctx.globalAlpha = (1 - p) * .9; ctx.drawImage(L.flare, x - 260, GROUND - 160, 520, 300);
  ctx.restore();
}

const layerX = f => -Math.round(cam.x * f);

/* ---------- painted volcano stage (volcano_stage.png) + eruption FX + flying beasts (volcano_beasts.png) ----------
   The stage image is cover-fitted to the canvas once at load and drawn as the fixed backdrop. Eruptions, smoke and
   beasts are ambient (each player's screen rolls its own randomness) and are drawn BEHIND the fighters, and the
   beasts only fly in the sky band at the top, so nothing ever covers a player. */
const STAGE = { bg: null, beasts: null, crater: [W * .505, H * .16] };
const ERUPT = { puffs: [], sparks: [], next: 240, flash: 0 };
const BEASTS = { list: [], next: 90 };
const SKY_BAND = [62, 205]; // beast flight band (screen px from the top): fully above the health bars (~215) and heads (~250)
async function loadStage() {
  const bg = await loadImgFile([`volcano_stage.png?v=${ANIM_V}`, 'volcano_stage.png']);
  if (bg) {
    const K = keyedFile(bg, 'volcano_stage.png', 1);            // same white-key pass as every other asset
    const iw = K.W, ih = K.H, sw = Math.min(iw, ih * W / H), sh = sw * H / W, sx = (iw - sw) / 2, sy = (ih - sh) / 2;
    const crop = mk(sw, sh); crop.getContext('2d').drawImage(K.cv, sx, sy, sw, sh, 0, 0, sw, sh);
    STAGE.bg = resizeHQ(crop, W, H);                             // cover-fit once, drawn 1:1 every frame
    STAGE.crater = [(845 - sx) / sw * W, (150 - sy) / sh * H];   // the crater in volcano_stage.png
  }
  const bz = await loadImgFile([`volcano_beasts.png?v=${ANIM_V}`, 'volcano_beasts.png']);
  if (bz) STAGE.beasts = buildAnim(keyedFile(bz, 'volcano_beasts.png', 1), { h: 120 }, 4);
  console.info(`stage: ${bg ? 'volcano_stage.png' : 'MISSING volcano_stage.png → procedural arena'}, beasts: ${bz ? '4 frames' : 'MISSING volcano_beasts.png'}`);
}
// ambient update (runs on host and guest alike, also in the menu)
function updateStageFx() {
  const [cx, cy] = STAGE.crater;
  if (G.frame % 8 === 0) ERUPT.puffs.push({ x: cx + rand(-18, 18), y: cy + rand(-4, 6), vx: rand(-.15, .35), vy: rand(-.7, -.4), s: rand(.35, .55), life: 0, max: rand(420, 620), v: (Math.random() * 3) | 0, rot: rand(0, 6), vr: rand(-.004, .004) });
  if (Math.random() < .05) for (let k = 0; k < 4; k++) ERUPT.sparks.push(lavaSpark(cx, cy, .6));       // small spurts
  if (G.frame >= ERUPT.next) {                                                                     // big eruption
    ERUPT.next = G.frame + rand(180, 480) | 0; ERUPT.flash = 1;
    const n = rand(45, 90) | 0; for (let k = 0; k < n; k++) ERUPT.sparks.push(lavaSpark(cx, cy, 1));
    for (let k = 0; k < 7; k++) ERUPT.puffs.push({ x: cx + rand(-30, 30), y: cy - rand(0, 20), vx: rand(-.6, .6), vy: rand(-1.6, -.9), s: rand(.5, .9), life: 0, max: rand(380, 560), v: (Math.random() * 3) | 0, rot: rand(0, 6), vr: rand(-.006, .006) });
  }
  ERUPT.flash *= .94;
  for (const s of ERUPT.puffs) { s.x += s.vx; s.y += s.vy; s.vy *= .997; s.s += .0022; s.life++; s.rot += s.vr; }
  ERUPT.puffs = ERUPT.puffs.filter(s => s.life < s.max && s.y > -260);
  for (const p of ERUPT.sparks) { p.px = p.x; p.py = p.y; p.x += p.vx; p.y += p.vy; p.vy += .13; p.life--; }
  ERUPT.sparks = ERUPT.sparks.filter(p => p.life > 0 && p.y < H * .8);
  // beasts: up to 3 at a time, random side, speed, size and altitude; bigger = nearer = faster and brighter
  if (STAGE.beasts && BEASTS.list.length < 3 && G.frame >= BEASTS.next) {
    const dir = Math.random() < .5 ? 1 : -1, s = rand(.42, 1), hh = 120 * s;
    BEASTS.list.push({ dir, s, x: dir > 0 ? -220 : W + 220, y: rand(SKY_BAND[0] + hh * .4, SKY_BAND[1] - hh * .5), vx: dir * rand(1.1, 2.6) * (.55 + .7 * s),
      ph: rand(0, 4), fps: rand(7, 11), bob: rand(4, 12), bs: rand(.02, .045), a: .6 + .4 * s, t: 0 });
    BEASTS.next = G.frame + rand(100, 420) | 0;
  }
  for (const b of BEASTS.list) { b.x += b.vx; b.t++; }
  BEASTS.list = BEASTS.list.filter(b => b.x > -260 && b.x < W + 260);
}
function lavaSpark(cx, cy, k) {
  // arcs 30-200px above the crater and rains back down the slopes (gravity .13 in updateStageFx)
  const a = -Math.PI / 2 + rand(-.75, .75), sp = rand(2.5, 7.2) * (k < 1 ? .7 : 1);
  return { x: cx + rand(-14, 14), y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(70, 140) | 0, max: 140, size: rand(2.5, 6.5) * (k < 1 ? .7 : 1) };
}
function drawStage() {
  const [cx, cy] = STAGE.crater, pulse = .85 + .15 * Math.sin(G.frame * .05);
  ctx.drawImage(STAGE.bg, 0, 0);
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = .35 * pulse + .55 * ERUPT.flash; ctx.drawImage(L.flare, cx - 260, cy - 220, 520, 440);   // crater glow / eruption flash
  ctx.restore();
  // smoke clouds rising out of the crater (underlit by the lava)
  for (const s of ERUPT.puffs) {
    const k = s.life / s.max, a = Math.sin(Math.PI * Math.min(1, k * 1.2)) * .42, sz = 160 * s.s * 1.6;
    ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.rot); ctx.globalAlpha = a;
    ctx.drawImage(L.smoke[s.v], -sz / 2, -sz / 2, sz, sz);
    const lit = Math.max(.25, 1 - (cy - s.y) / 260);                                         // lava-lit from below
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = Math.min(1, a * lit * 1.1 + ERUPT.flash * .4); ctx.drawImage(L.smokeLit[s.v], -sz / 2, -sz / 2, sz, sz);
    ctx.restore();
  }
  // beasts in the sky band (4-frame flap, flipped to their flight direction)
  if (STAGE.beasts) {
    const A = STAGE.beasts;
    for (const b of BEASTS.list) {
      const F = A.frames[Math.floor(b.t / 60 * b.fps + b.ph) % A.frames.length], y = b.y + Math.sin(b.t * b.bs) * b.bob;
      ctx.save(); ctx.translate(Math.round(b.x), Math.round(y));
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = .28 * b.a;                   // lava backlight so the dark
      ctx.drawImage(L.flare, -95 * b.s, -75 * b.s, 190 * b.s, 150 * b.s);                    // silhouettes read on the sky
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = b.a; ctx.scale(b.dir * b.s, b.s);
      ctx.drawImage(A.strip, F.sX, F.sY, F.w, F.h, -F.w / 2, -F.h / 2, F.w, F.h);
      ctx.restore();
    }
  }
  // lava sparks and embers thrown up by the volcano
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const p of ERUPT.sparks) {
    const k = Math.min(1, p.life / 40);
    ctx.globalAlpha = k; ctx.strokeStyle = 'rgba(255,170,60,.9)'; ctx.lineWidth = p.size * .8;
    ctx.beginPath(); ctx.moveTo(p.px ?? p.x, p.py ?? p.y); ctx.lineTo(p.x - (p.x - (p.px ?? p.x)) * 3, p.y - (p.y - (p.py ?? p.y)) * 3); ctx.stroke(); // streak
    ctx.drawImage(L.ember, p.x - p.size * 2, p.y - p.size * 2, p.size * 4, p.size * 4);
  }
  ctx.restore();
  drawEmbers(false);
}

function drawArena() {
  if (STAGE.bg) { drawStage(); return; } // painted stage; the procedural arena below is the fallback
  ctx.drawImage(L.sky, layerX(PAR.sky), 0);
  // crater back-glow
  const cx = CONES[0].cx + layerX(PAR.vol), cy = CONES[0].crY, pulse = .85 + .15 * Math.sin(G.frame * .045);
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = .55 * pulse;
  ctx.drawImage(L.flare, cx - 420, cy - 380, 840, 760); ctx.restore();
  ctx.drawImage(L.far, layerX(PAR.far), 0);
  ctx.drawImage(L.vol, layerX(PAR.vol), 0);
  // crater glow + lava bombs
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = .9 * pulse; ctx.drawImage(L.flare, cx - 130, cy - 120, 260, 220);
  ctx.globalAlpha = 1;
  for (const b of bombs) { const a = Math.min(1, b.life / 40); ctx.globalAlpha = a; ctx.drawImage(L.ember, b.x + layerX(PAR.vol) - 7, b.y - 7, 14, 14); }
  ctx.restore();
  drawSmoke(cx);
  drawGodRays(cx, cy);
  drawFog(470, .55, .3, .45);
  ctx.drawImage(L.mid, layerX(PAR.mid), 0);
  // lava lake shimmer + lava falls pulse
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  const ly = L.lakeY;
  let gr = ctx.createLinearGradient(0, ly - 6, 0, FLOOR_TOP);
  gr.addColorStop(0, `rgba(255,120,40,${.10 + .06 * Math.sin(G.frame * .06)})`); gr.addColorStop(1, 'rgba(255,170,70,.28)');
  ctx.fillStyle = gr; ctx.fillRect(0, ly - 6, W, FLOOR_TOP - ly + 6);
  ctx.globalAlpha = .35 + .2 * Math.sin(G.frame * .08);
  for (const fl of L.falls) { const x = fl.x + layerX(PAR.mid); if (x > -60 && x < W + 60) ctx.drawImage(L.flare, x - 40, ly - 50, 80, 80); }
  ctx.restore();
  drawFog(520, .8, .5, .4);
  drawFloor();
  drawPillar(-40); drawPillar(STAGE_W - 90);
  drawEmbers(false);
}

function drawSmoke(cx) {
  const ox = layerX(PAR.vol), c = CONES[0];
  for (const s of smoke) {
    const k = s.life / s.max, a = Math.sin(Math.PI * Math.min(1, k * 1.15)) * .85, sz = 160 * s.s * 1.6;
    const x = s.x + ox, y = s.y;
    if (x < -sz || x > W + sz) continue;
    ctx.save(); ctx.translate(x, y); ctx.rotate(s.rot);
    ctx.globalAlpha = a; ctx.drawImage(L.smoke[s.v], -sz / 2, -sz / 2, sz, sz);
    const lit = Math.max(0, 1 - (c.crY - s.y) / 260);
    if (lit > 0) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = a * lit * .9; ctx.drawImage(L.smokeLit[s.v], -sz / 2, -sz / 2, sz, sz); }
    ctx.restore();
  }
}

function drawGodRays(cx, cy) {
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 7; i++) {
    const base = -Math.PI / 2 + (i - 3) * .32 + Math.sin(G.frame * .004 + i * 1.7) * .06;
    const wdt = .05 + .03 * Math.sin(i * 2.3 + G.frame * .01), len = 640;
    const gr = ctx.createRadialGradient(cx, cy, 10, cx, cy, len);
    gr.addColorStop(0, `rgba(255,150,70,${.13 + .05 * Math.sin(G.frame * .02 + i)})`); gr.addColorStop(1, 'rgba(255,90,30,0)');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(base - wdt) * len, cy + Math.sin(base - wdt) * len);
    ctx.lineTo(cx + Math.cos(base + wdt) * len, cy + Math.sin(base + wdt) * len);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function drawFog(y, par, speed, alpha) {
  const fw = L.fog.width * 1.6, fh = L.fog.height * 1.2;
  let x = ((-(cam.x * par) - G.frame * speed) % fw + fw) % fw - fw;
  ctx.save(); ctx.globalAlpha = alpha;
  for (; x < W; x += fw - 1) ctx.drawImage(L.fog, x, y - fh / 2, fw, fh);
  ctx.restore();
}

function drawFloor() {
  const TH = H - FLOOR_TOP, pulse = .75 + .25 * Math.sin(G.frame * .05);
  for (let r = 0; r < TH; r++) {
    const y = FLOOR_TOP + r, p = floorP(y + .5);
    const sx = (cam.x + W / 2 - (W / 2) / p + TEX_PAD) * TEX_RES, sw = (W / p) * TEX_RES;
    ctx.drawImage(L.floor, sx, r, sw, 1, 0, y, W, 1);
  }
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = pulse;
  for (let r = 0; r < TH; r++) {
    const y = FLOOR_TOP + r, p = floorP(y + .5);
    const sx = (cam.x + W / 2 - (W / 2) / p + TEX_PAD) * TEX_RES, sw = (W / p) * TEX_RES;
    ctx.drawImage(L.floorGlow, sx, r, sw, 1, 0, y, W, 1);
  }
  ctx.restore();
  // far lip of the platform, lit from the lava lake behind
  let gr = ctx.createLinearGradient(0, FLOOR_TOP - 2, 0, FLOOR_TOP + 22);
  gr.addColorStop(0, 'rgba(255,170,80,.75)'); gr.addColorStop(.12, 'rgba(255,120,40,.25)'); gr.addColorStop(.35, 'rgba(10,2,2,.45)'); gr.addColorStop(1, 'rgba(10,2,2,0)');
  ctx.fillStyle = gr; ctx.fillRect(0, FLOOR_TOP - 2, W, 24);
  // depth darkening toward the camera
  gr = ctx.createLinearGradient(0, GROUND, 0, H);
  gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(8,0,0,.45)');
  ctx.fillStyle = gr; ctx.fillRect(0, GROUND, W, H - GROUND);
}

function drawPillar(wx) {
  const x = wx - cam.x; if (x < -200 || x > W + 60) return;
  const top = GROUND + 40 - L.pillar.height;
  ctx.drawImage(L.pillar, x, top);
  drawFlame(x + 65, top + 2, 1.5);
}
function drawFlame(x, y, s) {
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = .7 + .2 * Math.sin(G.frame * .3 + x);
  ctx.drawImage(L.flare, x - 120 * s, y - 150 * s, 240 * s, 240 * s);
  ctx.globalAlpha = 1;
  const cols = ['rgba(255,50,0,.7)', 'rgba(255,130,20,.75)', 'rgba(255,225,130,.85)'];
  cols.forEach((c, i) => {
    const k = 1 - i * .28, t = G.frame * .25 + i * 2 + x;
    const hgt = (62 + 10 * Math.sin(t) + 6 * Math.sin(t * 1.7)) * s * k, wid = 24 * s * k;
    ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(x - wid, y);
    ctx.quadraticCurveTo(x - wid * 1.1, y - hgt * .5, x + Math.sin(t * 1.3) * 8 * s, y - hgt);
    ctx.quadraticCurveTo(x + wid * 1.1, y - hgt * .5, x + wid, y); ctx.closePath(); ctx.fill();
  });
  ctx.restore();
}

function drawEmbers() {
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  const span = W + 200;
  for (const e of embers) {
    const x = ((e.x - cam.x * e.d) % span + span) % span - 100;
    const fl = .55 + .45 * Math.sin((G.frame + e.ph) * .15), s = e.s * e.d;
    ctx.globalAlpha = fl; ctx.drawImage(L.ember, x - s / 2, e.y - s / 2, s, s);
  }
  ctx.restore();
  ctx.fillStyle = 'rgba(40,30,30,.55)';
  for (const a of ash) ctx.fillRect(a.x, a.y, a.s, a.s);
}

function drawForeground() {
  if (!STAGE.bg) ctx.drawImage(L.fg, layerX(PAR.fg), H - L.fg.height); // (the painted stage has its own foreground)
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  const span = W * 1.6;
  for (const b of bokeh) {
    const x = ((b.x - cam.x * 1.5) % span + span) % span - b.r * 2;
    ctx.globalAlpha = b.a * (.7 + .3 * Math.sin((G.frame + b.ph) * .05));
    ctx.drawImage(L.bokeh, x - b.r, b.y - b.r, b.r * 2, b.r * 2);
  }
  ctx.restore();
}

function drawPost() {
  // bloom
  if (L.bloomOK) {
    const g = L.bloomG; g.globalCompositeOperation = 'copy'; g.filter = 'brightness(.7) contrast(2.6) saturate(1.3) blur(1.5px)';
    g.drawImage(cvs, 0, 0, W / 8, H / 8); g.filter = 'none';
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = .32; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(L.bloom, 0, 0, W, H); ctx.restore();
  }
  // grade + vignette
  let gr = ctx.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, STAGE.bg ? 'rgba(20,0,10,.12)' : 'rgba(20,0,10,.35)'); gr.addColorStop(.35, 'rgba(20,0,10,0)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
  gr = ctx.createRadialGradient(W / 2, H * .52, H * .3, W / 2, H * .52, H * 1.0);
  gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(12,0,0,.62)');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
}

/* ---------- fighters on screen ---------- */
function drawShadow(f) {
  const x = f.x - cam.x, k = clamp(1 - (GROUND - f.y) / 420, .35, 1);
  const lying = f.knock === 'down' || f.knock === 'rise';
  const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  gr.addColorStop(0, `rgba(0,0,0,${.65 * k})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save(); ctx.translate(x - (lying ? f.facing * 150 : 0), GROUND + 4); ctx.scale((lying ? 220 : 95) * k, 18 * k);
  ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, 1, 0, 7); ctx.fill(); ctx.restore();
}

function drawTrail(f) {
  if (f.trail.length < 2) return;
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let i = 1; i < f.trail.length; i++) {
    const t = i / f.trail.length, a = f.trail[i - 1], b = f.trail[i];
    ctx.strokeStyle = f.color; ctx.globalAlpha = t * .5; ctx.lineWidth = 26 * t;
    ctx.beginPath(); ctx.moveTo(a[0] - cam.x, a[1]); ctx.lineTo(b[0] - cam.x, b[1]); ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.globalAlpha = t * .35; ctx.lineWidth = 8 * t; ctx.stroke();
  }
  ctx.restore();
}

function drawProjectiles() {
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const p of projectiles) {
    const x = p.x - cam.x;
    if (p.type === 'fire') {
      // JOE's fireball: glowing core, outer flare and spinning flame arcs
      const R = 36 + Math.sin(p.t * .5) * 5;
      ctx.globalAlpha = .8; ctx.drawImage(L.flare, x - R * 3, p.y - R * 3, R * 6, R * 6); ctx.globalAlpha = 1;
      const gr = ctx.createRadialGradient(x, p.y, 0, x, p.y, R * 1.6);
      gr.addColorStop(0, 'rgba(255,255,225,1)'); gr.addColorStop(.2, 'rgba(255,210,70,.95)');
      gr.addColorStop(.5, 'rgba(255,60,15,.8)'); gr.addColorStop(1, 'rgba(150,0,0,0)');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, p.y, R * 1.6, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(255,120,30,.8)'; ctx.lineWidth = 4;
      for (let i = 0; i < 3; i++) { const ang = p.t * .4 + i * 2.1; ctx.beginPath(); ctx.arc(x, p.y, R * .9, ang, ang + 1.1); ctx.stroke(); }
    } else if (p.type === 'whip') {
      // ROKAIA's ponytail lash: a tapering dark-brown strand from her head to the tip, rippling, with a crack of light
      const dir = Math.sign(p.vx) || 1, k = p.t / WHIP_LASH.life;
      const x0 = (p.x0 != null ? p.x0 : p.owner.x + dir * 40) - cam.x, len = x - x0; // an online guest has no x0: from her head
      ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.lineCap = 'round';
      for (let s = 0; s < 3; s++) {
        ctx.strokeStyle = s === 0 ? 'rgba(20,10,6,.95)' : s === 1 ? 'rgba(70,40,26,.85)' : 'rgba(150,100,70,.5)';
        ctx.lineWidth = [16, 9, 3][s] * (1 - k * .4);
        ctx.beginPath(); ctx.moveTo(x0, p.y - 6);
        for (let i = 1; i <= 12; i++) { const u = i / 12; ctx.lineTo(x0 + len * u, p.y - 6 + Math.sin(u * 7 - p.t * .9) * 10 * u * (1 - u * .5) + s); }
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(211,38,58,.9)'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x0, p.y - 14); ctx.lineTo(x0 + dir * 50, p.y - 26 + Math.sin(p.t) * 6); ctx.stroke(); // ribbon
      ctx.restore();
      const gl = ctx.createRadialGradient(x, p.y, 0, x, p.y, 44); gl.addColorStop(0, 'rgba(255,250,230,.95)'); gl.addColorStop(.4, 'rgba(255,90,100,.5)'); gl.addColorStop(1, 'rgba(255,60,80,0)');
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(x, p.y, 44, 0, 7); ctx.fill();
    } else if (p.type === 'shuriken') {
      // LULU's boomerang shuriken: glowing wave ring around a spinning four-bladed blue star
      const R = 38, spin = p.t * .55 * (p.vx < 0 ? -1 : 1);
      const gl = ctx.createRadialGradient(x, p.y, 0, x, p.y, R * 2.3);
      gl.addColorStop(0, 'rgba(200,235,255,.85)'); gl.addColorStop(.35, 'rgba(70,150,255,.5)'); gl.addColorStop(1, 'rgba(20,60,200,0)');
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(x, p.y, R * 2.3, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(160,215,255,.75)'; ctx.lineWidth = 4;
      for (let i = 0; i < 3; i++) { const a0 = spin * 1.4 + i * 2.1; ctx.beginPath(); ctx.arc(x, p.y, R * 1.4, a0, a0 + 1.2); ctx.stroke(); }
      ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.translate(x, p.y); ctx.scale(1, .82); ctx.rotate(spin);
      const bg = ctx.createRadialGradient(0, 0, R * .1, 0, 0, R);
      bg.addColorStop(0, '#e8f6ff'); bg.addColorStop(.45, '#4a9aff'); bg.addColorStop(1, '#0f3aa8');
      ctx.fillStyle = bg; ctx.strokeStyle = '#0a1f5c'; ctx.lineWidth = 2.5; ctx.beginPath();
      for (let i = 0; i < 4; i++) { // curved blades
        const a = i * Math.PI / 2;
        ctx.lineTo(Math.cos(a - .5) * R * .34, Math.sin(a - .5) * R * .34);
        ctx.quadraticCurveTo(Math.cos(a - .15) * R * .8, Math.sin(a - .15) * R * .8, Math.cos(a) * R, Math.sin(a) * R);
        ctx.quadraticCurveTo(Math.cos(a + .45) * R * .55, Math.sin(a + .45) * R * .55, Math.cos(a + 1.07) * R * .34, Math.sin(a + 1.07) * R * .34);
      }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#0a1f5c'; ctx.beginPath(); ctx.arc(0, 0, R * .16, 0, 7); ctx.fill();   // centre hole
      ctx.strokeStyle = '#cfeaff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, R * .26, 0, 7); ctx.stroke();
      ctx.restore();
    } else if (p.type === 'flower' && p.owner.spr && p.owner.spr.heart) {
      // ROMANA's heart blast: the heart cut out of her launch frame 3, flying (and gently pulsing) at Moe
      const Hh = p.owner.spr.heart, dir = Math.sign(p.vx) || 1, s = 1 + .06 * Math.sin(p.t * .5);
      ctx.save(); ctx.globalAlpha = .55; ctx.drawImage(L.flare, x - 120, p.y - 120, 240, 240); ctx.restore(); // warm glow
      ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.imageSmoothingEnabled = false;
      ctx.translate(Math.round(x), Math.round(p.y)); ctx.scale(dir * s, s);
      ctx.drawImage(Hh.c, Math.round(-Hh.w * .55), Math.round(-Hh.h / 2));
      ctx.restore();
    } else if (p.type === 'flower') {
      // spinning thrown flower: whirl streaks + the flower tumbling around its middle
      const dir = Math.sign(p.vx) || 1, spin = p.t * .45 * dir;
      ctx.strokeStyle = 'rgba(255,90,110,.35)'; ctx.lineWidth = 3;
      for (let i = 0; i < 2; i++) { const a0 = spin + i * Math.PI; ctx.beginPath(); ctx.arc(x, p.y, 58, a0 - 1.2 * dir, a0, dir < 0); ctx.stroke(); }
      ctx.save(); ctx.globalCompositeOperation = 'source-over';
      ctx.translate(x, p.y); ctx.rotate(spin); ctx.scale(1.25, 1.25); ctx.translate(-48, 0);
      drawFlower(ctx);
      ctx.restore();
    } else if (p.owner.spr && p.owner.spr.projectile) {
      // MOE's energy blast (moe_projectile_energy.png): same speed and hitbox as the bullet, glowing art instead
      const E = p.owner.spr.projectile, F = E.frames[0], dir = Math.sign(p.vx) || 1;
      ctx.save(); ctx.translate(x, p.y); ctx.scale(dir, 1); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(E.strip, F.sX, F.sY, F.w, F.h, Math.round(-F.w * .85), Math.round(-F.h / 2), F.w, F.h); // ball at the hit point
      ctx.restore();
    } else {
      // high-speed bullet: long tracer streak + brass slug
      const tail = p.vx * 4, dir = Math.sign(p.vx) || 1;
      const gr = ctx.createLinearGradient(x - tail, 0, x, 0);
      gr.addColorStop(0, 'rgba(255,200,80,0)'); gr.addColorStop(1, 'rgba(255,250,220,1)');
      ctx.strokeStyle = gr; ctx.lineWidth = 6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x - tail, p.y); ctx.lineTo(x, p.y); ctx.stroke();
      ctx.drawImage(L.ember, x - 16, p.y - 16, 32, 32);
      ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.translate(x, p.y); ctx.scale(dir, 1);
      const bg = ctx.createLinearGradient(0, -6, 0, 6);
      bg.addColorStop(0, '#fff2c0'); bg.addColorStop(.45, '#d8a040'); bg.addColorStop(1, '#6a4410');
      ctx.fillStyle = bg; ctx.beginPath(); ctx.moveTo(-18, -5.5); ctx.lineTo(4, -5.5); ctx.quadraticCurveTo(16, -4, 20, 0); ctx.quadraticCurveTo(16, 4, 4, 5.5); ctx.lineTo(-18, 5.5); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(40,20,0,.8)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();
}

function drawParticles() {
  ctx.save();
  for (const p of particles) {
    const k = p.life / p.max, x = p.x - cam.x;
    if (p.dust) { ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = k * .45; ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(x, p.y, p.size * (1.8 - k), 0, 7); ctx.fill(); continue; }
    if (p.rock) { // tumbling rock chunk with a molten edge
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = Math.min(1, k * 2);
      ctx.save(); ctx.translate(x, p.y); ctx.rotate(p.spin * (p.max - p.life));
      ctx.fillStyle = p.color; ctx.strokeStyle = 'rgba(255,120,40,.85)'; ctx.lineWidth = 1.5;
      const s = p.size; ctx.beginPath(); ctx.moveTo(-s, -s * .6); ctx.lineTo(s * .7, -s); ctx.lineTo(s, s * .5); ctx.lineTo(-s * .4, s); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore(); continue;
    }
    if (p.star) { // impact starburst: 12 spikes growing outward, white-hot core
      const t = 1 - k, R = p.size * (.45 + .75 * Math.min(1, t * 2.2)), r = R * .38;
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = Math.min(1, k * 1.8);
      ctx.save(); ctx.translate(x, p.y); ctx.rotate(p.rot + t * .4);
      ctx.fillStyle = p.color; ctx.beginPath();
      for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2, rr = i % 2 ? r : R * (i % 4 ? .8 : 1); ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(0, 0, r * (1.1 - t * .6), 0, 7); ctx.fill();
      ctx.restore(); continue;
    }
    if (p.petal) { // fluttering flower petal
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = Math.min(1, k * 1.6);
      ctx.save(); ctx.translate(x, p.y); ctx.rotate(p.spin * (p.max - p.life));
      ctx.fillStyle = p.color; ctx.beginPath(); ctx.ellipse(0, 0, p.size, p.size * .55, 0, 0, 7); ctx.fill();
      ctx.restore(); continue;
    }
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = Math.min(1, k * 1.4); ctx.fillStyle = p.color;
    if (p.spark) {
      ctx.strokeStyle = p.color; ctx.lineWidth = p.size * .7;
      ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x - p.vx * 2, p.y - p.vy * 2); ctx.stroke();
    } else { ctx.beginPath(); ctx.arc(x, p.y, p.size * k, 0, 7); ctx.fill(); }
  }
  ctx.restore();
}

function drawPopups() {
  for (const p of popups) {
    const k = p.t / p.life, s = p.t < 8 ? 1.4 - p.t * .05 : 1;
    ctx.save(); ctx.globalAlpha = k > .7 ? (1 - k) / .3 : 1;
    ctx.translate(p.x - cam.x, p.y); ctx.scale(s, s);
    ctx.font = `${p.size}px Impact, "Arial Black", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = p.size * .14; ctx.strokeStyle = '#1a0000'; ctx.lineJoin = 'round'; ctx.strokeText(p.text, 0, 0);
    ctx.fillStyle = p.color; ctx.fillText(p.text, 0, 0);
    ctx.restore();
  }
}

function drawOverhead(f) {
  const x = f.x - cam.x;
  const top = f.knock === 'none' ? f.y + (f.topY !== undefined ? f.topY - 30 : f.R.chin[1] - 108) : GROUND - 150;
  const w = 160, h = 15, bx = x - w / 2;
  ctx.save();
  ctx.font = '20px Impact, "Arial Black", sans-serif'; ctx.textBaseline = 'bottom';
  ctx.lineWidth = 4; ctx.strokeStyle = '#000'; ctx.lineJoin = 'round';
  ctx.textAlign = 'left'; ctx.strokeText(f.name, bx, top - 3); ctx.fillStyle = f.color; ctx.fillText(f.name, bx, top - 3);
  ctx.textAlign = 'right'; const hpTxt = `${f.hp}/${MAX_HP}`; ctx.strokeText(hpTxt, bx + w, top - 3); ctx.fillStyle = '#fff'; ctx.fillText(hpTxt, bx + w, top - 3);
  ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(bx - 3, top - 3, w + 6, h + 6);
  ctx.fillStyle = '#3a0000'; ctx.fillRect(bx, top, w, h);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(bx, top, w * f.hpShown / MAX_HP, h);
  const r = f.hp / MAX_HP, gr = ctx.createLinearGradient(0, top, 0, top + h);
  const c = r > .5 ? ['#9dff7a', '#2fbf3a'] : r > .25 ? ['#ffe27a', '#e09a10'] : ['#ff8a7a', '#d0180c'];
  gr.addColorStop(0, c[0]); gr.addColorStop(1, c[1]);
  ctx.fillStyle = gr; ctx.fillRect(bx, top, w * r, h);
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  for (let i = 5; i < MAX_HP; i += 5) ctx.fillRect(bx + w * i / MAX_HP - 1, top, 2, h);
  ctx.strokeStyle = '#ffcf5a'; ctx.lineWidth = 1.5; ctx.strokeRect(bx - 1, top - 1, w + 2, h + 2);
  ctx.restore();
}

/* ---------- HUD & announcer ---------- */
function drawHUD() {
  const vsb = vsBannerInMatch(), dy = vsb ? 78 : 0; // the VS banner shows the names: win pips, specials and round sit below it
  let gr = ctx.createLinearGradient(0, 0, 0, 110 + dy);
  gr.addColorStop(0, STAGE.bg ? 'rgba(0,0,0,.5)' : 'rgba(0,0,0,.8)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); // lighter over the painted sky
  ctx.fillStyle = gr; ctx.fillRect(0, 0, W, 110 + dy);
  fighters.forEach((f, i) => {
    const left = i === 0, x = left ? 150 : W - 36; // left side leaves room for the Exit button
    ctx.save(); ctx.textAlign = left ? 'left' : 'right'; ctx.textBaseline = 'middle';
    ctx.font = '42px Impact, "Arial Black", sans-serif'; ctx.lineWidth = 5; ctx.strokeStyle = '#000'; ctx.lineJoin = 'round';
    if (!vsb) { ctx.strokeText(f.name, x, 38); ctx.fillStyle = f.color; ctx.fillText(f.name, x, 38); }
    ctx.translate(0, dy);
    for (let k = 0; k < 2; k++) {
      const mx = left ? x + 12 + k * 32 : x - 12 - k * 32, won = f.wins > k;
      ctx.beginPath(); ctx.arc(mx, 80, 11, 0, 7);
      if (won) { const g2 = ctx.createRadialGradient(mx - 3, 77, 1, mx, 80, 11); g2.addColorStop(0, '#fff6c0'); g2.addColorStop(1, '#d48a00'); ctx.fillStyle = g2; ctx.shadowColor = '#ffb000'; ctx.shadowBlur = 12; }
      else ctx.fillStyle = 'rgba(40,10,0,.85)';
      ctx.fill(); ctx.shadowBlur = 0; ctx.strokeStyle = '#ffcf5a'; ctx.lineWidth = 2; ctx.stroke();
    }
    const label = f.char.hud + ' ' + (f.specialUsed ? '— USED' : 'READY [' + f.specialKey + ']');
    ctx.font = '18px Impact, "Arial Black", sans-serif';
    const tw = ctx.measureText(label).width + 22, px = left ? x + 84 : x - 84 - tw;
    ctx.fillStyle = f.specialUsed ? 'rgba(60,60,60,.8)' : (G.frame % 40 < 20 ? 'rgba(200,50,0,.9)' : 'rgba(150,30,0,.9)');
    ctx.fillRect(px, 68, tw, 24);
    ctx.strokeStyle = f.specialUsed ? '#777' : '#ffcf5a'; ctx.lineWidth = 1.5; ctx.strokeRect(px, 68, tw, 24);
    ctx.textAlign = 'left'; ctx.fillStyle = f.specialUsed ? '#aaa' : '#fff'; ctx.fillText(label, px + 11, 81);
    ctx.restore();
  });
  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.translate(0, dy);
  ctx.font = '30px Impact, "Arial Black", sans-serif'; ctx.lineWidth = 5; ctx.strokeStyle = '#000';
  ctx.strokeText(`ROUND ${G.round}`, W / 2, 34); ctx.fillStyle = '#ffd23a'; ctx.fillText(`ROUND ${G.round}`, W / 2, 34);
  ctx.font = '15px "Segoe UI", Arial, sans-serif'; ctx.fillStyle = '#ffb070'; ctx.fillText('BEST 2 OUT OF 3', W / 2, 62);
  ctx.restore();
}

function banner(text, y, size, alpha = 1, scale = 1, red = false, x = W / 2) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.scale(scale, scale);
  ctx.font = `${size}px Impact, "Arial Black", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round'; ctx.lineWidth = size * .12; ctx.strokeStyle = '#1a0000';
  ctx.shadowColor = red ? 'rgba(255,0,0,.9)' : 'rgba(255,90,0,.9)'; ctx.shadowBlur = size * .35;
  ctx.strokeText(text, 0, 0); ctx.shadowBlur = 0;
  const gr = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
  if (red) { gr.addColorStop(0, '#fff0e0'); gr.addColorStop(.5, '#ff4a1a'); gr.addColorStop(1, '#900000'); }
  else { gr.addColorStop(0, '#fffbe0'); gr.addColorStop(.5, '#ffd23a'); gr.addColorStop(1, '#d46a00'); }
  ctx.fillStyle = gr; ctx.fillText(text, 0, 0);
  ctx.restore();
}

function drawBanners() {
  if (G.phase === 'victory') {
    const vt = G.vt, lb = 72 * smooth(0, .7, vt), w = fighters[G.winnerIdx];
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, lb); ctx.fillRect(0, H - lb, W, lb);
    if (vt >= .45) {
      const k = smooth(.45, .68, vt), beat = 1 + .06 * smooth(SLAM_T, SLAM_T + .05, vt) * (1 - smooth(SLAM_T + .05, SLAM_T + .4, vt));
      // anchored above the winner's head (follows them even when the camera is clamped at a stage edge)
      const VZ = victoryZoom(), sx = VZ ? VZ[0] + VZ[2] * (w.x - cam.x) : w.x - cam.x;
      const cel = smooth(w.char.victoryFrom - .4, w.char.victoryFrom + .6, vt); // fades as the celebration close-up begins
      if (cel < 1) banner('WINNER!', 122, 118, k * (1 - cel), (1 + 1.8 * (1 - k)) * beat, false, clamp(sx, 270, W - 270));
    }
    if (vt >= 1.0) banner(`${w.name} WINS THE MATCH!`, H - 36, 38, smooth(1.0, 1.4, vt), 1, true); // in the letterbox, like a subtitle
    return;
  }
  if (G.phase === 'countdown') {
    const n = COUNTDOWN - Math.floor(G.timer / 60), k = (G.timer % 60) / 60;
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(0, 0, W, H);
    banner(`ROUND ${G.round}`, 210, 64, 1, 1);
    banner(String(n), 360, 200, 1 - k * .6, 1.5 - Math.min(k * 3, 1) * .5, true);
    banner('GET READY', 500, 34, .85);
  }
  if (G.fightBanner > 0) {
    const k = 1 - G.fightBanner / 70;
    banner('FIGHT!', 330, 170, G.fightBanner < 15 ? G.fightBanner / 15 : 1, 1.6 - Math.min(k * 5, 1) * .6, true);
  }
  if (G.phase === 'roundEnd') {
    if (G.timer < 90) banner('K.O.!', 300, 190, G.timer > 70 ? (90 - G.timer) / 20 : 1, 1.5 - Math.min(G.timer / 12, 1) * .5, true);
    if (G.timer >= 70) {
      const w = fighters[G.winnerIdx], k = Math.min(1, (G.timer - 70) / 12);
      banner(`${w.name} WINS ROUND!`, 320, 96, k, 1.3 - k * .3);
      if (w.wins >= 2) banner('MATCH POINT REACHED', 420, 30, k * .9);
      else banner(`ROUNDS  ${fighters[0].wins} — ${fighters[1].wins}`, 420, 34, k * .9);
    }
  }
}

/* =====================================================================
   BOOT
   ===================================================================== */
let last = performance.now(), acc = 0;
const STEP = 1000 / 60;
function loop(now) {
  acc += Math.min(100, now - last); last = now;
  let stepped = false;
  while (acc >= STEP) {
    if (NET.role === 'guest') guestUpdate();
    else if (netHold()) { G.frame++; updateAmbient(); }   // online host: pause the fight while Player 2 lags / reconnects
    else update();
    acc -= STEP; stepped = true;
  }
  if (stepped && NET.role === 'host' && ++NET.snapN % SNAP_EVERY === 0) sendSnapshot();
  if ((G.phase === 'victory' || G.phase === 'gameover') && winnerDances()) rkUpdate(Math.min(100, now - (loop.prev || now))); // Rokaia's dance clock
  loop.prev = now;
  audioDirector();                                           // combat music level, final-K.O. cut
  render();
  if (G.phase === 'gameover' && G.winnerIdx >= 0) drawMontage();
  updateOverlays();
  requestAnimationFrame(loop);
}

function fit() { const w = $('wrap').clientWidth; $('wrap').style.setProperty('--u', (w / 100) + 'px'); }
addEventListener('resize', fit); fit();

/* =====================================================================
   ONLINE MULTIPLAYER (PeerJS / WebRTC data channel)
   Host = Player 1 (MOE, left) runs the whole simulation and streams snapshots.
   Guest = Player 2 (ROMANA, right) only sends its inputs and renders the snapshots.
   ===================================================================== */
const NET = {
  role: 'local', me: 0, peer: null, conn: null, ev: [], lastRx: 0,
  snapN: 0,            // host: frame counter for the snapshot cadence
  hostId: null,        // guest: the room to (re)connect to
  reconnectUntil: 0,   // >0 while waiting for the other player to come back (ms timestamp)
  hostHidden: false    // guest: Player 1's tab is in the background (their game is paused)
};
const JOIN_ID = new URLSearchParams(location.search).get('join');
// network tuning
const SNAP_EVERY = 2;        // host sends state every 2nd frame = 30 updates/s (the guest smooths in between)
const SNAP_BACKLOG = 64000;  // skip a snapshot if this many bytes are still queued (only the newest state matters)
const PING_MS = 250;         // keep-alive both ways
const STALL_MS = 1200;       // no data for this long = lagging: host pauses the fight, both show a banner
const LOST_MS = 6000;        // no data for this long = connection treated as dropped
const RECONNECT_MS = 180000; // 3 minutes: how long a dropped player has to reconnect before the match ends
const IN_MATCH = () => ['intro', 'countdown', 'fight', 'roundEnd', 'victory'].includes(G.phase);
const netStalled = () => !!NET.conn && performance.now() - NET.lastRx > STALL_MS;
// host: freeze the simulation while Player 2 is lagging or reconnecting (so they can't be beaten while frozen)
const netHold = () => NET.role === 'host' && IN_MATCH() && (!!NET.reconnectUntil || netStalled());

function netSend(m) { if (NET.conn && NET.conn.open) NET.conn.send(m); }
function netStatus(t) { $('netStatus').textContent = t; }
function showNetPanel(show) { $('netPanel').classList.toggle('hidden', !show); $('menuBtns').classList.toggle('hidden', show); }
function netTeardown() {
  try { NET.conn && NET.conn.close(); } catch (e) {}
  try { NET.peer && NET.peer.destroy(); } catch (e) {}
  NET.conn = NET.peer = null; NET.role = 'local'; NET.me = 0; NET.ev = []; NET.token = null;
  NET.hostId = null; NET.reconnectUntil = 0; NET.joinUntil = 0; NET.hostHidden = false; clearTimeout(NET.retryTimer);
  held[1] = {}; // drop any remote-held keys
}

/* ---------------------------------------------------------------------
   TURN RELAY SETUP  (required for players on 4G/5G mobile data / CGNAT)
   STUN only discovers public addresses; behind carrier-grade NAT a direct path usually can't be
   opened, so traffic must be relayed by a TURN server. There is no working credential-free public
   TURN anymore (PeerJS's relay hosts no longer exist in DNS and OpenRelay was shut down), so plug in
   your own — both options below have free tiers:

   Configured with the Metered app "moevsjoe" and its TURN credential "moevsjoe-game".
   METERED.apiKey is that credential's public API key: it can only fetch relay logins, it cannot
   manage the account. NEVER put the account's Secret Key (wb_…) in this file — page source is public.
   If the credential is ever deleted/rotated in the Metered dashboard, update both values below.
   --------------------------------------------------------------------- */
// Preferred: fetch fresh relay logins from Metered when hosting/joining
const METERED = { domain: 'moevsjoe.metered.live', apiKey: 'dfab41d255ea01b686fe2f07d84ff63311ff' };
// Fallback (used only if that request fails): the same credential, every transport.
// UDP 80 / TCP 80 / UDP 443 / TLS 443 — cellular networks and strict firewalls often only allow TCP or TLS on 443.
const TURN_SERVERS = [
  {
    urls: [
      'turn:global.relay.metered.ca:80',
      'turn:global.relay.metered.ca:80?transport=tcp',
      'turn:global.relay.metered.ca:443',
      'turns:global.relay.metered.ca:443?transport=tcp'
    ],
    username: '749ce3a8ace632023cc7d756',
    credential: 'ee6dNDXQ+qc3S7vP'
  }
];
const GOOGLE_STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' }
];
let iceCache = null;
async function getIceServers() {
  if (iceCache) return iceCache;
  let turn = [];
  if (METERED.domain && METERED.apiKey) {
    const ctl = window.AbortController ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), 4000); // never hold up hosting/joining on a slow network
    try {
      const r = await fetch(`https://${METERED.domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED.apiKey)}`, ctl ? { signal: ctl.signal } : {});
      if (r.ok) { const list = await r.json(); if (Array.isArray(list)) turn = list.filter(s => [].concat(s.urls).some(u => /^turns?:/.test(u))); }
      else console.warn('Metered TURN credentials request failed:', r.status);
    } catch (e) { console.warn('Metered TURN credentials request failed:', e); }
    clearTimeout(timer);
  }
  if (!turn.length) turn = TURN_SERVERS.filter(s => s && s.urls && s.username && !/^YOUR_/.test(s.username));
  return (iceCache = { stun: GOOGLE_STUN, turn });
}
// relayOnly forces every packet through TURN — used as the automatic fallback when a direct path times out
function peerOptions(ice, relayOnly = false) {
  return { debug: 1, config: { iceServers: [...ice.stun, ...ice.turn], iceTransportPolicy: relayOnly ? 'relay' : 'all', sdpSemantics: 'unified-plan' } };
}
const NO_TURN_NOTE = ' (No TURN relay is configured, so players on mobile data may not be able to connect — see TURN RELAY SETUP in index.html.)';

// Share link = the exact page the host is on (Netlify domain, LAN IP, …) + ?join=<peer id>
function shareLink(id) {
  let base = window.location.origin + window.location.pathname;
  if (!window.location.origin || window.location.origin === 'null') base = window.location.href.split(/[?#]/)[0]; // file://
  return base + '?join=' + encodeURIComponent(id);
}
function linkWarning() {
  const h = window.location.hostname;
  if (window.location.protocol === 'file:')
    return 'Note: this is a local file, so Player 2 can’t open the link. Upload the game (e.g. Netlify) and host from there.';
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1')
    return 'Note: this link uses “localhost”, which only works on this computer. Open the game from your Netlify site or your PC’s network IP (e.g. http://192.168.x.x:port) and host again.';
  return '';
}

async function hostOnline(attempt = 0) {
  if (!window.Peer) { showNetPanel(true); netStatus('Online play needs an internet connection (PeerJS could not load).'); return; }
  showNetPanel(true); $('linkRow').classList.add('hidden'); netStatus('Creating room…');
  const token = NET.token = Symbol('host');
  const ice = await getIceServers();
  if (NET.token !== token) return; // cancelled while fetching credentials
  const id = 'moevsjoe-' + Math.random().toString(36).slice(2, 8);
  const peer = NET.peer = new Peer(id, peerOptions(ice));
  peer.on('open', pid => {
    if (NET.peer !== peer) return;
    $('netLink').value = shareLink(pid); $('linkRow').classList.remove('hidden');
    const warn = linkWarning();
    netStatus('Waiting for opponent… Send this link to Player 2.' + (warn ? ' ' + warn : '') + (ice.turn.length ? '' : NO_TURN_NOTE));
  });
  peer.on('connection', conn => {
    if (NET.peer !== peer) return;
    if (NET.conn && NET.conn.open && !netStalled()) { // room is full: tell the newcomer instead of silently dropping them
      conn.on('open', () => { try { conn.send({ t: 'full' }); } catch (e) {} setTimeout(() => conn.close(), 400); });
      return;
    }
    // replace a stalled / dropped connection (relay retry, or Player 2 reconnecting mid-match)
    if (NET.conn) { const old = NET.conn; NET.conn = null; try { old.close(); } catch (e) {} }
    NET.conn = conn;
    if (NET.role !== 'host') netStatus('Opponent found — connecting…');
    setTimeout(() => {
      if (NET.conn === conn && !conn.open && NET.role !== 'host') netStatus('Opponent found, but their network is blocking the connection. Trying the relay…' + (ice.turn.length ? '' : NO_TURN_NOTE));
    }, 10000);
    const begin = () => {
      if (NET.role === 'host') { // Player 2 is back: resume the paused match from the current state
        NET.reconnectUntil = 0; NET.lastRx = performance.now(); held[1] = {};
        conn.send({ t: 'resume' }); sendSnapshot(true);
        return;
      }
      NET.role = 'host'; NET.me = 0; held[1] = {}; NET.lastRx = performance.now();
      netStatus('Opponent joined! Starting match…');
      // start straight away; the guest leaves its waiting screen on the first snapshot
      setTimeout(() => { if (NET.conn !== conn) return; initAudio(); showNetPanel(false); openSelect('online'); }, 400); // pick fighters first
    };
    conn.on('open', begin);
    if (conn.open) begin();
    conn.on('data', m => { if (NET.conn === conn) onNetData(m); }); // ignore late packets after Exit
    conn.on('close', () => { if (NET.conn === conn) hostLostGuest(); });
  });
  // keep the room alive if the signalling server drops us while waiting
  peer.on('disconnected', () => { if (NET.peer === peer && !peer.destroyed) try { peer.reconnect(); } catch (e) {} });
  peer.on('error', e => {
    if (NET.peer !== peer) return;
    if (e.type === 'unavailable-id' && attempt < 3) { try { peer.destroy(); } catch (x) {} hostOnline(attempt + 1); return; }
    netStatus('Connection error: ' + (e.type || e.message));
  });
}

/* Joining: try a direct P2P path first (STUN), then switch to relay-only (every packet through the Metered TURN
   relay — works behind any NAT / firewall / cellular CGNAT). Keep retrying through the relay — including
   "room not found yet" — until the 3-minute join window runs out. */
const DIRECT_TIMEOUT = 9000, RELAY_TIMEOUT = 15000, JOIN_WINDOW_MS = 180000, ROOM_RETRY_MS = 4000;
const secsLeft = until => Math.max(0, Math.ceil((until - performance.now()) / 1000));
async function joinOnline(id, relayOnly = false, attempt = 1, note = '') {
  if (attempt > 1 && !NET.joinUntil) return;                   // cancelled while a retry was scheduled
  showNetPanel(true); $('linkRow').classList.add('hidden');
  if (!window.Peer) { netStatus('Online play needs an internet connection (PeerJS could not load).'); return; }
  if (attempt === 1) NET.joinUntil = performance.now() + JOIN_WINDOW_MS;
  const until = NET.joinUntil;
  netStatus(note ? note.replace(/\(\d+s left\)/, `(${secsLeft(until)}s left)`)
    : !relayOnly ? 'Connecting to Player 1…'
    : attempt <= 2 ? 'Direct connection blocked by the network — connecting through the relay server…'
    : `Still trying to reach Player 1 through the relay… (attempt ${attempt}, ${secsLeft(until)}s left)`);
  const token = NET.token = Symbol('join');
  const ice = await getIceServers();
  if (NET.token !== token) return;
  const peer = NET.peer = new Peer(peerOptions(ice, relayOnly));
  NET.hostId = id;
  // start over (always through the relay from now on) unless the join window has run out
  const retry = (why) => {
    if (NET.peer !== peer || !NET.joinUntil || NET.role === 'guest') return;
    if (performance.now() > until) {
      netStatus('Couldn’t connect to Player 1 within 3 minutes. Check that Player 1 still has the game open, then try the link again.');
      return;
    }
    const c = NET.conn; NET.conn = NET.peer = null;
    try { c && c.close(); } catch (e) {} try { peer.destroy(); } catch (e) {}
    if (why) netStatus(why);
    setTimeout(() => joinOnline(id, true, attempt + 1, why || ''), why ? ROOM_RETRY_MS : 0);
  };
  // keep the signalling link alive so a dropped match can be reconnected
  peer.on('disconnected', () => { if (NET.peer === peer && !peer.destroyed) try { peer.reconnect(); } catch (e) {} });
  peer.on('open', () => {
    if (NET.peer !== peer) return;
    const conn = guestConnect(peer, () => { NET.joinUntil = 0; netStatus('Connected' + (relayOnly ? ' via relay' : '') + '! You are Player 2 (right).'); openSelect('online'); });
    setTimeout(() => { if (NET.conn === conn && !conn.open) retry(); }, relayOnly ? RELAY_TIMEOUT : DIRECT_TIMEOUT);
  });
  peer.on('error', e => {
    if (NET.peer !== peer) return;
    if (NET.reconnectUntil) return; // during a reconnect, the retry loop handles failures
    if (e.type === 'peer-unavailable') retry(`Player 1’s room isn’t available yet — retrying… (${secsLeft(until)}s left)`);
    else if (['network', 'server-error', 'socket-error', 'socket-closed', 'webrtc'].includes(e.type)) retry(`Network problem (${e.type}) — retrying… (${secsLeft(until)}s left)`);
    else netStatus('Connection error: ' + (e.type || e.message));
  });
}
// guest: open a data connection to the host room (first join and every reconnect attempt)
function guestConnect(peer, onFirstOpen) {
  const conn = NET.conn = peer.connect(NET.hostId, { serialization: 'json', reliable: true });
  conn.on('open', () => {
    if (NET.conn !== conn) return;
    const resumed = NET.role === 'guest' && NET.reconnectUntil;
    NET.role = 'guest'; NET.me = 1; NET.lastRx = performance.now(); NET.reconnectUntil = 0; clearTimeout(NET.retryTimer);
    if (resumed) { // re-send any keys still held so ROMANA doesn't lose a held block / walk
      for (const act in held[1]) if (held[1][act] && held[1][act].size) netSend({ t: 'k', a: act, d: 1 });
    } else if (onFirstOpen) onFirstOpen();
  });
  conn.on('data', m => { if (NET.conn === conn) onNetData(m); }); // ignore late packets after Exit
  conn.on('close', () => { if (NET.conn === conn) guestLostHost(); });
  return conn;
}

function onNetClose(msg) {
  if (NET.role === 'local' && !NET.peer) return;
  exitToMenu(false);
  showNetPanel(true); $('linkRow').classList.add('hidden'); netStatus(msg);
}

// Exit: stop the fight, drop any online connection, wipe HP / round scores / specials, back to the Start Screen
function exitToMenu(notifyPeer = true) {
  if (NET.role !== 'local' || NET.peer) {
    if (notifyPeer) netSend({ t: 'bye' });
    // give the 'bye' a moment to leave before the channel closes
    const conn = NET.conn, peer = NET.peer;
    NET.conn = NET.peer = null;
    setTimeout(() => { try { conn && conn.close(); } catch (e) {} try { peer && peer.destroy(); } catch (e) {} }, 150);
    netTeardown();
    history.replaceState(null, '', location.pathname);
  }
  releaseAllLocal(); clearBuffers(); stopVictoryMusic();
  document.querySelectorAll('#touch .tb.on').forEach(b => { b.classList.remove('on'); delete b.dataset.p; });
  G.phase = 'menu'; G.timer = 0; G.round = 1; G.hitStop = 0; G.fightBanner = 0; G.flash = 0; G.shake = 0; G.winnerIdx = -1;
  fighters.forEach(f => { f.wins = 0; f.specialUsed = false; });
  if (fighters.length) { fighters[0].reset(STAGE_W / 2 - 280); fighters[1].reset(STAGE_W / 2 + 280); }
  projectiles = []; particles = []; popups = [];
  cam.x = (STAGE_W - W) / 2;
  closeSelect();
  $('over').classList.add('hidden'); $('start').classList.remove('hidden'); showNetPanel(false);
  updateOverlays();
}

/* ---------- keep-alive, lag and reconnect ----------
   Both sides ping every 250ms. Silence > 1.2s = "lagging": the host pauses the fight and both show a banner.
   Silence > 6s or a closed channel = dropped: the match stays paused and the guest keeps reconnecting to the
   same room for up to 3 minutes (the host keeps the room open). Only after that do both return to the menu.
   An explicit Exit sends 'bye' and ends the match immediately. */
setInterval(() => {
  if (NET.role === 'local') return;
  const now = performance.now();
  if (NET.reconnectUntil) {
    if (now > NET.reconnectUntil) onNetClose(NET.role === 'host' ? 'Player 2 disconnected and did not come back.' : 'Lost connection to Player 1.');
    return;
  }
  if (!NET.conn) return;
  netSend({ t: 'ping' });
  if (now - NET.lastRx > STALL_MS && NET.role === 'host') held[1] = {};   // drop P2's stale held keys while lagging
  if (now - NET.lastRx > LOST_MS) NET.role === 'host' ? hostLostGuest() : guestLostHost();
}, PING_MS);
// host: Player 2 dropped — keep the room open and wait for them
function hostLostGuest() {
  if (!IN_MATCH() && G.phase !== 'gameover') { onNetClose('Player 2 disconnected.'); return; }
  const c = NET.conn; NET.conn = null; held[1] = {};
  try { c && c.close(); } catch (e) {}
  NET.reconnectUntil = performance.now() + RECONNECT_MS;
}
// guest: lost the host — retry the same room every 2.5s until RECONNECT_MS runs out
function guestLostHost() {
  if (NET.reconnectUntil) return;
  const c = NET.conn; NET.conn = null;
  try { c && c.close(); } catch (e) {}
  NET.reconnectUntil = performance.now() + RECONNECT_MS;
  const retry = () => {
    if (!NET.reconnectUntil || NET.role !== 'guest') return;
    const peer = NET.peer;
    if (!peer || peer.destroyed) { onNetClose('Lost connection to Player 1.'); return; }
    if (peer.disconnected) { try { peer.reconnect(); } catch (e) {} }
    else if (!NET.conn || !NET.conn.open) {
      const old = NET.conn; NET.conn = null; try { old && old.close(); } catch (e) {}
      guestConnect(peer);
    }
    NET.retryTimer = setTimeout(retry, 2500);
  };
  retry();
}
// leaving the page on purpose = Exit (no reconnect wait on the other side)
addEventListener('pagehide', () => { try { netSend({ t: 'bye' }); NET.conn && NET.conn.close(); NET.peer && NET.peer.destroy(); } catch (e) {} });
// host: tell the guest when this tab goes to the background (browsers pause hidden tabs, so the fight freezes)
document.addEventListener('visibilitychange', () => { if (NET.role === 'host') netSend({ t: 'vis', h: document.hidden }); });

function onNetData(m) {
  NET.lastRx = performance.now();
  if (m.t === 'bye') { onNetClose(NET.role === 'host' ? 'Player 2 exited the match.' : 'Player 1 exited the match.'); return; }
  if (m.t === 'full') { onNetClose('That game already has two players. Ask Player 1 for a new link.'); return; }
  if (m.t === 'vis') { NET.hostHidden = !!m.h; return; }
  if (m.t === 'resume') { NET.hostHidden = false; return; }
  // character select: the other player's pick / lock, and (guest) the final line-up from the host
  if (m.t === 'sel') {
    if (m.p !== NET.me && SEL.side[m.p]) { SEL.side[m.p] = { i: m.i | 0, lock: !!m.lock }; if (SEL.open) { renderSelect(); selCheckStart(); } }
    if (m.hello && SEL.open) sendSel(NET.me); // they just opened their select screen: tell them our current pick
    return;
  }
  if (m.t === 'cfg') { if (NET.role === 'guest' && Array.isArray(m.c)) applyCfg(m.c); return; }
  if (NET.role === 'host') {
    if (m.t === 'k') { // guest input -> player 2
      if (m.d) { (held[1][m.a] = new Set(['net'])); pressedAt[1][m.a] = G.frame; }
      else if (held[1][m.a]) held[1][m.a].delete('net');
    } else if (m.t === 'restart' && G.phase === 'gameover') startMatch();
  } else if (m.t === 's') applySnapshot(m);
}

const r1 = v => Math.round(v * 10) / 10;
function sendSnapshot(force = false) {
  if (!NET.conn || !NET.conn.open) return;
  // back-pressure: if the channel is still busy (lag spike), skip this one — events stay queued for the next
  const dc = NET.conn.dataChannel;
  if (!force && dc && dc.bufferedAmount > SNAP_BACKLOG) return;
  netSend({
    t: 's',
    g: [G.phase, G.timer, G.round, G.fightBanner, G.winnerIdx, G.flash, Math.round((G.vt || 0) * 1000) / 1000],
    f: fighters.map(f => [r1(f.x), r1(f.y), r1(f.vx), r1(f.vy), f.facing, +f.onGround, f.hp, f.action ? [f.action.type, f.action.t] : 0,
      f.stun, f.knock, f.knockT, f.airT, +f.ko, +f.blocking, +f.walking, f.flash, +f.win, f.wins, +f.specialUsed, f.vpose || 0, +!!f.crouching, f.hitType || 0]),
    p: projectiles.map(p => [p.type, p.owner.idx, r1(p.x), r1(p.y), p.vx, p.r, p.t]),
    e: NET.ev.splice(0)
  });
}

function applySnapshot(m) {
  const prev = G.phase;
  [G.phase, G.timer, G.round, G.fightBanner, G.winnerIdx, G.flash] = m.g;
  G.vt = m.g[6] || 0; // host's victory clock (its music position) drives the guest's sequence
  m.f.forEach((a, i) => {
    const f = fighters[i];
    // positions are smoothed toward the host's value in guestUpdate(); big jumps (round reset, knockback) snap
    f.netX = a[0]; f.netY = a[1];
    if (f.netSeen !== true || Math.abs(f.x - a[0]) > 160 || Math.abs(f.y - a[1]) > 160) { f.x = a[0]; f.y = a[1]; f.netSeen = true; }
    [f.vx, f.vy, f.facing] = [a[2], a[3], a[4]];
    f.onGround = !!a[5]; f.hp = a[6];
    f.action = a[7] ? { type: a[7][0], t: a[7][1], hit: true } : null;
    [f.stun, f.knock, f.knockT, f.airT] = [a[8], a[9], a[10], a[11]];
    f.ko = !!a[12]; f.blocking = !!a[13]; f.walking = !!a[14]; f.flash = a[15]; f.win = !!a[16]; f.wins = a[17]; f.specialUsed = !!a[18]; f.vpose = a[19] || null; f.crouching = !!a[20]; f.hitType = a[21] || null;
  });
  projectiles = m.p.map(a => ({ type: a[0], owner: fighters[a[1]], x: a[2], y: a[3], vx: a[4], r: a[5], t: a[6] }));
  for (const [n, args] of m.e) {
    if (n === 's') sfx[args[0]](); else if (n === 'b') burst(...args); else if (n === 'd') dust(...args);
    else if (n === 'p') popup(...args); else if (n === 'k') shake(...args); else if (n === 'r') debris(...args);
    else if (n === 'sb') starburst(...args);
  }
  if (G.phase !== 'menu') { $('start').classList.add('hidden'); showNetPanel(false); }
  if (prev !== 'countdown' && G.phase === 'countdown') fighters.forEach(f => { f.trail = []; f.hpShown = f.hp; });
  if (G.phase === 'victory' && prev !== 'victory') playVictoryMusic();
  if (prev === 'gameover' || prev === 'victory') { if (G.phase !== 'gameover' && G.phase !== 'victory') stopVictoryMusic(); }
  if (G.phase === 'gameover' && prev !== 'gameover') showGameOver();
  if (G.phase !== 'gameover' && prev === 'gameover') $('over').classList.add('hidden');
}

function requestRestart() {
  initAudio(); blurAll();
  if (NET.role === 'guest') { netSend({ t: 'restart' }); $('btnRestart').textContent = 'Rematch requested…'; }
  else startMatch();
}

/* =====================================================================
   TOUCH CONTROLS
   ===================================================================== */
let touchSeen = false, touchP = 0;
// touch UI: any touchscreen (phones, tablets, touch laptops) or a small viewport
const IS_TOUCH = () => touchSeen || matchMedia('(pointer: coarse), (any-pointer: coarse)').matches || innerWidth < 900;
addEventListener('touchstart', () => { if (!touchSeen) { touchSeen = true; touchShown = null; } }, { passive: true, capture: true });
function touchPlayer() { return NET.role === 'local' ? touchP : NET.me; }
function refreshTouchLabels() {
  const p = touchPlayer(), f = fighters[p];
  if (!f) return;
  $('tSpecial').innerHTML = `${f.name}<br>SPECIAL`;
  $('tWho').textContent = NET.role === 'local' ? `Touch controls: P${p + 1} ${f.name}  ⇄` : `You are ${f.name} (P${p + 1})`;
}
let touchShown = null, touchKey = '', exitShown = null;
function updateOverlays() {
  const inMatch = ['intro', 'countdown', 'fight', 'roundEnd', 'victory'].includes(G.phase);
  if (inMatch !== exitShown) { exitShown = inMatch; $('btnExit').classList.toggle('hidden', !inMatch); }
  const show = IS_TOUCH() && inMatch && G.phase !== 'victory'; // keep the victory cinematic clear of buttons
  if (show !== touchShown) { touchShown = show; $('touch').classList.toggle('show', show); document.body.classList.toggle('touching', show); }
  // keep labels right for local P1/P2 switching and for online host (MOE) / guest (ROMANA)
  const key = NET.role + touchPlayer();
  if (show && key !== touchKey) { touchKey = key; refreshTouchLabels(); }
  if (!show) touchKey = '';
  syncVsBanner();
}
document.querySelectorAll('#touch [data-act]').forEach(b => {
  const act = b.dataset.act, src = 'touch:' + act;
  const down = e => { e.preventDefault(); if (b.dataset.p) return; b.dataset.p = touchPlayer(); b.classList.add('on'); initAudio(); press(+b.dataset.p, act, src); };
  const up = e => { e.preventDefault(); if (!b.dataset.p) return; b.classList.remove('on'); release(+b.dataset.p, act, src); delete b.dataset.p; };
  b.addEventListener('touchstart', down, { passive: false });
  b.addEventListener('touchend', up, { passive: false });
  b.addEventListener('touchcancel', up, { passive: false });
  b.addEventListener('mousedown', down); b.addEventListener('mouseup', up); b.addEventListener('mouseleave', up);
});
const toggleWho = e => { e.preventDefault(); if (NET.role !== 'local') return; releaseAllLocal(); touchP = 1 - touchP; refreshTouchLabels(); };
$('tWho').addEventListener('touchstart', toggleWho, { passive: false });
$('tWho').addEventListener('mousedown', toggleWho);
// block pinch-zoom / double-tap zoom while playing
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('touchmove', e => { if (G.phase !== 'menu') e.preventDefault(); }, { passive: false });
function goFullscreenOnPhone() {
  if (!IS_TOUCH()) return;
  try { const r = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); r && r.catch(() => {}); } catch (e) {}
  try { screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {}); } catch (e) {}
}

/* =====================================================================
   CHARACTER SELECT (2 players)
   Local: P1 picks on the left (A / D, lock with L / K / F), P2 on the right (← / →, lock with N / M / V) — or tap a
   portrait (tap it again to unlock). Online: the host picks P1 and the guest picks P2; every pick / lock is sent to
   the other side ({t:'sel'}), and when both are locked the host sends the line-up ({t:'cfg'}) and starts the match.
   ===================================================================== */
const SEL = { open: false, mode: 'local', side: [{ i: 0, lock: false }, { i: 2, lock: false }], starting: false };
const selEls = () => [$('selP1'), $('selP2')];
function drawPortrait(cv, id, mirror) { // the character's portrait art (or idle pose), fitted into the canvas, facing the middle
  const spr = SPRITES[id]; if (!spr) return;
  const P = spr.portrait && spr.portrait.F, A = spr.idle, F = A.frames[0], g = cv.getContext('2d');
  const [src, sx, sy, w, h, ax] = P ? [P.c, 0, 0, P.w, P.h, P.w / 2] : [A.strip, F.sX, F.sY, F.w, F.h, F.ax];
  const k = Math.min(cv.width * .92 / w, cv.height * .96 / h);
  g.clearRect(0, 0, cv.width, cv.height); g.save(); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.translate(cv.width / 2, cv.height - 4); if (mirror) g.scale(-1, 1);
  g.drawImage(src, sx, sy, w, h, -ax * k, -h * k, w * k, h * k); g.restore();
}
function buildSelectScreen() {
  selEls().forEach((el, p) => {
    const box = el.querySelector('.sel-cards'); box.innerHTML = '';
    ROSTER_ORDER.forEach((id, i) => {
      const card = document.createElement('div'); card.className = 'sel-card'; card.dataset.i = i; card.dataset.badge = 'P' + (p + 1);
      const cv = document.createElement('canvas'); cv.width = 120; cv.height = 130; drawPortrait(cv, id, p === 1);
      const name = document.createElement('span'); name.textContent = ROSTER[id].name;
      card.append(cv, name); box.append(card);
      const tap = e => { e.preventDefault(); initAudio(); selTap(p, i); };
      card.addEventListener('click', tap); card.addEventListener('touchend', tap, { passive: false });
    });
  });
  $('btnSelBack').onclick = () => { blurAll(); selBack(); };
}
const canControl = p => SEL.mode === 'local' || p === NET.me;
function openSelect(mode) {
  const idx = id => Math.max(0, ROSTER_ORDER.indexOf(id));
  Object.assign(SEL, { open: true, mode, starting: false, side: [{ i: idx(MATCH.chars[0]), lock: false }, { i: idx(MATCH.chars[1]), lock: false }] });
  $('start').classList.add('hidden'); $('over').classList.add('hidden'); showNetPanel(false); $('select').classList.remove('hidden');
  renderSelect();
  if (mode === 'online') sendSel(NET.me, true); // hello: the other side answers with its current pick
}
function closeSelect() { SEL.open = false; $('select').classList.add('hidden'); }
function sendSel(p, hello = false) { if (SEL.mode === 'online') netSend({ t: 'sel', p, i: SEL.side[p].i, lock: SEL.side[p].lock, hello }); }
function selMove(p, d) {
  const s = SEL.side[p]; if (!SEL.open || SEL.starting || !canControl(p) || s.lock) return;
  s.i = (s.i + d + ROSTER_ORDER.length) % ROSTER_ORDER.length; sfx.jump(); renderSelect(); sendSel(p);
}
function selLock(p, v) {
  const s = SEL.side[p]; if (!SEL.open || SEL.starting || !canControl(p) || s.lock === v) return;
  s.lock = v; v ? sfx.block() : sfx.whoosh(); renderSelect(); sendSel(p); selCheckStart();
}
function selTap(p, i) {
  if (!canControl(p) || SEL.starting) return;
  const s = SEL.side[p];
  if (s.i === i && s.lock) { selLock(p, false); return; }
  if (s.lock) s.lock = false;
  s.i = i; renderSelect(); sendSel(p); selLock(p, true);
}
function selBack() {
  if (SEL.mode === 'online') { closeSelect(); exitToMenu(); return; } // leaving the online select ends the session
  closeSelect(); $('start').classList.remove('hidden');
}
// both locked: a short "READY" beat, then the fight (local, or the online host) — the guest waits for {t:'cfg'}
function selCheckStart() {
  if (!SEL.side[0].lock || !SEL.side[1].lock || SEL.starting) return;
  if (SEL.mode === 'online' && NET.role !== 'host') return;
  SEL.starting = true; renderSelect(); sfx.fight();
  setTimeout(() => {
    if (!SEL.open || !SEL.side[0].lock || !SEL.side[1].lock) { SEL.starting = false; renderSelect(); return; }
    const ids = SEL.side.map(s => ROSTER_ORDER[s.i]);
    makeFighters(ids[0], ids[1]);
    if (SEL.mode === 'online') netSend({ t: 'cfg', c: ids });
    closeSelect(); initAudio(); startMatch();
  }, 750);
}
// online guest: the host has fixed the line-up -> build the same fighters, snapshots take it from here
function applyCfg(ids) { makeFighters(ids[0], ids[1]); SEL.starting = true; closeSelect(); }
function renderSelect() {
  syncVsBanner();
  selEls().forEach((el, p) => {
    const s = SEL.side[p], id = ROSTER_ORDER[s.i], C = ROSTER[id], mine = canControl(p);
    el.classList.toggle('locked', s.lock); el.classList.toggle('remote', !mine);
    el.querySelectorAll('.sel-card').forEach(c => c.classList.toggle('on', +c.dataset.i === s.i));
    drawPortrait(el.querySelector('.sel-big'), id, p === 1);
    el.querySelector('.sel-name').textContent = C.name;
    el.querySelector('.sel-tagline').textContent = C.tag;
    el.querySelector('.sel-who').textContent = SEL.mode === 'online' ? (mine ? 'YOU' : 'OPPONENT') : 'PLAYER ' + (p + 1);
    el.querySelector('.sel-help').innerHTML = s.lock ? 'Locked in' + (mine ? ' — tap again to change' : '')
      : !mine ? 'Choosing…'
      : SEL.mode === 'online' ? '<kbd>←</kbd>/<kbd>→</kbd> or <kbd>A</kbd>/<kbd>D</kbd> choose · <kbd>Punch</kbd> or tap to lock'
      : p === 0 ? '<kbd>A</kbd>/<kbd>D</kbd> choose · <kbd>L</kbd> lock · or tap' : '<kbd>←</kbd>/<kbd>→</kbd> choose · <kbd>N</kbd> lock · or tap';
  });
  const both = SEL.side[0].lock && SEL.side[1].lock;
  $('selStatus').textContent = SEL.starting || both ? 'GET READY!'
    : SEL.mode === 'online' && !NET.conn ? 'Connecting…' : 'Lock in both fighters to start the match';
}
/* ---------- live VS banner: P1 / P2 avatar + name, updated the moment a pick changes ---------- */
const HEAD_BOX = {};   // id -> head crop in its idle frame (found once from the art)
function headBox(id) {
  if (HEAD_BOX[id]) return HEAD_BOX[id];
  const P = SPRITES[id].portrait, av = ROSTER[id].avatar;
  if (P && av) return (HEAD_BOX[id] = { A: { strip: P.c }, F: { sX: 0, sY: 0 }, x: av[0] * P.W, y: av[1] * P.H, size: av[2] * P.W }); // portrait head crop
  const A = SPRITES[id].idle, F = A.frames[0], d = A.strip.getContext('2d').getImageData(F.sX, F.sY, F.w, F.h).data;
  let top = -1; for (let y = 0; y < F.h && top < 0; y++) for (let x = 0; x < F.w; x++) if (d[(y * F.w + x) * 4 + 3] > 120) { top = y; break; }
  const band = Math.max(4, Math.round(F.h * .1)); let sx = 0, n = 0;
  for (let y = top; y < top + band; y++) for (let x = 0; x < F.w; x++) if (d[(y * F.w + x) * 4 + 3] > 120) { sx += x; n++; }
  const size = F.h * .27, cx = n ? sx / n : F.w / 2;          // head + a bit of shoulder
  return (HEAD_BOX[id] = { A, F, x: cx - size / 2, y: Math.max(0, top - size * .08), size });
}
function drawAvatar(cv, id, mirror) {
  const H = headBox(id), g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height); g.save(); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  if (mirror) { g.translate(cv.width, 0); g.scale(-1, 1); }   // both avatars look toward the VS in the middle
  g.drawImage(H.A.strip, H.F.sX + H.x, H.F.sY + H.y, H.size, H.size, 0, 0, cv.width, cv.height); g.restore();
}
const VSB = { ids: [null, null] };
function updateVsBanner(ids) {
  if (!SPRITES.moe) return;
  document.querySelectorAll('#vsBanner .vsb-side').forEach((el, p) => {
    const id = ids[p]; if (id === VSB.ids[p]) return;
    const pop = VSB.ids[p] !== null; VSB.ids[p] = id;
    drawAvatar(el.querySelector('.vsb-ava'), id, p === 1);
    el.querySelector('.vsb-name').textContent = ROSTER[id].name;
    if (pop) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); } // quick flash on change
  });
}
// shown only on the select screen (live picks) and during a fight (the chosen line-up) — never on the landing screen
// or over the victory cinematic; in a fight it replaces the HUD's names (drawHUD moves the rest below it)
const VSB_MATCH_PHASES = ['intro', 'countdown', 'fight', 'roundEnd'];
const vsBannerInMatch = () => !SEL.open && VSB_MATCH_PHASES.includes(G.phase);
function syncVsBanner() {
  const inMatch = vsBannerInMatch(), show = !!SPRITES.moe && (SEL.open || inMatch), el = $('vsBanner');
  el.classList.toggle('hidden', !show); el.classList.toggle('match', inMatch);
  if (show) updateVsBanner(SEL.open ? SEL.side.map(s => ROSTER_ORDER[s.i]) : MATCH.chars);
}

// keyboard on the select screen (either key set works for your own side online, like in a fight)
addEventListener('keydown', e => {
  if (!SEL.open) return;
  if (e.code === 'Escape') { e.preventDefault(); selBack(); return; }
  const k = keyInfo(e); if (!k) return;
  e.preventDefault(); e.stopImmediatePropagation(); if (e.repeat) return;
  if (k.act === 'left') selMove(k.p, -1);
  else if (k.act === 'right') selMove(k.p, 1);
  else if (k.act === 'punch' || k.act === 'kick' || k.act === 'special' || k.act === 'jump') selLock(k.p, !SEL.side[k.p].lock);
  else if (k.act === 'block' || k.act === 'crouch') selLock(k.p, false);
}, { capture: true });

/* =====================================================================
   STARTUP
   ===================================================================== */
const START_ART_CROP = 205 / 1024; // share of the start image's height taken by its painted title bar
loadImgFile(['Moe vs Romana_Fighting Arena.png', 'Moe vs Romana_ Fiery Battle Royale.png']).then(i3 => {
  if (!i3) return;
  // the key art has a static "MOE VS ROMANA" bar painted across its top: crop it off (the live VS banner replaces it)
  const cut = Math.round(i3.naturalHeight * START_ART_CROP), c = mk(i3.naturalWidth, i3.naturalHeight - cut);
  c.getContext('2d').drawImage(i3, 0, cut, c.width, c.height, 0, 0, c.width, c.height);
  c.toBlob(b => { if (b) $('start').style.backgroundImage = `url("${URL.createObjectURL(b)}")`; }, 'image/jpeg', .92);
});
Promise.all([loadPoses(), loadStage()]).then(([SPR]) => {
  $('btnStart').textContent = 'Forging arena…';
  setTimeout(() => {
    buildArena();
    CHARACTERS.forEach((C, i) => { SPRITES[C.id] = SPR[i]; });
    makeFighters('moe', 'romana');   // default line-up until the select screen sets one
    buildSelectScreen();
    const b = $('btnStart'); b.disabled = false; b.textContent = 'Play Local';
    $('btnHost').disabled = false;
    requestAnimationFrame(loop);
    if (JOIN_ID) joinOnline(JOIN_ID);
  }, 30);
}).catch(e => {
  console.error(e);
  const b = $('btnStart'); b.textContent = 'Can’t load fighters';
  showNetPanel(true); $('linkRow').classList.add('hidden'); $('btnNetCancel').classList.add('hidden');
  netStatus(location.protocol === 'file:'
    ? 'The move images need a web server to remove their white backgrounds. Open the game from Netlify (or any local server, e.g. “npx serve”) instead of double-clicking index.html.'
    : 'Couldn’t load the fighters’ move images (moe_idle.png, romana_idle.png, …) — make sure they are uploaded next to index.html.');
});

function blurAll() { document.activeElement && document.activeElement.blur(); }
$('btnStart').onclick = () => { initAudio(); blurAll(); netTeardown(); goFullscreenOnPhone(); openSelect('local'); };
$('btnHost').onclick = () => { initAudio(); blurAll(); netTeardown(); goFullscreenOnPhone(); hostOnline(); };
$('btnCopy').onclick = () => {
  const inp = $('netLink'); inp.select();
  (navigator.clipboard ? navigator.clipboard.writeText(inp.value) : Promise.reject()).then(
    () => { $('btnCopy').textContent = 'Copied!'; }, () => { document.execCommand('copy'); $('btnCopy').textContent = 'Copied!'; });
  setTimeout(() => { $('btnCopy').textContent = 'Copy'; }, 1500);
};
$('btnNetCancel').onclick = () => { netTeardown(); history.replaceState(null, '', location.pathname); showNetPanel(false); };
$('btnRestart').onclick = requestRestart;
$('btnMenu').onclick = () => { blurAll(); exitToMenu(); };
const onExit = e => { e.preventDefault(); e.stopPropagation(); blurAll(); exitToMenu(); };
$('btnExit').addEventListener('click', onExit);
$('btnExit').addEventListener('touchend', onExit, { passive: false });
addEventListener('keydown', e => { if (e.code === 'Escape' && ['intro', 'countdown', 'fight', 'roundEnd', 'victory'].includes(G.phase)) exitToMenu(); });
$('mute').onclick = () => {
  soundOn = !soundOn; $('mute').textContent = soundOn ? '🔊 Sound' : '🔇 Muted'; blurAll();
  if (MUSIC.victory) MUSIC.victory.muted = !soundOn;  // muted music keeps playing silently so the sequence stays in sync
  if (RK.gain) RK.gain.gain.value = soundOn ? 1 : 0;   // Rokaia's song too (her dance keeps following it)
  if (MIX.music) MIX.music.gain.value = soundOn && BGM.on ? MIX.COMBAT : 0;
  if (!soundOn) cutAllSfx();
};
preloadMusic();
