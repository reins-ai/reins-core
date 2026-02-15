import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { err, ok } from "../result";
import type {
  DaemonPlatform,
  DaemonResult,
  GeneratedServiceConfig,
  InstallerFileSystem,
  PlatformCommandRunner,
  PlatformServiceAdapter,
  ServiceDefinition,
} from "./types";
import { DaemonError } from "./types";

const DEFAULT_WINDOWS_CONFIG_NAME = "reins-daemon-service.json";

class NodeInstallerFileSystem implements InstallerFileSystem {
  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async writeFile(path: string, content: string): Promise<void> {
    await writeFile(path, content, "utf8");
  }

  async unlink(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
}

class BunCommandRunner implements PlatformCommandRunner {
  async run(command: string, args: string[]): Promise<DaemonResult<{ stdout: string; stderr: string }>> {
    try {
      const processResult = Bun.spawn([command, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(processResult.stdout).text(),
        new Response(processResult.stderr).text(),
        processResult.exited,
      ]);

      if (exitCode !== 0) {
        return err(new DaemonError(`Command failed: ${command} ${args.join(" ")}`, "DAEMON_COMMAND_FAILED"));
      }

      return ok({ stdout, stderr });
    } catch (error) {
      return err(
        new DaemonError(
          `Unable to execute command: ${command}`,
          "DAEMON_COMMAND_EXECUTION_FAILED",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }
}

class LaunchdUserAdapter implements PlatformServiceAdapter {
  readonly platform: DaemonPlatform = "darwin";

  generateConfig(definition: ServiceDefinition): DaemonResult<GeneratedServiceConfig> {
    const filePath = join(homedir(), "Library", "LaunchAgents", `${definition.serviceName}.plist`);
    const argsXml = [definition.command, ...definition.args]
      .map((value) => `    <string>${escapeXml(value)}</string>`)
      .join("\n");

    const content = [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
      "<plist version=\"1.0\">",
      "<dict>",
      `  <key>Label</key><string>${definition.serviceName}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      argsXml,
      "  </array>",
      "  <key>RunAtLoad</key><true/>",
      `  <key>KeepAlive</key><${definition.autoRestart ? "true" : "false"}/>`,
      `  <key>WorkingDirectory</key><string>${escapeXml(definition.workingDirectory)}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n");

    return ok({ platform: this.platform, filePath, content });
  }

  async install(definition: ServiceDefinition, runner: PlatformCommandRunner): Promise<DaemonResult<void>> {
    return this.start(definition, runner);
  }

  async start(definition: ServiceDefinition, runner: PlatformCommandRunner): Promise<DaemonResult<void>> {
    const filePath = join(homedir(), "Library", "LaunchAgents", `${definition.serviceName}.plist`);
    const uid = String(process.getuid?.() ?? 0);
    const bootstrap = await runner.run("launchctl", ["bootstrap", `gui/${uid}`, filePath]);
    if (!bootstrap.ok) {
      return bootstrap;
    }

    const kickstart = await runner.run("launchctl", ["kickstart", "-k", `gui/${uid}/${definition.serviceName}`]);
    if (!kickstart.ok) {
      return kickstart;
    }

    return ok(undefined);
  }

  async stop(definition: ServiceDefinition, runner: PlatformCommandRunner): Promise<DaemonResult<void>> {
    const uid = String(process.getuid?.() ?? 0);
    const result = await runner.run("launchctl", ["bootout", `gui/${uid}/${definition.serviceName}`]);
    if (!result.ok) {
      return result;
    }

    return ok(undefined);
  }

  async uninstall(definition: ServiceDefinition, runner: PlatformCommandRunner): Promise<DaemonResult<void>> {
    return this.stop(definition, runner);
  }

  async status(
    definition: ServiceDefinition,
    runner: PlatformCommandRunner,
  ): Promise<DaemonResult<"running" | "stopped" | "not-installed">> {
    const result = await runner.run("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${definition.serviceName}`]);
    if (!result.ok) {
      return ok("not-installed");
    }

    return ok(result.value.stdout.includes("state = running") ? "running" : "stopped");
  }
}

class SystemdUserAdapter implements PlatformServiceAdapter {
  readonly platform: DaemonPlatform = "linux";

  generateConfig(definition: ServiceDefinition): DaemonResult<GeneratedServiceConfig> {
    const filePath = join(homedir(), ".config", "systemd", "user", `${definition.serviceName}.service`);
    const envEntries = Object.entries(definition.env)
      .map(([key, value]) => `Environment=${key}=${escapeSystemd(value)}`)
      .join("\n");

    const content = [
      "[Unit]",
      `Description=${definition.description}`,
      "After=default.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${definition.command} ${definition.args.join(" ")}`,
      `WorkingDirectory=${definition.workingDirectory}`,
      envEntries,
      `Restart=${definition.autoRestart ? "always" : "no"}`,
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");

    return ok({ platform: this.platform, filePath, content });
  }

  async install(definition: ServiceDefinition, runner: PlatformCommandRunner): Promise<DaemonResult<void>> {
    const daemonReload = await runner.run("systemctl", ["--user", "daemon-reload"]);
    if (!daemonReload.ok) {
      return daemonReload;
    }

    const enable = await runner.run("systemctl", ["--user", "enable", "--now", `${definition.serviceName}.service`]);
    if (!enable.ok) {
      return enable;
    }

    return ok(undefined);
  }

  async start(definition: ServiceDefinition, runner: PlatformCommandRunner): Promise<DaemonResult<void>> {
    const start = await runner.run("systemctl", ["--user", "start", `${definition.serviceName}.service`]);
    if (!start.ok) {
      return start;
    }

    return ok(undefined);
  }

  async stop(definition: ServiceDefinition, runner: PlatformCommandRunner): Promise<DaemonResult<void>> {
    const stop = await runner.run("systemctl", ["--user", "stop", `${definition.serviceName}.service`]);
    if (!stop.ok) {
      return stop;
    }

    return ok(undefined);
  }

  async uninstall(definition: ServiceDefinition, runner: PlatformCommandRunner): Promise<DaemonResult<void>> {
    const disable = await runner.run("systemctl", ["--user", "disable", "--now", `${definition.serviceName}.service`]);
    if (!disable.ok) {
      return disable;
    }

    const daemonReload = await runner.run("systemctl", ["--user", "daemon-reload"]);
    if (!daemonReload.ok) {
      return daemonReload;
    }

    return ok(undefined);
  }

  async status(
    definition: ServiceDefinition,
    runner: PlatformCommandRunner,
  ): Promise<DaemonResult<"running" | "stopped" | "not-installed">> {
    // Use `show` instead of `is-active` because `is-active` exits non-zero
    // for any state other than "active" (including "failed", "inactive",
    // "activating"), which would incorrectly report "not-installed" for a
    // service that exists but crashed. `show` always exits 0 and returns
    // LoadState/ActiveState properties that let us distinguish properly.
    const result = await runner.run("systemctl", [
      "--user", "show", "-p", "LoadState,ActiveState",
      `${definition.serviceName}.service`,
    ]);

    if (!result.ok) {
      return ok("not-installed");
    }

    const output = result.value.stdout;

    // LoadState=not-found means the unit file does not exist on disk
    if (output.includes("LoadState=not-found")) {
      return ok("not-installed");
    }

    // Unit file exists — check if it's running
    if (output.includes("ActiveState=active")) {
      return ok("running");
    }

    // Unit exists but not active (failed, inactive, activating, etc.)
    return ok("stopped");
  }
}

class WindowsUserServiceAdapter implements PlatformServiceAdapter {
  readonly platform: DaemonPlatform = "win32";

  generateConfig(definition: ServiceDefinition): DaemonResult<GeneratedServiceConfig> {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    const filePath = join(appData, "Reins", DEFAULT_WINDOWS_CONFIG_NAME);
    const content = JSON.stringify(
      {
        serviceName: definition.serviceName,
        displayName: definition.displayName,
        description: definition.description,
        command: definition.command,
        args: definition.args,
        workingDirectory: definition.workingDirectory,
        env: definition.env,
        autoRestart: definition.autoRestart,
        manager: "sc.exe",
      },
      null,
      2,
    );

    return ok({ platform: this.platform, filePath, content });
  }

  async install(definition: ServiceDefinition, runner: PlatformCommandRunner): Promise<DaemonResult<void>> {
    const create = await runner.run("sc.exe", [
      "create",
      definition.serviceName,
      `DisplayName=${definition.displayName}`,
      `binPath=${definition.command} ${definition.args.join(" ")}`,
      "start=auto",
    ]);
    if (!create.ok) {
      return create;
    }

    const start = await runner.run("sc.exe", ["start", definition.serviceName]);
    if (!start.ok) {
      return start;
    }

    return ok(undefined);
  }

  async start(definition: ServiceDefinition, runner: PlatformCommandRunner): Promise<DaemonResult<void>> {
    const start = await runner.run("sc.exe", ["start", definition.serviceName]);
    if (!start.ok) {
      return start;
    }

    return ok(undefined);
  }

  async stop(definition: ServiceDefinition, runner: PlatformCommandRunner): Promise<DaemonResult<void>> {
    const stop = await runner.run("sc.exe", ["stop", definition.serviceName]);
    if (!stop.ok) {
      return stop;
    }

    return ok(undefined);
  }

  async uninstall(definition: ServiceDefinition, runner: PlatformCommandRunner): Promise<DaemonResult<void>> {
    const stop = await this.stop(definition, runner);
    if (!stop.ok) {
      return stop;
    }

    const remove = await runner.run("sc.exe", ["delete", definition.serviceName]);
    if (!remove.ok) {
      return remove;
    }

    return ok(undefined);
  }

  async status(
    definition: ServiceDefinition,
    runner: PlatformCommandRunner,
  ): Promise<DaemonResult<"running" | "stopped" | "not-installed">> {
    const result = await runner.run("sc.exe", ["query", definition.serviceName]);
    if (!result.ok) {
      return ok("not-installed");
    }

    if (result.value.stdout.includes("RUNNING")) {
      return ok("running");
    }

    return ok("stopped");
  }
}

/**
 * Cross-platform installer for per-user daemon services.
 */
export class ServiceInstaller {
  private readonly runner: PlatformCommandRunner;
  private readonly fileSystem: InstallerFileSystem;
  private readonly platformDetector: () => NodeJS.Platform;
  private readonly adapters: Map<DaemonPlatform, PlatformServiceAdapter>;

  constructor(options?: {
    runner?: PlatformCommandRunner;
    fileSystem?: InstallerFileSystem;
    platformDetector?: () => NodeJS.Platform;
    adapters?: PlatformServiceAdapter[];
  }) {
    this.runner = options?.runner ?? new BunCommandRunner();
    this.fileSystem = options?.fileSystem ?? new NodeInstallerFileSystem();
    this.platformDetector = options?.platformDetector ?? (() => process.platform);

    const defaultAdapters: PlatformServiceAdapter[] = [
      new LaunchdUserAdapter(),
      new SystemdUserAdapter(),
      new WindowsUserServiceAdapter(),
    ];

    this.adapters = new Map((options?.adapters ?? defaultAdapters).map((adapter) => [adapter.platform, adapter]));
  }

  /**
   * Generates a platform-specific user service configuration file content.
   */
  generateConfig(definition: ServiceDefinition): DaemonResult<GeneratedServiceConfig> {
    const adapterResult = this.resolveAdapter();
    if (!adapterResult.ok) {
      return adapterResult;
    }

    return adapterResult.value.generateConfig(definition);
  }

  /**
   * Writes service config file and installs service with the platform manager.
   */
  async install(definition: ServiceDefinition): Promise<DaemonResult<GeneratedServiceConfig>> {
    const adapterResult = this.resolveAdapter();
    if (!adapterResult.ok) {
      return adapterResult;
    }

    const configResult = adapterResult.value.generateConfig(definition);
    if (!configResult.ok) {
      return configResult;
    }

    try {
      await this.fileSystem.mkdir(dirname(configResult.value.filePath));
      await this.fileSystem.writeFile(configResult.value.filePath, configResult.value.content);
    } catch (error) {
      return err(
        new DaemonError(
          `Unable to write service config: ${configResult.value.filePath}`,
          "DAEMON_INSTALL_WRITE_FAILED",
          error instanceof Error ? error : undefined,
        ),
      );
    }

    const installResult = await adapterResult.value.install(definition, this.runner);
    if (!installResult.ok) {
      return installResult;
    }

    return ok(configResult.value);
  }

  /**
   * Starts an installed per-user service.
   */
  async start(definition: ServiceDefinition): Promise<DaemonResult<void>> {
    const adapterResult = this.resolveAdapter();
    if (!adapterResult.ok) {
      return adapterResult;
    }

    return adapterResult.value.start(definition, this.runner);
  }

  /**
   * Stops a running per-user service.
   */
  async stop(definition: ServiceDefinition): Promise<DaemonResult<void>> {
    const adapterResult = this.resolveAdapter();
    if (!adapterResult.ok) {
      return adapterResult;
    }

    return adapterResult.value.stop(definition, this.runner);
  }

  /**
   * Restarts a per-user service.
   */
  async restart(definition: ServiceDefinition): Promise<DaemonResult<void>> {
    const stopResult = await this.stop(definition);
    if (!stopResult.ok) {
      return stopResult;
    }

    return this.start(definition);
  }

  /**
   * Uninstalls the per-user service and removes generated config file.
   */
  async uninstall(definition: ServiceDefinition): Promise<DaemonResult<void>> {
    const adapterResult = this.resolveAdapter();
    if (!adapterResult.ok) {
      return adapterResult;
    }

    const configResult = adapterResult.value.generateConfig(definition);
    if (!configResult.ok) {
      return configResult;
    }

    const uninstallResult = await adapterResult.value.uninstall(definition, this.runner);
    if (!uninstallResult.ok) {
      return uninstallResult;
    }

    if (await this.fileSystem.exists(configResult.value.filePath)) {
      await this.fileSystem.unlink(configResult.value.filePath);
    }

    return ok(undefined);
  }

  /**
   * Checks current user-service status using platform manager commands.
   */
  async status(definition: ServiceDefinition): Promise<DaemonResult<"running" | "stopped" | "not-installed">> {
    const adapterResult = this.resolveAdapter();
    if (!adapterResult.ok) {
      return adapterResult;
    }

    return adapterResult.value.status(definition, this.runner);
  }

  private resolveAdapter(): DaemonResult<PlatformServiceAdapter> {
    const platform = this.platformDetector();
    if (!isSupportedPlatform(platform)) {
      return err(new DaemonError(`Unsupported platform '${platform}'`, "DAEMON_PLATFORM_UNSUPPORTED"));
    }

    const adapter = this.adapters.get(platform);
    if (!adapter) {
      return err(new DaemonError(`No adapter registered for '${platform}'`, "DAEMON_ADAPTER_MISSING"));
    }

    return ok(adapter);
  }
}

function isSupportedPlatform(platform: NodeJS.Platform): platform is DaemonPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeSystemd(value: string): string {
  return value.replaceAll("\n", "\\n").replaceAll('"', '\\"');
}
