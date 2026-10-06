# Lokaler Coding-Agent für kleine Bubble-Aufträge (Vorbereitung)

Stand: Bubble 0.0.3, 2026-10-06. Bubble bleibt read-only; dieses Dokument beschreibt einen **externen** lokalen Agenten und implementiert keinen Bubble-Writer.

## 1. Status: noch nicht einsatzbereit (kein Pilot ausgeführt)

Beleg: Auf diesem Rechner sind weder `opencode` noch `aider` installiert (`Get-Command` findet nur `ollama.exe`; `npm ls -g` zeigt keinen der Agenten). Eine Installation würde global erfolgen und Benutzerverzeichnisse beschreiben (OpenCode: `~/.local/share/opencode/auth.json` und eine Benutzerkonfiguration; Aider: `aider-install`, `setx OLLAMA_API_BASE`). Das war laut Auftrag ausgeschlossen, daher **kein Pilot, keine Schreibprobe, kein Ersatzversuch**. Es gibt keinen Live-Nachweis für Devstral mit einem dieser Agenten.

## 2. Vergleich (nur Dokumentation, keine praktische Kompatibilität belegt)

| Kriterium | OpenCode (opencode.ai/docs) | Aider (aider.chat/docs) |
|---|---|---|
| Ollama / devstral-small-2:24b | Providerkonfiguration über `opencode.json` (`provider`, `baseURL`); das konkrete Ollama-Schema wurde hier nicht geprüft. Ob Devstral Tool-Calls dort zuverlässig nutzt: unbekannt. | `aider --model ollama_chat/<modell>`, `OLLAMA_API_BASE`; Aider setzt `num_ctx` automatisch, Ollama-Standard ist 2k und verwirft Überlänge still. Kein Tool-Calling-Agent, arbeitet mit Edit-Formaten. |
| Planen vs. Bearbeiten | Primäragenten Build (alle Werkzeuge) und Plan (Edits und bash standardmäßig `ask`). | Chat-/Architect-/Ask-Modi (nicht im Detail geprüft). |
| Freigaben | `permission` mit `allow`/`ask`/`deny`, Muster pro Werkzeug (`edit`, `bash`, …), letzte passende Regel gewinnt. **Standard ist überwiegend `allow`**; Freigaben müssen also ausdrücklich auf `ask`/`deny` gesetzt werden. `--auto` genehmigt alles Nicht-Verbotene. | Bestätigt Änderungen per Git-Commit-Workflow; Befehlsfreigabe nicht geprüft. |
| Isolation | `external_directory` fragt außerhalb des Arbeitsverzeichnisses nach (Standard `ask`); kein Sandbox-Nachweis. | Arbeitet im Git-Repo; keine Sandbox. |

Kandidat für einen späteren Pilot: **OpenCode** (getrenntes Plan-/Build-Modell mit feiner Freigabekonfiguration). Aider ist nur Vergleich. Beide Aussagen beruhen auf Dokumentation.

## 3. Vorbereitete Anleitung (nicht live erprobt)

Alle Befehle in einer **separaten Kopie**, nie im Haupt-Workspace.

```powershell
# 1. Isolierte Kopie des gesicherten Git-Stands (ohne uncommittete Änderungen)
git clone C:\Users\JürgenSeifert\Git_HPlan_VSC\bubble-vscode-agent C:\Temp\bubble-pilot
cd C:\Temp\bubble-pilot
git checkout -b pilot/lokal
git status --short   # muss leer sein
npm ci
```

Projektregeln: `PROJECT_STATE.md`, `AGENTS.md`/`AGENT_RULES.md` liegen in der Kopie und gelten als Vorgabe (an den Agenten ausdrücklich verweisen).

Beispielhafte Projektkonfiguration `opencode.json` **nur in der Kopie** (nach Installation, Syntax gegen die aktuelle Dokumentation prüfen):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "*": "ask",
    "read": "allow",
    "edit": "ask",
    "bash": "ask",
    "external_directory": "deny"
  }
}
```

Regeln: Modell ausdrücklich `devstral-small-2:24b` wählen; **kein** `--auto`; zuerst im Plan-Agenten planen, erst nach Durchsicht Edits einzeln freigeben (`once`, nicht `always`).

Prüfung nach dem Lauf (in der Kopie):

```powershell
git diff                 # Änderung vollständig lesen
git diff --check
npm test
npm run package
git status --short
```

Verwerfen eines fehlgeschlagenen Versuchs (nur in der Kopie):

```powershell
git restore --staged --worktree .
git clean -fd            # vorher mit 'git clean -nd' prüfen
# oder die Kopie komplett löschen: Remove-Item -Recurse -Force C:\Temp\bubble-pilot
```

Übernahme in den Hauptstand nur manuell nach Diff-Prüfung (`git diff > pilot.patch`, im Hauptrepo `git apply --check pilot.patch`).

## 4. Fähigkeiten: dokumentiert vs. live nachgewiesen

| Fähigkeit | Dokumentiert | Live nachgewiesen |
|---|---|---|
| Ollama-Anbindung | ja | nein |
| Devstral-Tool-Calling im Agenten | nein/unbekannt | nein |
| Plan-/Build-Trennung | ja (OpenCode) | nein |
| Freigabe für Edits und bash (`ask`) | ja | nein |
| Isolation per Kopie/`external_directory` | ja | nein |
| Ausführen von `npm test`/`package` durch den Agenten | – | nein |

## 5. Entscheidung

**Noch nicht einsatzbereit.** Beleg: kein Agent installiert, kein Pilot, keine Freigabe- oder Isolationsprüfung live. Verbleibende Grenzen: Installation außerhalb des Hauptprojekts erst freigeben lassen; Devstral-Tool-Calling mit dem Agenten ungeprüft; OpenCode-Standardrechte sind permissiv; ein einzelner späterer Erfolg würde keine allgemeine Zuverlässigkeit belegen. P4 in Bubble bleibt „nicht bestanden“; die Wirkung der neuen `search_text`-Beschreibung ist ungeprüft.