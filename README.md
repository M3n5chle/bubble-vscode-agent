# Bubble

Bubble is a local and controlled AI development assistant for Visual Studio Code.

Bubble connects Visual Studio Code to locally hosted language models through Ollama. The project focuses on transparent context selection, strict safety boundaries, and human approval before code changes.

> Bubble is currently an experimental early-development version. File analysis works, but autonomous editing and terminal access are not production-ready.

## Goals

Bubble is designed to:

- run locally with Ollama
- keep project files on the local computer
- show which files are used as context
- analyze the currently opened file
- analyze explicitly selected project files
- respect project-specific instruction files
- separate analysis, planning, and modification
- require approval before future file changes
- avoid automatic commits, pushes, deployments, and server access

## Current Features

Bubble currently provides these Visual Studio Code commands:

- `Bubble: System prüfen`
- `Bubble: Frage stellen`
- `Bubble: Projekt analysieren`
- `Bubble: Aktuelle Datei analysieren`
- `Bubble: Ausgewählte Dateien analysieren`
- `Bubble: Änderungsvorschau (manueller Text)`
- `Bubble: Änderungsvorschau mit Ollama (nur Diff)`
- `Bubble: Änderung planen`

`Bubble: Änderung planen` is a read-only planning command: it produces a plan
(at most three steps) using only the read-only tools and never modifies files.

### Single-File Diff Preview (implemented)

Both preview commands require choosing one workspace text file and show the
original and proposed content in the existing diff view. The manual command
accepts replacement text directly. The Ollama command sends the checked file
content and the user's change instruction in one request to the configured Ollama model (setting `bubble-vscode-agent.ollamaModel`, default
`qwen3:14b`). Its bounded response is validated and shown only as an
in-memory suggestion. Neither command writes files, and there is no tool-calling
loop. Before reading, both commands reject a target file that has unsaved
changes in the VS Code editor, starts with a UTF-8 BOM, or contains invalid
UTF-8, with a clear message; for the Ollama command this happens before the
request. The editor text is never used as a substitute: the preview always
rests on the checked on-disk content, and no bytes are silently removed or
replaced.

After the diff is shown, the dialog offers `Vorschlag freigeben`. This is a
**simulation only**: no project file is changed, and the message states that the
change was not applied. Bubble has no productive apply command and no real
writer.

`src/agent/applyDecision.ts` adds a testable, write-free approval simulation for
a later apply step. After consent in the modal dialog it issues an internally
verified receipt that is bound to the shown proposal (path, original bytes, and
proposed text) and can be used only once. A passed-in string such as
"approved", a forged or copied receipt, a used receipt, or a receipt for a
different proposal is not accepted. Before a call to the fake writer, the
existing checks are repeated: the diff is still open, and workspace, path,
text type, symlink checks pass with current raw bytes identical to the bytes
captured at preview time. Rejection, cancellation, a closed diff, any check
error, or a changed original yield no receipt or "do not apply". The receipt
does **not** prove that the user read the diff. It is verified only with an
injected in-memory fake writer; a real writer and an apply command still do not
exist. This also does **not** prove a safe real write path or atomicity: check
and a later write remain separate steps, so a change in between is not
excluded.

### Controlled Multi-File Analysis (implemented)

`Bubble: Ausgewählte Dateien analysieren` analyzes several files in one request while keeping the selection under explicit user control:

- you choose the files deliberately in a Quick Pick list of allowed workspace files (relative paths, multi-select across folders); at most five files are allowed, and a larger selection is rejected
- the selected workspace-relative paths are shown in a modal confirmation before anything is sent to Ollama; the analysis only continues after you confirm
- only allowed text files inside the workspace are accepted; paths outside the workspace, blocked paths, and non-text files reject the whole selection
- the complete prompt (rules, file paths, file contents, and your question) is limited to 8,000 UTF-8 bytes; this is a conservative product limit, not a guarantee against context truncation, and above it no request is sent to Ollama
- the contents are passed read-only to the local Ollama endpoint with a prompt that forbids modifying files, running commands, and accessing servers or databases
- the command makes a single chat request without tools; there is no tool-calling loop
- the analyzed file paths are listed in the output channel

This command never writes files.

### Project Analysis Follow-Up Questions (implemented)

After an answer, `Bubble: Projekt analysieren` offers `Rückfrage stellen`, `Gespräch zurücksetzen`, and `Beenden`. A follow-up question is sent together with the previous questions and final answers; `Gespräch zurücksetzen` discards that history and starts a new analysis. Only the existing read-only tools and path restrictions are used.

Before every Ollama call, the complete request body (system text, conversation history, tool results, and tool definitions) must stay within 32,000 UTF-8 bytes. Above that, Bubble shows a message; only the request that is too large is not sent to Ollama and it is not silently truncated. Earlier requests in the same run may already have been sent. The history stays unchanged so it can be reset. This is a conservative byte limit, not a guaranteed token limit. Larger tool results (for example big files) can therefore stop an analysis; ask a narrower question. The history lives only in memory while the command runs. Single- and multi-file analysis are unaffected.

### Symbolic Links and Junctions

When reading, Bubble rejects symbolic links and junctions in the checked path. This applies to the file itself, to every parent folder below the workspace root, and to the workspace root itself. It covers multi-file analysis, project analysis (file reading, directory listing, and text search), analysis of the current file, and the optional project instruction files. Link entries are hidden in directory listings and skipped in text search.

As a consequence, a workspace that is opened through a symbolic link or junction cannot be analyzed; open the real folder instead.

Limitation: the check and the subsequent read are separate steps. If someone with write access to the workspace replaces a checked path with a link in between, this is not fully excluded. Folders above the workspace root are not checked.

Current capabilities include:

- checking the local Ollama connection
- checking whether the configured model is installed
- reading optional project instruction files
- analyzing the currently opened file
- performing read-only project analysis
- blocking selected sensitive files and directories
- limiting file size and context usage
- displaying responses in a dedicated output channel

## Planned Features

The features below are **not implemented yet**. The simulated `Vorschlag
freigeben` dialog of the diff preview exists, but it changes nothing; the
approval-based apply workflow listed here is still missing. Bubble does not
modify files.

### Version 0.1

- configurable Ollama model: available now through the setting
  `bubble-vscode-agent.ollamaModel` (default `qwen3:14b`); used by all
  Ollama requests and by `Bubble: System prüfen`
- configurable Ollama base URL (currently fixed to `http://localhost:11434`)
- improved project-rule discovery
- clearer error messages

### Version 0.2

- structured change proposals
- explicit list of affected files
- validation plan before modifications

### Version 0.3

- real apply workflow after approval (the current `Vorschlag freigeben` is only a simulation)
- transactional file updates
- no direct file writes without approval

### Later Versions

- allowlisted validation commands
- controlled terminal execution
- project-specific safety profiles
- optional tool-call fallback for local models
- session history
- Visual Studio Code sidebar interface

## Requirements

- Visual Studio Code
- Node.js
- npm
- Ollama
- a locally installed Ollama model

Bubble is currently tested with the default model:

qwen3:14b

The model name can be changed with the VS Code setting
`bubble-vscode-agent.ollamaModel`. Other models are not tested.

The default local Ollama endpoint is:

Plain Text
http://localhost:11434
Weitere Zeilen anzeigen
Development Setup

Clone the repository:

PowerShell
git clone https://github.com/M3n5chle/bubble-vscode-agent.git
cd bubble-vscode-agent
Weitere Zeilen anzeigen

Install the dependencies:

PowerShell
npm install
Weitere Zeilen anzeigen

Run the validation steps:

PowerShell
npm run check-types
npm run lint
npm run package
Weitere Zeilen anzeigen

Open the project in Visual Studio Code:

PowerShell
code .
Weitere Zeilen anzeigen

Press F5 to launch the Extension Development Host.

Project Structure
Plain Text
bubble-vscode-agent/
├─ .vscode/
├─ src/
│ ├─ agent/
│ ├─ safety/
│ ├─ test/
│ ├─ tools/
│ └─ extension.ts
├─ .gitignore
├─ .vscodeignore
├─ CHANGELOG.md
├─ LICENSE
├─ README.md
├─ esbuild.js
├─ eslint.config.mjs
├─ package-lock.json
├─ package.json
└─ tsconfig.json
Weitere Zeilen anzeigen
Project Instructions

Bubble can read optional project instruction files when they are present:

Plain Text
AGENTS.md
AGENT_RULES.md
PROJECT_STATE.md
Weitere Zeilen anzeigen

Projects do not need to provide all of these files. Future versions will make instruction-file discovery configurable.

Safety Model

Bubble is being developed with a conservative safety model.

Current and planned safeguards include:

project-bound path validation
blocked sensitive files
blocked dependency and build directories
maximum file-size limits
explicit context selection
no automatic deployment
no automatic Git push
no production-server access
no database commands
no file changes without an approval workflow

Commonly blocked paths include:

Plain Text
.git/
node_modules/
vendor/
uploads/
dist/
.env
.env.*
config.php
db.php
Weitere Zeilen anzeigen
Privacy

Bubble is designed for local model execution through Ollama.

When Bubble uses a local Ollama endpoint:

prompts are sent to the local Ollama service
selected source files remain on the local computer
no Bubble account is required
no cloud API key is required by Bubble
Bubble does not intentionally send project files to an external service

Users remain responsible for reviewing the configured Ollama endpoint and the files selected for analysis.

Limitations

Bubble is experimental software.

The current version should not be used for:

unattended code modifications
automatic production deployments
security-critical automation
automatic database changes
unrestricted terminal execution
automatic Git commits or pushes

AI-generated analyses can contain incorrect assumptions. Review all results before using them as the basis for code changes.

Contributing

Contributions, issue reports, security reviews, and suggestions are welcome.

Before submitting changes, run:

PowerShell
npm run check-types
npm run lint
npm run package
Weitere Zeilen anzeigen

Please keep changes small, focused, and reviewable.

License

Bubble is licensed under the Apache License 2.0.

See LICENSE for the complete license text.