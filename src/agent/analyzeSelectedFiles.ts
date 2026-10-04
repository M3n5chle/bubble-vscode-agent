import * as path from 'node:path';
import * as vscode from 'vscode';
import { getOllamaModel } from '../ollamaModel.js';

import { checkWorkspacePath } from '../safety/pathPolicy.js';
import {
    isAllowedTextFilePath,
    readProjectFile
} from '../tools/readTools.js';

const OLLAMA_URL = 'http://localhost:11434';

export const MAX_SELECTED_FILES = 5;
// Konservative Produktgrenze für den vollständigen Prompt (UTF-8-Bytes),
// keine Garantie gegen Kontextkürzung: Ollama dokumentiert keine
// verlässliche Erkennung, die Tokenisierung hängt vom Modell ab.
export const MAX_PROMPT_BYTES = 8_000;

export function promptTooLargeMessage(bytes: number): string {
    return (
        `Bubble: Der Prompt (${bytes} Bytes) überschreitet die `
        + `konservative Produktgrenze von ${MAX_PROMPT_BYTES} Bytes. `
        + 'Bitte weniger oder kleinere Dateien bzw. eine kürzere '
        + 'Frage wählen. Die Grenze ist eine Vorsichtsmaßnahme, '
        + 'keine Garantie gegen Kontextkürzung.'
    );
}

export type AnalysisResult =
    | { ok: true; answer: string }
    | { ok: false; message: string };

export async function analyzeWithLimit(
    files: readonly SelectedFile[],
    question: string,
    ask: (prompt: string) => Promise<string> = askOllama
): Promise<AnalysisResult> {
    const prompt = buildPrompt(files, question);
    const bytes = Buffer.byteLength(prompt, 'utf8');

    if (bytes > MAX_PROMPT_BYTES) {
        return { ok: false, message: promptTooLargeMessage(bytes) };
    }

    return { ok: true, answer: await ask(prompt) };
}

export interface SelectedFile {
    relativePath: string;
    content: string;
}

export interface SelectionResult {
    files: SelectedFile[];
    rejected: string[];
}

interface OllamaChatResponse {
    message?: {
        content?: string;
    };
}

export function registerAnalyzeSelectedFilesCommand(
    output: vscode.OutputChannel
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'bubble-vscode-agent.analyzeSelectedFiles',
        async () => {
            const workspaceFolder =
                vscode.workspace.workspaceFolders?.[0];

            if (!workspaceFolder) {
                vscode.window.showErrorMessage(
                    'Bubble: Es ist kein Workspace geöffnet.'
                );
                return;
            }

            const picked = await pickFilesFromWorkspace(
                workspaceFolder.uri
            );

            if (!picked || picked.length === 0) {
                return;
            }

            const validation = await validateSelection(
                workspaceFolder.uri,
                picked
            );

            if (!validation.ok) {
                if (validation.kind === 'tooMany') {
                    vscode.window.showWarningMessage(validation.message);
                } else {
                    vscode.window.showErrorMessage(validation.message);
                }
                return;
            }

            const selection = validation.selection;

            const totalBytes = selection.files.reduce(
                (sum, file) =>
                    sum + Buffer.byteLength(file.content, 'utf8'),
                0
            );

            // Der Prompt ist immer größer als die reinen Dateiinhalte.
            if (totalBytes > MAX_PROMPT_BYTES) {
                vscode.window.showWarningMessage(
                    promptTooLargeMessage(totalBytes)
                );
                return;
            }

            const pathList = selection.files
                .map((file) => file.relativePath)
                .join('\n');

            const confirmation =
                await vscode.window.showInformationMessage(
                    'Diese Dateien werden an das lokale '
                    + 'Ollama-Modell gesendet:',
                    {
                        modal: true,
                        detail: pathList
                    },
                    'Weiter'
                );

            if (confirmation !== 'Weiter') {
                return;
            }

            const question =
                await vscode.window.showInputBox({
                    title: 'Bubble: Ausgewählte Dateien analysieren',
                    prompt:
                        `Frage zu ${selection.files.length} Datei(en): `
                        + selection.files
                            .map((file) => file.relativePath)
                            .join(', '),
                    placeHolder:
                        'Zum Beispiel: Wie hängen diese Dateien zusammen?',
                    ignoreFocusOut: true
                });

            if (!question?.trim()) {
                return;
            }

            const trimmedQuestion = question.trim();

            output.clear();
            output.show(true);
            output.appendLine('Bubble: Analyse ausgewählter Dateien');
            output.appendLine('=====================================');
            output.appendLine('');
            output.appendLine('Analysierte Dateien:');
            for (const file of selection.files) {
                output.appendLine(`- ${file.relativePath}`);
            }
            output.appendLine('');
            output.appendLine(`Frage: ${trimmedQuestion}`);
            output.appendLine('');
            output.appendLine('Antwort wird erstellt ...');

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Bubble analysiert die ausgewählten Dateien ...',
                    cancellable: false
                },
                async () => {
                    try {
                        const result = await analyzeWithLimit(
                            selection.files,
                            trimmedQuestion
                        );

                        if (!result.ok) {
                            output.appendLine('');
                            output.appendLine(result.message);
                            vscode.window.showWarningMessage(
                                result.message
                            );
                            return;
                        }

                        const answer = result.answer;

                        output.appendLine('');
                        output.appendLine('Antwort:');
                        output.appendLine('');
                        output.appendLine(answer);
                        output.appendLine('');
                        output.appendLine('Analysierte Dateien:');
                        for (const file of selection.files) {
                            output.appendLine(`- ${file.relativePath}`);
                        }

                        vscode.window.showInformationMessage(
                            'Bubble: Analyse abgeschlossen.'
                        );
                    } catch (error) {
                        const message = getErrorMessage(error);

                        output.appendLine('');
                        output.appendLine(`FEHLER: ${message}`);
                        vscode.window.showErrorMessage(
                            `Bubble: ${message}`
                        );
                    }
                }
            );
        }
    );
}

const MAX_LISTED_FILES = 2_000;

export interface SelectableFile {
    relativePath: string;
    uri: vscode.Uri;
}

// Listet nur Dateien, die checkWorkspacePath und die Textdatei-Allowlist
// bestehen. Symlinks (Dateien wie Ordner) werden nie verfolgt.
export async function listSelectableFiles(
    workspaceUri: vscode.Uri
): Promise<SelectableFile[]> {
    const found: SelectableFile[] = [];

    const walk = async (relativeDir: string): Promise<void> => {
        const dirUri = relativeDir
            ? vscode.Uri.joinPath(workspaceUri, relativeDir)
            : workspaceUri;
        let entries: [string, vscode.FileType][];

        try {
            entries = await vscode.workspace.fs.readDirectory(dirUri);
        } catch {
            return;
        }

        entries.sort(([a], [b]) => a.localeCompare(b));

        for (const [name, type] of entries) {
            if (found.length >= MAX_LISTED_FILES) {
                return;
            }

            if ((type & vscode.FileType.SymbolicLink) !== 0) {
                continue;
            }

            const relative = relativeDir ? `${relativeDir}/${name}` : name;
            const check = checkWorkspacePath(workspaceUri, relative);

            if (!check.allowed || !check.relativePath) {
                continue;
            }

            if ((type & vscode.FileType.Directory) !== 0) {
                await walk(check.relativePath);
            } else if (
                (type & vscode.FileType.File) !== 0
                && isAllowedTextFilePath(check.relativePath)
            ) {
                found.push({
                    relativePath: check.relativePath,
                    uri: vscode.Uri.joinPath(
                        workspaceUri,
                        check.relativePath
                    )
                });
            }
        }
    };

    await walk('');

    return found;
}

export async function pickFilesFromWorkspace(
    workspaceUri: vscode.Uri
): Promise<vscode.Uri[] | undefined> {
    const files = await listSelectableFiles(workspaceUri);

    if (files.length === 0) {
        vscode.window.showWarningMessage(
            'Bubble: Im Workspace wurden keine analysierbaren '
            + 'Dateien gefunden.'
        );
        return undefined;
    }

    const items = files.map((file) => ({
        label: file.relativePath,
        uri: file.uri
    }));

    const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        matchOnDescription: true,
        ignoreFocusOut: true,
        title:
            `Bubble: Bis zu ${MAX_SELECTED_FILES} Dateien auswählen`,
        placeHolder: 'Dateien aus beliebigen Ordnern auswählen'
    });

    return picked?.map((item) => item.uri);
}

export type SelectionValidation =
    | { ok: true; selection: SelectionResult }
    | { ok: false; kind: 'tooMany' | 'rejected'; message: string };

export async function validateSelection(
    workspaceUri: vscode.Uri,
    uris: readonly vscode.Uri[]
): Promise<SelectionValidation> {
    if (uris.length > MAX_SELECTED_FILES) {
        return {
            ok: false,
            kind: 'tooMany',
            message:
                `Bubble: Es sind maximal ${MAX_SELECTED_FILES} `
                + `Dateien erlaubt (gewählt: ${uris.length}).`
        };
    }

    const selection = await readSelectedFiles(workspaceUri, uris);

    if (selection.rejected.length > 0) {
        return {
            ok: false,
            kind: 'rejected',
            message:
                'Bubble: Auswahl abgelehnt – '
                + selection.rejected.join(' | ')
        };
    }

    return { ok: true, selection };
}

export async function readSelectedFiles(
    workspaceUri: vscode.Uri,
    uris: readonly vscode.Uri[]
): Promise<SelectionResult> {
    const files: SelectedFile[] = [];
    const rejected: string[] = [];
    const seen = new Set<string>();

    for (const uri of uris) {
        if (uri.scheme !== 'file') {
            rejected.push(`${uri.toString()}: nur lokale Dateien erlaubt`);
            continue;
        }

        const relative = path
            .relative(workspaceUri.fsPath, uri.fsPath)
            .replaceAll('\\', '/');

        if (
            !relative
            || path.isAbsolute(relative)
            || relative === '..'
            || relative.startsWith('../')
        ) {
            rejected.push(
                `${uri.fsPath}: liegt außerhalb des Workspaces`
            );
            continue;
        }

        const check = checkWorkspacePath(workspaceUri, relative);

        if (!check.allowed || !check.relativePath) {
            rejected.push(`${relative}: ${check.reason ?? 'gesperrt'}`);
            continue;
        }

        if (seen.has(check.relativePath.toLowerCase())) {
            continue;
        }
        seen.add(check.relativePath.toLowerCase());

        if (!isAllowedTextFilePath(check.relativePath)) {
            rejected.push(
                `${check.relativePath}: ist nicht als `
                + 'Textdatei freigegeben'
            );
            continue;
        }

        const result = await readProjectFile(
            workspaceUri,
            check.relativePath
        );

        if (!result.success) {
            rejected.push(`${check.relativePath}: ${result.content}`);
            continue;
        }

        // readProjectFile liefert einen Kopf aus Pfad, Größe und Leerzeile.
        const separator = result.content.indexOf('\n\n');

        files.push({
            relativePath: check.relativePath,
            content: result.content.slice(separator + 2)
        });
    }

    return { files, rejected };
}

export function buildPrompt(
    files: readonly SelectedFile[],
    question: string
): string {
    const sections = files.flatMap((file) => [
        `### Datei: ${file.relativePath}`,
        '',
        '```text',
        file.content,
        '```',
        ''
    ]);

    return [
        'Du bist ein lokaler, rein lesender Projektassistent.',
        '',
        'Regeln:',
        '- Verändere, erstelle oder lösche keine Dateien.',
        '- Führe keine Befehle oder Git-Aktionen aus.',
        '- Greife nicht auf Server oder Datenbanken zu.',
        '- Nutze ausschließlich die unten angegebenen Dateiinhalte.',
        '- Erfinde keine nicht vorhandenen Inhalte.',
        '- Geplante Funktionen dürfen nicht als bereits '
            + 'implementiert dargestellt werden. Aussagen '
            + 'über den aktuellen Funktionsstand müssen durch '
            + 'die übergebenen Dateiinhalte belegt sein.',
        '- Antworte auf Deutsch, klar und strukturiert.',
        '',
        '## Dateien',
        '',
        ...sections,
        '## Frage',
        '',
        question
    ].join('\n');
}

async function askOllama(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);

    try {
        const response = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                model: getOllamaModel(),
                stream: false,
                messages: [{ role: 'user', content: prompt }],
                options: { temperature: 0.1, num_ctx: 16384 }
            })
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Ollama HTTP ${response.status}: ${text.slice(0, 300)}`
            );
        }

        const data = await response.json() as OllamaChatResponse;
        const answer = data.message?.content?.trim();

        if (!answer) {
            throw new Error('Ollama hat keine Antwort geliefert.');
        }

        return answer;
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(
                'Ollama hat nicht innerhalb von 180 Sekunden geantwortet.'
            );
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
