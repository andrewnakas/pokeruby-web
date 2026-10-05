/* Core-level smoke test, outside the browser.
 *
 * Isolates "does the mGBA shim work" from "does the page work". Runs a ROM for
 * N frames and reports frame count, mean luma and the save-buffer state.
 *
 * Audio is never drained and no audio device exists in node, so this is silent
 * by construction.
 *
 *   node core-smoke.mjs <rom path> [frames]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const createGBA = require(resolve(here, 'core-node.js'));

const romPath = process.argv[2];
const frames = Number(process.argv[3] || 600);
if (!romPath) {
	console.error('usage: node core-smoke.mjs <rom> [frames]');
	process.exit(2);
}

const rom = readFileSync(romPath);
const M = await createGBA();

const api = {
	init: M.cwrap('vj_init', 'number', []),
	loadRom: M.cwrap('vj_load_rom', 'number', ['number', 'number']),
	runFrame: M.cwrap('vj_run_frame', null, []),
	frameCounter: M.cwrap('vj_frame_counter', 'number', []),
	opaque: M.cwrap('vj_opaque', null, []),
	meanLuma: M.cwrap('vj_mean_luma', 'number', []),
	frameHash: M.cwrap('vj_frame_hash', 'number', []),
	setKeys: M.cwrap('vj_set_keys', null, ['number']),
	saveHash: M.cwrap('vj_save_hash', 'number', []),
	saveBuffer: M.cwrap('vj_save_buffer', 'number', []),
	saveSize: M.cwrap('vj_save_size', 'number', []),
	stateSize: M.cwrap('vj_state_size', 'number', []),
	stateSave: M.cwrap('vj_state_save', 'number', []),
	stateLoad: M.cwrap('vj_state_load', 'number', ['number', 'number']),
	title: M.cwrap('vj_game_title', 'string', []),
	revision: M.cwrap('vj_rom_revision', 'number', []),
	sampleRate: M.cwrap('vj_sample_rate', 'number', [])
};

function fail(msg) {
	console.log('FAIL ' + msg);
	process.exitCode = 1;
}

if (!api.init()) {
	fail('vj_init');
	process.exit(1);
}
console.log('init ok, sampleRate=' + api.sampleRate());

const p = M._malloc(rom.length);
M.HEAPU8.set(rom, p);
const ok = api.loadRom(p, rom.length);
M._free(p);
if (!ok) {
	fail('vj_load_rom');
	process.exit(1);
}
console.log('rom loaded: title="' + api.title() + '" headerRevision=' + api.revision());

// GBA keys, bit positions from mGBA's enum GBAKey.
const KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 };

// Frame dumps as binary PPM: no PNG encoder needed, and every image viewer and
// ImageMagick reads it. Written only when VJ_DUMP is set, so the test stays
// side-effect-free by default. Mean luma proves "not black"; these prove the
// frame is actually the game and not noise, which luma alone cannot.
const dumpDir = process.env.VJ_DUMP;
if (dumpDir) {
	mkdirSync(dumpDir, { recursive: true });
}
const W = M.cwrap('vj_width', 'number', [])();
const H = M.cwrap('vj_height', 'number', [])();
const fbPtr = M.cwrap('vj_framebuffer', 'number', [])();

function dumpFrame(tag) {
	if (!dumpDir) {
		return;
	}
	const rgba = M.HEAPU8.subarray(fbPtr, fbPtr + W * H * 4);
	const header = Buffer.from(`P6\n${W} ${H}\n255\n`, 'ascii');
	const px = Buffer.allocUnsafe(W * H * 3);
	for (let i = 0; i < W * H; i++) {
		px[i * 3 + 0] = rgba[i * 4 + 0];
		px[i * 3 + 1] = rgba[i * 4 + 1];
		px[i * 3 + 2] = rgba[i * 4 + 2];
	}
	writeFileSync(`${dumpDir}/${tag}.ppm`, Buffer.concat([header, px]));
}

let lastLuma = -1;
const lumaAt = {};
// Tap START and A periodically: Ruby's intro is a sequence of waits that only
// advance on a press, so a purely passive run stalls on the title screen.
for (let i = 0; i < frames; i++) {
	if (i > 120 && i % 40 === 0) {
		api.setKeys(i % 80 === 0 ? KEY.START : KEY.A);
	} else if (i % 40 === 20) {
		api.setKeys(0);
	}
	api.runFrame();
	if (i === 1 || i === 60 || i === 180 || i === 300 || i === frames - 1) {
		api.opaque();
		lastLuma = api.meanLuma();
		lumaAt[i] = Number(lastLuma.toFixed(2));
		dumpFrame('f' + String(i).padStart(5, '0'));
	} else if (dumpDir && i % 150 === 0) {
		api.opaque();
		dumpFrame('f' + String(i).padStart(5, '0'));
	}
}
api.setKeys(0);

console.log('frames run=' + frames + ' coreFrameCounter=' + api.frameCounter());
console.log('mean luma by frame: ' + JSON.stringify(lumaAt));

if (api.frameCounter() < frames) {
	fail('core advanced fewer frames (' + api.frameCounter() + ') than requested (' + frames + ')');
}
if (!(lastLuma > 1.0)) {
	fail('frame is essentially black at end of run (mean luma ' + lastLuma.toFixed(3) + ')');
} else {
	console.log('PASS non-black frame, mean luma ' + lastLuma.toFixed(2));
}

// Savestate round trip: snapshot, run on, restore, and require the restored
// frame to hash-match the snapshot frame exactly.
api.opaque();
const hashAtSnapshot = api.frameHash();
const sSize = api.stateSize();
const sPtr = api.stateSave();
if (!sPtr || sSize <= 0) {
	fail('savestate capture (size=' + sSize + ')');
} else {
	const snapshot = Uint8Array.from(M.HEAPU8.subarray(sPtr, sPtr + sSize));
	// Keep tapping during the divergence window. A passive 120 frames can land
	// entirely inside one waiting-for-input text box, in which case the picture
	// never changes and the round trip would "pass" without proving anything.
	for (let i = 0; i < 240; i++) {
		if (i % 20 === 0) {
			api.setKeys(KEY.A);
		} else if (i % 20 === 10) {
			api.setKeys(0);
		}
		api.runFrame();
	}
	api.setKeys(0);
	api.opaque();
	const hashAfter = api.frameHash();
	const rp = M._malloc(sSize);
	M.HEAPU8.set(snapshot, rp);
	const restored = api.stateLoad(rp, sSize);
	M._free(rp);
	// A savestate restores emulator state; the frame buffer is only redrawn by
	// the next frame, so run one and compare that.
	api.runFrame();
	api.opaque();
	const hashRestored = api.frameHash();
	console.log('savestate: size=' + sSize + ' restored=' + restored +
		' hash@snapshot=' + hashAtSnapshot + ' hash@+240=' + hashAfter + ' hash@restored=' + hashRestored);
	if (!restored) {
		fail('savestate load returned false');
	} else if (hashAfter === hashAtSnapshot) {
		fail('inconclusive: frame did not change over 240 frames, so the round trip proves nothing');
	} else if (hashRestored === hashAfter) {
		fail('savestate load did not rewind the frame');
	} else {
		console.log('PASS savestate round trip rewound the picture');
	}
}

// Save media: report whether the cartridge save buffer was touched. Ruby only
// writes flash when the game saves, so a zero hash here is expected this early
// and is reported, not asserted.
const sh = api.saveHash();
const sb = api.saveBuffer();
const sz = api.saveSize();
const nonZero = M.HEAPU8.subarray(sb, sb + sz).reduce((a, b) => a + (b ? 1 : 0), 0);
console.log('save media: size=' + sz + ' hash=' + sh + ' nonZeroBytes=' + nonZero);
