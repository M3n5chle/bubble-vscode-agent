import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { runReadOnlyAgent } from '../agent/readOnlyAgent.js';
import { ChatSession, type ChatState } from './chatSession.js';

export const CHAT_VIEW_ID = 'bubble-vscode-agent.chatView';

// Nachrichten der Weboberfläche sind nicht vertrauenswürdig: nur diese
// ausdrücklich unterstützten Typen werden verarbeitet.
export interface ChatSystemCheckResult {
    output: string;
}

export type ChatSystemChecker = () => Promise<ChatSystemCheckResult>;

export async function handleChatMessage(
    session: ChatSession,
    message: unknown,
    checkSystem?: ChatSystemChecker
): Promise<void> {
    if (typeof message !== 'object' || message === null) {
        return;
    }

    const { type, text } = message as { type?: unknown; text?: unknown };

    switch (type) {
        case 'ask':
            await session.ask(text);
            break;
        case 'reset':
            session.reset();
            break;
        case 'end':
            session.end();
            break;
        case 'systemCheck':
            if (!checkSystem) {
                session.addSystemCheckError(
                    'Die Systemprüfung ist momentan nicht verfügbar.'
                );
                break;
            }
            try {
                const result = await checkSystem();
                session.addSystemCheckResult(result.output);
            } catch (error) {
                session.addSystemCheckError(
                    error instanceof Error
                        ? error.message
                        : String(error)
                );
            }
            break;
        default:
            break;
    }
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | undefined;
    private readonly session: ChatSession;

    constructor(private readonly checkSystem: ChatSystemChecker) {
        this.session = new ChatSession(
            (question, history, onStatus, signal) => {
                const workspaceUri =
                    vscode.workspace.workspaceFolders?.[0]?.uri;

                if (!workspaceUri) {
                    return Promise.reject(new Error(
                        'Es ist kein Workspace geöffnet. Bitte zuerst '
                        + 'einen Projektordner öffnen.'
                    ));
                }

                return runReadOnlyAgent(
                    workspaceUri, question, onStatus, history, [], signal
                );
            },
            state => this.post(state)
        );
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = getChatHtml(crypto.randomBytes(16).toString('base64'));

        view.webview.onDidReceiveMessage(
            message => handleChatMessage(this.session, message, this.checkSystem)
        );
        view.onDidDispose(() => {
            if (this.view === view) {
                this.view = undefined;
            }
        });

        this.post(this.session.state);
    }

    dispose(): void {
        this.session.end();
    }

    private post(state: ChatState): void {
        void this.view?.webview.postMessage({ type: 'state', state });
    }
}

export function getChatHtml(nonce: string): string {
    return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
html, body { height: 100%; }
body { margin: 0; padding: 0; display: flex; flex-direction: column; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
#log { flex: 1; min-width: 0; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
.hint { color: var(--vscode-descriptionForeground); }
.msg { padding: 8px 10px; border-radius: 6px; border: 1px solid var(--vscode-panel-border, transparent); max-width: 100%; box-sizing: border-box; }
.msg .who { font-size: 0.85em; font-weight: 600; margin-bottom: 4px; opacity: 0.85; }
.msg .body { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.45; }
.msg.user { align-self: flex-end; width: 92%; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textLink-foreground); }
.msg.answer { position: relative; align-self: flex-start; width: 100%; background: var(--vscode-editor-background); border-left: 3px solid var(--vscode-charts-green, var(--vscode-focusBorder)); }
.msg.answer .who { padding-right: 34px; }
.copy-button { position: absolute; top: 6px; right: 6px; display: grid; place-items: center; width: 28px; height: 28px; padding: 4px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
.copy-button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.copy-button svg { display: block; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
.copy-feedback { min-height: 1em; margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
.copy-feedback.error { color: var(--vscode-errorForeground); }
.msg.info { color: var(--vscode-descriptionForeground); border-style: dashed; }
.msg.system { border-left: 3px solid var(--vscode-focusBorder); background: var(--vscode-editorWidget-background, transparent); }
.msg.systemError { border-left: 3px solid var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground, transparent); }
.msg.error { border-left: 3px solid var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground, transparent); }
.msg.limit { border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-inputValidation-warningBackground, transparent); }
details.tools { margin: -4px 0 0 14px; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
details.tools summary { cursor: pointer; padding: 2px 0; }
details.tools pre { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family, monospace); padding: 6px 8px; border-radius: 4px; background: var(--vscode-textCodeBlock-background); }
#working { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--vscode-focusBorder); background: var(--vscode-editorWidget-background, transparent); }
.spinner { width: 14px; height: 14px; flex: none; border-radius: 50%; border: 2px solid var(--vscode-progressBar-background, var(--vscode-focusBorder)); border-right-color: transparent; animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; border-right-color: var(--vscode-progressBar-background, var(--vscode-focusBorder)); } }
#composer { box-sizing: border-box; width: 100%; min-width: 0; padding: 8px 10px 10px; border-top: 1px solid var(--vscode-panel-border, transparent); display: flex; flex-direction: column; gap: 6px; }
textarea { width: 100%; min-width: 0; box-sizing: border-box; min-height: 64px; resize: vertical; font-family: inherit; font-size: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent)); border-radius: 4px; padding: 6px 8px; }
textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
textarea:focus, button:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px; align-items: stretch; }
.row .spacer { display: none; }
.row #send { grid-column: 1 / -1; }
button { font-family: inherit; font-size: inherit; padding: 4px 12px; border-radius: 2px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); }
button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: 0.5; cursor: default; }
.keys { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
@media (max-width: 340px) { .row { grid-template-columns: minmax(0, 1fr); } .row #send { grid-column: auto; } }
@media (max-width: 220px) { #composer { padding-right: 6px; padding-left: 6px; } .row button { padding-right: 4px; padding-left: 4px; font-size: 0.78em; } }
</style>
</head>
<body>
<main id="log" role="log" aria-live="polite" aria-label="Bubble Gespräch" tabindex="0"></main>
<form id="composer" aria-label="Neue Frage">
<label for="input" class="keys">Frage zum Projekt (rein lesend) – Enter sendet, Umschalt+Enter ergibt eine neue Zeile</label>
<textarea id="input" placeholder="Frage zum Projekt ..."></textarea>
<div class="row">
<button type="submit" id="send" class="primary">Fragen</button>
<button type="button" id="system-check" class="secondary">System prüfen</button>
<span class="spacer"></span>
<button type="button" id="reset" class="secondary">Gespräch zurücksetzen</button>
<button type="button" id="end" class="secondary">Beenden</button>
</div>
</form>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
const input = document.getElementById('input');
const send = document.getElementById('send');
const LABELS = { user: 'Du', answer: 'Bubble', error: 'Fehler', limit: 'Kontextgrenze', info: 'Hinweis', system: 'Systemprüfung', systemError: 'Systemprüfung fehlgeschlagen' };
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) { node.className = className; }
  if (text !== undefined) { node.textContent = text; }
  return node;
}
function render(state) {
  const openTools = new Set();
  log.querySelectorAll('details.tools').forEach((d, i) => { if (d.open) { openTools.add(i); } });
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.textContent = '';
  if (state.entries.length === 0 && !state.busy) {
    log.appendChild(el('p', 'hint', 'Stelle eine Frage zum Projekt. Bubble liest nur und verändert nichts.'));
  }
  let toolIndex = 0;
  for (const e of state.entries) {
    if (e.kind === 'evidence') {
      const details = el('details', 'tools');
      details.open = openTools.has(toolIndex);
      toolIndex += 1;
      details.appendChild(el('summary', '', 'Werkzeugprotokoll'));
      details.appendChild(el('pre', '', e.text));
      log.appendChild(details);
      continue;
    }
    const msg = el('section', 'msg ' + e.kind);
    msg.appendChild(el('div', 'who', LABELS[e.kind] || ''));
    msg.appendChild(el('div', 'body', e.text));
    if (e.kind === 'answer') {
      const copy = el('button', 'secondary copy-button');
      copy.type = 'button';
      copy.setAttribute('aria-label', 'Antwort kopieren');
      copy.setAttribute('title', 'Antwort kopieren');
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 16 16');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('focusable', 'false');
      const back = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      back.setAttribute('d', 'M5 5V3.5A1.5 1.5 0 0 1 6.5 2h6A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H11');
      const front = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      front.setAttribute('d', 'M3.5 5h6A1.5 1.5 0 0 1 11 6.5v6A1.5 1.5 0 0 1 9.5 14h-6A1.5 1.5 0 0 1 2 12.5v-6A1.5 1.5 0 0 1 3.5 5Z');
      icon.appendChild(back);
      icon.appendChild(front);
      copy.appendChild(icon);
      const feedback = el('div', 'copy-feedback');
      feedback.setAttribute('aria-live', 'polite');
      copy.addEventListener('click', async () => {
        copy.disabled = true;
        feedback.className = 'copy-feedback';
        feedback.textContent = '';
        try {
          if (!navigator.clipboard?.writeText) {
            throw new Error('Die Zwischenablage ist nicht verfügbar.');
          }
          await navigator.clipboard.writeText(e.text);
          feedback.textContent = 'Antwort wurde kopiert.';
        } catch (error) {
          feedback.className = 'copy-feedback error';
          feedback.textContent = 'Kopieren fehlgeschlagen: '
            + (error && typeof error === 'object'
              && 'message' in error && typeof error.message === 'string'
              && error.message
              ? error.message
              : 'Bitte erneut versuchen.');
        } finally {
          copy.disabled = false;
        }
      });
      msg.appendChild(copy);
      msg.appendChild(feedback);
    }
    log.appendChild(msg);
  }
  if (state.busy) {
    const working = el('div', '');
    working.id = 'working';
    working.setAttribute('role', 'status');
    working.appendChild(el('span', 'spinner'));
    working.appendChild(el('span', '', 'Bubble arbeitet: ' + (state.status || 'Analyse läuft ...')));
    log.appendChild(working);
  }
  send.disabled = state.busy;
  if (nearBottom || state.busy) { log.scrollTop = log.scrollHeight; }
}
function ask() {
  const text = input.value.trim();
  if (!text) { return; }
  input.value = '';
  vscode.postMessage({ type: 'ask', text });
}
document.getElementById('composer').addEventListener('submit', e => { e.preventDefault(); ask(); });
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); } });
document.getElementById('reset').addEventListener('click', () => vscode.postMessage({ type: 'reset' }));
document.getElementById('end').addEventListener('click', () => vscode.postMessage({ type: 'end' }));
document.getElementById('system-check').addEventListener('click', () => vscode.postMessage({ type: 'systemCheck' }));
window.addEventListener('message', e => { if (e.data && e.data.type === 'state') { render(e.data.state); } });
render({ entries: [], busy: false, status: '' });
</script>
</body>
</html>`;
}