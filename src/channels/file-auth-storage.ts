import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ChannelAuthData, ChannelAuthStorage } from "./auth-storage";

/**
 * File-backed implementation of {@link ChannelAuthStorage} that persists
 * the per-channel user allow-list to `~/.reins/channel-users.json`.
 *
 * Every read operation loads from disk (no in-memory cache) so the data
 * is always fresh and race-safe for a single-process daemon.
 *
 * Writes are atomic: data is serialized to a temporary `.tmp` file in
 * the same directory, then renamed over the target path. This prevents
 * partial writes from corrupting the allow-list.
 *
 * The file is created lazily on the first write — construction never
 * touches the filesystem.
 */
export class FileChannelAuthStorage implements ChannelAuthStorage {
  private readonly filePath: string;

  /**
   * @param filePath Override the default storage path
   *   (`~/.reins/channel-users.json`). Useful for testing with a
   *   temporary directory.
   */
  constructor(filePath?: string) {
    this.filePath = filePath ?? join(homedir(), ".reins", "channel-users.json");
  }

  async getAuthorizedUsers(channelId: string): Promise<string[]> {
    const data = await this.readData();
    return data[channelId] ?? [];
  }

  async addUser(channelId: string, userId: string): Promise<boolean> {
    const data = await this.readData();
    const users = data[channelId] ?? [];

    if (users.includes(userId)) {
      return false;
    }

    users.push(userId);
    data[channelId] = users;
    await this.writeData(data);
    return true;
  }

  async removeUser(channelId: string, userId: string): Promise<boolean> {
    const data = await this.readData();
    const users = data[channelId] ?? [];
    const index = users.indexOf(userId);

    if (index === -1) {
      return false;
    }

    users.splice(index, 1);
    data[channelId] = users;
    await this.writeData(data);
    return true;
  }

  async listUsers(channelId: string): Promise<string[]> {
    const data = await this.readData();
    return data[channelId] ?? [];
  }

  async getAllData(): Promise<ChannelAuthData> {
    return this.readData();
  }

  /**
   * Read and parse the JSON allow-list file.
   *
   * Returns empty data when the file does not exist or contains
   * invalid JSON — never throws for expected filesystem conditions.
   */
  private async readData(): Promise<ChannelAuthData> {
    try {
      const content = await readFile(this.filePath, "utf8");
      return JSON.parse(content) as ChannelAuthData;
    } catch (error: unknown) {
      if (isFileNotFound(error)) {
        return {};
      }

      // Corrupt or unparseable JSON — warn and treat as empty
      console.warn(
        `[FileChannelAuthStorage] Failed to read ${this.filePath}, treating as empty:`,
        error instanceof Error ? error.message : String(error),
      );
      return {};
    }
  }

  /**
   * Atomically write the allow-list data to disk.
   *
   * Writes to a temporary file first, then renames it over the target
   * path so readers never see a partially-written file.
   */
  private async writeData(data: ChannelAuthData): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });

    const tmpPath = `${this.filePath}.tmp`;
    const content = JSON.stringify(data, null, 2);

    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, this.filePath);
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
