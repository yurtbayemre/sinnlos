# E2E-Erweiterung: Confirm-Abschluss mit sofortigem Feedback

Stand: 18.10.2026. Basis: `main` nach Merge von PR #96 (`e409f74`). Diese Erweiterung ergänzt genau einen Browserfall `training-confirm-completion` im bestehenden Playwright-/Docker-Stack. Status: lokal und auf GitHub abgenommen; PR #97 wurde am 18.10.2026 um 14:00:37 UTC als `68daf5ab2963c51b11a088f9f7ab623e9b0669c5` nach `main` gemergt.

## Umfang

Ein Mitglied öffnet über Training einen eigenen veröffentlichten, freiwilligen `confirm`-Kurs mit einer Lektion und zwei Fragen. Jeder Klick erhält automatisch serverseitiges Einzelfeedback, ohne Prüfbutton. Fehlende oder falsche Antworten sperren den Abschluss; erst alle richtigen Antworten geben ihn frei. Eine erneute falsche Auswahl nach einem Pass sperrt ihn wieder.

Eine bestandene Prüfung allein erzeugt keinen Beleg. Nach Neuladen bleibt die Lektion offen; erst der ausdrückliche Abschluss wird gespeichert und durch einen weiteren vollständigen Reload nachgewiesen. Die bestehenden Team-, `quizGate`- und Examfälle behalten ihre unabhängigen veränderlichen Ziele. Dieselben zwei Fixture-Nutzer und Quizfragen werden wiederverwendet; Lösungsschlüssel bleiben außerhalb der privaten Browser-Fixtures.

Keine neue Abhängigkeit, kein neuer Runner und keine Produktänderung. Transportrennen und die breite API-/Rollenmatrix bleiben in den vorhandenen Unit-/HTTP-Tests. Die [Authoring-Erweiterung](./plan-e2e-authoring.md) ist der nächste Browserfall. Die vollständige Staging-Browserabnahme bleibt ein weiterer Schritt.

## Umsetzung und Abnahme

- [x] Eigenen veröffentlichten Confirm-Kurs samt Lektion in den vorhandenen Fixture-Loop aufnehmen; Modi, Publikation, Beziehungen, unterschiedliche Dokument-IDs und fehlende Belege prüfen.
- [x] Vorhandenen Login und Kursnavigation nutzen. Automatisches Einzelfeedback, fehlenden Prüfbutton, Sperren und erneutes Sperren nach einer falschen Änderung sowie ausdrücklich gespeicherten Abschluss prüfen.
- [x] Confirmfall allein und alle fünf Browserfälle gemeinsam auf frischen Daten bestehen lassen; ein Worker, keine Wiederholungen und unveränderte native Login-Limits.
- [x] Vorübergehend den automatischen Confirm-Prüfaufruf nach einer Auswahl deaktivieren. Der Test muss am fehlenden ersten Einzelurteil scheitern. Quelle bytegenau wiederherstellen; Fehlerartefakte und Cleanup prüfen.
- [x] Typecheck, Lint, Format und unabhängigen Review abschließen; Anleitung und Laufnachweise ergänzen. Der saubere Stand läuft nach dem Push automatisch im bestehenden Browser-CI-Job.

## Nachweise

- PR #96 wurde als `e409f74d513462a8b81320046366d0cc39d222f1` nach `main` gemergt. Die Exam-Erweiterung hatte acht grüne CI-Jobs und vier bestandene Browserfälle auf `97ce840`.
- Confirm bestand allein auf frischen Daten: Run `sinnlos-e2e-0cf9dc6ba24bc2465f56f215`, 1 Test in 5,4 Sekunden.
- Die lokale Störungsprobe im Run `sinnlos-e2e-74b2893bc4d85c3480517c3e` deaktivierte nur den automatischen Confirm-Prüfaufruf. Der Test scheiterte genau beim ersten erwarteten Einzelurteil nach Auswahl von HTTPS-Port 80 (Exit 1). Die Produktquelle wurde im `finally` bytegenau wiederhergestellt; ihr Git-Diff ist leer. Bericht, Screenshot und Trace wurden vor dem Folgelauf archiviert und geprüft: genau ein Fehler, `retry: 0`, 465 gültige Trace-Ereignisse. Der Screenshot zeigt die Auswahl ohne Feedback und den gesperrten Abschluss.
- Nach Wiederherstellung bestanden alle fünf Browserfälle gemeinsam: Run `sinnlos-e2e-3a3720c06dc834560a7d1805`, 22,9 Sekunden, Confirmfall 4,0 Sekunden. Ein Worker, keine Wiederholungen, frische Datenbank und Browsersitzungen; native Login-Limits unverändert.
- E2E-Typecheck, Lint, fünf Runner-Tests, Format und Diff-Check sind grün. Der unabhängige Review fand keine bestätigten Probleme. Alle drei Läufe entfernten ihre eigenen Ressourcen und privaten Laufdateien. Die Negativprobe enthält 20 Diagnose-Logs mit 15 redigierten Credential-Feldern und keine privaten Env-/Fixture-Dateien im archivierten Bericht.
- [CI-Lauf 39133020122](https://github.com/yurtbayemre/sinnlos/actions/runs/39133020122) auf `caa3c568` bestand alle acht Jobs. Alle fünf Browserfälle bestanden in 27,3 Sekunden ohne Wiederholungen; [Artifact 12138832119](https://github.com/yurtbayemre/sinnlos/actions/runs/39133020122/artifacts/12138832119) wurde geprüft. [PR #97](https://github.com/yurtbayemre/sinnlos/pull/97) ist als `68daf5ab2963c51b11a088f9f7ab623e9b0669c5` gemergt.
- Anwendungscode, Abhängigkeiten, CI-Workflow, Auslöser und Zeitlimits bleiben unverändert. Staging und Produktion wurden nicht verändert. Alle drei Quizmodi haben jetzt einen eigenen Browserfall; die breite API-/Rollenmatrix und die vollständige Batch-17-Abnahme werden dadurch nicht ersetzt.
