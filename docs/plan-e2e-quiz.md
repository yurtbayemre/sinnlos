# E2E-Erweiterung: Quiz-Abschluss im Browser

Stand: 18.10.2026. Basis: `main` nach Merge von PR #93 (`f7f74c9`). Der Teams-Pilot ist abgeschlossen. Diese Erweiterung nutzt denselben Playwright-/Docker-Stack und ergänzt genau einen Browserfall `training-quiz-completion`.

## Umfang

Ein normales Mitglied öffnet einen veröffentlichten Kurs im Modus `quizGate` über die Training-Navigation. Eine veröffentlichte Lektion enthält zwei Fragen mit unterschiedlichen richtigen Antwortindizes. Der Kurs ist freiwillig, damit die vorhandenen Teamtests keinen zusätzlichen Pflichtkurs-Banner erhalten.

Der Test beweist sichtbaren Login und Navigation, gesperrten Abschluss bei fehlenden oder falschen Antworten, serverseitiges Feedback und einen gespeicherten Abschluss nach vollständigem Neuladen. Eine erfolgreiche Quiz-Prüfung allein darf noch keinen Abschluss speichern. Am Ende zeigt auch die Kursübersicht den Kurs als abgeschlossen.

Vorhandene Unit-/HTTP-Tests behalten die breite Modus-, Rollen- und API-Matrix. `confirm`, `exam`, Kursauthoring, Quizänderungen während eines Versuchs, Videos und Uploads sind weitere mögliche Browserfälle. Keine neue Abhängigkeit, keine zweite Testumgebung und keine Änderung der Produktlogik.

## 1 Fixtures und vorhandene Helfer erweitern

- [x] Im vorhandenen CMS-Starter einen veröffentlichten `quizGate`-Kurs und eine veröffentlichte Lektion über den Document Service anlegen. Keine Abschlussbelege vorbereiten.
- [x] Veröffentlichung, Kurszuordnung, Modus und gespeicherte Quizdaten vor Öffnen des HTTP-Servers prüfen. Die privaten Laufdaten erhalten nur Kurs-/Lektionsnamen und IDs; der Lösungsschlüssel bleibt in den CMS-Fixtures.
- [x] Fixture-Lesen und sichtbaren Formularlogin aus dem Teams-Test in einen kleinen gemeinsamen Helfer verschieben. Teamnavigation bleibt im Teams-Test.

Abnahme: Frischer Stack startet mit bestätigten Fixtures; Typecheck/Lint und beide bestehenden Teamfälle bleiben grün.

## 2 Einen vollständigen Quiz-Ablauf ergänzen

- [ ] Als bestehendes Mitglied über das Formular anmelden, Training und den Testkurs öffnen. Zunächst `0 of 1 done` prüfen und die Lektion über `Start course` öffnen.
- [ ] Ohne vollständige Antworten bleiben Prüfung und Abschluss gesperrt. Mit einer falschen und einer richtigen Antwort muss die Prüfung den Fehler anzeigen; der Abschluss bleibt gesperrt.
- [ ] Nach Neuladen ist die Lektion weiterhin offen. Beide richtigen Antworten auswählen und prüfen; die Erfolgsmeldung schaltet den Abschluss frei.
- [ ] Erneut laden: Eine erfolgreiche Prüfaktion allein hat noch keinen Abschluss erzeugt. Quiz erneut korrekt beantworten und ausdrücklich `Complete lesson` klicken.
- [ ] Nach vollständigem Neuladen einen datierten Abschluss und keinen Abschlussbutton sehen. Kursdetail und Kurskarte in der Übersicht zeigen `Completed`; keine Fehlermeldung darf den Erfolg begleiten.

Abnahme: Der Fall besteht allein auf frischen Daten. Eine vorübergehende Störung, die den Abschluss nur als erfolgreich meldet, ohne den Beleg zu schreiben, muss die Persistenzprüfung scheitern lassen; anschließend wird sie vollständig zurückgenommen.

## 3 Gemeinsame Ausführung und Anleitung abschließen

- [ ] Den bestehenden CI-Job und Artefaktnamen auf Browser-E2E verallgemeinern; alle drei Fälle laufen mit einem Worker und ohne Wiederholung im bestehenden Budget. Scope und Datenbankauslöser bleiben fachlich unverändert.
- [ ] Anleitung und README um Quiz-Ablauf und Einzelaufruf ergänzen; den alten Teams-Plan als abgeschlossene Historie behalten.
- [ ] Alle drei Fälle zweimal auf jeweils frischen Daten ausführen, Typecheck/Lint/Format und die betroffenen CI-Prüfungen ausführen. Cleanup sowie Fehlerbericht/Screenshot/Trace der Störungsprobe prüfen.
- [ ] Unabhängigen Review und lokale Commit-/Laufnachweise dokumentieren. Neue Implementierung zunächst lokal abschließen; ein späterer Push liefert den GitHub-Nachweis für die Quiz-Erweiterung.

## Nachweise

- PR #93 ist nach `main` gemergt; [Main-CI](https://github.com/yurtbayemre/sinnlos/actions/runs/39119203517) für `f7f74c94e4e7e4b8c618bd7cdf0d37c59dc395b8` wird während dieser Arbeit geprüft.
- Schritt 1 lokal abgenommen: E2E-Typecheck und Lint grün; beide bestehenden Teamfälle bestanden mit den neuen veröffentlichten Kurs-Fixtures auf frischen Daten (2 Tests, 9,6 Sekunden, Run `sinnlos-e2e-843c19295d8681abf829770c`). Cleanup erfolgreich. Schritte 2–3 werden anschließend geprüft.
