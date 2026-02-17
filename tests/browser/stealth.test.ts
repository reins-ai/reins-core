import { describe, expect, it, mock } from "bun:test";

import type { CdpClient } from "../../src/browser/cdp-client";
import type { CdpMethod } from "../../src/browser/types";
import { getStealthScripts, injectStealthScripts } from "../../src/browser/stealth";

interface CdpClientLike {
  send: <T = unknown>(
    method: CdpMethod,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<T>;
}

describe("getStealthScripts", () => {
  it("returns a non-empty array of scripts", () => {
    const scripts = getStealthScripts();
    expect(scripts.length).toBeGreaterThan(0);
  });

  it("scripts contain navigator.webdriver patch", () => {
    const scripts = getStealthScripts().join("\n");
    expect(scripts).toContain("navigator, 'webdriver'");
  });

  it("scripts contain cdc_ property removal", () => {
    const scripts = getStealthScripts().join("\n");
    expect(scripts).toContain("cdc_adoQpoasnfa76pfcZLmcfl_Array");
    expect(scripts).toContain("cdc_adoQpoasnfa76pfcZLmcfl_Promise");
    expect(scripts).toContain("cdc_adoQpoasnfa76pfcZLmcfl_Symbol");
  });

  it("scripts contain navigator.plugins override", () => {
    const scripts = getStealthScripts().join("\n");
    expect(scripts).toContain("Object.defineProperty(navigator, 'plugins'");
  });

  it("scripts contain navigator.languages override", () => {
    const scripts = getStealthScripts().join("\n");
    expect(scripts).toContain("Object.defineProperty(navigator, 'languages'");
  });
});

describe("injectStealthScripts", () => {
  it("calls Page.addScriptToEvaluateOnNewDocument for each script", async () => {
    const send = mock(async () => ({}));
    const client: CdpClientLike = { send };

    await injectStealthScripts(client as unknown as CdpClient);

    expect(send).toHaveBeenCalledTimes(getStealthScripts().length);
    const methods = send.mock.calls.map((call) => call[0]);
    expect(methods.every((method) => method === "Page.addScriptToEvaluateOnNewDocument")).toBe(true);
  });

  it("passes source as the script content", async () => {
    const send = mock(async () => ({}));
    const client: CdpClientLike = { send };

    await injectStealthScripts(client as unknown as CdpClient);

    const firstParams = send.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(typeof firstParams?.source).toBe("string");
    expect((firstParams?.source as string).length).toBeGreaterThan(0);
  });

  it("does not throw if injection succeeds", async () => {
    const send = mock(async () => ({}));
    const client: CdpClientLike = { send };

    await expect(
      injectStealthScripts(client as unknown as CdpClient),
    ).resolves.toBeUndefined();
  });
});
