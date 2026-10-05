# Native wasm port probe (measured, 2026-10-05)

Question: can pokeruby's C be compiled to wasm directly, rather than running a
built ROM on a wasm GBA core?

## Method

Ran upstream's real compile pipeline with emcc substituted for agbcc:

    arm-none-eabi-cpp <upstream CPPFLAGS> f.c -o f.i
    tools/preproc/preproc f.i charmap.txt > f.pp.c
    emcc -fsyntax-only -O1 f.pp.c

`preproc` is load-bearing: it expands `INCBIN_*()` (which `include/global.h`
defines as the placeholder `{0}`) and applies charmap.txt to string literals.
A first probe that skipped preproc reported 14/352 passing, which was an
artifact of my own harness, not a fact about the code. A second probe that
added `-I include` (upstream uses only `-iquote include`) made emscripten's
`<string.h>` resolve `<strings.h>` to the repo's game-strings header; also my
bug. Numbers below are from the corrected run.

## Result: 337 / 352 C files compile to wasm

Only 15 files fail, and every failure is the same single cause: ARM inline asm
with named registers. 27 sites total (r0 x7, r1 x6, r2 x5, r4 x3, r5 x2,
r3 x2, r8 x1, r9 x1), in battle_script_commands, contest_2, contest_link_util,
easy_chat_2, event_object_movement, item_menu, menu, mystery_event_menu,
palette, party_menu, pokenav, record_mixing, roulette_gfx, text, tv.

wasm32 helps more than expected: int/long/pointer are all 32-bit, same as ARM32,
so the struct layouts and the codebase's pervasive 32-bit assumptions hold.

## Why I still did not ship a native port

The C is ~96% portable; the C was never the problem. Two blockers are, and
neither is a small piece of work:

1. **No PPU.** The game writes tiles, tilemaps, OAM and palettes into VRAM and
   expects hardware to rasterize them. It drives 38 distinct video/DMA/timer
   registers. A native port has to supply BG modes 0-5, affine backgrounds,
   128 sprites with affine transforms, windows, alpha blending, mosaic and
   priority resolution, plus a DMA engine, timers, and IRQ/VCOUNT timing.
   That is most of a GBA emulator, written from scratch, to end up rendering
   less accurately than mGBA already does.

2. **Assets would become redistribution.** `preproc` bakes assets in at build
   time: 1985 `INCBIN_*` sites referencing 1948 distinct files, against 97 MB
   of graphics/sound/data committed upstream. A wasm bundle built this way
   embeds the game's art and music, which the fleet rules forbid shipping.
   Complying means replacing all 1985 sites with runtime reads from the user's
   ROM at the correct offsets — mechanical, but ~2000 offsets to derive and
   verify.

Also outstanding, though minor next to the above: `src/crt0.s` (entry + IRQ
vector), `src/libs/libagbsyscall.s` (BIOS SWI wrappers), and
`src/libs/m4a_1.s` (the ARM sound mixer). libgcnmultiboot.s can be stubbed.

Conclusion: a native port is a real, scoped project — not a dead end — but it is
far larger than this task, and the honest fallback is the wasm GBA core.
