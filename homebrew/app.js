/* ============================================================================
   Genesis Homebrew — interactive layer
   Everything on this page is simulated in your browser: the "Genesis screen"
   is a canvas drawing, the boot wordmark is a generic stand-in (never Sega's
   actual logo or jingle), the build pipeline is an animation, the ROM header
   is a synthetic one generated below, and the frame-budget game runs on
   requestAnimationFrame standing in for the VDP's vertical-blank interrupt.
   No Sega code, tools or assets are involved anywhere on this page.
   ============================================================================ */
'use strict';

/* ------------------------------------------------------------- helpers */

const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* devicePixelRatio-aware canvas sizing (CSS height fixed in the stylesheet) */
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

/* pause off-screen animations */
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

/* palette (mirrors the CSS custom properties) */
const PAL = {
  blue: '#3fb5ff', red: '#ff5347', redD: '#e23b30', gold: '#ffc44d', amber: '#ff9d3c',
  good: '#4fd08a', bad: '#ff5f5f', ink: '#eef1f8', ink2: '#b3b9cc',
  muted: '#7e8599', line: '#262b3a', line2: '#343a4d',
  panel: '#14161f', panel2: '#1b1e2a', ground: '#0a0b10',
};

function grid(c, W, H, cols, rows) {
  c.strokeStyle = 'rgba(90,104,140,0.16)';
  c.lineWidth = 1;
  for (let i = 1; i < cols; i++) { const x = W * i / cols; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
  for (let i = 1; i < rows; i++) { const y = H * i / rows; c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function wrapText(c, text, x, y, maxW, lh) {
  const words = text.split(' ');
  let lineTxt = '';
  for (const w of words) {
    const test = lineTxt ? lineTxt + ' ' + w : w;
    if (c.measureText(test).width > maxW && lineTxt) { c.fillText(lineTxt, x, y); lineTxt = w; y += lh; }
    else lineTxt = test;
  }
  if (lineTxt) c.fillText(lineTxt, x, y);
}

/* ==========================================================================
   Hero ambient — SGDK toolchain tokens drifting like a build log at 2 a.m.
   ========================================================================== */
function heroAmbient(canvas) {
  const { c, dpr } = labCanvas(canvas);
  const vis = watchVisibility(canvas);
  const TOKENS = [
    'm68k-elf-gcc', 'make', 'rescomp', 'rom.bin', 'rom.out', 'libmd',
    'VDP_drawText()', 'SYS_doVBlankProcess()', '0xA10003', 'main.c',
    'JOY_readJoypad()', 'SPR_addSprite()', 'XGM_startPlay()', 'resources.res',
    'SEGA MEGA DRIVE', 'big-endian',
  ];
  const parts = TOKENS.map((t, i) => ({
    t,
    x: Math.random(), y: Math.random(),
    v: 0.006 + Math.random() * 0.012,
    s: 10 + (i % 3) * 2,
    a: 0.10 + Math.random() * 0.16,
  }));
  let raf, last = 0;
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (!vis.visible) { last = ts; return; }
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts;
    const W = canvas.width, H = canvas.height;
    c.clearRect(0, 0, W, H);
    parts.forEach(p => {
      if (!REDUCE_MOTION) { p.y -= p.v * dt; if (p.y < -0.05) { p.y = 1.05; p.x = Math.random(); } }
      c.font = `600 ${p.s * dpr}px ui-monospace, Menlo, monospace`;
      c.fillStyle = `rgba(255,83,71,${p.a})`;
      c.fillText(p.t, p.x * W, p.y * H);
    });
  }
  raf = requestAnimationFrame(frame);
}

/* ==========================================================================
   Lab 04 — "your first frame": a mock Genesis console screen.
   Replays the hello-world boot: a generic red boot wordmark (a clearly
   non-Sega stand-in), then VDP init (black), then your text drawn as a grid
   of 8x8 VDP tiles, then the vblank loop counting frames until START exits.
   ========================================================================== */
function BootLab(root) {
  const canvas = root.querySelector('canvas');
  const { c, dpr } = labCanvas(canvas);
  const vis = watchVisibility(root);

  const input = root.querySelector('[data-boot-text]');
  const runBtn = root.querySelector('[data-boot-run]');
  const startBtn = root.querySelector('[data-boot-start]');
  const frameRO = root.querySelector('[data-boot-frames]');
  const stateRO = root.querySelector('[data-boot-state]');

  // phases: off → boot (red wordmark) → vdp-init (black) → draw (tiles fill in) → loop → exited
  let phase = 'off';
  let t = 0, frames = 0, drawn = 0;

  function msg() { return (input.value || 'HELLO WORLD').toUpperCase().slice(0, 20); }
  function setPhase(p) { phase = p; t = 0; if (p === 'loop') frames = 0; }

  runBtn.addEventListener('click', () => { drawn = 0; setPhase('boot'); });
  startBtn.addEventListener('click', () => { if (phase === 'loop') setPhase('exited'); });
  input.addEventListener('input', () => { if (phase === 'loop' || phase === 'draw') { drawn = 0; setPhase('draw'); } });

  let raf, last = 0;
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (!vis.visible) { last = ts; return; }
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts;
    t += dt;

    const W = canvas.width, H = canvas.height;
    c.clearRect(0, 0, W, H);

    // the "TV": a 4:3 screen centred in the canvas
    const sh = H * 0.92, sw = Math.min(W * 0.94, sh * 4 / 3);
    const sx = (W - sw) / 2, sy = (H - sh) / 2;
    c.fillStyle = '#04050a';
    c.strokeStyle = PAL.line2; c.lineWidth = 2 * dpr;
    roundRect(c, sx, sy, sw, sh, 10 * dpr); c.fill(); c.stroke();

    c.save();
    roundRect(c, sx, sy, sw, sh, 10 * dpr); c.clip();

    if (phase === 'off') {
      c.fillStyle = PAL.muted;
      c.font = `600 ${12 * dpr}px ui-monospace, Menlo, monospace`;
      c.textAlign = 'center';
      c.fillText('◦ press "power on & run" to boot the ROM ◦', W / 2, H / 2);
      c.textAlign = 'left';
    } else if (phase === 'boot') {
      // generic boot wordmark — a stand-in, NOT Sega's logo or jingle
      const a = Math.min(1, t * 2) * (t > 1.4 ? Math.max(0, 1 - (t - 1.4) * 2.2) : 1);
      c.globalAlpha = a;
      c.fillStyle = PAL.red;
      const bw = sw * 0.5, bh = sh * 0.16;
      roundRect(c, W / 2 - bw / 2, H / 2 - bh / 2, bw, bh, 8 * dpr); c.fill();
      c.fillStyle = '#04050a';
      c.font = `800 ${sh * 0.085}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('16-BIT', W / 2, H / 2);
      c.font = `600 ${sh * 0.03}px ui-monospace, Menlo, monospace`;
      c.fillStyle = PAL.red; c.globalAlpha = a * 0.8;
      c.fillText('HOMEBREW SYSTEM · generic stand-in', W / 2, H / 2 + bh * 0.9);
      c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.globalAlpha = 1;
      if (t > 2.0) setPhase('vdp-init');
    } else if (phase === 'vdp-init') {
      // VDP_init / palette load: a black background plane
      if (t > 0.7) setPhase('draw');
    } else if (phase === 'draw' || phase === 'loop' || phase === 'exited') {
      // draw the message as 8x8 VDP tiles on plane A
      const m = msg();
      const cell = Math.max(10, sw / 34);       // one 8x8 tile cell
      const gx0 = sx + cell * 3, gy0 = sy + sh * 0.30;
      // faint tile grid to make "these are 8x8 tiles" legible
      c.strokeStyle = 'rgba(63,181,255,0.10)'; c.lineWidth = dpr;
      for (let gx = 0; gx <= 28; gx++) { c.beginPath(); c.moveTo(gx0 + gx * cell, gy0 - cell); c.lineTo(gx0 + gx * cell, gy0 + cell * 2); c.stroke(); }
      for (let gy = -1; gy <= 2; gy++) { c.beginPath(); c.moveTo(gx0, gy0 + gy * cell); c.lineTo(gx0 + 28 * cell, gy0 + gy * cell); c.stroke(); }

      if (phase === 'draw') { drawn = Math.min(m.length, drawn + dt * 26); if (drawn >= m.length) setPhase('loop'); }
      const shown = Math.floor(phase === 'draw' ? drawn : m.length);
      c.font = `700 ${cell * 0.92}px ui-monospace, Menlo, monospace`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      for (let i = 0; i < shown; i++) {
        const ch = m[i];
        const cx = gx0 + (i + 0.5) * cell, cy = gy0 + cell * 0.5;
        // each glyph "lives in" one tile: highlight its cell
        c.fillStyle = 'rgba(255,83,71,0.14)';
        c.fillRect(gx0 + i * cell + dpr, gy0 + dpr, cell - 2 * dpr, cell - 2 * dpr);
        c.fillStyle = '#eaf6ff';
        if (ch !== ' ') c.fillText(ch, cx, cy);
      }
      c.textAlign = 'left'; c.textBaseline = 'alphabetic';

      if (phase === 'loop') {
        frames += dt * 60;
        c.font = `500 ${cell * 0.62}px ui-monospace, Menlo, monospace`;
        c.fillStyle = PAL.muted;
        c.fillText('frames since boot: ' + Math.floor(frames), gx0, sy + sh * 0.62);
        c.fillStyle = PAL.gold;
        c.fillText('press START to exit to loader', gx0, sy + sh * 0.72);
      }
      if (phase === 'exited') {
        c.font = `500 ${cell * 0.62}px ui-monospace, Menlo, monospace`;
        c.fillStyle = PAL.amber;
        c.fillText('SYS_hardReset() — returning to loader...', gx0, sy + sh * 0.62);
      }
    }

    // faint scanlines over the "screen"
    c.fillStyle = 'rgba(0,0,0,0.16)';
    for (let y = sy; y < sy + sh; y += 3 * dpr) c.fillRect(sx, y, sw, dpr);
    c.restore();

    if (frameRO) frameRO.textContent = phase === 'loop' ? String(Math.floor(frames)) : (phase === 'exited' ? 'stopped' : '—');
    if (stateRO) stateRO.textContent = {
      off: 'powered off', boot: 'boot wordmark', 'vdp-init': 'VDP_init()…',
      draw: 'VDP_drawText()…', loop: 'while(1) doVBlank', exited: 'reset',
    }[phase];
  }
  raf = requestAnimationFrame(frame);
}

/* ==========================================================================
   Lab 05a — the SGDK build pipeline, animated.
   main.c + resources.res → m68k-elf-gcc → objects → rescomp/link → rom.bin
   ========================================================================== */
function BuildLab(root) {
  const canvas = root.querySelector('canvas');
  const { c, dpr } = labCanvas(canvas);
  const vis = watchVisibility(root);

  const STAGES = [
    { file: 'main.c',   size: '1.4 KB',  tool: 'm68k-elf-gcc', desc: 'your C source (plus resources.res) — compiled to Motorola 68000 machine code by m68k-elf-gcc, one object file per source file' },
    { file: 'main.o',   size: '4.0 KB',  tool: 'rescomp',      desc: 'relocatable 68000 object code. Meanwhile rescomp turns resources.res — your tiles, palettes, maps and music — into an object too' },
    { file: 'assets.o', size: '96 KB',   tool: 'm68k-elf-ld',  desc: 'the compiled resources: tilesets, palettes and XGM music as raw data. The linker now fuses everything with SGDK’s libmd' },
    { file: 'rom.out',  size: '512 KB',  tool: 'objcopy',      desc: 'a full ELF executable with symbols & debug info — emulators can load this for debugging; objcopy strips it to a raw image' },
    { file: 'rom.bin',  size: '512 KB',  tool: null,           desc: 'the finished cartridge image: a raw big-endian .bin/.md ROM with the header at 0x100 and the 68000 vector table at 0x0 — this is what you run' },
  ];
  let stage = 0, anim = 0, running = false;

  const stepBtn = root.querySelector('[data-build-step]');
  const runBtn = root.querySelector('[data-build-run]');
  const resetBtn = root.querySelector('[data-build-reset]');
  const stageRO = root.querySelector('[data-build-stage]');
  const sizeRO = root.querySelector('[data-build-size]');

  function advance() { if (stage < STAGES.length - 1 && anim === 0) anim = 0.0001; }
  stepBtn.addEventListener('click', () => { running = false; advance(); });
  runBtn.addEventListener('click', () => { running = true; advance(); });
  resetBtn.addEventListener('click', () => { running = false; stage = 0; anim = 0; });

  let raf, last = 0;
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (!vis.visible) { last = ts; return; }
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts;

    if (anim > 0) {
      anim += dt * (REDUCE_MOTION ? 6 : 1.1);
      if (anim >= 1) {
        anim = 0; stage++;
        if (running && stage < STAGES.length - 1) anim = 0.0001;
      }
    }

    const W = canvas.width, H = canvas.height;
    c.clearRect(0, 0, W, H);
    grid(c, W, H, 10, 3);

    const n = STAGES.length;
    const bw = Math.min(140 * dpr, (W - 30 * dpr) / n - 18 * dpr);
    const gap = (W - n * bw) / (n + 1);
    const by = H * 0.30, bh = H * 0.34;

    STAGES.forEach((s, i) => {
      const x = gap + i * (bw + gap);
      const built = i <= stage;
      c.fillStyle = built ? PAL.panel2 : PAL.panel;
      c.strokeStyle = built ? PAL.good : PAL.line2;
      c.lineWidth = (built ? 1.8 : 1.2) * dpr;
      roundRect(c, x, by, bw, bh, 9 * dpr); c.fill(); c.stroke();
      c.textAlign = 'center';
      c.font = `700 ${11.5 * dpr}px ui-monospace, Menlo, monospace`;
      c.fillStyle = built ? PAL.ink : PAL.muted;
      c.fillText(s.file, x + bw / 2, by + bh * 0.42);
      c.font = `600 ${9.5 * dpr}px ui-monospace, Menlo, monospace`;
      c.fillStyle = built ? PAL.good : '#3a4055';
      c.fillText(built ? s.size : '· · ·', x + bw / 2, by + bh * 0.72);
      if (i < n - 1) {
        const ax0 = x + bw + 5 * dpr, ax1 = x + bw + gap - 5 * dpr, ay = by + bh / 2;
        c.strokeStyle = i < stage ? PAL.good : PAL.line2;
        c.lineWidth = 1.6 * dpr;
        c.beginPath(); c.moveTo(ax0, ay); c.lineTo(ax1 - 6 * dpr, ay); c.stroke();
        c.beginPath(); c.moveTo(ax1, ay); c.lineTo(ax1 - 7 * dpr, ay - 4.5 * dpr); c.lineTo(ax1 - 7 * dpr, ay + 4.5 * dpr); c.closePath();
        c.fillStyle = i < stage ? PAL.good : PAL.line2; c.fill();
        c.font = `600 ${9 * dpr}px ui-monospace, Menlo, monospace`;
        c.fillStyle = i === stage && anim > 0 ? PAL.blue : PAL.muted;
        c.fillText(STAGES[i].tool, (ax0 + ax1) / 2, by - 14 * dpr);
        if (i === stage && anim > 0) {
          const tx = ax0 + (ax1 - ax0) * anim;
          c.fillStyle = PAL.blue;
          c.beginPath(); c.arc(tx, ay, 4.5 * dpr, 0, Math.PI * 2); c.fill();
        }
      }
      c.textAlign = 'left';
    });

    c.font = `500 ${11 * dpr}px ui-monospace, Menlo, monospace`;
    c.fillStyle = PAL.ink2;
    c.textAlign = 'center';
    wrapText(c, STAGES[stage].desc, W / 2, by + bh + 26 * dpr, W - 60 * dpr, 15 * dpr);
    c.textAlign = 'left';

    if (stageRO) stageRO.textContent = STAGES[stage].file;
    if (sizeRO) sizeRO.textContent = STAGES[stage].size;
  }
  raf = requestAnimationFrame(frame);
}

/* ==========================================================================
   Lab 05b — ROM-header inspector. We synthesise a plausible Genesis cartridge
   header (the 256 bytes at 0x100) and let you click each field group to see
   which bytes it owns and what they say. Everything is big-endian.
   ========================================================================== */
function RomLab(root) {
  const hexEl = root.querySelector('[data-rom-hex]');
  const fieldsEl = root.querySelector('[data-rom-fields]');
  const decodeEl = root.querySelector('[data-rom-decode]');

  const BASE = 0x100;
  const bytes = new Uint8Array(0x100);   // the header block 0x100..0x1FF
  const putStr = (off, str, len) => {
    for (let i = 0; i < len; i++) bytes[off + i] = i < str.length ? str.charCodeAt(i) & 0xff : 0x20;
  };
  const putU32 = (off, v) => {
    bytes[off] = (v >>> 24) & 0xff; bytes[off + 1] = (v >>> 16) & 0xff;
    bytes[off + 2] = (v >>> 8) & 0xff; bytes[off + 3] = v & 0xff;
  };
  const putU16 = (off, v) => { bytes[off] = (v >>> 8) & 0xff; bytes[off + 1] = v & 0xff; };

  // offsets are relative to the block (file offset = 0x100 + index)
  putStr(0x00, 'SEGA MEGA DRIVE ', 16);                              // 0x100 console name
  putStr(0x10, '(C)T-000 2026.JUL', 16);                            // 0x110 copyright + date (truncated to 16)
  putStr(0x20, 'HOMEBREW DEMO                                   ', 48); // 0x120 domestic title
  putStr(0x50, 'HOMEBREW DEMO                                   ', 48); // 0x150 overseas title
  putStr(0x80, 'GM 00000000-00', 14);                               // 0x180 type + serial + rev
  putU16(0x8E, 0x1A3C);                                             // 0x18E checksum (illustrative)
  putStr(0x90, 'J               ', 16);                             // 0x190 device support (J = 3-button pad)
  putU32(0xA0, 0x00000000);                                        // 0x1A0 ROM start
  putU32(0xA4, 0x0007FFFF);                                        // 0x1A4 ROM end (512 KB - 1)
  putU32(0xA8, 0x00FF0000);                                        // 0x1A8 RAM start
  putU32(0xAC, 0x00FFFFFF);                                        // 0x1AC RAM end
  putStr(0xB0, '            ', 12);                                 // 0x1B0 SRAM info (none)
  putStr(0xBC, '            ', 12);                                 // 0x1BC modem
  putStr(0xC8, '                                        ', 40);    // 0x1C8 reserved/notes
  putStr(0xF0, 'JUE             ', 16);                             // 0x1F0 region support

  const hx = (v, w) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(w || 8, '0');
  const rd32 = off => ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
  const rd16 = off => ((bytes[off] << 8) | bytes[off + 1]) >>> 0;
  const str = (off, len) => { let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i]); return s.replace(/\s+$/, ''); };

  const FIELDS = [
    { a: 0x00, b: 0x10, name: 'System name',
      d: () => `The 16-byte console signature — <code>"${str(0x00, 16)}"</code>. Later TMSS machines refuse to run a cartridge that doesn't begin with <b>"SEGA"</b> here (and also require the ROM to write "SEGA" to a hardware register at boot). Overseas carts often read <code>"SEGA GENESIS"</code> instead.` },
    { a: 0x10, b: 0x20, name: 'Copyright',
      d: () => `Publisher and build date: <code>"${str(0x10, 16)}"</code>. Format is <code>(C)</code> + a company code + a <code>YYYY.MMM</code> date. Homebrew simply invents its own — nothing checks it.` },
    { a: 0x20, b: 0x50, name: 'Domestic title',
      d: () => `The 48-byte game name shown on Japanese systems: <code>"${str(0x20, 48)}"</code>. Plain ASCII, space-padded to fill the field.` },
    { a: 0x50, b: 0x80, name: 'Overseas title',
      d: () => `The 48-byte international game name: <code>"${str(0x50, 48)}"</code>. Usually identical to, or a translation of, the domestic title.` },
    { a: 0x80, b: 0x8E, name: 'Serial / type',
      d: () => `Product type and serial: <code>"${str(0x80, 14)}"</code>. <b>GM</b> = a game cartridge (<b>AI</b> = education, etc.), then an 8-digit serial and a 2-digit revision.` },
    { a: 0x8E, b: 0x90, name: 'Checksum',
      d: () => `A 16-bit checksum (<code>${hx(rd16(0x8E), 4)}</code>): the big-endian sum of every word of the ROM from <code>0x200</code> onward. The stock boot ROM doesn't verify it, but many tools recompute it — SGDK fills it in for you at build time.` },
    { a: 0x90, b: 0xA0, name: 'I/O support',
      d: () => `Which peripherals the game understands: <code>"${str(0x90, 16)}"</code>. <b>J</b> = a standard 3-button joypad; a <b>6</b> here declares 6-button support; other letters cover the mouse, multitap, light gun and more.` },
    { a: 0xA0, b: 0xA8, name: 'ROM range',
      d: () => `Start and end addresses of the cartridge ROM in the 68000's address space: <code>${hx(rd32(0xA0))}</code> to <code>${hx(rd32(0xA4))}</code> — here a ${((rd32(0xA4) + 1) / 1024).toFixed(0)} KB ROM. The 68000 has a 24-bit address bus, so a flat ROM tops out at 4 MB (bigger carts add a mapper).` },
    { a: 0xA8, b: 0xB0, name: 'RAM range',
      d: () => `The 68000 work RAM window: <code>${hx(rd32(0xA8))}</code> to <code>${hx(rd32(0xAC))}</code> — the console's 64 KB of main RAM, mirrored across the top of the map.` },
    { a: 0xB0, b: 0xBC, name: 'Backup (SRAM)',
      d: () => `Battery-backed save RAM info. All spaces here means <b>no SRAM</b>; a cart with saves writes <code>"RA"</code> plus flags and an address range so the game can persist high scores or progress.` },
    { a: 0xF0, b: 0x100, name: 'Region',
      d: () => `Which regions the cart runs on: <code>"${str(0xF0, 16)}"</code>. <b>J</b> = Japan, <b>U</b> = Americas (NTSC), <b>E</b> = Europe (PAL). The letters here drive lockout and the 60 Hz / 50 Hz decision on real hardware.` },
  ];

  // --- render the hex grid (16 rows × 16 bytes) with an ASCII gutter --------
  const cells = [], ascCells = [];
  for (let row = 0; row < 16; row++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    const off = document.createElement('span');
    off.className = 'off';
    off.textContent = '0x' + (BASE + row * 16).toString(16).toUpperCase().padStart(3, '0');
    rowEl.appendChild(off);
    for (let colIdx = 0; colIdx < 16; colIdx++) {
      const i = row * 16 + colIdx;
      const b = document.createElement('span');
      b.className = 'b' + (bytes[i] === 0 ? ' dim' : '');
      b.textContent = bytes[i].toString(16).toUpperCase().padStart(2, '0');
      rowEl.appendChild(b);
      cells.push(b);
    }
    const asc = document.createElement('span');
    asc.className = 'asc';
    for (let colIdx = 0; colIdx < 16; colIdx++) {
      const i = row * 16 + colIdx;
      const ch = document.createElement('span');
      ch.className = 'ac';
      const v = bytes[i];
      ch.textContent = (v >= 0x20 && v < 0x7f) ? String.fromCharCode(v) : '·';
      asc.appendChild(ch);
      ascCells.push(ch);
    }
    rowEl.appendChild(asc);
    hexEl.appendChild(rowEl);
  }

  // --- field buttons ------------------------------------------------------
  let onBtn = null;
  FIELDS.forEach(f => {
    const btn = document.createElement('button');
    btn.innerHTML = `<span class="rng">${hx(BASE + f.a, 3)}–${hx(BASE + f.b - 1, 3)}</span><span>${f.name}</span>`;
    btn.addEventListener('click', () => {
      if (onBtn) onBtn.classList.remove('on');
      onBtn = btn; btn.classList.add('on');
      cells.forEach((cel, i) => cel.classList.toggle('hi', i >= f.a && i < f.b));
      ascCells.forEach((cel, i) => cel.classList.toggle('hi', i >= f.a && i < f.b));
      decodeEl.innerHTML = f.d();
    });
    fieldsEl.appendChild(btn);
  });
  // start with the system-name field selected — the TMSS story
  fieldsEl.children[0].click();
}

/* ==========================================================================
   Lab 09 — controller tester. Keyboard (or a connected gamepad) drives a
   drawn Genesis pad, and we show exactly what JOY_readJoypad(JOY_1) returns:
   the live 12-bit mask, in 3-button or 6-button mode.
   ========================================================================== */
function PadLab(root) {
  const canvas = root.querySelector('canvas');
  const { c, dpr } = labCanvas(canvas);
  const vis = watchVisibility(root);

  const maskRO = root.querySelector('[data-pad-mask]');
  const binRO = root.querySelector('[data-pad-bin]');
  const namesRO = root.querySelector('[data-pad-names]');
  const modeBtns = [...root.querySelectorAll('[data-pad-mode] button')];

  let sixButton = false;

  // SGDK joy.h bit assignments (BUTTON_*)
  const BITS = {
    UP: 0x0001, DOWN: 0x0002, LEFT: 0x0004, RIGHT: 0x0008,
    B: 0x0010, C: 0x0020, A: 0x0040, START: 0x0080,
    Z: 0x0100, Y: 0x0200, X: 0x0400, MODE: 0x0800,
  };
  const EXTRA = new Set(['X', 'Y', 'Z', 'MODE']);
  const KEYMAP = {
    ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
    KeyA: 'A', KeyS: 'B', KeyD: 'C', Enter: 'START',
    KeyZ: 'X', KeyX: 'Y', KeyC: 'Z', KeyV: 'MODE',
  };

  modeBtns.forEach((b, i) => b.addEventListener('click', () => {
    sixButton = i === 1;
    modeBtns.forEach(x => x.classList.remove('on'));
    b.classList.add('on');
  }));

  const held = new Set();
  const gpHeld = new Set();

  window.addEventListener('keydown', e => {
    const b = KEYMAP[e.code];
    if (!b) return;
    if (!vis.visible) return;
    if (EXTRA.has(b) && !sixButton) return;
    e.preventDefault();
    held.add(b);
  });
  window.addEventListener('keyup', e => {
    const b = KEYMAP[e.code];
    if (b) held.delete(b);
  });

  function pollGamepad() {
    if (!navigator.getGamepads) return;
    const gp = [...navigator.getGamepads()].find(g => g && g.connected);
    if (!gp) return;
    // approximate standard-mapping → Genesis translation
    const map = [['A', 0], ['B', 1], ['C', 2], ['Y', 3], ['X', 4], ['Z', 5], ['MODE', 8], ['START', 9], ['UP', 12], ['DOWN', 13], ['LEFT', 14], ['RIGHT', 15]];
    map.forEach(([name, idx]) => {
      if (EXTRA.has(name) && !sixButton) { if (gpHeld.has(name)) { held.delete(name); gpHeld.delete(name); } return; }
      const btn = gp.buttons[idx];
      if (btn && btn.pressed) { held.add(name); gpHeld.add(name); }
      else if (gpHeld.has(name)) { held.delete(name); gpHeld.delete(name); }
    });
  }

  let raf, last = 0;
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (!vis.visible) { last = ts; return; }
    last = ts;
    pollGamepad();

    let mask = 0;
    held.forEach(b => { if (!(EXTRA.has(b) && !sixButton)) mask |= BITS[b]; });

    const W = canvas.width, H = canvas.height;
    c.clearRect(0, 0, W, H);

    const cx = W / 2, cy = H * 0.54;
    const u = Math.min(W, H * 1.7) / 620;
    c.save();
    c.translate(cx, cy);

    // rounded body (the classic Genesis pad silhouette)
    c.fillStyle = PAL.panel2;
    c.strokeStyle = PAL.line2; c.lineWidth = 2 * dpr;
    roundRect(c, -235 * u, -70 * u, 470 * u, 150 * u, 74 * u); c.fill(); c.stroke();

    const btn = (x, y, r, on, color, label) => {
      c.beginPath(); c.arc(x * u, y * u, r * u, 0, Math.PI * 2);
      c.fillStyle = on ? color : PAL.panel;
      c.fill();
      c.strokeStyle = on ? color : PAL.line2; c.lineWidth = 1.6 * dpr; c.stroke();
      if (label) {
        c.fillStyle = on ? '#0a0b10' : PAL.muted;
        c.font = `700 ${Math.max(9, r * 0.82) * u}px ui-monospace, Menlo, monospace`;
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(label, x * u, y * u + u);
        c.textBaseline = 'alphabetic'; c.textAlign = 'left';
      }
    };

    // D-pad (left) — a plus of four pads
    const dx = -150, dy = 0, dp = 26;
    c.fillStyle = PAL.ground;
    roundRect(c, (dx - dp - 13) * u, (dy - 13) * u, (dp * 2 + 26) * u, 26 * u, 6 * u); c.fill();
    roundRect(c, (dx - 13) * u, (dy - dp - 13) * u, 26 * u, (dp * 2 + 26) * u, 6 * u); c.fill();
    btn(dx, dy - dp, 12, held.has('UP'), PAL.blue, '▲');
    btn(dx, dy + dp, 12, held.has('DOWN'), PAL.blue, '▼');
    btn(dx - dp, dy, 12, held.has('LEFT'), PAL.blue, '◀');
    btn(dx + dp, dy, 12, held.has('RIGHT'), PAL.blue, '▶');

    // START in the middle (a small oblong)
    c.fillStyle = held.has('START') ? PAL.gold : PAL.panel;
    c.strokeStyle = held.has('START') ? PAL.gold : PAL.line2; c.lineWidth = 1.6 * dpr;
    roundRect(c, -22 * u, 42 * u, 44 * u, 15 * u, 7 * u); c.fill(); c.stroke();
    c.fillStyle = held.has('START') ? '#0a0b10' : PAL.muted;
    c.font = `700 ${9 * u}px ui-monospace, Menlo, monospace`;
    c.textAlign = 'center'; c.fillText('START', 0, 53 * u); c.textAlign = 'left';

    // MODE (6-button) — a small oblong opposite START
    if (sixButton) {
      c.fillStyle = held.has('MODE') ? PAL.gold : PAL.panel;
      c.strokeStyle = held.has('MODE') ? PAL.gold : PAL.line2;
      roundRect(c, -22 * u, -58 * u, 44 * u, 15 * u, 7 * u); c.fill(); c.stroke();
      c.fillStyle = held.has('MODE') ? '#0a0b10' : PAL.muted;
      c.textAlign = 'center'; c.fillText('MODE', 0, -47 * u); c.textAlign = 'left';
    }

    // face buttons (right) — A B C on an arc, X Y Z above them for 6-button
    btn(120, 20, 18, held.has('A'), PAL.red, 'A');
    btn(168, 6, 18, held.has('B'), PAL.red, 'B');
    btn(214, -6, 18, held.has('C'), PAL.red, 'C');
    if (sixButton) {
      btn(120, -30, 15, held.has('X'), PAL.amber, 'X');
      btn(166, -42, 15, held.has('Y'), PAL.amber, 'Y');
      btn(210, -52, 15, held.has('Z'), PAL.amber, 'Z');
    }

    c.restore();

    // readouts
    const bitCount = sixButton ? 12 : 8;
    if (maskRO) maskRO.textContent = '0x' + mask.toString(16).toUpperCase().padStart(3, '0');
    if (binRO) binRO.textContent = mask.toString(2).padStart(bitCount, '0');
    if (namesRO) namesRO.textContent = mask
      ? [...held].filter(b => !(EXTRA.has(b) && !sixButton)).sort((a, b2) => BITS[a] - BITS[b2]).map(b => 'BUTTON_' + b).join(' | ')
      : '0 (nothing held)';
  }
  raf = requestAnimationFrame(frame);
}

/* ==========================================================================
   Lab 10 — the frame budget. A tiny playable game whose loop is the
   canonical  read → update → draw → doVBlankProcess  shape. A slider adds
   pretend "work" per frame; blow past 16.7 ms (NTSC) and the loop starts
   missing vblanks — the game visibly drops to 30 Hz, exactly like hardware.
   ========================================================================== */
function LoopLab(root) {
  const canvas = root.querySelector('canvas');
  const { c, dpr } = labCanvas(canvas);
  const vis = watchVisibility(root);

  const workR = root.querySelector('[data-loop-work]');
  const workV = root.querySelector('[data-loop-work-val]');
  const fpsRO = root.querySelector('[data-loop-fps]');
  const missRO = root.querySelector('[data-loop-missed]');
  const scoreRO = root.querySelector('[data-loop-score]');

  let workMs = 6;
  workR.addEventListener('input', () => { workMs = parseFloat(workR.value); workV.textContent = workMs.toFixed(0) + ' ms'; });

  const G = {
    px: 0.5, bx: 0.5, by: 0.35, vx: 0.31, vy: 0.42,
    score: 0, missed: 0, presented: 0, vsyncs: 0,
  };
  let leftHeld = false, rightHeld = false;
  window.addEventListener('keydown', e => {
    if (!vis.visible) return;
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') { leftHeld = true; e.preventDefault(); }
    if (e.code === 'ArrowRight' || e.code === 'KeyD') { rightHeld = true; e.preventDefault(); }
  });
  window.addEventListener('keyup', e => {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') leftHeld = false;
    if (e.code === 'ArrowRight' || e.code === 'KeyD') rightHeld = false;
  });
  canvas.addEventListener('pointermove', e => {
    const r = canvas.getBoundingClientRect();
    G.px = Math.max(0.08, Math.min(0.92, (e.clientX - r.left) / r.width));
  });

  function update(dt) {
    if (leftHeld) G.px = Math.max(0.08, G.px - dt * 0.9);
    if (rightHeld) G.px = Math.min(0.92, G.px + dt * 0.9);
    G.bx += G.vx * dt; G.by += G.vy * dt;
    if (G.bx < 0.02 || G.bx > 0.98) G.vx *= -1;
    if (G.by < 0.04) G.vy *= -1;
    if (G.by > 0.88 && G.vy > 0 && Math.abs(G.bx - G.px) < 0.09) { G.vy *= -1; G.vx += (G.bx - G.px) * 1.6; G.score++; }
    if (G.by > 1.05) { G.by = 0.2; G.bx = 0.2 + Math.random() * 0.6; G.vy = Math.abs(G.vy); G.score = Math.max(0, G.score - 2); }
  }

  const VSYNC = 1000 / 60;      // 16.67 ms — the NTSC frame budget
  let sinceTick = 0, framesToSkip = 0, fpsWindow = [], raf, last = 0;

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (!vis.visible) { last = ts; return; }
    const dtms = Math.min(50, ts - last || 16.7);
    last = ts;
    sinceTick += dtms;

    while (sinceTick >= VSYNC) {
      sinceTick -= VSYNC;
      G.vsyncs++;
      if (framesToSkip > 0) { framesToSkip--; G.missed++; continue; }
      const need = Math.max(1, Math.ceil(workMs / VSYNC));
      framesToSkip = need - 1;
      update(need * VSYNC / 1000);
      G.presented++;
      fpsWindow.push(performance.now());
    }
    fpsWindow = fpsWindow.filter(t2 => performance.now() - t2 < 1000);

    const W = canvas.width, H = canvas.height;
    c.clearRect(0, 0, W, H);

    c.strokeStyle = PAL.line2; c.lineWidth = dpr;
    c.strokeRect(1, 1, W - 2, H * 0.94 - 2);
    c.fillStyle = PAL.blue;
    c.beginPath(); c.arc(G.bx * W, G.by * H * 0.94, 7 * dpr, 0, Math.PI * 2); c.fill();
    c.fillStyle = PAL.red;
    roundRect(c, (G.px - 0.08) * W, H * 0.88, 0.16 * W, 8 * dpr, 4 * dpr); c.fill();

    // frame-time meter along the bottom
    const my = H * 0.955, mh = H * 0.035;
    const budgetW = W * 0.55;
    c.fillStyle = PAL.panel2;
    c.fillRect(0, my, W, mh);
    const frac = Math.min(2.2, workMs / VSYNC);
    c.fillStyle = workMs <= VSYNC ? PAL.good : PAL.bad;
    c.fillRect(0, my, budgetW * frac, mh);
    c.strokeStyle = PAL.ink; c.lineWidth = dpr * 1.4;
    c.beginPath(); c.moveTo(budgetW, my - 2 * dpr); c.lineTo(budgetW, my + mh + 2 * dpr); c.stroke();
    c.font = `600 ${9.5 * dpr}px ui-monospace, Menlo, monospace`;
    c.fillStyle = PAL.muted;
    c.fillText('work per frame', 6 * dpr, my + mh - 4 * dpr);
    c.fillStyle = PAL.ink2;
    c.fillText('16.7 ms budget (NTSC)', budgetW + 8 * dpr, my + mh - 4 * dpr);

    if (fpsRO) {
      const fps = fpsWindow.length;
      fpsRO.textContent = fps + ' fps';
      fpsRO.parentElement.classList.toggle('bad', fps < 45);
      fpsRO.parentElement.classList.toggle('good', fps >= 55);
    }
    if (missRO) missRO.textContent = String(G.missed);
    if (scoreRO) scoreRO.textContent = String(G.score);
  }
  raf = requestAnimationFrame(frame);
}

/* ==========================================================================
   Widgets: OS tabs, copy buttons, checklists
   ========================================================================== */
function initOsTabs() {
  document.querySelectorAll('.os-tabs').forEach(tabs => {
    const btns = [...tabs.querySelectorAll('.tab-row button')];
    const panels = [...tabs.querySelectorAll('.tab-panel')];
    btns.forEach((b, i) => b.addEventListener('click', () => {
      btns.forEach(x => x.classList.remove('on'));
      panels.forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      panels[i].classList.add('on');
    }));
    const plat = (navigator.platform || '') + ' ' + navigator.userAgent;
    let idx = 0;
    if (/Mac/i.test(plat)) idx = 1;
    else if (/Linux|X11/i.test(plat) && !/Android/i.test(plat)) idx = 2;
    if (btns[idx]) btns[idx].click();
  });
}

function initCopyButtons() {
  document.querySelectorAll('.code').forEach(block => {
    const btn = block.querySelector('.copy');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const pre = block.querySelector('pre');
      const text = pre.innerText.split('\n').map(l => l.replace(/^\$ /, '')).join('\n').trim();
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'copied ✓'; btn.classList.add('ok');
        setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('ok'); }, 1600);
      } catch { btn.textContent = 'select & copy manually'; }
    });
  });
}

function initChecklists() {
  document.querySelectorAll('.checklist input[type=checkbox]').forEach(cb => {
    const key = 'mdhb-' + cb.id;
    try { if (localStorage.getItem(key) === '1') { cb.checked = true; cb.closest('label').classList.add('done'); } } catch {}
    cb.addEventListener('change', () => {
      cb.closest('label').classList.toggle('done', cb.checked);
      try { localStorage.setItem(key, cb.checked ? '1' : '0'); } catch {}
    });
  });
}

/* ==========================================================================
   Boot
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  const heroCanvas = document.getElementById('hero-tokens');
  if (heroCanvas) heroAmbient(heroCanvas);

  const boot = document.getElementById('lab-boot'); if (boot) BootLab(boot);
  const bl = document.getElementById('lab-build'); if (bl) BuildLab(bl);
  const rl = document.getElementById('lab-rom'); if (rl) RomLab(rl);
  const pl = document.getElementById('lab-pad'); if (pl) PadLab(pl);
  const ll = document.getElementById('lab-loop'); if (ll) LoopLab(ll);

  initOsTabs();
  initCopyButtons();
  initChecklists();
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
  document.body.appendChild(tip);
  let current = null;

  function place(el) {
    current = el;
    tip.innerHTML = `<span class="tt">${el.textContent}</span> — ${el.dataset.tip}`;
    tip.classList.add('show');
    const r = el.getBoundingClientRect();
    const tw = Math.min(340, window.innerWidth - 24);
    tip.style.maxWidth = tw + 'px';
    const tr = tip.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - tr.width - 12));
    let top = r.top - tr.height - 10;
    tip.classList.toggle('below', top < 8);
    if (top < 8) top = r.bottom + 10;
    tip.style.left = left + 'px';
    tip.style.top = (top + window.scrollY) + 'px';
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
