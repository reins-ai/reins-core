import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { KeychainProvider } from "../../security/keychain-provider";
import type { OpenClawChannelConfig } from "../types";
import type { MapError, MapperOptions, MapResult } from "./types";

const CHANNEL_TOKEN_SERVICE = "reins-channel-token";

export interface ReinsChannelEntry {
  id: string;
  type: "telegram" | "discord";
  name: string;
  keychainService: string;
  keychainAccount: string;
  settings: Record<string, unknown>;
  enabled: false;
  source: "openclaw-import";
}

function defaultOutputPath(): string {
  return join(homedir(), ".reins", "channels.json");
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : "channel";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function readStringArrayField(
  source: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = source[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : undefined;
}

function buildSettings(type: "telegram" | "discord", source: Record<string, unknown>): Record<string, unknown> {
  const settings: Record<string, unknown> = {};

  if (type === "telegram") {
    const chatId = readStringField(source, "chatId");
    if (chatId) {
      settings.chatId = chatId;
    }
  }

  if (type === "discord") {
    const guildId = readStringField(source, "guildId");
    if (guildId) {
      settings.guildId = guildId;
    }

    const channelIds = readStringArrayField(source, "channelIds");
    if (channelIds) {
      settings.channelIds = channelIds;
    }
  }

  const nestedSettings = source.settings;
  if (isObjectRecord(nestedSettings)) {
    Object.assign(settings, nestedSettings);
  }

  return settings;
}

async function loadExistingChannels(path: string): Promise<ReinsChannelEntry[]> {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    return [];
  }

  try {
    const parsed = await file.json();
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed as ReinsChannelEntry[];
  } catch {
    return [];
  }
}

/**
 * Maps OpenClaw Telegram/Discord channel definitions into Reins channel entries.
 * Bot tokens are stored only in keychain; channels.json only stores key references.
 */
export class ChannelMapper {
  private readonly keychainProvider: KeychainProvider;
  private readonly outputPath: string;

  constructor(keychainProvider: KeychainProvider, outputPath?: string) {
    this.keychainProvider = keychainProvider;
    this.outputPath = outputPath ?? defaultOutputPath();
  }

  public async map(
    channelConfigs: OpenClawChannelConfig[],
    options?: MapperOptions,
  ): Promise<MapResult> {
    const errors: MapError[] = [];
    let converted = 0;
    let skipped = 0;

    const existing = await loadExistingChannels(this.outputPath);
    const nameSet = new Set(existing.map((entry) => normalizeName(entry.name)));
    const additions: ReinsChannelEntry[] = [];

    for (let index = 0; index < channelConfigs.length; index += 1) {
      const config = channelConfigs[index] as OpenClawChannelConfig & Record<string, unknown>;
      const itemLabel = `channel-${index + 1}`;

      if (config.type !== "telegram" && config.type !== "discord") {
        skipped += 1;
        errors.push({
          item: itemLabel,
          reason: `Unsupported channel type: ${String(config.type)}`,
        });
        options?.onProgress?.(index + 1, channelConfigs.length);
        continue;
      }

      const name = typeof config.name === "string" ? config.name.trim() : "";
      if (name.length === 0) {
        skipped += 1;
        errors.push({ item: itemLabel, reason: "Channel has no name" });
        options?.onProgress?.(index + 1, channelConfigs.length);
        continue;
      }

      const normalizedName = normalizeName(name);
      if (nameSet.has(normalizedName)) {
        skipped += 1;
        options?.onProgress?.(index + 1, channelConfigs.length);
        continue;
      }

      const token = typeof config.botToken === "string"
        ? config.botToken
        : typeof config.token === "string"
        ? config.token
        : "";

      const trimmedToken = token.trim();
      if (trimmedToken.length === 0) {
        skipped += 1;
        errors.push({ item: name, reason: "Channel bot token is required" });
        options?.onProgress?.(index + 1, channelConfigs.length);
        continue;
      }

      const keychainAccount = `${config.type}-${slugify(name)}`;

      try {
        if (!options?.dryRun) {
          const setResult = await this.keychainProvider.set(
            CHANNEL_TOKEN_SERVICE,
            keychainAccount,
            trimmedToken,
          );

          if (!setResult.ok) {
            throw setResult.error;
          }
        }

        additions.push({
          id: `${config.type}-${slugify(name)}`,
          type: config.type,
          name,
          keychainService: CHANNEL_TOKEN_SERVICE,
          keychainAccount,
          settings: buildSettings(config.type, config),
          enabled: false,
          source: "openclaw-import",
        });

        nameSet.add(normalizedName);
        converted += 1;
      } catch (error) {
        skipped += 1;
        errors.push({
          item: name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }

      options?.onProgress?.(index + 1, channelConfigs.length);
    }

    if (!options?.dryRun && additions.length > 0) {
      await mkdir(dirname(this.outputPath), { recursive: true });
      await Bun.write(this.outputPath, JSON.stringify([...existing, ...additions], null, 2));
    }

    return {
      converted,
      skipped,
      errors,
    };
  }
}
