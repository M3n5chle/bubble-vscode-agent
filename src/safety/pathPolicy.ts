import * as path from 'node:path';
import * as vscode from 'vscode';

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

export interface PathCheckResult {
    allowed: boolean;
    absolutePath?: string;
    relativePath?: string;
    reason?: string;
}

export function checkWorkspacePath(
    workspaceUri: vscode.Uri,
    requestedPath: string
): PathCheckResult {
    const cleanedPath = requestedPath
        .trim()
        .replaceAll('\\', '/')
        .replace(/^\.\/+/, '');

    if (!cleanedPath) {
        return {
            allowed: false,
            reason: 'Es wurde kein Pfad angegeben.'
        };
    }

    if (path.isAbsolute(cleanedPath)) {
        return {
            allowed: false,
            reason:
                'Absolute Pfade sind nicht erlaubt. '
                + 'Verwende einen Pfad relativ zum Projekt.'
        };
    }

    const normalizedRelativePath = path.posix.normalize(
        cleanedPath
    );

    if (
        normalizedRelativePath === '..'
        || normalizedRelativePath.startsWith('../')
    ) {
        return {
            allowed: false,
            reason:
                'Der Pfad darf den Projektordner '
                + 'nicht verlassen.'
        };
    }

    const lowerRelativePath =
        normalizedRelativePath.toLowerCase();

    if (BLOCKED_RELATIVE_PATHS.has(lowerRelativePath)) {
        return {
            allowed: false,
            reason:
                `Der sensible Pfad "${normalizedRelativePath}" `
                + 'ist gesperrt.'
        };
    }

    const pathParts = lowerRelativePath.split('/');

    for (const part of pathParts) {
        if (BLOCKED_DIRECTORIES.has(part)) {
            return {
                allowed: false,
                reason:
                    `Der Ordner "${part}" ist für den Agenten `
                    + 'gesperrt.'
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
            reason:
                `Die sensible Datei "${fileName}" `
                + 'ist gesperrt.'
        };
    }

    const fileUri = vscode.Uri.joinPath(
        workspaceUri,
        ...normalizedRelativePath.split('/')
    );

    const workspacePath = normalizeAbsolutePath(
        workspaceUri.fsPath
    );

    const requestedAbsolutePath = normalizeAbsolutePath(
        fileUri.fsPath
    );

    const workspacePrefix =
        workspacePath.endsWith(path.sep)
            ? workspacePath
            : workspacePath + path.sep;

    if (
        requestedAbsolutePath !== workspacePath
        && !requestedAbsolutePath.startsWith(
            workspacePrefix
        )
    ) {
        return {
            allowed: false,
            reason:
                'Der aufgelöste Pfad liegt außerhalb '
                + 'des geöffneten Projekts.'
        };
    }

    return {
        allowed: true,
        absolutePath: fileUri.fsPath,
        relativePath: normalizedRelativePath
    };
}

export function isBlockedRelativePath(
    relativePath: string
): boolean {
    return !checkWorkspacePath(
        vscode.Uri.file(path.parse(process.cwd()).root),
        relativePath
    ).allowed;
}

function normalizeAbsolutePath(
    value: string
): string {
    const normalized = path.resolve(value);

    return process.platform === 'win32'
        ? normalized.toLowerCase()
        : normalized;
}