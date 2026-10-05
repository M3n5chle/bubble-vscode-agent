import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    checkNoSymlinkInPath,
    checkWorkspacePath
} from '../safety/pathPolicy.js';

const MAX_FILE_SIZE = 120_000;
const MAX_LIST_ENTRIES = 200;
export const MAX_SEARCH_RESULTS = 40;
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_FILE_SIZE = 250_000;
export const MAX_SEARCH_MATCH_TEXT_LENGTH = 300;
// 6 KB bleiben unter einem Fünftel der festen 32-KB-Anfragegrenze und
// lassen mindestens 26 KB für Systemtext, Frage, Werkzeuge und Verlauf.
export const MAX_SEARCH_RESULT_BYTES = 6_000;
export const MAX_RANGE_LINES = 120;
// Wie bei der Suche bleibt der größte Einzelbereich deutlich unter der
// 32-KB-Gesamtgrenze, ohne den übrigen Anfragekontext aufzubrauchen.
export const MAX_RANGE_RESULT_BYTES = 4_000;

const ALLOWED_TEXT_EXTENSIONS = new Set([
    '.js',
    '.mjs',
    '.cjs',
    '.ts',
    '.tsx',
    '.jsx',
    '.php',
    '.json',
    '.md',
    '.css',
    '.scss',
    '.html',
    '.htm',
    '.sql',
    '.ps1',
    '.yml',
    '.yaml',
    '.txt',
    '.xml'
]);

export function isAllowedTextFilePath(
    filePath: string
): boolean {
    const extension = path.posix.extname(filePath).toLowerCase();

    return extension !== ''
        && ALLOWED_TEXT_EXTENSIONS.has(extension);
}

export interface ToolResult {
    success: boolean;
    content: string;
}

interface AllowedTextFile {
    relativePath: string;
    absolutePath: string;
}

async function validateReadableTextFile(
    workspaceUri: vscode.Uri,
    requestedPath: string
): Promise<
    | { success: true; file: AllowedTextFile }
    | { success: false; content: string }
> {
    const pathCheck = checkWorkspacePath(
        workspaceUri,
        requestedPath
    );

    if (
        !pathCheck.allowed
        || !pathCheck.absolutePath
        || !pathCheck.relativePath
    ) {
        return {
            success: false,
            content:
                pathCheck.reason
                ?? 'Der Pfad ist nicht erlaubt.'
        };
    }

    const extension = path.posix
        .extname(pathCheck.relativePath)
        .toLowerCase();

    if (!isAllowedTextFilePath(pathCheck.relativePath)) {
        return {
            success: false,
            content:
                `Der Dateityp "${extension || '(ohne Endung)'}" `
                + 'ist nicht als Textdatei freigegeben.'
        };
    }

    const linkCheck = await checkNoSymlinkInPath(
        workspaceUri,
        pathCheck.relativePath
    );

    if (!linkCheck.allowed) {
        return { success: false, content: linkCheck.reason ?? 'Der Pfad ist nicht erlaubt.' };
    }

    return {
        success: true,
        file: {
            relativePath: pathCheck.relativePath,
            absolutePath: pathCheck.absolutePath
        }
    };
}

export async function readProjectFile(
    workspaceUri: vscode.Uri,
    requestedPath: string
): Promise<ToolResult> {
    const pathCheck = await validateReadableTextFile(
        workspaceUri,
        requestedPath
    );

    if (!pathCheck.success) {
        return { success: false, content: pathCheck.content };
    }

    const fileUri = vscode.Uri.file(
        pathCheck.file.absolutePath
    );

    try {
        const stat =
            await vscode.workspace.fs.stat(fileUri);

        if (
            (stat.type & vscode.FileType.Directory)
            === vscode.FileType.Directory
        ) {
            return {
                success: false,
                content:
                    `"${pathCheck.file.relativePath}" ist ein Ordner. `
                    + 'Verwende list_directory.'
            };
        }

        if (stat.size > MAX_FILE_SIZE) {
            return {
                success: false,
                content:
                    `Die Datei ist mit ${stat.size} Bytes `
                    + `größer als das Leselimit `
                    + `von ${MAX_FILE_SIZE} Bytes.`
            };
        }

        const data =
            await vscode.workspace.fs.readFile(fileUri);

        const content =
            new TextDecoder('utf-8').decode(data);

        if (content.includes('\u0000')) {
            return {
                success: false,
                content:
                    'Die Datei scheint Binärdaten zu enthalten.'
            };
        }

        return {
            success: true,
            content: [
                `Datei: ${pathCheck.file.relativePath}`,
                `Größe: ${stat.size} Bytes`,
                '',
                content
            ].join('\n')
        };
    } catch (error) {
        return {
            success: false,
            content:
                `Datei konnte nicht gelesen werden: `
                + getErrorMessage(error)
        };
    }
}

interface RangeResultPayload {
    path: string;
    requestedRange: { firstLine: number; lastLine: number };
    readRange: { firstLine: number; lastLine: number } | null;
    totalLines: number;
    text: string;
    actualUtf8Bytes: number;
    note: string | null;
}

function serializeRangeResult(
    payload: RangeResultPayload,
    success: boolean
): string {
    // Measure the full serialized ToolResult envelope, not only its text field.
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const content = JSON.stringify(payload);
        const actualUtf8Bytes = Buffer.byteLength(
            JSON.stringify({ success, content }),
            'utf8'
        );

        if (payload.actualUtf8Bytes === actualUtf8Bytes) {
            return content;
        }
        payload.actualUtf8Bytes = actualUtf8Bytes;
    }

    throw new Error('Die Bytegröße des Bereichsergebnisses stabilisierte sich nicht.');
}

export async function readProjectFileRange(
    workspaceUri: vscode.Uri,
    requestedPath: string,
    firstLine: unknown,
    lastLine: unknown
): Promise<ToolResult> {
    if (
        typeof firstLine !== 'number'
        || typeof lastLine !== 'number'
        || !Number.isSafeInteger(firstLine)
        || firstLine < 1
        || !Number.isSafeInteger(lastLine)
        || lastLine < 1
    ) {
        return {
            success: false,
            content: 'Zeilennummern müssen positive ganze Zahlen sein.'
        };
    }

    const start = firstLine;
    const end = lastLine;

    if (start > end) {
        return {
            success: false,
            content: 'Die erste Zeile darf nicht nach der letzten Zeile liegen.'
        };
    }

    if (end - start + 1 > MAX_RANGE_LINES) {
        return {
            success: false,
            content:
                `Der angeforderte Bereich umfasst mehr als `
                + `${MAX_RANGE_LINES} Zeilen. Bitte fordere einen `
                + 'kleineren Bereich an.'
        };
    }

    const pathCheck = await validateReadableTextFile(
        workspaceUri,
        requestedPath
    );

    if (!pathCheck.success) {
        return { success: false, content: pathCheck.content };
    }

    const fileUri = vscode.Uri.file(pathCheck.file.absolutePath);

    try {
        const stat = await vscode.workspace.fs.stat(fileUri);

        if (
            (stat.type & vscode.FileType.Directory)
            === vscode.FileType.Directory
        ) {
            return {
                success: false,
                content:
                    `"${pathCheck.file.relativePath}" ist ein Ordner. `
                    + 'Verwende list_directory.'
            };
        }

        if (stat.size > MAX_FILE_SIZE) {
            return {
                success: false,
                content:
                    `Die Datei ist mit ${stat.size} Bytes `
                    + `größer als das Leselimit `
                    + `von ${MAX_FILE_SIZE} Bytes.`
            };
        }

        const data = await vscode.workspace.fs.readFile(fileUri);
        const content = new TextDecoder('utf-8').decode(data);

        if (content.includes('\u0000')) {
            return {
                success: false,
                content: 'Die Datei scheint Binärdaten zu enthalten.'
            };
        }

        const lines = content.length === 0
            ? []
            : content.split(/\r?\n/);
        if (content.endsWith('\n')) {
            lines.pop();
        }

        const totalLines = lines.length;
        const availableStart = Math.min(start, totalLines + 1);
        const availableEnd = Math.min(end, totalLines);
        const hasRange = availableStart <= availableEnd;
        const selectedText = hasRange
            ? lines.slice(availableStart - 1, availableEnd).join('\n')
            : '';
        const outsideContent = start > totalLines || end > totalLines;
        const note = outsideContent
            ? `Der angeforderte Bereich liegt teilweise oder ganz außerhalb `
                + `des Dateiinhalts; vorhanden sind ${totalLines} Zeilen.`
            : null;
        const payload: RangeResultPayload = {
            path: pathCheck.file.relativePath,
            requestedRange: { firstLine: start, lastLine: end },
            readRange: hasRange
                ? { firstLine: availableStart, lastLine: availableEnd }
                : null,
            totalLines,
            text: selectedText,
            actualUtf8Bytes: 0,
            note
        };
        const serialized = serializeRangeResult(payload, true);

        if (
            Buffer.byteLength(
                JSON.stringify({ success: true, content: serialized }),
                'utf8'
            ) > MAX_RANGE_RESULT_BYTES
        ) {
            const tooLargePayload: RangeResultPayload = {
                ...payload,
                readRange: null,
                text: '',
                actualUtf8Bytes: 0,
                note:
                    `Der angeforderte Bereich überschreitet das Bytebudget `
                    + `von ${MAX_RANGE_RESULT_BYTES} UTF-8-Bytes. `
                    + 'Bitte fordere einen kleineren Bereich an.'
            };
            const errorContent = serializeRangeResult(
                tooLargePayload,
                false
            );

            return { success: false, content: errorContent };
        }

        return { success: true, content: serialized };
    } catch (error) {
        return {
            success: false,
            content:
                `Dateibereich konnte nicht gelesen werden: `
                + getErrorMessage(error)
        };
    }
}

export async function listProjectDirectory(
    workspaceUri: vscode.Uri,
    requestedPath: string
): Promise<ToolResult> {
    const directoryPath =
        requestedPath.trim() || '.';

    const pathCheck = checkWorkspacePath(
        workspaceUri,
        directoryPath
    );

    if (
        !pathCheck.allowed
        || !pathCheck.absolutePath
        || !pathCheck.relativePath
    ) {
        return {
            success: false,
            content:
                pathCheck.reason
                ?? 'Der Pfad ist nicht erlaubt.'
        };
    }

    const linkCheck = await checkNoSymlinkInPath(
        workspaceUri,
        pathCheck.relativePath
    );

    if (!linkCheck.allowed) {
        return {
            success: false,
            content: linkCheck.reason ?? 'Der Pfad ist nicht erlaubt.'
        };
    }

    const directoryUri = vscode.Uri.file(
        pathCheck.absolutePath
    );

    try {
        const entries =
            await vscode.workspace.fs.readDirectory(
                directoryUri
            );

        const visibleEntries = entries
            .filter(([, type]) => (
                (type & vscode.FileType.SymbolicLink) === 0
            ))
            .filter(([name]) => {
                const childCheck = checkWorkspacePath(
                    workspaceUri,
                    joinRelativePath(
                        pathCheck.relativePath ?? '.',
                        name
                    )
                );

                return childCheck.allowed;
            })
            .sort(([nameA, typeA], [nameB, typeB]) => {
                const directoryA =
                    typeA === vscode.FileType.Directory
                        ? 0
                        : 1;

                const directoryB =
                    typeB === vscode.FileType.Directory
                        ? 0
                        : 1;

                return (
                    directoryA - directoryB
                    || nameA.localeCompare(
                        nameB,
                        'de'
                    )
                );
            })
            .slice(0, MAX_LIST_ENTRIES);

        const lines = visibleEntries.map(
            ([name, type]) => {
                const prefix =
                    type === vscode.FileType.Directory
                        ? '[Ordner]'
                        : '[Datei] ';

                return `${prefix} ${name}`;
            }
        );

        if (entries.length > MAX_LIST_ENTRIES) {
            lines.push(
                '',
                `Hinweis: Ausgabe auf `
                + `${MAX_LIST_ENTRIES} Einträge begrenzt.`
            );
        }

        return {
            success: true,
            content: [
                `Ordner: ${pathCheck.relativePath}`,
                '',
                ...lines
            ].join('\n')
        };
    } catch (error) {
        return {
            success: false,
            content:
                `Ordner konnte nicht gelesen werden: `
                + getErrorMessage(error)
        };
    }
}

export async function searchProjectText(
    workspaceUri: vscode.Uri,
    searchText: string,
    includePattern = '**/*'
): Promise<ToolResult> {
    const normalizedSearch = searchText.trim();

    if (!normalizedSearch) {
        return {
            success: false,
            content:
                'Es wurde kein Suchtext angegeben.'
        };
    }

    if (normalizedSearch.length > 200) {
        return {
            success: false,
            content:
                'Der Suchtext ist zu lang.'
        };
    }

    const workspaceFolder =
        vscode.workspace.getWorkspaceFolder(workspaceUri);

    const basePattern = workspaceFolder
        ? new vscode.RelativePattern(
            workspaceFolder,
            includePattern
        )
        : new vscode.RelativePattern(
            workspaceUri.fsPath,
            includePattern
        );

    const excludePattern = [
        '**/.git/**',
        '**/node_modules/**',
        '**/vendor/**',
        '**/uploads/**',
        '**/dist/**',
        '**/.vite/**',
        '**/.env',
        '**/.env.*',
        '**/config/db.php',
        '**/db.php',
        '**/config.php'
    ].join(',');

    try {
        const files = await vscode.workspace.findFiles(
            basePattern,
            `{${excludePattern}}`,
            MAX_SEARCH_FILES + 1
        );
        const filesTruncated = files.length > MAX_SEARCH_FILES;
        const orderedFiles = files
            .slice(0, MAX_SEARCH_FILES)
            .map(fileUri => ({
                fileUri,
                relativePath: toRelativePath(workspaceUri, fileUri)
            }))
            .sort((left, right) => left.relativePath < right.relativePath
                ? -1
                : left.relativePath > right.relativePath
                    ? 1
                    : 0);
        const matches: Array<{
            path: string;
            line: number;
            text: string;
            textTruncated: boolean;
        }> = [];
        const lowerSearch =
            normalizedSearch.toLocaleLowerCase('de');

        for (const { fileUri, relativePath } of orderedFiles) {
            const pathCheck = checkWorkspacePath(
                workspaceUri,
                relativePath
            );

            if (!pathCheck.allowed) {
                continue;
            }

            if (!isAllowedTextFilePath(relativePath)) {
                continue;
            }

            const linkCheck = await checkNoSymlinkInPath(
                workspaceUri,
                relativePath
            );

            if (!linkCheck.allowed) {
                continue;
            }

            const stat =
                await vscode.workspace.fs.stat(fileUri);

            if (stat.size > MAX_SEARCH_FILE_SIZE) {
                continue;
            }

            const data =
                await vscode.workspace.fs.readFile(fileUri);

            const content =
                new TextDecoder('utf-8').decode(data);

            if (content.includes('\u0000')) {
                continue;
            }

            const lines = content.split(/\r?\n/);

            for (
                let lineIndex = 0;
                lineIndex < lines.length;
                lineIndex += 1
            ) {
                const line = lines[lineIndex];

                if (
                    line
                        .toLocaleLowerCase('de')
                        .includes(lowerSearch)
                ) {
                    const trimmed = line.trim();
                    const codePoints = Array.from(trimmed);
                    const marker = '…[gekürzt]';
                    const textTruncated =
                        codePoints.length > MAX_SEARCH_MATCH_TEXT_LENGTH;
                    const text = textTruncated
                        ? codePoints
                            .slice(
                                0,
                                MAX_SEARCH_MATCH_TEXT_LENGTH
                                    - Array.from(marker).length
                            )
                            .join('') + marker
                        : trimmed;

                    matches.push({
                        path: relativePath,
                        line: lineIndex + 1,
                        text,
                        textTruncated
                    });

                    if (matches.length > MAX_SEARCH_RESULTS) {
                        break;
                    }
                }
            }

            if (matches.length > MAX_SEARCH_RESULTS) {
                break;
            }
        }

        const hitCountLimited = matches.length > MAX_SEARCH_RESULTS;
        const candidates = matches.slice(0, MAX_SEARCH_RESULTS);
        const emitted: typeof candidates = [];
        let byteLimited = false;
        const truncatedTextCount = candidates.filter(
            match => match.textTruncated
        ).length;

        interface SearchResultPayload {
            query: string;
            hits: typeof candidates;
            emittedHitCount: number;
            truncatedHitCount: number;
            moreHitsAvailable: boolean | 'unknown';
            omittedHitCount: number | null;
            limitTypes: string[];
            byteBudget: number;
            actualUtf8Bytes: number;
        }

        const serialize = (payload: SearchResultPayload): string => {
            // Budget the serialized ToolResult envelope sent to the agent.
            for (let attempt = 0; attempt < 8; attempt += 1) {
                const content = JSON.stringify(payload);
                const actualUtf8Bytes = Buffer.byteLength(
                    JSON.stringify({ success: true, content }),
                    'utf8'
                );

                if (payload.actualUtf8Bytes === actualUtf8Bytes) {
                    return content;
                }
                payload.actualUtf8Bytes = actualUtf8Bytes;
            }

            throw new Error('Die Bytegröße des Suchergebnisses stabilisierte sich nicht.');
        };

        const buildPayload = (
            hits: typeof candidates,
            hasMore: boolean | 'unknown',
            omittedHitCount: number | null,
            limitTypes: string[]
        ): SearchResultPayload => ({
            query: normalizedSearch,
            hits,
            emittedHitCount: hits.length,
            truncatedHitCount: hits.filter(hit => hit.textTruncated).length,
            moreHitsAvailable: hasMore,
            omittedHitCount,
            limitTypes,
            byteBudget: MAX_SEARCH_RESULT_BYTES,
            actualUtf8Bytes: 0
        });

        const limitTypes: string[] = [];
        if (truncatedTextCount > 0) {
            limitTypes.push('per_hit_text');
        }
        if (hitCountLimited) {
            limitTypes.push('hit_count');
        }
        if (filesTruncated) {
            limitTypes.push('file_scan');
        }

        const omittedBeyondCandidates = hitCountLimited || filesTruncated;
        let omittedHitCount: number | null = omittedBeyondCandidates
            ? null
            : 0;
        let moreHitsAvailable: boolean | 'unknown' = hitCountLimited
            ? true
            : filesTruncated
                ? 'unknown'
                : false;

        for (let index = 0; index < candidates.length; index += 1) {
            const nextHits = [...emitted, candidates[index]];
            const probeTypes = [...limitTypes];
            const probe = buildPayload(
                nextHits,
                moreHitsAvailable,
                omittedHitCount,
                probeTypes
            );
            const serializedProbe = serialize(probe);
            const actualBytes = Buffer.byteLength(
                JSON.stringify({
                    success: true,
                    content: serializedProbe
                }),
                'utf8'
            );

            if (actualBytes > MAX_SEARCH_RESULT_BYTES) {
                byteLimited = true;
                break;
            }
            emitted.push(candidates[index]);
        }

        if (byteLimited) {
            limitTypes.push('total_bytes');
            const omittedFromCandidates = candidates.length - emitted.length;
            omittedHitCount = omittedBeyondCandidates
                ? null
                : omittedFromCandidates;
            moreHitsAvailable = true;
        } else if (!omittedBeyondCandidates) {
            omittedHitCount = 0;
            moreHitsAvailable = false;
        }

        let payload = buildPayload(
            emitted,
            moreHitsAvailable,
            omittedHitCount,
            limitTypes
        );
        const content = serialize(payload);
        let actualBytes = Buffer.byteLength(
            JSON.stringify({ success: true, content }),
            'utf8'
        );

        while (actualBytes > MAX_SEARCH_RESULT_BYTES && emitted.length > 0) {
            emitted.pop();
            byteLimited = true;
            if (!limitTypes.includes('total_bytes')) {
                limitTypes.push('total_bytes');
            }
            const omittedFromCandidates = candidates.length - emitted.length;
            omittedHitCount = omittedBeyondCandidates
                ? null
                : omittedFromCandidates;
            moreHitsAvailable = true;
            payload = buildPayload(
                emitted,
                moreHitsAvailable,
                omittedHitCount,
                limitTypes
            );
            const reducedContent = serialize(payload);
            actualBytes = Buffer.byteLength(
                JSON.stringify({ success: true, content: reducedContent }),
                'utf8'
            );
        }

        if (actualBytes > MAX_SEARCH_RESULT_BYTES) {
            throw new Error('Suchergebnis überschreitet trotz Begrenzung das Bytebudget.');
        }

        return { success: true, content: serialize(payload) };
    } catch (error) {
        return {
            success: false,
            content:
                `Suche fehlgeschlagen: `
                + getErrorMessage(error)
        };
    }
}

function joinRelativePath(
    parent: string,
    child: string
): string {
    if (!parent || parent === '.') {
        return child;
    }

    return `${parent.replace(/\/+$/, '')}/${child}`;
}

function toRelativePath(
    workspaceUri: vscode.Uri,
    fileUri: vscode.Uri
): string {
    const workspacePath =
        workspaceUri.fsPath.replaceAll('\\', '/');

    const filePath =
        fileUri.fsPath.replaceAll('\\', '/');

    if (
        filePath.toLowerCase().startsWith(
            workspacePath.toLowerCase() + '/'
        )
    ) {
        return filePath.slice(
            workspacePath.length + 1
        );
    }

    return filePath;
}

function getErrorMessage(
    error: unknown
): string {
    return error instanceof Error
        ? error.message
        : String(error);
}