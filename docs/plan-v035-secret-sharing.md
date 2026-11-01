# Secret sharing (v0.35.0): design and plan

Status: planned, not built yet (2026-11-01).

- **Owner request (2026-11-01):** a module that shares secrets, links and passwords, like an internal one-time secret, from user to user. External recipients maybe later; they may be too insecure for now.
- **When:** built as v0.35.0, before v1.0.0-rc.1.
- **Review:** Codex researched the design, then reviewed this plan in five rounds until it approved it (15, 11, 3 and 2 findings, all adopted below).
- **Open:** the owner decisions in section 10, each with its recommended default.

## 1. What it is, and what it promises

A person sends one short text (a password, a link, an access code, a note) to one colleague. The colleague opens it once; at that moment the stored copy is deleted. A share nobody opens expires.

**The promise** (for staff, the data-protection officer and the works council):

- Only the named recipient can open a share, once, while both people are active staff. Other employees, department heads, editors and intranet admins cannot read it through the intranet; there is no admin view of shares and no export of their content. (An `admin_role` who exports a person's data for Art. 15 sees that person's share metadata: counterpart, times, state.)
- The content is stored encrypted. It is deleted from the database when it is opened or revoked. At its expiry (at most 24 hours) it can no longer be opened, and it is deleted at the next successful cleanup (normally within a minute).
- The sender sees whether the share was retrieved (never the content), for 7 days. After that the remaining metadata is deleted.

**What it does not promise** (written into `docs/security.md` and `docs/data-protection.md`):

- **The operator is trusted.** Whoever runs the server (database, `.env` with `ENCRYPTION_KEY`, backups, the running cms) can technically read shares that are still pending. Backups taken while a share was pending keep its ciphertext for the backup's lifetime, together with the key in the `.env` backup; old row versions and the WAL are not a certified erase. This is the same boundary the release plan draws for the whistleblower channel: secret sharing is for everyday credentials between colleagues, not for confidential reports about the company.
- "Retrieved" means the share was consumed by an authorised open attempt of the recipient; delivery of the text is not confirmed, and it never proves that a human read it. A response lost on the way, or a lost database acknowledgement at the moment of opening (the share is consumed, the answer is `busy`), loses the text (at most once).
- After opening, the recipient can copy, screenshot or forward the text. Clipboard, browser extensions and password managers are outside the intranet's control.
- A stolen signed-in session of the recipient can open the share, as with all other intranet content. Sign-out ends every session once the cms confirms the revocation (v0.34.0). Shares survive a sign-out and can be opened after a fresh sign-in.
- Eligibility means the account as stored in the intranet (exists, not blocked, staff role), checked when a share is created, listed and opened; the identity provider's live status is not consulted. If a person is blocked or loses the staff role, their pending shares are cancelled at the next successful cleanup; a block or role loss undone before that cleanup leaves the share pending.
- Notifications are an ordinary admin-visible type: an admin can see in the panel that "A sent B a secret" (never the content).

## 2. Scope

**In v0.35.0:**

- One recipient per share: an active employee with a staff role (`admin_role`, `editor`, `department_head`, `team_lead`, `member`), not oneself. Guests and the fallback role `authenticated` neither send nor receive.
- One plain-text field, at most 8 KiB (UTF-8 bytes). URL, user name and notes go into that text. No separate types, no clear-text label.
- Lifetime 1 hour (default) or 24 hours. Nothing longer, no free date.
- Open = an explicit "Show and delete" click. Viewing the page, previews and prefetches never consume a share.
- The sender: the latest sent shares (paginated) with recipient, created, expiry and state (pending, retrieved, revoked, expired, cancelled); revoke while pending.
- The recipient: a list of pending shares, a bell notification, the open page with a copy button.
- Module switch `secrets` in `FEATURES_OFF`.

**Cut (ponytail):** attachments, rich text or Markdown, clickable links in the revealed text, password generator, editing, resend, view counts above one, several recipients, groups, bulk send, the e-mail digest entry, admin reports, audit events per retrieval, a browser passphrase (option D), per-user key pairs, external recipients, a dedicated key env, cancellation hooks in every block/role write path, a `Referrer-Policy` change (the edge sends `strict-origin-when-cross-origin`; the id is opaque and the page has no outbound links), duplicate edge header rules, a product knob for short lifetimes (e2e moves `expires_at` in the database instead), Redis or a second quota in the web.

**Later, as its own release and review:** external recipients (section 9).

## 3. Design

### 3.1 Protection model

**A:** server-side encryption, access bound to the recipient account, burn after retrieval. A fragment key (B) breaks as soon as the link travels in a notification stored on the server; per-user key pairs (C) need device keys and recovery and do not work for SSO users; a browser passphrase (D) needs a second channel and an honest client, so it waits for a real need.

### 3.2 Crypto contract (frozen in lane D)

- **Key:** HKDF-SHA256 (RFC 5869). Input keying material = the raw UTF-8 bytes of the `ENCRYPTION_KEY` string as configured (never base64- or hex-decoded); salt = the ASCII bytes `sinnlos`; info = `sinnlos/secret-share/v1`; output 32 bytes. Derived once per process.
- **Cipher:** AES-256-GCM (Node `crypto`), a fresh random 12-byte nonce per share, 16-byte tag.
- **Envelope:** `v1.<base64url nonce>.<base64url ciphertext‖tag>`, stored in a `text` column.
- **Additional data:** the UTF-8 bytes of `v1|<documentId>|<senderId>|<recipientId>|<expiresAt as ISO 8601 UTC with milliseconds>`.
- **Key strength:** `env-guard` already refuses placeholders. With the module on and an `ENCRYPTION_KEY` shorter than 32 characters, the cms logs one error line at boot and the module answers `unavailable` (no create, no reveal); the rest of the intranet boots. A key change makes pending envelopes fail to open: such a share turns `cancelled` at the reveal attempt, never `retrieved`. Never rotate `ENCRYPTION_KEY` to purge shares (it also breaks the MFA secrets); purge with the SQL of section 5.

### 3.3 Storage (frozen in lane D)

- Hidden content type `api::secret-share.secret-share`, table `secret_shares`, no draft/publish, no i18n, `pluginOptions` `visible: false` for the Content Manager and the Content-Type Builder.
- Attributes: integer `senderId`, `recipientId` (no relations: no link tables, no traversal from users, explicit privacy queries in section 5); datetime `expiresAt`; enumeration `state` (`pending`, `retrieved`, `revoked`, `expired`, `cancelled`); datetime `terminalAt`; private `text` `envelope` (nullable). `documentId` (Strapi's, created by the query engine with its default) is the opaque id in URLs; `createdAt`/`updatedAt` as usual.
- Indexes (through the index builder of `bootstrap/document-indexes.ts`): `UNIQUE (document_id)`, `(recipient_id, state)`, `(sender_id, created_at)`, `(state, expires_at)`, `(terminal_at)`.
- **Creation sequence** (the additional data needs the id): inside one transaction, insert a metadata-only row (`envelope` NULL) through the query engine, which generates `documentId` in Strapi's format; encrypt with that id; fill the envelope with a conditional update on that row; create the notification. Nothing is visible before the commit, and reveal requires `envelope IS NOT NULL`.
- Accessed only from the module's controllers and janitor through `strapi.db.query` and knex inside transactions. Database lifecycles still run on `db.query`; only the Document Service middleware and its events are bypassed. The rule is therefore: **only the encrypted envelope ever reaches persistence or any subscriber**; the plaintext exists only in the create and reveal request handlers.
- Fresh boot and restart are tested on SQLite and Postgres 16.

### 3.4 Transactions, locks and read-once

- **Lock order** for share transactions: the directory lock (`utils/user-admin.ts`), then the two user rows in ascending id (`lockUserRow` in `utils/mfa-core.ts`), then the share row (Postgres `FOR UPDATE`; SQLite has one writer). Not every existing multi-user writer follows this order (the Content Manager's bulk user deletion locks rows without the directory lock), so a deadlock is possible: it rolls back safely and answers a fixed `busy` code; nothing is claimed beyond that.
- **Fresh caller checks under the locks** (create, reveal and revoke): re-read the caller (exists, not blocked, staff role), compare its token version with the request's (`assurance.tv`), and re-run the existing `mfaDecision` on the fresh row: canonical claims rebuilt from the verified assurance (`mfa: 1` only when it is true, `am` only when valid, otherwise absent), the fresh `role.type` and `totpEnabledAt`, `mfaRequiredRoles()`; only `pass` goes on (a member promoted to editor while the request waited must now meet the editor's MFA rule). No new MFA policy. Create and reveal also re-read the other party (exists, not blocked, staff role); revoke does not, so a sender can always erase a share.
- **Create:** after the fresh checks, count under the same locks: the sender's pending shares (≤ 20), the recipient's pending shares (≤ 20) and the sender's shares created in the last 24 hours in any state (refused when already 100); then the creation sequence of 3.3; commit. The in-process limiter (10 creates per minute per sender, bounded memory like `login-rate-limit.ts`) reserves its slot synchronously before the first await.
- **Reveal:** after the fresh checks, check recipient, state `pending` and expiry with a clock read after the locks (expiry is checked before decrypting); decrypt; then a conditional knex update `SET state='retrieved', envelope=NULL, terminal_at=now WHERE id=? AND state='pending' AND envelope IS NOT NULL` that must report exactly one row (Strapi's single-row `db.query().update()` updates by id after a select, so it is not used here); delete the share's notification in the same transaction. A failed decrypt sets `cancelled` (envelope NULL) the same way and answers `unavailable`.
- **Commit confirmation:** a resolved Strapi transaction does not prove that the COMMIT succeeded (`after-commit.engine.test.ts` shows a failed COMMIT resolving). The handler keeps the knex transaction it was given and awaits its `executionPromise` after the outermost transaction has returned (never inside the callback); the text leaves only when that resolved. On any failure or uncertainty the answer is `busy` and no text leaves. The share is then either still pending or already burned (a lost COMMIT acknowledgement); the handler never compensates by setting it back to `pending`, and "at most once" holds either way. On SQLite a failed COMMIT can leave the transaction open on the connection, so the connection is rolled back or disposed of before reuse (with a recovery test). The same confirmation guards create and revoke results. Raw knex writes are bound to that same transaction.
- **Revoke:** the same locks and fresh caller checks; conditional update from `pending` to `revoked` (envelope NULL, terminal_at); notification deleted; commit.
- **Pings:** a notification created through the query engine already schedules its live ping after the commit (`utils/live-events.ts`); the share transactions add an explicit after-commit ping when they delete a notification (reveal, revoke, cancel, expiry, anonymisation).

### 3.5 Eligibility

Both parties must exist, be unblocked and hold a staff role at create and at reveal (persisted cms state, see section 1). In `list` and `findOne`, a pending share whose other party is not eligible keeps its stored state, is shown as "currently unavailable" and is left out of the recipient's pending inbox; `cancelled` appears only after a committed transition. The other party is shown in every state through the existing blocked-user sanitizer (`utils/sanitize-user-contact.ts`: `{ displayName, blocked }` for a blocked person). The janitor cancels pending shares of ineligible users at its next successful run. Anonymisation deletes transactionally (section 5). No hook in each block or role write path (cut; the semantics are stated in section 1).

### 3.6 Admin panel

- The boot removes every Content Manager grant on this UID from every admin role, read included (extending `bootstrap/hidden-type-permissions.ts`; super admins are reset by Strapi before the application bootstrap, so the removal holds).
- An unconditional denial at the Content Manager's `permission-checker` service: its `create({ model })` factory is wrapped at register time and throws a forbidden error immediately for `api::secret-share.secret-share`, whatever a role is granted later in the panel (an immediate throw, not a sanitizer-only refusal that could come after a workflow write). That one place covers collection and detail routes, bulk actions, relations, history (whose UID comes in the query string), the i18n fill-from-locale route and review-workflow entries, including callers that only use its sanitizer. Preview bypasses that checker, so preview gets a narrow UID denial too; releases already refuse a type without draft/publish. A path or body text scanner is cut (incomplete: query strings, `/i18n/content-manager/…`, percent-encoding). Every route family is tested after a deliberate re-grant. "Hidden" means hidden from the editing UI: the Content Manager's `init`, `content-types` and configuration endpoints still describe the type's schema to admins (never rows); schema secrecy is not a goal.

### 3.7 Notifications

- New type `secretShared` in the schema enum, the domain templates, the cms union and the web union: "{name} hat dir ein Geheimnis geschickt" / "{name} sent you a secret", link `/secrets/{documentId}`, `source*` null. Built with `buildNotification`, written and deleted directly inside the share transactions (not through the catch-all fan-out writer).
- Deleted when the share ends (reveal, revoke, expiry, cancel, anonymisation). Not in the e-mail digest (digest types are selected explicitly; tested).

### 3.8 Janitor

New cron job `secret-share-janitor`, every minute, bounded batches, registered regardless of `FEATURES_OFF` (it is erasure): pending past expiry → `expired`; pending with an ineligible party → `cancelled`; each with envelope NULL, `terminal_at` set and its notification deleted; shares whose sender or recipient no longer exists are deleted in **every state**, with their notifications; ended rows with `terminal_at` older than 7 days deleted. The expected cron set gains one job (ops-check reads it dynamically); docs say "one more job", no global number.

### 3.9 API (cms, users-permissions auth only, no core routes)

| Action       | Route                                                                                                                                                                                                                                                                                                                                                            | Who                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `create`     | `POST /api/secret-shares` `{ recipient, text, lifetime: "1h" \| "24h" }` → `{ id, expiresAt }`                                                                                                                                                                                                                                                                   | staff                 |
| `list`       | `GET /api/secret-shares?sentPage=` → `{ received: [pending, to me, eligible], sent: [mine: pending, and ended ones within their 7-day retention; with terminalAt], hasMore }`, metadata only; `sentPage` a bounded positive integer (validated like `utils/user-admin.ts` pages), 20 per page, ordered `created_at DESC, id DESC`, 21 rows fetched for `hasMore` | staff                 |
| `findOne`    | `GET /api/secret-shares/:id` → metadata for its sender or recipient; anything else 404                                                                                                                                                                                                                                                                           | staff                 |
| `reveal`     | `POST /api/secret-shares/:id/reveal` → `{ text }` once; otherwise 404, or a fixed code (Errors)                                                                                                                                                                                                                                                                  | recipient             |
| `revoke`     | `POST /api/secret-shares/:id/revoke`                                                                                                                                                                                                                                                                                                                             | sender, while pending |
| `recipients` | `GET /api/secret-shares/recipients?q=` → `{ id, displayName, department }` of eligible staff, not oneself                                                                                                                                                                                                                                                        | staff                 |

- Fixed DTOs; `private` does not sanitise raw query results, so nothing else is returned. No `populate`, `fields`, `filters` or `sort` is accepted.
- **Permissions:** six managed actions, 222 → **228**; 30 grants (six actions × five staff roles); explicit revocations for `public`, `guest` and `authenticated`. Snapshots, route matrix, README permission table and `prod-perm-diff.sql` follow. All routes stay outside the restricted-session (MFA pending) allowlist.
- **Headers:** a cms middleware sets `Cache-Control: private, no-store` on `/api/secret-shares` and below, errors included.
- **Errors:** fixed codes (`recipient`, `text`, `lifetime`, `quota`, `gone`, `unavailable`, `busy`); the text is never echoed. The status follows the cause (frozen in `packages/domain/src/secret-share.ts`, `SECRET_SHARE_REFUSALS`): 400 for `recipient`, `text` and `lifetime`; 429 `quota`; 410 `gone`; `unavailable` is 409 while the other party is not eligible (the share stays pending), 503 when the module has no usable key, 410 after a committed cancellation (the envelope did not open); 503 `busy`. `busy` is an unknown outcome: after a create a new pending share and its notification may exist (a lost COMMIT acknowledgement), so the web tells the sender to check the sent list before sending again.

### 3.10 Web

- Pages `/secrets` (pending for me, sent by me, "New"), `/secrets/new`, `/secrets/[id]`, built like kudos (picker from the `recipients` endpoint, de/en messages).
- **Reveal:** an imperative click → Server Action → client state. No `refresh()`, no server props, no progressive form result and no `useActionState` carrying the text; the text appears only in the deliberate action result, never in a rendered page tree. The state is cleared on `pagehide`, on unmount and when a late action result arrives after navigation away. Next adds no-store and its Origin/Host check to action responses (a missing Origin is allowed; a cross-origin one is refused: tested).
- Create and revoke are Server Actions too. The textarea has `autocomplete="off"` and `spellcheck={false}`; the 8 KiB limit is checked in web and cms.
- **Headers:** `next.config.mjs` `headers()` sets `Cache-Control: private, no-store` on `/secrets/:path*`.
- **Logging:** the secret actions do not hand raw errors to `runCmsAction`'s logger: `StrapiError` embeds the upstream body and a malformed success response can put response text into a `JSON.parse` error. A local wrapper maps every failure to a fixed code and logs only the status and that code; Next's control-flow errors (redirect, not-found) pass through untouched.
- **Analytics:** with the module on, the root layout does not render the Plausible script, and `instrumentation.ts` logs one line at start when Plausible is configured; a third-party script must not share a document with revealed text, and client navigation keeps a loaded script alive across pages.
- **Switch:** `secrets` in nav, the path mapping and `proxy.ts` (404 when off); no new notifications are produced when off.

## 4. Module switch everywhere

`packages/domain/src/features.ts` (`MODULE_NAMES`), `apps/cms/src/utils/module-switches.ts`, `apps/web/src/lib/switches.ts` and `nav-config.ts`, the switch allowlist in `infra/deploy.sh` (its preflight rejects unknown names), `infra/.env.example` and the env-examples test, INSTALL's module list. Default on, like every module.

## 5. Data protection and operations

- **`docs/data-protection.md`:** a new data class "Geheimnisse": purpose, who sees what (content: only the recipient, once; metadata: sender and recipient; the notification is admin-visible like every notification), deletion (on retrieval or revoke; at expiry ≤ 24 h refused and deleted at the next cleanup; metadata after 7 days), backups and WAL, the trusted operator, the sender's "retrieved" status (consumed by an authorised open attempt, delivery unconfirmed; a status of this one share, no analytics; to be agreed with the works council), switch `secrets`.
- **Export (Art. 15):** explicit scalar queries (both directions) for sent and received shares as metadata (counterpart, created, expiry, state), never the content; the explanation says why. The export runs through the endpoint where an `admin_role` exports another person's data, so admins can obtain this metadata that way; `data-protection.md` says so. Requests about still pending content: handled by the operator manually, not by a plaintext export. The notification export already copies links (an opaque id, no key).
- **Anonymisation:** explicit scalar deletion of every share the person sent or received and their `secretShared` notifications, in the anonymisation transaction; also in the preview counts and the erasure sweep; with the module off too. Coverage tests gain explicit assertions for the scalar columns, since the relation inventory does not see them.
- **User deleted in the Content Manager** (the guard only stops deleting anonymised accounts): the janitor deletes shares whose sender or recipient no longer exists, in every state, with their notifications; reveal refuses them at once.
- **Restore behind closed doors:** `infra/restore-db.sh` runs a schema-aware purge after `pg_restore` and before it records `S_APPLIED_AT`: every envelope NULL; pending rows `cancelled` with `terminal_at` set; terminal states and existing timestamps kept (idempotent on retries); all `secretShared` notifications deleted; a dump without the table (pre-v0.35) is a no-op. A failing purge stops the restore before `start`. Otherwise a share opened after the backup could be opened again. The isolated restore drill never opens the app and stays as it is.
- **Rollback to v0.34.0 (retag):** remove `secrets` from `FEATURES_OFF` (v0.34 refuses unknown names), retag, then run `infra/diagnostics/secret-shares-rollback.sql`, which deletes **all** rows of `secret_shares` and all `secretShared` notifications (v0.34 has no janitor, so metadata would otherwise stay forever). The empty table and the inert permission rows stay; `forceMigration` stays false. v0.34 writes nothing to the table. The rollback is complete only when the SQL ran successfully; until then v0.34's bell shows those notifications with its fallback icon and a dead link (no digest entry: the digest selects known types).
- **Upgrade:** additive (new table, six permission actions, one notification type, one cron job). No env change. `UPGRADE.md`: the module is on after the upgrade; an operator who wants to wait for the works council adds `secrets` to `FEATURES_OFF` for the upgrade and removes it after agreement (the note informs, it does not enforce consent).

## 6. Tests (release gates)

- **Unit:** HKDF contract vectors, envelope round trip, tampered nonce/ciphertext/additional data, wrong key, unknown version, short key → unavailable; input validation (size in bytes, lifetime values, recipient checks); state transitions.
- **Integration on SQLite and Postgres 16, both required:** every action per role; guests, `authenticated`, `public`, API tokens and MFA-pending sessions refused; another employee and moderators get 404; `populate`/`filters`/`sort` refused; concurrent reveals (exactly one wins); reveal vs revoke vs expiry; a reveal queued behind a block, a sign-out or an anonymisation loses; a member promoted to editor while the reveal waits meets the editor's MFA rule, and valid password, MFA and IdP sessions still pass; a revoke queued behind a sign-out or a block loses, and a sender revokes although the recipient is blocked; a failed COMMIT returns no text and never sets the share back to pending, and a COMMIT that succeeds with a lost acknowledgement leaves the share `retrieved` and answers `busy` without text; on SQLite the next transaction works on the recovered connection or its replacement, and a disposed connection is never reused; a Content Manager bulk deletion of both users racing a reveal (safe rollback, `busy`); transient block/unblock and role loss (documented semantics; "currently unavailable", never `cancelled` before the transition); concurrent creates against the pending cap; the daily cap; key change → cancelled; janitor with the module off, orphans in every state; anonymisation, preview counts, erasure sweep and export (also by an `admin_role`); every Content Manager route family (list, detail, bulk, relations, history, i18n fill-from-locale, review workflows, preview) after a deliberate re-grant; the raw-writers inventory; the permission snapshot (228) and the cron expected set; fresh boot and restart.
- **Sentinel test:** a unique sentinel text is created and revealed, and upstream 500 bodies and malformed JSON containing it are provoked; afterwards it appears in no database table, no captured cms or web log line, no audit event, no notification, no search index, no export, no server-rendered HTML and no refreshed RSC payload.
- **Restore tests** (stub and real Postgres): purge with and without the table, a retry, a failing purge that stops the restore.
- **Production headers:** `Cache-Control: private, no-store` on `/secrets*` pages, their redirects and errors, and the module-off responses; on `/api/secret-shares*` including errors (the header string may differ, the policy may not).
- **e2e (Playwright, disposable harness):** send, bell, the page shows no text before the click, reveal, reload shows "already retrieved", a second browser context loses the race, revoke, expiry (the harness moves `expires_at` in the database; the test asserts the expiry outcome, since the moved time also no longer matches the additional data), back/forward after reveal shows no text, a late reveal response after navigation is dropped, no `/secrets` for a guest, cross-origin action refused; one case with live events on, through an explicit fixture (the harness runs with live events off today, `e2e/cms-start.mjs`).

## 7. Documentation

`security.md` (the promise and its limits, read-once semantics, the crypto contract, admin closure), `data-protection.md` (section 5), `INSTALL.md` (module list, Plausible note), `UPGRADE.md` (v0.35.0 section, rollback SQL), `OPERATIONS.md` (janitor, restore purge, never rotate the key to purge), `architecture.md` and the conventions file, README permission table, `v1-release-plan.md` (this item before rc.1), the in-app help text (de/en).

## 8. Work breakdown

| Lane                    | Content                                                                                                                                                                                                                                                             | Size (opinion) |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **D: contract** (first) | `packages/domain`: module name, states, lifetimes, limits, error codes, DTO types, notification type and templates; frozen: physical schema and indexes, id and additional-data encoding, the HKDF contract, notification creation/cleanup                          | 1 day          |
| **C: cms**              | content type, crypto, routes/controllers/policies, permissions and snapshots, limiter and caps, the locked transactions, recipients endpoint, janitor, notifications, export/anonymisation/erasure, admin closure, cms headers, integration tests on both databases | 5–7 days       |
| **W: web**              | pages, Server Actions with the local error wrapper, picker, client-only reveal, headers, Plausible rule, nav and switch, bell rendering, i18n, e2e                                                                                                                  | 3–4 days       |
| **O: ops and docs**     | `deploy.sh` allowlist, env examples, restore purge and its tests, rollback SQL, all docs                                                                                                                                                                            | 1–2 days       |

One integrator owns the shared inventories (permission matrix, switch lists, notification unions, the raw-writers inventory, version manifests, docs, translations). Then the whole-release Codex review; staging rehearsal: upgrade, send and consume, restore of an earlier backup → the consumed share stays closed, rollback with the rollback SQL, roll forward. Deploy, tag v0.35.0. Total roughly 10–14 days of work. The rc.1 soak starts after v0.35.0 is live.

## 9. External recipients (later)

Not in v0.35.0, and no dormant code for it. A later release would need its own review and at least: a public page and an unauthenticated claim route (both edges, Caddy and Traefik), a bearer link with the key in the URL fragment so the server stores only ciphertext, an optional passphrase sent another way, a shorter maximum lifetime, the same "click to reveal" rule tested against real mail and chat link scanners (Outlook Safe Links, Teams), creation only by signed-in staff with stricter quotas, no attachments or HTML (the company domain must not become a phishing host), and a data-protection entry for external recipients. The v0.35 state machine and versioned envelope let that be added without a redesign.

## 10. Owner decisions (with the recommended default)

1. **Trust boundary:** the operator is trusted (option A). _Default: yes._ If protection against the operator is a must, this design stops here.
2. **Who:** staff only, no guests. _Default: yes._
3. **Lifetime:** 1 hour default, 24 hours maximum. _Default: yes_ (alternative: a 7-day maximum, with longer backup residue).
4. **Sender sees "retrieved" (with time) for 7 days** (consumed by an authorised open attempt; delivery unconfirmed). _Default: yes,_ as a status of this one share, agreed with the works council; alternative: no status at all.
5. **Module on after the upgrade** (like every module), with the `UPGRADE.md` note. _Default: on;_ on the owner's instance on.
6. **Plausible off while the module is on.** _Default: yes_ (only matters when Plausible is configured).
7. **Key:** derived from `ENCRYPTION_KEY`. _Default: derived_ (the plan review found it sound with the stated contract; a dedicated key is not worth another mandatory upgrade secret).
8. **External recipients:** later, as their own release. _Default: later._
9. **Name in the UI:** "Geheimnisse" / "Secrets". _Default: yes._
