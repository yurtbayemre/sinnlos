import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runPattern = /^sinnlos-e2e-[a-f0-9]{24}$/;
const projectLabel = "com.docker.compose.project";

/** App secrets, URLs, NODE_OPTIONS and Compose overrides never pass through. */
export function toolEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(path|home|userprofile|systemroot|windir|temp|tmp|appdata|localappdata|programdata|programfiles|docker_config)$/i.test(
        key,
      ),
    ),
  );
}

/** @param {string} text @param {string[]} secrets */
export function redact(text, secrets) {
  for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
  return text;
}

/** @param {string} parent @param {string} directory @param {string} runId */
export async function removePrivateRun(parent, directory, runId) {
  assert.match(runId, runPattern);
  assert.equal(await realpath(directory), join(await realpath(parent), runId));
  assert.equal(await readFile(join(directory, "owner"), "utf8"), runId);
  await rm(directory, { recursive: true });
}

/** @param {{Name?: string, Config?: {Labels?: Record<string, string>}}[]} containers @param {string} runId */
export function assertOwnedContainers(containers, runId) {
  assert.match(runId, runPattern);
  for (const container of containers) {
    assert.equal(container.Config?.Labels?.[projectLabel], runId);
    assert.ok(container.Name?.startsWith(`/${runId}-`));
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done(undefined));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((done, fail) =>
    server.close((error) => (error ? fail(error) : done(undefined))),
  );
  return address.port;
}

/** @param {string} url @param {AbortSignal} signal */
export async function requireReady(url, signal) {
  let response;
  try {
    response = await fetch(url, { signal, redirect: "manual" });
  } catch (error) {
    throw new Error(
      `Readiness failed: ${url}: ${error instanceof Error ? error.message : "request failed"}`,
    );
  }
  if (response.status !== 200)
    throw new Error(`Readiness failed: ${url} returned ${response.status}`);
  return response;
}

/** @param {string[]} args */
export async function main(args) {
  const checkOnly = args.length === 1 && args[0] === "--check";
  assert.ok(!args.includes("--check") || checkOnly, "Use --check alone");
  const runId = `sinnlos-e2e-${randomBytes(12).toString("hex")}`;
  const privateRoot = join(root, ".e2e", "runs");
  const runtime = join(privateRoot, runId);
  const logs = join(root, ".e2e", "logs", runId);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await chmod(runtime, 0o700);
  await writeFile(join(runtime, "owner"), runId, { mode: 0o600, flag: "wx" });
  await mkdir(logs, { recursive: true });
  const secret = () => randomBytes(32).toString("hex");
  const secrets = Array.from({ length: 14 }, secret);
  const [
    dbPassword,
    leadPassword,
    memberPassword,
    editorPassword,
    appKey1,
    appKey2,
    apiSalt,
    adminJwt,
    transferSalt,
    jwt,
    encryption,
    auth,
    revalidate,
    upload,
  ] = secrets;
  const controller = new AbortController();
  const interrupt = () => {
    process.exitCode = 130;
    controller.abort();
  };
  const terminate = () => {
    process.exitCode = 143;
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  /** @type {string[]} */
  let dockerPrefix = [];
  /** @type {string[]} */
  let compose = [];
  let configured = false;

  /** @param {string[]} command @param {string} log @param {number} timeout @param {boolean} cleanup */
  async function docker(command, log, timeout = 30_000, cleanup = false) {
    try {
      const result = await execute("docker", [...dockerPrefix, ...command], {
        cwd: root,
        env: toolEnv(),
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        signal: cleanup ? undefined : controller.signal,
      });
      await writeFile(join(logs, `${log}.log`), redact(result.stdout + result.stderr, secrets));
      return result.stdout.trim();
    } catch (error) {
      const detail = /** @type {Error & {stdout?: string, stderr?: string}} */ (error);
      await writeFile(
        join(logs, `${log}.log`),
        redact((detail.stdout ?? "") + (detail.stderr ?? "") + detail.message, secrets),
      );
      throw new Error(`${log} failed; see ${join(logs, `${log}.log`)}`);
    }
  }

  /** @param {string} name @param {Record<string, string>} values */
  async function envFile(name, values) {
    await writeFile(
      join(runtime, `${name}.env`),
      Object.entries(values)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join("\n") + "\n",
      { mode: 0o600, flag: "wx" },
    );
  }

  console.log(`[e2e] ${runId}; diagnostics: ${logs}`);
  try {
    // Pin a local endpoint so an inherited remote Docker context cannot receive test writes.
    const endpoint =
      process.env.DOCKER_HOST ||
      JSON.parse(
        await docker(
          [
            "context",
            "inspect",
            ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : []),
            "--format",
            "{{json .Endpoints.docker.Host}}",
          ],
          "docker-context",
        ),
      );
    assert.match(endpoint, /^(unix|npipe):\/\//, "E2E requires a local Docker daemon");
    dockerPrefix = ["--host", endpoint];
    assert.equal(
      await docker(["info", "--format", "{{.OSType}}"], "docker-info"),
      "linux",
      "E2E requires Linux containers",
    );
    await docker(["compose", "version"], "compose-version");
    const webPort = await freePort();
    const baseURL = `http://127.0.0.1:${webPort}`;
    const common = {
      NODE_ENV: "production",
      TZ: "UTC",
      APP_TIME_ZONE: "Europe/Berlin",
      DEMO_MODE: "0",
      ENTRA_ENABLED: "0",
      AUTH_LOCAL_ENABLED: "1",
      LOCAL_REGISTRATION: "0",
      LIVE_EVENTS_DISABLED: "1",
      REVALIDATE_SECRET: revalidate,
      INTERNAL_UPLOAD_TOKEN: upload,
    };
    await envFile("db", {
      POSTGRES_USER: "sinnlos_e2e",
      POSTGRES_DB: "sinnlos_e2e",
      POSTGRES_PASSWORD: dbPassword,
      PGTZ: "UTC",
    });
    await envFile("cms", {
      ...common,
      HOST: "0.0.0.0",
      PORT: "1337",
      ENV_PATH: "/tmp/no-such-e2e.env",
      E2E_RUN_ID: runId,
      E2E_LEAD_PASSWORD: leadPassword,
      E2E_MEMBER_PASSWORD: memberPassword,
      E2E_EDITOR_PASSWORD: editorPassword,
      DATABASE_CLIENT: "postgres",
      DATABASE_HOST: "db",
      DATABASE_PORT: "5432",
      DATABASE_NAME: "sinnlos_e2e",
      DATABASE_USERNAME: "sinnlos_e2e",
      DATABASE_PASSWORD: dbPassword,
      DATABASE_SSL: "false",
      APP_KEYS: `${appKey1},${appKey2}`,
      API_TOKEN_SALT: apiSalt,
      ADMIN_JWT_SECRET: adminJwt,
      TRANSFER_TOKEN_SALT: transferSalt,
      JWT_SECRET: jwt,
      ENCRYPTION_KEY: encryption,
      PUBLIC_URL: "http://cms:1337",
      CORS_ORIGIN: baseURL,
      PUBLIC_WEB_URL: baseURL,
      CRON_ENABLED: "0",
      DIGESTS_DISABLED: "1",
      SEED_DEMO_DATA: "0",
      STRAPI_TELEMETRY_DISABLED: "true",
    });
    await envFile("web", {
      ...common,
      HOSTNAME: "0.0.0.0",
      PORT: "3000",
      STRAPI_URL: "http://cms:1337",
      AUTH_URL: baseURL,
      AUTH_SECRET: auth,
      AUTH_TRUST_HOST: "true",
      DEFAULT_LOCALE: "en",
      NEXT_TELEMETRY_DISABLED: "1",
    });
    await envFile("compose", {
      E2E_RUN_ID: runId,
      E2E_RUNTIME: runtime.replaceAll("\\", "/"),
      E2E_WEB_PORT: String(webPort),
    });
    compose = [
      "compose",
      "--project-name",
      runId,
      "--env-file",
      join(runtime, "compose.env"),
      "-f",
      join(root, "e2e", "compose.yaml"),
    ];
    configured = true;
    console.log("[e2e] Building CMS and web from the current checkout");
    await docker([...compose, "build"], "build", 15 * 60_000);
    console.log("[e2e] Starting fresh PostgreSQL, CMS fixtures and web");
    await docker(
      [...compose, "up", "--detach", "--wait", "--wait-timeout", "180"],
      "startup",
      210_000,
    );
    const cmsId = await docker([...compose, "ps", "--quiet", "cms"], "cms-id");
    await docker(
      ["cp", `${cmsId}:/tmp/e2e-fixtures.json`, join(runtime, "fixtures.json")],
      "fixtures",
    );
    await chmod(join(runtime, "fixtures.json"), 0o600);
    /** @type {{runId: string, users: Record<string, {email: string, password: string}>}} */
    const fixtures = JSON.parse(await readFile(join(runtime, "fixtures.json"), "utf8"));
    assert.equal(fixtures.runId, runId, "Fixture ownership mismatch");
    await requireReady(
      `${baseURL}/sign-in`,
      AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    );
    const providers = await (
      await requireReady(
        `${baseURL}/api/auth/providers`,
        AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      )
    ).json();
    assert.deepEqual(Object.keys(providers), ["local"], "Expected real local sign-in only");
    const cmsAddress = await docker([...compose, "port", "cms", "1337"], "cms-port");
    assert.match(cmsAddress, /^127\.0\.0\.1:\d+$/);
    assert.deepEqual(Object.keys(fixtures.users).sort(), ["editor", "lead", "member"]);
    // Two preflight logins leave room for the real UI logins within Strapi's auth limit.
    for (const key of ["lead", "member"]) {
      const user = fixtures.users[key];
      const login = await fetch(`http://${cmsAddress}/api/auth/local`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: user.email, password: user.password }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      assert.equal(login.status, 200, `Fixture login failed for ${key}`);
      const { jwt: token } = await login.json();
      assert.equal(typeof token, "string", "Fixture login did not issue a token");
      const profile = await fetch(`http://${cmsAddress}/api/me`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      assert.equal(profile.status, 200, "Fixture profile unavailable");
      assert.equal((await profile.json()).data.role.type, key === "lead" ? "team_lead" : "member");
    }

    console.log("[e2e] Fresh fixtures and local sign-in are ready");
    if (!checkOnly) {
      const playwright = join(root, "e2e", "node_modules", "@playwright", "test", "cli.js");
      await new Promise((done, fail) => {
        const child = execFile(
          process.execPath,
          [playwright, "test", ...args],
          {
            cwd: join(root, "e2e"),
            env: {
              ...toolEnv(),
              CI: process.env.CI,
              SINNLOS_E2E_BASE_URL: baseURL,
              SINNLOS_E2E_FIXTURES: join(runtime, "fixtures.json"),
            },
            timeout: 6 * 60_000,
            signal: controller.signal,
          },
          (error) => (error ? fail(new Error("Playwright failed")) : done(undefined)),
        );
        child.stdout?.pipe(process.stdout);
        child.stderr?.pipe(process.stderr);
      });
    }
  } catch (error) {
    await writeFile(
      join(logs, "runner.log"),
      redact(error instanceof Error ? error.message : String(error), secrets),
    );
    throw error;
  } finally {
    try {
      if (configured) {
        const ids = (
          await docker(
            ["ps", "--all", "--quiet", "--filter", `label=${projectLabel}=${runId}`],
            "cleanup-ids",
            30_000,
            true,
          )
        )
          .split(/\s+/)
          .filter(Boolean);
        if (ids.length)
          assertOwnedContainers(
            JSON.parse(await docker(["inspect", ...ids], "cleanup-inspect", 30_000, true)),
            runId,
          );
        const networks = await docker(
          ["network", "ls", "--quiet", "--filter", `label=${projectLabel}=${runId}`],
          "cleanup-networks",
          30_000,
          true,
        );
        if (networks) {
          const entries = JSON.parse(
            await docker(
              ["network", "inspect", ...networks.split(/\s+/)],
              "cleanup-network-inspect",
              30_000,
              true,
            ),
          );
          for (const network of entries) {
            assert.equal(network.Name, `${runId}_default`);
            assert.equal(network.Labels?.[projectLabel], runId);
          }
        }
        try {
          await docker(
            [...compose, "logs", "--no-color", "--timestamps"],
            "services",
            30_000,
            true,
          );
        } finally {
          await docker(
            [...compose, "down", "--volumes", "--timeout", "20"],
            "cleanup",
            90_000,
            true,
          );
          for (const app of ["cms", "web"]) {
            const tag = `${runId}-${app}`;
            if (
              await docker(
                ["image", "ls", "--quiet", "--filter", `reference=${tag}`],
                `cleanup-${app}-image`,
                30_000,
                true,
              )
            ) {
              await docker(["image", "rm", tag], `cleanup-${app}-image-remove`, 30_000, true);
            }
          }
        }
        assert.equal(
          await docker(
            ["ps", "--all", "--quiet", "--filter", `label=${projectLabel}=${runId}`],
            "cleanup-verify",
            30_000,
            true,
          ),
          "",
        );
      }
    } finally {
      await removePrivateRun(privateRoot, runtime, runId);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    }
    console.log(`[e2e] Cleaned up ${runId}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch((error) => {
    console.error(`[e2e] ${error.message}`);
    process.exitCode ||= 1;
  });
}
