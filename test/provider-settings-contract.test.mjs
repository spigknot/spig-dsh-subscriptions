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
