# Praxistest-Ergebnisse (versioniert)

Szenarien: siehe [praxistests.md](./praxistests.md). Neue Läufe als neuen Abschnitt oben anfügen; frühere Abschnitte nicht überschreiben. Automatisierte Tests und echte Devstral-Läufe stehen getrennt.

## Bubble 0.0.3 – Stand 2026-10-06

### A. Automatisierte Tests (simulierte Modellantworten, keine Aussage über Devstral)
| Prüfung | Ergebnis |
|---|---|
| `npm test` | 157 passing, Exit 0 |
| `npm run package` | Exit 0 |
| `git diff --check` | Exit 0 |

### B. Echte Devstral-Läufe
Modell: `devstral-small-2:24b` (lokales Ollama), Bubble 0.0.3, Modus „Änderung planen“ (`runChatPlan`), je ein Lauf, ohne F5-Host.

| Szenario | Einstufung | Kriterien / Abweichungen | Werkzeuge, Modellschritte | Budget / Abbruch | Vollständiger belegter Plan/Antwort |
|---|---|---|---|---|---|
| P1 Suche + Bereichslesen | bestanden (früherer Lauf, vereinfachte Harness über `runReadOnlyAgent`, nicht `runChatPlan`) | Zeile 17, Wert 120 genannt | `search_text`, `read_file_range`; Schrittzahl nicht erfasst; 36 s, Exit 0 | keine / keiner | ja, Antwort korrekt |
| P2 Suche ohne Treffer | nicht ausgeführt | Früherer Lauf war Harness-Artefakt (Suchbegriff stand im Repo), nicht gewertet | – | – | – |
| P3 Plan über zwei Dateien | teilweise bestanden | Planformat mit 5 Abschnitten eingehalten, keine Schreibwerkzeuge, Unbelegtes als „Unklar“ markiert, Warnung des Systems für ungeprüfte Dateien. Abweichungen: `src/chat/chatView.ts` wurde nur gesucht, nie gelesen; der Plan schlägt dennoch Änderungen dort vor und `getBubbleReleaseDate()` ist nicht belegt; Abschnitt „betroffene Dateien“ nennt nur `src/extension.ts`, Schritt 3 widerspricht dem; „Header in extension.ts“ ohne Beleg | 2× `search_text`, 2× `read_file_range` (`src/extension.ts` 60–80, 165–180); 2 von 8 Werkzeug-Modellschritten, danach Antwort; ca. 48 s Antwortphase, Gesamtlauf ca. 1 min, Testhost Exit 0 | keine Budgetablehnung (max. ca. 24.960 von 32.000 Bytes), kein Abbruch | nein: Teilplan, nur teilweise belegt |
| P4 Große Datei, gezieltes Bereichslesen | nicht ausgeführt (frühere Einzelbeobachtung vor Validator-Fix: 1 Suche, 5 nicht angrenzende Bereiche, Plan geliefert; nicht als Ergebnis gewertet) | – | – | – | – |
| P5 Teilplan nach Schrittlimit | nicht ausgeführt (frühere Einzelbeobachtung: Request-Budget überschritten, `RequestTooLargeError`; nicht als Ergebnis gewertet) | – | – | – | – |

Beobachtungen zu P3:
- Das Schrittlimit wurde nicht erreicht; der Teilplan-Hinweis entstand durch die Validierung der Antwort, nicht durch Erschöpfung.
- Das Modell hat die zweite genannte Datei nicht gelesen, obwohl die Suche Treffer liefern konnte; das ist Modellverhalten und kein nachgewiesener Codefehler.
- Mit nur einem Lauf ist keine Zuverlässigkeitsaussage möglich.

### Live-Ausführbarkeit
Ein begrenzter Lauf (ein Aufruf, 240 s Mocha-Timeout, Vordergrund, `vscode-test --grep`) ohne F5-Host war ausführbar und endete mit Exit 0, 1 passing. Frühere Exit-1-Läufe ohne Ergebnisdatei bleiben ungeklärt.
