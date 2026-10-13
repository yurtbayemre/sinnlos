import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CLASSIFIED_MAX_IMAGES, DOCUMENT_MAX_BYTES, IMAGE_MAX_BYTES } from "@sinnlos/domain";

/**
 * The two request-body limits of apps/web/next.config.mjs (batch 16 plan
 * S8, decision 06 §E8). An upload passes two Next edges before its Server
 * Action runs: the proxy (src/proxy.ts matches every path) buffers the
 * body up to `experimental.proxyClientMaxBodySize` (Next 16.4 default
 * 10 MB, a larger body is cut short), then the action parser refuses a
 * body above `experimental.serverActions.bodySizeLimit`. Both must let a
 * 20 MB document (and four 5 MB ad photos) with their multipart overhead
 * through, and both are written in one unit so they cannot drift apart.
 * Next's own config schema must accept them (a renamed key would be
 * ignored with a warning, silently back at 10 MB).
 */
const WEB_DIR = resolve(__dirname, "..");
const requireFromWeb = createRequire(resolve(WEB_DIR, "package.json"));

interface WebConfig {
  experimental?: {
    serverActions?: { bodySizeLimit?: string };
    proxyClientMaxBodySize?: string;
  };
}

async function loadConfig(): Promise<WebConfig> {
  const url = pathToFileURL(resolve(WEB_DIR, "next.config.mjs")).href;
  const module = (await import(/* @vite-ignore */ url)) as { default: WebConfig };
  return module.default;
}

/** "22mb" → bytes, as Next reads a size limit (binary units). */
function sizeOf(limit: string | undefined): number {
  const match = /^(\d+)mb$/.exec(limit ?? "");
  if (!match) throw new Error(`not a size in mb: ${String(limit)}`);
  return Number(match[1]) * 1024 * 1024;
}

/** The multipart envelope around one file (boundaries, headers, the action's own fields). */
const OVERHEAD = 1024 * 1024;

describe("next.config.mjs body limits (S8)", () => {
  it("sets the proxy cap and the server-action limit to the same 22 MB", async () => {
    const config = await loadConfig();
    expect(config.experimental?.serverActions?.bodySizeLimit).toBe("22mb");
    expect(config.experimental?.proxyClientMaxBodySize).toBe("22mb");
  });

  it("lets a 20 MB document and four 5 MB photos through both edges", async () => {
    const config = await loadConfig();
    for (const limit of [
      config.experimental?.proxyClientMaxBodySize,
      config.experimental?.serverActions?.bodySizeLimit,
    ]) {
      expect(sizeOf(limit)).toBeGreaterThanOrEqual(DOCUMENT_MAX_BYTES + OVERHEAD);
      expect(sizeOf(limit)).toBeGreaterThanOrEqual(
        CLASSIFIED_MAX_IMAGES * IMAGE_MAX_BYTES + OVERHEAD,
      );
    }
  });

  it("is a configuration this Next version accepts, and raises its 10 MB proxy default", async () => {
    const config = await loadConfig();
    const { configSchema } = requireFromWeb("next/dist/server/config-schema") as {
      configSchema: { safeParse(value: unknown): { success: boolean; error?: unknown } };
    };
    const parsed = configSchema.safeParse(config);
    expect(parsed.error).toBeUndefined();
    expect(parsed.success).toBe(true);
    const { defaultConfig } = requireFromWeb("next/dist/server/config-shared") as {
      defaultConfig: { experimental: { proxyClientMaxBodySize: number } };
    };
    expect(defaultConfig.experimental.proxyClientMaxBodySize).toBe(10 * 1024 * 1024);
    expect(sizeOf(config.experimental?.proxyClientMaxBodySize)).toBeGreaterThan(
      defaultConfig.experimental.proxyClientMaxBodySize,
    );
  });
});
