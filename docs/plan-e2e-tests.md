# Implementierungsplan für automatische E2E Tests

Stand: 18.10.2026. Ausgangspunkt: Main `c2bce321`, nach dem Merge von Batch 17 und der Rollback-Rehearsal. Status: Planung; die sechs Umsetzungsschritte sind offen.

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

- [ ] `@playwright/test` als Entwicklungsabhängigkeit mit passender Lockfile ergänzen; den vorhandenen Node-/pnpm-Versionen folgen.
- [ ] Eine Playwright-Konfiguration und `e2e/` außerhalb der Produktionsquellen anlegen. Als späteren Einstieg `pnpm test:e2e` vorsehen.
- [ ] E2E-Dateien bewusst in Typecheck und Lint aufnehmen. Die vorhandenen Test-Tsconfigs erfassen nur `*.test.ts`; die Workspace-Lint-Aufrufe erfassen ein neues Root-Verzeichnis nicht automatisch. Vorhandene TypeScript-/ESLint-Pakete verwenden.
- [ ] Playwright-Dateien von der Vitest-Sammlung und App-Builds getrennt halten. Reports, Traces, temporäre Laufdaten und etwaige Sitzungsdateien aus Git, Format-/Lint-Suchen und Docker-Kontext ausschließen.
- [ ] Einen Worker, zunächst keine automatischen Wiederholungen, feste Zeitlimits und in CI ein Verbot von `test.only` konfigurieren. Ein Lauf ohne gesammelte Tests darf nicht als bestanden gelten.

**Abnahme:** Installation, E2E-Typecheck/Lint und die betroffenen bestehenden Prüfungen funktionieren. Produktionsbuilds ziehen weder Testcode noch Browser-Binaries in die Anwendung. Zu diesem Zeitpunkt wird noch kein bestandener Browser-Test behauptet.

## 2 Isolierte Testumgebung und Fixtures starten

Ein kleiner, separat ausgeführter Teststarter lädt das gebaute CMS, legt die Fixtures über Strapis User Service und Document Service an und öffnet anschließend den HTTP-Server. Er nutzt die vorhandenen Compiler-/Bootstrap-Muster. Das Vitest-Harness mit seinem `inject`-Kontext wird dafür nicht in ein neues allgemeines Testframework umgebaut.

- [ ] PostgreSQL 16 für den Lauf isoliert starten. Der Runner erzeugt und kennt seine eigene Datenbank, Ports und Prozess-/Container-Identitäten; beliebige externe Datenbankadressen sind kein Eingang für den Piloten.
- [ ] Die Anwendung einmal pro Lauf bauen und CMS/Web mit begrenzten Bereitschaftsprüfungen starten. Keine Übernahme bereits laufender Entwicklungs- oder Staging-Server.
- [ ] Eine Abteilung, zwei bestätigte lokale Benutzer (`team_lead`, `member`) und je Browserfall ein eigenes Team anlegen. Den Lead nur dem Team des Erfolgstests zuweisen: `team.lead` ist eine `oneToOne`-Relation. Das Team des Rechtefalls bleibt ohne Lead; das Mitglied wird beiden Teams zugeordnet. Der Ausgangstext unterscheidet sich ausdrücklich vom späteren Testtext.
- [ ] Zufällige Testpasswörter und gültige Secrets erzeugen. Keine vorhandenen Projekt-`.env`-Dateien laden; auch Next.js darf keine lokale Konfiguration unbeabsichtigt übernehmen. Laufdaten nur temporär speichern und Zugangsdaten nicht in Runner-Logs ausgeben. Für die Aufzeichnung temporärer Testsitzungen gilt die Artefaktregel in Schritt 5.
- [ ] `DEMO_MODE=0`, `SEED_DEMO_DATA=0`, `ENTRA_ENABLED=0`, `AUTH_LOCAL_ENABLED=1`, `TZ=UTC` und feste App-/Browser-Zeitzone setzen. Cron-/Mail-Nebeneffekte abschalten; die getestete Authentifizierung und Rechteprüfung bleiben aktiv.
- [ ] `AUTH_URL` exakt auf die Browser-Origin und `STRAPI_URL` auf den CMS-Port setzen. `AUTH_TRUST_HOST` nur für diese isolierte lokale Umgebung setzen. Keine Abhängigkeit von `sinnlos.b12i.test`, Traefik oder Produktionszertifikaten.
- [ ] Bei Erfolg, Startfehler und Abbruch alle eigenen Prozesse stoppen und nur die eigenen Daten entfernen. Vor Bereinigung Identität und Zielpfade prüfen. Diagnoseausgaben bleiben erhalten; Projektsecrets, private Laufdateien und separate Auth-Dateien werden nicht als CI-Artefakte hochgeladen.

**Abnahme:** Zwei Start-/Stop-Proben mit frischer Datenbank funktionieren. Eine absichtlich fehlgeschlagene Bereitschaftsprüfung endet mit Fehlercode und brauchbarem Log; der Runner hinterlässt keine laufenden eigenen Dienste. Testbenutzer, Teamzuordnung und Bereitschaft werden konkret geprüft.

## 3 Erfolgreiches Bearbeiten im Browser testen

Testfall `teams-edit-description`:

1. Im frischen Browser-Kontext das Login-Formular öffnen und den Team-Lead mit E-Mail und Passwort anmelden.
2. Sein vorbereitetes Team über die Teamübersicht öffnen und den sichtbaren Bearbeiten-Link benutzen.
3. Die Beschreibung auf einen für diesen Lauf bekannten neuen Text ändern, speichern und die sichtbare Erfolgsmeldung prüfen.
4. Die Seite neu laden und prüfen, dass das Bearbeitungsfeld weiterhin den neuen Text enthält.
5. Zur Teamdetailseite navigieren und die gespeicherte Beschreibung prüfen.
6. In einem getrennten Browser-Kontext das Mitglied anmelden, dasselbe Team öffnen und denselben gespeicherten Text prüfen.

- [ ] Elemente über Rollen, Labels und sichtbare Namen ansprechen. Vorhandene zugängliche Beschriftungen nutzen; neue Test-IDs nur bei einer nachgewiesenen Mehrdeutigkeit.
- [ ] Auf erwartete UI-Zustände warten, keine festen Schlafzeiten verwenden. Weder Save noch Login durch API-Aufrufe ersetzen.
- [ ] Nach dem Speichern tatsächlich neu laden und mit der zweiten Sitzung lesen, damit ein bloß lokal geänderter React-Zustand den Test nicht bestehen lässt.

**Abnahme:** Der Fall besteht allein auf frischen Daten. Eine lokale, anschließend zurückgenommene Störung des Speicherns lässt ihn zuverlässig scheitern. Der Test beweist Login, Navigation, Speichern und erneutes Lesen zusammen.

## 4 Fehlende Bearbeitungsrechte im Browser testen

Testfall `teams-member-read-only` verwendet sein eigenes vorbereitetes Team und eine neue Mitgliedssitzung. Er benötigt keinen vorher erfolgreichen Bearbeitungstest.

- [ ] Als normales Mitglied anmelden, das Team öffnen und den bekannten Ausgangstext sehen.
- [ ] Prüfen, dass der Bearbeiten-Link für dieses Team fehlt.
- [ ] `/teams/<slug>/edit` direkt aufrufen: Die vorgesehene Nicht-gefunden-Ansicht muss erscheinen; Editor und Speichern-Aktion müssen fehlen.
- [ ] Zur Leseseite zurückkehren und den unveränderten Ausgangstext prüfen.

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

- [ ] `scripts/ci-scope.mjs` und seine bestehenden Tests gemeinsam erweitern: Docs, Teams, gemeinsame Web-Helfer, unabhängige Seite, CMS, Abhängigkeiten, E2E-Dateien, Umbenennungen, Löschungen, gemischter PR und manueller Start.
- [ ] Typecheck/Lint der E2E-Dateien sowie den vollständigen Start-/Test-/Cleanup-Ablauf einbinden. Laufzeitbudgets für Start, Tests und CI-Job setzen; Cleanup und Artefaktsicherung brauchen darin Reserve.
- [ ] Bei einem Testfehler Screenshot und Trace behalten (`only-on-failure` / `retain-on-failure`); bei Startfehlern CMS-/Web-/Runner-Logs bereitstellen. HTML-Bericht und Fehlerartefakte mit kurzer Aufbewahrung, beispielsweise sieben Tagen, hochladen.
- [ ] Keine Produktionszugänge oder persistierten Auth-Dateien hochladen. Traces können ausschließlich temporäre Testzugänge und Testsitzungen enthalten; sie bleiben interne Diagnoseartefakte mit begrenzter Aufbewahrung.
- [ ] Neue GitHub Actions gemäß Repository-Konvention auf vollständige Commit-SHAs pinnen. Keine aus einem Beispiel übernommenen beweglichen Action-Tags verwenden.
- [ ] E2E-Fehler dürfen nicht durch `continue-on-error`, leere Testsammlung oder automatische Wiederholungen grün werden. Einen erforderlichen Merge-Check nur passend zur tatsächlich bestehenden Branch-Regel konfigurieren; dessen Status ausdrücklich dokumentieren.

**Abnahme:** Ein passender PR startet den E2E-Check und besteht beide Fälle. Ein ausschließlich dokumentarischer Lauf startet weder E2E noch dessen Datenbank. Ein absichtlich scheiternder Test lässt den Check rot werden und liefert verwertbare Artefakte; nach Rücknahme der Störung ist der Check wieder grün.

## 6 Pilot prüfen und Betriebsanleitung abschließen

- [ ] Zwei aufeinanderfolgende vollständige Läufe auf frischen Daten ohne Wiederholung bestehen lassen. Die beiden Fälle zusätzlich einzeln ausführen, soweit der Unabhängigkeitsnachweis aus Schritt 4 noch nicht vorliegt.
- [ ] Installation, lokale Voraussetzungen, `pnpm test:e2e`, Auswahl eines Einzelfalls, Aufruf des Fehlerberichts und Bereinigung nach einem abgebrochenen Lauf dokumentieren.
- [ ] Laufzeit für Build, Start und Browserfälle getrennt messen. Erst anhand dieser Werte über zusätzliche Caches oder breitere Parallelisierung entscheiden.
- [ ] Unabhängigen Review von Isolation, Testaussagen, CI-Auslösern und Cleanup durchführen. Nur bestätigte Probleme im Umfang des Piloten beheben.
- [ ] Ergebnisse mit Commit und CI-Link hier vermerken. Danach mögliche weitere Module separat auswählen; ein Quiz-Abschluss ist der vorgesehene Kandidat.

**Abnahme:** Beide Fälle laufen automatisch, Fehler sind nachvollziehbar und fremde Daten/Dienste werden nicht berührt. Bestehende Unit-/HTTP-Prüfungen bleiben grün. Der Pilot ist als Team-E2E-Abdeckung dokumentiert und wird nicht als vollständige Batch-17-Browser-Abnahme ausgegeben.

## Voraussichtlich betroffene Dateien

Die Liste grenzt die Arbeiten ein; beim Umsetzen wird der kleinste passende Zuschnitt verwendet.

| Bereich                       | Dateien oder vorhandene Anknüpfung                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| Werkzeug und Aufrufe          | `package.json`, `pnpm-lock.yaml`, `playwright.config.ts`                                           |
| Testumgebung und Browserfälle | `e2e/` mit kleinem Runner/CMS-Starter, Fixtures und zwei Team-Fällen                               |
| Statische Prüfungen           | E2E-Typecheck-/Lint-Einbindung mit vorhandenen Toolversionen; Test-Sammlung nur ändern, wenn nötig |
| Generierte Dateien            | `.gitignore`, `.dockerignore`, `.prettierignore` und passende Lint-Ausnahmen                       |
| CI                            | `.github/workflows/ci.yml`, `scripts/ci-scope.mjs`, `scripts/ci-scope.test.mjs`                    |
| Dokumentation                 | Dieser Plan, kurze E2E-Anleitung unter `docs/`, Verweis bei den Testbefehlen in `README.md`        |

## Fortschritt

| Schritt                            | Status | Nachweis |
| ---------------------------------- | ------ | -------- |
| 1 Werkzeug und Projektanbindung    | Offen  | —        |
| 2 Isolierte Testumgebung           | Offen  | —        |
| 3 Beschreibung bearbeiten          | Offen  | —        |
| 4 Mitglied ohne Bearbeitungsrechte | Offen  | —        |
| 5 Automatische CI Ausführung       | Offen  | —        |
| 6 Abnahme und Anleitung            | Offen  | —        |

## Technische Bezugspunkte

- [Teamdetailseite](<../apps/web/src/app/(app)/teams/[slug]/page.tsx>), [Bearbeitungsseite](<../apps/web/src/app/(app)/teams/[slug]/edit/page.tsx>), [Organisationseditor](../apps/web/src/components/manage/org-editor.tsx) und [Loader](../apps/web/src/lib/loaders/manage/org.ts).
- [Vorhandenes CMS-Testsetup](../apps/cms/src/integration/harness.test.helper.ts) und [CMS-Compiler für Tests](../apps/cms/src/integration/global-setup.test.helper.ts) als Muster für Bootstrap, Fixtures und Lebensdauer.
- [Bestehende CI](../.github/workflows/ci.yml) und [Scope-Erkennung](../scripts/ci-scope.mjs).
- Playwright: [CI-Ausführung](https://playwright.dev/docs/ci), [Aufzeichnungen und Screenshots](https://playwright.dev/docs/test-use-options#recording-options).
