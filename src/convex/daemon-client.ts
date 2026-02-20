interface ConvexRuntimeClient {
  setAuth(token: string): void;
  clearAuth?(): void;
}

interface ConvexRuntimeModule {
  ConvexHttpClient?: new (convexUrl: string) => ConvexRuntimeClient;
  ConvexClient?: new (convexUrl: string) => ConvexRuntimeClient;
}

export interface ConvexDaemonClientOptions {
  convexUrl: string;
  authToken?: string;
  clientFactory?: () => Promise<new (convexUrl: string) => ConvexRuntimeClient>;
}

export class ConvexDaemonClient {
  private readonly convexUrl: string;
  private readonly clientFactory: () => Promise<new (convexUrl: string) => ConvexRuntimeClient>;
  private authToken: string | null;
  private client: ConvexRuntimeClient | null = null;
  private loadError: Error | null = null;

  constructor(options: ConvexDaemonClientOptions) {
    this.convexUrl = options.convexUrl;
    this.authToken = this.normalizeToken(options.authToken);
    this.clientFactory = options.clientFactory ?? loadConvexClientCtor;
  }

  async initialize(): Promise<boolean> {
    if (this.client) {
      return true;
    }

    try {
      const ConvexClientCtor = await this.clientFactory();
      this.client = new ConvexClientCtor(this.convexUrl);
      if (this.authToken) {
        this.client.setAuth(this.authToken);
      }
      this.loadError = null;
      return true;
    } catch (error) {
      this.client = null;
      this.loadError = error instanceof Error
        ? error
        : new Error(String(error));
      return false;
    }
  }

  setAuthToken(token: string): void {
    this.authToken = this.normalizeToken(token);
    if (this.client && this.authToken) {
      this.client.setAuth(this.authToken);
      return;
    }

    if (this.client && !this.authToken && typeof this.client.clearAuth === "function") {
      this.client.clearAuth();
    }
  }

  getClient(): ConvexRuntimeClient | null {
    return this.client;
  }

  getLoadError(): Error | null {
    return this.loadError;
  }

  getConvexUrl(): string {
    return this.convexUrl;
  }

  getAuthToken(): string | null {
    return this.authToken;
  }

  isReady(): boolean {
    return this.client !== null;
  }

  private normalizeToken(token: string | undefined | null): string | null {
    if (typeof token !== "string") {
      return null;
    }

    const trimmed = token.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}

export function createConvexDaemonClientFromEnv(authToken?: string): ConvexDaemonClient | null {
  const convexUrl = readConvexUrlFromEnv();
  if (!convexUrl) {
    return null;
  }

  return new ConvexDaemonClient({
    convexUrl,
    authToken,
  });
}

function readConvexUrlFromEnv(): string | null {
  const raw = process.env.CONVEX_URL ?? Bun.env.CONVEX_URL;
  if (typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function loadConvexClientCtor(): Promise<new (convexUrl: string) => ConvexRuntimeClient> {
  const moduleName = ["convex", "browser"].join("/");
  const moduleExports = await import(moduleName) as ConvexRuntimeModule;
  const ctor = moduleExports.ConvexHttpClient ?? moduleExports.ConvexClient;

  if (!ctor) {
    throw new Error("Convex client constructor not found in convex/browser");
  }

  return ctor;
}
