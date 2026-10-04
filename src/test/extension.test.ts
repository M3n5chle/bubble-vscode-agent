import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import {
	MAX_PROMPT_BYTES,
	MAX_SELECTED_FILES,
	analyzeWithLimit,
	buildPrompt,
	listSelectableFiles,
	pickFilesFromWorkspace,
	readSelectedFiles,
	validateSelection
} from '../agent/analyzeSelectedFiles.js';
import {
	PreviewContentProvider,
	prepareAIDiffPreview,
	prepareDiffPreview,
	showDiffPreview
} from '../agent/diffPreview.js';
import { checkFilePath } from '../agent/analyzeCurrentFile.js';
import {
	applyIfApproved,
	decideApply,
	type ChangeWriter
} from '../agent/applyDecision.js';
import { resolveWorkspaceUri, runSystemCheck } from '../extension.js';
import { readProjectFile, searchProjectText } from '../tools/readTools.js';
import {
	MAX_REQUEST_BYTES,
	RequestTooLargeError,
	formatEvidence,
	getReadOnlyTools,
	runReadOnlyAgent
} from '../agent/readOnlyAgent.js';
import { END_CHOICE, FOLLOW_UP_CHOICE, RESET_CHOICE } from '../extension.js';
import {
	validatePlanOutput,
	buildPlanPrompt,
	formatPlanResponse
} from '../agent/planChange.js';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Workspace-Auflösung: ohne Workspace kein Fallback, mit Workspace der erste Ordner', () => {
		assert.strictEqual(resolveWorkspaceUri(undefined), undefined);
		assert.strictEqual(resolveWorkspaceUri([]), undefined);

		const root = vscode.workspace.workspaceFolders![0];
		assert.strictEqual(
			resolveWorkspaceUri(vscode.workspace.workspaceFolders)?.toString(),
			root.uri.toString()
		);
	});

	test('Systemprüfung: fehlende Regeldateien verhindern Bereitschaft nicht', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-norules-'));
		const originalFetch = globalThis.fetch;
		const run = async (models: string[] | 'down') => {
			globalThis.fetch = (async () => {
				if (models === 'down') {
					throw new Error('Ollama-Mock nicht erreichbar');
				}
				return new Response(JSON.stringify({ models: models.map(name => ({ name })) }));
			}) as typeof fetch;
			const lines: string[] = [];
			const output = {
				appendLine: (line: string) => { lines.push(line); },
				clear: () => { lines.length = 0; },
				show: () => { }
			} as unknown as vscode.OutputChannel;
			const ready = await runSystemCheck(output, vscode.Uri.file(dir));
			return { ready, text: lines.join('\n') };
		};
		try {
			assert.deepStrictEqual(fs.readdirSync(dir), []);

			const ok = await run(['qwen3:14b']);
			assert.strictEqual(ok.ready, true);
			for (const name of ['AGENTS.md', 'AGENT_RULES.md', 'PROJECT_STATE.md']) {
				assert.ok(ok.text.includes(`FEHLT (optional): ${name}`));
			}
			assert.ok(ok.text.includes('SYSTEM BEREIT'));

			assert.strictEqual((await run(['andere:1b'])).ready, false);
			assert.strictEqual((await run('down')).ready, false);
		} finally {
			globalThis.fetch = originalFetch;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Aktuelle Datei: Allowlist und Sperren gelten wie bei den anderen Lesewegen', () => {
		const root = vscode.workspace.workspaceFolders![0].uri;
		const check = (name: string) =>
			checkFilePath(root, vscode.Uri.joinPath(root, name));

		const markdown = check('README.md');
		assert.strictEqual(markdown.allowed, true);

		const extensionless = check('id_rsa');
		assert.strictEqual(extensionless.allowed, false);
		assert.ok(
			extensionless.reason?.includes('nicht als Textdatei freigegeben')
		);

		const pem = check('server.pem');
		assert.strictEqual(pem.allowed, false);
		assert.ok(pem.reason?.includes('nicht als Textdatei freigegeben'));

		assert.strictEqual(check('.env').allowed, false);
		assert.strictEqual(check('node_modules/x.js').allowed, false);
		assert.strictEqual(
			checkFilePath(
				root,
				vscode.Uri.joinPath(root, '..', 'outside.md')
			).allowed,
			false
		);
	});

	test('Ausgewählte Dateien: gesperrte und externe Pfade werden abgelehnt', async () => {
		const root = vscode.workspace.workspaceFolders![0].uri;
		const result = await readSelectedFiles(root, [
			vscode.Uri.joinPath(root, '.env'),
			vscode.Uri.joinPath(root, 'node_modules', 'x.js'),
			vscode.Uri.joinPath(root, '..', 'outside.txt'),
			vscode.Uri.joinPath(root, 'package.json')
		]);

		assert.strictEqual(MAX_SELECTED_FILES, 5);
		assert.strictEqual(result.rejected.length, 3);
		assert.deepStrictEqual(
			result.files.map((file) => file.relativePath),
			['package.json']
		);
	});

	test('Auswahlliste: Dateien aus zwei Unterordnern, gesperrte, fremde und verlinkte Einträge fehlen', async function () {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-pick-'));
		try {
			fs.mkdirSync(path.join(dir, 'a'));
			fs.mkdirSync(path.join(dir, 'b'));
			fs.mkdirSync(path.join(dir, 'node_modules'));
			fs.writeFileSync(path.join(dir, 'a', 'index.md'), 'A');
			fs.writeFileSync(path.join(dir, 'b', 'index.md'), 'B');
			fs.writeFileSync(path.join(dir, 'b', 'image.png'), 'x');
			fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
			fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'x');
			fs.writeFileSync(path.join(dir, 'outside.md'), 'O');
			try {
				fs.symlinkSync(path.join(dir, 'outside.md'), path.join(dir, 'a', 'link.md'));
				fs.symlinkSync(path.join(dir, 'b'), path.join(dir, 'linkdir'), 'junction');
			} catch {
				// Ohne Symlink-Recht entfallen nur die Link-Prüfungen.
			}

			const root = vscode.Uri.file(dir);
			const listed = (await listSelectableFiles(root)).map(file => file.relativePath);
			assert.deepStrictEqual(listed, ['a/index.md', 'b/index.md', 'outside.md']);

			const win = vscode.window as unknown as Record<string, unknown>;
			const originalPick = win.showQuickPick;
			let shownLabels: string[] = [];
			try {
				win.showQuickPick = async (items: Array<{ label: string; uri: vscode.Uri }>, options: vscode.QuickPickOptions) => {
					assert.strictEqual(options.canPickMany, true);
					shownLabels = items.map(item => item.label);
					return items.slice(0, 2);
				};
				const picked = await pickFilesFromWorkspace(root);
				assert.deepStrictEqual(shownLabels, listed);
				assert.deepStrictEqual(
					picked?.map(uri => path.relative(dir, uri.fsPath).replaceAll('\\', '/')),
					['a/index.md', 'b/index.md']
				);
				const validation = await validateSelection(root, picked!);
				assert.strictEqual(validation.ok, true);

				win.showQuickPick = async () => undefined;
				assert.strictEqual(await pickFilesFromWorkspace(root), undefined);
			} finally {
				win.showQuickPick = originalPick;
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Ausgewählte Dateien: Abbruch in der Auswahlliste fragt nichts und ruft Ollama nicht auf', async () => {
		await vscode.extensions.getExtension('undefined_publisher.bubble-vscode-agent')?.activate();

		const win = vscode.window as unknown as Record<string, unknown>;
		const originalPick = win.showQuickPick;
		const originalInfo = win.showInformationMessage;
		const originalInput = win.showInputBox;
		const originalFetch = globalThis.fetch;
		let dialogCalls = 0;
		let fetchCalls = 0;
		win.showQuickPick = async () => undefined;
		win.showInformationMessage = async () => { dialogCalls += 1; return undefined; };
		win.showInputBox = async () => { dialogCalls += 1; return undefined; };
		globalThis.fetch = (async () => { fetchCalls += 1; return new Response('{}'); }) as typeof fetch;

		try {
			await vscode.commands.executeCommand('bubble-vscode-agent.analyzeSelectedFiles');
			assert.strictEqual(dialogCalls, 0);
			assert.strictEqual(fetchCalls, 0);
		} finally {
			win.showQuickPick = originalPick;
			win.showInformationMessage = originalInfo;
			win.showInputBox = originalInput;
			globalThis.fetch = originalFetch;
		}
	});

	test('Auswahl: README.md zusammen mit .env lehnt die gesamte Auswahl ab', async () => {
		const root = vscode.workspace.workspaceFolders![0].uri;
		const result = await validateSelection(root, [
			vscode.Uri.joinPath(root, 'README.md'),
			vscode.Uri.joinPath(root, '.env')
		]);

		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.strictEqual(result.kind, 'rejected');
			assert.ok(result.message.includes('.env'));
		}
	});

	test('Auswahl: mehr als fünf Dateien werden abgelehnt', async () => {
		const root = vscode.workspace.workspaceFolders![0].uri;
		const uris = Array.from(
			{ length: MAX_SELECTED_FILES + 1 },
			(_, i) => vscode.Uri.joinPath(root, `file${i}.md`)
		);
		const result = await validateSelection(root, uris);

		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.strictEqual(result.kind, 'tooMany');
		}
	});

	test('Promptgrenze: genau 8000 Bytes gehen durch, 8001 nicht und ohne Ollama-Aufruf', async () => {
		assert.strictEqual(MAX_PROMPT_BYTES, 8000);

		const question = 'Frage mit Umlauten: äöü?';
		const promptBytes = (content: string) =>
			Buffer.byteLength(
				buildPrompt([{ relativePath: 'a.md', content }], question),
				'utf8'
			);
		const baseBytes = promptBytes('');
		const filesWith = (content: string) => [{ relativePath: 'a.md', content }];

		let calls = 0;
		const ask = async () => {
			calls++;
			return 'ok';
		};

		// Mehrbyte-Zeichen: 'ä' belegt 2 Bytes, die Grenze zählt Bytes, nicht Zeichen.
		const multiByte = 'ä'.repeat((MAX_PROMPT_BYTES - baseBytes - 1) / 2 | 0);
		assert.ok(promptBytes(multiByte) < MAX_PROMPT_BYTES);
		const under = await analyzeWithLimit(filesWith(multiByte), question, ask);
		assert.strictEqual(under.ok, true);
		assert.strictEqual(calls, 1);

		const atLimitContent = 'x'.repeat(MAX_PROMPT_BYTES - baseBytes);
		assert.strictEqual(promptBytes(atLimitContent), MAX_PROMPT_BYTES);
		const atLimit = await analyzeWithLimit(filesWith(atLimitContent), question, ask);
		assert.strictEqual(atLimit.ok, true);
		assert.strictEqual(calls, 2);
		const overFiles = filesWith(atLimitContent + 'x');
		assert.strictEqual(Buffer.byteLength(buildPrompt(overFiles, question), 'utf8'), MAX_PROMPT_BYTES + 1);
		const over = await analyzeWithLimit(overFiles, question, ask);
		assert.strictEqual(over.ok, false);
		assert.strictEqual(calls, 2);
		if (!over.ok) {
			assert.ok(over.message.includes('weniger oder kleinere Dateien'));
			assert.ok(over.message.includes('konservative Produktgrenze'));
			assert.ok(over.message.includes('keine Garantie'));
		}
	});

	test('Promptgrenze: Pfade und Frage zählen mit, und fetch wird bei Überschreitung nicht aufgerufen', async () => {
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			return new Response('{}');
		}) as typeof fetch;
		try {
			const result = await analyzeWithLimit(
				[{ relativePath: 'a.md', content: 'x' }],
				'q'.repeat(MAX_PROMPT_BYTES)
			);
			assert.strictEqual(result.ok, false);
			assert.strictEqual(fetchCalls, 0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('Dateileser erlaubt Markdown und lehnt PNG sowie Dateien ohne Endung ab', async () => {
		const root = vscode.workspace.workspaceFolders![0].uri;

		const markdown = await readProjectFile(root, 'README.md');
		assert.strictEqual(markdown.success, true);
		assert.ok(markdown.content.includes('# Bubble'));

		const png = await readProjectFile(root, 'not-present.png');
		assert.strictEqual(png.success, false);
		assert.ok(png.content.includes('nicht als Textdatei freigegeben'));

		const extensionless = await readProjectFile(
			root,
			'not-present'
		);
		assert.strictEqual(extensionless.success, false);
		assert.ok(
			extensionless.content.includes(
				'nicht als Textdatei freigegeben'
			)
		);
	});

	test('Symlinks im Workspace auf externe Ziele werden abgelehnt', async function () {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-link-'));
		const ws = path.join(base, 'ws');
		const outside = path.join(base, 'outside');
		fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, 'secret.txt'), 'GEHEIM');
		fs.writeFileSync(path.join(ws, 'normal.txt'), 'ok-normal');

		try {
			try {
				fs.symlinkSync(
					path.join(outside, 'secret.txt'),
					path.join(ws, 'link.txt'),
					'file'
				);
				fs.symlinkSync(outside, path.join(ws, 'dirlink'), 'junction');
			} catch (error) {
				console.warn(
					'Symlink-Test NICHT AUSGEFÜHRT: Link konnte nicht angelegt werden: '
					+ String(error)
				);
				this.skip();
				return;
			}

			const wsUri = vscode.Uri.file(ws);

			const normal = await readProjectFile(wsUri, 'normal.txt');
			assert.strictEqual(normal.success, true);
			assert.ok(normal.content.includes('ok-normal'));

			const file = await readProjectFile(wsUri, 'link.txt');
			assert.strictEqual(file.success, false);
			assert.ok(!file.content.includes('GEHEIM'));

			const viaDir = await readProjectFile(wsUri, 'dirlink/secret.txt');
			assert.strictEqual(viaDir.success, false);
			assert.ok(!viaDir.content.includes('GEHEIM'));

			const selection = await readSelectedFiles(wsUri, [
				vscode.Uri.file(path.join(ws, 'link.txt')),
				vscode.Uri.file(path.join(ws, 'dirlink', 'secret.txt')),
				vscode.Uri.file(path.join(ws, 'normal.txt'))
			]);
			assert.strictEqual(selection.rejected.length, 2);
			assert.deepStrictEqual(
				selection.files.map((f) => f.relativePath),
				['normal.txt']
			);

		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});

	test('Textsuche im geöffneten Workspace: Link auf externe Datei ist kein Treffer', async function () {
		const root = vscode.workspace.workspaceFolders![0].uri;
		const fixtureName = `.bubble-link-search-${process.pid}-${Date.now()}`;
		const fixture = path.join(root.fsPath, fixtureName);
		const outside = fs.mkdtempSync(
			path.join(os.tmpdir(), 'bubble-outside-')
		);
		const needle = 'BUBBLE_NEEDLE_4711';

		try {
			fs.mkdirSync(fixture);
			fs.writeFileSync(path.join(outside, 'secret.txt'), needle);
			fs.writeFileSync(path.join(fixture, 'normal.txt'), needle);

			try {
				fs.symlinkSync(
					path.join(outside, 'secret.txt'),
					path.join(fixture, 'link.txt'),
					'file'
				);
				fs.symlinkSync(
					outside,
					path.join(fixture, 'dirlink'),
					'junction'
				);
			} catch (error) {
				console.warn(
					'Such-Test NICHT AUSGEFÜHRT: Link konnte nicht angelegt werden: '
					+ String(error)
				);
				this.skip();
				return;
			}

			const pattern = `${fixtureName}/**/*`;

			// Belegt, dass VS Code die Links selbst liefert und der Filter greift.
			const found = (
				await vscode.workspace.findFiles(
					new vscode.RelativePattern(
						vscode.workspace.workspaceFolders![0],
						pattern
					)
				)
			).map((uri) => path.basename(uri.fsPath));
			console.log(`findFiles lieferte: ${found.join(', ')}`);

			const result = await searchProjectText(root, needle, pattern);

			assert.strictEqual(result.success, true);
			assert.ok(
				result.content.includes(`${fixtureName}/normal.txt`),
				'normale Datei muss gefunden werden'
			);
			assert.ok(!result.content.includes('link.txt'));
			assert.ok(!result.content.includes('dirlink'));
			assert.ok(!result.content.includes('secret.txt'));
		} finally {
			fs.rmSync(fixture, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test('Workspace-Root, der selbst ein Link ist, wird abgelehnt', async function () {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-root-'));
		const real = path.join(base, 'real');
		const rootLink = path.join(base, 'rootlink');
		fs.mkdirSync(real);
		fs.writeFileSync(path.join(real, 'normal.txt'), 'ok-normal');

		try {
			try {
				fs.symlinkSync(real, rootLink, 'junction');
			} catch (error) {
				console.warn(
					'Root-Link-Test NICHT AUSGEFÜHRT: Link konnte nicht angelegt werden: '
					+ String(error)
				);
				this.skip();
				return;
			}

			const viaReal = await readProjectFile(
				vscode.Uri.file(real),
				'normal.txt'
			);
			assert.strictEqual(viaReal.success, true);

			const viaLink = await readProjectFile(
				vscode.Uri.file(rootLink),
				'normal.txt'
			);
			assert.strictEqual(viaLink.success, false);
			assert.ok(!viaLink.content.includes('ok-normal'));
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	function snapshot(dir: string): string {
		const entries: string[] = [];
		const walk = (d: string) => {
			for (const name of fs.readdirSync(d).sort()) {
				const p = path.join(d, name);
				const st = fs.lstatSync(p);
				if (st.isDirectory()) {
					entries.push(`D:${path.relative(dir, p)}`);
					walk(p);
				} else {
					entries.push(`F:${path.relative(dir, p)}:${st.size}:${st.mtimeMs}:${fs.readFileSync(p, 'utf8')}`);
				}
			}
		};
		walk(dir);
		return entries.join('\n');
	}

	function diffTabCount(): number {
		return vscode.window.tabGroups.all
			.flatMap(group => group.tabs)
			.filter(tab => tab.input instanceof vscode.TabInputTextDiff).length;
	}

	async function waitFor(condition: () => boolean): Promise<boolean> {
		for (let i = 0; i < 40 && !condition(); i++) {
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		return condition();
	}

	test('Diff-Vorschau: Vorschau und Abbruch verändern keine Datei', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-diff-'));
		fs.writeFileSync(path.join(dir, 'a.txt'), 'alt\n');
		fs.writeFileSync(path.join(dir, 'x.exe'), 'MZ');
		const before = snapshot(dir);
		const wsUri = vscode.Uri.file(dir);
		const scheme = 'bubble-preview-test';
		const provider = new PreviewContentProvider(scheme);
		const registration = vscode.workspace.registerTextDocumentContentProvider(scheme, provider);

		try {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');

			// Zweimal hintereinander: der Vorschau-Tab wird ersetzt, der alte Text freigegeben
			for (const proposed of ['neu\n', 'noch neuer\n']) {
				const prepared = await prepareDiffPreview(wsUri, 'a.txt', proposed);
				assert.ok(prepared.ok);
				assert.strictEqual(prepared.original, 'alt\n');
				await showDiffPreview(provider, prepared);
				if (proposed === 'noch neuer\n') {
					assert.strictEqual(
						Reflect.set(prepared, 'proposed', 'ausgetauscht\n'),
						false,
						'angezeigter Vorschlag darf nicht austauschbar sein'
					);
					assert.strictEqual(
						Reflect.set(prepared.originalBytes, '0', 0),
						false,
						'Originalbytes der Vorschau dürfen nicht veränderbar sein'
					);
					assert.strictEqual(prepared.proposed, proposed);
				}
			}
			assert.strictEqual(diffTabCount(), 1);
			assert.ok(await waitFor(() => provider.size === 2), 'alte Vorschau nicht freigegeben');

			// Die Anzeige liest die In-Memory-Inhalte, nicht die Datei
			const proposedDoc = vscode.workspace.textDocuments.find(
				d => d.uri.scheme === scheme && d.getText() === 'noch neuer\n'
			);
			assert.ok(proposedDoc);

			// Nichts auf der Platte verändert, kein Dokument der Datei geöffnet oder dirty
			assert.strictEqual(snapshot(dir), before);
			assert.ok(!vscode.workspace.textDocuments.some(
				d => d.uri.scheme === 'file' && d.uri.fsPath.startsWith(dir)
			));
			assert.ok(!vscode.workspace.textDocuments.some(d => d.isDirty));

			// Abbruch: Tabs schließen, Inhalte werden freigegeben
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			assert.strictEqual(diffTabCount(), 0);
			assert.ok(await waitFor(() => provider.size === 0), 'Provider gibt Inhalte nicht frei');
			assert.strictEqual(snapshot(dir), before);

			// Abgelehnte Fälle ändern ebenfalls nichts
			for (const bad of ['.env', 'node_modules/a.txt', '../a.txt', 'x.exe', 'fehlt.txt', 'sub']) {
				const r = await prepareDiffPreview(wsUri, bad, 'neu');
				assert.strictEqual(r.ok, false, bad);
			}
			assert.strictEqual(snapshot(dir), before);
		} finally {
			registration.dispose();
			provider.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('KI-Diff-Vorschau: Ollama-Vorschlag erscheint nur im Diff und Ablehnung oder Fehler ändern keine Datei', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-ai-diff-'));
		const filePath = path.join(dir, 'a.txt');
		fs.writeFileSync(filePath, 'alter Inhalt\n');
		const before = snapshot(dir);
		const originalFetch = globalThis.fetch;
		const wsUri = vscode.Uri.file(dir);
		const scheme = 'bubble-ai-preview-test';
		const provider = new PreviewContentProvider(scheme);
		const registration = vscode.workspace.registerTextDocumentContentProvider(scheme, provider);
		const suggestion = '```md\n# neuer Inhalt\n```\n';

		try {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			let requestBody: Record<string, unknown> | undefined;
			globalThis.fetch = (async (_input, init) => {
				requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(JSON.stringify({
					message: { content: JSON.stringify({ content: suggestion }) }
				}));
			}) as typeof fetch;

			const prepared = await prepareAIDiffPreview(
				wsUri,
				'a.txt',
				'Ersetze den Inhalt.'
			);
			assert.ok(prepared.ok);
			assert.strictEqual(prepared.original, 'alter Inhalt\n');
			assert.strictEqual(prepared.proposed, suggestion);
			const messages = requestBody?.messages as Array<{ content: string }>;
			assert.strictEqual(requestBody?.model, 'qwen3:14b');
			assert.deepStrictEqual(requestBody?.format, {
				type: 'object',
				properties: { content: { type: 'string' } },
				required: ['content'],
				additionalProperties: false
			});
			assert.strictEqual(messages.length, 1);
			assert.ok(messages[0].content.includes('alter Inhalt\n'));
			assert.ok(messages[0].content.includes('Ersetze den Inhalt.'));

			await showDiffPreview(provider, prepared);
			assert.ok(await waitFor(() => vscode.workspace.textDocuments.some(
				document => document.uri.scheme === scheme && document.getText() === suggestion
			)), 'Ollama-Vorschlag erscheint nicht im Diff');
			assert.strictEqual(snapshot(dir), before);

			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			assert.ok(await waitFor(() => provider.size === 0));

			for (const malformed of [
				{ name: 'leerer Inhalt', response: JSON.stringify({ content: '' }) },
				{ name: 'Erklärungstext', response: 'Hier ist der vollständige Inhalt.' },
				{
					name: 'Erklärung vor Codeblock',
					response: 'Hier ist die Datei:\n```txt\ninhalt\n```'
				},
				{ name: 'Codeblock statt Struktur', response: '```txt\ninhalt\n```' },
				{
					name: 'zusätzliches Feld',
					response: JSON.stringify({ content: 'inhalt', note: 'unerwartet' })
				}
			]) {
				globalThis.fetch = (async () => new Response(JSON.stringify({
					message: { content: malformed.response }
				}))) as typeof fetch;
				const rejected = await prepareAIDiffPreview(
					wsUri,
					'a.txt',
					'Ändere die Datei.'
				);
				assert.strictEqual(rejected.ok, false, malformed.name);
				assert.strictEqual(snapshot(dir), before, malformed.name);
				assert.strictEqual(diffTabCount(), 0, malformed.name);
			}

			globalThis.fetch = (async () => new Response(JSON.stringify({
				message: {
					content: JSON.stringify({ content: 'x'.repeat(120_001) })
				}
			}))) as typeof fetch;
			const oversized = await prepareAIDiffPreview(
				wsUri,
				'a.txt',
				'Ändere die Datei.'
			);
			assert.strictEqual(oversized.ok, false);
			if (!oversized.ok) {
				assert.ok(oversized.reason.includes('Limit'));
			}
			assert.strictEqual(snapshot(dir), before);
			assert.strictEqual(diffTabCount(), 0);

			globalThis.fetch = (async () => {
				throw new Error('Ollama nicht erreichbar');
			}) as typeof fetch;
			const failed = await prepareAIDiffPreview(
				wsUri,
				'a.txt',
				'Ändere die Datei.'
			);
			assert.strictEqual(failed.ok, false);
			if (!failed.ok) {
				assert.ok(failed.reason.includes('Ollama nicht erreichbar'));
			}
			assert.strictEqual(snapshot(dir), before);
			assert.strictEqual(diffTabCount(), 0);
		} finally {
			globalThis.fetch = originalFetch;
			registration.dispose();
			provider.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('KI-Diff-Befehl: Dialog, Eingabe und Ollama sind verdrahtet; Abbruch und Fehler öffnen keinen Diff', async () => {
		const extension = vscode.extensions.getExtension('undefined_publisher.bubble-vscode-agent');
		assert.ok(extension);
		await extension.activate();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');

		const workspaceUri = vscode.workspace.workspaceFolders![0].uri;
		const targetUri = vscode.Uri.joinPath(workspaceUri, 'README.md');
		const fileBefore = fs.readFileSync(targetUri.fsPath);
		const originalFetch = globalThis.fetch;
		const win = vscode.window as unknown as Record<string, unknown>;
		const originalOpen = win.showOpenDialog;
		const originalInput = win.showInputBox;
		const originalError = win.showErrorMessage;
		const originalProgress = win.withProgress;
		let fetchCalls = 0;
		let inputCalls = 0;
		let progressCalls = 0;
		let progressActive = false;
		const progressOptions: vscode.ProgressOptions[] = [];
		let requestBody: Record<string, unknown> | undefined;
		const suggestion = '## KI-Vorschlag\n';

		try {
			win.showOpenDialog = async () => undefined;
			win.showInputBox = async () => {
				inputCalls += 1;
				return 'Füge eine Überschrift hinzu.';
			};
			win.showErrorMessage = async () => undefined;
			win.withProgress = async (
				options: vscode.ProgressOptions,
				task: (progress: vscode.Progress<{ message?: string; increment?: number }>) => Thenable<unknown>
			) => {
				progressCalls += 1;
				progressOptions.push(options);
				progressActive = true;
				try {
					return await task({ report: () => undefined });
				} finally {
					progressActive = false;
				}
			};
			globalThis.fetch = (async (_input, init) => {
				fetchCalls += 1;
				assert.strictEqual(progressActive, true, 'Fortschritt muss während Ollama aktiv sein');
				requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(JSON.stringify({
					message: { content: JSON.stringify({ content: suggestion }) }
				}));
			}) as typeof fetch;

			await vscode.commands.executeCommand('bubble-vscode-agent.previewDiffWithAI');
			assert.strictEqual(inputCalls, 0, 'Dateidialog-Abbruch darf keine Eingabe abfragen');
			assert.strictEqual(fetchCalls, 0, 'Dateidialog-Abbruch darf Ollama nicht aufrufen');
			assert.strictEqual(progressCalls, 0, 'Abbruch darf keine Fortschrittsmeldung anzeigen');
			assert.strictEqual(diffTabCount(), 0);
			assert.deepStrictEqual(fs.readFileSync(targetUri.fsPath), fileBefore);

			win.showOpenDialog = async () => [targetUri];
			await vscode.commands.executeCommand('bubble-vscode-agent.previewDiffWithAI');
			assert.strictEqual(fetchCalls, 1);
			assert.strictEqual(progressCalls, 1);
			assert.strictEqual(progressActive, false, 'Fortschritt muss nach Erfolg verschwinden');
			assert.strictEqual(progressOptions[0].location, vscode.ProgressLocation.Notification);
			assert.strictEqual(progressOptions[0].cancellable, false);
			assert.strictEqual(inputCalls, 1);
			const messages = requestBody?.messages as Array<{ content: string }>;
			assert.ok(messages[0].content.includes('Füge eine Überschrift hinzu.'));
			assert.ok(messages[0].content.includes(fileBefore.toString('utf8')));
			assert.ok(await waitFor(() => diffTabCount() === 1));
			assert.ok(vscode.workspace.textDocuments.some(
				document => document.uri.scheme === 'bubble-preview'
					&& document.getText() === suggestion
			));
			assert.deepStrictEqual(fs.readFileSync(targetUri.fsPath), fileBefore);

			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			assert.ok(await waitFor(() => diffTabCount() === 0));

			win.showInputBox = async () => undefined;
			await vscode.commands.executeCommand('bubble-vscode-agent.previewDiffWithAI');
			assert.strictEqual(fetchCalls, 1, 'Abbruch darf Ollama nicht aufrufen');
			assert.strictEqual(progressCalls, 1, 'Eingabeabbruch darf keine Fortschrittsmeldung anzeigen');
			assert.strictEqual(diffTabCount(), 0);
			assert.deepStrictEqual(fs.readFileSync(targetUri.fsPath), fileBefore);

			win.showInputBox = async () => 'Füge eine Überschrift hinzu.';
			globalThis.fetch = (async () => {
				fetchCalls += 1;
				return new Response('Ollama nicht erreichbar', { status: 503 });
			}) as typeof fetch;
			await vscode.commands.executeCommand('bubble-vscode-agent.previewDiffWithAI');
			assert.strictEqual(fetchCalls, 2);
			assert.strictEqual(progressCalls, 2);
			assert.strictEqual(progressActive, false, 'Fortschritt muss nach Fehler verschwinden');
			assert.strictEqual(diffTabCount(), 0);
			assert.deepStrictEqual(fs.readFileSync(targetUri.fsPath), fileBefore);
		} finally {
			globalThis.fetch = originalFetch;
			win.showOpenDialog = originalOpen;
			win.showInputBox = originalInput;
			win.showErrorMessage = originalError;
			win.withProgress = originalProgress;
		}
	});

	test('Diff-Vorschau: Abbruch im Dateidialog öffnet nichts und fragt keinen Text ab', async () => {
		await vscode.extensions.getExtension('undefined_publisher.bubble-vscode-agent')?.activate();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');

		const win = vscode.window as unknown as Record<string, unknown>;
		const originalOpen = win.showOpenDialog;
		const originalInput = win.showInputBox;
		let inputCalls = 0;
		win.showOpenDialog = async () => undefined;
		win.showInputBox = async () => { inputCalls += 1; return undefined; };

		try {
			await vscode.commands.executeCommand('bubble-vscode-agent.previewDiff');
			assert.strictEqual(inputCalls, 0);
			assert.strictEqual(diffTabCount(), 0);
		} finally {
			win.showOpenDialog = originalOpen;
			win.showInputBox = originalInput;
		}
	});
	test('Diff-Vorschau: Symlink wird abgelehnt', async function () {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-diff-link-'));
		const ws = path.join(base, 'ws');
		fs.mkdirSync(ws);
		fs.writeFileSync(path.join(base, 'secret.txt'), 'GEHEIM');

		try {
			try {
				fs.symlinkSync(path.join(base, 'secret.txt'), path.join(ws, 'link.txt'), 'file');
			} catch (error) {
				console.warn('Diff-Symlink-Test NICHT AUSGEFÜHRT: ' + String(error));
				this.skip();
				return;
			}
			const r = await prepareDiffPreview(vscode.Uri.file(ws), 'link.txt', 'x');
			assert.strictEqual(r.ok, false);
			assert.strictEqual(fs.readFileSync(path.join(base, 'secret.txt'), 'utf8'), 'GEHEIM');
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});

	test('Freigabeentscheidung: Negativfälle rufen den Fake-Writer nie auf (kein echter Schreibpfad bewiesen)', async function () {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-decide-'));
		fs.writeFileSync(path.join(dir, 'a.txt'), 'alt\n');
		fs.writeFileSync(path.join(dir, 'x.exe'), 'MZ');
		fs.mkdirSync(path.join(dir, 'sub'));
		const wsUri = vscode.Uri.file(dir);
		const calls: Array<[string, string]> = [];
		const writer: ChangeWriter = {
			write: async (p, c) => { calls.push([p, c]); }
		};

		try {
			const preview = await prepareDiffPreview(wsUri, 'a.txt', 'neu\n');
			assert.ok(preview.ok);
			assert.deepStrictEqual(
				Buffer.from(preview.originalBytes),
				Buffer.from('alt\n')
			);
			const before = snapshot(dir);

			const expectDenied = async (
				name: string,
				approval: 'approved' | 'rejected' | 'cancelled' | undefined,
				ws: vscode.Uri | null = wsUri,
				p: Extract<typeof preview, { ok: true }> = preview
			) => {
				const decision = await applyIfApproved(ws ?? undefined, p, approval, writer);
				assert.strictEqual(decision.eligible, false, name);
				assert.strictEqual(calls.length, 0, name);
				assert.strictEqual(snapshot(dir), before, name);
			};

			// Keine ausdrückliche Freigabe
			await expectDenied('ohne Entscheidung', undefined);
			await expectDenied('abgelehnt', 'rejected');
			await expectDenied('abgebrochen', 'cancelled');

			// Workspace, Pfad, Dateityp
			await expectDenied('kein Workspace', 'approved', null);
			for (const bad of ['.env', 'node_modules/a.txt', '../a.txt', 'a.txt/../.env', 'x.exe', 'fehlt.txt', 'sub']) {
				await expectDenied(bad, 'approved', wsUri, { ...preview, relativePath: bad });
			}
			await expectDenied('nicht normalisierter Pfad', 'approved', wsUri, { ...preview, relativePath: './a.txt' });

			// Zu große Vorschlagstexte
			await expectDenied('zu groß', 'approved', wsUri, { ...preview, proposed: 'x'.repeat(120_001) });

			// Verändertes Original: gleiche Länge, nur ein Byte anders
			fs.writeFileSync(path.join(dir, 'a.txt'), 'alx\n');
			const changed = snapshot(dir);
			const changedDecision = await applyIfApproved(wsUri, preview, 'approved', writer);
			assert.strictEqual(changedDecision.eligible, false);
			assert.strictEqual(calls.length, 0);
			assert.strictEqual(snapshot(dir), changed);

			// Gelöschte Datei
			fs.rmSync(path.join(dir, 'a.txt'));
			const deleted = await applyIfApproved(wsUri, preview, 'approved', writer);
			assert.strictEqual(deleted.eligible, false);
			assert.strictEqual(calls.length, 0);

			// Symlink an Stelle der Datei
			const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-decide-out-'));
			try {
				fs.writeFileSync(path.join(outside, 'a.txt'), 'alt\n');
				let linked = true;
				try {
					fs.symlinkSync(path.join(outside, 'a.txt'), path.join(dir, 'a.txt'), 'file');
				} catch (error) {
					linked = false;
					console.warn('Freigabe-Symlink-Fall NICHT AUSGEFÜHRT: ' + String(error));
				}
				if (linked) {
					const viaLink = await applyIfApproved(wsUri, preview, 'approved', writer);
					assert.strictEqual(viaLink.eligible, false);
					assert.strictEqual(calls.length, 0);
					assert.strictEqual(fs.readFileSync(path.join(outside, 'a.txt'), 'utf8'), 'alt\n');
				}
			} finally {
				fs.rmSync(outside, { recursive: true, force: true });
			}

			// Positivfall: unverändertes Original und Freigabe -> genau ein Fake-Aufruf
			fs.rmSync(path.join(dir, 'a.txt'), { force: true });
			fs.writeFileSync(path.join(dir, 'a.txt'), 'alt\n');
			const okSnapshot = snapshot(dir);
			const ok = await decideApply(wsUri, preview);
			assert.deepStrictEqual(ok, { eligible: true, relativePath: 'a.txt', content: 'neu\n' });
			const applied = await applyIfApproved(wsUri, preview, 'approved', writer);
			assert.strictEqual(applied.eligible, true);
			assert.deepStrictEqual(calls, [['a.txt', 'neu\n']]);
			assert.strictEqual(snapshot(dir), okSnapshot, 'Fake-Writer darf keine Datei ändern');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Diff-Vorschau: kein Annehmen-Befehl registriert', async () => {
		const extension = vscode.extensions.getExtension('undefined_publisher.bubble-vscode-agent');
		assert.ok(extension);
		await extension.activate();
		const commands = await vscode.commands.getCommands(true);
		const bubble = commands.filter(c => c.startsWith('bubble-vscode-agent.'));
		assert.ok(bubble.includes('bubble-vscode-agent.previewDiff'));
		assert.ok(bubble.includes('bubble-vscode-agent.previewDiffWithAI'));
			assert.ok(bubble.includes('bubble-vscode-agent.planChange'));
		assert.ok(!bubble.some(c => /accept|apply|annehmen/i.test(c)));
	});

		suite('Änderung planen: Format, Schritte und unbelegte Dateibehauptungen', () => {
			test('Planformat: Vollständiger Plan erfüllt alle 5 Abschnitte und maximal 3 Schritte', () => {
				const plan = [
					'1. Ziel der Änderung',
					'Ergänze den Befehl.',
					'',
					'2. betroffene Dateien, nur soweit tatsächlich geprüft',
					'- `src/extension.ts`',
					'',
					'3. höchstens drei Umsetzungsschritte',
					'1. Befehl registrieren',
					'2. Modul anlegen',
					'3. Testen',
					'',
					'4. nötige Tests',
					'Unit-Tests ausführen.',
					'',
					'5. offene Fragen oder unbelegte Annahmen',
					'Keine.'
				].join('\n');

				const evidence = [{ tool: 'read_file', target: 'src/extension.ts', success: true }];
				const validation = validatePlanOutput(plan, evidence);

				assert.strictEqual(validation.valid, true);
				assert.deepStrictEqual(validation.missingSections, []);
				assert.deepStrictEqual(validation.unverifiedFiles, []);
				assert.strictEqual(validation.stepCountExceeded, false);
				assert.strictEqual(validation.stepCount, 3);
			});

			test('Planformat: Fehlende Abschnitte werden erkannt', () => {
				const plan = [
					'1. Ziel der Änderung',
					'Ergänze den Befehl.',
					'2. betroffene Dateien, nur soweit tatsächlich geprüft',
					'Keine.'
				].join('\n');

				const validation = validatePlanOutput(plan);
				assert.strictEqual(validation.valid, false);
				assert.ok(validation.missingSections.includes('höchstens drei Umsetzungsschritte'));
				assert.ok(validation.missingSections.includes('nötige Tests'));
				assert.ok(validation.missingSections.includes('offene Fragen oder unbelegte Annahmen'));
			});

			test('Umsetzungsschritte: mehr als 3 Schritte erzeugen eine Warnung', () => {
				const plan = [
					'1. Ziel der Änderung',
					'Test',
					'2. betroffene Dateien, nur soweit tatsächlich geprüft',
					'Keine',
					'3. höchstens drei Umsetzungsschritte',
					'1. Schritt 1',
					'2. Schritt 2',
					'3. Schritt 3',
					'4. Schritt 4',
					'5. nötige Tests',
					'Testen',
					'6. offene Fragen oder unbelegte Annahmen',
					'Keine'
				].join('\n');

				const validation = validatePlanOutput(plan);
				assert.strictEqual(validation.stepCountExceeded, true);
				assert.strictEqual(validation.stepCount, 4);

				const formatted = formatPlanResponse(plan, [], 0);
				assert.ok(formatted.includes('WARNUNG: Der Plan enthält 4 Umsetzungsschritte (maximal 3 erlaubt).'));
			});

			test('Unbelegte Dateibehauptungen: ungeprüfte Datei wird als Warnung ausgegeben', () => {
				const plan = [
					'1. Ziel der Änderung',
					'Änderung an der Extension.',
					'2. betroffene Dateien, nur soweit tatsächlich geprüft',
					'- `src/extension.ts`',
					'- `package.json`',
					'3. höchstens drei Umsetzungsschritte',
					'1. Ändern',
					'4. nötige Tests',
					'Test',
					'5. offene Fragen oder unbelegte Annahmen',
					'Keine'
				].join('\n');

				// Nur src/extension.ts wurde per read_file gelesen
				const evidence = [{ tool: 'read_file', target: 'src/extension.ts', success: true }];
				const validation = validatePlanOutput(plan, evidence);

				assert.strictEqual(validation.valid, false);
				assert.deepStrictEqual(validation.unverifiedFiles, ['package.json']);

				const formatted = formatPlanResponse(plan, evidence, 0);
				assert.ok(formatted.includes('WARNUNG (Unbelegte Dateibehauptung):'));
				assert.ok(formatted.includes('package.json'));
			});

			test('Prompt-Erstellung: verlangt reine Lesewerkzeuge, kein Schreiben/Terminal', () => {
				const prompt = buildPlanPrompt('Füge ein Feature hinzu.');
				assert.ok(prompt.includes('WICHTIG: Ändere keine Dateien'));
				assert.ok(prompt.includes('ausschließlich Lesewerkzeuge'));
				assert.ok(prompt.includes('Füge ein Feature hinzu.'));
			});
		});

	test('search_text-Beschreibung warnt vor Gleichsetzen und nennt exakten Pfad', () => {
		type Tool = {
			function: {
				name: string;
				description: string;
				parameters: { properties: { include: { description: string } } };
			};
		};
		const tool = (getReadOnlyTools() as Tool[])
			.find(t => t.function.name === 'search_text');
		assert.ok(tool);
		const include = tool.function.parameters.properties.include.description;
		assert.ok(include.includes('exakten relativen Pfad'));
		assert.ok(include.includes('src/extension.ts'));
		assert.ok(include.includes('**/*.md'));
		assert.ok(tool.function.description.includes('nur seine jeweilige Zeile'));
		assert.ok(tool.function.description.includes('nicht ohne weiteren Kontext'));
	});

	suite('Projektanalyse: Folgefragen', () => {
		type ChatBody = {
			messages: Array<{ role: string; content: string }>;
			tools: Array<{ function: { name: string } }>;
		};

		const runConversation = async (
			inputs: Array<string | undefined>,
			choices: Array<string | undefined>,
			respond: (call: number) => object
		) => {
			await vscode.extensions.getExtension('undefined_publisher.bubble-vscode-agent')?.activate();
			const win = vscode.window as unknown as Record<string, unknown>;
			const originals = {
				input: win.showInputBox,
				pick: win.showQuickPick,
				info: win.showInformationMessage,
				error: win.showErrorMessage
			};
			const originalFetch = globalThis.fetch;
			const bodies: ChatBody[] = [];
			const errors: string[] = [];
			const shownChoices: string[][] = [];
			win.showInputBox = async () => inputs.shift();
			win.showQuickPick = async (items: string[]) => {
				shownChoices.push([...items]);
				return choices.shift();
			};
			win.showInformationMessage = async () => undefined;
			win.showErrorMessage = async (message: string) => { errors.push(message); return undefined; };
			globalThis.fetch = (async (_url: string, init: { body: string }) => {
				bodies.push(JSON.parse(init.body) as ChatBody);
				return new Response(JSON.stringify({ message: respond(bodies.length) }));
			}) as unknown as typeof fetch;
			try {
				await vscode.commands.executeCommand('bubble-vscode-agent.analyzeProject');
			} finally {
				win.showInputBox = originals.input;
				win.showQuickPick = originals.pick;
				win.showInformationMessage = originals.info;
				win.showErrorMessage = originals.error;
				globalThis.fetch = originalFetch;
			}
			return { bodies, errors, shownChoices, inputsLeft: inputs.length, choicesLeft: choices.length };
		};

		const answer = (call: number) => ({ role: 'assistant', content: `Antwort${call}` });
		const NO_TOOLS = '\n\n' + formatEvidence([], 0);
		const roles = (body: ChatBody) => body.messages.slice(1).map(m => `${m.role}:${m.content}`);

		test('Rückfrage erhält vorherige Frage und Antwort; nur Lesewerkzeuge werden angeboten', async () => {
			const result = await runConversation(
				['Frage1', 'Frage2'],
				[FOLLOW_UP_CHOICE, END_CHOICE],
				answer
			);
			assert.deepStrictEqual(result.shownChoices[0], [FOLLOW_UP_CHOICE, RESET_CHOICE, END_CHOICE]);
			assert.strictEqual(result.bodies.length, 2);
			assert.deepStrictEqual(roles(result.bodies[0]), ['user:Frage1']);
			assert.deepStrictEqual(
				roles(result.bodies[1]),
				['user:Frage1', 'assistant:Antwort1' + NO_TOOLS, 'user:Frage2']
			);
			assert.deepStrictEqual(
				result.bodies[1].tools.map(tool => tool.function.name),
				['list_directory', 'read_file', 'search_text']
			);
		});

		test('Reset entfernt den bisherigen Verlauf', async () => {
			const result = await runConversation(
				['Frage1', 'Neu'],
				[RESET_CHOICE, END_CHOICE],
				answer
			);
			assert.strictEqual(result.bodies.length, 2);
			assert.deepStrictEqual(roles(result.bodies[1]), ['user:Neu']);
		});

		test('Beenden und Abbruch der Auswahl senden nichts weiter', async () => {
			for (const choice of [END_CHOICE, undefined]) {
				const result = await runConversation(['Frage1', 'Unbenutzt'], [choice], answer);
				assert.strictEqual(result.bodies.length, 1);
				assert.strictEqual(result.inputsLeft, 1);
			}
		});

		test('Überschreitung durch Rückfrage: kein Ollama-Aufruf, nichts gekürzt, Verlauf bleibt', async () => {
			const result = await runConversation(
				['Frage1', 'x'.repeat(MAX_REQUEST_BYTES), 'Frage3'],
				[FOLLOW_UP_CHOICE, FOLLOW_UP_CHOICE, END_CHOICE],
				answer
			);
			assert.strictEqual(result.bodies.length, 2);
			assert.strictEqual(result.errors.length, 1);
			assert.ok(result.errors[0].includes('überschreitet die konservative Produktgrenze'));
			assert.ok(result.errors[0].includes('keine garantierte Token-Grenze'));
			assert.ok(result.errors[0].includes('Gespräch zurücksetzen'));
			assert.deepStrictEqual(
				roles(result.bodies[1]),
				['user:Frage1', 'assistant:Antwort1' + NO_TOOLS, 'user:Frage3']
			);
		});

		test('Überschreitung durch Werkzeugergebnisse stoppt vor dem Ollama-Aufruf', async () => {
			const toolCall = {
				role: 'assistant',
				content: '',
				tool_calls: [{ function: { name: 'read_file', arguments: { path: 'README.md' } } }]
			};
			const result = await runConversation(['Lies README'], [], () => toolCall);
			assert.ok(result.bodies.length >= 2 && result.bodies.length < 8);
			assert.strictEqual(result.errors.length, 1);
			assert.ok(result.errors[0].includes('Werkzeugergebnisse'));
			assert.ok(!result.errors[0].includes('Gespräch zurücksetzen'), 'bei der ersten Frage gibt es keinen Reset-Menüpunkt');
			for (const body of result.bodies) {
				assert.ok(Buffer.byteLength(JSON.stringify(body), 'utf8') <= MAX_REQUEST_BYTES);
			}
		});

		test('Überschreitung durch ein Werkzeugergebnis nach Verlauf: Verlauf bleibt für kleinere Rückfrage nutzbar', async () => {
			const result = await runConversation(
				['Frage1', 'Frage2', 'Frage3'],
				[FOLLOW_UP_CHOICE, FOLLOW_UP_CHOICE, END_CHOICE],
				call => call === 2
					? {
						role: 'assistant',
						content: 'y'.repeat(MAX_REQUEST_BYTES),
						tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }]
					}
					: answer(call)
			);
			// Aufruf 1: Frage1, Aufruf 2: Frage2 (Werkzeugergebnis sprengt Grenze), Aufruf 3: Frage3
			assert.strictEqual(result.bodies.length, 3);
			assert.strictEqual(result.errors.length, 1);
			assert.ok(result.errors[0].includes('Gespräch zurücksetzen'));
			assert.deepStrictEqual(
				roles(result.bodies[2]),
				['user:Frage1', 'assistant:Antwort1' + NO_TOOLS, 'user:Frage3']
			);
		});

		const toolRound = (file: string) => ({
			role: 'assistant',
			content: '',
			tool_calls: [{ function: { name: 'read_file', arguments: { path: file } } }]
		});

		const evidenceCases: Array<[string, Array<object>, string]> = [
			['ohne Werkzeug', [answer(1), answer(2)], formatEvidence([], 0)],
			[
				'erfolgreiches read_file',
				[toolRound('package.json'), answer(2), answer(3)],
				formatEvidence([{ tool: 'read_file', target: 'package.json', success: true }], 0)
			],
			[
				'fehlgeschlagenes read_file',
				[toolRound('gibt-es-nicht.ts'), answer(2), answer(3)],
				formatEvidence([{ tool: 'read_file', target: 'gibt-es-nicht.ts', success: false }], 0)
			]
		];

		for (const [label, script, expected] of evidenceCases) {
			test(`Rückfrage nach Antwort ${label}: Werkzeugprotokoll ohne Dateiinhalt im Verlauf`, async () => {
				const result = await runConversation(
					['Frage1', 'Frage2'],
					[FOLLOW_UP_CHOICE, END_CHOICE],
					call => script[call - 1]
				);
				const last = result.bodies[result.bodies.length - 1];
				const history = last.messages.slice(1, -1);
				assert.strictEqual(history.length, 2);
				const assistant = history[1].content;
				assert.ok(assistant.endsWith(expected), assistant);
				assert.ok(assistant.includes('kein Beleg, dass die Antwort inhaltlich korrekt ist'));
				assert.strictEqual(assistant.includes('In diesem Schritt keine Datei gelesen'), !expected.includes('read_file package.json: erfolgreich'));
				assert.ok(!last.messages.some(m => m.role === 'tool'), 'keine Werkzeugergebnisse im Verlauf');
				assert.ok(!assistant.includes('"name"'), 'kein Dateiinhalt im Verlauf');
				assert.deepStrictEqual(result.errors, []);
			});
		}

		test('Rückfrage ohne neuen Leseaufruf nach früherem read_file: Schritt und frühere Belege getrennt', async () => {
			const result = await runConversation(
				['Frage1', 'Frage2', 'Frage3'],
				[FOLLOW_UP_CHOICE, FOLLOW_UP_CHOICE, END_CHOICE],
				call => call === 1 ? toolRound('package.json') : answer(call)
			);
			assert.strictEqual(result.bodies.length, 4);
			const history = result.bodies[3].messages.slice(1, -1);
			assert.strictEqual(history.length, 4);
			const [, step1, , step2] = history.map(m => m.content);

			assert.ok(step1.includes('read_file package.json: erfolgreich'));
			assert.ok(!step1.includes('In diesem Schritt keine Datei gelesen'));
			assert.ok(!step1.includes('Frühere Schritte'));

			assert.ok(step2.includes('In diesem Schritt keine Datei gelesen.'));
			assert.ok(step2.includes('Frühere Schritte (nicht dieser Schritt): read_file erfolgreich für package.json'));
			assert.ok(step2.includes('Der Inhalt steht nicht im Verlauf'));
			assert.ok(!step2.includes('- read_file package.json'), 'frühere Belege nicht als Beleg dieses Schritts');
			assert.ok(!step2.includes('"success"'), 'kein Werkzeugergebnis im Verlauf');
			assert.deepStrictEqual(result.errors, []);
		});

		test('formatEvidence: Begrenzung und Hinweis auf ausgelassene Aufrufe', () => {
			const text = formatEvidence(
				[{ tool: 'search_text', target: '"x" in **/*', success: true }],
				3
			);
			assert.ok(text.includes('In diesem Schritt keine Datei gelesen.'));
			assert.ok(text.includes('search_text "x" in **/*: erfolgreich'));
			assert.ok(text.includes('3 weitere Aufrufe nicht aufgeführt'));
		});

		test('Mehrere tool_calls: nach dem Ergebnis über der Grenze keine weiteren Werkzeug- oder Ollama-Aufrufe', async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-limit-'));
			const originalFetch = globalThis.fetch;
			try {
				fs.writeFileSync(path.join(dir, 'big.md'), 'x'.repeat(MAX_REQUEST_BYTES));
				fs.writeFileSync(path.join(dir, 'small.md'), 'klein');
				let fetchCalls = 0;
				globalThis.fetch = (async () => {
					fetchCalls += 1;
					const call = (name: string, file: string) =>
						({ function: { name, arguments: { path: file } } });
					return new Response(JSON.stringify({
						message: {
							role: 'assistant',
							content: '',
							tool_calls: [
								call('read_file', 'small.md'),
								call('read_file', 'big.md'),
								call('read_file', 'small.md'),
								call('list_directory', '.')
							]
						}
					}));
				}) as unknown as typeof fetch;

				const statuses: string[] = [];
				await assert.rejects(
					runReadOnlyAgent(
						vscode.Uri.file(dir),
						'Lies alles',
						status => statuses.push(status)
					),
					(error: unknown) => error instanceof RequestTooLargeError
				);

				// Genau zwei Werkzeuge liefen: small.md und big.md (Überschreitung).
				assert.strictEqual(statuses.filter(s => s.startsWith('Lesewerkzeug:')).length, 2);
				assert.strictEqual(fetchCalls, 1);
			} finally {
				globalThis.fetch = originalFetch;
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});	});
});
