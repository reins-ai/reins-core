import { describe, expect, it } from "bun:test";

import { runCli } from "../../src/cli/index";
import { runService } from "../../src/cli/commands/service";
import { DaemonError } from "../../src/daemon/types";
import { err, ok } from "../../src/result";

interface InstallerCalls {
  install: number;
  start: number;
  stop: number;
  restart: number;
}

function createInstaller(overrides: Partial<InstallerCalls> = {}) {
  const calls: InstallerCalls = {
    install: 0,
    start: 0,
    stop: 0,
    restart: 0,
    ...overrides,
  };

  return {
    calls,
    installer: {
      generateConfig: () =>
        ok({
          platform: "linux" as const,
          filePath: "/tmp/com.reins.daemon.service",
          content: "",
        }),
      install: async () => {
        calls.install += 1;
        return ok({
          platform: "linux" as const,
          filePath: "/tmp/com.reins.daemon.service",
          content: "",
        });
      },
      start: async () => {
        calls.start += 1;
        return ok(undefined);
      },
      stop: async () => {
        calls.stop += 1;
        return ok(undefined);
      },
      restart: async () => {
        calls.restart += 1;
        return ok(undefined);
      },
    },
  };
}

describe("service command dispatch integration", () => {
  it("routes CLI service subcommands to runService action values", async () => {
    const actions: string[] = [];

    for (const action of ["install", "start", "stop", "restart", "logs"]) {
      const code = await runCli(["service", action], {
        runService: async (value) => {
          actions.push(value);
          return 0;
        },
        writeStdout: () => {},
        writeStderr: () => {},
      });

      expect(code).toBe(0);
    }

    expect(actions).toEqual(["install", "start", "stop", "restart", "logs"]);
  });
});

describe("runService integration", () => {
  it("runs install flow", async () => {
    const { calls, installer } = createInstaller();
    const output: string[] = [];

    const code = await runService("install", {
      installer,
      platform: "linux",
      fetchFn: async () => new Response("{}", { status: 200 }),
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls.install).toBe(1);
    expect(output.join("\n")).toContain("reins service install");
  });

  it("runs start flow with health verification", async () => {
    const { calls, installer } = createInstaller();
    const output: string[] = [];
    const requestedUrls: string[] = [];

    const code = await runService("start", {
      installer,
      platform: "linux",
      fetchFn: async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        return new Response("{}", { status: 200 });
      },
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
      sleep: async () => {},
    });

    expect(code).toBe(0);
    expect(calls.start).toBe(1);
    expect(requestedUrls.some((url) => url.endsWith("/health"))).toBe(true);
    expect(output.join("\n")).toContain("daemon reachable at localhost:7433");
  });

  it("runs stop flow gracefully", async () => {
    const { calls, installer } = createInstaller();
    const output: string[] = [];

    const code = await runService("stop", {
      installer,
      platform: "linux",
      fetchFn: async () => new Response("{}", { status: 200 }),
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls.stop).toBe(1);
    expect(output.join("\n")).toContain("Service stopped via systemd");
  });

  it("runs restart flow and performs readiness check", async () => {
    const { calls, installer } = createInstaller();
    const output: string[] = [];

    const code = await runService("restart", {
      installer,
      platform: "linux",
      fetchFn: async () => new Response("{}", { status: 200 }),
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
      sleep: async () => {},
    });

    expect(code).toBe(0);
    expect(calls.restart).toBe(1);
    expect(output.join("\n")).toContain("Service restarted via systemd");
  });

  it("prints logs path and command hint", async () => {
    const { installer } = createInstaller();
    const output: string[] = [];

    const code = await runService("logs", {
      installer,
      platform: "linux",
      fetchFn: async () => new Response("{}", { status: 200 }),
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
    });

    const rendered = output.join("\n");
    expect(code).toBe(0);
    expect(rendered).toContain("reins service logs");
    expect(rendered).toContain("Logs");
    expect(rendered).toContain("journalctl --user -u");
  });
});

describe("platform-aware service output", () => {
  it("uses launchd messaging on macOS", async () => {
    const { installer } = createInstaller();
    const output: string[] = [];

    const code = await runService("install", {
      installer,
      platform: "darwin",
      fetchFn: async () => new Response("{}", { status: 200 }),
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    expect(output.join("\n")).toContain("via launchd");
  });

  it("uses systemd messaging on Linux", async () => {
    const { installer } = createInstaller();
    const output: string[] = [];

    const code = await runService("install", {
      installer,
      platform: "linux",
      fetchFn: async () => new Response("{}", { status: 200 }),
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    expect(output.join("\n")).toContain("via systemd");
  });
});

describe("service command error handling", () => {
  it("shows usage help when no subcommand is provided", async () => {
    const errors: string[] = [];

    const code = await runService("", {
      writeStdout: () => {},
      writeStderr: (text) => {
        errors.push(text);
      },
    });

    const rendered = errors.join("\n");
    expect(code).toBe(1);
    expect(rendered).toContain("Unknown action");
    expect(rendered).toContain("install|start|stop|restart|logs");
  });

  it("shows supported subcommands for invalid subcommand", async () => {
    const errors: string[] = [];

    const code = await runService("bad-action", {
      writeStdout: () => {},
      writeStderr: (text) => {
        errors.push(text);
      },
    });

    const rendered = errors.join("\n");
    expect(code).toBe(1);
    expect(rendered).toContain("Supported actions: install, start, stop, restart, logs");
  });

  it("returns actionable remediation when permission is denied", async () => {
    const errors: string[] = [];

    const code = await runService("start", {
      installer: {
        generateConfig: () =>
          ok({
            platform: "linux",
            filePath: "/tmp/com.reins.daemon.service",
            content: "",
          }),
        install: async () =>
          ok({
            platform: "linux",
            filePath: "/tmp/com.reins.daemon.service",
            content: "",
          }),
        start: async () => err(new DaemonError("permission denied", "DAEMON_COMMAND_FAILED")),
        stop: async () => ok(undefined),
        restart: async () => ok(undefined),
      },
      platform: "linux",
      fetchFn: async () => new Response("{}", { status: 503 }),
      writeStdout: () => {},
      writeStderr: (text) => {
        errors.push(text);
      },
    });

    const rendered = errors.join("\n").toLowerCase();
    expect(code).toBe(1);
    expect(rendered).toContain("failed to start service");
    expect(rendered).toContain("permission denied");
    expect(rendered).toContain("sudo reins service install");
  });
});
