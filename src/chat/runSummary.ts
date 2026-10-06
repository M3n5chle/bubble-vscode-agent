import {
    AgentRepeatLoopError,
    AgentStepLimitError,
    RequestTooLargeError,
    type ToolActivity
} from '../agent/readOnlyAgent.js';
import { ChatModeLimitError, ChatWorkflowCancelledError } from './chatSession.js';
import { describeActivity } from './activityText.js';

export type RunOutcome = 'success' | 'partial' | 'aborted' | 'failed';

const OUTCOME_LABELS: Record<RunOutcome, string> = {
    success: 'erfolgreich',
    partial: 'teilweise',
    aborted: 'abgebrochen',
    failed: 'fehlgeschlagen'
};

const MAX_LISTED = 6;

function titles(activities: readonly ToolActivity[]): string[] {
    const listed = activities.slice(0, MAX_LISTED)
        .map(activity => `- ${describeActivity(activity).title}`);
    if (activities.length > MAX_LISTED) {
        listed.push(`- … und ${activities.length - MAX_LISTED} weitere (siehe Aktivitätsverlauf)`);
    }
    return listed;
}

// Laufende Statuszeile ausschließlich aus beobachteten Aktivitäten; Budget-
// und Fehlerereignisse bleiben sichtbar und werden nicht überschrieben.
export function liveStatusLine(
    status: string,
    activities: readonly ToolActivity[]
): string {
    const running = [...activities].reverse()
        .find(activity => activity.status === 'running');
    const base = running
        ? describeActivity(running).title
        : (status || 'Analyse läuft ...');
    const count = (wanted: ToolActivity['status']) =>
        activities.filter(activity => activity.status === wanted).length;
    const notes: string[] = [];
    if (count('budget-rejected') > 0) {
        notes.push(`Budgetgrenze: ${count('budget-rejected')} Aufruf(e) nicht übernommen`);
    }
    if (count('failed') > 0) {
        notes.push(`${count('failed')} Aufruf(e) fehlgeschlagen`);
    }
    if (count('repeat-blocked') > 0) {
        notes.push(`${count('repeat-blocked')} Aufruf(e) übersprungen`);
    }
    return notes.length > 0 ? `${base} (${notes.join('; ')})` : base;
}

export function classifyRun(
    activities: readonly ToolActivity[],
    error?: unknown
): RunOutcome {
    const succeeded = activities.some(activity => activity.status === 'success');
    const problems = activities.some(activity =>
        activity.status !== 'success');

    if (error === undefined) {
        return problems ? 'partial' : 'success';
    }
    if (error instanceof AgentStepLimitError
        || error instanceof AgentRepeatLoopError) {
        return succeeded ? 'partial' : 'failed';
    }
    if (error instanceof RequestTooLargeError
        || error instanceof ChatModeLimitError
        || error instanceof ChatWorkflowCancelledError) {
        return 'aborted';
    }
    return 'failed';
}

function reasonFor(error: unknown): string | undefined {
    if (error === undefined) {
        return undefined;
    }
    if (error instanceof AgentStepLimitError) {
        return 'Das Limit von acht Modellschritten wurde erreicht.';
    }
    if (error instanceof AgentRepeatLoopError) {
        return 'Wiederholte Aufrufe wurden beendet.';
    }
    if (error instanceof RequestTooLargeError || error instanceof ChatModeLimitError) {
        return 'Eine Budget- oder Kontextgrenze wurde erreicht.';
    }
    if (error instanceof ChatWorkflowCancelledError) {
        return 'Der Ablauf wurde vor der Ausführung abgebrochen.';
    }
    return 'Ein Fehler ist aufgetreten (siehe Fehlermeldung).';
}

// Kompakte Zusammenfassung nur aus dem Aktivitätsverlauf und dem
// Ausgang des Laufs; keine Inhalte, keine erfundenen Ergebnisse.
export function summarizeRun(
    rawActivities: readonly ToolActivity[],
    error?: unknown
): string {
    // Am Ende noch laufende Aufrufe sind nicht abgeschlossen worden.
    const activities = rawActivities.map(activity =>
        activity.status === 'running'
            ? { ...activity, status: 'failed' as const }
            : activity);
    const outcome = classifyRun(activities, error);
    const done = activities.filter(activity => activity.status === 'success');
    const notDone = activities.filter(activity => activity.status !== 'success');
    const lines = [`Zusammenfassung: ${OUTCOME_LABELS[outcome]}`];

    lines.push(done.length > 0
        ? `Ausgeführt (${done.length}):`
        : 'Ausgeführt: keine erfolgreichen Werkzeugaufrufe.');
    lines.push(...titles(done));

    if (notDone.length > 0) {
        lines.push(`Nicht ausgeführt oder abgewiesen (${notDone.length}):`);
        lines.push(...titles(notDone));
    }

    const open: string[] = [];
    const reason = reasonFor(error);
    if (reason) {
        open.push(reason);
    }
    if (notDone.some(activity => activity.status === 'budget-rejected')) {
        open.push('Abgewiesene Aufrufe wurden nicht an das Modell übermittelt.');
    }
    if (!done.some(activity =>
        activity.tool === 'read_file' || activity.tool === 'read_file_range')) {
        open.push('Es wurde keine Datei oder kein Dateibereich gelesen.');
    }
    if (open.length > 0) {
        lines.push('Offen:');
        lines.push(...open.map(item => `- ${item}`));
    }

    lines.push('Bubble hat keine Dateien geändert (nur lesender Zugriff).');
    return lines.join('\n');
}
