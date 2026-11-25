/**
 * End-to-end overflow recovery through the installed DSH runtime: real agent
 * loop, session, token meter and compaction-basic, with a fake `agy` that
 * behaves like 1.5.16 (only the first 192,000 bytes of a message are visible).
 *
 * No Google quota is used. On a packaged (ASAR) DSH the file re-runs itself
 * under the DSH executable, which can read the archive.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCliAdapter } from '../lib/antigravity-cli-adapter.js';
import { createAgy, MAX_AGY_PROMPT_BYTES } from '../lib/antigravity-cli-local.js';
import { installAgyOverflowRecovery } from '../lib/antigravity-cli-recovery.js';

const packages = [
	'llm', 'agent', 'agent-loop', 'tools', 'system-prompt', 'session-projection',
	'session', 'token-meter', 'tool-executor-native', 'compaction-basic'
];
const runtime = process.env.DSH_INSTALL_DIR;
const needsElectron = runtime?.includes('.asar') && !process.versions.electron;
const requireDsh = runtime ? createRequire(join(runtime, 'package.json')) : createRequire(import.meta.url);
const AGY_VISIBLE_BYTES = 192_000;

function missingPackage() {
	for (const name of ['@deepseek-ai/cordis', ...packages.map((name) => `@deepseek-ai/dsh-${name}`)]) {
		try {
			requireDsh.resolve(name);
		} catch (error) {
			if (error.code === 'MODULE_NOT_FOUND') return name;
			throw error;
		}
	}
}

const scenarios = [
	['a long history is compacted through the CLI itself and the current request is answered', false],
	['runtime context admitted after the request does not get the request compacted', true]
];

if (needsElectron && process.env.DSH_NODE_EXECUTABLE) {
	test('DSH overflow recovery (re-run under the DSH runtime)', () => {
		const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
		delete env.NODE_TEST_CONTEXT;
		const result = spawnSync(process.env.DSH_NODE_EXECUTABLE, ['--test', fileURLToPath(import.meta.url)], { env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
		if (result.error) throw result.error;
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	});
} else {
	const missing = missingPackage();
	for (const [scenario, trailingContext] of scenarios) {
		test(scenario, { skip: missing && `requires installed DSH packages (missing ${missing})`, timeout: 30_000 }, async (t) => {
			const dsh = (name) => requireDsh(`@deepseek-ai/dsh-${name}`);
			const { Context } = requireDsh('@deepseek-ai/cordis');
			const { LlmAdapter, LlmError, createUserMessage } = dsh('llm');
			const ctx = new Context();
			const fibers = [];
			t.after(async () => {
				for (const fiber of fibers.reverse()) await fiber.dispose();
			});
			const mount = async (name, config) => {
				const plugin = dsh(name);
				const fiber = ctx.plugin(plugin.default ?? plugin, config);
				fibers.push(fiber);
				await fiber;
			};
			for (const service of packages.filter((name) => !['agent-loop', 'compaction-basic'].includes(name))) await mount(service);
			await mount('agent-loop');
			// Stock defaults: no separate summarizer, so summaries go through the CLI route too.
			await mount('compaction-basic');

			const model = 'gemini-4-hydrogen-low';
			const sent = [];
			const summaries = [];
			const failures = [];
			const warnings = [];
			const facts = ['FACT=cobalt-river-7729', 'FACT=amber-gate-4410'];
			const current = 'CURRENT=ivory-kite-1349';
			const factsIn = (text) => [...new Set(text.match(/FACT=[a-z0-9-]+/gu) ?? [])];
			const transport = createAgy({ bin: 'fixture-cli', spawn(_bin, args) {
				const child = new EventEmitter();
				child.stdout = new PassThrough();
				child.stderr = new PassThrough();
				child.stdin = new PassThrough();
				child.kill = () => {};
				assert.ok(args.includes('--input-format'));
				const buffers = [];
				child.stdin.on('data', (chunk) => buffers.push(chunk));
				child.stdin.on('end', () => {
					const [{ text }] = JSON.parse(Buffer.concat(buffers).toString('utf8')).message.content;
					const bytes = Buffer.from(text, 'utf8');
					sent.push(bytes.length);
					// What agy 1.5.16 actually lets the model see.
					const visible = bytes.subarray(0, AGY_VISIBLE_BYTES).toString('utf8');
					let response;
					if (visible.includes('acting as a compaction engine')) {
						summaries.push({ bytes: bytes.length, current: text.includes(current) });
						response = `## Primary Request and Intent\n- ${factsIn(visible).join(' ') || '(none)'}`;
					} else if (visible.includes(current)) {
						response = `${factsIn(visible).join(' ')} ${current}`;
					} else if (visible.includes('Remember')) {
						response = 'Noted.';
					} else {
						response = 'ANSWERED_PREVIOUS_TOPIC';
					}
					child.stdout.end(`${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response } })}\n`);
					setImmediate(() => child.emit('close', 0));
				});
				return child;
			} });
			// The same adapter and AgyCliError→LlmError translation the mounted route uses.
			ctx.llm.registerAdapter(['antigravity'], Object.assign(new LlmAdapter(), createCliAdapter({
				list: async () => [{ id: model, name: 'Fixture (Low)' }],
				run: async (options) => {
					try {
						return await transport.run(options);
					} catch (cause) {
						options.signal?.throwIfAborted();
						failures.push(cause.code);
						throw new LlmError(cause.message, cause.code ?? 'ANTIGRAVITY_CLI');
					}
				},
				error: (message, code) => new LlmError(message, code)
			})));
			installAgyOverflowRecovery(ctx, { onWarn: (message) => warnings.push(message) });

			let runtimeContext = '';
			if (trailingContext) ctx.systemPrompt.context({ name: 'fixture-runtime-context', order: 1, text: () => runtimeContext });
			const agent = await ctx.agentLoop.create('fixture-overflow', { provider: 'antigravity', model });
			const lastTurnEnd = () => agent.session.snapshotEvents(0).findLast((event) => event.type === 'turn/end')?.data;
			async function turn(text) {
				let unlisten;
				const ended = new Promise((resolve) => {
					unlisten = ctx.on('agent/status', ({ agent: owner, status }) => {
						if (owner === agent && status === 'idle') resolve();
					});
				});
				const timer = setTimeout(() => agent.cancel({ kind: 'disposed' }), 20_000);
				try {
					agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }));
					await ended;
				} finally {
					clearTimeout(timer);
					unlisten();
				}
			}
			// Two seed turns of ~83 kB each: the history alone still fits, so the
			// overflow happens on the turn that carries the current request.
			for (const fact of facts) {
				await turn(`Remember ${fact}.\n${'registro detalhado de teste ó. '.repeat(2_600)}`);
				assert.equal(lastTurnEnd()?.reason?.kind, 'completed', JSON.stringify(lastTurnEnd()));
			}
			assert.equal(failures.length, 0, 'the seed history must fit before the current turn');
			if (trailingContext) runtimeContext = 'Runtime context contributed by the integration fixture.';
			const request = `Reply with every historical fact and ${current}.\n${'dados do pedido atual. '.repeat(700)}`;
			await turn(request);

			const reason = lastTurnEnd()?.reason;
			assert.equal(reason?.kind, 'completed', `turn failed: ${JSON.stringify(reason)}; warnings=${warnings.join(' | ')}; failures=${failures.join(',')}`);
			assert.ok(sent.every((bytes) => bytes <= MAX_AGY_PROMPT_BYTES), `a prompt above the ceiling reached the CLI: ${sent.join(', ')}`);
			assert.equal(failures.length, 1, `exactly one refusal, then a compacted retry: ${failures.join(',')}`);
			assert.ok(summaries.length >= 1, 'history was summarized');
			assert.ok(summaries.every((summary) => !summary.current), 'the current request entered a compaction region');
			const messages = agent.session.deriveMessages();
			assert.ok(messages.some((message) => message.source?.kind === 'user' && message.content[0]?.text === request), 'current request kept verbatim');
			assert.ok(messages.some((message) => message.source?.kind === 'compact-checkpoint'), 'a checkpoint replaced the old history');
			const reply = messages.at(-1);
			assert.equal(reply.role, 'assistant');
			const text = reply.content.map((block) => block.text).join('');
			assert.ok(text.endsWith(current), `answered: ${text}`);
			for (const fact of facts) assert.ok(text.includes(fact), `history fact ${fact} lost: ${text}`);
		});
	}
}
