import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
  authMethodStep,
  checkDaemonHealth,
  confirmationStep,
  connectionValidationStep,
  createInitialSetupState,
  credentialEntryStep,
  daemonCheckStep,
  nameStep,
  parseAuthMethodSelection,
  parseProviderSelection,
  providerSelectionStep,
  runSetupWizard,
  toUserConfig,
  welcomeStep,
  type AuthMethod,
  type SetupDaemonAuthStatus,
  type SetupDaemonOAuthResult,
  type SetupDaemonResult,
  type SetupDaemonTransport,
  type SetupWizardIO,
  type SetupWizardState,
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

function createMockTransport(overrides: Partial<SetupDaemonTransport> = {}): SetupDaemonTransport {
  return {
    configureApiKey: overrides.configureApiKey ?? (async () => ({ success: true })),
    initiateOAuth: overrides.initiateOAuth ?? (async () => ({ success: true, authorizationUrl: "https://auth.anthropic.com/login" })),
    getProviderAuthStatus: overrides.getProviderAuthStatus ?? (async () => ({ connectionState: "ready", configured: true })),
  };
}

function createMockIO(responses: string[]): { io: SetupWizardIO; output: string[] } {
  const output: string[] = [];
  let responseIndex = 0;

  return {
    io: {
      writeLine: (text: string) => {
        output.push(text);
      },
      prompt: async () => {
        const response = responses[responseIndex] ?? "";
        responseIndex++;
        return response;
      },
      confirm: async (_question: string, defaultValue = true) => {
        const response = responses[responseIndex] ?? "";
        responseIndex++;
        if (response.length === 0) {
          return defaultValue;
        }
        return response.toLowerCase() === "y" || response.toLowerCase() === "yes";
      },
    },
    output,
  };
}

describe("setup wizard state machine", () => {
  it("transitions through welcome, daemon check, provider, auth method, credential, validation, name, confirmation", () => {
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
    expect(state.step).toBe("auth-method");
    expect(state.provider.activeProvider).toBe("anthropic");

    const authMethod = authMethodStep(state, "api_key");
    state = authMethod.state;
    expect(state.step).toBe("credential-entry");
    expect(state.provider.authMethod).toBe("api_key");

    const credential = credentialEntryStep(state, "sk-ant-api03-test123");
    state = credential.state;
    expect(state.step).toBe("connection-validation");

    const validation = connectionValidationStep(state, "ready");
    state = validation.state;
    expect(state.step).toBe("name");
    expect(state.provider.connectionVerified).toBe(true);

    const named = nameStep(state, "James");
    state = named.state;
    expect(state.step).toBe("confirmation");
    expect(state.name).toBe("James");

    const confirmed = confirmationStep(state, true);
    expect(confirmed.state.step).toBe("write-config");
  });

  it("transitions through OAuth auth method to oauth-launch step", () => {
    let state = createInitialSetupState();
    state = welcomeStep(state).state;
    state = daemonCheckStep(state, true).state;
    state = providerSelectionStep(state, "byok").state;

    const authMethod = authMethodStep(state, "oauth");
    state = authMethod.state;
    expect(state.step).toBe("oauth-launch");
    expect(state.provider.authMethod).toBe("oauth");
  });

  it("skips provider setup when mode is none", () => {
    let state = createInitialSetupState();
    state = welcomeStep(state).state;
    state = daemonCheckStep(state, true).state;

    const provider = providerSelectionStep(state, "none");
    state = provider.state;
    expect(state.step).toBe("name");
    expect(state.provider.mode).toBe("none");
    expect(provider.output.join(" ")).toContain("skipped");
  });

  it("returns to auth-method on failed connection validation", () => {
    let state = createInitialSetupState();
    state = welcomeStep(state).state;
    state = daemonCheckStep(state, true).state;
    state = providerSelectionStep(state, "byok").state;
    state = authMethodStep(state, "api_key").state;
    state = credentialEntryStep(state, "sk-invalid").state;

    const validation = connectionValidationStep(state, "invalid");
    state = validation.state;
    expect(state.step).toBe("auth-method");
    expect(state.provider.connectionVerified).toBe(false);
    expect(validation.output.join(" ")).toContain("could not be verified");
  });

  it("builds daemon guidance when daemon is missing", () => {
    const state = createInitialSetupState();
    const welcome = welcomeStep(state);
    const daemon = daemonCheckStep(welcome.state, false);

    expect(daemon.state.daemonOnline).toBe(false);
    expect(daemon.output.join("\n")).toContain("reins service install");
    expect(daemon.output.join("\n")).toContain("reins service start");
  });

  it("rejects empty API key with guidance", () => {
    let state = createInitialSetupState();
    state = welcomeStep(state).state;
    state = daemonCheckStep(state, true).state;
    state = providerSelectionStep(state, "byok").state;
    state = authMethodStep(state, "api_key").state;

    const credential = credentialEntryStep(state, "  ");
    expect(credential.state.step).toBe("credential-entry");
    expect(credential.output.join(" ")).toContain("required");
    expect(credential.output.join(" ")).toContain("console.anthropic.com");
  });
});

describe("provider selection parsing", () => {
  it("parses Anthropic selection values", () => {
    expect(parseProviderSelection("1")).toBe("byok");
    expect(parseProviderSelection("anthropic")).toBe("byok");
    expect(parseProviderSelection("Anthropic")).toBe("byok");
  });

  it("parses skip selection values", () => {
    expect(parseProviderSelection("2")).toBe("none");
    expect(parseProviderSelection("skip")).toBe("none");
    expect(parseProviderSelection("none")).toBe("none");
  });

  it("returns null for invalid selections", () => {
    expect(parseProviderSelection("3")).toBeNull();
    expect(parseProviderSelection("gateway")).toBeNull();
    expect(parseProviderSelection("unexpected")).toBeNull();
  });
});

describe("auth method selection parsing", () => {
  it("parses API key selection values", () => {
    expect(parseAuthMethodSelection("1")).toBe("api_key");
    expect(parseAuthMethodSelection("api_key")).toBe("api_key");
    expect(parseAuthMethodSelection("api key")).toBe("api_key");
    expect(parseAuthMethodSelection("key")).toBe("api_key");
  });

  it("parses OAuth selection values", () => {
    expect(parseAuthMethodSelection("2")).toBe("oauth");
    expect(parseAuthMethodSelection("oauth")).toBe("oauth");
    expect(parseAuthMethodSelection("browser")).toBe("oauth");
  });

  it("returns null for invalid selections", () => {
    expect(parseAuthMethodSelection("3")).toBeNull();
    expect(parseAuthMethodSelection("")).toBeNull();
    expect(parseAuthMethodSelection("unknown")).toBeNull();
  });
});

describe("connection validation step", () => {
  it("marks connection verified on ready state", () => {
    const state: SetupWizardState = {
      step: "connection-validation",
      reset: false,
      daemonOnline: true,
      provider: { mode: "byok", activeProvider: "anthropic", authMethod: "api_key" },
      name: "",
    };

    const result = connectionValidationStep(state, "ready");
    expect(result.state.step).toBe("name");
    expect(result.state.provider.connectionVerified).toBe(true);
    expect(result.output.join(" ")).toContain("Connection successful");
  });

  it("returns to auth-method on requires_auth state", () => {
    const state: SetupWizardState = {
      step: "connection-validation",
      reset: false,
      daemonOnline: true,
      provider: { mode: "byok", activeProvider: "anthropic", authMethod: "api_key" },
      name: "",
    };

    const result = connectionValidationStep(state, "requires_auth");
    expect(result.state.step).toBe("auth-method");
    expect(result.state.provider.connectionVerified).toBe(false);
  });

  it("returns to auth-method on requires_reauth state", () => {
    const state: SetupWizardState = {
      step: "connection-validation",
      reset: false,
      daemonOnline: true,
      provider: { mode: "byok", activeProvider: "anthropic", authMethod: "oauth" },
      name: "",
    };

    const result = connectionValidationStep(state, "requires_reauth");
    expect(result.state.step).toBe("auth-method");
    expect(result.state.provider.connectionVerified).toBe(false);
  });
});

describe("toUserConfig", () => {
  it("maps Anthropic BYOK state to user config with activeProvider", () => {
    const config = toUserConfig({
      step: "write-config",
      reset: false,
      daemonOnline: true,
      provider: {
        mode: "byok",
        activeProvider: "anthropic",
        authMethod: "api_key",
        connectionVerified: true,
      },
      name: "Maya",
    });

    expect(config).toEqual({
      name: "Maya",
      provider: {
        mode: "byok",
        activeProvider: "anthropic",
      },
      daemon: {
        host: "localhost",
        port: 7433,
      },
      setupComplete: true,
    });
  });

  it("maps OAuth state to user config with activeProvider", () => {
    const config = toUserConfig({
      step: "write-config",
      reset: false,
      daemonOnline: true,
      provider: {
        mode: "byok",
        activeProvider: "anthropic",
        authMethod: "oauth",
        connectionVerified: true,
      },
      name: "Taylor",
    });

    expect(config.provider.activeProvider).toBe("anthropic");
    expect(config.setupComplete).toBe(true);
  });

  it("marks setupComplete false when connection not verified", () => {
    const config = toUserConfig({
      step: "write-config",
      reset: false,
      daemonOnline: true,
      provider: {
        mode: "byok",
        activeProvider: "anthropic",
        authMethod: "api_key",
        connectionVerified: false,
      },
      name: "Test",
    });

    expect(config.setupComplete).toBe(false);
  });

  it("marks setupComplete true when provider mode is none", () => {
    const config = toUserConfig({
      step: "write-config",
      reset: false,
      daemonOnline: true,
      provider: {
        mode: "none",
      },
      name: "Test",
    });

    expect(config.setupComplete).toBe(true);
    expect(config.provider.activeProvider).toBeUndefined();
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
  it("writes and reads config roundtrip with activeProvider", async () => {
    const tempHome = await createTempDirectory();
    const filePath = join(tempHome, ".config", "reins", "config.json");

    const writeResult = await writeUserConfig(
      {
        name: "Taylor",
        provider: {
          mode: "byok",
          activeProvider: "anthropic",
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
    expect(readResult.value?.provider.activeProvider).toBe("anthropic");
  });

  it("resolves config path under data root", () => {
    const path = resolveUserConfigPath({
      platform: "linux",
      homeDirectory: "/home/example",
    });

    expect(path).toBe("/home/example/.reins/config.json");
  });
});

describe("full setup wizard flow", () => {
  it("completes API key setup with successful connection", async () => {
    const tempHome = await createTempDirectory();
    const configPath = join(tempHome, ".config", "reins", "config.json");

    const transport = createMockTransport();
    const { io, output } = createMockIO([
      "1",              // Choose Anthropic
      "1",              // Choose API Key
      "sk-ant-test123", // Enter API key
      "James",          // Name
      "y",              // Confirm
    ]);

    const result = await runSetupWizard({
      io,
      transport,
      configPath,
      fetchHealth: async () => new Response("ok", { status: 200 }),
    });

    expect(result.status).toBe("completed");
    expect(result.state.provider.activeProvider).toBe("anthropic");
    expect(result.state.provider.connectionVerified).toBe(true);
    expect(output.join("\n")).toContain("Connection successful");
    expect(result.message).toContain("Anthropic is connected");

    const readResult = await readUserConfig({ filePath: configPath });
    expect(readResult.ok).toBe(true);
    if (readResult.ok && readResult.value) {
      expect(readResult.value.provider.activeProvider).toBe("anthropic");
      expect(readResult.value.setupComplete).toBe(true);
    }
  });

  it("completes OAuth setup with successful connection", async () => {
    const tempHome = await createTempDirectory();
    const configPath = join(tempHome, ".config", "reins", "config.json");

    let pollCount = 0;
    const transport = createMockTransport({
      initiateOAuth: async () => ({
        success: true,
        authorizationUrl: "https://auth.anthropic.com/login?state=abc",
      }),
      getProviderAuthStatus: async () => {
        pollCount++;
        if (pollCount >= 1) {
          return { connectionState: "ready", configured: true };
        }
        return { connectionState: "requires_auth", configured: false };
      },
    });

    let openedUrl: string | undefined;
    const { io, output } = createMockIO([
      "1",      // Choose Anthropic
      "2",      // Choose OAuth
      "Taylor", // Name
      "y",      // Confirm
    ]);

    const result = await runSetupWizard({
      io,
      transport,
      configPath,
      fetchHealth: async () => new Response("ok", { status: 200 }),
      openUrl: async (url) => { openedUrl = url; },
    });

    expect(result.status).toBe("completed");
    expect(result.state.provider.activeProvider).toBe("anthropic");
    expect(result.state.provider.connectionVerified).toBe(true);
    expect(openedUrl).toBe("https://auth.anthropic.com/login?state=abc");
    expect(output.join("\n")).toContain("Opening browser");
    expect(output.join("\n")).toContain("Connection successful");
  });

  it("retries on invalid API key with guidance", async () => {
    const tempHome = await createTempDirectory();
    const configPath = join(tempHome, ".config", "reins", "config.json");

    let configureCallCount = 0;
    const transport = createMockTransport({
      configureApiKey: async () => {
        configureCallCount++;
        if (configureCallCount === 1) {
          return { success: false, error: "Invalid API key format." };
        }
        return { success: true };
      },
    });

    const { io, output } = createMockIO([
      "1",              // Choose Anthropic
      "1",              // Choose API Key (first attempt)
      "sk-bad",         // Enter bad API key
      "1",              // Choose API Key again (retry)
      "sk-ant-good123", // Enter good API key
      "James",          // Name
      "y",              // Confirm
    ]);

    const result = await runSetupWizard({
      io,
      transport,
      configPath,
      fetchHealth: async () => new Response("ok", { status: 200 }),
    });

    expect(result.status).toBe("completed");
    expect(configureCallCount).toBe(2);
    expect(output.join("\n")).toContain("Invalid API key format");
    expect(output.join("\n")).toContain("Connection successful");
  });

  it("retries on failed OAuth with guidance", async () => {
    const tempHome = await createTempDirectory();
    const configPath = join(tempHome, ".config", "reins", "config.json");

    let oauthCallCount = 0;
    const transport = createMockTransport({
      initiateOAuth: async () => {
        oauthCallCount++;
        if (oauthCallCount === 1) {
          return { success: false, error: "OAuth service unavailable." };
        }
        return { success: true, authorizationUrl: "https://auth.anthropic.com/login" };
      },
      getProviderAuthStatus: async () => ({ connectionState: "ready", configured: true }),
    });

    const { io, output } = createMockIO([
      "1",      // Choose Anthropic
      "2",      // Choose OAuth (first attempt - fails)
      "2",      // Choose OAuth again (retry - succeeds)
      "James",  // Name
      "y",      // Confirm
    ]);

    const result = await runSetupWizard({
      io,
      transport,
      configPath,
      fetchHealth: async () => new Response("ok", { status: 200 }),
      openUrl: async () => {},
    });

    expect(result.status).toBe("completed");
    expect(oauthCallCount).toBe(2);
    expect(output.join("\n")).toContain("OAuth service unavailable");
  });

  it("handles OAuth when daemon is offline and falls back to partial API key config", async () => {
    const tempHome = await createTempDirectory();
    const configPath = join(tempHome, ".config", "reins", "config.json");

    const transport = createMockTransport();
    const { io, output } = createMockIO([
      "1",              // Choose Anthropic
      "2",              // Choose OAuth (daemon offline — redirects to auth-method)
      "1",              // Fall back to API Key
      "sk-ant-test123", // Enter API key (daemon still offline — verification gate)
      "y",              // Save partial config (deferred verification)
      "James",          // Name
      "y",              // Confirm
    ]);

    const result = await runSetupWizard({
      io,
      transport,
      configPath,
      fetchHealth: async () => { throw new Error("offline"); },
    });

    expect(result.status).toBe("completed");
    expect(result.state.provider.connectionVerified).toBe(false);
    expect(output.join("\n")).toContain("OAuth requires a running daemon");
    expect(output.join("\n")).toContain("cannot verify connection");

    const readResult = await readUserConfig({ filePath: configPath });
    expect(readResult.ok).toBe(true);
    if (readResult.ok && readResult.value) {
      expect(readResult.value.setupComplete).toBe(false);
    }
  });

  it("skips provider setup and completes", async () => {
    const tempHome = await createTempDirectory();
    const configPath = join(tempHome, ".config", "reins", "config.json");

    const transport = createMockTransport();
    const { io } = createMockIO([
      "2",      // Skip provider
      "James",  // Name
      "y",      // Confirm
    ]);

    const result = await runSetupWizard({
      io,
      transport,
      configPath,
      fetchHealth: async () => new Response("ok", { status: 200 }),
    });

    expect(result.status).toBe("completed");
    expect(result.state.provider.mode).toBe("none");
    expect(result.state.provider.activeProvider).toBeUndefined();
  });

  it("handles connection validation failure and retries with different method", async () => {
    const tempHome = await createTempDirectory();
    const configPath = join(tempHome, ".config", "reins", "config.json");

    let statusCallCount = 0;
    const transport = createMockTransport({
      configureApiKey: async () => ({ success: true }),
      getProviderAuthStatus: async () => {
        statusCallCount++;
        if (statusCallCount === 1) {
          return { connectionState: "invalid" as const, configured: false };
        }
        return { connectionState: "ready" as const, configured: true };
      },
    });

    const { io, output } = createMockIO([
      "1",              // Choose Anthropic
      "1",              // Choose API Key (first attempt)
      "sk-bad-key",     // Enter API key (validation fails)
      "1",              // Choose API Key again (retry)
      "sk-good-key",    // Enter good API key
      "James",          // Name
      "y",              // Confirm
    ]);

    const result = await runSetupWizard({
      io,
      transport,
      configPath,
      fetchHealth: async () => new Response("ok", { status: 200 }),
    });

    expect(result.status).toBe("completed");
    expect(result.state.provider.connectionVerified).toBe(true);
    expect(output.join("\n")).toContain("could not be verified");
    expect(output.join("\n")).toContain("Connection successful");
  });

  it("cancels setup when user declines confirmation", async () => {
    const tempHome = await createTempDirectory();
    const configPath = join(tempHome, ".config", "reins", "config.json");

    const transport = createMockTransport();
    const { io } = createMockIO([
      "1",              // Choose Anthropic
      "1",              // Choose API Key
      "sk-ant-test123", // Enter API key
      "James",          // Name
      "n",              // Decline confirmation
    ]);

    const result = await runSetupWizard({
      io,
      transport,
      configPath,
      fetchHealth: async () => new Response("ok", { status: 200 }),
    });

    expect(result.status).toBe("cancelled");
    expect(result.state.step).toBe("cancelled");
  });

  it("blocks setup completion when daemon is offline and user saves partial config", async () => {
    const tempHome = await createTempDirectory();
    const configPath = join(tempHome, ".config", "reins", "config.json");

    const transport = createMockTransport();
    const { io, output } = createMockIO([
      "1",              // Choose Anthropic
      "1",              // Choose API Key
      "sk-ant-test123", // Enter API key
      "y",              // Save partial config (confirm deferred verification)
      "James",          // Name
      "y",              // Confirm
    ]);

    const result = await runSetupWizard({
      io,
      transport,
      configPath,
      fetchHealth: async () => { throw new Error("offline"); },
    });

    expect(result.status).toBe("completed");
    expect(result.state.provider.connectionVerified).toBe(false);
    expect(output.join("\n")).toContain("cannot verify connection");
    expect(output.join("\n")).toContain("marked incomplete");

    const readResult = await readUserConfig({ filePath: configPath });
    expect(readResult.ok).toBe(true);
    if (readResult.ok && readResult.value) {
      expect(readResult.value.setupComplete).toBe(false);
    }
  });

  it("cancels setup when daemon is offline and user declines partial config", async () => {
    const tempHome = await createTempDirectory();
    const configPath = join(tempHome, ".config", "reins", "config.json");

    const transport = createMockTransport();
    const { io, output } = createMockIO([
      "1",              // Choose Anthropic
      "1",              // Choose API Key
      "sk-ant-test123", // Enter API key
      "n",              // Decline partial config
    ]);

    const result = await runSetupWizard({
      io,
      transport,
      configPath,
      fetchHealth: async () => { throw new Error("offline"); },
    });

    expect(result.status).toBe("cancelled");
    expect(result.state.provider.connectionVerified).toBe(false);
    expect(result.message).toContain("daemon required");
    expect(output.join("\n")).toContain("cannot verify connection");
    expect(output.join("\n")).toContain("reins service start");
  });
});
