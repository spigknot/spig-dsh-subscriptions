/**
 * Official Antigravity CLI transport for the `antigravity` route.
 *
 * Nothing here talks to `cloudcode-pa.googleapis.com`: every call runs the
 * user's installed `agy` binary with whatever Google account that binary is
 * already signed in to. No token is copied, refreshed or stored, and no second
 * account is tried when the account is rate limited — a quota error surfaces as
 * a quota error.
 *
 * The CLI's own tools run with full permission: the prompt goes in over
 * stdin and the session workspace is added to the CLI, so the model reads,
 * writes and executes there. This runs outside the DSH sandbox and audit
 * trail by design; use it only for workspaces you trust.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Permission resources granted to the Antigravity engine: file reads and web
 * reads. Both were verified working on this host.
 */
const ALLOWED_ACTIONS = ['read_file', 'read_url'];

/**
 * Everything else denied, spelled per action.
 *
 * `command` matters most: the CLI's own `run_command` fails on this host with
 * `0xC0000142` (STATUS_DLL_INIT_FAILED) no matter how `agy` is spawned — it
 * returns "No output from the command" every time. When the model needs the
 * shell it retries the broken tool until the turn ends with an empty response
 * (that is the "resposta vazia" bug). An explicit denial answers immediately,
 * so the model stops instead of looping.
 */
const DENIED_ACTIONS = ['write_file', 'command', 'execute_url', 'download_url', 'mcp'];

/** Deny beats ask, and ask beats allow. */
const ROUTE_RULES = {
	permissions: {
		allow: ALLOWED_ACTIONS.map((action) => `${action}(*)`),
		deny: DENIED_ACTIONS.map((action) => `${action}(*)`)
	}
};

/** Stated up front so the model does not spend the turn rediscovering the denials. */
const ROUTE_NOTE = 'Route note: this Antigravity route cannot run shell commands or write files — those permissions are denied. Read the files you need and answer in text.';

/** The pre-fix behaviour: every CLI tool granted, and no note in the prompt. */
const PERMISSIVE_RULES = { permissions: { allow: ['*'] } };

/**
 * Route-fix state, on by default.
 *
 * The host owns persistence (Settings → Subscriptions) and keeps this flag in
 * step through {@link setAgyRouteFix}; the transport only reads it per call so
 * flipping the switch applies to the next request without a restart.
 */
let agyFixEnabled = true;

/** Turn the shell-free route fix on or off; the host persists the user's choice. */
export function setAgyRouteFix(enabled) {
	agyFixEnabled = enabled !== false;
}

/** Whether the shell-free route fix is currently on. */
export function agyRouteFix() {
	return agyFixEnabled;
}

const QUOTA = /RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED|quota (?:exceeded|reached|exhausted)|rate[ -]?limit|"?code"?\s*[:=]\s*"?429|status"?\s*[:=]\s*"?429|too many requests/i;
const MODEL_ROW = /^([a-z0-9][a-z0-9._-]*)\t(.+)$/u;

/** Quota families the subscription meters, as the CLI names them. */
const QUOTA_SCOPES = ['Gemini Models', 'Claude and GPT models', 'Gemini 4 Argon'];

/**
 * Parse the `/usage` payload into the window shape the panel renders.
 *
 * The CLI reports what is *left*, so a bucket of 0.94 becomes 6% used.
 */
export function parseUsage(payload) {
	const groups = payload?.command?.data?.groups;
	if (!Array.isArray(groups)) return [];
	const windows = [];
	for (const group of groups) {
		const scope = QUOTA_SCOPES.find((name) => name === group?.name);
		if (scope === undefined || !Array.isArray(group?.buckets)) continue;
		for (const bucket of group.buckets) {
			const fraction = typeof bucket?.remaining_fraction === 'number' ? bucket.remaining_fraction : Number.NaN;
			if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
			const label = `${bucket.window ?? ''} ${bucket.name ?? ''}`.toLowerCase();
			const kind = bucket.window === 'weekly' || /week/.test(label) ? 'weekly' : bucket.window === '5h' || /(?:5|five)[ _-]?h/.test(label) ? 'session' : undefined;
			if (kind === undefined) continue;
			const resetsAt = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : Number.NaN;
			windows.push({ kind, scope, usedPercent: (1 - fraction) * 100, ...Number.isFinite(resetsAt) ? { resetsAt } : {} });
		}
	}
	return windows;
}

/** A CLI failure carrying a stable code so DSH can classify it. */
export class AgyCliError extends Error {
	constructor(message, code = 'ANTIGRAVITY_CLI', extra = {}) {
		super(message);
		this.name = 'AgyCliError';
		this.code = code;
		Object.assign(this, extra);
	}
}

/** Parse `agy models` stdout; progress lines carry no tab and are skipped. */
export function parseModels(stdout) {
	const rows = [];
	for (const line of String(stdout ?? '').split(/\r?\n/u)) {
		const match = MODEL_ROW.exec(line.trim());
		if (match !== null) rows.push({ id: match[1], name: match[2].trim() });
	}
	return rows;
}

/** Flatten one tool-result block; only text can be carried by a text prompt. */
function toolResultText(block) {
	const content = Array.isArray(block?.content) ? block.content : typeof block?.content === 'string' ? [{ type: 'text', text: block.content }] : [];
	const texts = [];
	for (const part of content) {
		if (part?.type !== 'text') throw new AgyCliError(`Antigravity CLI route is text-only and cannot send a ${String(part?.type)} block inside a tool result`, 'UNSUPPORTED_CONTENT');
		texts.push(part.text);
	}
	return texts.join('\n');
}

/** Flatten a DSH request into one prompt; content a text prompt cannot carry fails closed. */
export function buildPrompt({ messages, system }) {
	const turns = [];
	for (const message of messages ?? []) {
		const blocks = Array.isArray(message?.content) ? message.content : typeof message?.content === 'string' ? [{ type: 'text', text: message.content }] : [];
		const texts = [];
		for (const block of blocks) {
			const type = block?.type;
			// Reasoning is model scaffolding and a tool call is an instruction to an
			// executor: neither is conversation content, so a history that carries them
			// (every mid-session model switch does) must not fail here.
			if (type === 'reasoning' || type === 'tool-call') continue;
			if (type === 'tool-result') {
				const text = toolResultText(block);
				if (text.length > 0) texts.push(text);
				continue;
			}
			if (type !== 'text') throw new AgyCliError(`Antigravity CLI route is text-only and cannot send a ${String(type)} block`, 'UNSUPPORTED_CONTENT');
			texts.push(block.text);
		}
		if (texts.length > 0) turns.push({ role: message.role, text: texts.join('\n') });
	}
	if (turns.length === 0) throw new AgyCliError('Antigravity CLI route received no text to send', 'EMPTY_REQUEST');
	const instructions = typeof system === 'string' ? system.trim() : '';
	// One user turn goes verbatim, so the CLI answers the prompt and not a transcript.
	if (turns.length === 1 && turns[0].role === 'user') {
		return instructions.length === 0 ? turns[0].text : `${instructions}\n\n${turns[0].text}`;
	}
	const label = (role) => (role === 'assistant' ? 'Assistant' : role === 'tool' ? 'Tool result' : 'User');
	const transcript = turns.map((turn) => `${label(turn.role)}: ${turn.text}`).join('\n\n');
	return instructions.length === 0 ? transcript : `System instructions:\n${instructions}\n\n${transcript}`;
}

/** Map the CLI's own diagnostic onto the codes DSH already understands. */
export function classifyFailure(output) {
	const detail = String(output ?? '');
	let payload;
	const embedded = /AGY_ERROR:\s*(\{[\s\S]*\})/u.exec(detail)?.[1];
	if (embedded !== undefined) {
		try {
			payload = JSON.parse(embedded);
		} catch {}
	}
	const message = payload?.short_error ?? payload?.message ?? detail.trim().split(/\r?\n/u).filter(Boolean).slice(-3).join(' ');
	if (QUOTA.test(detail)) return new AgyCliError(`Antigravity CLI quota exhausted: ${message}`, 'RATE_LIMIT', { status: 429 });
	if (/UNAUTHENTICATED|PERMISSION_DENIED|"?status"?\s*[:=]\s*401/u.test(detail)) return new AgyCliError(`Antigravity CLI is not signed in: ${message}`, 'AUTH');
	return new AgyCliError(`Antigravity CLI failed: ${message.length > 0 ? message : 'no diagnostic output'}`, payload?.status ?? 'ANTIGRAVITY_CLI');
}

function defaultBin() {
	const configured = process.env.DSH_AGY_BIN?.trim();
	return configured !== undefined && configured.length > 0 ? configured : 'agy';
}

/**
 * One bounded subprocess: it dies with the caller's signal and with a hard cap.
 * When `stdin` is given it is written to the child and the stream is closed.
 */
function runProcess(spawn, args, { signal, cwd, timeoutMs, stdin }) {
	return new Promise((resolve, reject) => {
		const child = spawn(args[0], args.slice(1), { cwd, shell: false, windowsHide: true, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		let settled = false;
		let timer;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
			fn(value);
		};
		const abort = () => {
			child.kill();
			finish(reject, new AgyCliError('Antigravity CLI call aborted', 'ABORTED'));
		};
		if (signal?.aborted === true) {
			abort();
			return;
		}
		signal?.addEventListener('abort', abort, { once: true });
		timer = setTimeout(() => {
			child.kill();
			finish(reject, new AgyCliError(`Antigravity CLI exceeded ${Math.round(timeoutMs / 1000)}s`, 'TIMEOUT'));
		}, timeoutMs);
		timer.unref?.();
		child.stdout?.setEncoding?.('utf8');
		child.stderr?.setEncoding?.('utf8');
		child.stdout?.on('data', (chunk) => { stdout += chunk; });
		child.stderr?.on('data', (chunk) => { stderr += chunk; });
		if (stdin !== undefined) {
			child.stdin?.on('error', () => void 0);
			child.stdin?.end(stdin);
		}
		child.on('error', (error) => finish(reject, new AgyCliError(`Antigravity CLI could not start (${args[0]}): ${error.message}`, 'NO_ADAPTER')));
		child.on('close', (code) => {
			if (code === 0) finish(resolve, { stdout, stderr });
			else finish(reject, classifyFailure(`${stderr}\n${stdout}`));
		});
	});
}

/** One NDJSON turn for `--input-format stream-json`. */
const streamTurn = (prompt) => JSON.stringify({ event: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } });

/** Flatten a `--output-format stream-json` transcript into the single result record. */
function parseStreamResult(stdout) {
	let result;
	for (const line of String(stdout ?? '').split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) continue;
		let event;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (event?.event === 'result' && event.result !== undefined) result = event.result;
	}
	if (result === undefined) throw new AgyCliError('Antigravity CLI returned no result event in its stream', 'EMPTY_RESPONSE');
	return result;
}

/**
 * Build the transport the `antigravity` adapter uses.
 * @param options - spawn implementation, binary name, time limits, and the
 *   route-fix reader; injectable for tests.
 */
export function createAgy({ spawn = nodeSpawn, bin = defaultBin(), timeoutMs = 60 * 60_000, modelsTimeoutMs = 60_000, fixOf = () => agyFixEnabled } = {}) {
	let listed;
	let listedAt = 0;
	async function listModels({ signal } = {}) {
		if (listed !== undefined && Date.now() - listedAt < 60_000) return listed;
		const { stdout } = await runProcess(spawn, [bin, 'models'], { signal, timeoutMs: modelsTimeoutMs });
		const rows = parseModels(stdout);
		if (rows.length === 0) {
			listed = undefined;
			throw new AgyCliError('Antigravity CLI listed no models; check that agy is signed in', 'NO_ADAPTER');
		}
		listed = rows;
		listedAt = Date.now();
		return rows;
	}
	async function run({ model, messages, system, signal, workspaceDir }) {
		// Read per call: the Settings switch applies to the next request, no restart.
		const fix = fixOf() !== false;
		const request = buildPrompt({ messages, system });
		const prompt = fix ? `${ROUTE_NOTE}\n\n${request}` : request;
		const tmp = await mkdtemp(join(tmpdir(), 'dsh-agy-'));
		try {
			// Neither big payload touches argv: Windows caps a command line near
			// 32 KB, and a long session overflows it (spawn ENAMETOOLONG) before the
			// model is ever reached. The prompt goes in as one NDJSON turn on stdin;
			// the policy goes in a file inside this call's temp directory.
			const settingsPath = join(tmp, 'settings.json');
			await writeFile(settingsPath, JSON.stringify(fix ? ROUTE_RULES : PERMISSIVE_RULES), 'utf8');
			const args = [bin, '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model, '--settings', settingsPath];
			// The CLI works where the session works: with a workspace, run there
			// and register it, so relative paths resolve to the repo instead of
			// the temp directory. Without one, fall back to the temp directory.
			let cwd = tmp;
			if (typeof workspaceDir === 'string' && workspaceDir.length > 0) {
				args.push('--add-dir', workspaceDir);
				cwd = workspaceDir;
			}
			const { stdout } = await runProcess(spawn, args, { signal, cwd, timeoutMs, stdin: `${streamTurn(prompt)}\n` });
			const payload = parseStreamResult(stdout);
			if (payload.status !== undefined && payload.status !== 'SUCCESS') {
				throw new AgyCliError(`Antigravity CLI reported ${payload.status}: ${payload.response ?? ''}`, 'ANTIGRAVITY_CLI');
			}
			const text = typeof payload.response === 'string' ? payload.response : '';
			if (text.trim().length === 0) throw new AgyCliError('Antigravity CLI returned an empty answer', 'EMPTY_RESPONSE');
			const usage = payload.usage;
			return {
				text,
				...(usage === undefined ? {} : { usage: {
					inputTokens: usage.input_tokens ?? 0,
					outputTokens: usage.output_tokens ?? 0,
					...(usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
					...(usage.cache_read_tokens ? { cacheReadTokens: usage.cache_read_tokens } : {}),
					...(usage.thinking_tokens ? { reasoningTokens: usage.thinking_tokens } : {})
				} })
			};
		} finally {
			await rm(tmp, { recursive: true, force: true }).catch(() => {});
		}
	}
	async function usage({ signal } = {}) {
		const { stdout } = await runProcess(spawn, [bin, '-p', '/usage', '--output-format', 'json'], { signal, timeoutMs: modelsTimeoutMs });
		let payload;
		try {
			payload = JSON.parse(stdout.trim());
		} catch {
			throw new AgyCliError('Antigravity CLI returned no parsable quota report', 'EMPTY_RESPONSE');
		}
		const windows = parseUsage(payload);
		if (windows.length === 0) throw new AgyCliError('Antigravity CLI reported no quota windows', 'EMPTY_RESPONSE');
		return windows;
	}

	async function version({ signal } = {}) {
		const { stdout, stderr } = await runProcess(spawn, [bin, '--version'], { signal, timeoutMs: modelsTimeoutMs });
		const line = `${stdout}\n${stderr}`.split(/\r?\n/u).map((part) => part.trim()).find((part) => /^\d+\.\d+/u.test(part));
		if (line === undefined) throw new AgyCliError('Antigravity CLI reported no version', 'EMPTY_RESPONSE');
		return line;
	}

	return { listModels, run, usage, version };
}

let shared;
const transport = () => (shared ??= createAgy());

/** The transport calls the adapter uses; created on first call. */
export const listAgyModels = (options) => transport().listModels(options);
export const runAgy = (options) => transport().run(options);
export const readAgyUsage = (options) => transport().usage(options);

/** CLI version, resolved once: it only changes when the user updates the CLI. */
let versionCache;
export const readAgyVersion = async (options) => (versionCache ??= await transport().version(options).catch(() => undefined));
