-- Batch 17 -> pre-17 CMS: save exam variants, then map only those to quizGate.
-- WRITES. Stop every CMS/scheduler writer first; run with psql -X -v ON_ERROR_STOP=1.
-- Runbook: infra/rollback/exam-mode/README.md. An existing snapshot is never replaced.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE content_versions, courses IN SHARE ROW EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM courses WHERE completion_mode = 'exam'
      AND (document_id IS NULL OR document_id = '' OR to_jsonb(courses)->>'locale' IS NOT NULL)
  ) OR EXISTS (
    SELECT 1 FROM courses GROUP BY document_id, (published_at IS NOT NULL)
      HAVING count(*) > 1 AND bool_or(completion_mode = 'exam')
  ) THEN
    RAISE EXCEPTION 'exam-mode: invalid, localized or duplicate course identity; reconcile before downgrade';
  END IF;
END $$;

-- Outside the application schema: Strapi schema sync must not own this snapshot.
CREATE SCHEMA batch17_rollback;
CREATE TABLE batch17_rollback.exam_modes (
  source_schema name NOT NULL,
  document_id text NOT NULL,
  published boolean NOT NULL,
  original_row_id integer NOT NULL,
  original_updated_at timestamptz,
  restore_exam boolean,
  PRIMARY KEY (source_schema, document_id, published)
);
INSERT INTO batch17_rollback.exam_modes
  (source_schema, document_id, published, original_row_id, original_updated_at)
SELECT current_schema(), document_id, published_at IS NOT NULL, id, updated_at
  FROM courses WHERE completion_mode = 'exam';

WITH changed AS (
  UPDATE courses SET completion_mode = 'quizGate'
    WHERE completion_mode = 'exam'
    RETURNING document_id
)
-- Raw writes must invalidate open authoring forms, once per document, not per twin.
INSERT INTO content_versions AS v
  (document_id, target_uid, target_document_id, revision, created_at, updated_at, published_at)
SELECT substr(replace(gen_random_uuid()::text, '-', ''), 1, 24),
       'api::course.course', document_id, 1, now(), now(), now()
  FROM (SELECT DISTINCT document_id FROM changed) documents
ON CONFLICT (target_uid, target_document_id) DO UPDATE
  SET revision = v.revision + 1, updated_at = excluded.updated_at;

SELECT count(*) AS exam_variants_saved FROM batch17_rollback.exam_modes;
SELECT count(*) AS exam_variants_left FROM courses WHERE completion_mode = 'exam';
COMMIT;
