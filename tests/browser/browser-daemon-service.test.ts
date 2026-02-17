import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { BrowserDaemonService } from "../../src/browser/browser-daemon-service";
import { ok } from "../../src/result";
import { CdpClient } from "../../src/browser/cdp-client";

interface MockProcess {
  pid?: number;
  kill(signal?: number): void;
  exited: Promise<number>;
}

class MockCdpClient {
  public isConnected = false;
  public connectCalls = 0;
  public disconnectCalls = 0;

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.isConnected = false;
  }
}

function createMockProcess(pid = 4567): {
  process: MockProcess;
  killSignals: number[];
} {
  const killSignals: number[] = [];
  let resolveExit: ((value: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const process: MockProcess = {
    pid,
    kill(signal?: number): void {
      killSignals.push(signal ?? 15);
      if (resolveExit) {
        resolveExit(0);
        resolveExit = undefined;
      }
    },
    exited,
  };

  return { process, killSignals };
}

describe("BrowserDaemonService", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    BrowserDaemonService._resetBunSpawnForTests();
    globalThis.fetch = async () => {
      return {
        ok: true,
      } as Response;
    };
  });

  afterEach(() => {
    BrowserDaemonService._resetBunSpawnForTests();
    globalThis.fetch = originalFetch;
  });

  it("start() returns ok immediately and does not launch Chrome", async () => {
    const spawnCalls: string[][] = [];

    BrowserDaemonService._setBunSpawnForTests(((argv: string[]) => {
      spawnCalls.push(argv);
      const { process } = createMockProcess();
      return process as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn);

    const service = new BrowserDaemonService();
    const result = await service.start();

    expect(result).toEqual(ok(undefined));
    expect(spawnCalls).toHaveLength(0);
  });

  it("getStatus() returns stopped before browser launch", () => {
    const service = new BrowserDaemonService();
    const status = service.getStatus();

    expect(status.running).toBe(false);
    expect(status.tabs).toEqual([]);
  });

  it("ensureBrowser() launches Chrome and returns connected client", async () => {
    const spawnCalls: string[][] = [];
    const { process } = createMockProcess(1234);
    const mockClient = new MockCdpClient();

    const service = new BrowserDaemonService({
      config: { port: 9333, profilePath: "/tmp/reins-browser-profile" },
      findBinaryFn: async () => "/usr/bin/google-chrome",
      cdpClientFactory: () => mockClient as unknown as CdpClient,
      spawnFn: ((argv: string[]) => {
        spawnCalls.push(argv);
        return process as unknown as ReturnType<typeof Bun.spawn>;
      }) as typeof Bun.spawn,
    });

    const client = await service.ensureBrowser();

    expect(client).toBe(mockClient as unknown as CdpClient);
    expect(mockClient.isConnected).toBe(true);
    expect(mockClient.connectCalls).toBe(1);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.[0]).toBe("/usr/bin/google-chrome");
  });

  it("ensureBrowser() is idempotent and returns the same client", async () => {
    const { process } = createMockProcess(2222);
    const spawnCalls: string[][] = [];
    const mockClient = new MockCdpClient();

    const service = new BrowserDaemonService({
      config: { port: 9444, profilePath: "/tmp/reins-browser-profile-2" },
      findBinaryFn: async () => "/usr/bin/chromium",
      cdpClientFactory: () => mockClient as unknown as CdpClient,
      spawnFn: ((argv: string[]) => {
        spawnCalls.push(argv);
        return process as unknown as ReturnType<typeof Bun.spawn>;
      }) as typeof Bun.spawn,
    });

    const first = await service.ensureBrowser();
    const second = await service.ensureBrowser();

    expect(first).toBe(second);
    expect(spawnCalls).toHaveLength(1);
    expect(mockClient.connectCalls).toBe(1);
  });

  it("stop() terminates Chrome and disconnects CDP client", async () => {
    const { process, killSignals } = createMockProcess(3333);
    const mockClient = new MockCdpClient();

    const service = new BrowserDaemonService({
      config: { port: 9555, profilePath: "/tmp/reins-browser-profile-3" },
      findBinaryFn: async () => "/usr/bin/chromium-browser",
      cdpClientFactory: () => mockClient as unknown as CdpClient,
      spawnFn: (() => process as unknown as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn,
    });

    await service.ensureBrowser();
    const result = await service.stop();

    expect(result.ok).toBe(true);
    expect(mockClient.disconnectCalls).toBe(1);
    expect(killSignals[0]).toBe(15);
  });

  it("getStatus() returns running with chrome pid after launch", async () => {
    const { process } = createMockProcess(9999);
    const mockClient = new MockCdpClient();

    const service = new BrowserDaemonService({
      config: { port: 9666, profilePath: "/tmp/reins-browser-profile-4" },
      findBinaryFn: async () => "/usr/bin/chromium",
      cdpClientFactory: () => mockClient as unknown as CdpClient,
      spawnFn: (() => process as unknown as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn,
    });

    await service.ensureBrowser();
    const status = service.getStatus();

    expect(status.running).toBe(true);
    expect(status.chrome?.pid).toBe(9999);
  });
});
