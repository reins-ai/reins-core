import { describe, expect, it } from "bun:test";

import { runCli, routeCliArgs } from "../../src/cli/index";
import { formatBootBanner } from "../../src/cli/launch-tui";

describe("CLI launcher routing", () => {
  it("routes known commands", () => {
    expect(routeCliArgs(["setup"])).toEqual({ kind: "command", command: "setup", args: [] });
    expect(routeCliArgs(["status"])).toEqual({ kind: "command", command: "status", args: [] });
    expect(routeCliArgs(["service", "start"])).toEqual({
      kind: "command",
      command: "service",
      args: ["start"],
    });
  });

  it("defaults to launching TUI when no args are provided", async () => {
    let launchCalls = 0;

    const code = await runCli([], {
      version: "0.1.0",
      launchTui: async () => {
        launchCalls += 1;
        return 0;
      },
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    expect(launchCalls).toBe(1);
  });

  it("prints help output for --help", async () => {
    const output: string[] = [];

    const code = await runCli(["--help"], {
      version: "0.1.0",
      launchTui: async () => 1,
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    expect(output.join("")).toContain("Usage:");
    expect(output.join("")).toContain("reins [command]");
  });

  it("prints version output for --version", async () => {
    const output: string[] = [];

    const code = await runCli(["--version"], {
      version: "0.1.0",
      launchTui: async () => 1,
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    expect(output.join("")).toContain("reins v0.1.0");
  });

  it("routes positional unknown input to one-shot stub", async () => {
    const output: string[] = [];
    let launchCalls = 0;

    const code = await runCli(["what", "time", "is", "it"], {
      version: "0.1.0",
      launchTui: async () => {
        launchCalls += 1;
        return 0;
      },
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    expect(launchCalls).toBe(0);
    expect(output.join("")).toContain("one-shot mode is coming soon");
    expect(output.join("")).toContain("Query: what time is it");
  });

  it("falls back to TUI launch for unknown flag", async () => {
    let launchCalls = 0;

    const code = await runCli(["--unknown"], {
      version: "0.1.0",
      launchTui: async () => {
        launchCalls += 1;
        return 0;
      },
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    expect(launchCalls).toBe(1);
  });

  it("formats branded startup output", () => {
    expect(formatBootBanner("0.1.0")).toBe("reins v0.1.0 | launching TUI");
  });
});
