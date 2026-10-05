/* Drives the real page in headless Chrome over the DevTools protocol.
 *
 * Deliberately exercises the shipping path, not a test-only shortcut: the ROM
 * is handed to the actual <input type=file> via DOM.setFileInputFiles, so the
 * picker, the FileReader path, the IndexedDB cache and the boot sequence are
 * all the ones a user gets.
 *
 * Audio: asserted off. The page creates no AudioContext unless the mute button
 * is clicked, and this harness never clicks it, then checks that none exists.
 *
 *   node browser-check.mjs <url> <rom path> [outdir]
 */

import { mkdirSync, writeFileSync } from 'node:fs';

const url = process.argv[2];
const romPath = process.argv[3];
const outDir = process.argv[4] || null;
if (!url || !romPath) {
	console.error('usage: node browser-check.mjs <url> <rom> [outdir]');
	process.exit(2);
}
if (outDir) {
	mkdirSync(outDir, { recursive: true });
}

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok: !!ok, detail });
	console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

/* --------------------------------------------------------------- CDP client */

const endpoint = process.env.CDP_URL;
if (!endpoint) {
	console.error('CDP_URL not set (the websocket URL from /json/version)');
	process.exit(2);
}

const ws = new WebSocket(endpoint);
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];

ws.addEventListener('message', (ev) => {
	const msg = JSON.parse(ev.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		if (msg.error) {
			reject(new Error(msg.error.message));
		} else {
			resolve(msg.result);
		}
		return;
	}
	if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
		consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
	}
	if (msg.method === 'Runtime.exceptionThrown') {
		pageErrors.push(msg.params.exceptionDetails.text + ' ' +
			(msg.params.exceptionDetails.exception?.description || ''));
	}
});

function send(method, params = {}) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
}

await new Promise((res, rej) => {
	ws.addEventListener('open', res);
	ws.addEventListener('error', () => rej(new Error('could not connect to Chrome at ' + endpoint)));
});

async function evalJs(expr, awaitPromise = false) {
	const r = await send('Runtime.evaluate', {
		expression: expr, returnByValue: true, awaitPromise
	});
	if (r.exceptionDetails) {
		throw new Error(r.exceptionDetails.text + ' ' +
			(r.exceptionDetails.exception?.description || '') + ' while evaluating: ' + expr);
	}
	return r.result.value;
}

async function waitFor(expr, timeoutMs, label) {
	const t0 = Date.now();
	for (;;) {
		let v = false;
		try { v = await evalJs(expr); } catch { /* page may still be loading */ }
		if (v) { return true; }
		if (Date.now() - t0 > timeoutMs) {
			throw new Error('timed out waiting for ' + (label || expr));
		}
		await new Promise((r) => setTimeout(r, 100));
	}
}

async function shot(tag) {
	if (!outDir) { return; }
	const r = await send('Page.captureScreenshot', { format: 'png' });
	writeFileSync(`${outDir}/${tag}.png`, Buffer.from(r.data, 'base64'));
}

/* ------------------------------------------------------------------ the run */

try {
	await send('Page.enable');
	await send('Runtime.enable');
	await send('DOM.enable');

	// Start from a clean profile state so "persists across reload" means
	// something: anything found later was written by this run.
	await send('Page.navigate', { url });
	await waitFor('document.readyState === "complete"', 20000, 'page load');
	await evalJs('indexedDB.deleteDatabase("pokeruby-web"), true');
	await send('Page.navigate', { url });
	await waitFor('document.readyState === "complete"', 20000, 'reload after db wipe');

	await waitFor('!!(window.__vj && window.__vj.ready)', 30000, 'wasm core init');
	check('core initialises in browser', true);

	// Hand the ROM to the real file input.
	const doc = await send('DOM.getDocument');
	const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#rom-file' });
	if (!node.nodeId) { throw new Error('#rom-file not found in the page'); }
	await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [romPath] });

	await waitFor('!!(window.__vj && window.__vj.running)', 30000, 'ROM to boot');
	const title = await evalJs('window.__vj.title()');
	const rev = await evalJs('window.__vj.revision()');
	check('ROM accepted through the file picker', /POKEMON (RUBY|SAPP)/.test(title),
		'title="' + title + '" headerRevision=' + rev);
	check('ROM is revision 2 (game v1.2)', rev === 2, 'header byte 0xBC = ' + rev);

	// No network request may carry the ROM. The page is static; assert that the
	// only requests are its own two files.
	const reqs = await evalJs(
		'JSON.stringify(performance.getEntriesByType("resource").map(e => e.name))');
	const bad = JSON.parse(reqs).filter((u) => !/pokeruby\.(js|wasm)$/.test(u));
	check('no network request other than the page\'s own js/wasm', bad.length === 0,
		bad.length ? bad.join(', ') : JSON.parse(reqs).length + ' requests, all local assets');

	await shot('01-booted');

	// Play past the intro, muted. Pump frames rather than sleeping: headless
	// rAF pacing is not something to build a test on.
	await evalJs(`(async () => {
		const KEY = { A:1, START:8 };
		for (let i = 0; i < 46; i++) {
			window.__vj.pump(20, 0);
			window.__vj.pump(8, i % 2 ? KEY.START : KEY.A);
			window.__vj.pump(12, 0);
		}
		return true;
	})()`, true);

	const frames = await evalJs('window.__vj.frames');
	const luma = await evalJs('window.__vj.meanLuma()');
	check('ran frames in the browser', frames > 1500, frames + ' frames');
	check('canvas is not black after the intro', luma > 1.0, 'mean luma ' + Number(luma).toFixed(2));
	await shot('02-after-intro');

	// The frame must keep changing: a frozen non-black picture would pass a
	// luma check while the core was actually wedged.
	const h1 = await evalJs('window.__vj.frameHash()');
	await evalJs('window.__vj.pump(180, 1)');
	const h2 = await evalJs('window.__vj.frameHash()');
	check('picture advances (core not wedged)', h1 !== h2, 'hash ' + h1 + ' -> ' + h2);
	await shot('03-advanced');

	// Audio must be off and no AudioContext may exist.
	const audioOn = await evalJs('window.__vj.audioOn()');
	const acExists = await evalJs('window.__vj.audioContextExists()');
	check('audio is muted (no AudioContext created)', audioOn === false && acExists === false,
		'audioOn=' + audioOn + ' audioContext=' + acExists);

	// Cartridge save persistence across a real reload.
	const poked = await evalJs('window.__vj.pokeSave(0x5A)', true);
	const before = await evalJs('JSON.stringify(window.__vj.readSaveBytes(16))');
	await evalJs('window.__vj.flushSave()', true);

	await send('Page.navigate', { url });
	await waitFor('document.readyState === "complete"', 20000, 'reload');
	await waitFor('!!(window.__vj && window.__vj.ready)', 30000, 'core init after reload');
	// The ROM is cached locally, so the page should resume without the picker.
	await waitFor('!!(window.__vj && window.__vj.running)', 30000, 'resume from cached ROM');
	check('ROM resumes from local cache after reload (no re-pick)', true);

	const after = await evalJs('JSON.stringify(window.__vj.readSaveBytes(16))');
	check('cartridge save survives reload', before === after,
		'first 16 bytes ' + before + ' -> ' + after);
	await shot('04-after-reload');

	// Savestate round trip across the same reload.
	await evalJs('window.__vj.pump(120, 0)');
	const sHash = await evalJs('window.__vj.frameHash()');
	await evalJs('window.__vj.saveState()', true);
	await evalJs('window.__vj.pump(300, 1)');
	const divergedHash = await evalJs('window.__vj.frameHash()');
	const loadedOk = await evalJs('window.__vj.loadState()', true);
	await evalJs('window.__vj.pump(1, 0)');
	const restoredHash = await evalJs('window.__vj.frameHash()');
	check('savestate round trip', loadedOk && divergedHash !== sHash && restoredHash !== divergedHash,
		'snapshot=' + sHash + ' diverged=' + divergedHash + ' restored=' + restoredHash);

	check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | ') || 'none');
	check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | ') || 'none');

} catch (e) {
	check('harness completed', false, e.message);
	if (pageErrors.length) { console.log('page errors: ' + pageErrors.join(' | ')); }
} finally {
	const failed = results.filter((r) => !r.ok);
	console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
	if (outDir) {
		writeFileSync(outDir + '/results.json', JSON.stringify(results, null, 2));
	}
	ws.close();
	process.exit(failed.length ? 1 : 0);
}
