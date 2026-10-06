import * as path from 'node:path';
import * as vscode from 'vscode';
import { runExclusiveOperation } from './operationLock.js';
import { checkWorkspacePath } from '../safety/pathPolicy.js';
import { getOllamaModel } from '../ollamaModel.js';
import {
    createContextLedger,
    formatContextStatus,
    recordForwardedResult,
    recordRejected
} from './contextStatus.js';
import {
    listProjectDirectory,
    readProjectFile,
    readProjectFileRange,
    searchProjectText,
    MAX_RANGE_LINES,
    MAX_RANGE_RESULT_BYTES,
    ToolResult
} from '../tools/readTools.js';

const OLLAMA_URL = 'http://localhost:11434';
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

export interface ToolRequestDiagnostic {
    tool: string;
    target: string;
    requestBytesAdded: number;
    hypotheticalRequestBytes: number;
    outcome: 'included' | 'budget-rejected' | 'not-executed' | 'aborted'
        | 'repeat-blocked' | 'context-search-blocked';
    // Metadaten; nie Datei- oder Regelinhalte.
    round?: number;
    requestedRange?: LineRange;
    deliveredRange?: LineRange | null;
    reason?: string;
}

export interface LineRange {
    firstLine: number;
    lastLine: number;
}

export type ToolActivityStatus =
    'running' | 'success' | 'failed' | 'budget-rejected'
    | 'repeat-blocked';

export interface ToolActivity {
    step: number;
    tool: string;
    target: string;
    status: ToolActivityStatus;
    reason?: string;
    requestBytesAdded?: number;
    hypotheticalRequestBytes?: number;
    // Modellschritt (0 = vorab gelesene Datei); nur Modellschritte zählen
    // zum Limit, mehrere Aufrufe einer Antwort teilen sich einen Schritt.
    round?: number;
    maxRounds?: number;
    requestedRange?: LineRange;
    deliveredRange?: LineRange | null;
}

export interface ConversationTurn {
    question: string;
    answer: string;
    evidence?: readonly ToolEvidence[];
    omitted?: number;
    toolDiagnostics?: readonly ToolRequestDiagnostic[];
}

export interface AgentResult {
    answer: string;
    evidence: ToolEvidence[];
    omitted: number;
    toolDiagnostics?: ToolRequestDiagnostic[];
}

export interface RequestSizeBreakdown {
    systemPromptBytes: number;
    historyBytes: number;
    questionBytes: number;
    agentStepBytes: number;
    toolResultBytes: number;
    toolDefinitionsBytes: number;
    requestEnvelopeBytes: number;
    totalBytes: number;
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
            if (
                (entry.tool === 'read_file'
                    || entry.tool === 'read_file_range')
                && entry.success
            ) {
                paths.add(entry.target);
            }
        }
    }

    return [...paths];
}

function requestedRangeFromArgs(
    toolName: string,
    args: Record<string, unknown>
): LineRange | undefined {
    const first = args.first_line;
    const last = args.last_line;

    return toolName === 'read_file_range'
        && typeof first === 'number' && Number.isSafeInteger(first)
        && typeof last === 'number' && Number.isSafeInteger(last)
        ? { firstLine: first, lastLine: last }
        : undefined;
}

// Liest nur die Zeilenzahlen aus dem Bereichsergebnis, nie den Text.
function deliveredRangeFromResult(
    content: string
): LineRange | null | undefined {
    try {
        const parsed = JSON.parse(content) as {
            readRange?: { firstLine?: unknown; lastLine?: unknown } | null;
        };
        const range = parsed.readRange;

        if (range === null) {
            return null;
        }
        if (
            range
            && typeof range.firstLine === 'number'
            && typeof range.lastLine === 'number'
        ) {
            return {
                firstLine: range.firstLine,
                lastLine: range.lastLine
            };
        }
    } catch {
        // Kein Bereichsergebnis (zum Beispiel ein Textfehler).
    }

    return undefined;
}

function formatLineRange(range: LineRange): string {
    return `${range.firstLine}-${range.lastLine}`;
}

// earlierTurns: Schritte vor dem protokollierten Schritt; nur Metadaten.
export function formatEvidence(
    evidence: readonly ToolEvidence[] | undefined,
    omitted = 0,
    earlierTurns: readonly ConversationTurn[] = [],
    toolDiagnostics: readonly ToolRequestDiagnostic[] = []
): string {
    const entries = evidence ?? [];
    const readOk = entries.some(
        e => (
            e.tool === 'read_file'
            || e.tool === 'read_file_range'
        ) && e.success
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

    if (toolDiagnostics.length > 0) {
        const blocked = toolDiagnostics
            .filter(d => d.outcome === 'repeat-blocked').length;
        const contextSearchesBlocked = toolDiagnostics
            .filter(d => d.outcome === 'context-search-blocked').length;
        lines.push(
            `Ausgeführte Lesezugriffe: ${entries.length + omitted}; `
            + `unterbundene Wiederholungen (nicht ausgeführt): ${blocked}.`
        );
        lines.push(
            'Unterbundene Suchen in vollständig gelesenen Dateien: '
            + `${contextSearchesBlocked}.`
        );
        const usedRounds = new Set(
            toolDiagnostics
                .map(d => d.round)
                .filter((r): r is number => typeof r === 'number' && r > 0)
        ).size;
        if (usedRounds > 0) {
            lines.push(
                'Zum Schrittlimit zählen Modellschritte, nicht einzelne '
                + `Aufrufe: ${usedRounds} von ${MAX_TOOL_ROUNDS} genutzt. `
                + 'Alle Aufrufe einer Modellantwort, auch unterbundene '
                + 'oder wegen Budget abgewiesene, gehören zu demselben '
                + 'Schritt; vorab gelesene Dateien zählen nicht.'
            );
        }
        lines.push('Requestgrößen je Werkzeugergebnis (ohne Inhalte):');
        lines.push(...toolDiagnostics.map(formatToolRequestDiagnostic));
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
    constructor(
        readonly bytes: number,
        readonly breakdown?: RequestSizeBreakdown,
        readonly toolResultCount = 0,
        readonly toolDiagnostics: readonly ToolRequestDiagnostic[] = [],
        diagnosticReason?: string
    ) {
        const diagnosticText = toolDiagnostics.length > 0
            ? [
                '',
                'Werkzeugdiagnose (ohne Dateiinhalte):',
                ...toolDiagnostics.map(formatToolRequestDiagnostic)
            ].join('\n')
            : '';
        super(
            requestTooLargeMessage(bytes)
            + (diagnosticReason ? ` ${diagnosticReason}` : '')
            + diagnosticText
        );
        this.name = 'RequestTooLargeError';
    }
}

function formatToolRequestDiagnostic(
    diagnostic: ToolRequestDiagnostic
): string {
    const delivery = diagnostic.outcome === 'included'
        ? 'Ergebnis an Ollama übermittelt'
        : diagnostic.outcome === 'not-executed'
            ? 'Werkzeug nicht ausgeführt'
            : diagnostic.outcome === 'repeat-blocked'
                ? 'Wiederholung nicht ausgeführt; Hinweis an Ollama übermittelt'
                : diagnostic.outcome === 'context-search-blocked'
                    ? 'Suche nicht ausgeführt; Kontext-Hinweis an Ollama übermittelt'
                : 'Ergebnis nicht an Ollama übermittelt';

    return (
        `- ${diagnostic.tool} ${diagnostic.target}: `
        + `${diagnostic.outcome}; ${delivery}; `
        + `zusätzliche Request-Bytes=${diagnostic.requestBytesAdded}; `
        + `hypothetische Gesamtgröße=${diagnostic.hypotheticalRequestBytes}`
        + (diagnostic.round !== undefined
            ? (diagnostic.round > 0
                ? `; Modellschritt=${diagnostic.round}/${MAX_TOOL_ROUNDS}`
                : '; vorab gelesen (zählt nicht zum Limit)')
            : '')
        + (diagnostic.requestedRange
            ? `; angefordert=${formatLineRange(diagnostic.requestedRange)}`
            : '')
        + (diagnostic.deliveredRange !== undefined
            ? `; geliefert=${diagnostic.deliveredRange
                ? formatLineRange(diagnostic.deliveredRange)
                : 'keine Zeilen'}`
            : '')
        + (diagnostic.reason ? `; Grund=${diagnostic.reason}` : '')
    );
}

function safeToolFailureReason(
    toolName: string,
    content: string
): string | undefined {
    if (toolName !== 'read_file_range') {
        return undefined;
    }

    if (content.includes('Zeilennummern müssen positive ganze Zahlen')) {
        return 'Zeilennummern müssen positive ganze Zahlen sein.';
    }
    if (content.includes('Die erste Zeile darf nicht nach der letzten Zeile')) {
        return 'Der Zeilenbereich ist ungültig: Anfang liegt nach dem Ende.';
    }
    if (content.includes('Der angeforderte Bereich umfasst mehr als')) {
        return 'Der angeforderte Bereich überschreitet das Zeilenlimit.';
    }
    if (content.includes('überschreitet das Bytebudget')) {
        return 'Der Bereich überschreitet das Ergebnis-Bytebudget.';
    }
    if (content.includes('ist gesperrt') || content.includes('ist nicht erlaubt')) {
        return 'Der Dateipfad ist gesperrt oder nicht erlaubt.';
    }
    if (content.includes('ist nicht als Textdatei freigegeben')) {
        return 'Der Dateityp ist nicht zum Lesen freigegeben.';
    }
    if (content.includes('Symbolische Links sind nicht erlaubt')) {
        return 'Der Pfad enthält einen nicht erlaubten symbolischen Link.';
    }
    if (content.includes('ist ein Ordner')) {
        return 'Der Pfad verweist auf einen Ordner statt auf eine Datei.';
    }
    if (content.includes('größer als das Leselimit')) {
        return 'Die Datei überschreitet das Größenlimit.';
    }
    if (content.includes('Binärdaten')) {
        return 'Die Datei scheint Binärdaten zu enthalten.';
    }

    return 'Der Dateibereich konnte nicht gelesen werden.';
}

export const REPEATED_CALL_NOTICE =
    'Dieses Ergebnis liegt bereits vor; der identische Aufruf wurde '
    + 'nicht erneut ausgeführt. Nutze das vorhandene Ergebnis oder '
    + 'wähle einen anderen relevanten Zugriff.';

// Höchstens so viele Wiederholungshinweise pro Aufgabe; danach Abbruch.
export const MAX_REPEAT_NOTICES = 2;

function fullFileContextSearchNotice(): string {
    return 'Der vollständige Inhalt der angefragten Datei liegt bereits '
        + 'im Kontext. Untersuche für unbelegte Teile der Frage andere '
        + 'relevante Dateien: Rufe search_text mit dem betreffenden '
        + 'Suchbegriff ohne include auf und prüfe danach einen '
        + 'relevanten Treffer mit read_file_range.';
}

function normalizeToolArgument(value: unknown): unknown {
    if (typeof value === 'string') {
        return value.trim().replace(/\\/g, '/');
    }

    if (Array.isArray(value)) {
        return value.map(normalizeToolArgument);
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, entry]) => [key, normalizeToolArgument(entry)])
        );
    }

    return value;
}

export function toolCallKey(
    toolName: string,
    args: Record<string, unknown>
): string {
    return `${toolName.trim()}\u0000${JSON.stringify(normalizeToolArgument(args))}`;
}

// Trägt nur Metadaten (keine Dateiinhalte).
export class AgentRepeatLoopError extends Error {
    constructor(
        readonly evidence: readonly ToolEvidence[],
        readonly omitted: number,
        readonly toolDiagnostics: readonly ToolRequestDiagnostic[],
        message =
            'Der Agent hat denselben Lesezugriff wiederholt angefordert, '
            + 'obwohl das Ergebnis bereits vorlag, und wurde nach '
            + `${MAX_REPEAT_NOTICES} Wiederholungshinweisen abgebrochen. `
            + 'Stelle die Frage konkreter oder nenne die relevante Datei.'
    ) {
        super(message);
        this.name = 'AgentRepeatLoopError';
    }
}

export const TOOL_RESULT_BUDGET_NOTICE =
    'Das Werkzeugergebnis wurde wegen des kumulativen '
    + '32.000-Byte-Requestbudgets nicht an Ollama übermittelt. '
    + 'Fordere als nächsten Leseversuch einen kleineren '
    + 'read_file_range-Bereich oder eine eng begrenzte search_text-Suche '
    + 'in derselben Datei an.';

export function requestTooLargeMessage(bytes: number): string {
    return (
        `Die Anfrage (${bytes} Bytes) überschreitet die konservative `
        + `Produktgrenze von ${MAX_REQUEST_BYTES} Bytes `
        + '(Systemtext, Gesprächsverlauf und Werkzeugergebnisse). '
        + 'Diese zu große Anfrage wurde nicht an Ollama gesendet und '
        + 'nicht stillschweigend gekürzt; '
        + 'weitere Werkzeugaufrufe wurden nicht ausgeführt. '
        + 'Die Byte-Grenze ist eine Vorsichtsmaßnahme, keine '
        + 'garantierte Token-Grenze und keine Garantie gegen '
        + 'Kontextkürzung.'
    );
}

function buildRequestBody(
    messages: OllamaMessage[],
    withTools = true
): string {
    return JSON.stringify({
        model: getOllamaModel(),
        stream: false,
        messages,
        ...(withTools ? { tools: getReadOnlyTools() } : {}),
        options: {
            temperature: 0.1,
            num_ctx: 16384
        }
    });
}

function assertWithinRequestLimit(
    body: string,
    messages: OllamaMessage[],
    questionMessageIndex: number
): void {
    const bytes = Buffer.byteLength(body, 'utf8');

    if (bytes > MAX_REQUEST_BYTES) {
        const breakdown = getRequestSizeBreakdown(
            body,
            messages,
            questionMessageIndex
        );
        const toolResultCount = messages
            .slice(questionMessageIndex + 1)
            .filter(message => message.role === 'tool')
            .length;
        throw new RequestTooLargeError(
            bytes, breakdown, toolResultCount
        );
    }
}

function getRequestSizeBreakdown(
    body: string,
    messages: OllamaMessage[],
    questionMessageIndex: number
): RequestSizeBreakdown {
    const messageBytes = (message: OllamaMessage) =>
        Buffer.byteLength(JSON.stringify(message), 'utf8');
    const systemPromptBytes = messageBytes(messages[0]);
    const historyBytes = messages
        .slice(1, questionMessageIndex)
        .reduce((total, message) => total + messageBytes(message), 0);
    const questionBytes = messageBytes(messages[questionMessageIndex]);
    const subsequentMessages = messages.slice(questionMessageIndex + 1);
    const toolResultBytes = subsequentMessages
        .filter(message => message.role === 'tool')
        .reduce((total, message) => total + messageBytes(message), 0);
    const agentStepBytes = subsequentMessages
        .filter(message => message.role !== 'tool')
        .reduce((total, message) => total + messageBytes(message), 0);
    const toolDefinitionsBytes = Buffer.byteLength(
        JSON.stringify(getReadOnlyTools()),
        'utf8'
    );
    const categorizedBytes = systemPromptBytes
        + historyBytes
        + questionBytes
        + agentStepBytes
        + toolResultBytes
        + toolDefinitionsBytes;
    const totalBytes = Buffer.byteLength(body, 'utf8');

    return {
        systemPromptBytes,
        historyBytes,
        questionBytes,
        agentStepBytes,
        toolResultBytes,
        toolDefinitionsBytes,
        requestEnvelopeBytes: totalBytes - categorizedBytes,
        totalBytes
    };
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

export function runReadOnlyAgent(
    ...args: Parameters<typeof runReadOnlyAgentUnlocked>
): ReturnType<typeof runReadOnlyAgentUnlocked> {
    return runExclusiveOperation(
        'Leseanalyse',
        () => runReadOnlyAgentUnlocked(...args)
    );
}

async function runReadOnlyAgentUnlocked(
    workspaceUri: vscode.Uri,
    userQuestion: string,
    onStatus?: (status: string) => void,
    history: readonly ConversationTurn[] = [],
    initialFiles: readonly string[] = [],
    signal?: AbortSignal,
    onToolActivity?: (activity: ToolActivity) => void,
    finalAnswer: FinalAnswerTexts = {}
): Promise<AgentResult> {
    const evidence: ToolEvidence[] = [];
    let totalToolCalls = 0;
    let activityStep = 0;
    let currentActivityStep = 0;
    let currentRound = 0;
    let currentActivityTool = '';
    let currentActivityArgs: Record<string, unknown> = {};

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
                    ? `${turn.answer}\n\n${formatEvidence(turn.evidence, turn.omitted, history.slice(0, index), turn.toolDiagnostics)}`
                    : turn.answer
            }
        ]),
        {
            role: 'user',
            content: userQuestion
        }
    ];
    const questionMessageIndex = 1 + history.length * 2;
    const toolDiagnostics: ToolRequestDiagnostic[] = [];
    let budgetRejection: {
        tool: string;
        requestBytesAdded: number;
        filePath?: string;
    } | undefined;
    let rangeRecoveryComplete = false;
    const executedCallKeys = new Set<string>();
    let blockedRepeats = 0;
    let blockedContextSearches = 0;
    const fullReadsAwaitingTransmission = new Set<string>();
    const fullReadsInContext = new Set<string>();
    const contextLedger = createContextLedger();

    const workspacePathKey = (relativePath: string): string =>
        process.platform === 'win32'
            ? relativePath.toLowerCase()
            : relativePath;

    const resolveWorkspaceRelativePath = (
        requestedPath: string
    ): string | undefined => {
        const pathCheck = checkWorkspacePath(
            workspaceUri,
            requestedPath
        );

        return pathCheck.allowed ? pathCheck.relativePath : undefined;
    };

    const annotate = (
        diagnostic: ToolRequestDiagnostic,
        toolName: string,
        args: Record<string, unknown>
    ): ToolRequestDiagnostic => {
        diagnostic.round = currentRound;
        const requested = requestedRangeFromArgs(toolName, args);
        if (requested) {
            diagnostic.requestedRange = requested;
        }
        return diagnostic;
    };

    const updateToolActivity = (
        step: number,
        toolName: string,
        args: Record<string, unknown>,
        status: ToolActivityStatus,
        reason?: string,
        diagnostic?: ToolRequestDiagnostic
    ): void => {
        const requestedRange = requestedRangeFromArgs(toolName, args);
        onToolActivity?.({
            step,
            tool: toolName,
            target: describeToolTarget(toolName, args),
            status,
            round: currentRound,
            maxRounds: MAX_TOOL_ROUNDS,
            ...(requestedRange ? { requestedRange } : {}),
            ...(diagnostic?.deliveredRange !== undefined
                ? { deliveredRange: diagnostic.deliveredRange }
                : {}),
            ...(reason ? { reason } : {}),
            ...(diagnostic ? {
                requestBytesAdded: diagnostic.requestBytesAdded,
                hypotheticalRequestBytes: diagnostic.hypotheticalRequestBytes
            } : {})
        });
    };

    const beginToolActivity = (
        toolName: string,
        args: Record<string, unknown>
    ): number => {
        currentActivityStep = ++activityStep;
        currentActivityTool = toolName;
        currentActivityArgs = args;
        updateToolActivity(
            currentActivityStep,
            toolName,
            args,
            'running'
        );
        return currentActivityStep;
    };

    const finishToolActivityFromDiagnostic = (
        toolName: string,
        args: Record<string, unknown>,
        diagnostic: ToolRequestDiagnostic
    ): void => {
        const status: ToolActivityStatus =
            diagnostic.outcome === 'repeat-blocked'
                || diagnostic.outcome === 'context-search-blocked'
                ? 'repeat-blocked'
                : diagnostic.outcome === 'budget-rejected'
                    || diagnostic.outcome === 'not-executed'
                    || diagnostic.outcome === 'aborted'
                    ? 'budget-rejected'
                    : 'failed';
        updateToolActivity(
            currentActivityStep,
            toolName,
            args,
            status,
            status === 'repeat-blocked'
                ? 'Wiederholung unterbunden.'
                : status === 'budget-rejected'
                    ? 'Werkzeugergebnis wegen des Anfragebudgets nicht übermittelt.'
                    : undefined,
            diagnostic
        );
    };

    const makeToolMessage = (
        toolName: string,
        result: ToolResult
    ): OllamaMessage => ({
        role: 'tool',
        tool_name: toolName,
        content: JSON.stringify({
            success: result.success,
            content: result.content
        })
    });

    const requestSizeWith = (message: OllamaMessage) => {
        const candidateMessages = [...messages, message];
        const body = buildRequestBody(candidateMessages);
        return {
            body,
            messages: candidateMessages,
            bytes: Buffer.byteLength(body, 'utf8')
        };
    };

    const throwForToolBudget = (
        body: string,
        candidateMessages: OllamaMessage[],
        diagnostic: ToolRequestDiagnostic,
        reason: string
    ): never => {
        finishToolActivityFromDiagnostic(
            currentActivityTool,
            currentActivityArgs,
            diagnostic
        );
        const diagnostics = [...toolDiagnostics, diagnostic];
        const toolResultCount = messages
            .slice(questionMessageIndex + 1)
            .filter(message => message.role === 'tool')
            .length;
        throw new RequestTooLargeError(
            Buffer.byteLength(body, 'utf8'),
            getRequestSizeBreakdown(
                body,
                candidateMessages,
                questionMessageIndex
            ),
            toolResultCount,
            diagnostics,
            reason
        );
    };

    const executeAndAppendTool = async (
        toolName: string,
        args: Record<string, unknown>
    ): Promise<{ result: ToolResult; forwarded: boolean }> => {
        const target = describeToolTarget(toolName, args);
        const diagnosticTool = toolName
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80);
        const baselineBody = buildRequestBody(messages);
        const baselineBytes = Buffer.byteLength(baselineBody, 'utf8');
        const noticeMessage = makeToolMessage(toolName, {
            success: false,
            content: TOOL_RESULT_BUDGET_NOTICE
        });
        const noticeRequest = requestSizeWith(noticeMessage);
        const noticeBytesAdded = noticeRequest.bytes - baselineBytes;

        if (noticeRequest.bytes > MAX_REQUEST_BYTES) {
            throwForToolBudget(
                noticeRequest.body,
                noticeRequest.messages,
                annotate({
                    tool: diagnosticTool,
                    target,
                    requestBytesAdded: noticeBytesAdded,
                    hypotheticalRequestBytes: noticeRequest.bytes,
                    outcome: 'not-executed'
                }, toolName, args),
                'Schon der kurze Ablehnungshinweis passt nicht in die '
                + '32.000-Byte-Grenze; das Werkzeug wurde nicht ausgeführt.'
            );
        }

        const recoverySearchPath = toolName === 'search_text'
            ? resolveWorkspaceRelativePath(
                getStringArgument(args, 'include')
            )
            : undefined;
        const isScopedSearchRecovery = budgetRejection?.tool === 'read_file'
            && budgetRejection.filePath !== undefined
            && recoverySearchPath !== undefined
            && workspacePathKey(recoverySearchPath)
                === budgetRejection.filePath;

        if (
            budgetRejection
            && !rangeRecoveryComplete
            && toolName !== 'read_file_range'
            && !isScopedSearchRecovery
        ) {
            throwForToolBudget(
                noticeRequest.body,
                noticeRequest.messages,
                annotate({
                    tool: diagnosticTool,
                    target,
                    requestBytesAdded: noticeBytesAdded,
                    hypotheticalRequestBytes: noticeRequest.bytes,
                    outcome: 'not-executed'
                }, toolName, args),
                'Nach einer Budgetablehnung ist als nächster Leseversuch '
                + 'nur ein kleinerer read_file_range oder eine eng '
                + 'begrenzte search_text-Suche in derselben abgewiesenen '
                + 'Datei erlaubt.'
            );
        }

        if (
            budgetRejection
            && !rangeRecoveryComplete
            && toolName === 'read_file_range'
        ) {
            const firstLine = args.first_line;
            const lastLine = args.last_line;
            const rangeIsValid =
                typeof firstLine === 'number'
                && Number.isSafeInteger(firstLine)
                && typeof lastLine === 'number'
                && Number.isSafeInteger(lastLine)
                && firstLine >= 1
                && lastLine >= firstLine
                && lastLine - firstLine + 1 <= MAX_RANGE_LINES;

            if (!rangeIsValid) {
                throwForToolBudget(
                    noticeRequest.body,
                    noticeRequest.messages,
                    annotate({
                        tool: diagnosticTool,
                        target,
                        requestBytesAdded: noticeBytesAdded,
                        hypotheticalRequestBytes: noticeRequest.bytes,
                        outcome: 'not-executed'
                    }, toolName, args),
                    'Der Folgeversuch muss ein gültiger kleinerer '
                    + `read_file_range-Bereich mit höchstens ${MAX_RANGE_LINES} `
                    + 'Zeilen sein.'
                );
            }
        }

        onStatus?.(`Lesewerkzeug: ${toolName}`);
        let result: ToolResult;
        try {
            result = await executeReadTool(
                workspaceUri,
                toolName,
                args
            );
        } catch (error) {
            updateToolActivity(
                currentActivityStep,
                toolName,
                args,
                'failed',
                'Werkzeug konnte nicht ausgeführt werden.'
            );
            throw error;
        }
        totalToolCalls += 1;

        const actualMessage = makeToolMessage(toolName, result);
        const actualRequest = requestSizeWith(actualMessage);
        const actualBytesAdded = actualRequest.bytes - baselineBytes;
        const actualDiagnostic: ToolRequestDiagnostic = annotate({
            tool: diagnosticTool,
            target,
            requestBytesAdded: actualBytesAdded,
            hypotheticalRequestBytes: actualRequest.bytes,
            outcome: 'included'
        }, toolName, args);
        if (toolName === 'read_file_range') {
            const delivered = deliveredRangeFromResult(result.content);
            if (delivered !== undefined) {
                actualDiagnostic.deliveredRange = delivered;
            } else if (!result.success) {
                actualDiagnostic.deliveredRange = null;
            }
            const failureReason = result.success
                ? undefined
                : safeToolFailureReason(toolName, result.content);
            if (failureReason) {
                actualDiagnostic.reason = failureReason;
            }
        }

        if (actualRequest.bytes <= MAX_REQUEST_BYTES) {
            if (
                budgetRejection
                && !rangeRecoveryComplete
                && actualBytesAdded >= budgetRejection.requestBytesAdded
            ) {
                actualDiagnostic.outcome = 'aborted';
                throwForToolBudget(
                    actualRequest.body,
                    actualRequest.messages,
                    actualDiagnostic,
                    'Der read_file_range-Folgeversuch war nicht kleiner '
                    + 'als das zuvor abgelehnte Ergebnis; der Inhalt wurde '
                    + 'nicht an Ollama übermittelt und der Lauf abgebrochen.'
                );
            }

            messages.push(actualMessage);
            toolDiagnostics.push(actualDiagnostic);
            recordForwardedResult(
                contextLedger,
                toolName,
                args,
                result.success,
                result.content
            );
            if (toolName === 'read_file' && result.success) {
                const relativePath = resolveWorkspaceRelativePath(
                    getStringArgument(args, 'path')
                );
                if (relativePath) {
                    fullReadsAwaitingTransmission.add(
                        workspacePathKey(relativePath)
                    );
                }
            }
            updateToolActivity(
                currentActivityStep,
                toolName,
                args,
                result.success ? 'success' : 'failed',
                result.success
                    ? undefined
                    : safeToolFailureReason(toolName, result.content),
                actualDiagnostic
            );
            if (budgetRejection && !rangeRecoveryComplete) {
                rangeRecoveryComplete = true;
            }
            if (evidence.length < MAX_EVIDENCE_ENTRIES) {
                evidence.push({
                    tool: diagnosticTool,
                    target,
                    success: result.success
                });
            }
            return { result, forwarded: true };
        }

        if (budgetRejection) {
            actualDiagnostic.outcome = 'aborted';
            throwForToolBudget(
                actualRequest.body,
                actualRequest.messages,
                actualDiagnostic,
                'Ein weiteres zu großes Ergebnis kann nach der bereits '
                + 'verwendeten Budgetablehnung nicht erneut ersetzt werden. '
                + 'Dieses Ergebnis wurde nicht an Ollama übermittelt.'
            );
        }

        const rejectionMessage = makeToolMessage(toolName, {
            success: false,
            content: TOOL_RESULT_BUDGET_NOTICE
        });
        const rejectionRequest = requestSizeWith(rejectionMessage);

        if (rejectionRequest.bytes > MAX_REQUEST_BYTES) {
            actualDiagnostic.outcome = 'aborted';
            throwForToolBudget(
                actualRequest.body,
                actualRequest.messages,
                actualDiagnostic,
                'Das Ergebnis überschreitet die Grenze und selbst der '
                + 'vorab reservierte Ablehnungshinweis passt nicht mehr; '
                + 'das Ergebnis wurde nicht an Ollama übermittelt.'
            );
        }

        actualDiagnostic.outcome = 'budget-rejected';
        recordRejected(contextLedger, target);
        toolDiagnostics.push(actualDiagnostic);
        messages.push(rejectionMessage);
        updateToolActivity(
            currentActivityStep,
            toolName,
            args,
            'budget-rejected',
            'Ergebnis überschreitet das Anfragebudget; ein Hinweis wurde übermittelt.',
            actualDiagnostic
        );
        const rejectedReadPath = toolName === 'read_file'
            ? resolveWorkspaceRelativePath(
                getStringArgument(args, 'path')
            )
            : undefined;
        budgetRejection = {
            tool: diagnosticTool,
            requestBytesAdded: actualBytesAdded,
            ...(rejectedReadPath
                ? { filePath: workspacePathKey(rejectedReadPath) }
                : {})
        };
        if (evidence.length < MAX_EVIDENCE_ENTRIES) {
            evidence.push({
                tool: toolName,
                target,
                success: false
            });
        }
        return {
            result: {
                success: false,
                content: TOOL_RESULT_BUDGET_NOTICE
            },
            forwarded: false
        };
    };

    const blockRepeatedCall = (
        toolName: string,
        args: Record<string, unknown>
    ): void => {
        const target = describeToolTarget(toolName, args);
        const diagnosticTool = toolName
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80);
        const baselineBytes = Buffer.byteLength(
            buildRequestBody(messages),
            'utf8'
        );
        const noticeRequest = requestSizeWith(makeToolMessage(toolName, {
            success: false,
            content: REPEATED_CALL_NOTICE
        }));
        const diagnostic: ToolRequestDiagnostic = annotate({
            tool: diagnosticTool,
            target,
            requestBytesAdded: noticeRequest.bytes - baselineBytes,
            hypotheticalRequestBytes: noticeRequest.bytes,
            outcome: 'repeat-blocked'
        }, toolName, args);

        if (blockedRepeats >= MAX_REPEAT_NOTICES) {
            diagnostic.outcome = 'aborted';
            updateToolActivity(
                currentActivityStep,
                toolName,
                args,
                'repeat-blocked',
                'Wiederholung unterbunden; das Hinweislimit ist erreicht.',
                diagnostic
            );
            throw new AgentRepeatLoopError(
                evidence.slice(),
                totalToolCalls - evidence.length,
                [...toolDiagnostics, diagnostic]
            );
        }

        if (noticeRequest.bytes > MAX_REQUEST_BYTES) {
            diagnostic.outcome = 'not-executed';
            throwForToolBudget(
                noticeRequest.body,
                noticeRequest.messages,
                diagnostic,
                'Auch der Hinweis auf den wiederholten Aufruf passt nicht '
                + 'mehr in die 32.000-Byte-Grenze.'
            );
        }

        blockedRepeats += 1;
        toolDiagnostics.push(diagnostic);
        messages.push(noticeRequest.messages[noticeRequest.messages.length - 1]);
        updateToolActivity(
            currentActivityStep,
            toolName,
            args,
            'repeat-blocked',
            'Identische Wiederholung unterbunden.',
            diagnostic
        );
    };

    const blockSearchInFullReadFile = (
        args: Record<string, unknown>
    ): void => {
        const target = describeToolTarget('search_text', args);
        const baselineBytes = Buffer.byteLength(
            buildRequestBody(messages),
            'utf8'
        );
        const noticeRequest = requestSizeWith(makeToolMessage(
            'search_text',
            {
                success: false,
                content:                 fullFileContextSearchNotice()
            }
        ));
        const diagnostic: ToolRequestDiagnostic = annotate({
            tool: 'search_text',
            target,
            requestBytesAdded: noticeRequest.bytes - baselineBytes,
            hypotheticalRequestBytes: noticeRequest.bytes,
            outcome: 'context-search-blocked'
        }, 'search_text', args);

        if (blockedContextSearches >= MAX_REPEAT_NOTICES) {
            diagnostic.outcome = 'aborted';
            updateToolActivity(
                currentActivityStep,
                'search_text',
                args,
                'repeat-blocked',
                'Suche in bereits vollständig gelesener Datei unterbunden; das Hinweislimit ist erreicht.',
                diagnostic
            );
            throw new AgentRepeatLoopError(
                evidence.slice(),
                totalToolCalls - evidence.length,
                [...toolDiagnostics, diagnostic],
                'Der Agent hat wiederholt eine Datei durchsucht, deren '
                + 'vollständiger Inhalt bereits im Kontext lag, und wurde '
                + `nach ${MAX_REPEAT_NOTICES} Hinweisen abgebrochen. `
                + 'Untersuche andere relevante Dateien.'
            );
        }

        if (noticeRequest.bytes > MAX_REQUEST_BYTES) {
            diagnostic.outcome = 'not-executed';
            throwForToolBudget(
                noticeRequest.body,
                noticeRequest.messages,
                diagnostic,
                'Der Hinweis auf den bereits im Kontext liegenden '
                + 'Dateiinhalt passt nicht in die 32.000-Byte-Grenze; '
                + 'die Suche wurde nicht ausgeführt.'
            );
        }

        blockedContextSearches += 1;
        toolDiagnostics.push(diagnostic);
        messages.push(noticeRequest.messages[noticeRequest.messages.length - 1]);
        updateToolActivity(
            currentActivityStep,
            'search_text',
            args,
            'repeat-blocked',
            'Suche in bereits vollständig gelesener Datei unterbunden.',
            diagnostic
        );
    };

    // Liegt schon die Dateigröße (untere Schranke des Ergebnisses) über dem
    // Requestbudget, wird kein read_file-Vorabinhalt angefordert. Die Datei
    // gilt weder als gelesen noch wird sie gekürzt; das Modell erhält nur
    // den Pfad und wählt selbst search_text/read_file_range.
    const exceedsRequestBudgetWhole = async (
        filePath: string
    ): Promise<boolean> => {
        const relativePath = resolveWorkspaceRelativePath(filePath);
        if (!relativePath) {
            return false;
        }
        let size: number;
        try {
            size = (await vscode.workspace.fs.stat(
                vscode.Uri.joinPath(workspaceUri, relativePath)
            )).size;
        } catch {
            return false;
        }
        if (size > MAX_REQUEST_BYTES) {
            return true;
        }
        return requestSizeWith(makeToolMessage('read_file', {
            success: true,
            content: 'x'.repeat(size)
        })).bytes > MAX_REQUEST_BYTES;
    };

    for (const filePath of initialFiles) {
        if (await exceedsRequestBudgetWhole(filePath)) {
            messages.push({
                role: 'user',
                content: `Hinweis: Die ausdrücklich genannte Datei ${filePath} `
                    + 'ist zu groß für das 32.000-Byte-Requestbudget und '
                    + 'wurde nicht gelesen oder übermittelt. Nutze '
                    + 'search_text mit include auf diese Datei und kleine '
                    + 'read_file_range-Bereiche.'
            });
            assertWithinRequestLimit(
                buildRequestBody(messages),
                messages,
                questionMessageIndex
            );
            continue;
        }
        beginToolActivity('read_file', { path: filePath });
        messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [{
                function: {
                    name: 'read_file',
                    arguments: { path: filePath }
                }
            }]
        });

        const { result, forwarded } = await executeAndAppendTool(
            'read_file',
            { path: filePath }
        );

        // Lesefehler zuerst zurückgeben: es folgt kein Ollama-Aufruf, die
        // Größenprüfung gilt nur für die nächste Anfrage.
        if (!result.success && forwarded) {
            return {
                answer: '',
                evidence: evidence.slice(),
                omitted: totalToolCalls - evidence.length,
                toolDiagnostics: toolDiagnostics.slice()
            };
        }

        assertWithinRequestLimit(
            buildRequestBody(messages),
            messages,
            questionMessageIndex
        );
    }

    for (
        let round = 1;
        round <= MAX_TOOL_ROUNDS;
        round += 1
    ) {
        onStatus?.(
            `Agent arbeitet, Schritt ${round} `
            + `von ${MAX_TOOL_ROUNDS} ...`
        );

        throwIfCancelled(signal);
        currentRound = round;

        const statusText = formatContextStatus(
            contextLedger, round, MAX_TOOL_ROUNDS
        );
        let requestMessages = messages;
        if (statusText) {
            const withStatus: OllamaMessage[] = [
                ...messages,
                { role: 'user', content: statusText }
            ];
            // Die Übersicht zählt zum Requestbudget; passt sie nicht, entfällt
            // nur sie, nie vorhandene Inhalte.
            if (
                new TextEncoder().encode(buildRequestBody(withStatus)).length
                <= MAX_REQUEST_BYTES
            ) {
                requestMessages = withStatus;
            }
        }

        const response = await callOllama(
            requestMessages, questionMessageIndex, signal
        );
        for (const relativePath of fullReadsAwaitingTransmission) {
            fullReadsInContext.add(workspacePathKey(relativePath));
        }
        fullReadsAwaitingTransmission.clear();

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
                omitted: totalToolCalls - evidence.length,
                toolDiagnostics: toolDiagnostics.slice()
            };
        }

        for (const toolCall of toolCalls) {
            const toolName =
                toolCall.function?.name ?? '';

            const argumentsValue =
                toolCall.function?.arguments ?? {};

            throwIfCancelled(signal);

            beginToolActivity(toolName, argumentsValue);
            const callKey = toolCallKey(toolName, argumentsValue);

            const searchPath = toolName === 'search_text'
                ? resolveWorkspaceRelativePath(
                    getStringArgument(argumentsValue, 'include', '**/*')
                )
                : undefined;

            if (
                searchPath
                && fullReadsInContext.has(workspacePathKey(searchPath))
            ) {
                blockSearchInFullReadFile(argumentsValue);
            } else if (executedCallKeys.has(callKey)) {
                blockRepeatedCall(toolName, argumentsValue);
            } else {
                await executeAndAppendTool(
                    toolName,
                    argumentsValue
                );
                executedCallKeys.add(callKey);
            }

            // Nach jedem Ergebnis prüfen: bei Überschreitung weder weitere
            // Werkzeuge noch Ollama aufrufen.
            assertWithinRequestLimit(
                buildRequestBody(messages),
                messages,
                questionMessageIndex
            );
        }
    }

    // Limit erreicht: keine Werkzeuge mehr. Die Ergebnisse der letzten
    // Runde wurden noch nie an das Modell übermittelt; eine Abschlussantwort
    // ohne Werkzeuge ist nur innerhalb des bestehenden Requestbudgets erlaubt.
    throwIfCancelled(signal);

    const finalRequest = prepareFinalAnswerRequest(
        messages, finalAnswer.request
    );
    const finalMessages = finalRequest.messages;
    const finalBytes = finalRequest.bytes;
    const limitError = (reason: string): AgentStepLimitError =>
        new AgentStepLimitError(
            evidence.slice(),
            totalToolCalls - evidence.length,
            toolDiagnostics.slice(),
            reason
        );

    if (!finalRequest.allowed) {
        throw limitError(
            `Eine abschließende Antwort aus den vorhandenen Belegen wäre `
            + `mit ${finalBytes} Bytes größer als die Produktgrenze von `
            + `${MAX_REQUEST_BYTES} Bytes und wurde nicht angefordert.`
        );
    }

    onStatus?.('Limit erreicht: Abschlussantwort ohne weitere Werkzeuge ...');
    const finalResponse = await callOllama(
        finalMessages, questionMessageIndex, signal, false
    );
    const finalMessage = finalResponse.message;
    const finalText = finalMessage?.content?.trim();

    if (!finalText || (finalMessage?.tool_calls ?? []).length > 0) {
        throw limitError(
            'Eine abschließende Antwort ohne weitere Werkzeuge wurde '
            + 'nicht geliefert.'
        );
    }

    return {
        answer: (finalAnswer.notice ?? FINAL_ANSWER_NOTICE) + finalText,
        evidence: evidence.slice(),
        omitted: totalToolCalls - evidence.length,
        toolDiagnostics: toolDiagnostics.slice()
    };
}

// Baut die werkzeuglose Abschlussanfrage und prüft das Requestbudget;
// bei Überschreitung wird nichts gekürzt, sondern nicht angefragt.
export function prepareFinalAnswerRequest(
    messages: readonly OllamaMessage[],
    requestText: string = FINAL_ANSWER_REQUEST
): { messages: OllamaMessage[]; bytes: number; allowed: boolean } {
    const finalMessages: OllamaMessage[] = [
        ...messages,
        { role: 'user', content: requestText }
    ];
    const bytes = Buffer.byteLength(
        buildRequestBody(finalMessages, false),
        'utf8'
    );

    return {
        messages: finalMessages,
        bytes,
        allowed: bytes <= MAX_REQUEST_BYTES
    };
}

// Optional: aufgabenspezifische Abschlussanfrage (z. B. Planungsmodus).
export interface FinalAnswerTexts {
    request?: string;
    notice?: string;
}

const FINAL_ANSWER_REQUEST =
    'Das Limit von acht Modellschritten ist erreicht; es werden keine '
    + 'Werkzeuge mehr ausgeführt. Antworte jetzt knapp auf Deutsch '
    + 'ausschließlich aus den bereits übermittelten Werkzeugergebnissen. '
    + 'Gliedere in „Belegt:“ (nur was in den Ergebnissen steht) und '
    + '„Unklar:“ (was die Ergebnisse nicht belegen). Stelle nichts als '
    + 'gesichert dar, was nicht belegt ist, und erfinde keine '
    + 'Dateiinhalte. Nenne, dass keine weitere Recherche stattfand. '
    + 'Rufe keine Werkzeuge auf.';

export const FINAL_ANSWER_NOTICE =
    'Hinweis: Das Limit von acht Modellschritten wurde erreicht. Diese '
    + 'Antwort beruht nur auf den bis dahin übermittelten Belegen; es '
    + 'fand keine weitere Recherche statt und sie kann unvollständig '
    + 'sein.\n\n';

// Trägt nur Metadaten (keine Dateiinhalte), damit das Protokoll sichtbar bleibt.
export class AgentStepLimitError extends Error {
    constructor(
        readonly evidence: readonly ToolEvidence[],
        readonly omitted: number,
        readonly toolDiagnostics: readonly ToolRequestDiagnostic[],
        reason?: string
    ) {
        super(
            'Der Agent hat das maximale Limit '
            + 'von acht Modellschritten erreicht.'
            + (reason ? ` ${reason}` : '')
        );
        this.name = 'AgentStepLimitError';
    }
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

        case 'read_file_range':
            return readProjectFileRange(
                workspaceUri,
                getStringArgument(args, 'path'),
                args.first_line,
                args.last_line
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
            + 'Behaupte nicht, eine Datei gelesen zu haben, wenn dort '
            + 'kein erfolgreiches read_file oder read_file_range steht.',
        '- Verwende Werkzeuge nur, wenn sie nötig sind.',
        '- Antworte auf Deutsch.',
        '',
        'Verfügbare Werkzeuge:',
        '- list_directory: Ordnerinhalt auflisten, nur wenn noch kein '
            + 'geeigneter Dateipfad bekannt ist',
        '- read_file: eine erlaubte Textdatei vollständig lesen; für '
            + 'kleine, bereits gezielt gewählte Dateien',
        '- read_file_range: einen begrenzten Zeilenbereich lesen; nach '
            + 'search_text bevorzugt den relevanten Trefferbereich lesen '
            + 'und große Dateien nicht automatisch vollständig anfordern',
        '- search_text: Text im Projekt suchen; Treffer nennen Pfad und '
            + 'Zeilennummer',
        '- Liefert search_text bereits einen geeigneten Dateipfad, '
            + 'liste nicht zuerst den Ordner auf. Prüfe stattdessen '
            + 'die Stelle mit read_file_range rund um die Trefferzeile '
            + 'und lies bei möglicherweise großen Dateien nicht vorsorglich '
            + 'die ganze Datei.',
        '- Wähle den Bereich so klein wie für die Frage nötig. Die '
            + 'Höchstgrenze an Zeilen ist kein Richtwert; das '
            + 'Ergebnis-Bytebudget gilt weiterhin.',
        '- Lies nicht systematisch kleine Nachbarbereiche nacheinander: '
            + 'Wähle stattdessen einen ausreichend großen zusammenhängenden '
            + 'Bereich, der noch in das Ergebnis-Bytebudget passt. Bereits '
            + 'gelieferte Zeilen (siehe readRange im Werkzeugergebnis) '
            + 'fordere nicht erneut an; bei Überlappung zählen nur die '
            + 'neuen Zeilen als neuer Beleg. Ein angrenzender, noch nicht '
            + 'gelesener Bereich bleibt erlaubt, wenn er wirklich fehlt.',
        '- Antworte, sobald die vorhandenen Belege ausreichen. Rufe '
            + 'nicht nur deshalb weitere Werkzeuge auf, weil noch '
            + 'Modellschritte verfügbar sind.',
        '- Wenn search_text wegen einer bereits vollständig gelesenen '
            + 'Datei unterbleibt, folge dem Werkzeughinweis: Rufe '
            + 'search_text mit dem Suchbegriff ohne include auf und '
            + 'prüfe danach einen relevanten Treffer mit read_file_range.',
        '',
        'Wenn die Belege für die Antwort noch fehlen, '
            + 'verwende zuerst ein Lesewerkzeug.',
        '',
        'Projektregeln:',
        '',
        rules.join('\n\n---\n\n')
    ].join('\n');
}

export class AgentCancelledError extends Error {
    constructor() {
        super('Die Analyse wurde abgebrochen.');
        this.name = 'AgentCancelledError';
    }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw new AgentCancelledError();
    }
}

async function callOllama(
    messages: OllamaMessage[],
    questionMessageIndex: number,
    signal?: AbortSignal,
    withTools = true
): Promise<OllamaResponse> {
    const body = buildRequestBody(messages, withTools);

    assertWithinRequestLimit(
        body,
        messages,
        questionMessageIndex
    );

    const controller = new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        180_000
    );
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);

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
        if (signal?.aborted) {
            throw new AgentCancelledError();
        }

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
        signal?.removeEventListener('abort', onAbort);
    }
}

export function getReadOnlyTools(): object[] {
    return [
        {
            type: 'function',
            function: {
                name: 'list_directory',
                description:
                    'Listet den Inhalt eines erlaubten '
                    + 'Ordners im Projekt auf. Nicht als Zwischenschritt '
                    + 'verwenden, wenn search_text bereits einen '
                    + 'geeigneten Dateipfad geliefert hat.',
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
                    + 'vollständig aus dem Projekt. Bei möglicherweise '
                    + 'großen Dateien oder wenn search_text Treffer mit '
                    + 'Zeilennummern geliefert hat, stattdessen '
                    + 'read_file_range verwenden.',
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
                name: 'read_file_range',
                description:
                    'Liest einen begrenzten Zeilenbereich einer erlaubten '
                    + 'Textdatei. Nach search_text bevorzugt den kleinen '
                    + 'relevanten Bereich lesen, statt eine große Datei '
                    + 'vollständig anzufordern; nutze dafür Pfad und '
                    + 'Zeilennummer des Treffers und wähle den Bereich '
                    + 'so klein wie nötig. Zeilen sind 1-basiert und '
                    + 'beide Grenzen inklusiv; höchstens '
                    + `${MAX_RANGE_LINES} Zeilen und `
                    + `${MAX_RANGE_RESULT_BYTES} UTF-8-Bytes Ergebnis. `
                    + `Ein Bereich mit ${MAX_RANGE_LINES} Zeilen kann das `
                    + 'Bytebudget überschreiten. Lies nicht mehrere kleine '
                    + 'Nachbarbereiche nacheinander, sondern wähle einen '
                    + 'zusammenhängenden Bereich, der ins Bytebudget passt. '
                    + 'Bereits gelieferte Zeilen (readRange im Ergebnis) '
                    + 'nicht erneut anfordern; Überlappungen sind kein '
                    + 'neuer Beleg.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description:
                                'Relativer Dateipfad im Workspace'
                        },
                        first_line: {
                            type: 'integer',
                            minimum: 1,
                            description:
                                'Erste Zeile, 1-basiert und einschließlich'
                        },
                        last_line: {
                            type: 'integer',
                            minimum: 1,
                            description:
                                'Letzte Zeile, 1-basiert und einschließlich'
                        }
                    },
                    required: ['path', 'first_line', 'last_line']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'search_text',
                description:
                    'Sucht einen Text in erlaubten '
                    + 'Projektdateien und liefert je Treffer Pfad und '
                    + 'Zeilennummer. Ein Suchtreffer belegt '
                    + 'nur seine jeweilige Zeile. Treffer zu '
                    + 'verschiedenen Variablen oder Sachverhalten '
                    + 'dürfen nicht ohne weiteren Kontext '
                    + 'gleichgesetzt werden. Wenn ein Werkzeughinweis '
                    + 'meldet, dass die Datei bereits vollständig im '
                    + 'Kontext liegt, rufe search_text mit dem '
                    + 'Suchbegriff ohne include auf und prüfe einen '
                    + 'relevanten Treffer mit read_file_range. Liefert '
                    + 'ein Treffer bereits einen geeigneten Dateipfad, '
                    + 'prüfe ihn direkt mit read_file_range, ohne '
                    + 'zuerst den Ordner aufzulisten.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description:
                                'Gesuchter Text, wörtlich und ohne '
                                + 'Beachtung der Groß-/Kleinschreibung '
                                + 'gesucht. Kein regulärer Ausdruck: "|" '
                                + 'verbindet keine Alternativen und Regex-'
                                + 'Syntax wird nicht interpretiert. Nutze '
                                + 'einen konkreten Suchbegriff pro Aufruf; '
                                + 'emittedHitCount im Ergebnis nennt die '
                                + 'Trefferzahl.'
                        },
                        include: {
                            type: 'string',
                            description:
                                'Optionales Dateimuster, '
                                + 'zum Beispiel **/*.js. Nennt der '
                                + 'Nutzer eine konkrete Datei, '
                                + 'verwende deren exakten relativen '
                                + 'Pfad, zum Beispiel '
                                + 'src/extension.ts, statt eines '
                                + 'breiten Musters wie **/*.md. Wenn '
                                + 'der Werkzeughinweis meldet, dass '
                                + 'diese Datei bereits vollständig im '
                                + 'Kontext liegt, lasse include weg, '
                                + 'auch wenn der Nutzer sie genannt hat.'
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