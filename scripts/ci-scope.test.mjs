import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./ci-scope.mjs", import.meta.url));

test("CI scopes use the whole change and keep the browser E2E exclusions narrow", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "sinnlos-ci-scope-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const write = (path, text = "content\n") => {
    const target = join(repo, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const commit = () => {
    git("add", "--all");
    git("-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  const run = (name, event) => {
    const eventPath = join(temp, "event.json");
    const output = join(temp, "output");
    writeFileSync(eventPath, JSON.stringify(event));
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [script], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: name,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: output,
      },
    });
    return { ...result, output: readFileSync(output, "utf8") };
  };
  const pr = (base, head) => ({ pull_request: { base: { sha: base }, head: { sha: head } } });
  const expect = (name, event, full, database, e2e) => {
    const result = run(name, event);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, `full=${full}\ndatabase=${database}\ne2e=${e2e}\n`);
  };
  // A push to main always runs everything (deploy.sh --require-green-ci trusts that run);
  // the narrowed expectation of a push range is checked as the same range in a pull request.
  const check = (name, event, full, database = full, e2e = full) => {
    if (name !== "push") return expect(name, event, full, database, e2e);
    expect(name, event, true, true, true);
    if (!/^0+$/.test(event.before)) {
      expect("pull_request", pr(event.before, event.after), full, database, e2e);
    }
  };

  git("init", "-q");
  git("config", "core.autocrlf", "false");
  write("apps/example.ts");
  write("docs/plan.md");
  const base = commit();
  write("docs/plan.md", "revised plan\n");
  write("docs/nested/space in name.md");
  const docs = commit();
  check("pull_request", pr(base, docs), false);
  check("push", { before: base, after: docs }, false);
  // INSTALL.md pins the release tag: its unit test runs, the database and E2E suites do not.
  write("docs/INSTALL.md", "git clone --branch v1\n");
  check("push", { before: docs, after: commit() }, true, false, false);

  // README contracts, new executable docs and all unknown paths keep full CI.
  for (const path of [
    "README.md",
    "infra/migration/README.md",
    "docs/check.sh",
    ".github/workflows/ci.yml",
    "pnpm-lock.yaml",
    "package.json",
    "pnpm-workspace.yaml",
    ".dockerignore",
    "scripts/ci-scope.mjs",
    "e2e/teams.spec.ts",
    "e2e/run.mjs",
    "e2e/compose.yaml",
    "e2e/playwright.config.ts",
    "e2e/package.json",
    "apps/example.ts",
    "apps/cms/src/api/example/controller.ts",
    "apps/cms/src/api/example/schema.json",
    "apps/cms/Dockerfile",
    "packages/domain/src/training.ts",
    "infra/diagnostics/check.sql",
    "vitest.config.ts",
    "new-module/unknown.ts",
  ]) {
    const before = git("rev-parse", "HEAD");
    write(path, "changed\n");
    check("push", { before, after: commit() }, true);
  }
  // Relevant web changes run E2E without widening the existing database scope.
  for (const path of [
    "apps/web/src/app/(app)/teams/page.tsx",
    "apps/web/src/app/(app)/teams/[slug]/page.tsx",
    "apps/web/src/app/(app)/teams/[slug]/edit/page.tsx",
    "apps/web/src/components/manage/org-editor.tsx",
    "apps/web/src/auth.ts",
    "apps/web/src/lib/auth/credentials.ts",
    "apps/web/src/lib/session.ts",
    "apps/web/src/lib/roles.ts",
    "apps/web/src/lib/viewer.ts",
    "apps/web/src/components/layout/app-shell.tsx",
    "apps/web/src/app/(app)/layout.tsx",
    "apps/web/src/components/manage/form-controls.tsx",
    "apps/web/src/components/ui/button.tsx",
    "apps/web/src/app/globals.css",
    "apps/web/messages/en.json",
    "apps/web/messages/manage/org.en.json",
    "apps/web/src/app/(app)/polls/layout.tsx",
    "apps/web/src/app/(app)/polls/new/page.tsx",
    "apps/web/src/lib/loaders/polls.ts",
    "apps/web/src/components/polls/poll-card.tsx",
    "apps/web/src/unknown.ts",
    "apps/web/package.json",
    "apps/web/next.config.ts",
    "apps/web/tsconfig.json",
    "apps/web/Dockerfile",
  ]) {
    const before = git("rev-parse", "HEAD");
    write(path);
    const after = commit();
    check("push", { before, after }, true, false);
    check("pull_request", pr(before, after), true, false);
  }
  // The web search reads the Meilisearch index the cms writes (v0.21): database tests too.
  for (const path of ["apps/web/src/lib/search-action.ts", "apps/web/src/lib/search-meili.ts"]) {
    const before = git("rev-parse", "HEAD");
    write(path);
    check("push", { before, after: commit() }, true, true);
  }
  const pollPage = "apps/web/src/app/(app)/polls/page.tsx";
  const pollLoading = "apps/web/src/app/(app)/polls/loading.tsx";
  const beforePolls = git("rev-parse", "HEAD");
  for (const path of [pollPage, pollLoading]) {
    const before = git("rev-parse", "HEAD");
    write(path);
    const after = commit();
    check("push", { before, after }, true, false, false);
    check("pull_request", pr(before, after), true, false, false);
  }
  write("docs/plan.md", "poll reader documentation\n");
  check("pull_request", pr(beforePolls, commit()), true, false, false);

  // A docs-only last commit cannot hide an earlier team change in the same PR.
  const beforeMixed = git("rev-parse", "HEAD");
  write(pollPage, "changed poll reader\n");
  commit();
  write("apps/web/src/app/(app)/teams/page.tsx", "changed team reader\n");
  const mixedCode = commit();
  write("docs/plan.md", "team and poll documentation\n");
  const mixedDocs = commit();
  check("pull_request", pr(beforeMixed, mixedDocs), true, false, true);
  check("push", { before: beforeMixed, after: mixedDocs }, true, false, true);
  check("push", { before: mixedCode, after: mixedDocs }, false);

  const code = git("rev-parse", "HEAD");
  write("docs/plan.md", "another doc change\n");
  const last = commit();
  check("pull_request", pr(base, last), true);
  check("push", { before: code, after: last }, false);

  renameSync(join(repo, "apps/example.ts"), join(repo, "docs/example.md"));
  const renamed = commit();
  check("pull_request", pr(last, renamed), true);
  rmSync(join(repo, "docs/plan.md"));
  const deleted = commit();
  check("push", { before: renamed, after: deleted }, false);

  // Both sides of a rename matter, including a code path moved into an E2E exclusion.
  const movedTeam = "apps/web/src/app/(app)/teams/moved.tsx";
  renameSync(join(repo, pollPage), join(repo, movedTeam));
  const pollToTeam = commit();
  check("pull_request", pr(deleted, pollToTeam), true, false, true);
  renameSync(join(repo, movedTeam), join(repo, pollPage));
  const teamToPoll = commit();
  check("push", { before: pollToTeam, after: teamToPoll }, true, false, true);
  for (const path of [pollPage, pollLoading]) {
    const before = git("rev-parse", "HEAD");
    rmSync(join(repo, path));
    check("push", { before, after: commit() }, true, false, false);
  }
  const beforeTeamDelete = git("rev-parse", "HEAD");
  rmSync(join(repo, "apps/web/src/app/(app)/teams/[slug]/page.tsx"));
  const teamDeleted = commit();
  check("pull_request", pr(beforeTeamDelete, teamDeleted), true, false, true);

  // The Git diff has no GitHub path filter's 300-file truncation.
  for (let i = 0; i < 301; i++) write(`docs/bulk/${i}.md`);
  write("z-code.ts");
  check("pull_request", pr(teamDeleted, commit()), true);
  check("workflow_dispatch", {}, true);
  check("push", { before: "0".repeat(40), after: last }, true);
  // Missing commits and malformed event SHAs must fail, never emit a skipped job.
  for (const baseSha of ["f".repeat(40), "not-a-commit"]) {
    const invalid = run("pull_request", pr(baseSha, last));
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.output, "");
  }
  const malformed = run("pull_request", {});
  assert.notEqual(malformed.status, 0);
  assert.equal(malformed.output, "");
});
