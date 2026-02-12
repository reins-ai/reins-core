import type { PluginManifest, PluginState } from "../types";

export interface PluginStateEntry {
  manifest: PluginManifest;
  state: PluginState;
  sourcePath: string;
  installedAt: number;
  updatedAt: number;
  enabledAt?: number;
  disabledAt?: number;
  config: Record<string, unknown>;
}

export interface PluginStateStore {
  get(pluginName: string): PluginStateEntry | undefined;
  set(pluginName: string, entry: PluginStateEntry): void;
  delete(pluginName: string): void;
  getAll(): Map<string, PluginStateEntry>;
  clear(): void;
}

export class InMemoryPluginStateStore implements PluginStateStore {
  private readonly entries = new Map<string, PluginStateEntry>();

  get(pluginName: string): PluginStateEntry | undefined {
    const entry = this.entries.get(pluginName);
    return entry ? cloneEntry(entry) : undefined;
  }

  set(pluginName: string, entry: PluginStateEntry): void {
    this.entries.set(pluginName, cloneEntry(entry));
  }

  delete(pluginName: string): void {
    this.entries.delete(pluginName);
  }

  getAll(): Map<string, PluginStateEntry> {
    const cloned = new Map<string, PluginStateEntry>();

    for (const [pluginName, entry] of this.entries.entries()) {
      cloned.set(pluginName, cloneEntry(entry));
    }

    return cloned;
  }

  clear(): void {
    this.entries.clear();
  }
}

function cloneEntry(entry: PluginStateEntry): PluginStateEntry {
  return {
    ...structuredClone(entry),
    config: structuredClone(entry.config),
  };
}
