# Praxistests für den Planungsmodus

Version 0.0.3. Dieses Dokument trennt zwei Arten von Prüfungen.

## A. Automatisierte Tests (deterministisch)

`npm test` (Mocha im VS-Code-Testhost, `src/test/*.test.ts`) verwendet simulierte Modellantworten. Geprüft werden nur Routing, Budgets (32.000 Requestbytes, 8 Werkzeug-Modellschritte, Ergebnisbudgets), Pfadsperren, Formatvorgaben und der Kontextstatus. Sie sagen **nichts** über die Zuverlässigkeit von devstral-small-2:24b aus.

Tests, die den Inhalt von Regeldateien (`PROJECT_STATE.md`, `AGENTS.md`, `AGENT_RULES.md`) im Systemprompt beeinflusst, nutzen eigene Temp-Workspaces. Bewusst noch auf dem echten Repo (kein Budgetbezug oder nur über Befehle auflösbar): Fehlergrund-Anzeige bei `read_file_range`, Abbruch ohne Fetch, „Überschreitung durch Werkzeugergebnisse…“, README-Tests und die Suite „Projektanalyse: Folgefragen“.

## B. Manuelle Devstral-Praxistests

Ausführung: Chat-Modus „Änderung planen“, Ollama-Modell `devstral-small-2:24b`, Workspace = dieses Repository. Jede Frage einzeln in einem neuen Chat stellen. Das Ergebnis hängt vom Modell ab; wiederholen und Abweichungen notieren, nicht verallgemeinern.

### P1 – Einfache Suche mit Bereichslesen
Eingabe: `Suche in src/tools/readTools.ts nach MAX_RANGE_LINES und lies danach die Definitionszeile per read_file_range. Nenne Zeilennummer und Wert.`
Kriterien: Aktivität zeigt `search_text` und danach `read_file_range` (je erfolgreich); Antwort nennt Zeile 17 und Wert 120.

### P2 – Suche ohne Treffer
Eingabe: `Suche in src/chat/chatView.ts nach dem Begriff "zzqx-nicht-vorhanden-7731" und berichte das Ergebnis.`
Kriterien: Trefferzahl 0 wird gemeldet; Datei gilt nicht als gelesen (Kontextstatus führt sie nicht unter gelesenen Bereichen); Antwort erfindet keinen Dateiinhalt. Hinweis: Der Suchbegriff darf nicht selbst im Repository stehen (diese Datei enthält ihn bewusst nur in der Eingabe; bei Fehltreffern Begriff ändern).

### P3 – Plan über zwei Dateien
Eingabe: `Plane, wie die Versionsanzeige im Chat-Header um das Erscheinungsdatum erweitert werden könnte. Relevante Dateien: src/extension.ts und src/chat/chatView.ts.`
Kriterien: Antwort enthält die Planabschnitte (Ziel…) oder ist als Teilplan gekennzeichnet; Aussagen stützen sich nur auf gelesene Bereiche; keine Schreibwerkzeuge.

### P4 – Große Datei mit gezieltem Bereichslesen
Eingabe: `Plane eine Änderung an der Abbruchbehandlung in src/chat/chatView.ts.`
Kriterien: Datei wird nicht vollständig vorab gelesen (Hinweis auf Budget); Modell nutzt `search_text` und kleine `read_file_range`-Aufrufe; Datei erscheint nie als vollständig gelesen.

### P5 – Teilplan nach Schrittlimit
Eingabe: `Plane eine Umstrukturierung der gesamten Chat-Logik in src/chat/ mit Prüfung aller Dateien.`
Kriterien: Nach 8 Werkzeugschritten folgt eine Abschlussantwort ohne Werkzeuge im Planformat, deutlich als Teilplan gekennzeichnet; fehlende Belege sind als offen benannt, nicht ergänzt.

### Bisher beobachtete Live-Ergebnisse (Einzelbeobachtungen)
- P1: korrekt (Suche, Bereich, Zeile 17 = 120; Lauf 36 s, Exit 0).
- P3-ähnlicher Lauf: nur Suchen, kein Plan (Modellverhalten).
- P4-ähnlicher Lauf: 1 Suche, 5 nicht angrenzende Bereiche, Plan geliefert.
- P5-ähnlicher Lauf: Request-Budget überschritten, `RequestTooLargeError` (bestehendes Verhalten).
- Frühere automatisierte Live-Läufe über `vscode-test` endeten mehrfach mit Exit 1 ohne Ergebnisdatei. Ursache ungeklärt; ein erneuter begrenzter Lauf (ein Aufruf, 240 s Timeout) lief fehlerfrei. Live-Läufe sind daher nicht als zuverlässig reproduzierbar belegt.
