import type { CdpClient } from "./cdp-client";
import type { ConsoleEntry, NetworkEntry, PageError, DebugSnapshot } from "./types";

export class DebugEventBuffer {
  private readonly consoleEntries: ConsoleEntry[] = [];
  private readonly pageErrors: PageError[] = [];
  private readonly networkEntries: NetworkEntry[] = [];
  private readonly MAX_ENTRIES = 100;
  private readonly cleanupFns: Array<() => void> = [];

  subscribe(client: CdpClient, sessionId: string): void {
    void client.send("Console.enable", {}, sessionId).catch(() => {});
    void client.send("Runtime.enable", {}, sessionId).catch(() => {});
    void client.send("Network.enable", {}, sessionId).catch(() => {});

    const unsubConsole = client.on(
      "Console.messageAdded",
      (params: Record<string, unknown>) => {
        const msg = params.message as Record<string, unknown> | undefined;
        if (!msg) return;
        this.pushCapped(this.consoleEntries, {
          level: msg.level as string,
          text: msg.text as string,
          timestamp: (msg.timestamp as number) ?? Date.now(),
        });
      },
    );

    const unsubError = client.on(
      "Runtime.exceptionThrown",
      (params: Record<string, unknown>) => {
        const details = params.exceptionDetails as Record<string, unknown> | undefined;
        if (!details) return;
        this.pushCapped(this.pageErrors, {
          message: details.text as string,
          stack: details.stackTrace
            ? JSON.stringify(details.stackTrace)
            : undefined,
        });
      },
    );

    const unsubNetResponse = client.on(
      "Network.responseReceived",
      (params: Record<string, unknown>) => {
        const response = params.response as Record<string, unknown> | undefined;
        if (!response) return;
        this.pushCapped(this.networkEntries, {
          url: response.url as string,
          method: "GET",
          status: response.status as number,
          failed: false,
        });
      },
    );

    const unsubNetFailed = client.on(
      "Network.loadingFailed",
      (params: Record<string, unknown>) => {
        this.pushCapped(this.networkEntries, {
          url: (params.url as string) ?? "",
          method: "GET",
          status: undefined,
          failed: true,
        });
      },
    );

    const unsubNav = client.on(
      "Page.frameNavigated",
      (_params: Record<string, unknown>) => {
        this.clearAll();
      },
    );

    this.cleanupFns.push(
      unsubConsole,
      unsubError,
      unsubNetResponse,
      unsubNetFailed,
      unsubNav,
    );
  }

  clearAll(): void {
    this.consoleEntries.length = 0;
    this.pageErrors.length = 0;
    this.networkEntries.length = 0;
  }

  unsubscribe(): void {
    for (const cleanup of this.cleanupFns) {
      cleanup();
    }
    this.cleanupFns.length = 0;
  }

  getConsole(): ConsoleEntry[] {
    return [...this.consoleEntries];
  }

  getErrors(): PageError[] {
    return [...this.pageErrors];
  }

  getNetwork(): NetworkEntry[] {
    return [...this.networkEntries];
  }

  getAll(): DebugSnapshot {
    return {
      console: this.getConsole(),
      errors: this.getErrors(),
      network: this.getNetwork(),
    };
  }

  private pushCapped<T>(arr: T[], entry: T): void {
    arr.push(entry);
    if (arr.length > this.MAX_ENTRIES) {
      arr.shift();
    }
  }
}
