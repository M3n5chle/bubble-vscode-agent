import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import * as vscode from 'vscode';
import { getFileReadStatus } from '../agent/planChange.js';
import { AgentCancelledError, AgentStepLimitError, MAX_REQUEST_BYTES, REPEATED_CALL_NOTICE, RequestTooLargeError, runReadOnlyAgent, toolCallKey } from '../agent/readOnlyAgent.js';
import type { AgentResult, ConversationTurn } from '../agent/readOnlyAgent.js';
import { ChatModeLimitError } from '../chat/chatSession.js';
import { MAX_SEARCH_RESULT_BYTES } from '../tools/readTools.js';
import { runExclusiveOperation } from '../agent/operationLock.js';
import { describeActivity } from '../chat/activityText.js';
import { liveStatusLine, summarizeRun } from '../chat/runSummary.js';
import type { ToolActivity } from '../agent/readOnlyAgent.js';
import { CHAT_MODES, ChatSession, type AgentRunner, type ChatState } from '../chat/chatSession.js';
import {
	getChatHtml,
	getChatWorkspaceName,
	handleChatMessage,
	runChatPlan,
	runChatTools
} from '../chat/chatView.js';

const ok = (answer: string): AgentResult => ({
	answer,
	evidence: [{ tool: 'read_file', target: 'a.ts', success: true }],
	omitted: 0
});

class WebviewElement {
	readonly children: WebviewElement[] = [];
	readonly listeners = new Map<string, (event?: {
		data?: unknown;
		preventDefault?: () => void;
	}) => unknown>();
	readonly attributes = new Map<string, string>();
	className = '';
	type = '';
	disabled = false;
	open = false;
	value = '';
	selectionStart = 0;
	selectionEnd = 0;
	scrollHeight = 0;
	scrollTop = 0;
	clientHeight = 0;
	private content = '';

	constructor(readonly tagName: string) {}

	get textContent(): string {
		return this.content;
	}

	set textContent(value: string) {
		this.content = value;
		this.children.length = 0;
	}

	set innerHTML(_value: string) {
		throw new Error('The webview must not render HTML strings.');
	}

	appendChild(child: WebviewElement): void {
		this.children.push(child);
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	setRangeText(text: string, start: number, end: number, selectionMode: string): void {
		this.value = this.value.slice(0, start) + text + this.value.slice(end);
		const cursor = start + text.length;
		this.selectionStart = selectionMode === 'start' ? start : cursor;
		this.selectionEnd = selectionMode === 'select' ? cursor : this.selectionStart;
	}

	focus(): void {}

	getAttribute(name: string): string | undefined {
		return this.attributes.get(name);
	}

	addEventListener(name: string, listener: (event?: {
		data?: unknown;
		preventDefault?: () => void;
	}) => unknown): void {
		this.listeners.set(name, listener);
	}

	querySelectorAll(selector: string): WebviewElement[] {
		const matches: WebviewElement[] = [];
		for (const child of this.children) {
			if (selector.startsWith('details.')
				&& child.tagName === 'details'
				&& child.className.split(' ').includes(selector.slice('details.'.length))) {
				matches.push(child);
			}
			matches.push(...child.querySelectorAll(selector));
		}
		return matches;
	}

	findAll(tagName: string): WebviewElement[] {
		const matches: WebviewElement[] = [];
		for (const child of this.children) {
			if (child.tagName === tagName) { matches.push(child); }
			matches.push(...child.findAll(tagName));
		}
		return matches;
	}
}

function renderWebview(
	html: string,
	writeText: (text: string) => Promise<void>,
	readText: () => Promise<string> = async () => ''
) {
	const elements = new Map<string, WebviewElement>();
	for (const id of ['log', 'workspace-name', 'input', 'mode-select', 'send', 'system-check', 'paste', 'paste-feedback', 'composer', 'reset', 'end']) {
		elements.set(id, new WebviewElement(
			id === 'mode-select' ? 'select' : id === 'composer' ? 'form' : 'div'
		));
	}
	elements.get('workspace-name')!.textContent = 'Kein Workspace geöffnet';
	elements.get('mode-select')!.value = 'question';
	const postedMessages: unknown[] = [];
	const document = {
		getElementById: (id: string) => elements.get(id)!,
		createElement: (tagName: string) => new WebviewElement(tagName),
		createElementNS: (_namespace: string, tagName: string) => new WebviewElement(tagName)
	};
	const window = new WebviewElement('window');
	const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
	assert.ok(script);
	runInNewContext(script, {
		document,
		window,
		navigator: { clipboard: { writeText, readText } },
		acquireVsCodeApi: () => ({ postMessage: (message: unknown) => postedMessages.push(message) })
	});
	return {
		log: elements.get('log')!,
		workspaceName: elements.get('workspace-name')!,
		input: elements.get('input')!,
		modeSelect: elements.get('mode-select')!,
		submit: () => elements.get('composer')!.listeners.get('submit')?.({
			preventDefault: () => {}
		}),
		paste: elements.get('paste')!,
		pasteFeedback: elements.get('paste-feedback')!,
		postedMessages,
		sendState: (state: unknown, name?: string) => window.listeners.get('message')?.({
			data: { type: 'state', state, workspaceName: name }
		}),
		sendWorkspace: (name: string) => window.listeners.get('message')?.({
			data: { type: 'workspace', name }
		})
	};
}

suite('Bubble Chat', () => {
	test('Frage und Folgefrage: Antwort, Werkzeugprotokoll und Verlauf', async () => {
		const seen: ConversationTurn[][] = [];
		const statuses: string[] = [];
		const runner: AgentRunner = async (q, history, onStatus) => {
			seen.push(history.slice());
			onStatus('Lesewerkzeug: read_file');
			return ok(`Antwort auf ${q}`);
		};
		const session = new ChatSession(runner, s => statuses.push(s.status));

		await session.ask('  Erste? ');
		await session.ask('Zweite?');

		assert.strictEqual(seen[0].length, 0);
		assert.deepStrictEqual(seen[1].map(t => t.question), ['Erste?']);
		const kinds = session.state.entries.map(e => e.kind);
		assert.deepStrictEqual(kinds, ['user', 'answer', 'evidence', 'user', 'answer', 'evidence']);
		assert.ok(session.state.entries[2].text.includes('read_file a.ts: erfolgreich'));
		assert.ok(statuses.includes('Analyse wird vorbereitet ...'));
		assert.ok(statuses.includes('Lesewerkzeug: read_file'));
		assert.strictEqual(session.state.busy, false);
		assert.strictEqual(session.state.status, '');
	});

	test('Dropdown übermittelt den ausgewählten Modus samt Eingabe', async () => {
		const { modeSelect, input, submit, postedMessages } = renderWebview(
			getChatHtml('mode-submit'),
			async () => {}
		);
		modeSelect.value = 'tools';
		input.value = 'Suche nach Aufrufen von render() und lies den Trefferbereich.';
		submit();

		assert.deepStrictEqual(JSON.parse(JSON.stringify(postedMessages)), [{
			type: 'submit',
			mode: 'tools',
			text: 'Suche nach Aufrufen von render() und lies den Trefferbereich.'
		}]);
		const html = getChatHtml('mode-submit');
		for (const label of Object.values(CHAT_MODES)) {
			assert.ok(html.includes(label));
		}
		assert.ok(html.includes('id="mode-select"'));
		assert.ok(html.includes('Dateien werden nur nach ausdrücklicher Auswahl und Bestätigung übermittelt.'));
	});

	test('Werkzeugmodus zeigt vorab gelesene und modellaufgerufene Aktivitäten ohne Dateiinhalte', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-chat-tools-mode-'));
		const secretContent = 'PRIVATE_FILE_CONTENT_MUST_NOT_APPEAR_IN_ACTIVITY';
		fs.writeFileSync(path.join(dir, 'target.ts'), secretContent);
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			return new Response(JSON.stringify({
				message: fetchCalls === 1
					? {
						role: 'assistant',
						content: '',
						tool_calls: [{
							function: {
								name: 'read_file',
								arguments: { path: 'target.ts' }
							}
						}]
					}
					: fetchCalls === 2
						? {
							role: 'assistant',
							content: '',
							tool_calls: [{
								function: {
									name: 'search_text',
									arguments: {
										query: 'TARGET_SEARCH_TERM',
										include: 'target.ts'
									}
								}
							}]
						}
						: { role: 'assistant', content: 'Die Leseprüfung ist abgeschlossen.' }
			}));
		}) as typeof fetch;
		try {
			const session = new ChatSession(
				(question, history, onStatus, signal, onToolActivity, mode) => {
					assert.strictEqual(mode, 'tools');
					return runChatTools(
						vscode.Uri.file(dir),
						question,
						history,
						onStatus,
						signal,
						onToolActivity
					);
				}
			);
			await handleChatMessage(session, {
				type: 'submit',
				mode: 'tools',
				text: 'Suche und prüfe den Treffer.'
			});

			assert.strictEqual(fetchCalls, 3);
			assert.deepStrictEqual(
				session.state.activities.map(activity => [
					activity.tool,
					activity.target,
					activity.round,
					activity.status
				]),
				[
					['read_file', 'target.ts', 1, 'success'],
					['search_text', '"TARGET_SEARCH_TERM" in target.ts', 2, 'repeat-blocked']
				]
			);
			const activityText = JSON.stringify(session.state.activities);
			assert.ok(!activityText.includes(secretContent));
			assert.strictEqual(session.state.entries[0].text.split('\n')[0], 'Modus: Werkzeuge (nur lesen)');
			assert.ok(session.state.entries[1].text.includes('Leseprüfung ist abgeschlossen'));
		} finally {
			globalThis.fetch = originalFetch;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Werkzeugmodus zeigt Budgetablehnung und erfindet ohne Modellaufruf keine Aktivitäten', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-chat-tools-budget-'));
		const fileContent = 'BUDGET_TOOL_CONTENT_'.repeat(2_000);
		fs.writeFileSync(path.join(dir, 'large.ts'), fileContent);
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			return new Response(JSON.stringify({
				message: fetchCalls === 1
					? {
						role: 'assistant',
						content: '',
						tool_calls: [{
							function: {
								name: 'read_file',
								arguments: { path: 'large.ts' }
							}
						}]
					}
					: { role: 'assistant', content: 'Die Datei wurde wegen des Budgets nicht übermittelt.' }
			}));
		}) as typeof fetch;
		try {
			const session = new ChatSession(
				(question, history, onStatus, signal, onToolActivity) =>
					runChatTools(
						vscode.Uri.file(dir),
						question,
						history,
						onStatus,
						signal,
						onToolActivity
					)
			);
			await session.ask('Lies die große Datei.', 'tools');
			assert.strictEqual(fetchCalls, 2);
			assert.deepStrictEqual(
				session.state.activities.map(activity => activity.status),
				['budget-rejected']
			);
			assert.ok(!JSON.stringify(session.state.activities).includes('BUDGET_TOOL_CONTENT'));

			globalThis.fetch = (async () => new Response(JSON.stringify({
				message: { role: 'assistant', content: 'Keine Werkzeuge nötig.' }
			}))) as typeof fetch;
			const noTools = new ChatSession(
				(question, history, onStatus, signal, onToolActivity) =>
					runChatTools(
						vscode.Uri.file(dir),
						question,
						history,
						onStatus,
						signal,
						onToolActivity
					)
			);
			await noTools.ask('Antworte ohne Werkzeugaufruf.', 'tools');
			assert.deepStrictEqual(noTools.state.activities, []);
		} finally {
			globalThis.fetch = originalFetch;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Chat protokolliert Modus und Eingabe und routet den Modus', async () => {
		const received: string[] = [];
		let receivedMode = '';
		const session = new ChatSession(async (question, _history, _status, _signal, _activity, mode) => {
			received.push(question);
			receivedMode = mode;
			return ok('Planantwort');
		});

		await handleChatMessage(session, {
			type: 'submit',
			mode: 'plan',
			text: 'Ändere die Konfiguration.'
		});

		assert.deepStrictEqual(received, ['Ändere die Konfiguration.']);
		assert.strictEqual(receivedMode, 'plan');
		assert.ok(session.state.entries[0].text.includes('Modus: Änderung planen'));
		assert.ok(session.state.entries[0].text.includes('Ändere die Konfiguration.'));
		assert.strictEqual(session.state.entries[1].text, 'Planantwort');
	});

	test('Unbekannter Chatmodus wird abgelehnt', async () => {
		let runs = 0;
		const session = new ChatSession(async () => {
			runs += 1;
			return ok('unerwartet');
		});
		await handleChatMessage(session, {
			type: 'submit',
			mode: 'writeFiles',
			text: 'Dateien ändern'
		});
		assert.strictEqual(runs, 0);
		assert.strictEqual(session.state.entries[0].kind, 'error');
	});

	test('Chatplanung verwendet vorhandenen Read-only-Agenten und liest angeforderte Datei vorab', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-chat-plan-'));
		const fileContent = 'CHAT_PLAN_READONLY_MARKER';
		fs.writeFileSync(path.join(dir, 'README.md'), fileContent);
		const originalFetch = globalThis.fetch;
		let requestBody: { messages: Array<{ role: string; content: string }>; tools?: unknown[] } | undefined;
		const activities = new Map<number, ToolActivity>();
		globalThis.fetch = (async (_url: string, init: { body: string }) => {
			requestBody = JSON.parse(init.body) as typeof requestBody;
			return new Response(JSON.stringify({
				message: {
					role: 'assistant',
					content: [
						'1. Ziel der Änderung',
						'Ein Ziel.',
						'',
						'2. betroffene Dateien, nur soweit tatsächlich geprüft',
						'- `README.md`',
						'',
						'3. höchstens drei Umsetzungsschritte',
						'1. Umsetzung.',
						'',
						'4. nötige Tests',
						'Tests.',
						'',
						'5. offene Fragen oder unbelegte Annahmen',
						'Keine.'
					].join('\n')
				}
			}));
		}) as typeof fetch;

		try {
			const result = await runChatPlan(
				vscode.Uri.file(dir),
				'Lies README.md und plane die Änderung.',
				() => {},
				new AbortController().signal,
				activity => activities.set(activity.step, activity)
			);
			assert.ok(result.answer.includes('Ziel der Änderung'));
			assert.deepStrictEqual(result.evidence.map(item => item.target), ['README.md']);
			assert.deepStrictEqual(
				[...activities.values()].map(activity => [activity.tool, activity.round, activity.status]),
				[['read_file', 0, 'success']]
			);
			assert.ok(!JSON.stringify(activities).includes(fileContent));
			assert.ok(JSON.stringify(requestBody).includes(fileContent));
			assert.ok(requestBody?.tools);
			assert.ok(!JSON.stringify(requestBody?.tools).includes('write_file'));
		} finally {
			globalThis.fetch = originalFetch;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('P4-Aufruf: search_text "src/chat/chatView.ts" projektweit überträgt parameterHint innerhalb des Ergebnisbudgets an das Modell', async () => {
		const originalFetch = globalThis.fetch;
		const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
		globalThis.fetch = (async (_url: string, init: { body: string }) => {
			bodies.push(JSON.parse(init.body));
			if (bodies.length === 1) {
				return new Response(JSON.stringify({
					message: {
						role: 'assistant',
						content: '',
						tool_calls: [{ function: { name: 'search_text', arguments: { query: 'src/chat/chatView.ts' } } }]
					}
				}));
			}
			return new Response(JSON.stringify({
				message: { role: 'assistant', content: '1. Ziel der Änderung\nTeilplan.' }
			}));
		}) as typeof fetch;

		try {
			const workspace = vscode.workspace.workspaceFolders![0].uri;
			const activities: ToolActivity[] = [];
			const result = await runChatPlan(
				workspace,
				'Plane eine Änderung an der Abbruchbehandlung in src/chat/chatView.ts.',
				() => {},
				new AbortController().signal,
				activity => activities.push(activity)
			);

			assert.strictEqual(bodies.length, 2);
			// Die Frage nennt kein Lesewort: keine Vorabsuche/-lesung der Zieldatei.
			assert.ok(!bodies[0].messages.some(message => message.role === 'tool'));
			const toolMessages = bodies[1].messages.filter(message => message.role === 'tool');
			assert.strictEqual(toolMessages.length, 1);

			const envelope = JSON.parse(toolMessages[0].content) as { success: boolean; content: string };
			assert.strictEqual(envelope.success, true);
			const payload = JSON.parse(envelope.content) as {
				query: string;
				parameterHint?: string;
				emittedHitCount: number;
				actualUtf8Bytes: number;
			};
			assert.strictEqual(payload.query, 'src/chat/chatView.ts');
			assert.ok(payload.parameterHint?.includes('query ist Text im Dateiinhalt, include wählt die Zieldatei'));
			assert.ok(payload.emittedHitCount > 0);
			const toolBytes = Buffer.byteLength(JSON.stringify({ success: true, content: envelope.content }), 'utf8');
			assert.strictEqual(payload.actualUtf8Bytes, toolBytes);
			assert.ok(toolBytes <= MAX_SEARCH_RESULT_BYTES);

			// Antwort ohne weiteren Werkzeugaufruf ist nach dem Ergebnis zulässig;
			// die Zieldatei gilt dabei nicht als gelesen.
			assert.deepStrictEqual(result.evidence.map(item => item.tool), ['search_text']);
			assert.ok(!result.evidence.some(item => item.tool.startsWith('read_file')));
			assert.ok(result.answer.includes('src/chat/chatView.ts'));
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	suite('Navigationshinweis für eindeutig benannte Zieldatei (Planmodus)', () => {
		const P4 = 'Plane eine Änderung an der Abbruchbehandlung in src/chat/chatView.ts.';
		const HINT_MARK = 'Navigationshinweis (kein Beleg';

		const withWorkspace = async (
			files: Record<string, string>,
			question: string
		) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-nav-hint-'));
			for (const [name, content] of Object.entries(files)) {
				fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
				fs.writeFileSync(path.join(dir, name), content);
			}
			const originalFetch = globalThis.fetch;
			const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
			const rawBodies: string[] = [];
			globalThis.fetch = (async (_url: string, init: { body: string }) => {
				rawBodies.push(init.body);
				bodies.push(JSON.parse(init.body));
				return new Response(JSON.stringify({
					message: { role: 'assistant', content: '1. Ziel der Änderung\nGeneriert.' }
				}));
			}) as typeof fetch;
			try {
				const result = await runChatPlan(
					vscode.Uri.file(dir),
					question,
					() => {},
					new AbortController().signal,
					() => {}
				);
				const userText = bodies[0].messages
					.filter(message => message.role === 'user')
					.map(message => message.content)
					.join('\n');
				return { result, bodies, rawBodies, userText };
			} finally {
				globalThis.fetch = originalFetch;
				fs.rmSync(dir, { recursive: true, force: true });
			}
		};

		test('exakter P4-Text ohne Lese-/Prüfwort: Hinweis vor der ersten Werkzeugwahl, nichts gelesen, Planblockade bleibt', async () => {
			const big = 'x'.repeat(40_000);
			const { result, bodies, userText } = await withWorkspace({ 'src/chat/chatView.ts': big }, P4);

			assert.strictEqual(bodies.length, 1);
			assert.ok(!bodies[0].messages.some(message => message.role === 'tool'));
			assert.ok(userText.includes(HINT_MARK));
			assert.ok(userText.includes('Mögliches Leseziel: src/chat/chatView.ts'));
			assert.ok(userText.includes('query = ein wörtlicher Codebegriff aus dem Dateiinhalt, include = src/chat/chatView.ts'));
			assert.ok(userText.includes('read_file_range'));
			// Kein Dateiinhalt, kein erfundener Codebegriff, keine Lesebestätigung.
			assert.ok(!userText.includes(big.slice(0, 100)));
			assert.ok(userText.includes('noch nicht gelesen'));
			// Unveränderter Belegstatus: kein Leseaufruf, Planblockade greift.
			assert.deepStrictEqual(result.evidence, []);
			assert.strictEqual(getFileReadStatus('src/chat/chatView.ts', result.evidence, result.omitted), 'not-attempted');
			assert.ok(result.answer.includes('Deshalb liegt kein belastbarer Plan vor'));
			assert.ok(!result.answer.includes('Generiert.'));
		});

		test('kleine benannte Datei erhält denselben Hinweis, ohne dass sie gelesen wird', async () => {
			const { result, userText } = await withWorkspace({ 'src/small.ts': 'export const a = 1;\n' }, 'Plane eine Anpassung in src/small.ts.');
			assert.ok(userText.includes('Mögliches Leseziel: src/small.ts'));
			assert.ok(!userText.includes('export const a = 1;'));
			assert.deepStrictEqual(result.evidence, []);
		});

		test('mehrere, mehrdeutige, fehlende oder nur verzeichnisartige Ziele: kein Hinweis', async () => {
			const files = { 'src/a.ts': 'a', 'src/b.ts': 'b' };
			for (const question of [
				'Ändere src/a.ts und src/b.ts.',
				'Plane eine Änderung der Abbruchbehandlung im Chat.',
				'Ändere src/fehlt.ts.',
				'Ändere die Struktur in src/chat/.',
				'Erkläre src/a.ts.'
			]) {
				const { userText } = await withWorkspace(files, question);
				assert.ok(!userText.includes(HINT_MARK), question);
			}
		});

		test('gesperrter, externer und absoluter Pfad: kein scheinbar geprüfter Pfad im Hinweis', async () => {
			const files = { '.env': 'TOKEN=geheim', 'node_modules/m.js': 'x', 'src/a.ts': 'a' };
			for (const question of [
				'Ändere .env.',
				'Ändere node_modules/m.js.',
				'Ändere ../outside.ts.',
				`Ändere ${path.join(os.tmpdir(), 'fremd.ts').replace(/\\/g, '/')}.`
			]) {
				const { userText } = await withWorkspace(files, question);
				assert.ok(!userText.includes(HINT_MARK), question);
				assert.ok(!userText.includes('geheim'), question);
			}
		});

		test('Budget: Hinweis ist kurz, die Anfrage bleibt innerhalb von 32.000 Bytes, Schrittlimit unverändert', async () => {
			const { rawBodies, bodies, userText } = await withWorkspace({ 'src/chat/chatView.ts': 'y'.repeat(40_000) }, P4);
			const hint = userText.slice(userText.indexOf(HINT_MARK));
			assert.ok(Buffer.byteLength(hint, 'utf8') < 700);
			assert.strictEqual(bodies.length, 1);
			assert.ok(Buffer.byteLength(rawBodies[0], 'utf8') <= MAX_REQUEST_BYTES);
		});
	});

	test('Chat-Abbruch und Budgetfehler werden sichtbar behandelt', async () => {
		let signal: AbortSignal | undefined;
		const cancelled = new ChatSession(async (_q, _h, _s, currentSignal) => {
			signal = currentSignal;
			return new Promise<AgentResult>((_resolve, reject) => {
				currentSignal.addEventListener('abort', () =>
					reject(new AgentCancelledError()), { once: true }
				);
			});
		});
		const pending = cancelled.ask('Planen', 'plan');
		cancelled.end();
		await pending;
		assert.strictEqual(signal?.aborted, true);
		assert.ok(cancelled.state.entries.some(entry =>
			entry.kind === 'info' && entry.text.includes('Gespräch beendet')
		));

		const limited = new ChatSession(async () => {
			throw new ChatModeLimitError('Das Promptbudget von 8.000 Bytes wurde überschritten.');
		});
		await limited.ask('Analyse', 'selectedFiles');
		assert.strictEqual(limited.state.entries.at(-1)?.kind, 'limit');
		assert.ok(limited.state.entries.at(-1)?.text.includes('8.000 Bytes'));
	});

	test('Parallele bestehende Modellläufe werden mit verständlichem Hinweis abgewiesen', async () => {
		let release: (() => void) | undefined;
		const running = runExclusiveOperation(
			'Änderung planen',
			() => new Promise<void>(resolve => { release = resolve; })
		);
		await assert.rejects(
			runExclusiveOperation('Frage stellen', async () => {}),
			/Änderung planen/
		);
		release?.();
		await running;
		await assert.doesNotReject(
			runExclusiveOperation('Frage stellen', async () => {})
		);
	});

	test('Leseaktivität erscheint live und aktualisiert denselben Eintrag bei Erfolg', async () => {
		let finish: (() => void) | undefined;
		const snapshots: Array<ChatState> = [];
		const session = new ChatSession(
			async (_question, _history, _status, _signal, onToolActivity) => {
				onToolActivity({
					step: 1,
					tool: 'read_file',
					target: 'src/example.ts',
					status: 'running'
				});
				await new Promise<void>(resolve => { finish = resolve; });
				onToolActivity({
					step: 1,
					tool: 'read_file',
					target: 'src/example.ts',
					status: 'success'
				});
				return ok('Fertig');
			},
			state => snapshots.push(state)
		);

		const pending = session.ask('Frage zum Beispiel');
		assert.deepStrictEqual(
			session.state.activities.map(activity => [activity.step, activity.status]),
			[[1, 'running']]
		);
		assert.ok(snapshots.some(state =>
			state.activities.some(activity => activity.status === 'running')
		));

		finish?.();
		await pending;
		assert.deepStrictEqual(
			session.state.activities.map(activity => [activity.step, activity.status]),
			[[1, 'success']]
		);
		assert.strictEqual(session.state.activities.length, 1);
	});

	test('Aktivität zeigt bei read_file_range nur einen sicheren Fehlergrund', async () => {
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			return new Response(JSON.stringify({
				message: fetchCalls === 1
					? {
						role: 'assistant',
						content: '',
						tool_calls: [{
							function: {
								name: 'read_file_range',
								arguments: {
									path: 'src/chat/chatSession.ts',
									first_line: 0,
									last_line: 4
								}
							}
						}]
					}
					: { role: 'assistant', content: 'Geprüft' }
			}));
		}) as typeof fetch;
		try {
			const session = new ChatSession(
				(question, history, onStatus, signal, onToolActivity) =>
					runReadOnlyAgent(
						vscode.workspace.workspaceFolders![0].uri,
						question,
						onStatus,
						history,
						[],
						signal,
						onToolActivity
					)
			);
			await session.ask('Lies einen Bereich');
			assert.deepStrictEqual(
				session.state.activities.map(activity => activity.status),
				['failed']
			);
			assert.strictEqual(
				session.state.activities[0].reason,
				'Zeilennummern müssen positive ganze Zahlen sein.'
			);
			assert.ok(!JSON.stringify(session.state.activities).includes('Werkzeugergebnis'));
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('Reset und Beenden verwerfen verspätete Aktivitätsupdates eines laufenden Werkzeugs', async () => {
		for (const action of ['reset', 'end'] as const) {
			let finish: (() => void) | undefined;
			let signal: AbortSignal | undefined;
			const session = new ChatSession(
				async (_question, _history, _status, activeSignal, onToolActivity) => {
					signal = activeSignal;
					onToolActivity({
						step: 1,
						tool: 'read_file',
						target: 'src/stale.ts',
						status: 'running'
					});
					await new Promise<void>(resolve => { finish = resolve; });
					onToolActivity({
						step: 1,
						tool: 'read_file',
						target: 'src/stale.ts',
						status: 'success'
					});
					return ok('Verspätet');
				}
			);

			const pending = session.ask('Lange Frage');
			assert.strictEqual(session.state.activities[0].status, 'running');
			session[action]();
			assert.strictEqual(signal?.aborted, true);
			finish?.();
			await pending;

			assert.deepStrictEqual(session.state.activities, []);
			assert.strictEqual(session.state.entries.length, 1);
			assert.ok(session.state.entries[0].text.includes(
				action === 'reset' ? 'zurückgesetzt' : 'beendet'
			));
		}
	});

	suite('Statuszeile und Laufzusammenfassung', () => {
		const act = (
			step: number,
			tool: string,
			target: string,
			status: ToolActivity['status'],
			extra: Partial<ToolActivity> = {}
		): ToolActivity => ({ step, tool, target, status, ...extra });

		const runWith = async (
			script: (report: (activity: ToolActivity) => void) => Promise<AgentResult>
		) => {
			const session = new ChatSession(
				async (_q, _h, _s, _signal, onToolActivity) => script(onToolActivity)
			);
			await session.ask('Frage', 'tools');
			const summaries = session.state.entries.filter(entry => entry.kind === 'summary');
			return { session, summaries };
		};

		test('Erfolg: Zusammenfassung nennt nur tatsächlich ausgeführte Aufrufe', async () => {
			const { session, summaries } = await runWith(async report => {
				report(act(1, 'search_text', '"abort" in **/*', 'running'));
				report(act(1, 'search_text', '"abort" in **/*', 'success'));
				report(act(2, 'read_file_range', 'src/a.ts', 'success', {
					requestedRange: { firstLine: 1, lastLine: 10 },
					deliveredRange: { firstLine: 1, lastLine: 10 }
				}));
				return ok('Antwort');
			});

			assert.strictEqual(summaries.length, 1);
			const text = summaries[0].text;
			assert.ok(text.includes('Zusammenfassung: erfolgreich'));
			assert.ok(text.includes('Ausgeführt (2)'));
			assert.ok(text.includes('Dateibereich gelesen: src/a.ts'));
			assert.ok(!text.includes('Nicht ausgeführt'));
			assert.ok(text.includes('keine Dateien geändert'));
			assert.ok(!text.includes('Offen'));
			// Jeder genannte Titel stammt aus dem Aktivitätsverlauf.
			for (const view of session.state.activities) {
				if (view.status === 'success') {
					assert.ok(text.includes(view.title));
				}
			}
		});

		test('Budgetablehnung mit Recovery: Ablehnung bleibt sichtbar, Ergebnis teilweise', async () => {
			const { session, summaries } = await runWith(async report => {
				report(act(1, 'read_file', 'src/big.ts', 'budget-rejected', {
					reason: 'Requestbudget'
				}));
				report(act(2, 'read_file', 'src/other.ts', 'repeat-blocked'));
				report(act(3, 'read_file_range', 'src/big.ts', 'success'));
				return ok('Antwort');
			});

			const text = summaries[0].text;
			assert.ok(text.includes('Zusammenfassung: teilweise'));
			assert.ok(text.includes('Datei wegen Budget nicht übernommen: src/big.ts'));
			assert.ok(text.includes('Nicht ausgeführt oder abgewiesen (2)'));
			assert.ok(text.includes('Dateibereich gelesen: src/big.ts'));
			assert.ok(text.includes('nicht an das Modell übermittelt'));
			assert.strictEqual(session.state.activities.length, 3);
		});

		test('Früher Teilbefund: Schrittlimit mit einem Treffer ist teilweise, ohne Lesebeleg offen', async () => {
			const withRead = await runWith(async report => {
				report(act(1, 'read_file_range', 'src/a.ts', 'success'));
				throw new AgentStepLimitError([], 0, []);
			});
			assert.ok(withRead.summaries[0].text.includes('Zusammenfassung: teilweise'));
			assert.ok(withRead.summaries[0].text.includes('acht Modellschritten'));
			assert.ok(!withRead.summaries[0].text.includes('keine Datei oder kein Dateibereich gelesen'));

			const searchOnly = await runWith(async report => {
				report(act(1, 'search_text', '"x" in **/*', 'success'));
				throw new AgentStepLimitError([], 0, []);
			});
			const text = searchOnly.summaries[0].text;
			assert.ok(text.includes('Zusammenfassung: teilweise'));
			assert.ok(text.includes('Es wurde keine Datei oder kein Dateibereich gelesen.'));
			assert.ok(!text.includes('Datei gelesen'), 'Suche zählt nicht als Lesen');
		});

		test('Fehler: frühere Fehlschläge bleiben trotz späterem Erfolg erhalten; Fehlerentry bleibt', async () => {
			const failed = await runWith(async report => {
				report(act(1, 'read_file', 'src/missing.ts', 'failed', { reason: 'nicht gefunden' }));
				throw new Error('Ollama nicht erreichbar');
			});
			assert.ok(failed.summaries[0].text.includes('Zusammenfassung: fehlgeschlagen'));
			assert.ok(failed.summaries[0].text.includes('Datei nicht gelesen: src/missing.ts'));
			assert.ok(failed.session.state.entries.some(
				entry => entry.kind === 'error' && entry.text.includes('Ollama nicht erreichbar')
			));

			const mixed = await runWith(async report => {
				report(act(1, 'read_file', 'src/missing.ts', 'failed'));
				report(act(2, 'read_file', 'src/ok.ts', 'success'));
				return ok('Antwort');
			});
			assert.ok(mixed.summaries[0].text.includes('Zusammenfassung: teilweise'));
			assert.ok(mixed.summaries[0].text.includes('Datei nicht gelesen: src/missing.ts'));
			assert.ok(mixed.summaries[0].text.includes('Datei gelesen: src/ok.ts'));

			const limit = await runWith(async report => {
				report(act(1, 'read_file', 'src/a.ts', 'budget-rejected'));
				throw new ChatModeLimitError('Kontextgrenze erreicht.');
			});
			assert.ok(limit.summaries[0].text.includes('Zusammenfassung: abgebrochen'));
		});

		test('Nutzerabbruch: genau eine Abschlussmeldung, keine Zusammenfassung', async () => {
			for (const action of ['reset', 'end'] as const) {
				let finish: (() => void) | undefined;
				const session = new ChatSession(
					async (_q, _h, _s, _signal, onToolActivity) => {
						onToolActivity(act(1, 'read_file', 'src/a.ts', 'running'));
						await new Promise<void>(resolve => { finish = resolve; });
						throw new AgentCancelledError();
					}
				);
				const pending = session.ask('Frage', 'tools');
				session[action]();
				finish?.();
				await pending;

				assert.strictEqual(session.state.entries.length, 1);
				assert.ok(!session.state.entries.some(entry => entry.kind === 'summary'));
				assert.strictEqual(session.state.liveStatus, '');
			}
		});

		test('Ohne Werkzeugaktivität entsteht keine erfundene Zusammenfassung', async () => {
			const { summaries } = await runWith(async () => ok('Antwort'));
			assert.strictEqual(summaries.length, 0);
		});

		test('Laufende Statuszeile: nur beobachtete Ereignisse, Budgetgrenze nicht verdeckt', () => {
			assert.strictEqual(liveStatusLine('', []), 'Analyse läuft ...');
			assert.strictEqual(liveStatusLine('Lesewerkzeug: x', []), 'Lesewerkzeug: x');

			const line = liveStatusLine('Warte', [
				act(1, 'read_file', 'src/big.ts', 'budget-rejected'),
				act(2, 'search_text', '"abort" in src/big.ts', 'running')
			]);
			assert.ok(line.includes('Eingeschränkt wird gesucht'));
			assert.ok(line.includes('Budgetgrenze: 1 Aufruf(e) nicht übernommen'));

			const failedLine = liveStatusLine('Warte', [act(1, 'read_file', 'a', 'failed')]);
			assert.ok(failedLine.includes('1 Aufruf(e) fehlgeschlagen'));
		});

		test('Laufende Aktivität am Ende zählt nicht als ausgeführt; Zusammenfassung ändert Aktivitäten nicht', () => {
			const activities = [act(1, 'read_file', 'src/a.ts', 'running')];
			const text = summarizeRun(activities, new Error('x'));
			assert.ok(text.includes('keine erfolgreichen Werkzeugaufrufe'));
			assert.ok(text.includes('Datei nicht gelesen: src/a.ts'));
			assert.strictEqual(activities[0].status, 'running');
		});
	});

	test('Ungültige Eingaben und parallele Fragen starten keine Analyse', async () => {
		let calls = 0;
		let release: () => void = () => {};
		const session = new ChatSession(() => {
			calls += 1;
			return new Promise<AgentResult>(resolve => { release = () => resolve(ok('x')); });
		});

		await session.ask(42);
		await session.ask('   ');
		assert.strictEqual(calls, 0);

		const first = session.ask('a');
		await session.ask('b');
		assert.strictEqual(calls, 1);
		assert.ok(session.state.busy);
		release();
		await first;
		assert.strictEqual(session.turnCount, 1);
	});

	test('Reset verwirft den Verlauf', async () => {
		const seen: number[] = [];
		const session = new ChatSession(async (_q, history) => {
			seen.push(history.length);
			return ok('a');
		});

		await session.ask('eins');
		session.reset();
		await session.ask('zwei');

		assert.deepStrictEqual(seen, [0, 0]);
		assert.ok(session.state.entries[0].text.includes('zurückgesetzt'));
	});

	test('Beenden bricht laufende Analyse ab und übernimmt kein Ergebnis', async () => {
		let signal: AbortSignal | undefined;
		const session = new ChatSession((_q, _h, _s, sig) => {
			signal = sig;
			return new Promise<AgentResult>((_resolve, reject) => {
				sig.addEventListener('abort', () => reject(new AgentCancelledError()));
			});
		});

		const pending = session.ask('lange Frage');
		assert.ok(session.state.busy);
		session.end();
		await pending;

		assert.strictEqual(signal?.aborted, true);
		assert.strictEqual(session.state.busy, false);
		assert.strictEqual(session.turnCount, 0);
		assert.strictEqual(session.state.entries.length, 1);
		assert.ok(session.state.entries[0].text.includes('beendet'));
	});

	test('Fehler und Kontextgrenze werden im Chat gemeldet, Verlauf bleibt', async () => {
		let mode: 'ok' | 'fail' | 'big' = 'ok';
		const session = new ChatSession(async () => {
			if (mode === 'fail') { throw new Error('Ollama nicht erreichbar'); }
			if (mode === 'big') { throw new RequestTooLargeError(40_000); }
			return ok('gut');
		});

		await session.ask('eins');
		mode = 'fail';
		await session.ask('zwei');
		mode = 'big';
		await session.ask('drei');

		const entries = session.state.entries;
		assert.strictEqual(entries.find(e => e.kind === 'error')?.text, 'Ollama nicht erreichbar');
		const limit = entries.find(e => e.kind === 'limit');
		assert.ok(limit?.text.includes('32000 Bytes'));
		assert.ok(limit?.text.includes('nicht stillschweigend gekürzt'));
		assert.strictEqual(session.turnCount, 1);
		assert.strictEqual(session.state.busy, false);
	});

	test('Kontextgrenzen-Diagnose zeigt Kategorien und Abbruchstelle ohne Inhalte', async () => {
		const breakdown = {
			systemPromptBytes: 10_000,
			historyBytes: 2_000,
			questionBytes: 100,
			agentStepBytes: 200,
			toolResultBytes: 5_000,
			toolDefinitionsBytes: 4_000,
			requestEnvelopeBytes: 18_700,
			totalBytes: 40_000
		};
		for (const [toolResultCount, expectedStage] of [
			[0, 'vor dem ersten Lesewerkzeug'],
			[1, 'nach 1 Werkzeugergebnis']
		] as const) {
			const session = new ChatSession(async () => {
				throw new RequestTooLargeError(
					breakdown.totalBytes, breakdown, toolResultCount
				);
			});
			await session.ask('kurze Frage');
			const text = session.state.entries.find(entry => entry.kind === 'limit')?.text;
			assert.ok(text?.includes(expectedStage));
			assert.ok(text?.includes('Systemtext inkl. Projektregeln: 10000 Bytes'));
			assert.ok(text?.includes('Werkzeugergebnisse: 5000 Bytes'));
			assert.ok(text?.includes('JSON-Rahmen, Modell und Optionen: 18700 Bytes'));
			assert.ok(text?.includes('Gesamtgröße: 40000 Bytes'));
			assert.ok(!text?.includes('Regelinhalt'));
			assert.strictEqual(session.turnCount, 0);
		}
	});

	test('Webview-Nachrichten: nur ask, reset, end; keine Befehlsausführung', async () => {
		const asked: string[] = [];
		const session = new ChatSession(async q => { asked.push(q); return ok('a'); });

		await handleChatMessage(session, null);
		await handleChatMessage(session, 'ask');
		await handleChatMessage(session, { type: 'executeCommand', command: 'workbench.action.quit' });
		await handleChatMessage(session, { type: 'ask', text: { x: 1 } });
		assert.deepStrictEqual(asked, []);

		await handleChatMessage(session, { type: 'ask', text: 'Hallo' });
		assert.deepStrictEqual(asked, ['Hallo']);
		await handleChatMessage(session, { type: 'reset' });
		assert.strictEqual(session.turnCount, 0);
	});

	test('Systemprüfung: bereit wird im Chat angezeigt, ohne Frage oder Verlauf', async () => {
		let checks = 0;
		let agentCalls = 0;
		const session = new ChatSession(async () => {
			agentCalls += 1;
			return ok('Antwort');
		});
		await handleChatMessage(session, { type: 'systemCheck' }, async () => {
			checks += 1;
			return { output: 'Ergebnis:\n  SYSTEM BEREIT' };
		});

		assert.strictEqual(checks, 1);
		assert.strictEqual(agentCalls, 0);
		assert.strictEqual(session.turnCount, 0);
		assert.deepStrictEqual(session.state.entries.map(entry => entry.kind), ['system']);
		assert.ok(session.state.entries[0].text.includes('SYSTEM BEREIT'));
	});

	test('Systemprüfung: fehlendes Modell wird als nicht bereit angezeigt', async () => {
		const session = new ChatSession(async () => ok('Antwort'));
		await handleChatMessage(session, { type: 'systemCheck' }, async () => ({
			output: '  FEHLT: qwen3:14b\n  SYSTEM NOCH NICHT VOLLSTAENDIG BEREIT'
		}));

		assert.strictEqual(session.turnCount, 0);
		assert.deepStrictEqual(session.state.entries.map(entry => entry.kind), ['system']);
		assert.ok(session.state.entries[0].text.includes('FEHLT: qwen3:14b'));
		assert.ok(session.state.entries[0].text.includes('SYSTEM NOCH NICHT'));
	});

	test('Systemprüfung: fehlender Workspace wird verständlich im Chat gemeldet', async () => {
		let agentCalls = 0;
		const session = new ChatSession(async () => {
			agentCalls += 1;
			return ok('Antwort');
		});
		await handleChatMessage(session, { type: 'systemCheck' }, async () => {
			throw new Error(
				'Bubble: Es ist kein Workspace geöffnet. Bitte zuerst einen Projektordner öffnen.'
			);
		});

		assert.strictEqual(agentCalls, 0);
		assert.strictEqual(session.turnCount, 0);
		assert.deepStrictEqual(session.state.entries.map(entry => entry.kind), ['systemError']);
		assert.ok(session.state.entries[0].text.includes('kein Workspace geöffnet'));
	});

	test('Systemprüfung-Aktion ist sichtbar und sendet einen separaten Nachrichtentyp', () => {
		const html = getChatHtml('system-check');
		assert.ok(html.includes('>System prüfen</button>'));
		assert.ok(html.includes("document.getElementById('system-check').addEventListener"));
		assert.ok(html.includes("vscode.postMessage({ type: 'systemCheck' })"));
		assert.ok(html.includes("system: 'Systemprüfung'"));
	});

	test('Workspace-Kopfzeile zeigt den verwendeten Ordner und aktualisiert bei Wechsel', () => {
		const html = getChatHtml('workspace');
		const { workspaceName, sendState, sendWorkspace } = renderWebview(html, async () => {});
		assert.ok(html.includes('<header id="chat-header">Workspace:'));
		assert.strictEqual(workspaceName.textContent, 'Kein Workspace geöffnet');

		assert.strictEqual(
			getChatWorkspaceName([{ name: 'Projekt A' }, { name: 'Projekt B' }]),
			'Projekt A'
		);
		assert.strictEqual(getChatWorkspaceName(undefined), 'Kein Workspace geöffnet');

		sendState({
			entries: [],
			busy: false,
			status: ''
		}, getChatWorkspaceName([{ name: 'Projekt A' }]));
		assert.strictEqual(workspaceName.textContent, 'Projekt A');

		sendWorkspace(getChatWorkspaceName([{ name: 'Projekt B' }]));
		assert.strictEqual(workspaceName.textContent, 'Projekt B');

		sendWorkspace(getChatWorkspaceName(undefined));
		assert.strictEqual(workspaceName.textContent, 'Kein Workspace geöffnet');
	});

	test('Webview-HTML: strenge CSP mit Nonce, Anzeige über textContent', () => {
		const html = getChatHtml('abc123');
		assert.ok(html.includes("default-src 'none'"));
		assert.ok(html.includes("script-src 'nonce-abc123'"));
		assert.ok(!html.includes('innerHTML'));
	});

	test('Agent: bereits abgebrochenes Signal ruft Ollama nicht auf', async () => {
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = (async () => { fetchCalls += 1; return new Response('{}'); }) as typeof fetch;
		try {
			const controller = new AbortController();
			controller.abort();
			await assert.rejects(
				runReadOnlyAgent(vscode.workspace.workspaceFolders![0].uri, 'x', undefined, [], [], controller.signal),
				AgentCancelledError
			);
			assert.strictEqual(fetchCalls, 0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('Schrittlimit: bisher erfasstes Werkzeugprotokoll bleibt im Chat sichtbar', async () => {
		// Eigener Workspace: Regeldateien des echten Repositories (z. B. PROJECT_STATE.md)
		// dürfen die Request-Basis nicht beeinflussen.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-chat-step-limit-'));
		fs.mkdirSync(path.join(dir, 'src', 'agent'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'src', 'agent', 'readOnlyAgent.ts'), Array.from({ length: 6 }, (_, i) => `const wert${i} = 12345678; // Zeile ${i}`).join('\n'));
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			return new Response(JSON.stringify({
				message: {
					role: 'assistant',
					content: '',
					tool_calls: [{
						function: {
							name: 'search_text',
							arguments: {
								query: String(fetchCalls),
								include: 'src/agent/readOnlyAgent.ts'
							}
						}
					}]
				}
			}));
		}) as typeof fetch;
		try {
			const session = new ChatSession((question, history, onStatus, signal, onToolActivity) =>
				runReadOnlyAgent(
					vscode.Uri.file(dir),
					question,
					onStatus,
					history,
					[],
					signal,
					onToolActivity
				)
			);
			await session.ask('Endlosschleife');

			assert.strictEqual(fetchCalls, 9);
			const entries = session.state.entries;
			const error = entries.find(e => e.kind === 'error');
			assert.ok(error?.text.includes('maximale Limit von acht Modellschritten'));
			const evidence = entries.find(e => e.kind === 'evidence')?.text ?? '';
			assert.strictEqual(
				(evidence.match(/- search_text .*: erfolgreich/g) ?? []).length,
				8
			);
			assert.ok(evidence.includes('Requestgrößen je Werkzeugergebnis'));
			assert.ok(evidence.includes('hypothetische Gesamtgröße='));
			assert.ok(evidence.includes('Ergebnis an Ollama übermittelt'));
			assert.strictEqual(session.state.activities.length, 8);
			assert.ok(session.state.activities.every(activity =>
				activity.status === 'success'
			));
			assert.deepStrictEqual(
				session.state.activities.map(activity => activity.round),
				[1, 2, 3, 4, 5, 6, 7, 8]
			);
			assert.ok(session.state.activities.every(activity =>
				activity.details.some(line => line.includes('zählt zum Schrittlimit'))
			));
			assert.ok(evidence.includes('Modellschritt=8/8'));
			assert.ok(evidence.includes('8 von 8 genutzt'));
			assert.ok(!evidence.includes('package.json'));
			assert.ok(!error?.text.includes('package.json'));
			assert.strictEqual(session.state.busy, false);
		} finally {
			globalThis.fetch = originalFetch;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Beleg-Metadaten: Treffer (Pfad, Zeile), 0 Treffer und gelieferter Bereich gelangen ins Evidence-Protokoll, ohne Inhalte', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-chat-evidence-meta-'));
		fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'src', 'a.ts'), ['eins', 'zwei GEHEIM_ZEILE', 'drei', 'vier'].join('\n'));
		const originalFetch = globalThis.fetch;
		const calls = [
			{ name: 'search_text', arguments: { query: 'GEHEIM_ZEILE', include: 'src/a.ts' } },
			{ name: 'search_text', arguments: { query: 'gibtEsNicht', include: 'src/a.ts' } },
			{ name: 'read_file_range', arguments: { path: 'src/a.ts', first_line: 2, last_line: 3 } }
		];
		let n = 0;
		globalThis.fetch = (async () => {
			const call = calls[n++];
			return new Response(JSON.stringify({
				message: call
					? { role: 'assistant', content: '', tool_calls: [{ function: call }] }
					: { role: 'assistant', content: 'fertig' }
			}));
		}) as typeof fetch;
		try {
			const result = await runReadOnlyAgent(vscode.Uri.file(dir), 'Frage', undefined, [], [], undefined, undefined);
			const [hit, none, range] = result.evidence;
			assert.deepStrictEqual(hit.hits, [{ path: 'src/a.ts', line: 2 }]);
			assert.strictEqual(hit.query, 'GEHEIM_ZEILE');
			assert.strictEqual(none.success, true);
			assert.deepStrictEqual(none.hits, []);
			assert.deepStrictEqual(range.deliveredRange, { firstLine: 2, lastLine: 3 });
			assert.ok(!JSON.stringify(result.evidence).includes('zwei GEHEIM'));
		} finally {
			globalThis.fetch = originalFetch;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	test('Schleifenerkennung: identischer Aufruf wird nicht erneut ausgeführt, nach Hinweislimit Abbruch', async () => {
		// Eigener Workspace: Regeldateien und Dateien des echten Repositories
		// dürfen Budget und Treffer dieses Tests nicht bestimmen.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-chat-loop-'));
		fs.mkdirSync(path.join(dir, 'src', 'chat'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'src', 'chat', 'chatSession.ts'), 'const start = 1;\nconst stop = 2;\n');
		const originalFetch = globalThis.fetch;
		const bodies: string[] = [];
		globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
			bodies.push(init?.body ?? '');
			return new Response(JSON.stringify({
				message: {
					role: 'assistant',
					content: '',
					tool_calls: [{ function: { name: 'search_text', arguments: { query: ' reset|end ', include: 'src\\chat\\chatSession.ts' } } }]
				}
			}));
		}) as typeof fetch;
		try {
			const session = new ChatSession((question, history, onStatus, signal) =>
				runReadOnlyAgent(vscode.Uri.file(dir), question, onStatus, history, [], signal)
			);
			await session.ask('Wiederholung');

			// 1 Ausführung + 2 Hinweise; der vierte Versuch bricht ab.
			assert.strictEqual(bodies.length, 4);
			assert.ok(bodies.every(body => Buffer.byteLength(body, 'utf8') <= 32_000));
			const count = (text: string) => text.split('nicht erneut ausgeführt').length - 1;
			assert.ok(REPEATED_CALL_NOTICE.includes('nicht erneut ausgeführt'));
			assert.deepStrictEqual(bodies.map(count), [0, 0, 1, 2]);
			const entries = session.state.entries;
			assert.ok(entries.find(e => e.kind === 'error')?.text.includes('wiederholt'));
			const evidence = entries.find(e => e.kind === 'evidence')?.text ?? '';
			assert.strictEqual((evidence.match(/- search_text .*: erfolgreich/g) ?? []).length, 1);
			assert.ok(evidence.includes('Ausgeführte Lesezugriffe: 1; unterbundene Wiederholungen (nicht ausgeführt): 2.'));
			assert.strictEqual((evidence.match(/repeat-blocked/g) ?? []).length, 2);
			assert.strictEqual((evidence.match(/aborted/g) ?? []).length, 1);
		} finally {
			globalThis.fetch = originalFetch;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Schleifenerkennung: unterschiedliche Argumente und Reihenfolge der Schlüssel', () => {
		assert.strictEqual(
			toolCallKey('search_text', { query: 'a', include: 'x' }),
			toolCallKey('search_text', { include: 'x', query: ' a ' })
		);
		assert.strictEqual(
			toolCallKey('read_file', { path: 'src\\a.ts' }),
			toolCallKey('read_file', { path: 'src/a.ts' })
		);
		assert.notStrictEqual(
			toolCallKey('search_text', { query: 'a' }),
			toolCallKey('search_text', { query: 'b' })
		);
		assert.notStrictEqual(
			toolCallKey('read_file', { path: 'a' }),
			toolCallKey('list_directory', { path: 'a' })
		);
	});

	test('Schleifenerkennung: mehrere tool_calls in einer Antwort, Duplikat nur im selben Aufruf unterbunden', async () => {
		// Eigener Workspace statt der Verzeichnisstruktur des echten Repositories.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-chat-multicall-'));
		fs.mkdirSync(path.join(dir, 'src'));
		fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'const a = 1;\n');
		fs.writeFileSync(path.join(dir, 'root.md'), '# Wurzel\n');
		const originalFetch = globalThis.fetch;
		let call = 0;
		const bodies: string[] = [];
		globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
			call += 1;
			bodies.push(init?.body ?? '');
			if (call === 1) {
				const same = { function: { name: 'list_directory', arguments: { path: '.' } } };
				const other = { function: { name: 'list_directory', arguments: { path: 'src' } } };
				return new Response(JSON.stringify({
					message: { role: 'assistant', content: '', tool_calls: [same, other, same] }
				}));
			}
			return new Response(JSON.stringify({ message: { role: 'assistant', content: 'fertig' } }));
		}) as typeof fetch;
		try {
			const result = await runReadOnlyAgent(vscode.Uri.file(dir), 'Frage');
			assert.strictEqual(result.answer, 'fertig');
			assert.strictEqual(result.evidence.length, 2);
			assert.deepStrictEqual(
				result.toolDiagnostics?.map(d => d.outcome),
				['included', 'included', 'repeat-blocked']
			);
			assert.ok(bodies[1].includes('Dieses Ergebnis liegt bereits vor'));
			assert.ok(bodies.every(body => Buffer.byteLength(body, 'utf8') <= 32_000));
		} finally {
			globalThis.fetch = originalFetch;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Webview-HTML: Struktur, Arbeitsstatus, aufklappbares Protokoll und Themefarben', () => {
		const html = getChatHtml('n1');
		assert.ok(html.includes("createElement('details')") || html.includes("el('details'"));
		assert.ok(html.includes("el('summary', '', 'Werkzeugprotokoll')"));
		assert.ok(html.includes("setAttribute('role', 'status')"));
		assert.ok(html.includes('Bubble arbeitet'));
		assert.ok(html.includes('prefers-reduced-motion'));
		assert.ok(html.includes('var(--vscode-button-background)'));
		assert.ok(html.includes('var(--vscode-focusBorder)'));
		for (const label of ['Ausführen', 'Gespräch zurücksetzen', 'Beenden']) {
			assert.ok(html.includes(`>${label}</button>`), label);
		}
		assert.ok(!/\son(click|submit|keydown|load)=/i.test(html));
		assert.ok(!html.includes('<script src'));
		assert.ok(!html.includes('insertAdjacentHTML'));
	});

	test('Aktivitätstexte: Werkzeugereignisse werden verständlich zugeordnet', () => {
		const base = { step: 1, round: 2, maxRounds: 8 };
		const title = (activity: ToolActivity) => describeActivity(activity).title;
		assert.strictEqual(
			title({ ...base, tool: 'read_file', target: 'src/a.ts', status: 'success' }),
			'Datei gelesen: src/a.ts'
		);
		assert.strictEqual(
			title({ ...base, tool: 'search_text', target: '"foo" in **/*', status: 'success' }),
			'Projektweit gesucht: "foo"'
		);
		assert.strictEqual(
			title({ ...base, tool: 'search_text', target: '"foo" in src/a.ts', status: 'running' }),
			'Eingeschränkt wird gesucht: "foo" in src/a.ts'
		);
		assert.strictEqual(
			title({
				...base,
				tool: 'read_file_range',
				target: 'src/a.ts',
				status: 'budget-rejected',
				requestedRange: { firstLine: 10, lastLine: 20 }
			}),
			'Dateibereich wegen Budget nicht übernommen: src/a.ts (Zeilen 10-20 angefragt)'
		);
		assert.strictEqual(
			title({
				...base,
				tool: 'read_file_range',
				target: 'src/a.ts',
				status: 'success',
				requestedRange: { firstLine: 10, lastLine: 20 },
				deliveredRange: { firstLine: 10, lastLine: 12 }
			}),
			'Dateibereich gelesen: src/a.ts (Zeilen 10-20 angefragt, 10-12 geliefert)'
		);
		assert.strictEqual(
			title({ ...base, tool: 'read_file', target: 'src/a.ts', status: 'repeat-blocked' }),
			'Wiederholtes Lesen übersprungen: src/a.ts'
		);
		assert.strictEqual(
			title({ ...base, tool: 'list_directory', target: 'src', status: 'success' }),
			'Ordner aufgelistet: src'
		);
		const running = describeActivity({
			...base, tool: 'read_file', target: 'src/a.ts', status: 'running'
		});
		const done = describeActivity({
			...base, tool: 'read_file', target: 'src/a.ts', status: 'success'
		});
		assert.notStrictEqual(running.statusLabel, done.statusLabel);
		assert.notStrictEqual(running.title, done.title);

		const details = describeActivity({
			...base,
			tool: 'read_file_range',
			target: 'src/a.ts',
			status: 'failed',
			reason: 'Der Bereich überschreitet das Ergebnis-Bytebudget.',
			requestedRange: { firstLine: 1, lastLine: 120 },
			deliveredRange: null,
			requestBytesAdded: 5,
			hypotheticalRequestBytes: 6
		}).details.join('\n');
		assert.ok(details.includes('Werkzeug: read_file_range'));
		assert.ok(details.includes('Modellschritt 2 von 8; zählt zum Schrittlimit'));
		assert.ok(details.includes('Angefordert: Zeilen 1-120'));
		assert.ok(details.includes('Geliefert: keine Zeilen'));
		assert.ok(details.includes('Grund: Der Bereich überschreitet das Ergebnis-Bytebudget.'));
		assert.ok(details.includes('Zusätzliche Request-Bytes: 5'));
		assert.ok(describeActivity({
			step: 1, round: 0, maxRounds: 8, tool: 'read_file', target: 'a', status: 'success'
		}).details.join('\n').includes('zählt nicht zum Schrittlimit'));
	});

	test('Leseaktivität wird in der Webview chronologisch, unnummeriert und aufklappbar angezeigt', () => {
		const { log, sendState } = renderWebview(
			getChatHtml('live-tool-activity'),
			async () => {}
		);
		const view = (activity: ToolActivity) => describeActivity({
			round: 1, maxRounds: 8, ...activity
		});
		sendState({
			entries: [{ kind: 'user', text: 'Frage' }],
			activities: [
				view({ step: 1, tool: 'search_text', target: '"x" in **/*', status: 'success' }),
				view({ step: 2, tool: 'read_file_range', target: 'src/example.ts', status: 'running' })
			],
			busy: true,
			status: 'Lesewerkzeug: read_file_range'
		});
		assert.strictEqual(log.findAll('li').length, 2);
		const texts = () => log.findAll('span').map(node => node.textContent);
		assert.ok(texts().some(text => text.includes('Projektweit gesucht: "x"')));
		assert.ok(texts().some(text => text.includes('Dateibereich wird gelesen: src/example.ts')));
		assert.ok(texts().includes('läuft'));
		assert.ok(texts().includes('abgeschlossen'));
		// Keine zusätzliche Schrittnummer vor dem Titel (die Liste nummeriert selbst).
		assert.ok(!texts().some(text => /^[✓…✗!↷] \d+\./.test(text)));
		assert.ok(log.findAll('div').some(node =>
			node.textContent.startsWith('Modellschritte: 1 von 8')
		));
		const order = log.children.map(node => node.className);
		assert.ok(order.indexOf('msg user') < order.indexOf('activity'));
		assert.ok(order.indexOf('activity') < order.indexOf('') || order.at(-1) === '');
		assert.strictEqual(log.children.at(-1)?.getAttribute('role'), 'status');

		const step2 = log.findAll('details').find(d => d.getAttribute('data-step') === '2')!;
		step2.open = true;
		sendState({
			entries: [
				{ kind: 'user', text: 'Frage' },
				{ kind: 'answer', text: 'Antwort' }
			],
			activities: [
				view({ step: 1, tool: 'search_text', target: '"x" in **/*', status: 'success' }),
				view({
					step: 2,
					tool: 'read_file_range',
					target: 'src/example.ts',
					status: 'budget-rejected',
					reason: 'Ergebnis überschreitet das Anfragebudget; ein Hinweis wurde übermittelt.',
					requestedRange: { firstLine: 1, lastLine: 120 },
					requestBytesAdded: 12_000,
					hypotheticalRequestBytes: 33_000
				})
			],
			busy: false,
			status: ''
		});
		// Verlauf bleibt nach Abschluss sichtbar, über der Antwort; offener Schritt bleibt offen.
		const after = log.children.map(node => node.className);
		assert.ok(after.indexOf('activity') < after.indexOf('msg answer'));
		const reopened = log.findAll('details').find(d => d.getAttribute('data-step') === '2')!;
		assert.strictEqual(reopened.open, true);
		const rendered = log.findAll('div').map(node => node.textContent).join('\n');
		assert.ok(rendered.includes('Zusätzliche Request-Bytes: 12000'));
		assert.ok(rendered.includes('hypothetische Gesamtgröße: 33000 Bytes'));
		assert.ok(rendered.includes('Grund: Ergebnis überschreitet das Anfragebudget'));
		const spans = log.findAll('span');
		assert.ok(spans.some(node =>
			node.className === 'activity-symbol' && node.textContent === '!'
		));
		assert.ok(spans.some(node =>
			node.className === 'activity-title'
			&& node.textContent.startsWith('Dateibereich wegen Budget nicht übernommen')
			&& node.getAttribute('title') === node.textContent
		));
		assert.ok(!rendered.includes('Dateiinhalt'));
	});

	test('Timeline: kompakter Aktivitätenkopf zählt nur beobachtete Aufrufe', () => {
		const { log, sendState } = renderWebview(getChatHtml('counts'), async () => {});
		const view = (activity: ToolActivity) => describeActivity({ round: 1, maxRounds: 8, ...activity });
		sendState({
			entries: [{ kind: 'user', text: 'Frage' }],
			activities: [
				view({ step: 1, tool: 'search_text', target: '"x" in **/*', status: 'success' }),
				view({ step: 2, tool: 'read_file', target: 'a.ts', status: 'success' }),
				view({ step: 3, tool: 'read_file', target: 'b.ts', status: 'budget-rejected' }),
				view({ step: 4, tool: 'read_file', target: 'c.ts', status: 'failed' })
			],
			busy: false,
			status: ''
		});
		const counts = log.findAll('div').find(node => node.className === 'activity-counts');
		assert.strictEqual(
			counts?.textContent,
			'4 Aufrufe · 2 erfolgreich · 1 Budget · 1 fehlgeschlagen'
		);
		const rounds = log.findAll('div').find(node => node.className === 'activity-summary');
		assert.strictEqual(rounds?.textContent, 'Modellschritte: 1 von 8');
		assert.ok(rounds?.getAttribute('title')?.includes('nicht einzelne Aufrufe'));
	});

	test('Ergebniskarte: Ausgang aus der Zusammenfassung, sonst nur Zähler', () => {
		const { log, sendState } = renderWebview(getChatHtml('badges'), async () => {});
		const activities = [
			describeActivity({ step: 1, tool: 'read_file', target: 'a.ts', status: 'success' }),
			describeActivity({ step: 2, tool: 'read_file', target: 'b.ts', status: 'budget-rejected' })
		];
		const badgeTexts = () => log.findAll('span')
			.filter(node => node.className.split(' ').includes('badge'))
			.map(node => node.textContent);

		sendState({
			entries: [
				{ kind: 'user', text: 'Frage' },
				{ kind: 'answer', text: 'Antwort' },
				{ kind: 'summary', text: 'Zusammenfassung: teilweise\nAusgeführt (1):' }
			],
			activities, busy: false, status: ''
		});
		assert.deepStrictEqual(badgeTexts(), ['teilweise', '1 erfolgreich', '1 Budget']);

		sendState({
			entries: [{ kind: 'user', text: 'Frage' }, { kind: 'answer', text: 'Antwort' }],
			activities, busy: false, status: ''
		});
		assert.deepStrictEqual(badgeTexts(), ['1 erfolgreich', '1 Budget']);

		sendState({
			entries: [{ kind: 'user', text: 'Frage' }, { kind: 'answer', text: 'Antwort' }],
			activities: [], busy: false, status: ''
		});
		assert.deepStrictEqual(badgeTexts(), []);
	});

	test('Zusammenfassung ist einklappbar, kopierbar und bleibt beim Neuzeichnen offen', async () => {
		const copied: string[] = [];
		const { log, sendState } = renderWebview(
			getChatHtml('summary-details'),
			async text => { copied.push(text); }
		);
		const text = 'Zusammenfassung: erfolgreich\nAusgeführt (1):\n- Datei gelesen: a.ts';
		const state = {
			entries: [
				{ kind: 'user', text: 'Frage' },
				{ kind: 'answer', text: 'Antwort' },
				{ kind: 'summary', text }
			],
			busy: false,
			status: ''
		};
		sendState(state);
		const details = log.findAll('details').filter(d => d.className === 'summary-details');
		assert.strictEqual(details.length, 1);
		assert.strictEqual(details[0].open, false);
		assert.strictEqual(details[0].findAll('summary')[0].textContent, 'Zusammenfassung: erfolgreich');

		details[0].open = true;
		sendState(state);
		const reopened = log.findAll('details').filter(d => d.className === 'summary-details');
		assert.strictEqual(reopened[0].open, true);

		const [button] = reopened[0].findAll('button');
		assert.strictEqual(button.getAttribute('aria-label'), 'Zusammenfassung kopieren');
		await button.listeners.get('click')?.();
		assert.deepStrictEqual(copied, [text]);
	});

	test('Webview-CSS: Timeline, Statusfarben und schmale Breiten', () => {
		const html = getChatHtml('timeline-css');
		assert.ok(html.includes('.activity ol { list-style: none;'));
		assert.ok(html.includes('.activity li.failed::before'));
		assert.ok(html.includes('text-overflow: ellipsis'));
		assert.ok(html.includes('@media (max-width: 340px) { .activity .activity-status { display: none; } }'));
		assert.ok(html.includes('@media (max-width: 220px) { .activity .activity-counts { display: none; } }'));
	});

	test('Leseaktivität stellt Werkzeugdaten ausschließlich als Text dar', () => {
		const { log, sendState } = renderWebview(
			getChatHtml('safe-tool-activity'),
			async () => {}
		);
		const hostile = '<img src=x onerror=alert(1)>';
		sendState({
			entries: [],
			activities: [describeActivity({
				step: 1, tool: hostile, target: hostile, status: 'failed'
			})],
			busy: false,
			status: ''
		});
		assert.strictEqual(log.findAll('img').length, 0);
		assert.ok(log.findAll('span').some(node => node.textContent.includes(hostile)));
	});

	test('Aktivitätsverlauf kopiert alle Metadaten in Reihenfolge ohne Dateiinhalte', async () => {
		const copied: string[] = [];
		const { log, sendState } = renderWebview(
			getChatHtml('copy-activity'),
			async text => { copied.push(text); }
		);
		sendState({
			entries: [{ kind: 'user', text: 'Bitte prüfen' }],
			activities: [
				describeActivity({
					step: 0,
					round: 0,
					maxRounds: 8,
					tool: 'read_file',
					target: 'src/first.ts',
					status: 'success'
				}),
				describeActivity({
					step: 1,
					round: 1,
					maxRounds: 8,
					tool: 'read_file_range',
					target: 'src/blocked.ts',
					status: 'repeat-blocked',
					requestedRange: { firstLine: 2, lastLine: 4 },
					reason: 'Wiederholter Aufruf blockiert.'
				}),
				describeActivity({
					step: 2,
					round: 2,
					maxRounds: 8,
					tool: 'search_text',
					target: '"token" in src/**',
					status: 'budget-rejected',
					reason: 'Das Ergebnis überschreitet das Budget.',
					requestBytesAdded: 1200,
					hypotheticalRequestBytes: 30000
				}),
				describeActivity({
					step: 3,
					round: 3,
					maxRounds: 8,
					tool: 'read_file_range',
					target: 'src/range.ts',
					status: 'success',
					requestedRange: { firstLine: 5, lastLine: 10 },
					deliveredRange: { firstLine: 5, lastLine: 8 }
				})
			],
			busy: false,
			status: ''
		});

		const activity = log.findAll('section').find(section =>
			section.getAttribute('aria-label') === 'Aktivitätsverlauf'
		)!;
		const button = activity.findAll('button')[0];
		assert.ok(button);
		assert.strictEqual(button.getAttribute('aria-label'), 'Aktivitätsverlauf kopieren');
		await button.listeners.get('click')?.();

		assert.strictEqual(copied.length, 1);
		assert.ok(copied[0].indexOf('1. Datei gelesen: src/first.ts')
			< copied[0].indexOf('2. Wiederholtes Lesen übersprungen: src/blocked.ts'));
		assert.ok(copied[0].indexOf('2. Wiederholtes Lesen übersprungen: src/blocked.ts')
			< copied[0].indexOf('3. Suchergebnis wegen Budget nicht übernommen'));
		assert.ok(copied[0].includes('Vorab gelesene Datei; zählt nicht zum Schrittlimit.'));
		assert.ok(copied[0].includes('Angefordert: Zeilen 2-4'));
		assert.ok(copied[0].includes('Status: nicht übernommen (Budget)'));
		assert.ok(copied[0].includes('Grund: Das Ergebnis überschreitet das Budget.'));
		assert.ok(copied[0].includes('Modellschritt 2 von 8'));
		assert.ok(copied[0].includes('Angefordert: Zeilen 5-10'));
		assert.ok(copied[0].includes('Geliefert: Zeilen 5-8'));
		assert.ok(!copied[0].includes('Dateiinhalt'));
		assert.ok(!copied[0].includes('Modellgedanken'));
	});

	test('Ohne Werkzeugaktivitäten wird kein Aktivitätsverlauf-Kopierinhalt erzeugt', () => {
		const { log, sendState } = renderWebview(
			getChatHtml('copy-no-activity'),
			async () => {}
		);
		sendState({
			entries: [{ kind: 'user', text: 'Frage' }],
			activities: [],
			busy: false,
			status: ''
		});

		assert.strictEqual(log.findAll('section').some(section =>
			section.getAttribute('aria-label') === 'Aktivitätsverlauf'
		), false);
		assert.strictEqual(log.findAll('button').length, 1);
		assert.strictEqual(log.findAll('button')[0].getAttribute('aria-label'), 'Frage kopieren');
	});

	test('Kopieren verwendet nur den vollständigen Text der gewählten Antwort', async () => {
		const copied: string[] = [];
		const { log, sendState } = renderWebview(getChatHtml('copy-test'), async text => {
			copied.push(text);
		});
		sendState({
			entries: [
				{ kind: 'user', text: 'Nutzerfrage' },
				{ kind: 'answer', text: 'Erste Antwort' },
				{ kind: 'evidence', text: 'Werkzeugprotokoll' },
				{ kind: 'answer', text: 'Zweite Antwort\nmit vollständigem Text' }
			],
			busy: false,
			status: ''
		});

		const buttons = log.findAll('button');
		assert.strictEqual(buttons.length, 4);
		assert.deepStrictEqual(
			buttons.map(button => button.getAttribute('aria-label')),
			[
				'Frage kopieren',
				'Antwort kopieren',
				'Werkzeugprotokoll kopieren',
				'Antwort kopieren'
			]
		);
		assert.ok(buttons.every(button =>
			button.getAttribute('title') === button.getAttribute('aria-label')
			&& button.findAll('svg').length === 1
		));
		await buttons[3].listeners.get('click')?.();

		assert.deepStrictEqual(copied, ['Zweite Antwort\nmit vollständigem Text']);
		assert.strictEqual(buttons[3].textContent, '');
		assert.ok(log.findAll('div').some(node => node.textContent === 'Antwort wurde kopiert.'));
	});

	test('Werkzeugprotokoll-Kopierknöpfe kopieren jeweils nur den vollständigen Protokolltext', async () => {
		const copied: string[] = [];
		const { log, sendState, postedMessages } = renderWebview(
			getChatHtml('copy-tool-evidence'),
			async text => { copied.push(text); }
		);
		const protocols = [
			'Werkzeugprotokoll dieses Schritts\n- read_file src/a.ts: erfolgreich',
			'Werkzeugprotokoll dieses Schritts\n- search_text "x" in **/*: erfolgreich\nzusätzliche Diagnose'
		];
		sendState({
			entries: protocols.map(text => ({ kind: 'evidence', text })),
			busy: false,
			status: ''
		});

		const details = log.findAll('details');
		assert.strictEqual(details.length, protocols.length);
		for (let index = 0; index < details.length; index += 1) {
			const [button] = details[index].findAll('button');
			assert.ok(button);
			assert.strictEqual(button.getAttribute('aria-label'), 'Werkzeugprotokoll kopieren');
			assert.strictEqual(button.getAttribute('title'), 'Werkzeugprotokoll kopieren');
			assert.strictEqual(button.findAll('svg').length, 1);
			await button.listeners.get('click')?.();
		}

		assert.deepStrictEqual(copied, protocols);
		assert.deepStrictEqual(postedMessages, []);
		assert.strictEqual(
			log.findAll('div').filter(node =>
				node.textContent === 'Werkzeugprotokoll wurde kopiert.'
			).length,
			protocols.length
		);
	});

	test('Fehler beim Kopieren eines Werkzeugprotokolls werden am Protokoll gemeldet', async () => {
		const { log, sendState } = renderWebview(
			getChatHtml('copy-tool-evidence-error'),
			async () => { throw new Error('Zugriff verweigert.'); }
		);
		sendState({
			entries: [{ kind: 'evidence', text: 'Vollständiges Werkzeugprotokoll' }],
			busy: false,
			status: ''
		});

		const [button] = log.findAll('button');
		assert.ok(button);
		await button.listeners.get('click')?.();

		assert.strictEqual(button.disabled, false);
		assert.ok(log.findAll('div').some(node =>
			node.textContent === 'Kopieren fehlgeschlagen: Zugriff verweigert.'
		));
	});

	test('Systemprüfung- und Antwort-Kopierknopf kopieren jeweils nur ihren Eintrag', async () => {
		const copied: string[] = [];
		const { log, sendState } = renderWebview(getChatHtml('system-copy'), async text => {
			copied.push(text);
		});
		sendState({
			entries: [
				{ kind: 'user', text: 'Nutzerfrage' },
				{ kind: 'system', text: 'Systemprüfung\nSYSTEM BEREIT' },
				{ kind: 'answer', text: 'Bubble-Antwort' }
			],
			busy: false,
			status: ''
		});

		const buttons = log.findAll('button');
		assert.strictEqual(buttons.length, 3);
		assert.deepStrictEqual(
			buttons.map(button => button.getAttribute('aria-label')),
			['Frage kopieren', 'Systemprüfung kopieren', 'Antwort kopieren']
		);
		assert.deepStrictEqual(
			buttons.map(button => button.getAttribute('title')),
			['Frage kopieren', 'Systemprüfung kopieren', 'Antwort kopieren']
		);

		await buttons[1].listeners.get('click')?.();
		await buttons[2].listeners.get('click')?.();

		assert.deepStrictEqual(copied, [
			'Systemprüfung\nSYSTEM BEREIT',
			'Bubble-Antwort'
		]);
		assert.ok(log.findAll('div').some(node =>
			node.textContent === 'Systemprüfung wurde kopiert.'
		));
		assert.ok(log.findAll('div').some(node =>
			node.textContent === 'Antwort wurde kopiert.'
		));
	});

	test('Kopieren bleibt allen sichtbaren Texteingrägen einzeln zugeordnet', async () => {
		const copied: string[] = [];
		const { log, sendState } = renderWebview(getChatHtml('copy-entry-kinds'), async text => {
			copied.push(text);
		});
		const entries = [
			{ kind: 'user', text: 'Frage mit vollständigem Text' },
			{ kind: 'answer', text: 'Antwort mit vollständigem Text' },
			{ kind: 'system', text: 'Systemprüfung mit vollständigem Text' },
			{ kind: 'error', text: 'Fehler mit vollständigem Text' },
			{ kind: 'limit', text: 'Kontextgrenze mit vollständigem Text' },
			{ kind: 'info', text: 'Hinweis mit vollständigem Text' },
			{ kind: 'systemError', text: 'Systemfehler mit vollständigem Text' }
		];
		sendState({ entries, busy: false, status: '' });
		const buttons = log.findAll('button');

		assert.strictEqual(buttons.length, entries.length);
		assert.deepStrictEqual(
			buttons.map(button => button.getAttribute('aria-label')),
			[
				'Frage kopieren',
				'Antwort kopieren',
				'Systemprüfung kopieren',
				'Fehler kopieren',
				'Kontextgrenze kopieren',
				'Hinweis kopieren',
				'Systemprüfung kopieren'
			]
		);
		assert.ok(buttons.every(button =>
			button.getAttribute('title') === button.getAttribute('aria-label')
		));
		for (const button of buttons) {
			await button.listeners.get('click')?.();
		}
		assert.deepStrictEqual(copied, entries.map(entry => entry.text));
	});

	test('Einfügen ersetzt Auswahl an der Cursorposition und sendet keine Frage', async () => {
		const { input, paste, pasteFeedback, postedMessages } = renderWebview(
			getChatHtml('paste'),
			async () => {},
			async () => ' Clipboard'
		);
		input.value = 'HalloWelt';
		input.selectionStart = 5;
		input.selectionEnd = 5;
		assert.ok(getChatHtml('paste-type').includes(
			'<button type="button" id="paste" class="secondary">Einfügen</button>'
		));

		await paste.listeners.get('click')?.();

		assert.strictEqual(input.value, 'Hallo ClipboardWelt');
		assert.strictEqual(input.selectionStart, 15);
		assert.strictEqual(input.selectionEnd, 15);
		assert.strictEqual(pasteFeedback.textContent, 'Text wurde eingefügt.');
		assert.deepStrictEqual(postedMessages, []);
	});

	test('Einfügen meldet Fehler bei fehlender Zwischenablageberechtigung', async () => {
		const { paste, pasteFeedback } = renderWebview(
			getChatHtml('paste-error'),
			async () => {},
			async () => { throw new Error('Zugriff verweigert.'); }
		);
		await paste.listeners.get('click')?.();
		assert.strictEqual(
			pasteFeedback.textContent,
			'Einfügen fehlgeschlagen: Zugriff verweigert.'
		);
		assert.strictEqual(pasteFeedback.className, 'error');
	});

	test('Icon-Kopierbutton hat zugänglichen Namen und responsives Antwort-/Aktionslayout', () => {
		const html = getChatHtml('responsive');
		const { log, sendState } = renderWebview(html, async () => {});
		sendState({ entries: [{ kind: 'answer', text: 'Antwort' }], busy: false, status: '' });

		const answer = log.findAll('section')[0];
		const button = log.findAll('button')[0];
		assert.strictEqual(button.getAttribute('aria-label'), 'Antwort kopieren');
		assert.strictEqual(button.getAttribute('title'), 'Antwort kopieren');
		assert.deepStrictEqual(answer.children.map(child => child.tagName), [
			'div', 'div', 'button', 'div'
		]);
		assert.ok(html.includes('.msg { position: relative;'));
		assert.ok(html.includes('.copy-button { position: absolute; top: 6px; right: 6px;'));
		assert.ok(html.includes('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)'));
		assert.ok(html.includes('@media (max-width: 340px)'));
		assert.ok(html.includes('@media (max-width: 220px)'));
		assert.ok(html.includes('#composer { box-sizing: border-box; width: 100%; min-width: 0;'));
	});

	test('Kopierfehler werden verständlich und direkt an der Antwort gemeldet', async () => {
		const { log, sendState } = renderWebview(getChatHtml('copy-error'), async () => {
			throw new Error('Zugriff verweigert.');
		});
		sendState({ entries: [{ kind: 'answer', text: 'Antwort' }], busy: false, status: '' });

		const button = log.findAll('button')[0];
		await button.listeners.get('click')?.();

		assert.ok(log.findAll('div').some(node =>
			node.textContent === 'Kopieren fehlgeschlagen: Zugriff verweigert.'
		));
		assert.strictEqual(button.disabled, false);
	});

	test('Antworttext mit HTML-Zeichen wird ausschließlich als Text dargestellt', () => {
		const answer = '<img src=x onerror="alert(1)"> & unverändert';
		const { log, sendState } = renderWebview(getChatHtml('safe-test'), async () => {});
		sendState({ entries: [{ kind: 'answer', text: answer }], busy: false, status: '' });

		const body = log.findAll('div').find(node => node.className === 'body');
		assert.strictEqual(body?.textContent, answer);
		assert.strictEqual(log.findAll('img').length, 0);
	});
});
