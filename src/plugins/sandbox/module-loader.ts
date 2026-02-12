import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

import type { PluginPermission } from "../../types";

type PluginEntrypoint = (context: unknown) => void | Promise<void>;

interface PluginModule {
  default?: unknown;
  activate?: unknown;
  register?: unknown;
}

interface EntrypointLoadOptions {
  permissions?: PluginPermission[];
}

const FILESYSTEM_IMPORT_TOKENS = ["node:fs", "node:fs/promises"];
const NETWORK_IMPORT_TOKENS = ["node:http", "node:https", "node:net", "node:tls", "node:dgram"];
const DANGEROUS_PROCESS_TOKEN = "process.env";

function hasToken(source: string, token: string): boolean {
  return source.includes(token);
}

function includesAnyToken(source: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => hasToken(source, token));
}

function validateEntrypointSource(source: string, entryPoint: string, permissions: PluginPermission[]): void {
  if (source.includes("\0")) {
    throw new Error(`Plugin entry point ${entryPoint} contains null bytes and cannot be loaded`);
  }

  if (hasToken(source, DANGEROUS_PROCESS_TOKEN)) {
    throw new Error(`Plugin entry point ${entryPoint} cannot access process.env`);
  }

  const hasFileAccessPermission = permissions.includes("file_access");
  if (!hasFileAccessPermission && includesAnyToken(source, FILESYSTEM_IMPORT_TOKENS)) {
    throw new Error(`Plugin entry point ${entryPoint} requires file_access permission for filesystem modules`);
  }

  const hasNetworkAccessPermission = permissions.includes("network_access");
  if (!hasNetworkAccessPermission && (includesAnyToken(source, NETWORK_IMPORT_TOKENS) || /\bfetch\s*\(/.test(source))) {
    throw new Error(`Plugin entry point ${entryPoint} requires network_access permission for network usage`);
  }
}

async function loadSourceForValidation(entryPoint: string): Promise<string | null> {
  if (entryPoint.startsWith("file://")) {
    return readFile(fileURLToPath(entryPoint), "utf8");
  }

  if (entryPoint.startsWith("/")) {
    return readFile(entryPoint, "utf8");
  }

  return null;
}

function normalizeEntryPointPath(entryPoint: string): string {
  if (entryPoint.startsWith("file://")) {
    return entryPoint;
  }

  if (entryPoint.startsWith("/")) {
    return pathToFileURL(entryPoint).href;
  }

  return entryPoint;
}

function toEntrypoint(candidate: unknown): PluginEntrypoint | undefined {
  if (typeof candidate === "function") {
    return candidate as PluginEntrypoint;
  }

  return undefined;
}

export async function loadPluginEntrypoint(
  entryPoint: string,
  options: EntrypointLoadOptions = {},
): Promise<PluginEntrypoint> {
  const source = await loadSourceForValidation(entryPoint);
  if (source !== null) {
    validateEntrypointSource(source, entryPoint, options.permissions ?? []);
  }

  const moduleUrl = normalizeEntryPointPath(entryPoint);
  const loadedModule = (await import(moduleUrl)) as PluginModule;

  const entrypoint =
    toEntrypoint(loadedModule.default) ??
    toEntrypoint(loadedModule.activate) ??
    toEntrypoint(loadedModule.register);

  if (!entrypoint) {
    throw new Error(
      `Plugin entry point ${entryPoint} must export a function via default, activate, or register`,
    );
  }

  return entrypoint;
}
