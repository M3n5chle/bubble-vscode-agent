import * as vscode from 'vscode';

export const DEFAULT_OLLAMA_MODEL = 'qwen3:14b';

/** Liest den Modellnamen aus den Einstellungen; leer oder ungültig ergibt den bisherigen Standard. */
export function getOllamaModel(): string {
    const value = vscode.workspace
        .getConfiguration('bubble-vscode-agent')
        .get<unknown>('ollamaModel');
    if (typeof value !== 'string') {
        return DEFAULT_OLLAMA_MODEL;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : DEFAULT_OLLAMA_MODEL;
}
