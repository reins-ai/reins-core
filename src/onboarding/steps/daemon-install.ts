import type { ServiceInstaller } from "../../daemon/service-installer";
import type { ServiceDefinition } from "../../daemon/types";
import type {
  OnboardingStepHandler,
  StepDefaults,
  StepExecutionContext,
  StepResult,
} from "./types";

const DEFAULT_HEALTH_URL = "http://localhost:7433/health";
const HEALTH_CHECK_TIMEOUT_MS = 3000;

export interface DaemonInstallStepOptions {
  serviceInstaller?: ServiceInstaller;
  /** Service definition for the daemon. Uses a sensible default if omitted. */
  serviceDefinition?: ServiceDefinition;
  /** Check if daemon is already running. Defaults to fetching the health endpoint. */
  checkHealth?: () => Promise<boolean>;
  /** Override fetch for testing. */
  fetchFn?: typeof globalThis.fetch;
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
 * Checks if the daemon is already running via health check. If running,
 * completes immediately. If not, delegates to ServiceInstaller to install
 * and start the service, then verifies health.
 */
export class DaemonInstallStep implements OnboardingStepHandler {
  readonly step = "daemon-install" as const;
  readonly skippable = false;

  private readonly serviceInstaller?: ServiceInstaller;
  private readonly serviceDefinition: ServiceDefinition;
  private readonly checkHealth: () => Promise<boolean>;

  constructor(options?: DaemonInstallStepOptions) {
    this.serviceInstaller = options?.serviceInstaller;
    this.serviceDefinition = options?.serviceDefinition ?? getDefaultServiceDefinition();

    if (options?.checkHealth) {
      this.checkHealth = options.checkHealth;
    } else {
      const fetchFn = options?.fetchFn ?? globalThis.fetch;
      this.checkHealth = () => this.defaultHealthCheck(fetchFn);
    }
  }

  async execute(_context: StepExecutionContext): Promise<StepResult> {
    // 1. Check if daemon is already running
    const alreadyRunning = await this.checkHealth();
    if (alreadyRunning) {
      return {
        status: "completed",
        data: {
          alreadyRunning: true,
          installMethod: "none",
        },
      };
    }

    // 2. If no installer provided, report that manual install is needed
    if (!this.serviceInstaller) {
      return {
        status: "completed",
        data: {
          alreadyRunning: false,
          installMethod: "manual",
          error: "No service installer available — daemon must be started manually",
        },
      };
    }

    // 3. Install via ServiceInstaller
    const installResult = await this.serviceInstaller.install(this.serviceDefinition);
    if (!installResult.ok) {
      return {
        status: "completed",
        data: {
          alreadyRunning: false,
          installMethod: "auto",
          installed: false,
          error: installResult.error.message,
        },
      };
    }

    // 4. Verify health after install
    const healthyAfterInstall = await this.checkHealth();
    return {
      status: "completed",
      data: {
        alreadyRunning: false,
        installMethod: "auto",
        installed: true,
        healthy: healthyAfterInstall,
        error: healthyAfterInstall
          ? undefined
          : "Daemon installed but health check failed — it may still be starting",
      },
    };
  }

  getDefaults(): StepDefaults {
    return {
      installMethod: "auto",
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
