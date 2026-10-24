# Implementierungsplan für automatische E2E Tests

Stand: 18.10.2026. Ausgangspunkt: Main `c2bce321`, nach dem Merge von Batch 17 und der Rollback-Rehearsal. Status: Schritte 1–6 umgesetzt und lokal sowie auf GitHub abgenommen. Die CI-Belege stehen unter GitHub-Abnahme; PR #93 ist als `f7f74c9` nach Main gemergt. Die [Quiz-Erweiterung](./plan-e2e-quiz.md) führt den Browserumfang separat fort.

Der erste Pilot prüft das Modul **Teams** im Browser: Ein Team-Lead ändert die Beschreibung seines Teams, und ein Mitglied kann den gespeicherten Text lesen. Zwei Tests sollen automatisch in der CI laufen und die Strecke vom sichtbaren Login über Next.js und Strapi bis zur Datenbank abdecken.

Wir arbeiten die nummerierten Schritte einzeln ab. Nach jedem Schritt werden die zugehörigen Nachweise hier ergänzt; der nächste Schritt beginnt mit dem nächsten Umsetzungsauftrag.

## Umfang und feste Entscheidungen

- Playwright Test mit Chromium, einem Worker, einer festen Sprache (`en`) und Desktop-Auflösung. Keine Browser-, Sprach- oder Gerätematrix im Piloten.
- Echter Next.js-Server mit gebauter Anwendung, echtes Strapi mit dem normalen Bootstrap und PostgreSQL 16. Keine HTTP-Mocks, kein `DEMO_MODE` und kein Umgehen des Login-Formulars.
- Jeder Lauf besitzt seine eigene temporäre Datenbank und seine Prozesse. Er verwendet lokale Adressen und eigene Testzugänge. Damit hängt er nicht vom DNS/TLS der bisherigen Staging-Instanz ab.
- Die CI läuft auf Linux. Die dokumentierte lokale Ausführung verwendet dieselben Voraussetzungen; bestehende Windows-Buildprobleme werden nicht durch einen anderen App-Modus verdeckt.
- Zunächst genau zwei unabhängige Browserfälle. Beide melden sich über das sichtbare Formular an. Browser-Kontexte und veränderliche Teamdaten werden zwischen den Fällen nicht geteilt.
- Vorhandene Unit- und HTTP-Integrationstests bleiben zuständig für die breite Rollen-/Feldmatrix, direkte API-Schreibrechte und Datenbankrennen. Der E2E-Pilot ergänzt den sichtbaren Benutzerablauf.
- Uploads, Quizze, Veröffentlichungen, Zeitplanung, Microsoft-Login, vollständige Barrierefreiheitsprüfung und visuelle Screenshot-Vergleiche gehören nicht zu diesem Piloten.

## 1 Testwerkzeug und Projektanbindung vorbereiten

- [x] `@playwright/test` als Entwicklungsabhängigkeit mit passender Lockfile ergänzen; den vorhandenen Node-/pnpm-Versionen folgen.
- [x] Eine Playwright-Konfiguration und `e2e/` außerhalb der Produktionsquellen anlegen. Als späteren Einstieg `pnpm test:e2e` vorsehen.
- [x] E2E-Dateien bewusst in Typecheck und Lint aufnehmen. Die vorhandenen Test-Tsconfigs erfassen nur `*.test.ts`; die Workspace-Lint-Aufrufe erfassen ein neues Root-Verzeichnis nicht automatisch. Vorhandene TypeScript-/ESLint-Pakete verwenden.
- [x] Playwright-Dateien von der Vitest-Sammlung und App-Builds getrennt halten. Reports, Traces, temporäre Laufdaten und etwaige Sitzungsdateien aus Git, Format-/Lint-Suchen und Docker-Kontext ausschließen.
- [x] Einen Worker, zunächst keine automatischen Wiederholungen, feste Zeitlimits und in CI ein Verbot von `test.only` konfigurieren. Ein Lauf ohne gesammelte Tests darf nicht als bestanden gelten.

**Abnahme:** Installation, E2E-Typecheck/Lint und die betroffenen bestehenden Prüfungen funktionieren. Produktionsbuilds ziehen weder Testcode noch Browser-Binaries in die Anwendung. Zu diesem Zeitpunkt wird noch kein bestandener Browser-Test behauptet.

## 2 Isolierte Testumgebung und Fixtures starten

Ein kleiner, separat ausgeführter Teststarter lädt das gebaute CMS, legt die Fixtures über Strapis User Service und Document Service an und öffnet anschließend den HTTP-Server. Er nutzt die vorhandenen Compiler-/Bootstrap-Muster. Das Vitest-Harness mit seinem `inject`-Kontext wird dafür nicht in ein neues allgemeines Testframework umgebaut.

- [x] PostgreSQL 16 für den Lauf isoliert starten. Der Runner erzeugt und kennt seine eigene Datenbank, Ports und Prozess-/Container-Identitäten; beliebige externe Datenbankadressen sind kein Eingang für den Piloten.
- [x] Die Anwendung einmal pro Lauf bauen und CMS/Web mit begrenzten Bereitschaftsprüfungen starten. Keine Übernahme bereits laufender Entwicklungs- oder Staging-Server.
- [x] Eine Abteilung, zwei bestätigte lokale Benutzer (`team_lead`, `member`) und je Browserfall ein eigenes Team anlegen. Den Lead nur dem Team des Erfolgstests zuweisen: `team.lead` ist eine `oneToOne`-Relation. Das Team des Rechtefalls bleibt ohne Lead; das Mitglied wird beiden Teams zugeordnet. Der Ausgangstext unterscheidet sich ausdrücklich vom späteren Testtext.
- [x] Zufällige Testpasswörter und gültige Secrets erzeugen. Keine vorhandenen Projekt-`.env`-Dateien laden; auch Next.js darf keine lokale Konfiguration unbeabsichtigt übernehmen. Laufdaten nur temporär speichern und Zugangsdaten nicht in Runner-Logs ausgeben. Für die Aufzeichnung temporärer Testsitzungen gilt die Artefaktregel in Schritt 5.
- [x] `DEMO_MODE=0`, `SEED_DEMO_DATA=0`, `ENTRA_ENABLED=0`, `AUTH_LOCAL_ENABLED=1`, `TZ=UTC` und feste App-/Browser-Zeitzone setzen. Cron-/Mail-Nebeneffekte abschalten; die getestete Authentifizierung und Rechteprüfung bleiben aktiv.
- [x] `AUTH_URL` exakt auf die Browser-Origin und `STRAPI_URL` auf den CMS-Port setzen. `AUTH_TRUST_HOST` nur für diese isolierte lokale Umgebung setzen. Keine Abhängigkeit von `sinnlos.b12i.test`, Traefik oder Produktionszertifikaten.
- [x] Bei Erfolg, Startfehler und Abbruch alle eigenen Prozesse stoppen und nur die eigenen Daten entfernen. Vor Bereinigung Identität und Zielpfade prüfen. Diagnoseausgaben bleiben erhalten; Projektsecrets, private Laufdateien und separate Auth-Dateien werden nicht als CI-Artefakte hochgeladen.

**Abnahme:** Zwei Start-/Stop-Proben mit frischer Datenbank funktionieren. Eine absichtlich fehlgeschlagene Bereitschaftsprüfung endet mit Fehlercode und brauchbarem Log; der Runner hinterlässt keine laufenden eigenen Dienste. Testbenutzer, Teamzuordnung und Bereitschaft werden konkret geprüft.

## 3 Erfolgreiches Bearbeiten im Browser testen

Testfall `teams-edit-description`:

1. Im frischen Browser-Kontext das Login-Formular öffnen und den Team-Lead mit E-Mail und Passwort anmelden.
2. Sein vorbereitetes Team über die Teamübersicht öffnen und den sichtbaren Bearbeiten-Link benutzen.
3. Die Beschreibung auf einen für diesen Lauf bekannten neuen Text ändern, speichern und die sichtbare Erfolgsmeldung prüfen.
4. Die Seite neu laden und prüfen, dass das Bearbeitungsfeld weiterhin den neuen Text enthält.
5. Zur Teamdetailseite navigieren und die gespeicherte Beschreibung prüfen.
6. In einem getrennten Browser-Kontext das Mitglied anmelden, dasselbe Team öffnen und denselben gespeicherten Text prüfen.

- [x] Elemente über Rollen, Labels und sichtbare Namen ansprechen. Vorhandene zugängliche Beschriftungen nutzen; neue Test-IDs nur bei einer nachgewiesenen Mehrdeutigkeit.
- [x] Auf erwartete UI-Zustände warten, keine festen Schlafzeiten verwenden. Weder Save noch Login durch API-Aufrufe ersetzen.
- [x] Nach dem Speichern tatsächlich neu laden und mit der zweiten Sitzung lesen, damit ein bloß lokal geänderter React-Zustand den Test nicht bestehen lässt.

**Abnahme:** Der Fall besteht allein auf frischen Daten. Eine lokale, anschließend zurückgenommene Störung des Speicherns lässt ihn zuverlässig scheitern. Der Test beweist Login, Navigation, Speichern und erneutes Lesen zusammen.

## 4 Fehlende Bearbeitungsrechte im Browser testen

Testfall `teams-member-read-only` verwendet sein eigenes vorbereitetes Team und eine neue Mitgliedssitzung. Er benötigt keinen vorher erfolgreichen Bearbeitungstest.

- [x] Als normales Mitglied anmelden, das Team öffnen und den bekannten Ausgangstext sehen.
- [x] Prüfen, dass der Bearbeiten-Link für dieses Team fehlt.
- [x] `/teams/<slug>/edit` direkt aufrufen: Die vorgesehene Nicht-gefunden-Ansicht muss erscheinen; Editor und Speichern-Aktion müssen fehlen.
- [x] Zur Leseseite zurückkehren und den unveränderten Ausgangstext prüfen.

**Abnahme:** Beide Tests bestehen einzeln sowie zusammen und funktionieren auch in umgekehrter Reihenfolge. Der Rechtefall prüft die konkrete verweigerte Ansicht; ein beliebiger Serverfehler genügt nicht. Er verlangt nicht ausschließlich HTTP 404, weil die vorhandene Next.js-Streaming-Grenze bereits Status 200 gesendet haben kann. Direkte unbefugte CMS-Schreibversuche bleiben durch die vorhandenen HTTP-Integrationstests abgedeckt.

## 5 Automatische CI Ausführung ergänzen

Den vorhandenen Workflow um einen eindeutig benannten Check `e2e · teams` erweitern. Er läuft bei passenden Pull Requests, Pushes auf Main und bei manuellem Workflow-Start. Er nutzt ausschließlich seine eigene PostgreSQL-Instanz und installiert nur Chromium mit den benötigten Systembibliotheken.

### Auslöser und Datenbankkosten

Neben `full` und `database` bekommt die vorhandene Scope-Erkennung ein eigenes `e2e`-Ergebnis. Die bisherige Bedeutung von `database` bleibt erhalten. Eine relevante reine Web-Änderung darf den E2E-Stack starten, ohne dadurch die übrigen Datenbank-Testreihen zu aktivieren.

| Änderung                                                                                                             | E2E Pilot | Bisherige Datenbank-Testreihen            |
| -------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------- |
| Nur `docs/**/*.md`                                                                                                   | Aus       | Aus                                       |
| Teamseiten oder Organisationseditor im Web                                                                           | An        | Wie bisher bei reinen Web-Änderungen: aus |
| Gemeinsam genutzte Auth-/Session-/Rollenlogik, Layouts, Formulare, UI-Komponenten, globale Styles oder Übersetzungen | An        | Wie bisher bei reinen Web-Änderungen: aus |
| Nachweislich unabhängige, ausschließlich modulspezifische Web-Seite, etwa eine Poll-Leseseite                        | Aus       | Wie bisher: aus                           |
| CMS, Domain-Regeln, Laufzeit-/Build-/CI-Konfiguration oder gemeinsame Abhängigkeiten                                 | An        | Bestehende Scope-Regel                    |
| E2E-Tests, deren Runner oder Konfiguration                                                                           | An        | Bestehende Scope-Regel                    |
| Unbekannter Codepfad oder manueller Workflow-Start                                                                   | An        | Bestehende Scope-Regel                    |

Ausnahmen für unabhängige Seiten werden eng und ausdrücklich geführt. Gemeinsam verwendete Helfer dürfen dabei nicht mit ausgeschlossen werden. Ein Fehler beim Bestimmen des Scopes muss die CI fehlschlagen lassen.

- [x] `scripts/ci-scope.mjs` und seine bestehenden Tests gemeinsam erweitern: Docs, Teams, gemeinsame Web-Helfer, unabhängige Seite, CMS, Abhängigkeiten, E2E-Dateien, Umbenennungen, Löschungen, gemischter PR und manueller Start.
- [x] Typecheck/Lint der E2E-Dateien sowie den vollständigen Start-/Test-/Cleanup-Ablauf einbinden. Laufzeitbudgets für Start, Tests und CI-Job setzen; Cleanup und Artefaktsicherung brauchen darin Reserve.
- [x] Bei einem Testfehler Screenshot und Trace behalten (`only-on-failure` / `retain-on-failure`); bei Startfehlern CMS-/Web-/Runner-Logs bereitstellen. HTML-Bericht und Fehlerartefakte mit kurzer Aufbewahrung, beispielsweise sieben Tagen, hochladen.
- [x] Keine Produktionszugänge oder persistierten Auth-Dateien hochladen. Traces können ausschließlich temporäre Testzugänge und Testsitzungen enthalten; sie bleiben Diagnoseartefakte mit begrenzter Aufbewahrung und den Zugriffsrechten des Repositories. Das Repository ist öffentlich; diese Artefakte sind deshalb keine private Ablage.
- [x] Neue GitHub Actions gemäß Repository-Konvention auf vollständige Commit-SHAs pinnen. Keine aus einem Beispiel übernommenen beweglichen Action-Tags verwenden.
- [x] E2E-Fehler dürfen nicht durch `continue-on-error`, leere Testsammlung oder automatische Wiederholungen grün werden. Einen erforderlichen Merge-Check nur passend zur tatsächlich bestehenden Branch-Regel konfigurieren; dessen Status ausdrücklich dokumentieren.

**Stand:** Lokal und auf GitHub abgenommen. Die getrennten Nachweise unten belegen den vollständigen Pilotlauf, Docs-only-Skip sowie die rote/grüne Fehlerprobe.

**Abnahme:** Ein passender PR startet den E2E-Check und besteht beide Fälle. Ein ausschließlich dokumentarischer Lauf startet weder E2E noch dessen Datenbank. Ein absichtlich scheiternder Test lässt den Check rot werden und liefert verwertbare Artefakte; nach Rücknahme der Störung ist der Check wieder grün.

## 6 Pilot prüfen und Betriebsanleitung abschließen

- [x] Zwei aufeinanderfolgende vollständige Läufe auf frischen Daten ohne Wiederholung bestehen lassen. Die beiden Fälle zusätzlich einzeln ausführen, soweit der Unabhängigkeitsnachweis aus Schritt 4 noch nicht vorliegt.
- [x] Installation, lokale Voraussetzungen, `pnpm test:e2e`, Auswahl eines Einzelfalls, Aufruf des Fehlerberichts und Bereinigung nach einem abgebrochenen Lauf dokumentieren.
- [x] Laufzeit für Build, Start und Browserfälle getrennt messen. Erst anhand dieser Werte über zusätzliche Caches oder breitere Parallelisierung entscheiden.
- [x] Unabhängigen Review von Isolation, Testaussagen, CI-Auslösern und Cleanup durchführen. Nur bestätigte Probleme im Umfang des Piloten beheben.
- [x] Ergebnisse mit Commit und CI-Link hier vermerken. Danach mögliche weitere Module separat auswählen; ein Quiz-Abschluss ist der vorgesehene Kandidat.

**Stand:** Abgenommen. Aktuelle Commit-/CI-Links, heruntergeladene Artefakte und die Messung des kalten Ubuntu-Builds sind unter GitHub-Abnahme dokumentiert.

**Abnahme:** Beide Fälle laufen automatisch, Fehler sind nachvollziehbar und fremde Daten/Dienste werden nicht berührt. Bestehende Unit-/HTTP-Prüfungen bleiben grün. Der Pilot ist als Team-E2E-Abdeckung dokumentiert und wird nicht als vollständige Batch-17-Browser-Abnahme ausgegeben.

## Voraussichtlich betroffene Dateien

Die Liste grenzt die Arbeiten ein; beim Umsetzen wird der kleinste passende Zuschnitt verwendet.

| Bereich                       | Dateien oder vorhandene Anknüpfung                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| Werkzeug und Aufrufe          | `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `e2e/package.json`, `e2e/playwright.config.ts` |
| Testumgebung und Browserfälle | `e2e/` mit kleinem Runner/CMS-Starter, Fixtures und zwei Team-Fällen                                    |
| Statische Prüfungen           | E2E-Typecheck-/Lint-Einbindung mit vorhandenen Toolversionen; Test-Sammlung nur ändern, wenn nötig      |
| Generierte Dateien            | `.gitignore`, `.dockerignore`, `.prettierignore` und passende Lint-Ausnahmen                            |
| CI                            | `.github/workflows/ci.yml`, `scripts/ci-scope.mjs`, `scripts/ci-scope.test.mjs`                         |
| Dokumentation                 | Dieser Plan, kurze E2E-Anleitung unter `docs/`, Verweis bei den Testbefehlen in `README.md`             |

## Fortschritt

| Schritt                            | Status   | Nachweis                                      |
| ---------------------------------- | -------- | --------------------------------------------- |
| 1 Werkzeug und Projektanbindung    | Erledigt | Nachweise unten; [Anleitung](../e2e-tests.md)  |
| 2 Isolierte Testumgebung           | Erledigt | Lokale Nachweise unten; [CI](#github-abnahme) |
| 3 Beschreibung bearbeiten          | Erledigt | Lokale Nachweise unten; [CI](#github-abnahme) |
| 4 Mitglied ohne Bearbeitungsrechte | Erledigt | Lokale Nachweise unten; [CI](#github-abnahme) |
| 5 Automatische CI Ausführung       | Erledigt | [GitHub-Abnahme](#github-abnahme)             |
| 6 Abnahme und Anleitung            | Erledigt | [GitHub-Abnahme](#github-abnahme)             |

Die folgenden Einträge halten den Stand beim Abschluss jedes Schritts fest; die abschließende GitHub-Abnahme folgt darunter.

### Nachweise zu Schritt 1 (18.10.2026)

- Plan vor der Umsetzung separat als `1498786` committed und auf `codex/e2e-team-plan` gepusht.
- `@sinnlos/e2e` ist ein eigenes Workspacepaket mit Playwright 1.64.1 und den bestehenden TypeScript-/ESLint-Versionen. So greifen die vorhandenen rekursiven Prüfungen ohne zusätzliche Root-Skripte für Lint/Typecheck. Die Konfiguration liegt unter `e2e/`.
- Ein Root-Dev-Paket würde ins CMS-Image gelangen. Nexts optionaler Playwright-Peer zog die neue Abhängigkeit zunächst auch in den Web-Graphen; der gezielte Override `next>@playwright/test: "-"` verhindert das. Die App-Abhängigkeitsgraphen bleiben ohne Playwright.
- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` und die 21 Tests in `infra/build-pins.test.ts` bestanden. Lint hat ausschließlich die vorhandenen App-Warnungen.
- Temporäre, anschließend entfernte Negativproben bestätigen: Typecheck und Lint erfassen `*.spec.ts`, CI verweigert `test.only`, Vitest sammelt die Browserfälle nicht. `pnpm test:e2e` endet erwartungsgemäß mit `No tests found` und Status 1.
- Git und Prettier ignorieren `.e2e/`. Beide Docker-Abhängigkeitsstufen wurden mit gefrorener Lockfile gebaut und auf fehlende Playwrightpakete, Browsercache und E2E-Quellen geprüft. Auch beide vollständigen App-Images wurden erfolgreich gebaut und auf dieselben Ausschlüsse geprüft.
- Echte Browserabläufe und ein E2E-CI-Job sind noch nicht enthalten; sie gehören zu den folgenden Schritten.

### Nachweise zu Schritt 2 (18.10.2026, lokal)

- `e2e/run.mjs` und `e2e/compose.yaml` bauen die bestehenden Produktions-Dockerfiles je Lauf und starten ausschließlich ein eigenes Compose-Projekt mit PostgreSQL 16, CMS und Web. Die Datenbank liegt in tmpfs; CMS/Web veröffentlichen nur eigene Loopback-Ports. Es gibt keine zusätzliche Compiler-Implementierung oder Änderung am Vitest-Harness.
- `e2e/cms-start.mjs` verweigert eine nicht leere Datenbank vor Bootstrap, erzeugt die vereinbarten Fixtures über die vorhandenen Strapi-Services und prüft Rollen, Bestätigung, Abteilung und Teambeziehungen. Erst danach öffnet er HTTP. Echte CMS-Logins und `/api/me` bestätigen beide Rollen; die Web-Seite und der lokale Auth-Provider sind erreichbar.
- Mehrere frische `pnpm --filter @sinnlos/e2e check:setup`-Läufe bestanden einschließlich Bereinigung. Die wiederholten Prüfungen verwenden jeweils neue Datenbanken, Projekte, Ports und Zugangsdaten.
- Eine temporär auf einen unerreichbaren Erfolgsstatus gesetzte Web-Readiness ließ den Start mit Status 1 scheitern; die Störung wurde zurückgenommen. Ein echter Strg+C-Abbruch während des Starts führte ebenfalls zur Bereinigung. Container, Netzwerk und private Laufdateien fehlten danach; Diagnose-Logs blieben erhalten. Das gemeinsame PostgreSQL-Image wurde nicht entfernt.
- Der reguläre Einstieg `pnpm test:e2e` startet denselben frischen Stack, endet mangels Browserfällen erwartungsgemäß mit `No tests found` und Status 1 und bereinigt danach ebenfalls alle eigenen Ressourcen.
- Die fünf Node-Tests prüfen Umgebungstrennung, Secret-Redaktion, Fremd-Container-/Fremdpfad-Abwehr und echte HTTP-Readiness-Fehler/Timeouts. Sie sind in `pnpm test` eingebunden. Typecheck und Lint des gesamten Repositories bestanden; Lint hat nur die vorhandenen App-Warnungen.
- Der Standard-Bridge des eigenen Compose-Projekts wird verwendet: `internal: true` ließ auf dem geprüften Docker Desktop zwar interne Healthchecks bestehen, verhinderte aber den Host-Zugriff auf den veröffentlichten Web-Port. Keine Verbindung zu bestehenden Projektnetzwerken; SMTP, Digests, App- und Plugin-Crons sind deaktiviert.
- Laufdaten liegen ausschließlich unter `.e2e/`; private Env-/Fixturedateien werden gelöscht, bekannte zufällige Secrets in gespeicherten Logs redigiert. Bei hartem Prozessabbruch oder nicht erreichbarem Docker-Daemon kann eine manuelle Bereinigung anhand der protokollierten Run-ID nötig sein; siehe [Anleitung](../e2e-tests.md).
- Auf Wunsch bleibt dieser Schritt lokal: kein Push, keine Änderung an Staging oder Produktion. Browserfälle und E2E-CI folgen weiterhin erst in Schritten 3–5.

### Nachweise zu Schritt 3 (18.10.2026, lokal)

- `e2e/teams.spec.ts` meldet den Lead über das sichtbare Formular an, öffnet sein Team über die Übersicht, ändert die Beschreibung und prüft die Erfolgsmeldung. Der bekannte Ausgangstext und der neue Text mit Run-ID unterscheiden sich ausdrücklich.
- Ein vollständiger Reload prüft das gespeicherte Bearbeitungsfeld. Anschließend wird derselbe Text auf der Detailseite und nach einem eigenen Formularlogin als Mitglied in einem getrennten Browser-Kontext gelesen. Rollen-/Label-Locators reichen aus; keine zusätzlichen Test-IDs, API-Abkürzungen oder festen Wartezeiten.
- `pnpm test:e2e --grep teams-edit-description` bestand auf einer frischen Datenbank mit Chromium. E2E-Typecheck und Lint bestanden; ein unabhängiger Review fand keine relevanten Probleme.
- Für die Negativprobe wurde ausschließlich in der lokalen CMS-Testversion die neue Beschreibung durch den bisherigen Datenbankwert ersetzt. Trotz sichtbarem „Saved.“ scheiterte der Test zuverlässig beim Reload am alten Feldinhalt und lieferte Status 1, Screenshot und Trace. Die einzelne Störungszeile wurde vollständig zurückgenommen. Der anschließende reguläre Lauf `pnpm test:e2e` bestand erneut auf frischen Daten. Nach allen drei Läufen fehlten eigene Container, Netzwerke und private Laufdateien.
- Die dokumentierten Browser-Installations- und Einzeltestbefehle stehen in der [Anleitung](../e2e-tests.md). Punkt 4 (Mitglied ohne Bearbeitungsrechte) und Punkt 5 (automatische CI) bleiben offen. Kein Push, keine Änderung an Staging oder Produktion.

### Nachweise zu Schritt 4 (18.10.2026, lokal)

- `teams-member-read-only` meldet das Mitglied im frischen Browser-Kontext an, öffnet sein separates Readonly-Team über die Übersicht und prüft den Ausgangstext sowie den fehlenden Bearbeiten-Link. Beide Fälle liegen in `e2e/teams.spec.ts`; nur Fixture-Lesen und Formularlogin/Navigation werden geteilt. Die sichtbare Account-E-Mail bestätigt jeweils die verwendete Sitzung.
- Der direkte Aufruf der Edit-URL muss die konkreten Texte der Nicht-gefunden-Ansicht und ihren Dashboard-Rücklink zeigen. Erst danach werden fehlende Description-Textbox und Save-Button geprüft. Ein Loading-Skeleton, ein generischer Fehler oder eine Umleitung zum Login genügt nicht; HTTP 200 durch Streaming bleibt zulässig.
- Ein erneuter Dokumentabruf der Teamdetailseite bestätigt den unveränderten Text. Der Rechtefall benötigt weder den Bearbeitungsfall noch dessen veränderte Daten.
- Beide Fälle bestanden einzeln über `pnpm test:e2e --grep <Testname>`. Auch der gemeinsame Lauf mit zuerst `teams-member-read-only` bestand. Dafür wurden nur vorübergehend die beiden Testblöcke vertauscht und anschließend vollständig zurückgestellt; ein dauerhafter Reihenfolge-Schalter wurde nicht ergänzt. Abschließend bestand `pnpm test:e2e` in der normalen Reihenfolge ebenfalls (2 Tests, 8,7 Sekunden). Alle vier Läufe verwendeten frische Datenbanken; danach waren eigene Container, Netzwerke und private Laufdateien entfernt.
- E2E-Typecheck, Lint und Formatprüfung bestanden; der unabhängige Review fand keine relevanten Probleme. Anwendungscode, Fixtures und Runner bleiben unverändert. Die [Anleitung](../e2e-tests.md) beschreibt beide Fälle und ihre Einzelaufrufe.
- Dieser Schritt bleibt lokal: kein Push und keine Änderung an Staging oder Produktion. Als Nächstes folgt Punkt 5, die automatische CI-Ausführung.

### Nachweise zu Schritt 5 (18.10.2026, lokale Umsetzung)

- `scripts/ci-scope.mjs` liefert zusätzlich `e2e`; `full` und `database` behalten ihre bisherige Bedeutung. Neben `docs/**/*.md` sind ausschließlich die konkrete Poll-Leseseite und ihre eigene Ladeansicht ausgenommen. Gemeinsame Helfer, neue Poll-Dateien, Teams, Auth, Styles, Übersetzungen, CMS, Abhängigkeiten, E2E und unbekannte Pfade bleiben relevant. Manuelle Läufe aktivieren alle Prüfungen.
- Die erweiterten Scope-Tests bestanden mit echten Git-Änderungen: Web ohne bisherige Datenbankreihen, enge Poll-Ausnahmen, gemischte PRs trotz letztem Docs-Commit, beide Seiten von Umbenennungen, Löschungen, mehr als 300 Dateien, manueller/neuer Branch sowie fehlerhafte Vergleichsdaten ohne ausgegebenen Skip-Status.
- Der neue Ubuntu-Job `e2e · teams` installiert die gefrorenen Abhängigkeiten und ausschließlich Chromium samt Systembibliotheken. Er verwendet `pnpm test:e2e` einschließlich Start, Fixtures und Cleanup. E2E-Typecheck/Lint laufen bereits im bestehenden Build-Job. Joblimit 50 Minuten, Runner-Schritt 36 Minuten, Installation je fünf Minuten, Upload drei Minuten; die engeren Build-/Start-/Browserlimits bleiben im Runner.
- Der Upload läuft bei Erfolg und Fehler, soweit der Workflow nicht abgebrochen wurde. Die Positivliste enthält ausschließlich `.e2e/report/`, `.e2e/results/` und `.e2e/logs/`, mit explizit erlaubtem verstecktem Elternverzeichnis und sieben Tagen Aufbewahrung. Private `runs/`, Env-/Fixturedateien und separate Auth-Dateien gehören nicht dazu. `actions/upload-artifact` v7.0.2 ist anhand des offiziellen Release-Tags auf `cf430e030ddbb5b0abf93d22962f4752f3646cd9` gepinnt.
- Actionlint 1.7.12 akzeptierte den Workflow; die 21 Build-/Action-Pin-Tests und fünf Runner-Tests bestanden. Ein unabhängiger Review fand keine relevanten Probleme.
- Eine temporär falsche Browser-Erwartung unter `CI=true` ließ den echten Lauf mit Status 1 scheitern. HTML-Bericht, Screenshot, Trace und Runner-/Dienst-/Build-Logs waren vorhanden; die Credential-Felder der gespeicherten Containerdiagnose waren vollständig redigiert. Die Störung wurde vollständig zurückgenommen. Anschließend bestanden beide Browserfälle unter `CI=true` wieder (2 Tests, 9,0 Sekunden). Nach beiden Läufen waren eigene Container, Netzwerke und private Laufdateien entfernt.
- Die GitHub-API bestätigte am 18.10.2026: `main` hat keine Branch Protection und keine anwendbaren Branch Rules. Der neue Check wird deshalb nicht als erzwungene Merge-Sperre ausgegeben; keine Repository-Regel wurde verändert. Das öffentliche Repository macht auch Diagnoseartefakte für Repository-Leser zugänglich; sie enthalten ausschließlich Wegwerfdaten.
- Zum Abschluss der lokalen Umsetzung gab es noch keinen Push oder Remote-Workflow-Start und keine Änderung an Staging/Produktion. Damals offen waren der tatsächliche Ubuntu-Lauf (einschließlich kaltem Image-Build), ein Docs-only-Run ohne E2E/Datenbank sowie die rote/grüne GitHub-Probe mit herunterladbaren Artefakten. Die [Anleitung](../e2e-tests.md#ci-execution-and-scope) beschreibt Scope, Budgets, Abbruchgrenze und Artefakte.

### Nachweise zu Schritt 6 (18.10.2026, lokale Abnahme)

- Referenzstand: `0dd5a04` (CI-Konfiguration), davor `5cd0062` (Rechtefall) und `a305491` (Bearbeitungsfall). Zwei aufeinanderfolgende vollständige `pnpm test:e2e`-Läufe unter `CI=true` bestanden mit jeweils zwei Browserfällen, einem Worker und ohne Wiederholungen. Beide verwendeten neue Projekte, Datenbanken und Zugangsdaten. Einzel- und umgekehrte Reihenfolgeläufe sind bereits in Schritt 4 nachgewiesen.
- Lauf 1: `sinnlos-e2e-adbcc6d0dabbfe706b25644f`; Lauf 2: `sinnlos-e2e-262fa2e0e332f2b72ce44643`. Danach fehlten alle eigenen Container, Netzwerke, privaten Laufdateien und CMS-/Web-Image-Tags. Gemeinsame Images und Build-Cache wurden beibehalten.

| Lauf | Build   | Start inklusive Vorprüfungen | Browser | Cleanup | Gesamt  |
| ---- | ------- | ---------------------------- | ------- | ------- | ------- |
| 1    | 11,56 s | 13,67 s                      | 9,58 s  | 3,45 s  | 40,10 s |
| 2    | 11,37 s | 13,79 s                      | 9,59 s  | 3,64 s  | 39,62 s |

- Messung am unveränderten Runner über seine Fortschrittsmeldungen, einschließlich Browser-Prozessstart und Berichtserstellung. Die Gesamtdauer enthält zusätzlich pnpm-Aufruf und Vorbereitung. Umgebung: Windows mit Docker Desktop/Linux-Containern und vorhandenem Docker-Build-Cache; beide Datenbanken waren frisch. Diese Werte belegen keinen kalten Ubuntu-CI-Build. Zusätzliche Caches oder Parallelisierung werden vor dessen Messung nicht eingeführt.
- Der unabhängige Schlussreview des gesamten Pilot-Diffs `1498786..0dd5a04` fand keine bestätigten Probleme in Isolation, Secrets, Fixtures, Testaussagen, CI-Auslösern, Artefaktgrenzen oder Cleanup.
- Die [Betriebsanleitung](../e2e-tests.md) enthält Installation, Voraussetzungen, Gesamt-/Einzelaufrufe, Bericht/Trace sowie konkrete Bereinigung nach hartem Abbruch. Dabei werden nur geprüfte Run-IDs und lokale Docker-Endpunkte verwendet; fehlende Env-Dateien werden nicht rekonstruiert. Für private Dateien wird die vorhandene Pfad-/Owner-Prüfung des Runners wiederverwendet.
- [Letzter bestandener CI-Basislauf](https://github.com/yurtbayemre/sinnlos/actions/runs/39113118307) auf `a30549166b1cf0a40ce265163648b9a58b1e374b`: Unit-/Build-Prüfung, TZ-Matrix und SQLite-/Postgres-HTTP-Integration grün. Anwendungscode, Domain-Paket, Lockfile und Root-Paketmanifest sind seither unverändert. Die aktuellen Scope-/Pin-/Runner-Prüfungen sind in Schritt 5 nachgewiesen. Der alte CI-Link ist ausdrücklich kein Nachweis für den neuen E2E-Job; die vollständigen Unit-/HTTP-Suites wurden lokal nicht erneut ausgeführt.
- Der lokale Abschluss in `50e746e` änderte nur die Dokumentation; zu diesem Zeitpunkt gab es keinen Push, neuen Remote-CI-Lauf oder Eingriff in Staging/Produktion. Die damals noch fehlenden GitHub-Läufe und Artefakt-Downloads sind im folgenden Abschnitt nachgewiesen. Der Pilot deckt Teams ab; Quiz-Abschluss und weitere Module bleiben separate Folgeaufträge, ebenso eine vollständige Batch-17-Browserabnahme.

### GitHub-Abnahme

Die drei lokalen Commits `5cd0062`, `0dd5a04` und `50e746e` wurden nach der lokalen Abnahme auf den [Pilot-PR #93](https://github.com/yurtbayemre/sinnlos/pull/93) gepusht. Die Scope- und Fehlerproben liefen getrennt im temporären [Prüf-PR #94](https://github.com/yurtbayemre/sinnlos/pull/94), dessen Basis der Pilotbranch ist. Die absichtliche Störung gehört nicht zum Pilot-PR.

| Nachweis                                    | Commit    | CI-Lauf                                                                        | Ergebnis                                                                                          |
| ------------------------------------------- | --------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Vollständiger Pilot auf Ubuntu 24.04        | `50e746e` | [39114859538](https://github.com/yurtbayemre/sinnlos/actions/runs/39114859538) | Alle acht Jobs grün; beide Browserfälle ohne Wiederholung bestanden                               |
| Ausschließlich `docs/**/*.md` geändert      | `7f6b59a` | [39114926403](https://github.com/yurtbayemre/sinnlos/actions/runs/39114926403) | Grün; `full=false`, `database=false`, `e2e=false`; E2E, DB-Testreihen und Images übersprungen     |
| Absichtlich falsche Erwartung im Rechtefall | `fab3ef9` | [39115093800](https://github.com/yurtbayemre/sinnlos/actions/runs/39115093800) | E2E rot, sieben übrige Jobs grün; ein Browserfall bestanden, einer erwartungsgemäß fehlgeschlagen |
| Korrekte Erwartung wiederhergestellt        | `a7a3dd5` | [39115586504](https://github.com/yurtbayemre/sinnlos/actions/runs/39115586504) | E2E grün; beide Browserfälle ohne Wiederholung bestanden                                          |

- Der vollständige Pilotlauf bestätigt zusätzlich 7317 bestandene Unit-Tests, fünf Runner-Tests und 1050 bestandene HTTP-Integrationstests sowie die Zeitzonen-Matrix. Die regulären übersprungenen Tests sind keine E2E-Wiederholungen: 72 in der Unit-Suite, 24 in der Integration.
- Der erste E2E-Job benötigte insgesamt 168 Sekunden: Dependencies 6 Sekunden, Chromium/Systembibliotheken 20 Sekunden, Runner 129 Sekunden. Der kalte Image-Build dauerte 99,738 Sekunden, Start inklusive Fixture-/Auth-Prüfung 16,712 Sekunden, die zwei Browserfälle 9,9 Sekunden. Build-Logs enthalten weder Cache-Importe noch `CACHED`-Schritte. Die bestehenden Zeitbudgets reichen; kein zusätzlicher Cache und keine Parallelisierung ergänzt.
- [Erfolgsartefakt](https://github.com/yurtbayemre/sinnlos/actions/runs/39114859538/artifacts/12131218970) und [Fehlerartefakt](https://github.com/yurtbayemre/sinnlos/actions/runs/39115093800/artifacts/12132500325) wurden tatsächlich heruntergeladen und geprüft. Beide enthalten nur `logs/`, `report/` und `results/`; keine privaten Lauf-, Env-, Fixture- oder separaten Auth-Dateien. Das Fehlerartefakt enthält einen HTML-Bericht, einen Screenshot und einen gültigen Trace. Der Screenshot zeigt die erwartete Nicht-gefunden-Ansicht, während der Test absichtlich einen anderen Text verlangt.
- In beiden Downloads sind alle 15 Credential-Felder der gespeicherten Containerdiagnose redigiert. Die Fehlerlogs enthalten weder rohe JWTs noch das im Trace geprüfte temporäre Testpasswort. Traces dürfen weiterhin ausschließlich Wegwerfzugänge und Testsitzungen enthalten; die siebentägige Aufbewahrung endet für diese Artefakte am 25.10.2026.
- Beide Läufe entfernten ihre drei Container, das Netzwerk und die eigenen CMS-/Web-Image-Tags. Die abschließende Containerprüfung ist leer. Staging und Produktion wurden nicht berührt.
- Das heruntergeladene Wiederherstellungsartefakt bestätigt zwei bestandene Tests mit `retry=0`, einen erfolgreichen Ergebnisstatus und dieselben Datei-/Redaktionsgrenzen. Es enthält erwartungsgemäß keine Fehlerscreenshots oder Traces. Auch dessen Cleanup ist vollständig nachgewiesen.

## Technische Bezugspunkte

- [Teamdetailseite](<../../apps/web/src/app/(app)/teams/[slug]/page.tsx>), [Bearbeitungsseite](<../../apps/web/src/app/(app)/teams/[slug]/edit/page.tsx>), [Organisationseditor](../../apps/web/src/components/manage/org-editor.tsx) und [Loader](../../apps/web/src/lib/loaders/manage/org.ts).
- [Vorhandenes CMS-Testsetup](../../apps/cms/src/integration/harness.test.helper.ts) und [CMS-Compiler für Tests](../../apps/cms/src/integration/global-setup.test.helper.ts) als Muster für Bootstrap, Fixtures und Lebensdauer.
- [Bestehende CI](../../.github/workflows/ci.yml) und [Scope-Erkennung](../../scripts/ci-scope.mjs).
- Playwright: [CI-Ausführung](https://playwright.dev/docs/ci), [Aufzeichnungen und Screenshots](https://playwright.dev/docs/test-use-options#recording-options).
