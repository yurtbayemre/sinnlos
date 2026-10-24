# Deployment Guide

This guide was split in v0.29. Where each topic is now:

| Topic                                                                                                     | Page                                                           |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A new installation (bundled Caddy, host Traefik)                                                          | [INSTALL.md](INSTALL.md)                                       |
| Upgrades, release notes, rollback                                                                         | [UPGRADE.md](UPGRADE.md)                                       |
| Monitoring, restore, backups, hardening, the datetime contract, live events, Meilisearch, troubleshooting | [OPERATIONS.md](OPERATIONS.md)                                 |
| Microsoft Entra ID and OIDC sign-in                                                                       | [SSO.md](SSO.md)                                               |
| Local development                                                                                         | [CONTRIBUTING.md](../CONTRIBUTING.md#development-setup)        |
| Runbooks of earlier releases, Azure                                                                       | [archive/deployment-history.md](archive/deployment-history.md) |

## Old section links

The sections below are the old headings that other pages linked to, kept so old links still land somewhere.

### Microsoft Entra ID sign-in

Moved to [SSO.md](SSO.md#microsoft-entra-id-sign-in).

### What Entra owns

Moved to [SSO.md](SSO.md#what-entra-owns).

### Staging dry-run, then on

Moved to [SSO.md](SSO.md#staging-dry-run-then-on).

### An e-mail address that already has an account (409)

Moved to [SSO.md](SSO.md#an-e-mail-address-that-already-has-an-account-409).

### OIDC sign-in (Keycloak, authentik, Zitadel)

Moved to [SSO.md](SSO.md#oidc-sign-in-keycloak-authentik-zitadel).

### 1.2 Create environment files

Moved to [CONTRIBUTING.md](../CONTRIBUTING.md#local-development-sqlite).

### 1.6 Demo mode (no Microsoft account needed)

Moved to [archive/deployment-history.md](archive/deployment-history.md#16-demo-mode-no-microsoft-account-needed).

### 2. Docker Local (Full Stack)

Moved to [CONTRIBUTING.md](../CONTRIBUTING.md#full-stack-with-docker-compose).

### 3. VPS Deployment

Moved to [INSTALL.md](INSTALL.md).

### A. Bundled Caddy (standalone VPS)

Moved to [INSTALL.md](INSTALL.md).

### B. Shared Traefik (live production layout)

Moved to [INSTALL.md](INSTALL.md#behind-your-own-traefik).

### 3.8 Updates

Moved to [UPGRADE.md](UPGRADE.md#release-notes).

### Deploying batch 16 (v2 authoring phase 2: documents with uploads, the wiki)

Moved to [archive/deployment-history.md](archive/deployment-history.md#deploying-batch-16-v2-authoring-phase-2-documents-with-uploads-the-wiki).

### One-time: wiki revisions draft/publish off (batch 16)

Moved to [archive/deployment-history.md](archive/deployment-history.md#one-time-wiki-revisions-draftpublish-off-batch-16).

### Deploying batch 15 (2026-10-13)

Moved to [archive/deployment-history.md](archive/deployment-history.md#deploying-batch-15-2026-10-13).

### Deploying batch 13 (2026-10-12)

Moved to [archive/deployment-history.md](archive/deployment-history.md#deploying-batch-13-2026-10-12).

### Upgrading to the UI primitives and Markdown rendering (batch 13, lane 8B)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-ui-primitives-and-markdown-rendering-batch-13-lane-8b).

### Upgrading to the capabilities, navigation and loading states (batch 13, lane 8A)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-capabilities-navigation-and-loading-states-batch-13-lane-8a).

### Upgrading to the live client and password-change revocation (batch 13, lane 8C)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-live-client-and-password-change-revocation-batch-13-lane-8c).

### Upgrading to the CMS data lifecycle leftovers (batch 12, lane 7C)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-cms-data-lifecycle-leftovers-batch-12-lane-7c).

### Upgrading to the action results, auth codes and English defaults (batch 12, lane 7A)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-action-results-auth-codes-and-english-defaults-batch-12-lane-7a).

### Upgrading to the domain package, image layers and pnpm 10 (batch 12, lane 7B)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-domain-package-image-layers-and-pnpm-10-batch-12-lane-7b).

### Upgrading to the CI and edge changes (batch 10, lane 5A)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-ci-and-edge-changes-batch-10-lane-5a).

### Upgrading to the deploy, backup and cron hardening (batch 10, lane 5B)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-deploy-backup-and-cron-hardening-batch-10-lane-5b).

### Upgrading to the web session, data client and batched poll results (batch 10, lane 5C)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-web-session-data-client-and-batched-poll-results-batch-10-lane-5c).

### Upgrading to the policy primitives (batch 9, lane 4B)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-policy-primitives-batch-9-lane-4b).

### Upgrading to the live contract and poll documentIds (batch 9, lane 4C)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-live-contract-and-poll-documentids-batch-9-lane-4c).

### Upgrading to the Entra sign-in (batch 9, lane 4A)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-entra-sign-in-batch-9-lane-4a).

### Upgrading to the cms bootstrap split (batch 8, lane 3B)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-cms-bootstrap-split-batch-8-lane-3b).

### Upgrading to the web datetime port (batch 8, lane 3A)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-web-datetime-port-batch-8-lane-3a).

### Upgrading to the notification pipeline fixes (2026-09-28)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-notification-pipeline-fixes-2026-09-28).

### Upgrading to the user data and search hardening (batch 7, lane 2C)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-user-data-and-search-hardening-batch-7-lane-2c).

### Upgrading to the RSVP summary and reports (batch 7, lane 2B)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-rsvp-summary-and-reports-batch-7-lane-2b).

### Upgrading to the cms input hardening (2026-09-28)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-cms-input-hardening-2026-09-28).

### Upgrading to poll department targeting

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-poll-department-targeting).

### Checking targeted polls after rolling forward

Moved to [archive/deployment-history.md](archive/deployment-history.md#checking-targeted-polls-after-rolling-forward).

### Upgrading to the ICS and cms start fixes (2026-09-27)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-ics-and-cms-start-fixes-2026-09-27).

### Upgrading to the draft-twin repair (FX38)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-draft-twin-repair-fx38).

### Upgrading an existing instance to this release

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-an-existing-instance-to-this-release).

### One-time: org draft/publish off

Moved to [archive/deployment-history.md](archive/deployment-history.md#one-time-org-draftpublish-off).

### Upgrading to the Strapi 5.55.1 release (2026-09-25)

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-to-the-strapi-5551-release-2026-09-25).

### Upgrading from a release before 2026-09-24

Moved to [archive/deployment-history.md](archive/deployment-history.md#upgrading-from-a-release-before-2026-09-24).

### 3.9 Production hardening

Moved to [OPERATIONS.md](OPERATIONS.md#production-hardening).

### 3.10 Datetime contract

Moved to [OPERATIONS.md](OPERATIONS.md#datetime-contract).

### 4. Azure VM Deployment

Moved to [archive/deployment-history.md](archive/deployment-history.md#4-azure-vm-deployment).

### 5. Azure Container Apps (Advanced)

Moved to [archive/deployment-history.md](archive/deployment-history.md#5-azure-container-apps-advanced).

### Post-Deployment Verification

Moved to [OPERATIONS.md](OPERATIONS.md#post-deployment-verification).

### 6.4 Role enforcement (optional)

Moved to [OPERATIONS.md](OPERATIONS.md#role-enforcement-optional).

### Backup & Restore

Moved to [OPERATIONS.md](OPERATIONS.md#backup--restore).

### Restoring a database dump

Moved to [OPERATIONS.md](OPERATIONS.md#restoring-a-database-dump).

### 7.4 Update procedure (production-safe)

Moved to [UPGRADE.md](UPGRADE.md#update-procedure-production-safe).
