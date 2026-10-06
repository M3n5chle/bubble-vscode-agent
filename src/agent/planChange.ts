import * as vscode from 'vscode';
import {
    runReadOnlyAgent,
    formatEvidence,
    type ToolEvidence,
    type ToolRequestDiagnostic
} from './readOnlyAgent.js';

export const PLAN_SECTIONS = [
    'Ziel der Änderung',
    'betroffene Dateien, nur soweit tatsächlich geprüft',
    'höchstens drei Umsetzungsschritte',
    'nötige Tests',
    'offene Fragen oder unbelegte Annahmen'
] as const;

export interface PlanValidationResult {
    valid: boolean;
    missingSections: string[];
    unverifiedFiles: string[];
    stepCountExceeded: boolean;
    stepCount: number;
}

/**
 * Überprüft die Ausgabe des KI-Modells auf Einhaltung des geforderten Formats
 * und vergleicht genannte Dateien mit den tatsächlich ausgeführten Lesewerkzeugen.
 */
export function validatePlanOutput(
    planText: string,
    evidence: readonly ToolEvidence[] = []
): PlanValidationResult {
    const missingSections: string[] = [];

    const prefix = '(?:#+|\\d+[\\.\\)]|[*\\-])*\\s*';

    for (const section of PLAN_SECTIONS) {
        const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(?:^|\\n)${prefix}${escaped}`, 'i');

        if (!regex.test(planText)) {
            missingSections.push(section);
        }
    }

    // Ermittle tatsächlich mit einem Lesewerkzeug gelesene Dateien.
    const verifiedFiles = new Set<string>();

    for (const entry of evidence) {
        if (
            (entry.tool === 'read_file'
                || entry.tool === 'read_file_range')
            && entry.success
        ) {
            verifiedFiles.add(normalizePath(entry.target));
        }
    }

    const unverifiedFiles: string[] = [];
    // Alle Datei-Bezüge erfassen: ein ungeprüfter Implementierungsvorschlag
    // bleibt auch außerhalb des Abschnitts "betroffene Dateien" unbelegt.
    const fileMatches = planText.matchAll(/(?:^|\s|`|")([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)(?:`|"|\s|$|,|\.)/g);
    const commonExtensions = new Set([
        'bat', 'c', 'cc', 'cpp', 'cs', 'css', 'cjs', 'go', 'h', 'hpp',
        'htm', 'html', 'ipynb', 'java', 'js', 'jsx', 'json', 'md', 'mjs',
        'php', 'ps1', 'py', 'rs', 'scss', 'sh', 'sql', 'ts', 'tsx', 'txt',
        'xml', 'yaml', 'yml'
    ]);

    for (const match of fileMatches) {
        const candidate = normalizePath(match[1]);
        const hasDirectory = candidate.includes('/');
        const extension = candidate.split('.').at(-1) ?? '';

        if (
            !hasDirectory
            && !commonExtensions.has(extension)
        ) {
            // Ein punktgetrennter Ausdruck ohne Pfadtrenner ist ohne bekannte
            // Dateiendung nicht zuverlässig von einem Property-Zugriff zu
            // unterscheiden (z. B. controller.signal.aborted).
            continue;
        }

        // Ausnahmen für z. B. Bezeichnungen wie "keine" oder allgemeine Worte
        if (candidate === 'keine' || candidate === 'keine.') {
            continue;
        }

        const basename = candidate.split('/').at(-1);
        const matchingVerifiedPaths = [...verifiedFiles].filter(
            file => file.split('/').at(-1) === basename
        );
        if (
            !verifiedFiles.has(candidate)
            && !(basename === candidate && matchingVerifiedPaths.length === 1)
        ) {
            if (!unverifiedFiles.includes(match[1])) {
                unverifiedFiles.push(match[1]);
            }
        }
    }

    // Extrahiere den Abschnitt "höchstens drei Umsetzungsschritte"
    const stepsSectionMatch = planText.match(
        new RegExp(
            `(?:^|\\n)${prefix}höchstens drei Umsetzungsschritte[^\\n]*\\n([\\s\\S]*?)(?=\\n${prefix}(?:nötige Tests|offene Fragen)|$)`,
            'i'
        )
    );

    let stepCount = 0;

    if (stepsSectionMatch) {
        const stepsText = stepsSectionMatch[1];
        // Zähle Aufzählungspunkte (z. B. 1., 2., 3. oder -, *)
        const items = stepsText.split('\n').filter(line => {
            const trimmed = line.trim();
            return /^(?:\d+[\.\)]|[\-\*])\s+/.test(trimmed);
        });

        stepCount = items.length;
    }

    const stepCountExceeded = stepCount > 3;

    return {
        valid: missingSections.length === 0 && unverifiedFiles.length === 0 && !stepCountExceeded,
        missingSections,
        unverifiedFiles,
        stepCountExceeded,
        stepCount
    };
}

export function buildPlanPrompt(userWish: string): string {
    return [
        'Untersuche die gewünschte Codeänderung und erstelle einen strukturierten Plan.',
        'WICHTIG: Ändere keine Dateien und erstelle keine Dateien. Es werden ausschließlich Lesewerkzeuge genutzt.',
        '',
        'Deine Antwort MUSS exakt die folgenden fünf Abschnitte als Überschriften enthalten:',
        '',
        '1. Ziel der Änderung',
        '2. betroffene Dateien, nur soweit tatsächlich geprüft',
        '3. höchstens drei Umsetzungsschritte',
        '4. nötige Tests',
        '5. offene Fragen oder unbelegte Annahmen',
        '',
        'Regeln für die Abschnitte:',
        '- Unter "betroffene Dateien, nur soweit tatsächlich geprüft": Nenne jede Datei aus dem Werkzeugprotokoll, für die `read_file` oder `read_file_range` erfolgreich war. Das gilt ausdrücklich auch für vorab gelesene Dateien (Modellschritt 0). Schreibe nur dann "Keine", wenn kein erfolgreicher Leseaufruf vorliegt.',
        '- Behaupte in keinem Abschnitt konkrete Eigenschaften oder nötige Änderungen an einer Datei, die nicht erfolgreich mit `read_file` oder `read_file_range` gelesen wurde. Kennzeichne solche Dateiaussagen unter "offene Fragen oder unbelegte Annahmen" ausdrücklich als "Unklar" und nenne die ungelesene Datei. Rufe weitere Lesewerkzeuge nur auf, wenn sie für den Plan nötig sind; andernfalls kennzeichne die Aussage als unklar.',
        '- Unter "höchstens drei Umsetzungsschritte": Gib maximal 3 konkrete Schritte an (z. B. 1., 2., 3.). Mehr als 3 Schritte sind strikt verboten.',
        '- Eine konservative Byte-Produktgrenze ist keine Garantie für vollständigen Modellkontext oder sichere Verarbeitung. Leite daraus keine solche Garantie ab. Unbelegte Sicherheitsgarantien musst du unter "offene Fragen oder unbelegte Annahmen" ausdrücklich als offene Annahme kennzeichnen.',
        '- Halte die gesamte Ausgabe knapp und präzise.',
        '',
        `Gewünschte Änderung: ${userWish}`
    ].join('\n');
}

export type FileReadStatus = 'read' | 'failed' | 'not-attempted' | 'unknown';

function normalizePath(p: string): string {
    return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * Dateien, deren Prüfung der Nutzer ausdrücklich verlangt (Pfadangabe
 * zusammen mit einem Lese-/Prüfhinweis im Wunsch).
 */
export function extractRequestedFiles(userWish: string): string[] {
    const asksForCheck =
        /read_file|\b(?:les(?:e|en|t)?|lies|prüf\w*|überprüf\w*|untersuch\w*|inspizier\w*|read|inspect|check)\b/i
            .test(userWish);

    if (!asksForCheck) {
        return [];
    }

    const files: string[] = [];

    for (const m of userWish.matchAll(/(?:^|[\s`"'(])((?:[\w\-.]+[\\/])*[\w\-.]+\.[A-Za-z][A-Za-z0-9]{1,7})(?=$|[\s`"',;:)!?]|\.(?:\s|$))/g)) {
        if (!files.some(f => normalizePath(f) === normalizePath(m[1]))) {
            files.push(m[1]);
        }
    }

    return files;
}

/**
 * Status allein aus dem erfassten Werkzeugprotokoll:
 * 'read' = erfolgreiches read_file oder read_file_range für diese Datei,
 * 'failed' = nur fehlgeschlagene Leseversuche für diese Datei,
 * 'not-attempted' = kein Leseversuch für diese Datei (auch wenn
 * andere Dateien gelesen wurden),
 * 'unknown' = Protokoll wegen Begrenzung unvollständig (omitted > 0) und
 * kein erfolgreiches Lesewerkzeug sichtbar; dann ist weder 'failed' noch
 * 'not-attempted' belegt.
 */
export function getFileReadStatus(
    file: string,
    evidence: readonly ToolEvidence[],
    omitted = 0
): FileReadStatus {
    const wanted = normalizePath(file);
    const attempts = evidence.filter(
        e => (
            e.tool === 'read_file'
            || e.tool === 'read_file_range'
        ) && normalizePath(e.target) === wanted
    );

    if (attempts.some(e => e.success)) {
        return 'read';
    }

    if (omitted > 0) {
        return 'unknown';
    }

    return attempts.length > 0 ? 'failed' : 'not-attempted';
}

export function formatUnverifiedRequestNotice(
    files: readonly string[],
    evidence: readonly ToolEvidence[],
    omitted = 0
): string | undefined {
    const lines: string[] = [];

    for (const file of files) {
        const status = getFileReadStatus(file, evidence, omitted);
        const readTools = evidence
            .filter(e => normalizePath(e.target) === normalizePath(file))
            .map(e => e.tool)
            .filter(tool => tool === 'read_file' || tool === 'read_file_range');
        const readToolLabel = [...new Set(readTools)].join('/');

        if (status === 'unknown') {
            lines.push(`- ${file}: Status nicht feststellbar, das Werkzeugprotokoll ist begrenzt und unvollständig (${omitted} Aufrufe nicht aufgeführt).`);
        } else if (status === 'failed') {
            lines.push(`- ${file}: ${readToolLabel || 'read_file'} wurde versucht, ist aber fehlgeschlagen.`);
        } else if (status === 'not-attempted') {
            lines.push(`- ${file}: laut Werkzeugprotokoll wurde kein read_file-Versuch für diese Datei ausgeführt.`);
        }
    }

    if (lines.length === 0) {
        return undefined;
    }

    return [
        'HINWEIS: Die ausdrücklich verlangte Dateiprüfung liegt nicht vor. '
        + 'Es wird kein dateispezifischer Umsetzungsplan als geprüft ausgegeben.',
        '',
        ...lines,
        '',
        'Offene Frage: Soll die Prüfung dieser Datei(en) erneut versucht werden '
        + '(Pfad und Lesbarkeit prüfen), oder soll ein Plan ausdrücklich ohne '
        + 'gelesene Datei als ungeprüft erstellt werden?'
    ].join('\n');
}

function listVerifiedFiles(
    evidence: readonly ToolEvidence[]
): string[] {
    const files = new Map<string, string>();

    for (const entry of evidence) {
        if (
            (entry.tool === 'read_file' || entry.tool === 'read_file_range')
            && entry.success
        ) {
            const normalized = normalizePath(entry.target);
            if (!files.has(normalized)) {
                files.set(normalized, entry.target.replace(/\\/g, '/'));
            }
        }
    }

    return [...files.values()];
}

function reconcileVerifiedFiles(
    planText: string,
    evidence: readonly ToolEvidence[]
): string {
    const lines = planText.split('\n');
    const prefix = '(?:#+|\\d+[\\.\\)]|[*\\-])*\\s*';
    const sectionHeader = new RegExp(
        `^${prefix}betroffene Dateien, nur soweit tatsächlich geprüft`,
        'i'
    );
    const nextSectionHeader = new RegExp(
        `^${prefix}(?:höchstens drei Umsetzungsschritte|nötige Tests|offene Fragen oder unbelegte Annahmen)`,
        'i'
    );
    const start = lines.findIndex(line => sectionHeader.test(line.trim()));
    const verifiedFiles = listVerifiedFiles(evidence);

    if (start < 0 || verifiedFiles.length === 0) {
        return planText;
    }

    let end = start + 1;
    while (end < lines.length && !nextSectionHeader.test(lines[end].trim())) {
        end += 1;
    }

    lines.splice(
        start + 1,
        end - start - 1,
        ...verifiedFiles.map(file => `- \`${file}\``)
    );
    return lines.join('\n');
}

function appendUnverifiedAssumptions(
    planText: string,
    unverifiedFiles: readonly string[]
): string {
    if (unverifiedFiles.length === 0) {
        return planText;
    }

    const lines = planText.split('\n');
    const prefix = '(?:#+|\\d+[\\.\\)]|[*\\-])*\\s*';
    const sectionHeader = new RegExp(
        `^${prefix}offene Fragen oder unbelegte Annahmen`,
        'i'
    );
    const start = lines.findIndex(line => sectionHeader.test(line.trim()));
    const note = 'Unklar, weil nicht gelesen: Aussagen oder Vorschläge zu '
        + `${unverifiedFiles.join(', ')} sind Annahmen und nicht durch `
        + 'Werkzeugergebnisse belegt.';

    if (start < 0) {
        return `${planText}\n\n${note}`;
    }

    const end = lines.findIndex(
        (line, index) => index > start && new RegExp(
            `^${prefix}(?:${PLAN_SECTIONS.slice(0, -1).map(section => (
                section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            )).join('|')})`,
            'i'
        ).test(line.trim())
    );
    lines.splice(end < 0 ? lines.length : end, 0, note);
    return lines.join('\n');
}

export function formatPlanResponse(
    answer: string,
    evidence: readonly ToolEvidence[],
    omitted: number,
    userWish = '',
    toolDiagnostics: readonly ToolRequestDiagnostic[] = []
): string {
    const notice = formatUnverifiedRequestNotice(
        extractRequestedFiles(userWish),
        evidence,
        omitted
    );

    if (notice) {
        return [
            notice,
            '',
            '---',
            formatEvidence(evidence, omitted, [], toolDiagnostics)
        ].join('\n');
    }
    const sourceValidation = validatePlanOutput(answer, evidence);
    const reconciledAnswer = reconcileVerifiedFiles(answer, evidence);
    const validation = validatePlanOutput(reconciledAnswer, evidence);
    const unverifiedFiles = [...new Set([
        ...sourceValidation.unverifiedFiles,
        ...validation.unverifiedFiles
    ])];
    const cautiousAnswer = appendUnverifiedAssumptions(
        reconciledAnswer,
        unverifiedFiles
    );
    const lines = [
        cautiousAnswer,
        '',
        '---',
        formatEvidence(evidence, omitted, [], toolDiagnostics)
    ];

    if (unverifiedFiles.length > 0) {
        lines.push(
            '',
            'WARNUNG (Unbelegte Dateibehauptung):',
            `Folgende im Plan genannte Dateien wurden nicht erfolgreich mit einem Lesewerkzeug geprüft: ${unverifiedFiles.join(', ')}.`
        );
    }

    if (validation.stepCountExceeded) {
        lines.push(
            '',
            `WARNUNG: Der Plan enthält ${validation.stepCount} Umsetzungsschritte (maximal 3 erlaubt).`
        );
    }

    if (validation.missingSections.length > 0) {
        lines.push(
            '',
            `WARNUNG: Folgende geforderte Abschnitte fehlen im Plan: ${validation.missingSections.join(', ')}.`
        );
    }

    return lines.join('\n');
}

export function registerPlanChangeCommand(
    output: vscode.OutputChannel
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'bubble-vscode-agent.planChange',
        async () => {
            const workspaceFolders = vscode.workspace.workspaceFolders;

            if (!workspaceFolders || workspaceFolders.length === 0) {
                vscode.window.showErrorMessage(
                    'Bubble: Es ist kein Workspace geöffnet. Bitte zuerst einen Projektordner öffnen.'
                );

                return;
            }

            const workspaceUri = workspaceFolders[0].uri;

            const changeRequest = await vscode.window.showInputBox({
                title: 'Bubble: Änderung planen',
                prompt: 'Welche Codeänderung soll untersucht und geplant werden?',
                placeHolder: 'Zum Beispiel: Füge eine Option zur Konfiguration des Ollama-Ports hinzu.',
                ignoreFocusOut: true
            });

            if (!changeRequest?.trim()) {
                return;
            }

            output.clear();
            output.show(true);

            output.appendLine('Bubble: Änderung planen');
            output.appendLine('==========================');
            output.appendLine('');
            output.appendLine(`Gewünschte Änderung: ${changeRequest.trim()}`);
            output.appendLine('');
            output.appendLine('Planung wird vorbereitet ...');

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Bubble plant die Änderung ...',
                    cancellable: false
                },
                async (progress) => {
                    try {
                        const prompt = buildPlanPrompt(changeRequest.trim());
                        const initialFiles = extractRequestedFiles(changeRequest.trim());

                        const result = await runReadOnlyAgent(
                            workspaceUri,
                            prompt,
                            (status) => {
                                progress.report({ message: status });
                                output.appendLine(status);
                            },
                            [],
                            initialFiles
                        );

                        const formatted = formatPlanResponse(
                            result.answer,
                            result.evidence,
                            result.omitted,
                            changeRequest.trim(),
                            result.toolDiagnostics
                        );

                        output.clear();
                        output.appendLine('Bubble: Änderung planen');
                        output.appendLine('==========================');
                        output.appendLine('');
                        output.appendLine(`Gewünschte Änderung: ${changeRequest.trim()}`);
                        output.appendLine('');
                        output.appendLine('Plan:');
                        output.appendLine('');
                        output.appendLine(formatted);

                        vscode.window.showInformationMessage(
                            'Bubble: Planung abgeschlossen.'
                        );
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);

                        output.appendLine('');
                        output.appendLine(`FEHLER: ${message}`);

                        vscode.window.showErrorMessage(`Bubble: ${message}`);
                    }
                }
            );
        }
    );
}
