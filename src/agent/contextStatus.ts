// Laufbezogene Übersicht für das Modell: nur Metadaten dessen, was tatsächlich
// in den Anfragekontext übernommen wurde. Keine Dateiinhalte, nichts erfunden.

export interface StatusRange {
    firstLine: number;
    lastLine: number;
}

export interface ContextLedger {
    fullFiles: string[];
    ranges: Map<string, StatusRange[]>;
    searches: Array<{ query: string; include: string; hits: number | undefined }>;
    rejected: string[];
}

export const MAX_CONTEXT_STATUS_BYTES = 1_500;
const MAX_LISTED = 6;
const MAX_QUERY_LENGTH = 60;

export function createContextLedger(): ContextLedger {
    return { fullFiles: [], ranges: new Map(), searches: [], rejected: [] };
}

function stringArg(args: Record<string, unknown>, key: string, fallback = ''): string {
    const value = args[key];
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function mergeRanges(ranges: readonly StatusRange[]): StatusRange[] {
    const sorted = [...ranges].sort((a, b) => a.firstLine - b.firstLine);
    const merged: StatusRange[] = [];
    for (const range of sorted) {
        const last = merged[merged.length - 1];
        if (last && range.firstLine <= last.lastLine + 1) {
            last.lastLine = Math.max(last.lastLine, range.lastLine);
        } else {
            merged.push({ ...range });
        }
    }
    return merged;
}

// Zeilen von `requested`, die in `existing` noch nicht geliefert wurden.
export function newLinesOutside(
    requested: StatusRange,
    existing: readonly StatusRange[]
): number {
    let covered = 0;
    for (const range of mergeRanges(existing)) {
        const first = Math.max(range.firstLine, requested.firstLine);
        const last = Math.min(range.lastLine, requested.lastLine);
        if (first <= last) {
            covered += last - first + 1;
        }
    }
    return requested.lastLine - requested.firstLine + 1 - covered;
}

// Wird nur für an das Modell übernommene Ergebnisse aufgerufen.
export function recordForwardedResult(
    ledger: ContextLedger,
    toolName: string,
    args: Record<string, unknown>,
    success: boolean,
    resultContent: string
): void {
    if (!success) {
        return;
    }
    if (toolName === 'read_file') {
        const file = stringArg(args, 'path');
        if (file && !ledger.fullFiles.includes(file)) {
            ledger.fullFiles.push(file);
        }
        return;
    }
    let parsed: Record<string, unknown> | undefined;
    try {
        parsed = JSON.parse(resultContent) as Record<string, unknown>;
    } catch {
        parsed = undefined;
    }
    if (toolName === 'read_file_range') {
        const range = parsed?.readRange as StatusRange | null | undefined;
        const file = typeof parsed?.path === 'string' ? parsed.path : undefined;
        if (
            file && range
            && typeof range.firstLine === 'number'
            && typeof range.lastLine === 'number'
        ) {
            const list = ledger.ranges.get(file) ?? [];
            list.push({ firstLine: range.firstLine, lastLine: range.lastLine });
            ledger.ranges.set(file, list);
        }
        return;
    }
    if (toolName === 'search_text') {
        const hits = typeof parsed?.emittedHitCount === 'number'
            ? parsed.emittedHitCount
            : undefined;
        ledger.searches.push({
            query: stringArg(args, 'query'),
            include: stringArg(args, 'include', '**/*'),
            hits
        });
    }
}

export function recordRejected(ledger: ContextLedger, target: string): void {
    if (target && !ledger.rejected.includes(target)) {
        ledger.rejected.push(target);
    }
}

function limited(items: string[], label: string): string[] {
    const shown = items.slice(0, MAX_LISTED);
    const more = items.length - shown.length;
    return more > 0
        ? [...shown, `… und ${more} weitere ${label} hier nicht aufgeführt`]
        : shown;
}

export function isLedgerEmpty(ledger: ContextLedger): boolean {
    return ledger.fullFiles.length === 0
        && ledger.ranges.size === 0
        && ledger.searches.length === 0
        && ledger.rejected.length === 0;
}

// Gekürzt wird nur diese Übersicht, und nur sichtbar („… weitere“).
// Passt sie nicht in `maxBytes`, liefert die Funktion undefined.
export function formatContextStatus(
    ledger: ContextLedger,
    round: number,
    maxRounds: number,
    maxBytes = MAX_CONTEXT_STATUS_BYTES
): string | undefined {
    if (isLedgerEmpty(ledger)) {
        return undefined;
    }
    const lines = [
        'Kontextstatus dieses Laufs (automatische Übersicht, nur Metadaten; '
        + 'Inhalte stehen in den Werkzeugergebnissen oben):',
        `- Modellschritt ${round} von ${maxRounds}; danach noch `
        + `${Math.max(0, maxRounds - round)} Schritte mit Werkzeugen.`
    ];
    if (ledger.fullFiles.length > 0) {
        lines.push(
            '- Vollständig übermittelt: '
            + limited(ledger.fullFiles, 'Dateien').join(', ')
        );
    }
    if (ledger.ranges.size > 0) {
        const entries = [...ledger.ranges.entries()].map(([file, list]) =>
            `${file} Zeilen ${mergeRanges(list)
                .map(r => `${r.firstLine}-${r.lastLine}`).join(', ')}`
        );
        lines.push(
            '- Zeilenbereiche übermittelt: ' + limited(entries, 'Dateien').join('; ')
        );
    }
    if (ledger.searches.length > 0) {
        const entries = ledger.searches.map(s => {
            const query = Array.from(s.query).length > MAX_QUERY_LENGTH
                ? Array.from(s.query).slice(0, MAX_QUERY_LENGTH).join('') + '…'
                : s.query;
            return `"${query}" in ${s.include}: `
                + (s.hits === undefined ? 'Trefferzahl unbekannt' : `${s.hits} Treffer`);
        });
        lines.push('- Suchen: ' + limited(entries, 'Suchen').join('; '));
    }
    if (ledger.rejected.length > 0) {
        lines.push(
            '- Wegen Budget nicht übermittelt (kein Beleg): '
            + limited(ledger.rejected, 'Ziele').join(', ')
        );
    }
    lines.push(
        '- Nur übermittelte Inhalte sind Belege; Suchtreffer belegen nur ihre Zeile.'
    );
    const text = lines.join('\n');
    return Buffer.byteLength(text, 'utf8') <= maxBytes ? text : undefined;
}
