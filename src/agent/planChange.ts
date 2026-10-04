import * as vscode from 'vscode';
import {
    runReadOnlyAgent,
    formatEvidence,
    type ToolEvidence
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
 * und vergleicht genannte Dateien mit den tatsächlich ausgeführten read_file-Werkzeugen.
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

    // Ermittle tatsächlich per read_file erfolgreich gelesene Dateien.
    const verifiedFiles = new Set<string>();

    for (const entry of evidence) {
        if (entry.tool === 'read_file' && entry.success) {
            verifiedFiles.add(entry.target.toLowerCase());
        }
    }

    // Extrahiere den Abschnitt "betroffene Dateien, nur soweit tatsächlich geprüft"
    const filesSectionMatch = planText.match(
        new RegExp(
            `(?:^|\\n)${prefix}betroffene Dateien, nur soweit tatsächlich geprüft[^\\n]*\\n([\\s\\S]*?)(?=\\n${prefix}(?:höchstens drei Umsetzungsschritte|nötige Tests|offene Fragen)|$)`,
            'i'
        )
    );

    const unverifiedFiles: string[] = [];

    if (filesSectionMatch) {
        const sectionText = filesSectionMatch[1];

        // Finde Pfadangaben (z.B. `- src/extension.ts` oder `package.json`)
        const fileMatches = sectionText.matchAll(/(?:^|\s|`|")([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)(?:`|"|\s|$|,|\.)/g);

        for (const match of fileMatches) {
            const candidate = match[1].toLowerCase();

            // Ausnahmen für z. B. Bezeichnungen wie "keine" oder allgemeine Worte
            if (candidate === 'keine' || candidate === 'keine.') {
                continue;
            }

            if (!verifiedFiles.has(candidate)) {
                if (!unverifiedFiles.includes(match[1])) {
                    unverifiedFiles.push(match[1]);
                }
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
        '- Unter "betroffene Dateien, nur soweit tatsächlich geprüft": Nenne NUR Dateien, die du zuvor mit dem Werkzeug `read_file` tatsächlich gelesen hast. Wenn du eine Datei nicht gelesen hast, darfst du sie hier NICHT als geprüft auflisten. Falls keine Datei gelesen wurde, schreibe "Keine".',
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
 * 'read' = erfolgreiches read_file für diese Datei,
 * 'failed' = nur fehlgeschlagene read_file-Versuche für diese Datei,
 * 'not-attempted' = kein read_file-Versuch für diese Datei (auch wenn
 * andere Dateien gelesen wurden),
 * 'unknown' = Protokoll wegen Begrenzung unvollständig (omitted > 0) und
 * kein erfolgreiches read_file sichtbar; dann ist weder 'failed' noch
 * 'not-attempted' belegt.
 */
export function getFileReadStatus(
    file: string,
    evidence: readonly ToolEvidence[],
    omitted = 0
): FileReadStatus {
    const wanted = normalizePath(file);
    const attempts = evidence.filter(
        e => e.tool === 'read_file' && normalizePath(e.target) === wanted
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

        if (status === 'unknown') {
            lines.push(`- ${file}: Status nicht feststellbar, das Werkzeugprotokoll ist begrenzt und unvollständig (${omitted} Aufrufe nicht aufgeführt).`);
        } else if (status === 'failed') {
            lines.push(`- ${file}: read_file wurde versucht, ist aber fehlgeschlagen.`);
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

export function formatPlanResponse(
    answer: string,
    evidence: readonly ToolEvidence[],
    omitted: number,
    userWish = ''
): string {
    const notice = formatUnverifiedRequestNotice(
        extractRequestedFiles(userWish),
        evidence,
        omitted
    );

    if (notice) {
        return [notice, '', '---', formatEvidence(evidence, omitted)].join('\n');
    }
    const validation = validatePlanOutput(answer, evidence);
    const lines = [answer, '', '---', formatEvidence(evidence, omitted)];

    if (validation.unverifiedFiles.length > 0) {
        lines.push(
            '',
            'WARNUNG (Unbelegte Dateibehauptung):',
            `Folgende im Plan genannte Dateien wurden nicht mit read_file geprüft: ${validation.unverifiedFiles.join(', ')}.`
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
                            changeRequest.trim()
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
