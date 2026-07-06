/* ============================================================================
   Genesis CPU — interactive layer
   Every lab on this page is a from-scratch teaching simulation: a toy CPU, a
   two's-complement bit board, a 68000 effective-address calculator, a tiny
   working 68000 assembler + stepper (with live CCR flags), a bus-arbitration
   timeline, a 24-bit address decoder, and an interpreter-vs-recompiler race.
   No game code runs here; the demos recreate the *behaviour* of the hardware
   and of Genesis Plus GX / BlastEm so you can watch the concepts, not games.
   ============================================================================ */
'use strict';

/* -------------------------------------------------------------- utilities */
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* Resize a canvas's bitmap to its CSS box × devicePixelRatio (capped at 2). */
function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  return { ctx: canvas.getContext('2d'), W: canvas.width, H: canvas.height, dpr };
}

/* Run onShow/onHide as an element enters/leaves the viewport. */
function whenVisible(el, onShow, onHide) {
  if (!('IntersectionObserver' in window)) { onShow(); return; }
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => { e.isIntersecting ? onShow() : onHide(); });
  }, { rootMargin: '80px 0px' });
  obs.observe(el);
}

const hex2 = v => '0x' + (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
const hexN = (v, n) => '$' + ((v >>> 0) % Math.pow(2, 4 * n)).toString(16).toUpperCase().padStart(n, '0');
/* 32-bit unsigned → $XXXXXXXX */
const hex8 = v => '$' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

/* ==========================================================================
   Module 01 — toy CPU  (a deliberately universal warm-up before the 68000)
   A 16-cell memory, registers PC/A/IR, and a 4-opcode ISA:
     1n LOAD A,[n] · 2n ADD A,[n] · 3n STORE A,[n] · 4n JUMP n
   Each Step runs ONE phase (fetch → decode → execute) with highlights and a
   plain-words narration, so the loop from the prose is literally watchable.
   ========================================================================== */
function ToyCpuLab(root) {
  const PROGRAM = [0x1e, 0x2d, 0x2c, 0x3e, 0x40];   // load,add,add,store,jump
  const memEl = root.querySelector('[data-tc-mem]');
  const regEl = root.querySelector('[data-tc-regs]');
  const narEl = root.querySelector('[data-tc-narrate]');
  const phases = [...root.querySelectorAll('[data-tc-phase] span')];
  const runBtn = root.querySelector('[data-tc-run]');

  let mem, pc, a, ir, phase, timer = null;

  const OPS = { 1: 'LOAD', 2: 'ADD', 3: 'STORE', 4: 'JUMP' };
  function disasm(b) {
    const op = OPS[b >> 4];
    if (!op) return '';
    const n = b & 15;
    return op === 'JUMP' ? 'JUMP ' + n : op + ' A,[' + n + ']';
  }

  const cells = [];
  for (let i = 0; i < 16; i++) {
    const c = document.createElement('div');
    c.className = 'tc-cell';
    c.innerHTML = '<span class="addr">cell ' + i + '</span><span class="val"></span><span class="dis"></span>';
    memEl.appendChild(c);
    cells.push(c);
  }
  const regs = {};
  [['pc', 'PC'], ['a', 'A'], ['ir', 'IR']].forEach(([k, label]) => {
    const r = document.createElement('div');
    r.className = 'tc-reg';
    r.innerHTML = '<div class="k">' + label + '</div><div class="v"></div>';
    regEl.appendChild(r);
    regs[k] = r;
  });

  function reset() {
    mem = new Array(16).fill(0);
    PROGRAM.forEach((b, i) => { mem[i] = b; });
    mem[12] = 1; mem[13] = 2; mem[14] = 0;
    pc = 0; a = 0; ir = 0; phase = 0;
    narrate('Press <b>Step</b> to run one phase of the loop, or <b>Run</b> to let it fly.');
    render();
  }
  function narrate(html) { narEl.innerHTML = html; }

  function render(marks = {}) {
    cells.forEach((c, i) => {
      c.querySelector('.val').textContent = hex2(mem[i]) + '  (' + mem[i] + ')';
      c.querySelector('.dis').textContent = i < PROGRAM.length ? disasm(mem[i]) : (i >= 12 ? 'data' : '');
      c.classList.toggle('is-data', i >= 12);
      c.classList.toggle('is-pc', i === pc);
      c.classList.toggle('is-read', marks.read === i);
      c.classList.toggle('is-write', marks.write === i);
    });
    regs.pc.querySelector('.v').textContent = pc;
    regs.a.querySelector('.v').textContent = a;
    regs.ir.querySelector('.v').textContent = hex2(ir);
    ['pc', 'a', 'ir'].forEach(k => regs[k].classList.toggle('hot', marks.reg === k));
    phases.forEach((p, i) => p.classList.toggle('on', i === marks.lit));
  }

  function step() {
    if (phase === 0) {
      ir = mem[pc];
      narrate('<b>Fetch.</b> The PC says <b>' + pc + '</b>, so read cell ' + pc +
        '. It holds <b>' + hex2(ir) + '</b> — into the instruction register it goes.');
      phase = 1;
      render({ read: pc, reg: 'ir', lit: 0 });
    } else if (phase === 1) {
      const op = ir >> 4, n = ir & 15;
      const words = {
        1: 'opcode 1 = <b>LOAD</b>: copy cell ' + n + ' into register A.',
        2: 'opcode 2 = <b>ADD</b>: add cell ' + n + ' to register A.',
        3: 'opcode 3 = <b>STORE</b>: write register A into cell ' + n + '.',
        4: 'opcode 4 = <b>JUMP</b>: set the PC to ' + n + '.',
      };
      narrate('<b>Decode.</b> ' + hex2(ir) + ' splits into opcode <b>' + op +
        '</b> and operand <b>' + n + '</b> — ' + (words[op] || 'not a known opcode; a real CPU would fault.'));
      phase = 2;
      render({ reg: 'ir', lit: 1 });
    } else {
      const op = ir >> 4, n = ir & 15;
      let marks = {};
      if (op === 1) {
        a = mem[n]; pc = (pc + 1) & 15;
        narrate('<b>Execute.</b> A ← cell ' + n + ' — so A is now <b>' + a + '</b>. PC steps to ' + pc + '.');
        marks = { read: n, reg: 'a' };
      } else if (op === 2) {
        a = (a + mem[n]) & 0xff; pc = (pc + 1) & 15;
        narrate('<b>Execute.</b> A + cell ' + n + ' → A is now <b>' + a + '</b>. PC steps to ' + pc + '.');
        marks = { read: n, reg: 'a' };
      } else if (op === 3) {
        mem[n] = a; pc = (pc + 1) & 15;
        narrate('<b>Execute.</b> Cell ' + n + ' ← A — memory now remembers <b>' + a + '</b>. PC steps to ' + pc + '.');
        marks = { write: n, reg: 'a' };
      } else if (op === 4) {
        pc = n & 15;
        narrate('<b>Execute.</b> A branch! The PC is overwritten with <b>' + n +
          '</b>, so the loop starts over. Cell 14 keeps counting up by 3 — watch it.');
        marks = { reg: 'pc' };
      } else {
        pc = (pc + 1) & 15;
        narrate('<b>Execute.</b> Unknown opcode — skipped. (Position and convention are everything.)');
      }
      phase = 0;
      marks.lit = 2;
      render(marks);
    }
  }

  function setRunning(on) {
    if (on && !timer) {
      timer = setInterval(step, REDUCED ? 1100 : 650);
      runBtn.textContent = 'Pause';
    } else if (!on && timer) {
      clearInterval(timer); timer = null;
      runBtn.textContent = 'Run';
    }
  }

  root.querySelector('[data-tc-step]').addEventListener('click', () => { setRunning(false); step(); });
  runBtn.addEventListener('click', () => setRunning(!timer));
  root.querySelector('[data-tc-reset]').addEventListener('click', () => { setRunning(false); reset(); });
  whenVisible(root, () => {}, () => setRunning(false));
  reset();
}

/* ==========================================================================
   Module 03 — two's-complement bit board
   8 or 16 toggle buttons. Read the same bits three ways: unsigned, two's-
   complement signed, and hex. A "negate" button performs invert-then-add-1 so
   the mechanism of two's complement is literally watchable; presets show the
   classic citizens (0, −1, +127, −128, the wrap point).
   ========================================================================== */
function BitLab(root) {
  const bitsEl = root.querySelector('[data-bits]');
  const outU = root.querySelector('[data-b-uns]');
  const outS = root.querySelector('[data-b-sig]');
  const outH = root.querySelector('[data-b-hex]');
  const outN = root.querySelector('[data-b-note]');

  let width = 8, value = 0;   // value stored as unsigned within width
  let note = null;
  const mask = () => (width === 8 ? 0xff : 0xffff);
  const signbit = () => (width === 8 ? 0x80 : 0x8000);

  let btns = [];
  function build() {
    bitsEl.innerHTML = '';
    btns = [];
    for (let i = width - 1; i >= 0; i--) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bit ' + (i === width - 1 ? 'sign' : 'man');
      b.setAttribute('aria-label', 'bit ' + i + ', weight ' + (i === width - 1 ? '-' : '') + Math.pow(2, i));
      b.innerHTML = '<span class="v">0</span>';
      b.addEventListener('click', () => { value ^= (1 << i); value &= mask(); note = null; render(); });
      bitsEl.appendChild(b);
      btns.push({ i, b });
      if (i % 4 === 0 && i !== 0) {
        const gap = document.createElement('span'); gap.className = 'bit-gap'; bitsEl.appendChild(gap);
      }
    }
  }

  function signed(v) { return (v & signbit()) ? v - (mask() + 1) : v; }

  function render() {
    btns.forEach(({ i, b }) => {
      const on = (value >> i) & 1;
      b.querySelector('.v').textContent = on;
      b.classList.toggle('on', !!on);
    });
    outU.textContent = value + '   (unsigned: every bit a plain power of two)';
    const sv = signed(value);
    outS.textContent = sv + '   (top bit worth ' + '−' + signbit() + ', the rest positive)';
    outH.textContent = hexN(value, width / 4) + '   ·   %' + value.toString(2).padStart(width, '0');
    let n;
    if (note) n = note;
    else if (value === 0) n = 'Zero — every bit clear. Its own negative: −0 and +0 are the same pattern in two’s complement (no wasted code).';
    else if (value === mask()) n = 'All ones = <em>−1</em>, not the biggest number. That is the whole trick: keep counting up past the top and the value wraps to the negatives.';
    else if (value === signbit()) n = 'The most negative value (' + sv + '). Notice it has no positive twin — one reason −(−128) overflows in a byte.';
    else if (sv < 0) n = 'A negative number. Flip every bit and add 1 and you get ' + (-sv) + ' — that round-trip <em>is</em> two’s-complement negation.';
    else n = 'A positive number. The same adder circuit will handle it and any negative correctly, never knowing the difference.';
    outN.innerHTML = n;
  }

  function negate() {
    value = ((~value) + 1) & mask();
    note = 'Negated: inverted every bit, then added 1. That two-step is exactly what a 68000 <code>NEG</code> does — and why subtraction is just “add the negative”.';
    render();
  }

  const PRESETS = {
    zero: 0, one: 1,
    max: () => (mask() >> 1),                 // +127 / +32767
    min: () => signbit(),                     // -128 / -32768
    neg1: () => mask(),                       // -1
    fortytwo: 42,
  };
  root.querySelectorAll('[data-b-preset]').forEach(b => b.addEventListener('click', () => {
    const p = PRESETS[b.dataset.bPreset];
    value = (typeof p === 'function' ? p() : p) & mask();
    note = null; render();
  }));
  root.querySelector('[data-b-negate]').addEventListener('click', negate);
  root.querySelectorAll('[data-b-width]').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('[data-b-width]').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    width = parseInt(b.dataset.bWidth, 10);
    value &= mask(); note = null; build(); render();
  }));

  build(); render();
}

/* ==========================================================================
   Module 07 — effective-address calculator
   The full D0–D7 / A0–A7 register file over a 64-byte memory window. Choose an
   addressing mode and an address register (and, where relevant, an index
   register and displacement); the lab computes the effective address exactly
   the way the 68000 does, shows the arithmetic, and lights the byte in memory.
   ========================================================================== */
function AddrLab(root) {
  const regEl = root.querySelector('[data-am-regs]');
  const memEl = root.querySelector('[data-am-mem]');
  const anSel = root.querySelector('[data-am-an]');
  const xnSel = root.querySelector('[data-am-xn]');
  const dispR = root.querySelector('[data-am-disp]');
  const dispV = root.querySelector('[data-am-disp-val]');
  const fFormula = root.querySelector('[data-am-formula]');
  const fEa = root.querySelector('[data-am-ea]');
  const fVal = root.querySelector('[data-am-val]');
  const fNote = root.querySelector('[data-am-note]');

  const A = [0x08, 0x18, 0x28, 0x38, 0x02, 0x14, 0x22, 0x3c];  // A0..A7 (A7=SP)
  const D = [0x02, 0x04, 0x06, 0x01, 0, 0, 0, 0];              // D0..D7
  const MEM = [];
  for (let i = 0; i < 64; i++) MEM[i] = (i * 7 + 3) & 0xff;    // arbitrary but stable data
  let mode = 'ind';

  // register file
  const regCells = {};
  function regRow(name, val, cls) {
    const d = document.createElement('div');
    d.className = 'am-reg ' + cls;
    d.innerHTML = '<span class="k">' + name + '</span><span class="v">' + hexN(val, 2) + '</span>';
    regEl.appendChild(d);
    regCells[name] = d;
    return d;
  }
  for (let i = 0; i < 8; i++) regRow('D' + i, D[i], 'dn');
  for (let i = 0; i < 8; i++) regRow('A' + i, A[i], 'an');

  // memory window
  const byteCells = [];
  for (let i = 0; i < 64; i++) {
    const c = document.createElement('div');
    c.className = 'am-byte';
    c.title = hexN(i, 2);
    c.textContent = MEM[i].toString(16).toUpperCase().padStart(2, '0');
    memEl.appendChild(c);
    byteCells.push(c);
  }

  const SIZE = 2; // we compute in words for post/pre-increment demonstrations

  function compute() {
    const an = parseInt(anSel.value, 10);
    const xn = parseInt(xnSel.value, 10);   // 0..7 = D0..D7
    const disp = parseInt(dispR.value, 10);
    dispV.textContent = (disp >= 0 ? '+' : '') + disp;

    let ea = null, formula, note, hotAn = false, hotIdx = false, regRead = null;
    switch (mode) {
      case 'dn':
        formula = 'operand = D' + an + ' itself';
        note = 'Data-register direct. No memory is touched at all — the value <em>is</em> the register. The fastest possible operand.';
        regRead = 'D' + an;
        break;
      case 'an':
        formula = 'operand = A' + an + ' itself';
        note = 'Address-register direct. Again no memory access; the address register is used as a plain 32-bit value.';
        hotAn = true;
        break;
      case 'ind':
        ea = A[an]; formula = 'EA = (A' + an + ') = ' + hexN(A[an], 2);
        note = 'Address-register indirect: the register holds a <em>pointer</em>; the effective address is simply its contents.';
        hotAn = true;
        break;
      case 'post':
        ea = A[an];
        formula = 'EA = (A' + an + ') = ' + hexN(A[an], 2) + ',  then A' + an + ' += ' + SIZE;
        note = 'Post-increment (A' + an + ')+: use the pointer, <em>then</em> bump it by the operand size (' + SIZE + ' for a word). This is how you walk forward through an array — the C idiom <code>*p++</code> in one instruction.';
        hotAn = true;
        break;
      case 'pre':
        ea = (A[an] - SIZE) & 0xffff;
        formula = 'A' + an + ' -= ' + SIZE + ' → ' + hexN(ea, 2) + ',  then EA = (A' + an + ')';
        note = 'Pre-decrement -(A' + an + '): drop the pointer <em>first</em>, then use it. Pair it with post-increment on another register and you have a stack — which is exactly how A7 (SP) works.';
        hotAn = true;
        break;
      case 'disp':
        ea = (A[an] + disp) & 0xffff;
        formula = 'EA = ' + disp + '(A' + an + ') = ' + hexN(A[an], 2) + ' + (' + disp + ') = ' + hexN(ea, 2);
        note = 'Displacement d(A' + an + '): a fixed signed offset baked into the instruction, added to the register. Perfect for reaching a field at a known offset inside a struct.';
        hotAn = true;
        break;
      case 'idx':
        ea = (A[an] + D[xn] + disp) & 0xffff;
        formula = 'EA = ' + disp + '(A' + an + ',D' + xn + ') = ' + hexN(A[an], 2) + ' + ' + hexN(D[xn], 2) + ' + (' + disp + ') = ' + hexN(ea, 2);
        note = 'Indexed d(A' + an + ',D' + xn + '): base + a <em>variable</em> index register + a constant. Base = array start, index = element number × size, displacement = field offset — one instruction addresses <code>arr[i].field</code>.';
        hotAn = true; hotIdx = true; regRead = 'D' + xn;
        break;
      case 'absw':
        ea = ((disp + 16) * 3) & 0x3f;   // map the slider onto an in-range absolute address
        formula = 'EA = ' + hexN(ea, 2) + '.W  (an absolute address, no register)';
        note = 'Absolute short: the address is a constant encoded in the instruction. No pointer register involved — you named the location outright.';
        break;
    }

    fFormula.textContent = formula;
    if (ea === null) {
      fEa.textContent = '— (no memory access)';
      fVal.textContent = regRead ? regRead + ' = ' + hexN(mode === 'an' ? A[an] : D[an], 2) : (mode === 'an' ? 'A' + an + ' = ' + hexN(A[an], 2) : '—');
    } else {
      fEa.textContent = hexN(ea, 2);
      const wv = ((MEM[ea] << 8) | MEM[(ea + 1) & 0x3f]);
      fVal.textContent = 'byte ' + hexN(MEM[ea], 2) + '  ·  word ' + hexN(wv, 4);
    }
    fNote.innerHTML = note;

    // paint
    byteCells.forEach((c, i) => {
      c.classList.toggle('ea', ea !== null && i === ea);
      c.classList.toggle('ea2', ea !== null && mode !== 'absw' && i === ((ea + 1) & 0x3f));
    });
    Object.entries(regCells).forEach(([name, el]) => {
      el.classList.toggle('hot', hotAn && name === 'A' + an);
      el.classList.toggle('idx', (hotIdx && name === 'D' + xn) || (regRead && name === regRead && !hotIdx));
    });
  }

  root.querySelectorAll('[data-am-mode]').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('[data-am-mode]').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    mode = b.dataset.amMode;
    compute();
  }));
  anSel.addEventListener('change', compute);
  xnSel.addEventListener('change', compute);
  dispR.addEventListener('input', compute);
  compute();
}

/* ==========================================================================
   Module 08 — a tiny working 68000 assembler + stepper
   Assembles a real subset — MOVE/MOVEQ/ADD/ADDQ/ADDI/SUB/SUBQ/CMP/TST/CLR/
   AND/OR/EOR/NOT/NEG, Bcc/BRA, DBRA, NOP — over D0–D7, A0–A7 (A7 = SP), a
   32-byte memory, and the CCR flags X N Z V C, computed size-correctly.
   ========================================================================== */
function Asm68kLab(root) {
  const srcEl = root.querySelector('[data-asm-src]');
  const listEl = root.querySelector('[data-asm-listing]');
  const regEl = root.querySelector('[data-asm-regs]');
  const flagEl = root.querySelector('[data-asm-ccr]');
  const memEl = root.querySelector('[data-asm-mem]');
  const narEl = root.querySelector('[data-asm-narrate]');
  const runBtn = root.querySelector('[data-asm-run]');

  const D = new Array(8), A = new Array(8);
  let flags, PC, prog, srcLines, timer = null, steps = 0, halted = true, lastWrite = -1;

  const SZBITS = { b: 8, w: 16, l: 32 };
  const szMask = s => s === 'l' ? 0xffffffff : s === 'w' ? 0xffff : 0xff;
  const szSign = s => s === 'l' ? 0x80000000 : s === 'w' ? 0x8000 : 0x80;
  const u32 = v => v >>> 0;

  /* ---- register file + flag chips + memory UI ---- */
  const regCells = {};
  ['D0','D1','D2','D3','D4','D5','D6','D7','A0','A1','A2','A3','A4','A5','A6','A7','PC'].forEach(name => {
    const d = document.createElement('div');
    d.className = 'asm-reg';
    d.innerHTML = '<div class="k">' + (name === 'A7' ? 'A7/SP' : name) + '</div><div class="v">—</div>';
    regEl.appendChild(d);
    regCells[name] = d;
  });
  const flagCells = {};
  ['X','N','Z','V','C'].forEach(f => {
    const d = document.createElement('div');
    d.className = 'flag';
    d.innerHTML = '<span class="b">0</span><span class="fl">' + f + '</span>';
    flagEl.appendChild(d);
    flagCells[f] = d;
  });
  const MEMBYTES = 32;
  const memCells = [];
  for (let i = 0; i < MEMBYTES; i++) {
    const c = document.createElement('div');
    c.className = 'am-byte';
    c.title = hexN(i, 2);
    memEl.appendChild(c);
    memCells.push(c);
  }
  let MEM = new Uint8Array(MEMBYTES);

  /* ---- number + operand parsing ---- */
  function parseNum(t) {
    t = t.trim();
    let neg = false;
    if (t[0] === '-') { neg = true; t = t.slice(1); }
    else if (t[0] === '+') t = t.slice(1);
    let v;
    if (t[0] === '$') v = parseInt(t.slice(1), 16);
    else if (t[0] === '%') v = parseInt(t.slice(1), 2);
    else v = parseInt(t, 10);
    if (Number.isNaN(v)) throw 'bad number "' + t + '"';
    return neg ? -v : v;
  }

  function parseOperand(s) {
    s = s.trim();
    let m;
    if ((m = /^d([0-7])$/i.exec(s))) return { t: 'd', n: +m[1] };
    if (/^sp$/i.test(s)) return { t: 'a', n: 7 };
    if ((m = /^a([0-7])$/i.exec(s))) return { t: 'a', n: +m[1] };
    if (s[0] === '#') return { t: 'imm', v: parseNum(s.slice(1)) };
    if ((m = /^-\(a([0-7])\)$/i.exec(s))) return { t: 'pre', n: +m[1] };
    if ((m = /^\(a([0-7])\)\+$/i.exec(s))) return { t: 'post', n: +m[1] };
    if ((m = /^\(a([0-7])\)$/i.exec(s))) return { t: 'ind', n: +m[1] };
    if (/^\$[0-9a-f]+$/i.test(s)) return { t: 'abs', addr: parseNum(s) };
    if (/^[a-z_]\w*$/i.test(s)) return { t: 'label', name: s };
    throw 'unrecognised operand "' + s + '"';
  }

  function assemble() {
    const text = srcEl.value;
    srcLines = text.split('\n');
    const instrs = [], labels = {}, errors = {};
    srcLines.forEach((raw, li) => {
      let line = raw.replace(/;.*$/, '');            // strip ; comments
      if (/^\s*\*/.test(raw)) line = '';             // * whole-line comment
      let t = line.trim();
      if (!t) return;
      // leading label(s):  name:
      let m;
      while ((m = /^([a-z_]\w*)\s*:\s*/i.exec(t))) {
        labels[m[1].toLowerCase()] = instrs.length;
        t = t.slice(m[0].length);
      }
      if (!t) return;
      // mnemonic[.size]  operands
      const firstTok = t.split(/\s+/)[0];
      let mn = firstTok;
      let size = 'w';
      const dot = mn.indexOf('.');
      if (dot >= 0) { size = mn.slice(dot + 1).toLowerCase(); mn = mn.slice(0, dot); }
      mn = mn.toUpperCase();
      const opsStr = t.slice(firstTok.length).trim();
      let ops = [];
      try {
        if (opsStr.trim()) ops = splitOps(opsStr).map(parseOperand);
      } catch (e) { errors[li] = String(e); }
      instrs.push({ mn, size, ops, srcLine: li });
    });
    return { instrs, labels, errors };
  }

  // split "a, b" respecting the (...) parens
  function splitOps(s) {
    const out = []; let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  /* ---- memory access (big-endian) ---- */
  function memRead(addr, s) {
    addr &= (MEMBYTES - 1);
    if (s === 'b') return MEM[addr];
    if (s === 'w') return (MEM[addr] << 8) | MEM[(addr + 1) & (MEMBYTES - 1)];
    return u32((MEM[addr] << 24) | (MEM[(addr + 1) & 31] << 16) | (MEM[(addr + 2) & 31] << 8) | MEM[(addr + 3) & 31]);
  }
  function memWrite(addr, s, v) {
    addr &= (MEMBYTES - 1);
    lastWrite = addr;
    if (s === 'b') { MEM[addr] = v & 0xff; return; }
    if (s === 'w') { MEM[addr] = (v >> 8) & 0xff; MEM[(addr + 1) & 31] = v & 0xff; return; }
    MEM[addr] = (v >>> 24) & 0xff; MEM[(addr + 1) & 31] = (v >>> 16) & 0xff;
    MEM[(addr + 2) & 31] = (v >>> 8) & 0xff; MEM[(addr + 3) & 31] = v & 0xff;
  }

  const eaAddr = (op, s) => {
    const sz = s === 'b' ? 1 : s === 'w' ? 2 : 4;
    if (op.t === 'ind') return A[op.n];
    if (op.t === 'post') { const a = A[op.n]; A[op.n] = u32(a + sz); return a; }
    if (op.t === 'pre') { A[op.n] = u32(A[op.n] - sz); return A[op.n]; }
    if (op.t === 'abs') return op.addr;
    throw 'not a memory operand';
  };

  function readOp(op, s) {
    if (op.t === 'd') return D[op.n] & szMask(s);
    if (op.t === 'a') return A[op.n] & szMask(s);
    if (op.t === 'imm') return u32(op.v) & szMask(s);
    return memRead(eaAddr(op, s), s);
  }
  function writeOp(op, s, v) {
    v = v & szMask(s);
    if (op.t === 'd') { D[op.n] = u32((D[op.n] & ~szMask(s)) | v); return; }
    if (op.t === 'a') { A[op.n] = u32(s === 'w' ? ((v & 0x8000) ? 0xffff0000 | v : v) : v); return; }
    memWrite(eaAddr(op, s), s, v);
  }

  /* ---- flag helpers ---- */
  function setNZ(r, s) {
    flags.N = (r & szSign(s)) !== 0;
    flags.Z = (r & szMask(s)) === 0;
  }
  function addFlags(a, b, r, s) {
    const m = szMask(s), sb = szSign(s);
    setNZ(r, s);
    flags.C = ((a & m) + (b & m)) > m;
    flags.V = (((~(a ^ b)) & (a ^ r)) & sb) !== 0;
    flags.X = flags.C;
  }
  function subFlags(a, b, r, s, setX) {
    const m = szMask(s), sb = szSign(s);
    setNZ(r, s);
    flags.C = (a & m) < (b & m);
    flags.V = (((a ^ b) & (a ^ r)) & sb) !== 0;
    if (setX) flags.X = flags.C;
  }

  const CC = {
    RA: () => true, T: () => true, F: () => false,
    EQ: () => flags.Z, NE: () => !flags.Z,
    MI: () => flags.N, PL: () => !flags.N,
    CS: () => flags.C, LO: () => flags.C, CC: () => !flags.C, HS: () => !flags.C,
    VS: () => flags.V, VC: () => !flags.V,
    GE: () => flags.N === flags.V, LT: () => flags.N !== flags.V,
    GT: () => !flags.Z && (flags.N === flags.V), LE: () => flags.Z || (flags.N !== flags.V),
    HI: () => !flags.C && !flags.Z, LS: () => flags.C || flags.Z,
  };

  function reset() {
    for (let i = 0; i < 8; i++) { D[i] = 0; A[i] = 0; }
    A[0] = 0x10;            // a handy pointer into memory
    A[7] = 0x20;            // stack pointer parked at top
    flags = { X: false, N: false, Z: false, V: false, C: false };
    MEM = new Uint8Array(MEMBYTES);
    lastWrite = -1;
    prog = assemble();
    PC = 0; steps = 0; halted = false;
    if (Object.keys(prog.errors).length) {
      narrate('<b style="color:var(--bad)">Assembly errors.</b> ' +
        Object.entries(prog.errors).map(([l, e]) => 'line ' + (+l + 1) + ': ' + e).join(' · '));
      halted = true;
    } else {
      narrate('Assembled <b>' + prog.instrs.length + '</b> instructions. Press <b>Step</b> to execute one at a time and watch the CCR flags <b>X N Z V C</b> react.');
    }
    renderListing(); render();
  }

  function narrate(h) { narEl.innerHTML = h; }

  function step() {
    if (halted) return;
    if (PC < 0 || PC >= prog.instrs.length) { halted = true; narrate('<b>Halted.</b> Ran off the end of the program.'); render(); return; }
    if (++steps > 4000) { halted = true; narrate('<b>Stopped.</b> 4000-instruction safety limit hit — an infinite loop?'); render(); return; }
    const ins = prog.instrs[PC];
    lastWrite = -1;
    let msg = '', jumped = false;
    try {
      msg = exec(ins);
    } catch (e) {
      halted = true; narrate('<b style="color:var(--bad)">Runtime error</b> on line ' + (ins.srcLine + 1) + ': ' + e); render(); return;
    }
    if (!ins._jumped) PC++;
    ins._jumped = false;
    narrate(msg || ('Executed <code>' + ins.mn + '</code>.'));
    render();
  }

  function branchTo(name, ins) {
    const t = prog.labels[name.toLowerCase()];
    if (t === undefined) throw 'unknown label "' + name + '"';
    PC = t; ins._jumped = true;
  }

  function exec(ins) {
    const s = ins.size, o = ins.ops, mn = ins.mn;
    switch (mn) {
      case 'NOP': return 'NOP — one quiet cycle, nothing changed.';
      case 'MOVE': case 'MOVEA': {
        const v = readOp(o[0], s);
        if (o[1].t === 'a') { writeOp(o[1], 'l', s === 'w' ? ((v & 0x8000) ? 0xffff0000 | v : v) : v); return 'MOVEA — A' + o[1].n + ' ← ' + hex8(A[o[1].n]) + ' (address moves set no flags).'; }
        writeOp(o[1], s, v); setNZ(v, s); flags.V = false; flags.C = false;
        return 'MOVE.' + s + ' — copied ' + hexN(v, s === 'b' ? 2 : s === 'w' ? 4 : 8) + '; N/Z updated, V=C=0, X untouched.';
      }
      case 'MOVEQ': {
        const v = u32((o[0].v << 24) >> 24);   // sign-extend 8-bit to long
        D[o[1].n] = v; setNZ(v, 'l'); flags.V = false; flags.C = false;
        return 'MOVEQ — sign-extended #' + o[0].v + ' into D' + o[1].n + ' as a long (' + hex8(v) + ').';
      }
      case 'ADD': case 'ADDI': case 'ADDQ': {
        const a = readOp(o[1], s), b = readOp(o[0], s), r = u32(a + b);
        writeOp(o[1], s, r); addFlags(a, b, r, s);
        return mn + '.' + s + ' — ' + (a & szMask(s)) + ' + ' + (b & szMask(s)) + ' = ' + (r & szMask(s)) + '. ' + flagLine();
      }
      case 'SUB': case 'SUBI': case 'SUBQ': {
        const a = readOp(o[1], s), b = readOp(o[0], s), r = u32(a - b);
        writeOp(o[1], s, r); subFlags(a, b, r, s, true);
        return mn + '.' + s + ' — ' + (a & szMask(s)) + ' − ' + (b & szMask(s)) + ' = ' + (r & szMask(s)) + '. ' + flagLine();
      }
      case 'CMP': case 'CMPI': {
        const a = readOp(o[1], s), b = readOp(o[0], s), r = u32(a - b);
        subFlags(a, b, r, s, false);   // CMP does not affect X
        return 'CMP.' + s + ' — compared ' + (a & szMask(s)) + ' with ' + (b & szMask(s)) + ' (result discarded). ' + flagLine();
      }
      case 'TST': {
        const v = readOp(o[0], s); setNZ(v, s); flags.V = false; flags.C = false;
        return 'TST.' + s + ' — tested ' + (v & szMask(s)) + ' against zero. Z=' + (flags.Z ? 1 : 0) + ', N=' + (flags.N ? 1 : 0) + '.';
      }
      case 'CLR': { writeOp(o[0], s, 0); flags.N = false; flags.Z = true; flags.V = false; flags.C = false; return 'CLR.' + s + ' — wrote zero; Z=1.'; }
      case 'AND': case 'OR': case 'EOR': {
        const a = readOp(o[1], s), b = readOp(o[0], s);
        const r = mn === 'AND' ? (a & b) : mn === 'OR' ? (a | b) : (a ^ b);
        writeOp(o[1], s, r); setNZ(r, s); flags.V = false; flags.C = false;
        return mn + '.' + s + ' — bitwise result ' + hexN(r & szMask(s), s === 'b' ? 2 : s === 'w' ? 4 : 8) + '. ' + flagLine();
      }
      case 'NOT': { const v = readOp(o[0], s) ^ szMask(s); writeOp(o[0], s, v); setNZ(v, s); flags.V = false; flags.C = false; return 'NOT.' + s + ' — inverted every bit.'; }
      case 'NEG': { const a = readOp(o[0], s), r = u32(0 - a); writeOp(o[0], s, r); subFlags(0, a, r, s, true); return 'NEG.' + s + ' — 0 − ' + (a & szMask(s)) + ' = ' + (r & szMask(s)) + '. ' + flagLine(); }
      case 'BRA': branchTo(o[0].name, ins); return 'BRA — unconditional jump to ' + o[0].name + '.';
      case 'BSR': branchTo(o[0].name, ins); return 'BSR — jump to ' + o[0].name + ' (return address not modelled here).';
      case 'DBRA': case 'DBF': {
        const dn = o[0].n, lo = (D[dn] - 1) & 0xffff;
        D[dn] = u32((D[dn] & 0xffff0000) | lo);
        if (lo !== 0xffff) { branchTo(o[1].name, ins); return 'DBRA — D' + dn + '.w decremented to ' + lo + ' (≠ −1), so loop back to ' + o[1].name + '.'; }
        return 'DBRA — D' + dn + '.w reached −1, loop finished; fall through.';
      }
      default: {
        // Bcc family
        if (mn[0] === 'B' && CC[mn.slice(1)]) {
          const cc = mn.slice(1);
          if (CC[cc]()) { branchTo(o[0].name, ins); return 'B' + cc + ' — condition true, branch to ' + o[0].name + '.'; }
          return 'B' + cc + ' — condition false, fall through.';
        }
        throw 'unsupported mnemonic "' + mn + '"';
      }
    }
  }

  function flagLine() {
    return 'X' + (flags.X ? 1 : 0) + ' N' + (flags.N ? 1 : 0) + ' Z' + (flags.Z ? 1 : 0) + ' V' + (flags.V ? 1 : 0) + ' C' + (flags.C ? 1 : 0);
  }

  function renderListing() {
    listEl.innerHTML = '';
    srcLines.forEach((raw, li) => {
      const ln = document.createElement('div');
      ln.className = 'ln';
      if (prog.errors[li]) ln.classList.add('err');
      ln.dataset.li = li;
      ln.innerHTML = '<span class="adr">' + String(li + 1).padStart(2, ' ') + '</span>  ' +
        (raw.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) || ' ');
      listEl.appendChild(ln);
    });
  }

  function render() {
    for (let i = 0; i < 8; i++) regCells['D' + i].querySelector('.v').textContent = hex8(D[i]);
    for (let i = 0; i < 8; i++) regCells['A' + i].querySelector('.v').textContent = hex8(A[i]);
    const cur = (!halted && prog.instrs[PC]) ? prog.instrs[PC] : null;
    regCells.PC.querySelector('.v').textContent = cur ? 'L' + (cur.srcLine + 1) : '—';
    // highlight touched registers
    Object.values(regCells).forEach(el => el.classList.remove('hot'));
    if (cur) {
      cur.ops.forEach(op => {
        if (op.t === 'd') regCells['D' + op.n].classList.add('hot');
        if (op.t === 'a' || op.t === 'ind' || op.t === 'post' || op.t === 'pre') regCells['A' + op.n].classList.add('hot');
      });
    }
    ['X', 'N', 'Z', 'V', 'C'].forEach(f => {
      flagCells[f].querySelector('.b').textContent = flags[f] ? 1 : 0;
      flagCells[f].classList.toggle('on', !!flags[f]);
    });
    memCells.forEach((c, i) => {
      c.textContent = MEM[i].toString(16).toUpperCase().padStart(2, '0');
      c.classList.toggle('ea2', i === lastWrite);
    });
    // listing highlight
    listEl.querySelectorAll('.ln').forEach(ln => ln.classList.remove('cur'));
    if (cur) {
      const el = listEl.querySelector('.ln[data-li="' + cur.srcLine + '"]');
      if (el) { el.classList.add('cur'); }
    }
  }

  function setRunning(on) {
    if (on && !timer && !halted) { timer = setInterval(() => { step(); if (halted) setRunning(false); }, REDUCED ? 700 : 380); runBtn.textContent = 'Pause'; }
    else if (!on && timer) { clearInterval(timer); timer = null; runBtn.textContent = 'Run'; }
  }

  root.querySelector('[data-asm-assemble]').addEventListener('click', () => { setRunning(false); reset(); });
  root.querySelector('[data-asm-step]').addEventListener('click', () => { setRunning(false); if (halted && PC >= (prog ? prog.instrs.length : 0)) return; step(); });
  runBtn.addEventListener('click', () => setRunning(!timer));
  whenVisible(root, () => {}, () => setRunning(false));
  reset();
}

/* ==========================================================================
   Module 10 — bus-arbitration timeline
   One video frame's worth of 68000 execution. The VDP steals bus cycles when
   it runs a DMA (a big vblank fill plus scattered active-display transfers);
   the 68000 freezes for the duration. Optionally the 68000 asserts BUSREQ to
   reach the Z80's space, halting the Z80. A playhead sweeps; red = 68000 stall.
   ========================================================================== */
function BusLab(root) {
  const canvas = root.querySelector('.bus-canvas');
  const outWork = root.querySelector('[data-bus-work]');
  const outStall = root.querySelector('[data-bus-stall]');
  const outTotal = root.querySelector('[data-bus-total]');
  const dmaR = root.querySelector('[data-bus-dma]');
  const dmaV = root.querySelector('[data-bus-dma-val]');
  const z80Btns = root.querySelectorAll('[data-bus-z80]');

  let m68k, vdp, z80, totalWork, totalStall, total, raf = null, play = 0, visible = false, ran = false, z80req = false;

  function build() {
    const dmaLen = parseInt(dmaR.value, 10);      // cycles per DMA burst
    const WORK_UNITS = 26, WPER = 6;              // 26 work chunks of 6 cycles
    m68k = []; vdp = []; totalStall = 0; totalWork = 0;
    // scatter a few active-display DMA bursts, then one big vblank burst
    const dmaAt = new Set([4, 9, 14, 19]);        // small bursts mid-frame
    for (let i = 0; i < WORK_UNITS; i++) {
      m68k.push({ t: 'work', len: WPER }); totalWork += WPER;
      if (dmaAt.has(i)) {
        const l = Math.round(dmaLen * 0.45);
        m68k.push({ t: 'stall', len: l }); totalStall += l;
        vdp.push({ at: cursum(m68k) - l, len: l, kind: 'active' });
      }
    }
    // big vblank DMA at the end
    m68k.push({ t: 'stall', len: dmaLen }); totalStall += dmaLen;
    vdp.push({ at: cursum(m68k) - dmaLen, len: dmaLen, kind: 'vblank' });
    total = totalWork + totalStall;

    // Z80 lane: runs the whole frame; if the 68000 requests its bus, a grant gap
    z80 = [{ t: 'work', len: total }];
    if (z80req) {
      const gapAt = Math.round(total * 0.30), gapLen = Math.round(total * 0.12);
      z80 = [{ t: 'work', len: gapAt }, { t: 'grant', len: gapLen }, { t: 'work', len: total - gapAt - gapLen }];
    }

    outWork.textContent = totalWork + ' cycles';
    outStall.textContent = totalStall + ' cycles (' + Math.round(100 * totalStall / total) + '% of the frame)';
    outTotal.textContent = total + ' cycles';
  }
  function cursum(arr) { return arr.reduce((s, x) => s + x.len, 0); }

  function draw(prog) {
    const { ctx, W, H, dpr } = fitCanvas(canvas);
    ctx.clearRect(0, 0, W, H);
    const padL = 10 * dpr, padR = 10 * dpr;
    const xOf = t => padL + (W - padL - padR) * (t / total);
    const font = px => { ctx.font = '600 ' + (px * dpr) + 'px ui-monospace, monospace'; };

    function lane(segs, y, h, colWork, colOther) {
      let t = 0;
      segs.forEach(seg => {
        const x0 = xOf(t), x1 = xOf(Math.min(t + seg.len, prog));
        if (t < prog) {
          ctx.fillStyle = seg.t === 'work' ? colWork : (colOther || 'rgba(255,95,95,0.85)');
          ctx.fillRect(x0, y, Math.max(1, x1 - x0), h);
        }
        t += seg.len;
      });
    }

    font(11); ctx.fillStyle = '#7e8599';
    ctx.fillText('68000 · executes — but freezes whenever the VDP holds the bus', padL, 20 * dpr);
    lane(m68k, 28 * dpr, 34 * dpr, 'rgba(255,83,71,0.85)');

    ctx.fillText('VDP DMA · steals bus cycles (small active-display bursts + one big vblank fill)', padL, 96 * dpr);
    vdp.forEach(d => {
      const x0 = xOf(d.at), x1 = xOf(Math.min(d.at + d.len, prog));
      if (d.at < prog) {
        ctx.fillStyle = d.kind === 'vblank' ? 'rgba(255,196,77,0.9)' : 'rgba(255,157,60,0.85)';
        ctx.fillRect(x0, 104 * dpr, Math.max(1, x1 - x0), 34 * dpr);
      }
    });

    ctx.fillText('Z80 · own clock — halts only while the 68000 requests its bus (BUSREQ)', padL, 168 * dpr);
    lane(z80, 176 * dpr, 34 * dpr, 'rgba(63,181,255,0.85)', 'rgba(126,133,153,0.7)');

    // playhead
    if (prog < total) {
      ctx.strokeStyle = 'rgba(238,241,248,0.6)'; ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.moveTo(xOf(prog), 24 * dpr); ctx.lineTo(xOf(prog), 214 * dpr); ctx.stroke();
    }
    font(10.5);
    ctx.fillStyle = '#ff5347'; ctx.fillText('■ 68000 run', padL, H - 8 * dpr);
    ctx.fillStyle = '#ffc44d'; ctx.fillText('■ VDP DMA', padL + 92 * dpr, H - 8 * dpr);
    ctx.fillStyle = '#3fb5ff'; ctx.fillText('■ Z80 run', padL + 184 * dpr, H - 8 * dpr);
    ctx.fillStyle = '#7e8599'; ctx.fillText('■ bus granted', padL + 268 * dpr, H - 8 * dpr);
  }

  function replay() {
    build();
    if (raf) cancelAnimationFrame(raf);
    if (REDUCED) { draw(total); return; }
    play = 0;
    const tick = () => {
      play += total / 200;
      draw(play);
      if (play < total && visible) raf = requestAnimationFrame(tick);
      else draw(total);
    };
    raf = requestAnimationFrame(tick);
  }

  dmaR.addEventListener('input', () => { dmaV.textContent = dmaR.value + ' cyc'; });
  z80Btns.forEach(b => b.addEventListener('click', () => {
    z80Btns.forEach(x => x.classList.remove('on')); b.classList.add('on');
    z80req = b.dataset.busZ80 === 'on';
  }));
  root.querySelector('[data-bus-run]').addEventListener('click', replay);
  window.addEventListener('resize', () => { if (total) draw(total); });
  whenVisible(root,
    () => { visible = true; if (!ran) { ran = true; replay(); } },
    () => { visible = false; if (raf) cancelAnimationFrame(raf); });
}

/* ==========================================================================
   Module 11 — 24-bit address decoder
   Type or slide a 24-bit address, or click a landmark. The lab finds which
   device the top address lines select, lights the region on the 16 MB bar,
   and shows the address in hex and binary with the decode explained.
   ========================================================================== */
function MemMapLab(root) {
  const barEl = root.querySelector('[data-mm-bar]');
  const input = root.querySelector('[data-mm-input]');
  const slider = root.querySelector('[data-mm-slider]');
  const fHex = root.querySelector('[data-mm-hex]');
  const fBin = root.querySelector('[data-mm-bin]');
  const fRegion = root.querySelector('[data-mm-region]');
  const fDevice = root.querySelector('[data-mm-device]');
  const fNote = root.querySelector('[data-mm-note]');

  // regions: [lo, hi, name, device, note, colorVar, weight]
  const R = [
    [0x000000, 0x3FFFFF, 'Cartridge ROM', 'Mask ROM on the cartridge', 'The program itself. The 68000 boots here: after reset it reads its initial stack pointer from $000000 and its first PC from $000004. Up to 4 MB flat; bigger carts add bank-switching mappers.', 'var(--red)', 4],
    [0x400000, 0x7FFFFF, 'Reserved / expansion', 'Sega CD & 32X window', 'Unused by a bare Genesis. The Sega CD and 32X add-ons map their extra ROM and RAM into this hole on the expansion connector.', 'var(--line-2)', 4],
    [0x800000, 0x9FFFFF, 'Reserved', 'Unmapped', 'Empty on a stock console — reads here are open-bus.', 'var(--line-2)', 2],
    [0xA00000, 0xA0FFFF, 'Z80 space', 'Z80 sound CPU: RAM + sound chips', 'A window onto the Z80’s own address space: its 8 KB RAM, the YM2612 FM chip and the SN76489 PSG. The 68000 may only touch this while it holds the Z80 bus (BUSREQ).', 'var(--gold)', 1],
    [0xA10000, 0xA10FFF, 'I/O ports', 'Controllers & version register', 'The joypad data/control ports and the console version/region register live here — one of the first things a boot ROM reads.', 'var(--blue)', 1],
    [0xA11000, 0xA11FFF, 'Z80 bus control', 'BUSREQ / RESET registers', '$A11100 requests (and releases) the Z80 bus; $A11200 asserts the Z80 reset line. This is the handshake behind the arbitration in Module 10.', 'var(--blue)', 1],
    [0xA12000, 0xBFFFFF, 'System / expansion', 'TMSS, CD/32X control', 'Later models’ TMSS trademark register sits near here; add-ons use the rest.', 'var(--line-2)', 2],
    [0xC00000, 0xDFFFFF, 'VDP ports', 'Video Display Processor', 'The VDP data port ($C00000), control port ($C00004) and HV counter. Everything drawn on screen is programmed by writing here. Heavily mirrored across the range.', 'var(--amber)', 3],
    [0xE00000, 0xFFFFFF, '68000 work RAM', '64 KB main RAM (mirrored)', 'The 68000’s own 64 KB of scratch RAM. It answers across this whole 2 MB block as a mirror; the canonical address is $FF0000–$FFFFFF.', 'var(--good)', 3],
  ];

  const segEls = [];
  R.forEach((r, i) => {
    const s = document.createElement('div');
    s.className = 'mm-seg';
    s.style.flex = r[6];
    s.style.background = r[5];
    s.innerHTML = '<span>' + r[2] + '</span>';
    s.addEventListener('click', () => setAddr(r[0]));
    barEl.appendChild(s);
    segEls.push(s);
  });

  function findRegion(a) { return R.findIndex(r => a >= r[0] && a <= r[1]); }

  function setAddr(a) {
    a = clamp(a >>> 0, 0, 0xFFFFFF);
    input.value = a.toString(16).toUpperCase().padStart(6, '0');
    slider.value = a;
    render(a);
  }

  function render(a) {
    const idx = findRegion(a);
    fHex.textContent = '$' + a.toString(16).toUpperCase().padStart(6, '0');
    const bin = a.toString(2).padStart(24, '0').replace(/(.{4})(?=.)/g, '$1 ');
    fBin.textContent = '%' + bin;
    if (idx < 0) { fRegion.textContent = 'unmapped'; fDevice.textContent = '—'; fNote.textContent = 'No device answers here.'; }
    else {
      const r = R[idx];
      fRegion.innerHTML = r[2] + '  <span style="color:var(--muted)">(' + hexN(r[0], 6) + '–' + hexN(r[1], 6) + ')</span>';
      fDevice.textContent = r[3];
      fNote.textContent = r[4];
    }
    segEls.forEach((s, i) => s.classList.toggle('active', i === idx));
  }

  input.addEventListener('change', () => {
    const v = parseInt(input.value.replace(/^[$]/, ''), 16);
    if (!Number.isNaN(v)) setAddr(v);
  });
  slider.addEventListener('input', () => setAddr(parseInt(slider.value, 10)));
  root.querySelectorAll('[data-mm-preset]').forEach(b => b.addEventListener('click', () => setAddr(parseInt(b.dataset.mmPreset, 16))));

  setAddr(0x000004);
}

/* ==========================================================================
   Module 13 — interpreter vs recompiler race
   One hot 68000 loop of BLOCK instructions, run R times. The interpreter pays
   a fixed decode+dispatch cost every instruction, every pass. The recompiler
   pays a one-off translation toll (shown striped) and then near-native cost.
   Both advance on the same clock; amortisation decides the winner.
   ========================================================================== */
function JitLab(root) {
  const BLOCK = 12, INT_COST = 8, COMPILE = 60, JIT_COST = 1;
  const fillI = root.querySelector('[data-int-fill]');
  const fillJ = root.querySelector('[data-jit-fill]');
  const ipsI = root.querySelector('[data-int-ips]');
  const ipsJ = root.querySelector('[data-jit-ips]');
  const nI = root.querySelector('[data-int-n]');
  const nJ = root.querySelector('[data-jit-n]');
  const chip = root.querySelector('[data-block-chip]');
  const runsR = root.querySelector('[data-jit-runs]');
  const runsV = root.querySelector('[data-jit-runs-val]');

  let raf = null, state = null, visible = true;

  function reset() {
    if (raf) cancelAnimationFrame(raf);
    state = null;
    fillI.style.width = '0%';
    fillJ.style.width = '0%';
    fillJ.classList.remove('compiling');
    ipsI.textContent = '0 inst/s';
    ipsJ.textContent = '0 inst/s';
    nI.textContent = '0'; nJ.textContent = '0';
    chip.classList.remove('on'); chip.textContent = 'block cache · empty';
  }

  function race() {
    reset();
    const R = parseInt(runsR.value, 10);
    const totalInst = R * BLOCK;
    const ticksI = totalInst * INT_COST;
    const ticksJ = BLOCK * COMPILE + totalInst * JIT_COST;
    const span = Math.max(ticksI, ticksJ);
    state = { t: 0, t0: performance.now(), span, totalInst, ticksI, ticksJ };
    const perFrame = span / (REDUCED ? 1 : 240);

    const tick = () => {
      const s = state; if (!s) return;
      s.t = Math.min(s.span, s.t + perFrame);
      const el = (performance.now() - s.t0) / 1000 || 1e-3;

      const instI = Math.min(s.totalInst, Math.floor(s.t / INT_COST));
      fillI.style.width = (100 * instI / s.totalInst) + '%';
      nI.textContent = instI.toLocaleString();
      ipsI.textContent = Math.round(instI / el).toLocaleString() + ' inst/s';

      const compileTicks = BLOCK * COMPILE;
      if (s.t < compileTicks) {
        fillJ.classList.add('compiling');
        fillJ.style.width = (100 * (s.t / compileTicks) * (compileTicks / s.ticksJ)) + '%';
        nJ.textContent = '0 — translating the block…';
        ipsJ.textContent = '0 inst/s';
      } else {
        fillJ.classList.remove('compiling');
        if (!chip.classList.contains('on')) { chip.classList.add('on'); chip.textContent = 'block cache · $00FF0100 ✓'; }
        const instJ = Math.min(s.totalInst, Math.floor((s.t - compileTicks) / JIT_COST));
        fillJ.style.width = (100 * (compileTicks + instJ * JIT_COST) / s.ticksJ) + '%';
        nJ.textContent = instJ.toLocaleString();
        ipsJ.textContent = Math.round(instJ / el).toLocaleString() + ' inst/s';
      }

      if (s.t < s.span && visible) raf = requestAnimationFrame(tick);
      else if (s.t >= s.span) {
        const verdict = s.ticksJ < s.ticksI
          ? 'recompiler wins by ' + (s.ticksI / s.ticksJ).toFixed(1) + '×'
          : 'interpreter wins — too few runs to repay the translation';
        ipsJ.textContent += ' · ' + verdict;
      }
    };
    raf = requestAnimationFrame(tick);
  }

  runsR.addEventListener('input', () => { runsV.textContent = runsR.value; });
  root.querySelector('[data-jit-go]').addEventListener('click', race);
  root.querySelector('[data-jit-reset]').addEventListener('click', reset);
  whenVisible(root, () => { visible = true; }, () => { visible = false; if (raf) cancelAnimationFrame(raf); });
  reset();
}

/* ------------------------------------------------------- hero ambient canvas
   Instruction "words" drifting rightward along faint bus lanes; every few
   seconds one lane suffers a branch flush and clears ahead of a red ripple. */
function heroAmbient(canvas) {
  const c = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let raf = null, running = false;
  function size() { const r = canvas.getBoundingClientRect(); canvas.width = r.width * dpr; canvas.height = r.height * dpr; }
  size();
  window.addEventListener('resize', size);

  const LANES = 5;
  const COLS = ['rgba(63,181,255,', 'rgba(255,83,71,', 'rgba(255,196,77,', 'rgba(255,157,60,', 'rgba(179,185,204,'];
  const cells = [];
  let flush = null, lastFlush = 0;

  function spawn(x) {
    const lane = Math.floor(Math.random() * LANES);
    cells.push({
      lane,
      x: x !== undefined ? x : -0.05,
      v: 0.0016 + Math.random() * 0.0022 + lane * 0.0003,
      w: 0.018 + Math.random() * 0.03,
      col: COLS[lane % COLS.length],
      a: 0.16 + Math.random() * 0.2,
    });
  }
  for (let i = 0; i < 42; i++) spawn(Math.random());

  function draw(now) {
    const W = canvas.width, H = canvas.height;
    c.clearRect(0, 0, W, H);
    const laneY = i => H * (0.16 + i * 0.17);
    c.lineWidth = 1;
    for (let i = 0; i < LANES; i++) {
      c.strokeStyle = 'rgba(90,100,130,0.14)';
      c.beginPath(); c.moveTo(0, laneY(i)); c.lineTo(W, laneY(i)); c.stroke();
    }
    if (!REDUCED && now - lastFlush > 5200 + Math.random() * 2600) {
      lastFlush = now;
      flush = { lane: Math.floor(Math.random() * LANES), x: 0.9, r: 0 };
      for (let i = cells.length - 1; i >= 0; i--) {
        if (cells[i].lane === flush.lane && cells[i].x < flush.x) cells.splice(i, 1);
      }
    }
    cells.forEach(cell => {
      if (!REDUCED) cell.x += cell.v;
      const y = laneY(cell.lane);
      c.fillStyle = cell.col + cell.a + ')';
      const w = cell.w * W, h = 7 * dpr;
      c.beginPath();
      c.roundRect ? c.roundRect(cell.x * W, y - h / 2, w, h, 3 * dpr) : c.rect(cell.x * W, y - h / 2, w, h);
      c.fill();
    });
    for (let i = cells.length - 1; i >= 0; i--) if (cells[i].x > 1.02) cells.splice(i, 1);
    while (cells.length < 42) spawn();
    if (flush) {
      flush.r += 0.02;
      const y = laneY(flush.lane);
      c.strokeStyle = 'rgba(255,95,95,' + Math.max(0, 0.35 - flush.r * 0.35) + ')';
      c.lineWidth = 2 * dpr;
      c.beginPath(); c.arc(flush.x * W, y, flush.r * H * 0.9, 0, 7); c.stroke();
      if (flush.r > 1) flush = null;
    }
    if (running && !REDUCED) raf = requestAnimationFrame(draw);
  }
  function start() { if (!running) { running = true; REDUCED ? draw(0) : raf = requestAnimationFrame(draw); } }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); }
  whenVisible(canvas, start, stop);
}

/* ------------------------------------------------------- glossary tooltips */
function initTooltips() {
  const terms = [...document.querySelectorAll('.term[data-tip]')];
  if (!terms.length) return;
  const tip = document.createElement('div');
  tip.className = 'tip-bubble';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let current = null;
  const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function place(el) {
    current = el;
    const label = el.textContent.trim().replace(/\s+/g, ' ');
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

/* ==========================================================================
   Wire-up
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  const heroCanvas = document.getElementById('hero-pipe');
  if (heroCanvas) heroAmbient(heroCanvas);

  const tc = document.getElementById('lab-toycpu'); if (tc) ToyCpuLab(tc);
  const bl = document.getElementById('lab-bits');   if (bl) BitLab(bl);
  const am = document.getElementById('lab-addr');   if (am) AddrLab(am);
  const as = document.getElementById('lab-asm');    if (as) Asm68kLab(as);
  const bs = document.getElementById('lab-bus');    if (bs) BusLab(bs);
  const mm = document.getElementById('lab-memmap'); if (mm) MemMapLab(mm);
  const jl = document.getElementById('lab-jit');    if (jl) JitLab(jl);

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
