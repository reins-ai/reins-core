import { join } from "node:path";
import { getLogsDir, ServiceInstaller } from "../../index";
import type { ServiceDefinition } from "../../daemon/types";
import { DAEMON_PORT } from "../../config/defaults";

type WriteFn = (text: string) => void;
type ServiceAction = "install" | "start" | "stop" | "restart" | "logs";

const DEFAULT_DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;
const SUPPORTED_ACTIONS: ServiceAction[] = ["install", "start", "stop", "restart", "logs"];

type InstallerContract = Pick<ServiceInstaller, "generateConfig" | "install" | "start" | "stop" | "restart">;

interface ServiceCommandDeps {
  installer: InstallerContract;
  fetchFn: typeof fetch;
  writeStdout: WriteFn;
  writeStderr: WriteFn;
  daemonBaseUrl: string;
  platform: NodeJS.Platform;
  workingDirectory: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  serviceDefinition: Partial<ServiceDefinition>;
}

export type RunServiceFn = (action: string, customDeps?: Partial<ServiceCommandDeps>) => Promise<number>;

export async function runService(action: string, customDeps: Partial<ServiceCommandDeps> = {}): Promise<number> {
  const deps: ServiceCommandDeps = {
    installer: customDeps.installer ?? new ServiceInstaller(),
    fetchFn: customDeps.fetchFn ?? fetch,
    writeStdout: customDeps.writeStdout ?? process.stdout.write.bind(process.stdout),
    writeStderr: customDeps.writeStderr ?? process.stderr.write.bind(process.stderr),
    daemonBaseUrl: customDeps.daemonBaseUrl ?? DEFAULT_DAEMON_BASE_URL,
    platform: customDeps.platform ?? process.platform,
    workingDirectory: customDeps.workingDirectory ?? process.cwd(),
    now: customDeps.now ?? (() => new Date()),
    sleep: customDeps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    serviceDefinition: customDeps.serviceDefinition ?? {},
  };

  if (!isServiceAction(action)) {
    deps.writeStderr(
      [
        "reins service",
        "",
        `Unknown action '${action || ""}'. Supported actions: ${SUPPORTED_ACTIONS.join(", ")}`,
        "Usage:",
        "  reins service install|start|stop|restart|logs",
        "",
      ].join("\n"),
    );
    return 1;
  }

  const serviceDefinition = createServiceDefinition(deps);
  const platformLabel = getPlatformLabel(deps.platform);

  switch (action) {
    case "install": {
      const installResult = await deps.installer.install(serviceDefinition);
      if (!installResult.ok) {
        deps.writeStderr(formatErrorOutput("install", platformLabel, installResult.error.message));
        return 1;
      }

      deps.writeStdout(
        [
          "reins service install",
          "",
          `● Installed daemon service via ${platformLabel}.`,
          `Config   ${installResult.value.filePath}`,
          "",
          `Start it with:\n  reins service start`,
          "",
        ].join("\n"),
      );
      return 0;
    }

    case "start": {
      const startResult = await deps.installer.start(serviceDefinition);
      if (!startResult.ok) {
        deps.writeStderr(formatErrorOutput("start", platformLabel, startResult.error.message));
        return 1;
      }

      const healthReady = await verifyDaemonHealth(deps);
      deps.writeStdout(
        [
          "reins service start",
          "",
          `● Service start requested via ${platformLabel}.`,
          `Health   ${healthReady ? `daemon reachable at localhost:${DAEMON_PORT}` : "service started, but health endpoint not ready yet"}`,
          "",
        ].join("\n"),
      );
      return healthReady ? 0 : 1;
    }

    case "stop": {
      const stopResult = await deps.installer.stop(serviceDefinition);
      if (!stopResult.ok) {
        deps.writeStderr(formatErrorOutput("stop", platformLabel, stopResult.error.message));
        return 1;
      }

      deps.writeStdout(
        [
          "reins service stop",
          "",
          `● Service stopped via ${platformLabel}.`,
          "",
        ].join("\n"),
      );
      return 0;
    }

    case "restart": {
      const restartResult = await deps.installer.restart(serviceDefinition);
      if (!restartResult.ok) {
        deps.writeStderr(formatErrorOutput("restart", platformLabel, restartResult.error.message));
        return 1;
      }

      const healthReady = await verifyDaemonHealth(deps);
      deps.writeStdout(
        [
          "reins service restart",
          "",
          `● Service restarted via ${platformLabel}.`,
          `Health   ${healthReady ? `daemon reachable at localhost:${DAEMON_PORT}` : "restart completed, waiting for daemon health"}`,
          "",
        ].join("\n"),
      );
      return healthReady ? 0 : 1;
    }

    case "logs": {
      const logsDir = getLogsDir({ platform: deps.platform });
      deps.writeStdout(formatLogsOutput(platformLabel, logsDir, serviceDefinition.serviceName));
      return 0;
    }
  }
}

function isServiceAction(action: string): action is ServiceAction {
  return SUPPORTED_ACTIONS.includes(action as ServiceAction);
}

function createServiceDefinition(deps: ServiceCommandDeps): ServiceDefinition {
  const serviceName = deps.serviceDefinition.serviceName ?? "com.reins.daemon";
  const displayName = deps.serviceDefinition.displayName ?? "Reins Daemon";
  const description = deps.serviceDefinition.description ?? "Reins background service";
  const command = deps.serviceDefinition.command ?? process.execPath;
  // Point to daemon entry point in reins-core/src/daemon/index.ts
  const args = deps.serviceDefinition.args ?? [join(deps.workingDirectory, "src", "daemon", "index.ts")];
  const env = deps.serviceDefinition.env ?? {
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };
  const autoRestart = deps.serviceDefinition.autoRestart ?? true;

  return {
    serviceName,
    displayName,
    description,
    command,
    args,
    workingDirectory: deps.serviceDefinition.workingDirectory ?? deps.workingDirectory,
    env,
    autoRestart,
  };
}

async function verifyDaemonHealth(deps: ServiceCommandDeps): Promise<boolean> {
  const retries = 6;
  const intervalMs = 300;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    const isHealthy = await checkDaemonHealth(deps.fetchFn, deps.daemonBaseUrl);
    if (isHealthy) {
      return true;
    }

    if (attempt < retries - 1) {
      await deps.sleep(intervalMs);
    }
  }

  return false;
}

async function checkDaemonHealth(fetchFn: typeof fetch, daemonBaseUrl: string): Promise<boolean> {
  try {
    const response = await fetchFn(`${daemonBaseUrl}/health`, {
      headers: {
        accept: "application/json",
      },
    });

    return response.ok;
  } catch {
    return false;
  }
}

function formatErrorOutput(action: ServiceAction, platformLabel: string, message: string): string {
  const permissionHint =
    message.toLowerCase().includes("permission") || message.toLowerCase().includes("access")
      ? "Permission denied? Try: sudo reins service install"
      : "If the service is not installed yet, run: reins service install";

  return [
    `reins service ${action}`,
    "",
    `○ Failed to ${action} service via ${platformLabel}.`,
    `Error    ${message}`,
    "",
    permissionHint,
    "",
  ].join("\n");
}

function formatLogsOutput(platformLabel: string, logsDir: string, serviceName: string): string {
  return [
    "reins service logs",
    "",
    `Platform ${platformLabel}`,
    `Logs     ${logsDir}`,
    "",
    "Live logs:",
    `  ${logHintForPlatform(platformLabel, serviceName)}`,
    "",
  ].join("\n");
}

function getPlatformLabel(platform: NodeJS.Platform): "launchd" | "systemd" | "windows-service" | "unknown" {
  if (platform === "darwin") {
    return "launchd";
  }

  if (platform === "linux") {
    return "systemd";
  }

  if (platform === "win32") {
    return "windows-service";
  }

  return "unknown";
}

function logHintForPlatform(platformLabel: string, serviceName: string): string {
  if (platformLabel === "launchd") {
    return `log stream --style compact --predicate 'process contains "${serviceName}"'`;
  }

  if (platformLabel === "systemd") {
    return `journalctl --user -u ${serviceName}.service -f`;
  }

  if (platformLabel === "windows-service") {
    return `Get-EventLog -LogName Application -Source "${serviceName}" -Newest 50`;
  }

  return `tail -f ${logsDirFallback()}`;
}

function logsDirFallback(): string {
  const timestamp = new Date().toISOString();
  return `${timestamp} (platform unsupported)`;
}
