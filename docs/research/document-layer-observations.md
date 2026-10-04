# Forschungsnotiz: VS-Code-Dokumentschicht als Grundlage für einen Writer

**Keine Freigabe für einen echten Writer.** Diese Notiz dokumentiert Diagnosebeobachtungen.
Sie ist kein Sicherheitsnachweis. Bubble hat weiterhin keinen Writer und keinen Anwenden-Befehl.

Experimente: [documentLayerProbe.diagnostic.ts](../../src/test/diagnostics/documentLayerProbe.diagnostic.ts),
ausführbar nur mit `npm run test:diagnostic` (nicht Teil von `npm test` oder CI).
Die Tests nutzen ausschließlich temporäre Dateien unter dem System-Temp-Ordner und sind nicht mit
Bubbles Vorschau, Freigabe oder Befehlen verbunden.

## Messungen

Je ein Lauf, Windows, VS Code 1.140.0, Extension-Host-Testlauf.

1. **Externe Änderung zwischen `applyEdit` und `save()`:** `applyEdit` → `true`; Dokument Version 2, dirty;
   Puffer übernahm die externe Änderung nicht; `save()` → `false`; Datenträger behielt die externen Bytes;
   Log: „File Modified Since“.
2. **Externe Änderung vor `applyEdit`, sauberes Dokument (Größe und mtime geändert):** Puffer blieb nach 1,5 s
   unverändert (Version 1, nicht dirty); `applyEdit` → `true`; `save()` → `false`; Datenträger behielt die
   externen Bytes; Log: „File Modified Since“.
3. **Externe Änderung mit gleicher Größe und exakt wiederhergestelltem mtime (Ganzsekunden-Wert):**
   Zeitstempel und Größe nachweislich identisch (ns-genau gemessen); Puffer blieb unverändert;
   `applyEdit` → `true`; `save()` → `true`; kein Dialog, keine Konfliktmeldung; Datenträger enthielt danach
   den Vorschlag, die externen Bytes waren überschrieben.

## Schlussfolgerungen (vorsichtig)

- `applyEdit() === true` sagt nur, dass der Puffer geändert wurde, nicht dass er zum Datenträgerstand passt.
- Ein sauberes Dokument wurde in der Beobachtungszeit nicht vom Datenträger nachgeladen.
- Der Konfliktschutz beim Speichern erkannte Änderungen mit anderer Größe/mtime, aber nicht eine Änderung mit
  gleicher Größe und gleichem mtime. Das ist eine Ableitung aus Messungen; der VS-Code-Quelltext wurde nicht geprüft.
- Die Dokumentschicht allein ist daher kein ausreichender Schutz vor Überschreiben veränderter Dateien.
- Selbst ein Bytevergleich unmittelbar vor `save()` wäre nicht atomar mit dem Speichern.
- Ergebnisse gelten nur für die getesteten Läufe und folgen nicht auf andere Systeme oder VS-Code-Versionen.

## Offene Fragen

- Wiederholbarkeit und Abhängigkeit von Zeitstempel-Auflösung, Dateisystem, Wartezeit und VS-Code-Version.
- Erhalt von BOM, Kodierung und Zeilenenden beim Speichern über die Dokumentschicht.
- Verhalten bei Dateiwächtern, Sync-Werkzeugen und mehreren Fenstern.
- Ob `workspace.fs` oder ein anderer Ansatz einen belastbaren Bedingt-Schreiben-Schutz bieten kann.
