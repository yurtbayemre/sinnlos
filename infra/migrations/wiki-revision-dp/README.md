# wiki-revision-dp: wiki revisions draft & publish off (Postgres)

Batch 16 (decision 06 §J4 and Migration §2, DA03) turns `draftAndPublish`
off for `wiki-revision`: a revision is one published row, anchored to its page
by `pageDocumentId`. A database that still holds revision rows with
`published_at IS NULL` must be migrated before a batch-16 cms boots on it.
Otherwise Strapi deletes those rows on its own at boot
(`DELETE ... WHERE published_at IS NULL`, @strapi/core 5.57
`dist/migrations/draft-publish.js` `disable`, no transaction) and their link
rows cascade away.

**The operator runbook is in [docs/DEPLOYMENT.md, "One-time: wiki revisions draft/publish off"](../../../docs/archive/deployment-history.md#one-time-wiki-revisions-draftpublish-off-batch-16).**

**Where draft rows come from:**

- A **rollback** to batch 15.1 (or older). Its first boot turns draft & publish
  back on and clones one draft twin of every revision through `discardDraft`.
  That gives one identical twin per revision. A **roll-forward** therefore
  always needs `migrate.sql`, and `infra/deploy.sh` refuses it until then.
- A revision draft created in the admin panel before batch 15.1 hid the type,
  or raw SQL. Production had none at the DA03 audit, so the first upgrade is
  expected to take the **fast path**: the preflight's R0 is 0, and you deploy
  normally.

A fresh install needs nothing.

| File            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight.sql` | Read only (`BEGIN TRANSACTION READ ONLY ... ROLLBACK`). R0 draft rows (fast path at 0), R1 their classes and the divergent and draft-only rows, R2 the page anchors per revision document and the conflicts, R3 revisions per page (keep it: the verification compares with it), R4 anomalies. R1 divergent, R2 conflicts and R4 must be 0.                                                                                                                            |
| `migrate.sql`   | Must run as ONE transaction (`psql -v ON_ERROR_STOP=1 --single-transaction`; it refuses to run otherwise), with cms and web stopped (it refuses while other sessions are connected). `lock_timeout` 10s. It stops on what it cannot decide, deletes the identical twins, promotes the draft-only rows and checks its post-conditions. It ends with `NOTICE:  revision-dp: OK - promoted=N, twins_deleted=M, orphans=K`. Any `RAISE` rolls everything back. Idempotent. |

## The checks

- **R0** counts the draft rows, published rows and revision documents.
  `draft_rows = 0` is the fast path.
- **R1** classifies each draft row:
  - **draft-only**: no published row with its `document_id`. `migrate.sql`
    **promotes** it (`published_at = coalesce(updated_at, created_at, now())`).
    The boot backfill then marks it `before` (a legacy row) and anchors it.
  - **identical twin**: its published row has the same `body` and `summary`
    and the same editor (users by id), the draft's batch-16 columns are NULL,
    and its page link names a page the published row belongs to. A
    rollback's boot makes exactly this, and `migrate.sql` **deletes** it with
    its link rows.
    - **Pages are compared by document, never by row id.** A twin links the
      page's draft row, while its published row links the draft row and,
      after a publish, the published row too (spike 5 S5.7).
    - **The published row belongs to its `page_document_id`** (every revision
      of batch 16) **and to the pages its own links reach.** Both count,
      because Strapi changes the links in two cases while the anchor stays:
      - on 15.1, a discard and an unpublish of the page can leave the
        published revision without page links while its twin keeps one;
      - a panel "Duplicate" of a page moves the revisions' page links to the
        copy.
    - **A twin without any page link** (its page row was deleted) differs in
      nothing that is kept.
  - **divergent twin**: anything else with a published row. `migrate.sql`
    **stops** and lists each one with what differs. Since batch 15.1 hides the
    type in the admin panel, only raw SQL can make one.
- **R2** gives each revision document its page anchor:
  - a document anchored by `page_document_id` (batch 16) keeps that anchor;
  - any other document is anchored by the page documents its link rows reach;
  - one anchor is fine; none is an **orphan** (its page was deleted, so the
    anchor stays NULL and no history action reaches it);
  - several is a **conflict**, and `migrate.sql` **stops**.
- **R3** counts revision documents per page. After the migration and the first
  boot, the counts per page must equal R3 minus the deleted twins. Each page
  also gains a `baseline` revision when its current content is in no snapshot,
  and after a rollback window each page edited on 15.1 gains one.
- **R4** lists anomalies:
  - two published or two draft rows of one revision document;
  - a row without `document_id`;
  - a `locale` (wiki-revision is not localized).

  `migrate.sql` stops on any of them; investigate before you continue.

## Resolving a divergent twin by hand

Pick one of two choices per listed draft row. Take a backup first, stop cms and
web, and run in one transaction. Then rerun `preflight.sql` and `migrate.sql`.

```sql
-- Choice 1: keep the published row, drop the draft (its edit is lost).
BEGIN;
DELETE FROM wiki_revisions_page_lnk   WHERE wiki_revision_id = <draft id>;
DELETE FROM wiki_revisions_editor_lnk WHERE wiki_revision_id = <draft id>;
DELETE FROM wiki_revisions            WHERE id = <draft id> AND published_at IS NULL;
COMMIT;

-- Choice 2: keep the draft's body as a revision of its own (a new document),
-- then drop the draft. The new row is published and links the same page rows.
BEGIN;
WITH copy AS (
  INSERT INTO wiki_revisions (document_id, body, summary, created_at, updated_at, published_at)
  SELECT 'r' || substr(md5(random()::text || clock_timestamp()::text), 1, 23),
         body, summary, created_at, updated_at, coalesce(updated_at, created_at, now())
    FROM wiki_revisions WHERE id = <draft id> AND published_at IS NULL
  RETURNING id
)
INSERT INTO wiki_revisions_page_lnk (wiki_revision_id, wiki_page_id, wiki_revision_ord)
SELECT copy.id, l.wiki_page_id, l.wiki_revision_ord
  FROM copy, wiki_revisions_page_lnk l WHERE l.wiki_revision_id = <draft id>;
DELETE FROM wiki_revisions_page_lnk   WHERE wiki_revision_id = <draft id>;
DELETE FROM wiki_revisions_editor_lnk WHERE wiki_revision_id = <draft id>;
DELETE FROM wiki_revisions            WHERE id = <draft id> AND published_at IS NULL;
COMMIT;
```

## Resolving a conflicting anchor

A conflict is a revision document whose link rows reach two page documents. It
is a damaged link table: the app links a revision to one page. Find the page it
belongs to (R2 lists the page document ids; R3 has their titles). Then delete
the other link rows:

```sql
BEGIN;
DELETE FROM wiki_revisions_page_lnk
 WHERE wiki_revision_id IN (SELECT id FROM wiki_revisions WHERE document_id = '<revision document_id>')
   AND wiki_page_id IN (SELECT id FROM wiki_pages WHERE document_id = '<the wrong page document_id>');
COMMIT;
```

## Assumptions

- Postgres only. For local SQLite dev, delete `apps/cms/.tmp/data.db` and
  reseed. The guard names this too.
- The default `search_path` (`DATABASE_SCHEMA=public`). For another schema, add
  `-v schema=<name>` to the psql call.
- Both schemas work:
  - **Before the first batch-16 deploy**, the batch-16 columns do not exist.
  - **After a rollback**, they exist and are NULL on every row 15.1 wrote.
    `forceMigration` is false (`apps/cms/config/database.ts`), so the rollback's
    schema sync keeps them.

  Both scripts read those columns through `to_jsonb()`, so a missing column
  reads as NULL.

## Why not a Strapi migration

Files in `apps/cms/database/migrations` run inside `db.schema.sync`. Strapi
calls that after the `beforeSync` hook that deletes the drafts, so they would
run too late. The permanent guard `apps/cms/src/utils/revision-dp-guard.ts`
runs in `register()`, before that hook (right after the org guard of decision
05), and refuses to boot while any revision row has `published_at IS NULL`.
`infra/deploy.sh` runs the same count before its backup and refuses the deploy.
The fix is always this `migrate.sql`.

## Verified

`apps/cms/src/integration/authoring-wiki-revision-dp.integration.test.ts`
runs both files with psql against Postgres 16, in a database of their own:

1. **The first upgrade from a batch-15 database** (no batch-16 columns, Strapi's
   bookkeeping of before batch 16):
   - the migration promotes a draft-only row;
   - the boot's disable hook deletes nothing;
   - the backfill anchors and marks every row and writes the cutover baselines.
2. **The fast path.**
3. **A rollback to 15.1 and forward**, with one identical twin per revision and
   two edits on 15.1:
   - the deploy.sh probe query counts the twins;
   - the boot refuses;
   - the preflight classifies the twins;
   - `migrate.sql` refuses outside one transaction and with another session
     connected;
   - it deletes the twins, then changes nothing on a second run;
   - the boot keeps every earlier revision id for id and records the 15.1
     content as a baseline;
   - the counts per page match.
4. **A divergent twin**: `migrate.sql` stops, lists it and changes nothing.
   Choice 1 above resolves it.
5. **An orphan** is promoted and counted. **A conflicting anchor** stops
   `migrate.sql`, and the fix above resolves it.

The full rollback cycle on the real images (batch 15.1 and batch 16) is part of
the combined staging rehearsal of batch 16.
