/* ============================================================================
   Genesis Cartridges — interactive layer
   Everything you see is simulated in your browser with the Canvas API.
   No game data ships with this page; the labs recreate cartridge *behaviour*
   (ROM readout, bus cycles, endianness, the 68000 memory map, the header,
   bank switching and lock-on) so you can watch the concepts, not the games.
   ============================================================================ */
'use strict';

/* ------------------------------------------------------------- helpers */

const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* devicePixelRatio-aware canvas sizing. The CSS height is fixed in the
   stylesheet (see the .scope comment there); we only sync the bitmap. */
function labCanvas(canvas) {
  const c = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let onResize = null;
  function resize() {
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    if (onResize) onResize();
  }
  resize();
  window.addEventListener('resize', resize);
  return {
    c, dpr,
    get W() { return canvas.width; },
    get H() { return canvas.height; },
    set onresize(fn) { onResize = fn; },
  };
}

/* Pause off-screen animations: each lab's rAF loop checks vis.visible and
   skips its drawing work while the lab is scrolled out of view. */
function watchVisibility(el) {
  const state = { visible: true };
  if ('IntersectionObserver' in window) {
    state.visible = false;
    const io = new IntersectionObserver(
      entries => entries.forEach(e => { state.visible = e.isIntersecting; }),
      { rootMargin: '120px' }
    );
    io.observe(el);
  }
  return state;
}

/* pointer position in canvas (device-pixel) coordinates */
function canvasPos(canvas, e, dpr) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * dpr,
    y: (e.clientY - r.top) * dpr,
  };
}

/* tiny deterministic pseudo-random generator (the same trick a mask-ROM
   test pattern or a mastering tool's junk fill would use) */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/* palette (mirrors the CSS custom properties — Genesis: red / blue / gold) */
const PAL = {
  red: '#ff5347', blue: '#3fb5ff', gold: '#ffc44d', amber: '#ff9d3c',
  good: '#4fd08a', bad: '#ff5f5f', ink: '#eef1f8', ink2: '#b3b9cc',
  muted: '#7e8599', line: '#262b3a', line2: '#343a4d',
  panel: '#14161f', panel2: '#1b1e2a', panel3: '#232736', ground: '#0a0b10',
  // aliases so shared drawing code reads naturally
  get violet() { return this.red; }, get cyan() { return this.blue; }, get magenta() { return this.gold; },
};

function grid(c, W, H, cols, rows) {
  c.strokeStyle = 'rgba(80,92,120,0.16)';
  c.lineWidth = 1;
  for (let i = 1; i < cols; i++) { const x = W * i / cols; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
  for (let i = 1; i < rows; i++) { const y = H * i / rows; c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
}

const hx = (n, w) => n.toString(16).toUpperCase().padStart(w || 2, '0');

/* ==========================================================================
   Lab 01 — ROM scope: clock an address in, watch the data byte appear
   ========================================================================== */
function RomLab(root) {
  const canvas = root.querySelector('canvas');
  const { c, dpr } = labCanvas(canvas);
  const vis = watchVisibility(root);

  // a 256-byte mask ROM, contents fixed at fabrication (deterministic)
  const rng = makeRng(0x5E6A0001);
  const ROM = new Uint8Array(256);
  for (let i = 0; i < 256; i++) ROM[i] = Math.floor(rng() * 256);

  let addr = 0;            // 8-bit address on the bus
  let sweep = false;       // auto-increment like a CPU walking memory
  let pulse = 1;           // read-strobe animation 0..1
  let lastAddr = -1;

  const addrR = root.querySelector('[data-rom-addr]');
  const aEl = root.querySelector('[data-rom-a]');
  const dEl = root.querySelector('[data-rom-d]');
  addrR.addEventListener('input', () => { addr = parseInt(addrR.value, 10) & 0xff; sweep = false; syncSweepBtns(); });
  root.querySelector('[data-rom-clock]').addEventListener('click', () => { addr = (addr + 1) & 0xff; addrR.value = addr; sweep = false; syncSweepBtns(); });
  function syncSweepBtns() {
    root.querySelectorAll('[data-rom-sweep]').forEach(b => b.classList.toggle('on', (b.dataset.romSweep === 'on') === sweep));
  }
  root.querySelectorAll('[data-rom-sweep]').forEach(b => b.addEventListener('click', () => {
    sweep = b.dataset.romSweep === 'on'; syncSweepBtns();
  }));
  syncSweepBtns();

  function bits(c, x, y, val, n, w, on, label) {
    c.font = `600 ${9.5 * dpr}px ui-monospace, monospace`;
    c.fillStyle = PAL.muted;
    c.fillText(label, x, y - 6 * dpr);
    for (let i = 0; i < n; i++) {
      const b = (val >> (n - 1 - i)) & 1;
      const bx = x + i * (w + 3 * dpr);
      c.fillStyle = b ? on : PAL.panel3;
      c.strokeStyle = b ? on : PAL.line2;
      c.lineWidth = 1 * dpr;
      c.beginPath(); c.roundRect(bx, y, w, w, 3 * dpr); c.fill(); c.stroke();
      c.fillStyle = b ? '#0a0b10' : PAL.muted;
      c.font = `700 ${9 * dpr}px ui-monospace, monospace`;
      c.fillText(b, bx + w * 0.32, y + w * 0.68);
    }
    return n * (w + 3 * dpr);
  }

  let raf, last = 0, acc = 0;
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (!vis.visible) { last = ts; return; }
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts;
    if (sweep && !REDUCE_MOTION) { acc += dt; if (acc > 0.28) { acc = 0; addr = (addr + 1) & 0xff; addrR.value = addr; } }
    if (addr !== lastAddr) { pulse = 0; lastAddr = addr; }
    if (pulse < 1) pulse = Math.min(1, pulse + dt / 0.28);

    const W = canvas.width, H = canvas.height;
    const data = ROM[addr];
    c.clearRect(0, 0, W, H);
    grid(c, W, H, 12, 4);

    // ---- address bus (top) -----------------------------------------------
    const bw = Math.min(20 * dpr, (W * 0.42) / 8 - 3 * dpr);
    bits(c, W * 0.06, H * 0.12, addr, 8, bw, PAL.red, 'ADDRESS  A7 … A0');
    c.font = `700 ${13 * dpr}px ui-monospace, monospace`;
    c.fillStyle = PAL.red;
    c.fillText('$' + hx(addr, 2), W * 0.06 + 8 * (bw + 3 * dpr) + 12 * dpr, H * 0.12 + bw * 0.72);

    // ---- the ROM array (middle) as 16x16 cells ----------------------------
    const gx = W * 0.06, gy = H * 0.30, gw = W * 0.5, gh = H * 0.5;
    const cw = gw / 16, ch = gh / 16;
    const row = addr >> 4, col = addr & 15;
    c.font = `600 ${9 * dpr}px ui-monospace, monospace`;
    c.fillStyle = PAL.muted;
    c.fillText('MASK ROM CELL ARRAY — 256 bytes (row = A7..A4, col = A3..A0)', gx, gy - 7 * dpr);
    for (let r = 0; r < 16; r++) for (let k = 0; k < 16; k++) {
      const sel = r === row && k === col;
      const rowSel = r === row, colSel = k === col;
      const x = gx + k * cw, y = gy + r * ch;
      c.fillStyle = sel ? PAL.red : (rowSel || colSel ? 'rgba(63,181,255,0.10)' : 'rgba(120,130,160,0.05)');
      c.beginPath(); c.roundRect(x + 1 * dpr, y + 1 * dpr, cw - 2 * dpr, ch - 2 * dpr, 2 * dpr); c.fill();
      if (sel) {
        c.fillStyle = '#0a0b10';
        c.font = `700 ${8.5 * dpr}px ui-monospace, monospace`;
        c.fillText(hx(ROM[r * 16 + k], 2), x + cw * 0.14, y + ch * 0.66);
      }
    }
    // decoder highlight lines
    c.strokeStyle = 'rgba(255,83,71,0.35)'; c.lineWidth = 1 * dpr;
    c.strokeRect(gx, gy + row * ch, gw, ch);
    c.strokeRect(gx + col * cw, gy, cw, gh);

    // ---- sense / read strobe animation to the data bus --------------------
    const cellCx = gx + col * cw + cw / 2, cellCy = gy + row * ch + ch / 2;
    const dbx = W * 0.62, dby = H * 0.56;
    c.strokeStyle = pulse < 1 ? PAL.gold : PAL.line2;
    c.lineWidth = (pulse < 1 ? 2.4 : 1.2) * dpr;
    c.beginPath(); c.moveTo(cellCx, cellCy); c.lineTo(dbx - 10 * dpr, dby); c.stroke();
    if (pulse < 1) {
      const px = cellCx + (dbx - 10 * dpr - cellCx) * pulse;
      const py = cellCy + (dby - cellCy) * pulse;
      c.fillStyle = PAL.gold; c.shadowColor = PAL.gold; c.shadowBlur = 10 * dpr;
      c.beginPath(); c.arc(px, py, 4.5 * dpr, 0, 7); c.fill(); c.shadowBlur = 0;
    }

    // ---- data bus (right) -------------------------------------------------
    const dbw = Math.min(20 * dpr, (W * 0.34) / 8 - 3 * dpr);
    bits(c, dbx, dby, data, 8, dbw, PAL.blue, 'DATA  D7 … D0');
    c.font = `800 ${26 * dpr}px ui-monospace, monospace`;
    c.fillStyle = PAL.blue;
    c.fillText('$' + hx(data, 2), dbx, dby + dbw + 34 * dpr);
    c.font = `600 ${10 * dpr}px ui-monospace, monospace`;
    c.fillStyle = PAL.muted;
    const ch2 = data >= 32 && data < 127 ? String.fromCharCode(data) : '·';
    c.fillText("= " + data + " decimal   '" + ch2 + "'", dbx, dby + dbw + 54 * dpr);
    c.fillStyle = PAL.muted;
    c.fillText('/OE asserted → cell drives the data bus', dbx, dby + dbw + 74 * dpr);

    aEl.textContent = '$' + hx(addr, 2);
    dEl.textContent = '$' + hx(data, 2);
  }
  raf = requestAnimationFrame(frame);
}

/* ==========================================================================
   Lab 02 — bus cycle animator: CPU ↔ ROM address/data handshake
   ========================================================================== */
function BusLab(root) {
  const canvas = root.querySelector('canvas');
  const { c, dpr } = labCanvas(canvas);
  const vis = watchVisibility(root);

  // a few interesting big-endian word addresses on the map
  const TARGETS = {
    reset:  { addr: 0x000004, dev: 'ROM', data: 0x0200, note: 'reset vector hi word' },
    rom:    { addr: 0x000100, dev: 'ROM', data: 0x5345, note: '"SE" of SEGA header' },
    ram:    { addr: 0xFF0000, dev: 'RAM', data: 0x0000, note: '68000 work RAM' },
    vdp:    { addr: 0xC00000, dev: 'VDP', data: 0x3400, note: 'VDP data port' },
  };
  let key = 'rom';
  let phase = 0;          // 0..4 through the bus cycle
  let anim = 0;           // 0..1 within a phase
  let running = true;

  const PHASES = ['S0 · CPU drives address, asserts /AS',
                  'S2 · CPU asserts /UDS /LDS, R/W = read',
                  'S4 · ROM decodes, drives 16-bit data',
                  'S6 · ROM asserts /DTACK — data valid',
                  'S7 · CPU latches word, deasserts strobes'];

  const phaseEl = root.querySelector('[data-bus-phase]');
  const addrEl = root.querySelector('[data-bus-addr]');
  const dataEl = root.querySelector('[data-bus-data]');

  root.querySelectorAll('[data-bus-target]').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('[data-bus-target]').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); key = b.dataset.busTarget; phase = 0; anim = 0;
  }));
  root.querySelector('[data-bus-run]').addEventListener('click', e => {
    running = !running; e.currentTarget.textContent = running ? 'Pause' : 'Run';
  });
  root.querySelector('[data-bus-step]').addEventListener('click', () => {
    running = false; root.querySelector('[data-bus-run]').textContent = 'Run';
    phase = (phase + 1) % 5; anim = 1;
  });

  function sig(c, x, y, w, label, active, col) {
    c.fillStyle = active ? col : PAL.panel3;
    c.strokeStyle = active ? col : PAL.line2; c.lineWidth = 1 * dpr;
    c.beginPath(); c.roundRect(x, y, w, 20 * dpr, 4 * dpr); c.fill(); c.stroke();
    c.fillStyle = active ? '#0a0b10' : PAL.muted;
    c.font = `700 ${9.5 * dpr}px ui-monospace, monospace`;
    c.fillText(label, x + 7 * dpr, y + 13.5 * dpr);
  }

  let raf, last = 0;
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (!vis.visible) { last = ts; return; }
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts;
    if (running && !REDUCE_MOTION) { anim += dt / 0.9; if (anim >= 1) { anim = 0; phase = (phase + 1) % 5; } }
    else anim = 1;

    const t = TARGETS[key];
    const W = canvas.width, H = canvas.height;
    c.clearRect(0, 0, W, H);
    grid(c, W, H, 12, 4);

    // CPU + ROM/device boxes
    const cpuX = W * 0.05, boxW = W * 0.2, boxY = H * 0.18, boxH = H * 0.34;
    const devX = W * 0.75;
    c.fillStyle = PAL.panel2; c.strokeStyle = PAL.red; c.lineWidth = 1.5 * dpr;
    c.beginPath(); c.roundRect(cpuX, boxY, boxW, boxH, 8 * dpr); c.fill(); c.stroke();
    c.fillStyle = PAL.ink; c.font = `700 ${13 * dpr}px ui-monospace, monospace`;
    c.fillText('68000', cpuX + 12 * dpr, boxY + 26 * dpr);
    c.fillStyle = PAL.muted; c.font = `600 ${9.5 * dpr}px ui-monospace, monospace`;
    c.fillText('the bus', cpuX + 12 * dpr, boxY + 44 * dpr);
    c.fillText('master', cpuX + 12 * dpr, boxY + 58 * dpr);

    const devCol = t.dev === 'ROM' ? PAL.blue : t.dev === 'VDP' ? PAL.gold : PAL.amber;
    c.fillStyle = PAL.panel2; c.strokeStyle = devCol;
    c.beginPath(); c.roundRect(devX, boxY, boxW, boxH, 8 * dpr); c.fill(); c.stroke();
    c.fillStyle = PAL.ink; c.font = `700 ${13 * dpr}px ui-monospace, monospace`;
    c.fillText(t.dev, devX + 12 * dpr, boxY + 26 * dpr);
    c.fillStyle = PAL.muted; c.font = `600 ${9.5 * dpr}px ui-monospace, monospace`;
    c.fillText('@ $' + hx(t.addr, 6), devX + 12 * dpr, boxY + 44 * dpr);
    c.fillText(t.note, devX + 12 * dpr, boxY + 58 * dpr);

    // address bus (CPU -> dev), lit from phase >= 0
    const abY = boxY + 6 * dpr, dbY = boxY + boxH - 26 * dpr;
    const x0 = cpuX + boxW, x1 = devX;
    c.fillStyle = PAL.muted; c.font = `600 ${9.5 * dpr}px ui-monospace, monospace`;
    c.fillText('address bus · 24 lines (A23…A1)', x0 + 6 * dpr, abY - 6 * dpr);
    c.strokeStyle = 'rgba(255,83,71,0.35)'; c.lineWidth = 8 * dpr;
    c.beginPath(); c.moveTo(x0, abY + 6 * dpr); c.lineTo(x1, abY + 6 * dpr); c.stroke();
    // moving address packet
    const aProg = phase === 0 ? anim : 1;
    const apx = x0 + (x1 - x0) * (phase === 0 ? aProg : 1);
    c.fillStyle = PAL.red; c.font = `700 ${11 * dpr}px ui-monospace, monospace`;
    c.fillStyle = PAL.red; c.beginPath(); c.arc(apx, abY + 6 * dpr, 5 * dpr, 0, 7); c.fill();
    c.fillText('$' + hx(t.addr, 6), x0 + (x1 - x0) * 0.28, abY + 2 * dpr);

    // data bus (dev -> CPU), lit from phase >= 2
    c.fillStyle = PAL.muted; c.font = `600 ${9.5 * dpr}px ui-monospace, monospace`;
    c.fillText('data bus · 16 lines (D15…D0)', x0 + 6 * dpr, dbY - 6 * dpr);
    const dataLive = phase >= 2;
    c.strokeStyle = dataLive ? 'rgba(63,181,255,0.4)' : 'rgba(120,130,160,0.15)'; c.lineWidth = 8 * dpr;
    c.beginPath(); c.moveTo(x1, dbY + 6 * dpr); c.lineTo(x0, dbY + 6 * dpr); c.stroke();
    if (dataLive) {
      const dProg = phase === 2 ? anim : 1;
      const dpx = x1 - (x1 - x0) * dProg;
      c.fillStyle = PAL.blue; c.beginPath(); c.arc(dpx, dbY + 6 * dpr, 5 * dpr, 0, 7); c.fill();
      c.fillStyle = PAL.blue; c.font = `700 ${11 * dpr}px ui-monospace, monospace`;
      c.fillText('$' + hx(t.data, 4), x0 + (x1 - x0) * 0.42, dbY + 2 * dpr);
    }

    // control signals row
    const sy = H * 0.68; let sx = W * 0.05;
    const AS = phase >= 0, DS = phase >= 1, DTACK = phase >= 3, RW = true;
    sx += 0; sig(c, sx, sy, 52 * dpr, '/AS', AS, PAL.red); sx += 62 * dpr;
    sig(c, sx, sy, 80 * dpr, '/UDS /LDS', DS, PAL.red); sx += 90 * dpr;
    sig(c, sx, sy, 74 * dpr, 'R/W = 1', RW, PAL.blue); sx += 84 * dpr;
    sig(c, sx, sy, 66 * dpr, '/DTACK', DTACK, PAL.good); sx += 76 * dpr;

    c.fillStyle = PAL.muted; c.font = `600 ${10 * dpr}px ui-monospace, monospace`;
    c.fillText('/DTACK = "data acknowledge": the device tells the CPU the word is ready.', W * 0.05, sy + 44 * dpr);

    // caption
    c.fillStyle = PAL.ink; c.font = `700 ${11.5 * dpr}px ui-monospace, monospace`;
    c.fillText(PHASES[phase], W * 0.05, H * 0.1);

    phaseEl.textContent = 'S' + [0, 2, 4, 6, 7][phase];
    addrEl.textContent = '$' + hx(t.addr, 6);
    dataEl.textContent = phase >= 2 ? '$' + hx(t.data, 4) : '— (hi-Z)';
  }
  raf = requestAnimationFrame(frame);
}

/* ==========================================================================
   Lab 04 — endianness explorer: byte / word / longword, big vs little
   ========================================================================== */
function EndianLab(root) {
  const canvas = root.querySelector('canvas');
  const { c, dpr } = labCanvas(canvas);
  const vis = watchVisibility(root);

  let value = 0x53454741;    // "SEGA"
  let big = true;            // 68000 is big-endian
  let size = 4;              // 1 byte / 2 word / 4 long
  let offset = 0;            // read start byte (0..3)

  const input = root.querySelector('[data-endian-input]');
  const outEl = root.querySelector('[data-endian-out]');
  const asciiEl = root.querySelector('[data-endian-ascii]');
  input.addEventListener('input', () => {
    const v = parseInt(input.value.replace(/[^0-9a-fA-F]/g, ''), 16);
    if (!isNaN(v)) value = v >>> 0;
  });
  root.querySelectorAll('[data-endian-mode]').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('[data-endian-mode]').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); big = b.dataset.endianMode === 'big';
  }));
  root.querySelectorAll('[data-endian-size]').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('[data-endian-size]').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); size = parseInt(b.dataset.endianSize, 10);
    if (offset + size > 4) offset = 4 - size;
  }));

  // clicking a memory cell moves the read offset
  canvas.addEventListener('pointerdown', e => {
    const p = canvasPos(canvas, e, dpr);
    const W = canvas.width, cellW = W * 0.19, x0 = W * 0.08, y = canvas.height * 0.3, cellH = canvas.height * 0.22;
    if (p.y > y && p.y < y + cellH) {
      const idx = Math.floor((p.x - x0) / cellW);
      if (idx >= 0 && idx < 4) offset = Math.min(idx, 4 - size);
    }
  });
  canvas.style.cursor = 'pointer';

  function memBytes() {
    // the four bytes of `value` laid out in memory at addresses 0..3
    const b = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    return big ? b : b.slice().reverse();
  }

  let raf;
  function frame() {
    raf = requestAnimationFrame(frame);
    if (!vis.visible) return;
    const W = canvas.width, H = canvas.height;
    const mem = memBytes();
    c.clearRect(0, 0, W, H);
    grid(c, W, H, 12, 4);

    c.font = `600 ${10.5 * dpr}px ui-monospace, monospace`;
    c.fillStyle = PAL.ink;
    c.fillText('register value: $' + hx(value, 8) + '   ·   ' + (big ? 'BIG-endian (68000)' : 'little-endian'),
      W * 0.08, H * 0.14);
    c.fillStyle = PAL.muted;
    c.fillText('how those 4 bytes sit in memory — lowest address on the left:', W * 0.08, H * 0.24);

    // memory cells
    const cellW = W * 0.19, x0 = W * 0.08, y = H * 0.3, cellH = H * 0.22;
    for (let i = 0; i < 4; i++) {
      const inRead = i >= offset && i < offset + size;
      const x = x0 + i * cellW;
      c.fillStyle = inRead ? 'rgba(255,83,71,0.18)' : PAL.panel2;
      c.strokeStyle = inRead ? PAL.red : PAL.line2; c.lineWidth = 1.5 * dpr;
      c.beginPath(); c.roundRect(x, y, cellW - 8 * dpr, cellH, 6 * dpr); c.fill(); c.stroke();
      c.fillStyle = PAL.muted; c.font = `600 ${9.5 * dpr}px ui-monospace, monospace`;
      c.fillText('addr N+' + i, x + 10 * dpr, y + 16 * dpr);
      c.fillStyle = PAL.ink; c.font = `800 ${18 * dpr}px ui-monospace, monospace`;
      c.fillText('$' + hx(mem[i], 2), x + 10 * dpr, y + cellH * 0.66);
      const ch = mem[i] >= 32 && mem[i] < 127 ? String.fromCharCode(mem[i]) : '·';
      c.fillStyle = PAL.gold; c.font = `700 ${12 * dpr}px ui-monospace, monospace`;
      c.fillText("'" + ch + "'", x + cellW - 34 * dpr, y + cellH * 0.66);
    }

    // read result
    let read = 0;
    for (let i = 0; i < size; i++) read = (read * 256) + mem[offset + i];
    const sizeName = size === 1 ? 'BYTE' : size === 2 ? 'WORD' : 'LONGWORD';
    const ry = H * 0.68;
    c.fillStyle = PAL.blue; c.font = `600 ${10.5 * dpr}px ui-monospace, monospace`;
    c.fillText('read a ' + sizeName + ' at address N+' + offset + '  (tap a cell to move):', W * 0.08, ry);
    c.fillStyle = PAL.ink; c.font = `800 ${24 * dpr}px ui-monospace, monospace`;
    c.fillText('$' + hx(read, size * 2), W * 0.08, ry + 34 * dpr);
    c.fillStyle = PAL.muted; c.font = `600 ${10.5 * dpr}px ui-monospace, monospace`;
    c.fillText('= ' + (read >>> 0) + ' unsigned', W * 0.08, ry + 54 * dpr);

    // ascii of full longword as stored
    let ascii = '';
    for (let i = 0; i < 4; i++) ascii += (mem[i] >= 32 && mem[i] < 127) ? String.fromCharCode(mem[i]) : '·';

    outEl.textContent = '$' + hx(read, size * 2);
    asciiEl.textContent = '"' + ascii + '"';
  }
  raf = requestAnimationFrame(frame);
}

/* ==========================================================================
   Lab 06 — 68000 memory-map explorer: point at an address, see who answers
   ========================================================================== */
function MemMapLab(root) {
  const canvas = root.querySelector('canvas');
  const { c, dpr } = labCanvas(canvas);
  const vis = watchVisibility(root);

  // regions of the 24-bit (16 MB) 68000 space. `min` = a minimum drawn share
  const REGIONS = [
    { s: 0x000000, e: 0x3FFFFF, name: 'Cartridge ROM', col: PAL.blue, dev: 'The cartridge. Reset vectors + header live at the very start; up to 4 MB flat, more via mappers.' },
    { s: 0x400000, e: 0x9FFFFF, name: 'Reserved / expansion', col: 'rgba(126,133,153,0.5)', dev: 'Unused on a bare Genesis; the Mega-CD and 32X claim parts of this range.' },
    { s: 0xA00000, e: 0xA0FFFF, name: 'Z80 area', col: PAL.gold, dev: 'The Z80 sound CPU’s 8 KB RAM and the sound chips, seen by the 68000 through a window.' },
    { s: 0xA10000, e: 0xA10FFF, name: 'I/O — controllers & version', col: PAL.amber, dev: 'Controller data/control ports and the console version register.' },
    { s: 0xA11000, e: 0xA11FFF, name: 'Z80 / 68K bus control', col: PAL.amber, dev: 'Z80 bus-request and reset lines — the 68000 borrows the Z80’s bus here.' },
    { s: 0xA13000, e: 0xA130FF, name: 'Mapper / TIME registers', col: PAL.red, dev: 'Bank-switch and SRAM-enable registers on mapped cartridges (Module 09 & 10).' },
    { s: 0xA14000, e: 0xA140FF, name: 'TMSS register', col: PAL.red, dev: 'The TMSS lock: later models require the ROM to write ‘SEGA’ here (Module 08).' },
    { s: 0xC00000, e: 0xC0001F, name: 'VDP ports', col: PAL.good, dev: 'VDP data & control ports, the HV counter, and the PSG — the video/​sound doorway.' },
    { s: 0xE00000, e: 0xFEFFFF, name: 'RAM mirrors', col: 'rgba(126,133,153,0.35)', dev: 'The 64 KB work RAM mirrored repeatedly across this range (only 16 address lines decode).' },
    { s: 0xFF0000, e: 0xFFFFFF, name: '68000 work RAM', col: PAL.red, dev: 'The 64 KB of main work RAM — the only large read/write memory the 68000 owns directly.' },
  ];

  let addr = 0x000100;

  const input = root.querySelector('[data-map-input]');
  const nameEl = root.querySelector('[data-map-name]');
  const devEl = root.querySelector('[data-map-dev]');
  input.addEventListener('input', () => {
    const v = parseInt(input.value.replace(/[^0-9a-fA-F]/g, ''), 16);
    if (!isNaN(v)) addr = Math.min(0xFFFFFF, v >>> 0);
  });
  root.querySelectorAll('[data-map-goto]').forEach(b => b.addEventListener('click', () => {
    addr = parseInt(b.dataset.mapGoto, 16); input.value = hx(addr, 6);
  }));

  function regionOf(a) {
    for (const r of REGIONS) if (a >= r.s && a <= r.e) return r;
    return null;
  }

  // draw a vertical stack; each region gets height ∝ log(size) so tiny I/O
  // ranges stay visible next to the 4 MB ROM
  function layout(H) {
    const pad = 10 * dpr;
    const weights = REGIONS.map(r => Math.log2(r.e - r.s + 1) + 3);
    const tot = weights.reduce((a, b) => a + b, 0);
    let y = pad; const rows = [];
    const avail = H - pad * 2;
    REGIONS.forEach((r, i) => { const h = avail * weights[i] / tot; rows.push({ r, y, h }); y += h; });
    return rows;
  }

  let hover = null;
  canvas.addEventListener('pointermove', e => {
    const p = canvasPos(canvas, e, dpr);
    const rows = layout(canvas.height);
    hover = null;
    const barX = canvas.width * 0.30, barW = canvas.width * 0.34;
    if (p.x > barX && p.x < barX + barW) {
      for (const row of rows) if (p.y >= row.y && p.y < row.y + row.h) {
        // set address to the middle of the region for feedback
        addr = row.r.s; input.value = hx(addr, 6); hover = row.r; break;
      }
    }
  });

  let raf;
  function frame() {
    raf = requestAnimationFrame(frame);
    if (!vis.visible) return;
    const W = canvas.width, H = canvas.height;
    c.clearRect(0, 0, W, H);

    const rows = layout(H);
    const barX = W * 0.30, barW = W * 0.34;
    const cur = regionOf(addr);

    c.font = `600 ${9.5 * dpr}px ui-monospace, monospace`;
    c.fillStyle = PAL.muted;
    c.fillText('$000000', barX - 62 * dpr, rows[0].y + 10 * dpr);
    c.fillText('$FFFFFF', barX - 62 * dpr, H - 12 * dpr);
    c.save();
    c.translate(W * 0.06, H * 0.5); c.rotate(-Math.PI / 2);
    c.fillStyle = PAL.muted; c.font = `600 ${9 * dpr}px ui-monospace, monospace`;
    c.textAlign = 'center'; c.fillText('24-BIT ADDRESS SPACE · 16 MB', 0, 0); c.textAlign = 'left';
    c.restore();

    rows.forEach(({ r, y, h }) => {
      const active = r === cur;
      c.fillStyle = active ? r.col : (typeof r.col === 'string' && r.col.startsWith('rgba') ? r.col : r.col + '30');
      c.globalAlpha = active ? 0.9 : 0.55;
      c.beginPath(); c.roundRect(barX, y + 1 * dpr, barW, h - 2 * dpr, 4 * dpr); c.fill();
      c.globalAlpha = 1;
      c.strokeStyle = active ? PAL.ink : PAL.line2; c.lineWidth = active ? 1.8 * dpr : 1 * dpr;
      c.beginPath(); c.roundRect(barX, y + 1 * dpr, barW, h - 2 * dpr, 4 * dpr); c.stroke();
      // label to the right
      c.fillStyle = active ? PAL.ink : PAL.ink2;
      c.font = `${active ? 700 : 600} ${10.5 * dpr}px ui-sans-serif, system-ui, sans-serif`;
      c.fillText(r.name, barX + barW + 12 * dpr, y + h / 2 + 1 * dpr);
      c.fillStyle = PAL.muted; c.font = `600 ${8.5 * dpr}px ui-monospace, monospace`;
      c.fillText('$' + hx(r.s, 6) + '–$' + hx(r.e, 6), barX + barW + 12 * dpr, y + h / 2 + 14 * dpr);
    });

    // the address marker
    let my = rows[0].y;
    for (const row of rows) if (addr >= row.r.s && addr <= row.r.e) {
      const f = (addr - row.r.s) / (row.r.e - row.r.s + 1);
      my = row.y + row.h * f; break;
    }
    c.fillStyle = PAL.red; c.strokeStyle = PAL.red;
    c.beginPath(); c.moveTo(barX - 6 * dpr, my); c.lineTo(barX - 16 * dpr, my - 6 * dpr); c.lineTo(barX - 16 * dpr, my + 6 * dpr); c.closePath(); c.fill();
    c.lineWidth = 1.5 * dpr; c.setLineDash([4 * dpr, 3 * dpr]);
    c.beginPath(); c.moveTo(barX, my); c.lineTo(barX + barW, my); c.stroke(); c.setLineDash([]);

    // big readout
    c.fillStyle = PAL.red; c.font = `800 ${20 * dpr}px ui-monospace, monospace`;
    c.fillText('$' + hx(addr, 6), barX - 62 * dpr, H * 0.5 - 4 * dpr);
    c.fillStyle = cur ? PAL.ink : PAL.muted; c.font = `700 ${11 * dpr}px ui-monospace, monospace`;

    nameEl.textContent = cur ? cur.name : 'unmapped';
    devEl.textContent = cur ? cur.dev : 'Nothing decodes here on a stock console.';
  }
  raf = requestAnimationFrame(frame);
}

/* ==========================================================================
   Lab 07 — ROM header inspector: hover a byte, decode the field
   ========================================================================== */
function HeaderLab(root) {
  const canvas = root.querySelector('canvas');
  const { c, dpr } = labCanvas(canvas);
  const vis = watchVisibility(root);

  // build a synthetic but structurally real 256-byte header ($100..$1FF)
  const H = new Uint8Array(256);
  const put = (off, str) => { for (let i = 0; i < str.length; i++) H[off - 0x100 + i] = str.charCodeAt(i); };
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  put(0x100, pad('SEGA MEGA DRIVE ', 16));
  put(0x110, pad('(C)T-00 2024.JAN', 16));
  put(0x120, pad('SILICON QUEST', 48));                 // domestic title
  put(0x150, pad('SILICON QUEST', 48));                 // overseas title
  put(0x180, pad('GM 00042042-00', 14));                // serial: type + number + rev
  // checksum $18E..$18F (illustrative)
  H[0x18E - 0x100] = 0x1A; H[0x18F - 0x100] = 0xC7;
  put(0x190, pad('J', 16));                             // I/O device support: 3-button pad
  // ROM start/end
  const put32 = (off, v) => { H[off - 0x100] = (v >>> 24) & 255; H[off - 0x100 + 1] = (v >>> 16) & 255; H[off - 0x100 + 2] = (v >>> 8) & 255; H[off - 0x100 + 3] = v & 255; };
  put32(0x1A0, 0x00000000);
  put32(0x1A4, 0x000FFFFF);                             // 1 MB ROM
  put32(0x1A8, 0x00FF0000);                             // RAM start
  put32(0x1AC, 0x00FFFFFF);                             // RAM end
  put(0x1B0, 'RA' ); H[0x1B2 - 0x100] = 0xF8; H[0x1B3 - 0x100] = 0x20; // SRAM present, even bytes
  put32(0x1B4, 0x00200001); put32(0x1B8, 0x0020FFFF);  // SRAM range
  put(0x1BC, pad('', 12));                              // modem: none
  put(0x1C8, pad('', 40));                              // notes/reserved
  put(0x1F0, pad('JUE', 16));                           // region: Japan/USA/Europe

  const FIELDS = [
    { s: 0x100, e: 0x10F, name: 'Console name', col: PAL.blue, dec: () => '"' + txt(0x100, 16) + '" — the magic string a TMSS console checks for.' },
    { s: 0x110, e: 0x11F, name: 'Copyright & date', col: PAL.gold, dec: () => '"' + txt(0x110, 16) + '" — maker code T-00 and build date.' },
    { s: 0x120, e: 0x14F, name: 'Domestic title', col: PAL.amber, dec: () => '"' + txt(0x120, 48).trim() + '" — the Japanese title.' },
    { s: 0x150, e: 0x17F, name: 'Overseas title', col: PAL.amber, dec: () => '"' + txt(0x150, 48).trim() + '" — the international title.' },
    { s: 0x180, e: 0x18D, name: 'Serial number', col: PAL.red, dec: () => '"' + txt(0x180, 14).trim() + '" — GM = game, then the product number and revision.' },
    { s: 0x18E, e: 0x18F, name: 'Checksum', col: PAL.good, dec: () => '$' + hx(H[0x8E], 2) + hx(H[0x8F], 2) + ' — 16-bit sum of every word from $000200 to the ROM end.' },
    { s: 0x190, e: 0x19F, name: 'I/O support', col: PAL.blue, dec: () => '"' + txt(0x190, 16).trim() + '" — J = standard 3-button control pad.' },
    { s: 0x1A0, e: 0x1A3, name: 'ROM start', col: PAL.red, dec: () => '$' + hx(u32(0x1A0), 8) + ' — first ROM address.' },
    { s: 0x1A4, e: 0x1A7, name: 'ROM end', col: PAL.red, dec: () => '$' + hx(u32(0x1A4), 8) + ' — last ROM address (this cart: 1 MB).' },
    { s: 0x1A8, e: 0x1AB, name: 'RAM start', col: PAL.gold, dec: () => '$' + hx(u32(0x1A8), 8) + ' — work-RAM start ($FF0000).' },
    { s: 0x1AC, e: 0x1AF, name: 'RAM end', col: PAL.gold, dec: () => '$' + hx(u32(0x1AC), 8) + ' — work-RAM end ($FFFFFF).' },
    { s: 0x1B0, e: 0x1BB, name: 'SRAM info', col: PAL.amber, dec: () => '"RA" + flags — battery-backed SRAM present, at $' + hx(u32(0x1B4), 6) + '–$' + hx(u32(0x1B8), 6) + '.' },
    { s: 0x1BC, e: 0x1C7, name: 'Modem', col: 'rgba(126,133,153,0.6)', dec: () => 'blank — no modem support.' },
    { s: 0x1C8, e: 0x1EF, name: 'Reserved / notes', col: 'rgba(126,133,153,0.45)', dec: () => 'spare space, usually spaces or a memo.' },
    { s: 0x1F0, e: 0x1FF, name: 'Region', col: PAL.good, dec: () => '"' + txt(0x1F0, 16).trim() + '" — J = Japan, U = USA, E = Europe (all three here).' },
  ];
  const txt = (off, n) => { let s = ''; for (let i = 0; i < n; i++) { const b = H[off - 0x100 + i]; s += (b >= 32 && b < 127) ? String.fromCharCode(b) : ' '; } return s; };
  const u32 = off => ((H[off - 0x100] << 24) | (H[off - 0x100 + 1] << 16) | (H[off - 0x100 + 2] << 8) | H[off - 0x100 + 3]) >>> 0;
  const fieldOf = a => FIELDS.find(f => a >= f.s && a <= f.e);

  let sel = 0x100;
  const nameEl = root.querySelector('[data-hdr-name]');
  const decEl = root.querySelector('[data-hdr-dec]');

  function geom() {
    const W = canvas.width, Ht = canvas.height;
    const x0 = W * 0.16, y0 = Ht * 0.08;
    const cw = (W * 0.50) / 16, ch = (Ht * 0.86) / 16;
    return { W, Ht, x0, y0, cw, ch };
  }
  canvas.addEventListener('pointermove', e => {
    const g = geom(); const p = canvasPos(canvas, e, dpr);
    const col = Math.floor((p.x - g.x0) / g.cw), row = Math.floor((p.y - g.y0) / g.ch);
    if (col >= 0 && col < 16 && row >= 0 && row < 16) sel = 0x100 + row * 16 + col;
  });
  canvas.style.cursor = 'crosshair';

  let raf;
  function frame() {
    raf = requestAnimationFrame(frame);
    if (!vis.visible) return;
    const g = geom();
    c.clearRect(0, 0, g.W, g.Ht);
    const selF = fieldOf(sel);

    c.font = `600 ${8.5 * dpr}px ui-monospace, monospace`;
    // column headers
    for (let k = 0; k < 16; k++) { c.fillStyle = PAL.muted; c.fillText(hx(k, 1), g.x0 + k * g.cw + g.cw * 0.28, g.y0 - 4 * dpr); }
    for (let r = 0; r < 16; r++) {
      c.fillStyle = PAL.muted;
      c.fillText('$' + hx(0x100 + r * 16, 3), g.x0 - 44 * dpr, g.y0 + r * g.ch + g.ch * 0.66);
      for (let k = 0; k < 16; k++) {
        const off = 0x100 + r * 16 + k;
        const f = fieldOf(off);
        const inSel = selF && f === selF;
        const x = g.x0 + k * g.cw, y = g.y0 + r * g.ch;
        c.fillStyle = inSel ? (typeof f.col === 'string' && f.col.startsWith('rgba') ? f.col : f.col + '55')
                            : (f && !f.col.startsWith('rgba') ? f.col + '1e' : 'rgba(120,130,160,0.05)');
        c.beginPath(); c.roundRect(x + 0.6 * dpr, y + 0.6 * dpr, g.cw - 1.2 * dpr, g.ch - 1.2 * dpr, 2 * dpr); c.fill();
        const b = H[off - 0x100];
        c.fillStyle = inSel ? PAL.ink : PAL.ink2;
        c.font = `${inSel ? 700 : 500} ${8.2 * dpr}px ui-monospace, monospace`;
        c.fillText(hx(b, 2), x + g.cw * 0.14, y + g.ch * 0.66);
      }
    }
    // ASCII column
    for (let r = 0; r < 16; r++) {
      let s = '';
      for (let k = 0; k < 16; k++) { const b = H[r * 16 + k]; s += (b >= 32 && b < 127) ? String.fromCharCode(b) : '·'; }
      c.fillStyle = PAL.muted; c.font = `500 ${8.6 * dpr}px ui-monospace, monospace`;
      c.fillText(s, g.x0 + 16 * g.cw + 10 * dpr, g.y0 + r * g.ch + g.ch * 0.66);
    }
    // selected-field outline
    if (selF) {
      c.strokeStyle = typeof selF.col === 'string' && selF.col.startsWith('rgba') ? PAL.ink2 : selF.col;
      c.lineWidth = 1.8 * dpr;
      // outline each contiguous run within the grid
      for (let off = selF.s; off <= selF.e; off++) {
        const r = (off - 0x100) >> 4, k = (off - 0x100) & 15;
        const x = g.x0 + k * g.cw, y = g.y0 + r * g.ch;
        c.strokeRect(x + 0.6 * dpr, y + 0.6 * dpr, g.cw - 1.2 * dpr, g.ch - 1.2 * dpr);
      }
    }

    nameEl.textContent = selF ? '$' + hx(selF.s, 3) + ' · ' + selF.name : '—';
    decEl.textContent = selF ? selF.dec() : 'Hover the hex dump to inspect a field.';
  }
  raf = requestAnimationFrame(frame);
}

/* ==========================================================================
   Lab 09 — bank-switching playground (SSF2-style mapper)
   ========================================================================== */
function BankLab(root) {
  const canvas = root.querySelector('canvas');
  const { c, dpr } = labCanvas(canvas);
  const vis = watchVisibility(root);

  const NBANKS = 16;                 // physical: 16 × 512 KB = 8 MB ROM
  const NSLOTS = 8;                  // the 68000 sees 8 × 512 KB = 4 MB window
  const slots = [0, 1, 2, 3, 4, 5, 6, 7];   // slot -> physical bank (identity at reset)
  const BANKCOL = i => `hsl(${(i * 360 / NBANKS) | 0}, 62%, 58%)`;
  let active = 1;                    // slot being edited (slot 0 is locked)
  let target = 8;                    // bank to map in
  let sweep = 0;

  const slotEl = root.querySelector('[data-bank-slot]');
  const regEl = root.querySelector('[data-bank-reg]');
  root.querySelectorAll('[data-bank-pick]').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('[data-bank-pick]').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); active = parseInt(b.dataset.bankPick, 10);
  }));
  const tR = root.querySelector('[data-bank-target]');
  const tV = root.querySelector('[data-bank-target-val]');
  tR.addEventListener('input', () => { target = parseInt(tR.value, 10); tV.textContent = 'bank ' + target; });
  root.querySelector('[data-bank-write]').addEventListener('click', () => {
    if (active === 0) return;        // slot 0 fixed to bank 0 (holds the vectors)
    slots[active] = target;
  });
  root.querySelector('[data-bank-reset]').addEventListener('click', () => { for (let i = 0; i < NSLOTS; i++) slots[i] = i; });

  let raf, last = 0;
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (!vis.visible) { last = ts; return; }
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016); last = ts;
    if (!REDUCE_MOTION) sweep = (sweep + dt * 0.18) % 1;

    const W = canvas.width, Hh = canvas.height;
    c.clearRect(0, 0, W, Hh);
    grid(c, W, Hh, 12, 4);

    const topY = Hh * 0.14, botY = Hh * 0.9;
    const physX = W * 0.06, physW = W * 0.22;
    const winX = W * 0.62, winW = W * 0.22;
    const bankH = (botY - topY) / NBANKS;
    const slotH = (botY - topY) / NSLOTS;

    c.fillStyle = PAL.muted; c.font = `600 ${9.5 * dpr}px ui-monospace, monospace`;
    c.fillText('PHYSICAL ROM · 8 MB · 16 banks', physX, topY - 8 * dpr);
    c.fillText('68000 WINDOW · $000000–$3FFFFF', winX - 10 * dpr, topY - 8 * dpr);

    // physical banks
    for (let i = 0; i < NBANKS; i++) {
      const y = topY + i * bankH;
      const used = slots.includes(i);
      c.fillStyle = BANKCOL(i); c.globalAlpha = used ? 0.9 : 0.32;
      c.beginPath(); c.roundRect(physX, y + 0.8 * dpr, physW, bankH - 1.6 * dpr, 3 * dpr); c.fill();
      c.globalAlpha = 1;
      c.fillStyle = '#0a0b10'; c.font = `700 ${8.5 * dpr}px ui-monospace, monospace`;
      c.fillText('bank ' + hx(i, 1), physX + 6 * dpr, y + bankH * 0.66);
    }

    // window slots + connections
    for (let s = 0; s < NSLOTS; s++) {
      const y = topY + s * slotH;
      const bank = slots[s];
      const isActive = s === active;
      c.fillStyle = BANKCOL(bank); c.globalAlpha = 0.9;
      c.beginPath(); c.roundRect(winX, y + 0.8 * dpr, winW, slotH - 1.6 * dpr, 3 * dpr); c.fill();
      c.globalAlpha = 1;
      c.strokeStyle = isActive ? PAL.ink : (s === 0 ? PAL.muted : PAL.line2);
      c.lineWidth = isActive ? 2 * dpr : 1 * dpr;
      c.beginPath(); c.roundRect(winX, y + 0.8 * dpr, winW, slotH - 1.6 * dpr, 3 * dpr); c.stroke();
      c.fillStyle = '#0a0b10'; c.font = `700 ${8.5 * dpr}px ui-monospace, monospace`;
      c.fillText('$' + hx(s * 0x80000, 6), winX + 5 * dpr, y + slotH * 0.44);
      c.fillText('← bank ' + hx(bank, 1) + (s === 0 ? ' (fixed)' : ''), winX + 5 * dpr, y + slotH * 0.82);

      // connection line from physical bank to this slot
      const by = topY + bank * bankH + bankH / 2;
      c.strokeStyle = isActive ? PAL.red : BANKCOL(bank);
      c.globalAlpha = isActive ? 1 : 0.5;
      c.lineWidth = isActive ? 2.4 * dpr : 1.2 * dpr;
      c.beginPath(); c.moveTo(physX + physW, by); c.bezierCurveTo(W * 0.44, by, W * 0.5, y + slotH / 2, winX, y + slotH / 2); c.stroke();
      c.globalAlpha = 1;
    }

    // a "CPU read" cursor sweeping the window, colour = source bank
    const sy = topY + sweep * (botY - topY);
    const slotHit = Math.min(NSLOTS - 1, Math.floor(sweep * NSLOTS));
    c.strokeStyle = PAL.ink; c.lineWidth = 1.5 * dpr; c.setLineDash([3 * dpr, 3 * dpr]);
    c.beginPath(); c.moveTo(winX - 6 * dpr, sy); c.lineTo(winX + winW + 6 * dpr, sy); c.stroke(); c.setLineDash([]);
    c.fillStyle = BANKCOL(slots[slotHit]);
    c.beginPath(); c.arc(winX + winW + 14 * dpr, sy, 5 * dpr, 0, 7); c.fill();

    // register readout
    const regAddr = 0xA130F1 + active;   // SSF2 mapper bank registers
    slotEl.textContent = 'slot ' + active + (active === 0 ? ' (locked)' : '');
    regEl.textContent = '$' + hx(regAddr, 6) + ' ← ' + target;
  }
  raf = requestAnimationFrame(frame);
}

/* ==========================================================================
   Lab 11 — lock-on simulator: stack S&K + a game, show the combined space
   ========================================================================== */
function LockOnLab(root) {
  const canvas = root.querySelector('canvas');
  const { c, dpr } = labCanvas(canvas);
  const vis = watchVisibility(root);

  // Sonic & Knuckles has a passthrough slot; what it does depends on the
  // downstream cart. Mappings below are illustrative of the documented modes.
  const MODES = {
    none: {
      label: 'S&K alone', title: 'Sonic & Knuckles',
      regions: [
        { s: 0x000000, e: 0x1FFFFF, name: 'S&K ROM (2 MB)', col: PAL.red },
        { s: 0x200000, e: 0x3FFFFF, name: '(open bus)', col: 'rgba(126,133,153,0.4)' },
      ],
      note: 'No cart in the passthrough — S&K boots as its own standalone game.',
    },
    s3: {
      label: '+ Sonic 3', title: 'Sonic 3 & Knuckles',
      regions: [
        { s: 0x000000, e: 0x1FFFFF, name: 'Sonic 3 ROM (2 MB)', col: PAL.blue },
        { s: 0x200000, e: 0x3FFFFF, name: 'S&K ROM (2 MB)', col: PAL.red },
      ],
      note: 'S&K recognises Sonic 3 and maps it low, itself high — the two ROMs fuse into one 4 MB game.',
    },
    s2: {
      label: '+ Sonic 2', title: 'Knuckles in Sonic 2',
      regions: [
        { s: 0x000000, e: 0x0FFFFF, name: 'Sonic 2 ROM (1 MB)', col: PAL.gold },
        { s: 0x100000, e: 0x3FFFFF, name: 'S&K ROM + patch', col: PAL.red },
      ],
      note: 'S&K overlays Knuckles onto Sonic 2 using its own code and a small patch region.',
    },
    other: {
      label: '+ other game', title: '"No Way?" — Blue Sphere',
      regions: [
        { s: 0x000000, e: 0x1FFFFF, name: 'S&K ROM (2 MB)', col: PAL.red },
        { s: 0x300000, e: 0x3FFFFF, name: 'downstream cart as level seed', col: PAL.amber },
      ],
      note: 'An unrecognised cart unlocks the hidden Blue Sphere game, using the other ROM’s bytes to generate levels.',
    },
  };
  let mode = 'none';

  const titleEl = root.querySelector('[data-lock-title]');
  const noteEl = root.querySelector('[data-lock-note]');
  root.querySelectorAll('[data-lock-mode]').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('[data-lock-mode]').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); mode = b.dataset.lockMode;
  }));

  let raf, t = 0;
  function cart(x, y, w, h, col, label, passthrough) {
    c.fillStyle = PAL.panel2; c.strokeStyle = col; c.lineWidth = 1.6 * dpr;
    c.beginPath(); c.roundRect(x, y, w, h, 6 * dpr); c.fill(); c.stroke();
    // label strip
    c.fillStyle = col; c.globalAlpha = 0.25;
    c.beginPath(); c.roundRect(x + 5 * dpr, y + 5 * dpr, w - 10 * dpr, h * 0.4, 4 * dpr); c.fill(); c.globalAlpha = 1;
    c.fillStyle = PAL.ink; c.font = `700 ${9 * dpr}px ui-sans-serif, system-ui, sans-serif`;
    c.fillText(label, x + 12 * dpr, y + h * 0.28);
    // edge-connector pins at the bottom
    c.fillStyle = PAL.gold;
    const pins = 12, pw = (w - 20 * dpr) / pins;
    for (let i = 0; i < pins; i++) c.fillRect(x + 10 * dpr + i * pw, y + h - 6 * dpr, pw * 0.6, 5 * dpr);
    if (passthrough) { c.fillStyle = PAL.gold; for (let i = 0; i < pins; i++) c.fillRect(x + 10 * dpr + i * pw, y - 4 * dpr, pw * 0.6, 5 * dpr); }
  }

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (!vis.visible) return;
    t += 0.016;
    const W = canvas.width, Hh = canvas.height;
    const m = MODES[mode];
    c.clearRect(0, 0, W, Hh);
    grid(c, W, Hh, 12, 4);

    // left: the physical stack
    const cx = W * 0.06, cw = W * 0.26;
    const skY = Hh * 0.5, skH = Hh * 0.34;
    if (mode !== 'none') {
      cart(cx, Hh * 0.1, cw, Hh * 0.3, MODES[mode].regions[0].col === PAL.red ? PAL.amber : MODES[mode].regions[0].col,
        mode === 's3' ? 'Sonic 3' : mode === 's2' ? 'Sonic 2' : 'other game', false);
      // passthrough connector
      c.strokeStyle = PAL.gold; c.lineWidth = 2 * dpr; c.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(t * 2));
      c.beginPath(); c.moveTo(cx + cw / 2, Hh * 0.4); c.lineTo(cx + cw / 2, skY); c.stroke(); c.globalAlpha = 1;
    }
    cart(cx, skY, cw, skH, PAL.red, 'Sonic & Knuckles', true);
    c.fillStyle = PAL.muted; c.font = `600 ${9 * dpr}px ui-monospace, monospace`;
    c.fillText('into the console →', cx, skY + skH + 16 * dpr);

    // right: resulting 68000 address space
    const barX = W * 0.5, barW = W * 0.16, barY = Hh * 0.1, barH = Hh * 0.78;
    c.fillStyle = PAL.muted; c.font = `600 ${9.5 * dpr}px ui-monospace, monospace`;
    c.fillText('resulting map', barX, barY - 8 * dpr);
    c.fillText('$000000', barX + barW + 10 * dpr, barY + 8 * dpr);
    c.fillText('$3FFFFF', barX + barW + 10 * dpr, barY + barH);
    // full 4MB backdrop
    c.strokeStyle = PAL.line2; c.lineWidth = 1 * dpr;
    c.strokeRect(barX, barY, barW, barH);
    const A = 0x400000;
    m.regions.forEach(r => {
      const y0 = barY + barH * r.s / A, y1 = barY + barH * (r.e + 1) / A;
      c.fillStyle = r.col; c.globalAlpha = 0.85;
      c.beginPath(); c.roundRect(barX + 1 * dpr, y0 + 1 * dpr, barW - 2 * dpr, (y1 - y0) - 2 * dpr, 3 * dpr); c.fill();
      c.globalAlpha = 1;
      c.fillStyle = PAL.ink; c.font = `700 ${8.6 * dpr}px ui-sans-serif, system-ui, sans-serif`;
      c.fillText(r.name, barX + barW + 10 * dpr, (y0 + y1) / 2 + 3 * dpr);
      c.fillStyle = PAL.muted; c.font = `600 ${8 * dpr}px ui-monospace, monospace`;
      c.fillText('$' + hx(r.s, 6), barX + barW + 10 * dpr, (y0 + y1) / 2 + 15 * dpr);
    });

    // result title
    c.fillStyle = PAL.gold; c.font = `800 ${13 * dpr}px ui-sans-serif, system-ui, sans-serif`;
    c.fillText('▶ ' + m.title, W * 0.06, Hh * 0.94);

    titleEl.textContent = m.title;
    noteEl.textContent = m.note;
  }
  raf = requestAnimationFrame(frame);
}

/* ==========================================================================
   Hero ambient — a faint cartridge / edge-connector with streaming bits
   ========================================================================== */
function heroAmbient(canvas) {
  const c = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let t = 0, raf;
  function size() { const r = canvas.getBoundingClientRect(); canvas.width = r.width * dpr; canvas.height = r.height * dpr; }
  size(); window.addEventListener('resize', size);

  function draw() {
    const W = canvas.width, H = canvas.height;
    c.clearRect(0, 0, W, H);
    const cx = W * 0.76, cy = H * 0.5;
    const cw = Math.min(W * 0.28, 260 * dpr), ch = cw * 1.15;

    // cartridge silhouette
    c.strokeStyle = 'rgba(255,83,71,0.16)'; c.lineWidth = 1.6 * dpr;
    c.beginPath(); c.roundRect(cx - cw / 2, cy - ch / 2, cw, ch, 12 * dpr); c.stroke();
    c.strokeStyle = 'rgba(63,181,255,0.12)';
    c.beginPath(); c.roundRect(cx - cw * 0.36, cy - ch * 0.34, cw * 0.72, ch * 0.34, 6 * dpr); c.stroke();

    // edge-connector pins along the bottom, with bits flowing up the traces
    const pins = 16, pad = cw * 0.1, span = cw - pad * 2, pw = span / pins;
    for (let i = 0; i < pins; i++) {
      const x = cx - cw / 2 + pad + i * pw + pw * 0.2;
      const py = cy + ch / 2;
      c.fillStyle = 'rgba(255,196,77,0.18)';
      c.fillRect(x, py - 12 * dpr, pw * 0.5, 12 * dpr);
      // a moving bit along the trace
      const phase = (t * 0.6 + i * 0.13) % 1;
      const on = ((i * 7 + Math.floor(t)) & 1) === 0;
      if (on) {
        const by = py - 12 * dpr - phase * ch * 0.5;
        c.fillStyle = 'rgba(63,181,255,' + (0.28 * (1 - phase)) + ')';
        c.beginPath(); c.arc(x + pw * 0.25, by, 2.4 * dpr, 0, 7); c.fill();
      }
    }

    // faint address/data grid inside the cart
    c.strokeStyle = 'rgba(120,130,160,0.06)'; c.lineWidth = 1 * dpr;
    for (let i = 1; i < 6; i++) { const y = cy - ch * 0.1 + i * ch * 0.07; c.beginPath(); c.moveTo(cx - cw * 0.4, y); c.lineTo(cx + cw * 0.4, y); c.stroke(); }

    t += REDUCE_MOTION ? 0 : 0.016;
    raf = requestAnimationFrame(draw);
    if (REDUCE_MOTION) cancelAnimationFrame(raf);
  }
  draw();
}

/* ==========================================================================
   Wire-up
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  const heroCanvas = document.getElementById('hero-cart');
  if (heroCanvas) heroAmbient(heroCanvas);

  const wire = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
  wire('lab-rom', RomLab);
  wire('lab-bus', BusLab);
  wire('lab-endian', EndianLab);
  wire('lab-memmap', MemMapLab);
  wire('lab-header', HeaderLab);
  wire('lab-bank', BankLab);
  wire('lab-lockon', LockOnLab);

  initTooltips();
  scrollSpy();
  readingProgress();

  const mb = document.getElementById('menu-btn');
  const sb = document.getElementById('sidebar');
  const scrim = document.getElementById('scrim');
  const closeMenu = () => { sb.classList.remove('open'); scrim.classList.remove('show'); };
  mb.addEventListener('click', () => { sb.classList.toggle('open'); scrim.classList.toggle('show'); });
  scrim.addEventListener('click', closeMenu);
  sb.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMenu));
});

/* ------------------------------------------------------- glossary tooltips */
function initTooltips() {
  const terms = [...document.querySelectorAll('.term[data-tip]')];
  if (!terms.length) return;
  const tip = document.createElement('div');
  tip.className = 'tip-bubble';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let current = null;

  function place(el) {
    current = el;
    const label = el.textContent.trim().replace(/\s+/g, ' ');
    const esc = s => s.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
    tip.innerHTML = '<span class="tt">' + esc(label) + '</span> — ' + esc(el.getAttribute('data-tip'));
    tip.classList.add('show');
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight, pad = 10;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - tw - pad));
    let top = r.top - th - 10, below = false;
    if (top < 8) { top = r.bottom + 10; below = true; }
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
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
      if (e.isIntersecting) {
        links.forEach(l => l.classList.remove('active'));
        const a = map.get(e.target); if (a) a.classList.add('active');
      }
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
      if (top < mark) links[i].classList.add('done');
      else links[i].classList.remove('done');
    });
  }
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  window.addEventListener('resize', update);
  update();
}
