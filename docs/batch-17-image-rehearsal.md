# Batch 17 local image rehearsal — 2026-10-17

The complete local image cycle passed: v0.16.2 → Batch 17 → v0.16.2 → Batch 17.
The final CMS and web containers are healthy and run the Batch 17 pair. This was
local Compose project `b12i-staging`, using PostgreSQL 16, Traefik and the existing
deployment/backup/live-smoke scripts. Production was not accessed or changed.
Browser acceptance remains separate and outstanding.

## Images and deploy evidence

| Pair              | Source commit / immutable image tag                         | CMS image ID                                                              | Web image ID                                                              |
| ----------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Previous, v0.16.2 | `2f47b84fcadfd6f63ecffac1c78cdf388c5ea44d` / `2f47b84fcadf` | `sha256:65814d07427e35efa4500d3cf93ef83454f86c98e85c3a6f130f2035dd95bf3b` | `sha256:8ae0fca607f72cff14cfd377ed32870e26dfaea80dde48f04ae5413b814a1bbf` |
| Batch 17          | `b9c5e353ef3a789f9b3d2e0fb759653918708acb` / `b9c5e353ef3a` | `sha256:ca1b994e90f5d31fd6820455090a3fbdede1656ba774706dba33ef2e4a37dcfb` | `sha256:08bca409fcdeed0ac61637c6a5fbbe5d34dd2c04d7900f90a79f4700e57a6a2b` |

Both new images were built from the exact source above. All seven checks for that
commit passed in [CI run 39038911494](https://github.com/yurtbayemre/sinnlos/actions/runs/39038911494).
The local deployer's origin is its existing filesystem mirror, so its GitHub CI
lookup reports unknown; the real GitHub result was checked separately. Preflight
and dry-run passed, and `infra/deploy.sh` completed the real deploy, HTTP smoke,
live-pipeline smoke and last-known-good image record.

Encrypted database/uploads/config backups were made before deployment and each
image transition. Decryption/readability of the initial database and uploads
archives was verified with the existing offbox key: 1,347 database TOC entries
and 29 upload archive entries. This was not a full backup restore drill.

## Observed results

| Phase                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old-image fixture preparation | Created clearly labelled confirm/quizGate courses, completed users, unpublished and draft-only lessons, mixed draft/published course variants, organisation text and linked images.                                                                                                                                                                                                                                     |
| First Batch 17 deploy         | Existing and new learner responses omit answer keys. Confirm/quizGate return question verdicts; exam returns only the aggregate result, including completed review. Direct/nested reads and private filter/sort probes refuse disclosure. Forged mode inputs cannot bypass server grading.                                                                                                                              |
| Grading and authoring         | Feedback creates no receipt; completion regrades. Invalid stored quiz data returns `quizContentInvalid` from both actions without creating a receipt. The dedicated corrupt fixture was repaired from its untouched draft. Draft clearing/discard and stale authoring rejection passed. Existing receipts survived; old answer indices still pass after a text-only published edit, as explicitly accepted in the plan. |
| Scheduling                    | Batch 17 scheduled publication succeeded with exam mode. During rollback, both panel and scheduler successfully republished the downgraded course using the old CMS.                                                                                                                                                                                                                                                    |
| Organisation, media, activity | Real HTTP checks exercised head/lead/admin scope and fields, missing/stale versions, removed generic create/delete routes, image replacement for all three fields, and refusal to attach a tombstoned file. Admin activity filters, fixed pagination and non-admin refusal passed. Image byte hashes and links survived both transitions.                                                                               |
| Downgrade                     | Stopped web/CMS, including the in-process scheduler. The actual runbook SQL saved five variants from four documents and left zero exam variants before starting the old images. Exported the separate mode schema without quiz content or keys.                                                                                                                                                                         |
| Old-image behavior            | Both containers healthy. Answers were readable again; old organisation writes and the non-document tombstone-attachment limit returned. The temporary tombstone link was detached. Progress, organisation text and intact linked images remained.                                                                                                                                                                       |
| Restore                       | Stopped writers again and reviewed every saved variant. Restored four variants to exam; preserved one intentional draft change to confirm. The published row had changed from ID 22 to 23 in the panel and then 24 in the scheduler; restoration matched document/variant identity and retained row 24.                                                                                                                 |
| Final Batch 17                | Repeated learner privacy/feedback/receipt checks and organisation/media/activity checks passed. Both containers healthy. The mode snapshot was archived with the review decisions and then removed with the runbook's non-CASCADE cleanup.                                                                                                                                                                              |
| Live pipeline                 | After deploy, rollback and roll-forward, real web sign-in/SSE checks received both a content ping and notification ping. Probe comments and notifications were cleaned up. UTC database/process checks passed.                                                                                                                                                                                                          |

The census records rows, including draft/published copies:

| Checkpoint                     | Courses | Lessons | Receipts | Files | Departments | Teams |
| ------------------------------ | ------: | ------: | -------: | ----: | ----------: | ----: |
| Seeded old pair, before deploy |      18 |      18 |        8 |    20 |           6 |     9 |
| Batch 17, before rollback      |      18 |      22 |       10 |    23 |           6 |     9 |
| Old pair, after rollback       |      18 |      22 |       10 |    23 |           6 |     9 |
| Batch 17, after roll-forward   |      18 |      22 |       10 |    23 |           6 |     9 |

The planned new lesson/corruption fixtures, two completion receipts and three
replacement images explain the additions before rollback. Audit events continued
to append during the operations; unchanged audit counts were not expected.

## Diagnostics and limits

- The current `prod-perm-diff.sql` reported no permission differences, unknown
  roles or orphaned grants after both Batch 17 starts. The v0.16.2 diagnostic
  reported 31 remaining Batch 17 grants during rollback. Code inspection at the
  old SHA confirms they are inactive: the eight course/lesson create/update
  grants have no write route (the old routers expose only find/findOne), and the
  other 23 grants name new actions with no old route. No cleanup migration was
  needed. This route explanation is code evidence, not a separate HTTP probe.
- The plan names `admin-panel-permissions.sql`, but that file is absent at the
  rehearsed SHA. A read-only inventory joined `admin_permissions`,
  `admin_permissions_role_lnk` and `admin_roles` for the five relevant content
  types. This inventory is not proof of effective panel authorization; real
  authenticated HTTP checks covered the exercised paths, including panel saves
  and publishing. A comprehensive panel-role browser check remains outstanding.
- The first Batch 17 scheduler observation was early; a later admin login hit
  Strapi's HTTP 429 limit. The scheduled publication was instead verified by a
  read-only SQL assertion (new published row, exam mode, cleared schedule/error)
  and the scheduler's successful publication log. No rate limit was disabled.
- The in-app browser could not resolve `sinnlos.b12i.test`
  (`ERR_NAME_NOT_RESOLVED`). The deployer can resolve and reach that origin, and
  the HTTP/live checks above ran there. No browser walkthrough is claimed.
- Rolling back exposes answer keys again and restores the old organisation write
  rules, including missing revision checks and broader admin writes, plus the
  accepted course/org media tombstone limit. Roll-forward cannot retract answers
  already read. Unlimited quiz attempts and current-published grading remain the
  accepted alpha limits.

## Evidence and next step

Operational evidence is retained outside Git, with no credential or quiz export
in the mode snapshots: `/home/bigemo/b12i/b17/` inside `b12i-deployer`, plus the
host archive `E:/priv/sinnlos/batch-17-rehearsal/evidence-20261017/`. The latter
contains deploy/rollback/roll-forward logs, census and permission reports,
scheduler/live-smoke evidence, final image health and both mode-schema dumps
with the review decisions and checksums. Protected full backups remain in the
existing backup storage. Labelled rehearsal fixtures remain in local staging.

Complete the browser acceptance from a client that can resolve and trust the
local staging origin. Before any production operation, obtain the actual live
image tag, current backup, final-commit CI and the owner's deployment go in the
deployment session. No production deployment, merge or v0.17.0 release was made
as part of this rehearsal.

### Browser follow-up on 2026-10-18

[Browser acceptance phases 1 and 2](batch-17-browser-acceptance.md) now verify TLS access, eight role entries and the training workflows against these same staging images. An isolated client on the existing Docker network uses the public local CA with certificate checking and browser sandbox enabled; the host/In-App DNS was not changed. Training draft isolation, quiz-only edits, conflict Reload/Overwrite, actual scheduled publication and all three quiz completions passed. Three labelled optional courses/lessons and three member receipts remain in staging; older rehearsal fixtures and the deployment were unchanged. The temporary client and its private credentials/profile were removed after the checks. Organisation/media, activity/report/panel and final review remain open.
