import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryPermissionAuditLog } from "../../../src/plugins/audit";
import { InMemoryPluginEventBus } from "../../../src/plugins/events";
import { PluginLifecycleManager } from "../../../src/plugins/lifecycle";
import { PluginLoader } from "../../../src/plugins/loader";
import { PluginPermissionChecker } from "../../../src/plugins/permissions";
import { DEFAULT_RESOURCE_LIMITS, MockPluginSandbox, type SandboxConfig } from "../../../src/plugins/sandbox";
import { InMemoryPluginStateStore } from "../../../src/plugins/state";
import { ToolExecutor, ToolRegistry } from "../../../src/tools";
import type { PluginManifest, Tool, ToolContext, ToolResult } from "../../../src/types";

declare global {
  var __reinsConversationEvents: string[] | undefined;
}

const createdRoots: string[] = [];

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
  delete globalThis.__reinsConversationEvents;
});

async function createPluginEntryPoint(root: string, pluginName: string, source: string): Promise<string> {
  const entryPoint = join(root, `${pluginName}.ts`);
  await writeFile(entryPoint, source, "utf8");
  return entryPoint;
}

function createManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "conversation-plugin",
    version: "1.0.0",
    description: "Conversation integration plugin",
    author: "Test",
    permissions: ["read_notes"],
    entryPoint: "/tmp/plugin.ts",
    ...overrides,
  };
}

function registerLoadedPluginTools(
  loader: PluginLoader,
  sandboxes: Map<string, MockPluginSandbox>,
  registry: ToolRegistry,
): void {
  registry.clear();

  for (const pluginName of loader.getLoadedPlugins()) {
    const sandbox = sandboxes.get(pluginName);
    if (!sandbox) {
      continue;
    }

    for (const definition of sandbox.getRegisteredTools()) {
      const tool: Tool = {
        definition: {
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters as Tool["definition"]["parameters"],
        },
        async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
          return sandbox.executeToolCall(definition.name, args, context);
        },
      };

      registry.register(tool);
    }
  }
}

const alphaPluginSource = `
export default async function setupPlugin(context) {
  context.registerTool({
    definition: {
      name: "alpha.echo",
      description: "Echo values for conversation flow",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string" }
        },
        required: ["value"]
      }
    },
    async execute(args, toolContext) {
      return {
        callId: toolContext.conversationId,
        name: "alpha.echo",
        result: { value: args.value, userId: toolContext.userId }
      };
    }
  });

  context.on("message", async (eventData) => {
    const events = globalThis.__reinsConversationEvents ?? [];
    events.push(String(eventData));
    globalThis.__reinsConversationEvents = events;
  });
}
`;

const betaPluginSource = `
export default async function setupPlugin(context) {
  context.registerTool({
    definition: {
      name: "beta.fail",
      description: "Always fails",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    },
    async execute() {
      return {
        callId: "beta-call",
        name: "beta.fail",
        result: null,
        error: "beta-tool-failure"
      };
    }
  });
}
`;

const gammaPluginSource = `
export default async function setupPlugin(context) {
  context.registerTool({
    definition: {
      name: "gamma.sum",
      description: "Adds two numbers",
      parameters: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" }
        },
        required: ["a", "b"]
      }
    },
    async execute(args, toolContext) {
      return {
        callId: toolContext.conversationId,
        name: "gamma.sum",
        result: Number(args.a) + Number(args.b)
      };
    }
  });
}
`;

describe("integration/plugins/conversation", () => {
  it("integrates plugin tools with conversation-style tool flow", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-int-conversation-"));
    createdRoots.push(root);
    globalThis.__reinsConversationEvents = [];

    const alphaEntryPoint = await createPluginEntryPoint(root, "alpha-plugin", alphaPluginSource);
    const betaEntryPoint = await createPluginEntryPoint(root, "beta-plugin", betaPluginSource);
    const gammaEntryPoint = await createPluginEntryPoint(root, "gamma-plugin", gammaPluginSource);

    const lifecycleManager = new PluginLifecycleManager(new InMemoryPluginStateStore());
    const auditLog = new InMemoryPermissionAuditLog();
    const eventBus = new InMemoryPluginEventBus();
    const sandboxes = new Map<string, MockPluginSandbox>();

    const loader = new PluginLoader(
      lifecycleManager,
      (config: SandboxConfig) => {
        const sandbox = new MockPluginSandbox(
          {
            ...config,
            limits: {
              ...DEFAULT_RESOURCE_LIMITS,
              maxEventHandlerMs: 100,
            },
          },
          auditLog,
        );
        sandboxes.set(config.pluginName, sandbox);
        return sandbox;
      },
      (pluginName, permissions) => new PluginPermissionChecker(pluginName, permissions, auditLog),
      auditLog,
      eventBus,
    );

    await lifecycleManager.install(
      createManifest({ name: "alpha-plugin", entryPoint: alphaEntryPoint }),
      root,
    );
    await lifecycleManager.install(
      createManifest({ name: "beta-plugin", entryPoint: betaEntryPoint }),
      root,
    );
    await lifecycleManager.install(
      createManifest({ name: "gamma-plugin", entryPoint: gammaEntryPoint }),
      root,
    );

    await lifecycleManager.enable("alpha-plugin");
    await lifecycleManager.enable("beta-plugin");
    await lifecycleManager.enable("gamma-plugin");

    await loader.loadAllEnabled();

    const toolRegistry = new ToolRegistry();
    registerLoadedPluginTools(loader, sandboxes, toolRegistry);
    const toolExecutor = new ToolExecutor(toolRegistry);

    const availableToolNames = toolRegistry.getDefinitions().map((tool) => tool.name).sort();
    expect(availableToolNames).toEqual(["alpha.echo", "beta.fail", "gamma.sum"]);

    const alphaResult = await toolExecutor.execute(
      {
        id: "call-alpha",
        name: "alpha.echo",
        arguments: { value: "hello" },
      },
      { conversationId: "conv-1", userId: "user-1" },
    );
    expect(alphaResult.callId).toBe("call-alpha");
    expect(alphaResult.name).toBe("alpha.echo");
    expect(alphaResult.error).toBeUndefined();
    expect(alphaResult.result).toEqual({ value: "hello", userId: "user-1" });

    const errorResult = await toolExecutor.execute(
      {
        id: "call-beta",
        name: "beta.fail",
        arguments: {},
      },
      { conversationId: "conv-1", userId: "user-1" },
    );
    expect(errorResult.callId).toBe("call-beta");
    expect(errorResult.name).toBe("beta.fail");
    expect(errorResult.result).toBeNull();
    expect(errorResult.error).toBe("beta-tool-failure");

    await eventBus.emit("message", "conversation-event");
    expect(globalThis.__reinsConversationEvents).toEqual(["conversation-event"]);

    const gammaResult = await toolExecutor.execute(
      {
        id: "call-gamma",
        name: "gamma.sum",
        arguments: { a: 2, b: 5 },
      },
      { conversationId: "conv-2", userId: "user-2" },
    );
    expect(gammaResult.result).toBe(7);

    await loader.unloadPlugin("gamma-plugin");
    registerLoadedPluginTools(loader, sandboxes, toolRegistry);
    const toolNamesAfterUnload = toolRegistry.getDefinitions().map((tool) => tool.name).sort();
    expect(toolNamesAfterUnload).toEqual(["alpha.echo", "beta.fail"]);
  });
});
