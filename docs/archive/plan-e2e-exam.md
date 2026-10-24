# E2E-Erweiterung: Exam-Abschluss und Nachbetrachtung

Stand: 18.10.2026. Basis: `main` nach Merge von PR #95 (`42290d6`). Teams und `quizGate` sind umgesetzt und auf GitHub abgenommen. Diese Erweiterung ergänzt genau einen Browserfall `training-exam-completion` im bestehenden Playwright-/Docker-Stack. Status: lokal und in GitHub abgenommen; [PR #96](https://github.com/yurtbayemre/sinnlos/pull/96) ist als `e409f74` nach `main` gemergt. Die [Confirm-Erweiterung](./plan-e2e-confirm.md) führt den Browserumfang fort.

## Umfang

Ein Mitglied öffnet über Training einen eigenen veröffentlichten, freiwilligen Exam-Kurs mit einer Lektion und zwei Fragen. Fehlende oder falsche Antworten sperren den Abschluss. Falsche und richtige Antwortkombinationen liefern ausschließlich das Gesamtergebnis, keine Einzelbewertungen. Eine erfolgreiche Prüfung allein erzeugt keinen Beleg; erst der ausdrückliche Abschluss bleibt nach vollständigem Neuladen erhalten.

Auch die Nachbetrachtung einer abgeschlossenen Prüfung bleibt im Exam-Modus. Erneut falsche Antworten zeigen nur das Gesamtergebnis und entfernen den bestehenden Beleg nicht. Richtige Antworten in der Nachbetrachtung verraten ebenfalls keine Einzelbewertungen.

Der bestehende `quizGate`-Kurs bleibt unabhängig. Dieselben zwei Fixture-Nutzer und Quizfragen werden wiederverwendet; kein Lösungsschlüssel wird in die privaten Browser-Fixtures exportiert. Keine neue Abhängigkeit, kein neuer Runner und keine Änderung der Produktlogik. `confirm`, Kursauthoring und die vollständige Staging-Browserabnahme bleiben außerhalb dieses Schritts. Die API-Payload-/Rollenmatrix bleibt in den vorhandenen Unit-/HTTP-Tests.

## Umsetzung und Abnahme

- [x] Eigenen veröffentlichten Exam-Kurs samt Lektion ergänzen. Bestehende Erzeugung und vollständige Fixture-Assertions für beide Modi nutzen; verschiedene Dokument-IDs und fehlende Belege prüfen.
- [x] Login und Kursnavigation wiederverwenden. Ein Browserfall prüft Sperren, ausschließliches Gesamtergebnis, expliziten Abschluss und Nachbetrachtung nach vollständigem Neuladen.
- [x] Den Examfall allein und alle vier Browserfälle gemeinsam auf frischen Daten bestehen lassen, mit einem Worker und ohne Wiederholung. Native Login-Limits bleiben aktiv.
- [x] Eine vorübergehende Einzelbewertung nur in der abgeschlossenen Exam-Nachbetrachtung muss den neuen Test scheitern lassen. Quelle anschließend bytegenau wiederherstellen; Fehlerbericht, Screenshot, Trace und Cleanup prüfen.
- [x] Typecheck, Lint, Format und unabhängigen Review abschließen; Anleitung und Laufnachweise ergänzen. Der saubere Stand läuft nach dem Push automatisch im bestehenden Browser-CI-Job.

## Nachweise

- PR #95 wurde als `42290d6b7e5b68739f6d21498d41d6ba098c8106` nach `main` gemergt. Die Quiz-Erweiterung hatte vor dem Merge acht grüne CI-Jobs auf ihrem finalen Commit `66937a5`.
- Der [Main-Lauf nach dem Merge](https://github.com/yurtbayemre/sinnlos/actions/runs/39130290480) ist für `42290d6b7e5b68739f6d21498d41d6ba098c8106` vollständig grün.
- Der Examfall bestand allein auf frischen Daten: Run `sinnlos-e2e-9848654a80a023a79ce57560`, 1 Test, 5,6 Sekunden. Anschließend ergänzte der unabhängige Review einen weiteren vollständigen Reload am Ende der Nachbetrachtung, damit der Erhalt des Belegs auch dort aus der Datenbank neu gelesen wird.
- Die lokale Störungsprobe im Run `sinnlos-e2e-75fc53432a27a3d3ae0b91ab` blendete ausschließlich in der abgeschlossenen Exam-Nachbetrachtung eine Einzelbewertung ein. Genau dort scheiterte der Test an zwei Statusmeldungen statt ausschließlich des Gesamtergebnisses (Exit 1). Die Produktquelle wurde im `finally` bytegenau wiederhergestellt und ihr Git-Diff ist leer. HTML-Bericht, Screenshot und Trace wurden vor dem folgenden Lauf archiviert und geprüft: genau ein Fehler, `retry: 0`, 1.021 gültige Trace-Ereignisse. Der Screenshot zeigt die unerlaubte Einzelbewertung neben dem Gesamtergebnis und dem gespeicherten Abschluss.
- Der vollständige Lauf nach Wiederherstellung und Review-Fix bestand mit allen vier Fällen: `sinnlos-e2e-0426a118dcc7daf3a066f86a`, 18,2 Sekunden, Examfall 4,2 Sekunden. Ein Worker, keine Wiederholung, neue Datenbank und Browsersitzungen; native Login-Limits unverändert.
- E2E-Typecheck, Lint, fünf Runner-Tests, Formatprüfung und Diff-Check sind grün. Das Review-Finding ist geschlossen; keine weiteren bestätigten Probleme. Alle drei lokalen Läufe haben ihre eigenen Ressourcen und privaten Laufverzeichnisse entfernt. Die 15 Credential-Felder der Negativprobe sind redigiert; keine privaten Env-/Fixture-Dateien im archivierten Bericht.
- Anwendungscode, Abhängigkeiten, CI-Workflow, Auslöser und Zeitlimits bleiben unverändert. Staging und Produktion wurden nicht verändert. Eigene Browserfälle für `confirm` und Authoring sowie die vollständige Staging-Browserabnahme bleiben weitere Schritte.

- [GitHub-Abnahme](https://github.com/yurtbayemre/sinnlos/actions/runs/39130906853) auf `97ce840`: acht CI-Jobs grün, vier Browserfälle in 19,5 Sekunden, keine Wiederholungen, Fehler oder Flakes. Bericht, Artefaktgrenzen, Redigierung und Cleanup sind geprüft; Nachweise in PR #96.
