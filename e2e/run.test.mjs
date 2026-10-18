import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { assertOwnedContainers, redact, removePrivateRun, requireReady, toolEnv } from "./run.mjs";

const runId = "sinnlos-e2e-0123456789abcdef01234567";

test("host app secrets and runtime/Compose overrides never reach children", () => {
  const keys = ["AUTH_URL", "DATABASE_URL", "COMPOSE_FILE", "NODE_OPTIONS", "DEMO_MODE"];
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "must-not-reach-the-stack";
    const env = toolEnv();
    for (const key of keys) assert.equal(env[key], undefined);
    assert.ok(Object.keys(env).some((key) => key.toLowerCase() === "path"));
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test("diagnostics redact repeated credentials without hiding useful errors", () => {
  assert.equal(
    redact("password=secret-value; failed secret-value", ["secret-value"]),
    "password=[redacted]; failed [redacted]",
  );
});

test("cleanup refuses containers with foreign labels or names", () => {
  const own = {
    Name: `/${runId}-cms-1`,
    Config: { Labels: { "com.docker.compose.project": runId } },
  };
  assert.doesNotThrow(() => assertOwnedContainers([own], runId));
  assert.throws(() => assertOwnedContainers([{ ...own, Name: "/production-cms-1" }], runId));
  assert.throws(() => assertOwnedContainers([{ ...own, Config: { Labels: {} } }], runId));
  assert.throws(() => assertOwnedContainers([], "production"));
});

test("private cleanup removes only the owned child directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "sinnlos-runner-test-"));
  const own = join(parent, runId);
  const foreign = join(parent, "keep-me");
  try {
    await mkdir(own);
    await mkdir(foreign);
    await writeFile(join(own, "owner"), "wrong-owner");
    await writeFile(join(foreign, "data"), "untouched");
    await assert.rejects(removePrivateRun(parent, own, runId));
    await assert.rejects(removePrivateRun(parent, foreign, runId));
    await writeFile(join(own, "owner"), runId);
    await removePrivateRun(parent, own, runId);
    assert.equal(await readFile(join(foreign, "data"), "utf8"), "untouched");
  } finally {
    assert.equal(dirname(await realpath(parent)), await realpath(tmpdir()));
    assert.ok(basename(parent).startsWith("sinnlos-runner-test-"));
    await rm(parent, { recursive: true });
  }
});

test("readiness rejects an actual 503 response and respects its deadline", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/hang") return;
    res.writeHead(503).end("not ready");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(requireReady(url, AbortSignal.timeout(1_000)), /returned 503/);
    await assert.rejects(requireReady(`${url}/hang`, AbortSignal.timeout(50)), /timeout/i);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(() => done(undefined)));
  }
});
