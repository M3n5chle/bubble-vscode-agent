# Praxistest-Ergebnisse (versioniert)

Szenarien: siehe [praxistests.md](./praxistests.md). Neue Läufe als neuen Abschnitt oben anfügen; frühere Abschnitte nicht überschreiben. Automatisierte Tests und echte Devstral-Läufe stehen getrennt.

## Bubble 0.0.3 + `SKIPPED_AFTER_BUDGET_NOTICE` (lokal, uncommitted) – Live-Lauf P5, 2026-10-06 (zweiter P5-Eintrag des Tages)

Modell `devstral-small-2:24b`, genau ein Lauf (temporärer Harness über `runChatPlan` mit protokolliertem `fetch`, `vscode-test --grep LIVE`, Exit 0, 1 passing, ca. 1 min; Harness und Ergebnisdatei danach gelöscht). Eingabe und Kriterien unverändert aus `docs/praxistests.md` P5. Build vor dem Lauf geprüft: `SKIPPED_AFTER_BUDGET_NOTICE` in `out/agent/readOnlyAgent.js` und `dist/extension.js`. Der erste P5-Eintrag (darunter) bleibt unverändert erhalten.

### Beobachtung
- Modellschritt 1: `search_text` `query` = `chat`, `include` = `src/chat/**/*.ts` (+6.258 Bytes, hypothetisch 28.102). Anfrage 2 hatte 28.172 Bytes.
- Modellschritt 2: **zwei `read_file` in einer Modellantwort** (wie im ersten Lauf): `src/chat/chatSession.ts` → `budget-rejected` (+12.762, hypothetisch 41.134); `src/chat/chatView.ts` → `not-executed` (+393, hypothetisch 29.098, Grund „Nach Budgetablehnung in derselben Antwort nicht ausgeführt; Hinweis an Ollama übermittelt“).
- **Beide Hinweise erreichten das Modell:** Anfrage 3 (29.236 Bytes, unter 32.000) enthält neben dem Suchergebnis `TOOL_RESULT_BUDGET_NOTICE` und `SKIPPED_AFTER_BUDGET_NOTICE` als tool-Nachrichten.
- Modellschritt 3: **keine Recovery.** Das Modell rief kein `read_file_range` und keine begrenzte Suche auf, sondern lieferte direkt die Abschlussantwort. Kein Abbruch, kein `RequestTooLargeError`. Modellschritte 2 von 8 (Antwort im dritten Modellaufruf), gelesene Belege: keine.

### Antwort
Alle fünf Planabschnitte vorhanden. „betroffene Dateien“ = „Keine“ (korrekt, kein Lesebeleg). Schritte (3) bleiben allgemein; offene Fragen kennzeichnen Dateistruktur und Abhängigkeiten als „Unklar“ (keine Datei erfolgreich gelesen), die Sicherheitsgrenzen als Annahme ohne Beleg. Das Werkzeugprotokoll führt `read_file chatSession.ts` als fehlgeschlagen; der nicht ausgeführte zweite Aufruf erscheint nur in der Größenübersicht (`not-executed`). Ein „Teilplan wegen Schrittlimit“ ist nicht gekennzeichnet, da das Limit nicht erreicht wurde.

### Bewertung
- **Fix live ausgelöst: ja** (Mehrfachaufruf mit abgewiesenem und nicht ausgeführtem Aufruf trat auf). Der frühere Abbruch mit `RequestTooLargeError` trat nicht mehr auf; beide Hinweise erreichten Devstral; der Lauf endete mit Antwort statt Fehler.
- Recovery im Folgeschritt: **nicht genutzt** (Modell antwortete direkt); die Zulässigkeit einer Recovery bleibt live ungeprüft (nur deterministisch getestet).
- Planformat eingehalten: **ja**. Fehlende Belege als offen gekennzeichnet: **ja**, nichts ergänzt.
- Erfolgskriterium P5 („nach 8 Werkzeugschritten Abschlussantwort als Teilplan“): **nicht erreicht** (2 von 8 Schritten, kein Schrittlimit-Teilplan). **P5-Einstufung: nicht bestanden** nach den dokumentierten Kriterien, aber der konkrete Budget-Abbruch ist behoben; verbleibend ist, dass das Modell nach dem Hinweis nicht gezielt weiterliest und früh mit einem inhaltlich leeren, ehrlich gekennzeichneten Plan antwortet.
- Einzelbeobachtung; kein Produktivcode geändert.
## Bubble 0.0.3 + lokale Änderungen (uncommitted) – Live-Lauf P5, 2026-10-06

Modell `devstral-small-2:24b`, genau ein Lauf (temporärer Harness über `runChatPlan` mit protokolliertem `fetch`, `vscode-test --grep LIVE`, Exit 0, 1 passing, ca. 17 s; Harness und Ergebnisdatei danach gelöscht). Eingabe und Kriterien unverändert aus `docs/praxistests.md` P5: `Plane eine Umstrukturierung der gesamten Chat-Logik in src/chat/ mit Prüfung aller Dateien.` Kriterium: nach 8 Werkzeugschritten Abschlussantwort ohne Werkzeuge im Planformat, als Teilplan gekennzeichnet, fehlende Belege als offen.

### Werkzeugfolge
- Anfrage 1 (21.402 Bytes): kein Navigationshinweis (Frage nennt nur das Verzeichnis `src/chat/`, keine einzelne Datei; erwartetes Verhalten).
- Modellschritt 1: `search_text` `query` = `chat`, `include` = `src/chat/**/*.ts`, übermittelt, zusätzliche Request-Bytes 6.258, hypothetisch 28.102 von 32.000. (Trefferzahl nicht protokolliert; Ergebnis am 6.000-Byte-Budget begrenzt.)
- Modellschritt 2 (Anfrage 2: 28.172 Bytes): zwei parallele Aufrufe `read_file` `src/chat/chatSession.ts` (budget-rejected, +12.762, hypothetisch 41.134) und `read_file` `src/chat/chatView.ts` (nicht ausgeführt, +333, hypothetisch 29.038).
- Danach Abbruch mit `RequestTooLargeError` (Meldung nennt 29.038 Bytes; siehe Befund).
- Modellschritte: 2 von 8. Gelesene Belege: **keine** (kein erfolgreiches `read_file`/`read_file_range`; die Suche zählt nicht). Budgetablehnungen: 1 abgewiesen, 1 nicht ausgeführt.

### Abschlussantwort
**Keine.** Es gab keine Planantwort und keinen Teilplan; `runChatPlan` warf `RequestTooLargeError` (Fehlermeldung mit Werkzeugdiagnose ohne Dateiinhalte). Es wurde nichts erfunden, aber auch kein Plan geliefert.

### Bewertung
- Planformat eingehalten: **nicht anwendbar/nein** (keine Antwort).
- Fehlende Belege als offen gekennzeichnet: **nicht prüfbar** (keine Antwort; die Fehlermeldung nennt Budgetablehnung und erlaubten Folgeversuch).
- Teilplan nach Schrittlimit: nicht erreicht (nur 2 von 8 Schritten, Abbruch durch Budgetfehler).
- **P5-Einstufung: nicht bestanden.**

### Befund (nicht behoben)
- Das Modell forderte im selben Schritt zwei vollständige Lesezugriffe auf große Dateien an. Der erste (`chatSession.ts`, +12.762 Bytes) wurde budget-abgewiesen; der zweite Aufruf desselben Schritts trifft laut Code (`readOnlyAgent.ts`, Zweig „budgetRejection && !rangeRecoveryComplete && kein read_file_range/Scoped-Search“) auf die bereits verbrauchte Budgetablehnung und beendet den Lauf mit `RequestTooLargeError`. Die in der Meldung genannten 29.038 Bytes sind die Größe der Anfrage mit Hinweisnachricht und liegen unter 32.000; der Abbruch folgt also der Recovery-Regel, nicht einer Überschreitung dieser Größe (Meldungstext dazu irreführend). Dies ist aus dem Code abgeleitet, nicht separat getestet.
- Die Budget-Recovery („nur kleinerer `read_file_range` oder enge Suche“) kam nicht zum Tragen, weil der Fehler vor der nächsten Modellrunde auftrat. Der Fehlschlag entspricht dem früher beobachteten P5-ähnlichen Verhalten (`RequestTooLargeError`).
- Ein Lauf ist eine Einzelbeobachtung. Kein Produktivcode geändert.
### Folgemaßnahme (automatisiert, nicht live geprüft; Befund oben unverändert)
- Ursache bestätigt (deterministisch reproduziert): Die Prüfung „nach Budgetablehnung nur read_file_range oder Suche in derselben Datei“ lief auch für den zweiten Aufruf **derselben** Modellantwort und warf `RequestTooLargeError`; die Meldung nannte die Größe der Hinweisanfrage (29.038 Bytes, unter 32.000) mit dem Text „überschreitet“.
- Änderung (`readOnlyAgent.ts`): Weitere Aufrufe derselben Antwort nach einer Budgetablehnung werden nicht ausgeführt; das Modell erhält pro Aufruf `SKIPPED_AFTER_BUDGET_NOTICE` (Diagnose `not-executed`, kein Beleg). Passt dieser Hinweis nicht ins 32.000-Byte-Budget, bricht der Lauf ehrlich ab. Die Recovery-Regel gilt unverändert erst für die folgende Modellantwort. Liegt die Größe innerhalb der Grenze, nennt die Fehlermeldung jetzt die Recovery-Regel statt einer Grenzüberschreitung.
- Der frühere Test „Mehrere tool_calls … keine weiteren Werkzeug- oder Ollama-Aufrufe“ kodierte das alte Abbruchverhalten und wurde auf das neue Verhalten umgestellt.

## Bubble 0.0.3 + `buildPlanTargetHint` (lokal, uncommitted) – Live-Lauf P4, 2026-10-06 (Nachholung nach Ollama-Reparatur)

Modell `devstral-small-2:24b`, genau ein Lauf (temporärer Harness über `runChatPlan` mit protokolliertem `fetch`, `vscode-test --grep LIVE`, Exit 0, 1 passing, ca. 2 min; Harness und Ergebnisdatei danach gelöscht). Build vor dem Lauf geprüft: `buildPlanTargetHint` in `out/agent/planChange.js`, `out/chat/chatView.js`, `dist/extension.js`. Eingabe unverändert: `Plane eine Änderung an der Abbruchbehandlung in src/chat/chatView.ts.` Der vorherige Eintrag „nicht durchgeführt“ (Ollama-Manifestfehler) bleibt darunter erhalten.

### Beobachtung
- **Navigationshinweis in der ersten Modellanfrage: ja.** Der user-Prompt (Request 1, 21.738 Bytes) endet mit „Navigationshinweis (kein Beleg, die Datei src/chat/chatView.ts wurde noch nicht gelesen)“ inkl. `query` = Codebegriff, `include` = Pfad, Pfad nie in `query`, danach `read_file_range`.
- Modellschritt 1: `search_text` mit `query` = `abort` (Codebegriff), `include` = `src/chat/chatView.ts` (exakter Dateipfad). 7 Treffer, alle in `src/chat/chatView.ts` (Zeilen 58, 92, 181, 230, 255, 278, 294). Zusätzliche Request-Bytes 1.239, hypothetisch 23.428 von 32.000.
- Modellschritt 2: `read_file_range` `src/chat/chatView.ts` 225–240 (angefordert = geliefert, 16 Zeilen), zusätzliche Bytes 1.034, hypothetisch 24.659. Der Bereich enthält den Treffer in Zeile 230 (`if (signal.aborted) { throw new AgentCancelledError(); }`).
- Danach Abschlussantwort ohne weiteren Aufruf. Modellschritte 2 von 8, keine Budgetablehnung, keine unterbundenen Wiederholungen, keine Auslassungen.

### Antwort
Alle fünf Abschnitte; „betroffene Dateien“ nennt `src/chat/chatView.ts` (tatsächlich gelesen). Der Plan ist allgemein (Analyse, zentrale Abbruchbehandlung, Tests); offene Fragen kennzeichnen die nicht gelesenen Treffer (230 ist gelesen; 255, 278, 294 nicht) und `AgentCancelledError` als „Unklar“. Die Nachbearbeitung ergänzte die Warnung für `src/agent/readOnlyAgent.ts` und `src/chat/chatSession.ts` (genannt, nicht gelesen). Planblockade griff nicht, da ein Lesebeleg vorliegt.

### Prüfpunkte
- Codebegriff als `search_text.query`: **ja** (`abort`).
- Dateipfad als `search_text.include`: **ja**.
- Relevanter Treffer mit `read_file_range` geprüft: **ja** (Treffer Zeile 230 in 225–240).
- Innerhalb Budgets und acht Modellschritte: **ja** (2/8, max. 24.659 von 32.000 Bytes).
- **P4-Einstufung: bestanden** (Einzelbeobachtung).

### Vergleich mit dem letzten gültigen P4-Lauf
Vorher: Query ein Dateiname/Pfad, `include` breit (`**/*.ts`), 22 Treffer außerhalb der Zieldatei, abgewiesenes Voll-`read_file`, kein Bereichslesen. Jetzt: Codebegriff, exaktes `include`, 7 Treffer nur in der Zieldatei, ein kleiner Bereich gelesen. Ansatz A hat in diesem Lauf gewirkt.

### Grenzen
- Ein Lauf ist eine Einzelbeobachtung; Stabilität über Wiederholungen nicht belegt. Die Wirkung ist plausibel dem Vorab-Hinweis zuzuschreiben, aber nicht kausal bewiesen.
- Inhaltliche Qualität begrenzt: Das Modell wählte den ersten passenden Treffer (Zeile 230, Abbruch im Flow „aktuelle Datei analysieren“) und las nicht die übrigen Treffer; der Plan ist allgemein. Er ist als Teilplan ehrlich gekennzeichnet.
- Kein Produktivcode durch diesen Lauf geändert.
## Bubble 0.0.3 + `buildPlanTargetHint` (lokal, uncommitted) – Live-Lauf P4, 2026-10-06 – NICHT DURCHGEFÜHRT (Ollama-Umgebungsfehler)

Geplant: genau ein Lauf mit `devstral-small-2:24b`, Eingabe unverändert (`Plane eine Änderung an der Abbruchbehandlung in src/chat/chatView.ts.`), temporärer Harness über `runChatPlan` mit protokolliertem `fetch`.

- Build geprüft: `buildPlanTargetHint` ist in `out/agent/planChange.js`, `out/chat/chatView.js` und `dist/extension.js` enthalten (kompiliert vor dem Lauf).
- Ergebnis: Beide Startversuche (derselbe Harness; der erste war ein Kompilierfehler-Leerlauf ohne Testausführung) scheiterten bei der ersten Modellanfrage mit `Ollama HTTP 500: CreateFile …\.ollama\models\manifests-v2\ollama.com\library\devstral-small-2\24b: Der Pfad kann nicht durchlaufen werden, da er einen nicht vertrauenswürdigen Bereitstellungspunkt enthält.` Auch `ollama show devstral-small-2:24b` schlägt mit demselben Fehler fehl. Es wurde keine Modellantwort erzeugt.
- Folge: Nichts davon ist eine P4-Bewertung. Ob der Navigationshinweis in der ersten Modellanfrage steht, welche `search_text`-Aufrufe Devstral wählt und ob `read_file_range` folgt, ist **ungeprüft**. Ansatz A bleibt live unbewertet; der letzte gültige P4-Eintrag (darunter) bleibt der aktuelle Stand „nicht bestanden“.
- Voraussetzung für den Lauf: Ollama-Modellmanifest für `devstral-small-2:24b` wieder lesbar machen (z. B. Modell neu ziehen oder `OLLAMA_MODELS`-Pfad prüfen). Kein Produktivcode betroffen; Harness gelöscht.
## Bubble 0.0.3 + geänderte `search_text`-Beschreibung (lokal, uncommitted) – Live-Lauf P4, 2026-10-06 (zweiter P4-Eintrag des Tages)

Modell `devstral-small-2:24b`, genau ein Lauf (temporärer Harness über `runChatPlan` mit durchgereichtem `fetch` zur Protokollierung, `vscode-test --grep LIVE`, Exit 0, 1 passing, ca. 72 s; Harness und Ergebnisdatei danach gelöscht). Eingabe unverändert: `Plane eine Änderung an der Abbruchbehandlung in src/chat/chatView.ts.` Vergleich mit dem vorigen P4-Eintrag (direkt darunter; erhalten).

### Werkzeugaufrufe
- Modellschritt 1: `search_text` mit `query` = `chatView.ts` (Dateiname, **kein** Codebegriff) und `include` = `**/*.ts` (**nicht** der Dateipfad). 22 ausgegebene Treffer: 21 in `src/test/extension.test.ts` (Zeilen 2030–3721), 1 im temporären Harness `src/test/live.test.ts` (Artefakt des Laufs). Kein Treffer in `src/chat/chatView.ts`. Zusätzliche Request-Bytes 4.591, hypothetische Gesamtgröße 26.411 von 32.000.
- Modellschritt 2: `read_file` `src/chat/chatView.ts` (vollständig angefordert, kein `read_file_range`): `budget-rejected` (zusätzliche Bytes 34.142, hypothetisch 60.711), Ergebnis nicht an Ollama übermittelt, Hinweis übermittelt.
- Danach Abschlussantwort. Modellschritte 2 von 8; keine unterbundenen Wiederholungen. Gelesene Bereiche: keine; `chatView.ts` nie gelesen und nicht als gelesen geführt.

### Antwort
Alle Planabschnitte vorhanden; „betroffene Dateien: Keine“; Schritt 1 mit `[UNGEPRÜFT: src/chat/chatView.ts nicht gelesen, nur Annahme]`; Schritt 2 nennt `read_file_range` nur als Vorhaben, Abschnitt 5 und Warnblock nennen `chatView.ts` als nicht gelesen. Inhaltlich ein leerer Teilplan, ehrlich gekennzeichnet.

### Prüfpunkte
- Codebegriff als `search_text.query`: **nein** (`chatView.ts`, ein Dateiname).
- Dateipfad als `search_text.include`: **nein** (`**/*.ts`).
- Relevanter Treffer mit `read_file_range` geprüft: **nein** (kein Treffer in der Zieldatei; stattdessen ein vollständiges `read_file`, vom Budget abgewiesen).
- Innerhalb der Budgets und acht Modellschritte: **ja** (2/8; Request nie über 32.000 Bytes übermittelt).
- **P4-Einstufung: weiterhin nicht bestanden.**

### Vergleich mit dem vorigen P4-Eintrag
- Gleich: Query war ein Pfad-/Dateiname-Begriff statt Codebegriff; kein Treffer in `chatView.ts`; kein `read_file_range`; Datei nie gelesen; Ehrlichkeitskriterien erfüllt.
- Anders: Vorher `include` = `**/*` und 1 Schritt, 21 Treffer (Doku, `out/`, Tests); jetzt `include` = `**/*.ts`, 22 Treffer nur in `.ts`-Tests, plus ein zweiter Schritt mit dem budgetabgewiesenen Vollzugriff `read_file`. Die Beschreibung wirkte nur insoweit, als `include` auf Dateityp eingegrenzt wurde; die Anweisung „Query = Inhalt, Datei über include“ wurde nicht befolgt.

### Abweichungen und Grenzen
- Folgemaßnahme (nicht live geprüft): `search_text` liefert bei einem Dateinamen als `query` und breitem `include` (Glob) im Ergebnis das Feld `parameterHint` (Rollen: query = Inhalt, include = Zieldatei). Die Suche läuft unverändert, keine Ersatzsuche, kein Sperren; Dateinamensuche im Inhalt bleibt gültig. Die Budget-Recovery nach abgewiesenem `read_file` nennt bereits `read_file_range` und eine eng begrenzte Suche in derselben Datei; eine Lücke ist nicht belegt, daher unverändert.
- Der Harness-Treffer in `src/test/live.test.ts` (1 von 22) stammt vom Messaufbau, nicht vom Produktcode.
- Ein Lauf ist eine Einzelbeobachtung; die Ursache des Modellverhaltens ist nicht belegt. Kein zweiter Lauf, keine Produktivcodeänderung durch diesen Lauf (die Beschreibungsänderung in `readOnlyAgent.ts` war bereits lokal vorhanden).

## Bubble 0.0.3 – Live-Lauf P4 „Große Datei mit gezieltem Bereichslesen“, 2026-10-06

Modell `devstral-small-2:24b`, genau ein Lauf (Harness über `runChatPlan`, `vscode-test --grep LIVE`, Exit 0, 1 passing, ca. 62 s; Harness danach gelöscht). Eingabe und Kriterien unverändert aus `docs/praxistests.md` P4.

### Beobachtung (aus Protokoll und Metadaten)
- Werkzeugfolge: genau 1 Aufruf: `search_text` mit dem Suchbegriff `src/chat/chatView.ts` (der Dateipfad als Query) in `**/*`. 21 ausgegebene Treffer, verteilt auf `docs/praxistests-ergebnisse.md` (12), `docs/praxistests.md` (3) und `out/test/extension.test.js` (6); kein Treffer in `src/chat/chatView.ts`. Zusätzliche Request-Bytes 6.476, Gesamtgröße 27.883 von 32.000.
- Modellschritte: 1 von 8. Kein `read_file`, kein `read_file_range`. Keine Budgetablehnung, kein Abbruch, keine unterbundenen Wiederholungen. `chatView.ts` wurde nicht vorab vollständig gelesen (Hinweis auf Budget hier nicht ausgelöst, da die Datei gar nicht angefordert wurde).
- Antwort: alle Planabschnitte vorhanden; „betroffene Dateien: Keine“; Schritt 1 mit `[UNGEPRÜFT: src/chat/chatView.ts nicht gelesen, nur Annahme]`; Abschnitt 5 und Warnblock nennen `chatView.ts` als nicht gelesen.

### Bewertung gegen die Kriterien
- Vollständiges Lesen vermieden: ja (Datei nie gelesen).
- Relevante Stelle durch Suche gefunden: nein. Die Query war ein Pfad statt eines Codebegriffs, die Treffer stammen aus Doku und kompiliertem Test-Output, nicht aus `chatView.ts`.
- Passender Bereich gelesen: nein, kein `read_file_range`. Damit auch keine Wiederholungen oder Mini-Bereiche.
- Datei erscheint nie als vollständig gelesen: erfüllt. Ehrliche Kennzeichnung: erfüllt.
- Antwort durch gelesene Stellen gedeckt: nur insofern, als sie keine Details behauptet und als ungeprüft markiert; inhaltlich ein leerer Teilplan (Schritte 2 und 3 sind generisch).
- **P4-Einstufung: nicht bestanden** (Kriterium „Modell nutzt `search_text` und kleine `read_file_range`-Aufrufe“ nicht erfüllt); die Ehrlichkeitskriterien sind erfüllt.

### Engpass (belegt, nicht behoben)
Das Modell beendete nach einem einzigen, wirkungslosen Suchaufruf (Pfad als Query, workspaceweit, Treffer in Doku/`out/`) und las nichts. Belegt ist der Protokollverlauf; die Ursache im Modell (warum es keinen weiteren Schritt machte) ist nicht belegt. Beitragend möglich: Die Suche nach dem Pfadstring über `**/*` liefert Treffer aus `docs/` und `out/`, nicht aus der Zieldatei (Beobachtung); ob ein enger gefasster Hinweis zu einem Codebegriff in `chatView.ts` führen würde, ist ungeprüft.

### Ungeprüfte Annahmen
- Dass ein zweiter Lauf anders verliefe, wurde nicht geprüft (kein zweiter Lauf, wie beauftragt).
- Dass die Treffer in `out/` und `docs/` das Modell von weiteren Schritten abhielten, ist Vermutung.
## Bubble 0.0.3 + L4-Korrektur – Live-Lauf P3, 2026-10-06 (zweiter Lauf des Tages nach L4-Fix)

Modell `devstral-small-2:24b`, Bubble 0.0.3, genau ein Lauf (Harness über `runChatPlan`, `vscode-test --grep LIVE`, Exit 0, 1 passing, ca. 72 s; Harness danach gelöscht). Eingabe unverändert aus `docs/praxistests.md` P3.

**Werkzeugfolge:** Modellschritt 1: `search_text "getBubbleVersion"` in `src/extension.ts` (3 ausgegebene Treffer: Zeilen 66, 130, 173) und in `src/chat/chatView.ts` (0 Treffer, trotzdem „erfolgreich“). Modellschritt 2: `read_file_range` `src/extension.ts` 60-80 und 165-180 (jeweils vollständig geliefert). Danach Abschlussantwort. `chatView.ts` und `package.json` nie gelesen.
**Modellschritte:** 2 von 8. **Budget:** keine Ablehnung, keine unterbundenen Wiederholungen; höchste hypothetische Requestgröße 24.960 von 32.000 Bytes.

**Planergebnis:** Alle Planabschnitte vorhanden, Teilplan durch Warnungen kenntlich (Abschnitt 5 und Warnblock nennen `package.json` und `src/chat/chatView.ts` als nicht gelesen).
- Schritt 1 (`getBubbleReleaseDate()` einführen, liest aus `package.json`): `[UNGEPRÜFT: package.json nicht gelesen …]` mit Pfad, plus Stellenmarkierung für `src/extension.ts` (gelesene Zeilen 60-80, 165-180). Kein UNBELEGT, da das Symbol als neu formuliert ist.
- Schritt 2: Stellenmarkierung für `src/extension.ts`. Schritt 3: `[UNGEPRÜFT: src/chat/chatView.ts nicht gelesen, nur Annahme]`.
- Dateiliste nennt nur `src/extension.ts` (geprüft); Schritte und Warnungen sind konsistent (ungelesene Dateien stehen nur markiert in den Schritten).

**Einstufung L4: live nicht geprüft.** Der Plan nannte `getBubbleVersion()` in keinem Umsetzungsschritt, daher wurde die Symbolprüfung (Treffer plus ungelesene zweite Datei im selben Schritt) nicht ausgelöst. Der Nachweis bleibt auf die automatisierten Tests (170 passing) beschränkt. Es wurde kein falsch-positives UNBELEGT beobachtet, aber auch kein Gegenbeleg erzeugt.
**Bestätigt (live, nur für diese Konstellation):** ungelesene Dateien erhalten UNGEPRÜFT mit konkretem Pfad; Suche mit 0 Treffern belegt nichts; Stellenbezug nur auf gelieferte Bereiche.
**Abweichungen/Beobachtungen:** `chatView.ts` wurde nur durchsucht (0 Treffer), nicht gelesen (Modellverhalten); Schritt 3 schlägt dennoch eine Änderung dort vor (gekennzeichnet). Gesamteinstufung P3: teilweise bestanden (ehrlicher Teilplan, L4 offen).
## Bubble 0.0.3 + Metadaten-Belege (L1–L3) – Live-Lauf P3, 2026-10-06

Version unverändert 0.0.3. Modell `devstral-small-2:24b`, `runChatPlan`, Eingabe unverändert aus `praxistests.md` P3, genau ein Lauf (Testhost Exit 0, 1 passing, ca. 1,5 min). Frühere Einträge darunter unverändert.

### A. Automatisierte Tests
`npm test` 166 passing, Exit 0; `npm run package` Exit 0; `git diff --check` Exit 0 (simulierte Antworten, keine Aussage über Devstral).

### B. Live-Lauf
| Aspekt | Beobachtung |
|---|---|
| Einstufung | teilweise bestanden (gleiche Stufe wie die früheren P3-Läufe, aber Kennzeichnung deutlich besser; eine neue Lücke L4) |
| Werkzeugfolge | Schritt 1: `search_text` „getBubbleVersion“ in `src/extension.ts` und in `src/chat/chatView.ts`; Schritt 2: `read_file_range` `src/extension.ts` 60–80 und 165–180 (angefordert = geliefert) |
| Trefferzahlen (aus Beleg-Metadaten) | `extension.ts`: 3 ausgegebene Treffer (Zeilen 66, 130, 173); `chatView.ts`: 0 Treffer, Suche trotzdem „erfolgreich“ |
| Modellschritte | 2 von 8 Werkzeug-Modellschritten, danach Antwort |
| Budget / Abbruch | keine Ablehnung, kein Abbruch; max. 24.960 von 32.000 Bytes |
| Plan | Planformat vollständig, Warnung für `package.json` und `src/chat/chatView.ts`, „Unklar, weil nicht gelesen“; Teilplan, kein vollständig belegter Plan (Überschrift „TEILPLAN“ fehlt, da das Schrittlimit nicht erreicht wurde) |

Antwort (Umsetzungsschritte, Markierungen wörtlich):
1. `getBubbleVersion()` um ein optionales `releaseDate`-Feld aus `package.json` erweitern. `[UNGEPRÜFT: package.json nicht gelesen, nur Annahme] [UNBELEGT: getBubbleVersion() durch keinen Suchtreffer in der genannten Datei belegt]`
2. Chat-Header in `src/chat/chatView.ts` … ergänzen. `[UNGEPRÜFT: src/chat/chatView.ts nicht gelesen, nur Annahme]`
3. Versionsanzeige in der Systemprüfung (Zeile 173) um das Datum erweitern. (unmarkiert)

Prüfpunkte:
1. Suchen mit 0 Treffern als Symbolbeleg? Nein im Beleg: `chatView.ts` hat `hits: []`. Ein Symbol-Schritt allein auf diesen 0 Treffern kam im Lauf nicht vor, der Fall ist live nicht ausgelöst und nur automatisiert belegt.
2. Vorschläge zu ungelesenen Dateien mit konkretem Pfad: ja (`package.json`, `src/chat/chatView.ts`); die in der Baseline fehlende Kennzeichnung von Schritt 2 ist behoben.
3. Aussagen zu ausschnittsweise gelesener Datei: Schritt 3 nennt Zeile 173 in `extension.ts`; sie liegt im gelieferten Bereich 165–180 und blieb zu Recht unmarkiert. Der Fall „nicht zuordenbar“ trat nicht auf.
4. Konsistenz: Dateiliste (nur `extension.ts`), Markierungen und Warnung stimmen überein; der Plan verortet den Header nun korrekt in `chatView.ts` (Baseline: fälschlich in `extension.ts`) und markiert ihn als ungelesen.
5. Ergebnis: ehrlich gekennzeichneter Teilplan.

### C. Neue Lücke (nicht behoben)
- L4: Schritt 1 nennt `getBubbleVersion()` zusammen mit `package.json`. Die Prüfung bewertet das Symbol gegen die im Schritt genannten Dateien, und dazu zählt die ungelesene `package.json` (0 Treffer). Ergebnis: `[UNBELEGT: getBubbleVersion() …]`, obwohl das Symbol per Suchtreffer in `src/extension.ts` (Zeilen 66, 130, 173) belegt ist. Die Markierung ist irreführend (falsch-positiv); nach Code-Lage zu eng: Dateien, die selbst ungelesen sind, sollten nicht als Suchort für den Symbolbeleg gelten, oder die Markierung sollte benennen, in welcher Datei Treffer vorliegen. Beleg: Beleg-Metadaten im Lauf (Treffer 66/130/173) und die Markierung in Schritt 1.
- Beobachtet (Modellverhalten, keine Codelücke): `chatView.ts` wurde trotz 0 Treffern und Plan-Schritt dazu weiterhin nicht gelesen; ein Lauf erlaubt keine Zuverlässigkeitsaussage.
## Bubble 0.0.3 + Kennzeichnung ungeprüfter Schritte (`markUnverifiedSteps`) – 2026-10-06

Version unverändert 0.0.3 (nicht erhöht, nicht committed); Stand = Baseline-Code plus `markUnverifiedSteps`. Die 0.0.3-Baseline unten bleibt unverändert. Ein Live-Lauf, `devstral-small-2:24b`, `runChatPlan`, Eingabe unverändert aus `praxistests.md` P3.

### A. Automatisierte Tests
`npm test` 161 passing, Exit 0; `npm run package` Exit 0; `git diff --check` Exit 0 (simulierte Antworten, keine Aussage über Devstral).

### B. Live-Lauf P3 (Testhost Exit 0, 1 passing, ca. 1,5 min)
| Aspekt | Beobachtung |
|---|---|
| Einstufung | teilweise bestanden (wie Baseline) |
| Werkzeugfolge | Schritt 1: `search_text` „getBubbleVersion“ in `src/extension.ts`, `search_text` dasselbe in `src/chat/chatView.ts` (beide „erfolgreich“); Schritt 2: `read_file_range` `src/extension.ts` 60–80 und 165–180 |
| Modellschritte | 2 von 8 Werkzeug-Modellschritten, danach Antwort; Schrittlimit nicht erreicht |
| Budget | keine Ablehnung, kein Abbruch; max. 24.960 von 32.000 Bytes |
| Trefferzahlen | im Protokoll/Aktivitätsereignis nicht verfügbar (nur „erfolgreich“, Request-Bytes 772 bzw. 332) |
| Plan | Planformat vollständig, Warnung „Unbelegte Dateibehauptung: package.json, src/chat/chatView.ts“, Hinweis „Unklar, weil nicht gelesen“; Teilplan, kein vollständig belegter Plan |

Prüfpunkte:
1. Konkrete Änderung an nur durchsuchter, nicht gelesener Datei als UNGEPRÜFT? Das Modell schlug diesmal keinen Schritt in `chatView.ts` vor; stattdessen stand `package.json` in Schritt 1 und wurde mit `[UNGEPRÜFT: Datei nicht gelesen, nur Annahme]` markiert. Der Fall „Schritt nennt `chatView.ts`“ trat im Live-Lauf nicht auf; er ist nur automatisiert belegt. Die Markierung nennt nicht, welche Datei gemeint ist.
2. „betroffene Dateien“ und Schritte: formal konsistent (nur `src/extension.ts`). Inhaltlich fehlerhaft: Schritt 2 verortet den Chat-Header in `src/extension.ts`. Der Header-HTML-Aufbau liegt laut Code in `getChatHtml` in `src/chat/chatView.ts` (nachträglich per Quelltext geprüft, nicht vom Modell); der gelesene Bereich enthielt ihn nicht. Dieser Schritt blieb unmarkiert, weil die Prüfung dateibasiert ist und `extension.ts` gelesen wurde.
3. Unbelegte Symbole: im Plan kam nur `getBubbleVersion()` vor; es war Suchbegriff und existiert (`extension.ts`), daher korrekt unmarkiert. Keine unbelegten Symbole aufgetreten, Kennzeichnung im Live-Lauf nicht ausgelöst.
4. Suche erfolgreich, aber 0 Treffer: Im Lauf trat genau das auf: `getBubbleVersion` kommt in `src/chat/chatView.ts` nicht vor (Quelltextprüfung), die Suche dort galt trotzdem als „erfolgreich“. Der Code unterscheidet im Beleg (`ToolEvidence`: nur `success`) nicht zwischen Treffern und 0 Treffern.
5. Teilplan: ehrlich gekennzeichnet durch Warnung und „Unklar“-Hinweis; die Überschrift „TEILPLAN“ erscheint nicht, da das Schrittlimit nicht erreicht wurde.

### C. Nachgewiesene Lücken (Stand des Live-Laufs; danach siehe D)
- L1: `markUnverifiedSteps` wertet ein Symbol als belegt, sobald eine erfolgreiche `search_text`-Anfrage es enthält, unabhängig von Trefferzahl (0 Treffer möglich). Im Lauf nicht schadensrelevant, im Code aber belegt.
- L2: Die Prüfung ist dateibasiert, nicht bereichsbasiert: Eine Aussage über „Chat-Header in `extension.ts`“ gilt als geprüft, obwohl der gelesene Bereich ihn nicht enthielt.
- L3: Die Markierung nennt nicht die betroffene Datei, und `package.json` wird wie eine geplante Änderung behandelt.
- Beobachtet (Modellverhalten, keine Codelücke): `chatView.ts` wurde nach 0 Treffern nicht gelesen, obwohl dort der Header gerendert wird. Ein Lauf ist keine Zuverlässigkeitsaussage.
### E. Folgeänderung zu L4 (automatisiert; Live-Nachweis offen)
L4 behoben: Ein ausgegebener Symboltreffer wird nicht mehr entwertet, weil der Schritt zusätzlich eine ungelesene Datei nennt; deren UNGEPRÜFT-Markierung mit Pfad bleibt. 0 Treffer, anderes Symbol, nicht ausgegebene Treffer und Treffer in einer anderen als der genannten gelesenen Datei belegen weiterhin nichts (4 neue Tests, 170 passing). Kein neuer Live-Lauf; P3 bleibt "teilweise bestanden".

### D. Folgeänderung zu L1–L3 (automatisiert; Live-Nachweis offen)
L1–L3 sind in der Plan-Nachbearbeitung behoben (Details: `praxistests.md`, Abschnitt C): Treffer/Bereiche werden als Metadaten im Protokoll geführt, 0 Treffer und Treffer in anderen Dateien belegen kein Symbol, ein Bereichslesen belegt nur die gelieferten Zeilen, Markierungen nennen den konkreten Pfad. Nachweis nur durch deterministische Tests (`npm test` 166 passing); kein neuer Live-Lauf, P3 daher unverändert „teilweise bestanden“. Grenze: keine semantische Prüfung, siehe Abschnitt C.
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
