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
    | { apply: true; relativePath: string; content: string }
    | { apply: false; reason: string };

/** Von außen injizierter Schreiber; dieses Modul schreibt selbst nie. */
export interface ChangeWriter {
    write(relativePath: string, content: string): Promise<void>;
}

/**
 * Bewertet nur, ob eine spätere Anwendung zulässig wäre. Rein lesend.
 * Jeder Zweifel, jede Ablehnung und jeder Fehler ergibt "nicht anwenden".
 *
 * Grenze: Prüfung und ein späteres Schreiben sind getrennte Schritte.
 * Diese Entscheidung beweist weder einen sicheren Schreibpfad noch
 * Atomarität zwischen Prüfung und Schreiben.
 */
export async function decideApply(
    workspaceUri: vscode.Uri | undefined,
    preview: Extract<PreparedPreview, { ok: true }>,
    approval: Approval | undefined
): Promise<ApplyDecision> {
    const deny = (reason: string): ApplyDecision => ({ apply: false, reason });

    if (approval !== 'approved') {
        return deny('Keine ausdrückliche Freigabe.');
    }

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
            apply: true,
            relativePath: pathCheck.relativePath,
            content: preview.proposed
        };
    } catch {
        return deny('Die Anwendung konnte nicht sicher geprüft werden.');
    }
}

/** Ruft den Writer nur bei positiver Entscheidung genau einmal auf. */
export async function applyIfApproved(
    workspaceUri: vscode.Uri | undefined,
    preview: Extract<PreparedPreview, { ok: true }>,
    approval: Approval | undefined,
    writer: ChangeWriter
): Promise<ApplyDecision> {
    const decision = await decideApply(workspaceUri, preview, approval);

    if (decision.apply) {
        await writer.write(decision.relativePath, decision.content);
    }

    return decision;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
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
