# Browser target for pokeruby / pokesapphire.
#
# Builds the mGBA core to wasm plus a small shim, and emits a static page that
# takes the user's own ROM from a file picker. No ROM, and no bytes extracted
# from one, are produced or consumed by this Makefile.
#
#   make            build dist/ (the shippable page)
#   make test       also build the node-side core test harness
#   make selftest   run the muted self-test against ~/decompfleet/roms
#   make clean

MGBA      ?= $(CURDIR)/../ref/mgba
MGBA_BUILD = $(MGBA)/build-wasm
LIBMGBA    = $(MGBA_BUILD)/libmgba.a
ROMS      ?= $(HOME)/decompfleet/roms
SHOTS     ?=

# The shim reads struct mCore through mGBA's headers, so it MUST be compiled
# with the same -D set as libmgba.a or the fields land at different offsets and
# every vtable entry reads back as NULL. Deriving this from the build instead of
# copying it by hand is deliberate: hand-copying it is exactly how that bug got
# in, and it fails silently at runtime, not at link time.
MGBA_DEFS = $(shell sed -n 's/^C_DEFINES = //p' $(MGBA_BUILD)/CMakeFiles/mgba.dir/flags.make)

CPPFLAGS = -I $(MGBA)/include -I $(MGBA)/src -I $(MGBA_BUILD)/include \
           -D_GNU_SOURCE -DPATH_MAX=4096 -DDISABLE_THREADING $(MGBA_DEFS)

# No audio device, no filesystem, no GL: the page owns the canvas and only
# creates an AudioContext if the user explicitly unmutes.
EMFLAGS = -s MODULARIZE=1 -s EXPORT_NAME=createGBA \
          -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=64MB \
          -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","HEAPU8","HEAPU32","HEAP16"]' \
          -s EXPORTED_FUNCTIONS='["_malloc","_free"]' \
          -s FILESYSTEM=0

.PHONY: all test selftest browsercheck check clean checklib

all: dist/pokeruby.js dist/index.html

checklib:
	@test -f $(LIBMGBA) || { \
	  echo "missing $(LIBMGBA)"; \
	  echo "build it first -- see ../STATUS.md for the exact emcmake line"; exit 1; }
	@test -n "$(MGBA_DEFS)" || { \
	  echo "could not read C_DEFINES from the mgba build; refusing to build with"; \
	  echo "mismatched struct layouts (every mCore function pointer would be NULL)"; exit 1; }

dist/pokeruby.js: src/shim.c $(LIBMGBA) Makefile | checklib
	@mkdir -p dist
	emcc -O3 $< $(LIBMGBA) $(CPPFLAGS) -o $@ $(EMFLAGS) -s ENVIRONMENT=web

dist/index.html: src/index.html
	@mkdir -p dist
	cp $< $@

test: test/core-node.js

test/core-node.js: src/shim.c $(LIBMGBA) Makefile | checklib
	@mkdir -p test
	emcc -O2 $< $(LIBMGBA) $(CPPFLAGS) -o $@ $(EMFLAGS) -s ENVIRONMENT=node

# Core-level, outside a browser. Fast; isolates core bugs from page bugs.
selftest: test/core-node.js
	node test/core-smoke.mjs $(ROMS)/pokeruby.gba 1800
	node test/core-smoke.mjs $(ROMS)/pokesapphire.gba 1800

# The real page in headless Chrome, ROM fed through the actual file picker.
browsercheck: all
	./test/run-browser-check.sh $(ROMS)/pokeruby.gba $(SHOTS)
	./test/run-browser-check.sh $(ROMS)/pokesapphire.gba $(SHOTS)

check: selftest browsercheck

clean:
	rm -rf dist test/core-node.js test/core-node.wasm
