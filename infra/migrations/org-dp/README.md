# org-dp: department/team draft & publish off (one-time, Postgres)

The cms release that switches `draftAndPublish` off for `department` and
`team` (decision 05) needs one data step on a database that was used while
both types still had draft & publish: every department and team document has
to be ONE row before the new image boots. Otherwise Strapi deletes the draft
rows on its own at boot (`DELETE ... WHERE published_at IS NULL`,
@strapi/core 5.55.1 `dist/migrations/draft-publish.js:48-65`, no
transaction), and their link rows cascade away: units that were never
published disappear, users lose their department, and draft content loses its
department/team targeting (a wider audience on its next publish).

**The operator runbook is in [docs/DEPLOYMENT.md, "One-time: org draft/publish off"](../../../docs/DEPLOYMENT.md#one-time-org-draftpublish-off).**
A fresh install needs nothing, as long as its first boot runs a release that
contains this change.

| File | What it does |
|---|---|
| `preflight.sql` | Read only (`BEGIN TRANSACTION READ ONLY ... ROLLBACK`). P0 twin census (fast path when `draft_rows` is 0 for both types), P1 units that will be promoted, P2 pending draft edits that will be discarded, P3 link rows by target state, P4 users in more than one department, P5 users linked to a draft row, P6 media on draft rows, P7 duplicate names/slugs, P8 unknown tables referencing departments/teams. P0 anomalies, P4, P7 and P8 must be 0. |
| `migrate.sql` | Must run as ONE transaction (`psql -v ON_ERROR_STOP=1 --single-transaction`; it refuses to run otherwise) with cms and web stopped (it refuses while other sessions are connected). `lock_timeout` 10s. Idempotent. Checks its own post-conditions and ends with `NOTICE:  org-dp: OK - departments=N, teams=M`; any `RAISE` rolls everything back. |

## Resolution rules (migrate.sql)

- Never-published documents are promoted: their draft row becomes the live
  row (`published_at = updated_at`). Delete unwanted ones in the admin
  afterwards.
- Scalars (`name`, `slug`, `description`, `color`) and what the org row owns
  as a single value (`department.head`, `department.headerImage`,
  `team.department`, `team.lead`, `team.avatar`): the published row wins. The
  draft value is adopted only where the published row has none. P2 lists the
  discarded edits for re-entry.
- `team.members`: union of both rows. Nobody loses access they have today;
  a member removed only in the draft stays a member.
- Every link into a department or team is re-pointed from the draft row to
  the published row of the same `document_id` (union).
- Then the draft rows are deleted. FK `ON DELETE CASCADE` removes their
  remaining link rows; their media rows are removed explicitly, because
  `files_related_mph` has no foreign key on `related_id`.

`document_id` never changes, so everything that references org units by
documentId (release actions, history versions) stays valid.

## Tables covered

Derived from the Strapi 5.55.1 models of this app (the join-table metadata
and the foreign keys of a booted schema), not from memory:

- into `departments`: `up_users_department_lnk` (user.department),
  `teams_department_lnk` (team.department), `departments_head_lnk`
  (department.head, owned), `announcements_department_lnk`,
  `documents_departments_lnk`, `events_departments_lnk`,
  `polls_departments_lnk`, `quick_links_departments_lnk`,
  `wiki_pages_department_lnk`, `wiki_spaces_department_lnk`;
- into `teams`: `teams_members_lnk` (team.members / user.teams),
  `teams_lead_lnk` (team.lead, owned), `teams_department_lnk` (owned),
  `announcements_team_lnk`, `wiki_pages_team_lnk`, `wiki_spaces_team_lnk`;
- media: `files_related_mph` rows with `related_type`
  `api::department.department` (`headerImage`) and `api::team.team`
  (`avatar`).

There are no components in this app. Both scripts abort (P8, M0) when the
database has any other foreign key into `departments` or `teams`: extend the
scripts first.

## Assumptions

- Postgres only. For local SQLite dev, delete `apps/cms/.tmp/data.db` and
  reseed with `SEED_DEMO_DATA=1` (the seed writes one live row per unit).
- Default `search_path` (`DATABASE_SCHEMA=public`). For another schema add
  `-v schema=<name>` to the psql call.
- department and team are not localized (every row has `locale` NULL);
  migrate.sql checks this.

## Why not a Strapi migration

Files in `apps/cms/database/migrations` run inside `db.schema.sync`
(@strapi/database `dist/schema/index.js:73-78`), which Strapi calls AFTER the
`beforeSync` hook that deletes the drafts (`Strapi.js:358-364`). They would
run too late. The permanent guard `apps/cms/src/utils/org-dp-guard.ts` runs
first in `register()`, before that hook, and refuses to boot while any
department or team row has `published_at IS NULL`. It also catches a
pre-migration dump restored onto the new image, and a roll-forward after an
image rollback (the old image re-clones a draft of every row). The fix is
always this `migrate.sql`.

## Verified

On Postgres 16 with Strapi 5.55.1 and this app's schemas: a messy draft &
publish state built through the admin's document manager (twins, a
never-published department and team, pending draft edits, draft-only
memberships, media on both rows, links from every covered table), then
preflight, migrate twice (the second run changes nothing), the flipped schema
booted (Strapi's hook deleted 0 rows), admin-shaped writes afterwards, an image
rollback with roll-forward, a fresh install, and the negative cases (outside a
transaction, other sessions connected, duplicate name or slug, a user in two
departments, two published rows for one document, an unknown referencing
table): each one RAISEs and leaves the database unchanged.
