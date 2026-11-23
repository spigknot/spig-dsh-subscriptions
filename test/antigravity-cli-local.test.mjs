import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { buildPrompt, createAgy, parseModels, classifyFailure, parseUsage } from '../lib/antigravity-cli-local.js';

/** Minimal stand-in for a spawned CLI that records its argv. */
function fakeSpawn(behaviour) {
	const calls = [];
	const spawn = (bin, args, options) => {
		calls.push({ bin, args, options });
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = () => {};
		setImmediate(() => behaviour({ args, stdout: child.stdout, stderr: child.stderr, child }));
		return child;
	};
	return { spawn, calls };
}

const modelsOutput = [
	'Fetching available models...',
	'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
	'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
	''
].join('\n');

test('parseModels keeps only <slug>\t<label> rows', () => {
	assert.deepEqual(parseModels(modelsOutput), [
		{ id: 'gemini-4-hydrogen-medium', name: 'Gemini 4 Hydrogen (Medium)' },
		{ id: 'gemini-4-hydrogen-xhigh', name: 'Gemini 4 Hydrogen (XHigh)' }
	]);
});

test('buildPrompt sends one user turn verbatim and refuses non-text blocks', () => {
	assert.equal(buildPrompt({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }), 'hi');
	assert.match(buildPrompt({ messages: [
		{ role: 'user', content: [{ type: 'text', text: 'q' }] },
		{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }
	] }), /^User: q\n\nAssistant: a$/);
	assert.throws(() => buildPrompt({ messages: [{ role: 'user', content: [{ type: 'image', attachment: {} }] }] }), /text-only/u);
});

test('the CLI is always called with the tool-deny policy and the chosen variant', async () => {
	const { spawn, calls } = fakeSpawn(({ stdout, child }) => {
		stdout.end(JSON.stringify({ status: 'SUCCESS', response: 'OK\n', usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6, thinking_tokens: 1 } }));
		child.emit('close', 0);
	});
	const agy = createAgy({ spawn, bin: 'agy-under-test' });
	const result = await agy.run({ model: 'gemini-4-hydrogen-medium', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
	assert.equal(result.text, 'OK\n');
	assert.equal(result.usage.totalTokens, 6);
	assert.equal(result.usage.reasoningTokens, 1);
	const [call] = calls;
	assert.equal(call.bin, 'agy-under-test');
	assert.equal(call.options.shell, false);
	assert.deepEqual(call.args.slice(0, 1), ['-p']);
	assert.ok(call.args.includes('gemini-4-hydrogen-medium'));
	const deny = JSON.parse(call.args[call.args.indexOf('--settings') + 1]);
	// Every action the permission engine evaluates, or a tool is left ungated.
	assert.deepEqual(deny.permissions.deny, [
		'read_file(*)',
		'write_file(*)',
		'read_url(*)',
		'execute_url(*)',
		'download_url(*)',
		'command(*)',
		'mcp(*)'
	]);
});

test('the quota report becomes one window per bucket, remaining turned into used', () => {
	// Shape captured from `agy -p /usage --output-format json` on 1.5.14.
	const payload = { command: { name: 'usage', data: { groups: [
		{ name: 'Gemini Models', buckets: [
			{ id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.9678482413291931, reset_time: '2026-11-29T19:31:40Z' },
			{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.9442857503890991, reset_time: '2026-11-23T05:31:40Z' }
		] },
		{ name: 'Claude and GPT models', buckets: [
			{ id: '3p-weekly', window: 'weekly', remaining_fraction: 0.9427, reset_time: '2026-11-29T21:42:20Z' }
		] },
		{ name: 'Unmetered', buckets: [{ id: 'x', window: 'weekly', remaining_fraction: 0.5 }] }
	] } } };
	const windows = parseUsage(payload);
	assert.deepEqual(windows.map((w) => `${w.scope}/${w.kind}`), [
		'Gemini Models/weekly',
		'Gemini Models/session',
		'Claude and GPT models/weekly'
	]);
	assert.ok(Math.abs(windows[0].usedPercent - 3.215175867080689) < 1e-9);
	assert.equal(windows[1].resetsAt, Date.parse('2026-11-23T05:31:40Z'));
	assert.deepEqual(parseUsage({}), []);
});

test('a quota failure surfaces once, as RATE_LIMIT, without another attempt', async () => {
	let attempts = 0;
	const { spawn } = fakeSpawn(({ stderr, child }) => {
		attempts += 1;
		stderr.end('AGY_ERROR: {"short_error":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED","retryable":false}');
		child.emit('close', 1);
	});
	const agy = createAgy({ spawn, bin: 'agy-under-test' });
	await assert.rejects(
		agy.run({ model: 'gemini-4-hydrogen-medium', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
		(error) => error.code === 'RATE_LIMIT' && error.status === 429
	);
	assert.equal(attempts, 1);
});

test('a signed-out CLI is reported as AUTH, not as a model failure', () => {
	assert.equal(classifyFailure('UNAUTHENTICATED: please sign in').code, 'AUTH');
	assert.equal(classifyFailure('boom').code, 'ANTIGRAVITY_CLI');
});

test('listing models runs the CLI once and then serves the cached catalog', async () => {
	let runs = 0;
	const { spawn } = fakeSpawn(({ stdout, child }) => {
		runs += 1;
		stdout.end('gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)\n');
		child.emit('close', 0);
	});
	const agy = createAgy({ spawn, bin: 'agy-under-test' });
	assert.equal((await agy.listModels()).length, 1);
	assert.equal((await agy.listModels()).length, 1);
	assert.equal(runs, 1);
});
