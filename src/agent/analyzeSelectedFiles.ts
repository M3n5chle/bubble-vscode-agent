import * as path from 'node:path';
import * as vscode from 'vscode';

import { checkWorkspacePath } from '../safety/pathPolicy.js';
import {
    isAllowedTextFilePath,
    readProjectFile
} from '../tools/readTools.js';

const OLLAMA_URL = 'http://localhost:11434';
const MODEL = 'qwen3:14b';

export const MAX_SELECTED_FILES = 5;
const MAX_TOTAL_BYTES = 200_000;

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

            const picked =
                await vscode.window.showOpenDialog({
                    canSelectMany: true,
                    canSelectFiles: true,
                    canSelectFolders: false,
                    defaultUri: workspaceFolder.uri,
                    openLabel: 'Zur Analyse auswählen',
                    title:
                        'Bubble: Bis zu '
                        + `${MAX_SELECTED_FILES} Dateien auswählen`
                });

            if (!picked || picked.length === 0) {
                return;
            }

            if (picked.length > MAX_SELECTED_FILES) {
                vscode.window.showWarningMessage(
                    `Bubble: Es sind maximal ${MAX_SELECTED_FILES} `
                    + `Dateien erlaubt (gewählt: ${picked.length}).`
                );
                return;
            }

            const selection = await readSelectedFiles(
                workspaceFolder.uri,
                picked
            );

            if (selection.rejected.length > 0) {
                vscode.window.showErrorMessage(
                    'Bubble: Auswahl abgelehnt – '
                    + selection.rejected.join(' | ')
                );
                return;
            }

            const totalBytes = selection.files.reduce(
                (sum, file) =>
                    sum + Buffer.byteLength(file.content, 'utf8'),
                0
            );

            if (totalBytes > MAX_TOTAL_BYTES) {
                vscode.window.showWarningMessage(
                    'Bubble: Die Auswahl überschreitet '
                    + `${MAX_TOTAL_BYTES} Bytes insgesamt.`
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
                        const answer = await askOllama(
                            buildPrompt(
                                selection.files,
                                trimmedQuestion
                            )
                        );

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

function buildPrompt(
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
                model: MODEL,
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
