# Inside the Sega Genesis

Interactive, explorable teardowns of the Sega Genesis / Mega Drive hardware —
part of the [**oldmachines**](https://github.com/oldmachines) collection.

Each subsystem is a self-contained, dependency-free static site: no build step,
no framework, no tracking. Open it in a browser and it runs.

## Subsystems

| Subsystem | Status | Path |
| --- | --- | --- |
| **CPU & the 68000** | ✅ Ready — 15-module interactive course | [`cpu/`](cpu/) |
| **Graphics & the VDP** | ✅ Ready — 16-module interactive course | [`graphics/`](graphics/) |
| **Audio · FM & PSG** | ✅ Ready — 16-module interactive course | [`audio/`](audio/) |
| **The cartridge** | ✅ Ready — 13-module interactive course | [`cartridge/`](cartridge/) |
| **Write your own homebrew** | ✅ Ready — 13-module interactive course | [`homebrew/`](homebrew/) |

Every course follows the same arc: **Part I** teaches the field's fundamentals
from absolute zero, **Part II** tears down the Genesis' take on it, and
**Part III** shows how open-source emulators reproduce it. A fifth course caps
the collection: once the machine has been taken apart, you learn to write your
own software for it. Each module ships **interactive labs** — everything is
drawn and synthesised live in the browser; no game assets are included.

### CPU & the 68000

How processors work from zero (fetch–decode–execute, registers, binary and
two's-complement, addressing modes, exceptions), then the Genesis' twin CPUs —
the Motorola **68000** main processor and the Zilog **Z80** sound coprocessor —
the 68000's register file and addressing modes, the shared 68000/Z80/VDP bus and
its arbitration, the memory map, and interrupts (VBlank, HBlank) — and finally
how emulators run two processors in lockstep and stay cycle-accurate. Labs
include a steppable toy CPU, a 68000 register/flag explorer, an addressing-mode
visualiser, a bus-arbitration timeline and an interpreter-vs-JIT comparison.

### Graphics & the VDP

2D tile-and-sprite rendering from zero (pixels, tiles/patterns, palettes,
nametables, scrolling, sprites), then the Sega **VDP** — VRAM, CRAM and VSRAM,
the two scroll planes A and B plus the window, the sprite engine and its
per-line limits, full/cell/line scroll modes, shadow & highlight, the 512-colour
master palette, and interlace/H32-vs-H40 modes — and finally how emulators redraw
the screen one scanline at a time and reproduce mid-frame raster effects. Labs
include a tile/pattern editor, a palette (CRAM) explorer, a two-plane parallax
scroller, a sprite-per-line overflow simulator and a shadow/highlight blender.

### Audio · FM & PSG

Sound synthesis from zero (waves, samples, additive vs FM synthesis, ADSR
envelopes), then the chips that gave the Genesis its voice — the Yamaha
**YM2612** six-channel FM synthesiser (operators, the eight algorithms, feedback,
LFO, the DAC channel) and the **SN76489** PSG (three squares + noise) — driven by
the Z80 — and finally how emulators such as **Nuked-OPN2** reproduce the FM chip
at sample accuracy. Every module has an **integrated synthesiser**: all audio is
*synthesised live in the browser* with the Web Audio API to demonstrate a
concept. **No copyrighted game audio is shipped.**

### The cartridge

ROM media from zero (mask ROM, the address/data bus, how a chip is read), then
Genesis cartridges — the 68000 memory map, the ROM header and region checks, the
**TMSS** trademark security, bank-switching mappers (the Sega SRAM mapper and the
SSF2 mapper), battery-backed saves, the **Sonic & Knuckles** lock-on passthrough,
and the Sega CD / 32X expansions on the edge connector — and finally how
emulators load a `.bin`/`.md` image, detect mappers and persist SRAM. Labs
include a ROM-read scope, a memory-map explorer, a bank-switching playground, a
header inspector and a lock-on cartridge simulator.

### Write your own homebrew

The collection's capstone: creating your own Genesis software with the free,
community-built toolchain — no Sega code anywhere. It covers what homebrew is,
the [SGDK](https://github.com/Stephane-D/SGDK) toolkit and the `m68k-elf-gcc`
cross-compiler, step-by-step setup on **Windows, macOS and Linux**, the
hello-world walkthrough, the build pipeline and the ROM header, drawing tiles and
sprites through the VDP from C, playing FM music with the XGM driver, reading the
controller, the 60 Hz (or 50 Hz) game loop, and running your code in
[BlastEm](https://github.com/libretro/blastem) and on real hardware (Mega
EverDrive and other flashcarts). Labs include a simulated first-boot screen, an
animated build pipeline, a byte-level ROM-header inspector, a live controller-bit
tester and a playable frame-budget game.

## Running locally

It's a plain static site. Open `index.html`, or serve the folder:

```sh
python3 -m http.server 8000
# → http://localhost:8000
```

Audio starts on first interaction (browsers require a user gesture before
playing sound).

## Deployment

Pushing to the default branch publishes to GitHub Pages via
`.github/workflows/pages.yml`. Enable Pages once under
**Settings → Pages → Source: GitHub Actions**. The site then lives at
`https://oldmachines.github.io/genesis/`.

## Accuracy & credits

Technical content is grounded in the open-source
[Genesis Plus GX](https://github.com/libretro/Genesis-Plus-GX) and
[BlastEm](https://github.com/libretro/blastem) emulators, the
[Nuked-OPN2](https://github.com/nukeykt/Nuked-OPN2) YM2612 core, and the
community documentation gathered at [Plutiedev](https://plutiedev.com) and
[SegaRetro](https://segaretro.org). The homebrew course follows the
[SGDK](https://github.com/Stephane-D/SGDK) project's public documentation. These
are educational explainers, not authoritative specifications.

"Sega", "Genesis" and "Mega Drive" are trademarks of Sega. This is an
independent, non-commercial educational project and is not affiliated with or
endorsed by Sega.

## License

Code is released under the [MIT License](LICENSE). See the file for details.
