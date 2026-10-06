import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import {
    AgentCancelledError,
    runReadOnlyAgent,
    type ConversationTurn,
    type ToolActivity
} from '../agent/readOnlyAgent.js';
import {
    analyzeWithLimit,
    pickFilesFromWorkspace,
    validateSelection
} from '../agent/analyzeSelectedFiles.js';
import {
    askOllama as askCurrentFile,
    buildPrompt as buildCurrentFilePrompt,
    checkFilePath,
    MAX_FILE_SIZE,
    readProjectRules
} from '../agent/analyzeCurrentFile.js';
import { checkNoSymlinkInPath } from '../safety/pathPolicy.js';
import {
    buildPlanPrompt,
    extractRequestedFiles,
    formatPlanResponse
} from '../agent/planChange.js';
import {
    ChatModeLimitError,
    ChatSession,
    ChatWorkflowCancelledError,
    type ChatWorkflowResult,
    type ChatMode,
    type ChatState
} from './chatSession.js';

export const CHAT_VIEW_ID = 'bubble-vscode-agent.chatView';

export function getChatWorkspaceName(
    folders: readonly { name: string }[] | undefined
): string {
    return folders?.[0]?.name ?? 'Kein Workspace geöffnet';
}

// Nachrichten der Weboberfläche sind nicht vertrauenswürdig: nur diese
// ausdrücklich unterstützten Typen werden verarbeitet.
export interface ChatSystemCheckResult {
    output: string;
}

export type ChatSystemChecker = () => Promise<ChatSystemCheckResult>;

export async function runChatPlan(
    workspaceUri: vscode.Uri,
    question: string,
    onStatus: (status: string) => void,
    signal: AbortSignal,
    onToolActivity: (activity: ToolActivity) => void
): Promise<ChatWorkflowResult> {
    const result = await runReadOnlyAgent(
        workspaceUri,
        buildPlanPrompt(question),
        onStatus,
        [],
        extractRequestedFiles(question),
        signal,
        onToolActivity
    );
    return {
        ...result,
        answer: formatPlanResponse(
            result.answer,
            result.evidence,
            result.omitted,
            question,
            result.toolDiagnostics
        ),
        includeEvidence: false
    };
}

export function runChatTools(
    workspaceUri: vscode.Uri,
    task: string,
    history: readonly ConversationTurn[],
    onStatus: (status: string) => void,
    signal: AbortSignal,
    onToolActivity: (activity: ToolActivity) => void
): Promise<ChatWorkflowResult> {
    return runReadOnlyAgent(
        workspaceUri,
        task,
        onStatus,
        history,
        [],
        signal,
        onToolActivity
    );
}

export async function handleChatMessage(
    session: ChatSession,
    message: unknown,
    checkSystem?: ChatSystemChecker
): Promise<void> {
    if (typeof message !== 'object' || message === null) {
        return;
    }

    const { type, text } = message as { type?: unknown; text?: unknown };
    const mode = (message as { mode?: unknown }).mode;

    switch (type) {
        case 'ask':
            await session.ask(text);
            break;
        case 'submit':
            await session.ask(text, mode);
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
            (question, history, onStatus, signal, onToolActivity, mode) =>
                this.runMode(
                    mode,
                    question,
                    history,
                    onStatus,
                    signal,
                    onToolActivity
                ),
            state => this.post(state)
        );
    }

    private async runMode(
        mode: ChatMode,
        question: string,
        history: readonly ConversationTurn[],
        onStatus: (status: string) => void,
        signal: AbortSignal,
        onToolActivity: (activity: ToolActivity) => void
    ): Promise<ChatWorkflowResult> {
        const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;

        if (!workspaceUri) {
            throw new Error(
                'Es ist kein Workspace geöffnet. Bitte zuerst einen Projektordner öffnen.'
            );
        }

        if (mode === 'currentFile') {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                throw new Error('Bitte zuerst eine Datei öffnen.');
            }

            const workspaceFolder = vscode.workspace.getWorkspaceFolder(
                editor.document.uri
            );
            if (!workspaceFolder) {
                throw new Error('Die aktuelle Datei gehört zu keinem geöffneten Workspace-Ordner.');
            }

            const pathCheck = checkFilePath(
                workspaceFolder.uri,
                editor.document.uri
            );
            if (!pathCheck.allowed) {
                throw new Error(pathCheck.reason ?? 'Die aktuelle Datei ist nicht erlaubt.');
            }

            const linkCheck = await checkNoSymlinkInPath(
                workspaceFolder.uri,
                pathCheck.relativePath
            );
            if (!linkCheck.allowed) {
                throw new Error(linkCheck.reason);
            }

            const documentText = editor.document.getText();
            if (Buffer.byteLength(documentText, 'utf8') > MAX_FILE_SIZE) {
                throw new ChatModeLimitError(
                    `Die geöffnete Datei überschreitet das Leselimit von ${MAX_FILE_SIZE} Bytes.`
                );
            }
            if (documentText.includes('\u0000')) {
                throw new Error('Binärdateien können nicht analysiert werden.');
            }
            if (signal.aborted) {
                throw new AgentCancelledError();
            }

            onStatus(`Lese Projektregeln und bereite ${pathCheck.relativePath} vor ...`);
            const rules = await readProjectRules(workspaceFolder.uri);
            const prompt = buildCurrentFilePrompt(
                pathCheck.relativePath,
                documentText,
                question,
                rules
            );
            const answer = await askCurrentFile(prompt, signal);
            return {
                answer,
                evidence: [],
                omitted: 0,
                includeEvidence: false,
                contextSummary: `Analysierte Datei: ${pathCheck.relativePath}`
            };
        }

        if (mode === 'selectedFiles') {
            onStatus('Warte auf die manuelle Dateiauswahl ...');
            const picked = await pickFilesFromWorkspace(workspaceUri);
            if (signal.aborted) {
                throw new AgentCancelledError();
            }
            if (!picked?.length) {
                throw new ChatWorkflowCancelledError(
                    'Dateiauswahl abgebrochen; es wurden keine Dateien gesendet.'
                );
            }

            const validation = await validateSelection(workspaceUri, picked);
            if (!validation.ok) {
                throw validation.kind === 'tooMany'
                    ? new ChatModeLimitError(validation.message)
                    : new Error(validation.message);
            }

            const selection = validation.selection;
            const paths = selection.files.map(file => file.relativePath);
            const confirmation = await vscode.window.showInformationMessage(
                'Diese Dateien werden an das lokale Ollama-Modell gesendet:',
                { modal: true, detail: paths.join('\n') },
                'Weiter'
            );
            if (signal.aborted) {
                throw new AgentCancelledError();
            }
            if (confirmation !== 'Weiter') {
                throw new ChatWorkflowCancelledError(
                    'Dateianalyse abgebrochen; die ausgewählten Dateien wurden nicht gesendet.'
                );
            }

            onStatus('Analysiere die ausdrücklich bestätigten Dateien ...');
            const result = await analyzeWithLimit(
                selection.files,
                question,
                undefined,
                signal
            );
            if (signal.aborted) {
                throw new AgentCancelledError();
            }
            if (!result.ok) {
                throw new ChatModeLimitError(result.message);
            }

            return {
                answer: result.answer,
                evidence: [],
                omitted: 0,
                includeEvidence: false,
                contextSummary: `Ausdrücklich bestätigte Dateien:\n${paths.map(file => `- ${file}`).join('\n')}`
            };
        }

        if (mode === 'plan') {
            return runChatPlan(
                workspaceUri,
                question,
                onStatus,
                signal,
                onToolActivity
            );
        }

        if (mode === 'tools') {
            return runChatTools(
                workspaceUri,
                question,
                history,
                onStatus,
                signal,
                onToolActivity
            );
        }

        return runReadOnlyAgent(
            workspaceUri,
            question,
            onStatus,
            history,
            [],
            signal,
            onToolActivity
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
        this.refreshWorkspaceName();
    }

    dispose(): void {
        this.session.end();
    }

    private post(state: ChatState): void {
        void this.view?.webview.postMessage({
            type: 'state',
            state,
            workspaceName: getChatWorkspaceName(
                vscode.workspace.workspaceFolders
            )
        });
    }

    refreshWorkspaceName(): void {
        void this.view?.webview.postMessage({
            type: 'workspace',
            name: getChatWorkspaceName(vscode.workspace.workspaceFolders)
        });
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
#chat-header { flex: none; padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border, transparent); color: var(--vscode-descriptionForeground); font-size: 0.9em; overflow-wrap: anywhere; }
#workspace-name { color: var(--vscode-foreground); font-weight: 600; }
#log { flex: 1; min-width: 0; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
.hint { color: var(--vscode-descriptionForeground); }
.msg { position: relative; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--vscode-panel-border, transparent); max-width: 100%; box-sizing: border-box; }
.msg .who { font-size: 0.85em; font-weight: 600; margin-bottom: 4px; opacity: 0.85; }
.msg .who { padding-right: 34px; }
.msg .body { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.45; }
.msg.user { align-self: flex-end; width: 92%; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textLink-foreground); }
.msg.answer { align-self: flex-start; width: 100%; background: var(--vscode-editor-background); border-left: 3px solid var(--vscode-charts-green, var(--vscode-focusBorder)); }
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
details.tools { position: relative; margin: -4px 0 0 14px; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
details.tools summary { cursor: pointer; padding: 2px 34px 2px 0; }
details.tools pre { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family, monospace); padding: 6px 8px; border-radius: 4px; background: var(--vscode-textCodeBlock-background); }
.activity { position: relative; padding: 8px 10px; border: 1px solid var(--vscode-panel-border, transparent); border-radius: 6px; background: var(--vscode-editorWidget-background, transparent); }
.activity h2 { margin: 0 0 2px; padding-right: 34px; font-size: 0.95em; }
.activity .activity-summary { margin: 0 0 6px; color: var(--vscode-descriptionForeground); font-size: 0.9em; overflow-wrap: anywhere; }
.activity ol { margin: 0; padding-left: 1.8em; }
.activity li { padding: 2px 0 2px 6px; margin: 2px 0; border-left: 2px solid transparent; overflow-wrap: anywhere; }
.activity li.running { border-left-color: var(--vscode-progressBar-background, var(--vscode-focusBorder)); font-weight: 600; }
.activity li.success { opacity: 0.9; }
.activity li.failed, .activity li.budget-rejected { border-left-color: var(--vscode-editorWarning-foreground); }
.activity li.failed { border-left-color: var(--vscode-errorForeground); }
.activity summary { cursor: pointer; overflow-wrap: anywhere; }
.activity .activity-status { margin-left: 6px; padding: 0 5px; border-radius: 8px; font-size: 0.8em; font-weight: 400; border: 1px solid var(--vscode-panel-border, currentColor); white-space: nowrap; }
.activity .activity-meta { margin-top: 2px; padding-left: 14px; color: var(--vscode-descriptionForeground); font-size: 0.9em; font-weight: 400; }
.activity .activity-error { color: var(--vscode-errorForeground); }
#working { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--vscode-focusBorder); background: var(--vscode-editorWidget-background, transparent); }
.spinner { width: 14px; height: 14px; flex: none; border-radius: 50%; border: 2px solid var(--vscode-progressBar-background, var(--vscode-focusBorder)); border-right-color: transparent; animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; border-right-color: var(--vscode-progressBar-background, var(--vscode-focusBorder)); } }
#composer { box-sizing: border-box; width: 100%; min-width: 0; padding: 8px 10px 10px; border-top: 1px solid var(--vscode-panel-border, transparent); display: flex; flex-direction: column; gap: 6px; }
textarea { width: 100%; min-width: 0; box-sizing: border-box; min-height: 64px; resize: vertical; font-family: inherit; font-size: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent)); border-radius: 4px; padding: 6px 8px; }
textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
#paste-feedback { min-height: 1em; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
#paste-feedback.error { color: var(--vscode-errorForeground); }
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
<header id="chat-header">Workspace: <span id="workspace-name">Kein Workspace geöffnet</span></header>
<main id="log" role="log" aria-live="polite" aria-label="Bubble Gespräch" tabindex="0"></main>
<form id="composer" aria-label="Neue Frage">
<label for="mode-select" class="keys">Arbeitsmodus</label>
<select id="mode-select" aria-label="Arbeitsmodus">
<option value="question">Frage stellen</option>
<option value="project">Projekt analysieren</option>
<option value="currentFile">Aktuelle Datei analysieren</option>
<option value="selectedFiles">Ausgewählte Dateien analysieren</option>
<option value="plan">Änderung planen</option>
<option value="tools">Werkzeuge (nur lesen)</option>
</select>
<label for="input" class="keys">Eingabe für den gewählten Modus – Enter sendet, Umschalt+Enter ergibt eine neue Zeile</label>
<textarea id="input" placeholder="Frage zum Projekt ..."></textarea>
<div id="paste-feedback" aria-live="polite"></div>
<div class="keys">Dateien werden nur nach ausdrücklicher Auswahl und Bestätigung übermittelt.</div>
<div class="row">
<button type="submit" id="send" class="primary">Ausführen</button>
<button type="button" id="paste" class="secondary">Einfügen</button>
<button type="button" id="system-check" class="secondary">System prüfen</button>
<span class="spacer"></span>
<button type="button" id="reset" class="secondary">Gespräch zurücksetzen</button>
<button type="button" id="end" class="secondary">Beenden</button>
</div>
</form>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
const workspaceName = document.getElementById('workspace-name');
const input = document.getElementById('input');
const modeSelect = document.getElementById('mode-select');
const send = document.getElementById('send');
const pasteFeedback = document.getElementById('paste-feedback');
const LABELS = { user: 'Du', answer: 'Bubble', error: 'Fehler', limit: 'Kontextgrenze', info: 'Hinweis', system: 'Systemprüfung', systemError: 'Systemprüfung fehlgeschlagen' };
const COPY_LABELS = { user: 'Frage', answer: 'Antwort', error: 'Fehler', limit: 'Kontextgrenze', info: 'Hinweis', system: 'Systemprüfung', systemError: 'Systemprüfung' };
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) { node.className = className; }
  if (text !== undefined) { node.textContent = text; }
  return node;
}
function addCopyButton(msg, text, label) {
  const copy = el('button', 'secondary copy-button');
  copy.type = 'button';
  copy.setAttribute('aria-label', label + ' kopieren');
  copy.setAttribute('title', label + ' kopieren');
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
      await navigator.clipboard.writeText(text);
      feedback.textContent = label + ' wurde kopiert.';
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
const ACTIVITY_SYMBOLS = { running: '…', success: '✓', failed: '✗', 'budget-rejected': '!', 'repeat-blocked': '↷' };
function renderActivities(activities, openSteps) {
  if (!activities || activities.length === 0) { return; }
  const section = el('section', 'activity');
  section.setAttribute('aria-label', 'Aktivitätsverlauf');
  section.appendChild(el('h2', '', 'Aktivitätsverlauf'));
  const copyText = activities.map((activity, index) => {
    const lines = [(index + 1) + '. ' + (activity.title || (activity.tool + ' ' + activity.target))];
    for (const detail of Array.isArray(activity.details) ? activity.details : []) {
      lines.push('   ' + detail);
    }
    if (activity.reason && !lines.some(line => line === '   Grund: ' + activity.reason)) {
      lines.push('   Grund: ' + activity.reason);
    }
    return lines.join('\\n');
  }).join('\\n\\n');
  addCopyButton(section, copyText, 'Aktivitätsverlauf');
  let usedRound = 0;
  let maxRounds = 0;
  for (const activity of activities) {
    if (Number.isFinite(activity.round) && activity.round > usedRound) { usedRound = activity.round; }
    if (Number.isFinite(activity.maxRounds)) { maxRounds = activity.maxRounds; }
  }
  if (usedRound > 0 && maxRounds > 0) {
    section.appendChild(el('div', 'activity-summary', 'Modellschritte: ' + usedRound + ' von ' + maxRounds + ' (nur Modellschritte zählen zum Limit, nicht einzelne Aufrufe)'));
  }
  const list = el('ol');
  for (const activity of activities) {
    const item = el('li', activity.status);
    const details = el('details', 'activity-step');
    details.setAttribute('data-step', String(activity.step));
    details.open = openSteps.has(String(activity.step));
    const summary = el('summary');
    summary.appendChild(el('span', '', (ACTIVITY_SYMBOLS[activity.status] || '?') + ' ' + (activity.title || (activity.tool + ' ' + activity.target))));
    summary.appendChild(el('span', 'activity-status', activity.statusLabel || activity.status));
    details.appendChild(summary);
    const lines = Array.isArray(activity.details) ? activity.details : [];
    for (const line of lines) {
      details.appendChild(el('div', 'activity-meta', line));
    }
    if (activity.reason && !lines.includes('Grund: ' + activity.reason)) {
      details.appendChild(el('div', 'activity-meta activity-error', activity.reason));
    }
    item.appendChild(details);
    list.appendChild(item);
  }
  section.appendChild(list);
  log.appendChild(section);
}
function render(state) {
  const openTools = new Set();
  log.querySelectorAll('details.tools').forEach((d, i) => { if (d.open) { openTools.add(i); } });
  const openSteps = new Set();
  log.querySelectorAll('details.activity-step').forEach(d => { if (d.open) { openSteps.add(d.getAttribute('data-step')); } });
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.textContent = '';
  if (state.entries.length === 0 && !state.busy) {
    log.appendChild(el('p', 'hint', 'Stelle eine Frage zum Projekt. Bubble liest nur und verändert nichts.'));
  }
  let toolIndex = 0;
  let lastUser = -1;
  state.entries.forEach((entry, index) => { if (entry.kind === 'user') { lastUser = index; } });
  const hasActivities = Array.isArray(state.activities) && state.activities.length > 0;
  state.entries.forEach((e, index) => {
    renderEntry(e);
    if (hasActivities && index === lastUser) { renderActivities(state.activities, openSteps); }
  });
  function renderEntry(e) {
    if (e.kind === 'evidence') {
      const details = el('details', 'tools');
      details.open = openTools.has(toolIndex);
      toolIndex += 1;
      details.appendChild(el('summary', '', 'Werkzeugprotokoll'));
      details.appendChild(el('pre', '', e.text));
      addCopyButton(details, e.text, 'Werkzeugprotokoll');
      log.appendChild(details);
      return;
    }
    const msg = el('section', 'msg ' + e.kind);
    msg.appendChild(el('div', 'who', LABELS[e.kind] || ''));
    msg.appendChild(el('div', 'body', e.text));
    if (COPY_LABELS[e.kind]) {
      addCopyButton(
        msg,
        e.text,
        COPY_LABELS[e.kind]
      );
    }
    log.appendChild(msg);
  }
  if (hasActivities && lastUser < 0) { renderActivities(state.activities, openSteps); }
  if (state.busy) {
    const working = el('div', '');
    working.id = 'working';
    working.setAttribute('role', 'status');
    working.appendChild(el('span', 'spinner'));
    working.appendChild(el('span', '', 'Bubble arbeitet: ' + (state.status || 'Analyse läuft ...')));
    log.appendChild(working);
  }
  send.disabled = state.busy;
  modeSelect.disabled = state.busy;
  if (nearBottom || state.busy) { log.scrollTop = log.scrollHeight; }
}
function ask() {
  const text = input.value.trim();
  if (!text) { return; }
  input.value = '';
  vscode.postMessage({ type: 'submit', mode: modeSelect.value, text });
}
document.getElementById('composer').addEventListener('submit', e => { e.preventDefault(); ask(); });
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); } });
document.getElementById('reset').addEventListener('click', () => vscode.postMessage({ type: 'reset' }));
document.getElementById('end').addEventListener('click', () => vscode.postMessage({ type: 'end' }));
document.getElementById('system-check').addEventListener('click', () => vscode.postMessage({ type: 'systemCheck' }));
document.getElementById('paste').addEventListener('click', async () => {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  pasteFeedback.className = '';
  pasteFeedback.textContent = '';
  try {
    if (!navigator.clipboard?.readText) {
      throw new Error('Die Zwischenablage ist nicht verfügbar.');
    }
    const text = await navigator.clipboard.readText();
    input.setRangeText(text, start, end, 'end');
    pasteFeedback.textContent = 'Text wurde eingefügt.';
    input.focus();
  } catch (error) {
    pasteFeedback.className = 'error';
    pasteFeedback.textContent = 'Einfügen fehlgeschlagen: '
      + (error && typeof error === 'object'
        && 'message' in error && typeof error.message === 'string'
        && error.message
        ? error.message
        : 'Bitte erneut versuchen.');
  }
});
window.addEventListener('message', e => {
  if (!e.data) { return; }
  if (e.data.type === 'state') {
    render(e.data.state);
    workspaceName.textContent = e.data.workspaceName || 'Kein Workspace geöffnet';
  } else if (e.data.type === 'workspace') {
    workspaceName.textContent = e.data.name || 'Kein Workspace geöffnet';
  }
});
render({ entries: [], busy: false, status: '' });
</script>
</body>
</html>`;
}