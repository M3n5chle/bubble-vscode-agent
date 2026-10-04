import * as path from 'node:path';
import * as vscode from 'vscode';
import { checkNoSymlinkInPath } from '../safety/pathPolicy.js';

const OLLAMA_URL = 'http://localhost:11434';
const MODEL = 'qwen3:14b';

const MAX_FILE_SIZE = 120_000;

const BLOCKED_FILE_NAMES = new Set([
    '.env',
    '.env.local',
    '.env.production',
    '.env.development',
    'db.php',
    'config.php'
]);

const BLOCKED_DIRECTORIES = new Set([
    '.git',
    'node_modules',
    'vendor',
    'uploads',
    'dist',
    '.vite'
]);

const BLOCKED_RELATIVE_PATHS = new Set([
    'config/db.php',
    'config/db.local.php'
]);

interface OllamaChatResponse {
    message?: {
        content?: string;
    };
}

export function registerAnalyzeCurrentFileCommand(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'bubble-vscode-agent.analyzeCurrentFile',
        async () => {
            const editor =
                vscode.window.activeTextEditor;

            if (!editor) {
                vscode.window.showWarningMessage(
                    'Bubble: Bitte zuerst eine Datei öffnen.'
                );

                return;
            }

            const documentUri =
                editor.document.uri;

            const workspaceFolder =
                vscode.workspace.getWorkspaceFolder(
                    documentUri
                );

            if (!workspaceFolder) {
                vscode.window.showErrorMessage(
                    'Bubble: Die Datei gehört zu '
                    + 'keinem geöffneten Workspace-Ordner.'
                );

                return;
            }

            const workspaceUri =
                workspaceFolder.uri;

            const pathCheck = checkFilePath(
                workspaceUri,
                documentUri
            );

            if (!pathCheck.allowed) {
                vscode.window.showErrorMessage(
                    `Bubble: ${pathCheck.reason}`
                );

                return;
            }

            const linkCheck = await checkNoSymlinkInPath(
                workspaceUri,
                pathCheck.relativePath
            );

            if (!linkCheck.allowed) {
                vscode.window.showErrorMessage(
                    `Bubble: ${linkCheck.reason}`
                );

                return;
            }

            const documentText =
                editor.document.getText();

            if (
                Buffer.byteLength(
                    documentText,
                    'utf8'
                ) > MAX_FILE_SIZE
            ) {
                vscode.window.showWarningMessage(
                    'Bubble: Die geöffnete Datei '
                    + `überschreitet das Leselimit von `
                    + `${MAX_FILE_SIZE} Bytes.`
                );

                return;
            }

            if (documentText.includes('\u0000')) {
                vscode.window.showErrorMessage(
                    'Bubble: Binärdateien '
                    + 'können nicht analysiert werden.'
                );

                return;
            }

            const question =
                await vscode.window.showInputBox({
                    title:
                        'Bubble: Aktuelle Datei analysieren',
                    prompt:
                        `Frage zu ${pathCheck.relativePath}`,
                    placeHolder:
                        'Zum Beispiel: '
                        + 'Welche Aufgaben übernimmt diese Datei?',
                    ignoreFocusOut: true
                });

            if (!question?.trim()) {
                return;
            }

            output.clear();
            output.show(true);

            output.appendLine(
                'Bubble: Dateianalyse'
            );
            output.appendLine(
                '========================'
            );
            output.appendLine('');
            output.appendLine(
                `Datei: ${pathCheck.relativePath}`
            );
            output.appendLine(
                `Frage: ${question.trim()}`
            );
            output.appendLine('');
            output.appendLine(
                'Antwort wird erstellt ...'
            );

            await vscode.window.withProgress(
                {
                    location:
                        vscode.ProgressLocation.Notification,
                    title:
                        'Bubble analysiert '
                        + 'die aktuelle Datei ...',
                    cancellable: false
                },
                async () => {
                    try {
                        const projectRules =
                            await readProjectRules(
                                workspaceUri
                            );

                        const prompt = buildPrompt(
                            pathCheck.relativePath,
                            documentText,
                            question.trim(),
                            projectRules
                        );

                        const answer =
                            await askOllama(prompt);

                        output.clear();
                        output.appendLine(
                            'Bubble: Dateianalyse'
                        );
                        output.appendLine(
                            '========================'
                        );
                        output.appendLine('');
                        output.appendLine(
                            `Datei: ${pathCheck.relativePath}`
                        );
                        output.appendLine(
                            `Frage: ${question.trim()}`
                        );
                        output.appendLine('');
                        output.appendLine('Antwort:');
                        output.appendLine('');
                        output.appendLine(answer);

                        vscode.window.showInformationMessage(
                            'Bubble: '
                            + 'Dateianalyse abgeschlossen.'
                        );
                    } catch (error) {
                        const message =
                            getErrorMessage(error);

                        output.appendLine('');
                        output.appendLine(
                            `FEHLER: ${message}`
                        );

                        vscode.window.showErrorMessage(
                            `Bubble: ${message}`
                        );
                    }
                }
            );
        }
    );
}

function checkFilePath(
    workspaceUri: vscode.Uri,
    documentUri: vscode.Uri
): {
    allowed: boolean;
    relativePath: string;
    reason?: string;
} {
    if (documentUri.scheme !== 'file') {
        return {
            allowed: false,
            relativePath: '',
            reason:
                'Nur lokale Dateien können '
                + 'analysiert werden.'
        };
    }

    const workspacePath =
        normalizeAbsolutePath(
            workspaceUri.fsPath
        );

    const documentPath =
        normalizeAbsolutePath(
            documentUri.fsPath
        );

    const workspacePrefix =
        workspacePath.endsWith(path.sep)
            ? workspacePath
            : workspacePath + path.sep;

    if (
        documentPath !== workspacePath
        && !documentPath.startsWith(
            workspacePrefix
        )
    ) {
        return {
            allowed: false,
            relativePath: '',
            reason:
                'Die Datei liegt außerhalb '
                + 'des geöffneten Projekts.'
        };
    }

    const relativePath = path
        .relative(
            workspaceUri.fsPath,
            documentUri.fsPath
        )
        .replaceAll('\\', '/');

    const lowerRelativePath =
        relativePath.toLowerCase();

    if (
        BLOCKED_RELATIVE_PATHS.has(
            lowerRelativePath
        )
    ) {
        return {
            allowed: false,
            relativePath,
            reason:
                `Die sensible Datei `
                + `"${relativePath}" ist gesperrt.`
        };
    }

    const pathParts =
        lowerRelativePath.split('/');

    for (const part of pathParts) {
        if (BLOCKED_DIRECTORIES.has(part)) {
            return {
                allowed: false,
                relativePath,
                reason:
                    `Der Ordner "${part}" `
                    + 'ist gesperrt.'
            };
        }
    }

    const fileName =
        pathParts[pathParts.length - 1] ?? '';

    if (
        BLOCKED_FILE_NAMES.has(fileName)
        || fileName.startsWith('.env.')
    ) {
        return {
            allowed: false,
            relativePath,
            reason:
                `Die sensible Datei `
                + `"${fileName}" ist gesperrt.`
        };
    }

    return {
        allowed: true,
        relativePath
    };
}

async function readProjectRules(
    workspaceUri: vscode.Uri
): Promise<string> {
    const ruleFiles = [
        'AGENTS.md',
        'AGENT_RULES.md',
        'PROJECT_STATE.md'
    ];

    const ruleContents: string[] = [];

    for (const fileName of ruleFiles) {
        if (!(await checkNoSymlinkInPath(workspaceUri, fileName)).allowed) {
            continue;
        }

        const fileUri = vscode.Uri.joinPath(
            workspaceUri,
            fileName
        );

        try {
            const data =
                await vscode.workspace.fs.readFile(
                    fileUri
                );

            ruleContents.push(
                `# ${fileName}\n\n`
                + new TextDecoder().decode(data)
            );
        } catch {
            continue;
        }
    }

    return ruleContents.join(
        '\n\n---\n\n'
    );
}

function buildPrompt(
    relativePath: string,
    fileContent: string,
    question: string,
    projectRules: string
): string {
    return [
        'Du bist der lokale, rein lesende '
            + 'Projektassistent.',
        '',
        'Sicherheitsregeln:',
        '- Verändere keine Dateien.',
        '- Erstelle keine Dateien.',
        '- Lösche keine Dateien.',
        '- Führe keine Befehle aus.',
        '- Führe keine Git-Aktionen aus.',
        '- Greife nicht auf Server '
            + 'oder Datenbanken zu.',
        '- Erfinde keine nicht vorhandenen Inhalte.',
        '- Antworte auf Deutsch.',
        '- Antworte klar, konkret und strukturiert.',
        '',
        '## Projektregeln',
        '',
        projectRules,
        '',
        '## Zu analysierende Datei',
        '',
        `Pfad: ${relativePath}`,
        '',
        '```text',
        fileContent,
        '```',
        '',
        '## Frage',
        '',
        question
    ].join('\n');
}

async function askOllama(
    prompt: string
): Promise<string> {
    const controller = new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        180_000
    );

    try {
        const response = await fetch(
            `${OLLAMA_URL}/api/chat`,
            {
                method: 'POST',
                headers: {
                    'Content-Type':
                        'application/json'
                },
                signal: controller.signal,
                body: JSON.stringify({
                    model: MODEL,
                    stream: false,
                    messages: [
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    options: {
                        temperature: 0.1,
                        num_ctx: 16384
                    }
                })
            }
        );

        if (!response.ok) {
            const responseText =
                await response.text();

            throw new Error(
                `Ollama HTTP ${response.status}: `
                + responseText.slice(0, 300)
            );
        }

        const data = await response.json() as OllamaChatResponse;

        const answer =
            data.message?.content?.trim();

        if (!answer) {
            throw new Error(
                'Ollama hat keine Antwort geliefert.'
            );
        }

        return answer;
    } catch (error) {
        if (
            error instanceof Error
            && error.name === 'AbortError'
        ) {
            throw new Error(
                'Ollama hat nicht innerhalb '
                + 'von 180 Sekunden geantwortet.'
            );
        }

        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function normalizeAbsolutePath(
    value: string
): string {
    const normalized = path.resolve(value);

    return process.platform === 'win32'
        ? normalized.toLowerCase()
        : normalized;
}

function getErrorMessage(
    error: unknown
): string {
    return error instanceof Error
        ? error.message
        : String(error);
}