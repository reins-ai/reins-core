import type { KeychainProvider } from "../../security/keychain-provider";
import type { SearchProviderPreference, UserConfigWriteOptions } from "../../config/user-config";
import { readUserConfig, writeUserConfig } from "../../config/user-config";
import type { OpenClawToolConfig } from "../types";
import type { MapError, MapperOptions, MapResult } from "./types";

const TOOL_KEY_SERVICE = "reins-tool-key";

/**
 * Supported search providers that map to Reins SearchProviderPreference.
 */
const SUPPORTED_SEARCH_PROVIDERS: ReadonlySet<string> = new Set(["brave", "exa"]);

function isSearchProviderPreference(value: string): value is SearchProviderPreference {
  return SUPPORTED_SEARCH_PROVIDERS.has(value);
}

/**
 * Resolves the keychain account name for a search provider.
 */
function searchProviderAccount(provider: string): string {
  return `${provider}-search`;
}

export interface ToolConfigMapperOptions {
  userConfigPath?: string;
}

/**
 * Maps OpenClaw tool configuration (search API keys, provider preferences)
 * into Reins keychain storage and user config.
 *
 * API keys are stored exclusively via KeychainProvider — never written to
 * config files or logs. Provider preferences are merged into the existing
 * UserConfig JSON file.
 */
export class ToolConfigMapper {
  private readonly keychainProvider: KeychainProvider;
  private readonly userConfigWriteOptions: UserConfigWriteOptions;

  constructor(
    keychainProvider: KeychainProvider,
    options?: ToolConfigMapperOptions,
  ) {
    this.keychainProvider = keychainProvider;
    this.userConfigWriteOptions = options?.userConfigPath
      ? { filePath: options.userConfigPath }
      : {};
  }

  public async map(
    toolConfig: OpenClawToolConfig,
    options?: MapperOptions,
  ): Promise<MapResult> {
    const errors: MapError[] = [];
    let converted = 0;
    let skipped = 0;

    const items = this.collectItems(toolConfig);
    const total = items.length;

    if (total === 0) {
      return { converted: 0, skipped: 0, errors: [] };
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      try {
        if (item.type === "apiKey") {
          if (!options?.dryRun) {
            await this.storeApiKey(item.provider, item.value);
          }
          converted++;
        } else if (item.type === "provider") {
          if (!options?.dryRun) {
            await this.updateSearchProvider(item.value as SearchProviderPreference);
          }
          converted++;
        } else {
          skipped++;
        }
      } catch {
        errors.push({
          item: item.label,
          reason: `Failed to store ${item.type} for ${item.provider}`,
        });
        skipped++;
      }

      options?.onProgress?.(i + 1, total);
    }

    return { converted, skipped, errors };
  }

  private collectItems(toolConfig: OpenClawToolConfig): ToolConfigItem[] {
    const items: ToolConfigItem[] = [];

    if (!toolConfig.search) {
      return items;
    }

    const { apiKey, provider } = toolConfig.search;

    if (typeof apiKey === "string" && apiKey.trim().length > 0) {
      const resolvedProvider = typeof provider === "string" && provider.trim().length > 0
        ? provider.trim()
        : "brave";

      items.push({
        type: "apiKey",
        provider: resolvedProvider,
        value: apiKey.trim(),
        label: `search-api-key:${resolvedProvider}`,
      });
    }

    if (typeof provider === "string" && provider.trim().length > 0) {
      const trimmed = provider.trim();

      if (isSearchProviderPreference(trimmed)) {
        items.push({
          type: "provider",
          provider: trimmed,
          value: trimmed,
          label: `search-provider:${trimmed}`,
        });
      } else {
        items.push({
          type: "unsupported",
          provider: trimmed,
          value: trimmed,
          label: `search-provider:${trimmed}`,
        });
      }
    }

    return items;
  }

  private async storeApiKey(provider: string, apiKey: string): Promise<void> {
    const account = searchProviderAccount(provider);
    const result = await this.keychainProvider.set(TOOL_KEY_SERVICE, account, apiKey);
    if (!result.ok) {
      throw result.error;
    }
  }

  private async updateSearchProvider(provider: SearchProviderPreference): Promise<void> {
    const existingResult = await readUserConfig(this.userConfigWriteOptions);
    const existingMode = existingResult.ok && existingResult.value
      ? existingResult.value.provider.mode
      : "none";

    const result = await writeUserConfig(
      { provider: { mode: existingMode, search: { provider } } },
      this.userConfigWriteOptions,
    );
    if (!result.ok) {
      throw result.error;
    }
  }
}

interface ToolConfigItem {
  type: "apiKey" | "provider" | "unsupported";
  provider: string;
  value: string;
  label: string;
}
