import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
let full = true;
let database = true;
let range;
if (process.env.GITHUB_EVENT_NAME === "pull_request") {
  range = `${event.pull_request.base.sha}...${event.pull_request.head.sha}`;
} else if (process.env.GITHUB_EVENT_NAME === "push" && !/^0+$/.test(event.before)) {
  range = `${event.before}..${event.after}`;
}

if (range) {
  if (!/^[a-f0-9]{40}\.{2,3}[a-f0-9]{40}$/.test(range)) {
    throw new Error("Invalid CI comparison commits");
  }
  const changesOutside = (...excluded) => {
    // A rename out of code must still include the deleted source path.
    const diff = spawnSync(
      "git",
      ["diff", "--quiet", "--no-renames", range, "--", ".", ...excluded],
      { stdio: "inherit" },
    );
    if (diff.error) throw diff.error;
    if (diff.status !== 0 && diff.status !== 1) throw new Error("Cannot determine CI scope");
    return diff.status === 1;
  };
  const docs = ":(exclude,glob)docs/**/*.md";
  full = changesOutside(docs);
  // CMS queries, shared rules, infra and dependency/config changes can affect stored data.
  database = changesOutside(docs, ":(exclude,glob)apps/web/**");
}

appendFileSync(process.env.GITHUB_OUTPUT, `full=${full}\ndatabase=${database}\n`);
console.log(`Application checks: ${full}; database tests: ${database}`);
