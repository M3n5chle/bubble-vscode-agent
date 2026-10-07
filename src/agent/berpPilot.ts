import * as vscode from 'vscode';
import { runExclusiveOperation } from './operationLock.js';
import { checkNoSymlinkInPath } from '../safety/pathPolicy.js';
import {
    readProjectFileRange,
    searchProjectText,
    type ToolResult
} from '../tools/readTools.js';
import {
    BERP_MICRO_MAP,
    BERP_PILOT_TASK,
    InvalidResearchContractError,
    isRecord,
    parseResearchContract,
    validateResearchContract
} from './berpContract.js';
import {
    createReadOnlyPromptContext,
    formatEvidence,
    MAX_REQUEST_BYTES,
    measureReadOnlyPromptRequest,
    RequestTooLargeError,
    runReadOnlyPrompt,
    type LineRange,
    type ReadOnlyPromptContext,
    type ToolEvidence
} from './readOnlyAgent.js';
import { buildPlanPrompt, formatPlanResponse } from './planChange.js';

export {
    BERP_MICRO_MAP,
    BERP_PILOT_TASK,
    parseResearchContract,
    validateResearchContract,
    type ResearchContract,
    type ResearchNeed
} from './berpContract.js';

export interface BerpEvidencePacket {
    originalTask: string;
    microMap: typeof BERP_MICRO_MAP;
    readEvidence: Array<{
        path: string;
        range: LineRange;
        codeExcerpt: string;
        origin: {
            question: string;
            searchTerm: string;
            hitLine: number;
        };
    }>;
    openNeeds: Array<{
        question: string;
        targetFile: string;
        searchTerm: string;
        reason: string;
    }>;
    planRequestUtf8Bytes: number;
}

export interface BerpPilotResult {
    answer: string;
    // Kurzfassung: Lesebelege und Gründe für offene Bedürfnisse.
    summary: string;
    evidence: ToolEvidence[];
    packet: BerpEvidencePacket;
    // Größe der gesamten Plananfrage (nicht nur des Packets); 0, wenn
    // keine Plananfrage gesendet wurde.
    planRequestBytes: number;
    planRequested: boolean;
}

export function summarizeBerpOutcome(packet: BerpEvidencePacket): string {
    const read = packet.readEvidence.length;
    const total = read + packet.openNeeds.length;
    const lines = [`Lesebelege: ${read} von ${total} Recherchebedürfnissen.`];
    if (packet.openNeeds.length > 0) {
        lines.push('Offen geblieben:');
        for (const open of packet.openNeeds) {
            lines.push(
                `- ${open.targetFile}, Suchbegriff "${open.searchTerm}": ${open.reason}`
            );
        }
    }
    return lines.join('\n');
}

export interface BerpPilotDependencies {
    createContext(workspace: vscode.Uri): Promise<ReadOnlyPromptContext>;
    measure(context: ReadOnlyPromptContext, prompt: string): number;
    request(
        context: ReadOnlyPromptContext,
        prompt: string,
        signal?: AbortSignal
    ): Promise<{ answer: string; requestBytes: number }>;
    search(
        workspace: vscode.Uri,
        targetFile: string,
        searchTerm: string
    ): Promise<ToolResult>;
    readRange(
        workspace: vscode.Uri,
        targetFile: string,
        firstLine: number,
        lastLine: number
    ): Promise<ToolResult>;
}

interface SearchHit {
    path: string;
    line: number;
    // Nur zur Auswahl einer Deklaration; gelangt nie ins Packet.
    text?: string;
    textTruncated?: boolean;
}

function parseSearch(content: string): {
    emittedHitCount: number;
    moreHitsAvailable: boolean | 'unknown';
    hits: SearchHit[];
    malformedHits: boolean;
} | undefined {
    try {
        const parsed: unknown = JSON.parse(content);
        if (!isRecord(parsed) || !Array.isArray(parsed.hits)) {
            return undefined;
        }
        const hits = parsed.hits.filter((hit): hit is SearchHit =>
            isRecord(hit)
            && typeof hit.path === 'string'
            && typeof hit.line === 'number'
            && Number.isSafeInteger(hit.line)
        );
        if (
            typeof parsed.emittedHitCount !== 'number'
            || (typeof parsed.moreHitsAvailable !== 'boolean'
                && parsed.moreHitsAvailable !== 'unknown')
        ) {
            return undefined;
        }
        return {
            emittedHitCount: parsed.emittedHitCount,
            moreHitsAvailable: parsed.moreHitsAvailable,
            hits,
            malformedHits: hits.length !== parsed.hits.length
        };
    } catch {
        return undefined;
    }
}

const DECLARATION_PREFIX = String.raw`(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum)`;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const DECLARATION_SEARCH = new RegExp(
    String.raw`^${DECLARATION_PREFIX}\s+([A-Za-z_$][\w$]*)\s*\(?$`
);

// Enge Regel: Nur ein Suchbegriff, der ein einzelner Bezeichner ist (oder
// "<Deklarationswort> <Bezeichner>"), darf mehrere Treffer auf genau eine
// Deklaration eingrenzen. Es wird nichts weiter analysiert.
function searchedIdentifier(searchTerm: string): string | undefined {
    const term = searchTerm.trim();
    if (IDENTIFIER.test(term)) {
        return term;
    }
    return DECLARATION_SEARCH.exec(term)?.[1];
}

function selectDeclarationHit(
    parsed: NonNullable<ReturnType<typeof parseSearch>>,
    searchTerm: string,
    targetFile: string
): { hit: SearchHit } | { reason: string } {
    const stop = (detail: string) => ({
        reason: `Trefferzahl nicht eindeutig; kein Bereich wurde gelesen (${detail}).`
    });
    const identifier = searchedIdentifier(searchTerm);
    if (!identifier) {
        return stop('Suchbegriff ist weder Bezeichner noch Deklarationssuche');
    }
    if (parsed.moreHitsAvailable !== false || parsed.malformedHits) {
        return stop('Trefferliste unvollständig');
    }
    if (parsed.emittedHitCount !== parsed.hits.length) {
        return stop('Trefferzahl stimmt nicht mit der Trefferliste überein');
    }
    if (parsed.hits.some(hit => typeof hit.text !== 'string' || hit.textTruncated !== false)) {
        return stop('Treffertext fehlt oder ist abgeschnitten');
    }
    if (parsed.hits.some(hit => hit.path !== targetFile || hit.line < 1)) {
        return stop('Treffer außerhalb der Zieldatei');
    }
    const declaration = new RegExp(
        String.raw`^${DECLARATION_PREFIX}\s+${identifier.replace(/\$/g, '\\$')}(?![\w$])`
    );
    const declarations = parsed.hits.filter(hit => declaration.test(hit.text ?? ''));
    if (declarations.length === 0) {
        return stop(`keine Deklaration von ${identifier} unter ${parsed.hits.length} Treffern`);
    }
    if (declarations.length > 1) {
        return stop(`${declarations.length} Deklarationen von ${identifier}`);
    }
    return { hit: declarations[0] };
}

function parseRange(content: string): {
    path: string;
    range: LineRange;
    text: string;
} | undefined {
    try {
        const parsed: unknown = JSON.parse(content);
        if (!isRecord(parsed) || !isRecord(parsed.readRange)) {
            return undefined;
        }
        const range = parsed.readRange;
        if (
            typeof parsed.path !== 'string'
            || typeof range.firstLine !== 'number'
            || !Number.isSafeInteger(range.firstLine)
            || range.firstLine < 1
            || typeof range.lastLine !== 'number'
            || !Number.isSafeInteger(range.lastLine)
            || range.lastLine < range.firstLine
            || typeof parsed.text !== 'string'
        ) {
            return undefined;
        }
        return {
            path: parsed.path,
            range: {
                firstLine: range.firstLine,
                lastLine: range.lastLine
            },
            text: parsed.text
        };
    } catch {
        return undefined;
    }
}

function contractPrompt(task: string): string {
    return [
        'Erzeuge ausschließlich einen JSON-Recherchevertrag, keinen Plan und keinen freien Text.',
        'Schema: {"researchNeeds":[{"question":"...","targetFile":"...","searchTerm":"...","reason":"..."}]}.',
        'Nutze ausschließlich die bestätigte Micro Map und höchstens zwei Bedürfnisse.',
        'Regeln für searchTerm: Wähle einen möglichst eindeutigen, dateispezifischen Begriff, der in der Zieldatei voraussichtlich nur einmal vorkommt, bevorzugt eine Deklaration oder Definition (z. B. "export const NAME" oder "function name(").',
        'Vermeide Begriffe, die in vielen Zeilen vorkommen können (allgemeine Funktions-, Variablen- oder Werkzeugnamen). searchTerm ist ein Inhaltsbegriff, kein Pfad.',
        'Gib ausschließlich das JSON-Objekt aus: ohne Codeblock, ohne Erklärung, ohne weiteren Text.',
        `Aufgabe: ${task}`,
        `Micro Map: ${BERP_MICRO_MAP.map(file => file.path).join(', ')}`
    ].join('\n');
}

function planPrompt(
    task: string,
    packet: BerpEvidencePacket
): string {
    const packetText = JSON.stringify(packet);
    return buildPlanPrompt(task, [
        'BERP-0 Evidence Packet (JSON; Codeauszüge stammen ausschließlich aus erfolgreichen read_file_range-Ergebnissen):',
        packetText,
        'Erstelle jetzt den Plan ausschließlich anhand der Projektregeln, der bestätigten Micro Map und dieses Evidence Packets.',
        'Diese Phase ist werkzeugfrei. Fordere keine Recherche oder Dateizugriffe an.'
    ].join('\n'));
}

function createDependencies(): BerpPilotDependencies {
    return {
        createContext: createReadOnlyPromptContext,
        measure: measureReadOnlyPromptRequest,
        request: runReadOnlyPrompt,
        search: (workspace, targetFile, searchTerm) =>
            searchProjectText(workspace, searchTerm, targetFile),
        readRange: readProjectFileRange
    };
}

export async function runBerpPilot(
    workspace: vscode.Uri,
    signal?: AbortSignal,
    onStatus?: (status: string) => void,
    overrides: Partial<BerpPilotDependencies> = {}
): Promise<BerpPilotResult> {
    return runExclusiveOperation('BERP-0 Pilot', async () => {
        const dependencies = { ...createDependencies(), ...overrides };
        const context = await dependencies.createContext(workspace);
        const askModel = async (prompt: string) => {
            const bytes = dependencies.measure(context, prompt);
            if (bytes > MAX_REQUEST_BYTES) {
                throw new RequestTooLargeError(bytes);
            }
            const result = await dependencies.request(context, prompt, signal);
            if (result.requestBytes !== bytes) {
                throw new Error(
                    'Die gemessene und gesendete BERP-Anfragegröße stimmt nicht überein.'
                );
            }
            return result;
        };

        onStatus?.('BERP-0: Recherchevertrag wird angefordert ...');
        const contractResponse = await askModel(contractPrompt(BERP_PILOT_TASK));
        const contract = validateResearchContract(
            parseResearchContract(contractResponse.answer),
            workspace
        );

        for (const need of contract.researchNeeds) {
            const safePath = await checkNoSymlinkInPath(
                workspace,
                need.targetFile
            );
            if (!safePath.allowed) {
                throw new InvalidResearchContractError(
                    safePath.reason ?? 'Ein Micro-Map-Pfad ist nicht sicher.'
                );
            }
        }

        const evidence: ToolEvidence[] = [];
        const readEvidence: BerpEvidencePacket['readEvidence'] = [];
        const openNeeds: BerpEvidencePacket['openNeeds'] = [];

        for (const need of contract.researchNeeds) {
            onStatus?.(`BERP-0: Suche in ${need.targetFile} ...`);
            const search = await dependencies.search(
                workspace,
                need.targetFile,
                need.searchTerm
            );
            const parsedSearch = search.success
                ? parseSearch(search.content)
                : undefined;
            evidence.push({
                tool: 'search_text',
                target: `"${need.searchTerm}" in ${need.targetFile}`,
                success: search.success && parsedSearch !== undefined,
                query: need.searchTerm,
                hits: (parsedSearch?.hits ?? []).map(({ path, line }) => ({ path, line }))
            });

            if (!search.success || !parsedSearch) {
                openNeeds.push({
                    question: need.question,
                    targetFile: need.targetFile,
                    searchTerm: need.searchTerm,
                    reason: search.success
                        ? 'Suchergebnis konnte nicht sicher ausgewertet werden.'
                        : search.content
                });
                continue;
            }
            const uniqueHit = parsedSearch.emittedHitCount === 1
                && parsedSearch.hits.length === 1
                && parsedSearch.moreHitsAvailable === false
                && parsedSearch.hits[0].path === need.targetFile;
            const selection = uniqueHit
                ? { hit: parsedSearch.hits[0] }
                : parsedSearch.emittedHitCount === 0
                    ? { reason: 'Kein Suchtreffer.' }
                    : selectDeclarationHit(
                        parsedSearch,
                        need.searchTerm,
                        need.targetFile
                    );
            if (!('hit' in selection)) {
                openNeeds.push({
                    question: need.question,
                    targetFile: need.targetFile,
                    searchTerm: need.searchTerm,
                    reason: selection.reason
                });
                continue;
            }

            const hit = selection.hit;
            const firstLine = Math.max(1, hit.line - 2);
            const lastLine = hit.line + 2;
            onStatus?.(`BERP-0: Bereich um Zeile ${hit.line} wird gelesen ...`);
            const rangeResult = await dependencies.readRange(
                workspace,
                need.targetFile,
                firstLine,
                lastLine
            );
            const parsedRange = rangeResult.success
                ? parseRange(rangeResult.content)
                : undefined;
            const validRange = parsedRange?.path === need.targetFile
                && parsedRange.range.firstLine <= hit.line
                && parsedRange.range.lastLine >= hit.line
                ? parsedRange
                : undefined;
            evidence.push({
                tool: 'read_file_range',
                target: need.targetFile,
                success: validRange !== undefined,
                ...(validRange ? { deliveredRange: validRange.range } : {})
            });
            if (!validRange) {
                openNeeds.push({
                    question: need.question,
                    targetFile: need.targetFile,
                    searchTerm: need.searchTerm,
                    reason: rangeResult.success
                        ? 'Gelieferter Bereich konnte nicht sicher ausgewertet werden.'
                        : rangeResult.content
                });
                continue;
            }
            readEvidence.push({
                path: validRange.path,
                range: validRange.range,
                codeExcerpt: validRange.text,
                origin: {
                    question: need.question,
                    searchTerm: need.searchTerm,
                    hitLine: hit.line
                }
            });
        }

        const packet: BerpEvidencePacket = {
            originalTask: BERP_PILOT_TASK,
            microMap: BERP_MICRO_MAP,
            readEvidence,
            openNeeds,
            planRequestUtf8Bytes: 0
        };
        const summary = summarizeBerpOutcome(packet);
        if (readEvidence.length === 0) {
            onStatus?.('BERP-0: Kein Bereich gelesen; es wird kein Plan angefordert.');
            return {
                answer: [
                    'TEILABSCHLUSS: Es wurde kein Codebereich erfolgreich gelesen. '
                    + 'Deshalb wurde kein Änderungsplan erstellt und keine '
                    + 'Plananfrage an das Modell gesendet.',
                    '',
                    '---',
                    formatEvidence(evidence, 0, [])
                ].join('\n'),
                summary,
                evidence,
                packet,
                planRequestBytes: 0,
                planRequested: false
            };
        }
        let nextBytes = 0;
        let finalPrompt = '';
        for (let attempt = 0; attempt < 8; attempt += 1) {
            packet.planRequestUtf8Bytes = nextBytes;
            finalPrompt = planPrompt(BERP_PILOT_TASK, packet);
            const measured = dependencies.measure(context, finalPrompt);
            if (measured === nextBytes) {
                break;
            }
            nextBytes = measured;
            if (attempt === 7) {
                throw new Error(
                    'Die exakte Größe der Plananfrage stabilisierte sich nicht; es wurde nichts gekürzt.'
                );
            }
        }
        const planRequestBytes = dependencies.measure(context, finalPrompt);
        if (planRequestBytes > MAX_REQUEST_BYTES) {
            throw new RequestTooLargeError(planRequestBytes);
        }
        onStatus?.('BERP-0: Werkzeugarmer Planaufruf wird gesendet ...');
        const plan = await dependencies.request(context, finalPrompt, signal);
        if (plan.requestBytes !== planRequestBytes) {
            throw new Error(
                'Die gemessene und gesendete Plananfragegröße stimmt nicht überein.'
            );
        }

        return {
            answer: formatPlanResponse(
                plan.answer,
                evidence,
                0,
                BERP_PILOT_TASK
            ),
            summary,
            evidence,
            packet,
            planRequestBytes,
            planRequested: true
        };
    });
}
