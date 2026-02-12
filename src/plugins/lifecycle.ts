import { PluginError } from "../errors";
import type { PluginInfo, PluginManifest } from "../types";
import { isValidSemver, validateManifest } from "./manifest";
import type { PluginStateEntry, PluginStateStore } from "./state";

export class PluginLifecycleManager {
  constructor(
    private readonly stateStore: PluginStateStore,
    private readonly currentReinsVersion = "0.1.0",
  ) {}

  async install(manifest: PluginManifest, sourcePath: string): Promise<PluginInfo> {
    const validatedManifest = this.validateAndNormalizeManifest(manifest);

    if (this.stateStore.get(validatedManifest.name)) {
      throw new PluginError(`Plugin already installed: ${validatedManifest.name}`);
    }

    this.assertCompatibleWithCurrentReins(validatedManifest);

    const now = Date.now();
    const entry: PluginStateEntry = {
      manifest: validatedManifest,
      state: "installed",
      sourcePath,
      installedAt: now,
      updatedAt: now,
      config: {},
    };

    this.stateStore.set(validatedManifest.name, entry);
    return this.toPluginInfo(entry);
  }

  async uninstall(pluginName: string): Promise<void> {
    this.getEntryOrThrow(pluginName);
    this.stateStore.delete(pluginName);
  }

  async enable(pluginName: string): Promise<PluginInfo> {
    const current = this.getEntryOrThrow(pluginName);
    const now = Date.now();
    const next: PluginStateEntry = {
      ...current,
      state: "enabled",
      updatedAt: now,
      enabledAt: now,
    };

    this.stateStore.set(pluginName, next);
    return this.toPluginInfo(next);
  }

  async disable(pluginName: string): Promise<PluginInfo> {
    const current = this.getEntryOrThrow(pluginName);
    const now = Date.now();
    const next: PluginStateEntry = {
      ...current,
      state: "disabled",
      updatedAt: now,
      disabledAt: now,
    };

    this.stateStore.set(pluginName, next);
    return this.toPluginInfo(next);
  }

  async update(
    pluginName: string,
    newManifest: PluginManifest,
    newSourcePath: string,
  ): Promise<PluginInfo> {
    const current = this.getEntryOrThrow(pluginName);
    const validatedManifest = this.validateAndNormalizeManifest(newManifest);

    if (validatedManifest.name !== pluginName) {
      throw new PluginError(
        `Updated manifest name mismatch: expected ${pluginName}, received ${validatedManifest.name}`,
      );
    }

    this.assertCompatibleWithCurrentReins(validatedManifest);

    const next: PluginStateEntry = {
      ...current,
      manifest: validatedManifest,
      sourcePath: newSourcePath,
      updatedAt: Date.now(),
    };

    this.stateStore.set(pluginName, next);
    return this.toPluginInfo(next);
  }

  getPlugin(pluginName: string): PluginInfo | undefined {
    const entry = this.stateStore.get(pluginName);
    return entry ? this.toPluginInfo(entry) : undefined;
  }

  getInstalledPlugins(): PluginInfo[] {
    return this.mapEntries(this.stateStore.getAll());
  }

  getEnabledPlugins(): PluginInfo[] {
    return this.mapEntries(this.stateStore.getAll()).filter((plugin) => plugin.state === "enabled");
  }

  private getEntryOrThrow(pluginName: string): PluginStateEntry {
    const entry = this.stateStore.get(pluginName);

    if (!entry) {
      throw new PluginError(`Plugin is not installed: ${pluginName}`);
    }

    return entry;
  }

  private validateAndNormalizeManifest(manifest: PluginManifest): PluginManifest {
    const validation = validateManifest(manifest);

    if (!validation.valid) {
      throw new PluginError(`Invalid plugin manifest: ${validation.errors.join("; ")}`);
    }

    return validation.value;
  }

  private assertCompatibleWithCurrentReins(manifest: PluginManifest): void {
    if (!manifest.minReinsVersion) {
      return;
    }

    if (!isValidSemver(this.currentReinsVersion)) {
      throw new PluginError(`Current Reins version is invalid: ${this.currentReinsVersion}`);
    }

    if (compareSemver(this.currentReinsVersion, manifest.minReinsVersion) < 0) {
      throw new PluginError(
        `Plugin ${manifest.name} requires Reins ${manifest.minReinsVersion} or newer`,
      );
    }
  }

  private mapEntries(entries: Map<string, PluginStateEntry>): PluginInfo[] {
    return Array.from(entries.values()).map((entry) => this.toPluginInfo(entry));
  }

  private toPluginInfo(entry: PluginStateEntry): PluginInfo {
    return {
      manifest: structuredClone(entry.manifest),
      state: entry.state,
      installedAt: new Date(entry.installedAt),
    };
  }
}

function compareSemver(left: string, right: string): number {
  const leftCore = left.split("-")[0] ?? "0.0.0";
  const rightCore = right.split("-")[0] ?? "0.0.0";
  const leftParts = leftCore.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = rightCore.split(".").map((part) => Number.parseInt(part, 10));

  for (let index = 0; index < 3; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;

    if (leftValue > rightValue) {
      return 1;
    }

    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}
