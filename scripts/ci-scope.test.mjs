import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./ci-scope.mjs", import.meta.url));

test("CI scope uses the whole change and excludes only ordinary documentation", (t) => {
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
  const check = (name, event, full) => {
    const result = run(name, event);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, `full=${full}\n`);
  };
  const pr = (base, head) => ({ pull_request: { base: { sha: base }, head: { sha: head } } });

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

  // README contracts, new executable docs and all unknown paths keep full CI.
  for (const path of [
    "README.md",
    "infra/migration/README.md",
    "docs/check.sh",
    ".github/workflows/ci.yml",
    "pnpm-lock.yaml",
    "apps/example.ts",
  ]) {
    const before = git("rev-parse", "HEAD");
    write(path, "changed\n");
    check("push", { before, after: commit() }, true);
  }
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

  // The Git diff has no GitHub path filter's 300-file truncation.
  for (let i = 0; i < 301; i++) write(`docs/bulk/${i}.md`);
  write("z-code.ts");
  check("pull_request", pr(deleted, commit()), true);
  check("workflow_dispatch", {}, true);
  check("push", { before: "0".repeat(40), after: last }, true);
  const invalid = run("pull_request", pr("f".repeat(40), last));
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.output, "");
});
