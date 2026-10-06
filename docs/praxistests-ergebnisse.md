# Praxistest-Ergebnisse (versioniert)

Szenarien: siehe [praxistests.md](./praxistests.md). Neue Läufe als neuen Abschnitt oben anfügen; frühere Abschnitte nicht überschreiben. Automatisierte Tests und echte Devstral-Läufe stehen getrennt.

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
