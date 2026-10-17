# Batch 17 exam mode rollback (Postgres 16)

Preparation only: this runbook does not authorize a production operation. Follow
[the Batch 17 rehearsal](../../../docs/plan-batch-17.md#8-deploy-and-rollback-rehearsal)
and get the deployment go for the actual instance. Use the previously deployed
CMS/web image pair; there is no second compatibility build.

The pre-17 CMS stores `completion_mode` as varchar but cannot validate/publish
`exam`. Before it starts, `downgrade.sql` saves only the `exam` variants in
`batch17_rollback.exam_modes` and changes them to `quizGate`. The snapshot is in a
separate schema, outside Strapi's application schema sync, without foreign keys
that republishing/deletion could remove. It contains IDs, variant identity and an
update timestamp, **no quiz questions, answer keys or personal data**.

Both SQL files are atomic, lock the affected tables, time out instead of waiting
indefinitely, and advance the authoring revision once per changed course document.
They do not change lesson content, receipts, links, files or course timestamps.
The snapshot creation refuses to overwrite an existing snapshot. Restore is
repeatable: already-restored `exam` variants cause no extra revision advance.

## Before starting

- Confirm the instance, database/application schema and **both immutable image
  tags**: the current Batch 17 pair and the previously deployed pair (v0.16.2 in
  the local rehearsal). Keep the Batch 17 checkout and both images available.
  Check the recorded tags, not a movable `latest` tag or an assumed live version.
- Have the usual verified database/uploads/config backup and deployment preflight
  evidence. The mode snapshot is not a replacement for that backup.
- Reserve a maintenance window; prevent other deploys or restarts. Stop **every**
  CMS replica and scheduler/process that writes this database, including restart
  supervisors outside Compose. `stop cms` stops the in-process cron too. Stopping
  the web avoids serving stale pages during the transition.
- Commands below run in Bash from the Batch 17 checkout and use the existing
  Traefik Compose setup. Set `PROJECT` for the actual instance, `ROLLBACK_TAG` and
  `BATCH17_TAG` to the recorded tags, and `MODE_ARCHIVE` to a new absolute directory
  in the instance's protected backup storage. Use its actual Compose overrides.
  For a non-default `DATABASE_SCHEMA`, set the psql session's `search_path` to
  that schema in **every** SQL command; restore rejects a different source schema.

```bash
set -euo pipefail
umask 077
: "${PROJECT:?set the confirmed Compose project}"
: "${ROLLBACK_TAG:?set the previous image pair tag}"
: "${BATCH17_TAG:?set the Batch 17 image pair tag}"
: "${MODE_ARCHIVE:?set a new absolute backup directory}"
COMPOSE=(docker compose -p "$PROJECT" -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml)
mkdir -m 700 -- "$MODE_ARCHIVE"
for tag in "$ROLLBACK_TAG" "$BATCH17_TAG"; do
  docker image inspect "$PROJECT-web:$tag" "$PROJECT-cms:$tag" >/dev/null
done
"${COMPOSE[@]}" stop web cms
"${COMPOSE[@]}" ps -a
```

Confirm all writers are stopped before continuing. Do not use `down -v` or
restore an old full database just to change the mode.

## Downgrade before starting the old pair

```bash
"${COMPOSE[@]}" exec -T db sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < infra/rollback/exam-mode/downgrade.sql
"${COMPOSE[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --schema=batch17_rollback --no-owner --no-privileges' \
  > "$MODE_ARCHIVE/exam-modes-before-rollback.sql"
test -s "$MODE_ARCHIVE/exam-modes-before-rollback.sql"
docker tag "$PROJECT-web:$ROLLBACK_TAG" "$PROJECT-web:latest"
docker tag "$PROJECT-cms:$ROLLBACK_TAG" "$PROJECT-cms:latest"
"${COMPOSE[@]}" up -d --no-build web cms
```

Require a successful SQL exit, `exam_variants_left = 0`, and a successful archive
before retag/start. If SQL fails, keep the CMS stopped and investigate; its whole
transaction rolls back. If snapshot creation reports an existing schema, inspect
that snapshot and the current modes: **do not delete it and blindly rerun**. The
snapshot and downgrade committed together; an interrupted terminal or failed
archive may have happened after success. Archive that existing snapshot and
confirm zero remaining `exam` rows before continuing the same rollback.

Check old CMS/web health and smoke tests. In the rehearsal, publish a downgraded
course through the **panel and scheduler**, not just a health probe. Include
published, draft-only and mixed-mode twins. Confirm lessons, completion receipts,
org text and intact linked images remain. Record any mode/publish/delete changes
made during the rollback window for the per-variant review below.

Accepted pre-17 behavior returns: learner APIs disclose correct answers again;
old organisation create/delete routes and grants return; course/org image claims
again have the non-document tombstone-attachment limit. Returning to Batch 17
cannot undo disclosed answers. Downgrade SQL does not delete intact linked images.

## Roll forward and reconcile saved variants

Stop every writer again before review. Keep them stopped until the Batch 17 pair
starts: the old CMS must never run against restored `exam` values.

```bash
"${COMPOSE[@]}" stop web cms
"${COMPOSE[@]}" exec -T db sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT b.document_id, b.published, b.original_row_id, c.id AS current_row_id,
       b.original_updated_at, c.updated_at AS current_updated_at,
       c.completion_mode AS current_mode, b.restore_exam
  FROM batch17_rollback.exam_modes b
  LEFT JOIN courses c ON c.document_id = b.document_id
    AND (c.published_at IS NOT NULL) = b.published
 ORDER BY b.document_id, b.published;
SQL
```

Review **every** saved variant against rollback-window changes. `published=false`
means draft, `true` means published. Row IDs and timestamps are diagnostics;
republish/discard may replace rows. A current `quizGate` value alone does not tell
whether someone intentionally chose learning mode. No automatic conflict check
can make that decision. For each reviewed identity, use the same psql invocation
to record `restore_exam=true` (restore exam) or `false` (keep the current state),
for example, replacing the ID with the actual reviewed document ID:

```sql
UPDATE batch17_rollback.exam_modes SET restore_exam = true
 WHERE document_id = 'REVIEWED_DOCUMENT_ID' AND published = false;
```

Set `false` for intentional learning modes or intentionally deleted/unpublished
variants. Resolve unexpected missing/duplicate rows or changed modes first; do
not invent rows, overwrite `confirm`, or convert all `quizGate` courses to exam.
A newly published variant that was not in the snapshot is not restored. Log the
decisions in the deployment record. `restore.sql` refuses unreviewed NULL choices
and selected variants that are missing, ambiguous, localized or no longer
`quizGate`/`exam`; no changes commit on such an error.

```bash
"${COMPOSE[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --schema=batch17_rollback --no-owner --no-privileges' \
  > "$MODE_ARCHIVE/exam-modes-reviewed.sql"
test -s "$MODE_ARCHIVE/exam-modes-reviewed.sql"
"${COMPOSE[@]}" exec -T db sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < infra/rollback/exam-mode/restore.sql
docker tag "$PROJECT-web:$BATCH17_TAG" "$PROJECT-web:latest"
docker tag "$PROJECT-cms:$BATCH17_TAG" "$PROJECT-cms:latest"
"${COMPOSE[@]}" up -d --no-build web cms
```

Repeat the review query to verify the selected modes. Check health, learner
privacy (direct and nested HTTP queries), all three feedback modes, old receipts,
panel/scheduler publication, org write boundaries and image claims. Reopen stale
authoring forms; the SQL advanced their revisions. Finish the existing deployment
record procedure only once the smoke checks pass.

Keep both archives and the deployment record. After a verified successful
roll-forward, remove only this operational snapshot so a later rollback can take
a fresh one (same psql invocation):

```sql
BEGIN;
DROP TABLE batch17_rollback.exam_modes;
DROP SCHEMA batch17_rollback;
COMMIT;
```

No `CASCADE`: unexpected contents stop cleanup. Never clear the snapshot while a
rollback/restore is unresolved. Before a second downgrade, run the whole sequence
again with a fresh archive directory; the original list is not reusable.

## Prepared checks versus rehearsal

The PostgreSQL regression suite executes both SQL files on disposable schemas:
variant matching after row replacement, deliberate exclusions, unchanged content,
revision advances, retries and atomic refusals. The deploy hint only prints this
manual procedure; it performs no mode writes.

Those tests do not replace the image-level deploy/rollback/roll-forward rehearsal
or browser acceptance. Record that evidence separately before production deploy.
