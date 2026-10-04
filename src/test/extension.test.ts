import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import {
	MAX_SELECTED_FILES,
	readSelectedFiles
} from '../agent/analyzeSelectedFiles.js';
import { readProjectFile } from '../tools/readTools.js';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Ausgewählte Dateien: gesperrte und externe Pfade werden abgelehnt', async () => {
		const root = vscode.Uri.file(process.cwd());
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

	test('Dateileser erlaubt Markdown und lehnt PNG sowie Dateien ohne Endung ab', async () => {
		const root = vscode.Uri.file(process.cwd());

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

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});
