import { createHash } from "node:crypto";

const DEFAULT_DEDUPE_WINDOW_MS = 4 * 60 * 60 * 1000;

export class AlertDedupeStore {
  private readonly alerts = new Map<string, number>();

  constructor(
    private readonly dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  isDuplicate(alertKey: string): boolean {
    this.cleanup();
    const recordedAt = this.alerts.get(alertKey);
    if (recordedAt === undefined) {
      return false;
    }

    return this.now() - recordedAt <= this.dedupeWindowMs;
  }

  recordAlert(alertKey: string): void {
    this.alerts.set(alertKey, this.now());
  }

  cleanup(): void {
    const threshold = this.now() - this.dedupeWindowMs;
    for (const [key, recordedAt] of this.alerts) {
      if (recordedAt < threshold) {
        this.alerts.delete(key);
      }
    }
  }

  generateAlertKey(content: string): string {
    const normalized = content.trim().toLowerCase().replace(/\s+/g, " ");
    return createHash("sha256").update(normalized).digest("hex");
  }
}
