import { describe, expect, it } from "bun:test";

import { ok, err } from "../../../src/result";
import { DaemonError } from "../../../src/daemon/types";
import type { ServiceInstaller } from "../../../src/daemon/service-installer";
import type { OnboardingConfig, OnboardingMode } from "../../../src/onboarding/types";
import type { StepExecutionContext } from "../../../src/onboarding/steps/types";
import { DaemonInstallStep } from "../../../src/onboarding/steps/daemon-install";

function createContext(
  mode: OnboardingMode = "quickstart",
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
    collectedData: {},
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

  it("returns defaults with installMethod", () => {
    const step = new DaemonInstallStep();
    const defaults = step.getDefaults();

    expect(defaults).toEqual({
      installMethod: "auto",
    });
  });

  it("completes immediately when daemon is already running", async () => {
    const step = new DaemonInstallStep({
      checkHealth: async () => true,
    });
    const context = createContext();

    const result = await step.execute(context);

    expect(result.status).toBe("completed");
    expect(result.data?.alreadyRunning).toBe(true);
    expect(result.data?.installMethod).toBe("none");
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
        // First call: not running. Second call (post-install): running.
        return healthCheckCount > 1;
      },
    });
    const context = createContext();

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
    const context = createContext();

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
    const context = createContext();

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
    const context = createContext();

    const result = await step.execute(context);

    expect(result.status).toBe("completed");
    expect(result.data?.installMethod).toBe("manual");
    expect(result.data?.error).toContain("manually");
  });

  it("runs in both quickstart and advanced modes", async () => {
    const step = new DaemonInstallStep({
      checkHealth: async () => true,
    });

    const quickstartResult = await step.execute(createContext("quickstart"));
    const advancedResult = await step.execute(createContext("advanced"));

    // Daemon install always runs regardless of mode
    expect(quickstartResult.status).toBe("completed");
    expect(advancedResult.status).toBe("completed");
    expect(quickstartResult.data?.alreadyRunning).toBe(true);
    expect(advancedResult.data?.alreadyRunning).toBe(true);
  });

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

    // No installer provided, so it falls through to manual
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
