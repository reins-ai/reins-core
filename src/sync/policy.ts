import { err, ok, type Result } from "../result";
import { SyncError } from "./types";

export const SYNCABLE_DOMAINS = ["credentials", "billing", "config"] as const;
export const LOCAL_ONLY_DOMAINS = ["conversations", "sessions", "transcripts", "cron", "memory"] as const;

export type SyncDomain = (typeof SYNCABLE_DOMAINS)[number];
export type LocalOnlyDomain = (typeof LOCAL_ONLY_DOMAINS)[number];

export interface SyncConflict {
  domain: SyncDomain;
  credentialId?: string;
  localChecksum: string;
  remoteChecksum: string;
  localUpdatedAt: number;
  remoteUpdatedAt: number;
  resolution: "local_wins" | "remote_wins" | "flagged";
}

interface SyncConflictEntry {
  checksum: string;
  updatedAt: number;
}

export class SyncPolicy {
  private static readonly CONFLICT_WINDOW_MS = 5000;

  public static isSyncable(domain: string): domain is SyncDomain {
    return (SYNCABLE_DOMAINS as readonly string[]).includes(domain);
  }

  public static isLocalOnly(domain: string): domain is LocalOnlyDomain {
    return (LOCAL_ONLY_DOMAINS as readonly string[]).includes(domain);
  }

  public static resolveConflict(
    local: SyncConflictEntry,
    remote: SyncConflictEntry,
  ): SyncConflict["resolution"] {
    if (local.checksum === remote.checksum) {
      return "local_wins";
    }

    const timeDiff = Math.abs(local.updatedAt - remote.updatedAt);
    if (timeDiff < this.CONFLICT_WINDOW_MS) {
      return "flagged";
    }

    return local.updatedAt > remote.updatedAt ? "local_wins" : "remote_wins";
  }

  public static validateSyncPayload(domain: string, _payload: unknown): Result<void, SyncError> {
    if (this.isLocalOnly(domain)) {
      return err(new SyncError(`Domain "${domain}" is local-only and cannot be synced`));
    }

    if (!this.isSyncable(domain)) {
      return err(new SyncError(`Unknown sync domain: "${domain}"`));
    }

    return ok(undefined);
  }
}
