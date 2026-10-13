-- Wiki structure report (READ-ONLY).
--
-- From batch 16 on, every writer (the content API, the admin panel, the
-- scheduler) is refused a wiki-page write that ADDS a parent link closing a
-- loop (`parentCycle`; apps/cms/src/utils/wiki-checks.ts). A loop that is
-- already in the database stays until someone repairs it: it blocks no
-- unrelated save, and its pages wait in the scheduler for at most an hour
-- before failing with notPublishable. Before batch 16 the admin panel let a
-- page's parent point at its own child, and editors could place a parent in
-- another space. Run this before the batch-16 deploy and after it:
--
--   1. loop: one row per page that sits on a loop of the DOCUMENT-level
--      parent graph (the links of every row, draft and published, mapped to
--      the pages' document ids: the graph the wiki checks read), with the
--      path. Repair: in the admin panel, clear the parent of one page of the
--      loop and publish it (both rows of that page lose the link);
--   2. parent_in_other_space: a row whose parent row sits in another space
--      (or one of the two in none). The relation guard trusts parent and
--      children to stay inside one space; move the page or clear the parent
--      in the admin panel;
--   3. page_without_space: a page row linked to no space (readers never see
--      it); give it a space in the admin panel or delete it;
--   4. the counts of the three.
--
--   docker exec -i infra-db-1 sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < infra/diagnostics/wiki-parent-cycles.sql
--
-- The output names pages (document id, title) and spaces (document id), no
-- user data; it is internal operational data, do not post it publicly.
--
-- Pure SQL, no psql meta-commands: the integration suite wiki-checks runs
-- this file against Postgres 16 as it is. Runs on every schema since
-- batch 5 (the wiki tables did not change).
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- 1. Pages on a loop of the document-level parent graph.
WITH RECURSIVE edges AS (
  SELECT DISTINCT c.document_id AS child, p.document_id AS parent
    FROM wiki_pages_parent_lnk l
    JOIN wiki_pages c ON c.id = l.wiki_page_id
    JOIN wiki_pages p ON p.id = l.inv_wiki_page_id
),
walk (start, node, path, depth) AS (
  SELECT child, parent, ARRAY[child, parent]::varchar[], 1
    FROM edges
  UNION ALL
  SELECT w.start, e.parent, w.path || e.parent::varchar, w.depth + 1
    FROM walk w
    JOIN edges e ON e.child = w.node
   WHERE w.node <> w.start
     AND NOT (e.parent = ANY (w.path[2:]))
     AND w.depth < 1000
)
SELECT DISTINCT ON (w.start)
       'loop' AS check,
       w.start AS document_id,
       (SELECT max(title) FROM wiki_pages WHERE document_id = w.start) AS title,
       array_to_string(w.path, ' -> ') AS path
  FROM walk w
 WHERE w.node = w.start
 ORDER BY w.start, w.depth;

-- 2. Rows whose parent row sits in another space (or one of them in none).
SELECT 'parent_in_other_space' AS check,
       c.document_id AS document_id,
       c.title AS title,
       CASE WHEN c.published_at IS NULL THEN 'draft' ELSE 'published' END AS status,
       cs.document_id AS space_document_id,
       p.document_id AS parent_document_id,
       ps.document_id AS parent_space_document_id
  FROM wiki_pages_parent_lnk l
  JOIN wiki_pages c ON c.id = l.wiki_page_id
  JOIN wiki_pages p ON p.id = l.inv_wiki_page_id
  LEFT JOIN wiki_pages_space_lnk csl ON csl.wiki_page_id = c.id
  LEFT JOIN wiki_spaces cs ON cs.id = csl.wiki_space_id
  LEFT JOIN wiki_pages_space_lnk psl ON psl.wiki_page_id = p.id
  LEFT JOIN wiki_spaces ps ON ps.id = psl.wiki_space_id
 WHERE cs.document_id IS DISTINCT FROM ps.document_id
 ORDER BY c.document_id, c.published_at NULLS FIRST;

-- 3. Page rows without a space.
SELECT 'page_without_space' AS check,
       w.document_id AS document_id,
       w.title AS title,
       CASE WHEN w.published_at IS NULL THEN 'draft' ELSE 'published' END AS status
  FROM wiki_pages w
 WHERE NOT EXISTS (SELECT 1 FROM wiki_pages_space_lnk s WHERE s.wiki_page_id = w.id)
 ORDER BY w.document_id, w.published_at NULLS FIRST;

-- 4. The counts (documents for loops and missing spaces, rows for the cross-space links).
WITH RECURSIVE edges AS (
  SELECT DISTINCT c.document_id AS child, p.document_id AS parent
    FROM wiki_pages_parent_lnk l
    JOIN wiki_pages c ON c.id = l.wiki_page_id
    JOIN wiki_pages p ON p.id = l.inv_wiki_page_id
),
walk (start, node, path, depth) AS (
  SELECT child, parent, ARRAY[child, parent]::varchar[], 1
    FROM edges
  UNION ALL
  SELECT w.start, e.parent, w.path || e.parent::varchar, w.depth + 1
    FROM walk w
    JOIN edges e ON e.child = w.node
   WHERE w.node <> w.start
     AND NOT (e.parent = ANY (w.path[2:]))
     AND w.depth < 1000
)
SELECT 'summary' AS check,
       (SELECT count(DISTINCT start) FROM walk WHERE node = start) AS pages_on_loops,
       (SELECT count(*)
          FROM wiki_pages_parent_lnk l
          JOIN wiki_pages c ON c.id = l.wiki_page_id
          JOIN wiki_pages p ON p.id = l.inv_wiki_page_id
          LEFT JOIN wiki_pages_space_lnk csl ON csl.wiki_page_id = c.id
          LEFT JOIN wiki_spaces cs ON cs.id = csl.wiki_space_id
          LEFT JOIN wiki_pages_space_lnk psl ON psl.wiki_page_id = p.id
          LEFT JOIN wiki_spaces ps ON ps.id = psl.wiki_space_id
         WHERE cs.document_id IS DISTINCT FROM ps.document_id) AS rows_with_parent_in_other_space,
       (SELECT count(DISTINCT w.document_id)
          FROM wiki_pages w
         WHERE NOT EXISTS (SELECT 1 FROM wiki_pages_space_lnk s WHERE s.wiki_page_id = w.id))
         AS pages_without_space;

ROLLBACK;
