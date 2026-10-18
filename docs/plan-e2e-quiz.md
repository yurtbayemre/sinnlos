# E2E-Erweiterung: Quiz-Abschluss im Browser

Stand: 18.10.2026. Basis: `main` nach Merge von PR #93 (`f7f74c9`). Der Teams-Pilot ist abgeschlossen. Diese Erweiterung nutzt denselben Playwright-/Docker-Stack und ergänzt genau einen Browserfall `training-quiz-completion`. Status: alle drei Schritte umgesetzt, lokal und in GitHub abgenommen. Die Quiz-Erweiterung ist als [PR #95](https://github.com/yurtbayemre/sinnlos/pull/95) gepusht und noch nicht gemergt.

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

- [x] Als bestehendes Mitglied über das Formular anmelden, Training und den Testkurs öffnen. Zunächst `0 of 1 done` prüfen und die Lektion über `Start course` öffnen.
- [x] Ohne vollständige Antworten bleiben Prüfung und Abschluss gesperrt. Mit einer falschen und einer richtigen Antwort muss die Prüfung den Fehler anzeigen; der Abschluss bleibt gesperrt.
- [x] Nach Neuladen ist die Lektion weiterhin offen. Beide richtigen Antworten auswählen und prüfen; die Erfolgsmeldung schaltet den Abschluss frei.
- [x] Erneut laden: Eine erfolgreiche Prüfaktion allein hat noch keinen Abschluss erzeugt. Quiz erneut korrekt beantworten und ausdrücklich `Complete lesson` klicken.
- [x] Nach vollständigem Neuladen einen datierten Abschluss und keinen Abschlussbutton sehen. Kursdetail und Kurskarte in der Übersicht zeigen `Completed`; keine Fehlermeldung darf den Erfolg begleiten.

Abnahme: Der Fall besteht allein auf frischen Daten. Eine vorübergehende Störung, die den Abschluss nur als erfolgreich meldet, ohne den Beleg zu schreiben, muss die Persistenzprüfung scheitern lassen; anschließend wird sie vollständig zurückgenommen.

## 3 Gemeinsame Ausführung und Anleitung abschließen

- [x] Den bestehenden CI-Job und Artefaktnamen auf Browser-E2E verallgemeinern; alle drei Fälle laufen mit einem Worker und ohne Wiederholung im bestehenden Budget. Scope und Datenbankauslöser bleiben fachlich unverändert.
- [x] Anleitung und README um Quiz-Ablauf und Einzelaufruf ergänzen; den alten Teams-Plan als abgeschlossene Historie behalten.
- [x] Alle drei Fälle zweimal auf jeweils frischen Daten ausführen, Typecheck/Lint/Format und die betroffenen CI-Prüfungen ausführen. Cleanup sowie Fehlerbericht/Screenshot/Trace der Störungsprobe prüfen.
- [x] Unabhängigen Review sowie lokale und GitHub-Commit-/Laufnachweise dokumentieren. Die Implementierung wurde zuerst lokal abgeschlossen und anschließend als PR #95 auf GitHub abgenommen.

## Nachweise

- PR #93 ist nach `main` gemergt; [Main-CI](https://github.com/yurtbayemre/sinnlos/actions/runs/39119203517) für `f7f74c94e4e7e4b8c618bd7cdf0d37c59dc395b8` ist vollständig grün (8/8 Jobs, beide Teamtests bestanden).
- Schritt 1 lokal abgenommen: E2E-Typecheck und Lint grün; beide bestehenden Teamfälle bestanden mit den neuen veröffentlichten Kurs-Fixtures auf frischen Daten (2 Tests, 9,6 Sekunden, Run `sinnlos-e2e-843c19295d8681abf829770c`). Cleanup erfolgreich. Die gemeinsamen Dreierläufe sind unter Schritt 3 nachgewiesen.

- Schritt 2: `training-quiz-completion` bestand allein mit frischen Daten (1 Test, 6,4 Sekunden, Run `sinnlos-e2e-c2c016fabc08e9d995f59c76`). Typecheck und Lint grün. Die lokale Störung des CMS-Abschlusscontrollers meldete Erfolg ohne Datenbankschreibzugriff; der Test scheiterte im Run `sinnlos-e2e-be38c8fd3e926459cfae59ab` genau nach dem Neuladen am fehlenden datierten Abschluss (Status 1). HTML-Bericht, Screenshot und Trace wurden vor dem nächsten Lauf gesichert. Der Controller wurde bytegenau wiederhergestellt; kein Anwendungscode gehört zur Erweiterung.
- Schritt 3: Zwei aufeinanderfolgende vollständige Läufe unter `CI=true`, einem Worker und ohne Wiederholung bestanden mit jeweils drei Browserfällen: `sinnlos-e2e-e75633725f4889b2489ac4dd` (14,7 Sekunden) und `sinnlos-e2e-5f54760a204ff095cd7d68ce` (14,6 Sekunden). Beide verwendeten neue Datenbanken und Testsitzungen. Die nativen Login-Limits blieben unverändert; keine 429-Antwort trat auf.
- Alle fünf Läufe dieser Erweiterung hinterließen keine eigenen Container, Netzwerke, privaten Laufdateien oder CMS-/Web-Image-Tags. Der negative Bericht, Screenshot und gültige Trace sind lokal gesichert; die 15 Credential-Felder der Containerdiagnose sind redigiert. Der Screenshot zeigt nach Reload wieder das gesperrte Quiz statt eines gespeicherten Abschlusses.
- E2E-Typecheck und Lint, fünf Runner-Tests, die Git-basierte CI-Scope-Suite, 21 Build-/Action-Pin-Tests, Actionlint und die Formatprüfung aller betroffenen Dateien sind grün. Der unabhängige Review fand keine bestätigten Probleme. Anwendungscode, Domain-Regeln, Abhängigkeiten und Lockfile bleiben unverändert; deren vollständige Unit-/HTTP-Basis ist durch den grünen Main-Lauf belegt.
- Implementierungscommits: `7ae0620` (Plan), `1ba19bf` (Fixtures und gemeinsamer Login), `9f77d09` (Quizfall und Persistenzprobe), `00f7af8` (CI-Namen und lokale Abnahme). Der CI-Job und neue Artefakte heißen `e2e · browser` und `e2e-browser-<run_id>-<run_attempt>`; nur die Namen ändern sich, Scope und Laufzeitbudgets bleiben erhalten.
- GitHub-Abnahme: [CI-Lauf 39120220734](https://github.com/yurtbayemre/sinnlos/actions/runs/39120220734) auf `00f7af82776a19c8734dc237b2e6840314db0b25`, Versuch 1, alle acht CI-Jobs grün. Alle drei Browserfälle bestanden in 18,1 Sekunden mit einem Worker; der dekodierte HTML-Bericht bestätigt genau einen erfolgreichen Versuch pro Fall, `retry: 0`, keine Fehler, Flakes oder übersprungenen Tests. Der Quizfall dauerte 6,388 Sekunden.
- Das heruntergeladene [Artefakt `e2e-browser-39120220734-1`](https://github.com/yurtbayemre/sinnlos/actions/runs/39120220734/artifacts/12134445234) enthält ausschließlich Bericht, Ergebnisse und Logs. Keine privaten Env-/Fixture-Dateien; alle 15 Credential-Felder der Containerdiagnose sind redigiert. Cleanup der drei Container, des Netzwerks und beider Image-Tags ist bestätigt; die abschließende Containerprüfung war leer. Aufbewahrung bis 25.10.2026.
- Die GitHub-Abnahme ist abgeschlossen. Offen bleibt der Merge von PR #95; Staging und Produktion wurden nicht verändert.
