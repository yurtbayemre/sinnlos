# Road to v1.0.0

Status: 2026-10-22, owner-approved. Baseline is v0.25.0 (`0c26656e`). This file lists **everything that still has to be done before v1.0.0**. Each item gets ticked when its release ships.

## What v1.0.0 means

- A second company (a German SME with 20 to 500 staff, self-hosted) installs sinnlos from a published release. No code changes are needed.
- Daily administration runs without the Strapi admin panel.
- The installation can be put in front of the company's data-protection officer and its works council (Betriebsrat).

The feature set is complete for v1.0.0. What is missing:

- trust and portability;
- the account lifecycle for local sign-in;
- data governance.

The owner rule still applies: **no bloat**. Every item below has the smallest scope that does the job.

## Owner decisions (2026-10-22)

| Question                                                | Decision                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License                                                 | **AGPL-3.0-only**                                                                                                                                                                                                                                     |
| Paid offer later (support, hosting, enterprise edition) | **Yes**. This brings two consequences:<br>1. Contributions need a CLA so dual licensing stays possible.<br>2. The CRA manufacturer duties apply once the project is monetised: vulnerability handling, SBOM, a support period and incident reporting. |
| MFA for local accounts                                  | **Build native TOTP**                                                                                                                                                                                                                                 |
| Unterweisung evidence                                   | **Snapshot on the receipt**: course title, version and validity are stored at completion; reports can include people who have left                                                                                                                    |
| Upgrade floor                                           | **v1.0.0 supports upgrades from v0.25.x only**                                                                                                                                                                                                        |
| Module switches                                         | **Before v1.0.0**                                                                                                                                                                                                                                     |
| SHOULD items                                            | **All of them before v1.0.0** too                                                                                                                                                                                                                     |

## Must be done before v1.0.0

### Trust and portability (v0.26)

- [ ] **M1 License.** Two parts:
  - `LICENSE` (AGPL-3.0-only), the `license` field in every package.json, and the third-party notices the dependencies require (the images ship bundled code).
  - A source link in the app (AGPL §13) and `CONTRIBUTING.md` with the CLA requirement. The CLA text needs a lawyer's check. Until it is signed, no outside contributions are merged.
- [ ] **M2 No owner infrastructure in the product.**
  - Remove the hard-wired Plausible script (`apps/web/src/app/layout.tsx`, `plausible.yurtbay.dev` on every page). Analytics load only when configured.
  - Remove the owner-host defaults from `infra/backup/pg-backup.sh` and `infra/deploy.sh`: `/home/bigemo/...`, `momsbest`, `/usr/local/sbin/backup-run`, and the Traefik override that is always on.
  - The smoke sign-in must not require demo accounts.
  - Host specifics move into an optional local override.
- [ ] **M3 Operator links.** Privacy and imprint links, plus an optional whistleblower-channel link, configured by env and reachable before sign-in. There is no subsystem behind them.
- [ ] **M4 Reproducible install, upgrade and restore.**
  - Based on the bundled Caddy.
  - Versioned images published to GHCR on release tags.
  - The upgrade path keeps the backup and the checks.
  - Rehearsed on a fresh host: fresh install, upgrade from v0.25.x, restore.
- [ ] **M5 Strapi administration surface protected at the edge.**
  - The surface includes `/admin` and also `/content-manager/*`, `/users-permissions/*`, `/upload*` and the other admin APIs. Strapi CE has no 2FA for panel admins.
  - Allowed source networks are configurable; the default is private networks only.
  - Apply it to both Caddy and the Traefik override.
- [ ] **M6 First intranet admin.** An explicit, documented install step. The seed creates the Strapi super-admin only, but `/manage/users` needs an intranet `admin_role`. v0.27 can replace the step with an invitation.
- [ ] **M8 (part) Demo seed refused in production.** Demo users share a known password.
- [ ] **M12 Release hygiene.**
  - `SECURITY.md` with GitHub private vulnerability reporting enabled, the supported versions and the response targets.
  - Release notes with upgrade and breaking-change sections.
  - The version and SHA on the images, in a cms boot line, and next to the source link.
  - The package.json versions follow the release.
- [ ] **S4 (start) `docs/INSTALL.md`.** One page, written together with the fresh-host rehearsal.
- [ ] **S5 Signed images and SBOM** through GitHub artifact attestations, on the published images.

### Accounts (v0.27)

- [ ] **M8 Password baseline.** Minimum length 10 to 12 characters, enforced server-side on every path (create, change, reset, registration), plus a common-password list. No policy engine and no rotation rules.
- [ ] **M7 Invitation and password recovery: one token flow, local accounts only.**
  - An admin invites one person at `/manage/users`, who gets a set-password link by e-mail. "Forgot password" uses the same flow.
  - The token is stored as a hash, has an expiry, is single use and is bound to `tokenVersion`.
  - Accounts with an identity-provider binding never get a password.
  - Redemption leads to sign-in, never straight to a session.
  - The generic Strapi reset routes stay revoked.
- [ ] **M9 TOTP for local accounts.**
  - Enforceable per role (at least admin and editor), with recovery codes.
  - Enforced in the cms on every path that issues a JWT, not only on the web form.
  - Specified together with M7, so a reset never bypasses MFA.
- [ ] **S3 Bulk invitations** (pasted list or CSV) on top of M7.
- [ ] **S7 Stale UI texts.** Some texts still send people to the Strapi panel: roles, and the empty states for announcements, departments, teams and courses.

### Data protection (v0.28)

- [ ] **M11 Data inventory and retention.**
  - One table: data class, purpose, who sees it (per role), deletion trigger and default retention. It serves as the data-protection officer's Art. 30 entry and the annex to the works agreement.
  - Executable cleanups for read confirmations, training receipts, poll votes, RSVPs and unread notifications. Fan-out anchors must not be pruned by a naive age rule, or old news comes back as new.
  - The search-log retention becomes configurable, plus a server-side switch for search-query logging.
  - Server-side switches for read confirmations and named training reports.
- [ ] **Training evidence snapshot (decision 4).**
  - At completion the receipt stores the course title, version and validity.
  - Reports can include people who have left.
  - The proof per person can be exported as CSV: date, course and version, confirmation, quiz result.
  - Each course gets an "ask the responsible person" contact.
  - This must land before M10, so anonymisation never destroys the evidence.
- [ ] **M10 Offboarding and data-subject rights, run by the admin.**
  - The admin first blocks the person and revokes their sessions.
  - **Export** of one person's data (Art. 15), with a dry run.
  - **Anonymisation** of the person (Art. 17), with a dry run. Training evidence is kept under its retention class.
  - Media and the search index are cleaned up after the commit; the cleanup can be rerun.
  - Re-applying anonymisations after a restore is documented.
  - The documentation says honestly what remains.
  - Blocked people disappear from the directory and the org chart (today `PEOPLE_QUERY` does not filter `blocked`).
  - There is no self-service portal.
- [ ] **S2 Module switches.** One env list for marketplace, kudos and celebrations. The navigation hides them and the cms refuses them.

### Polish and release candidate (v0.29)

- [ ] **S1 Branding by config.** Product name, logo and favicon, and one accent colour. Today the name is hard-coded in the title, sidebar, digest subject and welcome text. No theme builder.
- [ ] **S4 Docs split.** Today README.md is about 108 KB, security.md about 116 KB and DEPLOYMENT.md about 867 KB. Target: one page each for INSTALL, UPGRADE and OPERATIONS, plus an archive of the batch history. ROADMAP.md shrinks to a status list.
- [ ] **S6 Accessibility pass.** Keyboard, focus, screen reader and zoom on sign-in, search, navigation, authoring and training. Fix real blockers; claim no certification.
- [ ] **S8 Readiness check** through web → cms → db, plus documented alerts for backup age, a failed cron and disk space.
- [ ] **S9 Documentation**:
  - AD/LDAP through Keycloak or authentik.
  - MFA through the IdP for SSO users.
  - The whistleblower channel is a link and is not built in.
  - Team leads see their whole department's training reports.
- [ ] **Remove the pre-v0.25 upgrade machinery from the main path** (decision 5). `DATETIME_LEGACY_*` and the old migration runbooks move to the archive.
- [ ] **Final rehearsal** on the final schema and authentication: fresh install, upgrade from v0.25.x and restore (including re-applied anonymisations). Then v1.0.0-rc.1, then v1.0.0 with all package versions at 1.0.0.

### Open owner and ops items (not code)

- [ ] From 2026-12-26: DROP `datetime_migration_audit` and delete the pre-datetime dump on the test instance (go given; via the deploy session).
- [ ] Browser check of Meilisearch on the test instance (⌘K typo, a compound-word part, department news hidden, guests without news).
- [ ] Entra sign-in tested against a real tenant (issue #20).
- [ ] Remove the merged worktrees and leftover folders on the development machine.
- [ ] A lawyer checks the CLA text.

## After v1.0.0

These are deliberately not part of v1.0.0: SCIM or directory sync, OIDC single logout, web push (with quiet hours), a Microsoft Teams personal-app manifest, audit CSV export, S3 media storage, HA/Helm, LTS releases (a natural paid item), the Azure Container Apps test, the AI assistant, and the canteen menu / vending API.

## Not planned (bloat)

- SAML (bridge it through Keycloak or authentik).
- Native LDAP.
- A whistleblower channel inside the intranet: admins and SSO logs undermine its confidentiality, so link an external one instead.
- Per-person analytics, "seen by" or engagement rankings.
- A theme builder.
- Legal hold or compliance export.
- A workflow engine.
- Kubernetes.
- A self-service privacy portal.
- A password-policy engine.
