# Lokaler Coding-Agent für kleine Bubble-Aufträge

Stand: 2026-10-06. Bubble bleibt read-only; dieser Pilot hat keinen Bubble-Writer ergänzt. P4 und die Wirkung der geänderten `search_text`-Beschreibung waren ausdrücklich nicht Teil des Pilots und wurden nicht live geprüft.

## 1. Ergebnis

**Noch nicht einsatzbereit.** OpenCode 1.18.34 wurde lokal in einer getrennten Kopie gestartet und mit `devstral-small-2:24b` über Ollama verbunden. Die effektive Rechtekonfiguration wurde geprüft; ein externer Leseversuch wurde blockiert. In einem früheren Planlauf schlug der Agent sachfremde Aufgaben (Commits in einer Sidebar bzw. ein Webpack-Upgrade) vor und fragte nach einem fremden Linux-Verzeichnis. Im unten dokumentierten neuen, rein lesenden Pilot fand er die angeforderte Datei ebenfalls nicht und schlug stattdessen eine sachfremde Form-Klassen-Aufgabe vor. Es gab deshalb keine Schreibprobe und keine Dateiänderung durch den Agenten.

Der Pilot hielt vor einer Edit-Freigabe an. Es wurde weder `--auto` verwendet noch eine Edit- oder Bash-Freigabe erteilt. Die konfigurierte Nachfrage für Edit und Bash wurde wirksam eingelesen, ihr interaktives Freigabeverhalten wurde mangels entsprechender Werkzeuganforderung aber nicht live beobachtet.

## 2. Installationsart, Quellen und Schreiborte

Die offizielle [OpenCode-Dokumentation](https://opencode.ai/docs/) führt npm als Installationsweg auf. Statt globaler Installation wurde das Paket mit npm in ein eigenes Verzeichnis innerhalb der Testkopie gelegt:

```powershell
npm install --prefix "$pilot\.pilot-runtime\opencode" --no-save --no-package-lock opencode-ai@1.18.34
```

Das `--prefix`-Verzeichnis enthielt danach `node_modules`, `package.json` und `package-lock.json`; `opencode --version` meldete `1.18.34`. Weder die Manifeste der Testkopie noch die von Bubble im Hauptrepository wurden durch diese Installation geändert. npm warnte, dass das `postinstall`-Skript des Pakets zunächst nicht freigegeben war; die installierte CLI ließ sich dennoch starten.

Die Testkopie wurde aus dem sauberen Commit `9ce04c51f98399fe937655f591cb26e431303151` erstellt, nicht aus dem Arbeitsbaum mit uncommitteten Änderungen. Der OpenCode-Prozess lief beim Modellaufruf aus dieser Kopie; `/path` und die Sitzungsdaten bestätigten sie als `worktree` und `directory`.

Zur Umleitung der laufzeitbezogenen Dateien wurden für den OpenCode-Prozess `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `TEMP`, `TMP`, `npm_config_cache`, `OPENCODE_CONFIG` und `OPENCODE_CONFIG_DIR` auf Pfade innerhalb der Testkopie gesetzt. Tatsächlich beobachtete Schreiborte waren:

| Zweck | Beobachteter Ort |
|---|---|
| Projektkonfiguration und Pilotregeln | `<pilot>\opencode.json` |
| OpenCode-Programmdateien | `<pilot>\.pilot-runtime\opencode\` |
| OpenCode-Konfiguration und Provider-Abhängigkeiten | `<pilot>\.pilot-runtime\config\` und `<pilot>\.pilot-runtime\home\.config\opencode\` |
| Sitzungen, Datenbank und Git-Snapshots | `<pilot>\.pilot-runtime\home\.local\share\opencode\` |
| OpenCode-Cache und Status | `<pilot>\.pilot-runtime\home\.cache\opencode\`, `<pilot>\.pilot-runtime\home\.local\state\opencode\` |
| npm-Cache für die Installation, `npm ci` und Tests | `<pilot>\.pilot-runtime\npm-cache\` |
| Testabhängigkeiten und generierte Testergebnisse | `<pilot>\node_modules\`, `<pilot>\out\`, `<pilot>\dist\`, `<pilot>\.vscode-test\` |
| Temporärdateien | `<pilot>\.pilot-runtime\tmp\` |

**Keine vollständige Isolation:** Eine frühe npm-Metadatenabfrage (`npm view opencode-ai version`) und eine spätere Abfrage des Standard-Cachepfads liefen noch mit npm-Standardumgebung. npm verwendete dafür `C:\Users\JürgenSeifert\AppData\Local\npm-cache` (Metadaten bzw. Protokolle; keine globale OpenCode-Installation). Die folgenden Installations- und Testbefehle verwendeten den Cache innerhalb der Testkopie. Auch die OpenCode-Dokumentation nennt außerhalb eines Projektklons liegende Standardpfade, etwa `~/.config/opencode/opencode.json`, `~/.local/share/opencode/auth.json` und `~/.cache/opencode/node_modules`; Projektkonfiguration kann zusätzlich im Projekt-Root oder in `.opencode/` liegen. Diese dokumentierten Pfade wurden für den Lauf umgeleitet, nicht als grundsätzlich isoliert vorausgesetzt. Die Abfragewerkzeuge haben außerdem temporäre Ergebnisdateien unter `%LOCALAPPDATA%\Temp` abgelegt; das sind Host-/Werkzeugdateien, keine OpenCode-Projektänderungen.

Quellen: [OpenCode Installation/Einführung](https://opencode.ai/docs/), [Konfigurationsorte](https://opencode.ai/docs/config/), [Rechte und `external_directory`](https://opencode.ai/docs/permissions/), [Provider-Konfiguration](https://opencode.ai/docs/providers/), [OpenCode-Server](https://opencode.ai/docs/server/) und [Ollama OpenAI-Kompatibilität](https://docs.ollama.com/api/openai-compatibility). Die OpenCode-Dokumentation beschreibt npm, Konfigurationsorte, Provider und Berechtigungen; die konkrete Installation mit `--prefix`, die verwendeten Umgebungsvariablen und die folgenden Pilotresultate sind die hier tatsächlich erprobte Variante.

## 3. Modell, Konfiguration und beobachtete Aufrufe

Für das lokale Ollama-Modell war ein expliziter benutzerdefinierter OpenAI-kompatibler Provider erforderlich; `ollama` wurde von OpenCode ohne Providerblock zunächst nicht gefunden. Danach meldete `opencode models ollama` `ollama/devstral-small-2:24b`; `/config/providers`, Ollamas `/v1/models` und `ollama ps` bestätigten das Modell. OpenCode nutzte als lokale URL `http://127.0.0.1:11434/v1` und den von Ollama dokumentierten Platzhalter-API-Key `ollama`, den der lokale Server ignoriert. Die Providerkonfiguration wurde in `<pilot>\opencode.json` gehalten.

Die wirksame Rechtekonfiguration vor einem Modellaufruf lautete:

```json
{
  "permission": {
    "*": "ask",
    "read": "allow",
    "glob": "allow",
    "grep": "allow",
    "edit": "ask",
    "bash": "ask",
    "external_directory": "deny",
    "webfetch": "deny",
    "websearch": "deny",
    "task": "deny",
    "skill": "deny"
  }
}
```

`opencode debug config` zeigte Modell und Regeln. Es wurde kein `--auto` gesetzt. Der Server war an `127.0.0.1` gebunden; OpenCode protokollierte, dass kein Serverpasswort gesetzt war.

Beobachtete Modell- und Werkzeugaufrufe:

1. Der erste Planlauf verwendete laut Sitzungsdaten `ollama/devstral-small-2:24b` und den eingebauten `plan`-Agenten. Der Agent versuchte, mit `read` ein fremdes Verzeichnis (`/Users/jeasinemsa/Documents/Code/DevHub/DevHub`) zu öffnen. OpenCode protokollierte dafür `external_directory: deny`; der Leseaufruf wurde nicht ausgeführt. Der Agent gab anschließend keine passende Planung zurück.
2. Nach Klarstellung des Test-Workspaces gab der Agent eine Webpack-Upgrade-Aufgabe aus und verwendete `glob` zum Suchen nach Webpack-Dateien im Test-Workspace. Ein `read` der angeforderten Bubble-Testdatei fand nicht statt; die Antwort blieb unvollständig. Es gab keine `edit`, `write`, `patch` oder `bash`-Werkzeugaufrufe.
3. Die API meldete keine offenen Freigabeanforderungen. Es wurde weder eine Freigabe erteilt noch gespeichert. Damit ist die externe Sperre live beobachtet; das erwartete `ask`-Verhalten für Änderungen und Terminalbefehle ist nur durch die wirksame Konfiguration belegt, nicht durch einen Schreib-/Befehlsversuch.

Ein erster Serverstart aus dem Hauptrepository wurde vor jedem Prompt beendet. Der anschließende, tatsächlich für Modellaufrufe verwendete Server wurde aus der Testkopie gestartet und sein Arbeitsverzeichnis über API geprüft. Der Hauptrepository-Status blieb unverändert.

## 4. Pilotauftrag und Prüfung in der Testkopie

Geplanter einzelner Auftrag: genau einen Test für einen erfolgreichen `readProjectFileRange`-Aufruf mit UTF-8-Mehrbytezeichen innerhalb des Ergebnisbudgets ergänzen, ausschließlich in `src/test/extension.test.ts`. **Der Plan wurde vom Modell nicht geliefert; die Schreibprobe wurde gemäß Sicherheitsbedingung ausgelassen.** Die Testkopie enthält deshalb keine Pilot-Codeänderung. `opencode.json` und `.pilot-runtime/` sind reine Testeinrichtung.

Ausführung im unveränderten Teststand auf dem obigen Commit:

| Befehl | Exit-Code | Ergebnis |
|---|---:|---|
| `npm ci` | 0 | Abhängigkeiten installiert; npm meldete sechs Audit-Funde und ein nicht freigegebenes `esbuild`-Installskript. |
| `npm test` | 1 | 166 bestanden, 4 fehlgeschlagen; konkrete Meldungen siehe unten. |
| `npm run package` | 0 | Typecheck, Lint und Produktions-Build erfolgreich. |
| `git diff --check` | 0 | Kein Whitespace-Fehler im getrackten Diff; die ungetrackte Testkonfiguration ist davon nicht erfasst. |

Die Test-Exit-Codes belegen nur den unveränderten Checkout; sie sind kein Test eines Agenten-Patches. Es wurden keine Version erhöht, kein VSIX erstellt, kein F5 gestartet und weder Commit, Push noch PR erstellt. Pilotänderungen wurden nicht ins Hauptrepository übernommen.

### Vier fehlgeschlagene Tests im unveränderten Ausgangsstand

Diese vier Fehler stammen aus dem Lauf von `npm test` auf dem sauberen Pilot-Checkout, bevor der Agent irgendeine Änderung vorgenommen hatte. Es wurden keine Tests oder Produktivdateien zur Untersuchung geändert.

| Test | Tatsächliche Fehlermeldung |
|---|---|
| `Ausgewählte Dateien: Abbruch in der Auswahlliste fragt nichts und ruft Ollama nicht auf` | `Timeout of 2000ms exceeded. For async tests and hooks, ensure "done()" is called; if returning a Promise, ensure it resolves.` |
| `Simulierte Freigabe über den Befehl: Meldung nur bei Zustimmung, Datei unverändert` | `DialogService: refused to show dialog in tests. Contents: Bubble: Vorschlag für "README.md" freigeben?` |
| `Projektanalyse: Folgefragen > Kumulatives Werkzeugbudget > Planmodus: Vorablesen wird berücksichtigt und danach projektweit weitergesucht` | `AssertionError`: `assert.ok(outcome.value)` war false (generiertes `out/test/extension.test.js:2842`). |
| `Beleg-Metadaten: Treffer (Pfad, Zeile), 0 Treffer und gelieferter Bereich gelangen ins Evidence-Protokoll, ohne Inhalte` | `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal`: tatsächlich `[]`, erwartet `[{ line: 2, path: 'src/a.ts' }]` (generiertes `out/test/chat.test.js:788`). |

### Einmaliger rein lesender Pilot: `MAX_TOOL_ROUNDS`

Für diesen Lauf wurde die vorhandene lokale CLI `1.18.34` mit der bestehenden Konfiguration und `ollama/devstral-small-2:24b` verwendet; es wurde nichts installiert. Vor dem Prompt bestätigten Server-API und effektive Konfiguration, dass Arbeitsverzeichnis und `worktree` die Testkopie sind, `read` erlaubt, `edit` und `bash` auf `ask` und `external_directory` auf `deny` gesetzt sind. Es wurde weder `--auto` verwendet noch eine Schreibfreigabe erteilt.

Der einzige Auftrag lautete: „Lies `src/agent/readOnlyAgent.ts`. Finde die Definition von `MAX_TOOL_ROUNDS`. Nenne den tatsächlich gelesenen Wert und den Dateibereich als Beleg. Ändere nichts und schlage keine anderen Projektaufgaben vor.“

Werkzeugspur aus der OpenCode-Sitzung:

- Der Plan-Agent führte mehrere `glob`-Aufrufe aus, um nach sachfremden `Form`-/`get`-Aufgaben zu suchen. Seine Antwort begann mit: „I'll help you plan the implementation for adding `get` method to the Form class.“
- Er rief `read` auf, aber OpenCode wies den Aufruf wegen ungültiger Argumente zurück: `SchemaError(Missing key at ["filePath"])`. Es gab keinen erfolgreichen Leseaufruf von `src/agent/readOnlyAgent.ts`; Wert und Dateibereich wurden nicht genannt.
- Es gab in dieser Sitzung keine `edit`, `write`, `patch` oder `bash`-Aufrufe und keine Freigabeanforderungen. Auch externe Pfade wurden nicht angefordert oder aufgerufen.

Damit scheiterte schon die eng begrenzte Leseaufgabe. Gemäß Vorgabe wurde sofort gestoppt: kein Schreibversuch, keine Prompt-Reparatur und kein weiterer Modelllauf.

## 5. Dokumentiert vs. live nachgewiesen

| Fähigkeit | Dokumentiert | Live nachgewiesen |
|---|---|---|
| npm-Installation und benutzerdefinierte Konfigurationsorte | ja | lokale CLI-Installation ohne globale Installation; tatsächliche Pfade protokolliert |
| Ollama mit OpenAI-kompatibler lokaler URL | Provider-/API-Muster dokumentiert | Modellauflistung und OpenCode-Providerauflösung erfolgreich |
| Devstral als Modell für OpenCode | Konfiguration möglich; keine Verlässlichkeit zugesichert | Modell wurde aufgerufen, aber Aufgabenverständnis/Plan nicht brauchbar |
| Lesen im Workspace | Rechte konfigurierbar | passende Testdatei wurde nicht gelesen |
| Externe Pfade sperren | `external_directory` dokumentiert | ein externer Leseversuch wurde explizit abgewiesen |
| Edit/Bash erfordern Freigabe | `ask` dokumentiert und effektiv konfiguriert | keine Anfrage und daher kein Freigabedialog beobachtet |
| Kleinen Auftrag planen und begrenzt bearbeiten | dokumentierter OpenCode-Ablauf | nein; keine Schreibprobe |
| Bubble-Tests nach Agentenänderung | – | nicht ausgeführt; es gab keine Agentenänderung |

## 6. Einstufung

**Noch nicht einsatzbereit.** Zwar funktionierten Installation, lokale Ollama-Verbindung, Konfigurationsauflösung und die Sperre eines externen Leseversuchs. Der entscheidende Pilotnachweis scheiterte aber vor der Schreibprobe: Devstral erzeugte sachfremde Aufgaben und las nicht die angeforderte Datei. Weil keine Edit-/Bash-Anfrage ausgelöst wurde, ist außerdem keine bewusste Einzelfreigabe beobachtet. Den Agenten für kleine Bubble-Entwicklungsaufträge daher nicht einsetzen, bis ein neuer, kontrollierter Leselauf den passenden Plan liefert und Freigaben verlässlich beobachtet werden.
