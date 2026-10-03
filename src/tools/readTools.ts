import * as vscode from 'vscode';
import {
    checkWorkspacePath
} from '../safety/pathPolicy.js';

const MAX_FILE_SIZE = 120_000;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 40;
const MAX_SEARCH_FILE_SIZE = 250_000;

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

export interface ToolResult {
    success: boolean;
    content: string;
}

export async function readProjectFile(
    workspaceUri: vscode.Uri,
    requestedPath: string
): Promise<ToolResult> {
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

    const fileUri = vscode.Uri.file(
        pathCheck.absolutePath
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
                    `"${pathCheck.relativePath}" ist ein Ordner. `
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

        const extension = getExtension(
            pathCheck.relativePath
        );

        if (
            extension
            && !ALLOWED_TEXT_EXTENSIONS.has(extension)
        ) {
            return {
                success: false,
                content:
                    `Der Dateityp "${extension}" `
                    + 'ist nicht als Textdatei freigegeben.'
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
                `Datei: ${pathCheck.relativePath}`,
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

    const directoryUri = vscode.Uri.file(
        pathCheck.absolutePath
    );

    try {
        const entries =
            await vscode.workspace.fs.readDirectory(
                directoryUri
            );

        const visibleEntries = entries
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
            500
        );

        const results: string[] = [];
        const lowerSearch =
            normalizedSearch.toLocaleLowerCase('de');

        for (const fileUri of files) {
            if (results.length >= MAX_SEARCH_RESULTS) {
                break;
            }

            const relativePath =
                toRelativePath(
                    workspaceUri,
                    fileUri
                );

            const pathCheck = checkWorkspacePath(
                workspaceUri,
                relativePath
            );

            if (!pathCheck.allowed) {
                continue;
            }

            const extension =
                getExtension(relativePath);

            if (
                extension
                && !ALLOWED_TEXT_EXTENSIONS.has(extension)
            ) {
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
                if (results.length >= MAX_SEARCH_RESULTS) {
                    break;
                }

                const line = lines[lineIndex];

                if (
                    line
                        .toLocaleLowerCase('de')
                        .includes(lowerSearch)
                ) {
                    results.push(
                        `${relativePath}:`
                        + `${lineIndex + 1}: `
                        + line.trim().slice(0, 300)
                    );
                }
            }
        }

        if (results.length === 0) {
            return {
                success: true,
                content:
                    `Keine Treffer für `
                    + `"${normalizedSearch}" gefunden.`
            };
        }

        const limited =
            results.length >= MAX_SEARCH_RESULTS;

        return {
            success: true,
            content: [
                `Suchtext: ${normalizedSearch}`,
                `Treffer: ${results.length}`,
                '',
                ...results,
                ...(limited
                    ? [
                        '',
                        'Hinweis: Die Ausgabe wurde '
                        + 'auf 40 Treffer begrenzt.'
                    ]
                    : [])
            ].join('\n')
        };
    } catch (error) {
        return {
            success: false,
            content:
                `Suche fehlgeschlagen: `
                + getErrorMessage(error)
        };
    }
}

function getExtension(
    filePath: string
): string {
    const lastDot = filePath.lastIndexOf('.');

    if (lastDot < 0) {
        return '';
    }

    return filePath
        .slice(lastDot)
        .toLowerCase();
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