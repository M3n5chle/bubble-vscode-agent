import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { getOllamaModel } from '../ollamaModel.js';
import { getChatHtml } from '../chat/chatView.js';
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
	SIMULATED_APPROVAL_MESSAGE,
	applyIfApproved,
	decideApply,
	fingerprintPreview,
	recordSimulatedDecision,
	type ApprovalPrompt,
	type ApprovalReceipt,
	type ChangeWriter
} from '../agent/applyDecision.js';
import {
	resolveWorkspaceUri,
	runChatSystemCheck,
	runQuestion,
	runSystemCheck
} from '../extension.js';
import {
	MAX_RANGE_LINES,
	MAX_RANGE_RESULT_BYTES,
	MAX_SEARCH_MATCH_TEXT_LENGTH,
	MAX_SEARCH_RESULT_BYTES,
	MAX_SEARCH_RESULTS,
	listProjectDirectory,
	readProjectFile,
	readProjectFileRange,
	searchProjectText
} from '../tools/readTools.js';
import {
	MAX_REQUEST_BYTES,
	RequestTooLargeError,
	AgentCancelledError,
	AgentStepLimitError,
	FINAL_ANSWER_NOTICE,
	prepareFinalAnswerRequest,
	TOOL_RESULT_BUDGET_NOTICE,
	SKIPPED_AFTER_BUDGET_NOTICE,
	formatEvidence,
	getReadOnlyTools,
	runReadOnlyAgent,
	type ToolActivity
} from '../agent/readOnlyAgent.js';
import { END_CHOICE, FOLLOW_UP_CHOICE, RESET_CHOICE } from '../extension.js';
import {
	validatePlanOutput,
	buildPlanPrompt,
	formatPlanResponse,
	getFileReadStatus,
	extractChangeTargetFile,
	extractRequestedFiles,
	PLAN_SECTIONS,
	PLAN_FINAL_ANSWER,
	PLAN_FINAL_ANSWER_NOTICE
} from '../agent/planChange.js';
import {
	createContextLedger,
	formatContextStatus,
	mergeRanges,
	newLinesOutside,
	recordForwardedResult
} from '../agent/contextStatus.js';

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

	test('Chat-Systemprüfung meldet fehlenden Workspace ohne eine Prüfung zu starten', async () => {
		const output = {
			appendLine: () => {},
			clear: () => {},
			show: () => {}
		} as unknown as vscode.OutputChannel;
		await assert.rejects(
			runChatSystemCheck(output, undefined),
			/Bubble: Es ist kein Workspace geöffnet/
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

			const ok = await run([getOllamaModel()]);
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

	test('Version: Systemprüfung und Chat-Kopf zeigen die Version aus den Erweiterungsmetadaten', async () => {
		const extension = vscode.extensions.all.find(e => e.packageJSON?.name === 'bubble-vscode-agent');
		assert.ok(extension);
		await extension.activate();
		const pkg = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.json'), 'utf8'));
		assert.strictEqual(extension.packageJSON.version, pkg.version);

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-version-'));
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify({ models: [] }))) as typeof fetch;
		try {
			const lines: string[] = [];
			const output = {
				appendLine: (line: string) => { lines.push(line); },
				clear: () => { lines.length = 0; },
				show: () => { }
			} as unknown as vscode.OutputChannel;
			await runSystemCheck(output, vscode.Uri.file(dir));
			assert.ok(lines.includes(`Version: ${pkg.version}`));
		} finally {
			globalThis.fetch = originalFetch;
			fs.rmSync(dir, { recursive: true, force: true });
		}

		assert.ok(getChatHtml('v', pkg.version).includes(`<span id="bubble-version">v${pkg.version}</span>`));
		assert.ok(!getChatHtml('v').includes('bubble-version'));
	});

	suite('Release-Vorbereitung', () => {
		const root = path.resolve(__dirname, '..', '..');
		const release = require(path.join(root, 'scripts', 'releaseVersion.js')) as {
			bumpPatch(v: string): string;
			setVersion(text: string, count: number, from: string, to: string): string;
			setPackageVersion(text: string, from: string, to: string): string;
		};

		test('Patch-Version wird genau um eins erhöht, ungültige Versionen werden abgelehnt', () => {
			assert.strictEqual(release.bumpPatch('0.0.2'), '0.0.3');
			assert.strictEqual(release.bumpPatch('1.2.9'), '1.2.10');
			assert.throws(() => release.bumpPatch('1.2'));
			assert.throws(() => release.bumpPatch('1.2.3-beta'));
		});

		test('setVersion ersetzt nur Bubble-Angaben, prüft Anzahl und Konsistenz', () => {
			const lock = '{\n  "name": "bubble-vscode-agent",\n  "version": "0.0.2",\n  "packages": {\n    "": {\n      "name": "bubble-vscode-agent",\n      "version": "0.0.2"\n    },\n    "node_modules/x": {\n      "version": "0.0.2"\n    }\n  }\n}\n';
			const updated = release.setVersion(lock, 2, '0.0.2', '0.0.3');
			assert.strictEqual((updated.match(/0\.0\.3/g) ?? []).length, 2);
			assert.strictEqual((updated.match(/0\.0\.2/g) ?? []).length, 1);
			assert.throws(() => release.setVersion(lock, 1, '0.0.2', '0.0.3'));
			assert.throws(() => release.setVersion(lock, 2, '0.0.1', '0.0.3'));
		});

		test('setPackageVersion ändert nur die oberste Version von package.json', () => {
			const text = '{\n  "name": "x",\n  "version": "0.0.2",\n  "dependencies": { "y": "0.0.2" }\n}\n';
			const updated = release.setPackageVersion(text, '0.0.2', '0.0.3');
			assert.ok(updated.includes('"version": "0.0.3"') && updated.includes('"y": "0.0.2"'));
			assert.throws(() => release.setPackageVersion(text, '0.0.1', '0.0.3'));
			assert.throws(() => release.setPackageVersion('{}', '0.0.2', '0.0.3'));
		});

		test('Normale Builds und Tests erhöhen die Version nicht; package.json und Lockdatei sind konsistent', () => {
			const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
			const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
			assert.strictEqual(lock.version, pkg.version);
			assert.strictEqual(lock.packages[''].version, pkg.version);
			for (const name of ['test', 'package', 'compile', 'pretest', 'vscode:prepublish']) {
				assert.ok(!/release|version|prepare-release/.test(pkg.scripts[name]), name);
			}
			assert.strictEqual(pkg.scripts['release:prepare'], 'node scripts/prepare-release.js');
		});
	});
	test('Ollama-Modell: Standard qwen3:14b, alternative Einstellung gilt für Anfrage und Systemprüfung', async () => {
		const config = vscode.workspace.getConfiguration('bubble-vscode-agent');
		const previousGlobal = config.inspect<string>('ollamaModel')?.globalValue;
		const previousWorkspace = config.inspect<string>('ollamaModel')?.workspaceValue;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-model-'));
		fs.writeFileSync(path.join(dir, 'a.txt'), 'alt\n');
		const originalFetch = globalThis.fetch;
		const bodies: Array<Record<string, unknown>> = [];
		const systemCheck = async (models: string[]) => {
			globalThis.fetch = (async () => new Response(
				JSON.stringify({ models: models.map(name => ({ name })) })
			)) as typeof fetch;
			const lines: string[] = [];
			const output = {
				appendLine: (line: string) => { lines.push(line); },
				clear: () => { lines.length = 0; },
				show: () => { }
			} as unknown as vscode.OutputChannel;
			const ready = await runSystemCheck(output, vscode.Uri.file(dir));
			return { ready, text: lines.join('\n') };
		};
		const requestModel = async () => {
			globalThis.fetch = (async (_input, init) => {
				bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				return new Response(JSON.stringify({
					message: { content: JSON.stringify({ content: 'neu\n' }) }
				}));
			}) as typeof fetch;
			const prepared = await prepareAIDiffPreview(vscode.Uri.file(dir), 'a.txt', 'Ändere.');
			assert.ok(prepared.ok);
			return bodies[bodies.length - 1].model;
		};

		try {
			await config.update('ollamaModel', undefined, vscode.ConfigurationTarget.Workspace);
			await config.update('ollamaModel', undefined, vscode.ConfigurationTarget.Global);
			assert.strictEqual(getOllamaModel(), 'qwen3:14b');
			assert.strictEqual(await requestModel(), 'qwen3:14b');
			assert.strictEqual((await systemCheck(['qwen3:14b'])).ready, true);

			await config.update('ollamaModel', 'alternativ:7b', vscode.ConfigurationTarget.Global);
			assert.strictEqual(getOllamaModel(), 'alternativ:7b');
			assert.strictEqual(await requestModel(), 'alternativ:7b');
			const alt = await systemCheck(['alternativ:7b']);
			assert.strictEqual(alt.ready, true);
			assert.ok(alt.text.includes('OK: alternativ:7b vorhanden'));
			const standardOnly = await systemCheck(['qwen3:14b']);
			assert.strictEqual(standardOnly.ready, false);
			assert.ok(standardOnly.text.includes('FEHLT: alternativ:7b'));

			await config.update('ollamaModel', '   ', vscode.ConfigurationTarget.Global);
			assert.strictEqual(getOllamaModel(), 'qwen3:14b');
		} finally {
			globalThis.fetch = originalFetch;
			await config.update('ollamaModel', previousGlobal, vscode.ConfigurationTarget.Global);
			await config.update('ollamaModel', previousWorkspace, vscode.ConfigurationTarget.Workspace);
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		}
	});
	test('Frage stellen: angezeigter Modellname entspricht dem gesendeten, auch bei Änderung während der Anfrage', async () => {
		const config = vscode.workspace.getConfiguration('bubble-vscode-agent');
		const previousGlobal = config.inspect<string>('ollamaModel')?.globalValue;
		const previousWorkspace = config.inspect<string>('ollamaModel')?.workspaceValue;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-ask-model-'));
		const originalFetch = globalThis.fetch;
		let sentModel: unknown;
		const lines: string[] = [];
		const output = {
			appendLine: (line: string) => { lines.push(line); },
			clear: () => { lines.length = 0; },
			show: () => { }
		} as unknown as vscode.OutputChannel;

		try {
			await config.update('ollamaModel', undefined, vscode.ConfigurationTarget.Workspace);
			await config.update('ollamaModel', 'vorher:7b', vscode.ConfigurationTarget.Global);
			globalThis.fetch = (async (_input, init) => {
				sentModel = (JSON.parse(String(init?.body)) as Record<string, unknown>).model;
				// Einstellung ändert sich, während die Anfrage läuft
				await config.update('ollamaModel', 'waehrend:9b', vscode.ConfigurationTarget.Global);
				return new Response(JSON.stringify({ message: { content: 'Antwort' } }));
			}) as typeof fetch;

			await runQuestion(output, vscode.Uri.file(dir), 'Was gilt hier?');

			assert.strictEqual(sentModel, 'vorher:7b');
			assert.ok(lines.includes('Modell: vorher:7b'));
			assert.ok(!lines.some(line => line.includes('waehrend:9b')));
			assert.ok(lines.includes('Antwort'));
			assert.strictEqual(getOllamaModel(), 'waehrend:9b');
		} finally {
			globalThis.fetch = originalFetch;
			await config.update('ollamaModel', previousGlobal, vscode.ConfigurationTarget.Global);
			await config.update('ollamaModel', previousWorkspace, vscode.ConfigurationTarget.Workspace);
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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

	suite('search_text Ergebnisbudget', () => {
		const workspace = vscode.workspace.workspaceFolders![0].uri;
		const fixtureName = `.bubble-search-budget-${process.pid}-${Date.now()}`;
		const fixture = path.join(workspace.fsPath, fixtureName);
		const parse = (content: string) => JSON.parse(content) as {
			hits: Array<{ path: string; line: number; text: string; textTruncated: boolean }>;
			emittedHitCount: number;
			truncatedHitCount: number;
			moreHitsAvailable: boolean | 'unknown';
			omittedHitCount: number | null;
			limitTypes: string[];
			byteBudget: number;
			actualUtf8Bytes: number;
		};
		const assertByteCount = (result: { success: boolean; content: string }, report: ReturnType<typeof parse>) => {
			const actual = Buffer.byteLength(
				JSON.stringify({ success: result.success, content: result.content }),
				'utf8'
			);
			assert.strictEqual(report.actualUtf8Bytes, actual);
			assert.ok(actual <= report.byteBudget);
			assert.strictEqual(report.byteBudget, MAX_SEARCH_RESULT_BYTES);
		};

		teardown(() => {
			fs.rmSync(fixture, { recursive: true, force: true });
		});

		test('normales Ergebnis bleibt vollständig innerhalb des Budgets', async () => {
			fs.mkdirSync(fixture, { recursive: true });
			fs.writeFileSync(path.join(fixture, 'a.txt'), 'needle first\n');
			fs.writeFileSync(path.join(fixture, 'z.txt'), 'needle second\n');

			const result = await searchProjectText(
				workspace,
				'needle',
				`${fixtureName}/*.txt`
			);
			assert.strictEqual(result.success, true);
			const report = parse(result.content);
			assert.strictEqual(report.emittedHitCount, 2);
			assert.strictEqual(report.moreHitsAvailable, false);
			assert.deepStrictEqual(report.limitTypes, []);
			assert.deepStrictEqual(
				report.hits.map(hit => [path.posix.basename(hit.path), hit.line]),
				[['a.txt', 1], ['z.txt', 1]]
			);
			assertByteCount(result, report);
		});

		test('Suchsemantik: "|" ist wörtlich, kein Treffer ist erfolgreich mit 0 Treffern', async () => {
			fs.mkdirSync(fixture, { recursive: true });
			fs.writeFileSync(path.join(fixture, 'a.txt'), 'Abort one\ncancel two\nliteral abort|cancel here\n');
			const include = `${fixtureName}/a.txt`;

			const single = parse((await searchProjectText(workspace, 'ABORT', include)).content);
			assert.deepStrictEqual(single.hits.map(hit => hit.line), [1, 3]);

			const alternation = await searchProjectText(workspace, 'abort|cancel', include);
			const alt = parse(alternation.content);
			assert.strictEqual(alt.emittedHitCount, 1);
			assert.deepStrictEqual(alt.hits.map(hit => hit.line), [3]);

			const none = await searchProjectText(workspace, 'nirgends-vorhanden', include);
			assert.strictEqual(none.success, true);
			const noneReport = parse(none.content);
			assert.strictEqual(noneReport.emittedHitCount, 0);
			assert.deepStrictEqual(noneReport.hits, []);
			assert.strictEqual(noneReport.moreHitsAvailable, false);

			// Ein Suchergebnis (auch ohne Treffer) belegt keine gelesene Datei.
			const evidence = [{ tool: 'search_text', target: 'nirgends-vorhanden', success: true }];
			assert.strictEqual(getFileReadStatus('a.txt', evidence), 'not-attempted');
		});

		test('query und include sind getrennt: Pfad als query trifft nur Inhalt, Treffer außerhalb von include zählen nicht', async () => {
			fs.mkdirSync(fixture, { recursive: true });
			fs.writeFileSync(path.join(fixture, 'target.ts'), 'function abortChat() {}\n');
			fs.writeFileSync(path.join(fixture, 'notes.md'), `Siehe ${fixtureName}/target.ts und abortChat\n`);

			const byPath = parse((await searchProjectText(workspace, `${fixtureName}/target.ts`, `${fixtureName}/*`)).content);
			assert.deepStrictEqual(byPath.hits.map(hit => path.posix.basename(hit.path)), ['notes.md']);

			const inTarget = parse((await searchProjectText(workspace, 'abortChat', `${fixtureName}/target.ts`)).content);
			assert.deepStrictEqual(inTarget.hits.map(hit => path.posix.basename(hit.path)), ['target.ts']);

			const wrongFile = await searchProjectText(workspace, 'Siehe', `${fixtureName}/target.ts`);
			assert.strictEqual(wrongFile.success, true);
			const wrongReport = parse(wrongFile.content);
			assert.strictEqual(wrongReport.emittedHitCount, 0);
			assert.deepStrictEqual(wrongReport.hits, []);
		});

		test('P4-Fehlaufruf: Dateiname als query bei breitem include liefert Rollenhinweis, Suche läuft unverändert', async () => {
			fs.mkdirSync(fixture, { recursive: true });
			fs.writeFileSync(path.join(fixture, 'chatView.ts'), 'function abortChat() {}\n');
			fs.writeFileSync(path.join(fixture, 'other.test.ts'), "// prüft chatView.ts\n");

			const result = await searchProjectText(workspace, 'chatView.ts', `${fixtureName}/**/*.ts`);
			assert.strictEqual(result.success, true);
			const report = parse(result.content);
			const hint = (JSON.parse(result.content) as { parameterHint?: string }).parameterHint;
			assert.ok(hint?.includes('query ist Text im Dateiinhalt, include wählt die Zieldatei'));
			assert.ok(hint?.includes('Ist der Dateiname als Inhalt gemeint, ist dieses Ergebnis gültig'));
			// Keine Ersatzsuche, kein erfundener Begriff: nur der Treffer der echten Suche.
			assert.deepStrictEqual(report.hits.map(hit => path.posix.basename(hit.path)), ['other.test.ts']);
			assert.ok(!hint?.includes('abortChat'));
			assertByteCount(result, report);
		});

		test('Legitime Dateinamensuche im Inhalt bleibt ohne Hinweis, wenn include eine Datei nennt oder query kein Dateiname ist', async () => {
			fs.mkdirSync(fixture, { recursive: true });
			fs.writeFileSync(path.join(fixture, 'notes.md'), 'Siehe chatView.ts und abortChat\n');

			for (const [query, include] of [
				['chatView.ts', `${fixtureName}/notes.md`],
				['abortChat', `${fixtureName}/**/*.md`],
				['session.end', `${fixtureName}/**/*.md`],
				['Siehe chatView.ts', `${fixtureName}/**/*.md`]
			]) {
				const result = await searchProjectText(workspace, query, include);
				assert.strictEqual(result.success, true);
				assert.strictEqual(
					(JSON.parse(result.content) as { parameterHint?: string }).parameterHint,
					undefined,
					`${query} in ${include}`
				);
			}

			// Absichtliche Dateinamensuche bleibt möglich und liefert ihre Treffer.
			const intended = await searchProjectText(workspace, 'chatView.ts', `${fixtureName}/**/*.md`);
			assert.deepStrictEqual(
				parse(intended.content).hits.map(hit => path.posix.basename(hit.path)),
				['notes.md']
			);
		});

		test('search_text-Werkzeugbeschreibung trennt query (Inhalt) von include (Datei)', () => {
			const tool = getReadOnlyTools().find(
				entry => (entry as { function: { name: string } }).function.name === 'search_text'
			) as { function: { description: string; parameters: { properties: { query: { description: string }; include: { description: string } } } } };
			const { description, parameters } = tool.function;
			assert.ok(description.includes('IM Dateiinhalt, kein Dateipfad'));
			assert.ok(description.includes('mit include gewählt'));
			assert.ok(description.includes('Treffer in anderen Dateien belegen nichts über die genannte Zieldatei'));
			assert.ok(description.includes('read_file_range'));
			assert.ok(parameters.properties.query.description.includes('nie ein Dateipfad'));
			assert.ok(parameters.properties.include.description.includes('begrenzt die durchsuchten Dateien'));
			assert.ok(parameters.properties.include.description.includes('exakten relativen Pfad'));
		});
		test('Trefferzahlgrenze meldet ausgelassene Treffer und behält Fundreihenfolge', async () => {
			fs.mkdirSync(fixture, { recursive: true });
			fs.writeFileSync(
				path.join(fixture, 'many.txt'),
				Array.from({ length: MAX_SEARCH_RESULTS + 5 }, (_, index) => `needle ${index}`).join('\n')
			);

			const result = await searchProjectText(
				workspace,
				'needle',
				`${fixtureName}/many.txt`
			);
			const report = parse(result.content);
			assert.strictEqual(report.emittedHitCount, MAX_SEARCH_RESULTS);
			assert.strictEqual(report.moreHitsAvailable, true);
			assert.strictEqual(report.omittedHitCount, null);
			assert.ok(report.limitTypes.includes('hit_count'));
			assert.deepStrictEqual(report.hits.slice(0, 3).map(hit => hit.line), [1, 2, 3]);
			assertByteCount(result, report);
		});

		test('Treffertextgrenze kennzeichnet gekürzte Zeilen sichtbar', async () => {
			fs.mkdirSync(fixture, { recursive: true });
			fs.writeFileSync(path.join(fixture, 'long.txt'), `needle ${'🫧'.repeat(500)}`);

			const result = await searchProjectText(
				workspace,
				'needle',
				`${fixtureName}/long.txt`
			);
			const report = parse(result.content);
			assert.strictEqual(report.emittedHitCount, 1);
			assert.strictEqual(report.truncatedHitCount, 1);
			assert.strictEqual(report.hits[0].textTruncated, true);
			assert.ok(report.hits[0].text.endsWith('…[gekürzt]'));
			assert.ok(report.hits[0].text.includes('🫧'));
			assert.ok(Array.from(report.hits[0].text).length <= MAX_SEARCH_MATCH_TEXT_LENGTH);
			assert.strictEqual(
				new TextDecoder('utf-8', { fatal: true }).decode(
					Buffer.from(report.hits[0].text, 'utf8')
				),
				report.hits[0].text
			);
			assert.ok(report.limitTypes.includes('per_hit_text'));
			assertByteCount(result, report);
		});

		test('Gesamtbytegrenze stoppt nur zwischen Treffern und weist ausgelassene aus', async () => {
			fs.mkdirSync(fixture, { recursive: true });
			fs.writeFileSync(
				path.join(fixture, 'bytes.txt'),
				Array.from({ length: 40 }, (_, index) => `needle ${index} ${'x'.repeat(220)}`).join('\n')
			);

			const result = await searchProjectText(
				workspace,
				'needle',
				`${fixtureName}/bytes.txt`
			);
			const report = parse(result.content);
			assert.ok(report.emittedHitCount > 0);
			assert.ok(report.emittedHitCount < 40);
			assert.strictEqual(report.hits.length, report.emittedHitCount);
			assert.strictEqual(report.moreHitsAvailable, true);
			assert.strictEqual(report.omittedHitCount, 40 - report.emittedHitCount);
			assert.ok(report.limitTypes.includes('total_bytes'));
			assertByteCount(result, report);
		});

		test('UTF-8-Mehrbytezeichen und gemeldete Bytegröße werden exakt gemessen', async () => {
			fs.mkdirSync(fixture, { recursive: true });
			fs.writeFileSync(path.join(fixture, 'utf8.txt'), 'needle 🫧 Grüße');

			const result = await searchProjectText(
				workspace,
				'needle',
				`${fixtureName}/utf8.txt`
			);
			const report = parse(result.content);
			assert.ok(report.hits[0].text.includes('🫧 Grüße'));
			assertByteCount(result, report);
		});

		test('gesperrte Konfigurationspfade werden nicht durchsucht', async () => {
			fs.mkdirSync(fixture, { recursive: true });
			fs.writeFileSync(path.join(fixture, 'config.php'), 'needle secret');
			fs.writeFileSync(path.join(fixture, 'safe.txt'), 'needle safe');

			const result = await searchProjectText(
				workspace,
				'needle',
				`${fixtureName}/*`
			);
			const report = parse(result.content);
			assert.deepStrictEqual(report.hits.map(hit => path.posix.basename(hit.path)), ['safe.txt']);
			assert.ok(!result.content.includes('secret'));
		});
	});

	suite('Lesewerkzeuge: read_file und list_directory im Temp-Workspace', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-readtools-ws-'));
		const root = vscode.Uri.file(dir);

		suiteSetup(() => {
			fs.mkdirSync(path.join(dir, 'src'));
			fs.mkdirSync(path.join(dir, 'node_modules'));
			fs.writeFileSync(path.join(dir, 'src', 'small.ts'), 'export const x = 1;\n');
			fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=geheim\n');
			fs.writeFileSync(path.join(dir, 'node_modules', 'm.js'), 'x');
		});
		suiteTeardown(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});

		test('read_file: kleine Datei wird gelesen', async () => {
			const result = await readProjectFile(root, 'src/small.ts');
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('export const x = 1;'));
		});

		test('read_file: gesperrte und externe Pfade liefern keinen Inhalt', async () => {
			for (const blocked of ['.env', 'node_modules/m.js', '../outside.txt']) {
				const result = await readProjectFile(root, blocked);
				assert.strictEqual(result.success, false, blocked);
				assert.ok(!result.content.includes('geheim'), blocked);
			}
		});

		test('list_directory: erlaubter Pfad listet, gesperrte Einträge und Pfade nicht', async () => {
			const listing = await listProjectDirectory(root, 'src');
			assert.strictEqual(listing.success, true);
			assert.ok(listing.content.includes('small.ts'));
			const top = await listProjectDirectory(root, '.');
			assert.strictEqual(top.success, true);
			assert.ok(top.content.includes('src'));
			assert.ok(!top.content.includes('.env'));
			assert.ok(!top.content.includes('node_modules'));
			for (const blocked of ['node_modules', '../']) {
				const result = await listProjectDirectory(root, blocked);
				assert.strictEqual(result.success, false, blocked);
			}
		});
	});

	suite('read_file_range', () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-range-'));
		const workspace = path.join(base, 'workspace');
		const outside = path.join(base, 'outside');
		fs.mkdirSync(workspace);
		fs.mkdirSync(outside);
		const root = vscode.Uri.file(workspace);
		const parse = (result: { success: boolean; content: string }) => JSON.parse(result.content) as {
			path: string;
			requestedRange: { firstLine: number; lastLine: number };
			readRange: { firstLine: number; lastLine: number } | null;
			totalLines: number;
			text: string;
			actualUtf8Bytes: number;
			note: string | null;
		};
		const write = (name: string, content: string) => {
			fs.mkdirSync(workspace, { recursive: true });
			fs.writeFileSync(path.join(workspace, name), content);
		};

		suiteTeardown(() => {
			fs.rmSync(base, { recursive: true, force: true });
		});

		test('liest einen gültigen inklusiven 1-basierten Zeilenbereich', async () => {
			write('valid.txt', 'erste\nzweite\ndritte\n');
			const result = await readProjectFileRange(root, 'valid.txt', 2, 3);
			assert.strictEqual(result.success, true);
			const report = parse(result);
			assert.strictEqual(report.path, 'valid.txt');
			assert.deepStrictEqual(report.readRange, { firstLine: 2, lastLine: 3 });
			assert.strictEqual(report.totalLines, 3);
			assert.strictEqual(report.text, 'zweite\ndritte');
			assert.strictEqual(report.note, null);
			assert.strictEqual(
				report.actualUtf8Bytes,
				Buffer.byteLength(JSON.stringify({ success: true, content: result.content }), 'utf8')
			);
		});

		test('liest erste und letzte vorhandene Zeile sowie den verfügbaren Teil am Dateiende', async () => {
			write('ends.txt', 'erste\nletzte');
			const all = parse(await readProjectFileRange(root, 'ends.txt', 1, 2));
			assert.deepStrictEqual(all.readRange, { firstLine: 1, lastLine: 2 });
			assert.strictEqual(all.text, 'erste\nletzte');
			const tail = parse(await readProjectFileRange(root, 'ends.txt', 2, 9));
			assert.deepStrictEqual(tail.readRange, { firstLine: 2, lastLine: 2 });
			assert.strictEqual(tail.text, 'letzte');
			assert.ok(tail.note?.includes('außerhalb'));
			const pastEnd = parse(await readProjectFileRange(root, 'ends.txt', 5, 7));
			assert.strictEqual(pastEnd.readRange, null);
			assert.strictEqual(pastEnd.text, '');
			assert.ok(pastEnd.note?.includes('2 Zeilen'));
		});

		test('lehnt ungültige und nicht ganzzahlige Zeilennummern sowie Start nach Ende ab', async () => {
			write('invalid.txt', 'line');
			for (const [first, last] of [[0, 1], [1, 1.5], ['1', 2], [NaN, 2]]) {
				const result = await readProjectFileRange(root, 'invalid.txt', first, last);
				assert.strictEqual(result.success, false);
				assert.ok(result.content.includes('positive ganze Zahlen'));
			}
			const reversed = await readProjectFileRange(root, 'invalid.txt', 2, 1);
			assert.strictEqual(reversed.success, false);
			assert.ok(reversed.content.includes('nicht nach'));
		});

		test('begrenzt die angeforderte Zeilenzahl', async () => {
			write('maximum.txt', 'x\n'.repeat(MAX_RANGE_LINES + 1));
			const result = await readProjectFileRange(root, 'maximum.txt', 1, MAX_RANGE_LINES + 1);
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes(`${MAX_RANGE_LINES} Zeilen`));
		});

		test('UTF-8-Bytebudget gibt keinen Teiltext zurück und meldet die Größe', async () => {
			write('large-utf8.txt', '🫧'.repeat(1_500));
			const result = await readProjectFileRange(root, 'large-utf8.txt', 1, 1);
			assert.strictEqual(result.success, false);
			const report = parse(result);
			assert.strictEqual(report.text, '');
			assert.strictEqual(report.readRange, null);
			assert.ok(report.note?.includes(`${MAX_RANGE_RESULT_BYTES} UTF-8-Bytes`));
			assert.ok(report.actualUtf8Bytes <= MAX_RANGE_RESULT_BYTES);
			assert.strictEqual(
				report.actualUtf8Bytes,
				Buffer.byteLength(JSON.stringify({ success: false, content: result.content }), 'utf8')
			);
		});

		test('Workspace-Grenze, Symlink, gesperrter Dateityp, Binärdatei und fehlende Datei bleiben gesperrt', async function () {
			write('image.png', 'not allowed');
			write('binary.txt', 'before\u0000after');
			fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
			try {
				fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'link.txt'), 'file');
			} catch (error) {
				console.warn('Symlink-Test NICHT AUSGEFÜHRT: ' + String(error));
				this.skip();
				return;
			}

			const escaped = await readProjectFileRange(root, '../outside/secret.txt', 1, 1);
			assert.strictEqual(escaped.success, false);
			assert.ok(!escaped.content.includes('secret'));
			const linked = await readProjectFileRange(root, 'link.txt', 1, 1);
			assert.strictEqual(linked.success, false);
			assert.ok(!linked.content.includes('secret'));
			const blocked = await readProjectFileRange(root, 'image.png', 1, 1);
			assert.strictEqual(blocked.success, false);
			assert.ok(blocked.content.includes('nicht als Textdatei freigegeben'));
			const binary = await readProjectFileRange(root, 'binary.txt', 1, 1);
			assert.strictEqual(binary.success, false);
			assert.ok(binary.content.includes('Binärdaten'));
			const missing = await readProjectFileRange(root, 'missing.txt', 1, 1);
			assert.strictEqual(missing.success, false);
			assert.ok(missing.content.includes('nicht gelesen'));
		});

		test('bestehendes read_file und list_directory behalten ihre Lesefunktion', async () => {
			write('regression.txt', 'unchanged');
			const file = await readProjectFile(root, 'regression.txt');
			assert.strictEqual(file.success, true);
			assert.ok(file.content.includes('unchanged'));
			const listing = await listProjectDirectory(root, '.');
			assert.strictEqual(listing.success, true);
			assert.ok(listing.content.includes('regression.txt'));
		});
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
			assert.strictEqual(requestBody?.model, getOllamaModel());
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

	test('Diff-Vorschau: UTF-8-BOM und ungültiges UTF-8 werden abgelehnt, normale Datei nicht', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-utf8-'));
		const originalFetch = globalThis.fetch;
		const wsUri = vscode.Uri.file(dir);
		let fetchCalls = 0;
		const files: Record<string, Buffer> = {
			'ok.txt': Buffer.from('Grüße\n', 'utf8'),
			'bom.txt': Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('text\n')]),
			'bad.txt': Buffer.from([0x61, 0xFF, 0xC3, 0x28, 0x0A])
		};
		for (const [name, bytes] of Object.entries(files)) {
			fs.writeFileSync(path.join(dir, name), bytes);
		}
		const before = snapshot(dir);

		try {
			globalThis.fetch = (async () => {
				fetchCalls += 1;
				return new Response(JSON.stringify({
					message: { content: JSON.stringify({ content: 'neu\n' }) }
				}));
			}) as typeof fetch;

			const ok = await prepareDiffPreview(wsUri, 'ok.txt', 'neu\n');
			assert.ok(ok.ok);
			assert.strictEqual(ok.original, 'Grüße\n');
			assert.deepStrictEqual(ok.originalBytes, Array.from(files['ok.txt']));
			const okAI = await prepareAIDiffPreview(wsUri, 'ok.txt', 'Ändere.');
			assert.ok(okAI.ok);
			assert.strictEqual(fetchCalls, 1);

			for (const [name, fragment] of [['bom.txt', 'BOM'], ['bad.txt', 'ungültiges UTF-8']]) {
				const manual = await prepareDiffPreview(wsUri, name, 'neu\n');
				assert.strictEqual(manual.ok, false, name);
				if (!manual.ok) {
					assert.ok(manual.reason.includes(fragment), manual.reason);
				}
				const ai = await prepareAIDiffPreview(wsUri, name, 'Ändere.');
				assert.strictEqual(ai.ok, false, name);
				if (!ai.ok) {
					assert.ok(ai.reason.includes(fragment), ai.reason);
				}
			}
			assert.strictEqual(fetchCalls, 1);
			assert.strictEqual(snapshot(dir), before);
		} finally {
			globalThis.fetch = originalFetch;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Diff-Vorschau: ungespeicherte Zieldatei bricht vor Ollama ab, unveränderte Datei nicht', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-dirty-'));
		const filePath = path.join(dir, 'a.txt');
		fs.writeFileSync(filePath, 'Stand auf Platte\n');
		const originalFetch = globalThis.fetch;
		const wsUri = vscode.Uri.file(dir);
		let fetchCalls = 0;

		try {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			globalThis.fetch = (async () => {
				fetchCalls += 1;
				return new Response(JSON.stringify({
					message: { content: JSON.stringify({ content: 'neu\n' }) }
				}));
			}) as typeof fetch;

			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
			const editor = await vscode.window.showTextDocument(document);
			const clean = await prepareDiffPreview(wsUri, 'a.txt', 'neu\n');
			assert.ok(clean.ok);
			assert.strictEqual(clean.original, 'Stand auf Platte\n');
			const cleanAI = await prepareAIDiffPreview(wsUri, 'a.txt', 'Ändere.');
			assert.ok(cleanAI.ok);
			assert.strictEqual(fetchCalls, 1);

			assert.ok(await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'Editor ')));
			assert.ok(document.isDirty);

			const manual = await prepareDiffPreview(wsUri, 'a.txt', 'neu\n');
			assert.strictEqual(manual.ok, false);
			if (!manual.ok) {
				assert.ok(manual.reason.includes('ungespeicherte Änderungen'));
			}
			const ai = await prepareAIDiffPreview(wsUri, 'a.txt', 'Ändere.');
			assert.strictEqual(ai.ok, false);
			if (!ai.ok) {
				assert.ok(ai.reason.includes('ungespeicherte Änderungen'));
			}
			assert.strictEqual(fetchCalls, 1);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'Stand auf Platte\n');
		} finally {
			globalThis.fetch = originalFetch;
			await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
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
		const originalInfo = win.showInformationMessage;
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
			win.showInformationMessage = async () => undefined;
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
			win.showInformationMessage = originalInfo;
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

	test('Freigabeentscheidung: Negativfälle der Zulässigkeitsprüfung (kein echter Schreibpfad bewiesen)', async function () {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-decide-'));
		fs.writeFileSync(path.join(dir, 'a.txt'), 'alt\n');
		fs.writeFileSync(path.join(dir, 'x.exe'), 'MZ');
		fs.mkdirSync(path.join(dir, 'sub'));
		const wsUri = vscode.Uri.file(dir);

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
				ws: vscode.Uri | null = wsUri,
				p: Extract<typeof preview, { ok: true }> = preview
			) => {
				const decision = await decideApply(ws ?? undefined, p);
				assert.strictEqual(decision.eligible, false, name);
				assert.strictEqual(snapshot(dir), before, name);
			};

			// Workspace, Pfad, Dateityp
			await expectDenied('kein Workspace', null);
			for (const bad of ['.env', 'node_modules/a.txt', '../a.txt', 'a.txt/../.env', 'x.exe', 'fehlt.txt', 'sub']) {
				await expectDenied(bad, wsUri, { ...preview, relativePath: bad });
			}
			await expectDenied('nicht normalisierter Pfad', wsUri, { ...preview, relativePath: './a.txt' });

			// Zu große Vorschlagstexte
			await expectDenied('zu groß', wsUri, { ...preview, proposed: 'x'.repeat(120_001) });

			// Verändertes Original: gleiche Länge, nur ein Byte anders
			fs.writeFileSync(path.join(dir, 'a.txt'), 'alx\n');
			const changed = snapshot(dir);
			const changedDecision = await decideApply(wsUri, preview);
			assert.strictEqual(changedDecision.eligible, false);
			assert.strictEqual(snapshot(dir), changed);

			// Gelöschte Datei
			fs.rmSync(path.join(dir, 'a.txt'));
			const deleted = await decideApply(wsUri, preview);
			assert.strictEqual(deleted.eligible, false);

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
					const viaLink = await decideApply(wsUri, preview);
					assert.strictEqual(viaLink.eligible, false);
					assert.strictEqual(fs.readFileSync(path.join(outside, 'a.txt'), 'utf8'), 'alt\n');
				}
			} finally {
				fs.rmSync(outside, { recursive: true, force: true });
			}

			// Positivfall: unverändertes Original
			fs.rmSync(path.join(dir, 'a.txt'), { force: true });
			fs.writeFileSync(path.join(dir, 'a.txt'), 'alt\n');
			const okSnapshot = snapshot(dir);
			const ok = await decideApply(wsUri, preview);
			assert.deepStrictEqual(ok, { eligible: true, relativePath: 'a.txt', content: 'neu\n' });
			assert.strictEqual(snapshot(dir), okSnapshot);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Freigabebeleg: nur intern ausgestellt, an den Vorschlag gebunden, einmalig; Negativfälle rufen den Fake-Writer nie auf', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-receipt-'));
		fs.writeFileSync(path.join(dir, 'a.txt'), 'alt\n');
		const wsUri = vscode.Uri.file(dir);
		const scheme = 'bubble-preview-receipt';
		const provider = new PreviewContentProvider(scheme);
		const registration = vscode.workspace.registerTextDocumentContentProvider(scheme, provider);
		const calls: Array<[string, string]> = [];
		const writer: ChangeWriter = {
			write: async (p, c) => { calls.push([p, c]); }
		};
		const show = async (proposed: string) => {
			const prepared = await prepareDiffPreview(wsUri, 'a.txt', proposed);
			assert.ok(prepared.ok);
			const shown = await showDiffPreview(provider, prepared);
			assert.ok(await waitFor(() => vscode.workspace.textDocuments.some(
				d => d.uri.toString() === shown.right.toString()
			)));
			return shown;
		};
		const approve = async (shown: Awaited<ReturnType<typeof show>>) => {
			const outcome = await recordSimulatedDecision(wsUri, shown, async () => 'approved');
			assert.strictEqual(outcome.status, 'recorded');
			assert.ok(outcome.status === 'recorded');
			return outcome.receipt;
		};
		const expectDenied = async (
			name: string,
			shown: Awaited<ReturnType<typeof show>>,
			receipt: unknown
		) => {
			const decision = await applyIfApproved(wsUri, shown, receipt as ApprovalReceipt, writer);
			assert.strictEqual(decision.eligible, false, name);
			assert.strictEqual(calls.length, 0, name);
		};

		try {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			const before = snapshot(dir);

			// Ablehnung und Abbruch liefern keinen Beleg
			let shown = await show('neu\n');
			for (const answer of ['rejected', 'cancelled', undefined] as const) {
				const outcome = await recordSimulatedDecision(wsUri, shown, async () => answer);
				assert.ok(!('receipt' in outcome), String(answer));
			}

			// Fälschungen
			const genuine = await approve(shown);
			await expectDenied('ohne Beleg', shown, undefined);
			await expectDenied('String approved', shown, 'approved');
			await expectDenied('Objekt-Literal', shown, { fingerprint: fingerprintPreview(shown.preview) });
			await expectDenied('Kopie', shown, { ...genuine });
			await expectDenied('Klon', shown, JSON.parse(JSON.stringify(genuine)));

			// Anderer Vorschlag mit demselben Pfad
			const other = await show('anders\n');
			await expectDenied('anderer Vorschlag', other, genuine);

			// Gültiger Beleg: genau ein Aufruf, danach verbraucht
			shown = await show('neu\n');
			const receipt = await approve(shown);
			const applied = await applyIfApproved(wsUri, shown, receipt, writer);
			assert.strictEqual(applied.eligible, true);
			assert.deepStrictEqual(calls, [['a.txt', 'neu\n']]);
			assert.strictEqual(snapshot(dir), before, 'Fake-Writer darf keine Datei ändern');
			calls.length = 0;
			await expectDenied('verbraucht', shown, receipt);

			// Veränderte Datei zwischen Beleg und Anwendung
			shown = await show('dritter\n');
			const staleReceipt = await approve(shown);
			fs.writeFileSync(path.join(dir, 'a.txt'), 'alx\n');
			await expectDenied('verändertes Original', shown, staleReceipt);
			fs.writeFileSync(path.join(dir, 'a.txt'), 'alt\n');

			// Geschlossener Diff nach Beleg
			shown = await show('vierter\n');
			const closedReceipt = await approve(shown);
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			assert.ok(await waitFor(() => diffTabCount() === 0));
			await expectDenied('geschlossener Diff', shown, closedReceipt);

			// Veränderte Datei während des Dialogs: kein Beleg
			shown = await show('fünfter\n');
			const changedOutcome = await recordSimulatedDecision(wsUri, shown, async () => {
				fs.writeFileSync(path.join(dir, 'a.txt'), 'alx\n');
				return 'approved';
			});
			assert.strictEqual(changedOutcome.status, 'stale');
			assert.ok(!('receipt' in changedOutcome));
			assert.strictEqual(calls.length, 0);
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			registration.dispose();
			provider.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Simulierte Freigabe: ungespeicherte Änderung der Zieldatei verhindert die Freigabe, andere ungespeicherte Dateien nicht', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-dirty-sim-'));
		fs.writeFileSync(path.join(dir, 'a.txt'), 'alt\n');
		fs.writeFileSync(path.join(dir, 'b.txt'), 'andere\n');
		const wsUri = vscode.Uri.file(dir);
		const scheme = 'bubble-preview-dirty';
		const provider = new PreviewContentProvider(scheme);
		const registration = vscode.workspace.registerTextDocumentContentProvider(scheme, provider);
		const calls: Array<[string, string]> = [];
		const writer: ChangeWriter = {
			write: async (p, c) => { calls.push([p, c]); }
		};
		const show = async () => {
			const prepared = await prepareDiffPreview(wsUri, 'a.txt', 'neu\n');
			assert.ok(prepared.ok);
			const shown = await showDiffPreview(provider, prepared);
			assert.ok(await waitFor(() => vscode.workspace.textDocuments.some(
				d => d.uri.toString() === shown.right.toString()
			)));
			return shown;
		};
		const makeDirty = async (name: string) => {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(dir, name)));
			const editor = await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
			assert.ok(await editor.edit(builder => builder.insert(new vscode.Position(0, 0), 'x')));
			assert.ok(document.isDirty);
		};
		const revert = async (name: string) => {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(dir, name)));
			await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
			await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
		};

		try {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');

			// Fall 1: Zieldatei wird nach dem Öffnen des Diffs während der Abfrage ungespeichert geändert
			let shown = await show();
			const during = await recordSimulatedDecision(wsUri, shown, async () => {
				await makeDirty('a.txt');
				return 'approved';
			});
			assert.strictEqual(during.status, 'stale');
			assert.ok(!('receipt' in during));
			assert.ok(!during.status.startsWith('rec') && 'reason' in during && during.reason.includes('ungespeicherte Änderungen'));

			// Bereits ungespeichert vor der Abfrage: keine Abfrage
			let prompts = 0;
			const before = await recordSimulatedDecision(wsUri, shown, async () => { prompts += 1; return 'approved'; });
			assert.strictEqual(before.status, 'ineligible');
			assert.strictEqual(prompts, 0);

			// Beleg vor der Änderung ausgestellt, danach ungespeichert geändert: kein Schreibaufruf
			await revert('a.txt');
			shown = await show();
			const issued = await recordSimulatedDecision(wsUri, shown, async () => 'approved');
			assert.ok(issued.status === 'recorded');
			await makeDirty('a.txt');
			const denied = await applyIfApproved(wsUri, shown, issued.status === 'recorded' ? issued.receipt : undefined, writer);
			assert.strictEqual(denied.eligible, false);
			assert.strictEqual(calls.length, 0);
			await revert('a.txt');
			assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'alt\n');

			// Fall 2: andere ungespeicherte Datei stört nicht
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			shown = await show();
			await makeDirty('b.txt');
			const other = await recordSimulatedDecision(wsUri, shown, async () => 'approved');
			assert.strictEqual(other.status, 'recorded');
			await revert('b.txt');
			assert.strictEqual(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'andere\n');
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			registration.dispose();
			provider.dispose();
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		}
	});

	test('Simulierte Freigabe: Zustimmung, Ablehnung, Abbruch, geschlossener Diff und geänderter Vorschlag schreiben nie', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-sim-'));
		fs.writeFileSync(path.join(dir, 'a.txt'), 'alt\n');
		const wsUri = vscode.Uri.file(dir);
		const scheme = 'bubble-preview-sim';
		const provider = new PreviewContentProvider(scheme);
		const registration = vscode.workspace.registerTextDocumentContentProvider(scheme, provider);
		const before = snapshot(dir);
		const show = async (proposed: string) => {
			const prepared = await prepareDiffPreview(wsUri, 'a.txt', proposed);
			assert.ok(prepared.ok);
			const shown = await showDiffPreview(provider, prepared);
			assert.ok(await waitFor(() => vscode.workspace.textDocuments.some(
				d => d.uri.toString() === shown.right.toString()
			)));
			return shown;
		};
		const assertNoWrite = (name: string) => {
			assert.strictEqual(snapshot(dir), before, name);
			assert.ok(!vscode.workspace.textDocuments.some(d => d.isDirty), name);
		};

		try {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');

			// Zustimmung
			let prompts = 0;
			const approve: ApprovalPrompt = async () => { prompts += 1; return 'approved'; };
			let shown = await show('neu\n');
			const ok = await recordSimulatedDecision(wsUri, shown, approve);
			assert.strictEqual(ok.status, 'recorded');
			assert.ok(ok.status === 'recorded' && ok.message === SIMULATED_APPROVAL_MESSAGE);
			assert.strictEqual(SIMULATED_APPROVAL_MESSAGE, 'Freigabe erfasst; Änderung nicht angewendet.');
			assert.strictEqual(prompts, 1);
			assertNoWrite('Zustimmung');

			// Ablehnung und Abbruch
			const rejected = await recordSimulatedDecision(wsUri, shown, async () => 'rejected');
			assert.strictEqual(rejected.status, 'rejected');
			const cancelled = await recordSimulatedDecision(wsUri, shown, async () => undefined);
			assert.strictEqual(cancelled.status, 'cancelled');
			assertNoWrite('Ablehnung/Abbruch');

			// Geschlossener Diff: keine Abfrage, keine Freigabe
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			assert.ok(await waitFor(() => diffTabCount() === 0));
			prompts = 0;
			const closed = await recordSimulatedDecision(wsUri, shown, approve);
			assert.strictEqual(closed.status, 'not-shown');
			assert.strictEqual(prompts, 0);
			assertNoWrite('geschlossener Diff');

			// Diff wird während der Abfrage durch einen anderen Vorschlag ersetzt
			shown = await show('erster\n');
			const replaced = await recordSimulatedDecision(wsUri, shown, async () => {
				await show('zweiter\n');
				return 'approved';
			});
			assert.strictEqual(replaced.status, 'stale');
			assertNoWrite('ersetzter Vorschlag');

			// Diff während der Abfrage geschlossen
			shown = await show('dritter\n');
			const closedDuring = await recordSimulatedDecision(wsUri, shown, async () => {
				await vscode.commands.executeCommand('workbench.action.closeAllEditors');
				assert.ok(await waitFor(() => diffTabCount() === 0));
				return 'approved';
			});
			assert.strictEqual(closedDuring.status, 'stale');
			assertNoWrite('Diff während Abfrage geschlossen');

			// Originaldatei während der Abfrage verändert (gleiche Länge)
			shown = await show('vierter\n');
			const changed = await recordSimulatedDecision(wsUri, shown, async () => {
				fs.writeFileSync(path.join(dir, 'a.txt'), 'alx\n');
				return 'approved';
			});
			assert.strictEqual(changed.status, 'stale');
			assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'alx\n', 'nur die Teständerung darf vorhanden sein');
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			registration.dispose();
			provider.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Simulierte Freigabe über den Befehl: Meldung nur bei Zustimmung, Datei unverändert', async () => {
		const extension = vscode.extensions.getExtension('undefined_publisher.bubble-vscode-agent');
		assert.ok(extension);
		await extension.activate();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');

		const workspaceUri = vscode.workspace.workspaceFolders![0].uri;
		const targetUri = vscode.Uri.joinPath(workspaceUri, 'README.md');
		const fileBefore = fs.readFileSync(targetUri.fsPath);
		const win = vscode.window as unknown as Record<string, unknown>;
		const originals = {
			open: win.showOpenDialog,
			input: win.showInputBox,
			info: win.showInformationMessage
		};
		const infos: string[] = [];
		let choice: string | undefined;

		try {
			win.showOpenDialog = async () => [targetUri];
			win.showInputBox = async () => 'Neuer Text';
			win.showInformationMessage = async (message: string) => {
				infos.push(message);
				return choice;
			};

			for (const [pick, expected] of [
				['Vorschlag freigeben', 'Bubble: Freigabe erfasst; Änderung nicht angewendet.'],
				['Ablehnen', undefined],
				[undefined, undefined]
			] as const) {
				choice = pick;
				infos.length = 0;
				await vscode.commands.executeCommand('workbench.action.closeAllEditors');
				await vscode.commands.executeCommand('bubble-vscode-agent.previewDiff');
				assert.ok(infos.length >= 2, String(pick));
				assert.strictEqual(
					infos.includes('Bubble: Freigabe erfasst; Änderung nicht angewendet.'),
					expected !== undefined,
					String(pick)
				);
				assert.deepStrictEqual(fs.readFileSync(targetUri.fsPath), fileBefore);
			}
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			win.showOpenDialog = originals.open;
			win.showInputBox = originals.input;
			win.showInformationMessage = originals.info;
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

			test('Property-Zugriffe sind keine Dateipfade; gelesene und ungelesene Pfade bleiben korrekt', () => {
				const plan = [
					'1. Ziel der Änderung',
					'Die Abbruchprüfungen `controller.signal` und `controller.signal.aborted` bleiben erhalten.',
					'2. betroffene Dateien, nur soweit tatsächlich geprüft',
					'- `src/chat/chatSession.ts`',
					'- `src/chat/chatView.ts`',
					'3. höchstens drei Umsetzungsschritte',
					'1. Anzeige anpassen',
					'4. nötige Tests',
					'Chat-Tests ausführen.',
					'5. offene Fragen oder unbelegte Annahmen',
					'Keine'
				].join('\n');

				const evidence = [{
					tool: 'read_file',
					target: 'src/chat/chatSession.ts',
					success: true
				}];
				const validation = validatePlanOutput(plan, evidence);

				assert.deepStrictEqual(validation.unverifiedFiles, ['src/chat/chatView.ts']);
				assert.strictEqual(validation.valid, false);
				const formatted = formatPlanResponse(plan, evidence, 0);
				assert.ok(formatted.includes('- `src/chat/chatSession.ts`'));
				assert.ok(formatted.includes('src/chat/chatView.ts'));
				assert.ok(formatted.includes(
					'Unklar, weil nicht gelesen: Aussagen oder Vorschläge zu src/chat/chatView.ts'
				));
				assert.ok(!validation.unverifiedFiles.includes('controller.signal.aborted'));
				assert.ok(!validation.unverifiedFiles.includes('controller.signal'));
			});

			// Simulierte Modellantworten: prüfen nur die Nachbearbeitung, nicht Devstrals Verhalten.
			const p3Plan = [
				'### 1. Ziel der Änderung',
				'Release-Datum im Chat-Header anzeigen.',
				'### 2. betroffene Dateien, nur soweit tatsächlich geprüft',
				'- `src/extension.ts`',
				'### 3. höchstens drei Umsetzungsschritte',
				'1. Funktion `getBubbleReleaseDate()` in `src/extension.ts` einführen.',
				'2. `getBubbleVersion()` in `src/extension.ts` erweitern.',
				'3. Header in `src/chat/chatView.ts` um das Datum ergänzen.',
				'### 4. nötige Tests',
				'Header-Test.',
				'### 5. offene Fragen oder unbelegte Annahmen',
				'Keine'
			].join('\n');
			// Treffer in extension.ts bei Zeile 66 (liegt im gelesenen Bereich 60-80);
			// die Suche in chatView.ts war erfolgreich, lieferte aber 0 Treffer.
			const p3Evidence = [
				{ tool: 'search_text', target: '"getBubbleVersion" in src/extension.ts', success: true, query: 'getBubbleVersion', hits: [{ path: 'src/extension.ts', line: 66 }] },
				{ tool: 'search_text', target: '"getBubbleVersion" in src/chat/chatView.ts', success: true, query: 'getBubbleVersion', hits: [] },
				{ tool: 'read_file_range', target: 'src/extension.ts', success: true, deliveredRange: { firstLine: 60, lastLine: 80 } },
				{ tool: 'read_file_range', target: 'src/extension.ts', success: true, deliveredRange: { firstLine: 165, lastLine: 180 } }
			];
			const stepOf = (text: string, start: string): string | undefined =>
				text.split('\n').find(l => l.startsWith(start));

			test('Suchtreffer allein gilt nicht als gelesene Datei: Schritt zur ungelesenen Datei nennt den konkreten Pfad', () => {
				const validation = validatePlanOutput(p3Plan, p3Evidence);
				assert.deepStrictEqual(validation.unverifiedFiles, ['src/chat/chatView.ts']);
				const formatted = formatPlanResponse(p3Plan, p3Evidence, 0);
				assert.ok(stepOf(formatted, '3. Header in')?.includes('[UNGEPRÜFT: src/chat/chatView.ts nicht gelesen, nur Annahme]'));
				assert.ok(formatted.includes('Unklar, weil nicht gelesen: Aussagen oder Vorschläge zu src/chat/chatView.ts'));
				assert.ok(formatted.includes('WARNUNG (Unbelegte Dateibehauptung):'));
			});

			test('L3: package.json wird im Schritt beim Namen genannt, nicht nur allgemein', () => {
				const plan = p3Plan.replace(
					'3. Header in `src/chat/chatView.ts` um das Datum ergänzen.',
					'3. Feld `releaseDate` in `package.json` auswerten.'
				);
				const step = stepOf(formatPlanResponse(plan, p3Evidence, 0), '3. Feld');
				assert.ok(step?.includes('[UNGEPRÜFT: package.json nicht gelesen, nur Annahme]'));
			});

			test('L1: Suche mit 0 Treffern belegt kein Symbol; Treffer in anderer Datei belegt es nicht für die genannte Datei', () => {
				const plan = (step: string) => [
					'1. Ziel der Änderung', 'Ziel.',
					'2. betroffene Dateien, nur soweit tatsächlich geprüft', '- `src/extension.ts`',
					'3. höchstens drei Umsetzungsschritte', step,
					'4. nötige Tests', 'Test.',
					'5. offene Fragen oder unbelegte Annahmen', 'Keine'
				].join('\n');
				const read = { tool: 'read_file_range', target: 'src/extension.ts', success: true, deliveredRange: { firstLine: 1, lastLine: 200 } };
				const zeroHits = [{ tool: 'search_text', target: '"foo" in src/extension.ts', success: true, query: 'renderVersion', hits: [] }, read];
				const wrongFile = [{ tool: 'search_text', target: '"foo" in **/*', success: true, query: 'renderVersion', hits: [{ path: 'src/other.ts', line: 3 }] }, read];
				const rightFile = [{ tool: 'search_text', target: '"foo" in **/*', success: true, query: 'renderVersion', hits: [{ path: 'src/extension.ts', line: 90 }] }, read];
				const step = '1. Rufe `renderVersion()` in `src/extension.ts` Zeile 90 auf.';
				assert.ok(stepOf(formatPlanResponse(plan(step), zeroHits, 0), '1. Rufe')?.includes('[UNBELEGT: renderVersion()'));
				assert.ok(stepOf(formatPlanResponse(plan(step), wrongFile, 0), '1. Rufe')?.includes('[UNBELEGT: renderVersion()'));
				assert.ok(!stepOf(formatPlanResponse(plan(step), rightFile, 0), '1. Rufe')?.includes('UNBELEGT'));
				// Ohne Trefferdaten (Altbeleg) gilt das Symbol nicht als belegt.
				const legacy = [{ tool: 'search_text', target: '"renderVersion" in **/*', success: true }, read];
				assert.ok(stepOf(formatPlanResponse(plan(step), legacy, 0), '1. Rufe')?.includes('UNBELEGT'));
			});

			test('Symbol mit Treffer in der genannten, gelesenen Datei und Bereich bleibt unmarkiert', () => {
				const formatted = formatPlanResponse(p3Plan, p3Evidence, 0);
				const step2 = stepOf(formatted, '2. `getBubbleVersion()`');
				assert.ok(step2 && !step2.includes('UNBELEGT') && !step2.includes('UNGEPRÜFT'));
				const filesSection = formatted.split('### 3.')[0];
				assert.ok(filesSection.includes('- `src/extension.ts`'));
				assert.ok(!filesSection.includes('chatView.ts'));
			});

			test('L2: Stelle ohne Zuordnung zu den gelieferten Bereichen wird als ungeprüft gekennzeichnet; Bereichsgrenzen werden genannt', () => {
				const plan = [
					'1. Ziel der Änderung', 'Ziel.',
					'2. betroffene Dateien, nur soweit tatsächlich geprüft', '- `src/extension.ts`',
					'3. höchstens drei Umsetzungsschritte',
					'1. Chat-Header in `src/extension.ts` um das Datum ergänzen.',
					'2. In `src/extension.ts` Zeile 70 den Wert anpassen.',
					'3. In `src/extension.ts` Zeile 120 den Wert anpassen.',
					'4. nötige Tests', 'Test.',
					'5. offene Fragen oder unbelegte Annahmen', 'Keine'
				].join('\n');
				const formatted = formatPlanResponse(plan, p3Evidence, 0);
				assert.ok(stepOf(formatted, '1. Chat-Header')?.includes('[UNGEPRÜFT: Stelle in src/extension.ts nicht aus den gelesenen Zeilen 60-80, 165-180 zuordenbar]'));
				assert.ok(!stepOf(formatted, '2. In')?.includes('UNGEPRÜFT'));
				assert.ok(stepOf(formatted, '3. In')?.includes('[UNGEPRÜFT: Stelle in src/extension.ts'));
			});

			test('L2: vollständig gelesene Datei erzeugt keine Bereichsmarkierung', () => {
				const evidence = [{ tool: 'read_file', target: 'src/extension.ts', success: true }];
				const formatted = formatPlanResponse(p3Plan, evidence, 0);
				assert.ok(!formatted.includes('nicht aus den gelesenen Zeilen'));
			});

			test('Neu vorgeschlagenes Symbol wird nicht als bestehendes behauptet; bestehendes ohne Treffer wird markiert', () => {
				const plan = [
					'1. Ziel der Änderung', 'Ziel.',
					'2. betroffene Dateien, nur soweit tatsächlich geprüft', '- `src/extension.ts`',
					'3. höchstens drei Umsetzungsschritte',
					'1. Rufe die bestehende Funktion `formatReleaseDate()` auf.',
					'2. Neue Funktion `getBubbleReleaseDate()` einführen.',
					'3. `getBubbleVersion()` erweitern.',
					'4. nötige Tests', 'Test.',
					'5. offene Fragen oder unbelegte Annahmen', 'Keine'
				].join('\n');
				const formatted = formatPlanResponse(plan, p3Evidence, 0);
				assert.ok(stepOf(formatted, '1. Rufe')?.includes('[UNBELEGT: formatReleaseDate()'));
				assert.ok(!stepOf(formatted, '2. Neue')?.includes('UNBELEGT'));
				assert.ok(!stepOf(formatted, '3. `getBubbleVersion()`')?.includes('UNBELEGT'));
			});

			const symbolPlan = (step: string) => [
				'1. Ziel der Änderung', 'Ziel.',
				'2. betroffene Dateien, nur soweit tatsächlich geprüft', '- `src/extension.ts`',
				'3. höchstens drei Umsetzungsschritte', step,
				'4. nötige Tests', 'Test.',
				'5. offene Fragen oder unbelegte Annahmen', 'Keine'
			].join('\n');
			const symbolRead = { tool: 'read_file_range', target: 'src/extension.ts', success: true, deliveredRange: { firstLine: 60, lastLine: 80 } };
			const symbolHits = (hits: Array<{ path: string; line: number }>, query = 'getBubbleVersion') =>
				({ tool: 'search_text', target: `"${query}" in **/*`, success: true, query, hits });

			test('Symbol mit ausgegebenem Treffer plus ungelesene zweite Datei: kein UNBELEGT, UNGEPRÜFT mit Pfad bleibt', () => {
				const step = '1. Funktion `getBubbleVersion()` um ein `releaseDate`-Feld aus `package.json` erweitern.';
				const evidence = [
					symbolHits([{ path: 'src/extension.ts', line: 66 }, { path: 'src/extension.ts', line: 130 }, { path: 'src/extension.ts', line: 173 }]),
					symbolRead
				];
				const result = stepOf(formatPlanResponse(symbolPlan(step), evidence, 0), '1. Funktion');
				assert.ok(result && !result.includes('UNBELEGT'));
				assert.ok(result?.includes('[UNGEPRÜFT: package.json nicht gelesen, nur Annahme]'));
			});

			test('Symbol mit 0 Treffern, Treffer für anderes Symbol oder nicht ausgegebener Treffer belegt nichts, auch mit ungelesener zweiter Datei', () => {
				const step = '1. Funktion `getBubbleVersion()` um ein `releaseDate`-Feld aus `package.json` erweitern.';
				const cases = [
					[symbolHits([]), symbolRead],
					[symbolHits([{ path: 'src/extension.ts', line: 66 }], 'anderesSymbol'), symbolRead],
					[{ tool: 'search_text', target: '"getBubbleVersion" in **/*', success: true, query: 'getBubbleVersion' }, symbolRead]
				];
				for (const evidence of cases) {
					const result = stepOf(formatPlanResponse(symbolPlan(step), evidence, 0), '1. Funktion');
					assert.ok(result?.includes('[UNBELEGT: getBubbleVersion()'));
					assert.ok(result?.includes('[UNGEPRÜFT: package.json nicht gelesen, nur Annahme]'));
				}
			});

			test('Treffer nur in anderer Datei bei ausdrücklich genannter gelesener Datei belegt das Symbol nicht', () => {
				const step = '1. Rufe `getBubbleVersion()` in `src/extension.ts` auf.';
				const evidence = [symbolHits([{ path: 'src/other.ts', line: 5 }]), symbolRead];
				assert.ok(stepOf(formatPlanResponse(symbolPlan(step), evidence, 0), '1. Rufe')?.includes('[UNBELEGT: getBubbleVersion()'));
			});

			test('Symboltreffer bestätigt nicht die ganze Aussage: ungelesene Datei im selben Schritt bleibt UNGEPRÜFT, Treffer in genannter ungelesener Datei belegt nur die Existenz', () => {
				const step = '1. `getBubbleVersion()` in `package.json` und `src/extension.ts` anpassen.';
				const evidence = [symbolHits([{ path: 'src/extension.ts', line: 66 }]), symbolRead];
				const result = stepOf(formatPlanResponse(symbolPlan(step), evidence, 0), '1. `get');
				assert.ok(!result?.includes('UNBELEGT'));
				assert.ok(result?.includes('[UNGEPRÜFT: package.json nicht gelesen, nur Annahme]'));
			});
			test('Ohne Belege bleibt ein ehrlicher Teilplan zulässig: nur Markierungen kommen hinzu, nichts wird entfernt', () => {
				const formatted = formatPlanResponse(p3Plan, [], 0);
				assert.ok(formatted.includes('Release-Datum im Chat-Header anzeigen.'));
				assert.ok(formatted.includes('3. Header in `src/chat/chatView.ts` um das Datum ergänzen.'));
				assert.ok(formatted.includes('[UNGEPRÜFT: src/chat/chatView.ts'));
			});
			test('Vorab gelesene Dateien werden ergänzt und ungeprüfte Planbezüge als unklar markiert', () => {
				const plan = [
					'1. Ziel der Änderung',
					'Verbessere die Chat-Anzeige.',
					'2. betroffene Dateien, nur soweit tatsächlich geprüft',
					'Keine',
					'3. höchstens drei Umsetzungsschritte',
					'1. Passe die UI-Logik in `src/chat/chatView.ts` an.',
					'4. nötige Tests',
					'Chat-Tests ausführen.',
					'5. offene Fragen oder unbelegte Annahmen',
					'Keine'
				].join('\n');
				const evidence = [{
					tool: 'read_file',
					target: 'src/chat/chatSession.ts',
					success: true
				}];

				const formatted = formatPlanResponse(plan, evidence, 0);

				assert.ok(formatted.includes(
					'- `src/chat/chatSession.ts`'
				));
				assert.ok(!formatted.includes(
					'betroffene Dateien, nur soweit tatsächlich geprüft\nKeine'
				));
				assert.ok(formatted.includes(
					'Unklar, weil nicht gelesen: Aussagen oder Vorschläge zu src/chat/chatView.ts'
				));
				assert.ok(formatted.includes(
					'nicht erfolgreich mit einem Lesewerkzeug geprüft'
				));
				assert.ok(!validatePlanOutput(plan, evidence).valid);
			});

			suite('Konkrete Änderung an eindeutig benannter Datei', () => {
				const wish = 'Plane eine Änderung an der Abbruchbehandlung in src/chat/chatView.ts.';
				const file = 'src/chat/chatView.ts';
				const plan = [
					'1. Ziel der Änderung',
					'Abbruch anpassen.',
					'2. betroffene Dateien, nur soweit tatsächlich geprüft',
					'Keine',
					'3. höchstens drei Umsetzungsschritte',
					`1. Funktion Y in ${file} anpassen`,
					'4. nötige Tests',
					'Test',
					'5. offene Fragen oder unbelegte Annahmen',
					'Keine'
				].join('\n');

				test('erkennt nur genau eine Zieldatei bei Änderungswunsch', () => {
					assert.strictEqual(extractChangeTargetFile(wish), file);
					assert.strictEqual(extractChangeTargetFile('Plane eine Umstrukturierung der Chat-Logik in src/chat/.'), undefined);
					assert.strictEqual(extractChangeTargetFile('Erkläre src/extension.ts.'), undefined);
					assert.strictEqual(extractChangeTargetFile('Ändere src/a.ts und src/b.ts.'), undefined);
				});

				test('P4 ohne Lesebeleg: nur Suche mit Treffern ergibt keinen Plan', () => {
					const ev = [{
						tool: 'search_text', target: '"src/chat/chatView.ts" in **/*', success: true,
						query: file, hits: [{ path: 'docs/notes.md', line: 1 }, { path: file, line: 3 }]
					}];
					const out = formatPlanResponse(plan, ev, 0, wish);
					assert.ok(out.includes(`Die Datei ${file} wurde nicht geprüft`));
					assert.ok(out.includes('kein belastbarer Plan'));
					assert.ok(!out.includes('Funktion Y'));
				});

				test('gelesener Bereich: begrenzter, gekennzeichneter Teilplan bleibt möglich', () => {
					const ev = [{ tool: 'read_file_range', target: file, success: true, deliveredRange: { firstLine: 10, lastLine: 40 } }];
					const out = formatPlanResponse(plan, ev, 0, wish);
					assert.ok(out.includes('Funktion Y'));
					assert.ok(!out.includes('kein belastbarer Plan'));
				});

				test('allgemeine Planungsfrage ohne Zieldatei wird nicht blockiert', () => {
					const out = formatPlanResponse(plan, [], 0, 'Plane eine Änderung der Abbruchbehandlung im Chat.');
					assert.ok(out.includes('Funktion Y'));
					assert.ok(!out.includes('kein belastbarer Plan'));
				});
			});

			suite('Ausdrücklich verlangte Dateiprüfung', () => {
				const wish = 'Lies zuerst src/agent/readOnlyAgent.ts mit read_file und plane dann eine Änderung.';
				const file = 'src/agent/readOnlyAgent.ts';
				const plan = [
					'1. Ziel der Änderung',
					'Ändere readOnlyAgent.ts.',
					'2. betroffene Dateien, nur soweit tatsächlich geprüft',
					'Keine',
					'3. höchstens drei Umsetzungsschritte',
					'1. Funktion X in src/agent/readOnlyAgent.ts anpassen',
					'4. nötige Tests',
					'Test',
					'5. offene Fragen oder unbelegte Annahmen',
					'Keine'
				].join('\n');

				test('erkennt die verlangte Datei', () => {
					assert.deepStrictEqual(extractRequestedFiles(wish), [file]);
					assert.deepStrictEqual(extractRequestedFiles('Füge eine Option hinzu.'), []);
				});

				test('kein Werkzeugaufruf: nicht als fehlgeschlagen, kein Plan', () => {
					assert.strictEqual(getFileReadStatus(file, []), 'not-attempted');
					const out = formatPlanResponse(plan, [], 0, wish);
					assert.ok(out.includes('kein read_file-Versuch'));
					assert.ok(!out.includes('fehlgeschlagen.'));
					assert.ok(out.includes('Offene Frage'));
					assert.ok(!out.includes('Funktion X'));
				});

				test('read_file mit Fehler: als fehlgeschlagen gekennzeichnet', () => {
					const ev = [{ tool: 'read_file', target: file, success: false }];
					assert.strictEqual(getFileReadStatus(file, ev), 'failed');
					const out = formatPlanResponse(plan, ev, 0, wish);
					assert.ok(out.includes('read_file wurde versucht, ist aber fehlgeschlagen'));
					assert.ok(!out.includes('Funktion X'));
				});

				test('erfolgreiches read_file der Datei: Plan zugelassen', () => {
					const ev = [{ tool: 'read_file', target: file, success: true }];
					assert.strictEqual(getFileReadStatus(file, ev), 'read');
					const out = formatPlanResponse(plan, ev, 0, wish);
					assert.ok(out.includes('Funktion X'));
					assert.ok(!out.includes('HINWEIS'));
				});

				test('erfolgreiches read_file_range der Datei: Plan zugelassen', () => {
					const ev = [{ tool: 'read_file_range', target: file, success: true }];
					assert.strictEqual(getFileReadStatus(file, ev), 'read');
					const out = formatPlanResponse(plan, ev, 0, wish);
					assert.ok(out.includes('Funktion X'));
					assert.ok(!out.includes('HINWEIS'));
				});

				test('Zahlen und Abkürzungen werden nicht als Datei erkannt', () => {
					assert.deepStrictEqual(extractRequestedFiles('Prüfe, ob 32.000 Bytes reichen, z.B. bei v1.2 oder 3.5 und e.g. 0.75.'), []);
					assert.deepStrictEqual(extractRequestedFiles('Prüfe 32.000 Bytes und lies package.json.'), ['package.json']);
				});

				test('Protokoll begrenzt: kein sicherer Status "nicht versucht"', () => {
					const ev = [{ tool: 'list_directory', target: '.', success: true }];
					assert.strictEqual(getFileReadStatus(file, ev, 3), 'unknown');
					const out = formatPlanResponse(plan, ev, 3, wish);
					assert.ok(out.includes('Status nicht feststellbar'));
					assert.ok(!out.includes('kein read_file-Versuch'));
					assert.ok(!out.includes('fehlgeschlagen.'));
					assert.ok(!out.includes('Funktion X'));
				});

				test('Protokoll begrenzt, aber sichtbares erfolgreiches read_file: gelesen', () => {
					const ev = [{ tool: 'read_file', target: file, success: true }];
					assert.strictEqual(getFileReadStatus(file, ev, 3), 'read');
				});
				test('andere Datei gelesen: angefragte Datei bleibt ungeprüft', () => {
					const ev = [{ tool: 'read_file', target: 'src/extension.ts', success: true }];
					assert.strictEqual(getFileReadStatus(file, ev), 'not-attempted');
					const out = formatPlanResponse(plan, ev, 0, wish);
					assert.ok(out.includes('kein read_file-Versuch'));
					assert.ok(!out.includes('Funktion X'));
				});

				test('Pre-Reading via initialFiles: Erfolgreiches Vorab-Lesen, Gesperrt, Lesefehler und Limit', async () => {
					// Eigener Workspace: Größe von README.md/PROJECT_STATE.md des echten Repositories
					// darf das Requestbudget dieses Tests nicht bestimmen.
					const ownWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-pre-read-ws-'));
					fs.writeFileSync(path.join(ownWorkspace, 'README.md'), '# Testprojekt\nkurz\n');
					const workspaceUri = vscode.Uri.file(ownWorkspace);
					const originalFetch = globalThis.fetch;

					try {
						// 1. Erfolgreiches Lesen der vorab geforderten Datei
						let fetchCalls = 0;
						globalThis.fetch = (async () => {
							fetchCalls += 1;
							return new Response(JSON.stringify({
								message: {
									role: 'assistant',
									content: '1. Ziel der Änderung\nZiel\n\n2. betroffene Dateien, nur soweit tatsächlich geprüft\n- `README.md`\n\n3. höchstens drei Umsetzungsschritte\n1. Schritt 1\n\n4. nötige Tests\nTest\n\n5. offene Fragen oder unbelegte Annahmen\nKeine'
								}
							}));
						}) as unknown as typeof fetch;

						const resSuccess = await runReadOnlyAgent(
							workspaceUri,
							'Planung',
							undefined,
							[],
							['README.md']
						);
						assert.strictEqual(fetchCalls, 1);
						assert.strictEqual(resSuccess.evidence.length, 1);
						assert.strictEqual(resSuccess.evidence[0].tool, 'read_file');
						assert.strictEqual(resSuccess.evidence[0].target, 'README.md');
						assert.strictEqual(resSuccess.evidence[0].success, true);

						const formattedSuccess = formatPlanResponse(
							resSuccess.answer,
							resSuccess.evidence,
							resSuccess.omitted,
							'Lies README.md und plane'
						);
						assert.ok(!formattedSuccess.includes('HINWEIS'));
						assert.ok(formattedSuccess.includes('1. Ziel der Änderung'));

						// 2. Gesperrte Datei
						fetchCalls = 0;
						const resBlocked = await runReadOnlyAgent(
							workspaceUri,
							'Planung',
							undefined,
							[],
							['config/db.php']
						);
						assert.strictEqual(fetchCalls, 0, 'Ollama darf bei gesperrter Datei nicht aufgerufen werden');
						assert.strictEqual(resBlocked.evidence.length, 1);
						assert.strictEqual(resBlocked.evidence[0].success, false);

						const formattedBlocked = formatPlanResponse(
							resBlocked.answer,
							resBlocked.evidence,
							resBlocked.omitted,
							'Lies config/db.php und plane'
						);
						assert.ok(formattedBlocked.includes('read_file wurde versucht, ist aber fehlgeschlagen.'));
						assert.ok(formattedBlocked.includes('HINWEIS: Die ausdrücklich verlangte Dateiprüfung liegt nicht vor.'));

						// 3. Nicht existierende Datei (Lesefehler)
						fetchCalls = 0;
						const resNotFound = await runReadOnlyAgent(
							workspaceUri,
							'Planung',
							undefined,
							[],
							['non-existent-file-12345.ts']
						);
						assert.strictEqual(fetchCalls, 0, 'Ollama darf bei Lesefehler nicht aufgerufen werden');
						assert.strictEqual(resNotFound.evidence.length, 1);
						assert.strictEqual(resNotFound.evidence[0].success, false);

						const formattedNotFound = formatPlanResponse(
							resNotFound.answer,
							resNotFound.evidence,
							resNotFound.omitted,
							'Lies non-existent-file-12345.ts und plane'
						);
						assert.ok(formattedNotFound.includes('read_file wurde versucht, ist aber fehlgeschlagen.'));
						assert.ok(formattedNotFound.includes('HINWEIS: Die ausdrücklich verlangte Dateiprüfung liegt nicht vor.'));

						// 4. Überschreitung der Kontextgrenze
						const bigTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-pre-read-limit-'));
						try {
							fs.writeFileSync(path.join(bigTempDir, 'huge.md'), 'x'.repeat(MAX_REQUEST_BYTES));
							fetchCalls = 0;
							let requestBytes = 0;
							let requestBody = '';
							globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
								fetchCalls += 1;
								requestBody = String(init?.body ?? '');
								requestBytes = Buffer.byteLength(requestBody, 'utf8');
								return new Response(JSON.stringify({
									message: { role: 'assistant', content: 'Analyse nach Budgethinweis.' }
								}));
							}) as unknown as typeof fetch;
							const largeRead = await runReadOnlyAgent(
								vscode.Uri.file(bigTempDir),
								'Planung',
								undefined,
								[],
								['huge.md']
							);
							assert.strictEqual(fetchCalls, 1);
							assert.ok(requestBytes <= MAX_REQUEST_BYTES);
							assert.strictEqual(largeRead.toolDiagnostics?.length, 0);
							assert.strictEqual(largeRead.evidence.length, 0, 'keine Datei gilt als gelesen');
							assert.strictEqual(getFileReadStatus('huge.md', largeRead.evidence), 'not-attempted');
							assert.ok(requestBody.includes('huge.md'), 'der Pfad bleibt dem Modell bekannt');
							assert.ok(requestBody.includes('read_file_range'));
							assert.ok(!requestBody.includes('x'.repeat(100)), 'kein Dateiinhalt übermittelt');
							assert.ok(!JSON.stringify(largeRead).includes('x'.repeat(100)));

							// Kleine ausdrücklich genannte Datei wird weiterhin vollständig vorab gelesen
							fs.writeFileSync(path.join(bigTempDir, 'small.md'), 'kleiner Inhalt');
							const smallRead = await runReadOnlyAgent(
								vscode.Uri.file(bigTempDir),
								'Planung',
								undefined,
								[],
								['small.md']
							);
							assert.strictEqual(smallRead.evidence[0].tool, 'read_file');
							assert.strictEqual(smallRead.evidence[0].success, true);
							assert.ok(requestBody.includes('kleiner Inhalt'));
							assert.ok(!requestBody.includes('zu groß für das 32.000-Byte-Requestbudget'));
						} finally {
							fs.rmSync(bigTempDir, { recursive: true, force: true });
						}

					} finally {
						globalThis.fetch = originalFetch;
						fs.rmSync(ownWorkspace, { recursive: true, force: true });
					}
				});
			});
			test('Pre-Reading: reserviert bei nahezu voller Anfrage Platz für den Ablehnungshinweis', async () => {
				const originalFetch = globalThis.fetch;
				const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-pre-read-full-'));

				try {
					let fetchCalls = 0;
					let lastBodyBytes = 0;
					globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
						fetchCalls += 1;
						lastBodyBytes = Buffer.byteLength(String(init?.body ?? ''), 'utf8');
						return new Response(JSON.stringify({
							message: { role: 'assistant', content: 'Antwort' }
						}));
					}) as unknown as typeof fetch;

					const uri = vscode.Uri.file(tempDir);
					const rulesFile = path.join(tempDir, 'AGENTS.md');

					// Grundanfrage kalibrieren: knapp unter der Grenze, aber
					// kleiner als die Zusatznachrichten des Vorab-Lesens.
					fs.writeFileSync(rulesFile, 'x'.repeat(1000));
					await runReadOnlyAgent(uri, 'Planung');
					const margin = 50;
					const size = 1000 + (MAX_REQUEST_BYTES - margin - lastBodyBytes);
					fs.writeFileSync(rulesFile, 'x'.repeat(size));
					await runReadOnlyAgent(uri, 'Planung');
					assert.ok(lastBodyBytes <= MAX_REQUEST_BYTES);
					assert.ok(lastBodyBytes > MAX_REQUEST_BYTES - 2 * margin);

					fetchCalls = 0;
					let caught: unknown;
					await assert.rejects(
						runReadOnlyAgent(
							uri,
							'Planung',
							undefined,
							[],
							['src/agent/readOnlyAgent.ts']
						),
						error => {
							caught = error;
							return error instanceof RequestTooLargeError;
						}
					);
					assert.strictEqual(fetchCalls, 0);
					assert.ok(caught instanceof RequestTooLargeError);
					assert.strictEqual(caught.toolDiagnostics.length, 1);
					assert.strictEqual(caught.toolDiagnostics[0].outcome, 'not-executed');
					assert.ok(caught.message.includes('das Werkzeug wurde nicht ausgeführt'));
					assert.ok(!caught.message.includes('x'.repeat(100)));
				} finally {
					globalThis.fetch = originalFetch;
					fs.rmSync(tempDir, { recursive: true, force: true });
				}
			});			test('Prompt-Erstellung: verlangt reine Lesewerkzeuge, kein Schreiben/Terminal', () => {
				const prompt = buildPlanPrompt('Füge ein Feature hinzu.');
				assert.ok(prompt.includes('WICHTIG: Ändere keine Dateien'));
				assert.ok(prompt.includes('ausschließlich Lesewerkzeuge'));
				assert.ok(prompt.includes('Füge ein Feature hinzu.'));
			});

			test('Prompt-Erstellung: nennt Vorablesen als Beleg und verlangt unklare Kennzeichnung ungelesener Dateien ohne Werkzeugzwang', () => {
				const prompt = buildPlanPrompt('Plane die Änderung.');
				assert.ok(prompt.includes('vorab gelesene Dateien (Modellschritt 0)'));
				assert.ok(prompt.includes('Schreibe nur dann "Keine", wenn kein erfolgreicher Leseaufruf vorliegt'));
				assert.ok(prompt.includes('Kennzeichne solche Dateiaussagen'));
				assert.ok(prompt.includes('Rufe weitere Lesewerkzeuge nur auf, wenn sie für den Plan nötig sind'));
				assert.ok(!prompt.includes('Musst weitere Lesewerkzeuge aufrufen'));
			});

			test('Prompt-Erstellung: Byte-Grenze ist keine Garantie, unbelegte Sicherheit als offene Annahme', () => {
				const prompt = buildPlanPrompt('Füge ein Feature hinzu.');
				assert.ok(prompt.includes('konservative Byte-Produktgrenze ist keine Garantie für vollständigen Modellkontext oder sichere Verarbeitung'));
				assert.ok(prompt.includes('Unbelegte Sicherheitsgarantien musst du unter "offene Fragen oder unbelegte Annahmen" ausdrücklich als offene Annahme kennzeichnen'));
			});
		});

	test('Werkzeugdefinitionen beschreiben gezieltes Lesen nach Suche', () => {
		type Tool = {
			function: {
				name: string;
				description: string;
				parameters: {
					properties: {
						include?: { description: string };
						first_line?: { type: string; minimum: number; description: string };
						last_line?: { type: string; minimum: number; description: string };
					};
					required?: string[];
				};
			};
		};
		const tools = getReadOnlyTools() as Tool[];
		const tool = tools
			.find(t => t.function.name === 'search_text');
		assert.ok(tool);
		const include = tool.function.parameters.properties.include?.description ?? '';
		assert.ok(include.includes('exakten relativen Pfad'));
		assert.ok(include.includes('src/extension.ts'));
		assert.ok(include.includes('**/*.md'));
		assert.ok(tool.function.description.includes('nur seine jeweilige Zeile'));
		assert.ok(tool.function.description.includes('nicht ohne weiteren Kontext'));
		const range = tools.find(t => t.function.name === 'read_file_range');
		assert.ok(range);
		assert.ok(range.function.description.toLowerCase().includes('nach search_text'));
		assert.ok(range.function.description.includes('1-basiert'));
		assert.strictEqual(range.function.parameters.properties.first_line?.type, 'integer');
		assert.strictEqual(range.function.parameters.properties.last_line?.type, 'integer');
		assert.deepStrictEqual(range.function.parameters.required, ['path', 'first_line', 'last_line']);
		assert.strictEqual(MAX_REQUEST_BYTES, 32_000);
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
				['list_directory', 'read_file', 'read_file_range', 'search_text']
			);
		});

		test('Agent liest nach einem Treffer den angeforderten read_file_range-Bereich', async () => {
			const root = vscode.workspace.workspaceFolders![0].uri;
			const fixtureName = `.bubble-range-agent-${process.pid}-${Date.now()}`;
			const relativePath = `${fixtureName}/sample.ts`;
			const fixture = path.join(root.fsPath, fixtureName);
			fs.mkdirSync(fixture, { recursive: true });
			fs.writeFileSync(path.join(fixture, 'sample.ts'), 'eins\nzwei\ndrei\n');
			try {
				const result = await runConversation(
					['Lies Zeile zwei bis drei.'],
					[],
					call => call === 1
						? {
							role: 'assistant',
							content: '',
							tool_calls: [{
								function: {
									name: 'read_file_range',
									arguments: {
										path: relativePath,
										first_line: 2,
										last_line: 3
									}
								}
							}]
						}
						: answer(call)
				);
				assert.strictEqual(result.bodies.length, 2);
				assert.ok(result.bodies[0].messages[0].content.includes('bevorzugt'));
				const toolMessage = result.bodies[1].messages.find(message => message.role === 'tool');
				assert.ok(toolMessage);
				const envelope = JSON.parse(toolMessage.content) as { success: boolean; content: string };
				assert.strictEqual(envelope.success, true);
				const range = JSON.parse(envelope.content) as { readRange: { firstLine: number; lastLine: number }; text: string };
				assert.deepStrictEqual(range.readRange, { firstLine: 2, lastLine: 3 });
				assert.strictEqual(range.text, 'zwei\ndrei');
				assert.deepStrictEqual(result.errors, []);
			} finally {
				fs.rmSync(fixture, { recursive: true, force: true });
			}
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

		test('Meldung zur Byte-Grenze: betrifft nur die zu große Anfrage, nichts über frühere Anfragen', () => {
			const message = new RequestTooLargeError(MAX_REQUEST_BYTES + 1).message;
			assert.ok(message.includes('Diese zu große Anfrage wurde nicht an Ollama gesendet'));
			assert.ok(message.includes('nicht stillschweigend gekürzt'));
			assert.ok(!message.includes('nichts an Ollama'));
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
			const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
			const tempDir = fs.mkdtempSync(path.join(workspaceRoot, 'bubble-tool-budget-'));
			const files = Array.from({ length: 8 }, (_, index) => {
				const fileName = `source-${index + 1}.txt`;
				fs.writeFileSync(path.join(tempDir, fileName), 'x'.repeat(6_000));
				return path.relative(workspaceRoot, path.join(tempDir, fileName)).replace(/\\/g, '/');
			});
			try {
				const result = await runConversation(['Lies Dateien'], [], call => ({
					role: 'assistant',
					content: '',
					tool_calls: [{
						function: {
							name: 'read_file',
							arguments: { path: files[call - 1] }
						}
					}]
				}));
				assert.ok(result.bodies.length >= 2 && result.bodies.length < 8);
				assert.strictEqual(result.errors.length, 1);
				assert.ok(result.errors[0].includes('Werkzeugergebnisse'));
				assert.ok(!result.errors[0].includes('Gespräch zurücksetzen'), 'bei der ersten Frage gibt es keinen Reset-Menüpunkt');
				for (const body of result.bodies) {
					assert.ok(Buffer.byteLength(JSON.stringify(body), 'utf8') <= MAX_REQUEST_BYTES);
				}
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		suite('Kumulatives Werkzeugbudget', () => {
			type CapturedBody = {
				messages: Array<Record<string, unknown>>;
			};
			type Outcome = {
				bodies: CapturedBody[];
				value?: Awaited<ReturnType<typeof runReadOnlyAgent>>;
				error?: unknown;
			};
			const toolCall = (name: string, file: string, args: Record<string, unknown> = {}) => ({
				function: {
					name,
					arguments: { path: file, ...args }
				}
			});
			const runAgent = async (
				dir: string,
				reply: (call: number, body: CapturedBody) => object,
				onToolActivity?: (activity: ToolActivity) => void,
				initialFiles: string[] = []
			): Promise<Outcome> => {
				const originalFetch = globalThis.fetch;
				const bodies: CapturedBody[] = [];
				globalThis.fetch = (async (_url: string, init: { body: string }) => {
					const body = JSON.parse(init.body) as CapturedBody;
					bodies.push(body);
					return new Response(JSON.stringify({
						message: reply(bodies.length, body)
					}));
				}) as typeof fetch;
				try {
					const value = await runReadOnlyAgent(
						vscode.Uri.file(dir),
						'Prüfe die passende Stelle.',
						undefined,
						[],
						initialFiles,
						undefined,
						onToolActivity
					);
					return { bodies, value };
				} catch (error) {
					return { bodies, error };
				} finally {
					globalThis.fetch = originalFetch;
				}
			};
			const paddedReply = (
				body: CapturedBody,
				name: string,
				file: string,
				totalBytes: number,
				args: Record<string, unknown> = {}
			) => {
				const assistant = {
					role: 'assistant',
					content: '',
					tool_calls: [toolCall(name, file, args)]
				};
				const noticeToolMessage = {
					role: 'tool',
					tool_name: name,
					content: JSON.stringify({
						success: false,
						content: TOOL_RESULT_BUDGET_NOTICE
					})
				};
				const probe = {
					...body,
					messages: [...body.messages, assistant, noticeToolMessage]
				};
				const padding = totalBytes - Buffer.byteLength(JSON.stringify(probe), 'utf8');
				assert.ok(padding >= 0, 'test fixture must leave room to pad to target size');
				assistant.content = 'x'.repeat(padding);
				const exact = {
					...body,
					messages: [...body.messages, assistant, noticeToolMessage]
				};
				assert.strictEqual(Buffer.byteLength(JSON.stringify(exact), 'utf8'), totalBytes);
				return assistant;
			};
			const assertBodiesWithinProductLimit = (bodies: CapturedBody[]) => {
				for (const body of bodies) {
					assert.ok(
						Buffer.byteLength(JSON.stringify(body), 'utf8') <= MAX_REQUEST_BYTES
					);
				}
			};

			test('Aktivität protokolliert Budgetablehnung mit Request-Bytes', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-activity-budget-'));
				fs.writeFileSync(path.join(dir, 'large.txt'), 'BUDGET_PRIVATE_MARKER'.repeat(2_000));
				const activities: ToolActivity[] = [];
				try {
					const outcome = await runAgent(
						dir,
						call => call === 1
							? {
								role: 'assistant',
								content: '',
								tool_calls: [toolCall('read_file', 'large.txt')]
							}
							: { role: 'assistant', content: 'Fertig.' },
						activity => activities.push(activity)
					);
					assert.ok(outcome.value);
					assert.deepStrictEqual(
						activities.map(activity => activity.status),
						['running', 'budget-rejected']
					);
					assert.strictEqual(activities[0].step, activities[1].step);
					assert.strictEqual(activities[1].target, 'large.txt');
					assert.ok((activities[1].requestBytesAdded ?? 0) > 0);
					assert.ok((activities[1].hypotheticalRequestBytes ?? 0) > MAX_REQUEST_BYTES);
					assert.ok(!JSON.stringify(activities).includes('BUDGET_PRIVATE_MARKER'));
					assertBodiesWithinProductLimit(outcome.bodies);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			const limitReply = (call: number) => ({
				role: 'assistant',
				content: '',
				tool_calls: [toolCall('read_file', 'a.txt', { marker: call })]
			});

			test('Schrittlimit: Abschlussantwort ohne Werkzeuge, klar gekennzeichnet', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-final-answer-'));
				try {
					fs.writeFileSync(path.join(dir, 'a.txt'), 'inhalt');
					const outcome = await runAgent(dir, call => call <= 8
						? limitReply(call)
						: { role: 'assistant', content: 'Belegt: a.txt gelesen. Unklar: Rest.' });
					assert.ok(outcome.value, String(outcome.error));
					assert.strictEqual(outcome.bodies.length, 9);
					assert.ok(outcome.bodies.slice(0, 8).every(body => 'tools' in body));
					const finalBody = outcome.bodies[8] as unknown as { tools?: unknown; messages: Array<{ role: string; content: string }> };
					assert.strictEqual(finalBody.tools, undefined);
					const request = finalBody.messages[finalBody.messages.length - 1];
					assert.strictEqual(request.role, 'user');
					assert.ok(request.content.includes('ausschließlich aus den bereits übermittelten'));
					assert.ok(request.content.includes('Unklar'));
					assert.ok(request.content.includes('keine weitere Recherche'));
					// Der Hinweis steht deterministisch vor der Modellantwort.
					assert.ok(outcome.value.answer.startsWith(FINAL_ANSWER_NOTICE));
					assert.ok(FINAL_ANSWER_NOTICE.includes('keine weitere Recherche'));
					assert.ok(FINAL_ANSWER_NOTICE.includes('unvollständig'));
					assert.ok(outcome.value.answer.endsWith('Unklar: Rest.'));
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Schrittlimit: Abschlussanfrage liefert Werkzeugaufruf oder nichts, ehrlicher Fehler', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-final-answer-fail-'));
				try {
					fs.writeFileSync(path.join(dir, 'a.txt'), 'inhalt');
					const outcome = await runAgent(dir, call => limitReply(call));
					assert.strictEqual(outcome.bodies.length, 9, 'höchstens eine Zusatzanfrage');
					assert.ok(outcome.error instanceof AgentStepLimitError);
					assert.ok(outcome.error.message.includes('acht Modellschritten'));
					assert.ok(!outcome.error.message.includes('Leseschritten'));
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Schrittlimit: Abschlussanfrage über Requestbudget wird nicht gesendet und nicht gekürzt', () => {
				const small = prepareFinalAnswerRequest([
					{ role: 'system', content: 'sys' },
					{ role: 'user', content: 'frage' }
				]);
				assert.strictEqual(small.allowed, true);
				const messages: Parameters<typeof prepareFinalAnswerRequest>[0] = [
					{ role: 'system', content: 'sys' },
					{ role: 'user', content: 'x'.repeat(MAX_REQUEST_BYTES) }
				];
				const large = prepareFinalAnswerRequest(messages);
				assert.strictEqual(large.allowed, false);
				assert.ok(large.bytes > MAX_REQUEST_BYTES);
				assert.strictEqual(large.messages.length, messages.length + 1);
				assert.strictEqual(large.messages[1].content, messages[1].content, 'keine stille Kürzung');
			});

			test('Schrittlimit: Abbruch nach dem letzten Schritt löst keine Abschlussanfrage aus', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-final-answer-abort-'));
				const originalFetch = globalThis.fetch;
				const controller = new AbortController();
				let fetchCalls = 0;
				globalThis.fetch = (async () => {
					fetchCalls += 1;
					return new Response(JSON.stringify({ message: limitReply(fetchCalls) }));
				}) as typeof fetch;
				try {
					fs.writeFileSync(path.join(dir, 'a.txt'), 'inhalt');
					await assert.rejects(
						runReadOnlyAgent(
							vscode.Uri.file(dir),
							'Frage',
							undefined,
							[],
							[],
							controller.signal,
							activity => {
								if (activity.round === 8 && activity.status !== 'running') {
									controller.abort();
								}
							}
						),
						AgentCancelledError
					);
					assert.strictEqual(fetchCalls, 8);
				} finally {
					globalThis.fetch = originalFetch;
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Anweisungen: Treffer führen direkt zu kleinem Bereich, Budgets und Antwortfreiheit bleiben genannt', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-navigation-guidance-'));
				try {
					const outcome = await runAgent(dir, () => ({ role: 'assistant', content: 'Fertig.' }));
					assert.ok(outcome.value);
					const system = String(outcome.bodies[0].messages[0].content);
					const tools = getReadOnlyTools() as Array<{
						function: { name: string; description: string };
					}>;
					const description = (name: string) =>
						tools.find(tool => tool.function.name === name)!.function.description;

					assert.ok(system.includes('liste nicht zuerst den Ordner auf'));
					assert.ok(system.includes('read_file_range rund um die Trefferzeile'));
					assert.ok(system.includes('nicht vorsorglich die ganze Datei'));
					assert.ok(system.includes('Ergebnis-Bytebudget gilt weiterhin'));
					assert.ok(system.includes('Antworte, sobald die vorhandenen Belege ausreichen'));
					assert.ok(system.includes('weil noch Modellschritte verfügbar sind'));
					// Sicherheitsregeln bleiben unverändert.
					assert.ok(system.includes('- Lies keine gesperrten Dateien.'));
					assert.ok(system.includes('- Verändere keine Dateien.'));
					// Keine Empfehlung, den Ordner als Zwischenschritt aufzulisten.
					assert.ok(!/(rufe|Rufe)\s+list_directory/.test(system));
					assert.ok(!system.includes('list_directory im'));
					for (const name of ['search_text', 'read_file_range', 'read_file']) {
						assert.ok(!/(rufe|Rufe)\s+list_directory/.test(description(name)), name);
					}
					assert.ok(description('list_directory').includes('Nicht als Zwischenschritt'));
					assert.ok(description('search_text').includes('Zeilennummer'));
					assert.ok(description('read_file').includes('read_file_range'));
					const range = description('read_file_range');
					assert.ok(range.includes('so klein wie nötig'));
					assert.ok(range.includes(`${MAX_RANGE_LINES} Zeilen`));
					assert.ok(range.includes(`${MAX_RANGE_RESULT_BYTES} UTF-8-Bytes`));
					assert.ok(range.includes('Bytebudget überschreiten'));
					assert.ok(!description('search_text').includes('  '));
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Bereichsnavigation: identisch gesperrt, Überlappung und Nachbarbereich weiter lesbar, Budgets unverändert', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-range-overlap-'));
				fs.writeFileSync(
					path.join(dir, 'big.txt'),
					Array.from({ length: 100 }, (_, i) => `zeile ${i + 1}`).join('\n')
				);
				const ranges: Array<[number, number]> = [[10, 20], [10, 20], [15, 25], [26, 30]];
				try {
					const outcome = await runAgent(dir, call => call <= ranges.length
						? {
							role: 'assistant',
							content: '',
							tool_calls: [toolCall('read_file_range', 'big.txt', {
								first_line: ranges[call - 1][0],
								last_line: ranges[call - 1][1]
							})]
						}
						: { role: 'assistant', content: 'Teilplan.' });
					assert.ok(outcome.value, String(outcome.error));
					assert.deepStrictEqual(
						outcome.value.toolDiagnostics?.map(d => d.outcome),
						['included', 'repeat-blocked', 'included', 'included']
					);
					// Nur die tatsächlich gelieferten Bereiche sind Belege; die Wiederholung zählt nicht.
					assert.strictEqual(outcome.value.evidence.length, 3);
					const last = outcome.bodies[outcome.bodies.length - 1].messages;
					const toolContents = last
						.filter(message => message.role === 'tool')
						.map(message => String(message.content));
					assert.ok(toolContents.some(c => c.includes('\\"readRange\\":{\\"firstLine\\":15,\\"lastLine\\":25}')));
					assert.ok(toolContents.some(c => c.includes('\\"readRange\\":{\\"firstLine\\":26,\\"lastLine\\":30}')));
					for (const body of outcome.bodies) {
						assert.ok(Buffer.byteLength(JSON.stringify(body), 'utf8') <= MAX_REQUEST_BYTES);
					}
					assert.strictEqual(MAX_REQUEST_BYTES, 32_000);
					assert.strictEqual(MAX_RANGE_LINES, 120);
					assert.strictEqual(MAX_RANGE_RESULT_BYTES, 4_000);
					assert.strictEqual(outcome.bodies.length, 5);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Anweisungen: zusammenhängender Bereich statt Mini-Nachbarbereichen, keine erneute Anforderung', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-range-guidance-'));
				try {
					const outcome = await runAgent(dir, () => ({ role: 'assistant', content: 'Fertig.' }));
					assert.ok(outcome.value);
					const system = String(outcome.bodies[0].messages[0].content);
					const range = (getReadOnlyTools() as Array<{
						function: { name: string; description: string };
					}>).find(tool => tool.function.name === 'read_file_range')!.function.description;
					for (const text of [system, range]) {
						assert.ok(text.includes('zusammenhängend'));
						assert.ok(text.includes('readRange'));
						assert.ok(/Überlappung/.test(text));
						assert.ok(text.includes('Nachbarbereiche'));
					}
					assert.ok(system.includes('angrenzender, noch nicht gelesener Bereich bleibt erlaubt'));
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Kontextstatus: nur übermittelte Bereiche, Überlappung vereinigt, kein Inhalt doppelt, Budget gewahrt', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-context-status-'));
				fs.writeFileSync(
					path.join(dir, 'a.txt'),
					Array.from({ length: 20 }, (_, i) => `INHALT_${i + 1}`).join('\n')
				);
				const ranges: Array<[number, number]> = [[2, 4], [3, 6]];
				try {
					const outcome = await runAgent(dir, call => call <= 2
						? {
							role: 'assistant',
							content: '',
							tool_calls: [toolCall('read_file_range', 'a.txt', {
								first_line: ranges[call - 1][0],
								last_line: ranges[call - 1][1]
							})]
						}
						: { role: 'assistant', content: 'Fertig.' });
					assert.ok(outcome.value, String(outcome.error));
					const lastContent = (index: number) => {
						const messages = outcome.bodies[index].messages;
						return String(messages[messages.length - 1].content);
					};
					assert.ok(!lastContent(0).includes('Kontextstatus'), 'ohne Ergebnis keine Übersicht');
					const second = lastContent(1);
					assert.ok(second.startsWith('Kontextstatus'));
					assert.ok(second.includes('a.txt Zeilen 2-4'));
					assert.ok(second.includes('Modellschritt 2 von 8'));
					assert.ok(second.includes('noch 6 Schritte'));
					const third = lastContent(2);
					assert.ok(!third.includes('Vollständig übermittelt'));
					assert.ok(third.includes('a.txt Zeilen 2-6'));
					assert.ok(!second.includes('INHALT_'), 'keine Dateiinhalte in der Übersicht');
					assertBodiesWithinProductLimit(outcome.bodies);
					assert.strictEqual(outcome.bodies.length, 3);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Kontextstatus: budgetabgewiesene Datei gilt nicht als übermittelt', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-context-rejected-'));
				fs.writeFileSync(
					path.join(dir, 'big.txt'),
					Array.from({ length: 5_000 }, (_, i) => `zeile ${i + 1}`).join('\n')
				);
				try {
					const outcome = await runAgent(dir, call => call === 1
						? { role: 'assistant', content: '', tool_calls: [toolCall('read_file', 'big.txt')] }
						: { role: 'assistant', content: 'Fertig.' });
					assert.ok(outcome.value, String(outcome.error));
					const messages = outcome.bodies[1].messages;
					const status = String(messages[messages.length - 1].content);
					assert.ok(status.includes('Wegen Budget nicht übermittelt (kein Beleg): big.txt'));
					assert.ok(!status.includes('Vollständig übermittelt'));
					assertBodiesWithinProductLimit(outcome.bodies);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Kontextstatus (Modul): Suchen mit Trefferzahl, Fehlschläge zählen nicht, Begrenzung sichtbar', () => {
				const ledger = createContextLedger();
				assert.strictEqual(formatContextStatus(ledger, 1, 8), undefined);
				recordForwardedResult(ledger, 'search_text', { query: 'abort|cancel', include: 'a.ts' }, true, JSON.stringify({ emittedHitCount: 0 }));
				recordForwardedResult(ledger, 'read_file', { path: 'nie.ts' }, false, 'Fehler');
				recordForwardedResult(ledger, 'read_file_range', { path: 'x.ts' }, true, JSON.stringify({ path: 'x.ts', readRange: null }));
				recordForwardedResult(ledger, 'read_file', { path: 'klein.ts' }, true, '{}');
				const status = formatContextStatus(ledger, 3, 8)!;
				assert.ok(status.includes('"abort|cancel" in a.ts: 0 Treffer'));
				assert.ok(status.includes('Vollständig übermittelt: klein.ts'));
				assert.ok(!status.includes('nie.ts'));
				assert.ok(!status.includes('x.ts'));
				assert.deepStrictEqual(mergeRanges([{ firstLine: 5, lastLine: 8 }, { firstLine: 1, lastLine: 4 }]), [{ firstLine: 1, lastLine: 8 }]);
				assert.strictEqual(newLinesOutside({ firstLine: 3, lastLine: 8 }, [{ firstLine: 1, lastLine: 5 }]), 3);
				for (let i = 0; i < 10; i += 1) {
					recordForwardedResult(ledger, 'read_file', { path: `datei${i}.ts` }, true, '{}');
				}
				const many = formatContextStatus(ledger, 3, 8)!;
				assert.ok(many.includes('weitere Dateien hier nicht aufgeführt'));
				assert.strictEqual(formatContextStatus(ledger, 3, 8, 50), undefined, 'zu große Übersicht entfällt ganz');
			});

			test('Planformat: Überschriften mit "### 1." und "- 1." werden erkannt', () => {
				const text = [
					'### 1. Ziel der Änderung', 'x', '',
					'### 2. betroffene Dateien, nur soweit tatsächlich geprüft', 'Keine', '',
					'### 3. höchstens drei Umsetzungsschritte', '1. a', '2. b', '',
					'### 4. nötige Tests', 'x', '',
					'### 5. offene Fragen oder unbelegte Annahmen', 'x'
				].join('\n');
				const result = validatePlanOutput(text);
				assert.deepStrictEqual(result.missingSections, []);
				assert.strictEqual(result.stepCount, 2);
			});

			test('Planungsmodus: Schrittlimit verlangt Planabschnitte als Teilplan, andere Modi behalten Belegt/Unklar', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-plan-final-'));
				const originalFetch = globalThis.fetch;
				try {
					fs.writeFileSync(path.join(dir, 'a.txt'), 'inhalt');
					const run = async (texts?: typeof PLAN_FINAL_ANSWER) => {
						const bodies: Array<{ tools?: unknown; messages: Array<{ content: string }> }> = [];
						globalThis.fetch = (async (_url: string, init: { body: string }) => {
							bodies.push(JSON.parse(init.body));
							return new Response(JSON.stringify({
								message: bodies.length <= 8
									? limitReply(bodies.length)
									: { role: 'assistant', content: '1. Ziel der Änderung\nZiel\n\n5. offene Fragen oder unbelegte Annahmen\nViel' }
							}));
						}) as typeof fetch;
						const value = await runReadOnlyAgent(
							vscode.Uri.file(dir), 'Plane', undefined, [], [], undefined, undefined, texts
						);
						return { bodies, value };
					};

					const plan = await run(PLAN_FINAL_ANSWER);
					assert.strictEqual(plan.bodies.length, 9, 'keine zusätzliche Reparaturschleife');
					assert.strictEqual(plan.bodies[8].tools, undefined);
					const request = plan.bodies[8].messages[plan.bodies[8].messages.length - 1].content;
					assert.ok(request.includes('TEILPLAN'));
					for (const section of PLAN_SECTIONS) {
						assert.ok(request.includes(section), section);
					}
					assert.ok(request.includes('ergänze nichts'));
					assert.ok(plan.value.answer.startsWith(PLAN_FINAL_ANSWER_NOTICE));
					const formatted = formatPlanResponse(plan.value.answer, plan.value.evidence, plan.value.omitted, '');
					assert.ok(formatted.includes('WARNUNG: Folgende geforderte Abschnitte fehlen'));
					assert.ok(formatted.includes('TEILPLAN'));

					const other = await run();
					const otherRequest = other.bodies[8].messages[other.bodies[8].messages.length - 1].content;
					assert.ok(otherRequest.includes('„Belegt:“'));
					assert.ok(!otherRequest.includes('TEILPLAN'));
					assert.ok(other.value.answer.startsWith(FINAL_ANSWER_NOTICE));
				} finally {
					globalThis.fetch = originalFetch;
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Diagnose: Bereichsmetadaten, Fehlergrund und Modellschritte nach Budgetablehnung', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-activity-range-'));
				fs.writeFileSync(
					path.join(dir, 'large.txt'),
					Array.from({ length: 1_500 }, (_, i) => `BUDGET_PRIVATE_MARKER line ${i + 1}`).join('\n')
				);
				const activities: ToolActivity[] = [];
				try {
					const outcome = await runAgent(
						dir,
						call => call === 1
							? { role: 'assistant', content: '', tool_calls: [toolCall('read_file', 'large.txt')] }
							: call === 2
								? {
									role: 'assistant',
									content: '',
									tool_calls: [toolCall('read_file_range', 'large.txt', { first_line: 1, last_line: 3 })]
								}
								: call === 3
									? {
										role: 'assistant',
										content: '',
										tool_calls: [
											toolCall('read_file_range', 'large.txt', { first_line: 1_500, last_line: 1_600 }),
											toolCall('read_file_range', 'large.txt', { first_line: 0, last_line: 4 }),
											toolCall('read_file_range', 'large.txt', { first_line: 1, last_line: 3 })
										]
									}
									: { role: 'assistant', content: 'Fertig.' },
						activity => activities.push(activity)
					);
					assert.ok(outcome.value);
					const finished = activities.filter(activity => activity.status !== 'running');
					assert.deepStrictEqual(
						finished.map(activity => [activity.round, activity.status]),
						[
							[1, 'budget-rejected'],
							[2, 'success'],
							[3, 'success'],
							[3, 'failed'],
							[3, 'repeat-blocked']
						]
					);
					assert.ok(finished.every(activity => activity.maxRounds === 8));
					assert.deepStrictEqual(finished[1].requestedRange, { firstLine: 1, lastLine: 3 });
					assert.deepStrictEqual(finished[1].deliveredRange, { firstLine: 1, lastLine: 3 });
					assert.deepStrictEqual(finished[2].requestedRange, { firstLine: 1_500, lastLine: 1_600 });
					assert.deepStrictEqual(finished[2].deliveredRange, { firstLine: 1_500, lastLine: 1_500 });
					assert.strictEqual(finished[3].deliveredRange, null);
					assert.strictEqual(
						finished[3].reason,
						'Zeilennummern müssen positive ganze Zahlen sein.'
					);
					const text = formatEvidence(
						outcome.value.evidence,
						outcome.value.omitted,
						[],
						outcome.value.toolDiagnostics
					);
					assert.ok(text.includes('Modellschritt=1/8'));
					assert.ok(text.includes('angefordert=1500-1600; geliefert=1500-1500'));
					assert.ok(text.includes('geliefert=keine Zeilen; Grund=Zeilennummern müssen positive ganze Zahlen sein.'));
					assert.ok(text.includes('3 von 8 genutzt'));
					assert.ok(text.includes('wegen Budget abgewiesene'));
					assert.ok(!text.includes('BUDGET_PRIVATE_MARKER'));
					assert.ok(!JSON.stringify(activities).includes('BUDGET_PRIVATE_MARKER'));
					assertBodiesWithinProductLimit(outcome.bodies);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('search_text wird nach übermitteltem vollständigem read_file derselben Datei unterbunden', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-context-search-'));
				fs.writeFileSync(path.join(dir, 'target.md'), 'FULL_FILE_CONTEXT_MARKER');
				try {
					const outcome = await runAgent(dir, call => call === 1
						? {
							role: 'assistant',
							content: '',
							tool_calls: [toolCall('read_file', 'target.md')]
						}
						: call === 2
							? {
								role: 'assistant',
								content: '',
								tool_calls: [{
									function: {
										name: 'search_text',
										arguments: {
											query: 'UNIQUE_SEARCH_TERM',
											include: 'target.md'
										}
									}
								}]
							}
							: { role: 'assistant', content: 'Fertig.' });

					assert.ok(outcome.value);
					assert.strictEqual(outcome.bodies.length, 3);
					assert.deepStrictEqual(
						outcome.value.toolDiagnostics?.map(d => d.outcome),
						['included', 'context-search-blocked']
					);
					assert.deepStrictEqual(
						outcome.value.evidence.map(entry => entry.tool),
						['read_file']
					);
					const lastToolMessage = outcome.bodies[2].messages
						.filter(message => message.role === 'tool')
						.at(-1);
					assert.ok(lastToolMessage);
					const notice = JSON.parse(String(lastToolMessage.content)) as {
						success: boolean;
						content: string;
					};
					assert.strictEqual(notice.success, false);
					assert.ok(notice.content.includes('vollständige Inhalt'));
					assert.ok(notice.content.includes('andere relevante Dateien'));
					assert.ok(notice.content.includes('search_text'));
					assert.ok(notice.content.includes('ohne include'));
					assert.ok(notice.content.includes('read_file_range'));
					assert.ok(!notice.content.includes('list_directory'));
					assert.ok(!notice.content.includes('Ordner'));
					assert.ok(!notice.content.includes('target.md'));
					assert.ok(!notice.content.includes('UNIQUE_SEARCH_TERM'));
					assert.ok(formatEvidence(
						outcome.value.evidence,
						outcome.value.omitted,
						[],
						outcome.value.toolDiagnostics
					).includes('Unterbundene Suchen in vollständig gelesenen Dateien: 1.'));
					assertBodiesWithinProductLimit(outcome.bodies);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Mock-Navigation: blockierte Suche führt über projektweite Suche zum Treffer', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-context-navigation-'));
				const sourceDir = path.join(dir, 'src');
				fs.mkdirSync(sourceDir);
				fs.writeFileSync(path.join(sourceDir, 'target.ts'), 'FULL_TARGET_CONTENT');
				fs.writeFileSync(path.join(sourceDir, 'signal.ts'), 'SIGNAL_PATH_TERM = SIGNAL_PATH_IMPLEMENTATION');
				try {
					const outcome = await runAgent(dir, (call, body) => {
						if (call === 1) {
							return {
								role: 'assistant',
								content: '',
								tool_calls: [toolCall('read_file', 'src/target.ts')]
							};
						}
						if (call === 2) {
							return {
								role: 'assistant',
								content: '',
								tool_calls: [{
									function: {
										name: 'search_text',
										arguments: {
											query: 'SIGNAL_PATH_TERM',
											include: 'src/target.ts'
										}
									}
								}]
							};
						}
						if (call === 3) {
							const notice = body.messages
								.filter(message => message.role === 'tool')
								.map(message => JSON.parse(String(message.content)) as {
									content: string;
								})
								.at(-1);
							assert.ok(notice?.content.includes('search_text'));
							assert.ok(notice?.content.includes('ohne include'));
							assert.ok(notice?.content.includes('read_file_range'));
							assert.ok(!notice?.content.includes('list_directory'));
							assert.ok(!notice?.content.includes('Ordner'));
							assert.ok(!notice?.content.includes('SIGNAL_PATH_TERM'));
							return {
								role: 'assistant',
								content: '',
								tool_calls: [{
									function: {
										name: 'search_text',
										arguments: { query: 'SIGNAL_PATH_TERM' }
									}
								}]
							};
						}
						if (call === 4) {
							return {
								role: 'assistant',
								content: '',
								tool_calls: [toolCall('read_file_range', 'src/signal.ts', {
									first_line: 1,
									last_line: 1
								})]
							};
						}
						return { role: 'assistant', content: 'Signalweg gefunden.' };
					});

					assert.ok(outcome.value);
					assert.strictEqual(outcome.value.answer, 'Signalweg gefunden.');
					assert.strictEqual(outcome.bodies.length, 5);
					assert.deepStrictEqual(
						outcome.value.toolDiagnostics?.map(d => d.outcome),
						['included', 'context-search-blocked', 'included', 'included']
					);
					assert.deepStrictEqual(
						outcome.value.evidence.map(entry => entry.tool),
						['read_file', 'search_text', 'read_file_range']
					);
					const finalBody = outcome.bodies[4];
					assert.ok(JSON.stringify(finalBody).includes('SIGNAL_PATH_IMPLEMENTATION'));
					assertBodiesWithinProductLimit(outcome.bodies);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Planmodus: Vorablesen wird berücksichtigt und danach projektweit weitergesucht', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-plan-context-navigation-'));
				const sourceDir = path.join(dir, 'src');
				fs.mkdirSync(sourceDir);
				fs.writeFileSync(path.join(sourceDir, 'target.ts'), 'PRE_READ_PLAN_CONTENT');
				fs.writeFileSync(
					path.join(sourceDir, 'related.ts'),
					'PLAN_RELATED_SIGNAL = PLAN_RELATED_IMPLEMENTATION'
				);
				try {
					const outcome = await runAgent(
						dir,
						(call, body) => {
							if (call === 1) {
								const preRead = body.messages.find(message =>
									message.role === 'tool'
									&& String(message.content).includes('PRE_READ_PLAN_CONTENT')
								);
								assert.ok(preRead, 'initialFiles content is sent before the first model call');
								return {
									role: 'assistant',
									content: '',
									tool_calls: [{
										function: {
											name: 'search_text',
											arguments: {
												query: 'PLAN_RELATED_SIGNAL',
												include: 'src/target.ts'
											}
										}
									}]
								};
							}
							if (call === 2) {
								const toolMessages = body.messages.filter(message => message.role === 'tool');
								const notice = JSON.parse(String(toolMessages.at(-1)?.content)) as {
									success: boolean;
									content: string;
								};
								assert.strictEqual(notice.success, false);
								assert.ok(notice.content.includes('vollständige Inhalt'));
								assert.ok(notice.content.includes('ohne include'));
								return {
									role: 'assistant',
									content: '',
									tool_calls: [{
										function: {
											name: 'search_text',
											arguments: { query: 'PLAN_RELATED_SIGNAL' }
										}
									}]
								};
							}
							if (call === 3) {
								const toolMessages = body.messages.filter(message => message.role === 'tool');
								const result = JSON.parse(String(toolMessages.at(-1)?.content)) as {
									success: boolean;
									content: string;
								};
								assert.strictEqual(result.success, true);
								assert.ok(result.content.includes('related.ts'));
								return {
									role: 'assistant',
									content: '',
									tool_calls: [{
										function: {
											name: 'read_file_range',
											arguments: {
												path: 'src/related.ts',
												first_line: 1,
												last_line: 1
											}
										}
									}]
								};
							}
							return { role: 'assistant', content: 'Der relevante Planbeleg liegt vor.' };
						},
						undefined,
						['src/target.ts']
					);

					assert.ok(outcome.value);
					assert.strictEqual(outcome.value.answer, 'Der relevante Planbeleg liegt vor.');
					assert.deepStrictEqual(
						outcome.value.toolDiagnostics?.map(diagnostic => diagnostic.outcome),
						['included', 'context-search-blocked', 'included', 'included']
					);
					assert.ok(
						outcome.value.toolDiagnostics?.[1].target.includes(
							'PLAN_RELATED_SIGNAL" in src/target.ts'
						)
					);
					const searchTool = (
						getReadOnlyTools() as Array<{
							function: {
								name: string;
								parameters: {
									properties: {
										include: { description: string };
									};
								};
							};
						}>
					).find(tool => tool.function.name === 'search_text')!.function;
					const includeDescription = searchTool.parameters.properties.include.description;
					assert.ok(includeDescription.includes('lasse include weg'));
					assertBodiesWithinProductLimit(outcome.bodies);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Hinweise zu bereits gelesenen Dateien sind begrenzt', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-context-search-limit-'));
				fs.writeFileSync(path.join(dir, 'target.md'), 'FULL_FILE_CONTEXT_MARKER');
				try {
					const outcome = await runAgent(dir, call => call === 1
						? {
							role: 'assistant',
							content: '',
							tool_calls: [toolCall('read_file', 'target.md')]
						}
						: {
							role: 'assistant',
							content: '',
							tool_calls: [{
								function: {
									name: 'search_text',
									arguments: {
										query: `SEARCH_${call}`,
										include: 'target.md'
									}
								}
							}]
						});

					assert.ok(outcome.error);
					const diagnostics = (
						outcome.error as {
							toolDiagnostics: Array<{ outcome: string }>;
						}
					).toolDiagnostics;
					assert.deepStrictEqual(
						diagnostics.map(d => d.outcome),
						[
							'included',
							'context-search-blocked',
							'context-search-blocked',
							'aborted'
						]
					);
					assert.strictEqual(outcome.bodies.length, 4);
					const transmittedNotices = outcome.bodies.at(-1)!.messages
						.filter(message => message.role === 'tool')
						.map(message => JSON.parse(String(message.content)) as {
							content: string;
						})
						.filter(message => message.content.includes(
							'vollständige Inhalt der angefragten Datei'
						));
					assert.strictEqual(transmittedNotices.length, 2);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Nach budget-abgewiesenem read_file wird eine begrenzte Suche in derselben Datei ausgeführt', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-context-rejected-'));
				const chatDir = path.join(dir, 'src', 'chat');
				fs.mkdirSync(chatDir, { recursive: true });
				fs.writeFileSync(
					path.join(chatDir, 'chatSession.ts'),
					'PRE_READ_CHAT_SESSION_MARKER'
				);
				fs.writeFileSync(
					path.join(chatDir, 'chatView.ts'),
					'ordinary content\n'.repeat(2_000)
						+ 'export const ChatEntry = "SMALL_SEARCH_RESULT";\n'
				);
				try {
					const outcome = await runAgent(
						dir,
						(call, body) => {
							if (call === 1) {
								assert.ok(JSON.stringify(body).includes('PRE_READ_CHAT_SESSION_MARKER'));
								return {
									role: 'assistant',
									content: '',
									tool_calls: [toolCall('read_file', 'src/chat/chatView.ts')]
								};
							}
							if (call === 2) {
								const readNotice = body.messages
									.filter(message => message.role === 'tool')
									.map(message => JSON.parse(String(message.content)) as {
										success: boolean;
										content: string;
									})
									.find(message => message.content === TOOL_RESULT_BUDGET_NOTICE);
								assert.ok(readNotice);
								assert.strictEqual(readNotice.success, false);
								return {
									role: 'assistant',
									content: '',
									tool_calls: [{
										function: {
											name: 'search_text',
											arguments: {
												query: 'SMALL_SEARCH_RESULT',
												include: 'src/chat/chatView.ts'
											}
										}
									}]
								};
							}
							if (call === 3) {
								const results = body.messages
									.filter(message => message.role === 'tool')
									.map(message => JSON.parse(String(message.content)) as {
										success: boolean;
										content: string;
									});
								assert.ok(results.some(message =>
									message.success && message.content.includes('SMALL_SEARCH_RESULT')
								));
								return {
									role: 'assistant',
									content: 'ChatEntry wurde in der gezielt durchsuchten Datei gefunden.'
								};
							}
							throw new Error('Unerwarteter weiterer Modellaufruf.');
						},
						undefined,
						['src/chat/chatSession.ts']
					);

					assert.ok(outcome.value, String(outcome.error));
					assert.strictEqual(outcome.bodies.length, 3);
					assert.deepStrictEqual(
						outcome.value.toolDiagnostics?.map(d => d.outcome),
						['included', 'budget-rejected', 'included']
					);
					assert.deepStrictEqual(
						outcome.value.evidence.map(entry => [entry.tool, entry.target, entry.success]),
						[
							['read_file', 'src/chat/chatSession.ts', true],
							['read_file', 'src/chat/chatView.ts', false],
							['search_text', '"SMALL_SEARCH_RESULT" in src/chat/chatView.ts', true]
						]
					);
					assert.ok(outcome.value.answer.includes('gezielt durchsuchten Datei'));
					assert.ok(!JSON.stringify(outcome.bodies).includes('ordinary content'));
					assertBodiesWithinProductLimit(outcome.bodies);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Abgewiesene Suche darf nicht über 32.000 Bytes durch einen Folgeaufruf erzwungen werden', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-context-no-room-'));
				fs.writeFileSync(path.join(dir, 'large.md'), 'LARGE_RECOVERY_MARKER'.repeat(2_000));
				try {
					const outcome = await runAgent(dir, (call, body) => call === 1
						? paddedReply(
							body,
							'read_file',
							'large.md',
							MAX_REQUEST_BYTES - 100
						)
						: {
							role: 'assistant',
							content: '',
							tool_calls: [{
								function: {
									name: 'read_file_range',
									arguments: {
										path: 'large.md',
										first_line: 1,
										last_line: 1
									}
								}
							}]
						});

					assert.ok(outcome.error instanceof RequestTooLargeError);
					assert.strictEqual(outcome.bodies.length, 2);
					assertBodiesWithinProductLimit(outcome.bodies);
					assert.deepStrictEqual(
						(outcome.error as RequestTooLargeError).toolDiagnostics
							.map(diagnostic => diagnostic.outcome),
						['budget-rejected', 'not-executed']
					);
					assert.ok(outcome.error.message.includes(
						'kurze Ablehnungshinweis passt nicht in die 32.000-Byte-Grenze'
					));
					assert.ok(!JSON.stringify(outcome.bodies).includes('LARGE_RECOVERY_MARKER'));
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('search_text in anderer Datei und projektweite Suche werden weiter ausgeführt', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-context-other-search-'));
				fs.writeFileSync(path.join(dir, 'target.md'), 'TARGET_FILE_CONTENT');
				fs.writeFileSync(path.join(dir, 'other.md'), 'OTHER_FILE_SEARCH GLOBAL_SEARCH');
				try {
					const outcome = await runAgent(dir, call => call === 1
						? {
							role: 'assistant',
							content: '',
							tool_calls: [toolCall('read_file', 'target.md')]
						}
						: call === 2
							? {
								role: 'assistant',
								content: '',
								tool_calls: [
									{
										function: {
											name: 'search_text',
											arguments: {
												query: 'OTHER_FILE_SEARCH',
												include: 'other.md'
											}
										}
									},
									{
										function: {
											name: 'search_text',
											arguments: { query: 'GLOBAL_SEARCH' }
										}
									}
								]
							}
							: { role: 'assistant', content: 'Fertig.' });

					assert.ok(outcome.value);
					assert.strictEqual(outcome.bodies.length, 3);
					assert.deepStrictEqual(
						outcome.value.toolDiagnostics?.map(d => d.outcome),
						['included', 'included', 'included']
					);
					assert.deepStrictEqual(
						outcome.value.evidence.map(entry => entry.tool),
						['read_file', 'search_text', 'search_text']
					);
					const toolMessages = outcome.bodies[2].messages
						.filter(message => message.role === 'tool')
						.map(message => JSON.parse(String(message.content)) as {
							success: boolean;
							content: string;
						});
					assert.strictEqual(toolMessages.length, 3);
					assert.ok(toolMessages.every(message => message.success));
					assert.ok(toolMessages[1].content.includes('OTHER_FILE_SEARCH'));
					assert.ok(toolMessages[2].content.includes('GLOBAL_SEARCH'));
					assertBodiesWithinProductLimit(outcome.bodies);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('mehrere tool_calls: erstes Ergebnis bleibt, zweites wird durch den Hinweis ersetzt', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-multi-tools-'));
				fs.writeFileSync(path.join(dir, 'small.txt'), 'SMALL_RESULT_MARKER');
				fs.writeFileSync(
					path.join(dir, 'large.txt'),
					Array.from({ length: 4_000 }, (_, index) => `LARGE_RESULT_PRIVATE_${index}`).join('\n')
				);
				try {
					const outcome = await runAgent(dir, call => call === 1
						? {
							role: 'assistant',
							content: '',
							tool_calls: [
								toolCall('read_file', 'small.txt'),
								toolCall('read_file', 'large.txt')
							]
						}
						: call === 2
							? {
								role: 'assistant',
								content: '',
								tool_calls: [
									toolCall('read_file_range', 'large.txt', {
										first_line: 10,
										last_line: 15
									})
								]
							}
							: { role: 'assistant', content: 'Fertig.' });

					assert.ok(outcome.value);
					assert.strictEqual(outcome.bodies.length, 3);
					assertBodiesWithinProductLimit(outcome.bodies);
					const toolMessages = outcome.bodies[1].messages
						.filter(message => message.role === 'tool');
					assert.strictEqual(toolMessages.length, 2);
					const first = JSON.parse(String(toolMessages[0].content)) as {
						success: boolean;
						content: string;
					};
					const second = JSON.parse(String(toolMessages[1].content)) as {
						success: boolean;
						content: string;
					};
					assert.strictEqual(first.success, true);
					assert.ok(first.content.includes('SMALL_RESULT_MARKER'));
					assert.strictEqual(second.success, false);
					assert.strictEqual(second.content, TOOL_RESULT_BUDGET_NOTICE);
					assert.ok(!JSON.stringify(outcome.bodies[1]).includes('LARGE_RESULT_PRIVATE'));
					const recoveryResult = outcome.bodies[2].messages
						.filter(message => message.role === 'tool')
						.map(message => JSON.parse(String(message.content)) as {
							success: boolean;
							content: string;
						})
						.at(-1);
					assert.ok(recoveryResult?.success);
					assert.ok(recoveryResult.content.includes('LARGE_RESULT_PRIVATE_9'));
					assert.ok(recoveryResult.content.includes('LARGE_RESULT_PRIVATE_14'));

					const [included, rejected, recovery] = outcome.value.toolDiagnostics ?? [];
					assert.strictEqual(included.tool, 'read_file');
					assert.strictEqual(included.outcome, 'included');
					assert.strictEqual(rejected.outcome, 'budget-rejected');
					assert.strictEqual(recovery.tool, 'read_file_range');
					assert.strictEqual(recovery.outcome, 'included');
					assert.ok(included.requestBytesAdded > 0);
					assert.ok(rejected.requestBytesAdded > MAX_REQUEST_BYTES);
					assert.ok(recovery.requestBytesAdded < rejected.requestBytesAdded);
					assert.ok(rejected.hypotheticalRequestBytes > MAX_REQUEST_BYTES);
					assert.ok(!formatEvidence(
						outcome.value.evidence,
						outcome.value.omitted,
						[],
						outcome.value.toolDiagnostics
					).includes('LARGE_RESULT_PRIVATE'));
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('zwei große read_file in einer Antwort: zweiter wird nicht ausgeführt, Recovery im Folgeschritt', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-two-large-'));
				fs.writeFileSync(path.join(dir, 'a.txt'), Array.from({ length: 4_000 }, (_, i) => `A_PRIVATE_${i}`).join('\n'));
				fs.writeFileSync(path.join(dir, 'b.txt'), Array.from({ length: 4_000 }, (_, i) => `B_PRIVATE_${i}`).join('\n'));
				try {
					const outcome = await runAgent(dir, call => call === 1
						? {
							role: 'assistant',
							content: '',
							tool_calls: [toolCall('read_file', 'a.txt'), toolCall('read_file', 'b.txt')]
						}
						: call === 2
							? {
								role: 'assistant',
								content: '',
								tool_calls: [toolCall('read_file_range', 'a.txt', { first_line: 3, last_line: 5 })]
							}
							: { role: 'assistant', content: 'Fertig.' });

					assert.ok(outcome.value, String(outcome.error));
					assert.strictEqual(outcome.bodies.length, 3);
					assertBodiesWithinProductLimit(outcome.bodies);
					const second = outcome.bodies[1].messages
						.filter(message => message.role === 'tool')
						.map(message => JSON.parse(String(message.content)) as { success: boolean; content: string });
					assert.strictEqual(second.length, 2);
					assert.strictEqual(second[0].content, TOOL_RESULT_BUDGET_NOTICE);
					assert.strictEqual(second[1].success, false);
					assert.strictEqual(second[1].content, SKIPPED_AFTER_BUDGET_NOTICE);
					assert.ok(!JSON.stringify(outcome.bodies).includes('B_PRIVATE'));
					assert.deepStrictEqual(
						outcome.value.toolDiagnostics?.map(d => [d.target, d.outcome]),
						[
							['a.txt', 'budget-rejected'],
							['b.txt', 'not-executed'],
							['a.txt', 'included']
						]
					);
					const recovery = outcome.bodies[2].messages
						.filter(message => message.role === 'tool')
						.map(message => JSON.parse(String(message.content)) as { success: boolean; content: string })
						.at(-1);
					assert.ok(recovery?.success);
					assert.ok(recovery.content.includes('A_PRIVATE_2'));
					// Nur der abgewiesene Aufruf ist als Versuch erfasst; der nicht ausgeführte zählt nicht.
					assert.deepStrictEqual(
						outcome.value.evidence.map(entry => [entry.target, entry.success]),
						[['a.txt', false], ['a.txt', true]]
					);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('zwei Aufrufe in einer Antwort: ohne Platz für den zweiten Hinweis ehrlicher Abbruch', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-two-large-nospace-'));
				fs.writeFileSync(path.join(dir, 'a.txt'), 'A_PRIVATE'.repeat(4_000));
				fs.writeFileSync(path.join(dir, 'b.txt'), 'B_PRIVATE'.repeat(4_000));
				try {
					const outcome = await runAgent(dir, (call, body) => {
						assert.strictEqual(call, 1);
						const assistant = {
							role: 'assistant',
							content: '',
							tool_calls: [toolCall('read_file', 'a.txt'), toolCall('read_file', 'b.txt')]
						};
						const toolMessage = (content: string) => ({
							role: 'tool',
							tool_name: 'read_file',
							content: JSON.stringify({ success: false, content })
						});
						const full = (content: string) => Buffer.byteLength(JSON.stringify({
							...body,
							messages: [
								...body.messages,
								assistant,
								toolMessage(TOOL_RESULT_BUDGET_NOTICE),
								toolMessage(content)
							]
						}), 'utf8');
						const padding = MAX_REQUEST_BYTES + 1 - full(SKIPPED_AFTER_BUDGET_NOTICE);
						assert.ok(padding >= 0);
						assistant.content = 'x'.repeat(padding);
						return assistant;
					});

					assert.ok(outcome.error instanceof RequestTooLargeError);
					const error = outcome.error as RequestTooLargeError;
					assert.strictEqual(outcome.bodies.length, 1);
					assert.deepStrictEqual(
						error.toolDiagnostics.map(d => d.outcome),
						['budget-rejected', 'not-executed']
					);
					assert.ok(error.message.includes('Hinweis auf den nicht ausgeführten zweiten Aufruf'));
					assert.ok(error.bytes > MAX_REQUEST_BYTES);
					assert.ok(error.message.includes('überschreitet die konservative Produktgrenze'));
					assert.ok(!error.message.includes('B_PRIVATE'));
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Abbruch durch die Recovery-Regel nennt die Regel statt einer Grenzüberschreitung', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-recovery-rule-msg-'));
				fs.writeFileSync(path.join(dir, 'a.txt'), 'A_PRIVATE'.repeat(4_000));
				fs.writeFileSync(path.join(dir, 'b.txt'), 'B_PRIVATE'.repeat(4_000));
				try {
					const outcome = await runAgent(dir, call => ({
						role: 'assistant',
						content: '',
						tool_calls: [toolCall('read_file', call === 1 ? 'a.txt' : 'b.txt')]
					}));

					assert.ok(outcome.error instanceof RequestTooLargeError);
					const error = outcome.error as RequestTooLargeError;
					assert.ok(error.bytes <= MAX_REQUEST_BYTES);
					assert.ok(error.message.includes('innerhalb der Produktgrenze'));
					assert.ok(error.message.includes('Nach einer Budgetablehnung ist als nächster Leseversuch'));
					assert.ok(!error.message.includes('überschreitet die konservative Produktgrenze'));
					assertBodiesWithinProductLimit(outcome.bodies);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Ablehnungshinweis passt exakt bei 32.000 Bytes und der Request wird gesendet', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-budget-exact-'));
				fs.writeFileSync(path.join(dir, 'large.txt'), 'EXACT_PRIVATE'.repeat(4_000));
				try {
					const outcome = await runAgent(dir, (call, body) => call === 1
						? paddedReply(body, 'read_file', 'large.txt', MAX_REQUEST_BYTES)
						: { role: 'assistant', content: 'Fertig.' });

					assert.ok(outcome.value);
					assert.strictEqual(outcome.bodies.length, 2);
					assertBodiesWithinProductLimit(outcome.bodies);
					assert.strictEqual(
						Buffer.byteLength(JSON.stringify(outcome.bodies[1]), 'utf8'),
						MAX_REQUEST_BYTES
					);
					const toolMessage = outcome.bodies[1].messages
						.find(message => message.role === 'tool');
					assert.ok(toolMessage);
					const result = JSON.parse(String(toolMessage.content)) as { content: string };
					assert.strictEqual(result.content, TOOL_RESULT_BUDGET_NOTICE);
					assert.ok(!JSON.stringify(outcome.bodies[1]).includes('EXACT_PRIVATE'));
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('wenn der Hinweis nicht passt, wird das Werkzeug nicht ausgeführt', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-budget-no-notice-'));
				fs.writeFileSync(path.join(dir, 'large.txt'), 'NEVER_READ_PRIVATE'.repeat(4_000));
				try {
					const outcome = await runAgent(dir, (call, body) => {
						assert.strictEqual(call, 1);
						return paddedReply(
							body,
							'read_file',
							'large.txt',
							MAX_REQUEST_BYTES + 1
						);
					});

					assert.ok(outcome.error instanceof RequestTooLargeError);
					const error = outcome.error as RequestTooLargeError;
					assert.strictEqual(outcome.bodies.length, 1);
					assert.strictEqual(error.toolDiagnostics.length, 1);
					assert.strictEqual(error.toolDiagnostics[0].outcome, 'not-executed');
					assert.strictEqual(error.toolDiagnostics[0].tool, 'read_file');
					assert.strictEqual(
						error.toolDiagnostics[0].hypotheticalRequestBytes,
						MAX_REQUEST_BYTES + 1
					);
					assert.ok(!error.message.includes('NEVER_READ_PRIVATE'));
					assertBodiesWithinProductLimit(outcome.bodies);
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('nach einer Ablehnung wird ein erneut zu großes read_file_range abgebrochen', async () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-budget-retry-'));
				fs.writeFileSync(path.join(dir, 'large.txt'), 'INITIAL_PRIVATE'.repeat(4_000));
				fs.writeFileSync(path.join(dir, 'range.txt'), 'R'.repeat(3_000));
				try {
					const outcome = await runAgent(dir, (call, body) => {
						if (call === 1) {
							return paddedReply(
								body,
								'read_file',
								'large.txt',
								MAX_REQUEST_BYTES - 1_500
							);
						}
						return {
							role: 'assistant',
							content: '',
							tool_calls: [
								toolCall('read_file_range', 'range.txt', {
									first_line: 1,
									last_line: 1
								})
							]
						};
					});

					assert.ok(outcome.error instanceof RequestTooLargeError);
					const error = outcome.error as RequestTooLargeError;
					assert.strictEqual(outcome.bodies.length, 2);
					assertBodiesWithinProductLimit(outcome.bodies);
					assert.strictEqual(error.toolDiagnostics.length, 2);
					assert.strictEqual(error.toolDiagnostics[0].outcome, 'budget-rejected');
					assert.strictEqual(error.toolDiagnostics[1].tool, 'read_file_range');
					assert.strictEqual(error.toolDiagnostics[1].outcome, 'aborted');
					assert.ok(error.toolDiagnostics[1].hypotheticalRequestBytes > MAX_REQUEST_BYTES);
					assert.ok(error.message.includes('read_file_range range.txt'));
					assert.ok(!error.message.includes('INITIAL_PRIVATE'));
					assert.ok(!error.message.includes('R'.repeat(100)));
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});

			test('Diagnoseintrag weist Tool, Ziel und exakte Bytewerte ohne Dateiinhalt aus', () => {
				const text = formatEvidence(
					[{
						tool: 'read_file',
						target: 'src/private.ts',
						success: false
					}],
					0,
					[],
					[{
						tool: 'read_file',
						target: 'src/private.ts',
						requestBytesAdded: 24_000,
						hypotheticalRequestBytes: 40_000,
						outcome: 'budget-rejected'
					}]
				);
				assert.ok(text.includes('read_file src/private.ts'));
				assert.ok(text.includes('zusätzliche Request-Bytes=24000'));
				assert.ok(text.includes('hypothetische Gesamtgröße=40000'));
				assert.ok(text.includes('Ergebnis nicht an Ollama übermittelt'));
			});
		});

		test('Größenüberschreitung vor dem ersten Lesewerkzeug weist Body-Anteile exakt aus', async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-limit-before-tool-'));
			const originalFetch = globalThis.fetch;
			let fetchCalls = 0;
			try {
				fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'private rule marker '.repeat(2_000));
				globalThis.fetch = (async () => {
					fetchCalls += 1;
					return new Response('{}');
				}) as typeof fetch;

				const error = await runReadOnlyAgent(
					vscode.Uri.file(dir),
					'kurze Frage',
					undefined,
					[{ question: 'früher', answer: 'Antwort aus Verlauf' }]
				).then(() => undefined, reason => reason);

				assert.ok(error instanceof RequestTooLargeError);
				assert.strictEqual(error.toolResultCount, 0);
				assert.ok(error.breakdown);
				const breakdown = error.breakdown;
				assert.strictEqual(breakdown.totalBytes, error.bytes);
				assert.strictEqual(
					breakdown.systemPromptBytes
						+ breakdown.historyBytes
						+ breakdown.questionBytes
						+ breakdown.agentStepBytes
						+ breakdown.toolResultBytes
						+ breakdown.toolDefinitionsBytes
						+ breakdown.requestEnvelopeBytes,
					error.bytes
				);
				assert.ok(breakdown.systemPromptBytes > 32_000);
				assert.ok(breakdown.historyBytes > 0);
				assert.ok(breakdown.questionBytes > 0);
				assert.ok(breakdown.toolDefinitionsBytes > 0);
				assert.strictEqual(breakdown.toolResultBytes, 0);
				assert.strictEqual(fetchCalls, 0);
			} finally {
				globalThis.fetch = originalFetch;
				fs.rmSync(dir, { recursive: true, force: true });
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
				assert.ok(assistant.includes(expected), assistant);
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

		test('Mehrere tool_calls: nach der Budgetablehnung werden weitere Aufrufe derselben Antwort nicht ausgeführt', async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-limit-'));
			const originalFetch = globalThis.fetch;
			try {
				fs.writeFileSync(path.join(dir, 'big.md'), 'x'.repeat(MAX_REQUEST_BYTES));
				fs.writeFileSync(path.join(dir, 'small.md'), 'klein');
				fs.writeFileSync(path.join(dir, 'other.md'), 'anderes klein');
				let fetchCalls = 0;
				const sentBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
				globalThis.fetch = (async (_url: string, init: { body: string }) => {
					fetchCalls += 1;
					sentBodies.push(JSON.parse(init.body));
					const call = (name: string, file: string) =>
						({ function: { name, arguments: { path: file } } });
					return new Response(JSON.stringify({
						message: fetchCalls === 1
							? {
								role: 'assistant',
								content: '',
								tool_calls: [
									call('read_file', 'small.md'),
									call('read_file', 'big.md'),
									call('read_file', 'other.md'),
									call('list_directory', '.')
								]
							}
							: { role: 'assistant', content: 'Fertig.' }
					}));
				}) as unknown as typeof fetch;

				const statuses: string[] = [];
				const result = await runReadOnlyAgent(
					vscode.Uri.file(dir),
					'Lies alles',
					status => statuses.push(status)
				);

				// Genau zwei Werkzeuge liefen: small.md und big.md (abgewiesen).
				assert.strictEqual(statuses.filter(s => s.startsWith('Lesewerkzeug:')).length, 2);
				assert.strictEqual(fetchCalls, 2);
				assert.deepStrictEqual(
					result.toolDiagnostics?.map(d => d.outcome),
					['included', 'budget-rejected', 'not-executed', 'not-executed']
				);
				const toolMessages = sentBodies[1].messages.filter(m => m.role === 'tool');
				assert.strictEqual(toolMessages.length, 4);
				assert.ok(!JSON.stringify(sentBodies[1]).includes('anderes klein'));
				assert.ok(sentBodies.every(body =>
					Buffer.byteLength(JSON.stringify(body), 'utf8') <= MAX_REQUEST_BYTES));
			} finally {
				globalThis.fetch = originalFetch;
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});	});
});
