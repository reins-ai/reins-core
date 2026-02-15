import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { err, ok, type Result } from "../result";
import { getDataRoot } from "./paths";
import { DaemonError } from "./types";
import {
  isValidProfileName,
  normalizeProfileName,
  type DaemonProfile,
  type DaemonProfilesFile,
} from "./profile-types";

const PROFILES_FILENAME = "daemons.json";

export interface ProfileStoreOptions {
  dataRoot?: string;
}

export class DaemonProfileStore {
  private readonly filePath: string;

  constructor(options?: ProfileStoreOptions) {
    const root = options?.dataRoot ?? getDataRoot();
    this.filePath = join(root, PROFILES_FILENAME);
  }

  async add(
    profile: Omit<DaemonProfile, "createdAt" | "lastConnected">,
  ): Promise<Result<DaemonProfile, DaemonError>> {
    const name = normalizeProfileName(profile.name);

    if (!isValidProfileName(name)) {
      return err(
        new DaemonError(
          `Invalid profile name "${profile.name}": must be alphanumeric and hyphens only`,
          "DAEMON_PROFILE_INVALID_NAME",
        ),
      );
    }

    const readResult = await this.readFile();
    if (!readResult.ok) return readResult;

    const data = readResult.value;
    const existing = data.profiles.find((p) => p.name === name);
    if (existing) {
      return err(
        new DaemonError(
          `Profile "${name}" already exists`,
          "DAEMON_PROFILE_DUPLICATE",
        ),
      );
    }

    const newProfile: DaemonProfile = {
      ...profile,
      name,
      isDefault: profile.isDefault || data.profiles.length === 0,
      lastConnected: null,
      createdAt: new Date().toISOString(),
    };

    if (newProfile.isDefault) {
      for (const p of data.profiles) {
        p.isDefault = false;
      }
    }

    data.profiles.push(newProfile);

    const writeResult = await this.writeFile(data);
    if (!writeResult.ok) return writeResult;

    return ok(newProfile);
  }

  async get(name: string): Promise<Result<DaemonProfile | null, DaemonError>> {
    const normalized = normalizeProfileName(name);
    const readResult = await this.readFile();
    if (!readResult.ok) return readResult;

    const profile = readResult.value.profiles.find((p) => p.name === normalized) ?? null;
    return ok(profile);
  }

  async list(): Promise<Result<DaemonProfile[], DaemonError>> {
    const readResult = await this.readFile();
    if (!readResult.ok) return readResult;

    return ok(readResult.value.profiles);
  }

  async update(
    name: string,
    updates: Partial<Omit<DaemonProfile, "name" | "createdAt">>,
  ): Promise<Result<DaemonProfile, DaemonError>> {
    const normalized = normalizeProfileName(name);
    const readResult = await this.readFile();
    if (!readResult.ok) return readResult;

    const data = readResult.value;
    const index = data.profiles.findIndex((p) => p.name === normalized);
    if (index === -1) {
      return err(
        new DaemonError(
          `Profile "${normalized}" not found`,
          "DAEMON_PROFILE_NOT_FOUND",
        ),
      );
    }

    if (updates.isDefault === true) {
      for (const p of data.profiles) {
        p.isDefault = false;
      }
    }

    const updated: DaemonProfile = {
      ...data.profiles[index],
      ...updates,
      name: data.profiles[index].name,
      createdAt: data.profiles[index].createdAt,
    };
    data.profiles[index] = updated;

    const writeResult = await this.writeFile(data);
    if (!writeResult.ok) return writeResult;

    return ok(updated);
  }

  async remove(name: string): Promise<Result<void, DaemonError>> {
    const normalized = normalizeProfileName(name);
    const readResult = await this.readFile();
    if (!readResult.ok) return readResult;

    const data = readResult.value;
    const index = data.profiles.findIndex((p) => p.name === normalized);
    if (index === -1) {
      return err(
        new DaemonError(
          `Profile "${normalized}" not found`,
          "DAEMON_PROFILE_NOT_FOUND",
        ),
      );
    }

    data.profiles.splice(index, 1);

    const writeResult = await this.writeFile(data);
    if (!writeResult.ok) return writeResult;

    return ok(undefined);
  }

  async getDefault(): Promise<Result<DaemonProfile | null, DaemonError>> {
    const readResult = await this.readFile();
    if (!readResult.ok) return readResult;

    const defaultProfile = readResult.value.profiles.find((p) => p.isDefault) ?? null;
    return ok(defaultProfile);
  }

  async setDefault(name: string): Promise<Result<void, DaemonError>> {
    const normalized = normalizeProfileName(name);
    const readResult = await this.readFile();
    if (!readResult.ok) return readResult;

    const data = readResult.value;
    const target = data.profiles.find((p) => p.name === normalized);
    if (!target) {
      return err(
        new DaemonError(
          `Profile "${normalized}" not found`,
          "DAEMON_PROFILE_NOT_FOUND",
        ),
      );
    }

    for (const p of data.profiles) {
      p.isDefault = p.name === normalized;
    }

    const writeResult = await this.writeFile(data);
    if (!writeResult.ok) return writeResult;

    return ok(undefined);
  }

  async touchLastConnected(name: string): Promise<Result<void, DaemonError>> {
    const normalized = normalizeProfileName(name);
    const readResult = await this.readFile();
    if (!readResult.ok) return readResult;

    const data = readResult.value;
    const profile = data.profiles.find((p) => p.name === normalized);
    if (!profile) {
      return err(
        new DaemonError(
          `Profile "${normalized}" not found`,
          "DAEMON_PROFILE_NOT_FOUND",
        ),
      );
    }

    profile.lastConnected = new Date().toISOString();

    const writeResult = await this.writeFile(data);
    if (!writeResult.ok) return writeResult;

    return ok(undefined);
  }

  private async readFile(): Promise<Result<DaemonProfilesFile, DaemonError>> {
    const file = Bun.file(this.filePath);

    if (!(await file.exists())) {
      return ok({ version: 1, profiles: [] });
    }

    try {
      const raw = await file.json();
      return ok(this.normalizeFile(raw));
    } catch (error) {
      return err(
        new DaemonError(
          `Unable to parse daemon profiles: ${this.filePath}`,
          "DAEMON_PROFILE_PARSE_ERROR",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  private normalizeFile(raw: unknown): DaemonProfilesFile {
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("version" in raw) ||
      !("profiles" in raw) ||
      !Array.isArray((raw as Record<string, unknown>).profiles)
    ) {
      return { version: 1, profiles: [] };
    }

    return raw as DaemonProfilesFile;
  }

  private async writeFile(data: DaemonProfilesFile): Promise<Result<void, DaemonError>> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await Bun.write(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
      return ok(undefined);
    } catch (error) {
      return err(
        new DaemonError(
          `Unable to write daemon profiles: ${this.filePath}`,
          "DAEMON_PROFILE_WRITE_ERROR",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }
}
