import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import {
	MAX_SELECTED_FILES,
	readSelectedFiles,
	validateSelection
} from '../agent/analyzeSelectedFiles.js';
import { checkFilePath } from '../agent/analyzeCurrentFile.js';
import { resolveWorkspaceUri, runSystemCheck } from '../extension.js';
import { readProjectFile, searchProjectText } from '../tools/readTools.js';

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
});
