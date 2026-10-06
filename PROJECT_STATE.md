# Bubble – Projektstand

## 1. Zweck und Entwicklungsziel

Bubble ist eine lokale VS-Code-Erweiterung für kontrollierte
KI-gestützte Softwareentwicklung über Ollama.

Ziel:
- HPlan und andere Projekte analysieren.
- Konkrete Änderungen planen.
- Änderungen vorab als Diff zeigen.
- Später ausschließlich nach ausdrücklicher Bestätigung schreiben.
- Langfristig auch die eigene Weiterentwicklung unterstützen.

Aktueller Entwicklungsstand:
Read-only-Analyse und Planung funktionieren grundsätzlich.
Dateiübergreifende Planung ist noch nicht zuverlässig.
Ein produktiver Schreibzugriff existiert nicht.

## 2. Verbindliche Arbeitsregeln

- Erst lesen und verstehen, dann Änderungen vorschlagen.
- Keine ungeprüften Aussagen als gesichert darstellen.
- Änderungen klein, nachvollziehbar und gebündelt halten.
- Vollständige Dateien oder exakt bezeichnete Einfügestellen liefern.
- Keine externen Bibliotheken erzwingen.
- Keine automatischen Commits, Pushes, Deployments oder Serverzugriffe.
- Bestehende lokale Änderungen erhalten.
- Sicherheitsgrenzen nicht zur Behebung von Modellproblemen lockern.
- Vergleichbare Projekte anhand offizieller Dokumentation oder
  Primärquellen prüfen; keine unbelegten Lösungsbehauptungen.
- Testberichte unterscheiden zwischen automatisierten Tests und
  tatsächlichen Modell-Praxistests.

Der Copilot-Notizblock wird nicht mehr verwendet.
Projektstand und Entscheidungen werden lokal und mit Git gesichert.

## 3. Entwicklungsumgebung und Modelle

- Entwicklung mit VS Code und Copilot Agent.
- Das Copilot-Agent-Kontingent wurde erweitert, bleibt aber begrenzt.
- Bubble verwendet aktuell das lokal laufende Modell:
  devstral-small-2:24b
- Nach Verbrauch der Copilot-Credits soll die Entwicklung mit einem
  lokalen Agenten fortgesetzt werden.
- Bubble ist noch nicht als zuverlässiger Ersatz für den
  Copilot Coding Agent nachgewiesen.

## 4. Bereits implementierte Funktionen

### 4.1 Chat und Arbeitsmodi

Im Chat sind auswählbar:
- Frage stellen
- Projekt analysieren
- Aktuelle Datei analysieren
- Ausgewählte Dateien analysieren
- Änderung planen
- Werkzeuge (nur lesen)

Vorhanden:
- Systemprüfung im Chat.
- Fortschritts- und Fehleranzeige.
- Gespräch zurücksetzen und Beenden.
- Kopieren von Antwort, Werkzeugprotokoll und Aktivitätsverlauf.
- Gemeinsame Operationssperre gegen überlappende Modellläufe.
- Bestehende VS-Code-Befehle bleiben verfügbar.

### 4.2 Read-only-Werkzeuge

- read_file
- read_file_range
- search_text
- list_directory

„Werkzeuge (nur lesen)“ verwendet denselben runReadOnlyAgent
ohne initialFiles. Das Modell wählt die vorhandenen Werkzeuge.

### 4.3 Aktivitätsverlauf

Angezeigt und als Klartext kopierbar:
- Werkzeug und Ziel
- Status und Fehlergrund
- Modellschritt
- angeforderter und gelieferter Zeilenbereich
- zusätzliche Requestbytes und hypothetische Gesamtgröße

Vorab gelesene Dateien werden als Schritt 0 gekennzeichnet.
Aktivitäten enthalten keine Dateiinhalte oder Modellgedanken.
Es werden keine Aktivitäten erfunden, wenn keine Aufrufe stattfinden.

### 4.4 Analyse und Planung

- Einzeldatei- und kontrollierte Mehrdateianalyse.
- Explizite Dateiauswahl und erforderliche Bestätigungen.
- Planung mit höchstens drei Umsetzungsschritten.
- Erfolgreich gelesene Dateien werden deterministisch als geprüft
  aufgeführt.
- Ungelesene Dateiverweise werden als unklar gekennzeichnet.
- controller.signal und controller.signal.aborted werden nicht mehr
  fälschlich als Dateipfade behandelt.

### 4.5 Änderungsvorschau

Laut bereitgestellter README implementiert:
- Manuelle Single-File-Diff-Vorschau.
- Single-File-Diff-Vorschau mit Ollama.
- Freigabesimulation mit an den Vorschlag gebundenem,
  einmal verwendbarem Nachweis.

Wichtig:
- Keine produktive Anwendung der Änderung.
- Kein realer Writer.
- Die Simulation beweist keinen sicheren oder atomaren Schreibweg.

## 5. Bestehende Sicherheits- und Budgetgrenzen

- Maximal acht Werkzeug-Modellschritte.
- Mehrere Werkzeugaufrufe derselben Modellantwort teilen einen Schritt.
- Blockierte oder budgetabgewiesene Aufrufe zählen zum Modellschritt.
- Vorablesen zählt nicht zum Acht-Schritte-Limit.
- Vollständiger Request: maximal 32.000 UTF-8-Bytes.
- read_file_range:
  - 1-basierte, inklusive Zeilenbereiche
  - maximal 120 Zeilen
  - maximal 4.000 UTF-8-Bytes im Ergebnis
- search_text:
  - wörtliche Suche, keine Regex-Unterstützung
  - ignoriert Groß-/Kleinschreibung
  - "|" verbindet keine Alternativen
  - maximal 40 Treffer
  - maximal 300 Unicode-Zeichen je Treffer
  - maximal 6.000 Bytes serialisiertes Ergebnis
  - emittedHitCount nennt die ausgegebene Trefferzahl

Pfadschutz, gesperrte Dateien und Verzeichnisse sowie
Symlink-/Junction-Prüfungen bleiben verbindlich.

## 6. Zuletzt umgesetzte Korrekturen

### 6.1 Abschluss nach Schrittlimit

Nach dem achten Werkzeug-Modellschritt ist genau eine
Abschlussanfrage ohne Werkzeuge möglich, sofern das Requestbudget
und das Abbruchsignal dies erlauben.

- Keine weiteren Werkzeuge.
- Keine stillschweigende Kürzung.
- Fester Hinweis auf begrenzte Belege und mögliche Unvollständigkeit.
- Fehler, wenn die Abschlussantwort fehlt oder erneut Werkzeuge verlangt.

### 6.2 Navigation nach blockierter Suche

Bei einer Suche in einer bereits vollständig gelesenen Datei:
- vorhandenen Inhalt verwenden oder
- denselben Begriff projektweit ohne include suchen,
- anschließend einen relevanten Treffer mit read_file_range prüfen.

Keine automatische Hintergrundsuche.

### 6.3 Recovery nach abgewiesenem Komplettlesen

Nach einer budgetabgewiesenen read_file-Anfrage ist zusätzlich
eine search_text-Suche erlaubt, wenn include exakt auf dieselbe
abgewiesene Datei zeigt.

Pfad-, Ergebnis- und Requestbudget gelten weiterhin.

### 6.4 Große Vorabdateien im Planungsmodus

Vor dem Vorablesen wird die Dateigröße geprüft.

Wenn die Größe bereits nicht ins Requestbudget passt:
- kein vollständiger read_file-Versuch,
- kein Dateiinhalt übermittelt,
- keine Lesebelege und keine Budgetablehnung für diesen Versuch,
- Hinweis mit Pfad und gezielten Lesealternativen,
- Status not-attempted.

Das Modell entscheidet selbst über Suche und Bereichslesen.

### 6.5 Bereichslesen

Systemtext und Werkzeugbeschreibung empfehlen:
- ausreichend große zusammenhängende Bereiche innerhalb des Bytebudgets,
- keine Kette unnötiger Mini-Nachbarbereiche,
- bereits gelieferte readRange-Bereiche berücksichtigen.

Exakt identische Aufrufe werden blockiert.
Teilüberlappungen und angrenzende Bereiche bleiben erlaubt.
Es gibt bislang keine kompakte Übersicht aller gelesenen Bereiche.

### 6.6 Suchsemantik

Die Query-Beschreibung erklärt jetzt ausdrücklich:
- wörtliche, case-insensitive Suche,
- keine regulären Ausdrücke,
- "|" ist keine Alternativen-Verknüpfung,
- ein konkreter Begriff pro Aufruf ist empfohlen.

Das Ergebnisformat wurde nicht geändert:
emittedHitCount war bereits vorhanden.

### 6.7 Navigationshinweis für benannte Dateien (Ansatz A, implementiert)

`buildPlanTargetHint` (`src/agent/planChange.ts`, Aufruf in `runChatPlan`) erzeugt vor der ersten Modellanfrage einen kurzen Hinweis, wenn der Änderungswunsch genau eine eindeutig benannte, erlaubte, existierende Datei nennt: Pfad, `query` = Codebegriff im Inhalt, `include` = dieser Pfad, danach `read_file_range`. Der Hinweis ist kein Lesebeleg; nichts wird automatisch gelesen oder gesucht. Die Planblockade ohne Lesebeleg (`formatPlanResponse`) bleibt. Bekannte Grenze: Formulierungen ohne Änderungswort (z. B. „Passe … an“) werden nicht erkannt.

### 6.8 Budgetablehnung bei mehreren Aufrufen einer Antwort

Nach der ersten Budgetablehnung wird jeder weitere Dateizugriff derselben Modellantwort nicht ausgeführt (`SKIPPED_AFTER_BUDGET_NOTICE`); beide Hinweise gehen an das Modell. Die Recovery-Regel (nur `read_file_range` oder Suche in derselben Datei) greift erst bei der folgenden Modellantwort. Passt nicht einmal der Hinweis ins Budget, bricht Bubble ehrlich ab; die Fehlermeldung nennt die ausschlaggebende Prüfung.

## 7. Nachgewiesene Praxisergebnisse

Erfolgreich getestet:
- Projektweite Suche nach FINAL_ANSWER_REQUEST.
- Anschließendes gezieltes Bereichslesen.
- Antwort nach zwei Modellschritten.
- Darstellung beider Aktivitäten im Chat.
- Kopieren des Aktivitätsverlaufs.
- Korrekte Auflistung der vorab gelesenen chatSession.ts.
- Kein Fehlalarm mehr für controller.signal.

Noch nicht zuverlässig:
- Dateiübergreifender Plan für eine sichtbare Abbruchmeldung.
- Wiederholt Schrittlimit erreicht, ohne vollständigen Plan.
- Teilweise überlappende Mini-Bereichslesungen.
- Teilweise widersprüchliche Aussagen in Abschlussantworten.
- Abschluss nach Schrittlimit verwendet bisher „Belegt/Unklar“,
  obwohl der Planungsmodus andere Abschnitte verlangt.
- Regex-artige Suchbegriffe führten bei wörtlicher Suche zu
  fehlenden Treffern. Die neue Beschreibung ist noch nicht
  durch einen gemeldeten Live-Vergleich bestätigt.

Die vorgeschlagene Abbruchmeldung wurde noch nicht implementiert.

### 7a. Live-Stand P4/P5 (Einzelbeobachtungen, Details in `docs/praxistests-ergebnisse.md`)
- P4: Navigation in einem Live-Lauf bestanden (Hinweis in Anfrage 1, `search_text` mit Codebegriff und `include`, `read_file_range`, belegter Teilplan, 2/8 Schritte). Wiederholbarkeit offen; frühere P4-Läufe scheiterten.
- P5a (Budget-Recovery): Fehlerabbruch live behoben (kein `RequestTooLargeError` mehr). Recovery durch Devstral live nicht genutzt (Antwort ohne Lesebeleg).
- P5b (Abschluss am Schrittlimit): deterministisch geprüft, live nicht erreicht (max. 2 von 8 Schritten); nicht als live bestanden zu werten.
- Deterministische Tests sind kein Devstral-Nachweis.

## 8. Letzter gemeldeter Validierungsstand

Aktueller Stand (Bericht des Agenten, nach der P5a/P5b-Aufteilung): 191 bestandene Tests (npm test Exit 0, npm run package Exit 0, git diff --check Exit 0). Aus den Dateien allein nicht bestätigt (ungeprüft); vor weiteren Änderungen neu ausführen.

Historische Baseline (unverändert) – nach der Korrektur der Suchbeschreibung:
- npm test: 147 passing, Exit 0
- npm run package: Exit 0
- git diff --check: Exit 0

Letzter gemeldeter git status --short:
 M src/agent/readOnlyAgent.ts
 M src/test/extension.test.ts

Dieser Status ist eine Momentaufnahme aus dem Agentenbericht.
Vor weiteren Änderungen den tatsächlichen Git-Stand prüfen.

Offen:
Ein früherer zusätzlicher Testlauf mit Ausgabeumleitung endete mit
Exit 1. Die Ursache ist nicht geklärt. Ein späterer grüner Lauf
beweist nicht, dass der sporadische Fehler behoben ist.

## 9. Aktueller nächster Auftrag

Vorgeschlagen, noch nicht als umgesetzt gemeldet (Punkte 3 und 5 teilweise durch 6.1, 6.7 und `docs/praxistests.md` abgedeckt; ungeprüft, ob der Kontextstatus vollständig wie beschrieben umgesetzt ist):

„Read-only-Planung mit Kontextstatus und Regressionstests stabilisieren“

Umfang:
1. Beobachtete Fehlerfälle reproduzierbar testen.
2. Kompakten laufbezogenen Kontextstatus für das Modell ergänzen:
   - vollständig übermittelte Dateien,
   - tatsächlich gelieferte Zeilenbereiche,
   - Suchbegriffe und Trefferzahlen,
   - verbleibende Werkzeug-Modellschritte.
3. Aufgabenpassende Abschlussantwort:
   Planungsmodus verlangt auch nach dem Limit seine Planabschnitte.
   Fehlende Belege bleiben ausdrücklich offen.
4. Feste Praxistest-Sammlung mit überprüfbaren Erfolgskriterien.
5. Echte Devstral-Läufe getrennt von simulierten Tests dokumentieren.

Grenzen:
- Keine produktiven Schreibrechte.
- Keine höheren Budgets oder Schrittlimits.
- Keine automatische Hintergrundsuche.
- Keine stillschweigende Kontextkürzung.
- Keine neue Reparaturschleife.
- Keine unabhängigen UI-Umbauten.
- Kleine, getrennt testbare Module statt weiterer Monolithen.

## 9b. Nächster begrenzter Schritt (Empfehlung, nicht umgesetzt)

Siehe `docs/praxistests.md`, Abschnitt „Folgeschritt nach Budgetablehnung“.

## 9a. Versionierung

- Einzige Versionsquelle: `version` in `package.json`; `package-lock.json` (Kopf und `packages[""]`) wird konsistent mitgeführt.
- Chat-Kopfzeile und Systemprüfung lesen die Version zur Laufzeit aus den Erweiterungsmetadaten (`getBubbleVersion` in `src/extension.ts`). Es gibt keine zweite fest codierte Versionsnummer.
- `npm test`, `npm run package` und andere Builds erhöhen die Version nie.
- Ausdrücklich gestarteter Release-Vorbereitungsschritt: `npm run release:prepare` (`scripts/prepare-release.js`). Er führt zuerst `npm run test` und `npm run package` aus. Nur wenn beide mit Exit 0 enden, wird die Patch-Version genau einmal erhöht. Bei Fehlschlag bleibt die Version unverändert (Exit 1).
- Der Schritt erzeugt weder Commit, Tag, Push, VSIX noch Veröffentlichung. Diese bleiben manuelle, ausdrücklich beauftragte Schritte.
## 10. Entwicklungsphasen

### Phase 1: Read-only-Basis stabilisieren
Weit fortgeschritten, noch nicht vollständig abgeschlossen.
Chat, Werkzeuge und Diagnose sind vorhanden.
Verbleibend: Regressionen und ungeklärten Testfehler untersuchen.

### Phase 2: Analyse und Planung verlässlich machen
Aktueller Schwerpunkt.
Kontextstatus, Belegzuordnung, Rechercheeffizienz und Planformat
an festen Aufgaben prüfen.

### Phase 3: Konkrete Änderungsvorschläge ohne Schreiben
Bestehende Diff-Vorschau weiter absichern.
Geprüfte Pläne in nachvollziehbare Vorschläge überführen.

### Phase 4: Sicherer produktiver Schreibzugriff
Noch nicht implementiert.
Nur nach ausdrücklicher Freigabe des konkreten Diffs.
Originalstand vor Schreiben erneut prüfen.
Fehler und teilweise Änderungen sicher behandeln.

### Phase 5: Lokaler Entwicklungsagent für Bubble und HPlan
Kleine Aufgaben mit Devstral reproduzierbar bearbeiten.
Erst nach erfolgreicher Analyse-, Plan- und Diff-Phase ausweiten.

## 11. Git und Sicherungen

- Änderungen mit ausdrücklich genannten Dateien stagen.
- Kein pauschales git add . für Sicherungsdateien.
- bubble-critical-recovery.patch enthält laut Nutzer nur Codeänderungen.
- Die Datei kam versehentlich in ältere veröffentlichte Commits.
- Die Historie wurde nicht umgeschrieben.
- Die lokale Patchdatei wurde über .git/info/exclude ausgeschlossen.

## 12. Pflege dieser Datei

Nach jedem abgeschlossenen Arbeitspaket aktualisieren:
- tatsächlich geänderte Funktionen,
- automatisierte Testergebnisse,
- echte Praxisergebnisse,
- offene Fehler,
- nächster begrenzter Auftrag,
- Git-Sicherungsstand.

Nicht als erledigt markieren:
- nur vorgeschlagene Funktionen,
- nicht ausgeführte Live-Tests,
- vermutete Fehlerursachen,
- Zuverlässigkeit allein aufgrund grüner Unit-Tests.