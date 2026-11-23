import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { buildPrompt, createAgy, parseModels, classifyFailure, parseUsage } from '../lib/antigravity-cli-local.js';

/** Minimal stand-in for a spawned CLI that records its argv and what it was fed on stdin. */
function fakeSpawn(behaviour) {
	const calls = [];
	const spawn = (bin, args, options) => {
		const call = { bin, args, options, stdin: '', settings: undefined };
		// The transport deletes its temp directory on return, so snapshot the policy here.
		const settingsAt = args.indexOf('--settings');
		if (settingsAt !== -1) {
			try {
				call.settings = JSON.parse(readFileSync(args[settingsAt + 1], 'utf8'));
			} catch {}
		}
		calls.push(call);
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.stdin = new PassThrough();
		child.stdin.on('data', (chunk) => { call.stdin += chunk; });
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

test('buildPrompt drops reasoning and tool-call blocks so a mid-session switch survives', () => {
	const prompt = buildPrompt({ messages: [
		{ role: 'user', content: [{ type: 'text', text: 'q' }] },
		{ role: 'assistant', content: [{ type: 'reasoning', text: 'private thinking' }, { type: 'tool-call', name: 'pwsh', arguments: '{"command":"ls"}' }, { type: 'text', text: 'a' }] },
		{ role: 'user', content: [{ type: 'reasoning', text: 'more thinking' }, { type: 'text', text: 'q2' }] }
	] });
	assert.equal(prompt, 'User: q\n\nAssistant: a\n\nUser: q2');
	assert.doesNotMatch(prompt, /thinking|ls/u);
});

test('buildPrompt keeps tool-result text and still refuses a nested image', () => {
	const prompt = buildPrompt({ messages: [
		{ role: 'user', content: [{ type: 'text', text: 'q' }] },
		{ role: 'assistant', content: [{ type: 'text', text: 'a' }] },
		{ role: 'tool', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] }
	] });
	assert.match(prompt, /Tool result: ok$/u);
	assert.throws(() => buildPrompt({ messages: [
		{ role: 'tool', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }, { type: 'image', attachment: {} }] }] }
	] }), /text-only/u);
});

test('the CLI is always called with the full-access policy and the chosen variant', async () => {
	const { spawn, calls } = fakeSpawn(({ stdout, child }) => {
		// `--output-format stream-json` on 1.5.14: one event per line, last one wins.
		stdout.end([
			'{"event":"init","conversation_id":"c1","init":{"model":"gemini-4-hydrogen-medium"}}',
			'{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}',
			JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'OK\n', usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6, thinking_tokens: 1 } } }),
			''
		].join('\n'));
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
	// The prompt rides stdin, never argv: argv has a hard size cap on Windows.
	assert.deepEqual(call.args.slice(0, 4), ['--input-format', 'stream-json', '--output-format', 'stream-json']);
	assert.ok(call.args.includes('gemini-4-hydrogen-medium'));
	assert.ok(!call.args.some((arg) => arg.includes('"hi"')), 'prompt must not appear in argv');
	const turn = JSON.parse(call.stdin.trim());
	assert.equal(turn.event, 'user');
	assert.deepEqual(turn.message.content, [{ type: 'text', text: 'hi' }]);
	// The allow policy is a file (argv has a size cap), passed by path.
	const settingsPath = call.args[call.args.indexOf('--settings') + 1];
	assert.match(settingsPath, /settings\.json$/u);
	assert.deepEqual(call.settings, { permissions: { allow: ['*'] } });
	// Without a workspace the CLI runs in its temp directory and adds nothing.
	assert.ok(!call.args.includes('--add-dir'), 'no workspace, no --add-dir');
	assert.ok(settingsPath.startsWith(call.options.cwd), 'policy lives next to the run cwd');
	assert.match(settingsPath, /settings\.json$/u);
});

test('a session workspace becomes the CLI cwd and is registered with --add-dir', async () => {
	const { spawn, calls } = fakeSpawn(({ stdout, child }) => {
		stdout.end('{"event":"result","result":{"status":"SUCCESS","response":"ok"}}\n');
		child.emit('close', 0);
	});
	const agy = createAgy({ spawn, bin: 'agy-under-test' });
	await agy.run({ model: 'gemini-4-hydrogen-medium', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], workspaceDir: 'D:\\Projetos\\SIG' });
	const [call] = calls;
	const at = call.args.indexOf('--add-dir');
	assert.notEqual(at, -1);
	assert.equal(call.args[at + 1], 'D:\\Projetos\\SIG');
	assert.equal(call.options.cwd, 'D:\\Projetos\\SIG');
	// The policy file still lives in the temp directory, not in the repo.
	const settingsPath = call.args[call.args.indexOf('--settings') + 1];
	assert.ok(!settingsPath.startsWith('D:\\Projetos\\SIG'), 'policy must not pollute the workspace');
	assert.deepEqual(call.settings, { permissions: { allow: ['*'] } });
});

test('a prompt far past the Windows command-line cap is still delivered', async () => {
	const longText = 'x'.repeat(5 * 1024 * 1024);
	let seen = '';
	const { spawn, calls } = fakeSpawn(({ stdout, child }) => {
		stdout.end('{"event":"result","result":{"status":"SUCCESS","response":"ok"}}\n');
		child.emit('close', 0);
	});
	const agy = createAgy({ spawn, bin: 'agy-under-test' });
	await agy.run({ model: 'gemini-4-hydrogen-medium', messages: [{ role: 'user', content: [{ type: 'text', text: longText }] }] });
	const [call] = calls;
	const argvBytes = call.args.reduce((total, arg) => total + Buffer.byteLength(arg) + 1, 0);
	assert.ok(argvBytes < 8192, `argv stayed small (${argvBytes} bytes)`);
	seen = JSON.parse(call.stdin.trim()).message.content[0].text;
	assert.equal(seen.length, longText.length);
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
