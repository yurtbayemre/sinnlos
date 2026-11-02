/**
 * apps/cms/scripts/check-boot-env.ts, the boot-value check infra/deploy.sh
 * runs in the new cms image (v0.30; v0.36.0 added the secret-sharing role
 * lists of the cms and the web). The script runs top to bottom per case, as
 * `node dist/scripts/check-boot-env.js` does, with the compose config on its
 * stdin (fd 0, stubbed here); what counts is its exit code and its messages.
 * CI runs the built script in the real image (.github/workflows/ci.yml).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const SCRIPT = "../apps/cms/scripts/check-boot-env";

/** Runs the script with `config` on stdin: its exit code and its error lines. */
async function check(config: unknown): Promise<{ code: number; errors: string[] }> {
  vi.resetModules();
  vi.doMock("node:fs", async (importOriginal) => {
    const fs = await importOriginal<typeof import("node:fs")>();
    const readFileSync = ((path: unknown, ...rest: unknown[]) =>
      path === 0
        ? JSON.stringify(config)
        : (fs.readFileSync as (...args: unknown[]) => unknown)(
            path,
            ...rest,
          )) as typeof fs.readFileSync;
    return { ...fs, default: { ...fs, readFileSync }, readFileSync };
  });
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    errors.push(String(line));
  });
  process.exitCode = 0;
  await import(SCRIPT);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { code, errors };
}

const compose = (cms: Record<string, string>, web: Record<string, string>) => ({
  services: {
    cms: { environment: { APP_TIME_ZONE: "Europe/Berlin", ...cms } },
    web: { environment: web },
  },
});

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.restoreAllMocks();
});

describe("check-boot-env: the secret-sharing role lists (v0.36.0)", () => {
  it("passes both unset, and lists that normalize equal", async () => {
    expect(await check(compose({}, {}))).toEqual({ code: 0, errors: [] });
    expect(
      await check(
        compose(
          { SECRETS_SEND_ROLES: "department_head,team_lead", SECRETS_RECEIVE_ROLES: "" },
          {
            SECRETS_SEND_ROLES: " TEAM_LEAD, Department_Head ,team_lead",
            SECRETS_RECEIVE_ROLES: "admin_role,editor,department_head,team_lead,member",
          },
        ),
      ),
    ).toEqual({ code: 0, errors: [] });
  });

  it("refuses a bad cms value with the parser's message", async () => {
    const run = await check(compose({ SECRETS_SEND_ROLES: "member,guest" }, {}));
    expect(run.code).toBe(1);
    expect(run.errors).toEqual([
      'ERROR: cms: SECRETS_SEND_ROLES: "guest" is not a staff role (one of admin_role, editor, department_head, team_lead, member; empty = all staff)',
    ]);
  });

  it("refuses a bad web value, naming the web", async () => {
    const run = await check(compose({}, { SECRETS_RECEIVE_ROLES: ", ," }));
    expect(run.code).toBe(1);
    expect(run.errors).toEqual([
      'ERROR: web: SECRETS_RECEIVE_ROLES: ", ," names no role (empty = all staff)',
    ]);
  });

  it("refuses lists that differ between the cms and the web, naming the key", async () => {
    const run = await check(compose({ SECRETS_SEND_ROLES: "team_lead" }, {}));
    expect(run.code).toBe(1);
    expect(run.errors).toEqual([
      "ERROR: SECRETS_SEND_ROLES: the cms and the web would get different lists; give both the same value",
    ]);
  });

  it("keeps the v0.30 checks, and a cms environment alone (the image's CI check)", async () => {
    const run = await check(compose({ APP_TIME_ZONE: "Europe/Berln" }, {}));
    expect(run.code).toBe(1);
    expect(run.errors.join("\n")).toContain("APP_TIME_ZONE must be an IANA time zone name");
    expect(await check({ services: { cms: { environment: {} } } })).toEqual({
      code: 0,
      errors: [],
    });
  });
});
