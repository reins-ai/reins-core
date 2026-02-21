import { err, ok, type Result } from "../result";
import { DaemonError } from "./types";
import type { MemoryConsolidationJob } from "../cron/jobs/memory-consolidation-job";

export interface MemoryCronRegistrationOptions {
  consolidationJob?: MemoryConsolidationJob;
  isMemoryReady: () => boolean;
}

export interface MemoryCronHandle {
  stopAll(): void;
  isConsolidationRunning(): boolean;
}

/**
 * Registers the memory consolidation cron job after verifying that the
 * memory service is ready. Returns a handle for stopping the job during
 * daemon shutdown.
 */
export function registerMemoryCronJobs(
  options: MemoryCronRegistrationOptions,
): Result<MemoryCronHandle, DaemonError> {
  const { consolidationJob, isMemoryReady } = options;

  if (!isMemoryReady()) {
    return err(
      new DaemonError(
        "Cannot register memory cron jobs before memory service is ready",
        "DAEMON_MEMORY_NOT_READY",
      ),
    );
  }

  if (consolidationJob) {
    const consolidationResult = consolidationJob.start();
    if (!consolidationResult.ok) {
      return err(
        new DaemonError(
          `Failed to start consolidation job: ${consolidationResult.error.message}`,
          "DAEMON_CRON_REGISTRATION_FAILED",
          consolidationResult.error,
        ),
      );
    }
  }

  return ok({
    stopAll() {
      consolidationJob?.stop();
    },
    isConsolidationRunning() {
      return consolidationJob?.isRunning() ?? false;
    },
  });
}
