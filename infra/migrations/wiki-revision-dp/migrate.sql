-- wiki-revision-dp MIGRATION (Postgres only; one-time, and once more after
-- every rollback to a release before batch 16).
--
-- Makes every wiki revision ONE published row, so the cms release with
-- draftAndPublish OFF for wiki-revision (batch 16) boots with nothing left
-- for Strapi's disable hook to delete (@strapi/core 5.57
-- dist/migrations/draft-publish.js `disable`: DELETE ... WHERE published_at
-- IS NULL at boot, no transaction; the boot guard
-- apps/cms/src/utils/revision-dp-guard.ts refuses to boot before that, and
-- infra/deploy.sh refuses the deploy before its backup).
--
-- Runbook: docs/DEPLOYMENT.md "One-time: wiki revisions draft/publish off",
-- notes in infra/migrations/wiki-revision-dp/README.md. Run the read-only
-- preflight.sql first. Run with cms and web STOPPED, right after a verified
-- backup, as ONE transaction (the script refuses anything else):
--   docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
--     exec -T db sh -c 'psql -X -v ON_ERROR_STOP=1 --single-transaction -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < infra/migrations/wiki-revision-dp/migrate.sql
-- Success ends with:  NOTICE:  revision-dp: OK - promoted=N, twins_deleted=M, orphans=K
-- Any RAISE rolls the whole transaction back; fix what it names and rerun.
-- Idempotent: a second run finds no draft row, changes nothing and ends with
-- the same line (promoted=0, twins_deleted=0, the same orphans).
-- Non-default DATABASE_SCHEMA: add  -v schema=<name>  to the psql call.
--
-- What it does (preflight R1 to R4 show each case first):
--   - STOPS on an anomaly (two published or two draft rows of one revision
--     document, a row without document_id, a locale), on a revision document
--     anchored to more than one page document (a conflict), and on a
--     DIVERGENT twin: a draft row whose published row differs in body,
--     summary, page link (compared by page DOCUMENT, never by row id: a twin
--     links the page's draft row, its published row both page rows) or
--     editor, or that carries a value in a batch-16 column. Each is listed;
--     the README has the two manual resolutions;
--   - DELETES the identical twins (the draft row and its link rows): the
--     ones a rollback's boot cloned from every revision (one per revision,
--     through discardDraft, which knows none of the batch-16 columns);
--   - PROMOTES the draft-only rows: published_at = coalesce(updated_at,
--     created_at, now());
--   - asserts that no row is left without published_at and no document_id
--     occurs twice.
-- It runs on both schemas: before the first batch-16 deploy (no batch-16
-- columns yet) and after a rollback (the columns are there); to_jsonb()
-- reads them when they exist.

\set ON_ERROR_STOP on
\if :{?schema}
SET search_path TO :"schema";
\endif

-- ---------- guard: exactly ONE transaction (psql --single-transaction) ----------
-- Without it every statement would commit on its own. An ON COMMIT DROP
-- temp table only survives to the next statement inside one transaction.
CREATE TEMP TABLE revision_dp_single_txn ON COMMIT DROP AS SELECT 1 AS ok;
DO $$ BEGIN
  IF to_regclass('pg_temp.revision_dp_single_txn') IS NULL THEN
    RAISE EXCEPTION 'revision-dp: not inside one transaction - run: psql -v ON_ERROR_STOP=1 --single-transaction ... < migrate.sql';
  END IF;
END $$;

SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  n int;
  listing text;
  promoted int := 0;
  twins_deleted int := 0;
  orphans int := 0;
BEGIN
  -- The cms must be stopped: it would write before-images (an old release) or
  -- serve the twins' ids while they are deleted.
  SELECT count(*) INTO n FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend';
  IF n > 0 THEN
    RAISE EXCEPTION 'revision-dp: % other session(s) are connected to this database - stop cms and web first', n;
  END IF;

  IF to_regclass('wiki_revisions') IS NULL THEN
    RAISE NOTICE 'revision-dp: OK - promoted=0, twins_deleted=0, orphans=0 (no wiki_revisions table)';
    RETURN;
  END IF;

  LOCK TABLE wiki_revisions, wiki_revisions_page_lnk, wiki_revisions_editor_lnk IN EXCLUSIVE MODE;

  -- ---------- R4 anomalies (nothing has been changed yet) ----------
  SELECT string_agg(problem || ' ' || coalesce(document_id, '(none)'), '; ' ORDER BY problem, document_id)
    INTO listing
    FROM (
      SELECT 'more than one published row:' AS problem, document_id
        FROM wiki_revisions WHERE published_at IS NOT NULL GROUP BY document_id HAVING count(*) > 1
      UNION ALL
      SELECT 'more than one draft row:', document_id
        FROM wiki_revisions WHERE published_at IS NULL GROUP BY document_id HAVING count(*) > 1
      UNION ALL
      SELECT 'a row without document_id, id ' || id, NULL FROM wiki_revisions WHERE document_id IS NULL
      UNION ALL
      SELECT 'a locale:', document_id FROM wiki_revisions WHERE locale IS NOT NULL
    ) anomalies;
  IF listing IS NOT NULL THEN
    RAISE EXCEPTION 'revision-dp: anomalies (preflight R4) - investigate first: %', listing;
  END IF;

  -- ---------- R2 conflicting anchors ----------
  SELECT string_agg(document_id || ' -> ' || pages, '; ' ORDER BY document_id) INTO listing
    FROM (
      SELECT r.document_id,
             CASE WHEN count(DISTINCT to_jsonb(r) ->> 'page_document_id') > 0
                  THEN string_agg(DISTINCT to_jsonb(r) ->> 'page_document_id', ',')
                  ELSE string_agg(DISTINCT p.document_id, ',') END AS pages,
             count(DISTINCT to_jsonb(r) ->> 'page_document_id') AS n_set,
             count(DISTINCT p.document_id) AS n_linked
        FROM wiki_revisions r
        LEFT JOIN wiki_revisions_page_lnk l ON l.wiki_revision_id = r.id
        LEFT JOIN wiki_pages p ON p.id = l.wiki_page_id
       GROUP BY r.document_id
    ) anchors
   WHERE n_set > 1 OR (n_set = 0 AND n_linked > 1);
  IF listing IS NOT NULL THEN
    RAISE EXCEPTION 'revision-dp: revision document(s) anchored to more than one page (preflight R2) - resolve per infra/migrations/wiki-revision-dp/README.md, then rerun: %', listing;
  END IF;

  -- ---------- R1 the draft rows by class ----------
  CREATE TEMP TABLE revision_dp_drafts ON COMMIT DROP AS
    WITH page_docs AS (
      SELECT l.wiki_revision_id AS rev, string_agg(DISTINCT p.document_id, ',' ORDER BY p.document_id) AS docs
        FROM wiki_revisions_page_lnk l JOIN wiki_pages p ON p.id = l.wiki_page_id
       GROUP BY l.wiki_revision_id
    ), editors AS (
      SELECT wiki_revision_id AS rev, string_agg(DISTINCT user_id::text, ',' ORDER BY user_id::text) AS users
        FROM wiki_revisions_editor_lnk GROUP BY wiki_revision_id
    )
    SELECT d.id, d.document_id, pub.id AS pub_id,
           concat_ws(', ',
             CASE WHEN d.body IS DISTINCT FROM pub.body THEN 'body' END,
             CASE WHEN d.summary IS DISTINCT FROM pub.summary THEN 'summary' END,
             CASE WHEN dp.docs IS DISTINCT FROM pp.docs THEN 'page' END,
             CASE WHEN de.users IS DISTINCT FROM pe.users THEN 'editor' END,
             CASE WHEN jsonb_strip_nulls(to_jsonb(d) - ARRAY['id', 'document_id', 'body', 'summary',
                         'created_at', 'updated_at', 'published_at', 'created_by_id', 'updated_by_id',
                         'locale']) <> '{}'::jsonb
                  THEN 'batch-16 columns' END) AS differs
      FROM wiki_revisions d
      LEFT JOIN wiki_revisions pub ON pub.document_id = d.document_id AND pub.published_at IS NOT NULL
      LEFT JOIN page_docs dp ON dp.rev = d.id
      LEFT JOIN page_docs pp ON pp.rev = pub.id
      LEFT JOIN editors de ON de.rev = d.id
      LEFT JOIN editors pe ON pe.rev = pub.id
     WHERE d.published_at IS NULL;

  SELECT string_agg('id ' || id || ' (document ' || document_id || ', differs in ' || differs || ')', '; ' ORDER BY id)
    INTO listing
    FROM revision_dp_drafts WHERE pub_id IS NOT NULL AND differs <> '';
  IF listing IS NOT NULL THEN
    RAISE EXCEPTION 'revision-dp: divergent twin(s) (preflight R1) - resolve each per infra/migrations/wiki-revision-dp/README.md, then rerun: %', listing;
  END IF;

  -- ---------- delete the identical twins, promote the draft-only rows ----------
  DELETE FROM wiki_revisions_page_lnk
   WHERE wiki_revision_id IN (SELECT id FROM revision_dp_drafts WHERE pub_id IS NOT NULL);
  DELETE FROM wiki_revisions_editor_lnk
   WHERE wiki_revision_id IN (SELECT id FROM revision_dp_drafts WHERE pub_id IS NOT NULL);
  DELETE FROM wiki_revisions WHERE id IN (SELECT id FROM revision_dp_drafts WHERE pub_id IS NOT NULL);
  GET DIAGNOSTICS twins_deleted = ROW_COUNT;

  UPDATE wiki_revisions SET published_at = coalesce(updated_at, created_at, now())
   WHERE id IN (SELECT id FROM revision_dp_drafts WHERE pub_id IS NULL);
  GET DIAGNOSTICS promoted = ROW_COUNT;

  -- ---------- post-conditions ----------
  IF EXISTS (SELECT 1 FROM wiki_revisions WHERE published_at IS NULL) THEN
    RAISE EXCEPTION 'revision-dp: draft rows are left after the migration';
  END IF;
  IF EXISTS (SELECT 1 FROM wiki_revisions GROUP BY document_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'revision-dp: a document_id occurs more than once after the migration';
  END IF;

  -- Orphans: no page_document_id and no page link (their page was deleted);
  -- they keep a NULL anchor, and no history action reaches them.
  SELECT count(*) INTO orphans FROM wiki_revisions r
   WHERE to_jsonb(r) ->> 'page_document_id' IS NULL
     AND NOT EXISTS (SELECT 1 FROM wiki_revisions_page_lnk l WHERE l.wiki_revision_id = r.id);

  RAISE NOTICE 'revision-dp: OK - promoted=%, twins_deleted=%, orphans=%', promoted, twins_deleted, orphans;
END $$;
