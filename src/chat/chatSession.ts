import {
    AgentCancelledError,
    RequestTooLargeError,
    formatEvidence,
    type AgentResult,
    type ConversationTurn
} from '../agent/readOnlyAgent.js';

export type ChatEntryKind =
    'user' | 'answer' | 'evidence' | 'error' | 'limit' | 'info'
    | 'system' | 'systemError';

export interface ChatEntry {
    kind: ChatEntryKind;
    text: string;
}

export interface ChatState {
    entries: ChatEntry[];
    busy: boolean;
    status: string;
}

export type AgentRunner = (
    question: string,
    history: readonly ConversationTurn[],
    onStatus: (status: string) => void,
    signal: AbortSignal
) => Promise<AgentResult>;

export const MAX_QUESTION_LENGTH = 4_000;

// Eigener, rein lesender Gesprächszustand; nutzt ausschließlich den
// bestehenden Agenten über den übergebenen Runner.
export class ChatSession {
    private history: ConversationTurn[] = [];
    private entries: ChatEntry[] = [];
    private status = '';
    private controller: AbortController | undefined;

    constructor(
        private readonly runner: AgentRunner,
        private readonly onChange: (state: ChatState) => void = () => {}
    ) {}

    get state(): ChatState {
        return {
            entries: this.entries.slice(),
            busy: this.controller !== undefined,
            status: this.status
        };
    }

    get turnCount(): number {
        return this.history.length;
    }

    addSystemCheckResult(output: string): void {
        this.push('system', output);
    }

    addSystemCheckError(message: string): void {
        this.push('systemError', message);
    }

    async ask(rawQuestion: unknown): Promise<void> {
        if (typeof rawQuestion !== 'string') {
            return;
        }

        const question = rawQuestion.trim();

        if (!question) {
            return;
        }

        if (this.controller) {
            this.push('info', 'Es läuft bereits eine Analyse. Bitte '
                + 'warten oder „Beenden“ wählen.');
            return;
        }

        if (question.length > MAX_QUESTION_LENGTH) {
            this.push('error', 'Die Frage ist zu lang (höchstens '
                + `${MAX_QUESTION_LENGTH} Zeichen).`);
            return;
        }

        const controller = new AbortController();
        this.controller = controller;
        const earlier = this.history.slice();

        this.entries.push({ kind: 'user', text: question });
        this.setStatus('Analyse wird vorbereitet ...');

        try {
            const result = await this.runner(
                question,
                earlier,
                status => {
                    if (this.controller === controller) {
                        this.setStatus(status);
                    }
                },
                controller.signal
            );

            if (controller.signal.aborted) {
                return;
            }

            this.history.push({
                question,
                answer: result.answer,
                evidence: result.evidence,
                omitted: result.omitted
            });
            this.entries.push(
                { kind: 'answer', text: result.answer || '(keine Antwort)' },
                {
                    kind: 'evidence',
                    text: formatEvidence(
                        result.evidence, result.omitted, earlier
                    )
                }
            );
        } catch (error) {
            if (controller.signal.aborted
                || error instanceof AgentCancelledError) {
                return;
            }

            if (error instanceof RequestTooLargeError) {
                this.entries.push({
                    kind: 'limit',
                    text: error.message + (earlier.length > 0
                        ? ' Der bisherige Gesprächsverlauf bleibt '
                            + 'erhalten: Stelle eine kleinere Rückfrage '
                            + 'oder wähle „Gespräch zurücksetzen“.'
                        : ' Bitte formuliere die Frage enger.')
                });
            } else {
                this.entries.push({
                    kind: 'error',
                    text: error instanceof Error
                        ? error.message
                        : String(error)
                });
            }
        } finally {
            if (this.controller === controller) {
                this.controller = undefined;
                this.status = '';
                this.emit();
            }
        }
    }

    reset(): void {
        this.cancelRunning();
        this.history = [];
        this.entries = [{
            kind: 'info',
            text: 'Gespräch zurückgesetzt. Der bisherige Verlauf '
                + 'wurde verworfen.'
        }];
        this.status = '';
        this.emit();
    }

    end(): void {
        this.cancelRunning();
        this.history = [];
        this.entries = [{
            kind: 'info',
            text: 'Gespräch beendet. Eine neue Frage startet ein '
                + 'neues Gespräch.'
        }];
        this.status = '';
        this.emit();
    }

    private cancelRunning(): void {
        this.controller?.abort();
        this.controller = undefined;
    }

    private push(kind: ChatEntryKind, text: string): void {
        this.entries.push({ kind, text });
        this.emit();
    }

    private setStatus(status: string): void {
        this.status = status;
        this.emit();
    }

    private emit(): void {
        this.onChange(this.state);
    }
}
