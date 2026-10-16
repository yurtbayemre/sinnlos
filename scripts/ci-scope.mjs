import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
let full = true;
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
  // A rename out of code must still include the deleted source path.
  const diff = spawnSync(
    "git",
    ["diff", "--quiet", "--no-renames", range, "--", ".", ":(exclude,glob)docs/**/*.md"],
    { stdio: "inherit" },
  );
  if (diff.error) throw diff.error;
  if (diff.status !== 0 && diff.status !== 1) throw new Error("Cannot determine CI scope");
  full = diff.status === 1;
}

appendFileSync(process.env.GITHUB_OUTPUT, `full=${full}\n`);
console.log(full ? "Full CI: code/config, contract docs or manual run" : "Docs only: format check");
