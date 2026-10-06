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

### P5 – Teilplan nach Schrittlimit (aufgeteilt in P5a und P5b)
Eingabe: `Plane eine Umstrukturierung der gesamten Chat-Logik in src/chat/ mit Prüfung aller Dateien.`

**P5a – Budget-Recovery** (live bewertbar). Zwei getrennte Kriterien:
- Fehlerabbruch behoben: Mehrere `read_file`-Aufrufe in einer Modellantwort führen nicht zu `RequestTooLargeError`; der erste wird budgetabgewiesen, die übrigen nicht ausgeführt, beide Hinweise erreichen das Modell. Live erfüllt (zweiter P5-Lauf).
- Recovery durch Devstral genutzt: Im Folgeschritt folgt ein zulässiger `read_file_range` oder eine Suche in derselben Datei. Live nicht erfüllt (Devstral antwortete ohne Lesebeleg).

**P5b – Abschluss am Schrittlimit**. Kriterien: Nach genau 8 Werkzeug-Modellschritten werden keine Werkzeuge mehr ausgeführt; die Abschlussanfrage erfolgt nur innerhalb des 32.000-Byte-Requestbudgets; die Antwort hat Planformat bzw. ist ehrlich als Teilplan gekennzeichnet; es entstehen keine erfundenen Lesebelege; passt die Abschlussanfrage nicht, gibt es einen klaren Fehler. Live **nicht belegt**: Beide P5-Läufe erreichten nur 2 von 8 Schritten. Nur deterministisch geprüft (simulierte Antworten); das ist kein Devstral-Live-Nachweis.
### Bisher beobachtete Live-Ergebnisse (Einzelbeobachtungen)
- P1: korrekt (Suche, Bereich, Zeile 17 = 120; Lauf 36 s, Exit 0).
- P3-ähnlicher Lauf: nur Suchen, kein Plan (Modellverhalten).
- P4-ähnlicher Lauf: 1 Suche, 5 nicht angrenzende Bereiche, Plan geliefert.
- P5-ähnlicher Lauf: Request-Budget überschritten, `RequestTooLargeError` (bestehendes Verhalten).
- Frühere automatisierte Live-Läufe über `vscode-test` endeten mehrfach mit Exit 1 ohne Ergebnisdatei. Ursache ungeklärt; ein erneuter begrenzter Lauf (ein Aufruf, 240 s Timeout) lief fehlerfrei. Live-Läufe sind daher nicht als zuverlässig reproduzierbar belegt.

## C. Nachbearbeitung ungeprüfter Planaussagen (automatisiert)

### Testabdeckung der Lesewerkzeuge (deterministisch, Temp-Workspaces)
Stand der Prüfung des Bestands; keine vollständige Kombinationsabdeckung behauptet. Alle Fälle nutzen eigene Temp-Workspaces (außer den in Abschnitt A genannten Altlasten).
- `search_text` (Suite „search_text Ergebnisbudget“ u. a.): Treffer, 0 Treffer (erfolgreich, keine gelesene Datei), exaktes `include`, `query`/`include`-Trennung, gesperrte Konfigurationspfade, Treffer-/Bytebegrenzung; seit `parameterHint`: Fehlaufruf mit Hinweis und absichtliche Dateinamensuche im Inhalt ohne Hinweis.
- `read_file`: kleine Datei und gesperrte/externe Pfade (neue Suite „Lesewerkzeuge: read_file und list_directory“); Budgetablehnung und Folgeverhalten („Kumulatives Werkzeugbudget“, „Nach budget-abgewiesenem read_file …“); Vorablesung mit Sperre/Lesefehler/Limit.
- `read_file_range` (Suite `read_file_range`, „Bereichsnavigation“): gültiger Bereich, Dateiende, ungültige Zeilen, 120-Zeilen-Grenze, UTF-8-Bytebudget (4.000 Bytes), gesperrte Pfade/Symlink/Binär/fehlend, identische Wiederholung gesperrt, Überlappung und Nachbarbereich lesbar.
- `list_directory`: erlaubter Pfad, gesperrte Einträge ausgeblendet, gesperrter und externer Pfad abgelehnt (neue Suite).
- Neu ergänzt in diesem Schritt: 3 Tests (read_file klein, read_file gesperrt, list_directory erlaubt/gesperrt). Die übrigen Fälle waren bereits abgedeckt und wurden nicht dupliziert.

### Testabdeckung P5b (deterministisch, simulierte Antworten, Temp-Workspaces)
Vorhanden (Suite „Kumulatives Werkzeugbudget“): Abschlussantwort ohne Werkzeuge und Kennzeichnung; Abschlussanfrage ohne Werkzeugaufruf bzw. leer führt zu ehrlichem Fehler; `prepareFinalAnswerRequest` sendet bei Überschreitung nicht und kürzt nicht; kein Abschluss bei Abbruch nach dem letzten Schritt; Planmodus verlangt Planabschnitte als Teilplan.
Neu: „P5b: Teilplan am Schrittlimit ohne Lesebeleg erfindet keine Belege“ (8 fehlgeschlagene Lesungen, alle Evidenzen `success:false`, Plan nennt unbelegte Datei, Ausgabe als TEILPLAN mit Warnung „Unbelegte Dateibehauptung“).
Befund zur Grenze: Die werkzeuglose Abschlussanfrage ist kleiner als eine Anfrage mit Werkzeugschema, und jedes Werkzeugergebnis wird gegen die Anfrage mit Schema geprüft. Eine Abschlussanfrage über 32.000 Bytes ist daher durch die Agentenschleife praktisch nicht erreichbar; der Fall ist nur auf Einheitenebene (`prepareFinalAnswerRequest`) getestet, nicht Ende-zu-Ende. Kein Produktivcode geändert.
### Navigation bei ausdrücklich benannter großer Datei (Entwurf; Ansatz A inzwischen implementiert)
Status: Ansatz A ist als `buildPlanTargetHint` (`src/agent/planChange.ts`, Aufruf in `runChatPlan`) umgesetzt und deterministisch getestet; live in einem P4-Lauf bestanden, Wiederholbarkeit offen. Der folgende Entwurfstext ist der historische Stand vor der Umsetzung.

Befund im Code: Der Vorab-Hinweis „Datei zu groß, nutze search_text mit include und read_file_range“ (`readOnlyAgent.ts`, `initialFiles`) wird nur für Dateien erzeugt, die `extractRequestedFiles` liefert, also nur bei einem Lese-/Prüfwort in der Frage. Der P4-Satz („Plane eine Änderung … in src/chat/chatView.ts.“) enthält keines; `chatView.ts` erreicht das Modell daher nur als Pfad im Text, ohne Hinweis auf Rollen oder nächste Werkzeuge.

| Kriterium | A: Pfad + zulässige nächste Werkzeuge nennen | B: begrenzten ersten Bereich bereitstellen |
|---|---|---|
| Pfadschutz | unverändert (kein Dateizugriff) | liest die Datei vorab; Pfadprüfungen nötig, aber vorhanden |
| Bytebudget | wenige hundert Bytes, im Request | bis zu 4.000 Bytes Bereich zusätzlich; verbraucht Budget vor der Recherche |
| Modellschritte | keine zusätzlichen | keine zusätzlichen, aber Vorablesung zählt als Werkzeugergebnis |
| Belegstatus | Datei bleibt ungelesen; Planblockade bleibt | Bereich gälte als gelesen und würde die Planblockade aufheben, obwohl er beliebig gewählt ist |
| Risiko falscher Kontextauswahl | gering (keine Auswahl) | hoch: Dateianfang (Imports) ist für „Abbruchbehandlung“ meist irrelevant; ein erfundenes Ziel würde Teilplan „belegen“ |

Empfehlung: **A**, begrenzt auf eine in der Frage eindeutig benannte Datei bei konkretem Änderungswunsch (dieselbe Erkennung wie `extractChangeTargetFile`). Der Hinweis nennt Pfad, die Rollen (`query` = Codebegriff, `include` = dieser Pfad) und `read_file_range` als nächsten Schritt; er führt nichts aus und ändert weder Budgets noch Schleife. B ist innerhalb der bestehenden Grenzen nicht sicher, weil es die Belegsemantik aufweicht. Grenze: A ist ein Hinweis, keine Garantie; ob Devstral ihn befolgt, ist erst durch einen späteren Live-Lauf belegbar und hier nicht geprüft. Auch bei A kann das Modell weiter ohne Lesen antworten; dann greift die Planblockade.

### Folgeschritt nach Budgetablehnung (Untersuchung, nicht implementiert)
Beobachtung (P5, zweiter Live-Lauf): Beide Hinweise erreichten Devstral, danach folgte keine Recovery, sondern eine Antwort ohne Lesebeleg. Vorhandene Werkzeugführung: `TOOL_RESULT_BUDGET_NOTICE` und `SKIPPED_AFTER_BUDGET_NOTICE` nennen `read_file_range` bzw. eng begrenzte `search_text`-Suche in derselben Datei; die Recovery-Regel in `readOnlyAgent.ts` lässt genau diese Folgeaufrufe zu. Ob andere Hinweise die Antwort geändert hätten, ist nicht belegt.

Getrennt zu bewerten:
- Deterministisch prüfbare Werkzeugführung: Hinweis erreicht das Modell, zulässiger Folgeaufruf wird ausgeführt, unzulässiger abgewiesen. Bereits getestet; eine Lücke ist nicht nachgewiesen.
- Modellentscheidung: Devstral antwortet trotz Hinweis ohne weiteres Werkzeug. Das lässt sich ohne Schleife oder automatische Recherche nicht erzwingen.
- Requestbytes/Sicherheit: Jeder zusätzliche Text zählt gegen die 32.000 Bytes und wird nicht gekürzt; Pfadschutz bleibt unberührt, solange nur Text und kein Dateizugriff ergänzt wird.

| Option | Wirkung | Requestbytes | Sicherheit | Bewertung |
|---|---|---|---|---|
| 0: keine weitere Änderung | Hinweise und Recovery bleiben; Planblockade verhindert unbelegte Pläne | 0 | unverändert | Sicher; Antwort ohne Lesebeleg bleibt möglich, wird aber ehrlich als nicht belegt ausgegeben |
| 1: Hinweis nennt den konkreten zulässigen Folgeaufruf (Werkzeug, Pfad der abgewiesenen Datei, Rollen `query`/`include`), ohne erfundenen Codebegriff | Hinweis wird konkreter; keine Ausführung | einige hundert Bytes je Hinweis, nur wenn er ins Budget passt, sonst ehrlicher Abbruch | kein neuer Zugriff, kein Lesebeleg | klein und prüfbar; Wirkung auf Devstral ungewiss |

Empfehlung (genau ein Schritt): **Option 0 beibehalten und die Hinweisgröße deterministisch festhalten.** Ein Test prüft für den Ablauf „Budgetablehnung, Folgeantwort“ das tatsächlich übermittelte Request: Hinweisbytes je Ablehnung (`TOOL_RESULT_BUDGET_NOTICE`, `SKIPPED_AFTER_BUDGET_NOTICE`) und Gesamtrequest. Erfolgskriterium: Test grün mit Hinweisbytes je Ablehnung ≤ 600 und Gesamtrequest ≤ 32.000 Bytes (Schwelle ist eine Annahme; vor dem Test gegen die tatsächlichen Hinweislängen zu prüfen). Danach höchstens ein Live-Lauf P5a zur Wiederholbarkeit, Wertung weiter getrennt in „Fehlerabbruch behoben“ und „Recovery genutzt“. Option 1 erst erwägen, wenn dieser Lauf erneut keine Recovery zeigt und eine Lücke im übermittelten Hinweis nachgewiesen ist. Keine automatische Recherche, kein Writer, keine neue Modellarchitektur.

### Markierungen ungeprüfter Planaussagen

`formatPlanResponse` (`src/agent/planChange.ts`, `markUnverifiedSteps`) hängt an Umsetzungsschritte Markierungen an; es wird nichts entfernt oder ergänzt. Grundlage sind Metadaten im Werkzeugprotokoll (`ToolEvidence`, nie Inhalte): bei `search_text` Suchbegriff und ausgegebene Treffer (Pfad, Zeile), bei `read_file_range` der tatsächlich gelieferte Bereich.

- `[UNGEPRÜFT: <Pfad> nicht gelesen, nur Annahme]`: Schritt nennt eine Datei ohne erfolgreiches `read_file`/`read_file_range` (ein Suchtreffer genügt nicht).
- `[UNBELEGT: name() …]`: Symbol `name()` im Schritt ist nicht als neu formuliert (einführen, hinzufügen, anlegen …) und keine erfolgreiche Suche danach hatte mindestens einen ausgegebenen Treffer in einer im Schritt genannten Datei (ohne Dateinennung: in irgendeiner Datei). Nennt der Schritt eine gelesene Datei, muss der Treffer dort (oder in einer genannten ungelesenen Datei) liegen; nennt er nur ungelesene Dateien, belegt ein ausgegebener Treffer in irgendeiner Datei die Existenz des Symbols (die ungelesene Datei bleibt separat UNGEPRÜFT, der Symboltreffer bestätigt nie die Umsetzungsaussage). 0 Treffer, ein Treffer für ein anderes Symbol, ein nicht ausgegebener Treffer oder ein Treffer in einer anderen als der genannten gelesenen Datei belegt nichts; Belege ohne Trefferdaten gelten nicht als Beleg.
- `[UNGEPRÜFT: Stelle in <Pfad> nicht aus den gelesenen Zeilen a-b, … zuordenbar]`: Datei wurde nur per `read_file_range` gelesen und weder ein Treffer des Symbols noch eine ausdrücklich genannte Zeile („Zeile 70“, „Zeilen 60-80“, „datei.ts:70“) liegt in einem gelieferten Bereich. Vollständig gelesene Dateien lösen das nicht aus.

Verbleibende Grenzen: Bei einem Schritt mit ungelesener Datei und ohne genannte gelesene Datei lässt sich das Symbol keiner Datei zuordnen; es wird nur seine Existenz belegt, keine Position. Es gibt keine semantische Codeprüfung. Ein Treffer im gelieferten Bereich zeigt nur, dass der Suchbegriff dort steht, nicht dass die Aussage des Schritts stimmt. Schritte ohne Symbol und ohne Zeilenangabe in einer nur ausschnittsweise gelesenen Datei werden immer als nicht zuordenbar markiert (konservativ, auch bei „neu einführen“). Symbole ohne `()` und Aussagen ohne Dateinennung werden nicht geprüft. Die Treffer-Liste ist auf die ausgegebenen Treffer der Suche begrenzt; nicht ausgegebene Treffer zählen nicht als Beleg.

Die Tests (`extension.test.ts`, `chat.test.ts`) nutzen simulierte Modellantworten und beweisen **nicht**, dass Devstral weniger ungeprüfte Aussagen erzeugt; sie belegen nur Kennzeichnung und Datenfluss. Die Wirkung ist per P3 manuell zu prüfen.