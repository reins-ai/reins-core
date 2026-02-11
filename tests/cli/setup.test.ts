import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
  checkDaemonHealth,
  confirmationStep,
  createInitialSetupState,
  credentialEntryStep,
  daemonCheckStep,
  nameStep,
  parseProviderSelection,
  providerSelectionStep,
  toUserConfig,
  welcomeStep,
} from "../../src/cli/setup-wizard";
import { readUserConfig, resolveUserConfigPath, writeUserConfig } from "../../src/config/user-config";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-setup-test-"));
  tempDirectories.push(directory);
  return directory;
}

describe("setup wizard state machine", () => {
  it("transitions through welcome, daemon check, provider, credential, name, confirmation", () => {
    let state = createInitialSetupState();

    const welcome = welcomeStep(state);
    state = welcome.state;
    expect(state.step).toBe("daemon-check");

    const daemon = daemonCheckStep(state, true);
    state = daemon.state;
    expect(state.step).toBe("provider-selection");
    expect(state.daemonOnline).toBe(true);

    const provider = providerSelectionStep(state, "byok");
    state = provider.state;
    expect(state.step).toBe("credential-entry");

    const credential = credentialEntryStep(state, "sk-live-123");
    state = credential.state;
    expect(state.step).toBe("name");
    expect(state.provider.mode).toBe("byok");
    expect(state.provider.apiKey).toBe("sk-live-123");

    const named = nameStep(state, "James");
    state = named.state;
    expect(state.step).toBe("confirmation");
    expect(state.name).toBe("James");

    const confirmed = confirmationStep(state, true);
    expect(confirmed.state.step).toBe("write-config");
  });

  it("builds daemon guidance when daemon is missing", () => {
    const state = createInitialSetupState();
    const welcome = welcomeStep(state);
    const daemon = daemonCheckStep(welcome.state, false);

    expect(daemon.state.daemonOnline).toBe(false);
    expect(daemon.output.join("\n")).toContain("reins service install");
    expect(daemon.output.join("\n")).toContain("reins service start");
  });

  it("parses provider selection values", () => {
    expect(parseProviderSelection("1")).toBe("byok");
    expect(parseProviderSelection("gateway")).toBe("gateway");
    expect(parseProviderSelection("skip")).toBe("none");
    expect(parseProviderSelection("unexpected")).toBeNull();
  });

  it("maps final wizard state to user config schema", () => {
    const config = toUserConfig({
      step: "write-config",
      reset: false,
      daemonOnline: true,
      provider: {
        mode: "gateway",
      },
      name: "Maya",
    });

    expect(config).toEqual({
      name: "Maya",
      provider: {
        mode: "gateway",
      },
      daemon: {
        host: "localhost",
        port: 7433,
      },
      setupComplete: true,
    });
  });
});

describe("setup daemon checks", () => {
  it("returns true when daemon health returns ok", async () => {
    const healthy = await checkDaemonHealth(async () => new Response("ok", { status: 200 }));
    expect(healthy).toBe(true);
  });

  it("returns false when daemon health request fails", async () => {
    const healthy = await checkDaemonHealth(async () => {
      throw new Error("offline");
    });
    expect(healthy).toBe(false);
  });
});

describe("user config read/write", () => {
  it("writes and reads config roundtrip", async () => {
    const tempHome = await createTempDirectory();
    const filePath = join(tempHome, ".config", "reins", "config.json");

    const writeResult = await writeUserConfig(
      {
        name: "Taylor",
        provider: {
          mode: "byok",
          apiKey: "sk-temp",
        },
        daemon: {
          host: "localhost",
          port: 7433,
        },
        setupComplete: true,
      },
      { filePath },
    );

    expect(writeResult.ok).toBe(true);
    if (!writeResult.ok) {
      throw new Error("Write failed unexpectedly");
    }

    const readResult = await readUserConfig({ filePath });
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) {
      throw new Error("Read failed unexpectedly");
    }

    expect(readResult.value).toEqual(writeResult.value);
  });

  it("resolves XDG config path", () => {
    const path = resolveUserConfigPath({
      platform: "linux",
      env: {
        XDG_CONFIG_HOME: "/tmp/xdg-config",
      } as NodeJS.ProcessEnv,
      homeDirectory: "/home/example",
    });

    expect(path).toBe("/tmp/xdg-config/reins/config.json");
  });
});
