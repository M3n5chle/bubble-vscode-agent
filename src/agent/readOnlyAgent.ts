import * as vscode from 'vscode';
import {
    listProjectDirectory,
    readProjectFile,
    searchProjectText,
    ToolResult
} from '../tools/readTools.js';

const OLLAMA_URL = 'http://localhost:11434';
const MODEL = 'qwen3:14b';
const MAX_TOOL_ROUNDS = 8;

// Konservative Produktgrenze für die gesamte Anfrage (UTF-8-Bytes des
// JSON-Bodys: Systemtext, Verlauf, Werkzeugergebnisse, Werkzeugdefinitionen).
// Keine Token-Grenze und keine Garantie gegen Kontextkürzung: die
// Tokenisierung hängt vom Modell ab.
export const MAX_REQUEST_BYTES = 32_000;

// Nur Metadaten, keine Dateiinhalte.
export interface ToolEvidence {
    tool: string;
    target: string;
    success: boolean;
}

export interface ConversationTurn {
    question: string;
    answer: string;
    evidence?: readonly ToolEvidence[];
    omitted?: number;
}

export interface AgentResult {
    answer: string;
    evidence: ToolEvidence[];
    omitted: number;
}

const MAX_EVIDENCE_ENTRIES = 12;
const MAX_EVIDENCE_TARGET_LENGTH = 120;

function describeToolTarget(
    toolName: string,
    args: Record<string, unknown>
): string {
    const raw = toolName === 'search_text'
        ? `"${getStringArgument(args, 'query')}" in `
            + getStringArgument(args, 'include', '**/*')
        : getStringArgument(args, 'path', toolName === 'list_directory' ? '.' : '');

    const flat = raw.replace(/\s+/g, ' ').trim();

    return flat.length > MAX_EVIDENCE_TARGET_LENGTH
        ? `${flat.slice(0, MAX_EVIDENCE_TARGET_LENGTH)}…`
        : flat;
}

const MAX_EARLIER_READ_PATHS = 5;

function earlierSuccessfulReads(
    earlierTurns: readonly ConversationTurn[]
): string[] {
    const paths = new Set<string>();

    for (const turn of earlierTurns) {
        for (const entry of turn.evidence ?? []) {
            if (entry.tool === 'read_file' && entry.success) {
                paths.add(entry.target);
            }
        }
    }

    return [...paths];
}

// earlierTurns: Schritte vor dem protokollierten Schritt; nur Metadaten.
export function formatEvidence(
    evidence: readonly ToolEvidence[] | undefined,
    omitted = 0,
    earlierTurns: readonly ConversationTurn[] = []
): string {
    const entries = evidence ?? [];
    const readOk = entries.some(
        e => e.tool === 'read_file' && e.success
    );

    const lines = [
        'Werkzeugprotokoll dieses Schritts (nur Metadaten der '
        + 'Lesezugriffe; kein Beleg, dass die Antwort inhaltlich '
        + 'korrekt ist):'
    ];

    if (!readOk) {
        lines.push('In diesem Schritt keine Datei gelesen.');
    }

    const earlier = earlierSuccessfulReads(earlierTurns);

    if (earlier.length > 0) {
        const shown = earlier.slice(0, MAX_EARLIER_READ_PATHS);
        const more = earlier.length - shown.length;

        lines.push(
            'Frühere Schritte (nicht dieser Schritt): read_file '
            + 'erfolgreich für ' + shown.join(', ')
            + (more > 0 ? ` und ${more} weitere` : '')
            + '. Der Inhalt steht nicht im Verlauf.'
        );
    }

    for (const entry of entries) {
        lines.push(
            `- ${entry.tool} ${entry.target}: `
            + (entry.success ? 'erfolgreich' : 'fehlgeschlagen')
        );
    }

    if (omitted > 0) {
        lines.push(
            `- … ${omitted} weitere Aufrufe nicht aufgeführt`
        );
    }

    if (entries.length === 0) {
        lines.push('- Keine Lesewerkzeuge ausgeführt.');
    }

    return lines.join('\n');
}

export class RequestTooLargeError extends Error {
    constructor(readonly bytes: number) {
        super(requestTooLargeMessage(bytes));
        this.name = 'RequestTooLargeError';
    }
}

export function requestTooLargeMessage(bytes: number): string {
    return (
        `Die Anfrage (${bytes} Bytes) überschreitet die konservative `
        + `Produktgrenze von ${MAX_REQUEST_BYTES} Bytes `
        + '(Systemtext, Gesprächsverlauf und Werkzeugergebnisse). '
        + 'Es wurde nichts an Ollama gesendet und nichts gekürzt; '
        + 'weitere Werkzeugaufrufe wurden nicht ausgeführt. '
        + 'Die Byte-Grenze ist eine Vorsichtsmaßnahme, keine '
        + 'garantierte Token-Grenze und keine Garantie gegen '
        + 'Kontextkürzung.'
    );
}

function buildRequestBody(
    messages: OllamaMessage[]
): string {
    return JSON.stringify({
        model: MODEL,
        stream: false,
        messages,
        tools: getReadOnlyTools(),
        options: {
            temperature: 0.1,
            num_ctx: 16384
        }
    });
}

function assertWithinRequestLimit(
    body: string
): void {
    const bytes = Buffer.byteLength(body, 'utf8');

    if (bytes > MAX_REQUEST_BYTES) {
        throw new RequestTooLargeError(bytes);
    }
}

const PROJECT_RULE_FILES = [
    'AGENTS.md',
    'AGENT_RULES.md',
    'PROJECT_STATE.md'
];

interface OllamaMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_name?: string;
    tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
    function?: {
        name?: string;
        arguments?: Record<string, unknown>;
    };
}

interface OllamaResponse {
    message?: {
        role?: string;
        content?: string;
        tool_calls?: OllamaToolCall[];
    };
}

export async function runReadOnlyAgent(
    workspaceUri: vscode.Uri,
    userQuestion: string,
    onStatus?: (status: string) => void,
    history: readonly ConversationTurn[] = []
): Promise<AgentResult> {
    const evidence: ToolEvidence[] = [];
    let totalToolCalls = 0;

    const rules = await readAvailableRules(
        workspaceUri
    );

    const systemPrompt = buildSystemPrompt(rules);

    const messages: OllamaMessage[] = [
        {
            role: 'system',
            content: systemPrompt
        },
        ...history.flatMap((turn, index): OllamaMessage[] => [
            { role: 'user', content: turn.question },
            {
                role: 'assistant',
                content: turn.evidence
                    ? `${turn.answer}\n\n${formatEvidence(turn.evidence, turn.omitted, history.slice(0, index))}`
                    : turn.answer
            }
        ]),
        {
            role: 'user',
            content: userQuestion
        }
    ];

    for (
        let round = 1;
        round <= MAX_TOOL_ROUNDS;
        round += 1
    ) {
        onStatus?.(
            `Agent arbeitet, Schritt ${round} `
            + `von ${MAX_TOOL_ROUNDS} ...`
        );

        const response = await callOllama(messages);

        const assistantMessage =
            response.message;

        if (!assistantMessage) {
            throw new Error(
                'Ollama hat keine Nachricht geliefert.'
            );
        }

        const toolCalls =
            assistantMessage.tool_calls ?? [];

        messages.push({
            role: 'assistant',
            content: assistantMessage.content ?? '',
            tool_calls: toolCalls
        });

        if (toolCalls.length === 0) {
            const finalAnswer =
                assistantMessage.content?.trim();

            if (!finalAnswer) {
                throw new Error(
                    'Der Agent hat keine Antwort geliefert.'
                );
            }

            return {
                answer: finalAnswer,
                evidence: evidence.slice(),
                omitted: totalToolCalls - evidence.length
            };
        }

        for (const toolCall of toolCalls) {
            const toolName =
                toolCall.function?.name ?? '';

            const argumentsValue =
                toolCall.function?.arguments ?? {};

            onStatus?.(
                `Lesewerkzeug: ${toolName}`
            );

            const result = await executeReadTool(
                workspaceUri,
                toolName,
                argumentsValue
            );

            totalToolCalls += 1;

            if (evidence.length < MAX_EVIDENCE_ENTRIES) {
                evidence.push({
                    tool: toolName,
                    target: describeToolTarget(
                        toolName,
                        argumentsValue
                    ),
                    success: result.success
                });
            }

            messages.push({
                role: 'tool',
                tool_name: toolName,
                content: JSON.stringify({
                    success: result.success,
                    content: result.content
                })
            });

            // Nach jedem Ergebnis prüfen: bei Überschreitung weder weitere
            // Werkzeuge noch Ollama aufrufen.
            assertWithinRequestLimit(
                buildRequestBody(messages)
            );
        }
    }

    throw new Error(
        'Der Agent hat das maximale Limit '
        + 'von acht Leseschritten erreicht.'
    );
}

async function executeReadTool(
    workspaceUri: vscode.Uri,
    toolName: string,
    args: Record<string, unknown>
): Promise<ToolResult> {
    switch (toolName) {
        case 'read_file':
            return readProjectFile(
                workspaceUri,
                getStringArgument(args, 'path')
            );

        case 'list_directory':
            return listProjectDirectory(
                workspaceUri,
                getStringArgument(
                    args,
                    'path',
                    '.'
                )
            );

        case 'search_text':
            return searchProjectText(
                workspaceUri,
                getStringArgument(args, 'query'),
                getStringArgument(
                    args,
                    'include',
                    '**/*'
                )
            );

        default:
            return {
                success: false,
                content:
                    `Unbekanntes oder nicht erlaubtes `
                    + `Werkzeug: ${toolName}`
            };
    }
}

async function readAvailableRules(
    workspaceUri: vscode.Uri
): Promise<string[]> {
    const rules: string[] = [];

    for (const fileName of PROJECT_RULE_FILES) {
        const result = await readProjectFile(
            workspaceUri,
            fileName
        );

        if (result.success) {
            rules.push(result.content);
        }
    }

    return rules;
}

function buildSystemPrompt(
    rules: string[]
): string {
    return [
        'Du bist der lokale, rein lesende '
            + 'Projektagent.',
        '',
        'Du darfst das Projekt ausschließlich '
            + 'analysieren.',
        '',
        'Strikte Sicherheitsregeln:',
        '- Verändere keine Dateien.',
        '- Erstelle keine Dateien.',
        '- Lösche keine Dateien.',
        '- Führe keine Terminalbefehle aus.',
        '- Führe keine Git-Aktionen aus.',
        '- Greife nicht auf Server zu.',
        '- Greife nicht auf Datenbanken zu.',
        '- Fordere keine Geheimnisse an.',
        '- Lies keine gesperrten Dateien.',
        '- Erfinde keine Dateiinhalte.',
        '- Das „Werkzeugprotokoll“ im Verlauf nennt nur, welche '
            + 'Lesewerkzeuge liefen; es enthält keine Dateiinhalte. '
            + 'Behaupte nicht, eine Datei gelesen zu haben, '
            + 'wenn dort kein erfolgreiches read_file steht.',
        '- Verwende Werkzeuge nur, wenn sie nötig sind.',
        '- Antworte auf Deutsch.',
        '',
        'Verfügbare Werkzeuge:',
        '- list_directory: Ordnerinhalt auflisten',
        '- read_file: eine erlaubte Textdatei lesen',
        '- search_text: Text im Projekt suchen',
        '',
        'Wenn du nicht genug Informationen hast, '
            + 'verwende zuerst ein Lesewerkzeug.',
        '',
        'Projektregeln:',
        '',
        rules.join('\n\n---\n\n')
    ].join('\n');
}

async function callOllama(
    messages: OllamaMessage[]
): Promise<OllamaResponse> {
    const body = buildRequestBody(messages);

    assertWithinRequestLimit(body);

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
                    'Content-Type': 'application/json'
                },
                signal: controller.signal,
                body
            }
        );

        if (!response.ok) {
            const responseText =
                await response.text();

            throw new Error(
                `Ollama HTTP ${response.status}: `
                + responseText.slice(0, 400)
            );
        }

        const data = await response.json() as OllamaResponse;
        
        return data;
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

function getReadOnlyTools(): object[] {
    return [
        {
            type: 'function',
            function: {
                name: 'list_directory',
                description:
                    'Listet den Inhalt eines erlaubten '
                    + 'Ordners im Projekt auf.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description:
                                'Relativer Ordnerpfad, '
                                + 'zum Beispiel frontend/src'
                        }
                    },
                    required: ['path']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'read_file',
                description:
                    'Liest eine erlaubte Textdatei '
                    + 'aus dem Projekt.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description:
                                'Relativer Dateipfad, '
                                + 'zum Beispiel '
                                + 'frontend/src/modules/budget.js'
                        }
                    },
                    required: ['path']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'search_text',
                description:
                    'Sucht einen Text in erlaubten '
                    + 'Projektdateien.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description:
                                'Gesuchter Text'
                        },
                        include: {
                            type: 'string',
                            description:
                                'Optionales Dateimuster, '
                                + 'zum Beispiel **/*.js'
                        }
                    },
                    required: ['query']
                }
            }
        }
    ];
}

function getStringArgument(
    args: Record<string, unknown>,
    name: string,
    fallback = ''
): string {
    const value = args[name];

    return typeof value === 'string'
        ? value
        : fallback;
}