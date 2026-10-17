# Batch 17 implementation plan

> Phase 3 of v2 frontend authoring (plan 12). Written 2026-10-16 against main 2f47b84fcadfd6f63ecffac1c78cdf388c5ea44d, released as v0.16.2.
> Status: all implementation steps are merged into main afcbd51 through PR #90. The combined Ponytail review is complete with no confirmed new findings (section 16). Rollback instructions, browser acceptance and the deploy/rollback/roll-forward rehearsal remain next. Decision 06 remains the approved scope; section 3 records the accepted lean exam-mode amendment, unlimited retries and no timer. Review corrections are recorded in section 11.
> Paths: cms/ = apps/cms/src/, web/ = apps/web/src/, domain/ = packages/domain/src/. Paths outside those roots are written in full.
> This plan records the implementation baseline and local evidence; it does not verify or change the running server.

## 1. Outcome and scope

Editors and admins can author courses, lessons and quizzes in the web. Department heads and team leads can edit the organisational descriptions they are responsible for. Admins can read the existing content activity trail in the web. The remaining content-API payload bypasses disappear.

The implementation reuses the write gate, allowlist, document revision and lock, scheduler, audit recorder, media claims, form kit and shared training validators from batches 15 and 16. It adds no dependency, replacement form system, general workflow engine or new role system.

| Area                 | Batch 17 delivers                                                                                             | Boundary                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Training authoring   | Course and lesson forms, quiz builder, draft/preview, publish/unpublish, scheduled publish, safe discard      | admin_role and editor; deletion stays in the panel                               |
| Training player      | One answerless player for all modes; exam returns only an overall result                                      | confirm and quizGate keep their feedback styles; all grading is server-side      |
| Organisation content | Department description/color and team description; admin image editing                                        | Structure, names, membership, head/lead, creation and deletion stay in the panel |
| Activity             | Admin-only paginated content activity with type, actor, actor-class and date filters                          | Existing retention and append-only storage; no security-audit expansion          |
| Navigation           | Training authoring at /manage/training; report moves to /manage/training/report; activity at /manage/activity | Department authors retain their three existing manage areas                      |
| API boundary         | Org create/delete routes removed; final write bypass and S01 exceptions removed                               | Panel accounts and panel fallback remain                                         |

The scope follows frontend-authoring decision 06 (approved 2026-09-29), especially sections A, B4, E, H, I, L and phase 3, and the batch-17 handoff. Those source records are maintained outside this repository; their relevant decisions are restated here. The report move, activity page, course cover image and final manage navigation are all part of the approved scope.

### Explicit exclusions

- No sequential lesson unlocking, timed exams, attempt limits, certificates, question randomisation, validity periods or mandatory repeat training.
- No removal of existing completion receipts when a quiz changes; no new completion count gate.
- No drag-and-drop ordering; use the existing lesson order field.
- No web deletion of courses/lessons or structural organisation management.
- No admin-panel retirement or admin-account provisioning.
- No dependency upgrade, iPhone/PWA bar fix, general media tombstone overhaul, database uniqueness project (#16), Entra work (#20), upgrade backlog (#37), worktree deletion or staging teardown.
- Duplicate wiki-space field errors and stricter deployment smoke checks remain separate small follow-ups. They are not prerequisites for this batch.

## 2. What changed since the approved design

| Finding on v0.16.2                                                                                                                                                                                                                       | Consequence for this plan                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both existing completion modes already require correct answers at the CMS, but the browser receives correctIndex. cms/api/lesson-progress/controllers/lesson-progress.ts:49 and web/components/training/quiz-block.tsx:25 document this. | Hide keys in every learner response; add exam as an overall-feedback mode without relabeling existing courses.                                       |
| domain/training.ts:134–172 parses defensively by dropping invalid questions; an empty parsed quiz passes completion.                                                                                                                     | Feedback and completion share strict stored-quiz validation in every mode; malformed content cannot pass.                                            |
| Organisation types are single-row, while write-gate.ts:205–251 expects a draft twin and authoring/http.ts:63 has only explicit/alwaysPublished status modes.                                                                             | Add the narrow single-row loading/update path. Do not invent drafts or pass a status into org writes.                                                |
| Locks, revision counters, schedules and audit already cover course/lesson; locks and audit already cover department/team. cms/utils/authoring-uids.ts:79 and bootstrap/document-middlewares.ts:112.                                      | Extend the existing authoring surface, not these infrastructures.                                                                                    |
| Media claims currently cover only document.file (cms/utils/media-claims.ts:75); ownUploadCheck uses document MIME types (authoring-checks.ts:207).                                                                                       | Add image-only course.coverImage, department.headerImage and team.avatar, including upload permissions and per-field validation.                     |
| The remaining open payload exceptions are department and team (cms/routes.matrix.test.ts:644).                                                                                                                                           | Migrate both gates and revoke both route pairs before deleting WRITE_BYPASS_ROLES and KNOWN_OPEN_PAYLOADS.                                           |
| The existing training report occupies /manage/training (web/app/(app)/manage/training/page.tsx:45). Activity has storage but no API controller/router.                                                                                   | Move the report; implement a bounded activity read, not another recorder.                                                                            |
| The old phase-3 plan promises no schema change and a plain rollback. Exam adds an enum value and a private quiz contract.                                                                                                                | Retag the previous CMS/web pair with a rehearsed exam-to-quizGate downgrade; record restored old exposure and restore exam settings on roll-forward. |

Pinned framework baseline: Strapi 5.57.0 and Next 16.4.2, as declared by the application packages. Before implementation, each worktree installs the frozen lockfile with corepack pnpm and builds the domain package. Any dependency-source evidence must come from those installed versions, not stale node_modules in an old worktree.

## 3. Shared quiz player and lean exam mode

### 3.1 Product behavior

Accepted decision: retain confirm and quizGate and add completionMode = exam. Stored courses and the default confirm stay unchanged. Every mode uses the same answerless player and server grading. Confirm requests per-question feedback after each selection; quizGate requests it for the collected answers; exam returns only an overall passed/not-passed result, with no score, per-question verdicts, wrong-question indices or explanations. Completed exam review keeps this restriction. No separate exam player, grading algorithm or mode-discriminated question DTO.

Retries are unlimited and there is no timer. Learning feedback allows systematic discovery of the answers; exam's aggregate result makes guessing harder but cannot prevent it, collaboration or shared answers. Previously delivered or inferred answers cannot be withdrawn by switching to exam. A legitimate no-quiz lesson still completes manually. Existing receipts remain valid after quiz, order or mode changes; the authoring form explains this, and no minimum-quiz-count gate is added.

### 3.2 Private stored quiz and one learner contract

Mark raw lesson.quiz private for all generic content-API reads, including nested relations. Only the authorised author editable DTO and the panel expose the key. Keep the stored quiz shape unchanged. Add GET /api/lessons/:id/player for the roles that currently read lessons: resolve canonical documentId, published lesson and published owning course on the server; missing, draft-only, orphaned and unpublished-parent targets return the same unavailable response. Reject generic status/fields/filters/sort/populate queries and client-selected modes.

Explicitly select readable lesson content, course documentId/title/slug/completionMode and questions containing only question/options. Use one learner question type without correctIndex for all modes, separate from the author QuizQuestion; the existing parseQuiz requires correctIndex and must not parse this learner response. Never spread raw rows or quizzes into it, cache it or serialize author DTOs into learner pages. Migrate the normal lesson reader and player together; course outlines and reports keep their existing reads.

### 3.3 Shared feedback and completion

Add POST /api/lessons/:id/check with the same learner grants and published-target checks as the player. It accepts bounded indexed selections (partial for confirm, complete for quizGate/exam), returns feedback and never writes a receipt. The current published course determines the response mode on the server, including for already-completed lessons: forged mode/query parameters cannot make an exam return per-question feedback. Incomplete exam submissions cannot obtain individual verdicts.

Keep POST /api/lesson-progresses as the only completion action. It independently validates the target and submitted answers and writes a receipt only after all questions pass; it never trusts a previous feedback result, client passed flag or supplied actor. Both actions use one shared stored-quiz validation/grading path built from validateQuiz and quizAnswersPass. Null or [] is a legitimate manual-completion lesson; malformed stored content is a stable content error, never an empty or partially passing quiz. The lenient parser remains display-only. Bound and validate inputs at the CMS boundary; no answer persistence or attempt-history table. Preserve the existing completion response and Quiz not passed mapping; new content-error codes, domain exports and both web translations land together.

Grade the published quiz read when handling the request, without binding it to previously displayed questions. No lessonVersion/courseVersion submission tokens, player-specific 412/428 protocol, extra grading locks or inverse-course-write gate. Same-length stale answers can still pass when correct indices match; publish, unpublish or reparent can race with the availability read and receipt. These are accepted alpha limits, separate from retaining old receipts. Existing authoring If-Match, locks and publication readiness remain intact. Failed completion keeps the current refusal/refresh behavior; transport errors must not mark completion.

Lane 17A includes real HTTP privacy regression tests on pinned Strapi: direct/nested reads, fields, filters, sort/search, populate and array/JSON query shapes must not expose or infer the raw key. Cover the custom player, feedback, completed review and author/panel access too. This is not a separate prerequisite to freezing contracts; a failing privacy regression blocks release. Extend the existing query guard only if a test demonstrates a gap.

### 3.4 Rollback compatibility

Use the previous deployed CMS/web image pair, not a separately maintained compatibility release. Before starting the old CMS, record affected course documentIds and their draft/published variants, then map only exam values to quizGate using a short reviewed SQL step. Include its ordering and restore instructions in the runbook and a hint in infra/deploy.sh alongside the existing rollback notes. Roll-forward restores exam only for the recorded variants, accounting for republish replacing numeric row ids; do not convert unrelated quizGate courses. Verify old panel and scheduler publishing as well as startup: a varchar column alone does not prove application compatibility.

Rollback explicitly restores readable quiz keys, old organisation create/delete boundaries and the accepted course/org media tombstone-attachment limit. It does not automatically delete intact linked images, but solutions read during the rollback cannot be made secret again by roll-forward. Section 8 rehearses one deploy/rollback/roll-forward cycle with exam content, progress and both course variants. Exact SQL and image compatibility must be demonstrated there; no backported exam or media image pair is required.

## 4. Backend and HTTP contracts

### 4.1 Training authoring

Extend the existing course/lesson controllers and authoring type tables:

- Core routes: find, findOne, create, update. No delete.
- Custom routes: GET authoring, GET :id/editable; POST :id/publish, :id/unpublish, :id/discard-draft.
- Only admin_role and editor receive the write/authoring grants, behind global::can-author. Existing read policies remain.
- Explicit status=draft|published on create/update; existing If-Match and ETag protocol on mutations.
- Discard without a published row returns 400 neverPublished under the lock for both types, including previously published then unpublished content. The course and all lesson links survive.

Course allowlist: title, description, mandatory, completionMode, coverImage, publishAt. Slug remains derived; course.lessons and internal schedule/audit fields are refused. Lesson allowlist: title, body, order, course, videoUrl, quiz, publishAt. Course is required on create and resolves by documentId; reparenting uses the same validated relation path. Reject inverse structural payloads. Lesson ordering remains a nonnegative integer, with the current upper bound 10000.

Add a server-side course filter to lesson authoringList, validated as a documentId and applied before pagination/count. Do not fetch all lessons to filter in the browser. The fixed list/editable DTO includes the course reference and order needed by the nested editor; authors can still access a draft lesson whose course is draft.

Reuse domain validateQuiz and youtubeVideoId. Quiz shape stays at most 20 questions, 2–8 options, strings at most 500 characters. Keep parsing admin JSON text in the CMS boundary; do not move that runtime-specific normalization into the browser. Replace German lifecycle strings with stable codes and clear panel messages without weakening the idempotent lifecycle backstop.

Publish readiness remains shared across web, panel and scheduler. Quiz edits do not erase previous progress. A draft-only clear must not clear the published quiz; republishing must validate and copy the new quiz consistently. Progress remains anchored to lesson documentId: a new published lesson can make a completed course incomplete again; unpublish/delete/move changes its currently relevant lesson set without rewriting receipts. Keep the existing empty-course-is-incomplete rule.

### 4.2 Organisation content

| Caller                                                                    | Department fields               | Team fields                               |
| ------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------- |
| admin_role                                                                | description, color, headerImage | description, avatar                       |
| department_head with matching current user.department                     | own description, color          | description for a team in that department |
| permitted team lead                                                       | none through this right         | own team description                      |
| editor, member, guest, authenticated without one of those existing grants | none                            | none                                      |

The org moderator class is admin_role only. It does not inherit editor rights from the training/wiki moderator set. department.head stays display-only; reuse loadCallerDepartment and existing team-lead precedence/grant boundaries.

Routes: core find/findOne/update only, plus GET /api/{departments,teams}/:id/editable. Keep numeric-id compatibility through the canonical id loader; new web calls use documentId. Both editable and update use the same row classifier. Update requires If-Match, uses the existing lock/audit scope and returns a fixed result with version/ETag. Reclassify stale access as the existing gates do before disclosing a newer version.

Single-row handling is explicit: load the organisation's one row regardless of legacy publishedAt, reject every write query key including status, and do not pass draft/published options to the Document Service. Org forms have one Save action; there are no publish/schedule/discard/delete routes or controls.

Refuse name, slug, head, lead, members, department changes and inverse relations even for admin_role on the content API. Remove create/delete grants from the matrix and add explicit revocations; permission sync does not remove a stale grant merely because a matrix entry disappeared.

After both migrations, remove WRITE_BYPASS_ROLES, isWriteBypassRole, KNOWN_OPEN_PAYLOADS and their tolerated-open test branches. Replace them with a hard assertion that every exposed authored create/update is gated for every role that holds it.

### 4.3 Media

Extend the existing media field registry with course.coverImage, department.headerImage and team.avatar. Use one image MIME source from the existing domain upload constants (IMAGE_FORMATS and UPLOAD_FORMAT_SPECS): JPEG, PNG and WebP, maximum 5 MB. Extract only the small field-to-MIME table into a dependency-light CMS module; both early checks and media claims consume it. Bind/pass the actual field key to the check, whose current MediaCheck receives only a file id. Do not import executable media-claims middleware into the allowlist: it already imports refuseKeys in the other direction. The early ownUpload check and transaction-time claim must use the same list; a PDF/Office file is not a valid image.

Reuse upload transport, stamping, byte sniffing, tombstones, file-row locks and post-commit cleanup. New attachments are the caller's unclaimed files; retaining the existing file remains valid for another editor's or unstamped legacy upload. Send no unchanged media key. Removing/replacing an image only cleans a stamped file after all links are gone and the transaction commits.

The current web uploadDocumentFile guard only checks document capabilities. Adapt its existing transport for the actual training/org image capability and image-only validation; do not grant a head image editing merely because that head can upload documents. Every new allowlist media field and its middleware registry entry lands in the same commit.

### 4.4 Activity read

Add an explicit GET /api/audit-events action for admin_role only. No findOne/create/update/delete or public/other staff grants. Keep the existing retention task and append-only protections.

A fixed query takes only page, targetUid, actorKind/actorId, actorClass, from and to. Use a fixed page size of 25, positive bounded page numbers, validated type/class values, actor ids scoped by actorKind and offset-bearing ISO date bounds with from <= to. Reject generic Strapi query parameters and unknown keys. Sort by createdAt descending then id descending; return exact pagination metadata without an unbounded walk.

Return event id, timestamp, action, targetUid/targetDocumentId, revision, source, changed keys, detail and actor { kind, id, displayName, class }. Resolve user/admin names server-side in batches, without returning email or any user/admin object. Deleted actors get a stable deleted-user/admin label with id; system actors remain identifiable. The type and source vocabulary includes the current file/classified deletion events and source system as well as the ordinary authored types.

Use the existing guarded action set for validation where appropriate; no new configurable event schema. Actor filters may use a kind/id input and labels from returned events; avoid a new unrestricted directory lookup merely for a picker. Missing/deleted content need not produce a broken link.

The activity action calls only bounded reads. It does not need a Server Action, an activity-actions.ts mutation wrapper, another audit service, new indexes without evidence, or a second retention policy.

## 5. Web work

### Training

Create course list/new/edit screens under /manage/training and nested lesson new/edit routes under the selected course. Reuse AuthoringList, editableLoad, use-item-editor, PublishBar, ScheduleDialog, MarkdownEditor, field errors, the file field and conflict dialog. Extend course/lesson tables without creating an unnecessary top-level lesson tile. A nested lesson editor verifies its editable parent against the course in the URL and returns not-found on a mismatch. Course is selected at create; no web reparent control is added in this first version. Existing panel and guarded API moves remain supported.

The quiz builder uses the shared validator and existing UI primitives: question/options fields, radio selection of the correct answer, add/remove controls and explicit limits. Numeric lesson order is sufficient. Fix the existing editor's dirty comparison for quiz arrays: sameValues currently stringifies object arrays as [object Object]. With array-valued quiz form state, add quiz to its existing ORDERED_LISTS so the existing JSON equality compares nested values and question order. Test correct-answer/text changes, question reorder, save and reset; do not add another comparison abstraction. Render YouTube embeds only from the shared parsed id. Show the existing-completions notice next to quiz/mode editing. No delete button; discard is absent without a published version.

Adapt the existing player for answerless questions in every mode. Request server feedback after a selection for confirm and on the check button for quizGate/exam; render only the feedback the server supplies, with no individual verdicts in exam or completed-exam review. The browser may require selections but cannot decide correctness. Pending or outdated feedback cannot unlock completion for changed selections; transport failures preserve answers and never mark completion. Completion still submits the answers for independent server grading and refreshes on refusal. All modes preserve keyboard behavior, accessible field labels and announcements for errors/results.

Move the existing admin-only report to /manage/training/report and update its callers, tests and URL snapshots. /manage/training deliberately becomes authoring; do not add a redirect at the same path that hides that new page.

### Organisation

Add /departments/[slug]/edit and /teams/[slug]/edit, with row-aware Edit links on the detail pages. Capabilities decide presentation; the CMS editable action remains authoritative. Use the shared Markdown editor, existing color input/palette if available and image field only for admins.

Update detail readers/types/renderers for headerImage and avatar so saved images are visible. Preserve legacy descriptions with a display-only branch: HTML-looking values keep the existing escaped plain-text stripHtml presentation; other values use the existing safe Markdown renderer. Keep the raw description in editable/form state and omit it from an image/color-only save. Test legacy HTML, plain text, Markdown, hostile markup and byte-preserving unrelated saves. No raw-HTML plugin, new sanitizer, conversion or bulk rewrite. List summaries can stay plain text.

### Activity and navigation

Add /manage/activity with the fixed filters, pagination, actor labels and empty/error states. Reuse the existing report shell. Admin only; reports.activity and parity tests turn on with the endpoint grant.

Update the manage landing and navigation for training, report and activity. Narrow routine Strapi shortcuts as the decision specifies, while keeping the fallback panel entry reachable for organisational structure and other panel-only operations.

Add training/org/activity manage message files in German and English, register them in web/i18n/messages.ts and web/global.d.ts, and extend message/ICU parity tests. New pages receive the existing loading skeleton pattern. Shared error codes, maps and translations stay in lockstep.

## 6. Lanes, ownership and merge order

Keep two primary implementation lanes, as decision 06 planned. Backend work shares too many gates, registries, types and permission files to split them between parallel backend writers.

| Lane                  | Ownership                                                                                                                                                                                       | Handoff                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 17A CMS and contracts | Training/org/audit controllers, routes, gates, shared authoring tables, schema, validators, media claims, permission matrix, backend diagnostics/tests, domain DTOs/codes, web roles and parity | Pure contracts first; runtime grants/capabilities with implemented guarded endpoints |
| 17B Web               | Training/player/org/activity pages, readers, forms, server actions, report move, navigation, media UI, i18n, web tests                                                                          | Starts against the reviewed contracts; consumes 17A                                  |
| Integration           | Combined review, rollback instructions and staging rehearsal, final docs, PR/release/deploy brief                                                                                               | Owns the final integrated state                                                      |

The shared player/API change spans backend and learner web. 17A and 17B coordinate generic quiz privacy, the common player and feedback action, shared validation/grading and the learner adaptation in one usable integration point. One named owner assembles it; the web owner hands over its files. Every merge point keeps existing consumers working; no separate compatibility/backport branch is required.

### Shared-file register

- 17A owns cms/utils/{write-gate,write-allowlist,authoring-controller,authoring-checks,authoring-uids}.ts, the permission matrix, media field registry and bootstrap wiring/tests.
- 17A owns domain/authoring/{fields,http,dto,codes,validators}.ts and domain/training.ts/index.ts, plus the org, author quiz and common answerless learner/feedback contracts. Reuse existing files; add a module only when it holds substantive cohesive logic.
- 17A owns web/lib/roles.ts and role parity. It adds stable-code mappings and common German/English texts with the pure contracts, then explicitly hands the error/text files to 17B. Actual capabilities, grants, snapshots and parity changes land only with their implemented guarded endpoints: player/check with the shared player/API change; training/org/activity with the backend remainder.
- 17B owns manage components/actions/loaders/API modules and the reader API/types/player, except the coordinated shared player/API change.
- 17A owns S01 route pins, permission snapshots, policy contracts, removed-routes, read-exposure and role-read snapshot changes. 17B owns URL snapshots, message tests, page/access/form tests.
- 17A updates README permission tables and diagnostic queries with the matrix. Integration reconciles architecture/security/deployment/roadmap prose at the end.
- Neither lane changes dependencies, auth/session transport, worktree cleanup, CI worker limits or unrelated application features.

### Contract register

| Contract                                                                          | Freeze                                                                 |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Training intents, fields, explicit status, no-delete and nondeleting discard      | 17A contracts commit                                                   |
| Lesson authoring list course filter, list/editable DTO including order and parent | Same                                                                   |
| Common answerless quiz DTO, feedback/completion inputs and result/error shapes    | 17A contracts commit; privacy regression runs in the lane              |
| Org single-row editable/update DTO, exact role fields, no status query            | Single-row probe, then contracts commit                                |
| Per-field image MIME/capability rules and upload response                         | Same, with registry and allowlist atomic                               |
| Activity filters, vocabulary and response                                         | Same                                                                   |
| New codes plus web mappings/translations                                          | Pure contracts commit; no premature runtime capability                 |
| Actual grants, capabilities and parity/snapshots                                  | Atomically with each implemented guarded endpoint, never a placeholder |

Merge sequence: single-row org probe and pure contracts (DTOs, codes, fixtures and interfaces only) → shared player/API change → 17A backend remainder, including media claims and its grants/capabilities → 17B web remainder → integration. No contracts commit grants unimplemented actions or advertises an unusable capability. Every merge point builds and keeps its existing tests green. Use fixtures/mocks for web development until the guarded backend contract exists.

Each lane follows implementation → focused tests → Ponytail simplification → independent adversarial review → fixes → lane rehearsal. Integration receives another review and combined rehearsal. The existing eight-worker integration limit stays; only one full integration run on the shared host at a time. Every eventual lane uses its own worktree. No implementation worktree is needed just to write this plan.

## 7. Required checks and acceptance

| Surface              | Acceptance evidence                                                                                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Training authoring   | admin/editor create/edit/publish/schedule; other roles refused; unsupported delete 405; inverse/unlisted fields rejected; numeric id compatibility where already supported; missing/stale If-Match; panel writes invalidate web forms                                                        |
| Draft safety         | Never-published and unpublished course/lesson discard returns 400 and preserves rows/links; draft quiz clear leaves published version intact; published parent required through web, panel and scheduler                                                                                     |
| Quiz confidentiality | Real HTTP direct/nested reads, fields, filters, sort/search and populate reveal no raw key in any mode; player and completed review stay answerless; forged mode cannot obtain per-question exam feedback; authorised author editable/panel can edit keys                                    |
| Quiz correctness     | Both server actions share strict validation; correct/incorrect/missing/out-of-range answers, legitimate no-quiz and corrupt content; feedback creates no receipt, completion regrades; forged actor/result; mode changes; current-published/stale-answer semantics and failed receipt insert |
| Player behavior      | confirm per-selection server feedback, quizGate per-question batch feedback, exam overall-only feedback including review; pending/stale responses cannot unlock changed answers; no-quiz completion, rendering and historical receipts preserved; generic quiz consumers migrated            |
| Organisation         | Exact role/row fields; editor cannot gain org admin rights; structural fields refused even for admin; single-row with either legacy publishedAt shape; all status/query inputs rejected; POST/DELETE 405; current grants and revocations                                                     |
| Images               | Own/foreign/taken/unstamped-retained/wrong-type/tombstoned files; 5 MB limit; draft/published and single-row replace/remove; cleanup only after commit; one Postgres attach/delete race using an org field                                                                                   |
| Activity             | Admin-only even when called directly; closed generic query surface; filters/counts/order/page bounds; duplicate timestamps; overlapping admin/user ids; deleted actor/content; system/file/classified events; no PII objects or writes                                                       |
| Web                  | Role/row presentation, session expiry and CMS failure, conflict reload/overwrite, quiz dirty/save/reset and boundaries, nested parent mismatch, keyboard use, localized errors, report relocation, visible saved org media and descriptions                                                  |
| Contracts            | Routes/grants/policy pins, README permission table, prod-perm-diff, no stale exceptions, domain exports, URL snapshots, i18n/ICU parity, loading-file convention                                                                                                                             |

Use the existing Vitest suites and real Strapi HTTP harness on SQLite and Postgres 16. New tests target behavior and trust boundaries, not mirror implementations. Extend existing lesson-progress-quiz, authoring, read-exposure and media suites before introducing overlapping harnesses. The authoring helper currently sends status by default; org tests must omit it and also prove rejection when it is present.

Integration runs the required lint/typecheck/unit/integration/TZ/build checks from the existing package/CI scripts once for the final state. Re-run only when changes or failures justify it. Browser walkthrough is a separate staging acceptance check; do not claim it from unit results.

## 8. Deploy and rollback rehearsal

Use the existing local Postgres staging and deployment machinery for one complete deploy → rollback → roll-forward cycle. The rollback target is the previous deployed CMS/web image pair; do not build a separate compatibility pair.

1. Seed a v0.16.2 stand-in with confirm/quizGate courses, completed users, draft-only/unpublished lessons, org text/media and audit events. Record counts and file links without answers or credentials in logs, and identify the immutable target/rollback image tags.
2. Deploy batch 17. Check the enum/private-field behavior, permission drift against the actual matrix, revocations, routes, boot/scheduler logs and CMS/web health. Verify database and application behavior rather than inferring compatibility from the column type.
3. Exercise authoring, scheduling and publishing, then learner feedback and completion in all three modes. Verify answerless reads for existing courses, exam overall-only feedback including completed review and forged-mode requests, malformed stored quiz refusal and direct/nested HTTP privacy regressions. Edit quizzes, preserve old progress and demonstrate the accepted current-published grading behavior.
4. Exercise organisation head/lead/admin edits and image replacement, panel structural fallback and the activity filters/events. Run the read-only admin-panel-permissions diagnostic.
5. With new exam content/progress present, stop CMS/scheduler writers, record affected course documentIds with draft/published identity and apply the reviewed exam-to-quizGate SQL before starting the previous CMS/web images. Include published, draft-only and differing draft/published modes. Verify startup, panel and scheduler publication, preserved progress/files and the restored old grants, readable keys and media-attachment limit. Record these limits explicitly; do not claim exam secrecy during rollback.
6. Roll forward to batch 17 and restore the recorded exam settings, including variants whose numeric row ids changed on republish. Reconcile any rollback-window mode edits rather than overwriting unrelated quizGate courses. Recheck grants/revocations, quiz privacy, feedback, progress, drafts, files and activity. Preserve quiz content; never export answer keys as part of the mode backup.

Before deploying remotely, ask the deployment session for its current live tag; the handoff can go stale. Require a current backup, clean preflight, exact-commit green CI and a brief naming target/previous rollback tags, the rehearsed mode downgrade/restore steps, schema/permission changes and the owner's browser steps. The owner gives the deploy go in the deployment session. Rollback, DB writes, .env changes and destructive cleanup retain their existing explicit-approval rule.

The release notes state the reviewed training-write exception, answerless learning and exam semantics/limitations, org route removal, report URL change, panel fallback and rollback exposure. After successful deployment/report, create the annotated v0.17.0 tag and GitHub release per the standing release rule. package.json remains at its existing version until the separate v1.0.0 decision.

## 9. Files and fixtures to carry through

The lane lists are responsibilities, not a request to create every named file:

- cms/api/{course,lesson,lesson-progress,department,team,audit-event}/\*\*, their schemas, custom routes and lifecycles.
- cms/policies/{can-edit-department,can-edit-team,training-visibility}.ts and relevant tests; existing query guards only if the privacy regression proves a gap.
- cms/utils/{training-validation,write-gate,write-allowlist,authoring-controller,authoring-checks,authoring-uids,media-claims}.ts and focused tests; preserve existing authoring locks and publication readiness.
- cms/bootstrap/{permission-matrix,document-middlewares}.ts; index registration only if a targeted guard needs it; roles/policy/route/registry tests and snapshots.
- domain training and authoring types/constants/validators/DTOs/exports, common answerless learner type and shared stored-quiz validation/grading; no replacement validator.
- web reader training API/types/loaders/player/actions, org API/types/detail renderers, manage API/actions/loaders/components/pages, roles/parity, navigation and message registration.
- Existing training report imports and web/lib/strapi-urls.test.ts snapshot; use-item-editor.ts ordered quiz comparison; both locale files and new-page skeletons.
- cms integration fixtures using generic raw quiz reads, lesson snapshots, removed-routes assertions and helper status defaults. Keep fixtures valid through published parent readiness. media-claims.integration.test.ts:353–375 currently expects a tombstoned department attachment to succeed: change that case to refusal, and retain the removeReserved relink-fallback coverage using a genuinely unclaimed field. Update upload-orphans.ts's associated coverage comment.
- README.md, docs/{architecture,security,DEPLOYMENT,ROADMAP}.md, infra/diagnostics/{prod-perm-diff,admin-panel-permissions}.sql and diagnostic README; infra/deploy.sh rollback hint and the rehearsed exam downgrade/restore SQL instructions.

## 10. Completion gates for the plan and implementation

Implementation follows the accepted section 3 decision: exam remains as overall-only feedback, all learner modes are answerless, retries are unlimited and there is no timer. The single-row org prerequisite passed on SQLite and Postgres (section 12); guarded org endpoints and their HTTP tests are implemented (section 14). Privacy is a normal lane regression, not a pre-contract gate; real HTTP exposure still blocks release. The shared player/API privacy regression passed on SQLite and Postgres (section 13); production release and combined rehearsal remain pending.

Before production deployment, exact-commit CI and the complete rehearsal with the previous CMS/web pair and mode downgrade/restore are mandatory. Accepted limits remain: panel saves lack If-Match and may overwrite a web change; panel structural/media privileges remain; quiz edits do not revoke receipts; current-published grading is not bound to previously displayed questions and retains concurrent publish/reparent availability races; unlimited retries permit guessing; in-flight role/team changes retain the existing request race. Rollback restores the old answer exposure and media/org boundaries described in section 3.4.

Original planning validation: repository/decision inspection and independent review only. Preparing the plan changed no application code, dependencies, schema, database, production state or existing completion. Implementation evidence is recorded separately below.

## 11. Plan review and accepted simplification on 2026-10-16

The initial training, organisation/media/activity and web/contracts reviews were followed by the owner's accepted lean exam decision. The current plan incorporates these corrections:

- Keep exam only as an overall-feedback value; use one answerless learner contract/player and one strict validation/grading path for feedback and completion in all modes. The server chooses the current published mode, and completed exam review never returns per-question verdicts.
- Keep feedback free of receipt writes and regrade independently at completion. Invalid stored quiz content is an error in both actions; existing valid receipts remain untouched.
- Remove learner revision tokens, their 412/428 protocol and the additional inverse-course-lock gate. Document same-index stale-answer success and existing concurrent publication/reparent limits explicitly; retain authoring If-Match and locks.
- Run privacy checks as release-blocking real HTTP regressions in lane 17A, without a separate contract-freeze gate. Retain the single-row org probe.
- Replace the separate compatible image release with the previous CMS/web pair and one deploy/rollback/roll-forward rehearsal. Record stable course and variant identities before exam-to-quizGate downgrade, restore them on roll-forward and disclose restored answer/media/org exposure.
- Compare quiz objects and order correctly so edits are not silently treated as clean. Keep runtime grants/capabilities atomic with implemented guarded endpoints, check nested lesson parent URLs and omit an unnecessary web move control.
- Preserve raw legacy organisation descriptions on unrelated saves. Keep media allowlists and claim registration atomic, move the old tombstone fixture to the right invariant and share MIME data without a middleware import cycle.

These are plan corrections, not executed application tests or a rollback proof. No implementation-effort or rehearsal-time savings ratio is claimed.

## 12. First implementation step: org probe and contracts

The first merge-sequence step is implemented on top of main 36c62cf:

- Domain contracts define training fields/intents, course/lesson editable and list shapes, one answerless learner question type, indexed feedback requests, the existing completion input, org role fields and single-row responses, and the bounded activity query/response vocabulary. They remain separate from live authoring registrations.
- `quizContentInvalid` has one stable domain code, a web action mapping and German/English text. Existing quiz refusal and transport-error handling remain intact.
- The real Document Service probe covers department and team updates with both legacy publishedAt shapes on SQLite and Postgres 16. A status-free save preserves one row, identity and relations, increments the revision once and emits one update audit event. A stale revision returns 412 without changing content, revision or audit.

The NULL publishedAt fixture is injected after startup: the existing org boot guard still refuses such rows on restart. This probe establishes the narrow runtime write path, not boot compatibility or HTTP query/permission enforcement. Strapi stamps publishedAt during the update; no fake publish event is emitted. Do not reuse alwaysPublished for these org writes.

Local validation: 181 focused unit/contract tests and 12 integration tests passed; domain build/export parity and production/test TypeScript checks passed across all three packages. Independent review found no actionable issue. The integration run used disposable databases, not staging or production.

Next is the shared player/API change, including strict stored-quiz validation and release-blocking HTTP privacy regressions. That first step did not add endpoints, grants, capabilities, media claims or the exam schema value; its learner reads still exposed answers. Section 13 records the subsequent player/API change. Full release checks, browser acceptance and deploy/rollback rehearsal remain outstanding.

## 13. Second implementation step: shared player/API

The shared player/API builds on the contracts commit 9a0d643:

- Raw lesson.quiz is private for all generic content-API reads. One fixed player response contains only question/options; the new player and feedback actions have exactly the existing lesson read grants. The panel still reads and edits answer keys; web author editable endpoints belong to the backend remainder.
- Player, feedback and completion share the published lesson/parent check. Feedback and completion share strict stored-quiz validation and the existing grader. Null/[] means manual completion; corrupt stored content fails with quizContentInvalid. Feedback creates no receipt and completion independently regrades using the caller from the session.
- The course enum adds exam without changing existing/default modes. One web player requests confirm feedback per selection, quizGate feedback in a batch and exam aggregate feedback, including completed review. A shared bounded selection validator serves both request boundaries. Answer edits and unmount invalidate pending feedback; refused stale submissions reload the current player.
- The HTTP regressions exposed a malformed scalar filter being wrapped by visibility policies before Strapi validation, causing 500. The existing narrowFilters now rejects that shape with 400 before rewriting it; no additional privacy middleware was needed.

Local evidence: all 44 real HTTP tests pass on SQLite and Postgres 16, covering private direct/nested/filter/sort/search/populate and array/JSON query shapes, grants, unpublished targets, panel edits, corrupt content, failed receipt insertion, old receipts and current-published grading. The focused web checks pass, including stale feedback and unmount regressions; independent review findings were fixed. The local full unit run passed 6,983 tests but hit Windows shell/SWC-cache environment failures and a Postgres setup timeout; the isolated Postgres retry passed all 13 tests. Linux CI is the authority for the complete build and test run.

Next: the 17A backend remainder (training/org/activity authoring and media claims), then the web remainder and combined acceptance. No staging/production deployment or rollback rehearsal has been performed. The existing DEMO_MODE remains a read-only fixture preview; interactive quiz feedback requires the CMS. Accepted unlimited-attempt and current-published race limits remain as documented in section 3.

## 14. Third implementation step: 17A backend remainder

The backend remainder builds on the shared player/API commit bb0eecf:

- Course and lesson authoring use the existing gate/controller, explicit status, If-Match/ETag, locks, schedule checks and fixed editable/list DTOs. Only admin_role/editor receive writes. Delete stays in the panel; discarding without a published row refuses with neverPublished under the lock and preserves rows/links. Author editable responses include quiz keys; learner reads remain private.
- The lesson course filter applies before pagination/count. A course is required on create, and every publisher (web, panel, scheduler) now refuses a missing or unpublished parent. Stored quiz objects survive shared row normalization for scheduling; lifecycle validation uses stable field codes and readable panel messages.
- Department/team editable and update share one narrow single-row gate, independent of legacy publishedAt. Admins edit the frozen text/color/image fields; department heads and permitted team leads retain their existing row rights and lead precedence. Structural fields are refused for everyone. Queries including status are rejected, updates require If-Match, and lost access is reclassified under the existing lock. Raw legacy descriptions remain unchanged when omitted.
- Org create/delete routes and grants are removed with explicit revocations. The bypass-role helper and tolerated-open S01 cases are gone; route, field, permission, README and diagnostic contracts cover all implemented actions.
- One small field/MIME table feeds the early upload check and existing transactional claims for document.file, course.coverImage, department.headerImage and team.avatar. New images are owned uploads; retained legacy/other-author images remain valid, and removal waits for commit and absence of links. The upload transport retains its 5 MB image cap. Real tests cover each field and a PostgreSQL org attach/delete race; the relink-fallback fixture now uses the genuinely unclaimed user.avatar field.
- GET /api/audit-events is an admin-only fixed read with validated filters, page size 25, exact counts and deterministic ordering. Actor names are loaded in bounded batches with separate user/admin identities and deleted-actor labels; no user/admin object or email is returned. Existing retention and append-only protection remain.

Validation is recorded against disposable SQLite/Postgres databases. Focused controller/gate tests and production/test typechecks pass; independent training, organisation, activity and media reviews found no remaining actionable issue. The complete real HTTP integration run passed all 45 files with 1,042 tests and 32 intentional skips on SQLite and PostgreSQL 16. The full local unit run passed 7,039 tests; two stale structural pins were updated, while six existing Windows SWC-cache/bash failures remain environment-specific. Complete integration and exact-head Linux CI evidence is recorded in the PR.

The web authoring forms, org detail rendering, image upload UI, activity page, report relocation and navigation remain step four. No staging/production deploy, browser acceptance or deploy/rollback/roll-forward rehearsal has been performed. Existing panel-write and request-time role/department races, retained quiz receipts and the section 3 learner limits remain accepted.

## 15. Fourth implementation step: 17B web remainder

The web remainder builds on backend commit fc6e656 and PR #88:

- `/manage/training` now lists courses for admins/editors, with new/edit pages, a nested paginated lesson list and lesson new/edit pages. Nested routes verify the lesson's editable course against the URL. Existing authoring requests, explicit status, If-Match, publish/schedule controls, previews and conflict dialogs are reused. Training has no delete control and discard requires a published version.
- The bounded quiz builder uses question/options inputs, one correct-answer radio group, add/remove controls and the existing domain validator. Ordered quiz comparison now detects nested text/answer changes and question order. Saves/reset use the shared editor baseline. Mode/quiz editing explains retained receipts and the exam limitations; learner pages still use the answerless contract. Course readers display the cover through the existing authenticated upload path, safe Markdown on detail and a plain-text summary on the overview.
- Department/team detail pages expose row-aware edit links. The authoritative editable response supplies one Save form with exact role fields, no publication state and a shared revision conflict flow. Legacy raw descriptions are omitted on unrelated saves; HTML-looking values retain escaped stripHtml display, other text uses safe Markdown. Readers now populate and display department headers and team avatars.
- One image-only option extends the existing file control and upload path for course/org images, including the existing 5 MB limit, removal and server-sniffed MIME refusal. Uploaded IDs survive failed saves and explicit conflict overwrite without uploading twice; existing document uploads retain their role/format rules.
- `/manage/activity` is admin-only with bounded type, actor namespace/id, class and date filters, pagination and distinct invalid/failed/empty states. Local date/time filters are converted with the existing application-zone validation. Audit content is escaped; missing content is not linked.
- The admin report moved to `/manage/training/report`; the manage landing adds training and activity while retaining the three department-author areas. Routine content-manager shortcuts are narrowed; panel access remains for structure, users and permissions. German/English catalogs, skeletons, reader URL snapshots and contracts are updated together.

Focused tests, production/test typechecks, lint, formatting and independent training, organisation, activity and shared-helper reviews passed. The complete local unit run passed 7,212 tests with 153 intentional skips; six existing Windows bash/SWC-cache failures remain, and the same SWC cache validation blocks the local web build. Exact-head Linux CI evidence is recorded in the follow-up PR. No dependencies, authentication transport, CI concurrency or existing completion receipts changed.

Combined browser acceptance and the deploy/rollback/roll-forward rehearsal remain the integration step. No staging/production deployment or release has been performed; the accepted limits in section 10 remain.

## 16. Combined integration review on 2026-10-17

Reviewed main `afcbd51a817236d2259153e0354466e371697640`, covering the complete Batch 17 change from `36c62cf` and its connected callers. PR #90 brought every current Batch 17 branch into main; its tree is identical to the tested web commit `e0429ad`. [All seven checks on main passed](https://github.com/yurtbayemre/sinnlos/actions/runs/39008026613), including the real HTTP suites on SQLite/PostgreSQL 16, the three-zone matrix and both production images.

The review assumes the planned alpha instance with a few dozen users. Four parallel review areas traced input, storage and output, inspected the relevant regressions and ran focused checks:

| Review area               | Checked paths                                                                                                                                                                                                           | Focused checks             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Quiz/player               | Published lesson and parent, answerless responses, current server mode, strict stored-quiz validation, independent feedback/completion, completed exam review, stale/out-of-order/unmount responses, demo/error callers | 8 files, 117 tests passed  |
| Training authoring        | Form through CMS gate, draft/publish/schedule/discard, parent readiness and nested URLs, filter before pagination/count, quiz dirty/save/reset, upload reuse after conflict, existing shared-helper callers             | 17 files, 683 tests passed |
| Organisation/media        | Role and row scope, lead precedence, locked revision checks, status-free saves, structural/query restrictions and revocations, raw legacy text, MIME/ownership/claims/tombstones and cleanup after commit               | 12 files, 179 tests passed |
| Activity/report/contracts | Admin-only fixed activity query/response, bounded actor reads and namespaces, timezone filters, escaped output, pagination/failure/session states, report relocation, navigation, route/grant and message/URL contracts | 10 files, 355 tests passed |

These are per-area results; shared tests occur in more than one selection and are not a unique aggregate. No reproducible new correctness, access-control, data-loss or load issue was found. No application fix, dependency change or speculative refactoring was warranted. This review changes documentation only.

The existing HTTP integration coverage was inspected; the full database/build suites were not repeated locally because the exact reviewed main commit already has green CI and application code is unchanged. No browser walkthrough, staging rehearsal or production operation was performed. The accepted limits in section 10 remain decisions, not new review findings.

Next: prepare and review the exam mode downgrade/restore SQL and deployment instructions, then execute the browser acceptance and complete local staging cycle in section 8. Production deployment and the v0.17.0 release remain gated on that evidence and the owner's deployment go.
