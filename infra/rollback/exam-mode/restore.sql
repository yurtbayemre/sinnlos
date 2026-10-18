-- Roll forward to Batch 17, with every CMS/scheduler writer still stopped.
-- WRITES. Review EVERY saved variant and set restore_exam true/false first.
-- Runbook: infra/rollback/exam-mode/README.md. Run with psql -X -v ON_ERROR_STOP=1.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE batch17_rollback.exam_modes, content_versions, courses IN SHARE ROW EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM batch17_rollback.exam_modes WHERE source_schema <> current_schema()) THEN
    RAISE EXCEPTION 'exam-mode: snapshot belongs to another application schema';
  END IF;
  IF EXISTS (SELECT 1 FROM batch17_rollback.exam_modes WHERE restore_exam IS NULL) THEN
    RAISE EXCEPTION 'exam-mode: review every saved variant and set restore_exam true or false';
  END IF;
  IF EXISTS (
    SELECT 1 FROM batch17_rollback.exam_modes b
    LEFT JOIN courses c ON c.document_id = b.document_id
      AND (c.published_at IS NOT NULL) = b.published
    WHERE b.restore_exam
    GROUP BY b.document_id, b.published
    HAVING count(c.id) <> 1
      OR bool_or(c.completion_mode IS NULL OR c.completion_mode NOT IN ('quizGate', 'exam'))
      OR bool_or(to_jsonb(c)->>'locale' IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'exam-mode: selected variant missing, ambiguous, localized or no longer quizGate/exam; reconcile first';
  END IF;
END $$;

WITH changed AS (
  UPDATE courses c SET completion_mode = 'exam'
    FROM batch17_rollback.exam_modes b
    WHERE b.restore_exam AND c.document_id = b.document_id
      AND (c.published_at IS NOT NULL) = b.published
      AND c.completion_mode = 'quizGate'
    RETURNING c.document_id
)
INSERT INTO content_versions AS v
  (document_id, target_uid, target_document_id, revision, created_at, updated_at, published_at)
SELECT substr(replace(gen_random_uuid()::text, '-', ''), 1, 24),
       'api::course.course', document_id, 1, now(), now(), now()
  FROM (SELECT DISTINCT document_id FROM changed) documents
ON CONFLICT (target_uid, target_document_id) DO UPDATE
  SET revision = v.revision + 1, updated_at = excluded.updated_at;

SELECT count(*) FILTER (WHERE restore_exam) AS exam_variants_selected,
       count(*) FILTER (WHERE NOT restore_exam) AS variants_kept_as_reviewed
  FROM batch17_rollback.exam_modes;
COMMIT;
