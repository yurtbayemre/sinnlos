# Production diagnostics

Read-only checks to run on the production host. None of them change data.
The SQL runs inside `BEGIN TRANSACTION READ ONLY` … `ROLLBACK`, and no secret
values are printed.

| File                       | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `census.sh` + `census.sql` | A census of the data behind features whose production usage is unknown: comment threading, announcement expiry, poll/event department targeting, wiki page scoping and revisions, lesson quizzes, users by sign-in provider, digest opt-ins, notification volume and title lengths. It also reports whether SMTP is configured (set/empty only), plus the last `[digest]` and `[notifications] failed` log lines of the running cms container. |
| `prod-perm-diff.sql`       | The live users-permissions grants compared with what the code's bootstrap sync converges to: grants that exist only in the database (for example, made in the admin panel), grants the code expects but the database lacks, duplicates, unknown roles and orphaned rows.                                                                                                                                                                       |

## Running them

From the repository checkout on the host (compose project `infra`):

```bash
infra/diagnostics/census.sh

docker exec -i infra-db-1 sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < infra/diagnostics/prod-perm-diff.sql
```

The output contains counts and role/permission names, not personal data.
Still, treat it as internal operational data and don't post it publicly.

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
