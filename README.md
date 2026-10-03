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

### Version 0.1

- controlled selection of up to five files
- transparent list of analyzed files
- configurable Ollama model
- configurable Ollama base URL
- improved project-rule discovery
- clearer error messages
- automated tests for path restrictions

### Version 0.2

- dedicated planning mode
- structured change proposals
- explicit list of affected files
- validation plan before modifications

### Version 0.3

- diff preview
- accept or reject changes
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

Bubble is currently tested with:

qwen3:14b

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