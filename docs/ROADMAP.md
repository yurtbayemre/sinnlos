# Sinnlos Feature Roadmap

Implementation plan for the 10 most-requested intranet features that Sinnlos
does not have yet, based on market research (Staffbase, Workvivo, Sociabble,
Simpplr, MangoApps feature guides, June 2026).

## Why this is cheaper than it looks

Three architectural decisions already made carry most of the weight:

1. **Per-user Strapi JWT on every request** — `apps/web/src/lib/strapi.ts`
   injects the session's Strapi JWT into all fetches. Authenticated *writes*
   (comments, votes, kudos) need zero new auth plumbing: a Server Action
   calling `strapi()` with `method: "POST"` just works, and Strapi knows who
   the author is.
2. **Session knows role + department** — `apps/web/src/auth.ts` puts
   `user.role` and `user.department` on the session, so content targeting and
   personalization are filter expressions, not new infrastructure.
3. **Graph enrichment hook** — `apps/cms/src/extensions/users-permissions/strapi-server.ts`
   already syncs profile data from Microsoft Graph at sign-in. The directory
   and celebrations features extend this hook instead of building a sync job.

Every new content type follows the same recipe:
schema in `apps/cms/src/api/<name>/`, permissions added to the
`PERMISSION_MATRIX` in `apps/cms/src/index.ts`, fetch helper in
`apps/web/src/lib/strapi.ts`, types in `apps/web/src/lib/types.ts`, page under
`apps/web/src/app/(app)/`.

---

## Phase 1 — People & conversations (the foundation)

### 1.1 Employee directory + org chart

**Value:** consistently a top-3 most-used intranet resource. We already store
users with `displayName`, `jobTitle`, `department`, `teams`, `avatar`.

**CMS**
- Extend `user/schema.json`: `phone`, `officeLocation`, `manager`
  (self-relation `manyToOne` → user), `hireDate` (date), `birthday` (date,
  `private` until consent decided).
- Extend the Graph enrichment in `strapi-server.ts`: fetch
  `/me?$select=...,businessPhones,officeLocation` and `/me/manager` (needs no
  extra scope beyond `User.Read` for self; manager lookup uses
  `User.Read` → returns manager via delegated read). Map the manager by
  `microsoftOid` if that user exists, otherwise leave null and let the next
  sign-in of the manager backfill.
- `PERMISSION_MATRIX`: grant `plugin::users-permissions.user.find`/`findOne`
  to all roles (field-level privacy via `private: true` on sensitive fields).

**Web**
- `/people` — searchable, department-filterable card grid (client-side filter
  over one paginated fetch is fine below ~2k employees).
- `/people/[id]` — profile page: contact info, department, teams, manager
  chain, recent wiki edits.
- `/people/org-chart` — tree built from the `manager` relation. Pure
  CSS/flexbox tree first; only reach for a library (e.g. `react-flow`) if the
  hierarchy gets deep.
- Sidebar + mobile nav entry, search-command integration ("jump to person").

**Effort:** ~3–4 days. **Depends on:** nothing.

### 1.2 Comments & reactions

**Value:** turns announcements (and later wiki pages) from one-way into
two-way communication. Prerequisite for recognition (1.3 reuses the pattern).

**CMS**
- New `comment` content type: `body` (text), `author` (relation → user),
  `target` (string, e.g. `announcement:42` — Strapi v5 has no polymorphic
  relations; a typed string key keeps it one content type for all targets),
  `parent` (self-relation for one level of replies).
- New `reaction` content type: `emoji` (enum: 👍 ❤️ 🎉 💡 😄), `author`,
  `target` (same key scheme). Unique-per-(author,target,emoji) enforced in a
  `beforeCreate` lifecycle hook.
- Custom controller or lifecycle to force `author = ctx.state.user` on create
  (never trust the client) and restrict update/delete to the author
  (+ moderators/admins).
- `PERMISSION_MATRIX`: all roles get `find`/`create` on both; `delete` own.

**Web**
- `CommentThread` + `ReactionBar` client components; Server Actions
  `addComment`, `toggleReaction` in `apps/web/src/lib/actions.ts` using the
  existing `strapi()` client, then `revalidateTag("announcements")`.
- Mount on the announcements page first; wiki pages second.

**Effort:** ~3 days. **Depends on:** nothing.

### 1.3 Employee recognition (kudos + celebrations)

**CMS**
- New `kudos` content type: `from` (user), `to` (user), `message`,
  `value` (enum of company values — configurable later).
- Celebrations are derived data: birthdays/anniversaries computed from
  `birthday`/`hireDate` added in 1.1 — no new type, just a custom route
  `GET /api/celebrations?window=7` that returns upcoming ones.

**Web**
- "Give kudos" modal (user picker reuses directory search from 1.1).
- Dashboard widgets: kudos feed + "Celebrations this week".

**Effort:** ~2 days. **Depends on:** 1.1 (user fields, picker), 1.2 (write
pattern, reactions on kudos).

---

## Phase 2 — Reach (calendar, notifications, targeting)

### 2.1 Events calendar

**CMS**
- New `event` content type: `title`, `description` (richtext), `start`,
  `end`, `allDay`, `location`, `url`, `departments` (m2m, empty = company-wide).
- Draft & publish enabled (same as announcements).

**Web**
- `/events` — month grid (custom component; a month grid is ~100 lines and
  avoids a calendar-library dependency) + agenda list for mobile.
- Per-event **ICS download** (`/api/events/[id]/ics` route handler) so it
  lands in Outlook — this covers 90% of the "calendar sync" ask without
  touching Graph write scopes.
- Dashboard widget: next 3 events.
- *(Later, optional)* push events into Outlook calendars via Graph
  application permissions — separate decision, needs admin consent.

**Effort:** ~3 days. **Depends on:** nothing (targeting filter shared with 2.3).

### 2.2 Notifications

**Phase A — derived, no fan-out (ship first):**
- Bell icon in the topbar with unread count = announcements/events/kudos-to-me
  newer than `user.lastSeenNotificationsAt` (new datetime field on user).
  One aggregated route handler computes this; opening the panel updates the
  timestamp. No queue, no per-user rows, scales fine.

**Phase B — real notification rows (when mentions arrive):**
- `notification` content type (`recipient`, `type`, `title`, `link`,
  `readAt`) created by lifecycle hooks (`afterCreate` on announcement →
  notify targeted users; on comment reply → notify parent author; on kudos →
  notify recipient).
- Email digests via Strapi's email plugin + SMTP env vars (`EMAIL_SMTP_*` in
  `.env.example`), sent by a cron job (`config/cron-tasks.ts`) — daily digest,
  not per-event spam.

**Effort:** A: ~1–2 days, B: ~3 days. **Depends on:** the content types it
notifies about (1.2, 1.3, 2.1).

### 2.3 Targeted content / personalization

**CMS**
- Add `departments` (m2m) + `audience` (enum: `all` | `departments`) to
  `announcement` (and reuse on `event`).

**Web**
- Announcements/dashboard queries gain
  `filters[$or][0][audience][$eq]=all&filters[$or][1][departments][id][$eq]=<sessionDeptId>`.
  These fetches become per-user → switch them to `noCache: true` (same
  reasoning as the wiki-visibility comment in `strapi.ts`).
- Optional server-enforced variant later: a route policy like the existing
  wiki-visibility policy, so targeting is security, not just UX.

**Effort:** ~1–2 days. **Depends on:** nothing technically; pairs with 2.1/2.2.

### 2.4 Live updates via SSE (research + implementation)

**Value:** changes made by one session (comments, reactions, later
notifications) appear in other open sessions in under a second. Since
2026-06-12 the `LiveCommentSection` covers this with 10-second
visible-tab polling — works, but latency is up to 10s and every open page
polls in steady state. A server-push channel (Server-Sent Events) cuts
latency to near-instant and removes the steady-state polling. SignalR-class
functionality, self-hosted, no extra service.

**Current state this builds on:**

- `apps/web/src/components/comments/live-comment-section.tsx` already owns
  the comment/reaction data client-side: refetch after own mutations +
  10s visible-tab polling via the `getCommentSection` Server Action.
- The CMS already pushes webhooks to the web container:
  `apps/cms/src/utils/revalidate.ts` (wiki-page lifecycles →
  `POST WEB_INTERNAL_URL/api/revalidate` with `REVALIDATE_SECRET`). The
  SSE emit side is the same pattern with a different endpoint.
- Single web instance → an in-memory pub/sub in the Next server is enough;
  no Redis, no Centrifugo.

**Research spike (~0.5–1 day, answer before building):**

1. SSE from a Next.js 16 standalone route handler: `ReadableStream`
   lifetime, abort/cleanup per connection, memory per idle connection.
2. Traefik long-lived responses on the sinnlos router: which
   `respondingTimeouts` (if any) kill idle streams; pick a heartbeat
   interval (~25s comment frames) that also survives mobile carrier NAT.
3. Auth for the `EventSource` request: cookies are sent automatically —
   validate the Auth.js session in the route handler; confirm no extra
   token plumbing is needed.
4. Event payload design: notify-only (`"comments:announcement:2"` changed)
   vs. full payload. Notify-only is the working hypothesis — the client
   refetches through the existing Server Action with its own JWT, so all
   visibility rules keep holding by construction.
5. iOS Safari / Android background behavior: verify `EventSource`
   auto-reconnect on tab resume plus the existing `visibilitychange`
   refetch closes the catch-up gap.
6. Scope decision: comments/reactions only first, or also the notification
   bell and announcement list in the same pass?

**Implementation sketch:**

- **CMS** — `afterCreate`/`afterDelete` lifecycles on `comment` and
  `reaction` (later `notification`) POST
  `{ channel: "comments:<targetType>:<targetId>" }` to
  `WEB_INTERNAL_URL/api/events/emit`, protected by `REVALIDATE_SECRET`
  (generalize `revalidate.ts` into a small `notifyWeb()` util).
- **Web** — two route handlers + one hook:
  - `app/api/events/emit/route.ts`: secret-protected ingest → in-memory
    `EventEmitter`.
  - `app/api/events/route.ts`: SSE endpoint (GET, `ReadableStream`);
    validates the session, subscribes to `?channels=…`, heartbeats,
    cleanup on abort.
  - `LiveCommentSection`: subscribe via `EventSource`, on a matching event
    refetch (existing `getCommentSection`). Keep polling as fallback when
    the stream errors; stretch the interval (e.g. 60s) while connected.
- **Infra** — Traefik timeout tweak on the router if the spike says so;
  no new container.

**Out of scope:** multi-instance web scaling (needs external pub/sub),
WebSockets/bidirectional messaging.

**Acceptance criteria:**

- [ ] Comment/reaction from session A visible in session B in <2s without
      reload; only the affected component refetches.
- [ ] Stream survives ≥10 min idle through Traefik and a mobile connection
      (heartbeats), or reconnects transparently with a catch-up refetch.
- [ ] Polling fallback demonstrably takes over when the SSE endpoint is
      disabled.
- [ ] No authz shortcut: SSE carries notify-only payloads; data is always
      refetched with the requesting user's JWT.

**Effort:** ~1 day spike + ~1–2 days implementation. **Depends on:**
nothing (builds on `LiveCommentSection` + the revalidate webhook pattern).

---

## Phase 3 — Engagement & knowledge

### 3.1 Polls & surveys

**CMS**
- `poll`: `question`, `options` (JSON array of strings), `closesAt`,
  `anonymous` (bool), `departments` targeting (from 2.3).
- `poll-vote`: `poll` (relation), `voter` (relation), `optionIndex` (int).
- Custom routes (votes must not be writable via generic REST):
  `POST /api/polls/:id/vote` (validates open + not yet voted, forces voter
  from `ctx.state.user`) and `GET /api/polls/:id/results` (aggregates; hides
  voter identity when `anonymous`).

**Web**
- `PollCard` widget in dashboard + announcements feed: options as buttons,
  results as CSS bar chart after voting. Server Action → custom vote route.

**Effort:** ~3 days. **Depends on:** 2.3 (targeting), 1.2 (write pattern).

### 3.2 Document library

**CMS**
- `document` content type: `title`, `description`, `file` (media),
  `category` (enum or relation), `departments` (m2m, empty = public).
- Files live in Strapi's existing upload plugin; this type adds the
  browsable, permission-aware catalogue on top.

**Web**
- `/documents` — filter by category/department, search by title, download
  button, "recently updated" sort. `EmptyState` + skeletons per existing
  patterns.

**Effort:** ~2 days. **Depends on:** 2.3 pattern for department scoping.

---

## Phase 4 — Intelligence (search, analytics, AI)

### 4.1 Global content search

**V1 (no new infra):** route handler `GET /api/search?q=` fans out
`filters[$containsi]` queries to announcements, wiki pages, documents, events,
people in parallel with the user's JWT (so wiki visibility holds), merges
top-N per type. Upgrade `search-command.tsx` to call it (debounced) and render
grouped results. ~2 days.

**V2 (quality):** add a Meilisearch container to `docker-compose.yml` +
`strapi-plugin-meilisearch` for typo-tolerant ranked search. **Caveat:**
Meilisearch doesn't know about per-user wiki visibility — either index only
public content, or filter results post-hoc against Strapi. ~2–3 days.

### 4.2 Analytics dashboard

- Lightweight first: a `page-view` content type is write-heavy and bloats
  Postgres — instead run **self-hosted Umami** (one extra compose service,
  Postgres-backed) with the script tag added in the app layout (internal
  URL, no third-party data sharing).
- What Umami can't see, Strapi can: a `/admin` analytics page combining
  Umami stats (via its API) with content stats (announcements without
  comments/reactions = unread signal, top wiki pages, kudos volume,
  poll participation).
- Track search terms with zero results from the 4.1 route handler — the
  single most actionable comms metric.

**Effort:** ~2–3 days. **Depends on:** 4.1 for search-term capture.

### 4.3 AI assistant (exploratory — last)

- RAG over wiki + documents: nightly embed via Claude API, answer with
  citations in the search palette ("Ask Sinnlos").
- **Decisions needed first:** external API spend, and whether company wiki
  content may leave the VM. Park until Phases 1–3 are live and there is
  content worth asking about.

---

## Suggested order & rough timeline

| Sprint (≈1 wk) | Deliverables |
|---|---|
| 1 | 1.1 Directory + org chart |
| 2 | 1.2 Comments & reactions, 1.3 Recognition |
| 3 | 2.1 Events calendar, 2.3 Targeting |
| 4 | 2.2 Notifications (A then B) |
| 5 | 3.1 Polls, 3.2 Documents |
| 6 | 4.1 Search V1, 4.2 Analytics |
| later | 2.4 Live updates (SSE), 4.1 V2 (Meilisearch), 4.3 AI assistant |

## Cross-cutting checklist (applies to every feature)

- [ ] Add new content types to `PERMISSION_MATRIX` (`apps/cms/src/index.ts`) —
      forgetting this is the #1 cause of frontend 403s in this project.
- [ ] Never trust client-supplied author/voter/sender — force from
      `ctx.state.user` in a controller or lifecycle hook.
- [ ] Per-user responses must use `noCache: true` (Next fetch cache keys by
      URL, not Authorization header).
- [ ] Demo mode: extend `apps/web/src/lib/demo.ts` fixtures so `DEMO_MODE=1`
      keeps working.
- [ ] Types in `lib/types.ts`, skeleton + `loading.tsx`, `EmptyState`,
      `PageHeader`, mobile nav check.
- [ ] `pnpm typecheck && pnpm build` before every merge.
