import { describe, expect, it } from "bun:test";

import { err, ok } from "../../src/result";
import { DaemonRuntime } from "../../src/daemon/runtime";
import { ServiceInstaller } from "../../src/daemon/service-installer";
import { DaemonError } from "../../src/daemon/types";
import type {
  DaemonLifecycleEvent,
  DaemonLifecycleLogger,
  PlatformCommandRunner,
  ServiceDefinition,
} from "../../src/daemon/types";

class TestLifecycleLogger implements DaemonLifecycleLogger {
  readonly events: DaemonLifecycleEvent[] = [];

  log(event: DaemonLifecycleEvent): void {
    this.events.push(event);
  }
}

const baseServiceDefinition: ServiceDefinition = {
  serviceName: "com.reins.daemon",
  displayName: "Reins Daemon",
  description: "Reins background service",
  command: "bun",
  args: ["run", "daemon"],
  workingDirectory: "/tmp/reins",
  env: {
    NODE_ENV: "production",
  },
  autoRestart: true,
};

describe("DaemonRuntime", () => {
  it("runs deterministic lifecycle transitions", async () => {
    const logger = new TestLifecycleLogger();
    const runtime = new DaemonRuntime({ logger, restartBackoffMs: 1 });

    runtime.registerService({
      id: "service-a",
      start: async () => ok(undefined),
      stop: async () => ok(undefined),
    });

    const started = await runtime.start();
    const stopped = await runtime.stop();

    expect(started.ok).toBe(true);
    expect(stopped.ok).toBe(true);
    expect(runtime.getState()).toBe("stopped");

    const transitions = logger.events
      .filter((event) => event.type === "state-transition")
      .map((event) => `${event.previousState}->${event.nextState}`);

    expect(transitions).toEqual(["stopped->starting", "starting->running", "running->stopping", "stopping->stopped"]);
  });

  it("rejects invalid transition when start is called while already running", async () => {
    const runtime = new DaemonRuntime({ restartBackoffMs: 1 });

    runtime.registerService({
      id: "service-a",
      start: async () => ok(undefined),
      stop: async () => ok(undefined),
    });

    const first = await runtime.start();
    const second = await runtime.start();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("DAEMON_INVALID_TRANSITION");
    }

    await runtime.stop();
  });

  it("fails stop with timeout and returns to stopped state", async () => {
    const runtime = new DaemonRuntime({ shutdownTimeoutMs: 10, restartBackoffMs: 1 });

    runtime.registerService({
      id: "service-a",
      start: async () => ok(undefined),
      stop: async () => {
        await new Promise<void>(() => {
          // intentionally never resolved
        });
        return ok(undefined);
      },
    });

    await runtime.start();
    const stopped = await runtime.stop();

    expect(stopped.ok).toBe(false);
    if (!stopped.ok) {
      expect(stopped.error.code).toBe("DAEMON_SHUTDOWN_TIMEOUT");
    }

    expect(runtime.getState()).toBe("stopped");
  });

  it("emits structured lifecycle events to observers", async () => {
    const runtime = new DaemonRuntime({ restartBackoffMs: 1 });
    const events: DaemonLifecycleEvent[] = [];

    runtime.onEvent((event) => {
      events.push(event);
    });

    runtime.registerService({
      id: "service-a",
      start: async () => ok(undefined),
      stop: async () => ok(undefined),
    });

    await runtime.start();
    await runtime.restart();
    await runtime.stop();

    const eventTypes = new Set(events.map((event) => event.type));
    expect(eventTypes.has("start-requested")).toBe(true);
    expect(eventTypes.has("stop-requested")).toBe(true);
    expect(eventTypes.has("restart-requested")).toBe(true);
    expect(eventTypes.has("state-transition")).toBe(true);
  });
});

describe("ServiceInstaller", () => {
  it("generates launchd user agent config on darwin", () => {
    const installer = new ServiceInstaller({
      platformDetector: () => "darwin",
    });

    const result = installer.generateConfig(baseServiceDefinition);
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value.filePath).toContain("Library/LaunchAgents/com.reins.daemon.plist");
      expect(result.value.content).toContain("<key>Label</key><string>com.reins.daemon</string>");
      expect(result.value.content).toContain("<key>KeepAlive</key><true/>");
    }
  });

  it("generates systemd user unit config on linux", () => {
    const installer = new ServiceInstaller({
      platformDetector: () => "linux",
    });

    const result = installer.generateConfig(baseServiceDefinition);
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value.filePath).toContain(".config/systemd/user/com.reins.daemon.service");
      expect(result.value.content).toContain("[Unit]");
      expect(result.value.content).toContain("Restart=always");
      expect(result.value.content).toContain("ExecStart=bun run daemon");
    }
  });

  it("generates windows user service config on win32", () => {
    const installer = new ServiceInstaller({
      platformDetector: () => "win32",
    });

    const result = installer.generateConfig(baseServiceDefinition);
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value.filePath).toContain("reins-daemon-service.json");
      expect(result.value.content).toContain("\"manager\": \"sc.exe\"");
      expect(result.value.content).toContain("\"serviceName\": \"com.reins.daemon\"");
    }
  });

  it("returns a typed error for unsupported platforms", () => {
    const installer = new ServiceInstaller({
      platformDetector: () => "freebsd",
    });

    const result = installer.generateConfig(baseServiceDefinition);
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("DAEMON_PLATFORM_UNSUPPORTED");
      expect(result.error).toBeInstanceOf(DaemonError);
    }
  });

  it("delegates install/status/uninstall to the active platform adapter", async () => {
    const commands: string[] = [];
    const runner: PlatformCommandRunner = {
      run: async (command, args) => {
        const full = `${command} ${args.join(" ")}`;
        commands.push(full);

        // status() now uses `show -p LoadState,ActiveState` instead of
        // `is-active` to distinguish "failed" from "not-installed".
        if (full.includes("show") && full.includes("LoadState")) {
          return ok({ stdout: "LoadState=loaded\nActiveState=active\n", stderr: "" });
        }

        return ok({ stdout: "ok", stderr: "" });
      },
    };

    const writes: string[] = [];
    const installer = new ServiceInstaller({
      platformDetector: () => "linux",
      runner,
      fileSystem: {
        mkdir: async () => {},
        writeFile: async (path) => {
          writes.push(path);
        },
        unlink: async (path) => {
          writes.push(`deleted:${path}`);
        },
        exists: async () => true,
      },
    });

    const installed = await installer.install(baseServiceDefinition);
    const status = await installer.status(baseServiceDefinition);
    const removed = await installer.uninstall(baseServiceDefinition);

    expect(installed.ok).toBe(true);
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value).toBe("running");
    }
    expect(removed.ok).toBe(true);

    expect(writes.some((entry) => entry.endsWith(".service"))).toBe(true);
    expect(commands).toContain("systemctl --user daemon-reload");
    expect(commands).toContain("systemctl --user enable --now com.reins.daemon.service");
    expect(commands).toContain("systemctl --user show -p LoadState,ActiveState com.reins.daemon.service");
    expect(commands).toContain("systemctl --user disable --now com.reins.daemon.service");
  });

  it("returns command runner failures as Result errors", async () => {
    const installer = new ServiceInstaller({
      platformDetector: () => "linux",
      runner: {
        run: async () => err(new DaemonError("failed", "DAEMON_COMMAND_FAILED")),
      },
      fileSystem: {
        mkdir: async () => {},
        writeFile: async () => {},
        unlink: async () => {},
        exists: async () => false,
      },
    });

    const result = await installer.install(baseServiceDefinition);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DAEMON_COMMAND_FAILED");
    }
  });
});
