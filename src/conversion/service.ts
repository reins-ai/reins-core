import { basename } from "node:path";

import type { AgentStore } from "../agents/store";
import {
  ALL_CONVERSION_CATEGORIES,
  type ConversionCategory,
} from "../agents/types";
import type { IdentityFileManager } from "../agents/identity";
import type { AgentWorkspaceManager } from "../agents/workspace";
import { ReinsError } from "../errors";
import { err, ok, type Result } from "../result";
import type { KeychainProvider } from "../security/keychain-provider";
import { OpenClawDetector } from "./detector";
import { ImportLogWriter } from "./import-log";
import {
  AgentMapper,
  ChannelMapper,
  ConversationMapper,
  CredentialMapper,
  GatewayConfigMapper,
  MemoryMapper,
  SharedRefMapper,
  SkillMapper,
  ToolConfigMapper,
  type MapResult,
  type MapperOptions,
  type WorkspaceMapping,
} from "./mappers";
import { OpenClawParser } from "./parser";
import type { ProgressEmitter } from "./progress";
import type {
  CategoryResult,
  ConversionOptions,
  ConversionResult,
  OpenClawConfig,
  OpenClawToolConfig,
  ParsedOpenClawInstall,
} from "./types";

export interface DaemonService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

type ConversionCategoryRunner = (
  options: MapperOptions,
  context: ConversionExecutionContext,
) => Promise<MapResult>;

interface ConversionExecutionContext {
  parsedInstall: ParsedOpenClawInstall;
}

export interface ConversionServiceOptions {
  keychainProvider: KeychainProvider;
  agentStore: AgentStore;
  workspaceManager: AgentWorkspaceManager;
  identityManager: IdentityFileManager;
  importLogWriter: ImportLogWriter;
  openClawDetector?: OpenClawDetector;
  detectedPath?: string;
  parser?: OpenClawParser;
  progressEmitter?: ProgressEmitter;
  mapperRunners?: Partial<Record<ConversionCategory, ConversionCategoryRunner>>;
}

export class ConversionServiceError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "CONVERSION_SERVICE_ERROR", cause);
    this.name = "ConversionServiceError";
  }
}

export class ConversionService implements DaemonService {
  private readonly options: ConversionServiceOptions;
  private readonly detector: OpenClawDetector;
  private readonly parser: OpenClawParser;
  private running = false;

  constructor(options: ConversionServiceOptions) {
    this.options = options;
    this.detector = options.openClawDetector ?? new OpenClawDetector();
    this.parser = options.parser ?? new OpenClawParser();
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async convert(options: ConversionOptions): Promise<Result<ConversionResult>> {
    const startedAt = Date.now();
    const selected = new Set(options.selectedCategories);
    const categoryResults: CategoryResult[] = [];

    try {
      const needsDefaultContext = ALL_CONVERSION_CATEGORIES.some(
        (category) => selected.has(category) && !this.options.mapperRunners?.[category],
      );

      let context: ConversionExecutionContext | undefined;
      if (needsDefaultContext) {
        const contextResult = await this.loadExecutionContext();
        if (!contextResult.ok) {
          return err(contextResult.error);
        }
        context = contextResult.value;
      }

      for (const category of ALL_CONVERSION_CATEGORIES) {
        if (!selected.has(category)) {
          categoryResults.push({
            category,
            converted: 0,
            skipped: 0,
            errors: [],
            skippedReason: "not selected",
          });
          continue;
        }

        const categoryStartedAt = Date.now();
        const startEvent = {
          category,
          processed: 0,
          total: 1,
          elapsedMs: 0,
          status: "started" as const,
        };
        options.onProgress?.(startEvent);
        this.options.progressEmitter?.emit(startEvent);

        try {
          const mapperOptions: MapperOptions = {
            dryRun: options.dryRun,
          };
          const mapResult = await this.runCategory(category, mapperOptions, context);
          const categoryElapsed = Date.now() - categoryStartedAt;

          categoryResults.push({
            category,
            converted: mapResult.converted,
            skipped: mapResult.skipped,
            errors: mapResult.errors,
          });

          const completeEvent = {
            category,
            processed: 1,
            total: 1,
            elapsedMs: categoryElapsed,
            status: "complete" as const,
          };
          options.onProgress?.(completeEvent);
          this.options.progressEmitter?.emit(completeEvent);
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          const categoryElapsed = Date.now() - categoryStartedAt;

          categoryResults.push({
            category,
            converted: 0,
            skipped: 1,
            errors: [{ item: category, reason }],
          });

          const errorEvent = {
            category,
            processed: 0,
            total: 1,
            elapsedMs: categoryElapsed,
            status: "error" as const,
          };
          options.onProgress?.(errorEvent);
          this.options.progressEmitter?.emit(errorEvent);
        }
      }

      const totalConverted = categoryResults.reduce(
        (sum, result) => sum + result.converted,
        0,
      );
      const totalSkipped = categoryResults.reduce(
        (sum, result) => sum + result.skipped,
        0,
      );
      const totalErrors = categoryResults.reduce(
        (sum, result) => sum + result.errors.length,
        0,
      );

      return ok({
        success: totalErrors === 0,
        categories: categoryResults,
        totalConverted,
        totalSkipped,
        totalErrors,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (cause) {
      return err(
        new ConversionServiceError(
          "Conversion failed unexpectedly",
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  private async runCategory(
    category: ConversionCategory,
    mapperOptions: MapperOptions,
    context: ConversionExecutionContext | undefined,
  ): Promise<MapResult> {
    const overrideRunner = this.options.mapperRunners?.[category];
    if (overrideRunner) {
      return overrideRunner(mapperOptions, context ?? { parsedInstall: emptyParsedInstall() });
    }

    if (!context) {
      throw new ConversionServiceError(`Missing conversion context for category: ${category}`);
    }

    const defaultRunner = this.defaultRunners(context)[category];
    return defaultRunner(mapperOptions, context);
  }

  private async loadExecutionContext(): Promise<Result<ConversionExecutionContext>> {
    const stateDirResult = await this.resolveStateDir();
    if (!stateDirResult.ok) {
      return stateDirResult;
    }

    try {
      const parsedInstall = await this.parser.parse(stateDirResult.value);
      return ok({ parsedInstall });
    } catch (cause) {
      return err(
        new ConversionServiceError(
          "Failed to parse OpenClaw installation",
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  private async resolveStateDir(): Promise<Result<string>> {
    if (this.options.detectedPath) {
      return ok(this.options.detectedPath);
    }

    const detection = await this.detector.detect();
    if (!detection.found || detection.path.trim().length === 0) {
      return err(new ConversionServiceError("OpenClaw installation not found"));
    }

    return ok(detection.path);
  }

  private defaultRunners(
    context: ConversionExecutionContext,
  ): Record<ConversionCategory, ConversionCategoryRunner> {
    return {
      "agents": async (mapperOptions) => {
        const mapper = new AgentMapper({
          agentStore: this.options.agentStore,
          workspaceManager: this.options.workspaceManager,
          identityManager: this.options.identityManager,
        });

        return mapper.map(context.parsedInstall.config.agents?.named ?? {}, mapperOptions);
      },
      "workspace-memory": async (mapperOptions) => {
        const mapper = new MemoryMapper(this.options.workspaceManager);
        return mapper.map(buildWorkspaceMappings(context.parsedInstall), mapperOptions);
      },
      "auth-profiles": async (mapperOptions) => {
        const mapper = new CredentialMapper(this.options.keychainProvider);
        const profiles = Object.values(context.parsedInstall.config.auth?.profiles ?? {});
        return mapper.map(profiles, mapperOptions);
      },
      "channel-credentials": async (mapperOptions) => {
        const mapper = new ChannelMapper(this.options.keychainProvider);
        const channels = Object.values(context.parsedInstall.config.channels ?? {});
        return mapper.map(channels, mapperOptions);
      },
      "skills": async (mapperOptions) => {
        const mapper = new SkillMapper();
        const skills = context.parsedInstall.skillDirs.map((dir) => ({ name: basename(dir) }));
        return mapper.map(skills, mapperOptions);
      },
      "conversations": async (mapperOptions) => {
        const mapper = new ConversationMapper();
        return mapper.map([], mapperOptions);
      },
      "shared-references": async (mapperOptions) => {
        const mapper = new SharedRefMapper();
        const paths = {
          sharedReferences: context.parsedInstall.sharedReferenceDirs[0],
          templates: context.parsedInstall.sharedReferenceDirs[1],
        };
        return mapper.map(paths, mapperOptions);
      },
      "tool-config": async (mapperOptions) => {
        const mapper = new ToolConfigMapper(this.options.keychainProvider);
        return mapper.map(extractToolConfig(context.parsedInstall.config), mapperOptions);
      },
      "gateway-config": async (mapperOptions) => {
        const mapper = new GatewayConfigMapper(
          this.options.importLogWriter,
          this.options.keychainProvider,
        );
        return mapper.map(context.parsedInstall.config.gateway ?? {}, mapperOptions);
      },
    };
  }
}

function buildWorkspaceMappings(parsedInstall: ParsedOpenClawInstall): WorkspaceMapping[] {
  const namedAgents = parsedInstall.config.agents?.named ?? {};
  const mappings: WorkspaceMapping[] = [];

  for (const [name, config] of Object.entries(namedAgents)) {
    const openClawPath = typeof config.workspacePath === "string"
      ? config.workspacePath
      : undefined;
    if (!openClawPath) {
      continue;
    }

    const reinsAgentId = config.id ?? slugify(name);
    mappings.push({ openClawPath, reinsAgentId });
  }

  return mappings;
}

function extractToolConfig(config: OpenClawConfig): OpenClawToolConfig {
  const toolsValue = config.unknownFields["tools"];
  if (typeof toolsValue !== "object" || toolsValue === null || Array.isArray(toolsValue)) {
    return {};
  }

  const searchValue = (toolsValue as Record<string, unknown>)["search"];
  if (typeof searchValue !== "object" || searchValue === null || Array.isArray(searchValue)) {
    return {};
  }

  const providerValue = (searchValue as Record<string, unknown>)["provider"];
  const apiKeyValue = (searchValue as Record<string, unknown>)["apiKey"];

  return {
    search: {
      provider: typeof providerValue === "string" ? providerValue : undefined,
      apiKey: typeof apiKeyValue === "string" ? apiKeyValue : undefined,
    },
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function emptyParsedInstall(): ParsedOpenClawInstall {
  return {
    config: { unknownFields: {} },
    configPath: "",
    stateDir: "",
    agentDirs: [],
    workspaceDirs: [],
    skillDirs: [],
    sharedReferenceDirs: [],
    credentialFiles: [],
  };
}
