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
import {
  ConflictDetector,
  ConflictResolver,
  type Conflict,
  type ConversionPlan,
} from "./conflict";
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
import type {
  CategoryResult,
  ConflictResolution,
  ConflictStrategy,
  ConversionOptions,
  ConversionResult,
  ConversionProgressEvent,
  OpenClawConfig,
  OpenClawAuthProfile,
  OpenClawChannelConfig,
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

interface ConflictDetectionContext {
  resolutions: ConflictResolution[];
  skippedCategories: Set<ConversionCategory>;
  strategyByCategory: Map<ConversionCategory, ConflictStrategy>;
}

interface ProgressEmitterLike {
  emit(event: ConversionProgressEvent): void;
  emitThrottled(event: ConversionProgressEvent): void;
}

interface ConflictDetectorLike {
  detect(plan: ConversionPlan): Promise<Conflict[]>;
}

interface ConflictResolverLike {
  resolve(conflict: Conflict, strategy: ConflictStrategy): {
    conflict: Conflict;
    strategy: ConflictStrategy;
    outcome: "applied" | "skipped" | "merged";
    mergedValue?: unknown;
  };
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
  progressEmitter?: ProgressEmitterLike;
  conflictDetector?: ConflictDetectorLike;
  conflictResolver?: ConflictResolverLike;
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
  private readonly conflictDetector: ConflictDetectorLike;
  private readonly conflictResolver: ConflictResolverLike;
  private running = false;

  constructor(options: ConversionServiceOptions) {
    this.options = options;
    this.detector = options.openClawDetector ?? new OpenClawDetector();
    this.parser = options.parser ?? new OpenClawParser();
    this.conflictDetector = options.conflictDetector ?? new ConflictDetector({
      agentStore: options.agentStore,
      keychainProvider: options.keychainProvider,
    });
    this.conflictResolver = options.conflictResolver ?? new ConflictResolver();
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
    let conflictResolutions: ConflictResolution[] = [];

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

      const conflictsResult = await this.detectAndResolveConflicts(
        options,
        selected,
        context,
      );
      if (!conflictsResult.ok) {
        return err(conflictsResult.error);
      }

      conflictResolutions = conflictsResult.value.resolutions;

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

        if (conflictsResult.value.skippedCategories.has(category)) {
          categoryResults.push({
            category,
            converted: 0,
            skipped: 0,
            errors: [],
            skippedReason: "conflict strategy: skip",
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
            conflictStrategy:
              conflictsResult.value.strategyByCategory.get(category) ??
              options.conflictStrategy,
            conflicts: conflictResolutions.filter((resolution) => resolution.conflict.category === category),
            onProgress: (processed, total) => {
              const progressEvent: ConversionProgressEvent = {
                category,
                processed,
                total,
                elapsedMs: Date.now() - categoryStartedAt,
                status: "progress",
              };
              options.onProgress?.(progressEvent);
              this.options.progressEmitter?.emitThrottled(progressEvent);
            },
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
        conflicts: conflictResolutions,
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

  private async detectAndResolveConflicts(
    options: ConversionOptions,
    selected: Set<ConversionCategory>,
    context: ConversionExecutionContext | undefined,
  ): Promise<Result<ConflictDetectionContext>> {
    const plan = context
      ? buildConversionPlan(context.parsedInstall, selected)
      : {};
    const conflicts = await this.conflictDetector.detect(plan);
    if (conflicts.length === 0) {
      return ok({
        resolutions: [],
        skippedCategories: new Set<ConversionCategory>(),
        strategyByCategory: new Map<ConversionCategory, ConflictStrategy>(),
      });
    }

    const resolved: ConflictResolution[] = [];
    const skippedCategories = new Set<ConversionCategory>();
    const strategyByCategory = new Map<ConversionCategory, ConflictStrategy>();

    for (const conflict of conflicts) {
      let strategy: ConflictStrategy = options.conflictStrategy ?? "skip";
      if (options.onConflict) {
        try {
          strategy = await options.onConflict(conflict);
        } catch (cause) {
          return err(
            new ConversionServiceError(
              "Conflict resolution callback failed",
              cause instanceof Error ? cause : undefined,
            ),
          );
        }
      }

      const record = this.conflictResolver.resolve(conflict, strategy);
      resolved.push({
        conflict: record.conflict,
        strategy: record.strategy,
        outcome: record.outcome,
        mergedValue: record.mergedValue,
      });

      strategyByCategory.set(conflict.category, strategy);
      if (strategy === "skip") {
        skippedCategories.add(conflict.category);
      }
    }

    return ok({
      resolutions: resolved,
      skippedCategories,
      strategyByCategory,
    });
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

        // Support both agents.named (Record) and agents.list (Array) formats.
        // agents.list entries use `id` as the key; fall back to slugified `name`.
        const namedAgents = context.parsedInstall.config.agents?.named ?? {};
        const listAgents = context.parsedInstall.config.agents?.list ?? [];

        const allAgents: Record<string, Partial<import("./types").OpenClawAgentConfig>> = { ...namedAgents };
        for (const entry of listAgents) {
          const key = (entry.id ?? entry.name ?? "").trim();
          if (key.length > 0 && !(key in allAgents)) {
            allAgents[key] = entry;
          }
        }

        return mapper.map(allAgents, mapperOptions);
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
        const channels = Object.entries(context.parsedInstall.config.channels ?? {}).map(
          ([channelType, config]) => ({
            ...config,
            type: channelType,
            // Inject name from the map key if the value doesn't have one.
            name: typeof (config as Record<string, unknown>).name === "string"
              ? (config as Record<string, unknown>).name as string
              : channelType,
          }),
        );
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
  const mappings: WorkspaceMapping[] = [];

  const namedAgents = parsedInstall.config.agents?.named ?? {};
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

  // Also handle the agents.list format (uses `workspace` field, not `workspacePath`).
  const listAgents = parsedInstall.config.agents?.list ?? [];
  for (const entry of listAgents) {
    const raw = entry as unknown as Record<string, unknown>;
    const openClawPath = typeof raw.workspace === "string" ? raw.workspace : undefined;
    if (!openClawPath) {
      continue;
    }

    const agentId = (entry.id ?? entry.name ?? "").trim();
    if (agentId.length === 0) {
      continue;
    }

    mappings.push({ openClawPath, reinsAgentId: slugify(agentId) });
  }

  return mappings;
}

function buildConversionPlan(
  parsedInstall: ParsedOpenClawInstall,
  selected: Set<ConversionCategory>,
): ConversionPlan {
  const plan: ConversionPlan = {};

  if (selected.has("agents")) {
    const namedAgents = parsedInstall.config.agents?.named ?? {};
    const listAgents = parsedInstall.config.agents?.list ?? [];

    const fromNamed = Object.entries(namedAgents).map(([name, config]) => ({
      name,
      ...config,
    }));

    const fromList = listAgents.map((entry) => ({
      name: entry.name ?? entry.id ?? "",
      ...entry,
    }));

    plan.agents = [...fromNamed, ...fromList];
  }

  if (selected.has("auth-profiles")) {
    const profiles = Object.values(parsedInstall.config.auth?.profiles ?? {});
    plan.providerKeys = profiles
      .filter((profile): profile is OpenClawAuthProfile => typeof profile.provider === "string")
      .map((profile) => ({
        provider: profile.provider,
        mode: profile.mode,
      }));
  }

  if (selected.has("channel-credentials")) {
    plan.channels = Object.entries(parsedInstall.config.channels ?? {}).map(([channelType, config]) => {
      const channelConfig = config as OpenClawChannelConfig & { name?: string };
      return {
        name: typeof channelConfig.name === "string" ? channelConfig.name : channelType,
        type: channelType,
      };
    });
  }

  return plan;
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
