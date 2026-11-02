# Secret sharing by role ("Geheimnisse" per role group)

**Status:** owner decisions confirmed 2026-11-02 (all defaults; D6: v0.36.0 before rc.1); built in v0.36.0. A follow-up to v0.35.0 ([plan-v035-secret-sharing.md](plan-v035-secret-sharing.md)).
**Reviews:** Codex plan rounds r1–r3 revise, r4 approve (2026-11-02).

**The request (owner, 2026-11-02):** choose per role who can use secret sharing. The example: off for everyone in principle, but leading positions can use it.

## 1. Today (v0.35.0)

- **Who:** all five staff roles (`admin_role`, `editor`, `department_head`, `team_lead`, `member`) can send to each other and receive from each other. Guests and the `authenticated` fallback can do neither.
- **The only switch:** `FEATURES_OFF=secrets`, which turns the module off for everyone.
  - It **suspends** access.
  - The data stays: pending shares expire and the janitor keeps running.
- **The admin panel cannot narrow it.** The cms boot converges the users-permissions grants to the permission matrix and only adds rows. A share action removed from a role in the panel comes back at the next boot.
- **Who decides:**
  - the cms, per request (`isEligible` in `apps/cms/src/utils/secret-shares.ts`: unblocked and in `STAFF_ROLES`), for the caller, the other party and the recipient search;
  - the web gates pages and the navigation entry by the static `SECRET_SHARE_ROLES` (the read gate).

## 2. Design

### 2.1 Two role lists in the environment

| Key                     | Meaning                    | Unset or empty                  |
| ----------------------- | -------------------------- | ------------------------------- |
| `SECRETS_SEND_ROLES`    | the roles that may send    | all five staff roles (as today) |
| `SECRETS_RECEIVE_ROLES` | the roles that may receive | all five staff roles (as today) |

**Values:**

- A comma list of role types out of `admin_role`, `editor`, `department_head`, `team_lead`, `member`. Names are trimmed and case-insensitive; duplicates are fine.
- **Refused at start:**
  - an unknown name, `guest` or `authenticated`;
  - a value that holds only commas or spaces (`,` or `, ,`). An empty key means all staff; a value without a role name is a mistake.
  - The cms refuses its boot, as with `MFA_REQUIRED_ROLES`.
  - The web behaves as with a bad `FEATURES_OFF` (`instrumentation.ts`): it fails its health check and answers HTTP 500. The process does not necessarily exit.
  - **`deploy.sh`'s preflight** refuses before anything is pulled or built, so `deploy.sh --check` covers it too. This is the awk check that already validates `FEATURES_OFF` (`infra/deploy.sh` around lines 285 and 396, before the `--check` exit at about line 1385).
    - It validates both keys in **both** rendered service environments (cms and web).
    - It refuses when the normalized lists of the two services differ.
  - **`check-boot-env.ts`** in the new cms image (deploy step, after the pull) checks the same with the domain parser, as a second net. Today it reads only `services.cms.environment`; it gains the web environment and the comparison.
- **Clearing a list widens access** back to all staff. The docs say so.

**One parser** in `packages/domain` (`parseSecretRoles(value, key)`):

- the cms reads it in `index.ts` and `scripts/check-boot-env.ts`;
- the web reads it at runtime on the server, like `lib/switches.ts`.

**Compose** passes both keys to cms and web from the same `.env`. Both services print the normalized lists at start (§2.5), and the deploy POST compares the two lines.

**Off for everyone** stays `FEATURES_OFF=secrets`. There is no `none` value.

**The owner's example:**

```
SECRETS_SEND_ROLES=department_head,team_lead
SECRETS_RECEIVE_ROLES=
```

Leads send; every staff member can receive, so a lead can hand a team member an access code. To keep it among leads only: `SECRETS_RECEIVE_ROLES=department_head,team_lead`.

### 2.2 What the cms checks (the authority)

`isEligible` stays as it is: unblocked staff. Revoke and the janitor keep using it.

`assertFreshCaller` stays as it is: staff, token version and second factor. The new checks run on its fresh row, under the same locks:

- `canSend(row)` = eligible and the role is in the send list;
- `canReceive(row)` = eligible and the role is in the receive list.

| Request          | Check                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| create           | the caller `canSend`; the recipient `canReceive`                                                                            |
| recipient search | the caller `canSend`; the receive-role filter is part of the **database query, before its limit** (not a filter afterwards) |
| reveal           | the caller (the recipient) `canReceive` now; the sender is eligible now. The send list is **not** re-checked (D5)           |
| revoke           | unchanged: the sender may revoke an own pending share, also without the send right                                          |
| list, findOne    | unchanged access: every staff member sees their own shares                                                                  |

**`available`:** the same definition in list and detail, for both directions:

- pending and unexpired;
- the sender is eligible (the send list is not required);
- the recipient `canReceive`.

**The `received` list keeps its contract.** It shows only shares the caller can open, so a caller outside the receive list gets an empty inbox.

**Refusals, all existing shapes:**

| Cause                                                | Answer                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| a caller who may not send (create, search)           | a **plain 403**; the web maps it to its generic `forbidden` text |
| a recipient outside the receive list                 | the existing **400 `recipient`**, the same as a non-staff id     |
| a caller outside the receive list at reveal          | a **plain 403**; the share stays pending until it expires        |
| a sender who is blocked or no longer staff at reveal | the existing **409 `unavailable`**                               |
| a missing or foreign share                           | the plain **404**, unchanged                                     |

- **No new error code.** The web shows no send or reveal control to someone who may not use it, so the 403 appears only in races.
- **Unchanged:**
  - the users-permissions grants (30 rows, drift 228). An existing v0.35 install gains **no** new grants;
  - no schema change, no migration;
  - the janitor, notifications, export, anonymisation, restore, the admin closure and the Plausible suppression.

### 2.3 What the web shows

The read gate `SECRET_SHARE_ROLES` stays (all staff: list, detail, revoke). Two new predicates, `canSendSecrets` and `canReceiveSecrets`, come from the env lists.

- **Navigation entry "Geheimnisse":** owner decision D7.
  - **Default:** shown only to viewers who can send or receive, which matches "off for everyone in principle".
  - **The cost:** someone who lost both rights has no menu entry to their sent list. `/secrets` still works for them (the read gate), with revoke. Their pending shares end within 24 hours.
  - **The alternative:** the entry for all staff, as today. Revoke is always one click away, but members without rights see the entry.
- **New-secret button and `/secrets/new`:** only for senders. Others get the "not available for your role" page.
- **`/secrets`:**
  - the "received" section only for receivers;
  - the "sent" section for everyone, with revoke.
- **Detail `/secrets/<id>`, opened from the bell:** a recipient outside the receive list sees the metadata and "nicht verfügbar", with no reveal control.
- **The cms decides every request**; the web only hides controls.

### 2.4 Rollback to v0.35.0

- **v0.35.0 ignores both keys** and opens the module to all staff again. When the restriction matters, set `FEATURES_OFF=secrets` before the retag; v0.35.0 knows that name.
- UPGRADE.md and the deploy brief say so, and the staging rehearsal runs it.

### 2.5 Boot lines and the deploy POST

- **The boot line:** the cms and the web each print `[secrets] send: <roles | all staff>; receive: <roles | all staff>` once at start. The two lines must be identical.
- **POST of the release deploy, with both keys unset:**
  - both lines say `all staff` twice;
  - no `granted` line, drift 228;
  - everything else as v0.35.0.
- **After the owner sets the lists:**
  1. `deploy.sh --check`, which validates and compares both services;
  2. `docker compose up -d cms web`;
  3. compare the two boot lines again: they must be identical and show the new lists;
  4. a member gets no new-secret button, and a lead can send.

## 3. Owner decisions (defaults in bold)

| #   | Question                                                            | Default                                                                                                                                                           |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Two lists (send / receive) or one for both?                         | **Two lists.** One list would make "leads send to their team" impossible.                                                                                         |
| D2  | Values for the owner's instance                                     | **Send: `department_head,team_lead`. Receive: empty (all staff).** Add `admin_role` if admins should send too.                                                    |
| D3  | Env or an admin page in `/manage`?                                  | **Env**, like `FEATURES_OFF` and `MFA_REQUIRED_ROLES`. An admin page needs a settings store, an audit event and cache invalidation in the web; it can come later. |
| D4  | Groups = roles, or also departments or teams?                       | **Roles only.** Department or team lists (e.g. "only IT") are a possible extension.                                                                               |
| D5  | Sender loses the send right: do their pending shares stay openable? | **Yes, until they expire (max. 24 h).** Narrowing the send list stops new shares; `FEATURES_OFF=secrets` suspends all access at once.                             |
| D6  | When?                                                               | **After v1.0.0** (asked for as a future feature). It is small (no schema), so it could also come before rc.1 as v0.36.0.                                          |
| D7  | Menu entry for staff who can neither send nor receive               | **Hidden.** `/secrets` stays reachable directly, with revoke. The alternative: always shown to all staff (§2.3).                                                  |

## 4. Work breakdown

1. **Domain:**
   - `parseSecretRoles` and its tests: unset, empty, comma-only, case, spaces, duplicates, unknown, guest, authenticated.
   - **Contract wording** in `secret-share.ts`:
     - `recipient` also covers "outside the receive list";
     - `available` states the asymmetric rule: sender eligible, recipient able to receive;
     - the recipient-search DTO lists only people who can receive;
     - `received` stays "only what the caller can open"; the error codes are unchanged.
2. **cms:**
   - the boot check in `index.ts` and `check-boot-env.ts`, and the boot line;
   - `canSend` and `canReceive` in `utils/secret-shares.ts`;
   - create, recipient search (filter in the query) and reveal use them;
   - `available` follows the one definition in `summaryOf` (list and detail);
   - the `received` list leaves out what the caller cannot open.
3. **cms integration tests, on SQLite and Postgres:**
   - **create:**
     - a caller outside the send list gets 403, and nothing is written (no share, no notification);
     - a recipient outside the receive list gets 400 `recipient`;
   - **recipient search:**
     - a caller who may not send gets 403;
     - the receive filter applies before the limit: at least 20 excluded matches sort before one eligible match, and that match is returned;
   - **reveal:**
     - a recipient removed from the list gets 403, and the share stays pending;
     - after a restart with the role back, the share opens;
     - a share opens after the sender lost the send right (D5);
   - **lock races:** a role change while create or reveal waits on the locks;
   - **janitor:** a run while the recipient is outside the list leaves the share alone (it only expires);
   - **`available` and the lists:**
     - `available` is the same in list and detail, for sender and recipient;
     - the received list is empty for an excluded receiver;
   - **revoke** after losing the send right;
   - **empty lists:** every existing v0.35 suite stays green unchanged.
4. **web:**
   - `canSendSecrets` and `canReceiveSecrets`;
   - the nav entry, the button, `/secrets/new`, the list sections and the detail page without a reveal control;
   - the boot line;
   - a start test with a bad value (health fails, HTTP 500).
5. **Deploy checks:**
   - the `deploy.sh` preflight (awk, next to `FEATURES_OFF`) and `check-boot-env.ts` both validate the cms and web environments and compare them;
   - command-level tests in the infra test suite for `deploy.sh --check` and for `check-boot-env`:
     - a bad cms value;
     - a bad web value;
     - differing lists;
     - both unset (passes).
6. **e2e:**
   - a lead sends, a member receives and opens;
   - a member has no new-secret button and gets the role page on `/secrets/new`;
   - with receive restricted, a member sees "nicht verfügbar" on a bell link;
   - a lead with a pending share loses both rights: they open `/secrets` and revoke it (with D7 hidden, through the URL).
7. **Infra and docs:**
   - the compose file (cms and web) and all three env examples;
   - INSTALL and OPERATIONS: the keys, and that clearing a list widens access;
   - UPGRADE: nothing to do (empty means as before), and the rollback note from §2.4;
   - security.md;
   - data-protection.md: who can use the module is a setting, the owner's chosen groups, and that receive restrictions are reversible (for the works council).
8. **Process:**
   - Codex rounds on the plan and the build; ponytail;
   - a short staging rehearsal (no schema):
     1. deploy with empty lists; the POST is as v0.35.0, with the boot line "all staff" in both services;
     2. set the lists: a member is refused, a lead is allowed;
     3. restrict receiving: a bell link shows "nicht verfügbar";
     4. the rollback from §2.4 with `FEATURES_OFF=secrets`, and forward again.

## 5. Not in scope

- per-person allow lists;
- department or team lists (D4);
- an admin page (D3);
- external recipients (their own release, see the v0.35 plan §9).
