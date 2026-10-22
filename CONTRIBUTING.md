# Contributing

Thanks for your interest in sinnlos.

## Contributor License Agreement

sinnlos is licensed under the AGPL-3.0-only ([LICENSE](./LICENSE)). A commercial license will be offered next to it, so every contribution needs a signed Contributor License Agreement (CLA). The CLA text is not published yet. **Until it is, pull requests from outside contributors are not merged.** Issues, bug reports and ideas are welcome at any time.

To report a security vulnerability, do not open an issue; follow [SECURITY.md](./SECURITY.md).

## Development

Setup and the local stack are described in the [README](./README.md#quick-start). Before you open a pull request, run from the repository root (pnpm 10, through corepack):

```sh
pnpm typecheck          # the apps and the test sources
pnpm lint
pnpm format:check
pnpm test               # unit tests
pnpm test:integration   # Strapi in process, SQLite (and Postgres with SINNLOS_TEST_PG_URL)
```

CI runs the same checks plus the browser tests, the datetime matrix and both image builds. Commits are small and describe the why. Code follows the conventions in [docs/architecture.md](./docs/architecture.md).
