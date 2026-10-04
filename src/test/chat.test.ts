import * as assert from 'assert';
import { runInNewContext } from 'node:vm';
import * as vscode from 'vscode';
import { AgentCancelledError, RequestTooLargeError, runReadOnlyAgent } from '../agent/readOnlyAgent.js';
import type { AgentResult, ConversationTurn } from '../agent/readOnlyAgent.js';
import { ChatSession, type AgentRunner } from '../chat/chatSession.js';
import {
	getChatHtml,
	getChatWorkspaceName,
	handleChatMessage
} from '../chat/chatView.js';

const ok = (answer: string): AgentResult => ({
	answer,
	evidence: [{ tool: 'read_file', target: 'a.ts', success: true }],
	omitted: 0
});

class WebviewElement {
	readonly children: WebviewElement[] = [];
	readonly listeners = new Map<string, (event?: { data?: unknown }) => unknown>();
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

	addEventListener(name: string, listener: (event?: { data?: unknown }) => unknown): void {
		this.listeners.set(name, listener);
	}

	querySelectorAll(selector: string): WebviewElement[] {
		const matches: WebviewElement[] = [];
		for (const child of this.children) {
			if (selector === 'details.tools'
				&& child.tagName === 'details'
				&& child.className.split(' ').includes('tools')) {
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
	for (const id of ['log', 'workspace-name', 'input', 'send', 'system-check', 'paste', 'paste-feedback', 'composer', 'reset', 'end']) {
		elements.set(id, new WebviewElement('div'));
	}
	elements.get('workspace-name')!.textContent = 'Kein Workspace geöffnet';
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

	test('Webview-HTML: Struktur, Arbeitsstatus, aufklappbares Protokoll und Themefarben', () => {
		const html = getChatHtml('n1');
		assert.ok(html.includes("createElement('details')") || html.includes("el('details'"));
		assert.ok(html.includes("el('summary', '', 'Werkzeugprotokoll')"));
		assert.ok(html.includes("setAttribute('role', 'status')"));
		assert.ok(html.includes('Bubble arbeitet'));
		assert.ok(html.includes('prefers-reduced-motion'));
		assert.ok(html.includes('var(--vscode-button-background)'));
		assert.ok(html.includes('var(--vscode-focusBorder)'));
		for (const label of ['Fragen', 'Gespräch zurücksetzen', 'Beenden']) {
			assert.ok(html.includes(`>${label}</button>`), label);
		}
		assert.ok(!/\son(click|submit|keydown|load)=/i.test(html));
		assert.ok(!html.includes('<script src'));
		assert.ok(!html.includes('insertAdjacentHTML'));
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
		assert.strictEqual(buttons.length, 3);
		assert.deepStrictEqual(
			buttons.map(button => button.getAttribute('aria-label')),
			['Frage kopieren', 'Antwort kopieren', 'Antwort kopieren']
		);
		assert.ok(buttons.every(button =>
			button.getAttribute('title') === button.getAttribute('aria-label')
			&& button.findAll('svg').length === 1
		));
		await buttons[2].listeners.get('click')?.();

		assert.deepStrictEqual(copied, ['Zweite Antwort\nmit vollständigem Text']);
		assert.strictEqual(buttons[2].textContent, '');
		assert.ok(log.findAll('div').some(node => node.textContent === 'Antwort wurde kopiert.'));
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
