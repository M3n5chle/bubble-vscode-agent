import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Isolierte Beobachtung der VS-Code-Dokumentschicht mit temporären Dateien.
 * Keine Verbindung zu Vorschau, Freigabebeleg oder Befehlen; kein Writer.
 * Der Test erfasst Beobachtungen und stellt keine Sicherheitsgarantie fest.
 * Läuft nur über 
pm run test:diagnostic, nicht über npm test oder CI.
 * Siehe docs/research/document-layer-observations.md.
 */
const TIMEOUT = Symbol('timeout');

async function withTimeout<T>(promise: Thenable<T>, ms: number): Promise<T | typeof TIMEOUT> {
	return Promise.race([
		Promise.resolve(promise),
		new Promise<typeof TIMEOUT>(resolve => setTimeout(() => resolve(TIMEOUT), ms))
	]);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function hex(bytes: Buffer): string {
	return bytes.toString('hex');
}

suite('Dokumentschicht-Beobachtung (nur temporäre Dateien)', () => {
	test('WorkspaceEdit, externe Änderung vor save(): Beobachtungen werden erfasst', async function () {
		this.timeout(60_000);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-doclayer-'));
		const observations: Record<string, unknown> = {};

		try {
			assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())));
			const target = path.join(dir, 'probe.txt');
			const original = Buffer.from('original\n', 'utf8');
			const external = Buffer.from('EXTERN geändert, länger\n', 'utf8');
			fs.writeFileSync(target, original);
			const uri = vscode.Uri.file(target);

			// 1. Öffnen
			const document = await vscode.workspace.openTextDocument(uri);
			observations.openVersion = document.version;
			observations.openDirty = document.isDirty;

			// 2. WorkspaceEdit vorbereiten und anwenden
			const edit = new vscode.WorkspaceEdit();
			edit.replace(
				uri,
				new vscode.Range(0, 0, document.lineCount, 0),
				'vorgeschlagen\n'
			);
			observations.applyEdit = await withTimeout(vscode.workspace.applyEdit(edit), 10_000);
			observations.afterApplyVersion = document.version;
			observations.afterApplyDirty = document.isDirty;
			observations.afterApplyText = document.getText();

			// 3. Externe Änderung vor dem Speichern (neue Größe, spätere mtime)
			fs.writeFileSync(target, external);
			const later = new Date(Date.now() + 5_000);
			fs.utimesSync(target, later, later);
			await sleep(1_500);
			observations.afterExternalDirty = document.isDirty;
			observations.afterExternalText = document.getText();

			// 4. Speichern
			const saveResult = await withTimeout(document.save(), 10_000);
			observations.save = saveResult === TIMEOUT ? 'TIMEOUT (kein Ergebnis, möglicher Konflikt-Dialog)' : saveResult;
			observations.afterSaveDirty = document.isDirty;

			const onDisk = fs.readFileSync(target);
			observations.diskHex = hex(onDisk);
			observations.diskText = onDisk.toString('utf8');
			observations.diskIsExternal = onDisk.equals(external);
			observations.diskIsProposed = onDisk.equals(Buffer.from('vorgeschlagen\n', 'utf8'));
			observations.diskIsOriginal = onDisk.equals(original);

			// Ein Konflikt ist über die API nicht direkt abfragbar; nur indirekt beobachtbar.
			observations.conflictReported = 'nicht abfragbar (nur indirekt über save()-Ergebnis, isDirty und Bytes)';

			console.log('DOKUMENTSCHICHT-BEOBACHTUNG ' + JSON.stringify(observations, null, 2));

			// Nur Plausibilitäten des Testaufbaus, keine Aussage über das Konfliktverhalten.
			assert.strictEqual(observations.openDirty, false);
			assert.ok(typeof observations.diskText === 'string');
		} finally {
			await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			fs.rmSync(dir, { recursive: true, force: true });
			assert.ok(!fs.existsSync(dir), 'temporäres Verzeichnis nicht aufgeräumt');
		}
	});

	test('Externe Änderung VOR applyEdit bei sauberem Dokument: Beobachtungen werden erfasst', async function () {
		this.timeout(60_000);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-doclayer-pre-'));
		const observations: Record<string, unknown> = {};

		try {
			assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())));
			const target = path.join(dir, 'probe.txt');
			const original = Buffer.from('original\n', 'utf8');
			const external = Buffer.from('EXTERN vor applyEdit, länger\n', 'utf8');
			const proposed = Buffer.from('vorgeschlagen\n', 'utf8');
			fs.writeFileSync(target, original);
			const uri = vscode.Uri.file(target);

			// 1. Sauberes Dokument öffnen
			const document = await vscode.workspace.openTextDocument(uri);
			observations.openVersion = document.version;
			observations.openDirty = document.isDirty;
			observations.openText = document.getText();
			observations.openDiskHex = hex(fs.readFileSync(target));

			// 2. Extern ändern, bevor applyEdit aufgerufen wird
			fs.writeFileSync(target, external);
			const later = new Date(Date.now() + 5_000);
			fs.utimesSync(target, later, later);
			await sleep(1_500);
			observations.afterExternalVersion = document.version;
			observations.afterExternalDirty = document.isDirty;
			observations.afterExternalText = document.getText();
			observations.afterExternalDiskHex = hex(fs.readFileSync(target));

			// 3. WorkspaceEdit (bezogen auf den alten Text) und save(); kein Dialog wird bestätigt
			const edit = new vscode.WorkspaceEdit();
			edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), 'vorgeschlagen\n');
			observations.applyEdit = await withTimeout(vscode.workspace.applyEdit(edit), 10_000);
			observations.afterApplyVersion = document.version;
			observations.afterApplyDirty = document.isDirty;
			observations.afterApplyText = document.getText();

			const saveResult = await withTimeout(document.save(), 10_000);
			observations.save = saveResult === TIMEOUT
				? 'TIMEOUT (nicht abschließend prüfbar, möglicher Dialog)'
				: saveResult;
			observations.afterSaveVersion = document.version;
			observations.afterSaveDirty = document.isDirty;

			// 4. Tatsächliche Bytes
			const onDisk = fs.readFileSync(target);
			observations.diskHex = hex(onDisk);
			observations.diskText = onDisk.toString('utf8');
			observations.diskIsOriginal = onDisk.equals(original);
			observations.diskIsExternal = onDisk.equals(external);
			observations.diskIsProposed = onDisk.equals(proposed);

			console.log('DOKUMENTSCHICHT-BEOBACHTUNG (extern vor applyEdit) ' + JSON.stringify(observations, null, 2));

			assert.strictEqual(observations.openDirty, false);
			assert.ok(typeof observations.diskText === 'string');
		} finally {
			await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
			assert.ok(!fs.existsSync(dir), 'temporäres Verzeichnis nicht aufgeräumt');
		}
	});

	/*
	 * DIAGNOSETEST, KEIN SICHERHEITSTEST. Er hält einen Gegenfall fest und bestätigt keine Schutzwirkung.
	 * Beobachtet: Wurde die Datei extern mit anderen Bytes, aber gleicher Größe und exakt
	 * wiederhergestelltem mtime geändert, während das saubere Dokument offen war, schrieb
	 * applyEdit() + save() ohne Konfliktmeldung (save() === true) über die externen Bytes.
	 * Gilt nur für den getesteten VS-Code-/Windows-Lauf (Ganzsekunden-mtime, 1,5 s Wartezeit).
	 * Daraus folgt keine Freigabe für einen produktiven Writer; der Test assertet bewusst
	 * kein Überschreib- oder Schutzverhalten und schlägt daher bei Verhaltensänderungen nicht fehl.
	 */
	test('DIAGNOSE (kein Sicherheitstest): gleiche Größe und gleicher Zeitstempel, Beobachtungen werden erfasst', async function () {
		this.timeout(60_000);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-doclayer-same-'));
		const observations: Record<string, unknown> = {};

		try {
			assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())));
			const target = path.join(dir, 'probe.txt');
			const original = Buffer.from('original\n', 'utf8');
			const external = Buffer.from('externAL\n', 'utf8');
			assert.strictEqual(original.length, external.length);
			fs.writeFileSync(target, original);
			// Ganzsekunden-Zeitstempel, damit er sich exakt wiederherstellen lässt
			const fixed = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
			fs.utimesSync(target, fixed, fixed);
			const before = fs.statSync(target, { bigint: true });
			observations.setMtimeMs = fixed.getTime();
			observations.beforeMtimeNs = before.mtimeNs.toString();
			observations.beforeSize = before.size.toString();
			observations.beforeDiskHex = hex(fs.readFileSync(target));
			const uri = vscode.Uri.file(target);

			const document = await vscode.workspace.openTextDocument(uri);
			observations.openVersion = document.version;
			observations.openDirty = document.isDirty;
			observations.openText = document.getText();

			// Extern gleiche Größe schreiben und Zeitstempel zurücksetzen
			fs.writeFileSync(target, external);
			fs.utimesSync(target, fixed, fixed);
			const restored = fs.statSync(target, { bigint: true });
			observations.afterMtimeNs = restored.mtimeNs.toString();
			observations.afterSize = restored.size.toString();
			const exact = restored.mtimeNs === before.mtimeNs && restored.size === before.size;
			observations.timestampAndSizeRestoredExactly = exact;
			await sleep(1_500);
			observations.afterExternalVersion = document.version;
			observations.afterExternalDirty = document.isDirty;
			observations.afterExternalText = document.getText();
			observations.afterExternalDiskHex = hex(fs.readFileSync(target));

			const edit = new vscode.WorkspaceEdit();
			edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), 'vorgeschlagen\n');
			observations.applyEdit = await withTimeout(vscode.workspace.applyEdit(edit), 10_000);
			observations.afterApplyVersion = document.version;
			observations.afterApplyDirty = document.isDirty;

			const saveResult = await withTimeout(document.save(), 10_000);
			observations.save = saveResult === TIMEOUT
				? 'TIMEOUT (nicht abschließend prüfbar, möglicher Dialog)'
				: saveResult;
			observations.afterSaveVersion = document.version;
			observations.afterSaveDirty = document.isDirty;

			const onDisk = fs.readFileSync(target);
			observations.diskHex = hex(onDisk);
			observations.diskText = onDisk.toString('utf8');
			observations.diskIsOriginal = onDisk.equals(original);
			observations.diskIsExternal = onDisk.equals(external);
			observations.diskIsProposed = onDisk.equals(Buffer.from('vorgeschlagen\n', 'utf8'));
			const final = fs.statSync(target, { bigint: true });
			observations.finalMtimeNs = final.mtimeNs.toString();
			observations.finalSize = final.size.toString();
			observations.meaningful = exact ? 'ja (Zeitstempel und Größe exakt wiederhergestellt)' : 'NEIN, nicht aussagekräftig (Zeitstempel nicht exakt wiederherstellbar)';

			console.log('DOKUMENTSCHICHT-BEOBACHTUNG (gleiche Größe und mtime) ' + JSON.stringify(observations, null, 2));

			assert.strictEqual(observations.openDirty, false);
		} finally {
			await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
			assert.ok(!fs.existsSync(dir), 'temporäres Verzeichnis nicht aufgeräumt');
		}
	});
});