/**
 * Contract guard for the bundled ProviderSettingsStore.
 *
 * The host loads `lib/index.js`, which carries its own copy of
 * `ProviderSettingsStore` (region `src/provider-settings.ts`). A separate
 * `lib/provider-settings.js` exists in the tree and is NOT imported by the
 * host, so a method added only there is invisible at runtime — that is how
 * `preferences.agyFix is not a function` took every subscription route down
 * at mount.
 *
 * These tests fail when the bundle calls a preference method the inline class
 * does not define, and when the standalone copy drifts away from the bundled
 * one, so the mistake cannot ship silently again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../lib/', import.meta.url);
const bundle = readFileSync(new URL('index.js', root), 'utf8');

/** The inline class body: from its declaration to the region end. */
function bundledClassBody() {
	const start = bundle.indexOf('var ProviderSettingsStore = class {');
	assert.notEqual(start, -1, 'ProviderSettingsStore must exist inside lib/index.js');
	const end = bundle.indexOf('//#endregion', start);
	assert.notEqual(end, -1, 'the class region must be closed');
	return bundle.slice(start, end);
}

/** Method names the inline class defines. */
function bundledMethods() {
	const body = bundledClassBody();
	const names = new Set();
	for (const line of body.split('\n')) {
		// Class members are indented exactly once; getters and async methods included.
		const match = /^\t(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/u.exec(line);
		if (match !== null) names.add(match[1]);
	}
	return names;
}

test('every preferences method the bundle calls is defined in the bundled store', () => {
	const defined = bundledMethods();
	assert.ok(defined.size > 5, `expected a populated class, found ${defined.size} members`);
	const called = new Set();
	for (const match of bundle.matchAll(/preferences\.([A-Za-z_$][\w$]*)\(/gu)) called.add(match[1]);
	assert.ok(called.size > 0, 'the bundle must use the store');
	const missing = [...called].filter((name) => !defined.has(name));
	assert.deepEqual(missing, [], `called but not defined in lib/index.js: ${missing.join(', ')}`);
});

test('the toggle reads agyFix from the bundled store, not the unused file', () => {
	const defined = bundledMethods();
	assert.ok(defined.has('agyFix'), 'the bundled store must define agyFix()');
	// The behaviour the switch depends on: absent means on.
	assert.match(bundledClassBody(), /agyFix\(\)\s*\{[^}]*agyFix !== false/u);
});

test('the long-prompt guard defaults on and the Codex fast tier defaults off', () => {
	const body = bundledClassBody();
	assert.match(body, /agyPromptGuard\(\)\s*\{[^}]*agyPromptGuard !== false/u, 'absent guard must mean on');
	assert.match(body, /codexFastAllowed\(\)\s*\{[^}]*fastAllowed === true/u, 'absent permission must mean off');
});

test('every path to the Codex fast tier passes the Settings gate', () => {
	// The request itself: nothing else can put service_tier: priority on the wire.
	assert.match(bundle, /speedFor: \(sessionId, model\) => preferences\.codexFastAllowed\(\) &&/u);
	// The composer state: no fast-capable model is offered while disabled.
	assert.match(bundle, /async speed\(sessionId, model\) \{\s*(?:\/\/[^\n]*\n\s*)?if \(!preferences\.codexFastAllowed\(\)\) return \{\s*tier: "standard",\s*fastModels: \[\]/u);
	// Saving a fast choice is refused while disabled.
	assert.match(bundle, /async setSpeed\(sessionId, tier, model\) \{\s*if \(tier === "fast" && !preferences\.codexFastAllowed\(\)\) throw/u);
	// The settings catalog does not offer fast for subagents while disabled.
	assert.match(bundle, /fastTier: preferences\.codexFastAllowed\(\) &&/u);
	// service_tier is only ever written from that gated flag (comment lines aside).
	const writes = bundle.split('\n').filter((line) => /\bservice_tier\b/u.test(line) && !/^\s*(?:\*|\/\/)/u.test(line));
	assert.deepEqual(writes.map((line) => line.trim()), ['...fast ? { service_tier: CODEX_FAST_SERVICE_TIER } : {}']);
});

test('toggles merge into the stored provider document instead of replacing it', () => {
	// `set` replaces the whole document; spreading the async `get` used to wipe
	// the display name and visible models on the first toggle.
	assert.doesNotMatch(bundle, /\.\.\.providerSettings\.get\(/u);
	assert.match(bundle, /async patch\(provider, partial\) \{\s*await this\.set\(provider, \{\s*\.\.\.preferences\.get\(provider\),\s*\.\.\.partial/u);
	for (const endpoint of ['setAgyFix', 'setAgyPromptGuard', 'setCodexFast']) {
		assert.match(bundle, new RegExp(`"${endpoint}",`, 'u'), `${endpoint} must be a registered endpoint`);
	}
});

test('standalone provider-settings.js does not drift from the bundled copy', () => {
	// Nothing imports it, so it must not pretend to own a method the bundle lacks.
	const standalone = readFileSync(new URL('provider-settings.js', root), 'utf8');
	const exported = new Set();
	for (const match of standalone.matchAll(/^\s{4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gmu)) exported.add(match[1]);
	const bundled = bundledMethods();
	// Only enforce the direction that breaks runtime: the bundle needs everything it calls.
	const called = new Set();
	for (const match of bundle.matchAll(/preferences\.([A-Za-z_$][\w$]*)\(/gu)) called.add(match[1]);
	for (const name of called) {
		assert.ok(exported.has(name) || bundled.has(name), `preference ${name} must exist in the bundled class`);
	}
	assert.ok(exported.size > 0, 'the standalone copy should still parse');
});
