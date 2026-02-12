import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { runCli } from "../../src/cli/index";
import { runOneshot } from "../../src/cli/commands/oneshot";
import { runStatus } from "../../src/cli/commands/status";
import { runSetupWizard, type SetupWizardIO } from "../../src/cli/setup-wizard";

interface CloseEventLike {
  code: number;
  reason: string;
}

interface MessageEventLike {
  data: string;
}

class FakeStdout {
  public readonly writes: string[] = [];

  public write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  public once(_event: "drain", _listener: () => void): void {
    // no-op for tests that do not model backpressure
  }
}

class FakeWebSocket {
  private readonly listeners = {
    open: new Set<() => void>(),
    close: new Set<(event: CloseEventLike) => void>(),
    error: new Set<() => void>(),
    message: new Set<(event: MessageEventLike) => void>(),
  };

  constructor(private readonly onSend: (socket: FakeWebSocket, payload: string) => void) {
    queueMicrotask(() => {
      for (const listener of this.listeners.open) {
        listener();
      }
    });
  }

  public send(payload: string): void {
    this.onSend(this, payload);
  }

  public close(code = 1000, reason = "closed"): void {
    for (const listener of this.listeners.close) {
      listener({ code, reason });
    }
  }

  public addEventListener(type: "open", listener: () => void): void;
  public addEventListener(type: "close", listener: (event: CloseEventLike) => void): void;
  public addEventListener(type: "error", listener: () => void): void;
  public addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  public addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (() => void) | ((event: CloseEventLike) => void) | ((event: MessageEventLike) => void),
  ): void {
    if (type === "open" || type === "error") {
      (this.listeners[type] as Set<() => void>).add(listener as () => void);
      return;
    }

    if (type === "close") {
      this.listeners.close.add(listener as (event: CloseEventLike) => void);
      return;
    }

    this.listeners.message.add(listener as (event: MessageEventLike) => void);
  }

  public removeEventListener(type: "open", listener: () => void): void;
  public removeEventListener(type: "close", listener: (event: CloseEventLike) => void): void;
  public removeEventListener(type: "error", listener: () => void): void;
  public removeEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  public removeEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (() => void) | ((event: CloseEventLike) => void) | ((event: MessageEventLike) => void),
  ): void {
    if (type === "open" || type === "error") {
      (this.listeners[type] as Set<() => void>).delete(listener as () => void);
      return;
    }

    if (type === "close") {
      this.listeners.close.delete(listener as (event: CloseEventLike) => void);
      return;
    }

    this.listeners.message.delete(listener as (event: MessageEventLike) => void);
  }

  public serverMessage(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const listener of this.listeners.message) {
      listener({ data });
    }
  }
}

class QueueSetupIO implements SetupWizardIO {
  public readonly lines: string[] = [];

  constructor(
    private readonly promptAnswers: string[],
    private readonly confirmAnswers: boolean[] = [true],
  ) {}

  public async writeLine(text: string): Promise<void> {
    this.lines.push(text);
  }

  public async prompt(_question: string, _options?: { masked?: boolean }): Promise<string> {
    return this.promptAnswers.shift() ?? "";
  }

  public async confirm(_question: string, defaultValue?: boolean): Promise<boolean> {
    return this.confirmAnswers.shift() ?? defaultValue ?? true;
  }
}

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-cli-int-"));
  tempDirectories.push(directory);
  return directory;
}

function createJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("reins CLI routing integration", () => {
  it("routes no-arg invocation to TUI launch", async () => {
    let launchCalls = 0;

    const code = await runCli([], {
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

  it("renders help for help aliases and lists command family", async () => {
    for (const arg of ["help", "--help", "-h"]) {
      const output: string[] = [];

      const code = await runCli([arg], {
        writeStdout: (text) => {
          output.push(text);
        },
        writeStderr: () => {},
      });

      const rendered = output.join("");
      expect(code).toBe(0);
      expect(rendered).toContain("Commands:");
      expect(rendered).toContain("setup");
      expect(rendered).toContain("status");
      expect(rendered).toContain("service");
    }
  });

  it("renders branded version for version aliases", async () => {
    for (const arg of ["--version", "-v"]) {
      const output: string[] = [];

      const code = await runCli([arg], {
        version: "9.9.9",
        writeStdout: (text) => {
          output.push(text);
        },
        writeStderr: () => {},
      });

      expect(code).toBe(0);
      expect(output.join("")).toContain("reins v9.9.9");
    }
  });

  it("dispatches setup command entry", async () => {
    const setupCalls: string[][] = [];

    const code = await runCli(["setup", "--reset"], {
      runSetup: async (args = []) => {
        setupCalls.push(args);
        return 0;
      },
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    expect(setupCalls).toEqual([["--reset"]]);
  });

  it("dispatches status command entry", async () => {
    const statusCalls: string[][] = [];

    const code = await runCli(["status", "--json"], {
      runStatus: async (args = []) => {
        statusCalls.push(args);
        return 0;
      },
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    expect(statusCalls).toEqual([["--json"]]);
  });

  it("routes positional prompt to one-shot path", async () => {
    const calls: Array<{ query: string; options: Record<string, unknown> }> = [];

    const code = await runCli(["what", "is", "my", "next", "meeting"], {
      runOneshot: async (query, options = {}) => {
        calls.push({ query, options: options as Record<string, unknown> });
        return 0;
      },
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ query: "what is my next meeting", options: {} }]);
  });

  it("returns useful error output for invalid status args", async () => {
    const stderr: string[] = [];

    const code = await runCli(["status", "--unknown"], {
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr.push(text);
      },
    });

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("Unsupported status flag '--unknown'");
  });
});

describe("reins status integration", () => {
  it("shows branded running output with pid, uptime, provider, and model", async () => {
    const output: string[] = [];

    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return createJsonResponse({ status: "running", pid: 4421, uptimeSeconds: 3900, version: "0.3.0" });
      }

      if (url.endsWith("/status")) {
        return createJsonResponse({ provider: "fireworks", model: "llama-3.3-70b", modelCount: 7, sessionCount: 11 });
      }

      return createJsonResponse({}, 404);
    };

    const code = await runStatus([], {
      fetchFn,
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
    });

    const rendered = output.join("");
    expect(code).toBe(0);
    expect(rendered).toContain("reins status");
    expect(rendered).toContain("Daemon    ● running (PID 4421, uptime 1h 5m, v0.3.0)");
    expect(rendered).toContain("Provider  fireworks (7 models available)");
    expect(rendered).toContain("Model     llama-3.3-70b (active)");
  });

  it("shows offline status and remediation guidance when daemon is unavailable", async () => {
    const output: string[] = [];

    const code = await runStatus([], {
      fetchFn: async () => {
        throw new Error("offline");
      },
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
    });

    const rendered = output.join("");
    expect(code).toBe(0);
    expect(rendered).toContain("Daemon    ○ offline");
    expect(rendered).toContain("reins service start");
  });

  it("supports status --json output", async () => {
    const output: string[] = [];

    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return createJsonResponse({ status: "running", pid: 222, uptimeSeconds: 90, version: "0.4.1" });
      }

      if (url.endsWith("/status")) {
        return createJsonResponse({ provider: "gateway", model: "gpt-4o-mini", modelCount: 2, sessionCount: 5 });
      }

      return createJsonResponse({}, 404);
    };

    const code = await runStatus(["--json"], {
      fetchFn,
      writeStdout: (text) => {
        output.push(text);
      },
      writeStderr: () => {},
    });

    const parsed = JSON.parse(output.join("")) as {
      daemon: { status: string; pid: number; uptimeSeconds: number };
      provider: { name: string; modelsAvailable: number };
      model: { name: string };
      sessions: { count: number };
    };

    expect(code).toBe(0);
    expect(parsed.daemon.status).toBe("running");
    expect(parsed.daemon.pid).toBe(222);
    expect(parsed.provider.name).toBe("gateway");
    expect(parsed.model.name).toBe("gpt-4o-mini");
    expect(parsed.sessions.count).toBe(5);
  });
});

describe("reins setup integration", () => {
  it("runs welcome -> daemon check -> config write flow to XDG-style path", async () => {
    const tempRoot = await createTempDirectory();
    const configPath = join(tempRoot, "xdg", "reins", "config.json");
    const io = new QueueSetupIO(["2", "Jamie"], [true]);

    const result = await runSetupWizard({
      io,
      fetchHealth: async () => new Response("offline", { status: 503 }),
      configPath,
    });

    expect(result.status).toBe("completed");
    expect(io.lines[0]).toContain("Welcome to reins setup");
    expect(io.lines.join("\n")).toContain("Daemon is not reachable");
    expect(configPath).toContain("reins/config.json");

    const file = Bun.file(configPath);
    expect(await file.exists()).toBe(true);
    const parsed = (await file.json()) as { name: string; setupComplete: boolean; daemon: { port: number } };
    expect(parsed.name).toBe("Jamie");
    expect(parsed.setupComplete).toBe(true);
    expect(parsed.daemon.port).toBe(7433);
  });
});

describe("reins one-shot integration", () => {
  it("dispatches query to daemon, streams stdout, and exits 0 on success", async () => {
    const stdout = new FakeStdout();
    const stderr: string[] = [];
    const requests: Array<{ url: string; body: unknown }> = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const body = init?.body ? JSON.parse(init.body.toString()) : undefined;
      requests.push({ url, body });

      return createJsonResponse({
        conversationId: "conv-1",
        assistantMessageId: "msg-1",
      });
    };

    const webSocketFactory = () =>
      new FakeWebSocket((socket, payload) => {
        const request = JSON.parse(payload) as { type: string };
        if (request.type !== "stream.subscribe") {
          return;
        }

        queueMicrotask(() => {
          socket.serverMessage({
            type: "stream-event",
            event: {
              type: "delta",
              conversationId: "conv-1",
              messageId: "msg-1",
              delta: "hello",
              timestamp: new Date().toISOString(),
            },
          });
          socket.serverMessage({
            type: "stream-event",
            event: {
              type: "complete",
              conversationId: "conv-1",
              messageId: "msg-1",
              content: "hello",
              timestamp: new Date().toISOString(),
            },
          });
        });
      });

    const code = await runOneshot("hello", {}, { fetchImpl, webSocketFactory, stdout, stderrWrite: (text) => stderr.push(text) });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.writes).toEqual(["hello", "\n"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.endsWith("/messages")).toBe(true);
    expect(requests[0]?.body).toEqual({ content: "hello", model: undefined });
  });

  it("returns exit code 1 when daemon is unavailable", async () => {
    const stderr: string[] = [];

    const code = await runOneshot("hello", {}, {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      webSocketFactory: () => new FakeWebSocket(() => {}),
      stderrWrite: (text) => {
        stderr.push(text);
      },
    });

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("Daemon is not running");
  });
});
