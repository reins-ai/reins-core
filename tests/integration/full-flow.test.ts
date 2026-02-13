import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationManager, InMemoryConversationStore } from "../../src/conversation";
import { ContextManager, SlidingWindowStrategy } from "../../src/context";
import { DaemonRuntime } from "../../src/daemon/runtime";
import { ok } from "../../src/result";
import { LocalCronStore } from "../../src/cron/store";
import { CronScheduler } from "../../src/cron/scheduler";
import { InMemoryMemoryStore } from "../../src/memory";
import { PersonaRegistry, SystemPromptBuilder } from "../../src/persona";
import { EncryptedCredentialStore } from "../../src/providers/credentials/store";
import { MockProvider } from "../../src/providers/mock";
import { ModelRouter, ProviderRegistry } from "../../src/providers";
import { MachineAuthService } from "../../src/security/machine-auth";
import { StreamingResponse } from "../../src/streaming";
import { SyncPolicy } from "../../src/sync/policy";
import { ToolExecutor, ToolRegistry } from "../../src/tools";
import { SessionRepository } from "../../src/conversation/session-repository";
import {
  AgentLoop,
  ToolPipeline,
  createHarnessEventBus,
  EventTransportAdapter,
} from "../../src/harness";
import type { LoopEvent, TransportFrame } from "../../src/harness";
import type { ChatRequest, ContentBlock, Model, Provider, StreamEvent, Tool, ToolCall, ToolContext, ToolResult } from "../../src/types";

const createModel = (providerId: string): Model => ({
  id: "mock-model-1",
  name: "Mock Model",
  provider: providerId,
  contextWindow: 4096,
  capabilities: ["chat", "streaming", "tool_use"],
});

const weatherCall: ToolCall = {
  id: "tool-weather-1",
  name: "get_weather",
  arguments: { location: "San Francisco" },
};

const weatherTool: Tool = {
  definition: {
    name: "get_weather",
    description: "Get the weather for a location",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string" },
      },
      required: ["location"],
    },
  },
  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const location = typeof args.location === "string" ? args.location : "unknown";
    return {
      callId: "ignored",
      name: "internal",
      result: { location, temperatureF: 72, condition: "Sunny" },
    };
  },
};

const createRequest = (model: string, messages: ChatRequest["messages"], systemPrompt?: string): ChatRequest => ({
  model,
  messages,
  systemPrompt,
});

describe("integration/full-flow", () => {
  it("wires providers, streaming, tools, context, memory, and persona end-to-end", async () => {
    const firstProvider = new MockProvider({
      config: { id: "mock-first", name: "Mock First", type: "local" },
      models: [createModel("mock-first")],
      responseContent: "Great question. I can help with your day.",
    });
    const toolPlannerProvider = new MockProvider({
      config: { id: "mock-tool", name: "Mock Tool", type: "local" },
      models: [createModel("mock-tool")],
      responseContent: "I'll check the weather first.",
      toolCalls: [weatherCall],
      finishReason: "tool_use",
    });
    const finalProvider = new MockProvider({
      config: { id: "mock-final", name: "Mock Final", type: "local" },
      models: [createModel("mock-final")],
      responseContent: "It's sunny and 72F in San Francisco, ideal for an outdoor walk.",
    });

    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(firstProvider);
    providerRegistry.register(toolPlannerProvider);
    providerRegistry.register(finalProvider);
    const modelRouter = new ModelRouter(providerRegistry);

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(weatherTool);
    const toolExecutor = new ToolExecutor(toolRegistry);

    const conversationStore = new InMemoryConversationStore();
    const conversationManager = new ConversationManager(conversationStore);
    const contextManager = new ContextManager({
      strategy: new SlidingWindowStrategy(),
      defaultMaxTokens: 4096,
    });

    const personaRegistry = new PersonaRegistry();
    const promptBuilder = new SystemPromptBuilder();
    const memoryStore = new InMemoryMemoryStore();

    const persona = personaRegistry.getDefault();
    const systemPrompt = promptBuilder.build({
      persona,
      availableTools: toolRegistry.getDefinitions(),
      userContext: "User: Alex; timezone: PST",
    });

    const conversation = await conversationManager.create({
      title: "Assistant full flow",
      model: "mock-model-1",
      provider: "mock-first",
      personaId: persona.id,
      systemPrompt,
    });

    await conversationManager.addMessage(conversation.id, {
      role: "user",
      content: "Plan my afternoon and account for weather.",
    });

    const turnOneRoute = await modelRouter.route({
      provider: "mock-first",
      model: "mock-model-1",
      capabilities: ["chat", "streaming"],
    });

    const turnOneHistory = await conversationManager.getHistory(conversation.id);
    const turnOneContext = contextManager.prepare(turnOneHistory, {
      model: turnOneRoute.model,
      reservedForOutput: 200,
      systemPrompt,
    });
    const turnOneStream = new StreamingResponse(
      turnOneRoute.provider.stream(createRequest(turnOneRoute.model.id, turnOneContext, systemPrompt)),
    );
    const turnOneCollected = await turnOneStream.collect();

    await conversationManager.addMessage(conversation.id, {
      role: "assistant",
      content: turnOneCollected.content,
    });

    await memoryStore.save({
      content: `Assistant guidance: ${turnOneCollected.content}`,
      type: "context",
      tags: ["conversation", "planning"],
      importance: 0.75,
      conversationId: conversation.id,
    });

    await conversationManager.addMessage(conversation.id, {
      role: "user",
      content: "Also check the weather before finalizing.",
    });

    const turnTwoRoute = await modelRouter.route({
      provider: "mock-tool",
      model: "mock-model-1",
      capabilities: ["chat", "tool_use"],
    });
    const turnTwoHistory = await conversationManager.getHistory(conversation.id);
    const turnTwoContext = contextManager.prepare(turnTwoHistory, {
      model: turnTwoRoute.model,
      reservedForOutput: 200,
      systemPrompt,
    });
    const turnTwoResponse = await turnTwoRoute.provider.chat(
      createRequest(turnTwoRoute.model.id, turnTwoContext, systemPrompt),
    );

    await conversationManager.addMessage(conversation.id, {
      role: "assistant",
      content: turnTwoResponse.content,
      toolCalls: turnTwoResponse.toolCalls,
    });

    const toolResult = await toolExecutor.execute(weatherCall, {
      conversationId: conversation.id,
      userId: "user-1",
      workspaceId: "ws-1",
    });

    await conversationManager.addMessage(conversation.id, {
      role: "tool",
      content: JSON.stringify(toolResult.result),
      toolResultId: toolResult.callId,
    });

    const finalRoute = await modelRouter.route({
      provider: "mock-final",
      model: "mock-model-1",
      capabilities: ["chat"],
    });
    const finalHistoryBeforeAnswer = await conversationManager.getHistory(conversation.id);
    const finalContext = contextManager.prepare(finalHistoryBeforeAnswer, {
      model: finalRoute.model,
      reservedForOutput: 200,
      systemPrompt,
    });
    const finalResponse = await finalRoute.provider.chat(
      createRequest(finalRoute.model.id, finalContext, systemPrompt),
    );

    await conversationManager.addMessage(conversation.id, {
      role: "assistant",
      content: finalResponse.content,
    });

    const finalHistory = await conversationManager.getHistory(conversation.id);
    const memoryResults = await memoryStore.search({ query: "guidance", tags: ["planning"] });

    expect(finalHistory.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(finalHistory[4]?.toolCalls?.[0]?.name).toBe("get_weather");
    expect(finalHistory[5]?.toolResultId).toBe(weatherCall.id);
    expect(finalHistory[6]?.content).toContain("72F");

    expect(memoryResults).toHaveLength(1);
    expect(memoryResults[0]?.entry.conversationId).toBe(conversation.id);

    expect(turnOneCollected.usage.totalTokens).toBeGreaterThan(0);
    expect(finalResponse.usage.totalTokens).toBeGreaterThan(0);
    expect(contextManager.estimateTokens(finalContext)).toBeLessThanOrEqual(4096 - 200);

    expect(systemPrompt).toContain("You are Reins");
    expect(systemPrompt).toContain("## Available Tools");
    expect(systemPrompt).toContain("get_weather");
  });

  it("propagates streaming errors in the integrated pipeline", async () => {
    const failingProvider = new MockProvider({
      config: { id: "mock-error", name: "Mock Error", type: "local" },
      models: [createModel("mock-error")],
      simulateError: true,
      errorMessage: "provider stream failed",
    });

    const registry = new ProviderRegistry();
    registry.register(failingProvider);
    const router = new ModelRouter(registry);

    await expect(router.route({ provider: "mock-error", capabilities: ["streaming"] })).rejects.toThrow(
      "provider stream failed",
    );
  });
});

describe("integration/full-flow contract hardening", () => {
  it("validates daemon lifecycle, auth, session persistence, credentials, cron, and sync policy boundaries", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "reins-full-flow-"));

    try {
      const daemonRuntime = new DaemonRuntime();
      let daemonRunning = false;

      daemonRuntime.registerService({
        id: "contract-service",
        start: async () => {
          daemonRunning = true;
          return ok(undefined);
        },
        stop: async () => {
          daemonRunning = false;
          return ok(undefined);
        },
      });

      const startResult = await daemonRuntime.start();
      expect(startResult.ok).toBe(true);
      expect(daemonRuntime.getState()).toBe("running");
      expect(daemonRunning).toBe(true);

      const stopResult = await daemonRuntime.stop();
      expect(stopResult.ok).toBe(true);
      expect(daemonRuntime.getState()).toBe("stopped");
      expect(daemonRunning).toBe(false);

      const machineAuth = new MachineAuthService({
        serviceName: "com.reins.tests",
        accountName: `machine-${crypto.randomUUID()}`,
      });

      const bootstrapResult = await machineAuth.bootstrap();
      expect(bootstrapResult.ok).toBe(true);
      if (!bootstrapResult.ok) {
        return;
      }

      const tokenValidation = await machineAuth.validate(bootstrapResult.value);
      expect(tokenValidation).toEqual({ ok: true, value: true });

      const pathOptions = {
        platform: "linux" as const,
        env: {},
        homeDirectory: tempRoot,
      };

      const firstRepository = new SessionRepository({
        daemonPathOptions: pathOptions,
        defaultModel: "gpt-4o-mini",
        defaultProvider: "openai",
      });
      const firstMain = await firstRepository.getMain();
      expect(firstMain.ok).toBe(true);
      if (!firstMain.ok) {
        return;
      }

      const resumedRepository = new SessionRepository({
        daemonPathOptions: pathOptions,
        defaultModel: "gpt-4o-mini",
        defaultProvider: "openai",
      });
      const resumedMain = await resumedRepository.getMain();
      expect(resumedMain.ok).toBe(true);
      if (!resumedMain.ok) {
        return;
      }

      expect(resumedMain.value.id).toBe(firstMain.value.id);

      const credentialStore = new EncryptedCredentialStore({
        encryptionSecret: "full-flow-secret",
        filePath: join(tempRoot, "credentials", "store.enc.json"),
      });
      const setCredential = await credentialStore.set({
        id: "cred_contract",
        provider: "openai",
        type: "api_key",
        payload: {
          encryptedKey: "ciphertext-contract",
          iv: "credential-iv",
          maskedKey: "sk-...9999",
          usageCount: 0,
          isValid: true,
        },
      });
      expect(setCredential.ok).toBe(true);

      const readCredential = await credentialStore.get({ id: "cred_contract" });
      expect(readCredential.ok).toBe(true);
      if (!readCredential.ok || !readCredential.value) {
        return;
      }

      const revokeCredential = await credentialStore.revoke("cred_contract");
      expect(revokeCredential).toEqual({ ok: true, value: true });

      const activeCredentials = await credentialStore.list();
      expect(activeCredentials.ok).toBe(true);
      if (!activeCredentials.ok) {
        return;
      }
      expect(activeCredentials.value).toHaveLength(0);

      const cronStore = new LocalCronStore(join(tempRoot, "cron"));
      let current = new Date("2026-02-11T12:00:00.000Z");
      const executedJobs: string[] = [];
      const scheduler = new CronScheduler({
        store: cronStore,
        tickIntervalMs: 25,
        now: () => current,
        onExecute: async (job) => {
          executedJobs.push(job.id);
        },
      });

      const createdJob = await scheduler.create({
        name: "contract-cycle",
        schedule: "* * * * *",
        payload: { action: "noop", parameters: {} },
      });
      expect(createdJob.ok).toBe(true);
      if (!createdJob.ok) {
        return;
      }

      await scheduler.start();
      current = new Date("2026-02-11T12:01:00.000Z");
      await Bun.sleep(120);
      await scheduler.stop();

      expect(executedJobs).toContain(createdJob.value.id);

      const deleteJob = await scheduler.remove(createdJob.value.id);
      expect(deleteJob.ok).toBe(true);

      const listedAfterDelete = await scheduler.listJobs();
      expect(listedAfterDelete.ok).toBe(true);
      if (!listedAfterDelete.ok) {
        return;
      }
      expect(listedAfterDelete.value).toHaveLength(0);

      const blockedConversationSync = SyncPolicy.validateSyncPayload("conversations", {
        conversationId: "conv_contract",
      });
      expect(blockedConversationSync.ok).toBe(false);

      const allowedCredentialSync = SyncPolicy.validateSyncPayload("credentials", {
        credentialId: "cred_contract",
      });
      expect(allowedCredentialSync.ok).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("integration/full-flow: multi-turn tool conversation with event streaming", () => {
  function createMockProvider(responses: Array<{
    text?: string;
    toolCalls?: ToolCall[];
    finishReason?: string;
  }>): Provider {
    let callIndex = 0;
    return {
      config: { id: "mock-multi", name: "Mock Multi", type: "local" },
      async chat() {
        throw new Error("not used");
      },
      async *stream(): AsyncIterable<StreamEvent> {
        const response = responses[callIndex] ?? { text: "fallback" };
        callIndex += 1;

        if (response.text) {
          yield { type: "token", content: response.text };
        }

        if (response.toolCalls) {
          for (const tc of response.toolCalls) {
            yield { type: "tool_call_start", toolCall: tc };
          }
        }

        yield {
          type: "done",
          finishReason: response.finishReason ?? "stop",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      },
      async listModels() {
        return [];
      },
      async validateConnection() {
        return true;
      },
    };
  }

  const integrationToolContext: ToolContext = {
    conversationId: "conv-integration",
    userId: "user-integration",
    workspaceId: "ws-integration",
  };

  it("complete multi-turn conversation with tools — events ordered end-to-end", async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "get_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
      async execute(args): Promise<ToolResult> {
        return {
          callId: "ignored",
          name: "get_file",
          result: `contents of ${args.path}`,
        };
      },
    });

    const provider = createMockProvider([
      {
        text: "Let me read that file.",
        toolCalls: [{ id: "tc-1", name: "get_file", arguments: { path: "main.ts" } }],
        finishReason: "tool_use",
      },
      {
        text: "The file contains your main entry point.",
      },
    ]);

    const loop = new AgentLoop({ maxSteps: 5 });
    const events: LoopEvent[] = [];

    for await (const event of loop.runWithProvider({
      provider,
      model: "test-model",
      messages: [{ id: "u1", role: "user", content: "Read main.ts", createdAt: new Date() }],
      toolExecutor: new ToolExecutor(registry),
      toolContext: integrationToolContext,
      tools: [registry.get("get_file")!.definition],
    })) {
      events.push(event);
    }

    // Should have: tokens, tool_call_start, tool_call_end, more tokens, done
    const tokenEvents = events.filter((e) => e.type === "token");
    const toolStartEvents = events.filter((e) => e.type === "tool_call_start");
    const toolEndEvents = events.filter((e) => e.type === "tool_call_end");
    const doneEvents = events.filter((e) => e.type === "done");

    expect(tokenEvents.length).toBeGreaterThanOrEqual(1);
    expect(toolStartEvents).toHaveLength(1);
    expect(toolEndEvents).toHaveLength(1);
    expect(doneEvents).toHaveLength(1);

    // Done event should indicate natural completion
    if (doneEvents[0]?.type === "done") {
      expect(doneEvents[0].terminationReason).toBe("text_only_response");
    }
  });

  it("tool errors do not break event stream — error propagated as tool result", async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "failing_tool",
        description: "Always fails",
        parameters: { type: "object", properties: {} },
      },
      async execute(): Promise<ToolResult> {
        throw new Error("Tool crashed");
      },
    });

    const provider = createMockProvider([
      {
        toolCalls: [{ id: "tc-fail", name: "failing_tool", arguments: {} }],
        finishReason: "tool_use",
      },
      {
        text: "The tool failed, but I can continue.",
      },
    ]);

    const loop = new AgentLoop({ maxSteps: 5 });
    const events: LoopEvent[] = [];

    for await (const event of loop.runWithProvider({
      provider,
      model: "test-model",
      messages: [{ id: "u1", role: "user", content: "run", createdAt: new Date() }],
      toolExecutor: new ToolExecutor(registry),
      toolContext: integrationToolContext,
      tools: [registry.get("failing_tool")!.definition],
    })) {
      events.push(event);
    }

    // Stream should complete without throwing
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);

    // tool_call_end should still be emitted with error
    const toolEndEvents = events.filter((e) => e.type === "tool_call_end");
    expect(toolEndEvents).toHaveLength(1);
    if (toolEndEvents[0]?.type === "tool_call_end") {
      expect(toolEndEvents[0].result.error).toBeDefined();
    }
  });

  it("abort mid-conversation — partial results preserved, clean termination", async () => {
    const controller = new AbortController();
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "slow_tool",
        description: "Slow tool",
        parameters: { type: "object", properties: {} },
      },
      async execute(): Promise<ToolResult> {
        controller.abort("user-interrupt");
        return { callId: "ignored", name: "slow_tool", result: "partial-output" };
      },
    });

    const provider = createMockProvider([
      {
        toolCalls: [{ id: "tc-slow", name: "slow_tool", arguments: {} }],
        finishReason: "tool_use",
      },
      {
        text: "Should not reach this.",
      },
    ]);

    const loop = new AgentLoop({ signal: controller.signal });
    const events: LoopEvent[] = [];

    for await (const event of loop.runWithProvider({
      provider,
      model: "test-model",
      messages: [{ id: "u1", role: "user", content: "run", createdAt: new Date() }],
      toolExecutor: new ToolExecutor(registry),
      toolContext: integrationToolContext,
      tools: [registry.get("slow_tool")!.definition],
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent?.type === "done") {
      expect(doneEvent.terminationReason).toBe("aborted");
      // Partial content should include the tool result
      expect(Array.isArray(doneEvent.content)).toBe(true);
      if (Array.isArray(doneEvent.content)) {
        const toolResults = doneEvent.content.filter((b) => b.type === "tool_result");
        expect(toolResults).toHaveLength(1);
      }
    }
  });
});

describe("integration/full-flow: event transport with agent loop", () => {
  const integrationToolContext: ToolContext = {
    conversationId: "conv-transport",
    userId: "user-transport",
    workspaceId: "ws-transport",
  };

  it("event transport captures all tool lifecycle events from agent loop", async () => {
    const eventBus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus, replayLimit: 256 });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();

    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "echo",
        description: "Echo tool",
        parameters: { type: "object", properties: { msg: { type: "string" } } },
      },
      async execute(args): Promise<ToolResult> {
        return { callId: "ignored", name: "echo", result: args.msg };
      },
    });

    const pipeline = new ToolPipeline({ executor: new ToolExecutor(registry), eventBus });
    const loop = new AgentLoop({ maxSteps: 5, toolPipeline: pipeline });

    let callCount = 0;
    await loop.run(
      [{ role: "user", content: "Echo hello" }],
      async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            type: "tool_calls" as const,
            toolCalls: [{ id: "tc-1", name: "echo", arguments: { msg: "hello" } }],
          };
        }
        return { type: "text" as const, content: "Done.", done: true };
      },
      integrationToolContext,
    );

    adapter.stop();

    // Should have tool_call_start and tool_call_end frames
    const startFrames = frames.filter((f) => f.event === "tool_call_start");
    const endFrames = frames.filter((f) => f.event === "tool_call_end");
    expect(startFrames).toHaveLength(1);
    expect(endFrames).toHaveLength(1);

    // Start should come before end
    const startId = startFrames[0]?.id ?? 0;
    const endId = endFrames[0]?.id ?? 0;
    expect(startId).toBeLessThan(endId);

    // Replay buffer should contain the same frames
    const replay = adapter.getReplayBuffer();
    expect(replay.length).toBeGreaterThanOrEqual(2);
  });

  it("long-running tool + multiple short tools — ordering correct in transport", async () => {
    const eventBus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus, replayLimit: 256 });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();

    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "tool.fast",
        description: "Fast tool",
        parameters: { type: "object", properties: { v: { type: "string" } } },
      },
      async execute(args): Promise<ToolResult> {
        return { callId: "ignored", name: "tool.fast", result: args.v };
      },
    });

    const pipeline = new ToolPipeline({ executor: new ToolExecutor(registry), eventBus });
    const loop = new AgentLoop({ maxSteps: 10, toolPipeline: pipeline });

    let callCount = 0;
    await loop.run(
      [{ role: "user", content: "Run many tools" }],
      async () => {
        callCount += 1;
        if (callCount <= 5) {
          return {
            type: "tool_calls" as const,
            toolCalls: [{ id: `tc-${callCount}`, name: "tool.fast", arguments: { v: `val-${callCount}` } }],
          };
        }
        return { type: "text" as const, content: "All done.", done: true };
      },
      integrationToolContext,
    );

    adapter.stop();

    const startFrames = frames.filter((f) => f.event === "tool_call_start");
    const endFrames = frames.filter((f) => f.event === "tool_call_end");
    expect(startFrames).toHaveLength(5);
    expect(endFrames).toHaveLength(5);

    // All sequence IDs should be monotonically increasing
    const ids = frames.map((f) => f.id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1] ?? 0);
    }

    // Each start should come before its corresponding end
    for (let i = 0; i < 5; i++) {
      const startId = startFrames[i]?.id ?? 0;
      const endId = endFrames[i]?.id ?? 0;
      expect(startId).toBeLessThan(endId);
    }
  });

  it("abort during rapid tool execution — clean stop with transport frames", async () => {
    const eventBus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus, replayLimit: 256 });
    const frames: TransportFrame[] = [];

    adapter.onFrame((frame) => { frames.push(frame); });
    adapter.start();

    const controller = new AbortController();
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "tool.abort",
        description: "Abort tool",
        parameters: { type: "object", properties: { v: { type: "string" } } },
      },
      async execute(args): Promise<ToolResult> {
        return { callId: "ignored", name: "tool.abort", result: args.v };
      },
    });

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
      eventBus,
    });
    const loop = new AgentLoop({
      maxSteps: 20,
      toolPipeline: pipeline,
      signal: controller.signal,
    });

    let callCount = 0;
    await loop.run(
      [{ role: "user", content: "Run tools then abort" }],
      async () => {
        callCount += 1;
        if (callCount === 4) {
          controller.abort("stop");
        }
        return {
          type: "tool_calls" as const,
          toolCalls: [{ id: `tc-${callCount}`, name: "tool.abort", arguments: { v: `v-${callCount}` } }],
        };
      },
      integrationToolContext,
    );

    adapter.stop();

    // Should have some start/end pairs but not all 20
    const startFrames = frames.filter((f) => f.event === "tool_call_start");
    const endFrames = frames.filter((f) => f.event === "tool_call_end");

    expect(startFrames.length).toBeGreaterThan(0);
    expect(startFrames.length).toBeLessThanOrEqual(4);
    expect(endFrames.length).toBeLessThanOrEqual(startFrames.length);

    // All frame IDs should still be monotonically increasing
    const ids = frames.map((f) => f.id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1] ?? 0);
    }
  });
});
