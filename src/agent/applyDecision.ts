import * as vscode from 'vscode';
import {
    checkNoSymlinkInPath,
    checkWorkspacePath
} from '../safety/pathPolicy.js';
import { isAllowedTextFilePath } from '../tools/readTools.js';
import type { PreparedPreview } from './diffPreview.js';

const MAX_APPLY_SIZE = 120_000;

export type Approval = 'approved' | 'rejected' | 'cancelled';

export type ApplyDecision =
    | { eligible: true; relativePath: string; content: string }
    | { eligible: false; reason: string };

/** Von außen injizierter Schreiber; dieses Modul schreibt selbst nie. */
export interface ChangeWriter {
    write(relativePath: string, content: string): Promise<void>;
}

/**
 * Prüft rein lesend, ob eine spätere Anwendung zulässig wäre.
 * Eine Nutzerfreigabe wird hier absichtlich nicht bewertet.
 *
 * Grenze: Prüfung und ein späteres Schreiben sind getrennte Schritte.
 * Diese Entscheidung beweist weder einen sicheren Schreibpfad noch
 * Atomarität zwischen Prüfung und Schreiben.
 */
export async function decideApply(
    workspaceUri: vscode.Uri | undefined,
    preview: Extract<PreparedPreview, { ok: true }>
): Promise<ApplyDecision> {
    const deny = (reason: string): ApplyDecision => ({ eligible: false, reason });

    try {
        if (!workspaceUri) {
            return deny('Kein Projektordner geöffnet.');
        }

        const pathCheck = checkWorkspacePath(
            workspaceUri,
            preview.relativePath
        );

        if (
            !pathCheck.allowed
            || !pathCheck.absolutePath
            || pathCheck.relativePath !== preview.relativePath
        ) {
            return deny(pathCheck.reason ?? 'Der Pfad ist nicht erlaubt.');
        }

        if (!isAllowedTextFilePath(pathCheck.relativePath)) {
            return deny('Der Dateityp ist nicht als Textdatei freigegeben.');
        }

        const linkCheck = await checkNoSymlinkInPath(
            workspaceUri,
            pathCheck.relativePath
        );

        if (!linkCheck.allowed) {
            return deny(linkCheck.reason ?? 'Der Pfad ist nicht erlaubt.');
        }

        if (preview.proposed.length > MAX_APPLY_SIZE) {
            return deny('Der vorgeschlagene Text ist zu groß.');
        }

        const fileUri = vscode.Uri.file(pathCheck.absolutePath);
        const stat = await vscode.workspace.fs.stat(fileUri);

        if ((stat.type & vscode.FileType.File) !== vscode.FileType.File) {
            return deny('Das Ziel ist keine reguläre Datei.');
        }

        const current = await vscode.workspace.fs.readFile(fileUri);

        if (!sameBytes(current, preview.originalBytes)) {
            return deny(
                'Die Originaldatei wurde seit der Vorschau verändert. '
                + 'Bitte erstelle eine neue Vorschau.'
            );
        }

        return {
            eligible: true,
            relativePath: pathCheck.relativePath,
            content: preview.proposed
        };
    } catch {
        return deny('Die Anwendung konnte nicht sicher geprüft werden.');
    }
}

/**
 * Test-Hilfsfunktion für einen injizierten Fake-Writer; kein produktiver
 * Schreibpfad. "approved" ist nur die Angabe des Aufrufers und beweist
 * keine tatsächliche Nutzeraktion.
 */
export async function applyIfApproved(
    workspaceUri: vscode.Uri | undefined,
    preview: Extract<PreparedPreview, { ok: true }>,
    approval: Approval | undefined,
    writer: ChangeWriter
): Promise<ApplyDecision> {
    if (approval !== 'approved') {
        return { eligible: false, reason: 'Keine Freigabe angegeben.' };
    }

    const decision = await decideApply(workspaceUri, preview);

    if (decision.eligible) {
        await writer.write(decision.relativePath, decision.content);
    }

    return decision;
}

function sameBytes(a: Uint8Array, b: readonly number[]): boolean {
    if (a.length !== b.length) {
        return false;
    }

    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }

    return true;
}
