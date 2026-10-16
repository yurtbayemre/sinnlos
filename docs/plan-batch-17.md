# Batch 17 implementation plan

> Phase 3 of v2 frontend authoring (plan 12). Written 2026-10-16 against main 2f47b84fcadfd6f63ecffac1c78cdf388c5ea44d, released as v0.16.2.
> Status: reviewed planning draft; application implementation has not started. Decision 06 remains the approved scope; section 3 specifies the new exam-mode amendment and its proposed defaults. Review corrections are recorded in section 11.
> Paths: cms/ = apps/cms/src/, web/ = apps/web/src/, domain/ = packages/domain/src/. Paths outside those roots are written in full.
> This plan records the implementation baseline; it does not verify the running server. Application work has not started.

## 1. Outcome and scope

Editors and admins can author courses, lessons and quizzes in the web. Department heads and team leads can edit the organisational descriptions they are responsible for. Admins can read the existing content activity trail in the web. The remaining content-API payload bypasses disappear.

The implementation reuses the write gate, allowlist, document revision and lock, scheduler, audit recorder, media claims, form kit and shared training validators from batches 15 and 16. It adds no dependency, replacement form system, general workflow engine or new role system.

| Area                 | Batch 17 delivers                                                                                             | Boundary                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Training authoring   | Course and lesson forms, quiz builder, draft/preview, publish/unpublish, scheduled publish, safe discard      | admin_role and editor; deletion stays in the panel                               |
| Training player      | An explicit exam mode with server grading and no answer keys in learner responses                             | Existing confirm and quizGate learning modes keep their behavior                 |
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

| Finding on v0.16.2                                                                                                                                                                                                                       | Consequence for this plan                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Both existing completion modes already require correct answers at the CMS, but the browser receives correctIndex. cms/api/lesson-progress/controllers/lesson-progress.ts:49 and web/components/training/quiz-block.tsx:25 document this. | Add an explicit exam value. Do not relabel existing quizGate courses or remove completionMode.                                   |
| domain/training.ts:134–172 parses defensively by dropping invalid questions; an empty parsed quiz passes completion.                                                                                                                     | Exam grading validates stored data strictly and refuses malformed content; it must not grade a permissively parsed subset.       |
| Organisation types are single-row, while write-gate.ts:205–251 expects a draft twin and authoring/http.ts:63 has only explicit/alwaysPublished status modes.                                                                             | Add the narrow single-row loading/update path. Do not invent drafts or pass a status into org writes.                            |
| Locks, revision counters, schedules and audit already cover course/lesson; locks and audit already cover department/team. cms/utils/authoring-uids.ts:79 and bootstrap/document-middlewares.ts:112.                                      | Extend the existing authoring surface, not these infrastructures.                                                                |
| Media claims currently cover only document.file (cms/utils/media-claims.ts:75); ownUploadCheck uses document MIME types (authoring-checks.ts:207).                                                                                       | Add image-only course.coverImage, department.headerImage and team.avatar, including upload permissions and per-field validation. |
| The remaining open payload exceptions are department and team (cms/routes.matrix.test.ts:644).                                                                                                                                           | Migrate both gates and revoke both route pairs before deleting WRITE_BYPASS_ROLES and KNOWN_OPEN_PAYLOADS.                       |
| The existing training report occupies /manage/training (web/app/(app)/manage/training/page.tsx:45). Activity has storage but no API controller/router.                                                                                   | Move the report; implement a bounded activity read, not another recorder.                                                        |
| The old phase-3 plan promises no schema change and a plain rollback. Exam adds an enum value and a private quiz contract.                                                                                                                | Record the schema/API amendment and prepare a compatible rollback pair; unpatched v0.16.2 is unsafe after exam content exists.   |

Pinned framework baseline: Strapi 5.57.0 and Next 16.4.2, as declared by the application packages. Before implementation, each worktree installs the frozen lockfile with corepack pnpm and builds the domain package. Any dependency-source evidence must come from those installed versions, not stale node_modules in an old worktree.

## 3. Exam-mode amendment

### 3.1 Product behavior

Proposed default: add completionMode = exam alongside confirm and quizGate, leaving stored courses and the default confirm unchanged. Confirm keeps instant learning feedback; quizGate keeps its current batch feedback. Exam collects one option per question and submits the complete answer set to the CMS. Only a successful server result records completion. Failures return a general not-passed result, with no correct answer, wrong-question indices or explanations.

Retries are unlimited and there is no clock. This is an assessment without pre-delivered solutions; it does not prove identity, prevent collaboration or make repeated guessing impossible. The optional product question sent on 2026-10-16 concerns time/attempt limits; until answered this remains the recommended planning default, not an additional owner decision.

A lesson without a quiz still completes manually. An invalid nonempty quiz cannot become a no-quiz lesson through defensive parsing. A course need not gain a new minimum-quiz-count gate. Existing completion receipts remain valid after quiz, order or mode changes, as approved in decision 06. The authoring form makes that limitation visible.

Completed exam lessons never switch to the current instant-feedback review component and never reveal their key. Switching an already-published learning course to exam cannot withdraw answers readers already received; authors need new questions when secrecy matters.

### 3.2 One private stored field, one learner response

Mark raw lesson.quiz private in the CMS schema. That applies to generic content-API reads for every role, including nested lesson relations. The authorised editable authoring DTO reads the raw field internally and returns it only to training authors; panel editing remains available.

Add GET /api/lessons/:id/player, with grants limited to the roles that currently read lessons. It is a fixed response, not a generic query builder:

- Resolve the canonical documentId, the published lesson and its published owning course on the server. Missing, draft-only, orphaned and unpublished-parent targets are indistinguishable unavailable responses.
- Accept no status, fields, filters, sort, populate or client-selected completion mode.
- Return the lesson's readable content, the course's documentId/title/slug/completionMode, and a discriminated quiz DTO. Learning modes return the existing question/options/correctIndex shape. Exam returns only question and options.
- Return lessonVersion and courseVersion as opaque decimal strings from the existing content-version counters. Build content and version data from a coherent read under the same locks used for exam submission; no revision from one state with content from another.
- Use explicit selection for every returned object. Never spread raw database rows, the submitted body or the quiz into the exam DTO.
- Do not cache this response or serialize authoring DTOs into learner pages.

The normal lesson page uses this endpoint instead of relying on generic lesson.quiz. Course outlines and reports keep their existing reads. The reader type separates answerless exam questions from author/learning QuizQuestion; parseQuiz must never discard answerless exam questions.

**Implementation gate before the contracts freeze:** prove on pinned Strapi that schema-private quiz is absent from direct and nested generic reads and cannot be inferred through fields, filters, sorting, search or populate subqueries. Exercise array/JSON query shapes as well as ordinary attribute paths. If the framework leaves a query path open, extend the existing schema-aware query guard narrowly for lesson.quiz. Output removal alone does not close a filter oracle. Also prove the custom player, author editable and Content Manager behavior. This gate uses local fixtures only.

### 3.3 Grade and receipt in one request

Keep POST /api/lesson-progresses as the completion endpoint. The caller's user id and the current published mode come from the CMS.

For player submissions (the current exam mode always requires these preconditions):

1. Validate the target and bounded answer array before grading; take the existing lesson/course revision locks inside one transaction and re-read the published rows and owning relation.
2. Whenever either lessonVersion or courseVersion is supplied, require and compare both before choosing the grading branch. Current exam mode always requires both, even for a tokenless legacy request. Missing required tokens return 428; changed content, parent or mode returns 412 and asks the player to reload. It never writes a receipt. The new player sends both tokens in every mode; tokenless legacy requests remain compatible only while the current published mode is a learning mode.
3. Validate the stored quiz strictly. Null/empty is a legitimate manual-completion lesson; malformed nonempty data is a content error, not a pass.
4. Grade all questions on the server and write the receipt only when all answers are correct. A client passed flag, forged mode or actor is ignored/rejected.
5. Return the existing completion success information through a fixed response. A failed assessment returns only a stable quizNotPassed code. Do not store answers or create an attempt-history table.

The action must inspect current mode under the same protection even when a stale client submits the old learning payload. Both learning-to-exam and exam-to-learning transitions are tested; supplied stale tokens cannot be skipped by choosing the new mode's branch. Reuse existing locking and conflict conventions. Fix an acquisition order and prove it against lesson publish/reparent and course publish/unpublish/delete; do not add a general lock manager. A deadlock/serialization failure is surfaced as a retriable failure and writes no receipt.

Draft-only saves may conservatively invalidate the counters; explain the reload rather than adding a second revision system. Old completions still deduplicate by stable lesson documentId. Do not turn this into the unrelated duplicate-receipt cleanup.

Stable error codes, domain exports, web mappings and both translations land together. Preserve legacy learning feedback and completion paths through this change.

**Second exam implementation gate: inverse course writes.** The current document lock advances only the mutated document (cms/utils/document-lock.ts:578,590), and lesson readiness applies only to lesson mutations. There is no application-level propagation from course.lessons changes to a lesson revision. On pinned Strapi, probe a panel mutation of course B that attaches a lesson currently in A while the player/grader holds A and the lesson locks; include update, publish, clone and discard where they rewrite incoming links. Verify the published owning relation, blocking and revision changes. If an inverse writer can change the relation without participating, make that narrow path lock and advance the affected lesson revisions using a tested compatible acquisition order before relying on the player/submission snapshot. Preserve panel functionality; do not invent a general relationship-lock framework. The fix and its race tests belong to the isolated exam foundation and therefore to the rollback pair. Until this passes, coherence under inverse writes is an unproven prerequisite, not a guarantee.

### 3.4 Rollback compatibility

A plain retag to unpatched v0.16.2 after creating exam content would expose raw quizzes again and interpret the new mode incorrectly. Neither unpublishing a course nor hiding a web button proves all old generic API paths safe.

Keep the exam foundation as an isolated, complete compatibility commit: enum/private schema, fixed player contract, submission protection, grants/guards, and learner-web adaptation for all three modes. Keep the three new media-claim fields as a second isolated safety patch. Before batch 17 can deploy, build and rehearse a rollback CMS/web pair based on v0.16.2 that retains both patches but omits the new authoring/org/activity work. Otherwise existing stamped course/org images could again be attached after their bytes were removed. The pair is a known commit with its own green CI and immutable image tags, not tags assembled during an incident.

The rollback rehearsal must include a published exam and progress written on batch 17. If the compatible pair cannot be made to work, the release has no approved rollback path and must not deploy until that is resolved. Fix-forward is an operational alternative, not a reason to claim a tested rollback.

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

The exam player uses answerless questions, a submit/pending state and server result. It can require every question to have a selection locally, but cannot decide correctness. On conflict it asks to reload; transport failures preserve entered answers without marking completion. The learning modes retain current feedback. All modes preserve keyboard behavior, accessible field labels and announcements for errors/results.

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
| Integration           | Combined review, compatibility rollback images, staging rehearsal, final docs, PR/release/deploy brief                                                                                          | Owns the final integrated state                                                      |

The exam foundation spans backend and learner web. 17A and 17B coordinate it as one independently usable commit before either builds the remaining authoring features. One named owner assembles that commit; the web owner hands over its files. Both generic privacy and learner adaptation must land together.

### Shared-file register

- 17A owns cms/utils/{write-gate,write-allowlist,authoring-controller,authoring-checks,authoring-uids}.ts, the permission matrix, media field registry and bootstrap wiring/tests.
- 17A owns domain/authoring/{fields,http,dto,codes,validators}.ts and domain/training.ts/index.ts, plus the org/learning/exam DTO definitions. Reuse existing files; add a module only when it holds substantive cohesive logic.
- 17A owns web/lib/roles.ts and role parity. It adds stable-code mappings and common German/English texts with the pure contracts, then explicitly hands the error/text files to 17B. Actual capabilities, grants, snapshots and parity changes land only with their implemented guarded endpoints: player in the foundation; training/org/activity in the backend remainder.
- 17B owns manage components/actions/loaders/API modules and the reader API/types/player, except the coordinated exam foundation commit.
- 17A owns S01 route pins, permission snapshots, policy contracts, removed-routes, read-exposure and role-read snapshot changes. 17B owns URL snapshots, message tests, page/access/form tests.
- 17A updates README permission tables and diagnostic queries with the matrix. Integration reconciles architecture/security/deployment/roadmap prose at the end.
- Neither lane changes dependencies, auth/session transport, worktree cleanup, CI worker limits or unrelated application features.

### Contract register

| Contract                                                                          | Freeze                                                                 |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Training intents, fields, explicit status, no-delete and nondeleting discard      | 17A contracts commit                                                   |
| Lesson authoring list course filter, list/editable DTO including order and parent | Same                                                                   |
| Player discriminated quiz DTO, exam preconditions, pass/fail/conflict errors      | Privacy probe, then exam foundation                                    |
| Org single-row editable/update DTO, exact role fields, no status query            | Single-row probe, then contracts commit                                |
| Per-field image MIME/capability rules and upload response                         | Same, with registry and allowlist atomic                               |
| Activity filters, vocabulary and response                                         | Same                                                                   |
| New codes plus web mappings/translations                                          | Pure contracts commit; no premature runtime capability                 |
| Actual grants, capabilities and parity/snapshots                                  | Atomically with each implemented guarded endpoint, never a placeholder |

Merge sequence: reviewed probes and pure contracts (DTOs, codes, fixtures and interfaces only) → complete exam foundation → isolated media-claim safety patch → 17A backend remainder with its grants/capabilities → 17B web remainder → integration. No contracts commit grants unimplemented actions or advertises an unusable capability. Every merge point builds and keeps its existing tests green. Use fixtures/mocks for web development until the guarded backend contract exists.

Each lane follows implementation → focused tests → Ponytail simplification → independent adversarial review → fixes → lane rehearsal. Integration receives another review and combined rehearsal. The existing eight-worker integration limit stays; only one full integration run on the shared host at a time. Every eventual lane uses its own worktree. No implementation worktree is needed just to write this plan.

## 7. Required checks and acceptance

| Surface              | Acceptance evidence                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Training authoring   | admin/editor create/edit/publish/schedule; other roles refused; unsupported delete 405; inverse/unlisted fields rejected; numeric id compatibility where already supported; missing/stale If-Match; panel writes invalidate web forms                         |
| Draft safety         | Never-published and unpublished course/lesson discard returns 400 and preserves rows/links; draft quiz clear leaves published version intact; published parent required through web, panel and scheduler                                                      |
| Exam confidentiality | Direct, fields, filters, sort/search, nested relation/populate and custom read probes show no raw exam key; player ignores forged mode; completed-exam review remains answerless; author editable/panel can edit keys                                         |
| Exam correctness     | Correct/incorrect/missing/out-of-range answers, legitimate no-quiz lesson, corrupt stored nonempty quiz, forged actor/passed flag, stale lesson/course/mode/parent including both learning↔exam transitions, failed receipt insert and publish/reparent races |
| Existing learning    | confirm instant feedback, quizGate batch feedback, no-quiz completion, lesson/video rendering and historical receipts unchanged; old generic quiz consumers migrated                                                                                          |
| Organisation         | Exact role/row fields; editor cannot gain org admin rights; structural fields refused even for admin; single-row with either legacy publishedAt shape; all status/query inputs rejected; POST/DELETE 405; current grants and revocations                      |
| Images               | Own/foreign/taken/unstamped-retained/wrong-type/tombstoned files; 5 MB limit; draft/published and single-row replace/remove; cleanup only after commit; one Postgres attach/delete race using an org field                                                    |
| Activity             | Admin-only even when called directly; closed generic query surface; filters/counts/order/page bounds; duplicate timestamps; overlapping admin/user ids; deleted actor/content; system/file/classified events; no PII objects or writes                        |
| Web                  | Role/row presentation, session expiry and CMS failure, conflict reload/overwrite, quiz dirty/save/reset and boundaries, nested parent mismatch, keyboard use, localized errors, report relocation, visible saved org media and descriptions                   |
| Contracts            | Routes/grants/policy pins, README permission table, prod-perm-diff, no stale exceptions, domain exports, URL snapshots, i18n/ICU parity, loading-file convention                                                                                              |

Use the existing Vitest suites and real Strapi HTTP harness on SQLite and Postgres 16. New tests target behavior and trust boundaries, not mirror implementations. Extend existing lesson-progress-quiz, authoring, read-exposure and media suites before introducing overlapping harnesses. The authoring helper currently sends status by default; org tests must omit it and also prove rejection when it is present.

Integration runs the required lint/typecheck/unit/integration/TZ/build checks from the existing package/CI scripts once for the final state. Re-run only when changes or failures justify it. Browser walkthrough is a separate staging acceptance check; do not claim it from unit results.

## 8. Deploy and rollback rehearsal

This batch needs the full rehearsal because exam compatibility makes rollback more than a plain retag. Use the existing local Postgres staging and deployment machinery.

1. Seed a v0.16.2 stand-in with existing confirm/quizGate courses, completed users, draft-only/unpublished lessons, org text/media and audit events. Record counts and file links without answers or credentials in logs.
2. Rehearse the compatible rollback pair from section 3.4 with both exam foundation and media-claim safety patches; record immutable tags and its exact green CI commit.
3. Deploy batch 17. Check schema/private-field behavior, permission drift against the actual matrix, revocations, routes, boot/scheduler logs and CMS/web health. The new enum/private attribute is a schema change even if it needs no table rewrite; verify database behavior rather than assuming it.
4. Run the complete path: editor authors a course, video lesson and quiz lesson, schedules/publishes, member completes; edit quiz and preserve prior progress. Repeat with exam, failed answers, success, stale player, completed review and direct API key probes.
5. Exercise organisation head/lead/admin edits and image replacement; verify structural panel fallback. Activity shows web, panel, scheduler/system and deletion events with working filters. Run the read-only admin-panel-permissions diagnostic.
6. After new exam content and progress exist, roll back to the compatible pair. Recheck exam secrecy/operation, preserved progress/media, image replace/delete and tombstoned attachment refusal, old authoring boundaries and effective grants. The old organisation create/delete surface is an explicit restored boundary.
7. Roll forward to batch 17. Recheck grant pruning/recreation, progress, drafts, files and activity. No answer-key exports or destructive data rewrites are part of this cycle.

Before deploying remotely, ask the deployment session for its current live tag; the handoff can go stale. Require a current backup, clean preflight, exact-commit green CI and a brief naming target/compatible rollback tags, schema/permission changes and the owner's browser steps. The owner gives the deploy go in the deployment session. Rollback, DB writes, .env changes and destructive cleanup retain their existing explicit-approval rule.

The release notes state the reviewed training-write exception, exam semantics/limitations, org route removal, report URL change and panel fallback. After successful deployment/report, create the annotated v0.17.0 tag and GitHub release per the standing release rule. package.json remains at its existing version until the separate v1.0.0 decision.

## 9. Files and fixtures to carry through

The lane lists are responsibilities, not a request to create every named file:

- cms/api/{course,lesson,lesson-progress,department,team,audit-event}/\*\*, their schemas, custom routes and lifecycles.
- cms/policies/{can-edit-department,can-edit-team,training-visibility}.ts and relevant tests; existing query guards only if the privacy probe proves a gap.
- cms/utils/{training-validation,write-gate,write-allowlist,authoring-controller,authoring-checks,authoring-uids,media-claims}.ts and focused tests; existing lock/readiness helpers as reused by exam grading.
- cms/bootstrap/{permission-matrix,document-middlewares}.ts; index registration only if a targeted guard needs it; roles/policy/route/registry tests and snapshots.
- domain training and authoring types/constants/validators/DTOs/exports; no replacement validator.
- web reader training API/types/loaders/player/actions, org API/types/detail renderers, manage API/actions/loaders/components/pages, roles/parity, navigation and message registration.
- Existing training report imports and web/lib/strapi-urls.test.ts snapshot; use-item-editor.ts ordered quiz comparison; both locale files and new-page skeletons.
- cms integration fixtures using generic raw quiz reads, lesson snapshots, removed-routes assertions and helper status defaults. Keep fixtures valid through published parent readiness. media-claims.integration.test.ts:353–375 currently expects a tombstoned department attachment to succeed: change that case to refusal, and retain the removeReserved relink-fallback coverage using a genuinely unclaimed field. Update upload-orphans.ts's associated coverage comment.
- README.md, docs/{architecture,security,DEPLOYMENT,ROADMAP}.md, infra/diagnostics/{prod-perm-diff,admin-panel-permissions}.sql and diagnostic README.

## 10. Completion gates for the plan and implementation

The implementation can start from this reviewed plan, with section 3's unlimited-retry/no-clock choice explicitly retained as the proposed default unless the owner changes it. The privacy and single-row probes are implementation tasks with stop conditions; their success is not claimed here.

Before production deployment, the compatible rollback pair, CI and full rehearsal are mandatory. Current accepted limits remain: panel saves do not carry If-Match and may overwrite a web change; panel structural/media privileges remain; quiz edits do not revoke receipts; unlimited retries permit guessing; in-flight role/team changes retain the existing request race.

Planning validation: repository/decision inspection and independent review only. No application code, dependencies, schema, database, production state or existing completion was changed while preparing this document.

## 11. Plan review on 2026-10-16

Three independent read-only reviews covered training/exam behavior, organisation/media/activity and the web/contracts. The following corrections are incorporated:

- Validate supplied revision tokens before the mode branch, including exam-to-learning transitions.
- Compare quiz objects and their order correctly so edits are not silently treated as clean.
- Keep pure contract changes separate from runtime grants/capabilities; activate endpoints and their rights together.
- Check nested lesson parent URLs and omit an unnecessary web move control.
- Preserve raw legacy organisation descriptions on unrelated saves and keep their safe existing display.
- Carry the new media claims into the compatible rollback pair and move the old tombstone fixture to the right invariant.
- Keep shared MIME data independent of middleware and pass the field identity into early checks.
- Prove or repair inverse course-to-lesson lock/revision participation before relying on a coherent exam snapshot; retain that fix in the rollback foundation.

These are plan corrections, not executed tests. The Strapi privacy probe, publication/reparent races and real rollback images remain explicit implementation/rehearsal gates.
