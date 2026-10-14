# Production diagnostics

Read-only checks to run on the production host. None of them change data.
The SQL runs inside `BEGIN TRANSACTION READ ONLY` … `ROLLBACK`, and no secret
values are printed. The one exception, a one-time cleanup that changes data
only when armed, is described at the end.

| File                                  | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `census.sh` + `census.sql`            | A census of the data behind features whose production usage is unknown: comment threading, announcement expiry, poll/event department targeting, wiki page scoping and revisions, lesson quizzes, users by sign-in provider, digest opt-ins, notification volume and title lengths, and (section 9, DA04) a duplicate scan of the interaction records no unique index guards: poll votes per (poll, voter), acknowledgements, RSVPs and lesson progress per (target, user), reactions per (target, emoji, author). It also reports whether SMTP is configured (set/empty only), plus the last `[digest]` and `[notifications] failed` log lines of the running cms container. |
| `prod-perm-diff.sql`                  | The live users-permissions grants compared with what the code's bootstrap sync converges to: grants that exist only in the database (for example, made in the admin panel), grants the code expects but the database lacks, duplicates, unknown roles and orphaned rows.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `announcement-audience-preflight.sql` | Batch 15, D-PT01: the announcements whose audience is "departments" but that link neither a department nor a team, per row (draft and published) with title and `published_at`, plus the document count. From batch 15 on they are visible to admins and editors only and notify nobody; before, they were company-wide. Run it before the batch-15 deploy (it works on the batch-14 schema) and re-target or accept each row; the count goes into the release note. Also part of the rollback list.                                                                                                                                                                          |
| `announcement-retarget.sql`           | Batch 15 and later only: the announcements with `retarget_required` (a department or team they targeted was deleted) and the events restricted only by their flag (`notify_audience = 'departments'` without a department), per row. Save it before a rollback to a batch-14 image; the file's header has the guarded raise-only SQL that re-applies the values after the roll-forward.                                                                                                                                                                                                                                                                                       |
| `schedule-export.sql`                 | Batch 15 and later only: every pending schedule, the draft rows of the seven scheduled types with `publish_at` and/or `unpublish_at`, `schedule_error`, whether the document is published, `withdraw_by_hand` (published with a deadline batch 14 would miss) and `on_rollback` (`final_withdrawal`: never republished once its deadline passed; `pending_publish`; `none`). Save it before a rollback; the header says how to reconcile on the roll-forward.                                                                                                                                                                                                                 |
| `department-heads.sql`                | Batch 15 (department authors): per department the display-only `head` and the `department_head` users whose `user.department` it is, then the mismatches: a head without the role, a head of another department or of none, a `department_head` without a department, a department without any `department_head`. Run it before the batch-15 deploy and align the users in the admin panel. The output names users (username, display name), no contact data.                                                                                                                                                                                                                 |
| `upload-census.sql`                   | Batch 16, lane 16A (uploads): files per stored mime and extension; stamped (POST /api/upload), unstamped (admin panel) and tombstoned files; the uploads-janitor's next candidates (stamped, unlinked, older than 24 h or tombstoned); files linked by more than one document or ad; documents whose file mime is outside the document list. Run it before the batch-16 deploy (expected: the two demo PDFs, unstamped, 0 janitor candidates). The output names files, documents and ads and the uploader's user id, no contact data.                                                                                                                                         |
| `wiki-parent-cycles.sql`              | Batch 16, lane 16B (the wiki write model): the pages on a loop of the document-level parent graph (with the path), the page rows whose parent sits in another space, the page rows without a space, and the counts. From batch 16 on no writer can add a loop (`parentCycle`); this finds the ones from before. Run it before the batch-16 deploy (expected on the owner's instance: 0, 0, 0) and repair a loop in the admin panel (clear one page's parent, publish). The output names pages and spaces, no user data.                                                                                                                                                       |

## Running them

From the repository checkout on the host (compose project `infra`):

```bash
infra/diagnostics/census.sh          # another compose project: COMPOSE_PROJECT=<project> infra/diagnostics/census.sh

docker exec -i infra-db-1 sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < infra/diagnostics/prod-perm-diff.sql
```

The batch-15 and batch-16 files run the same way, one at a time (`<` the
file instead of `prod-perm-diff.sql`). Each one opens `BEGIN TRANSACTION READ ONLY` and
ends with `ROLLBACK`, uses no psql meta-commands, and is run against
Postgres 16 by `apps/cms/src/integration/targeting-fail-closed.integration.test.ts`.
`announcement-retarget.sql` and `schedule-export.sql` read columns batch 15
adds: on an older schema they stop with "column … does not exist" and change
nothing. Before a rollback from batch 15, save the output of the preflight,
`announcement-retarget.sql` and `schedule-export.sql` off the host
(DEPLOYMENT.md, "Deploying batch 15", rollback).

The output contains counts and role/permission names, not personal data.
Still, treat it as internal operational data and don't post it publicly.

### The duplicate scan (census section 9, DA04)

The owning user of a poll vote, an acknowledgement, an RSVP, a lesson
progress row and a reaction sits in a link table, so no database index can
make these rows unique today: the writers check, then insert, and the
readers deduplicate. Whether a unique constraint (and the migration that
first removes existing duplicates) is worth building depends on how often
duplicates occur in production. Section 9 answers that with counts only
(no ids, no names), per record type:

- `pairs`: distinct keys (for example a voter and a poll);
- `duplicate_keys`: keys with more than one row;
- `surplus_rows`: rows beyond the first per key (what a cleanup would remove);
- `max_rows`: the largest group;
- `without_user` (and for votes `votes_without_poll`, for the other
  records `without_target_document_id`): rows that cannot collide, counted
  apart. A missing target anchor (NULL, possible for rows from before issue
  #11) is left out of the key count: `GROUP BY` would treat those NULLs as
  one target, a unique index would not;
- a last table with the month of the newest row of each duplicate group,
  which shows whether the races still happen since the batch-6 cleanups.

Run `infra/diagnostics/census.sh` once and send the section 9 numbers to
the owner; nothing changes in the database.

## Keeping `prod-perm-diff.sql` current

`prod-perm-diff.sql` is generated. `apps/cms/src/prod-perm-diff.test.ts` builds
it from the constants in `apps/cms/src/index.ts` and from the installed
users-permissions plugin, and compares it as a file snapshot. After changing
the permission matrix, the custom grants or the revocations, or after
upgrading Strapi, regenerate it:

```bash
pnpm vitest run apps/cms/src/prod-perm-diff.test.ts -u
```

CI fails while the committed file is out of date.

## One-time cleanup: `cleanup-live-smoke-notifications.sql` (changes data)

Before batch 10, every run of `infra/live-smoke.sh` left one or two comment
notifications behind (actor: the smoke author `sam.chen@sinnlos.local`,
recipient: the author of the newest announcement); the census counted 33 of
them. This owner-run script removes them once. Run it without arguments
first: that is a dry run that prints the count (`residue_rows`) and the titles
and removes nothing. Then arm it with exactly that count, which it checks
before deleting, in one transaction:

```bash
docker exec -i infra-db-1 sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < infra/diagnostics/cleanup-live-smoke-notifications.sql

docker exec -i -e PGOPTIONS='-c sinnlos.cleanup_expected_rows=33' infra-db-1 \
  sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < infra/diagnostics/cleanup-live-smoke-notifications.sql
```

A real comment by the smoke author's account would match as well; check the
dry run's titles first. Deleted notifications come back only from a backup.
`apps/cms/src/utils/cleanup-live-smoke-notifications.pg.test.ts` runs the file
against Postgres 16.
