import { describe, expect, it } from "bun:test";

import { AgentLoop } from "../../src/harness";
import { RagContextInjector } from "../../src/memory/services";
import { ToolExecutor, ToolRegistry } from "../../src/tools";
import type { ChatRequest, Message, Model, Provider, StreamEvent, ToolContext } from "../../src/types";

const toolContext: ToolContext = {
  conversationId: "conv-agent-loop-rag",
  userId: "user-agent-loop-rag",
  workspaceId: "ws-agent-loop-rag",
};

function createModel(id: string): Model {
  return {
    id,
    name: id,
    provider: "anthropic",
    contextWindow: 4096,
    capabilities: ["chat", "streaming", "tool_use"],
  };
}

function createPromptCapturingProvider(options: {
  onStreamStart?: (request: ChatRequest) => void;
} = {}): Provider {
  return {
    config: {
      id: "anthropic",
      name: "Anthropic",
      type: "oauth",
    },
    async chat() {
      throw new Error("chat not used in this test");
    },
    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      options.onStreamStart?.(request);
      yield { type: "token", content: "ok" };
      yield { type: "done", finishReason: "stop" };
    },
    async listModels(): Promise<Model[]> {
      return [createModel("anthropic-test-model")];
    },
    async validateConnection(): Promise<boolean> {
      return true;
    },
  };
}

async function runSingleTurn(loop: AgentLoop, provider: Provider, systemPrompt = "Base system prompt"): Promise<void> {
  for await (const _event of loop.runWithProvider({
    provider,
    model: "anthropic-test-model",
    messages: [{
      id: "msg-user-1",
      role: "user",
      content: "What does the contract say?",
      createdAt: new Date(),
    } satisfies Message],
    toolExecutor: new ToolExecutor(new ToolRegistry()),
    toolContext,
    systemPrompt,
  })) {
    // Exhaust stream.
  }
}

describe("AgentLoop RAG context injection", () => {
  it("calls RagContextInjector before provider LLM call", async () => {
    const callOrder: string[] = [];
    const injector = new RagContextInjector({ retrieval: null });
    injector.getRelevantContext = async () => {
      callOrder.push("injector");
      return "Relevant contract clause";
    };

    const provider = createPromptCapturingProvider({
      onStreamStart: () => {
        callOrder.push("provider");
      },
    });

    const loop = new AgentLoop({ ragContextInjector: injector });
    await runSingleTurn(loop, provider);

    expect(callOrder).toEqual(["injector", "provider"]);
  });

  it("appends returned context to system prompt", async () => {
    let capturedSystemPrompt = "";
    const injector = new RagContextInjector({ retrieval: null });
    injector.getRelevantContext = async () => "Relevant contract clause";

    const provider = createPromptCapturingProvider({
      onStreamStart: (request) => {
        capturedSystemPrompt = request.systemPrompt ?? "";
      },
    });

    const loop = new AgentLoop({ ragContextInjector: injector });
    await runSingleTurn(loop, provider);

    expect(capturedSystemPrompt).toContain("Base system prompt");
    expect(capturedSystemPrompt).toContain("---\n**Relevant context from your documents:**\nRelevant contract clause\n---");
  });

  it("is a no-op when injector is not configured", async () => {
    let capturedSystemPrompt = "";
    const provider = createPromptCapturingProvider({
      onStreamStart: (request) => {
        capturedSystemPrompt = request.systemPrompt ?? "";
      },
    });

    const loop = new AgentLoop();
    await runSingleTurn(loop, provider);

    expect(capturedSystemPrompt).toBe("Base system prompt");
  });

  it("is a no-op when injector returns null", async () => {
    let capturedSystemPrompt = "";
    const injector = new RagContextInjector({ retrieval: null });
    injector.getRelevantContext = async () => null;

    const provider = createPromptCapturingProvider({
      onStreamStart: (request) => {
        capturedSystemPrompt = request.systemPrompt ?? "";
      },
    });

    const loop = new AgentLoop({ ragContextInjector: injector });
    await runSingleTurn(loop, provider);

    expect(capturedSystemPrompt).toBe("Base system prompt");
  });
});
