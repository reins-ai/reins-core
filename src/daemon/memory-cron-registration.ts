import { err, ok, type Result } from "../result";
import { DaemonError } from "./types";
import type { MemoryConsolidationJob } from "../cron/jobs/memory-consolidation-job";
import type { MorningBriefingJob } from "../cron/jobs/morning-briefing-job";

export interface MemoryCronRegistrationOptions {
  consolidationJob: MemoryConsolidationJob;
  briefingJob: MorningBriefingJob;
  isMemoryReady: () => boolean;
}

export interface MemoryCronHandle {
  stopAll(): void;
  isConsolidationRunning(): boolean;
  isBriefingRunning(): boolean;
}

/**
 * Registers memory consolidation and briefing cron jobs after verifying
 * that the memory service is ready. Returns a handle for stopping both
 * jobs during daemon shutdown.
 */
export function registerMemoryCronJobs(
  options: MemoryCronRegistrationOptions,
): Result<MemoryCronHandle, DaemonError> {
  const { consolidationJob, briefingJob, isMemoryReady } = options;

  if (!isMemoryReady()) {
    return err(
      new DaemonError(
        "Cannot register memory cron jobs before memory service is ready",
        "DAEMON_MEMORY_NOT_READY",
      ),
    );
  }

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

  const briefingResult = briefingJob.start();
  if (!briefingResult.ok) {
    consolidationJob.stop();
    return err(
      new DaemonError(
        `Failed to start briefing job: ${briefingResult.error.message}`,
        "DAEMON_CRON_REGISTRATION_FAILED",
        briefingResult.error,
      ),
    );
  }

  return ok({
    stopAll() {
      consolidationJob.stop();
      briefingJob.stop();
    },
    isConsolidationRunning() {
      return consolidationJob.isRunning();
    },
    isBriefingRunning() {
      return briefingJob.isRunning();
    },
  });
}
