# E2E-Erweiterung: Kurs, Lektion und Quiz im Browser bearbeiten

Stand: 18.10.2026. Basis: `main` nach Merge von PR #97 (`68daf5a`). Diese Erweiterung ergänzt einen Browserfall `training-authoring` im bestehenden Playwright-/Docker-Stack. Status: lokal umgesetzt und abgenommen. Aktuelle GitHub-Nachweise werden in den Prüfungen und der Beschreibung des zugehörigen PR festgehalten.

## Umfang

Ein Editor meldet sich über das sichtbare Formular an und legt über Manage einen freiwilligen `quizGate`-Kurs an. Der gespeicherte Entwurf muss nach vollständigem Neuladen Titel, Beschreibung und Feedbackmodus behalten. Danach veröffentlicht der Editor den Kurs und erstellt eine Lektion mit Inhalt und einer Quizfrage mit zwei Antworten.

Nach dem ersten Speichern und Neuladen ändert er ausschließlich Fragetext und richtige Antwort. Das muss den Speichern-Button aktivieren. Ein weiterer vollständiger Reload nach dem Speichern muss beide Änderungen erhalten. Nach Veröffentlichung öffnet ein Mitglied in einer getrennten Browsersitzung die neuen Inhalte über Training. Die alte richtige Antwort wird abgelehnt, die neue akzeptiert; dadurch ist auch der gespeicherte Lösungsschlüssel serverseitig geprüft.

Das zusätzliche Editor-Konto hat ein eigenes Zufallspasswort, dieselbe Abteilung und keine Teammitgliedschaften. Bootstrap prüft Rolle und Beziehungen. Der Runner behält die zwei vorhandenen Login-Preflights für Lead und Member; zusammen mit acht echten UI-Logins bleiben die sechs Fälle innerhalb des unveränderten nativen Limits von zehn Logins pro Minute. Der Editor-Login wird im neuen Browserfall geprüft.

Kurs und Lektion dieses Falls entstehen vollständig über die Oberfläche. Die bestehenden drei Seed-Kurse und Teamfälle bleiben unabhängig. Keine API-Schreibabkürzung, keine Mocks, keine neue Abhängigkeit und keine Änderung an Produkt, CI-Auslösern oder Zeitlimits. Scheduling, Uploads, Konflikte und die breite Rollenmatrix sind nicht Teil dieses Falls; die vollständige Batch-17-Staging-Abnahme bleibt separat.

## Umsetzung und Abnahme

- [x] Separates Editor-Fixture samt Passwortredaktion, Rollen-/Beziehungsassertions und angepassten Runner-Checks ergänzen.
- [x] Sichtbare Kurserstellung, Entwurf, Veröffentlichung, Lektion und reine Quizänderung mit Reload-Nachweisen implementieren.
- [x] Veröffentlichte Inhalte und geänderte richtige Antwort als Member in getrennter Sitzung prüfen.
- [x] Authoring allein und alle sechs Browserfälle gemeinsam auf frischen Daten bestehen lassen; ein Worker, keine Wiederholungen.
- [x] Vorübergehend `quiz` aus dem geordneten Dirty-Vergleich entfernen. Der Fall muss am deaktivierten Save-Button scheitern. Quelle bytegenau wiederherstellen, Bericht/Trace/Screenshot und Cleanup prüfen.
- [x] Typecheck, Lint, Runner-Tests, Format und unabhängigen Review abschließen; Anleitung und Nachweise ergänzen. Nach Push läuft derselbe Fall automatisch im vorhandenen Browser-CI-Job.

## Nachweise

- PR #97 wurde als `68daf5ab2963c51b11a088f9f7ab623e9b0669c5` nach `main` gemergt. Der [Confirm-PR-Lauf](https://github.com/yurtbayemre/sinnlos/actions/runs/39133020122) hatte acht grüne Jobs und fünf bestandene Browserfälle in 27,3 Sekunden ohne Wiederholungen. Das heruntergeladene Artefakt wurde geprüft.

- Authoring bestand allein auf frischen Daten: Run `sinnlos-e2e-99a035b43041dc54dcdb1988`, 1 Test in 11,2 Sekunden (Gesamtlauf 12,3 Sekunden).
- Die lokale Störungsprobe im Run `sinnlos-e2e-0bd8a356904e8e2c1f9b6c7c` entfernte ausschließlich `quiz` aus `ORDERED_LISTS`. Der Test scheiterte beim erwarteten aktivierten Save-Button nach der reinen Quizänderung (Exit 1). Die Produktquelle wurde im `finally` bytegenau wiederhergestellt; ihr Git-Diff ist leer. Bericht, Screenshot und Trace wurden vor dem Folgelauf archiviert und unabhängig geprüft: genau ein Fehler, `retry: 0`, 977 gültige Trace-Ereignisse und ein Screenshot. Alle 16 Credential-Felder in 20 Logs sind redigiert; das Archiv enthält keine privaten Env-/Fixture-Dateien. Der Screenshot zeigt die geänderte HTTPS-Frage und Antwort 443 bei deaktiviertem Save-Button.
- Nach Wiederherstellung bestanden alle sechs Browserfälle gemeinsam: Run `sinnlos-e2e-e6d5127b0b1fc6b287cf9c8b`, 32,5 Sekunden, Authoringfall 10,7 Sekunden. Ein Worker, keine Wiederholungen, frische Datenbank und Browsersitzungen; native Login-Limits unverändert.
- E2E-Typecheck, Lint, alle fünf Runner-Tests, Format und Diff-Check sind grün. Der unabhängige Review fand keine bestätigten Probleme. Die gefilterten Restprüfungen aller drei Läufe fanden keine Container, Netzwerke, laufbezogenen Images oder privaten Laufdateien mehr.
- Anwendungscode, Abhängigkeiten, CI-Workflow, Auslöser und Zeitlimits bleiben unverändert. Staging und Produktion wurden nicht verändert. Die vollständige Batch-17-Abnahme wird dadurch nicht ersetzt.
