import type { PersonalityPreset } from "../types";
import type { ServiceInstaller } from "../../daemon/service-installer";
import type { ServiceDefinition } from "../../daemon/types";
import type {
  OnboardingStepHandler,
  StepDefaults,
  StepExecutionContext,
  StepResult,
} from "./types";
import { getDaemonInstallCopy, type DaemonInstallCopy } from "./copy";
import { DAEMON_PORT } from "../../config/defaults";

const DEFAULT_HEALTH_URL = `http://localhost:${DAEMON_PORT}/health`;
const HEALTH_CHECK_TIMEOUT_MS = 3000;
const DEFAULT_INSTALL_PATH = "/usr/local/bin";

export interface DaemonInstallStepOptions {
  serviceInstaller?: ServiceInstaller;
  /** Service definition for the daemon. Uses a sensible default if omitted. */
  serviceDefinition?: ServiceDefinition;
  /** Check if daemon is already running. Defaults to fetching the health endpoint. */
  checkHealth?: () => Promise<boolean>;
  /** Override fetch for testing. */
  fetchFn?: typeof globalThis.fetch;
  /** Personality preset to select copy tone. Defaults to "balanced". */
  personalityPreset?: PersonalityPreset;
}

/**
 * Default service definition for the Reins daemon.
 * Used when no custom definition is provided.
 */
function getDefaultServiceDefinition(): ServiceDefinition {
  return {
    serviceName: "com.reins.daemon",
    displayName: "Reins Daemon",
    description: "Reins personal assistant background daemon",
    command: "bun",
    args: ["run", "reins-daemon"],
    workingDirectory: process.cwd(),
    env: {},
    autoRestart: true,
  };
}

/**
 * Second onboarding step: installs and verifies the Reins daemon service.
 *
 * Presents friendly, non-technical copy explaining what the daemon does
 * (background service for scheduled tasks, briefings, and async work).
 *
 * In quickstart mode: uses the default install path and auto-installs.
 * In advanced mode: returns install path options for user customization.
 *
 * Copy is personality-aware — the tone adjusts based on the selected
 * personality preset (balanced, concise, technical, warm).
 */
export class DaemonInstallStep implements OnboardingStepHandler {
  readonly step = "daemon-install" as const;
  readonly skippable = false;

  private readonly serviceInstaller?: ServiceInstaller;
  private readonly serviceDefinition: ServiceDefinition;
  private readonly checkHealth: () => Promise<boolean>;
  private readonly personalityPreset: PersonalityPreset;

  constructor(options?: DaemonInstallStepOptions) {
    this.serviceInstaller = options?.serviceInstaller;
    this.serviceDefinition = options?.serviceDefinition ?? getDefaultServiceDefinition();
    this.personalityPreset = options?.personalityPreset ?? "balanced";

    if (options?.checkHealth) {
      this.checkHealth = options.checkHealth;
    } else {
      const fetchFn = options?.fetchFn ?? globalThis.fetch;
      this.checkHealth = () => this.defaultHealthCheck(fetchFn);
    }
  }

  async execute(context: StepExecutionContext): Promise<StepResult> {
    const copy = this.getCopy(context);

    if (context.mode === "quickstart") {
      return this.executeQuickstart(copy);
    }

    return this.executeAdvanced(copy);
  }

  getDefaults(): StepDefaults {
    return {
      installMethod: "auto",
      installPath: DEFAULT_INSTALL_PATH,
    };
  }

  /**
   * Get the personality-aware copy for this step.
   *
   * Checks the execution context's collected data for a personality
   * preset first (in case a previous step set it), then falls back
   * to the preset provided at construction time.
   */
  getCopy(context?: StepExecutionContext): DaemonInstallCopy {
    const contextPreset = context?.collectedData?.personalityPreset;
    const preset = isPersonalityPreset(contextPreset)
      ? contextPreset
      : this.personalityPreset;
    return getDaemonInstallCopy(preset);
  }

  private async executeQuickstart(copy: DaemonInstallCopy): Promise<StepResult> {
    const alreadyRunning = await this.checkHealth();
    if (alreadyRunning) {
      return {
        status: "completed",
        data: {
          alreadyRunning: true,
          installMethod: "none",
          installPath: DEFAULT_INSTALL_PATH,
          copy: {
            headline: copy.headline,
            description: copy.description,
            benefit: copy.benefit,
            statusMessage: copy.alreadyRunningMessage,
          },
        },
      };
    }

    if (!this.serviceInstaller) {
      return {
        status: "completed",
        data: {
          alreadyRunning: false,
          installMethod: "manual",
          installPath: DEFAULT_INSTALL_PATH,
          copy: {
            headline: copy.headline,
            description: copy.description,
            benefit: copy.benefit,
            statusMessage: copy.manualInstallMessage,
          },
        },
      };
    }

    const installResult = await this.serviceInstaller.install(this.serviceDefinition);
    if (!installResult.ok) {
      return {
        status: "completed",
        data: {
          alreadyRunning: false,
          installMethod: "auto",
          installed: false,
          installPath: DEFAULT_INSTALL_PATH,
          error: installResult.error.message,
          copy: {
            headline: copy.headline,
            description: copy.description,
            benefit: copy.benefit,
            statusMessage: copy.manualInstallMessage,
          },
        },
      };
    }

    const healthyAfterInstall = await this.checkHealth();
    return {
      status: "completed",
      data: {
        alreadyRunning: false,
        installMethod: "auto",
        installed: true,
        healthy: healthyAfterInstall,
        installPath: DEFAULT_INSTALL_PATH,
        error: healthyAfterInstall
          ? undefined
          : "Daemon installed but health check failed — it may still be starting",
        copy: {
          headline: copy.headline,
          description: copy.description,
          benefit: copy.benefit,
          statusMessage: healthyAfterInstall
            ? copy.installedMessage
            : copy.installingMessage,
        },
      },
    };
  }

  private async executeAdvanced(copy: DaemonInstallCopy): Promise<StepResult> {
    const alreadyRunning = await this.checkHealth();

    return {
      status: "completed",
      data: {
        alreadyRunning,
        installMethod: alreadyRunning ? "none" : "auto",
        installPath: DEFAULT_INSTALL_PATH,
        copy: {
          headline: copy.headline,
          description: copy.description,
          benefit: copy.benefit,
          statusMessage: alreadyRunning
            ? copy.alreadyRunningMessage
            : copy.installingMessage,
          defaultPathLabel: copy.defaultPathLabel,
          customPathPrompt: copy.customPathPrompt,
        },
      },
    };
  }

  private async defaultHealthCheck(fetchFn: typeof globalThis.fetch): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

      try {
        const response = await fetchFn(DEFAULT_HEALTH_URL, {
          signal: controller.signal,
        });
        return response.ok;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return false;
    }
  }
}

function isPersonalityPreset(value: unknown): value is PersonalityPreset {
  return (
    value === "balanced"
    || value === "concise"
    || value === "technical"
    || value === "warm"
    || value === "custom"
  );
}
