import mermaid from "mermaid";
import { describe, expect, it } from "vitest";
import { MERMAID_MAX_TEXT_SIZE, mermaidConfig, renderMermaid } from "./mermaid-render";

/**
 * The renderer's settings and the rule that a diagram cannot change them.
 * Mermaid draws SVG only in a browser (it measures text), so what a hostile
 * diagram does to the DOM is e2e/mermaid.spec.ts; here the config logic runs
 * in node: Mermaid merges a diagram's `%%{init}%%` directive and front matter
 * `config:` into its settings while it parses, and drops the `secure` keys
 * (securityLevel, startOnLoad, maxTextSize, suppressErrorRendering, maxEdges)
 * on the way.
 */

const FLOW = "flowchart TD\n  A --> B";

describe("mermaidConfig", () => {
  it("is strict, never scans the page, throws instead of drawing an error graph", () => {
    expect(mermaidConfig(false)).toEqual({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "default",
    });
  });

  it("follows the app theme", () => {
    expect(mermaidConfig(true).theme).toBe("dark");
    expect(mermaidConfig(false).theme).toBe("default");
  });

  it("limits the text to Mermaid's maxTextSize", () => {
    expect(MERMAID_MAX_TEXT_SIZE).toBe(mermaid.mermaidAPI.defaultConfig.maxTextSize);
  });
});

describe("a diagram cannot change the settings", () => {
  const configAfterParsing = async (source: string) => {
    mermaid.initialize(mermaidConfig(false));
    await mermaid.parse(source);
    return mermaid.mermaidAPI.getConfig();
  };

  it("keeps the settings of the initialize call (positive control: a directive does set the theme)", async () => {
    const config = await configAfterParsing(`%%{init: {"theme": "forest"}}%%\n${FLOW}`);
    expect(config.theme).toBe("forest");
    expect(config.securityLevel).toBe("strict");
  });

  it.each([
    ["an init directive", `%%{init: {"securityLevel": "loose"}}%%\n${FLOW}`],
    [
      "an init directive that lists the key as nested",
      `%%{init: {"flowchart": {"securityLevel": "loose"}}}%%\n${FLOW}`,
    ],
    [
      "an init directive that empties the secure list first",
      `%%{init: {"secure": [], "securityLevel": "loose"}}%%\n${FLOW}`,
    ],
    ["a front matter config", `---\nconfig:\n  securityLevel: loose\n---\n${FLOW}`],
    [
      "both",
      `---\nconfig:\n  securityLevel: antiscript\n---\n%%{init: {"securityLevel": "loose"}}%%\n${FLOW}`,
    ],
  ])("refuses to lower securityLevel through %s", async (_label, source) => {
    expect((await configAfterParsing(source)).securityLevel).toBe("strict");
  });

  it("refuses the other secure keys too", async () => {
    const config = await configAfterParsing(
      `%%{init: {"startOnLoad": true, "maxTextSize": 999999999, "maxEdges": 999999, "suppressErrorRendering": false}}%%\n${FLOW}`,
    );
    expect(config).toMatchObject({
      startOnLoad: false,
      maxTextSize: MERMAID_MAX_TEXT_SIZE,
      suppressErrorRendering: true,
    });
    expect(config.maxEdges).toBe(mermaid.mermaidAPI.defaultConfig.maxEdges);
  });

  it("does not take a dompurifyConfig from a diagram (it is no config key)", async () => {
    const config = await configAfterParsing(
      `%%{init: {"dompurifyConfig": {"ADD_ATTR": ["onerror"]}}}%%\n${FLOW}`,
    );
    expect(config).not.toHaveProperty("dompurifyConfig");
  });
});

describe("renderMermaid", () => {
  it("rejects a render whose block is gone, without loading or drawing anything", async () => {
    await expect(renderMermaid(FLOW, false, AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
    // The queue goes on after a rejection.
    await expect(renderMermaid(FLOW, true, AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
