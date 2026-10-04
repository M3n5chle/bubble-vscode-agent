import * as vscode from 'vscode';
import { checkNoSymlinkInPath } from './safety/pathPolicy.js';

import {
registerAnalyzeCurrentFileCommand
} from './agent/analyzeCurrentFile.js';

import {
    registerAnalyzeSelectedFilesCommand
} from './agent/analyzeSelectedFiles.js';

import {
    runReadOnlyAgent
} from './agent/readOnlyAgent.js';

const OLLAMA_URL = 'http://localhost:11434';
const REQUIRED_MODEL = 'qwen3:14b';

const REQUIRED_PROJECT_FILES = [
    'AGENTS.md',
    'AGENT_RULES.md',
    'PROJECT_STATE.md'
];

interface OllamaModel {
    name?: string;
    model?: string;
}

interface OllamaTagsResponse {
    models?: OllamaModel[];
}

// Regeldateien sind optional und beeinflussen die Bereitschaft nicht.
function isSystemReady(
    ollamaStatus: {
        reachable: boolean;
        requiredModelFound: boolean;
    }
): boolean {
    return ollamaStatus.reachable
        && ollamaStatus.requiredModelFound;
}

export function activate(
    context: vscode.ExtensionContext
) {
    console.log('Bubble ist aktiv.');

    const output =
        vscode.window.createOutputChannel(
            'Bubble'
        );

    const systemCheckCommand =
        vscode.commands.registerCommand(
            'bubble-vscode-agent.systemCheck',
            async () => {
                await runSystemCheck(
                    output
                );
            }
        );

    const askCommand =
        vscode.commands.registerCommand(
            'bubble-vscode-agent.ask',
            async () => {
                await runSimpleQuestion(
                    output
                );
            }
        );

    const analyzeCommand =
        vscode.commands.registerCommand(
            'bubble-vscode-agent.analyzeProject',
            async () => {
                await runProjectAnalysis(
                    output
                );
            }
        );

    const analyzeCurrentFileCommand =
        registerAnalyzeCurrentFileCommand(
            context,
            output
        );

    const analyzeSelectedFilesCommand =
        registerAnalyzeSelectedFilesCommand(output);

    context.subscriptions.push(
        output,
        analyzeSelectedFilesCommand,
        systemCheckCommand,
        askCommand,
        analyzeCommand,
        analyzeCurrentFileCommand
    );
}

export async function runSystemCheck(
    output: vscode.OutputChannel,
    workspaceOverride?: vscode.Uri
): Promise<boolean | undefined> {
    const workspaceUri = workspaceOverride ?? requireWorkspaceUri();

    if (!workspaceUri) {
        return;
    }

    output.clear();
    output.show(true);

    output.appendLine(
        'Bubble: Systemprüfung'
    );
    output.appendLine(
        '=========================='
    );
    output.appendLine('');

    output.appendLine(
        `Workspace: ${workspaceUri.fsPath}`
    );

    output.appendLine('');
    output.appendLine('Projektdateien:');

    for (const fileName of REQUIRED_PROJECT_FILES) {
        const fileUri = vscode.Uri.joinPath(
            workspaceUri,
            fileName
        );

        const exists = await fileExists(fileUri);

        if (exists) {
            output.appendLine(
                `  OK: ${fileName}`
            );
        } else {
            output.appendLine(
                `  FEHLT (optional): ${fileName}`
            );
        }
    }

    output.appendLine('');
    output.appendLine('Ollama:');

    const ollamaStatus = await checkOllama();

    if (ollamaStatus.reachable) {
        output.appendLine(
            `  OK: Ollama erreichbar unter `
            + OLLAMA_URL
        );

        output.appendLine(
            '  Installierte Modelle:'
        );

        for (
            const modelName
            of ollamaStatus.modelNames
        ) {
            output.appendLine(
                `    - ${modelName}`
            );
        }

        if (ollamaStatus.requiredModelFound) {
            output.appendLine(
                `  OK: ${REQUIRED_MODEL} vorhanden`
            );
        } else {
            output.appendLine(
                `  FEHLT: ${REQUIRED_MODEL}`
            );
        }
    } else {
        output.appendLine(
            `  FEHLER: ${ollamaStatus.error}`
        );
    }

    output.appendLine('');
    output.appendLine('Ergebnis:');

    const ready = isSystemReady(ollamaStatus);

    if (ready) {
        output.appendLine('  SYSTEM BEREIT');

        vscode.window.showInformationMessage(
            'Bubble: System ist bereit.'
        );
    } else {
        output.appendLine(
            '  SYSTEM NOCH NICHT '
            + 'VOLLSTAENDIG BEREIT'
        );

        vscode.window.showWarningMessage(
            'Bubble: Systemprüfung '
            + 'mit Hinweisen beendet.'
        );
    }

    return ready;
}

async function runSimpleQuestion(
    output: vscode.OutputChannel
): Promise<void> {
    const workspaceUri = requireWorkspaceUri();

    if (!workspaceUri) {
        return;
    }

    const question =
        await vscode.window.showInputBox({
            title: 'Bubble',
            prompt:
                'Was möchtest du über die '
                + 'Projektregeln wissen?',
            ignoreFocusOut: true
        });

    if (!question?.trim()) {
        return;
    }

    output.clear();
    output.show(true);

    output.appendLine('Bubble');
    output.appendLine('===========');
    output.appendLine('');
    output.appendLine(
        `Frage: ${question.trim()}`
    );
    output.appendLine('');
    output.appendLine(
        'Antwort wird erstellt ...'
    );

    try {
        const ruleContents: string[] = [];

        for (
            const fileName
            of REQUIRED_PROJECT_FILES
        ) {
            const fileUri = vscode.Uri.joinPath(
                workspaceUri,
                fileName
            );

            if (
                !(await checkNoSymlinkInPath(workspaceUri, fileName)).allowed
                || !(await fileExists(fileUri))
            ) {
                continue;
            }

            const content =
                await vscode.workspace.fs.readFile(
                    fileUri
                );

            ruleContents.push(
                `# ${fileName}\n\n`
                + new TextDecoder().decode(content)
            );
        }

        const prompt = [
            'Du bist der lokale '
                + 'Projektassistent.',
            '',
            'Antworte nur auf Grundlage '
                + 'der folgenden Projektregeln.',
            'Verändere keine Dateien.',
            'Führe keine Befehle aus.',
            'Antworte auf Deutsch.',
            '',
            ruleContents.join(
                '\n\n---\n\n'
            ),
            '',
            'Frage:',
            question.trim()
        ].join('\n');

        const answer =
            await askOllamaSimple(prompt);

        output.clear();
        output.appendLine('Bubble');
        output.appendLine('===========');
        output.appendLine('');
        output.appendLine(
            `Frage: ${question.trim()}`
        );
        output.appendLine('');
        output.appendLine('Antwort:');
        output.appendLine('');
        output.appendLine(answer);
    } catch (error) {
        showError(output, error);
    }
}

async function runProjectAnalysis(
    output: vscode.OutputChannel
): Promise<void> {
    const workspaceUri = requireWorkspaceUri();

    if (!workspaceUri) {
        return;
    }

    const question =
        await vscode.window.showInputBox({
            title:
                'Bubble: Projekt analysieren',
            prompt:
                'Welche rein lesende Analyse '
                + 'soll durchgeführt werden?',
            placeHolder:
                'Zum Beispiel: Prüfe budget.js '
                + 'auf doppelte Formularlogik.',
            ignoreFocusOut: true
        });

    if (!question?.trim()) {
        return;
    }

    output.clear();
    output.show(true);

    output.appendLine(
        'Bubble: Projektanalyse'
    );
    output.appendLine(
        '============================'
    );
    output.appendLine('');
    output.appendLine(
        `Aufgabe: ${question.trim()}`
    );
    output.appendLine('');
    output.appendLine(
        'Analyse wird vorbereitet ...'
    );

    await vscode.window.withProgress(
        {
            location:
                vscode.ProgressLocation.Notification,
            title:
                'Bubble analysiert '
                + 'das Projekt ...',
            cancellable: false
        },
        async (progress) => {
            try {
                const answer =
                    await runReadOnlyAgent(
                        workspaceUri,
                        question.trim(),
                        (status) => {
                            progress.report({
                                message: status
                            });

                            output.appendLine(
                                status
                            );
                        }
                    );

                output.clear();
                output.appendLine(
                    'Bubble: Projektanalyse'
                );
                output.appendLine(
                    '============================'
                );
                output.appendLine('');
                output.appendLine(
                    `Aufgabe: ${question.trim()}`
                );
                output.appendLine('');
                output.appendLine('Ergebnis:');
                output.appendLine('');
                output.appendLine(answer);

                vscode.window
                    .showInformationMessage(
                        'Bubble: '
                        + 'Analyse abgeschlossen.'
                    );
            } catch (error) {
                showError(output, error);
            }
        }
    );
}

export const NO_WORKSPACE_MESSAGE =
    'Bubble: Es ist kein Workspace geöffnet. '
    + 'Bitte zuerst einen Projektordner öffnen.';

export function resolveWorkspaceUri(
    folders: readonly { uri: vscode.Uri }[] | undefined
): vscode.Uri | undefined {
    return folders?.[0]?.uri;
}

function requireWorkspaceUri(): vscode.Uri | undefined {
    const workspaceUri = resolveWorkspaceUri(
        vscode.workspace.workspaceFolders
    );

    if (!workspaceUri) {
        vscode.window.showErrorMessage(NO_WORKSPACE_MESSAGE);
    }

    return workspaceUri;
}

async function askOllamaSimple(
    prompt: string
): Promise<string> {
    const controller = new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        120_000
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
                    model: REQUIRED_MODEL,
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
            throw new Error(
                `Ollama HTTP ${response.status}`
            );
        }

        const data = await response.json() as {
            message?: {
                content?: string;
            };
        };

        const answer =
            data.message?.content?.trim();

        if (!answer) {
            throw new Error(
                'Ollama hat keine '
                + 'Antwort geliefert.'
            );
        }

        return answer;
    } finally {
        clearTimeout(timeout);
    }
}

async function checkOllama(): Promise<{
    reachable: boolean;
    requiredModelFound: boolean;
    modelNames: string[];
    error: string;
}> {
    try {
        const response = await fetch(
            `${OLLAMA_URL}/api/tags`
        );

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const data = await response.json() as OllamaTagsResponse;

        const modelNames = (data.models ?? [])
            .map(
                (model) =>
                    model.name
                    ?? model.model
                    ?? ''
            )
            .filter(Boolean);

        return {
            reachable: true,
            requiredModelFound:
                modelNames.includes(
                    REQUIRED_MODEL
                ),
            modelNames,
            error: ''
        };
    } catch (error) {
        return {
            reachable: false,
            requiredModelFound: false,
            modelNames: [],
            error: getErrorMessage(error)
        };
    }
}

async function fileExists(
    uri: vscode.Uri
): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

function showError(
    output: vscode.OutputChannel,
    error: unknown
): void {
    const message = getErrorMessage(error);

    output.appendLine('');
    output.appendLine(
        `FEHLER: ${message}`
    );

    vscode.window.showErrorMessage(
        `Bubble: ${message}`
    );
}

function getErrorMessage(
    error: unknown
): string {
    return error instanceof Error
        ? error.message
        : String(error);
}

export function deactivate() {}