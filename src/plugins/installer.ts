import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { PluginError } from "../errors";
import type { PluginInfo, PluginManifest } from "../types";
import { validateManifest } from "./manifest";
import type { PluginLifecycleManager } from "./lifecycle";
import type { PluginRegistry, PluginRegistryEntry } from "./registry";

const PLUGIN_MANIFEST_FILE = "reins-plugin.json";
const SIMULATED_PLUGIN_ENTRY_FILE = "index.ts";

export interface PluginSource {
  type: "local" | "npm";
  path?: string;
  package?: string;
  version?: string;
}

export interface InstallerConfig {
  pluginsDir: string;
  registry: PluginRegistry;
  lifecycleManager: PluginLifecycleManager;
}

export class PluginInstaller {
  constructor(private readonly config: InstallerConfig) {}

  async installFromLocal(sourcePath: string): Promise<PluginInfo> {
    const resolvedSourcePath = resolve(sourcePath);
    const manifest = await this.readAndValidateManifest(join(resolvedSourcePath, PLUGIN_MANIFEST_FILE));
    const destinationPath = this.getPluginInstallPath(manifest.name);

    if (await pathExists(destinationPath)) {
      throw new PluginError(`Plugin already exists on disk: ${manifest.name}`);
    }

    await mkdir(this.config.pluginsDir, { recursive: true });
    await cp(resolvedSourcePath, destinationPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });

    const installedManifest = this.toInstalledManifest(manifest, destinationPath);
    await this.writeManifest(destinationPath, installedManifest);

    try {
      return await this.config.lifecycleManager.install(installedManifest, destinationPath);
    } catch (error) {
      await rm(destinationPath, { recursive: true, force: true });
      throw error;
    }
  }

  async installFromNpm(packageName: string, version?: string): Promise<PluginInfo> {
    const details = await this.config.registry.getDetails(packageName);
    if (!details) {
      throw new PluginError(`Plugin not found in registry: ${packageName}`);
    }

    const resolvedVersion = await this.resolveRequestedVersion(packageName, details.version, version);
    const manifest = this.createManifestFromRegistryEntry(details, resolvedVersion);
    const destinationPath = this.getPluginInstallPath(manifest.name);

    if (await pathExists(destinationPath)) {
      throw new PluginError(`Plugin already exists on disk: ${manifest.name}`);
    }

    await this.materializeSimulatedPackage(destinationPath, manifest);

    try {
      return await this.config.lifecycleManager.install(manifest, destinationPath);
    } catch (error) {
      await rm(destinationPath, { recursive: true, force: true });
      throw error;
    }
  }

  async uninstall(pluginName: string): Promise<void> {
    await this.config.lifecycleManager.uninstall(pluginName);
    await rm(this.getPluginInstallPath(pluginName), { recursive: true, force: true });
  }

  async update(pluginName: string, newVersion?: string): Promise<PluginInfo> {
    const current = this.config.lifecycleManager.getPlugin(pluginName);
    if (!current) {
      throw new PluginError(`Plugin is not installed: ${pluginName}`);
    }

    const details = await this.config.registry.getDetails(pluginName);
    if (!details) {
      throw new PluginError(`Plugin not found in registry: ${pluginName}`);
    }

    const targetVersion = await this.resolveUpdateVersion(pluginName, current.manifest.version, newVersion);
    const manifest = this.createManifestFromRegistryEntry(details, targetVersion);
    const destinationPath = this.getPluginInstallPath(pluginName);

    await rm(destinationPath, { recursive: true, force: true });
    await this.materializeSimulatedPackage(destinationPath, manifest);

    return this.config.lifecycleManager.update(pluginName, manifest, destinationPath);
  }

  async checkUpdates(): Promise<
    Array<{ pluginName: string; currentVersion: string; latestVersion: string }>
  > {
    const installed = this.config.lifecycleManager.getInstalledPlugins();
    const updates: Array<{ pluginName: string; currentVersion: string; latestVersion: string }> = [];

    for (const plugin of installed) {
      const check = await this.config.registry.checkUpdate(plugin.manifest.name, plugin.manifest.version);
      if (!check.hasUpdate || !check.latestVersion) {
        continue;
      }

      updates.push({
        pluginName: plugin.manifest.name,
        currentVersion: plugin.manifest.version,
        latestVersion: check.latestVersion,
      });
    }

    return updates;
  }

  private getPluginInstallPath(pluginName: string): string {
    return join(this.config.pluginsDir, pluginName);
  }

  private async readAndValidateManifest(filePath: string): Promise<PluginManifest> {
    let parsed: unknown;

    try {
      const content = await readFile(filePath, "utf8");
      parsed = JSON.parse(content) as unknown;
    } catch (error) {
      throw new PluginError(
        `Failed to read plugin manifest at ${filePath}`,
        error instanceof Error ? error : undefined,
      );
    }

    const validation = validateManifest(parsed);
    if (!validation.valid) {
      throw new PluginError(`Invalid plugin manifest: ${validation.errors.join("; ")}`);
    }

    return validation.value;
  }

  private toInstalledManifest(manifest: PluginManifest, installPath: string): PluginManifest {
    return {
      ...manifest,
      entryPoint: this.resolveInstalledEntryPoint(installPath, manifest.entryPoint),
    };
  }

  private resolveInstalledEntryPoint(installPath: string, entryPoint: string): string {
    if (isAbsolute(entryPoint)) {
      return entryPoint;
    }

    return join(installPath, entryPoint);
  }

  private async writeManifest(installPath: string, manifest: PluginManifest): Promise<void> {
    const destination = join(installPath, PLUGIN_MANIFEST_FILE);
    await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  private async materializeSimulatedPackage(
    destinationPath: string,
    manifest: PluginManifest,
  ): Promise<void> {
    await mkdir(destinationPath, { recursive: true });
    await this.writeManifest(destinationPath, manifest);

    const simulatedEntrypoint = join(destinationPath, SIMULATED_PLUGIN_ENTRY_FILE);
    const simulatedSource = [
      "import type { PluginContext } from \"../src/types\";",
      "",
      "export default async function setupPlugin(_context: PluginContext): Promise<void> {",
      "  return;",
      "}",
      "",
    ].join("\n");

    await writeFile(simulatedEntrypoint, simulatedSource, "utf8");
  }

  private createManifestFromRegistryEntry(
    details: PluginRegistryEntry,
    version: string,
  ): PluginManifest {
    const installPath = this.getPluginInstallPath(details.name);

    return {
      name: details.name,
      version,
      description: details.description,
      author: details.author,
      permissions: [...details.permissions],
      entryPoint: join(installPath, SIMULATED_PLUGIN_ENTRY_FILE),
      homepage: details.homepage,
    };
  }

  private async resolveRequestedVersion(
    packageName: string,
    latestVersion: string,
    requestedVersion?: string,
  ): Promise<string> {
    if (!requestedVersion) {
      return latestVersion;
    }

    const versions = await this.config.registry.getVersions(packageName);
    if (!versions.includes(requestedVersion)) {
      throw new PluginError(`Version ${requestedVersion} is not available for ${packageName}`);
    }

    return requestedVersion;
  }

  private async resolveUpdateVersion(
    pluginName: string,
    currentVersion: string,
    requestedVersion?: string,
  ): Promise<string> {
    if (requestedVersion) {
      const versions = await this.config.registry.getVersions(pluginName);
      if (!versions.includes(requestedVersion)) {
        throw new PluginError(`Version ${requestedVersion} is not available for ${pluginName}`);
      }

      return requestedVersion;
    }

    const update = await this.config.registry.checkUpdate(pluginName, currentVersion);
    if (!update.hasUpdate || !update.latestVersion) {
      throw new PluginError(`No update available for plugin: ${pluginName}`);
    }

    return update.latestVersion;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
