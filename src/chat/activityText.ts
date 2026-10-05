import type {
    LineRange,
    ToolActivity,
    ToolActivityStatus
} from '../agent/readOnlyAgent.js';

export interface ActivityView extends ToolActivity {
    title: string;
    statusLabel: string;
    details: string[];
}

const STATUS_LABELS: Record<ToolActivityStatus, string> = {
    running: 'läuft',
    success: 'abgeschlossen',
    failed: 'fehlgeschlagen',
    'budget-rejected': 'nicht übernommen (Budget)',
    'repeat-blocked': 'übersprungen'
};

const PROJECT_WIDE_SUFFIX = ' in **/*';

function lineRange(range: LineRange): string {
    return range.firstLine === range.lastLine
        ? `${range.firstLine}`
        : `${range.firstLine}-${range.lastLine}`;
}

function rangeSuffix(activity: ToolActivity): string {
    if (!activity.requestedRange) {
        return '';
    }

    const requested = `Zeilen ${lineRange(activity.requestedRange)} angefragt`;

    if (activity.deliveredRange === undefined) {
        return ` (${requested})`;
    }

    return activity.deliveredRange
        ? ` (${requested}, ${lineRange(activity.deliveredRange)} geliefert)`
        : ` (${requested}, keine Zeilen geliefert)`;
}

function title(activity: ToolActivity): string {
    const { status, target } = activity;
    const running = status === 'running';

    switch (activity.tool) {
        case 'read_file':
            return status === 'success' ? `Datei gelesen: ${target}`
                : running ? `Datei wird gelesen: ${target}`
                : status === 'budget-rejected'
                    ? `Datei wegen Budget nicht übernommen: ${target}`
                : status === 'repeat-blocked'
                    ? `Wiederholtes Lesen übersprungen: ${target}`
                : `Datei nicht gelesen: ${target}`;

        case 'read_file_range': {
            const range = rangeSuffix(activity);
            return status === 'success'
                ? `Dateibereich gelesen: ${target}${range}`
                : running ? `Dateibereich wird gelesen: ${target}${range}`
                : status === 'budget-rejected'
                    ? `Dateibereich wegen Budget nicht übernommen: ${target}${range}`
                : status === 'repeat-blocked'
                    ? `Wiederholtes Lesen übersprungen: ${target}${range}`
                : `Dateibereich nicht gelesen: ${target}${range}`;
        }

        case 'list_directory':
            return status === 'success' ? `Ordner aufgelistet: ${target}`
                : running ? `Ordner wird aufgelistet: ${target}`
                : status === 'budget-rejected'
                    ? `Ordnerliste wegen Budget nicht übernommen: ${target}`
                : status === 'repeat-blocked'
                    ? `Wiederholtes Auflisten übersprungen: ${target}`
                : `Ordner nicht aufgelistet: ${target}`;

        case 'search_text': {
            const projectWide = target.endsWith(PROJECT_WIDE_SUFFIX);
            const what = projectWide
                ? target.slice(0, -PROJECT_WIDE_SUFFIX.length)
                : target;
            const scope = projectWide ? 'Projektweit' : 'Eingeschränkt';
            return status === 'success' ? `${scope} gesucht: ${what}`
                : running ? `${scope} wird gesucht: ${what}`
                : status === 'budget-rejected'
                    ? `Suchergebnis wegen Budget nicht übernommen: ${target}`
                : status === 'repeat-blocked'
                    ? `Suche übersprungen: ${target}`
                : `Suche fehlgeschlagen: ${target}`;
        }

        default:
            return status === 'success'
                ? `Werkzeug ausgeführt: ${activity.tool} ${target}`
                : running ? `Werkzeug läuft: ${activity.tool} ${target}`
                : `Werkzeug nicht übernommen: ${activity.tool} ${target}`;
    }
}

function details(activity: ToolActivity): string[] {
    const lines = [`Werkzeug: ${activity.tool}`];

    if (activity.round !== undefined && activity.maxRounds !== undefined) {
        lines.push(
            activity.round > 0
                ? `Modellschritt ${activity.round} von ${activity.maxRounds}; `
                    + 'zählt zum Schrittlimit, auch wenn der Aufruf '
                    + 'unterbunden oder abgewiesen wird. Mehrere Aufrufe '
                    + 'derselben Modellantwort teilen sich einen Schritt.'
                : 'Vorab gelesene Datei; zählt nicht zum Schrittlimit.'
        );
    }

    lines.push(`Status: ${STATUS_LABELS[activity.status]}`);

    if (activity.requestedRange) {
        lines.push(`Angefordert: Zeilen ${lineRange(activity.requestedRange)}`);
    }
    if (activity.deliveredRange !== undefined) {
        lines.push(
            activity.deliveredRange
                ? `Geliefert: Zeilen ${lineRange(activity.deliveredRange)}`
                : 'Geliefert: keine Zeilen'
        );
    }
    if (activity.reason) {
        lines.push(`Grund: ${activity.reason}`);
    }
    if (
        Number.isFinite(activity.requestBytesAdded)
        && Number.isFinite(activity.hypotheticalRequestBytes)
    ) {
        lines.push(
            `Zusätzliche Request-Bytes: ${activity.requestBytesAdded}; `
            + `hypothetische Gesamtgröße: ${activity.hypotheticalRequestBytes} Bytes`
        );
    }

    return lines;
}

// Nur beobachtete Werkzeugereignisse; keine Modellgedanken, keine Inhalte.
export function describeActivity(activity: ToolActivity): ActivityView {
    return {
        ...activity,
        title: title(activity),
        statusLabel: STATUS_LABELS[activity.status] ?? 'Status unbekannt',
        details: details(activity)
    };
}
