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

## C. Nachbearbeitung ungeprüfter Planaussagen (automatisiert)

`formatPlanResponse` (`src/agent/planChange.ts`, `markUnverifiedSteps`) hängt an Umsetzungsschritte Markierungen an; es wird nichts entfernt oder ergänzt. Grundlage sind Metadaten im Werkzeugprotokoll (`ToolEvidence`, nie Inhalte): bei `search_text` Suchbegriff und ausgegebene Treffer (Pfad, Zeile), bei `read_file_range` der tatsächlich gelieferte Bereich.

- `[UNGEPRÜFT: <Pfad> nicht gelesen, nur Annahme]`: Schritt nennt eine Datei ohne erfolgreiches `read_file`/`read_file_range` (ein Suchtreffer genügt nicht).
- `[UNBELEGT: name() …]`: Symbol `name()` im Schritt ist nicht als neu formuliert (einführen, hinzufügen, anlegen …) und keine erfolgreiche Suche danach hatte mindestens einen ausgegebenen Treffer in einer im Schritt genannten Datei (ohne Dateinennung: in irgendeiner Datei). Nennt der Schritt eine gelesene Datei, muss der Treffer dort (oder in einer genannten ungelesenen Datei) liegen; nennt er nur ungelesene Dateien, belegt ein ausgegebener Treffer in irgendeiner Datei die Existenz des Symbols (die ungelesene Datei bleibt separat UNGEPRÜFT, der Symboltreffer bestätigt nie die Umsetzungsaussage). 0 Treffer, ein Treffer für ein anderes Symbol, ein nicht ausgegebener Treffer oder ein Treffer in einer anderen als der genannten gelesenen Datei belegt nichts; Belege ohne Trefferdaten gelten nicht als Beleg.
- `[UNGEPRÜFT: Stelle in <Pfad> nicht aus den gelesenen Zeilen a-b, … zuordenbar]`: Datei wurde nur per `read_file_range` gelesen und weder ein Treffer des Symbols noch eine ausdrücklich genannte Zeile („Zeile 70“, „Zeilen 60-80“, „datei.ts:70“) liegt in einem gelieferten Bereich. Vollständig gelesene Dateien lösen das nicht aus.

Verbleibende Grenzen: Bei einem Schritt mit ungelesener Datei und ohne genannte gelesene Datei lässt sich das Symbol keiner Datei zuordnen; es wird nur seine Existenz belegt, keine Position. Es gibt keine semantische Codeprüfung. Ein Treffer im gelieferten Bereich zeigt nur, dass der Suchbegriff dort steht, nicht dass die Aussage des Schritts stimmt. Schritte ohne Symbol und ohne Zeilenangabe in einer nur ausschnittsweise gelesenen Datei werden immer als nicht zuordenbar markiert (konservativ, auch bei „neu einführen“). Symbole ohne `()` und Aussagen ohne Dateinennung werden nicht geprüft. Die Treffer-Liste ist auf die ausgegebenen Treffer der Suche begrenzt; nicht ausgegebene Treffer zählen nicht als Beleg.

Die Tests (`extension.test.ts`, `chat.test.ts`) nutzen simulierte Modellantworten und beweisen **nicht**, dass Devstral weniger ungeprüfte Aussagen erzeugt; sie belegen nur Kennzeichnung und Datenfluss. Die Wirkung ist per P3 manuell zu prüfen.