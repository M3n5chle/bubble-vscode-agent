import * as vscode from 'vscode';
import {
    checkWorkspacePath
} from '../safety/pathPolicy.js';
import { isAllowedTextFilePath } from '../tools/readTools.js';

export const BERP_PILOT_TASK =
    'Plane eine Änderung der Bereichsgrenze MAX_RANGE_LINES. '
    + 'Berücksichtige ausschließlich die bestätigte Micro Map '
    + 'src/tools/readTools.ts und src/test/extension.test.ts.';

export const BERP_MICRO_MAP = [
    { path: 'src/tools/readTools.ts', role: 'Zieldatei' },
    { path: 'src/test/extension.test.ts', role: 'bestehende Grenztests' }
] as const;

export interface ResearchNeed {
    question: string;
    targetFile: string;
    searchTerm: string;
    reason: string;
}

export interface ResearchContract {
    researchNeeds: ResearchNeed[];
}

export class InvalidResearchContractError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidResearchContractError';
    }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Akzeptiert wird nur die gesamte Antwort als JSON, optional genau ein
// umschließender Markdown-Codeblock. Text davor oder danach gilt nicht.
const FENCED_JSON = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i;

export function parseResearchContract(text: string): unknown {
    const trimmed = text.trim();
    const candidate = FENCED_JSON.exec(trimmed)?.[1] ?? trimmed;
    try {
        return JSON.parse(candidate);
    } catch {
        const preview = trimmed.replace(/\s+/g, ' ').slice(0, 200);
        throw new InvalidResearchContractError(
            'Der Recherchevertrag ist kein gültiges JSON; es wurde nicht recherchiert. '
            + `Antwortanfang: "${preview}"`
        );
    }
}

export function validateResearchContract(
    value: unknown,
    workspace: vscode.Uri
): ResearchContract {
    if (!isRecord(value) || !hasExactKeys(value, ['researchNeeds'])) {
        throw new InvalidResearchContractError(
            'Der Recherchevertrag hat nicht die erwartete Struktur.'
        );
    }
    const rawNeeds = value.researchNeeds;
    if (!Array.isArray(rawNeeds) || rawNeeds.length < 1 || rawNeeds.length > 2) {
        throw new InvalidResearchContractError(
            'Der Recherchevertrag muss ein oder zwei Recherchebedürfnisse enthalten.'
        );
    }

    const needs = rawNeeds.map((raw): ResearchNeed => {
        if (!isRecord(raw) || !hasExactKeys(
            raw,
            ['question', 'targetFile', 'searchTerm', 'reason']
        )) {
            throw new InvalidResearchContractError(
                'Ein Recherchebedürfnis hat nicht die erwarteten Felder.'
            );
        }
        const { question, targetFile, searchTerm, reason } = raw;
        if (
            !isNonEmptyString(question, 500)
            || !isNonEmptyString(targetFile, 260)
            || !isNonEmptyString(searchTerm, 200)
            || !isNonEmptyString(reason, 500)
        ) {
            throw new InvalidResearchContractError(
                'Alle Contract-Felder müssen nichtleer und begrenzt sein.'
            );
        }
        if (!BERP_MICRO_MAP.some(entry => entry.path === targetFile)) {
            throw new InvalidResearchContractError(
                `Zieldatei "${targetFile}" liegt außerhalb der bestätigten Micro Map.`
            );
        }
        const pathCheck = checkWorkspacePath(workspace, targetFile);
        if (
            !pathCheck.allowed
            || pathCheck.relativePath !== targetFile
            || !isAllowedTextFilePath(targetFile)
        ) {
            throw new InvalidResearchContractError(
                `Zieldatei "${targetFile}" ist kein erlaubter Workspace-Textpfad.`
            );
        }
        if (isPathLike(searchTerm)) {
            throw new InvalidResearchContractError(
                'searchTerm muss ein Suchbegriff im Dateiinhalt und kein Pfad sein.'
            );
        }
        return { question, targetFile, searchTerm, reason };
    });

    const seen = new Set<string>();
    for (const need of needs) {
        const key = `${need.targetFile.toLowerCase()}\u0000${need.searchTerm.toLowerCase()}`;
        if (seen.has(key)) {
            throw new InvalidResearchContractError(
                'Der Recherchevertrag enthält doppelte Recherchebedürfnisse.'
            );
        }
        seen.add(key);
    }
    return { researchNeeds: needs };
}

function hasExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[]
): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
    return typeof value === 'string'
        && value.trim().length > 0
        && value.length <= maxLength;
}

function isPathLike(value: string): boolean {
    return value.includes('/') || value.includes('\\')
        || /^[a-zA-Z]:/.test(value)
        || /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]{1,8}$/.test(value);
}
