# pokeruby — Pokémon Ruby & Sapphire

**Both versions build byte-identical to the staged ROMs.** The browser target runs
them on an emscripten build of mGBA, from a ROM the user picks themselves.

---

## 1. Matching builds

Upstream documents its own expected hashes in `ruby_rev2.sha1` / `sapphire_rev2.sha1`.
I checked those against the staged ROMs **before** building anything. They agree
exactly — there is no mismatch to report.

| | sha1 | size |
|---|---|---|
| staged `roms/pokeruby.gba` | `5b64eacf892920518db4ec664e62a086dd5f5bc8` | 16777216 |
| upstream `ruby_rev2.sha1` | `5b64eacf892920518db4ec664e62a086dd5f5bc8` | — |
| **built `pokeruby_rev2.gba`** | **`5b64eacf892920518db4ec664e62a086dd5f5bc8`** | 16777216 |
| staged `roms/pokesapphire.gba` | `89b45fb172e6b55d51fc0e61989775187f6fe63c` | 16777216 |
| upstream `sapphire_rev2.sha1` | `89b45fb172e6b55d51fc0e61989775187f6fe63c` | — |
| **built `pokesapphire_rev2.gba`** | **`89b45fb172e6b55d51fc0e61989775187f6fe63c`** | 16777216 |

Verified two ways, not one: the build's own `sha1sum -c` (the `compare_*` targets),
and an independent `cmp` of the built file against the staged ROM afterwards. Both
clean. Reproduced from a wiped `build/` directory a second time, same hashes.

`rev2` is the right target: these are **(USA, Europe) (Rev 2)**, i.e. game version
1.2, so the default `make ruby` / `make sapphire` (v1.0) targets would *not* match.
The ROM header's revision byte (0xBC) reads 2, which the browser test asserts.

### Pinned revision

```
pret/pokeruby  5784633ce4ef7ade1a7f2d2d0c288e3d5e6cdd7f   (2026-09-28)
               "Sync a lot of player controller with pokeemerald (#892)"
```
Checked out detached at that commit; not a moving branch.

### Toolchain

| component | version | where from |
|---|---|---|
| agbcc | `gcc 2.9-arm-000512` | pret/agbcc release asset, **prebuilt Linux x86-64** |
| agbcc tarball | sha256 `bcf0197e3e27d8e08506a142e25fa68ea7f6679a98347a6406804eb3f9ff4d29` | `releases/download/release/agbcc.tar.gz` |
| arm-none-eabi binutils | 2.45.50.20251209 | Ubuntu `binutils-arm-none-eabi` deb |
| arm-none-eabi-gcc/cpp | 14.2.1 20241119 (`15:14.2.rel1-1`) | Ubuntu `gcc-arm-none-eabi` deb |
| host gcc/g++ | 15.2.0 (Ubuntu 26.04) | system |
| emscripten | 4.0.10 (`b7dc6e57`) | shared emsdk |
| mGBA | `68cf79fe55257b61efaeea87c83de69aab01f963` (2026-10-04) | github.com/mgba-emu/mgba |

Reproducible recipe is in `~/decompfleet/shared/agbcc-notes.md` (shared with the
pokefirered agent). Short version:

```sh
export PATH="$HOME/decompfleet/shared/arm-bin/usr/bin:$PATH"
cp -r ~/decompfleet/shared/toolchain/dl/agbcc-prebuilt tools/agbcc
make tools -j$(nproc)
make compare_ruby_rev2     TOOLCHAIN="$HOME/decompfleet/shared/arm-bin/usr" -j$(nproc)
make compare_sapphire_rev2 TOOLCHAIN="$HOME/decompfleet/shared/arm-bin/usr" -j$(nproc)
```

Three things INSTALL.md implies that turned out to be unnecessary: devkitARM/devkitPro
(plain Ubuntu `arm-none-eabi-*` is fine if you override `TOOLCHAIN`), building agbcc
from source (there is a working prebuilt Linux binary), and any patching of the host
tools (they all compile under gcc 15 with their own `-Werror` intact). No sudo was
used or needed anywhere — `apt-get download` + `dpkg-deb -x` covers it.

A full clean build is ~8 s wall / ~40 s CPU at `-j12`, 798 objects.

---

## 2. What I shipped for the browser, and why

**Shipped: the decomp's ROM on an emscripten build of mGBA.** Not a native wasm port
of the decomp. I tried the native path first and measured it rather than assuming.

### The native-port probe (full detail in `notes/native-port-probe.md`)

Running upstream's real pipeline (`arm-none-eabi-cpp` → `tools/preproc` → compiler)
with **emcc substituted for agbcc**, **337 of 352 C files compile to wasm.** The 15
failures all have the same single cause: ARM inline asm with named registers, 27
sites in total. wasm32 helps — int, long and pointer are all 32-bit, same as ARM32,
so the codebase's pervasive 32-bit assumptions hold.

(Two earlier probe runs gave 14/352 and 254/352. Both were my harness being wrong —
one skipped `preproc`, which is what expands `INCBIN_*`; the other added `-I include`,
which made emscripten's `<string.h>` resolve `<strings.h>` to the repo's game-strings
header. The 337 figure is from the corrected run.)

So the C was never the blocker. Two other things are:

1. **There is no PPU.** The game writes tiles, tilemaps, OAM and palettes into VRAM
   and expects hardware to rasterize. It drives 38 distinct video/DMA/timer registers.
   A native port must supply BG modes 0–5, affine backgrounds, 128 affine-capable
   sprites, windows, alpha blending, mosaic, priority resolution, a DMA engine, timers
   and IRQ/VCOUNT timing — most of a GBA emulator, written from scratch, to end up
   rendering less accurately than mGBA already does.
2. **Assets would become redistribution.** `preproc` bakes assets in at build time:
   1985 `INCBIN_*` sites over 1948 distinct files, against 97 MB of graphics/sound/data
   committed upstream. A wasm bundle built that way embeds the game's art and music,
   which the fleet rules forbid shipping. Complying means replacing all 1985 sites with
   runtime reads from the user's ROM at derived offsets.

Also outstanding but minor beside those: `src/crt0.s` (entry + IRQ vector),
`src/libs/libagbsyscall.s` (BIOS SWI wrappers) and `src/libs/m4a_1.s` (ARM sound
mixer) would need reimplementing; `libgcnmultiboot.s` could be stubbed.

A native port is a real, scoped project — not a dead end — but it is far larger than
this task, so the honest answer was the wasm core.

### What the browser target actually is

Not EmulatorJS and not a libretro frontend: a direct build of mGBA's `mCore` API to
wasm, plus a ~300-line C shim (`web/src/shim.c`) and one static HTML page. That keeps
it small and dependency-free:

```
dist/pokeruby.wasm   663 KB
dist/pokeruby.js      19 KB
dist/index.html       20 KB
```

- **The user supplies the ROM.** A real `<input type=file>` plus drag-and-drop; read
  with the File API into wasm linear memory. The page is static files with no server
  component, and the test asserts the only network requests the page ever makes are
  its own `.js` and `.wasm`.
- The ROM is cached in IndexedDB so a reload doesn't re-prompt; there is a
  **"forget ROM"** button. It never leaves the device.
- **Saves persist across reload.** Cartridge flash (128 KiB, FLASH1M — matching the
  real Ruby/Sapphire save media) is mirrored to IndexedDB whenever its hash changes,
  and flushed on `pagehide`/`visibilitychange`. Keyed per game code so Ruby (AXVE)
  and Sapphire (AXPE) do not share a save slot. Savestates work the same way.
- **Muted by default, and genuinely silent**: no `AudioContext` is constructed at all
  until the user clicks the unmute button. Muting is absence of an audio graph, not a
  gain node at zero.

Build: `cd web && make`. Tests: `make selftest` (core, in node) and
`make browsercheck` (the real page in headless Chrome).

---

## 3. What I actually tested

### Matching builds — verified
- Both ROMs byte-identical, confirmed by `sha1sum -c` **and** independent `cmp`.
- Reproduced from a wiped build directory.

### Core, in node (`web/test/core-smoke.mjs`), muted — verified
Both ROMs, 1800 frames each with scripted input:
- ROM header read back as `POKEMON RUBYAXVE` / `POKEMON SAPPAXPE`, revision 2.
- 1800/1800 frames advanced.
- Non-black output (mean luma 102.3 at end; 0.0 mid-fade, so the probe does
  distinguish).
- Savestate round trip: snapshot → 240 frames of input → restore returns the exact
  frame hash. The test fails itself as "inconclusive" if the picture didn't change
  during the divergence window, so a frozen core can't fake a pass.
- **I looked at the frames**, not just the luma numbers. Dumped PPMs show the
  copyright screen, the Ruby title screen, Birch appearing, and his
  "This world is widely inhabited by creatures known as POKéMON" speech with Mudkip.

### The real page, headless Chrome (`web/test/run-browser-check.sh`), muted — verified
13/13 checks pass for **both** Ruby and Sapphire. The ROM is fed to the genuine file
input over the DevTools protocol (`DOM.setFileInputFiles`), so the picker, File API
path, IndexedDB cache and boot sequence under test are the ones a user gets.

- core initialises; ROM accepted through the file picker; revision 2 asserted
- no network request other than the page's own js/wasm
- ~1850 frames run; canvas not black (mean luma 103.4); frame hash keeps changing
  (so "not black" can't be satisfied by a wedged core holding one bright frame)
- **audio muted — asserted that no `AudioContext` object exists**
- ROM resumes from local cache after a real page reload
- **cartridge save survives a real reload** (bytes written, flushed, page reloaded,
  bytes read back identical)
- savestate round trip across that reload
- no uncaught page errors, no console errors

Screenshots confirm the page renders the game at full size with the control bar
below it, status line reading `POKEMON RUBY · rev 2` / `POKEMON SAPP · rev 2`.

### What I did NOT test — be clear about this
- **No long-form play.** The muted run reaches Professor Birch's opening speech and
  no further. Nothing past the intro is play-tested: not the overworld, not a battle,
  not the PokéDex, not the Pokémon Centre, not the end of the game.
- **I never reached an in-game save.** "Saves persist across reload" is verified at
  the cartridge-flash layer: bytes written into the save buffer survive a reload
  intact, and mGBA logs `Performing flash bank switch to bank 0` so the game does
  drive the flash hardware. But I did not play far enough to press SAVE in the menu
  and confirm a real save file reloads into a continuable game. **Unverified.**
- **Only headless Chrome.** No Firefox, no Safari, no real mobile browser.
- **No touch controls.** Keyboard and gamepad only. The gamepad path is written
  against the Standard Gamepad mapping but **unverified** — no controller was
  attached.
- **Audio output itself is unverified.** The code to drain mGBA's buffer into a
  ScriptProcessor exists and is wired to the unmute button, but every test ran muted
  by rule, so I have never heard it. Treat sound as untested.
- German ROMs, the debug targets, rev0/rev1 and `make modern` were not built.
- Link cable / wireless features are not available and were not attempted.

---

## 4. Proposed catalog fragment

Do not merge mechanically — `verification.date`, `source` and `embedUrl` are
placeholders until this is actually published.

```json
{
  "id": "pokemon-ruby-sapphire",
  "title": "Pokémon Ruby & Sapphire",
  "aliases": ["pokeruby", "pokesapphire", "pokemon ruby", "pokemon sapphire", "ruby", "sapphire", "hoenn"],
  "year": 2002,
  "genre": "RPG",
  "kind": "Decompilation",
  "mode": "embed",
  "engine": "the pret/pokeruby decompilation, built to matching ROMs and run on an emscripten build of mGBA",
  "description": "Travel Hoenn: catch, train and battle through Ruby or Sapphire.",
  "overview": "Pokémon Ruby and Sapphire built from the pret/pokeruby decompilation, pinned at 5784633c. Both builds are byte-identical to retail (USA, Europe) (Rev 2) cartridge dumps — sha1 5b64eacf892920518db4ec664e62a086dd5f5bc8 for Ruby and 89b45fb172e6b55d51fc0e61989775187f6fe63c for Sapphire. The page runs them on a direct WebAssembly build of mGBA's core, 663 KB, with no emulator frontend in between. You supply your own ROM: it is read in your browser with the File API straight into the emulator's memory. The page is static files with no server component, and makes no network request after its own two files load.",
  "source": "https://github.com/andrewnakas/pokeruby-web",
  "engineLicense": "pret/pokeruby; mGBA core MPL-2.0",
  "assetLicense": "None distributed — the player supplies their own ROM",
  "assetRequirements": "Your own Pokémon Ruby or Sapphire ROM, (USA, Europe) (Rev 2) / game version 1.2. Ruby sha1 5b64eacf892920518db4ec664e62a086dd5f5bc8, Sapphire sha1 89b45fb172e6b55d51fc0e61989775187f6fe63c. Nothing is uploaded.",
  "controls": [
    "Arrow keys — D-pad",
    "X — A",
    "Z — B",
    "A / S — L / R",
    "Enter — Start",
    "Shift — Select",
    "Gamepad — any standard controller (untested)"
  ],
  "saveInstructions": "Save from the in-game menu (Start, SAVE). The cartridge save is mirrored into this browser's storage and restored automatically on reload; Ruby and Sapphire keep separate saves. There are also save-state buttons. Clearing site data removes everything, including the cached ROM.",
  "limitations": [
    "You must supply your own ROM; none is distributed.",
    "Revision 2 (game v1.2) only — the v1.0 and v1.1 dumps are a different build and are untested here.",
    "Verified only as far as Professor Birch's opening speech. The overworld, battles and the rest of the game have not been play-tested.",
    "Reaching an in-game save was not tested; save persistence is verified at the cartridge-flash layer only.",
    "Sound is implemented but has never been listened to — all testing was muted.",
    "Keyboard and gamepad only; no on-screen touch controls.",
    "Tested in headless Chrome only.",
    "Link cable, trading and link battles are not available in the browser."
  ],
  "inputs": ["Keyboard", "Gamepad"],
  "downloadMB": 1,
  "complete": false,
  "color": "#c8402f",
  "shelf": "decomp",
  "platform": "Game Boy Advance",
  "launch": "embed",
  "touch": false,
  "embedUrl": "https://andrewnakas.github.io/pokeruby-web/",
  "verification": {
    "status": "smoke-tested",
    "date": null,
    "browsers": ["Chrome (headless)"],
    "scope": "Muted headless run of both versions: boot, title screen, and Professor Birch's intro speech. Cartridge-save and savestate persistence across a real page reload. No play-testing beyond the intro.",
    "playthrough": false
  },
  "image": "/images/pokemon-ruby-sapphire.png"
}
```

---

## 5. Layout

```
games/pokeruby/
  STATUS.md                     this file
  .gitignore                    no ROMs, no extracted assets, no build output
  notes/native-port-probe.md    the measured native-wasm feasibility study
  upstream/pokeruby/            pret/pokeruby @ 5784633c (detached), not vendored
  ref/mgba/                     mgba @ 68cf79fe, built to build-wasm/libmgba.a
  web/
    Makefile                    all / test / selftest / browsercheck / check
    src/shim.c                  mCore -> JS surface
    src/index.html              the page
    test/core-smoke.mjs         core test in node (VJ_DUMP=dir for PPM frames)
    test/browser-check.mjs      CDP harness, drives the real file picker
    test/run-browser-check.sh   serves dist/, runs headless Chrome, tears down
    dist/                       build output (gitignored)
```

### Two traps worth knowing about

**The shim must be compiled with libmgba's exact `-D` set.** `struct mCore`'s layout
depends on `ENABLE_DEBUGGERS`, `ENABLE_VFS`, `ENABLE_DIRECTORIES` and friends. Compile
the shim without them and every function pointer in the vtable reads back as `NULL` —
no link error, just a "null function or function signature mismatch" trap at the first
call. The Makefile therefore *derives* the defines from the mGBA build's own
`flags.make` rather than restating them, and refuses to build if it can't read them.

**A second tab blocks `indexedDB.deleteDatabase()` forever.** A leftover headless tab
holding the database open makes the new tab's delete hang, so the page stalls on its
first write and never boots the ROM — which looks exactly like a broken core. The test
runner closes every existing page target before it starts.
