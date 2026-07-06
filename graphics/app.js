/* ============================================================================
   Genesis Graphics — interactive layer
   Everything you see is drawn live in your browser with the 2D canvas API.
   The tile editors, palette explorer, nametable, scroll planes, sprite engine,
   raster wobble, shadow/highlight blend and scanline renderer all run their own
   tiny software VDP, exactly the algorithms the course describes. No WebGL, no
   libraries, and NO game art ships with this page — every pixel is procedural.
   ============================================================================ */
'use strict';

/* ------------------------------------------------------------- helpers ---- */
const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" style="width:13px;height:13px"><path d="M8 5v14l11-7z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor" style="width:13px;height:13px"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/* Size a canvas's bitmap to its CSS box × devicePixelRatio (capped at 2). */
function fit(canvas, dprMax = 2) {
  const dpr = Math.min(window.devicePixelRatio || 1, dprMax);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  return dpr;
}

/* Tell a lab when it scrolls into / out of view so animations can pause. */
function whenVisible(el, cb) {
  if (!('IntersectionObserver' in window)) { cb(true); return; }
  const obs = new IntersectionObserver(
    es => es.forEach(e => cb(e.isIntersecting)),
    { rootMargin: '100px' }
  );
  obs.observe(el);
}

/* segmented buttons: exclusive selection within one .seg-btns group. */
function segGroup(group, attr, onPick) {
  if (!group) return;
  group.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    group.querySelectorAll('button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    onPick(b.dataset[attr], b);
  }));
}

/* ---- shared VDP-ish building blocks -------------------------------------- */
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function makePal(arr) { return arr.map(h => h === null ? null : hex(h)); }

/* Four 16-colour CRAM lines (index 0 = transparent). Genesis-flavoured. */
const LINES = [
  makePal([null, '#0c0e16', '#ffffff', '#ff5347', '#ffc44d', '#3fb5ff', '#4fd08a', '#e23b30',
    '#2a6cc0', '#c98a1e', '#9aa3b8', '#c8cede', '#a05a2c', '#5f3418', '#ff9d3c', '#2f3348']),
  makePal([null, '#0c0e16', '#f4f7ff', '#5aa0ff', '#8fd0ff', '#2f6bd0', '#c8e6ff', '#1e4fa0',
    '#33507a', '#6f9fd8', '#8f98ad', '#cfd6e6', '#3a6fb0', '#22406f', '#a7d4ff', '#2a3350']),
  makePal([null, '#120a0c', '#ffe9c0', '#ff8a3c', '#ffc44d', '#e2452f', '#ffd77a', '#a52a1c',
    '#7a3b20', '#d88a2a', '#a88f78', '#e6d4b8', '#c07030', '#6a3b1c', '#ffb14e', '#3a2b28']),
  makePal([null, '#08120c', '#d8ffe0', '#4fd08a', '#a7f0c0', '#2a9a5e', '#7fe6a8', '#1e6b40',
    '#2f5a44', '#68c890', '#889a8f', '#cfe6d8', '#3aa068', '#1e4030', '#8fe6b0', '#22332a']),
];

/* Parse a 64-char index string ("0"–"f") into a Uint8Array(64) tile. */
function tile(str) {
  const t = new Uint8Array(64);
  for (let i = 0; i < 64; i++) t[i] = parseInt(str[i], 16) || 0;
  return t;
}

/* A small library of 8×8 patterns (palette indices). */
const TILES = {
  blank: tile('0000000000000000000000000000000000000000000000000000000000000000'),
  brick: tile('333333330777777037777770377777703333333307777703077777030777770333333333'.slice(0, 64)),
  grass: tile('6666666666666666656656656565565666666666666666666556655665565565'),
  sky:   tile('5555555555555555555555555555555b5555555b5555bbb555bbbbbb55555555b'),
  stone: tile('aaaaaaaaa9aaaa9aaaaaaaaaaa9aa9aaaaaaaaaaa9aaaa9aaaaaaaaaaaaaaaaaa'),
  water: tile('8585858558585858858585855858585885858585585858588585858558585858'),
  gold:  tile('4444444444999444499aa9944499994444999944449aa9444499944444444444'),
  face:  tile('0033330003bbbb3033b22b3333bbbb3333b33b3303bbbb30003bb30000033300'),
};

/* Paint an 8×8 tile with optional H/V flip via fillRect (index 0 transparent). */
function paintTile(ctx, t, x, y, cell, pal, hf, vf) {
  for (let ty = 0; ty < 8; ty++) {
    for (let tx = 0; tx < 8; tx++) {
      const sx = hf ? 7 - tx : tx, sy = vf ? 7 - ty : ty;
      const c = pal[t[sy * 8 + sx]];
      if (!c) continue;
      ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
      ctx.fillRect(x + tx * cell, y + ty * cell, cell + 0.6, cell + 0.6);
    }
  }
}

/* ==========================================================================
   Module 01 — pixel-grid lab (mirrors the sibling course's opener)
   A scene painted onto an N×N offscreen canvas, read back, channel-masked and
   blown up with smoothing OFF so each pixel is a visible square.
   ========================================================================== */
function PixelLab(root) {
  const canvas = root.querySelector('.gfx');
  const ctx = canvas.getContext('2d');
  const resR = root.querySelector('[data-res]');
  const resV = root.querySelector('[data-res-val]');
  const info = root.querySelector('[data-pix-info]');
  const chans = { r: true, g: true, b: true };
  const off = document.createElement('canvas');
  const octx = off.getContext('2d', { willReadFrequently: true });
  let img = null, N = 0, dpr = 1;

  function n() { return Math.pow(2, parseInt(resR.value, 10)); }

  function paintScene(s) {
    const g = octx;
    g.clearRect(0, 0, s, s);
    const sky = g.createLinearGradient(0, 0, 0, s);
    sky.addColorStop(0, '#12213f'); sky.addColorStop(0.7, '#3a6bb0');
    g.fillStyle = sky; g.fillRect(0, 0, s, s);
    g.fillStyle = '#ffc44d';                       // 16-bit gold sun
    g.beginPath(); g.arc(s * 0.76, s * 0.22, s * 0.12, 0, 7); g.fill();
    g.fillStyle = '#4fd08a';                       // hills
    g.beginPath(); g.arc(s * 0.24, s * 1.16, s * 0.5, 0, 7); g.fill();
    g.fillStyle = '#2a9a5e';
    g.beginPath(); g.arc(s * 0.86, s * 1.26, s * 0.55, 0, 7); g.fill();
    g.fillStyle = '#ff5347';                       // a little red craft
    g.beginPath(); g.arc(s * 0.44, s * 0.5, s * 0.14, 0, 7); g.fill();
    g.fillStyle = '#0c0e16';
    g.beginPath(); g.arc(s * 0.44, s * 0.48, s * 0.06, 0, 7); g.fill();
  }

  function rebuild() {
    N = n(); off.width = off.height = N; paintScene(N);
    img = octx.getImageData(0, 0, N, N);
    resV.textContent = N + ' × ' + N;
    draw(); defaultInfo();
  }
  function defaultInfo() {
    const bytes = N * N * 3;
    info.innerHTML = '<b>' + N + ' × ' + N + '</b> = ' + (N * N).toLocaleString('en-GB')
      + ' pixels · 3 bytes each → <b>' + (bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB' : bytes + ' B')
      + '</b> · hover a pixel to read its numbers';
  }
  function draw() {
    dpr = fit(canvas);
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const view = new ImageData(new Uint8ClampedArray(img.data), N, N);
    const d = view.data;
    for (let i = 0; i < d.length; i += 4) {
      if (!chans.r) d[i] = 0; if (!chans.g) d[i + 1] = 0; if (!chans.b) d[i + 2] = 0;
    }
    off.width = off.height = N;
    octx.putImageData(view, 0, 0);
    const size = Math.min(W, H) - 16 * dpr;
    const x0 = (W - size) / 2, y0 = (H - size) / 2;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, x0, y0, size, size);
    if (N <= 32) {
      ctx.strokeStyle = 'rgba(6,7,12,0.55)'; ctx.lineWidth = 1;
      for (let i = 1; i < N; i++) {
        const t = x0 + size * i / N;
        ctx.beginPath(); ctx.moveTo(t, y0); ctx.lineTo(t, y0 + size); ctx.stroke();
        const u = y0 + size * i / N;
        ctx.beginPath(); ctx.moveTo(x0, u); ctx.lineTo(x0 + size, u); ctx.stroke();
      }
    }
    ctx.strokeStyle = 'rgba(52,58,77,0.9)'; ctx.strokeRect(x0, y0, size, size);
    canvas.__geo = { x0, y0, size };
    octx.putImageData(img, 0, 0);
  }
  canvas.addEventListener('pointermove', e => {
    const g = canvas.__geo; if (!g) return;
    const r = canvas.getBoundingClientRect();
    const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
    const cx = Math.floor((px - g.x0) / g.size * N), cy = Math.floor((py - g.y0) / g.size * N);
    if (cx < 0 || cy < 0 || cx >= N || cy >= N) { defaultInfo(); return; }
    const i = (cy * N + cx) * 4, d = img.data;
    info.innerHTML = 'pixel (' + cx + ', ' + cy + ') = '
      + '<b style="color:#ff5f5a">R ' + d[i] + '</b> · '
      + '<b style="color:#5fd18b">G ' + d[i + 1] + '</b> · '
      + '<b style="color:#5aa8ff">B ' + d[i + 2] + '</b>';
  });
  canvas.addEventListener('pointerleave', defaultInfo);
  root.querySelectorAll('.chan-btns button').forEach(b => b.addEventListener('click', () => {
    b.classList.toggle('on'); chans[b.dataset.ch] = b.classList.contains('on'); draw();
  }));
  resR.addEventListener('input', rebuild);
  window.addEventListener('resize', draw);
  rebuild();
}

/* ==========================================================================
   Module 02 — tile / pattern editor (8×8, 4bpp, 16 colours)
   Paint one Genesis pattern with a 16-entry palette line; watch it tile.
   ========================================================================== */
function TileLab(root) {
  const canvas = root.querySelector('.gfx');
  const ctx = canvas.getContext('2d');
  const swWrap = root.querySelector('[data-tile-pal]');
  const info = root.querySelector('[data-tile-info]');
  const pal = LINES[0];
  let cur = new Uint8Array(TILES.face);   // start from a friendly face
  let sel = 3, dpr = 1;

  // build 16 palette swatches
  pal.forEach((c, i) => {
    const d = document.createElement('div'); d.className = 'sw' + (i === sel ? ' sel' : '');
    const ii = document.createElement('i');
    ii.style.background = c ? 'rgb(' + c.join(',') + ')' : 'repeating-conic-gradient(#333 0 25%, #555 0 50%) 0/10px 10px';
    const sp = document.createElement('span'); sp.textContent = i.toString(16);
    d.appendChild(ii); d.appendChild(sp);
    d.addEventListener('click', () => {
      sel = i; swWrap.querySelectorAll('.sw').forEach((s, k) => s.classList.toggle('sel', k === i));
    });
    swWrap.appendChild(d);
  });

  function count() { let n = 0; for (let i = 0; i < 64; i++) if (cur[i]) n++; return n; }

  function draw() {
    dpr = fit(canvas);
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const pad = 14 * dpr;
    const editSize = Math.min(H - pad * 2, W * 0.56);
    const cell = editSize / 8;
    const x0 = pad, y0 = (H - editSize) / 2;
    // checker under transparent
    ctx.fillStyle = '#0a0c12'; ctx.fillRect(x0, y0, editSize, editSize);
    for (let ty = 0; ty < 8; ty++) for (let tx = 0; tx < 8; tx++) {
      if ((tx + ty) & 1) { ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fillRect(x0 + tx * cell, y0 + ty * cell, cell, cell); }
    }
    paintTile(ctx, cur, x0, y0, cell, pal, false, false);
    ctx.strokeStyle = 'rgba(52,58,77,0.8)'; ctx.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      ctx.beginPath(); ctx.moveTo(x0 + i * cell, y0); ctx.lineTo(x0 + i * cell, y0 + editSize); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, y0 + i * cell); ctx.lineTo(x0 + editSize, y0 + i * cell); ctx.stroke();
    }
    canvas.__geo = { x0, y0, cell };
    // tiled preview (4×4) on the right
    const pv = Math.min(H - pad * 2, W - editSize - pad * 3);
    const pcell = pv / 32, px0 = x0 + editSize + pad, py0 = (H - pv) / 2;
    ctx.fillStyle = '#06070c'; ctx.fillRect(px0, py0, pv, pv);
    for (let ry = 0; ry < 4; ry++) for (let rx = 0; rx < 4; rx++)
      paintTile(ctx, cur, px0 + rx * 8 * pcell, py0 + ry * 8 * pcell, pcell, pal, false, false);
    ctx.strokeStyle = 'rgba(52,58,77,0.8)'; ctx.strokeRect(px0, py0, pv, pv);
    ctx.fillStyle = '#7e8599'; ctx.font = (10 * dpr) + 'px ' + 'ui-monospace, Menlo, monospace';
    ctx.fillText('one tile, repeated 4×4 →', px0, py0 - 5 * dpr);
    info.innerHTML = '<b>8 × 8</b> pixels · 4 bits/pixel → <b>32 bytes</b> in VRAM · '
      + count() + ' of 64 pixels are opaque (index ≠ 0) · painting with index <b>' + sel.toString(16) + '</b>';
  }
  function paintAt(e) {
    const g = canvas.__geo; if (!g) return;
    const r = canvas.getBoundingClientRect();
    const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
    const tx = Math.floor((px - g.x0) / g.cell), ty = Math.floor((py - g.y0) / g.cell);
    if (tx < 0 || ty < 0 || tx > 7 || ty > 7) return;
    cur[ty * 8 + tx] = sel; draw();
  }
  canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); paintAt(e); e.preventDefault(); });
  canvas.addEventListener('pointermove', e => { if (e.buttons) paintAt(e); });
  segGroup(root.querySelector('[data-tile-preset]'), 'p', p => {
    cur = new Uint8Array(TILES[p] || TILES.blank); draw();
  });
  window.addEventListener('resize', draw);
  draw();
}

/* ==========================================================================
   Module 03 — CRAM palette explorer (4 lines × 16, 9-bit BGR)
   Edit one entry's 3-bit R/G/B and read the raw CRAM word.
   ========================================================================== */
function PaletteLab(root) {
  const canvas = root.querySelector('.gfx');
  const ctx = canvas.getContext('2d');
  const rR = root.querySelector('[data-cr]'), gR = root.querySelector('[data-cg]'), bR = root.querySelector('[data-cb]');
  const rV = root.querySelector('[data-cr-val]'), gV = root.querySelector('[data-cg-val]'), bV = root.querySelector('[data-cb-val]');
  const info = root.querySelector('[data-pal-info]');
  // 64 entries as 3-bit triplets, seeded from the four LINES (quantised to 0..7)
  const cram = [];
  for (let l = 0; l < 4; l++) for (let i = 0; i < 16; i++) {
    const c = LINES[l][i] || [0, 0, 0];
    cram.push([Math.round(c[0] / 255 * 7), Math.round(c[1] / 255 * 7), Math.round(c[2] / 255 * 7)]);
  }
  let sel = 3, dpr = 1;
  const lvl = v => Math.round(v * 255 / 7);
  const css = t => 'rgb(' + lvl(t[0]) + ',' + lvl(t[1]) + ',' + lvl(t[2]) + ')';

  function syncSliders() {
    const t = cram[sel];
    rR.value = t[0]; gR.value = t[1]; bR.value = t[2];
    rV.textContent = t[0]; gV.textContent = t[1]; bV.textContent = t[2];
  }
  function draw() {
    dpr = fit(canvas);
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const pad = 14 * dpr;
    const gridW = W * 0.62;
    const cw = (gridW - pad) / 16, ch = cw;
    const gx = pad, gy = pad + 12 * dpr;
    ctx.fillStyle = '#7e8599'; ctx.font = (10 * dpr) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText('CRAM — 4 lines × 16 entries', gx, pad + 2 * dpr);
    for (let l = 0; l < 4; l++) {
      ctx.fillText('L' + l, gx - 0 * dpr, gy + l * ch + ch * 0.62);
    }
    for (let i = 0; i < 64; i++) {
      const l = i >> 4, c = i & 15;
      const x = gx + 20 * dpr + c * cw, y = gy + l * ch;
      const t = cram[i];
      if (i % 16 === 0 && (LINES[l][0] === null)) { /* index 0 transparent marker */ }
      ctx.fillStyle = (i % 16 === 0) ? '#0a0c12' : css(t);
      ctx.fillRect(x, y, cw - 1.5, ch - 1.5);
      if (i % 16 === 0) { ctx.strokeStyle = '#343a4d'; ctx.strokeRect(x + .5, y + .5, cw - 2.5, ch - 2.5); }
      if (i === sel) { ctx.strokeStyle = '#ffc44d'; ctx.lineWidth = 2.5 * dpr; ctx.strokeRect(x + 1, y + 1, cw - 3.5, ch - 3.5); ctx.lineWidth = 1; }
    }
    canvas.__geo = { gx: gx + 20 * dpr, gy, cw, ch };
    // big preview + word readout
    const t = cram[sel];
    const bx = gx + 20 * dpr + 16 * cw + pad, bw = W - bx - pad;
    const bh = 70 * dpr;
    ctx.fillStyle = (sel % 16 === 0) ? '#0a0c12' : css(t);
    ctx.fillRect(bx, gy, bw, bh);
    ctx.strokeStyle = '#343a4d'; ctx.strokeRect(bx + .5, gy + .5, bw - 1, bh - 1);
    const word = (t[2] << 9) | (t[1] << 5) | (t[0] << 1);  // Genesis CRAM: 0000 BBB0 GGG0 RRR0
    const hexw = '0x' + word.toString(16).toUpperCase().padStart(4, '0');
    ctx.fillStyle = '#eef1f8'; ctx.font = '700 ' + (13 * dpr) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText('line ' + (sel >> 4) + ' · entry ' + (sel & 15), bx, gy + bh + 20 * dpr);
    ctx.fillStyle = '#3fb5ff';
    ctx.fillText(hexw, bx, gy + bh + 40 * dpr);
    ctx.fillStyle = '#7e8599'; ctx.font = (10.5 * dpr) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText('BBB GGG RRR = ' + t[2] + ' ' + t[1] + ' ' + t[0], bx, gy + bh + 58 * dpr);
    info.innerHTML = '<b>64</b> entries live in 128 bytes of CRAM · 3 bits/channel → 8 levels each → '
      + '<b>512</b> master colours · this entry = ' + hexw + (sel % 16 === 0 ? ' <span class="m">(index 0 = backdrop / transparent)</span>' : '');
  }
  canvas.addEventListener('pointerdown', e => {
    const g = canvas.__geo; if (!g) return;
    const r = canvas.getBoundingClientRect();
    const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
    const c = Math.floor((px - g.gx) / g.cw), l = Math.floor((py - g.gy) / g.ch);
    if (c < 0 || c > 15 || l < 0 || l > 3) return;
    sel = l * 16 + c; syncSliders(); draw();
  });
  [rR, gR, bR].forEach((el, k) => el.addEventListener('input', () => {
    cram[sel][k] = parseInt(el.value, 10); syncSliders(); draw();
  }));
  window.addEventListener('resize', draw);
  syncSliders(); draw();
}

/* ==========================================================================
   Module 04 — nametable / tilemap lab
   Place tiles with attributes (palette line, H/V flip, priority) and read the
   decoded 16-bit nametable word.
   ========================================================================== */
function NameLab(root) {
  const canvas = root.querySelector('.gfx');
  const ctx = canvas.getContext('2d');
  const info = root.querySelector('[data-name-info]');
  const COLS = 12, ROWS = 8;
  const palette = ['blank', 'brick', 'grass', 'stone', 'gold', 'water', 'face'];
  const brush = { tile: 1, pal: 0, hf: false, vf: false, pri: false };
  const map = new Array(COLS * ROWS).fill(null);
  let dpr = 1, last = null;

  function draw() {
    dpr = fit(canvas);
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const pad = 12 * dpr, palH = 42 * dpr;
    const gW = W - pad * 2, gH = H - pad * 2 - palH;
    const cell = Math.min(gW / COLS, gH / ROWS);
    const x0 = (W - cell * COLS) / 2, y0 = pad;
    // grid cells
    for (let i = 0; i < COLS * ROWS; i++) {
      const cx = x0 + (i % COLS) * cell, cy = y0 + Math.floor(i / COLS) * cell;
      ctx.fillStyle = '#0a0c12'; ctx.fillRect(cx, cy, cell, cell);
      const e = map[i];
      if (e) {
        paintTile(ctx, TILES[palette[e.tile]], cx, cy, cell / 8, LINES[e.pal], e.hf, e.vf);
        if (e.pri) { ctx.fillStyle = '#ffc44d'; ctx.fillRect(cx + cell - 6 * dpr, cy + 2 * dpr, 4 * dpr, 4 * dpr); }
      }
      ctx.strokeStyle = 'rgba(52,58,77,0.55)'; ctx.strokeRect(cx + .5, cy + .5, cell, cell);
    }
    canvas.__geo = { x0, y0, cell };
    // brush tile palette strip along the bottom
    const py = H - palH + 4 * dpr, ps = palH - 10 * dpr;
    ctx.fillStyle = '#7e8599'; ctx.font = (9.5 * dpr) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText('brush tiles →', pad, py - 4 * dpr);
    canvas.__pal = [];
    for (let i = 0; i < palette.length; i++) {
      const bx = pad + 84 * dpr + i * (ps + 6 * dpr);
      ctx.fillStyle = '#06070c'; ctx.fillRect(bx, py, ps, ps);
      if (i > 0) paintTile(ctx, TILES[palette[i]], bx, py, ps / 8, LINES[brush.pal], false, false);
      else { ctx.strokeStyle = '#343a4d'; ctx.strokeRect(bx + 2, py + 2, ps - 4, ps - 4); ctx.fillStyle = '#4a5064'; ctx.fillText('✕', bx + ps / 2 - 3 * dpr, py + ps / 2 + 4 * dpr); }
      ctx.strokeStyle = i === brush.tile ? '#ffc44d' : '#343a4d';
      ctx.lineWidth = i === brush.tile ? 2.4 * dpr : 1;
      ctx.strokeRect(bx + 1, py + 1, ps - 2, ps - 2); ctx.lineWidth = 1;
      canvas.__pal.push({ bx, py, ps, i });
    }
    // readout: decode last placed word
    if (last !== null) {
      const e = map[last] || { tile: 0, pal: 0, hf: 0, vf: 0, pri: 0 };
      const word = ((e.pri ? 1 : 0) << 15) | (e.pal << 13) | ((e.vf ? 1 : 0) << 12) | ((e.hf ? 1 : 0) << 11) | (e.tile & 0x7ff);
      const bin = word.toString(2).padStart(16, '0');
      info.innerHTML = 'cell ' + last + ' → word <b>0x' + word.toString(16).toUpperCase().padStart(4, '0')
        + '</b> = <span class="m">' + bin.slice(0, 1) + '</span>·<span class="v">' + bin.slice(1, 3)
        + '</span>·' + bin.slice(3, 4) + bin.slice(4, 5) + '·' + bin.slice(5)
        + ' (pri·pal·V·H·tile) · pal line ' + e.pal + (e.hf ? ' ·Hflip' : '') + (e.vf ? ' ·Vflip' : '') + (e.pri ? ' ·priority' : '');
    } else {
      info.innerHTML = 'pick a brush tile + attributes, then click a cell — each entry is one <b>16-bit</b> nametable word';
    }
  }
  canvas.addEventListener('pointerdown', e => {
    const r = canvas.getBoundingClientRect();
    const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
    // palette strip?
    if (canvas.__pal) for (const p of canvas.__pal) {
      if (px >= p.bx && px <= p.bx + p.ps && py >= p.py && py <= p.py + p.ps) { brush.tile = p.i; draw(); return; }
    }
    const g = canvas.__geo; if (!g) return;
    const cx = Math.floor((px - g.x0) / g.cell), cy = Math.floor((py - g.y0) / g.cell);
    if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return;
    const idx = cy * COLS + cx;
    map[idx] = brush.tile === 0 ? null : { tile: brush.tile, pal: brush.pal, hf: brush.hf, vf: brush.vf, pri: brush.pri };
    last = idx; draw();
  });
  root.querySelectorAll('[data-attr]').forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.attr; brush[a] = !brush[a]; b.classList.toggle('on', brush[a]); draw();
  }));
  segGroup(root.querySelector('[data-pline]'), 'l', l => { brush.pal = +l; draw(); });
  window.addEventListener('resize', draw);
  draw();
}

/* ==========================================================================
   Module 05 — scrolling: a plane larger than the screen
   ========================================================================== */
function ScrollLab(root) {
  const canvas = root.querySelector('.gfx');
  const ctx = canvas.getContext('2d');
  const sxR = root.querySelector('[data-sx]'), syR = root.querySelector('[data-sy]');
  const playBtn = root.querySelector('[data-scroll-play]');
  const info = root.querySelector('[data-scroll-info]');
  const MW = 64, MH = 32;                          // plane size in cells (H40 max)
  const VW = 40, VH = 28;                          // H40 viewport in cells
  const mapArr = new Int8Array(MW * MH);
  // build a rolling landscape into the plane
  for (let x = 0; x < MW; x++) {
    const h = Math.round(MH * 0.55 + Math.sin(x * 0.3) * 3 + Math.sin(x * 0.11) * 4);
    for (let y = 0; y < MH; y++) {
      let t = 0; // sky
      if (y > h) t = (y === h + 1) ? 2 : 3;        // grass top then stone
      else if (y === h) t = 2;
      if (t === 0 && ((x * 3 + y * 7) % 29 === 0)) t = 4; // occasional gold star
      mapArr[y * MW + x] = t;
    }
  }
  const nameTiles = [TILES.sky, TILES.brick, TILES.grass, TILES.stone, TILES.gold];
  let dpr = 1, playing = !REDUCED, visible = false, raf = null, auto = 0, last = 0;

  function draw() {
    dpr = fit(canvas);
    const W = canvas.width, H = canvas.height;
    const cell = Math.min(W / VW, H / VH);
    const ox = (W - cell * VW) / 2, oy = (H - cell * VH) / 2;
    const pxPer = 8;                               // pixels per cell in plane space
    const sx = (parseInt(sxR.value, 10) + auto) % (MW * pxPer);
    const sy = parseInt(syR.value, 10) % (MH * pxPer);
    ctx.fillStyle = '#06070c'; ctx.fillRect(0, 0, W, H);
    const sub = cell / 8;
    for (let vy = -1; vy < VH + 1; vy++) for (let vx = -1; vx < VW + 1; vx++) {
      const worldX = Math.floor(sx / pxPer) + vx, worldY = Math.floor(sy / pxPer) + vy;
      const mx = ((worldX % MW) + MW) % MW, my = ((worldY % MH) + MH) % MH;
      const t = mapArr[my * MW + mx];
      const px = ox + vx * cell - (sx % pxPer) * sub, py = oy + vy * cell - (sy % pxPer) * sub;
      paintTile(ctx, nameTiles[t], px, py, sub, LINES[0], false, false);
    }
    // viewport frame + minimap
    ctx.strokeStyle = 'rgba(52,58,77,0.9)'; ctx.lineWidth = 1; ctx.strokeRect(ox, oy, cell * VW, cell * VH);
    const mmW = 120 * dpr, mmH = mmW * MH / MW, mmx = W - mmW - 10 * dpr, mmy = 10 * dpr;
    ctx.fillStyle = 'rgba(6,7,12,0.8)'; ctx.fillRect(mmx, mmy, mmW, mmH);
    ctx.strokeStyle = '#343a4d'; ctx.strokeRect(mmx, mmy, mmW, mmH);
    ctx.fillStyle = 'rgba(255,83,71,0.5)';
    const vwx = mmx + (sx / pxPer / MW) * mmW, vwy = mmy + (sy / pxPer / MH) * mmH;
    const vww = (VW / MW) * mmW, vwh = (VH / MH) * mmH;
    ctx.strokeStyle = '#ff5347'; ctx.lineWidth = 1.6 * dpr;
    // draw possibly-wrapped viewport box
    ctx.strokeRect(vwx, vwy, vww, vwh);
    if (vwx + vww > mmx + mmW) ctx.strokeRect(vwx - mmW, vwy, vww, vwh);
    ctx.lineWidth = 1;
    ctx.fillStyle = '#7e8599'; ctx.font = (9.5 * dpr) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText('plane 64×32', mmx, mmy + mmH + 12 * dpr);
    info.innerHTML = 'scroll registers · X <b>' + Math.round(sx) + '</b> Y <b>' + Math.round(sy)
      + '</b> px · plane is <b>512×256</b> px (64×32 cells), viewport <b>320×224</b> (H40) — the map wraps seamlessly';
  }
  function frame(ts) {
    raf = null; if (!last) last = ts;
    const dt = Math.min(0.05, (ts - last) / 1000); last = ts;
    if (playing) auto += dt * 46;
    draw();
    if (playing && visible) raf = requestAnimationFrame(frame);
  }
  function kick() { if (playing && visible && !raf) { last = 0; raf = requestAnimationFrame(frame); } }
  function syncBtn() { playBtn.innerHTML = (playing ? ICON_STOP : ICON_PLAY) + (playing ? ' Pause' : ' Auto-scroll'); }
  playBtn.addEventListener('click', () => { playing = !playing; syncBtn(); kick(); if (!playing) draw(); });
  [sxR, syR].forEach(el => el.addEventListener('input', draw));
  whenVisible(root, v => { visible = v; kick(); });
  window.addEventListener('resize', draw);
  syncBtn(); draw();
}

/* ==========================================================================
   Module 06 — sprites: a composed multi-cell sprite with flip & priority
   ========================================================================== */
function SpriteLab(root) {
  const canvas = root.querySelector('.gfx');
  const ctx = canvas.getContext('2d');
  const info = root.querySelector('[data-sprite-info]');
  const st = { hf: false, vf: false, pri: true, x: 0.42, y: 0.5 };
  let dpr = 1, drag = false;
  // a 3×3-cell (24×24) craft made of tiles referencing LINES[2] (warm)
  const cells = [
    TILES.blank, TILES.gold, TILES.blank,
    TILES.gold, TILES.face, TILES.gold,
    TILES.blank, TILES.stone, TILES.blank,
  ];
  const SC = 3;

  function draw() {
    dpr = fit(canvas);
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#06070c'; ctx.fillRect(0, 0, W, H);
    // background plane: sky + a foreground "wall" strip that priority interacts with
    const sub = Math.max(3 * dpr, Math.min(W, H) / 34);
    for (let y = 0; y * 8 * sub < H; y++) for (let x = 0; x * 8 * sub < W; x++) {
      const t = (y * 8 * sub > H * 0.68) ? TILES.grass : TILES.sky;
      paintTile(ctx, t, x * 8 * sub, y * 8 * sub, sub, LINES[1], false, false);
    }
    // a vertical wall (high-priority background) the sprite can hide behind
    const wallX = W * 0.62;
    for (let y = 0; y * 8 * sub < H; y++) paintTile(ctx, TILES.brick, wallX, y * 8 * sub, sub, LINES[0], false, false);

    const spx = st.x * W - SC * 4 * sub, spy = st.y * H - SC * 4 * sub;
    function blitSprite() {
      for (let cy = 0; cy < SC; cy++) for (let cx = 0; cx < SC; cx++) {
        const scx = st.hf ? SC - 1 - cx : cx, scy = st.vf ? SC - 1 - cy : cy;
        paintTile(ctx, cells[scy * SC + scx], spx + cx * 8 * sub, spy + cy * 8 * sub, sub, LINES[2], st.hf, st.vf);
      }
    }
    // priority: if low, the wall (drawn) already covers; we simulate by drawing
    // sprite BEFORE re-stamping the wall when low-priority, AFTER when high.
    if (st.pri) { blitSprite(); }
    else {
      // low priority: wall wins — redraw wall over sprite region
      blitSprite();
      for (let y = 0; y * 8 * sub < H; y++) paintTile(ctx, TILES.brick, wallX, y * 8 * sub, sub, LINES[0], false, false);
    }
    ctx.strokeStyle = 'rgba(255,196,77,0.7)'; ctx.lineWidth = 1.4 * dpr;
    ctx.strokeRect(spx, spy, SC * 8 * sub, SC * 8 * sub);
    ctx.fillStyle = '#7e8599'; ctx.font = (10 * dpr) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText('drag the sprite · brick wall = high-priority background', 12 * dpr, H - 12 * dpr);
    info.innerHTML = 'sprite: <b>3×3 cells</b> (24×24) · palette line 2 · '
      + (st.hf ? 'Hflip ' : '') + (st.vf ? 'Vflip ' : '') + 'priority <b>' + (st.pri ? 'high (in front)' : 'low (behind wall)')
      + '</b> · a sprite entry stores Y, size, link, pri/pal/flip, tile index, X';
  }
  function setPos(e) {
    const r = canvas.getBoundingClientRect();
    st.x = clamp((e.clientX - r.left) / r.width, 0.12, 0.88);
    st.y = clamp((e.clientY - r.top) / r.height, 0.15, 0.85); draw();
  }
  canvas.addEventListener('pointerdown', e => { drag = true; canvas.setPointerCapture(e.pointerId); setPos(e); e.preventDefault(); });
  canvas.addEventListener('pointermove', e => { if (drag) setPos(e); });
  canvas.addEventListener('pointerup', () => { drag = false; });
  root.querySelectorAll('[data-sp]').forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.sp; st[a] = !st[a]; b.classList.toggle('on', st[a]); draw();
  }));
  window.addEventListener('resize', draw);
  draw();
}

/* ==========================================================================
   Module 09 — planes A & B parallax scroller (independent speeds)
   ========================================================================== */
function PlanesLab(root) {
  const canvas = root.querySelector('.gfx');
  const ctx = canvas.getContext('2d');
  const aR = root.querySelector('[data-pa]'), bR = root.querySelector('[data-pb]');
  const aV = root.querySelector('[data-pa-val]'), bV = root.querySelector('[data-pb-val]');
  const playBtn = root.querySelector('[data-planes-play]');
  let dpr = 1, playing = !REDUCED, visible = false, raf = null, t = 0, last = 0;

  function layer(off, W, H, kind) {
    const sub = Math.max(3 * dpr, Math.min(W, H) / 30);
    if (kind === 'B') {                            // distant: stars + mountains
      for (let i = 0; i < 60; i++) {
        const x = ((i * 137 - off * 0.0) % W + W) % W;
        // handled below; stars belong to B slow
      }
      // mountains silhouette
      ctx.fillStyle = '#1a2740';
      for (let x = -1; x < W / (40 * dpr) + 1; x++) {
        const bx = x * 80 * dpr - (off % (80 * dpr));
        ctx.beginPath(); ctx.moveTo(bx, H); ctx.lineTo(bx + 40 * dpr, H * 0.45); ctx.lineTo(bx + 80 * dpr, H); ctx.closePath(); ctx.fill();
      }
    } else {                                       // near: ground + trees
      const groundY = H * 0.72;
      ctx.fillStyle = '#123021'; ctx.fillRect(0, groundY, W, H - groundY);
      for (let x = -1; x < W / (56 * dpr) + 1; x++) {
        const bx = x * 56 * dpr - (off % (56 * dpr));
        ctx.fillStyle = '#2a9a5e';
        ctx.beginPath(); ctx.arc(bx + 20 * dpr, groundY - 4 * dpr, 16 * dpr, 0, 7); ctx.fill();
        ctx.fillStyle = '#5f3418'; ctx.fillRect(bx + 17 * dpr, groundY - 4 * dpr, 6 * dpr, 18 * dpr);
      }
    }
  }
  function draw() {
    dpr = fit(canvas);
    const W = canvas.width, H = canvas.height;
    // sky gradient backdrop
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#0d1830'); sky.addColorStop(1, '#2a4a7a');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    const spB = parseFloat(bR.value), spA = parseFloat(aR.value);
    aV.textContent = spA.toFixed(1) + '×'; bV.textContent = spB.toFixed(1) + '×';
    const offB = t * spB * 30, offA = t * spA * 30;
    // Plane B stars (slow)
    ctx.fillStyle = '#c8cede';
    for (let i = 0; i < 70; i++) {
      const x = ((i * 173 - offB) % W + W) % W;
      const y = (i * 61) % Math.floor(H * 0.6);
      ctx.fillRect(x, y, 2 * dpr, 2 * dpr);
    }
    layer(offB, W, H, 'B');                        // Plane B mountains
    // gold sun on plane B
    ctx.fillStyle = '#ffc44d'; ctx.beginPath(); ctx.arc(W * 0.8, H * 0.24, 22 * dpr, 0, 7); ctx.fill();
    layer(offA, W, H, 'A');                        // Plane A foreground
    ctx.fillStyle = '#7e8599'; ctx.font = (10 * dpr) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText('Plane B (far) ' + spB.toFixed(1) + '× · Plane A (near) ' + spA.toFixed(1) + '× — same registers, different speeds = depth', 12 * dpr, 18 * dpr);
  }
  function frame(ts) {
    raf = null; if (!last) last = ts;
    const dt = Math.min(0.05, (ts - last) / 1000); last = ts;
    if (playing) t += dt; draw();
    if (playing && visible) raf = requestAnimationFrame(frame);
  }
  function kick() { if (playing && visible && !raf) { last = 0; raf = requestAnimationFrame(frame); } }
  function syncBtn() { playBtn.innerHTML = (playing ? ICON_STOP : ICON_PLAY) + (playing ? ' Pause' : ' Play'); }
  playBtn.addEventListener('click', () => { playing = !playing; syncBtn(); kick(); if (!playing) draw(); });
  [aR, bR].forEach(el => el.addEventListener('input', draw));
  whenVisible(root, v => { visible = v; kick(); });
  window.addEventListener('resize', draw);
  syncBtn(); draw();
}

/* ==========================================================================
   Module 10 — the sprite engine & its per-scanline limits
   ========================================================================== */
function SpriteEngineLab(root) {
  const canvas = root.querySelector('.gfx');
  const ctx = canvas.getContext('2d');
  const nR = root.querySelector('[data-num]'), yR = root.querySelector('[data-line]'), wR = root.querySelector('[data-w]');
  const nV = root.querySelector('[data-num-val]'), wV = root.querySelector('[data-w-val]');
  const info = root.querySelector('[data-eng-info]');
  let mode = 'h40', dpr = 1;
  // stable pseudo-random sprite field
  const sprites = [];
  { let s = 90125; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let i = 0; i < 40; i++) sprites.push({ x: rnd(), y: rnd(), c: 3 + (i % 5) }); }

  function draw() {
    dpr = fit(canvas);
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#06070c'; ctx.fillRect(0, 0, W, H);
    const N = parseInt(nR.value, 10), wCells = parseInt(wR.value, 10);
    nV.textContent = N; wV.textContent = wCells + '×1 cell (' + (wCells * 8) + 'px)';
    const lineLimit = mode === 'h40' ? 20 : 16;
    const pxLimit = mode === 'h40' ? 320 : 256;
    const scanY = parseInt(yR.value, 10) / 100 * H;
    const spW = wCells * 8 * dpr, spH = 8 * dpr * 2;
    // gather sprites crossing the scanline, in table (index) order
    const active = [];
    for (let i = 0; i < N; i++) {
      const sp = sprites[i];
      const px = 10 * dpr + sp.x * (W - 20 * dpr - spW), py = 10 * dpr + sp.y * (H - 20 * dpr - spH);
      const crosses = scanY >= py && scanY <= py + spH;
      active.push({ px, py, crosses, c: LINES[0][sp.c], i });
    }
    // apply per-line limits in order (count limit AND 320-pixel budget)
    let cnt = 0, pxUsed = 0;                        // pxUsed in logical VDP pixels
    for (const a of active) {
      if (!a.crosses) { a.state = 'off'; continue; }
      if (cnt >= lineLimit || pxUsed + wCells * 8 > pxLimit) { a.state = 'dropped'; continue; }
      a.state = 'shown'; cnt++; pxUsed += wCells * 8;
    }
    // draw non-crossing faint, crossing shown solid, dropped hatched
    for (const a of active) {
      if (a.state === 'off') { ctx.globalAlpha = 0.32; }
      else ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgb(' + a.c.join(',') + ')';
      if (a.state === 'dropped') {
        ctx.globalAlpha = 0.9; ctx.strokeStyle = '#ff5f5f'; ctx.lineWidth = 1.6 * dpr;
        ctx.strokeRect(a.px, a.py, spW, spH);
        ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(a.px + spW, a.py + spH); ctx.stroke();
      } else {
        ctx.fillRect(a.px, a.py, spW, spH);
      }
      ctx.globalAlpha = 1;
    }
    // the scanline bar
    ctx.strokeStyle = '#3fb5ff'; ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(0, scanY); ctx.lineTo(W, scanY); ctx.stroke();
    ctx.fillStyle = 'rgba(63,181,255,0.9)'; ctx.font = '700 ' + (10 * dpr) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText('scanline', 6 * dpr, scanY - 5 * dpr);
    const dropped = active.filter(a => a.state === 'dropped').length;
    info.innerHTML = mode.toUpperCase() + ' · on this line: <b>' + cnt + '</b>/' + lineLimit + ' sprites · '
      + '<b>' + pxUsed + '</b>/' + pxLimit + ' sprite-pixels'
      + (dropped ? ' · <span class="v">' + dropped + ' dropped (red ✕)</span>' : ' · none dropped');
  }
  segGroup(root.querySelector('[data-mode]'), 'm', m => { mode = m; draw(); });
  [nR, yR, wR].forEach(el => el.addEventListener('input', draw));
  window.addEventListener('resize', draw);
  draw();
}

/* ==========================================================================
   Module 11 — per-line horizontal scroll: the water / wobble raster effect
   ========================================================================== */
function RasterLab(root) {
  const canvas = root.querySelector('.gfx');
  const ctx = canvas.getContext('2d');
  const ampR = root.querySelector('[data-amp]'), frqR = root.querySelector('[data-frq]');
  const ampV = root.querySelector('[data-amp-val]'), frqV = root.querySelector('[data-frq-val]');
  const playBtn = root.querySelector('[data-raster-play]');
  const IW = 320, IH = 180;
  const src = document.createElement('canvas'); src.width = IW; src.height = IH;
  const sctx = src.getContext('2d');
  let dpr = 1, playing = !REDUCED, visible = false, raf = null, t = 0, last = 0;

  function paintSource() {
    const sky = sctx.createLinearGradient(0, 0, 0, IH * 0.5);
    sky.addColorStop(0, '#12213f'); sky.addColorStop(1, '#3a6bb0');
    sctx.fillStyle = sky; sctx.fillRect(0, 0, IW, IH * 0.5);
    sctx.fillStyle = '#ffc44d'; sctx.beginPath(); sctx.arc(IW * 0.7, IH * 0.2, 18, 0, 7); sctx.fill();
    sctx.fillStyle = '#1a2740';
    for (let x = -1; x < 6; x++) { const bx = x * 70 + 20; sctx.beginPath(); sctx.moveTo(bx, IH * 0.5); sctx.lineTo(bx + 35, IH * 0.2); sctx.lineTo(bx + 70, IH * 0.5); sctx.fill(); }
    // reflected lower half (what the wobble will ripple)
    sctx.save(); sctx.translate(0, IH); sctx.scale(1, -1);
    sctx.globalAlpha = 0.85; sctx.drawImage(src, 0, 0, IW, IH * 0.5, 0, 0, IW, IH * 0.5); sctx.restore();
    sctx.fillStyle = 'rgba(42,74,122,0.35)'; sctx.fillRect(0, IH * 0.5, IW, IH * 0.5);
  }
  function draw() {
    dpr = fit(canvas);
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#06070c'; ctx.fillRect(0, 0, W, H);
    const amp = parseFloat(ampR.value), frq = parseFloat(frqR.value) / 100;
    ampV.textContent = amp.toFixed(0) + ' px'; frqV.textContent = frq.toFixed(2);
    const scale = Math.min(W / IW, H / IH);
    const ox = (W - IW * scale) / 2, oy = (H - IH * scale) / 2;
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < IH; y++) {
      let dx = 0;
      if (y > IH * 0.5) dx = Math.sin(y * frq + t * 2.2) * amp * ((y - IH * 0.5) / (IH * 0.5)); // only ripple the reflection
      ctx.drawImage(src, 0, y, IW, 1, ox + dx * scale, oy + y * scale, IW * scale, scale + 1);
    }
    ctx.strokeStyle = 'rgba(63,181,255,0.5)'; ctx.setLineDash([5 * dpr, 5 * dpr]);
    ctx.beginPath(); ctx.moveTo(ox, oy + IH * 0.5 * scale); ctx.lineTo(ox + IW * scale, oy + IH * 0.5 * scale); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#7e8599'; ctx.font = (10 * dpr) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText('each scanline gets its own H-scroll value (per-line mode) → water', ox + 4 * dpr, oy + 14 * dpr);
  }
  function frame(ts) {
    raf = null; if (!last) last = ts;
    const dt = Math.min(0.05, (ts - last) / 1000); last = ts;
    if (playing) t += dt; draw();
    if (playing && visible) raf = requestAnimationFrame(frame);
  }
  function kick() { if (playing && visible && !raf) { last = 0; raf = requestAnimationFrame(frame); } }
  function syncBtn() { playBtn.innerHTML = (playing ? ICON_STOP : ICON_PLAY) + (playing ? ' Pause' : ' Play'); }
  playBtn.addEventListener('click', () => { playing = !playing; syncBtn(); kick(); if (!playing) draw(); });
  [ampR, frqR].forEach(el => el.addEventListener('input', draw));
  whenVisible(root, v => { visible = v; kick(); });
  window.addEventListener('resize', draw);
  paintSource(); syncBtn(); draw();
}

/* ==========================================================================
   Module 12 — shadow / highlight blend toggler
   ========================================================================== */
function ShadowLab(root) {
  const canvas = root.querySelector('.gfx');
  const ctx = canvas.getContext('2d');
  const info = root.querySelector('[data-sh-info]');
  let on = true, region = 'shadow', bx = 0.5, dpr = 1, drag = false;

  function draw() {
    dpr = fit(canvas);
    const W = canvas.width, H = canvas.height;
    // colourful base scene
    const sub = Math.max(3 * dpr, Math.min(W, H) / 26);
    for (let y = 0; y * 8 * sub < H; y++) for (let x = 0; x * 8 * sub < W; x++) {
      const t = (y % 2 ? TILES.gold : TILES.grass);
      paintTile(ctx, x % 2 ? TILES.brick : t, x * 8 * sub, y * 8 * sub, sub, LINES[(x + y) % 4], false, false);
    }
    // the effect box
    const boxW = W * 0.34, boxX = clamp(bx, 0.18, 0.82) * W - boxW / 2, boxY = H * 0.2, boxH = H * 0.6;
    if (on) {
      const img = ctx.getImageData(boxX, boxY, boxW, boxH);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        if (region === 'shadow') { d[i] *= 0.5; d[i + 1] *= 0.5; d[i + 2] *= 0.5; }
        else { d[i] = 128 + d[i] * 0.5; d[i + 1] = 128 + d[i + 1] * 0.5; d[i + 2] = 128 + d[i + 2] * 0.5; }
      }
      ctx.putImageData(img, boxX, boxY);
    }
    ctx.strokeStyle = region === 'shadow' ? '#3fb5ff' : '#ffc44d';
    ctx.lineWidth = 2 * dpr; ctx.strokeRect(boxX, boxY, boxW, boxH);
    ctx.fillStyle = '#eef1f8'; ctx.font = '700 ' + (11 * dpr) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText(on ? region + ' zone' : 'effect OFF', boxX + 8 * dpr, boxY + 18 * dpr);
    ctx.fillStyle = '#7e8599'; ctx.font = (10 * dpr) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText('drag the zone', 12 * dpr, H - 12 * dpr);
    info.innerHTML = 'shadow/highlight mode <b>' + (on ? 'ON' : 'OFF') + '</b> · zone = <span class="' + (region === 'shadow' ? 'v' : 'm') + '">' + region
      + '</span> · shadow halves intensity, highlight raises the floor — one bit gives 3 brightness tiers from the same 64 colours';
  }
  root.querySelector('[data-sh-toggle]').addEventListener('click', e => {
    on = !on; e.currentTarget.classList.toggle('on', on);
    e.currentTarget.textContent = 'S/H mode: ' + (on ? 'ON' : 'OFF'); draw();
  });
  segGroup(root.querySelector('[data-sh-region]'), 'r', r => { region = r; draw(); });
  function setBox(e) { const r = canvas.getBoundingClientRect(); bx = (e.clientX - r.left) / r.width; draw(); }
  canvas.addEventListener('pointerdown', e => { drag = true; canvas.setPointerCapture(e.pointerId); setBox(e); e.preventDefault(); });
  canvas.addEventListener('pointermove', e => { if (drag) setBox(e); });
  canvas.addEventListener('pointerup', () => { drag = false; });
  window.addEventListener('resize', draw);
  draw();
}

/* ==========================================================================
   Module 14 — scanline renderer: draw a frame one line at a time
   ========================================================================== */
function ScanlineLab(root) {
  const canvas = root.querySelector('.gfx');
  const ctx = canvas.getContext('2d');
  const spR = root.querySelector('[data-speed]'), splR = root.querySelector('[data-split]');
  const splV = root.querySelector('[data-split-val]');
  const playBtn = root.querySelector('[data-scan-play]');
  const info = root.querySelector('[data-scan-info]');
  const LINES_N = 224;
  const IW = 320;
  const frame = document.createElement('canvas'); frame.width = IW; frame.height = LINES_N;
  const fctx = frame.getContext('2d');
  let dpr = 1, playing = !REDUCED, visible = false, raf = null, beam = 0, last = 0;

  function renderLine(y, split) {
    // backdrop colour changes at the split line (a raster split)
    fctx.fillStyle = y < split ? '#12213f' : '#251230';
    fctx.fillRect(0, y, IW, 1);
    // plane B: a gold sun band + stars
    if (y > 24 && y < 60) { fctx.fillStyle = 'rgba(255,196,77,' + (0.5 - Math.abs(y - 42) / 60) + ')'; fctx.fillRect(210, y, 40, 1); }
    if ((y * 37) % 53 === 0) { fctx.fillStyle = '#c8cede'; fctx.fillRect((y * 71) % IW, y, 2, 1); }
    // plane A: rolling hills below horizon
    const horizon = 150;
    if (y >= horizon) {
      fctx.fillStyle = y === horizon ? '#4fd08a' : '#2a9a5e'; fctx.fillRect(0, y, IW, 1);
      for (let x = 0; x < IW; x += 4) if ((x + y * 3) % 23 === 0) { fctx.fillStyle = '#1e6b40'; fctx.fillRect(x, y, 3, 1); }
    }
    // a sprite (red craft) around the middle
    const spy = 90;
    if (y >= spy && y < spy + 16) { const w = 22 - Math.abs(y - (spy + 8)); fctx.fillStyle = '#ff5347'; fctx.fillRect(150 - w, y, w * 2, 1); }
  }
  function draw() {
    dpr = fit(canvas);
    const W = canvas.width, H = canvas.height;
    const split = parseInt(splR.value, 10);
    splV.textContent = 'line ' + split;
    const scale = Math.min(W / IW, H / LINES_N);
    const ox = (W - IW * scale) / 2, oy = (H - LINES_N * scale) / 2;
    ctx.fillStyle = '#06070c'; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    // (re)render every line up to the beam this frame so split changes show
    for (let y = 0; y <= Math.floor(beam) && y < LINES_N; y++) renderLine(y, split);
    // draw rendered region
    const drawn = Math.min(LINES_N, Math.floor(beam) + 1);
    ctx.drawImage(frame, 0, 0, IW, drawn, ox, oy, IW * scale, drawn * scale);
    // undrawn region: dim
    ctx.fillStyle = 'rgba(10,11,16,0.9)';
    ctx.fillRect(ox, oy + drawn * scale, IW * scale, (LINES_N - drawn) * scale);
    // the raster beam bar
    const by = oy + Math.min(LINES_N - 1, beam) * scale;
    ctx.fillStyle = 'rgba(63,181,255,0.85)'; ctx.fillRect(ox, by, IW * scale, 2 * dpr);
    ctx.fillStyle = 'rgba(63,181,255,0.14)'; ctx.fillRect(ox, by, IW * scale, 6 * dpr);
    // split marker
    const sy = oy + split * scale;
    ctx.strokeStyle = 'rgba(255,196,77,0.7)'; ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(ox, sy); ctx.lineTo(ox + IW * scale, sy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#ffc44d'; ctx.font = (9.5 * dpr) + 'px ui-monospace, Menlo, monospace';
    ctx.fillText('HBlank split → new backdrop', ox + 4 * dpr, sy - 4 * dpr);
    info.innerHTML = 'beam at scanline <b>' + Math.min(LINES_N, Math.floor(beam)) + '</b> / ' + LINES_N
      + ' · the VDP composites planes + sprites <b>one line at a time</b>; a register write at line ' + split + ' changes the backdrop mid-frame';
  }
  function step(ts) {
    raf = null; if (!last) last = ts;
    const dt = Math.min(0.05, (ts - last) / 1000); last = ts;
    if (playing) { beam += dt * parseFloat(spR.value); if (beam >= LINES_N) beam = 0; }
    draw();
    if (playing && visible) raf = requestAnimationFrame(step);
  }
  function kick() { if (playing && visible && !raf) { last = 0; raf = requestAnimationFrame(step); } }
  function syncBtn() { playBtn.innerHTML = (playing ? ICON_STOP : ICON_PLAY) + (playing ? ' Pause' : ' Play'); }
  playBtn.addEventListener('click', () => { playing = !playing; syncBtn(); kick(); if (!playing) draw(); });
  splR.addEventListener('input', draw);
  whenVisible(root, v => { visible = v; kick(); });
  window.addEventListener('resize', draw);
  syncBtn(); draw();
}

/* ------------------------------------------------------- hero ambient ----- */
/* A drifting nametable of tiles dissolving into scanlines — the course's arc
   (pixels → tiles → planes → scanout) in one ornament. Reduced-motion aware. */
function heroAmbient(canvas) {
  const c = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let t = 0, raf = null, visible = true;
  function size() { const r = canvas.getBoundingClientRect(); canvas.width = r.width * dpr; canvas.height = r.height * dpr; }
  size(); window.addEventListener('resize', size);
  const cols = ['#ff5347', '#3fb5ff', '#ffc44d', '#4fd08a'];
  function draw() {
    const W = canvas.width, H = canvas.height;
    c.clearRect(0, 0, W, H);
    const cell = 26 * dpr;
    for (let y = 0; y * cell < H; y++) for (let x = 0; x * cell < W; x++) {
      const n = Math.sin(x * 0.6 + t * 0.5) + Math.cos(y * 0.7 - t * 0.4);
      if (n < 0.7) continue;
      const col = cols[(x + y) % 4];
      c.fillStyle = col; c.globalAlpha = 0.18 + (n - 0.7) * 0.3;
      const gx = (x * cell + t * 22 * dpr) % (W + cell) - cell;
      c.fillRect(gx, y * cell, cell - 3 * dpr, cell - 3 * dpr);
    }
    c.globalAlpha = 1;
    // scanline knockout
    c.save(); c.globalCompositeOperation = 'destination-out'; c.fillStyle = 'rgba(0,0,0,0.5)';
    for (let y = 0; y < H; y += 5 * dpr) c.fillRect(0, y, W, 1.6 * dpr);
    c.restore();
    if (!REDUCED) { t += 0.01; if (visible) raf = requestAnimationFrame(draw); else raf = null; }
  }
  whenVisible(canvas, v => { visible = v; if (v && !raf && !REDUCED) raf = requestAnimationFrame(draw); });
  draw();
}

/* ------------------------------------------------------- glossary tooltips */
function initTooltips() {
  const terms = [...document.querySelectorAll('.term[data-tip]')];
  if (!terms.length) return;
  const tip = document.createElement('div');
  tip.className = 'tip-bubble'; tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let current = null;
  function place(el) {
    current = el;
    const esc = s => s.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
    const label = el.textContent.trim().replace(/\s+/g, ' ');
    tip.innerHTML = '<span class="tt">' + esc(label) + '</span> — ' + esc(el.getAttribute('data-tip'));
    tip.classList.add('show');
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight, pad = 10;
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
      if (top < mark) links[i].classList.add('done'); else links[i].classList.remove('done');
    });
  }
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  window.addEventListener('resize', update);
  update();
}

/* ==========================================================================
   Wire-up
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  const heroCanvas = document.getElementById('hero-gfx');
  if (heroCanvas) heroAmbient(heroCanvas);

  const wire = (id, Ctor) => { const el = document.getElementById(id); if (el) Ctor(el); };
  wire('lab-pixel', PixelLab);
  wire('lab-tile', TileLab);
  wire('lab-palette', PaletteLab);
  wire('lab-nametable', NameLab);
  wire('lab-scroll', ScrollLab);
  wire('lab-sprite', SpriteLab);
  wire('lab-planes', PlanesLab);
  wire('lab-spriteengine', SpriteEngineLab);
  wire('lab-raster', RasterLab);
  wire('lab-shadow', ShadowLab);
  wire('lab-scanline', ScanlineLab);

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
