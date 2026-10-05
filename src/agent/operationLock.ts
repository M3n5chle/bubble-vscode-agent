let activeOperation: string | undefined;

export class AgentOperationBusyError extends Error {
    constructor(operation: string) {
        super(`Bubble führt bereits „${operation}“ aus. Bitte warten, bis der laufende Vorgang beendet ist.`);
        this.name = 'AgentOperationBusyError';
    }
}

export async function runExclusiveOperation<T>(
    operation: string,
    run: () => Promise<T>
): Promise<T> {
    if (activeOperation) {
        throw new AgentOperationBusyError(activeOperation);
    }

    activeOperation = operation;
    try {
        return await run();
    } finally {
        activeOperation = undefined;
    }
}
