# Batch 17: Produktionsbrief

Stand: 18.10.2026. **Vorbereitet, noch kein Deployment-Go.** Implementierung, lokale Image-Rehearsal und Browserabnahme einschließlich Schlussreview sind abgeschlossen. [PR #99](https://github.com/yurtbayemre/sinnlos/pull/99) wurde als `bf781e9e2ae845770704027839cbec1f0dc010d6` nach Main gemergt. Dieser Brief bereitet die bestehende Deployment-Prozedur vor; Produktion wurde dafür nicht aufgerufen oder verändert.

## Ziel und noch zu bestätigender Live-Stand

| Angabe                                                   | Stand                                                                                                                                                                                                                                                     |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Konkreter Zielvorschlag                                  | Commit `bf781e9e2ae845770704027839cbec1f0dc010d6`, CMS/Web-Tag nach erfolgreichem Deploy `bf781e9e2ae8`.                                                                                                                                                  |
| Ziel-CI                                                  | [Main-Lauf 39167674916](https://github.com/yurtbayemre/sinnlos/actions/runs/39167674916) auf genau diesem Commit grün; Docs-only, Scope/Format geprüft.                                                                                                   |
| Vollständige Build-/Test-Evidenz                         | [Main-Lauf 39151797525](https://github.com/yurtbayemre/sinnlos/actions/runs/39151797525) auf `e50cc359c94924e99747eae588c7bcf95fe552df`, alle acht Jobs einschließlich Browser-E2E bestanden. Seitdem bis zum Zielvorschlag nur Dokumentationsänderungen. |
| Produktionshost, Checkout, Compose-Projekt               | **Offen: in der Deployment-Session bestätigen.** Das vorhandene Produktionsverfahren verwendet `bigemo`, Checkout `/home/bigemo/git/sinnlos`, Projekt `infra`; das ist die Repository-Vorgabe, kein aktueller Live-Nachweis.                              |
| Aktueller Live-SHA/Tag und vorheriges gutes CMS/Web-Paar | **Offen: Deployment-State und tatsächliche laufende Images abgleichen.** Der lokale Rehearsal-Rollback `2f47b84fcadf` ist keine Bestätigung des Produktionsstands.                                                                                        |
| Aktuelles Backup und Verify-Nachweis                     | **Offen: vollständige Datenbank-/Uploads-/Konfigurationsgeneration samt Verifikation festhalten.**                                                                                                                                                        |
| Preflight, Wartungsfenster und Owner-Go                  | **Offen: erst nach bestätigten Instanz-/Ziel-/Rollbackdaten in der Deployment-Session.**                                                                                                                                                                  |

Der Zielcommit ist ein überprüfbarer Vorschlag, keine Annahme über die spätere Checkout-Spitze. Wird stattdessen ein neuerer Merge-Commit gewählt, müssen dessen vollständige SHA, Tag, Änderungsumfang und eigene grüne CI vor dem Go im Deployment-Protokoll feststehen. Ein Merge dieses Briefs ist noch kein Deploy. Der Wrapper baut beide Images aus dem bestätigten Zielcheckout; die lokalen Rehearsal-Image-IDs sind kein Versprechen identischer Produktions-Image-IDs.

## Änderungen, die beim Deploy zusammengehören

CMS und Web werden als Paar aktualisiert. Alle Lernmodi erhalten Fragen ohne Lösungsschlüssel; `lesson.quiz` ist privat. Der neue Wert `completionMode=exam` beschränkt Feedback auf ein Gesamtergebnis, auch bei Nachbetrachtung. Bestehende Werte und das gespeicherte Quizformat bleiben erhalten. Gegen v0.16.2 ist kein zusätzlicher manueller Anwendungsdaten-Migrationsschritt für den Vorwärtsdeploy vorgesehen; `downgrade.sql` gehört ausschließlich zum späteren Rollback. Bei einem abweichenden Live-Ausgangsstand sind zunächst dessen Vorgänger-Voraussetzungen zu klären.

- Admin/Editor können Kurse, Lektionen und Quizze über die geschützten Authoring-Wege bearbeiten, speichern, terminieren und veröffentlichen. Der bisherige Payload-Bypass entfällt; Writes benötigen den vorgesehenen Versions-/Feldvertrag.
- Head/Lead bearbeiten nur die jeweils erlaubten Organisationsbeschreibungen, Head zusätzlich die eigene Abteilungsfarbe. Admin kann Kurs-Cover, Abteilungsheader und Teamavatar ändern. Die Content-API erlaubt keine Organisationsanlage/-löschung mehr; alte Create/Delete-Grants werden explizit widerrufen. Namen, Mitgliedschaften und Struktur bleiben im Panel.
- Die Berechtigungssynchronisierung ergänzt die vorgesehenen Training-/Player-/Check-/Editable-Aktionen und die ausschließlich für Admin zugängliche Aktivitätsliste. Nach dem Boot ist die aktuelle Grantdiagnostik maßgeblich; keine festen Grant-Anzahlen für einen unbekannten Live-Ausgangsstand voraussetzen.
- `/manage/training` ist die Kursbearbeitung; der bisherige Bericht liegt unter `/manage/training/report`. Die Aktivitätsseite liegt unter `/manage/activity`.
- Batch 17 erfordert keine neue Env-Konfiguration, Edge-Umstellung oder JWT-Rotation. Produkt-Runtime-Abhängigkeiten bleiben gegenüber dem geprüften Batch-17-Stand unverändert; die später hinzugekommene E2E-Infrastruktur ist Testwerkzeug.

Unbegrenzte Quizversuche und fehlender Timer bleiben akzeptiert. Bereits bekannte Antworten werden nicht wieder geheim. Bestehende Abschlussbelege bleiben nach Quizänderungen gültig; bewertet wird der aktuell veröffentlichte Stand ohne Bindung an zuvor angezeigte Fragen. Gleichindexige Altantworten und die dokumentierten Publish-/Reparent-Rennen bleiben möglich. Panel-Saves haben weiterhin kein If-Match und können Webänderungen überschreiben.

## Ablauf in der Deployment-Session

Die folgenden Befehle sind **vorbereitet, hier nicht ausgeführt**. Bestehende [Deployment-Prozedur](DEPLOYMENT.md#74-update-procedure-production-safe), Compose-Overrides, Backup- und Lock-Konfiguration der bestätigten Instanz verwenden. Kein neuer Deploymentmechanismus und keine Übernahme lokaler Rehearsal-Secrets oder -Fixtures.

### 1. Live-/Rollbacknachweis und sauberes Zielcheckout

Im bestätigten Produktionscheckout, mit dessen tatsächlichem `PROJECT` und gegebenenfalls `DEPLOY_STATE_DIR`:

```bash
set -euo pipefail
: "${PROJECT:?Compose-Projekt der Zielinstanz bestätigen}"
COMPOSE=(docker compose -p "$PROJECT" -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml)
STATE_DIR="${DEPLOY_STATE_DIR:-$(git rev-parse --path-format=absolute --git-common-dir)/sinnlos-deploy}"
sed -n '/^\(SHA\|TAG\|LIVE_SMOKE\)=/p' "$STATE_DIR/$PROJECT.state"
ROLLBACK_SHA="$(sed -n 's/^SHA=//p' "$STATE_DIR/$PROJECT.state")"
ROLLBACK_TAG="$(sed -n 's/^TAG=//p' "$STATE_DIR/$PROJECT.state")"
: "${ROLLBACK_SHA:?Live-SHA fehlt}"
: "${ROLLBACK_TAG:?Rollback-Tag fehlt}"
docker inspect --format '{{.Name}} {{.Image}} {{.State.Health.Status}}' "$PROJECT-web-1" "$PROJECT-cms-1"
docker image inspect --format '{{.Id}}' "$PROJECT-web:$ROLLBACK_TAG" "$PROJECT-cms:$ROLLBACK_TAG"
```

State, laufende Images und gespeichertes gutes Paar müssen zusammenpassen. Abweichungen vor dem Go klären; keine Tags aus dem lokalen Test übernehmen. Danach den bestätigten Zielcommit nach der bestehenden Update-Prozedur sauber bereitstellen, `git status --short` und vollständige HEAD-SHA protokollieren. Keine fremden Änderungen resetten oder ungetrackte Dateien automatisch löschen.

```bash
: "${BATCH17_SHA:?vollständige freigegebene Ziel-SHA setzen}"
test "$(git rev-parse HEAD)" = "$BATCH17_SHA"
git status --short
COMPOSE_PROJECT="$PROJECT" DEPLOY_STATE_DIR="$STATE_DIR" infra/deploy.sh --check
COMPOSE_PROJECT="$PROJECT" DEPLOY_STATE_DIR="$STATE_DIR" infra/deploy.sh --dry-run --require-green-ci
```

Erwartet: sauberer Checkout/Buildkontext, `Preflight OK`, freie Deploysperre, genau die Ziel-CI grün, richtiges vorheriges Image-Paar und regulärer Live-Smoke. `--check` allein ersetzt den vollständigen Dry-run nicht. Die bestehende lesende [Grantdiagnostik](../infra/diagnostics/prod-perm-diff.sql) vor/nach dem Deploy archivieren; vor dem Update können erwartete Unterschiede zum neuen Soll auftreten. Eine Datei `admin-panel-permissions.sql` existiert nicht; das in der Abnahme dokumentierte lesende Grantinventar ersetzt keine effektive Panel-Rechteprüfung.

### 2. Backup und Deploy nach dem Instanz-Go

Eine aktuelle, verifizierte vollständige Backupgeneration mit Pfad und Verify-Ergebnis festhalten; das bestehende Backupverfahren aus `docs/DEPLOYMENT.md` verwenden. Der Wrapper erstellt zusätzlich sein reguläres Predeploybackup und bricht bei Fehlern vor dem Imagewechsel ab. Ein `sudo -l`-Ergebnis allein ist kein Nachweis eines erfolgreichen Backups. Im bisherigen Produktionsprojekt läuft dies über `backup-run --kind predeploy sinnlos`; keine Backup-Pfade oder Overrides aus der lokalen Rehearsal übernehmen.

```bash
COMPOSE_PROJECT="$PROJECT" DEPLOY_STATE_DIR="$STATE_DIR" infra/deploy.sh --require-green-ci
```

Kein Umgehen der CI-/Backup-/Lock-Prüfungen und kein `--record-without-live-smoke`. Erwartet sind Exit 0, erfolgreiche HTTP-/Live-/UTC-Smokes und erst danach das neue Last-known-good-Paar mit der tatsächlichen Ziel-SHA und `LIVE_SMOKE=passed`. Reguläre Einschränkungen eines Entra-only-/deaktivierten Live-Setups oder ein ungeprüfter Notification-Frame müssen im Bericht ausdrücklich stehen; daraus keinen vollständigen Frame-Test ableiten. Bei Fehlern den Befund sichern und das Rollbackverfahren unten anwenden, nicht blind retaggen.

### 3. Nachkontrolle und Owner-Browserpunkte

State, tatsächliche Image-IDs/Health und Fehlerlogs von CMS/Web prüfen. Die aktuelle Grantdiagnostik darf keine ungeklärten Unterschiede, unbekannten Rollen oder verwaisten/doppelten Grants zeigen; reine `plugin_default_first_boot`-Informationszeilen sind gesondert zu lesen. Vorherige Inhalte, Abschlussbelege und Bildverknüpfungen stichprobenartig gegen den Ausgangsnachweis vergleichen.

Mit vorher vereinbarten Rollen und markierten Testinhalten:

1. Admin/Editor: Kurs und Lektion als Entwurf speichern, neu laden, veröffentlichen; Member sieht erst die veröffentlichte Fassung. Eine reine Quizänderung aktiviert Speichern.
2. Bestehender Lernkurs: keine Lösungsschlüssel in der Lernerantwort. Confirm/quizGate/exam geben ihren vorgesehenen Feedbackumfang; falsche Antworten sperren den Abschluss, Feedback allein erzeugt keinen Beleg. Exam-Nachbetrachtung bleibt Gesamtergebnis.
3. Head/Lead: erlaubte Organisationstexte speichern und neu laden; fremde Bereiche und reine Editor-/Member-Zugriffe bleiben gesperrt. Admin prüft die drei Bildfelder. Strukturverwaltung mit den tatsächlichen Panel-Rollen öffnen.
4. Admin: Aktivität/Filter und `/manage/training/report`; Nicht-Admin: beide Wege gesperrt. Bei vereinbarter Terminprobe tatsächliche Fälligkeit abwarten und Ergebnis protokollieren.

Testschreibvorgänge, erhaltene Testdaten und Wiederherstellungen im Deployment-Bericht festhalten. Gesundheits-/Fehlerkontrollen nach 15 und 60 Minuten gemäß bestehendem Verfahren ausführen; dieser Brief richtet dafür keine Automation ein.

## Rollback und Roll-forward

Das [geprobte Exam-Rollback-Runbook](../infra/rollback/exam-mode/README.md) ist die ausführbare Quelle. Vor einem Rollback alle CMS-/Schedulerwriter und Web stoppen, die tatsächlich vorhandenen Exam-Varianten sichern und zu `quizGate` downgraden, den Modestand exportieren und **erst danach** beide bestätigten vorherigen Images starten. Eine vorhandene Snapshot-Struktur nicht überschreiben oder ungeprüft löschen. Kein voller Datenbank-Restore allein für einen Moduswechsel.

Roll-forward ebenfalls bei gestoppten Writern: jede gespeicherte Dokument-/Draft-/Published-Identität gegen zwischenzeitliche Änderungen prüfen, bewusste Lernmodi respektieren und erst dann `restore.sql` ausführen. Republish kann numerische IDs ersetzt haben. Keine pauschale Umwandlung aller quizGate-Kurse. Alte Images dürfen nie gegen bereits wiederhergestellte Exam-Werte laufen. Snapshot erst nach erfolgreicher Prüfung und Archivierung gemäß Runbook entfernen.

Beim Rollback werden Antworten wieder lesbar wie vor Batch 17; alte Organisationsschreibregeln und die bekannte Tombstone-Grenze für Kurs-/Org-Bilder kehren zurück. Intakte Bilder und Belege werden dadurch nicht automatisch gelöscht. Roll-forward kann bereits gelesene Lösungen nicht zurückholen.

## Abnahmebelege und Release

- [Image-Rehearsal](batch-17-image-rehearsal.md): v0.16.2 → Batch 17 → v0.16.2 → Batch 17, inklusive echter Panel-/Scheduler-Veröffentlichung und gezielter Exam-Wiederherstellung.
- [Browserabnahme Phasen 1–5](batch-17-browser-acceptance.md): acht Rollen-Einstiege, 53 protokollierte Prüfschritte, unabhängiger Schlussreview ohne offene Befunde; Chromium/en-US, dokumentierte Panel-/Report- und Accessibility-Grenzen.
- [Abnahme-PR-CI](https://github.com/yurtbayemre/sinnlos/actions/runs/39167431712) auf `9721d1dd9608e227c6a59c4801382b75a3a0e29f` und oben verlinkte grüne Main-CI. Keine dieser Prüfungen behauptet einen bereits erfolgten Produktionslauf.

Erst nach erfolgreichem Produktionsdeployment, Nachkontrolle und Bericht folgen der annotierte Tag `v0.17.0` auf dem tatsächlich eingesetzten Commit und der GitHub-Release. Releasehinweise nennen Answerless-/Exam-Grenzen, geschützte Trainingswrites, entfernte Org-Routen, neuen Reportpfad, Panel-Fallback und Rollback-Offenlegung. `package.json` bleibt bis zur separaten v1.0.0-Entscheidung unverändert.
