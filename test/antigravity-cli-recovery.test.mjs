import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeTailStart, chooseCompactionRange, compactHistoryForAgy, installAgyOverflowRecovery, surfaceBytes } from '../lib/antigravity-cli-recovery.js';
import { AGY_PROMPT_TOO_LARGE, MAX_AGY_PROMPT_BYTES, estimateMessageBytes } from '../lib/antigravity-cli-local.js';

/** A session double with a positional surface, as compaction-basic sees it. */
function fakeSession(specs) {
	const log = [];
	const nodes = [];
	const add = (type, message) => {
		const seq = log.length;
		log.push({ seq, type, message });
		nodes.push(seq);
		return seq;
	};
	for (const [type, message] of specs) add(type, message);
	const surface = { nodes, replaceGeneration: 0 };
	return {
		surface,
		eventAt: (seq) => log[seq],
		deriveEventMessage: (event) => event.message,
		replace(start, end, message) {
			const from = nodes.indexOf(start);
			const to = nodes.indexOf(end);
			const seq = log.length;
			log.push({ seq, type: 'user/message', message });
			nodes.splice(from, to - from + 1, seq);
			surface.replaceGeneration += 1;
		}
	};
}

const user = (text, kind = 'user') => ['user/message', { role: 'user', source: { kind }, content: text }];
const assistant = (text) => ['assistant/message', { role: 'assistant', content: text }];
const system = (text) => ['system/message', { role: 'system', source: { kind: 'system-prompt' }, content: text }];
const big = (label) => `${label} ${'conteúdo histórico ó. '.repeat(4_000)}`; // ~92 kB

/** Compaction double that records each summarized span and its estimated prompt. */
function fakeCompaction(session) {
	const spans = [];
	return {
		spans,
		async compactRegion(start, end) {
			const nodes = session.surface.nodes;
			const messages = nodes.slice(nodes.indexOf(start), nodes.indexOf(end) + 1).map((seq) => session.eventAt(seq).message);
			const head = session.eventAt(nodes[0]).message.role === 'system' ? [session.eventAt(nodes[0]).message] : [];
			spans.push({ seqs: nodes.slice(nodes.indexOf(start), nodes.indexOf(end) + 1), bytes: estimateMessageBytes([...head, ...messages]) });
			session.replace(start, end, { role: 'user', source: { kind: 'compact-checkpoint' }, content: `<compacted-summary>${spans.length}</compacted-summary>` });
		}
	};
}

test('the active tail starts after the last assistant answer', () => {
	const session = fakeSession([system('S'), user('q1'), assistant('a1'), user('NOW'), user('ctx', 'runtime-context')]);
	const entries = session.surface.nodes.map((seq) => ({ seq, event: session.eventAt(seq), message: session.eventAt(seq).message }));
	assert.equal(activeTailStart(entries), 3);
});

test('a 450 kB history is summarized oldest-first in spans that each fit the route, never touching the request', async () => {
	const session = fakeSession([
		system('Follow the rules.'),
		user(big('R1')), assistant(big('A1')), user(big('R2')), assistant(big('A2')), user(big('R3')),
		assistant('short answer'),
		user('CURRENT REQUEST'), user('runtime facts', 'runtime-context'), user('time', 'time-context')
	]);
	const tail = session.surface.nodes.slice(-3);
	const entries = () => session.surface.nodes.map((seq) => ({ seq, event: session.eventAt(seq), message: session.eventAt(seq).message }));
	assert.ok(surfaceBytes(entries()) > 450_000);
	const compaction = fakeCompaction(session);
	const rounds = await compactHistoryForAgy({ agent: { session }, compaction });
	assert.ok(rounds >= 2, `needed several summaries, got ${rounds}`);
	for (const span of compaction.spans) {
		assert.ok(span.bytes < MAX_AGY_PROMPT_BYTES - 8_000, `a summarization prompt would exceed the route: ${span.bytes}`);
		assert.ok(span.seqs.every((seq) => !tail.includes(seq)), 'the current request entered a summary');
	}
	assert.deepEqual(session.surface.nodes.slice(-3), tail, 'request and its context kept verbatim and in place');
	assert.ok(surfaceBytes(entries()) <= MAX_AGY_PROMPT_BYTES);
});

test('a span never ends between a tool call and its result', () => {
	const session = fakeSession([
		user('q'),
		['assistant/message', { role: 'assistant', content: [{ type: 'tool-call', id: 't', name: 'ls', arguments: '{}' }] }],
		['tool/result', { role: 'tool', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'a.txt' }] }] }],
		assistant('done'),
		user('NOW')
	]);
	const entries = session.surface.nodes.map((seq) => ({ seq, event: session.eventAt(seq), message: session.eventAt(seq).message }));
	const range = chooseCompactionRange(entries, 180_000);
	assert.equal(range.end, 3, 'ends after the result and the answer, not after the call');
	// With room only for the call, no span may end there.
	const tight = chooseCompactionRange(entries, estimateMessageBytes([entries[0].message]) + 8_000 + 200);
	assert.notEqual(tight?.end, 1);
});

test('a single message too large to summarize fails instead of sending or cutting it', async () => {
	const session = fakeSession([user('x'.repeat(200_000)), assistant('a'), user('NOW')]);
	await assert.rejects(compactHistoryForAgy({ agent: { session }, compaction: fakeCompaction(session) }), /no history span small enough/u);
});

test('the listener handles only this route and this code, once per step', async () => {
	const listeners = [];
	const ctx = { on: (name, fn, options) => { listeners.push({ name, fn, options }); return () => {}; }, get: () => undefined };
	installAgyOverflowRecovery(ctx);
	const [{ name, fn, options }] = listeners;
	assert.equal(name, 'agent/request-error');
	assert.deepEqual(options, { prepend: true });
	const next = async () => 'next';
	const agent = { session: fakeSession([user('NOW')]) };
	assert.equal(await fn({ agent, turn: 1, step: 1, provider: 'claude', failure: { code: AGY_PROMPT_TOO_LARGE } }, next), 'next');
	assert.equal(await fn({ agent, turn: 1, step: 1, provider: 'antigravity', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } }, next), 'next');
	// Ours, but no compaction service: terminal, and never delegated to stock recovery.
	assert.equal(await fn({ agent, turn: 1, step: 1, provider: 'antigravity', failure: { code: AGY_PROMPT_TOO_LARGE } }, next), undefined);
});

test('the listener compacts with the agent\'s own compaction service and retries', async () => {
	const session = fakeSession([user(big('R1')), assistant(big('A1')), user(big('R2')), assistant('a'), user('NOW')]);
	const compaction = fakeCompaction(session);
	let handler;
	const ctx = {
		on: (_name, fn) => { handler = fn; return () => {}; },
		get: (name) => (name === 'agentPresets' ? { serviceFor: (_agent, service) => (service === 'compaction' ? compaction : undefined) } : undefined)
	};
	installAgyOverflowRecovery(ctx);
	const agent = { session, ctx: {} };
	const payload = { agent, turn: 3, step: 1, provider: 'antigravity', failure: { code: AGY_PROMPT_TOO_LARGE }, signal: new AbortController().signal };
	assert.deepEqual(await handler(payload, async () => 'next'), { kind: 'retry' });
	assert.ok(compaction.spans.length >= 1);
	// A second refusal in the same step is terminal: no compaction loop.
	assert.equal(await handler(payload, async () => 'next'), undefined);
});
