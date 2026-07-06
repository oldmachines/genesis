/* ============================================================================
   Genesis Audio — interactive layer
   Everything you hear is synthesised in your browser with the Web Audio API.
   No copyrighted game audio ships with this page; the demos recreate the
   *behaviour* of the YM2612 FM chip and the SN76489 PSG (FM operators &
   algorithms, envelopes, the LFO, the 8-bit DAC, square + noise channels, the
   DAC "ladder effect") so you can hear the concepts, not the games.
   ============================================================================ */
'use strict';

/* -------------------------------------------------------- audio foundation */
const Engine = (() => {
  let ctx = null;
  let master = null, analyser = null;
  let current = null;
  let currentName = '—';
  let onState = () => {};

  function ac() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.7;
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.72;
      master.connect(analyser);
      analyser.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function stop() {
    if (current) {
      try { current.stop(); } catch (e) {}
      current = null;
    }
    onState({ playing: false, name: currentName });
  }

  /* play a group: {stop:fn, duration?} produced by a builder(ctx, dest) */
  function play(name, builder) {
    ac();
    stop();
    currentName = name;
    const group = builder(ctx, master);
    current = { stop() { group.stop && group.stop(); } };
    if (group.duration) {
      const t = setTimeout(() => {
        if (current) { current = null; onState({ playing: false, name: currentName }); }
      }, group.duration * 1000 + 60);
      const prevStop = current.stop;
      current.stop = () => { clearTimeout(t); prevStop(); };
    }
    if (navigator.mediaSession && window.MediaMetadata) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: name, artist: 'Inside the Sega Genesis — audio course',
        });
      } catch (e) {}
    }
    onState({ playing: true, name });
    return group;
  }

  return {
    ctx: ac,
    play, stop,
    get analyser() { return analyser; },
    get master() { return master; },
    setVolume(v) { if (master) master.gain.value = v; },
    subscribe(fn) { onState = fn; },
    get name() { return currentName; },
  };
})();

/* -------------------------------------------------------- helper: envelopes */
function adsr(ctx, gain, t0, dur, a = 0.008, r = 0.05, peak = 0.9) {
  const g = gain.gain;
  g.setValueAtTime(0.0001, t0);
  g.exponentialRampToValueAtTime(peak, t0 + a);
  g.setValueAtTime(peak, t0 + Math.max(a, dur - r));
  g.exponentialRampToValueAtTime(0.0001, t0 + dur);
}

/* per-operator envelope evaluated at time t (seconds). p = {a,dcy,sus,d2,rel} */
function envOp(t, dur, p) {
  const a = Math.max(0.0005, p.a), dcy = Math.max(0.0005, p.dcy), rel = Math.max(0.0005, p.rel);
  const sus = p.sus, d2 = p.d2 || 0;
  const kneeT = a + dcy;
  const relStart = Math.max(kneeT, dur - rel);
  if (t < a) return t / a;
  if (t < kneeT) return 1 - (1 - sus) * ((t - a) / dcy);
  if (t < relStart) return sus * Math.exp(-d2 * (t - kneeT));
  const lvlAtRel = sus * Math.exp(-d2 * (relStart - kneeT));
  if (t < dur) return lvlAtRel * (1 - (t - relStart) / rel);
  return 0;
}

/* ---------------------------------------------------------- 4-operator FM ---
   The heart of the course: a software model of the YM2612's FM engine. Four
   sine operators, connected by one of 8 algorithms, each with its own ratio,
   level and envelope; OP1 can feed back on itself. Rendered into an AudioBuffer
   so algorithms and feedback (which a Web Audio graph can't loop cleanly) are
   exact. Modulation is phase modulation, as on the real chip.                 */
const K_MOD = 6.0;    // modulation strength (radians per unit operator output)
function renderFM(ctx, opt) {
  const sr = ctx.sampleRate;
  const dur = opt.dur;
  const n = Math.floor(sr * dur);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const ops = opt.ops;                    // [{ratio, amp, env}] length 4
  const links = opt.links || [];          // [[from,to],...]
  const carriers = opt.carriers;
  const fb = opt.fb || 0;                 // 0..1
  const lfo = opt.lfo;                    // {rate, pm, am} | undefined
  const incoming = [[], [], [], []];
  links.forEach(([f, t]) => incoming[t].push(f));
  const inc = ops.map(o => 2 * Math.PI * opt.freq * o.ratio / sr);
  const ph = [0, 0, 0, 0];
  let last = [0, 0, 0, 0], prev = [0, 0, 0, 0];
  const cg = 1 / Math.max(1, carriers.length);
  let lph = 0;
  const linc = lfo ? 2 * Math.PI * lfo.rate / sr : 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let pmMul = 1, amMul = 1;
    if (lfo) {
      const s = Math.sin(lph);
      pmMul = 1 + lfo.pm * s;
      amMul = 1 - lfo.am * (0.5 + 0.5 * s);
      lph += linc;
    }
    const cur = [0, 0, 0, 0];
    for (let op = 0; op < 4; op++) {
      let mod = 0;
      const inl = incoming[op];
      for (let j = 0; j < inl.length; j++) mod += last[inl[j]] * K_MOD;
      if (op === 0 && fb > 0) mod += (last[0] + prev[0]) * 0.5 * fb * 3.2;
      const e = envOp(t, dur, ops[op].env);
      cur[op] = e * ops[op].amp * Math.sin(ph[op] + mod);
      ph[op] += inc[op] * pmMul;
    }
    let out = 0;
    for (let c = 0; c < carriers.length; c++) out += cur[carriers[c]];
    d[i] = out * cg * amMul * 0.92;
    prev = last; last = cur;
  }
  return buf;
}

/* play a rendered mono buffer through a destination */
function playBuffer(ctx, dest, buf, gain = 0.9) {
  const g = ctx.createGain(); g.gain.value = gain; g.connect(dest);
  const node = ctx.createBufferSource(); node.buffer = buf; node.connect(g);
  node.start(ctx.currentTime + 0.02);
  return { duration: buf.duration + 0.05, stop() { try { node.stop(); } catch (e) {} } };
}

/* the 8 YM2612 algorithms: operator links + carriers (ops 0..3 = OP1..OP4) */
const ALGOS = [
  { links: [[0, 1], [1, 2], [2, 3]], car: [3], desc: 'One deep stack: OP1→OP2→OP3→OP4, only OP4 heard. Complex, evolving — basses & leads.' },
  { links: [[0, 2], [1, 2], [2, 3]], car: [3], desc: 'OP1 and OP2 both modulate OP3, then OP3→OP4. Two modulators feeding one stack.' },
  { links: [[0, 3], [1, 2], [2, 3]], car: [3], desc: 'OP1→OP4 directly, while OP2→OP3→OP4. Two parallel paths into the carrier.' },
  { links: [[0, 1], [1, 3], [2, 3]], car: [3], desc: 'OP1→OP2→OP4, and OP3→OP4. A stack and a lone modulator meet at OP4.' },
  { links: [[0, 1], [2, 3]], car: [1, 3], desc: 'Two independent 2-op voices — OP1→OP2 and OP3→OP4 — summed. Fat, layered.' },
  { links: [[0, 1], [0, 2], [0, 3]], car: [1, 2, 3], desc: 'OP1 modulates OP2, OP3 and OP4 in parallel — three carriers. Rich & bright.' },
  { links: [[0, 1]], car: [1, 2, 3], desc: 'OP1→OP2 as one FM voice, plus OP3 and OP4 as bare sine carriers.' },
  { links: [], car: [0, 1, 2, 3], desc: 'No modulation — four carriers summed. Pure additive synthesis: organs & bells.' },
];

/* -------------------------------------------------------- signature chord  */
/* A warm FM major-9 swell — pure two-operator FM per note, no samples. */
function buildChord(ctx, dest) {
  const dur = 3.2, t0 = ctx.currentTime + 0.02;
  const notes = [130.81, 196.0, 261.63, 329.63, 392.0, 493.88];
  const bus = ctx.createGain();
  bus.gain.setValueAtTime(0.0001, t0);
  bus.gain.exponentialRampToValueAtTime(0.5, t0 + 1.3);
  bus.gain.setValueAtTime(0.5, t0 + 2.0);
  bus.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  bus.connect(dest);
  const nodes = [];
  notes.forEach((f, i) => {
    const car = ctx.createOscillator(); car.type = 'sine'; car.frequency.value = f;
    const mod = ctx.createOscillator(); mod.type = 'sine'; mod.frequency.value = f * 2;
    const mg = ctx.createGain(); mg.gain.value = f * 1.6;
    mod.connect(mg); mg.connect(car.frequency);
    const g = ctx.createGain(); g.gain.value = 0.16 / (1 + i * 0.15);
    car.connect(g); g.connect(bus);
    car.start(t0 + i * 0.09); mod.start(t0 + i * 0.09);
    car.stop(t0 + dur + 0.1); mod.stop(t0 + dur + 0.1);
    nodes.push(car, mod);
  });
  return { duration: dur + 0.15, stop() { nodes.forEach(o => { try { o.stop(); } catch (e) {} }); } };
}

/* -------------------------------------------------------- waveform lab     */
function buildTone(shape, freq, dur = 1.4) {
  return (ctx, dest) => {
    const t0 = ctx.currentTime + 0.02;
    const g = ctx.createGain(); g.connect(dest);
    adsr(ctx, g, t0, dur, 0.01, 0.12, 0.75);
    let node;
    if (shape === 'noise') {
      const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let s = 22695477;
      for (let i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = (s / 0x3fffffff) - 1; }
      node = ctx.createBufferSource(); node.buffer = buf;
    } else {
      node = ctx.createOscillator(); node.type = shape; node.frequency.value = freq;
    }
    node.connect(g);
    node.start(t0); node.stop(t0 + dur + 0.02);
    return { duration: dur + 0.05, stop() { try { node.stop(); } catch (e) {} } };
  };
}

/* -------------------------------------------------------- oscilloscope     */
function Scope(canvas, opts = {}) {
  const ctx2d = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let raf = null;
  const buf = new Uint8Array(2048);
  const freqBuf = new Uint8Array(1024);
  function resize() { const r = canvas.getBoundingClientRect(); canvas.width = r.width * dpr; canvas.height = r.height * dpr; }
  resize();
  window.addEventListener('resize', resize);
  function frame() {
    const a = Engine.analyser;
    const W = canvas.width, H = canvas.height;
    ctx2d.clearRect(0, 0, W, H);
    ctx2d.strokeStyle = 'rgba(80,92,120,0.16)'; ctx2d.lineWidth = 1;
    const cols = 12, rows = 4;
    for (let i = 1; i < cols; i++) { const x = W * i / cols; ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, H); ctx2d.stroke(); }
    for (let i = 1; i < rows; i++) { const y = H * i / rows; ctx2d.beginPath(); ctx2d.moveTo(0, y); ctx2d.lineTo(W, y); ctx2d.stroke(); }
    if (a) {
      if (opts.mode === 'bars') {
        a.getByteFrequencyData(freqBuf);
        const n = 64, bw = W / n;
        for (let i = 0; i < n; i++) {
          const v = freqBuf[Math.floor(i * 2)] / 255;
          const bh = v * H * 0.92;
          const hue = 8 + v * 40;            // red -> gold
          ctx2d.fillStyle = `hsl(${hue} 95% ${50 + v * 12}%)`;
          ctx2d.fillRect(i * bw + 1, H - bh, bw - 2, bh);
        }
      } else {
        a.getByteTimeDomainData(buf);
        ctx2d.lineWidth = 2 * dpr;
        ctx2d.strokeStyle = opts.color || '#3fb5ff';
        ctx2d.shadowColor = opts.color || '#3fb5ff';
        ctx2d.shadowBlur = 8 * dpr;
        ctx2d.beginPath();
        const slice = W / buf.length;
        for (let i = 0; i < buf.length; i++) {
          const y = (buf[i] / 255) * H, x = i * slice;
          i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
        }
        ctx2d.stroke();
        ctx2d.shadowBlur = 0;
      }
    }
    raf = requestAnimationFrame(frame);
  }
  frame();
  return { stop() { cancelAnimationFrame(raf); } };
}

/* -------------------------------------------------------- keyboard lab     */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', 'C'];
const IS_BLACK = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0];
function PianoLab(root) {
  const pad = root.querySelector('[data-piano]');
  let shape = 'triangle';
  const base = 261.63; // C4
  // build white keys as flow items, black keys absolutely positioned
  const whiteIdx = [], allKeys = [];
  for (let s = 0; s <= 12; s++) if (!IS_BLACK[s]) whiteIdx.push(s);
  const whiteCount = whiteIdx.length;
  whiteIdx.forEach((s, wi) => {
    const k = document.createElement('div');
    k.className = 'key white'; k.dataset.semi = s;
    k.innerHTML = '<span class="lbl">' + NOTE_NAMES[s] + '</span>';
    pad.appendChild(k); allKeys.push(k);
  });
  // black keys sit after white index positions 0,1,3,4,5 (C#,D#,F#,G#,A#)
  const blackAfterWhite = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };
  for (const s in blackAfterWhite) {
    const wpos = blackAfterWhite[s];
    const k = document.createElement('div');
    k.className = 'key black'; k.dataset.semi = s;
    k.style.left = ((wpos + 1) * (100 / whiteCount)) + '%';
    pad.appendChild(k); allKeys.push(k);
  }
  function playKey(semi) {
    const ctx = Engine.ctx(), dest = Engine.master;
    const freq = base * Math.pow(2, semi / 12);
    const t0 = ctx.currentTime + 0.005;
    if (shape === 'fm') {
      const buf = renderFM(ctx, {
        dur: 1.1, freq, links: [[0, 1]], carriers: [1], fb: 0,
        ops: [
          { ratio: 3.5, amp: 0.9, env: { a: 0.002, dcy: 0.7, sus: 0.0, d2: 0, rel: 0.3 } },
          { ratio: 1, amp: 1.0, env: { a: 0.002, dcy: 0.9, sus: 0.0, d2: 0, rel: 0.3 } },
        ],
      });
      playBuffer(ctx, dest, buf, 0.8);
    } else {
      const o = ctx.createOscillator(); o.type = shape; o.frequency.value = freq;
      const g = ctx.createGain(); g.connect(dest);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.28, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9);
      o.connect(g); o.start(t0); o.stop(t0 + 0.95);
    }
  }
  allKeys.forEach(k => {
    const semi = parseInt(k.dataset.semi, 10);
    const down = e => { e.preventDefault(); k.classList.add('down'); playKey(semi); };
    const up = () => k.classList.remove('down');
    k.addEventListener('pointerdown', down);
    k.addEventListener('pointerup', up);
    k.addEventListener('pointerleave', up);
    k.addEventListener('pointercancel', up);
  });
  root.querySelectorAll('[data-pkey-shape]').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('[data-pkey-shape]').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); shape = b.dataset.pkeyShape;
  }));
}

/* -------------------------------------------------------- additive lab     */
function AdditiveLab(root) {
  const holder = root.querySelector('[data-harm-sliders]');
  const N = 8;
  const sliders = [];
  const PRESETS = {
    sine: [1, 0, 0, 0, 0, 0, 0, 0],
    saw: [1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8],
    square: [1, 0, 1 / 3, 0, 1 / 5, 0, 1 / 7, 0],
    organ: [1, 0.55, 0, 0.35, 0, 0, 0.5, 0],
  };
  for (let i = 0; i < N; i++) {
    const cell = document.createElement('div');
    cell.className = 'hs' + (i === 0 ? ' fundamental' : '');
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = 0; inp.max = 100; inp.value = Math.round(PRESETS.saw[i] * 100);
    inp.setAttribute('aria-label', 'Harmonic ' + (i + 1));
    const lab = document.createElement('span'); lab.className = 'hn'; lab.textContent = (i + 1);
    cell.appendChild(inp); cell.appendChild(lab);
    holder.appendChild(cell); sliders.push(inp);
  }
  let osc = null, actx = null;
  function amps() { return sliders.map(s => parseFloat(s.value) / 100); }
  function makeWave(ctx) {
    const a = amps(); const real = new Float32Array(N + 1); const imag = new Float32Array(N + 1);
    for (let i = 0; i < N; i++) imag[i + 1] = a[i];
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }
  function refresh() { if (osc && actx) osc.setPeriodicWave(makeWave(actx)); }
  sliders.forEach(s => s.addEventListener('input', refresh));
  root.querySelectorAll('[data-harm-preset]').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('[data-harm-preset]').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    const p = PRESETS[b.dataset.harmPreset];
    sliders.forEach((s, i) => s.value = Math.round(p[i] * 100));
    refresh();
  }));
  Scope(root.querySelector('.scope'), { color: '#3fb5ff' });
  Scope(root.querySelector('.spectrum'), { mode: 'bars' });
  root.querySelector('[data-additive-play]').addEventListener('click', () => {
    Engine.play('Additive · harmonic stack', (ctx, dest) => {
      actx = ctx;
      const o = ctx.createOscillator(); o.setPeriodicWave(makeWave(ctx)); o.frequency.value = 196;
      const g = ctx.createGain(); g.connect(dest);
      const t0 = ctx.currentTime + 0.02;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.03);
      o.connect(g); o.start(t0); osc = o;
      return { stop() { try { o.stop(); } catch (e) {} osc = null; } };
    });
  });
}

/* -------------------------------------------------------- 2-operator FM    */
function FMLab(root) {
  const ratioR = root.querySelector('[data-fm-ratio]');
  const ratioV = root.querySelector('[data-fm-ratio-val]');
  const indexR = root.querySelector('[data-fm-index]');
  const indexV = root.querySelector('[data-fm-index-val]');
  Scope(root.querySelector('.scope'), { color: '#ff5347' });
  Scope(root.querySelector('.spectrum'), { mode: 'bars' });
  const fc = 220;
  let live = null, actx = null;
  const ratio = () => parseFloat(ratioR.value);
  const index = () => parseFloat(indexR.value);
  function labels() { ratioV.textContent = ratio().toFixed(2); indexV.textContent = index().toFixed(1); }
  function apply() {
    if (!live || !actx) return;
    const t = actx.currentTime, fm = fc * ratio();
    live.mod.frequency.setTargetAtTime(fm, t, 0.02);
    live.modGain.gain.setTargetAtTime(index() * fm, t, 0.02);
  }
  ratioR.addEventListener('input', () => { labels(); apply(); });
  indexR.addEventListener('input', () => { labels(); apply(); });
  labels();
  root.querySelector('[data-fm-play]').addEventListener('click', () => {
    live = Engine.play(`FM · ratio ${ratio().toFixed(2)} · index ${index().toFixed(1)}`, (ctx, dest) => {
      actx = ctx;
      const t0 = ctx.currentTime + 0.02;
      const car = ctx.createOscillator(); car.type = 'sine'; car.frequency.value = fc;
      const mod = ctx.createOscillator(); mod.type = 'sine'; mod.frequency.value = fc * ratio();
      const modGain = ctx.createGain(); modGain.gain.value = index() * fc * ratio();
      mod.connect(modGain); modGain.connect(car.frequency);
      const g = ctx.createGain(); g.connect(dest);
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.04);
      car.connect(g);
      car.start(t0); mod.start(t0);
      return { mod, modGain, stop() { try { car.stop(); mod.stop(); } catch (e) {} live = null; } };
    });
  });
}

/* -------------------------------------------------------- envelope lab     */
function buildEnvNote(a, d, s, r) {
  return (ctx, dest) => {
    const t0 = ctx.currentTime + 0.02, hold = 0.45, dur = a + d + hold + r;
    const peak = 0.85, sus = Math.max(0.0008, peak * s);
    const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 220;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; lp.Q.value = 0.6;
    const g = ctx.createGain(), gg = g.gain;
    gg.setValueAtTime(0.0001, t0);
    gg.linearRampToValueAtTime(peak, t0 + a);
    gg.linearRampToValueAtTime(sus, t0 + a + d);
    gg.setValueAtTime(sus, t0 + a + d + hold);
    gg.linearRampToValueAtTime(0.0001, t0 + a + d + hold + r);
    osc.connect(lp); lp.connect(g); g.connect(dest);
    osc.start(t0); osc.stop(t0 + dur + 0.03);
    return { duration: dur + 0.05, stop() { try { osc.stop(); } catch (e) {} } };
  };
}
function EnvelopeLab(root) {
  const canvas = root.querySelector('.env-canvas');
  const ctx2d = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const R = k => root.querySelector(`[data-${k}]`);
  const V = k => root.querySelector(`[data-${k}-val]`);
  const rs = { a: R('a'), d: R('d'), s: R('s'), r: R('r') };
  function vals() { return { a: +rs.a.value / 1000, d: +rs.d.value / 1000, s: +rs.s.value / 100, r: +rs.r.value / 1000 }; }
  function labels() { V('a').textContent = rs.a.value + ' ms'; V('d').textContent = rs.d.value + ' ms'; V('s').textContent = rs.s.value + ' %'; V('r').textContent = rs.r.value + ' ms'; }
  function draw() {
    const b = canvas.getBoundingClientRect();
    canvas.width = b.width * dpr; canvas.height = b.height * dpr;
    const W = canvas.width, H = canvas.height, pad = 10 * dpr;
    ctx2d.clearRect(0, 0, W, H);
    ctx2d.strokeStyle = 'rgba(80,92,120,0.28)'; ctx2d.lineWidth = 1;
    ctx2d.beginPath(); ctx2d.moveTo(pad, H - pad); ctx2d.lineTo(W - pad, H - pad); ctx2d.stroke();
    const v = vals(), hold = 0.45, total = v.a + v.d + hold + v.r || 1;
    const x = t => pad + (W - 2 * pad) * (t / total);
    const y = amp => (H - pad) - (H - 2 * pad) * amp;
    const pts = [[0, 0], [v.a, 1], [v.a + v.d, v.s], [v.a + v.d + hold, v.s], [total, 0]];
    ctx2d.beginPath(); ctx2d.moveTo(x(0), y(0));
    pts.forEach(p => ctx2d.lineTo(x(p[0]), y(p[1])));
    ctx2d.lineTo(x(total), y(0)); ctx2d.closePath();
    ctx2d.fillStyle = 'rgba(63,181,255,0.10)'; ctx2d.fill();
    ctx2d.beginPath(); ctx2d.moveTo(x(pts[0][0]), y(pts[0][1]));
    pts.slice(1).forEach(p => ctx2d.lineTo(x(p[0]), y(p[1])));
    ctx2d.strokeStyle = '#3fb5ff'; ctx2d.lineWidth = 2.4 * dpr; ctx2d.lineJoin = 'round'; ctx2d.stroke();
    ctx2d.fillStyle = '#ff5347';
    pts.forEach(p => { ctx2d.beginPath(); ctx2d.arc(x(p[0]), y(p[1]), 3.4 * dpr, 0, 7); ctx2d.fill(); });
  }
  Object.values(rs).forEach(el => el.addEventListener('input', () => { labels(); draw(); }));
  window.addEventListener('resize', draw);
  labels(); draw();
  root.querySelector('[data-env-play]').addEventListener('click', () => {
    const v = vals();
    Engine.play('Envelope · ADSR voice', buildEnvNote(v.a, v.d, v.s, v.r));
  });
}

/* -------------------------------------------------------- percussion lab   */
function NoiseLab(root) {
  const cutR = root.querySelector('[data-noise-cut]');
  const cutV = root.querySelector('[data-noise-cut-val]');
  let drum = 'hat';
  Scope(root.querySelector('.scope'), { color: '#ffc44d' });
  root.querySelectorAll('[data-drum]').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('[data-drum]').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); drum = b.dataset.drum;
  }));
  cutR.addEventListener('input', () => cutV.textContent = cutR.value + ' Hz');
  root.querySelector('[data-noise-play]').addEventListener('click', () => {
    Engine.play('Percussion · ' + drum, (ctx, dest) => {
      const t0 = ctx.currentTime + 0.02;
      const sr = ctx.sampleRate, len = Math.floor(sr * 0.5);
      const nbuf = ctx.createBuffer(1, len, sr); const nd = nbuf.getChannelData(0);
      let s = 12345;
      for (let i = 0; i < len; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; nd[i] = (s / 0x3fffffff) - 1; }
      const node = ctx.createBufferSource(); node.buffer = nbuf;
      const filt = ctx.createBiquadFilter();
      const cut = parseFloat(cutR.value);
      const g = ctx.createGain(); g.connect(dest);
      let dur;
      if (drum === 'hat') { filt.type = 'highpass'; filt.frequency.value = Math.max(3000, cut); dur = 0.08; }
      else if (drum === 'snare') { filt.type = 'bandpass'; filt.frequency.value = cut; filt.Q.value = 0.7; dur = 0.2; }
      else { filt.type = 'lowpass'; filt.frequency.value = Math.min(cut, 900); dur = 0.4; }
      node.connect(filt); filt.connect(g);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(drum === 'hat' ? 0.5 : 0.7, t0 + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      const extra = [];
      if (drum === 'tom' || drum === 'snare') {
        const o = ctx.createOscillator(); o.type = 'sine';
        const f0 = drum === 'tom' ? 180 : 250;
        o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(f0 * 0.5, t0 + dur);
        const og = ctx.createGain(); og.connect(dest);
        og.gain.setValueAtTime(0.0001, t0);
        og.gain.exponentialRampToValueAtTime(drum === 'tom' ? 0.6 : 0.25, t0 + 0.004);
        og.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(og); o.start(t0); o.stop(t0 + dur + 0.02); extra.push(o);
      }
      node.start(t0); node.stop(t0 + dur + 0.02);
      return { duration: dur + 0.05, stop() { try { node.stop(); extra.forEach(o => o.stop()); } catch (e) {} } };
    });
  });
}

/* -------------------------------------------------------- YM2612 patches   */
const PATCHES = {
  bass: {
    dur: 1.3, freq: 82.41, links: ALGOS[0].links, carriers: ALGOS[0].car, fb: 0.5,
    ops: [
      { ratio: 1, amp: 0.85, env: { a: 0.003, dcy: 0.25, sus: 0.4, d2: 0.4, rel: 0.15 } },
      { ratio: 1, amp: 0.7, env: { a: 0.003, dcy: 0.3, sus: 0.3, d2: 0.6, rel: 0.15 } },
      { ratio: 2, amp: 0.5, env: { a: 0.003, dcy: 0.2, sus: 0.2, d2: 0.8, rel: 0.15 } },
      { ratio: 1, amp: 1.0, env: { a: 0.003, dcy: 0.9, sus: 0.7, d2: 0.2, rel: 0.2 } },
    ],
  },
  brass: {
    dur: 1.5, freq: 233.08, links: ALGOS[3].links, carriers: ALGOS[3].car, fb: 0.2,
    ops: [
      { ratio: 1, amp: 0.9, env: { a: 0.05, dcy: 0.3, sus: 0.7, d2: 0.1, rel: 0.2 } },
      { ratio: 1, amp: 0.8, env: { a: 0.06, dcy: 0.3, sus: 0.75, d2: 0.1, rel: 0.2 } },
      { ratio: 2, amp: 0.7, env: { a: 0.05, dcy: 0.3, sus: 0.6, d2: 0.15, rel: 0.2 } },
      { ratio: 1, amp: 1.0, env: { a: 0.05, dcy: 0.4, sus: 0.85, d2: 0.05, rel: 0.25 } },
    ],
  },
  bell: {
    dur: 2.4, freq: 440, links: ALGOS[4].links, carriers: ALGOS[4].car, fb: 0,
    ops: [
      { ratio: 3.5, amp: 0.9, env: { a: 0.002, dcy: 1.4, sus: 0.0, d2: 0, rel: 0.6 } },
      { ratio: 1, amp: 1.0, env: { a: 0.002, dcy: 2.0, sus: 0.0, d2: 0, rel: 0.6 } },
      { ratio: 7.01, amp: 0.6, env: { a: 0.002, dcy: 0.8, sus: 0.0, d2: 0, rel: 0.4 } },
      { ratio: 2, amp: 1.0, env: { a: 0.002, dcy: 2.2, sus: 0.0, d2: 0, rel: 0.6 } },
    ],
  },
};
function YmLab(root) {
  Scope(root.querySelector('.scope'), { color: '#ff5347' });
  root.querySelectorAll('[data-patch]').forEach(b => b.addEventListener('click', () => {
    const name = b.dataset.patch;
    Engine.play('YM2612 · ' + name, (ctx, dest) => playBuffer(ctx, dest, renderFM(ctx, PATCHES[name]), 0.9));
  }));
}

/* -------------------------------------------------------- algorithm lab    */
function AlgoLab(root) {
  const canvas = root.querySelector('[data-algo-graph]');
  const c2 = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const descEl = root.querySelector('[data-algo-desc]');
  const fbR = root.querySelector('[data-algo-fb]');
  const fbV = root.querySelector('[data-algo-fb-val]');
  let algo = 0;
  const POS = [[0.30, 0.24], [0.70, 0.24], [0.30, 0.60], [0.70, 0.60]]; // OP1..OP4
  function draw() {
    const r = canvas.getBoundingClientRect();
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    const W = canvas.width, H = canvas.height;
    c2.clearRect(0, 0, W, H);
    const A = ALGOS[algo];
    const px = i => POS[i][0] * W, py = i => POS[i][1] * H, rad = 22 * dpr;
    // modulation arrows
    c2.strokeStyle = '#ff5347'; c2.fillStyle = '#ff5347'; c2.lineWidth = 2 * dpr;
    A.links.forEach(([f, t]) => arrow(c2, px(f), py(f) + rad * (py(t) > py(f) ? 1 : 0), px(t), py(t), rad));
    // feedback loop on OP1
    if (parseInt(fbR.value, 10) > 0) {
      c2.beginPath();
      c2.arc(px(0) - rad * 1.1, py(0) - rad * 0.2, rad * 0.7, -0.6, Math.PI + 0.4);
      c2.stroke();
    }
    // carrier -> OUT
    const outY = 0.90 * H;
    c2.strokeStyle = '#ffc44d'; c2.lineWidth = 2 * dpr;
    A.car.forEach(c => { c2.beginPath(); c2.moveTo(px(c), py(c) + rad); c2.lineTo(px(c), outY); c2.stroke(); });
    c2.fillStyle = 'rgba(255,196,77,.14)'; c2.fillRect(W * 0.18, outY, W * 0.64, 3 * dpr);
    c2.fillStyle = '#ffc44d'; c2.font = `600 ${11 * dpr}px ui-monospace,monospace`; c2.textAlign = 'center';
    c2.fillText('OUT', W * 0.5, outY + 16 * dpr);
    // operator nodes
    for (let i = 0; i < 4; i++) {
      const carrier = A.car.indexOf(i) >= 0;
      c2.beginPath(); c2.arc(px(i), py(i), rad, 0, 7);
      c2.fillStyle = carrier ? 'rgba(255,196,77,.18)' : 'rgba(255,83,71,.14)';
      c2.fill();
      c2.lineWidth = 2 * dpr; c2.strokeStyle = carrier ? '#ffc44d' : '#ff5347'; c2.stroke();
      c2.fillStyle = carrier ? '#ffc44d' : '#ff9a90';
      c2.font = `700 ${12 * dpr}px ui-monospace,monospace`; c2.textAlign = 'center'; c2.textBaseline = 'middle';
      c2.fillText('OP' + (i + 1), px(i), py(i));
    }
    c2.textBaseline = 'alphabetic';
    descEl.textContent = A.desc;
  }
  function arrow(ctx, x1, y1, x2, y2, rad) {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const ex = x2 - Math.cos(ang) * rad, ey = y2 - Math.sin(ang) * rad;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(ex, ey); ctx.stroke();
    const ah = 7 * dpr;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.cos(ang - 0.5) * ah, ey - Math.sin(ang - 0.5) * ah);
    ctx.lineTo(ex - Math.cos(ang + 0.5) * ah, ey - Math.sin(ang + 0.5) * ah);
    ctx.closePath(); ctx.fill();
  }
  root.querySelectorAll('[data-algo]').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('[data-algo]').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); algo = parseInt(b.dataset.algo, 10); draw();
  }));
  fbR.addEventListener('input', () => { fbV.textContent = fbR.value; draw(); });
  window.addEventListener('resize', draw);
  draw();
  root.querySelector('[data-algo-play]').addEventListener('click', () => {
    const A = ALGOS[algo], fb = parseInt(fbR.value, 10) / 7;
    const env = { a: 0.006, dcy: 0.5, sus: 0.55, d2: 0.25, rel: 0.35 };
    const ratios = [1, 2, 3, 1];
    const ops = ratios.map((rt, i) => ({ ratio: rt, amp: A.car.indexOf(i) >= 0 ? 1.0 : 0.85, env }));
    Engine.play('FM · algorithm ' + algo, (ctx, dest) =>
      playBuffer(ctx, dest, renderFM(ctx, { dur: 1.7, freq: 220, links: A.links, carriers: A.car, fb, ops }), 0.9));
  });
}

/* -------------------------------------------------------- 4-op env / TL lab */
function EnvLab2(root) {
  const board = root.querySelector('[data-tl-board]');
  const canvas = root.querySelector('.env-canvas');
  const c2 = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const A = ALGOS[1];                                   // OP1,OP2→OP3→OP4(carrier)
  const roles = ['modulator', 'modulator', 'modulator', 'carrier'];
  const tls = [];
  for (let i = 0; i < 4; i++) {
    const carrier = A.car.indexOf(i) >= 0;
    const op = document.createElement('div'); op.className = 'op' + (carrier ? ' carrier' : '');
    op.innerHTML = '<span class="on-tag">OP' + (i + 1) + '</span>';
    const inp = document.createElement('input'); inp.type = 'range'; inp.min = 0; inp.max = 127;
    inp.value = carrier ? 8 : [40, 55, 70, 0][i]; inp.setAttribute('aria-label', 'OP' + (i + 1) + ' total level');
    const tv = document.createElement('span'); tv.className = 'tv'; tv.textContent = 'TL ' + inp.value;
    const role = document.createElement('span'); role.className = 'role'; role.textContent = carrier ? 'carrier' : 'mod';
    inp.addEventListener('input', () => { tv.textContent = 'TL ' + inp.value; });
    op.appendChild(inp); op.appendChild(tv); op.appendChild(role);
    board.appendChild(op); tls.push(inp);
  }
  const S = k => root.querySelector('[data-e2-' + k + ']');
  const SV = k => root.querySelector('[data-e2-' + k + '-val]');
  const rs = { ar: S('ar'), d1: S('d1'), sl: S('sl'), d2: S('d2'), rr: S('rr') };
  function env() {
    const p = k => parseFloat(rs[k].value) / 100;
    return {
      a: 0.4 * (1 - p('ar')) + 0.003,
      dcy: 0.8 * (1 - p('d1')) + 0.02,
      sus: p('sl'),
      d2: p('d2') * 3.0,
      rel: 0.8 * (1 - p('rr')) + 0.02,
    };
  }
  function labels() { for (const k in rs) SV(k).textContent = rs[k].value + ' %'; }
  function draw() {
    const b = canvas.getBoundingClientRect();
    canvas.width = b.width * dpr; canvas.height = b.height * dpr;
    const W = canvas.width, H = canvas.height, pad = 12 * dpr;
    c2.clearRect(0, 0, W, H);
    c2.strokeStyle = 'rgba(80,92,120,0.28)'; c2.lineWidth = 1;
    c2.beginPath(); c2.moveTo(pad, H - pad); c2.lineTo(W - pad, H - pad); c2.stroke();
    const e = env(), dur = 1.6;
    c2.beginPath();
    for (let i = 0; i <= 200; i++) {
      const t = i / 200 * dur;
      const v = envOp(t, dur, e);
      const x = pad + (W - 2 * pad) * (t / dur), y = (H - pad) - (H - 2 * pad) * v;
      i === 0 ? c2.moveTo(x, y) : c2.lineTo(x, y);
    }
    c2.strokeStyle = '#3fb5ff'; c2.lineWidth = 2.4 * dpr; c2.lineJoin = 'round'; c2.stroke();
    c2.fillStyle = 'rgba(255,196,77,.6)'; c2.font = `600 ${10 * dpr}px ui-monospace,monospace`;
    c2.fillText('carrier envelope (AR·D1R·SL·D2R·RR)', pad + 4 * dpr, pad + 10 * dpr);
  }
  Object.values(rs).forEach(el => el.addEventListener('input', () => { labels(); draw(); }));
  window.addEventListener('resize', draw);
  labels(); draw();
  root.querySelector('[data-env2-play]').addEventListener('click', () => {
    const e = env();
    const ops = tls.map((s, i) => {
      const tl = parseFloat(s.value);
      const amp = Math.pow(10, -tl / 64);              // TL → level (bigger TL = quieter)
      return { ratio: [1, 2, 3, 1][i], amp: Math.max(0.0, amp), env: e };
    });
    Engine.play('YM2612 · 4-op patch', (ctx, dest) =>
      playBuffer(ctx, dest, renderFM(ctx, { dur: 1.7, freq: 220, links: A.links, carriers: A.car, fb: 0, ops }), 0.9));
  });
}

/* -------------------------------------------------------- LFO + DAC lab     */
function LfoDacLab(root) {
  Scope(root.querySelector('.scope'), { color: '#3fb5ff' });
  const rateR = root.querySelector('[data-lfo-rate]'), rateV = root.querySelector('[data-lfo-rate-val]');
  const pmR = root.querySelector('[data-lfo-pm]'), pmV = root.querySelector('[data-lfo-pm-val]');
  const amR = root.querySelector('[data-lfo-am]'), amV = root.querySelector('[data-lfo-am-val]');
  rateR.addEventListener('input', () => rateV.textContent = (+rateR.value).toFixed(1) + ' Hz');
  pmR.addEventListener('input', () => pmV.textContent = pmR.value + ' %');
  amR.addEventListener('input', () => amV.textContent = amR.value + ' %');
  root.querySelector('[data-lfo-play]').addEventListener('click', () => {
    const lfo = { rate: parseFloat(rateR.value), pm: parseFloat(pmR.value) / 100 * 0.05, am: parseFloat(amR.value) / 100 * 0.6 };
    const env = { a: 0.05, dcy: 0.3, sus: 0.8, d2: 0.05, rel: 0.3 };
    const ops = [
      { ratio: 1, amp: 0.9, env }, { ratio: 1, amp: 0.8, env },
      { ratio: 2, amp: 0.7, env }, { ratio: 1, amp: 1.0, env },
    ];
    Engine.play('YM2612 · LFO vibrato/tremolo', (ctx, dest) =>
      playBuffer(ctx, dest, renderFM(ctx, { dur: 2.4, freq: 233, links: ALGOS[3].links, carriers: ALGOS[3].car, fb: 0.2, ops, lfo }), 0.9));
  });
  root.querySelector('[data-dac-play]').addEventListener('click', () => {
    Engine.play('YM2612 · channel-6 DAC drum', (ctx, dest) => {
      const sr = ctx.sampleRate, dur = 0.45, n = Math.floor(sr * dur);
      const buf = ctx.createBuffer(1, n, sr); const d = buf.getChannelData(0);
      let s = 987654;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const thump = Math.sin(2 * Math.PI * 90 * Math.exp(-t * 6) * t * 6) * Math.exp(-t * 12);
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const noise = ((s / 0x3fffffff) - 1) * Math.exp(-t * 22);
        let v = 0.7 * thump + 0.5 * noise;
        // quantise to 8-bit to emulate the raw DAC feed
        v = Math.round(v * 127) / 127;
        d[i] = Math.max(-1, Math.min(1, v)) * 0.9;
      }
      return playBuffer(ctx, dest, buf, 0.95);
    });
  });
}

/* -------------------------------------------------------- PSG lab          */
const PSG_NOTES = { 'C4': 261.63, 'D4': 293.66, 'E4': 329.63, 'G4': 392.0, 'A4': 440.0, 'C5': 523.25, 'E5': 659.25, 'G5': 783.99, 'C3': 130.81, 'G3': 196.0 };
function PsgLab(root) {
  const board = root.querySelector('[data-psg-board]');
  const chans = [
    { name: 'Tone 1', note: 'C3', attn: 3, notes: ['C3', 'G3', 'C4', 'E4'] },
    { name: 'Tone 2', note: 'E4', attn: 5, notes: ['E4', 'G4', 'C5', 'A4'] },
    { name: 'Tone 3', note: 'G4', attn: 6, notes: ['G4', 'C5', 'E5', 'G5'] },
  ];
  const els = [];
  chans.forEach((ch, i) => {
    const div = document.createElement('div'); div.className = 'pch';
    const noteOpts = ch.notes.map(nn => `<option${nn === ch.note ? ' selected' : ''}>${nn}</option>`).join('');
    div.innerHTML = `<span class="pname">${ch.name}</span>
      <label>Note</label><select data-note>${noteOpts}</select>
      <label>Attenuation <span class="attn" data-attnv>${ch.attn}</span></label>
      <input type="range" min="0" max="15" value="${ch.attn}" data-attn aria-label="${ch.name} attenuation">`;
    board.appendChild(div); els.push(div);
  });
  const nz = document.createElement('div'); nz.className = 'pch noise';
  nz.innerHTML = `<span class="pname">Noise</span>
    <label>Mode</label><select data-nmode><option value="white">white</option><option value="periodic">periodic</option></select>
    <label>Attenuation <span class="attn" data-attnv>6</span></label>
    <input type="range" min="0" max="15" value="6" data-attn aria-label="Noise attenuation">`;
  board.appendChild(nz);
  board.querySelectorAll('[data-attn]').forEach(inp => inp.addEventListener('input', () => {
    inp.parentElement.querySelector('[data-attnv]').textContent = inp.value;
  }));
  const attnGain = a => (a >= 15 ? 0 : Math.pow(10, -a / 10));
  root.querySelector('[data-psg-play]').addEventListener('click', () => {
    Engine.play('SN76489 PSG · arrangement', (ctx, dest) => {
      const t0 = ctx.currentTime + 0.05, beat = 0.24, bars = 2, steps = 8 * bars;
      const oscs = [];
      // three square tone channels, gated in a little pattern
      els.forEach((div, ci) => {
        const freq = PSG_NOTES[div.querySelector('[data-note]').value] || 262;
        const a = parseInt(div.querySelector('[data-attn]').value, 10);
        const lvl = attnGain(a) * 0.18;
        const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = freq;
        const g = ctx.createGain(); g.gain.value = 0.0001; o.connect(g); g.connect(dest);
        for (let st = 0; st < steps; st++) {
          const on = ci === 0 ? (st % 2 === 0) : (st % 4 === ci);   // ch0 = bass pulse, ch1/2 = offbeat stabs
          const tt = t0 + st * beat;
          if (on && lvl > 0) {
            g.gain.setValueAtTime(0.0001, tt);
            g.gain.exponentialRampToValueAtTime(lvl, tt + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, tt + beat * 0.9);
          }
        }
        o.start(t0); o.stop(t0 + steps * beat + 0.2); oscs.push(o);
      });
      // noise hats
      const na = parseInt(nz.querySelector('[data-attn]').value, 10);
      const nlvl = attnGain(na) * 0.16;
      if (nlvl > 0) {
        const sr = ctx.sampleRate, ln = Math.floor(sr * 0.06);
        const nb = ctx.createBuffer(1, ln, sr); const nd = nb.getChannelData(0);
        const periodic = nz.querySelector('[data-nmode]').value === 'periodic';
        let s = 0xACE1;
        for (let i = 0; i < ln; i++) {
          // LFSR-ish: white = full random, periodic = coarse buzzy pattern
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          nd[i] = periodic ? (Math.floor(i / 12) % 2 ? 0.8 : -0.8) : (s / 0x3fffffff) - 1;
        }
        for (let st = 0; st < steps; st++) {
          const tt = t0 + st * beat;
          const node = ctx.createBufferSource(); node.buffer = nb;
          const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5000;
          const g = ctx.createGain(); g.gain.value = 0.0001;
          node.connect(hp); hp.connect(g); g.connect(dest);
          g.gain.setValueAtTime(nlvl, tt);
          g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.09);
          node.start(tt); node.stop(tt + 0.09);
        }
      }
      return { duration: steps * beat + 0.3, stop() { oscs.forEach(o => { try { o.stop(); } catch (e) {} }); } };
    });
  });
}

/* -------------------------------------------------------- ladder effect    */
function LadderLab(root) {
  Scope(root.querySelector('.scope'), { color: '#ffc44d' });
  function makeBass(ctx, ladder) {
    const env = { a: 0.004, dcy: 0.3, sus: 0.45, d2: 0.4, rel: 0.2 };
    const ops = [
      { ratio: 1, amp: 0.85, env }, { ratio: 1, amp: 0.6, env },
      { ratio: 2, amp: 0.4, env }, { ratio: 1, amp: 1.0, env },
    ];
    const buf = renderFM(ctx, { dur: 1.6, freq: 73.42, links: ALGOS[0].links, carriers: ALGOS[0].car, fb: 0.4, ops });
    const d = buf.getChannelData(0);
    // keep it quiet — the ladder effect is proportionally louder on soft signals
    for (let i = 0; i < d.length; i++) d[i] *= 0.42;
    if (ladder) {
      const g = 0.03;                                  // the zero-crossing gap
      for (let i = 0; i < d.length; i++) {
        const v = d[i];
        d[i] = v >= 0 ? v + g : v - g;
      }
    }
    return buf;
  }
  root.querySelectorAll('[data-ladder]').forEach(b => b.addEventListener('click', () => {
    const ladder = b.dataset.ladder === 'ladder';
    Engine.play('YM2612 DAC · ' + (ladder ? 'ladder effect' : 'clean'), (ctx, dest) =>
      playBuffer(ctx, dest, makeBass(ctx, ladder), 0.95));
  }));
}

/* ------------------------------------------------- animated flow diagrams  */
function FlowAnim(opts) {
  const svg = opts.svg, cap = opts.cap;
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (l) => {
    const p = svg.querySelector('#' + l.path);
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('r', l.r === undefined ? 5 : l.r);
    dot.setAttribute('fill', l.color || 'transparent');
    dot.setAttribute('opacity', '0');
    dot.style.pointerEvents = 'none';
    svg.appendChild(dot);
    return Object.assign({}, l, { el: p, len: p ? p.getTotalLength() : 0, dot });
  };
  const seqs = {};
  for (const name in opts.seqs) { const s = opts.seqs[name]; seqs[name] = { T: s.T, onLoop: s.onLoop, legs: s.legs.map(mk) }; }
  let raf = null, startT = 0, cur = null, looping = false, paused = false;
  function setGlow(sel, on) { const el = sel && svg.querySelector(sel); if (el) el.classList.toggle('fx-glow', on); }
  function clearAll() { for (const n in seqs) for (const l of seqs[n].legs) { l.dot.setAttribute('opacity', '0'); if (l.glow) setGlow(l.glow, false); } }
  function tick(now) {
    const s = seqs[cur];
    let t = (now - startT) / 1000;
    if (t >= s.T) {
      clearAll();
      if (looping) { if (s.onLoop) s.onLoop(); startT = now; raf = requestAnimationFrame(tick); return; }
      raf = null; if (opts.idleCap) cap.textContent = opts.idleCap; if (opts.onStop) opts.onStop(); return;
    }
    let text = ''; const glows = new Set();
    for (const l of s.legs) {
      if (!l.el) continue;
      if (t >= l.t0 && t <= l.t1) {
        const u = (t - l.t0) / (l.t1 - l.t0);
        const pt = l.el.getPointAtLength(u * l.len);
        l.dot.setAttribute('cx', pt.x); l.dot.setAttribute('cy', pt.y); l.dot.setAttribute('opacity', '1');
        if (l.glow) glows.add(l.glow);
        if (l.cap) text = l.cap;
      } else l.dot.setAttribute('opacity', '0');
    }
    for (const l of s.legs) if (l.glow) setGlow(l.glow, glows.has(l.glow));
    if (text) cap.textContent = text;
    raf = requestAnimationFrame(tick);
  }
  const api = {
    playing: () => !!raf || paused,
    start(name, loop) { api.stopQuiet(); cur = name; looping = !!loop; paused = false; startT = performance.now(); raf = requestAnimationFrame(tick); },
    stopQuiet() { if (raf) cancelAnimationFrame(raf); raf = null; paused = false; looping = false; clearAll(); },
    stop() { api.stopQuiet(); if (opts.idleCap) cap.textContent = opts.idleCap; if (opts.onStop) opts.onStop(); },
  };
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(es => es.forEach(e => {
      if (!e.isIntersecting && raf) { cancelAnimationFrame(raf); raf = null; paused = true; }
      else if (e.isIntersecting && paused) { paused = false; startT = performance.now(); raf = requestAnimationFrame(tick); }
    })).observe(svg);
  }
  return api;
}

function Z80Flow() {
  const fig = document.getElementById('z80-flow');
  if (!fig) return;
  const svg = fig.querySelector('svg');
  const cap = fig.querySelector('[data-anim-cap]');
  const btn = fig.querySelector('[data-z80-flow]');
  if (!svg || !btn || !svg.querySelector('#p-z80-play')) return;
  const B = '#3fb5ff', R = '#ff5347', G = '#ffc44d';
  const anim = FlowAnim({
    svg, cap,
    idleCap: 'Watch the Z80 drive the chips every frame — and the 68000 politely borrow the bus when it must.',
    onStop() { btn.textContent = '▶ Animate the bus handshake'; },
    seqs: {
      run: { T: 6.0, legs: [
        { path: 'p-z80-play', t0: 0.1, t1: 0.9, color: R, glow: '#g-z80chips', cap: '① Normally the Z80 streams notes into the YM2612 + PSG, frame after frame' },
        { path: 'p-z80-play', t0: 0.7, t1: 1.5, color: R, glow: '#g-z80chips' },
        { path: 'p-req', t0: 2.0, t1: 2.8, color: B, cap: '② The 68000 needs the sound bus, so it raises BUSREQ' },
        { path: 'p-grant', t0: 3.0, t1: 3.8, color: R, cap: '③ The Z80 finishes its cycle, pauses, and asserts BUSACK — the bus is free' },
        { path: 'p-68-chips', t0: 4.1, t1: 5.1, color: B, glow: '#g-z80chips', cap: '④ The 68000 accesses the chips directly, then releases BUSREQ so the Z80 resumes' },
      ]},
    },
  });
  btn.addEventListener('click', () => {
    if (anim.playing()) { anim.stop(); return; }
    btn.textContent = '⏸ Stop'; anim.start('run', true);
  });
}

/* -------------------------------------------------------- final quiz       */
function QuizLab(root) {
  const wrap = root.querySelector('[data-quiz]');
  const scoreEl = root.querySelector('[data-quiz-score]');
  const verdictEl = root.querySelector('[data-quiz-verdict]');
  const Q = [
    { s: 'You want the authentic gritty buzz on a Genesis bassline, especially on quiet notes.',
      o: ['Turn PSG volume up', 'Enable the YM2612 ladder effect (or the Nuked-OPN2 core)', 'Add reverb'], a: 1,
      e: 'That grit is the DAC ladder effect (Module 14) — a zero-crossing distortion the YM3438 later removed. The Nuked-OPN2 core reproduces it.' },
    { s: 'A tone starts bright and metallic, then mellows into a soft sine as it rings.',
      o: ['The PSG is fading', 'A modulator operator’s envelope decays faster than the carrier’s', 'The LFO rate is too high'], a: 1,
      e: 'On the YM2612 every operator has its own envelope (Module 09). A modulator that fades takes the harmonics with it — bright attack, mellow tail.' },
    { s: 'You need a real recorded drum / speech sample on the FM chip. Where does it come from?',
      o: ['PSG noise channel', 'Channel 6 switched to the 8-bit DAC', 'Algorithm 7'], a: 1,
      e: 'Channel 6 can drop its FM and become a raw 8-bit DAC (Module 10) — how the Genesis plays drums and the “SEGA!” shout.' },
    { s: 'A homebrew tune plays fine on an emulator but hangs on real hardware after loading music.',
      o: ['The FM ratio is wrong', 'The 68000 mis-handled the Z80 bus request', 'The PSG attenuation is 15'], a: 1,
      e: 'The 68000 and Z80 share the sound bus (Module 12). Get the BUSREQ/BUSACK handshake timing wrong and you get stuck notes or a hang.' },
    { s: 'You want a fat lead that’s two independent 2-operator voices layered together.',
      o: ['Algorithm 0 (one deep stack)', 'Algorithm 4 (two 2-op stacks summed)', 'Algorithm 7 (four sines)'], a: 1,
      e: 'Algorithm 4 wires OP1→OP2 and OP3→OP4 as two parallel voices (Module 08) — exactly two 2-op stacks, summed. Fat and layered.' },
    { s: 'On weak hardware the emulator’s Nuked-OPN2 core is too slow. What’s the trade-off if you switch cores?',
      o: ['You lose stereo', 'You get a faster, datasheet-accurate core that may miss subtle quirks', 'The PSG stops'], a: 1,
      e: 'Nuked models the silicon cycle-by-cycle (Module 13); the faster MAME-style core is datasheet-accurate but can miss quirks like the ladder effect.' },
  ];
  let score = 0, answered = 0;
  Q.forEach((q, qi) => {
    const card = document.createElement('div'); card.className = 'q-card';
    card.innerHTML = '<div class="q-s"><span class="q-n">' + (qi + 1) + '</span>' + q.s + '</div>'
      + '<div class="q-opts">' + q.o.map((o, i) => '<button data-i="' + i + '">' + o + '</button>').join('') + '</div>'
      + '<div class="q-exp" hidden></div>';
    const btns = card.querySelectorAll('button');
    btns.forEach(b => b.addEventListener('click', () => {
      if (card.classList.contains('done')) return;
      card.classList.add('done');
      const pick = parseInt(b.dataset.i, 10);
      btns.forEach((x, i) => { x.disabled = true; if (i === q.a) x.classList.add('good'); else if (i === pick) x.classList.add('bad'); });
      const exp = card.querySelector('.q-exp'); exp.hidden = false;
      exp.innerHTML = (pick === q.a ? '<strong class="yes">Exactly.</strong> ' : '<strong class="no">Not quite.</strong> ') + q.e;
      if (pick === q.a) score++;
      answered++;
      scoreEl.textContent = score + ' / ' + Q.length;
      if (answered === Q.length) {
        verdictEl.hidden = false;
        verdictEl.textContent = score === Q.length
          ? '6 / 6 — flawless. You could write a Genesis sound driver.'
          : score >= 4
            ? score + ' / 6 — solid. The explanations point at the modules worth a second read.'
            : score + ' / 6 — the whole course is above you, and now you know which modules to revisit.';
      }
    }));
    wrap.appendChild(card);
  });
}

/* ------------------------------------------------------- glossary tooltips */
function initTooltips() {
  const terms = [...document.querySelectorAll('.term[data-tip]')];
  if (!terms.length) return;
  const tip = document.createElement('div'); tip.className = 'tip-bubble'; tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let current = null;
  const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function place(el) {
    current = el;
    const label = el.textContent.trim().replace(/\s+/g, ' ');
    tip.innerHTML = '<span class="tt">' + esc(label) + '</span> — ' + esc(el.getAttribute('data-tip'));
    tip.classList.add('show');
    const r = el.getBoundingClientRect(); const tw = tip.offsetWidth, th = tip.offsetHeight, pad = 10;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - tw - pad));
    let top = r.top - th - 10, below = false;
    if (top < 8) { top = r.bottom + 10; below = true; }
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
    tip.classList.toggle('below', below);
    tip.style.setProperty('--arrow-x', (r.left + r.width / 2 - left) + 'px');
  }
  function hide(el) { if (!el || current === el) { tip.classList.remove('show'); current = null; } }
  terms.forEach(el => {
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    el.addEventListener('mouseenter', () => place(el));
    el.addEventListener('mouseleave', () => hide(el));
    el.addEventListener('focus', () => place(el));
    el.addEventListener('blur', () => hide(el));
    el.addEventListener('click', e => { e.stopPropagation(); current === el ? hide(el) : place(el); });
  });
  window.addEventListener('scroll', () => hide(current), true);
  window.addEventListener('resize', () => hide(current));
  document.addEventListener('click', () => hide(current));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(current); });
}

/* ------------------------------------------------------- scroll-spy nav    */
function scrollSpy() {
  const links = [...document.querySelectorAll('.toc a')];
  const map = new Map();
  links.forEach(a => { const id = a.getAttribute('href').slice(1); const el = document.getElementById(id); if (el) map.set(el, a); });
  const obs = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) { links.forEach(l => l.classList.remove('active')); const a = map.get(e.target); if (a) a.classList.add('active'); }
    });
  }, { rootMargin: '-20% 0px -72% 0px', threshold: 0 });
  map.forEach((_a, el) => obs.observe(el));
}

/* ------------------------------------------------------- reading progress  */
function readingProgress() {
  const fill = document.getElementById('progress-fill');
  const pct = document.getElementById('pct');
  const links = [...document.querySelectorAll('.toc a')];
  const modules = links.map(a => document.getElementById(a.getAttribute('href').slice(1))).filter(Boolean);
  let ticking = false;
  function update() {
    ticking = false;
    const doc = document.documentElement;
    const max = doc.scrollHeight - doc.clientHeight;
    const p = max > 0 ? Math.min(1, doc.scrollTop / max) : 0;
    if (fill) fill.style.width = (p * 100).toFixed(1) + '%';
    if (pct) pct.textContent = Math.round(p * 100) + '%';
    const mark = doc.clientHeight * 0.4;
    modules.forEach((el, i) => {
      const top = el.getBoundingClientRect().top;
      if (top < mark) links[i].classList.add('done'); else links[i].classList.remove('done');
    });
  }
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  window.addEventListener('resize', update);
  update();
}

/* ------------------------------------------------------- hero ambient scope */
function heroAmbient(canvas) {
  const c = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let t = 0, raf;
  function size() { const r = canvas.getBoundingClientRect(); canvas.width = r.width * dpr; canvas.height = r.height * dpr; }
  size(); window.addEventListener('resize', size);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function draw() {
    const W = canvas.width, H = canvas.height;
    c.clearRect(0, 0, W, H);
    const traces = [
      { col: 'rgba(63,181,255,0.9)', a: 0.30, f: 2.0, ph: 0 },
      { col: 'rgba(255,83,71,0.85)', a: 0.22, f: 3.3, ph: 1.1 },
      { col: 'rgba(255,196,77,0.7)', a: 0.16, f: 5.1, ph: 2.2 },
    ];
    traces.forEach(tr => {
      c.beginPath(); c.lineWidth = 1.6 * dpr; c.strokeStyle = tr.col; c.shadowColor = tr.col; c.shadowBlur = 10 * dpr;
      for (let x = 0; x <= W; x += 4 * dpr) {
        const p = x / W, env = Math.sin(p * Math.PI);
        const y = H / 2 + Math.sin(p * Math.PI * 2 * tr.f + t + tr.ph) * H * tr.a * env
                        + Math.sin(p * Math.PI * 2 * tr.f * 2.7 + t * 1.3) * H * tr.a * 0.25 * env;
        x === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
      }
      c.stroke();
    });
    c.shadowBlur = 0;
    t += reduce ? 0 : 0.018;
    raf = requestAnimationFrame(draw);
    if (reduce) cancelAnimationFrame(raf);
  }
  draw();
}

const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

/* ==========================================================================
   Wire-up
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  const heroCanvas = document.getElementById('hero-scope');
  if (heroCanvas) heroAmbient(heroCanvas);

  /* player bar */
  const ppBtn = document.getElementById('pp');
  const playerViz = document.getElementById('player-viz');
  const nowTrack = document.getElementById('now-track');
  const vol = document.getElementById('vol');
  Scope(playerViz, { mode: 'bars' });
  let _playing = false;
  Engine.subscribe(({ playing, name }) => {
    _playing = playing;
    nowTrack.textContent = playing ? name : 'Nothing playing';
    ppBtn.setAttribute('aria-label', playing ? 'Stop' : 'Play');
    ppBtn.innerHTML = playing ? ICON_STOP : ICON_PLAY;
  });
  ppBtn.addEventListener('click', () => { if (_playing) Engine.stop(); else Engine.play('FM chord', buildChord); });
  vol.addEventListener('input', () => Engine.setVolume(parseFloat(vol.value) / 100));

  const chordBtn = document.getElementById('play-chord');
  if (chordBtn) chordBtn.addEventListener('click', () => Engine.play('FM chord', buildChord));

  /* Part I labs */
  const wl = document.getElementById('lab-wave');
  if (wl) {
    Scope(wl.querySelector('.scope'), { color: '#3fb5ff' });
    const freqR = wl.querySelector('[data-wave-freq]'), freqV = wl.querySelector('[data-wave-freq-val]');
    let shape = 'sine';
    wl.querySelectorAll('.seg-btns button').forEach(b => b.addEventListener('click', () => {
      wl.querySelectorAll('.seg-btns button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); shape = b.dataset.shape;
    }));
    freqR.addEventListener('input', () => freqV.textContent = freqR.value + ' Hz');
    wl.querySelector('[data-wave-play]').addEventListener('click', () =>
      Engine.play(`Waveform · ${shape} @ ${freqR.value} Hz`, buildTone(shape, parseFloat(freqR.value))));
  }
  const pl = document.getElementById('lab-pitch'); if (pl) PianoLab(pl);
  const ad = document.getElementById('lab-additive'); if (ad) AdditiveLab(ad);
  const fm = document.getElementById('lab-fm'); if (fm) FMLab(fm);
  const ev = document.getElementById('lab-env'); if (ev) EnvelopeLab(ev);
  const nz = document.getElementById('lab-noise'); if (nz) NoiseLab(nz);

  /* Part II labs */
  const ym = document.getElementById('lab-ym'); if (ym) YmLab(ym);
  const al = document.getElementById('lab-algo'); if (al) AlgoLab(al);
  const e2 = document.getElementById('lab-env2'); if (e2) EnvLab2(e2);
  const ld = document.getElementById('lab-lfo'); if (ld) LfoDacLab(ld);
  const ps = document.getElementById('lab-psg'); if (ps) PsgLab(ps);
  Z80Flow();

  /* Part III labs */
  const lad = document.getElementById('lab-ladder'); if (lad) LadderLab(lad);
  const qz = document.getElementById('lab-quiz'); if (qz) QuizLab(qz);

  /* plumbing */
  initTooltips();
  scrollSpy();
  readingProgress();

  /* mobile menu */
  const mb = document.getElementById('menu-btn');
  const sb = document.getElementById('sidebar');
  const scrim = document.getElementById('scrim');
  const closeMenu = () => { sb.classList.remove('open'); scrim.classList.remove('show'); };
  mb.addEventListener('click', () => { sb.classList.toggle('open'); scrim.classList.toggle('show'); });
  scrim.addEventListener('click', closeMenu);
  sb.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMenu));
});
