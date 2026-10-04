import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    checkNoSymlinkInPath,
    checkWorkspacePath
} from '../safety/pathPolicy.js';
import { isAllowedTextFilePath } from '../tools/readTools.js';

export const PREVIEW_SCHEME = 'bubble-preview';
const MAX_PREVIEW_SIZE = 120_000;

export type PreparedPreview =
    | {
        ok: true;
        relativePath: string;
        original: string;
        proposed: string;
    }
    | { ok: false; reason: string };

/**
 * Prüft Pfad, Dateityp und Symlinks und liest die Originaldatei.
 * Rein lesend: Es wird nichts geschrieben, erstellt oder gelöscht.
 */
export async function prepareDiffPreview(
    workspaceUri: vscode.Uri,
    requestedPath: string,
    proposedText: string
): Promise<PreparedPreview> {
    const pathCheck = checkWorkspacePath(workspaceUri, requestedPath);

    if (
        !pathCheck.allowed
        || !pathCheck.absolutePath
        || !pathCheck.relativePath
    ) {
        return {
            ok: false,
            reason: pathCheck.reason ?? 'Der Pfad ist nicht erlaubt.'
        };
    }

    if (!isAllowedTextFilePath(pathCheck.relativePath)) {
        const extension = path.posix
            .extname(pathCheck.relativePath)
            .toLowerCase();

        return {
            ok: false,
            reason:
                `Der Dateityp "${extension || '(ohne Endung)'}" `
                + 'ist nicht als Textdatei freigegeben.'
        };
    }

    const linkCheck = await checkNoSymlinkInPath(
        workspaceUri,
        pathCheck.relativePath
    );

    if (!linkCheck.allowed) {
        return {
            ok: false,
            reason: linkCheck.reason ?? 'Der Pfad ist nicht erlaubt.'
        };
    }

    if (proposedText.length > MAX_PREVIEW_SIZE) {
        return {
            ok: false,
            reason:
                'Der vorgeschlagene Text überschreitet '
                + `${MAX_PREVIEW_SIZE} Zeichen.`
        };
    }

    const fileUri = vscode.Uri.file(pathCheck.absolutePath);

    try {
        const stat = await vscode.workspace.fs.stat(fileUri);

        if ((stat.type & vscode.FileType.File) !== vscode.FileType.File) {
            return {
                ok: false,
                reason: `"${pathCheck.relativePath}" ist keine Datei.`
            };
        }

        if (stat.size > MAX_PREVIEW_SIZE) {
            return {
                ok: false,
                reason:
                    `Die Datei ist mit ${stat.size} Bytes größer als `
                    + `das Limit von ${MAX_PREVIEW_SIZE} Bytes.`
            };
        }

        const data = await vscode.workspace.fs.readFile(fileUri);
        const original = new TextDecoder('utf-8').decode(data);

        if (original.includes('\u0000')) {
            return {
                ok: false,
                reason: 'Die Datei scheint Binärdaten zu enthalten.'
            };
        }

        return {
            ok: true,
            relativePath: pathCheck.relativePath,
            original,
            proposed: proposedText
        };
    } catch {
        return {
            ok: false,
            reason: 'Die Datei konnte nicht gelesen werden.'
        };
    }
}

/** Hält Vorschautexte nur im Speicher; es gibt keine Datei dahinter. */
export class PreviewContentProvider
    implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly contents = new Map<string, string>();
    private readonly closeListener: vscode.Disposable;
    private counter = 0;

    constructor(private readonly scheme: string = PREVIEW_SCHEME) {
        // Schließt der Nutzer den Diff-Tab, wird der Text freigegeben.
        this.closeListener = vscode.workspace.onDidCloseTextDocument(
            (document) => {
                if (document.uri.scheme === this.scheme) {
                    this.contents.delete(document.uri.toString());
                }
            }
        );
    }

    get size(): number {
        return this.contents.size;
    }

    dispose(): void {
        this.closeListener.dispose();
        this.contents.clear();
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.toString()) ?? '';
    }

    add(relativePath: string, side: 'original' | 'vorschlag', text: string): vscode.Uri {
        this.counter += 1;
        const uri = vscode.Uri.from({
            scheme: this.scheme,
            path: `/${side}/${this.counter}/${relativePath}`
        });
        this.contents.set(uri.toString(), text);
        return uri;
    }
}

export async function showDiffPreview(
    provider: PreviewContentProvider,
    preview: Extract<PreparedPreview, { ok: true }>
): Promise<void> {
    const left = provider.add(preview.relativePath, 'original', preview.original);
    const right = provider.add(preview.relativePath, 'vorschlag', preview.proposed);

    await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `Bubble Vorschau: ${preview.relativePath} (Original ↔ Vorschlag)`,
        { preview: true }
    );
}

export function registerDiffPreviewCommand(
    getWorkspaceUri: () => vscode.Uri | undefined
): vscode.Disposable {
    const provider = new PreviewContentProvider();
    const registration =
        vscode.workspace.registerTextDocumentContentProvider(
            PREVIEW_SCHEME,
            provider
        );

    const command = vscode.commands.registerCommand(
        'bubble-vscode-agent.previewDiff',
        async () => {
            const workspaceUri = getWorkspaceUri();

            if (!workspaceUri) {
                vscode.window.showErrorMessage(
                    'Bubble: Kein Projektordner geöffnet.'
                );
                return;
            }

            const picked = await vscode.window.showOpenDialog({
                defaultUri: workspaceUri,
                canSelectMany: false,
                canSelectFiles: true,
                canSelectFolders: false,
                openLabel: 'Datei für Vorschau wählen'
            });

            if (!picked || picked.length === 0) {
                return;
            }

            const relativePath = path
                .relative(workspaceUri.fsPath, picked[0].fsPath)
                .replaceAll('\\', '/');

            const proposed = await vscode.window.showInputBox({
                title: 'Bubble: Vorgeschlagener neuer Text',
                prompt:
                    'Neuer Dateiinhalt (einzeilig; \\n steht für einen '
                    + 'Zeilenumbruch). Es wird nichts gespeichert.',
                ignoreFocusOut: true
            });

            if (proposed === undefined) {
                return;
            }

            const result = await prepareDiffPreview(
                workspaceUri,
                relativePath,
                proposed.replaceAll('\\n', '\n')
            );

            if (!result.ok) {
                vscode.window.showErrorMessage(`Bubble: ${result.reason}`);
                return;
            }

            await showDiffPreview(provider, result);
        }
    );

    return vscode.Disposable.from(registration, provider, command);
}
