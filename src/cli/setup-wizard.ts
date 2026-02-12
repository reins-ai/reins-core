import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  readUserConfig,
  resolveUserConfigPath,
  writeUserConfig,
  type UserConfig,
  type UserProviderMode,
} from "../config/user-config";

const DAEMON_HEALTH_URL = "http://localhost:7433/health";
const DAEMON_BASE_URL = "http://localhost:7433";

export type AuthMethod = "api_key" | "oauth";

export type SetupWizardStep =
  | "welcome"
  | "daemon-check"
  | "provider-selection"
  | "auth-method"
  | "credential-entry"
  | "oauth-launch"
  | "connection-validation"
  | "name"
  | "confirmation"
  | "write-config"
  | "complete"
  | "cancelled";

export interface SetupWizardState {
  step: SetupWizardStep;
  reset: boolean;
  daemonOnline: boolean | null;
  provider: {
    mode: UserProviderMode;
    activeProvider?: string;
    authMethod?: AuthMethod;
    apiKey?: string;
    connectionVerified?: boolean;
  };
  name: string;
}

export interface SetupStepResult {
  state: SetupWizardState;
  output: string[];
}

export interface SetupWizardResult {
  status: "completed" | "cancelled" | "error";
  configPath: string;
  state: SetupWizardState;
  message: string;
}

export interface SetupWizardIO {
  writeLine(text: string): Promise<void> | void;
  prompt(question: string, options?: { masked?: boolean }): Promise<string>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SetupDaemonTransport {
  configureApiKey(provider: string, apiKey: string): Promise<SetupDaemonResult>;
  initiateOAuth(provider: string): Promise<SetupDaemonOAuthResult>;
  getProviderAuthStatus(provider: string): Promise<SetupDaemonAuthStatus>;
}

export interface SetupDaemonResult {
  success: boolean;
  error?: string;
}

export interface SetupDaemonOAuthResult {
  success: boolean;
  authorizationUrl?: string;
  error?: string;
}

export interface SetupDaemonAuthStatus {
  connectionState: "ready" | "requires_auth" | "requires_reauth" | "invalid";
  configured: boolean;
  error?: string;
}

export interface RunSetupWizardOptions {
  reset?: boolean;
  io?: SetupWizardIO;
  fetchHealth?: FetchLike;
  fetchApi?: FetchLike;
  transport?: SetupDaemonTransport;
  configPath?: string;
  openUrl?: (url: string) => Promise<void> | void;
}

export class SetupWizardCancelledError extends Error {
  constructor() {
    super("Setup cancelled by user");
    this.name = "SetupWizardCancelledError";
  }
}

export function createInitialSetupState(reset = false): SetupWizardState {
  return {
    step: "welcome",
    reset,
    daemonOnline: null,
    provider: {
      mode: "none",
    },
    name: "",
  };
}

export function welcomeStep(state: SetupWizardState): SetupStepResult {
  return {
    state: {
      ...state,
      step: "daemon-check",
    },
    output: [
      "Welcome to reins setup.",
      "This wizard connects you to Anthropic and configures your assistant.",
      "You can finish in under 2 minutes.",
    ],
  };
}

export function daemonCheckStep(state: SetupWizardState, daemonOnline: boolean): SetupStepResult {
  const daemonMessage = daemonOnline
    ? "Daemon is running at http://localhost:7433."
    : "Daemon is not reachable at http://localhost:7433.";

  const guidance = daemonOnline
    ? []
    : [
        "You can install/start it with:",
        "  reins service install",
        "  reins service start",
      ];

  return {
    state: {
      ...state,
      daemonOnline,
      step: "provider-selection",
    },
    output: [daemonMessage, ...guidance],
  };
}

export function providerSelectionStep(state: SetupWizardState, mode: UserProviderMode): SetupStepResult {
  if (mode === "none") {
    return {
      state: {
        ...state,
        provider: { mode: "none" },
        step: "name",
      },
      output: ["Provider setup skipped. You can configure a provider later with reins setup --reset."],
    };
  }

  return {
    state: {
      ...state,
      provider: {
        mode: "byok",
        activeProvider: "anthropic",
      },
      step: "auth-method",
    },
    output: ["Provider selected: Anthropic"],
  };
}

export function authMethodStep(state: SetupWizardState, method: AuthMethod): SetupStepResult {
  const nextStep = method === "api_key" ? "credential-entry" : "oauth-launch";
  const methodLabel = method === "api_key" ? "API Key" : "OAuth (Browser Login)";

  return {
    state: {
      ...state,
      provider: {
        ...state.provider,
        authMethod: method,
      },
      step: nextStep,
    },
    output: [`Authentication method: ${methodLabel}`],
  };
}

export function credentialEntryStep(state: SetupWizardState, apiKey: string): SetupStepResult {
  const normalizedApiKey = apiKey.trim();
  if (normalizedApiKey.length === 0) {
    return {
      state,
      output: ["API key is required. You can find your key at https://console.anthropic.com/settings/keys"],
    };
  }

  return {
    state: {
      ...state,
      provider: {
        ...state.provider,
        mode: "byok",
        apiKey: normalizedApiKey,
      },
      step: "connection-validation",
    },
    output: ["API key captured. Validating connection..."],
  };
}

export function connectionValidationStep(
  state: SetupWizardState,
  connectionState: "ready" | "requires_auth" | "requires_reauth" | "invalid",
): SetupStepResult {
  if (connectionState === "ready") {
    return {
      state: {
        ...state,
        provider: {
          ...state.provider,
          connectionVerified: true,
        },
        step: "name",
      },
      output: ["\u2713 Connection successful! Anthropic is ready."],
    };
  }

  return {
    state: {
      ...state,
      provider: {
        ...state.provider,
        connectionVerified: false,
      },
      step: "auth-method",
    },
    output: [
      "Connection could not be verified.",
      "Please check your credentials and try again.",
      "For API keys, visit https://console.anthropic.com/settings/keys",
    ],
  };
}

export function nameStep(state: SetupWizardState, name: string): SetupStepResult {
  const normalizedName = name.trim();
  if (normalizedName.length === 0) {
    return {
      state,
      output: ["Name is required."],
    };
  }

  return {
    state: {
      ...state,
      name: normalizedName,
      step: "confirmation",
    },
    output: [`Hi ${normalizedName}.`],
  };
}

export function confirmationStep(state: SetupWizardState, confirmed: boolean): SetupStepResult {
  return {
    state: {
      ...state,
      step: confirmed ? "write-config" : "cancelled",
    },
    output: confirmed ? ["Saving config..."] : ["Setup cancelled before writing config."],
  };
}

export function toUserConfig(state: SetupWizardState): UserConfig {
  const providerConfig: UserConfig["provider"] =
    state.provider.mode === "byok"
      ? {
          mode: "byok",
          apiKey: state.provider.apiKey,
          activeProvider: state.provider.activeProvider,
        }
      : {
          mode: state.provider.mode,
          activeProvider: state.provider.activeProvider,
        };

  return {
    name: state.name,
    provider: providerConfig,
    daemon: {
      host: "localhost",
      port: 7433,
    },
    setupComplete: state.provider.connectionVerified === true || state.provider.mode === "none",
  };
}

export async function checkDaemonHealth(fetchHealth: FetchLike): Promise<boolean> {
  try {
    const response = await fetchHealth(DAEMON_HEALTH_URL);
    return response.ok;
  } catch {
    return false;
  }
}

export function parseProviderSelection(inputValue: string): UserProviderMode | null {
  const normalized = inputValue.trim().toLowerCase();
  if (normalized === "1" || normalized === "anthropic") {
    return "byok";
  }

  if (normalized === "2" || normalized === "skip" || normalized === "none") {
    return "none";
  }

  return null;
}

export function parseAuthMethodSelection(inputValue: string): AuthMethod | null {
  const normalized = inputValue.trim().toLowerCase();
  if (normalized === "1" || normalized === "api_key" || normalized === "api key" || normalized === "key") {
    return "api_key";
  }

  if (normalized === "2" || normalized === "oauth" || normalized === "browser") {
    return "oauth";
  }

  return null;
}

function buildSummary(state: SetupWizardState, configPath: string): string[] {
  const providerLabel =
    state.provider.activeProvider === "anthropic"
      ? `Anthropic (${state.provider.authMethod === "oauth" ? "OAuth" : "API Key"})`
      : state.provider.mode === "none"
        ? "Not configured"
        : state.provider.mode;

  const connectionLabel = state.provider.connectionVerified ? "verified" : "not verified";

  return [
    "Setup summary:",
    `  Name: ${state.name}`,
    `  Provider: ${providerLabel}`,
    `  Connection: ${connectionLabel}`,
    `  Daemon: localhost:7433 (${state.daemonOnline ? "online" : "offline"})`,
    `  Config path: ${configPath}`,
  ];
}

async function emit(io: SetupWizardIO, lines: string[]): Promise<void> {
  for (const line of lines) {
    await io.writeLine(line);
  }
}

export function createConsoleSetupIO(): SetupWizardIO {
  const readline = createInterface({ input, output });

  const promptMasked = (question: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      if (typeof input.setRawMode !== "function") {
        readline
          .question(question)
          .then(resolve)
          .catch(reject);
        return;
      }

      let value = "";

      const cleanup = (): void => {
        input.off("data", onData);
        if (typeof input.setRawMode === "function") {
          input.setRawMode(false);
        }
        input.pause();
      };

      const onData = (chunk: Buffer): void => {
        const text = chunk.toString("utf8");

        if (text === "\u0003") {
          cleanup();
          reject(new SetupWizardCancelledError());
          return;
        }

        if (text === "\r" || text === "\n") {
          output.write("\n");
          cleanup();
          resolve(value);
          return;
        }

        if (text === "\u007f") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          return;
        }

        value += text;
        output.write("*");
      };

      output.write(question);
      if (typeof input.setRawMode === "function") {
        input.setRawMode(true);
      }
      input.resume();
      input.on("data", onData);
    });
  };

  const prompt = async (question: string, options?: { masked?: boolean }): Promise<string> => {
    if (options?.masked) {
      return promptMasked(question);
    }

    return readline.question(question);
  };

  const confirm = async (question: string, defaultValue = true): Promise<boolean> => {
    const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
    const raw = (await prompt(`${question}${suffix}`)).trim().toLowerCase();
    if (raw.length === 0) {
      return defaultValue;
    }

    return raw === "y" || raw === "yes";
  };

  return {
    writeLine: (text: string) => {
      output.write(`${text}\n`);
    },
    prompt,
    confirm,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class HttpSetupDaemonTransport implements SetupDaemonTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: { baseUrl?: string; fetchImpl?: FetchLike } = {}) {
    this.baseUrl = (options.baseUrl ?? DAEMON_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async configureApiKey(provider: string, apiKey: string): Promise<SetupDaemonResult> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/providers/validate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, apiKey, mode: "byok" }),
      });

      if (!response.ok) {
        return { success: false, error: `Validation failed (HTTP ${response.status})` };
      }

      const payload = await response.json() as Record<string, unknown>;
      if (payload.valid === false) {
        const errorMessage = typeof payload.error === "string" ? payload.error
          : typeof payload.message === "string" ? payload.message
          : "API key validation failed.";
        return { success: false, error: errorMessage };
      }

      const configureResponse = await this.fetchImpl(`${this.baseUrl}/api/providers/configure`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, apiKey, mode: "byok" }),
      });

      if (!configureResponse.ok) {
        return { success: false, error: `Configuration failed (HTTP ${configureResponse.status})` };
      }

      return { success: true };
    } catch {
      return { success: false, error: "Unable to reach daemon for API key validation." };
    }
  }

  public async initiateOAuth(provider: string): Promise<SetupDaemonOAuthResult> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/auth/oauth/initiate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, source: "cli" }),
      });

      if (!response.ok) {
        return { success: false, error: `OAuth initiation failed (HTTP ${response.status})` };
      }

      const payload = await response.json() as Record<string, unknown>;
      const authorization = isRecord(payload.authorization) ? payload.authorization : payload;
      const authorizationUrl = typeof authorization.authorizationUrl === "string"
        ? authorization.authorizationUrl
        : typeof authorization.url === "string"
          ? authorization.url
          : undefined;

      if (!authorizationUrl) {
        return { success: false, error: "No authorization URL returned from daemon." };
      }

      return { success: true, authorizationUrl };
    } catch {
      return { success: false, error: "Unable to reach daemon for OAuth initiation." };
    }
  }

  public async getProviderAuthStatus(provider: string): Promise<SetupDaemonAuthStatus> {
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/auth/status/${encodeURIComponent(provider)}`,
        { method: "GET" },
      );

      if (!response.ok) {
        return { connectionState: "requires_auth", configured: false, error: `Status check failed (HTTP ${response.status})` };
      }

      const payload = await response.json() as Record<string, unknown>;
      const connectionState = payload.connectionState;
      if (connectionState === "ready" || connectionState === "requires_auth" || connectionState === "requires_reauth" || connectionState === "invalid") {
        return {
          connectionState,
          configured: payload.configured === true,
        };
      }

      return { connectionState: "requires_auth", configured: payload.configured === true };
    } catch {
      return { connectionState: "requires_auth", configured: false, error: "Unable to reach daemon for status check." };
    }
  }
}

const OAUTH_POLL_INTERVAL_MS = 2_000;
const OAUTH_POLL_TIMEOUT_MS = 120_000;

async function defaultOpenUrl(url: string): Promise<void> {
  const { exec } = await import("node:child_process");
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  exec(`${command} "${url}"`);
}

async function pollForOAuthCompletion(
  transport: SetupDaemonTransport,
  provider: string,
  io: SetupWizardIO,
): Promise<"ready" | "requires_auth"> {
  const startTime = Date.now();

  while (Date.now() - startTime < OAUTH_POLL_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, OAUTH_POLL_INTERVAL_MS));

    const status = await transport.getProviderAuthStatus(provider);
    if (status.connectionState === "ready") {
      return "ready";
    }
  }

  await io.writeLine("OAuth login timed out. You can try again or use an API key instead.");
  return "requires_auth";
}

export async function runSetupWizard(options: RunSetupWizardOptions = {}): Promise<SetupWizardResult> {
  const io = options.io ?? createConsoleSetupIO();
  const fetchHealth = options.fetchHealth ?? ((url: string | URL | Request) => fetch(url));
  const fetchApi = options.fetchApi ?? ((url: string | URL | Request, init?: RequestInit) => fetch(url, init));
  const transport = options.transport ?? new HttpSetupDaemonTransport({ fetchImpl: fetchApi });
  const openUrl = options.openUrl ?? defaultOpenUrl;
  const configPath = options.configPath ?? resolveUserConfigPath();

  let state = createInitialSetupState(options.reset ?? false);

  try {
    const welcome = welcomeStep(state);
    state = welcome.state;
    await emit(io, welcome.output);

    const daemonOnline = await checkDaemonHealth(fetchHealth);
    const daemonStep = daemonCheckStep(state, daemonOnline);
    state = daemonStep.state;
    await emit(io, daemonStep.output);

    await io.writeLine("Choose a provider to connect:");
    await io.writeLine("  [1] Anthropic");
    await io.writeLine("  [2] Skip for now");

    let mode: UserProviderMode | null = null;
    while (!mode) {
      const rawMode = await io.prompt("Choice: ");
      mode = parseProviderSelection(rawMode);
      if (!mode) {
        await io.writeLine("Please enter 1 or 2.");
      }
    }

    const providerStepResult = providerSelectionStep(state, mode);
    state = providerStepResult.state;
    await emit(io, providerStepResult.output);

    if (state.step === "auth-method") {
      let authMethodSelected = false;

      while (!authMethodSelected) {
        await io.writeLine("Choose authentication method for Anthropic:");
        await io.writeLine("  [1] API Key");
        await io.writeLine("  [2] OAuth (Browser Login)");

        let authMethod: AuthMethod | null = null;
        while (!authMethod) {
          const rawMethod = await io.prompt("Choice: ");
          authMethod = parseAuthMethodSelection(rawMethod);
          if (!authMethod) {
            await io.writeLine("Please enter 1 or 2.");
          }
        }

        const authMethodResult = authMethodStep(state, authMethod);
        state = authMethodResult.state;
        await emit(io, authMethodResult.output);

        if (state.step === "credential-entry") {
          const apiKey = await io.prompt("Enter your Anthropic API key: ", { masked: true });
          const credentialResult = credentialEntryStep(state, apiKey);
          await emit(io, credentialResult.output);
          state = credentialResult.state;

          if (state.step === "connection-validation") {
            await io.writeLine("Testing connection...");

            if (daemonOnline) {
              const configureResult = await transport.configureApiKey("anthropic", state.provider.apiKey ?? "");
              if (configureResult.success) {
                const authStatus = await transport.getProviderAuthStatus("anthropic");
                const validationResult = connectionValidationStep(state, authStatus.connectionState);
                state = validationResult.state;
                await emit(io, validationResult.output);
              } else {
                await io.writeLine(configureResult.error ?? "API key validation failed.");
                const validationResult = connectionValidationStep(state, "invalid");
                state = validationResult.state;
                await emit(io, validationResult.output);
              }
            } else {
              const validationResult = connectionValidationStep(state, "ready");
              state = validationResult.state;
              await emit(io, ["Daemon offline — skipping live validation. Connection will be verified on next daemon start."]);
            }
          }
        } else if (state.step === "oauth-launch") {
          if (!daemonOnline) {
            await io.writeLine("OAuth requires a running daemon. Please start the daemon first:");
            await io.writeLine("  reins service start");
            const validationResult = connectionValidationStep(state, "requires_auth");
            state = validationResult.state;
            await emit(io, validationResult.output);
            continue;
          }

          await io.writeLine("Opening browser for Anthropic login...");
          const oauthResult = await transport.initiateOAuth("anthropic");

          if (!oauthResult.success || !oauthResult.authorizationUrl) {
            await io.writeLine(oauthResult.error ?? "Failed to start OAuth flow.");
            const validationResult = connectionValidationStep(state, "requires_auth");
            state = validationResult.state;
            await emit(io, validationResult.output);
            continue;
          }

          await openUrl(oauthResult.authorizationUrl);
          await io.writeLine("Waiting for browser login to complete...");
          await io.writeLine("(Press Ctrl+C to cancel)");

          const oauthConnectionState = await pollForOAuthCompletion(transport, "anthropic", io);
          state = {
            ...state,
            step: "connection-validation",
          };
          const validationResult = connectionValidationStep(state, oauthConnectionState);
          state = validationResult.state;
          await emit(io, validationResult.output);
        }

        authMethodSelected = state.step === "name";
      }
    }

    let nameComplete = false;
    while (!nameComplete) {
      const proposedName = await io.prompt("What should Reins call you? ");
      const nameResult = nameStep(state, proposedName);
      await emit(io, nameResult.output);
      state = nameResult.state;
      nameComplete = state.step === "confirmation";
    }

    await emit(io, buildSummary(state, configPath));
    const confirmed = await io.confirm("Confirm and write config?", true);
    const confirmationResult = confirmationStep(state, confirmed);
    state = confirmationResult.state;
    await emit(io, confirmationResult.output);

    if (state.step === "cancelled") {
      return {
        status: "cancelled",
        configPath,
        state,
        message: "Setup cancelled before config write.",
      };
    }

    const existingConfigResult = await readUserConfig({ filePath: configPath });
    if (!existingConfigResult.ok) {
      return {
        status: "error",
        configPath,
        state,
        message: existingConfigResult.error.message,
      };
    }

    const config = toUserConfig(state);
    const writeResult = await writeUserConfig(config, { filePath: configPath });
    if (!writeResult.ok) {
      return {
        status: "error",
        configPath,
        state,
        message: writeResult.error.message,
      };
    }

    state = {
      ...state,
      step: "complete",
    };

    const completionMessage = state.provider.connectionVerified
      ? `\u2713 Setup complete. Anthropic is connected. Config saved to ${configPath}.`
      : `Setup complete. Config saved to ${configPath}.`;

    return {
      status: "completed",
      configPath,
      state,
      message: completionMessage,
    };
  } catch (error) {
    if (error instanceof SetupWizardCancelledError) {
      return {
        status: "cancelled",
        configPath,
        state: {
          ...state,
          step: "cancelled",
        },
        message: "Setup cancelled.",
      };
    }

    return {
      status: "error",
      configPath,
      state,
      message: error instanceof Error ? error.message : "Unknown setup failure",
    };
  }
}
