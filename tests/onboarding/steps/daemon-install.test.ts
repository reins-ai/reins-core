import { describe, expect, it } from "bun:test";

import { ok, err } from "../../../src/result";
import { DaemonError } from "../../../src/daemon/types";
import type { ServiceInstaller } from "../../../src/daemon/service-installer";
import type { OnboardingConfig, OnboardingMode } from "../../../src/onboarding/types";
import type { StepExecutionContext } from "../../../src/onboarding/steps/types";
import { DaemonInstallStep } from "../../../src/onboarding/steps/daemon-install";
import {
  getDaemonInstallCopy,
  DAEMON_INSTALL_COPY_VARIANTS,
} from "../../../src/onboarding/steps/copy";

function createContext(
  mode: OnboardingMode = "quickstart",
  collectedData: Record<string, unknown> = {},
): StepExecutionContext {
  const config: OnboardingConfig = {
    setupComplete: false,
    mode,
    currentStep: "daemon-install",
    completedSteps: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  return {
    mode,
    config,
    collectedData,
  };
}

function createMockServiceInstaller(options?: {
  installOk?: boolean;
  statusResult?: "running" | "stopped" | "not-installed";
}): ServiceInstaller {
  const installOk = options?.installOk ?? true;
  const statusResult = options?.statusResult ?? "running";

  return {
    async install() {
      if (!installOk) {
        return err(new DaemonError("Install failed", "DAEMON_INSTALL_WRITE_FAILED"));
      }
      return ok({
        platform: "linux" as const,
        filePath: "/tmp/reins-daemon.service",
        content: "mock-config",
      });
    },
    async start() {
      return ok(undefined);
    },
    async stop() {
      return ok(undefined);
    },
    async restart() {
      return ok(undefined);
    },
    async uninstall() {
      return ok(undefined);
    },
    async status() {
      return ok(statusResult);
    },
    generateConfig() {
      return ok({
        platform: "linux" as const,
        filePath: "/tmp/reins-daemon.service",
        content: "mock-config",
      });
    },
  } as unknown as ServiceInstaller;
}

describe("DaemonInstallStep", () => {
  it("is not skippable", () => {
    const step = new DaemonInstallStep();
    expect(step.skippable).toBe(false);
  });

  it("has step identifier 'daemon-install'", () => {
    const step = new DaemonInstallStep();
    expect(step.step).toBe("daemon-install");
  });

  it("returns defaults with installMethod and installPath", () => {
    const step = new DaemonInstallStep();
    const defaults = step.getDefaults();

    expect(defaults.installMethod).toBe("auto");
    expect(defaults.installPath).toBe("/usr/local/bin");
  });

  describe("quickstart mode", () => {
    it("completes immediately when daemon is already running", async () => {
      const step = new DaemonInstallStep({
        checkHealth: async () => true,
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data?.alreadyRunning).toBe(true);
      expect(result.data?.installMethod).toBe("none");
      expect(result.data?.installPath).toBe("/usr/local/bin");
    });

    it("includes friendly copy when daemon is already running", async () => {
      const step = new DaemonInstallStep({
        checkHealth: async () => true,
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);
      const copy = result.data?.copy as Record<string, string>;

      expect(copy.headline).toBeDefined();
      expect(copy.description).toBeDefined();
      expect(copy.benefit).toBeDefined();
      expect(copy.statusMessage).toBeDefined();
      // Should not contain raw config keys or technical jargon in balanced mode
      expect(copy.headline).not.toContain("localhost");
      expect(copy.description).not.toContain("7433");
    });

    it("installs via ServiceInstaller when daemon is not running", async () => {
      let installCalled = false;
      const mockInstaller = createMockServiceInstaller();
      const originalInstall = mockInstaller.install.bind(mockInstaller);
      (mockInstaller as Record<string, unknown>).install = async (...args: unknown[]) => {
        installCalled = true;
        return originalInstall(...(args as Parameters<typeof mockInstaller.install>));
      };

      let healthCheckCount = 0;
      const step = new DaemonInstallStep({
        serviceInstaller: mockInstaller,
        checkHealth: async () => {
          healthCheckCount++;
          return healthCheckCount > 1;
        },
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(installCalled).toBe(true);
      expect(result.status).toBe("completed");
      expect(result.data?.alreadyRunning).toBe(false);
      expect(result.data?.installMethod).toBe("auto");
      expect(result.data?.installed).toBe(true);
      expect(result.data?.healthy).toBe(true);
    });

    it("reports error when install fails", async () => {
      const mockInstaller = createMockServiceInstaller({ installOk: false });

      const step = new DaemonInstallStep({
        serviceInstaller: mockInstaller,
        checkHealth: async () => false,
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data?.installed).toBe(false);
      expect(result.data?.error).toBe("Install failed");
    });

    it("reports health check failure after successful install", async () => {
      const mockInstaller = createMockServiceInstaller();

      const step = new DaemonInstallStep({
        serviceInstaller: mockInstaller,
        checkHealth: async () => false,
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data?.installed).toBe(true);
      expect(result.data?.healthy).toBe(false);
      expect(result.data?.error).toContain("health check failed");
    });

    it("reports manual install needed when no installer provided", async () => {
      const step = new DaemonInstallStep({
        checkHealth: async () => false,
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data?.installMethod).toBe("manual");
      expect(result.data?.installPath).toBe("/usr/local/bin");
    });

    it("uses default install path without exposing it to user", async () => {
      const step = new DaemonInstallStep({
        checkHealth: async () => true,
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.data?.installPath).toBe("/usr/local/bin");
      // Quickstart copy should not include path customization prompts
      const copy = result.data?.copy as Record<string, string>;
      expect(copy.customPathPrompt).toBeUndefined();
    });
  });

  describe("advanced mode", () => {
    it("returns install path options for customization", async () => {
      const step = new DaemonInstallStep({
        checkHealth: async () => false,
      });
      const context = createContext("advanced");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data?.installPath).toBe("/usr/local/bin");
      const copy = result.data?.copy as Record<string, string>;
      expect(copy.defaultPathLabel).toBeDefined();
      expect(copy.customPathPrompt).toBeDefined();
    });

    it("shows daemon already running status in advanced mode", async () => {
      const step = new DaemonInstallStep({
        checkHealth: async () => true,
      });
      const context = createContext("advanced");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data?.alreadyRunning).toBe(true);
      expect(result.data?.installMethod).toBe("none");
    });

    it("includes full copy with path customization options", async () => {
      const step = new DaemonInstallStep({
        checkHealth: async () => false,
      });
      const context = createContext("advanced");

      const result = await step.execute(context);
      const copy = result.data?.copy as Record<string, string>;

      expect(copy.headline).toBeDefined();
      expect(copy.description).toBeDefined();
      expect(copy.benefit).toBeDefined();
      expect(copy.statusMessage).toBeDefined();
      expect(copy.defaultPathLabel).toBeDefined();
      expect(copy.customPathPrompt).toBeDefined();
    });
  });

  describe("personality-aware copy", () => {
    it("uses balanced copy by default", () => {
      const step = new DaemonInstallStep();
      const copy = step.getCopy();
      const expected = getDaemonInstallCopy("balanced");

      expect(copy.headline).toBe(expected.headline);
      expect(copy.description).toBe(expected.description);
    });

    it("uses personality preset from constructor", () => {
      const step = new DaemonInstallStep({
        personalityPreset: "warm",
        checkHealth: async () => true,
      });
      const copy = step.getCopy();
      const expected = getDaemonInstallCopy("warm");

      expect(copy.headline).toBe(expected.headline);
    });

    it("uses personality preset from context collectedData", () => {
      const step = new DaemonInstallStep({
        personalityPreset: "balanced",
        checkHealth: async () => true,
      });
      const context = createContext("quickstart", { personalityPreset: "technical" });
      const copy = step.getCopy(context);
      const expected = getDaemonInstallCopy("technical");

      expect(copy.headline).toBe(expected.headline);
    });

    it("context preset overrides constructor preset", () => {
      const step = new DaemonInstallStep({
        personalityPreset: "warm",
        checkHealth: async () => true,
      });
      const context = createContext("quickstart", { personalityPreset: "concise" });
      const copy = step.getCopy(context);
      const expected = getDaemonInstallCopy("concise");

      expect(copy.headline).toBe(expected.headline);
    });

    it("falls back to constructor preset when context has no personality", () => {
      const step = new DaemonInstallStep({
        personalityPreset: "technical",
        checkHealth: async () => true,
      });
      const context = createContext("quickstart");
      const copy = step.getCopy(context);
      const expected = getDaemonInstallCopy("technical");

      expect(copy.headline).toBe(expected.headline);
    });
  });

  describe("copy content quality", () => {
    it("all personality presets have complete copy", () => {
      const presets = ["balanced", "concise", "technical", "warm", "custom"] as const;

      for (const preset of presets) {
        const copy = DAEMON_INSTALL_COPY_VARIANTS[preset];
        expect(copy.headline).toBeTruthy();
        expect(copy.description).toBeTruthy();
        expect(copy.benefit).toBeTruthy();
        expect(copy.alreadyRunningMessage).toBeTruthy();
        expect(copy.installingMessage).toBeTruthy();
        expect(copy.installedMessage).toBeTruthy();
        expect(copy.manualInstallMessage).toBeTruthy();
        expect(copy.defaultPathLabel).toBeTruthy();
        expect(copy.customPathPrompt).toBeTruthy();
      }
    });

    it("balanced copy explains daemon purpose in plain language", () => {
      const copy = getDaemonInstallCopy("balanced");

      // Should explain what the daemon does without technical jargon
      expect(copy.description).toContain("background");
      expect(copy.description).toContain("scheduled tasks");
      expect(copy.description).toContain("briefings");
      // Should not contain raw technical terms
      expect(copy.description).not.toContain("localhost");
      expect(copy.description).not.toContain("WebSocket");
      expect(copy.description).not.toContain("AgentLoop");
    });

    it("warm copy is friendly and approachable", () => {
      const copy = getDaemonInstallCopy("warm");

      expect(copy.headline.length).toBeGreaterThan(10);
      expect(copy.description).toContain("quietly");
    });

    it("technical copy includes implementation details", () => {
      const copy = getDaemonInstallCopy("technical");

      expect(copy.description).toContain("cron");
      expect(copy.description).toContain("WebSocket");
    });

    it("concise copy is shorter than balanced", () => {
      const balanced = getDaemonInstallCopy("balanced");
      const concise = getDaemonInstallCopy("concise");

      expect(concise.description.length).toBeLessThan(balanced.description.length);
      expect(concise.headline.length).toBeLessThanOrEqual(balanced.headline.length);
    });
  });

  describe("health check", () => {
    it("uses default health check with custom fetch", async () => {
      const mockFetch = async () => new Response("ok", { status: 200 });

      const step = new DaemonInstallStep({
        fetchFn: mockFetch as typeof globalThis.fetch,
      });
      const context = createContext();

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data?.alreadyRunning).toBe(true);
    });

    it("default health check returns false on fetch error", async () => {
      const mockFetch = async () => {
        throw new Error("Connection refused");
      };

      const step = new DaemonInstallStep({
        fetchFn: mockFetch as typeof globalThis.fetch,
      });
      const context = createContext();

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data?.alreadyRunning).toBe(false);
    });

    it("default health check returns false on non-ok response", async () => {
      const mockFetch = async () => new Response("error", { status: 503 });

      const step = new DaemonInstallStep({
        fetchFn: mockFetch as typeof globalThis.fetch,
      });
      const context = createContext();

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data?.alreadyRunning).toBe(false);
    });
  });
});
