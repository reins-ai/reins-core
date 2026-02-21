import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

/**
 * Options for the PersonalityWatcher.
 */
export interface PersonalityWatcherOptions {
  /** Called with new file content when PERSONALITY.md changes. */
  onChanged: (content: string) => void;
  /** Debounce delay in ms (default: 500). */
  debounceMs?: number;
}

/**
 * Watches a PERSONALITY.md file for external changes and delivers
 * the updated content via callback.
 *
 * Watches the parent directory rather than the file directly to
 * handle editor write patterns (rename-swap in vim/nano/etc.).
 * Debounces rapid changes to avoid redundant reads during
 * multi-save editors.
 */
export class PersonalityWatcher {
  private readonly personalityFilePath: string;
  private readonly onChanged: (content: string) => void;
  private readonly debounceMs: number;
  private readonly targetBasename: string;

  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    personalityFilePath: string,
    options: PersonalityWatcherOptions,
  ) {
    this.personalityFilePath = personalityFilePath;
    this.onChanged = options.onChanged;
    this.debounceMs = options.debounceMs ?? 500;
    this.targetBasename = basename(personalityFilePath);
  }

  /**
   * Start watching for changes to PERSONALITY.md.
   *
   * Watches the parent directory for reliability with editor
   * rename-swap write patterns. If the file or directory does
   * not exist, silently returns without error.
   */
  start(): void {
    if (this.running) {
      return;
    }

    const dir = dirname(this.personalityFilePath);

    try {
      this.watcher = watch(dir, { persistent: false }, (_eventType, fileName) => {
        if (!fileName || fileName !== this.targetBasename) {
          return;
        }
        this.scheduleRead();
      });

      this.watcher.on("error", () => {
        // Silently ignore watcher errors (directory removed, etc.)
      });

      this.running = true;
    } catch {
      // Directory doesn't exist or can't be watched — skip silently
      this.running = false;
    }
  }

  /**
   * Stop watching and cancel any pending debounced read.
   *
   * Safe to call multiple times or when already stopped.
   */
  stop(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // Ignore close errors
      }
      this.watcher = null;
    }

    this.running = false;
  }

  /**
   * Whether the watcher is currently active.
   */
  get isRunning(): boolean {
    return this.running;
  }

  private scheduleRead(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.readAndNotify();
    }, this.debounceMs);
  }

  private async readAndNotify(): Promise<void> {
    try {
      const content = await readFile(this.personalityFilePath, "utf8");
      this.onChanged(content);
    } catch {
      // File may have been deleted or is temporarily unavailable
      // during an editor swap — silently ignore
    }
  }
}
