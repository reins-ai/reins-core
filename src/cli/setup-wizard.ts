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

export type SetupWizardStep =
  | "welcome"
  | "daemon-check"
  | "provider-selection"
  | "credential-entry"
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
    apiKey?: string;
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

type FetchLike = (input: string) => Promise<Response>;

export interface RunSetupWizardOptions {
  reset?: boolean;
  io?: SetupWizardIO;
  fetchHealth?: FetchLike;
  configPath?: string;
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
      "This wizard configures your daemon connection, provider mode, and display name.",
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
  const nextStep = mode === "byok" ? "credential-entry" : "name";
  const providerMessage =
    mode === "byok"
      ? "Provider mode selected: BYOK"
      : mode === "gateway"
        ? "Provider mode selected: Reins Gateway"
        : "Provider mode selected: Skip for now";

  return {
    state: {
      ...state,
      provider: {
        mode,
      },
      step: nextStep,
    },
    output: [providerMessage],
  };
}

export function credentialEntryStep(state: SetupWizardState, apiKey: string): SetupStepResult {
  const normalizedApiKey = apiKey.trim();
  if (normalizedApiKey.length === 0) {
    return {
      state,
      output: ["API key is required for BYOK mode."],
    };
  }

  return {
    state: {
      ...state,
      provider: {
        mode: "byok",
        apiKey: normalizedApiKey,
      },
      step: "name",
    },
    output: [
      "Credential captured.",
      "Note: API key is stored in plaintext in config.json for now (temporary until keychain integration).",
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
  return {
    name: state.name,
    provider:
      state.provider.mode === "byok"
        ? {
            mode: "byok",
            apiKey: state.provider.apiKey,
          }
        : {
            mode: state.provider.mode,
          },
    daemon: {
      host: "localhost",
      port: 7433,
    },
    setupComplete: true,
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
  if (normalized === "1" || normalized === "byok") {
    return "byok";
  }

  if (normalized === "2" || normalized === "gateway") {
    return "gateway";
  }

  if (normalized === "3" || normalized === "none" || normalized === "skip") {
    return "none";
  }

  return null;
}

function buildSummary(state: SetupWizardState, configPath: string): string[] {
  const providerLabel =
    state.provider.mode === "byok" ? "BYOK" : state.provider.mode === "gateway" ? "Reins Gateway" : "Skip for now";

  return [
    "Setup summary:",
    `  Name: ${state.name}`,
    `  Provider: ${providerLabel}`,
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

export async function runSetupWizard(options: RunSetupWizardOptions = {}): Promise<SetupWizardResult> {
  const io = options.io ?? createConsoleSetupIO();
  const fetchHealth = options.fetchHealth ?? ((url: string) => fetch(url));
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

    await io.writeLine("Select provider mode:");
    await io.writeLine("  [1] BYOK");
    await io.writeLine("  [2] Reins Gateway");
    await io.writeLine("  [3] Skip for now");

    let mode: UserProviderMode | null = null;
    while (!mode) {
      const rawMode = await io.prompt("Choice: ");
      mode = parseProviderSelection(rawMode);
      if (!mode) {
        await io.writeLine("Please enter 1, 2, or 3.");
      }
    }

    const providerStepResult = providerSelectionStep(state, mode);
    state = providerStepResult.state;
    await emit(io, providerStepResult.output);

    if (state.step === "credential-entry") {
      let credentialComplete = false;
      while (!credentialComplete) {
        const apiKey = await io.prompt("Enter provider API key: ", { masked: true });
        const credentialResult = credentialEntryStep(state, apiKey);
        await emit(io, credentialResult.output);
        state = credentialResult.state;
        credentialComplete = state.step === "name";
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

    return {
      status: "completed",
      configPath,
      state,
      message: `Setup complete. Config saved to ${configPath}.`,
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
