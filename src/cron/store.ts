import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { err, ok } from "../result";
import type { CronJobDefinition, CronResult } from "./types";
import { CronError } from "./types";

export interface CronStore {
  save(job: CronJobDefinition): Promise<CronResult<void>>;
  get(id: string): Promise<CronResult<CronJobDefinition | null>>;
  list(): Promise<CronResult<CronJobDefinition[]>>;
  delete(id: string): Promise<CronResult<void>>;
}

export class LocalCronStore implements CronStore {
  constructor(private readonly cronDir: string) {}

  async save(job: CronJobDefinition): Promise<CronResult<void>> {
    try {
      await mkdir(this.cronDir, { recursive: true });
      const path = this.jobPath(job.id);
      await Bun.write(path, JSON.stringify(job, null, 2));
      return ok(undefined);
    } catch (cause) {
      return err(this.asCronError("Failed to save cron job", "CRON_STORE_SAVE_FAILED", cause));
    }
  }

  async get(id: string): Promise<CronResult<CronJobDefinition | null>> {
    try {
      const path = this.jobPath(id);
      const file = Bun.file(path);
      if (!(await file.exists())) {
        return ok(null);
      }

      const content = await file.text();
      const parsed = JSON.parse(content) as CronJobDefinition;
      return ok(parsed);
    } catch (cause) {
      return err(this.asCronError("Failed to get cron job", "CRON_STORE_GET_FAILED", cause));
    }
  }

  async list(): Promise<CronResult<CronJobDefinition[]>> {
    try {
      await mkdir(this.cronDir, { recursive: true });
      const entries = await readdir(this.cronDir, { withFileTypes: true });

      const jobs: CronJobDefinition[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }

        const path = join(this.cronDir, entry.name);
        const content = await Bun.file(path).text();
        jobs.push(JSON.parse(content) as CronJobDefinition);
      }

      return ok(jobs);
    } catch (cause) {
      return err(this.asCronError("Failed to list cron jobs", "CRON_STORE_LIST_FAILED", cause));
    }
  }

  async delete(id: string): Promise<CronResult<void>> {
    try {
      await unlink(this.jobPath(id));
      return ok(undefined);
    } catch (cause) {
      if (isNodeErrno(cause, "ENOENT")) {
        return ok(undefined);
      }

      return err(this.asCronError("Failed to delete cron job", "CRON_STORE_DELETE_FAILED", cause));
    }
  }

  private jobPath(id: string): string {
    return join(this.cronDir, `${id}.json`);
  }

  private asCronError(message: string, code: string, cause: unknown): CronError {
    if (cause instanceof CronError) {
      return cause;
    }

    return new CronError(message, code, cause instanceof Error ? cause : undefined);
  }
}

function isNodeErrno(error: unknown, code: string): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "code" in error && (error as { code?: string }).code === code;
}
