import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import {
    checkNoSymlinkInPath,
    checkWorkspacePath
} from '../safety/pathPolicy.js';
import { isAllowedTextFilePath } from '../tools/readTools.js';
import type { PreparedPreview, ShownPreview } from './diffPreview.js';

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

        const dirty = vscode.workspace.textDocuments.some(
            document => document.uri.scheme === 'file'
                && document.isDirty
                && document.uri.fsPath === fileUri.fsPath
        );

        if (dirty) {
            return deny(
                `"${pathCheck.relativePath}" hat ungespeicherte Änderungen `
                + 'im Editor. Es wird keine Freigabe erfasst; bitte speichere '
                + 'oder verwirf sie und erstelle eine neue Vorschau.'
            );
        }

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

declare const receiptBrand: unique symbol;

/**
 * Nur von recordSimulatedDecision ausgestellt und zur Laufzeit gegen eine
 * modulinterne Registry geprüft. Er belegt eine Zustimmung im modalen
 * Dialog zu genau diesem Vorschlag; nicht, dass der Diff gelesen wurde.
 */
export interface ApprovalReceipt {
    readonly [receiptBrand]: true;
    readonly fingerprint: string;
}

const issuedReceipts = new WeakMap<object, { fingerprint: string; used: boolean }>();

function issueReceipt(fingerprint: string): ApprovalReceipt {
    const receipt = Object.freeze({ fingerprint }) as unknown as ApprovalReceipt;
    issuedReceipts.set(receipt, { fingerprint, used: false });
    return receipt;
}

/**
 * Test-Hilfsfunktion für einen injizierten Fake-Writer; kein produktiver
 * Schreibpfad. Ohne gültigen, unverbrauchten Beleg zu genau dem übergebenen
 * Vorschlag wird nie geschrieben. Der Beleg wird bei erster gültiger
 * Verwendung verbraucht. Prüfung und Schreiben sind nicht atomar.
 */
export async function applyIfApproved(
    workspaceUri: vscode.Uri | undefined,
    shown: ShownPreview,
    receipt: ApprovalReceipt | undefined,
    writer: ChangeWriter
): Promise<ApplyDecision> {
    const deny = (reason: string): ApplyDecision => ({ eligible: false, reason });
    const entry = receipt && typeof receipt === 'object'
        ? issuedReceipts.get(receipt)
        : undefined;

    if (!receipt || !entry) {
        return deny('Keine gültige Freigabe angegeben.');
    }

    if (entry.used) {
        return deny('Die Freigabe wurde bereits verwendet.');
    }

    if (entry.fingerprint !== fingerprintPreview(shown.preview)) {
        return deny('Die Freigabe gehört zu einem anderen Vorschlag.');
    }

    entry.used = true;

    if (!isShown(shown)) {
        return deny('Der Diff ist nicht mehr geöffnet.');
    }

    const decision = await decideApply(workspaceUri, shown.preview);

    if (decision.eligible && isShown(shown)) {
        await writer.write(decision.relativePath, decision.content);
        return decision;
    }

    return decision.eligible ? deny('Der Diff ist nicht mehr geöffnet.') : decision;
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

export const APPROVE_LABEL = 'Vorschlag freigeben';
export const REJECT_LABEL = 'Ablehnen';
export const SIMULATED_APPROVAL_MESSAGE =
    'Freigabe erfasst; Änderung nicht angewendet.';

export type SimulatedOutcome =
    | { status: 'recorded'; fingerprint: string; message: string; receipt: ApprovalReceipt }
    | {
        status: 'rejected' | 'cancelled' | 'not-shown' | 'stale' | 'ineligible';
        reason: string;
    };

export type ApprovalPrompt = (
    preview: Extract<PreparedPreview, { ok: true }>
) => Thenable<Approval | undefined>;

/** Kennung genau dieses Vorschlags (Pfad, Originalbytes, Vorschlagstext). */
export function fingerprintPreview(
    preview: Extract<PreparedPreview, { ok: true }>
): string {
    return createHash('sha256')
        .update(JSON.stringify([
            preview.relativePath,
            preview.originalBytes,
            preview.proposed
        ]))
        .digest('hex');
}

function isShown(shown: ShownPreview): boolean {
    const right = shown.right.toString();
    const open = vscode.window.tabGroups.all
        .flatMap(group => group.tabs)
        .some(tab =>
            tab.input instanceof vscode.TabInputTextDiff
            && tab.input.modified.toString() === right
        );

    return open && vscode.workspace.textDocuments.some(
        document => document.uri.toString() === right
            && document.getText() === shown.preview.proposed
    );
}

async function defaultPrompt(
    preview: Extract<PreparedPreview, { ok: true }>
): Promise<Approval | undefined> {
    const choice = await vscode.window.showInformationMessage(
        `Bubble: Vorschlag für "${preview.relativePath}" freigeben?`,
        {
            modal: true,
            detail:
                'Simulation: Es wird keine Datei geändert und kein '
                + 'Schreibvorgang ausgelöst.'
        },
        APPROVE_LABEL,
        REJECT_LABEL
    );

    if (choice === APPROVE_LABEL) {
        return 'approved';
    }

    return choice === REJECT_LABEL ? 'rejected' : 'cancelled';
}

/**
 * Erfasst eine ausdrückliche Entscheidung zum angezeigten Vorschlag.
 * Reine Simulation: Es gibt keinen Writer und keinen Schreibaufruf.
 * Eine Freigabe entsteht nur, wenn der Diff noch offen ist und Vorschlag
 * sowie Originaldatei nach der Eingabe unverändert zur Anzeige passen.
 */
export async function recordSimulatedDecision(
    workspaceUri: vscode.Uri | undefined,
    shown: ShownPreview,
    prompt: ApprovalPrompt = defaultPrompt
): Promise<SimulatedOutcome> {
    const preview = shown.preview;
    const fingerprint = fingerprintPreview(preview);

    if (!isShown(shown)) {
        return { status: 'not-shown', reason: 'Der Diff ist nicht mehr geöffnet.' };
    }

    const before = await decideApply(workspaceUri, preview);

    if (!before.eligible) {
        return { status: 'ineligible', reason: before.reason };
    }

    const approval = await prompt(preview);

    if (approval === 'rejected') {
        return { status: 'rejected', reason: 'Vorschlag abgelehnt.' };
    }

    if (approval !== 'approved') {
        return { status: 'cancelled', reason: 'Keine Entscheidung getroffen.' };
    }

    const after = await decideApply(workspaceUri, preview);

    if (
        !isShown(shown)
        || !after.eligible
        || fingerprintPreview(preview) !== fingerprint
    ) {
        return {
            status: 'stale',
            reason: !after.eligible
                ? after.reason
                : 'Der Vorschlag wurde nicht mehr unverändert angezeigt. '
                    + 'Keine Freigabe erfasst.'
        };
    }

    return {
        status: 'recorded',
        fingerprint,
        message: SIMULATED_APPROVAL_MESSAGE,
        receipt: issueReceipt(fingerprint)
    };
}

/** Zeigt das Ergebnis; ändert nie eine Datei. */
export function reportSimulatedOutcome(outcome: SimulatedOutcome): void {
    if (outcome.status === 'recorded') {
        void vscode.window.showInformationMessage(`Bubble: ${outcome.message}`);
    } else if (outcome.status === 'rejected' || outcome.status === 'cancelled') {
        void vscode.window.showInformationMessage(`Bubble: ${outcome.reason}`);
    } else {
        void vscode.window.showErrorMessage(`Bubble: ${outcome.reason}`);
    }
}