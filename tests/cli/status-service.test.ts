import { describe, expect, it } from "bun:test";

import { runCli } from "../../src/cli/index";
import { runService } from "../../src/cli/commands/service";
import { runStatus } from "../../src/cli/commands/status";
import { DaemonError } from "../../src/daemon/types";
import { err, ok } from "../../src/result";

describe("runStatus", () => {
  it("prints daemon, provider, model, and usage summary when healthy", async () => {
    const output: string[] = [];

    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(
          JSON.stringify({
            status: "running",
            pid: 12345,
            uptimeSeconds: 8100,
            version: "0.1.0",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.endsWith("/status")) {
        return new Response(
          JSON.stringify({
            provider: "fireworks",
            model: "llama-3.3-70b",
            modelCount: 3,
            sessionCount: 12,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("{}", { status: 404 });
    };

    const code = await runStatus([], {
      fetchFn,
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    const rendered = output.join("");
    expect(rendered).toContain("Daemon    ● running (PID 12345, uptime 2h 15m, v0.1.0)");
    expect(rendered).toContain("Provider  fireworks (3 models available)");
    expect(rendered).toContain("Model     llama-3.3-70b (active)");
    expect(rendered).toContain("Sessions  12 conversations");
  });

  it("shows actionable guidance when daemon is offline", async () => {
    const output: string[] = [];

    const fetchFn: typeof fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };

    const code = await runStatus([], {
      fetchFn,
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    const rendered = output.join("");
    expect(rendered).toContain("Daemon    ○ offline");
    expect(rendered).toContain("reins service start");
  });

  it("supports --json output", async () => {
    const output: string[] = [];

    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(
          JSON.stringify({ status: "running", pid: 321, uptimeSeconds: 62, version: "0.2.0" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.endsWith("/status")) {
        return new Response(
          JSON.stringify({ provider: "fireworks", model: "llama-3.3-70b", modelCount: 5, sessionCount: 9 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("{}", { status: 404 });
    };

    const code = await runStatus(["--json"], {
      fetchFn,
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(output.join("")) as {
      daemon: { status: string; pid: number; uptimeSeconds: number; version: string };
      provider: { name: string; modelsAvailable: number };
      model: { name: string };
      sessions: { count: number };
    };

    expect(parsed.daemon.status).toBe("running");
    expect(parsed.daemon.pid).toBe(321);
    expect(parsed.provider.name).toBe("fireworks");
    expect(parsed.model.name).toBe("llama-3.3-70b");
    expect(parsed.sessions.count).toBe(9);
  });
});

describe("CLI service routing", () => {
  it("routes `reins service <action>` to runService", async () => {
    let routedAction = "";

    const code = await runCli(["service", "start"], {
      version: "0.1.0",
      launchTui: async () => 99,
      runOneshot: async () => 99,
      runSetup: async () => 99,
      runStatus: async () => 99,
      runService: async (action) => {
        routedAction = action;
        return 0;
      },
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    expect(routedAction).toBe("start");
  });
});

describe("runService", () => {
  it("renders platform-aware install output", async () => {
    const output: string[] = [];

    const code = await runService("install", {
      platform: "linux",
      installer: {
        generateConfig: () =>
          ok({
            platform: "linux",
            filePath: "/home/test/.config/systemd/user/com.reins.daemon.service",
            content: "",
          }),
        install: async () =>
          ok({
            platform: "linux",
            filePath: "/home/test/.config/systemd/user/com.reins.daemon.service",
            content: "",
          }),
        start: async () => ok(undefined),
        stop: async () => ok(undefined),
        restart: async () => ok(undefined),
      },
      fetchFn: async () => new Response("{}", { status: 200 }),
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    const rendered = output.join("");
    expect(rendered).toContain("via systemd");
    expect(rendered).toContain("com.reins.daemon.service");
  });

  it("preserves Result error paths with actionable remediation", async () => {
    const errors: string[] = [];

    const code = await runService("start", {
      platform: "linux",
      installer: {
        generateConfig: () =>
          ok({
            platform: "linux",
            filePath: "/home/test/.config/systemd/user/com.reins.daemon.service",
            content: "",
          }),
        install: async () =>
          ok({
            platform: "linux",
            filePath: "/home/test/.config/systemd/user/com.reins.daemon.service",
            content: "",
          }),
        start: async () => err(new DaemonError("permission denied", "DAEMON_COMMAND_FAILED")),
        stop: async () => ok(undefined),
        restart: async () => ok(undefined),
      },
      fetchFn: async () => new Response("{}", { status: 503 }),
      sleep: async () => {},
      writeStdout: () => {},
      writeStderr: (text) => {
        errors.push(text);
      },
    });

    expect(code).toBe(1);
    const rendered = errors.join("").toLowerCase();
    expect(rendered).toContain("failed to start service");
    expect(rendered).toContain("permission denied");
    expect(rendered).toContain("sudo reins service install");
  });
});
