-- Schedule export (READ-ONLY), valid from batch 15 on.
--
-- Every pending schedule: the draft rows of the seven scheduled types with
-- a publish_at and/or an unpublish_at (documents and quick links only),
-- with the schedule_error and whether the document has a published row.
-- The draft row is authoritative (decision 06 §D rule 2).
--
-- WHEN. Before a rollback to a batch-14 image, save the output off the host
-- (DEPLOYMENT.md "Deploying batch 15", rollback step 2). Batch 14 runs no
-- schedule:
--   - a pending publish waits (safe);
--   - a published document or quick link whose unpublish_at falls due stays
--     published: an editor withdraws it by hand in the admin panel at its
--     time (every row with published = true and an unpublish_at before the
--     planned roll-forward);
--   - an old-image publish or "Discard changes" rewrites the draft without
--     these columns, so a draft can lose its publish_at or unpublish_at.
-- On the roll-forward compare this export with the drafts: re-enter a lost
-- time that is still ahead through the admin panel or /manage (a Document
-- Service write, so the revision advances; never raw SQL), withdraw what
-- fell due and was not withdrawn, publish by hand what fell due (or leave it
-- to the scheduler if the draft kept publish_at; the expired-window rule
-- applies).
-- The columns do not exist before batch 15: on a batch-14 schema this file
-- fails with "column ... does not exist" and changes nothing.
--
--   docker exec -i infra-db-1 sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < infra/diagnostics/schedule-export.sql
--
-- Pure SQL, no psql meta-commands: the integration suite
-- targeting-fail-closed runs this file against Postgres 16 as it is.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

WITH schedules AS (
  SELECT 'announcements' AS table_name, d.document_id, d.title AS label, d.publish_at,
         NULL::timestamptz AS unpublish_at, d.schedule_error,
         EXISTS (SELECT 1 FROM announcements p
                  WHERE p.document_id = d.document_id AND p.published_at IS NOT NULL) AS published
    FROM announcements d
   WHERE d.published_at IS NULL AND d.publish_at IS NOT NULL
  UNION ALL
  SELECT 'events', d.document_id, d.title, d.publish_at, NULL::timestamptz, d.schedule_error,
         EXISTS (SELECT 1 FROM events p
                  WHERE p.document_id = d.document_id AND p.published_at IS NOT NULL)
    FROM events d
   WHERE d.published_at IS NULL AND d.publish_at IS NOT NULL
  UNION ALL
  SELECT 'documents', d.document_id, d.title, d.publish_at, d.unpublish_at, d.schedule_error,
         EXISTS (SELECT 1 FROM documents p
                  WHERE p.document_id = d.document_id AND p.published_at IS NOT NULL)
    FROM documents d
   WHERE d.published_at IS NULL AND (d.publish_at IS NOT NULL OR d.unpublish_at IS NOT NULL)
  UNION ALL
  SELECT 'quick_links', d.document_id, d.label, d.publish_at, d.unpublish_at, d.schedule_error,
         EXISTS (SELECT 1 FROM quick_links p
                  WHERE p.document_id = d.document_id AND p.published_at IS NOT NULL)
    FROM quick_links d
   WHERE d.published_at IS NULL AND (d.publish_at IS NOT NULL OR d.unpublish_at IS NOT NULL)
  UNION ALL
  SELECT 'wiki_pages', d.document_id, d.title, d.publish_at, NULL::timestamptz, d.schedule_error,
         EXISTS (SELECT 1 FROM wiki_pages p
                  WHERE p.document_id = d.document_id AND p.published_at IS NOT NULL)
    FROM wiki_pages d
   WHERE d.published_at IS NULL AND d.publish_at IS NOT NULL
  UNION ALL
  SELECT 'courses', d.document_id, d.title, d.publish_at, NULL::timestamptz, d.schedule_error,
         EXISTS (SELECT 1 FROM courses p
                  WHERE p.document_id = d.document_id AND p.published_at IS NOT NULL)
    FROM courses d
   WHERE d.published_at IS NULL AND d.publish_at IS NOT NULL
  UNION ALL
  SELECT 'lessons', d.document_id, d.title, d.publish_at, NULL::timestamptz, d.schedule_error,
         EXISTS (SELECT 1 FROM lessons p
                  WHERE p.document_id = d.document_id AND p.published_at IS NOT NULL)
    FROM lessons d
   WHERE d.published_at IS NULL AND d.publish_at IS NOT NULL
)
SELECT 'schedule' AS check, table_name, document_id, label, publish_at, unpublish_at,
       schedule_error, published,
       -- A withdrawal that batch 14 would miss: published, with a deadline.
       (published AND unpublish_at IS NOT NULL) AS withdraw_by_hand
  FROM schedules
 ORDER BY least(publish_at, unpublish_at) NULLS LAST, table_name, document_id;

ROLLBACK;
