/* global AFRAME, THREE */

// ---------------------------------------------------------------------------
// Config access (config.js loads before game.js). CFG('section.key', fallback)
// fetches the value by path; if config.js is absent or the key is missing it
// returns the fallback, so the game stays functional even without a config.
// ---------------------------------------------------------------------------
const CFG = (function () {
  const root = (typeof window !== 'undefined' && window.GAME_CONFIG) || {};
  return function (path, fallback) {
    let v = root;
    const keys = path.split('.');
    for (let i = 0; i < keys.length; i++) {
      if (v == null) { v = undefined; break; }
      v = v[keys[i]];
    }
    return v == null ? fallback : v;
  };
})();

// ---------------------------------------------------------------------------
// Procedural sound (Web Audio API). No external files — synthesized on the fly.
// AudioContext "wakes up" on the first shot (which is a user gesture).
// ---------------------------------------------------------------------------
const SFX = {
  ctx: null,
  master: null,

  // Real samples (downloaded locally into sfx/): the pistol shot and the ring
  // of a bullet on metal. If they didn't load — sound is synthesized as before.
  buffers: {},                                       // name -> AudioBuffer
  _pending: {},                                      // name -> Promise<ArrayBuffer>
  files: { shot: 'sfx/shot.mp3', casing: 'sfx/ting.mp3', hit: 'sfx/clay_2.mp3' },

  ensure: function () {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = CFG('audio.masterVolume', 0.5);
      this.master.connect(this.ctx.destination);
      this.decodeAll(); // decode the prefetched files — ctx already exists
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },

  // Download the files into memory right away (the network doesn't need AudioContext).
  prefetch: function () {
    const cb = window.__CB || ''; // the same cache-busting token as the document
    Object.keys(this.files).forEach((name) => {
      this._pending[name] = fetch(this.files[name] + cb)
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .catch((e) => { console.warn('SFX: failed to download ' + name, e); return null; });
    });
  },

  // Decode the loaded files into AudioBuffer (once, after ctx exists).
  decodeAll: function () {
    if (this._decoded) return;
    this._decoded = true;
    Object.keys(this._pending).forEach((name) => {
      this._pending[name].then((ab) => {
        if (!ab) return;
        this.ctx.decodeAudioData(ab,
          (buf) => { this.buffers[name] = buf; },
          (e) => console.warn('SFX: failed to decode ' + name, e));
      });
    });
  },

  // Play a sample through a spatial panner. rate — a slight pitch variation
  // (livelier on repeats). Returns false if the sample isn't ready yet — then
  // the caller synthesizes the sound as a fallback.
  playBuffer: function (name, pos, gain, rate) {
    const buf = this.buffers[name];
    if (!buf) return false;
    const ctx = this.ensure();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (rate) src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain != null ? gain : 1;
    src.connect(g).connect(this.output(pos));
    src.start(ctx.currentTime);
    return true;
  },

  // Update the listener (position + head orientation). Called every frame.
  setListener: function (p, f, u) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    if (l.positionX) { // modern API (AudioParam)
      l.positionX.value = p.x; l.positionY.value = p.y; l.positionZ.value = p.z;
      l.forwardX.value = f.x; l.forwardY.value = f.y; l.forwardZ.value = f.z;
      l.upX.value = u.x; l.upY.value = u.y; l.upZ.value = u.z;
    } else { // legacy API
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  },

  // Panner at world point pos. The sound attenuates with distance.
  makePanner: function (pos) {
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    // The reference distance covers the range (targets/wall ~10 m), the rolloff
    // is gentle — otherwise hits and concrete impacts are barely audible against
    // a nearby shot. Directionality (left/right/front) is preserved either way.
    panner.refDistance = 8;
    panner.maxDistance = 50;
    panner.rolloffFactor = 0.5;
    if (panner.positionX) {
      panner.positionX.value = pos.x; panner.positionY.value = pos.y; panner.positionZ.value = pos.z;
    } else {
      panner.setPosition(pos.x, pos.y, pos.z);
    }
    panner.connect(this.master);
    return panner;
  },

  // Output node: a spatial panner when a position is given, otherwise master.
  output: function (pos) {
    if (!pos) return this.master;
    const panner = this.makePanner(pos);
    // IMPORTANT: disconnect the node after a few seconds (longer than any sound).
    // Otherwise HRTF panners pile up on every shot/casing/hit and over time
    // overload the audio graph — the sound and the whole scene start to "stick"
    // (and the score freezes with them, since shoot() throws on SFX.shot()).
    setTimeout(() => { try { panner.disconnect(); } catch (e) {} }, 3000);
    return panner;
  },

  // Shot: a real sample (with a slight pitch variation), otherwise synthesis:
  // a noise click through a low-pass filter + a short low "boom".
  shot: function (pos) {
    const ctx = this.ensure();
    if (this.playBuffer('shot', pos, 0.9, 0.96 + Math.random() * 0.08)) return;
    const out = this.output(pos);
    const t = ctx.currentTime;
    const dur = 0.18;

    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2000;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.8, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + dur);
    noise.connect(lp).connect(ng).connect(out);
    noise.start(t);
    noise.stop(t + dur);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.12);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.6, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + 0.13);
  },

  // Target hit/break: a real sample (clay_1.mp3) with a slight pitch variation
  // so repeats don't sound identical. If the sample isn't loaded yet — fallback
  // synthesis: a muffled "thwock" (a short low thump + a band-pass "smack").
  hit: function (pos) {
    const ctx = this.ensure();
    if (this.playBuffer('hit', pos, 0.85, 0.94 + Math.random() * 0.12)) return;
    const out = this.output(pos);
    const t = ctx.currentTime;

    // Body of the impact — a short low thump.
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(420, t);
    osc.frequency.exponentialRampToValueAtTime(150, t + 0.06);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.5, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + 0.1);

    // "Smack" — a short band-pass noise with a fast decay (no resonant tail).
    const dur = 0.06;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const env = Math.pow(1 - i / d.length, 2.5);
      d[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1000 + Math.random() * 300;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(bp).connect(g).connect(out);
    src.start(t);
    src.stop(t + dur);
  },

  // Casing on the floor: a real ringing sample (ting.mp3) with pitch variation,
  // volume by touch strength. Fallback — a synthetic "tink".
  casing: function (pos, gain) {
    // Global throttling: with rapid fire the casings ring in a bunch and it gets
    // annoying — no more than one ring per ~110 ms.
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (this._lastCasing && now - this._lastCasing < 110) return;
    this._lastCasing = now;
    const v = (gain != null ? gain : 1);
    if (this.playBuffer('casing', pos, 0.6 * v, 0.9 + Math.random() * 0.25)) return;
    this.impact(0.5 * v, pos);
  },

  // Debris impact on the ground: a short band-pass "tick", volume by impact
  // strength. Spatial localization — via a panner at point pos.
  impact: function (intensity, pos) {
    const ctx = this.ensure();
    const out = this.output(pos);
    const t = ctx.currentTime;
    const dur = 0.08;

    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const env = Math.pow(1 - i / d.length, 2);
      d[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2500 + Math.random() * 2500;
    bp.Q.value = 1.5;
    const g = ctx.createGain();
    const vol = Math.min(0.5, 0.12 + intensity * 0.3);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);

    src.connect(bp).connect(g).connect(out);
    src.start(t);
    src.stop(t + dur);
  },

  // Bullet into the wall (concrete): a muffled "thump" (low-freq noise + low
  // thump) and a short concrete "crumble" on top. A bit of randomness — misses
  // sound different each time.
  wallHit: function (pos) {
    const ctx = this.ensure();
    const out = this.output(pos);
    const t = ctx.currentTime;

    // Body of the impact: noise through a low-pass filter dropping into a muffled low, very fast decay.
    const dur = 0.13;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const env = Math.pow(1 - i / d.length, 2.5);
      d[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(850 + Math.random() * 350, t);
    lp.frequency.exponentialRampToValueAtTime(250, t + dur);
    lp.Q.value = 0.7;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.7, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(lp).connect(ng).connect(out);
    src.start(t);
    src.stop(t + dur);

    // Low thump — the weight of the impact.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(170, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.07);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.5, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + 0.09);

    // Concrete crumble — a short band-pass crackle on top.
    const cdur = 0.05;
    const cbuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * cdur), ctx.sampleRate);
    const cd = cbuf.getChannelData(0);
    for (let i = 0; i < cd.length; i++) {
      const env = Math.pow(1 - i / cd.length, 3);
      cd[i] = (Math.random() * 2 - 1) * env;
    }
    const csrc = ctx.createBufferSource();
    csrc.buffer = cbuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2000 + Math.random() * 1500;
    bp.Q.value = 1.2;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.25, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + cdur);
    csrc.connect(bp).connect(cg).connect(out);
    csrc.start(t);
    csrc.stop(t + cdur);
  },

  // Level-up: an ascending arpeggio (C-E-G-C), centered.
  levelup: function () {
    const ctx = this.ensure();
    const t = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = ctx.createGain();
      const start = t + i * 0.09;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.3, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.25);
      osc.connect(g).connect(this.master);
      osc.start(start);
      osc.stop(start + 0.26);
    });
  }
};

// Start downloading the samples immediately — they're usually ready by the
// first shot (and if not — the fallback synthesis in shot()/hit() kicks in).
SFX.prefetch();

// ---------------------------------------------------------------------------
// Background music. One random track per game: starts when the game begins
// (shooting the START target) and fades out smoothly when it ends (GAME OVER).
// Unlike SFX (spatial Web Audio via panners), the music is a plain <audio>:
// non-directional, identical in both ears. We animate the volume directly via
// .volume, which gives a smooth fade-out on stop.
// ---------------------------------------------------------------------------
const MUSIC = {
  // Tracks live in music/ with uniform names bg_01.mp3 … bg_NN.mp3.
  // Just specifying their count is enough — the path is built on the fly in play().
  count: CFG('audio.musicTrackCount', 20),
  volume: CFG('audio.musicVolume', 0.5),  // target background volume (quieter than shots/hits)
  el: null,
  _fadeT: null,
  current: null, // number of the track currently loaded (1..count), for isOnBeat()

  // Lazily create one <audio> and reuse it for all games.
  audio: function () {
    if (!this.el) {
      const a = new Audio();
      a.preload = 'none'; // don't download megabytes until the game starts
      a.loop = true;      // the track may be shorter than the game — loop it
      this.el = a;
    }
    return this.el;
  },

  // Game start: a random track from the beginning, at target volume.
  play: function () {
    const a = this.audio();
    clearInterval(this._fadeT);
    const n = Math.floor(Math.random() * this.count) + 1;     // 1..count
    const name = 'bg_' + String(n).padStart(2, '0') + '.mp3'; // bg_07.mp3
    this.current = n;
    a.src = 'music/' + name;
    a.currentTime = 0;
    a.volume = this.volume;
    const p = a.play();
    if (p && p.catch) p.catch((e) => console.warn('MUSIC: failed to start ' + name, e));
  },

  // True if the music is currently within a beat-hit window of the playing
  // track's nearest detected beat (see www/music-beats.js, generated offline
  // by tools/beat-analysis/). Used to award a "Beat" bonus indicator on hits.
  isOnBeat: function () {
    const a = this.el;
    if (!a || a.paused || !this.current) return false;
    const track = window.MUSIC_BEATS && window.MUSIC_BEATS[this.current];
    const beats = track && track.beats;
    if (!beats || !beats.length) return false;

    const t = a.currentTime;
    // Binary search for the insertion point of t in the ascending beats array,
    // then compare against its two neighbors to find the nearest beat.
    let lo = 0, hi = beats.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] < t) lo = mid + 1; else hi = mid;
    }
    let nearest = beats[lo];
    if (lo > 0 && Math.abs(beats[lo - 1] - t) < Math.abs(nearest - t)) nearest = beats[lo - 1];

    return Math.abs(nearest - t) <= CFG('audio.beatToleranceMs', 120) / 1000;
  },

  // Game end: a smooth fade-out over ~1.5 s, then stop and reset.
  stop: function () {
    const a = this.el;
    if (!a || a.paused) return;
    clearInterval(this._fadeT);
    const steps = 30, dt = 50;       // 30 steps × 50 ms = 1.5 s
    const start = a.volume;
    let i = 0;
    this._fadeT = setInterval(() => {
      i++;
      a.volume = Math.max(0, start * (1 - i / steps));
      if (i >= steps) {
        clearInterval(this._fadeT);
        a.pause();
        a.currentTime = 0;
        a.volume = this.volume;       // restore volume for the next game
      }
    }, dt);
  }
};

// ---------------------------------------------------------------------------
// Sync the audio listener with the head. Attached to the camera: every frame it
// moves AudioContext.listener to the camera's position/orientation, so spatial
// sound is correct relative to the gaze.
// ---------------------------------------------------------------------------
AFRAME.registerComponent('audio-listener-sync', {
  init: function () {
    this.q = new THREE.Quaternion();
    this.p = new THREE.Vector3();
    this.f = new THREE.Vector3();
    this.u = new THREE.Vector3();
  },

  tick: function () {
    if (!SFX.ctx) return; // sound not initialized yet
    const o = this.el.object3D;
    o.getWorldPosition(this.p);
    o.getWorldQuaternion(this.q);
    this.f.set(0, 0, -1).applyQuaternion(this.q); // gaze
    this.u.set(0, 1, 0).applyQuaternion(this.q);  // head "up"
    SFX.setListener(this.p, this.f, this.u);
  }
});

// ---------------------------------------------------------------------------
// Text via a canvas texture. Needed because A-Frame's stock MSDF font has no
// Cyrillic (only digits show up). We draw the lines on a <canvas> with a system
// font and place it as a texture on a plane.
// Multiline — via \n. Size is set by the size parameter (line height, m).
// ---------------------------------------------------------------------------
AFRAME.registerComponent('ctext', {
  schema: {
    value: { default: '' },
    color: { default: '#FFFFFF' },
    align: { default: 'center' },  // left | center | right
    size: { default: 0.4 },        // height of one line in meters (width — from proportions)
    weight: { default: 'bold' }
  },

  init: function () {
    this.canvas = document.createElement('canvas');
    this.cx = this.canvas.getContext('2d');
    this._cw = 0;
    this._ch = 0;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true })
    );
    this.makeTexture();             // creates this.texture and assigns it to material.map
    this.el.setObject3D('ctext', this.mesh);
  },

  // (Re)create the CanvasTexture over the current canvas and bind it to the material.
  // IMPORTANT for Quest/Oculus Browser: when the canvas size changes, CanvasTexture
  // is not reliably re-uploaded by a single needsUpdate — "ghosts" of the previous
  // text remain on the wall (or the texture doesn't update at all). So when the
  // canvas size changes we recreate the texture entirely.
  makeTexture: function () {
    if (this.texture) this.texture.dispose();
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.anisotropy = 8;
    this.texture.minFilter = THREE.LinearFilter;
    // So colors don't look dull under colorManagement.
    if ('sRGBEncoding' in THREE) this.texture.encoding = THREE.sRGBEncoding;
    if ('SRGBColorSpace' in THREE) this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh.material.map = this.texture;
    this.mesh.material.needsUpdate = true;
  },

  update: function () {
    const d = this.data;
    const lines = String(d.value).split('\n');
    const px = 72;
    const font = (d.weight ? d.weight + ' ' : '') + px + 'px Arial, "Segoe UI", sans-serif';
    const cx = this.cx;
    cx.font = font;
    let textW = 1;
    for (let i = 0; i < lines.length; i++) {
      textW = Math.max(textW, cx.measureText(lines[i]).width);
    }
    const pad = px * 0.5;
    const lineH = px * 1.3;
    const cw = Math.ceil(textW + pad * 2);
    const ch = Math.ceil(lineH * lines.length + pad * 2);

    const sizeChanged = (cw !== this._cw || ch !== this._ch);
    this.canvas.width = cw;
    this.canvas.height = ch;

    cx.clearRect(0, 0, cw, ch);
    cx.font = font;                 // reset settings after the canvas resize
    cx.textBaseline = 'middle';
    cx.textAlign = d.align;
    cx.fillStyle = d.color;
    const x = d.align === 'left' ? pad : d.align === 'right' ? cw - pad : cw / 2;
    for (let i = 0; i < lines.length; i++) {
      cx.fillText(lines[i], x, pad + lineH * (i + 0.5));
    }

    // Canvas size changed — recreate the texture (otherwise "ghosts" on Quest).
    if (sizeChanged) {
      this._cw = cw;
      this._ch = ch;
      this.makeTexture();
    }
    this.texture.needsUpdate = true;

    // Scale: one text line (lineH pixels) = d.size meters.
    const k = d.size / lineH;
    this.mesh.scale.set(cw * k, ch * k, 1);
  },

  remove: function () {
    if (this.texture) this.texture.dispose();
    this.el.removeObject3D('ctext');
  }
});

// ---------------------------------------------------------------------------
// Per-level stats table on the wall. We draw on our own <canvas> and place it
// as a texture on a separate plane (like ctext) — this reliably renders and
// doesn't depend on the entity's material. One row per cleared level: number,
// hits/shots, accuracy, time spent. Rows are added by the levels component as
// you progress (setRows).
// ---------------------------------------------------------------------------
AFRAME.registerComponent('stats-table', {
  schema: {
    maxRows: { default: 10 },              // total levels (rows by the end of the game)
    width:   { default: 3.9 },             // board width in meters
    title:   { default: 'LEVEL STATS' },
    hsKey:   { default: CFG('game.highScoreKey', 'vr-shooter-highscore') } // high-score key in localStorage
  },

  init: function () {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.anisotropy = 8;
    this.texture.minFilter = THREE.LinearFilter;
    if ('sRGBEncoding' in THREE) this.texture.encoding = THREE.sRGBEncoding;
    if ('SRGBColorSpace' in THREE) this.texture.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.el.setObject3D('stats-table', this.mesh);
    this.rows = [];
    this.highScore = this.loadHighScore();
    this.draw();
  },

  // The high score is kept in localStorage between sessions. We guard reads with
  // try/catch: private mode / disabled storage must not break the board's drawing.
  loadHighScore: function () {
    try {
      const v = parseInt(localStorage.getItem(this.data.hsKey), 10);
      return isNaN(v) ? 0 : v;
    } catch (e) { return 0; }
  },

  // Update the high score if the given score beat it. Returns true if a new
  // record was set (for the final banner). The board is always redrawn.
  submitScore: function (score) {
    const beaten = score > this.highScore;
    if (beaten) {
      this.highScore = score;
      try { localStorage.setItem(this.data.hsKey, String(score)); } catch (e) { /* storage unavailable */ }
    }
    this.draw();
    return beaten;
  },

  // rows: [{ level, hits, shots, acc, secs, score }, ...]
  setRows: function (rows) {
    this.rows = rows ? rows.slice() : [];
    this.draw();
  },

  draw: function () {
    const W = 760, rowH = 52, titleH = 74, pad = 22, hsH = 70;
    const maxRows = this.data.maxRows;
    const H = pad * 2 + hsH + titleH + (1 + maxRows) * rowH; // record + title + header + rows
    const c = this.canvas, g = this.ctx;
    c.width = W; c.height = H;
    g.clearRect(0, 0, W, H);

    // Backing panel with rounded corners and a border.
    const rr = (x, y, w, h, r) => {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    };
    g.fillStyle = 'rgba(12,14,22,0.88)';
    rr(0, 0, W, H, 18); g.fill();
    g.lineWidth = 4; g.strokeStyle = 'rgba(58,134,255,0.85)';
    rr(2, 2, W - 4, H - 4, 16); g.stroke();

    g.textBaseline = 'middle';
    g.textAlign = 'center';

    // High-Score above the table: a highlighted full-width banner.
    const hsMidY = pad + hsH / 2;
    g.fillStyle = 'rgba(255,214,10,0.12)';
    rr(pad, pad, W - pad * 2, hsH, 12); g.fill();
    g.font = 'bold 38px Arial, "Segoe UI", sans-serif';
    g.fillStyle = '#FFD60A';
    g.fillText('★ HIGH SCORE: ' + this.highScore, W / 2, hsMidY);

    // Title.
    g.fillStyle = '#FFD60A';
    g.font = 'bold 46px Arial, "Segoe UI", sans-serif';
    g.fillText(this.data.title, W / 2, pad + hsH + titleH / 2);

    // Columns: level number, hits/shots, accuracy, score, time.
    const cols = [
      { key: 'lvl',   label: 'LVL',     x: 58  },
      { key: 'hs',    label: 'HITS/SH', x: 210 },
      { key: 'acc',   label: 'ACC',     x: 358 },
      { key: 'score', label: 'SCORE',   x: 510 },
      { key: 'time',  label: 'TIME',    x: 662 }
    ];
    const headerY = pad + hsH + titleH + rowH / 2;
    g.font = 'bold 30px Arial, "Segoe UI", sans-serif';
    g.fillStyle = '#3A86FF';
    cols.forEach((col) => g.fillText(col.label, col.x, headerY));

    // Separator below the header.
    const sepY = pad + hsH + titleH + rowH;
    g.strokeStyle = 'rgba(58,134,255,0.5)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(pad + 6, sepY); g.lineTo(W - pad - 6, sepY); g.stroke();

    // Level rows.
    const fmtTime = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    g.font = '32px Arial, "Segoe UI", sans-serif';
    for (let i = 0; i < maxRows; i++) {
      const top = pad + hsH + titleH + rowH * (1 + i);
      const midY = top + rowH / 2;
      if (i % 2 === 1) { g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(pad, top, W - pad * 2, rowH); }
      const r = this.rows[i];
      if (!r) continue;
      g.fillStyle = '#E8ECF2';
      g.fillText(String(r.level), cols[0].x, midY);
      g.fillText(r.hits + '/' + r.shots, cols[1].x, midY);
      g.fillStyle = r.acc >= 70 ? '#6FD08C' : r.acc >= 40 ? '#FFD60A' : '#FF6B6B';
      g.fillText(r.acc + '%', cols[2].x, midY);
      g.fillStyle = '#FFD60A';
      g.fillText(String(r.score != null ? r.score : 0), cols[3].x, midY);
      g.fillStyle = '#9AA7B5';
      g.fillText(fmtTime(r.secs), cols[4].x, midY);
    }

    this.texture.needsUpdate = true;
    const k = this.data.width / W;
    this.mesh.scale.set(W * k, H * k, 1);
  },

  remove: function () { this.el.removeObject3D('stats-table'); }
});

// ---------------------------------------------------------------------------
// Combat panel on the front wall: two large indicators readable from afar —
// how many targets are left to clear on the current level and the current
// accuracy. We draw on our own canvas (like stats-table) and place it as a
// texture on a plane. The values are updated by: levels.render() (remaining)
// and game-state.render() (accuracy).
// ---------------------------------------------------------------------------
AFRAME.registerComponent('mission-board', {
  schema: {
    width: { default: 3.4 }   // panel width in meters
  },

  init: function () {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.anisotropy = 8;
    this.texture.minFilter = THREE.LinearFilter;
    if ('sRGBEncoding' in THREE) this.texture.encoding = THREE.sRGBEncoding;
    if ('SRGBColorSpace' in THREE) this.texture.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.el.setObject3D('mission-board', this.mesh);
    this.remaining = '—';   // string: count remaining, '—' before start, '✓' after victory
    this.accText = '0%';
    this.accVal = 0;
    this.draw();
  },

  setRemaining: function (v) { this.remaining = String(v); this.draw(); },
  setAccuracy: function (pct) {
    this.accVal = pct;
    this.accText = pct + '%';
    this.draw();
  },

  draw: function () {
    const W = 1100, H = 280;
    const c = this.canvas, g = this.ctx;
    c.width = W; c.height = H;
    g.clearRect(0, 0, W, H);

    const rr = (x, y, w, h, r) => {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    };

    // Backing panel with rounded corners and a border (stats-table style).
    g.fillStyle = 'rgba(12,14,22,0.88)';
    rr(0, 0, W, H, 20); g.fill();
    g.lineWidth = 4; g.strokeStyle = 'rgba(58,134,255,0.85)';
    rr(2, 2, W - 4, H - 4, 18); g.stroke();

    // Vertical separator between the two indicators.
    g.strokeStyle = 'rgba(58,134,255,0.5)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(W / 2, 36); g.lineTo(W / 2, H - 36); g.stroke();

    g.textBaseline = 'middle';
    g.textAlign = 'center';
    const lx = W * 0.25, rx = W * 0.75;
    const labelY = 70, valueY = 178;

    // Left cell: targets remaining.
    g.fillStyle = '#9AA7B5';
    g.font = 'bold 38px Arial, "Segoe UI", sans-serif';
    g.fillText('TARGETS LEFT', lx, labelY);
    g.fillStyle = '#FFD60A';
    g.font = 'bold 132px Arial, "Segoe UI", sans-serif';
    g.fillText(this.remaining, lx, valueY);

    // Right cell: accuracy (color by value, as in the table).
    g.fillStyle = '#9AA7B5';
    g.font = 'bold 38px Arial, "Segoe UI", sans-serif';
    g.fillText('ACCURACY', rx, labelY);
    g.fillStyle = this.accVal >= 70 ? '#6FD08C' : this.accVal >= 40 ? '#FFD60A' : '#FF6B6B';
    g.font = 'bold 120px Arial, "Segoe UI", sans-serif';
    g.fillText(this.accText, rx, valueY);

    this.texture.needsUpdate = true;
    const k = this.data.width / W;
    this.mesh.scale.set(W * k, H * k, 1);
  },

  remove: function () { this.el.removeObject3D('mission-board'); }
});

// ---------------------------------------------------------------------------
// Rules and scoring board (on the right wall). We draw our own <canvas> with a
// title, sections and items — in the stats-table style. The scoring text is
// built from the real SCORING constants (see below in this file) so the
// explanation always matches the actual scoring formula.
// ---------------------------------------------------------------------------
AFRAME.registerComponent('rules-board', {
  schema: {
    width: { default: 3.6 },                 // board width in meters
    title: { default: 'RULES & SCORING' }
  },

  init: function () {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.anisotropy = 8;
    this.texture.minFilter = THREE.LinearFilter;
    if ('sRGBEncoding' in THREE) this.texture.encoding = THREE.sRGBEncoding;
    if ('SRGBColorSpace' in THREE) this.texture.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.el.setObject3D('rules-board', this.mesh);
    this.draw();
  },

  // Board lines. type: 'head' — section heading, 'item' — list item,
  // 'gap' — empty spacing. Score values are substituted from SCORING.
  lines: function () {
    const s = (typeof SCORING !== 'undefined') ? SCORING : null;
    const accMax = s ? s.accMax : 1.5;
    const beatBonus = s ? s.beatBonus : 25;
    return [
      { type: 'head', text: 'HOW TO PLAY' },
      { type: 'item', text: 'Shoot START to begin' },
      { type: 'item', text: 'Hit targets to clear each level' },
      { type: 'item', text: (this.maxLevel() || 5) + ' levels, then GAME OVER' },
      { type: 'item', text: 'Targets shrink every level' },
      { type: 'item', text: 'Shoot RELOAD to restart' },
      { type: 'gap' },
      { type: 'head', text: 'SCORING' },
      { type: 'item', text: 'Distance + speed + accuracy + beat = max score' },
      { type: 'item', text: 'Bullseye scores up to ×' + accMax },
      { type: 'item', text: 'On-beat hit: +' + beatBonus + ' bonus' }
    ];
  },

  // Fetch the level count from the levels component on the scene (if present).
  maxLevel: function () {
    const lv = this.el.sceneEl && this.el.sceneEl.components.levels;
    return lv && lv.data ? lv.data.maxLevel : null;
  },

  draw: function () {
    const W = 760, pad = 26, titleH = 80, headH = 50, itemH = 44, gapH = 22;
    const rows = this.lines();
    let bodyH = 0;
    rows.forEach((r) => {
      bodyH += r.type === 'head' ? headH : r.type === 'gap' ? gapH : itemH;
    });
    const H = pad * 2 + titleH + bodyH;

    const c = this.canvas, g = this.ctx;
    c.width = W; c.height = H;
    g.clearRect(0, 0, W, H);

    // Backing panel with rounded corners and a border (like stats-table).
    const rr = (x, y, w, h, r) => {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    };
    g.fillStyle = 'rgba(12,14,22,0.88)';
    rr(0, 0, W, H, 18); g.fill();
    g.lineWidth = 4; g.strokeStyle = 'rgba(58,134,255,0.85)';
    rr(2, 2, W - 4, H - 4, 16); g.stroke();

    g.textBaseline = 'middle';

    // Centered title.
    g.textAlign = 'center';
    g.fillStyle = '#FFD60A';
    g.font = 'bold 50px Arial, "Segoe UI", sans-serif';
    g.fillText(this.data.title, W / 2, pad + titleH / 2);

    // Body: sections and items on the left.
    let y = pad + titleH;
    rows.forEach((r) => {
      if (r.type === 'gap') { y += gapH; return; }
      if (r.type === 'head') {
        const midY = y + headH / 2;
        g.textAlign = 'left';
        g.fillStyle = '#3A86FF';
        g.font = 'bold 34px Arial, "Segoe UI", sans-serif';
        g.fillText(r.text, pad + 8, midY);
        // Section underline.
        g.strokeStyle = 'rgba(58,134,255,0.45)';
        g.lineWidth = 2;
        g.beginPath(); g.moveTo(pad + 8, y + headH - 6); g.lineTo(W - pad - 8, y + headH - 6); g.stroke();
        y += headH;
      } else {
        const midY = y + itemH / 2;
        // Bullet dot.
        g.fillStyle = '#6FD08C';
        g.beginPath(); g.arc(pad + 18, midY, 5, 0, Math.PI * 2); g.fill();
        g.textAlign = 'left';
        g.fillStyle = '#E8ECF2';
        g.font = '30px Arial, "Segoe UI", sans-serif';
        g.fillText(r.text, pad + 38, midY);
        y += itemH;
      }
    });

    this.texture.needsUpdate = true;
    const k = this.data.width / W;
    this.mesh.scale.set(W * k, H * k, 1);
  },

  remove: function () { this.el.removeObject3D('rules-board'); }
});

// ---------------------------------------------------------------------------
// Distance markings on the floor. A dashed center line of the range (along the Z
// axis) with transverse ticks and distance labels to the FRONT wall (5m, 10m,
// ...). The line starts some distance from the front wall and runs back right up
// to the back wall. The front wall (with the targets) at z=wallZ is 0 m.
// ---------------------------------------------------------------------------
AFRAME.registerComponent('range-markings', {
  schema: {
    wallZ:      { default: -10 },     // z of the front wall — the distance origin (0 m)
    backZ:      { default: 5.9 },     // how far to run the line (the back wall surface)
    startDist:  { default: 3 },       // at what distance from the wall the line starts, m
    step:       { default: 5 },       // marking step, m
    color:      { default: '#3A86FF' },
    labelColor: { default: '#DCE6F2' }
  },

  init: function () {
    const d = this.data;
    const y = 0.02;                       // slightly above the floor — avoids z-fighting
    const zFront = d.wallZ + d.startDist; // near end of the line (toward the front wall)
    const zBack  = d.backZ;               // far end (at the back wall)

    // Central solid line along the Z axis (from the near end to the back wall).
    const lineW = 0.06;
    this.el.appendChild(this.bar(0, y, (zFront + zBack) / 2, lineW, zBack - zFront, d.color));

    // Distance markings: a transverse tick across the lane + an "Nm" label.
    for (let dist = d.step; ; dist += d.step) {
      const z = d.wallZ + dist;
      if (z > zBack) break;
      if (z < zFront) continue;
      this.el.appendChild(this.bar(0, y, z, 1.1, 0.06, d.color)); // transverse tick
      const label = document.createElement('a-entity');
      // rotation -90 about X lays the text flat on the floor facing up, top toward the front wall.
      label.setAttribute('rotation', '-90 0 0');
      label.setAttribute('position', { x: 0.75, y: y, z: z });
      label.setAttribute('ctext',
        'value: ' + dist + 'm; color: ' + d.labelColor + '; size: 0.32; weight: bold');
      this.el.appendChild(label);
    }
  },

  // A flat strip on the floor: width along X, depth along Z, near-zero height.
  bar: function (x, y, z, width, depth, color) {
    const b = document.createElement('a-box');
    b.setAttribute('position', { x: x, y: y, z: z });
    b.setAttribute('width', width);
    b.setAttribute('height', 0.012);
    b.setAttribute('depth', depth);
    b.setAttribute('material', 'color: ' + color + '; shader: flat');
    return b;
  }
});

// ---------------------------------------------------------------------------
// Procedural texture for surfaces (floor/walls/ceiling) via canvas — no external
// files. We draw "concrete panels": a noisy background + seams along the canvas
// edges that tile seamlessly via RepeatWrapping and form a grid of panels.
// Cheap for Quest (a small canvas + GPU tiling).
// ---------------------------------------------------------------------------
AFRAME.registerComponent('proc-texture', {
  schema: {
    base:   { default: '#20232E' },                       // surface color
    line:   { default: '#11131a' },                       // seam color
    accent: { default: '#2b2f3c' },                       // soft blotches on the concrete
    repeat: { type: 'vec2', default: { x: 6, y: 6 } },    // number of tiles (panels)
    res:    { default: 256 }                              // canvas size, px
  },

  init: function () {
    if (this.el.hasLoaded) this.apply();
    else this.el.addEventListener('loaded', this.apply.bind(this));
  },

  apply: function () {
    const mesh = this.el.getObject3D('mesh');
    if (!mesh || !mesh.material) return;
    const tex = new THREE.CanvasTexture(this.draw());
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(this.data.repeat.x, this.data.repeat.y);
    tex.anisotropy = 4;
    if ('SRGBColorSpace' in THREE) tex.colorSpace = THREE.SRGBColorSpace;
    else if ('sRGBEncoding' in THREE) tex.encoding = THREE.sRGBEncoding;
    mesh.material.map = tex;
    mesh.material.color.set('#ffffff'); // show the texture "as is"
    mesh.material.needsUpdate = true;
  },

  draw: function () {
    const d = this.data;
    const n = d.res;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d');

    // Concrete background.
    g.fillStyle = d.base;
    g.fillRect(0, 0, n, n);

    // Soft blotches of the accent color — concrete unevenness.
    for (let i = 0; i < 8; i++) {
      g.fillStyle = d.accent;
      g.globalAlpha = 0.05 + Math.random() * 0.06;
      const r = n * (0.1 + Math.random() * 0.22);
      g.beginPath(); g.arc(Math.random() * n, Math.random() * n, r, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;

    // Fine "graininess": light and dark speckles.
    for (let i = 0; i < n * 6; i++) {
      const x = Math.random() * n, y = Math.random() * n;
      const r = Math.random() * 1.5 + 0.3;
      g.fillStyle = Math.random() < 0.5
        ? 'rgba(255,255,255,' + (Math.random() * 0.05).toFixed(3) + ')'
        : 'rgba(0,0,0,' + (Math.random() * 0.06).toFixed(3) + ')';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }

    // Seams along the top and left edges → tiling produces a grid of panels
    // (the right/bottom seam comes from the neighbor tile, so we draw only two sides).
    const w = Math.max(2, n * 0.035);
    g.fillStyle = d.line;
    g.fillRect(0, 0, n, w);          // top seam
    g.fillRect(0, 0, w, n);          // left seam
    // A slight bevel shadow next to the seam — adds depth.
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.fillRect(0, w, n, w * 0.6);
    g.fillRect(w, 0, w * 0.6, n);

    return c;
  }
});

// ---------------------------------------------------------------------------
// Target texture: concentric rings ("bullseye") on the front face of the
// cylinder. We draw in grayscale, and the target material color (red/blue)
// shows through by multiplication (map × color) — this preserves the color
// coding of target types while the texture itself is shared by all. Cheap: one
// canvas per target. The cylinder cap's UV is a disc (center 0.5,0.5, radius
// 0.5), so the centered "eye" sits exactly on the face edge.
// ---------------------------------------------------------------------------
AFRAME.registerComponent('target-rings', {
  schema: {
    rings:  { default: 5 },     // how many rings from center to edge
    bright: { default: 0.95 },  // brightness of the light rings (fraction 0..1)
    dark:   { default: 0.42 },  // brightness of the dark rings
    res:    { default: 256 }    // canvas size, px
  },

  init: function () {
    this.applied = false;
    this.apply();                                   // in case the mesh is already ready
    this.el.addEventListener('loaded', this.apply.bind(this));
  },

  // The target's mesh (or its material) is sometimes not created yet at 'loaded'
  // — for the floor/walls it makes it in time, for the target entities it
  // doesn't, and the ring texture wasn't applied. So we try in tick until it's
  // applied, then watch that the material doesn't "lose" our map (in case
  // someone overwrites it).
  tick: function () {
    if (!this.applied) { this.apply(); return; }
    const mesh = this.el.getObject3D('mesh');
    if (mesh && mesh.material && mesh.material.map !== this.tex) {
      mesh.material.map = this.tex;
      mesh.material.needsUpdate = true;
    }
  },

  apply: function () {
    if (this.applied) return;
    const mesh = this.el.getObject3D('mesh');
    if (!mesh || !mesh.material) return;
    const tex = new THREE.CanvasTexture(this.draw());
    tex.anisotropy = 4;
    if ('SRGBColorSpace' in THREE) tex.colorSpace = THREE.SRGBColorSpace;
    else if ('sRGBEncoding' in THREE) tex.encoding = THREE.sRGBEncoding;
    mesh.material.map = tex;          // the material's color stays — it tints the rings
    mesh.material.needsUpdate = true;
    this.tex = tex;
    this.applied = true;
  },

  draw: function () {
    const d = this.data;
    const n = d.res;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d');
    const cx = n / 2, cy = n / 2, maxR = n / 2;
    const gray = (v) => { const x = Math.round(Math.max(0, Math.min(1, v)) * 255); return 'rgb(' + x + ',' + x + ',' + x + ')'; };

    // Dark background (canvas corners + outer rim).
    g.fillStyle = gray(d.dark * 0.55);
    g.fillRect(0, 0, n, n);

    // Rings from outer to center: each next circle overlaps the previous one.
    const ringW = maxR / d.rings;
    g.lineWidth = Math.max(2, n * 0.012);
    g.strokeStyle = gray(0.12);                 // dark separating outline
    for (let i = d.rings; i >= 1; i--) {
      const r = ringW * i;
      g.fillStyle = gray(i % 2 === 1 ? d.bright : d.dark); // alternate; center (i=1) is light
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    }
    // Bright "bullseye" dot in the very center.
    g.fillStyle = gray(1);
    g.beginPath(); g.arc(cx, cy, ringW * 0.45, 0, Math.PI * 2); g.fill();

    return c;
  }
});

// ---------------------------------------------------------------------------
// Game timer: elapsed time (mm:ss) on the scoreboard. Paused on victory
// (game-stop), reset on restart (game-reset).
// ---------------------------------------------------------------------------
AFRAME.registerComponent('game-timer', {
  init: function () {
    this.display = document.querySelector('#hud-timer');
    this.elapsed = 0;
    this.acc = 0;
    this.running = false; // before the game starts (START target) the timer is stopped; game-start/game-reset start it
    this.render();
    this.el.addEventListener('game-stop', () => { this.running = false; });
    this.el.addEventListener('game-start', () => { this.running = true; });
    this.el.addEventListener('game-reset', () => {
      this.elapsed = 0; this.acc = 0; this.running = true; this.render();
    });
  },

  tick: function (t, dt) {
    if (!this.running || !dt) return;
    this.elapsed += dt;
    this.acc += dt;
    if (this.acc >= 250) { this.acc = 0; this.render(); } // refresh the display ~4 times/s
  },

  seconds: function () { return Math.floor(this.elapsed / 1000); },

  mmss: function () {
    const s = this.seconds();
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  },

  render: function () {
    if (this.display) this.display.setAttribute('ctext', 'value', 'TIME ' + this.mmss());
  }
});

// ---------------------------------------------------------------------------
// Global game state (score, hits, misses).
// ---------------------------------------------------------------------------
AFRAME.registerComponent('game-state', {
  schema: {
    score: { default: 0 },
    hits: { default: 0 },
    shots: { default: 0 }
  },

  init: function () {
    this.boardEl = document.querySelector('#mission-board'); // front-wall panel (score/accuracy)
    this.render();

    // Global events: a target was hit / a shot was fired.
    this.el.addEventListener('target-hit', (e) => {
      this.data.hits++;
      this.data.score += e.detail.points;
      this.render();
    });
    this.el.addEventListener('shot-fired', () => {
      this.data.shots++;
      this.render();
    });
    // Reset on game restart.
    this.el.addEventListener('game-reset', () => {
      this.data.score = 0;
      this.data.hits = 0;
      this.data.shots = 0;
      this.render();
    });
  },

  render: function () {
    const acc = this.data.shots
      ? Math.round((this.data.hits / this.data.shots) * 100)
      : 0;
    const mb = this.boardEl && this.boardEl.components['mission-board'];
    if (mb) mb.setAccuracy(acc);
  }
});

// ---------------------------------------------------------------------------
// Levels. The level goal is to destroy a required number of targets. On reaching
// it — advance to the next level with rising difficulty: targets respawn faster,
// tough/rare ones appear more often, the hit bar grows.
// Attached to the scene next to game-state.
// ---------------------------------------------------------------------------
AFRAME.registerComponent('levels', {
  schema: {
    baseKills: { default: CFG('levels.baseKills', 6) },   // targets to destroy on level 1
    killsStep: { default: CFG('levels.killsStep', 3) },   // +N to the goal each next level
    maxLevel: { default: CFG('levels.maxLevel', 10) },    // after clearing this level — victory
    bigRadius:   { default: CFG('levels.bigRadius', 0.4) },   // uniform target radius on level 1 (large)
    smallRadius: { default: CFG('levels.smallRadius', 0.18) } // uniform target radius on the last level (small)
  },

  init: function () {
    this.level = 1;
    this.kills = 0;
    this.killsNeeded = this.data.baseKills;
    this.finished = false;
    this.started = false;            // is the game running? not until START is shot
    this.el.gameStarted = false;     // flag for targets (target.init hides them while false)
    this.levelEl = document.querySelector('#hud-level');
    this.bannerEl = document.querySelector('#level-banner');
    this.boardEl = document.querySelector('#mission-board'); // front-wall panel
    this.startEl = document.querySelector('#start-button'); // START target in the center
    this.targets = null; // base target params are collected lazily (see applyDifficulty)

    // Per-level stats for the wall table (see recordLevel).
    this.statsEl = document.querySelector('#stats-board');
    this.levelStats = [];     // [{ level, hits, shots, acc, secs, score }]
    this.levelStartShots = 0; // snapshot of total shots at the level start
    this.levelStartElapsed = 0; // snapshot of total time (ms) at the level start
    this.levelStartScore = 0; // snapshot of total score at the level start

    this.render();
    this.showStart();         // wait for a shot at the START target

    // Each target destroyed brings us closer to the level goal.
    this.el.addEventListener('target-hit', () => {
      if (this.finished || !this.started) return;
      this.kills++;
      if (this.kills >= this.killsNeeded) {
        this.recordLevel();   // record the stats row for the cleared level
        if (this.level >= this.data.maxLevel) this.finishGame();
        else this.nextLevel();
      } else {
        this.render();
      }
    });
  },

  // Show/hide the central START target. The .target class is added/removed by the
  // start-button component itself (arm/disarm) — so a hidden target can't be
  // shot by the ray by accident during the game.
  showStart: function () {
    if (!this.startEl) return;
    this.startEl.setAttribute('visible', true);
    const sb = this.startEl.components['start-button'];
    if (sb) sb.arm();
  },
  hideStart: function () {
    if (!this.startEl) return;
    this.startEl.setAttribute('visible', false);
    const sb = this.startEl.components['start-button'];
    if (sb) sb.disarm();
  },

  // Record the stats of the just-cleared level and update the wall table. We
  // compute by the delta from the level-start snapshot: shots — from game-state,
  // time — from game-timer; hits = the level goal (this.kills).
  recordLevel: function () {
    const gs = this.el.components['game-state'];
    const tm = this.el.components['game-timer'];
    const shotsNow = gs ? gs.data.shots : 0;
    const elapsedNow = tm ? tm.elapsed : 0;
    const scoreNow = gs ? gs.data.score : 0;

    const hits = this.kills;
    const shots = Math.max(hits, shotsNow - this.levelStartShots); // no fewer than hits
    const acc = shots ? Math.round((hits / shots) * 100) : 0;
    const secs = Math.max(0, Math.round((elapsedNow - this.levelStartElapsed) / 1000));
    const score = Math.max(0, scoreNow - this.levelStartScore); // points earned during the level

    this.levelStats.push({ level: this.level, hits, shots, acc, secs, score });

    const st = this.statsEl && this.statsEl.components['stats-table'];
    if (st) st.setRows(this.levelStats);

    // Snapshot for the next level.
    this.levelStartShots = shotsNow;
    this.levelStartElapsed = elapsedNow;
    this.levelStartScore = scoreNow;
  },

  nextLevel: function () {
    this.level++;
    this.kills = 0;
    this.killsNeeded = this.data.baseKills + (this.level - 1) * this.data.killsStep;
    this.applyDifficulty();
    this.el.emit('level-changed'); // targets immediately adjust size to the new level
    this.render();
    this.setBannerStyle(0.62, 2.4);                // normal level banner style
    this.showBanner('LEVEL ' + this.level, true); // stays until the level changes
    SFX.levelup();
  },

  // Uniform radius of all targets on the current level: decreases linearly from
  // bigRadius (level 1) to smallRadius (last level). The size is fixed at spawn
  // time and is the same for all targets of the level regardless of their base geometry.
  currentTargetRadius: function () {
    const maxL = this.data.maxLevel;
    const t = maxL > 1 ? Math.min(1, (this.level - 1) / (maxL - 1)) : 0; // 0..1
    return this.data.bigRadius + (this.data.smallRadius - this.data.bigRadius) * t;
  },

  // Game completed: stop the targets and shooting, show the final banner.
  // After 10 s — show the START target again so the game can be replayed.
  finishGame: function () {
    this.finished = true;
    this.started = false;
    this.el.gameStarted = false;
    this.el.isGameOver = true;          // shooting is disabled while the result is shown

    // FIRST show the banner — before any side operations (emit/render/stats
    // computation). If any of them throws, it's silently swallowed by the
    // target-hit event dispatcher, but GAME OVER is already on the wall.
    this.setBannerStyle(0.41, 1.85);   // result — smaller (×1.5) and a line lower
    this.showBanner('GAME OVER', true);

    this.el.emit('game-stop');          // targets hide and don't respawn, timer stops
    try { MUSIC.stop(); } catch (e) { /* music is not critical */ }
    this.render();

    // Append the final stats to the banner (score, accuracy, time). In try — so
    // a computation failure doesn't "eat" the already-shown GAME OVER.
    let stats = '';
    try {
      const gs = this.el.components['game-state'];
      const d = gs && gs.data;
      const acc = d && d.shots ? Math.round((d.hits / d.shots) * 100) : 0;
      const tm = this.el.components['game-timer'];
      const timeStr = tm ? '   TIME: ' + tm.mmss() : '';
      stats = d ? '\nSCORE: ' + d.score + '   ACCURACY: ' + acc + '%' + timeStr : '';

      // Save the record to localStorage and update the High-Score banner above the table.
      const st = this.statsEl && this.statsEl.components['stats-table'];
      if (st && d && st.submitScore(d.score)) stats += '\nNEW HIGH SCORE!';

      this.showBanner('GAME OVER' + stats, true);
    } catch (e) {
      console.error('finishGame stats failed:', e);
    }
    try { SFX.levelup(); } catch (e) { /* sound is not critical */ }

    // After 10 s re-enable shooting and show the START target.
    clearTimeout(this._startAgainT);
    this._startAgainT = setTimeout(() => {
      this.el.isGameOver = false;
      this.showStart();
      this.showBanner('GAME OVER' + stats + '\nShoot START to play again', true);
    }, CFG('game.restartDelayMs', 10000));
  },

  // Start/restart the game on shooting the START target. Re-entry guard (double
  // shot): while started — ignore.
  startGame: function () {
    if (this.started) return;
    clearTimeout(this._startAgainT);
    this.finished = false;
    this.started = true;
    this.el.gameStarted = true;
    this.el.isGameOver = false;
    this.level = 1;
    this.kills = 0;
    this.killsNeeded = this.data.baseKills;

    this.hideStart();           // remove the START target for the duration of the game

    try { MUSIC.play(); } catch (e) { /* music is not critical */ }

    // Clear the stats table on the wall.
    this.levelStats = [];
    this.levelStartShots = 0;
    this.levelStartElapsed = 0;
    this.levelStartScore = 0;
    const st = this.statsEl && this.statsEl.components['stats-table'];
    if (st) st.setRows(this.levelStats);

    // Restore the targets' base params (level-1 difficulty).
    if (this.targets) {
      this.targets.forEach((t) => {
        const upd = { respawn: t.respawn };
        if (t.rarity < 1) upd.rarity = t.rarity;
        t.el.setAttribute('target', upd);
      });
    }

    clearBulletHoles();         // a clean wall for the new attempt
    this.el.emit('game-reset'); // zero the score/accuracy/timer
    this.el.emit('game-start'); // targets appear, the timer runs
    if (this.bannerEl) this.bannerEl.setAttribute('visible', false);
    this.render();
    this.setBannerStyle(0.62, 2.4);   // normal level banner style
    this.showBanner('LEVEL 1', true); // stays until the level changes
  },

  // Recompute all targets' params from their base values by the level number.
  applyDifficulty: function () {
    // Base values are collected on the first call — the targets are already initialized.
    if (!this.targets) {
      this.targets = Array.from(document.querySelectorAll('[target]')).map((el) => {
        const d = el.getAttribute('target');
        return { el: el, respawn: d.respawn, rarity: d.rarity };
      });
    }
    const lvl = this.level;
    const respawnFactor = Math.max(0.4, 1 - (lvl - 1) * 0.1); // faster respawn
    this.targets.forEach((t) => {
      const upd = { respawn: Math.round(t.respawn * respawnFactor) };
      if (t.rarity < 1) {
        // tough targets appear more often with the level
        upd.rarity = Math.min(0.9, t.rarity + (lvl - 1) * 0.08);
      }
      t.el.setAttribute('target', upd);
    });
  },

  // Banner style: font size (m/line) and height on the wall. The final GAME OVER
  // screen is smaller and lower than the LEVEL N banners.
  setBannerStyle: function (size, y) {
    if (!this.bannerEl) return;
    this.bannerEl.setAttribute('position', { x: 0, y: y, z: -9.8 });
    this.bannerEl.setAttribute('ctext', 'size', size);
  },

  // Show a banner on the wall. persist=true — don't hide automatically.
  showBanner: function (text, persist) {
    if (!this.bannerEl) return;
    this.bannerEl.setAttribute('ctext', 'value', text);
    this.bannerEl.setAttribute('visible', true);
    clearTimeout(this._bannerT);
    if (!persist) {
      this._bannerT = setTimeout(() => this.bannerEl.setAttribute('visible', false), 2200);
    }
  },

  render: function () {
    let txt;
    if (this.finished) txt = 'COMPLETE!   ' + this.data.maxLevel + '/' + this.data.maxLevel;
    else if (!this.started) txt = 'SHOOT  START';
    else txt = 'LEVEL ' + this.level + '   GOAL ' + this.kills + '/' + this.killsNeeded;
    if (this.levelEl) this.levelEl.setAttribute('ctext', 'value', txt);

    // Front-wall panel: how many targets remain until the level goal.
    const mb = this.boardEl && this.boardEl.components['mission-board'];
    if (mb) {
      let rem;
      if (this.finished) rem = '✓';
      else if (!this.started) rem = '—';
      else rem = Math.max(0, this.killsNeeded - this.kills);
      mb.setRemaining(rem);
    }
  }
});

// ---------------------------------------------------------------------------
// Scoring per hit. The score is higher the FASTER the target is destroyed after
// it appears and the FARTHER the shot was taken.
//   score = base × timeMult × distMult
//     timeMult: 2.0 on an instant hit → 1.0 if it took ≥ reactFull
//     distMult: 1.0 at the reference distance distRef, proportionally farther/closer
//                (clamped to [distMin, distMax] so it doesn't degenerate)
// The numbers live here — tweak the balance in one place.
// ---------------------------------------------------------------------------
const SCORING = {
  base:      CFG('scoring.base', 50),        // base points per hit
  reactFull: CFG('scoring.reactFull', 2500), // ms: up to this reaction time the speed bonus applies
  distRef:   CFG('scoring.distRef', 10),     // m: distance giving a ×1 multiplier
  distMin:   CFG('scoring.distMin', 0.5),    // lower bound of the distance multiplier (close shot)
  distMax:   CFG('scoring.distMax', 3.0),    // upper bound (very far shot)
  accMin:    CFG('scoring.accMin', 0.5),     // accuracy multiplier for a rim hit
  accMax:    CFG('scoring.accMax', 1.5),     // accuracy multiplier for a dead-center hit
  beatBonus: CFG('scoring.beatBonus', 25),   // flat bonus for a hit landing on the music beat

  // accuracyFrac: 0 (rim) .. 1 (dead center) — see target.hit(). onBeat: whether
  // the shot landed on a detected beat of the playing track (MUSIC.isOnBeat()).
  compute: function (reactionMs, distance, accuracyFrac, onBeat) {
    const rf = Math.max(0, 1 - reactionMs / this.reactFull); // 1 instant → 0
    const timeMult = 1 + rf;                                  // 1..2
    const distMult = Math.min(this.distMax,
      Math.max(this.distMin, distance / this.distRef));
    const af = Math.max(0, Math.min(1, accuracyFrac != null ? accuracyFrac : 1));
    const accMult = this.accMin + (this.accMax - this.accMin) * af;
    const bonus = onBeat ? this.beatBonus : 0;
    return Math.round(this.base * timeMult * distMult * accMult) + bonus;
  }
};

// ---------------------------------------------------------------------------
// Target entity: reacts to a hit, awards points, disappears and reappears in a
// new random spot.
// ---------------------------------------------------------------------------
AFRAME.registerComponent('target', {
  schema: {
    points: { default: 10 },
    respawn: { default: CFG('targets.respawn', 1200) }, // ms before reappearing
    health: { default: CFG('targets.health', 1) },      // how many hits are needed to destroy it
    rarity: { default: 1 },     // spawn probability on respawn (0..1): <1 — rarer
    lifetime: { default: 0 }    // ms "in view"; 0 — forever, otherwise it leaves and reappears on its own
  },

  init: function () {
    // the shot raycaster fires specifically against the .target class
    this.el.classList.add('target');
    this.maxHealth = this.data.health;
    this.hp = this.data.health;
    this.stopped = false;
    // Base color — for debris and damage indication.
    const mat = this.el.getAttribute('material');
    this.baseColor = (mat && mat.color) || '#E84A4A';

    // Base radius of the target geometry. The per-level size is made uniform for
    // all targets (levels.currentTargetRadius), scaling each from its base radius
    // to the level radius — see sizeScale().
    const geo = this.el.getAttribute('geometry');
    this.baseRadius = (geo && geo.radius) || 0.3;

    // Before the game starts (until the START target is shot) the targets are
    // hidden and don't appear. The game-start event reveals them. The
    // sceneEl.gameStarted flag is set by levels.
    if (this.el.sceneEl.gameStarted) {
      this.spawnInitial();
    } else {
      this.alive = false;
      this.el.setAttribute('visible', false);
      this.el.setAttribute('scale', '0 0 0');
    }

    // Stopping/resuming the game (victory on the last level → restart).
    this.el.sceneEl.addEventListener('game-stop', () => {
      this.stopped = true;
      this.alive = false;
      clearTimeout(this._respawnT);
      clearTimeout(this._lifeT);
      this.el.setAttribute('visible', false);
      this.el.setAttribute('scale', '0 0 0');
    });
    this.el.sceneEl.addEventListener('game-start', () => {
      this.stopped = false;
      this.respawn();
    });
    // Level change: live targets immediately adjust size to the new level.
    this.el.sceneEl.addEventListener('level-changed', () => {
      if (this.alive) this.applySize();
    });
  },

  // Scale that brings the target's base radius to the uniform radius of the
  // current level. If levels is unavailable — leave the target at its original size.
  sizeScale: function () {
    const lv = this.el.sceneEl.components.levels;
    const r = (lv && lv.currentTargetRadius) ? lv.currentTargetRadius() : this.baseRadius;
    return r / this.baseRadius;
  },

  // Apply the uniform level size to the target (uniformly on all axes).
  applySize: function () {
    const s = this.sizeScale();
    this.el.setAttribute('scale', s + ' ' + s + ' ' + s);
  },

  // Initial spawn: regular ones immediately, rare/tough ones — via rare spawn.
  spawnInitial: function () {
    if (this.data.rarity < 1) {
      this.alive = false;
      this.el.setAttribute('visible', false);
      this.el.setAttribute('scale', '0 0 0');
      this._respawnT = setTimeout(() => this.respawn(), this.data.respawn);
    } else {
      this.alive = true;
      this.applySize();
      this.relocate();
      this.spawnTime = performance.now(); // start of the reaction-time count for scoring
    }
  },

  // Called by the shot on a hit. distance — shot distance (m) from the raycaster
  // (origin → hit point); needed for scoring. point — world-space impact point
  // on the target surface (from the raycaster), used to originate the shard
  // burst where the bullet actually struck rather than at the target center.
  hit: function (sourceEl, distance, point) {
    if (!this.alive) return;

    const scene = this.el.sceneEl;
    const wp = new THREE.Vector3();
    this.el.object3D.getWorldPosition(wp);

    // Shards/rubble originate at the actual impact point, and scatter biased
    // outward along the center→impact direction (mostly the disc's face
    // plane), so a hit near the rim throws debris toward that rim.
    const origin = point || wp;
    let biasDir = null;
    let radialDist = 0;
    if (point) {
      biasDir = point.clone().sub(wp);
      radialDist = biasDir.length();
      if (biasDir.lengthSq() > 1e-6) biasDir.normalize(); else biasDir = null;
    }
    // How close to dead center the shot landed, 0 (rim/miss the disc) .. 1
    // (bullseye) — feeds SCORING.compute()'s accuracy multiplier.
    const effRadius = this.baseRadius * this.sizeScale();
    const accuracyFrac = effRadius > 0 ? 1 - Math.min(1, radialDist / effRadius) : 1;
    this.hp--;

    try { SFX.hit(wp); } catch (e) { /* sound is not critical for scoring */ }

    const onBeat = MUSIC.isOnBeat();
    if (onBeat) spawnBeatIndicator(scene, origin);

    if (this.hp > 0) {
      // Target still alive: damage flash, a few chipped shards, no points awarded.
      spawnShards(scene, origin, this.baseColor, 4, biasDir);
      spawnDebris(scene, origin, this.baseColor, 3, 0.015, 0.035, biasDir);
      this.flashDamage();
      return;
    }

    // Target destroyed. Points depend on the reaction time (since spawn), the
    // shot distance, how close to center it landed, and whether it was on the
    // music beat — see SCORING.compute().
    this.alive = false;
    clearTimeout(this._lifeT); // no more "time in view" needed
    const reactionMs = this.spawnTime != null ? performance.now() - this.spawnTime : 0;
    const dist = distance != null ? distance : SCORING.distRef; // fallback: neutral ×1
    const points = SCORING.compute(reactionMs, dist, accuracyFrac, onBeat);
    scene.emit('target-hit', { points: points });
    spawnShards(scene, origin, this.baseColor, 14, biasDir);
    spawnDebris(scene, origin, this.baseColor, 8, 0.015, 0.035, biasDir);

    // Remove the target instantly (scale 0 — rays no longer hit it).
    this.el.setAttribute('visible', false);
    this.el.setAttribute('scale', '0 0 0');

    this._respawnT = setTimeout(() => this.respawn(), this.data.respawn);
  },

  // We set the color DIRECTLY on the THREE material, not via setAttribute('material', ...).
  // A-Frame's material component update recomputes the texture from src; since the
  // targets' src is empty, it resets material.map to null — wiping the canvas rings
  // (target-rings). Editing mesh.material.color directly preserves the texture.
  setColor: function (hex) {
    const mesh = this.el.getObject3D('mesh');
    if (mesh && mesh.material && mesh.material.color) mesh.material.color.set(hex);
  },

  // White flash and color darkening proportional to the damage taken.
  flashDamage: function () {
    this.setColor('#FFFFFF');
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => {
      const frac = this.hp / this.maxHealth;           // 1 → 0 as damage accrues
      const c = new THREE.Color(this.baseColor);
      c.lerp(new THREE.Color('#2a0d0d'), 1 - frac);     // the lower the hp, the darker
      this.setColor('#' + c.getHexString());
    }, 80);
  },

  respawn: function () {
    if (this.stopped) return; // game stopped (victory) — don't respawn
    // Rare targets don't appear every cycle — retry later.
    if (this.data.rarity < 1 && Math.random() > this.data.rarity) {
      this._respawnT = setTimeout(() => this.respawn(), this.data.respawn);
      return;
    }
    this.hp = this.maxHealth;
    this.setColor(this.baseColor);
    this.el.setAttribute('visible', true);
    this.applySize();         // uniform level size (same for all targets)
    this.relocate();
    this.alive = true;
    this.spawnTime = performance.now(); // start of the reaction-time count for scoring

    // Limited "time in view": if not hit — it leaves and reappears.
    clearTimeout(this._lifeT);
    if (this.data.lifetime > 0) {
      this._lifeT = setTimeout(() => this.despawnIdle(), this.data.lifetime);
    }
  },

  // An un-hit target with a limited lifetime hides and enters the respawn cycle
  // (at a new spot) — so tough targets don't "get stuck".
  despawnIdle: function () {
    if (!this.alive || this.stopped) return;
    this.alive = false;
    this.el.setAttribute('visible', false);
    this.el.setAttribute('scale', '0 0 0');
    this._respawnT = setTimeout(() => this.respawn(), this.data.respawn);
  },

  // Random position within the "target wall". The area is wide — targets spread
  // across the whole wall (it's 16 m wide, x -8..8, height y -1..5).
  relocate: function () {
    const x = (Math.random() - 0.5) * 13;    // -6.5..6.5
    const y = 0.8 + Math.random() * 3.4;      // 0.8..4.2
    const z = -5 - Math.random() * 4.5;       // -5..-9.5
    this.el.setAttribute('position', { x, y, z });
  }
});

// ---------------------------------------------------------------------------
// Thumbstick locomotion. Attached to the rig (#rig).
//   Left stick  — movement relative to the gaze direction.
//   Right stick — snap turn by 30°.
// ---------------------------------------------------------------------------
AFRAME.registerComponent('locomotion', {
  schema: {
    speed: { default: 2.5 },          // m/s
    snapAngle: { default: 30 },       // degrees per click
    deadzone: { default: 0.15 }
  },

  init: function () {
    this.leftAxis = { x: 0, y: 0 };
    this.rightAxis = { x: 0, y: 0 };
    this.turned = false;

    this.q = new THREE.Quaternion();
    this.dir = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.move = new THREE.Vector3();

    this.cam = this.el.querySelector('[camera], a-camera');

    const left = this.el.querySelector('#leftHand');
    const right = this.el.querySelector('#rightHand');
    if (left) left.addEventListener('thumbstickmoved', (e) => { this.leftAxis = e.detail; });
    if (right) right.addEventListener('thumbstickmoved', (e) => { this.rightAxis = e.detail; });
  },

  tick: function (t, dt) {
    if (!dt || !this.cam) return;
    const dz = this.data.deadzone;

    // --- Movement (left stick) ---
    const ax = this.leftAxis.x;
    const ay = this.leftAxis.y;
    if (Math.abs(ax) > dz || Math.abs(ay) > dz) {
      // Horizontal gaze direction (camera's -Z, projected onto the floor).
      this.cam.object3D.getWorldQuaternion(this.q);
      this.dir.set(0, 0, -1).applyQuaternion(this.q);
      this.dir.y = 0;
      this.dir.normalize();
      // "Right" vector relative to the gaze.
      this.right.set(-this.dir.z, 0, this.dir.x);

      this.move.set(0, 0, 0);
      this.move.addScaledVector(this.dir, -ay); // stick forward (y<0) → forward
      this.move.addScaledVector(this.right, ax);
      if (this.move.lengthSq() > 1) this.move.normalize();

      this.el.object3D.position.addScaledVector(this.move, this.data.speed * dt / 1000);
    }

    // --- Snap turn (right stick) ---
    const rx = this.rightAxis.x;
    if (!this.turned && Math.abs(rx) > 0.6) {
      const step = THREE.MathUtils.degToRad(this.data.snapAngle);
      this.el.object3D.rotation.y -= Math.sign(rx) * step;
      this.turned = true;
    } else if (Math.abs(rx) < 0.3) {
      this.turned = false;
    }
  }
});

// ---------------------------------------------------------------------------
// Tracer: a glowing "bullet" flying from the muzzle to the hit point, after
// which it removes itself. Oriented along the flight direction.
// ---------------------------------------------------------------------------
AFRAME.registerComponent('tracer', {
  schema: {
    to: { type: 'vec3' },
    speed: { default: 70 } // m/s
  },

  init: function () {
    const obj = this.el.object3D;
    this.target = new THREE.Vector3(this.data.to.x, this.data.to.y, this.data.to.z);
    this.dir = this.target.clone().sub(obj.position);
    this.dist = this.dir.length();
    this.dir.normalize();
    this.traveled = 0;
    obj.lookAt(this.target); // the -Z-elongated "bullet" looks at the target
  },

  tick: function (t, dt) {
    if (!dt) return;
    const step = this.data.speed * dt / 1000;
    this.traveled += step;
    if (this.traveled >= this.dist) {
      if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
      return;
    }
    this.el.object3D.position.addScaledVector(this.dir, step);
  }
});

// Create a tracer from point `from` to point `to`.
function spawnTracer (sceneEl, from, to) {
  const tr = document.createElement('a-entity');
  tr.setAttribute('geometry', 'primitive: box; width: 0.02; height: 0.02; depth: 0.5');
  tr.setAttribute('material', 'color: #FFE066; emissive: #FFE066; emissiveIntensity: 1; shader: flat');
  tr.setAttribute('position', { x: from.x, y: from.y, z: from.z });
  tr.setAttribute('tracer', { to: { x: to.x, y: to.y, z: to.z } });
  sceneEl.appendChild(tr);
}

// ---------------------------------------------------------------------------
// Debris: flies ballistically with gravity, spins, bounces off the floor and
// fades toward the end of its life, then is removed.
// ---------------------------------------------------------------------------
AFRAME.registerComponent('debris', {
  schema: {
    velocity: { type: 'vec3' },
    angular: { type: 'vec3' },
    life: { default: 900 }
  },

  init: function () {
    this.age = 0;
    this.v = new THREE.Vector3(this.data.velocity.x, this.data.velocity.y, this.data.velocity.z);
  },

  tick: function (t, dt) {
    if (!dt) return;
    const d = dt / 1000;
    this.age += dt;

    this.v.y -= 9.8 * d; // gravity
    const p = this.el.object3D.position;
    p.addScaledVector(this.v, d);

    // debris rotation
    const r = this.el.object3D.rotation;
    r.x += this.data.angular.x * d;
    r.y += this.data.angular.y * d;
    r.z += this.data.angular.z * d;

    // bounce off the floor
    if (p.y < 0.03) {
      const impactSpeed = -this.v.y; // >0 if the debris was falling down
      p.y = 0.03;
      this.v.y *= -0.4;
      this.v.x *= 0.7;
      this.v.z *= 0.7;
      // a ringing impact only on a noticeable hit (not on small jitter);
      // p — the debris world position (debris lives at the scene root).
      if (impactSpeed > 0.6) {
        SFX.impact(Math.min(1, impactSpeed / 4), p);
      }
    }

    // removal + fade in the last third of the life
    const k = this.age / this.data.life;
    if (k >= 1) {
      if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
      return;
    }
    if (k > 0.66) {
      const mesh = this.el.getObject3D('mesh');
      if (mesh && mesh.material) {
        mesh.material.transparent = true;
        mesh.material.opacity = 1 - (k - 0.66) / 0.34;
      }
    }
  }
});

// Scatter `count` debris pieces from point pos. minSize/maxSize default to
// fist-sized rubble (concrete crumble); pass smaller values for fine pebbles.
// biasDir, if given, is a normalized outward direction (e.g. target
// center → impact point) blended into the scatter so debris flies toward
// the side that was actually hit, not just straight up.
function spawnDebris (sceneEl, pos, color, count, minSize, maxSize, biasDir) {
  minSize = minSize != null ? minSize : 0.05;
  maxSize = maxSize != null ? maxSize : 0.12;
  for (let i = 0; i < count; i++) {
    const f = document.createElement('a-entity');
    const s = minSize + Math.random() * (maxSize - minSize);
    f.setAttribute('geometry', `primitive: box; width: ${s}; height: ${s}; depth: ${s}`);
    f.setAttribute('material', `color: ${color}; emissive: ${color}; emissiveIntensity: 0.25`);
    f.setAttribute('position', { x: pos.x, y: pos.y, z: pos.z });

    // random scatter direction, biased upward (and outward from biasDir, if given)
    let vx = (Math.random() - 0.5) * 2;
    let vy = Math.random() * 1.5 + 0.8;
    let vz = (Math.random() - 0.5) * 2;
    if (biasDir) {
      vx += biasDir.x * 1.4;
      vy += biasDir.y * 0.6;
      vz += biasDir.z * 1.4;
    }
    const len = Math.hypot(vx, vy, vz) || 1;
    const speed = 1.6 + Math.random() * 2.4;

    f.setAttribute('debris', {
      velocity: { x: vx / len * speed, y: vy / len * speed, z: vz / len * speed },
      angular: {
        x: (Math.random() - 0.5) * 12,
        y: (Math.random() - 0.5) * 12,
        z: (Math.random() - 0.5) * 12
      },
      life: 800 + Math.random() * 500
    });
    sceneEl.appendChild(f);
  }
}

// A short-lived "⚡ Beat" popup shown above a target when a hit lands on the
// beat of the currently playing track (see MUSIC.isOnBeat() / music-beats.js).
// Rises and fades out, then self-removes — same disposable-entity pattern as
// debris/shards above, just driven by ctext (canvas text) instead of geometry.
// No rotation is set: like every other ctext panel in the scene (mission board,
// stats table, level banner), the plane's default +Z facing already points at
// the player — the targets' own "90 0 0" is specific to orienting their
// cylinder geometry and isn't a facing convention to copy onto a text plane.
function spawnBeatIndicator(sceneEl, pos) {
  const f = document.createElement('a-entity');
  f.setAttribute('position', { x: pos.x, y: pos.y + 0.15, z: pos.z });
  f.setAttribute('ctext', { value: '⚡\nBeat', color: '#FFD700', size: 0.22 });
  f.setAttribute('beat-indicator', {});
  sceneEl.appendChild(f);
}

AFRAME.registerComponent('beat-indicator', {
  schema: {
    life: { default: 750 },
    riseSpeed: { default: 0.4 } // m/s upward drift
  },

  init: function () {
    this.age = 0;
  },

  tick: function (t, dt) {
    if (!dt) return;
    this.age += dt;
    this.el.object3D.position.y += this.data.riseSpeed * (dt / 1000);

    // removal + fade in the last third of the life
    const k = this.age / this.data.life;
    if (k >= 1) {
      if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
      return;
    }
    if (k > 0.66) {
      const mesh = this.el.getObject3D('ctext');
      if (mesh && mesh.material) mesh.material.opacity = 1 - (k - 0.66) / 0.34;
    }
  }
});

// Scatter `count` triangular shards from point pos — the way a clay target
// breaks. Each shard is a chunky prism: a random triangle extruded ~2–4cm
// (ExtrudeGeometry), so it reads as a solid wedge of debris, not a flat
// plate. Physics/fade are reused from the debris component; only the
// geometry differs from spawnDebris. biasDir, if given, is a normalized
// outward direction (target center → impact point) blended into the
// scatter so shards fly toward the side that was actually hit.
function spawnShards (sceneEl, pos, color, count, biasDir) {
  for (let i = 0; i < count; i++) {
    const f = document.createElement('a-entity');

    // Random triangle profile: three vertices at ~120° around the center with
    // jittered angles and radii — every shard has its own shape.
    const r = 0.05 + Math.random() * 0.09;
    const a0 = Math.random() * Math.PI * 2;
    const shape = new THREE.Shape();
    for (let k = 0; k < 3; k++) {
      const a = a0 + k * (Math.PI * 2 / 3) + (Math.random() - 0.5) * 0.9;
      const rr = r * (0.55 + Math.random() * 0.75);
      if (k === 0) shape.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      else shape.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    const depth = 0.018 + Math.random() * 0.022; // wedge thickness, 18–40 mm
    const geo = new THREE.ExtrudeGeometry(shape, { depth: depth, bevelEnabled: false });
    geo.translate(0, 0, -depth / 2); // center the thickness on the entity origin
    const mat = new THREE.MeshStandardMaterial({
      color: color,
      emissive: color,
      emissiveIntensity: 0.25
    });
    f.setObject3D('mesh', new THREE.Mesh(geo, mat));
    f.setAttribute('position', { x: pos.x, y: pos.y, z: pos.z });

    // Scatter like debris: random direction, biased upward (and outward from biasDir, if given).
    let vx = (Math.random() - 0.5) * 2;
    let vy = Math.random() * 1.5 + 0.8;
    let vz = (Math.random() - 0.5) * 2;
    if (biasDir) {
      vx += biasDir.x * 1.4;
      vy += biasDir.y * 0.6;
      vz += biasDir.z * 1.4;
    }
    const len = Math.hypot(vx, vy, vz) || 1;
    const speed = 1.6 + Math.random() * 2.4;

    f.setAttribute('debris', {
      velocity: { x: vx / len * speed, y: vy / len * speed, z: vz / len * speed },
      angular: {
        x: (Math.random() - 0.5) * 12,
        y: (Math.random() - 0.5) * 12,
        z: (Math.random() - 0.5) * 12
      },
      life: 800 + Math.random() * 500
    });
    sceneEl.appendChild(f);
  }
}

// ---------------------------------------------------------------------------
// Casing: ejects from the pistol, flies ballistically, spins, bounces off the
// floor with a ring (ting.mp3) and fades. Similar to debris, but it sounds like
// a falling casing and rings only on the first floor touches.
// ---------------------------------------------------------------------------
AFRAME.registerComponent('casing', {
  schema: {
    velocity: { type: 'vec3' },
    angular: { type: 'vec3' },
    life: { default: 2400 }
  },

  init: function () {
    this.age = 0;
    this.v = new THREE.Vector3(this.data.velocity.x, this.data.velocity.y, this.data.velocity.z);
    this.bounces = 0;
  },

  tick: function (t, dt) {
    if (!dt) return;
    const d = dt / 1000;
    this.age += dt;

    this.v.y -= 9.8 * d; // gravity
    const p = this.el.object3D.position;
    p.addScaledVector(this.v, d);

    const r = this.el.object3D.rotation;
    r.x += this.data.angular.x * d;
    r.y += this.data.angular.y * d;
    r.z += this.data.angular.z * d;

    // bounce off the floor + casing ring (only on the first noticeable touches)
    if (p.y < 0.02) {
      const impactSpeed = -this.v.y;
      p.y = 0.02;
      this.v.y *= -0.35;
      this.v.x *= 0.6;
      this.v.z *= 0.6;
      if (impactSpeed > 0.4 && this.bounces < 1) {
        this.bounces++;
        SFX.casing(p, Math.min(1, impactSpeed / 3));
      }
    }

    const k = this.age / this.data.life;
    if (k >= 1) {
      if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
      return;
    }
    if (k > 0.7) {
      const mesh = this.el.getObject3D('mesh');
      if (mesh && mesh.material) {
        mesh.material.transparent = true;
        mesh.material.opacity = 1 - (k - 0.7) / 0.3;
      }
    }
  }
});

// Eject a casing from point pos, up-and-to-the-right relative to orientation quat.
function spawnCasing (sceneEl, pos, quat) {
  const c = document.createElement('a-entity');
  c.setAttribute('geometry', 'primitive: cylinder; radius: 0.006; height: 0.025');
  c.setAttribute('material',
    'color: #C8A032; metalness: 0.85; roughness: 0.3; emissive: #2a1f06; emissiveIntensity: 0.2');
  c.setAttribute('position', { x: pos.x, y: pos.y, z: pos.z });
  c.setAttribute('rotation', { x: 90, y: 0, z: 0 });

  // Right-up-back in the pistol's frame, with random spread.
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
  const vel = new THREE.Vector3();
  vel.addScaledVector(right, 1.2 + Math.random() * 0.6);
  vel.addScaledVector(up, 1.4 + Math.random() * 0.5);
  vel.addScaledVector(back, 0.3 + Math.random() * 0.3);

  // Offset the ejection direction relative to the player: 30° forward (rotation
  // about the "up" axis) and 20° up (rotation about the "right" axis).
  const DEG = Math.PI / 180;
  vel.applyAxisAngle(up, 30 * DEG);
  vel.applyAxisAngle(right, 20 * DEG);

  c.setAttribute('casing', {
    velocity: { x: vel.x, y: vel.y, z: vel.z },
    angular: {
      x: (Math.random() - 0.5) * 22,
      y: (Math.random() - 0.5) * 22,
      z: (Math.random() - 0.5) * 22
    },
    life: 2200 + Math.random() * 800
  });
  sceneEl.appendChild(c);
}

// ---------------------------------------------------------------------------
// Bullet holes on surfaces (wall, floor). A dark crater + a light chipped rim,
// oriented along the surface normal. They accumulate with a limit (old ones are
// removed), plus a spray of concrete crumble. This is "procedural" destruction
// without editing geometry — cheap for Quest.
// ---------------------------------------------------------------------------
const BULLET_HOLES = [];
const MAX_BULLET_HOLES = CFG('game.maxBulletHoles', 100);
const HOLE_Z = new THREE.Vector3(0, 0, 1);

function spawnBulletHole (sceneEl, point, normal) {
  const r = 0.04 + Math.random() * 0.03;

  const hole = document.createElement('a-entity');
  hole.setAttribute('geometry', 'primitive: circle; radius: ' + r.toFixed(3));
  hole.setAttribute('material',
    'color: #08080a; shader: flat; side: double; transparent: true; opacity: 0.97');
  hole.setAttribute('position', point.clone().addScaledVector(normal, 0.012 + Math.random() * 0.006));

  // Orientation: the plane's +Z axis along the surface normal.
  const e = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion().setFromUnitVectors(HOLE_Z, normal));
  hole.setAttribute('rotation', {
    x: THREE.MathUtils.radToDeg(e.x),
    y: THREE.MathUtils.radToDeg(e.y),
    z: THREE.MathUtils.radToDeg(e.z)
  });

  // Light chipped rim around the crater (slightly behind, so the crater is on top).
  const ring = document.createElement('a-entity');
  ring.setAttribute('geometry',
    'primitive: ring; radiusInner: ' + r.toFixed(3) + '; radiusOuter: ' + (r * 1.7).toFixed(3));
  ring.setAttribute('material', 'color: #2b2f3a; shader: flat; side: double; transparent: true; opacity: 0.55');
  ring.setAttribute('position', '0 0 -0.002');
  hole.appendChild(ring);

  sceneEl.appendChild(hole);

  BULLET_HOLES.push(hole);
  if (BULLET_HOLES.length > MAX_BULLET_HOLES) {
    const old = BULLET_HOLES.shift();
    if (old.parentNode) old.parentNode.removeChild(old);
  }

  // Concrete crumble from the impact.
  spawnDebris(sceneEl, point, '#3a3f4b', 5);
}

// Erase all holes (e.g. on game restart).
function clearBulletHoles () {
  while (BULLET_HOLES.length) {
    const h = BULLET_HOLES.pop();
    if (h.parentNode) h.parentNode.removeChild(h);
  }
}

// ---------------------------------------------------------------------------
// The pistol model is now an external GLB (Quaternius, CC0): models/pistol.glb,
// attached in index.html via <a-gltf-model> inside the .gun "hand". The muzzle
// flash (.muzzle-flash) is also defined in the markup next to the model; it's
// turned on by shoot.flash(). The procedural primitive model has been removed.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scene reload with a cache bust. We navigate to the same URL with a unique
// token ?cb=<time>: the document loads fresh, and the inline loader in
// index.html forwards the same token to game.js/assets — the cache doesn't get
// in the way. When possible we also clear Cache Storage (in case of a service worker).
// ---------------------------------------------------------------------------
function reloadWithCacheBust () {
  const go = function () {
    const base = location.href.split('?')[0].split('#')[0];
    location.replace(base + '?cb=' + Date.now());
  };
  if (window.caches && caches.keys) {
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(go, go);
  } else {
    go();
  }
}

// ---------------------------------------------------------------------------
// "RELOAD" target button: a normal target for the ray, but on a hit it doesn't
// score points — it reloads the scene with a cache bust. The target class is
// needed only so the shot raycaster catches it; there's no target component on it.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// START target: centered in front of the player. Shooting it starts the game
// (and restarts after completion). The .target class is added only when the
// target is "armed" (arm) and visible — a hidden one can't be shot by the ray.
// ---------------------------------------------------------------------------
AFRAME.registerComponent('start-button', {
  init: function () {
    // At app start we show exactly the START screen, so the target is "armed"
    // right away. After that the game is controlled by levels: hideStart()/showStart().
    this.used = false;
    this.el.classList.add('target');
  },
  arm: function () { this.used = false; this.el.classList.add('target'); },
  disarm: function () { this.el.classList.remove('target'); },
  hit: function () {
    if (this.used) return;           // one trigger per appearance
    this.used = true;
    const wp = new THREE.Vector3();
    this.el.object3D.getWorldPosition(wp);
    try { SFX.hit(wp); } catch (e) { /* sound is not critical */ }
    // No white flash: the target hides in this same frame (startGame → hideStart),
    // and the white color would "stick" until the next appearance.
    const lv = this.el.sceneEl.components['levels'];
    if (lv) lv.startGame();
  }
});

AFRAME.registerComponent('reload-button', {
  init: function () {
    this.used = false;
    this.el.classList.add('target'); // catchable by the ray, but without target logic
  },
  hit: function () {
    if (this.used) return;           // one trigger — otherwise a double shot would reload twice
    this.used = true;
    const wp = new THREE.Vector3();
    this.el.object3D.getWorldPosition(wp);
    SFX.hit(wp);                                       // ringing feedback
    this.el.setAttribute('material', 'color', '#FFFFFF'); // flash
    setTimeout(reloadWithCacheBust, 250);             // let the sound play out
  }
});

// ---------------------------------------------------------------------------
// Shooting: attached to a controller. On a trigger press it casts a ray forward,
// and if it hits a .target — it calls the target's hit().
// ---------------------------------------------------------------------------
AFRAME.registerComponent('shoot', {
  // Ray downward tilt (in radians), to match the tilted line of sight.
  PITCH: -55 * Math.PI / 180,

  init: function () {
    this.raycaster = new THREE.Raycaster();
    this.direction = new THREE.Vector3();
    this.origin = new THREE.Vector3();
    this.worldQuat = new THREE.Quaternion();
    this.shoot = this.shoot.bind(this);

    // Trigger on its own controller — only this hand fires.
    this.el.addEventListener('triggerdown', this.shoot);

    // Desktop mouse debugging: attach once (to the right hand) and only outside
    // VR, otherwise the bubbling mousedown from the laser-controls cursor duplicates shots.
    if (this.el.id === 'rightHand') {
      this.el.sceneEl.addEventListener('mousedown', () => {
        if (!this.el.sceneEl.is('vr-mode')) this.shoot();
      });
    }
  },

  shoot: function () {
    const scene = this.el.sceneEl;
    if (scene.isGameOver) return; // game completed — shooting is disabled until restart
    scene.emit('shot-fired');

    // Muzzle flash.
    this.flash();

    // Haptic kick on this hand's controller. Read live (never cached) — a Quest
    // hand can briefly disconnect/reconnect and swap its underlying controller
    // instance, which is exactly what makes a cached actuator go dead on one hand.
    this.vibrate(1.0, 60);

    // Ray from the controller position, tilted by PITCH downward relative to -Z.
    const obj = this.el.object3D;
    obj.getWorldPosition(this.origin);

    // Shot sound at the controller point. In try — so an audio failure never
    // aborts the hit computation below (otherwise "the score stops working").
    try { SFX.shot(this.origin); } catch (e) { /* sound is not critical */ }
    obj.getWorldQuaternion(this.worldQuat);
    this.direction
      .set(0, Math.sin(this.PITCH), -Math.cos(this.PITCH))
      .applyQuaternion(this.worldQuat);
    this.raycaster.set(this.origin, this.direction);

    // Nearest hit on a target.
    const targetMeshes = Array.from(document.querySelectorAll('.target'))
      .map(t => t.getObject3D('mesh'))
      .filter(Boolean);
    const tHit = this.raycaster.intersectObjects(targetMeshes, true)[0];

    // Nearest hit on a surface (wall/floor) — for bullet holes.
    const surfMeshes = Array.from(document.querySelectorAll('.surface'))
      .map(s => s.getObject3D('mesh'))
      .filter(Boolean);
    const sHit = this.raycaster.intersectObjects(surfMeshes, true)[0];

    // The target counts only if it's closer than the surface (stands in front of the wall).
    const targetFirst = tHit && (!sHit || tHit.distance <= sHit.distance);

    // Tracer end point.
    let end;
    if (targetFirst) {
      end = tHit.point.clone();
    } else if (sHit) {
      // Miss: we punch the surface — a hole along the normal at the impact point.
      end = sHit.point.clone();
      let n;
      if (sHit.face) {
        n = sHit.face.normal.clone().transformDirection(sHit.object.matrixWorld);
      } else {
        n = this.direction.clone().multiplyScalar(-1).normalize();
      }
      spawnBulletHole(scene, end, n);
      SFX.wallHit(end); // muffled impact of the bullet on concrete
    } else {
      end = this.origin.clone().addScaledVector(this.direction, 20);
    }

    // The tracer is purely visual (it doesn't affect hits/holes, those are already
    // computed by the ray above). We raise both of its ends by TRACER_RISE
    // vertically so the beam matches the line of sight (the controller pivot is
    // below the barrel). Both ends by the same amount → the line stays parallel to the shot.
    const TRACER_RISE = 0.04; // meters; larger — higher
    const rise = new THREE.Vector3(0, TRACER_RISE, 0);
    // The tracer starts slightly ahead of the muzzle so it doesn't "stick out" of the hand.
    const muzzle = this.origin.clone().addScaledVector(this.direction, 0.1).add(rise);
    spawnTracer(scene, muzzle, end.clone().add(rise));

    // Eject a casing up-and-to-the-right from the pistol (rings when it hits the floor).
    // In try — cosmetics must not interfere with the hit computation.
    try {
      spawnCasing(scene, this.origin.clone().addScaledVector(this.direction, 0.05), this.worldQuat);
    } catch (e) { /* casing is not critical */ }

    // Hit on a target.
    if (targetFirst) {
      let hitObj = tHit.object;
      let targetEl = hitObj.el;
      while (!targetEl && hitObj.parent) {
        hitObj = hitObj.parent;
        targetEl = hitObj.el;
      }
      if (targetEl && targetEl.components['start-button']) {
        targetEl.components['start-button'].hit(this.el);
      } else if (targetEl && targetEl.components['reload-button']) {
        targetEl.components['reload-button'].hit(this.el);
      } else if (targetEl && targetEl.components.target) {
        targetEl.components.target.hit(this.el, tHit.distance, tHit.point); // distance for scoring, point for the shard burst
      }
    }
  },

  // Haptic pulse on THIS hand's controller. Resolves the gamepad fresh each call
  // instead of caching it — the superframe haptics component's caching is what
  // breaks vibration on one hand after a hand reconnects (see issue.txt).
  vibrate: function (strength, duration) {
    const tc = this.el.components['tracked-controls-webxr'] ||
               this.el.components['tracked-controls'];
    if (!tc) return; // no controller (desktop/mouse debugging)
    // WebXR: tc.controller is the XRInputSource (gamepad on .gamepad).
    // WebVR fallback: tc.controller is already the Gamepad.
    const src = tc.controller;
    if (!src) return;
    const gamepad = src.gamepad || src;
    const actuators = gamepad && gamepad.hapticActuators;
    if (!actuators || !actuators.length) return;
    try { actuators[0].pulse(strength, duration); } catch (e) { /* haptics optional */ }
  },

  // A short flash at the "weapon's" muzzle.
  flash: function () {
    const muzzle = this.el.querySelector('.muzzle-flash');
    if (!muzzle) return;
    muzzle.setAttribute('visible', true);
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => muzzle.setAttribute('visible', false), 60);
  }
});
