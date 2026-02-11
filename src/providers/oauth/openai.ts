import { ProviderError } from "../../errors";
import { generateId } from "../../conversation/id";
import { StreamTransformer } from "../../streaming";
import type { StreamEvent } from "../../types/streaming";
import type {
  ChatRequest,
  ChatResponse,
  Model,
  Provider,
  ProviderConfig,
  TokenUsage,
} from "../../types/provider";
import type { ToolCall } from "../../types/tool";
import { OAuthFlowHandler } from "./flow";
import { OAuthProvider } from "./provider";
import type {
  AuthorizationResult,
  OAuthConfig,
  OAuthExchangeContext,
  OAuthProviderDefinition,
  OAuthTokens,
  ProviderMetadata,
} from "./types";
import type { OAuthTokenStore } from "./token-store";

interface OpenAIOAuthProviderOptions {
  oauthConfig: OAuthConfig;
  tokenStore: OAuthTokenStore;
  baseUrl?: string;
  providerConfig?: Partial<ProviderConfig>;
  flow?: OAuthFlowHandler;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function mapFinishReason(value: unknown): ChatResponse["finishReason"] {
  if (value === "tool_calls") {
    return "tool_use";
  }

  if (value === "length") {
    return "length";
  }

  if (value === "stop") {
    return "stop";
  }

  return "stop";
}

function parseUsage(value: unknown): TokenUsage {
  if (!isRecord(value)) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  const inputTokens = typeof value.prompt_tokens === "number" ? value.prompt_tokens : 0;
  const outputTokens = typeof value.completion_tokens === "number" ? value.completion_tokens : 0;
  const totalTokens = typeof value.total_tokens === "number" ? value.total_tokens : inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function parseToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const calls: ToolCall[] = [];

  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.function)) {
      continue;
    }

    const id = asString(item.id) ?? generateId("tool");
    const name = asString(item.function.name) ?? "unknown_tool";
    const args = asString(item.function.arguments);

    let parsedArguments: Record<string, unknown> = {};
    if (args) {
      try {
        const parsed = JSON.parse(args) as unknown;
        if (isRecord(parsed)) {
          parsedArguments = parsed;
        }
      } catch {
        parsedArguments = {};
      }
    }

    calls.push({
      id,
      name,
      arguments: parsedArguments,
    });
  }

  return calls;
}

const DEFAULT_BASE_URL = "https://api.openai.com";

export class OpenAIOAuthProvider extends OAuthProvider implements Provider, OAuthProviderDefinition {
  protected readonly providerType = "openai" as const;

  public readonly id = "openai";

  public readonly authModes = ["oauth", "api_key"] as const;

  public readonly metadata: ProviderMetadata;

  public readonly config: ProviderConfig;

  private readonly baseUrl: string;

  constructor(options: OpenAIOAuthProviderOptions) {
    super(options.oauthConfig, options.tokenStore, options.flow ?? new OAuthFlowHandler(options.oauthConfig));

    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.metadata = {
      name: "OpenAI",
      description: "OpenAI provider supporting OAuth and API key credentials",
      authModes: [...this.authModes],
      oauth: {
        authUrl: options.oauthConfig.authorizationUrl,
        tokenUrl: options.oauthConfig.tokenUrl,
        scopes: [...options.oauthConfig.scopes],
        pkce: true,
      },
      endpoints: [this.baseUrl],
      icon: "openai",
    };
    this.config = {
      id: options.providerConfig?.id ?? "openai-oauth",
      name: options.providerConfig?.name ?? "OpenAI OAuth",
      type: "oauth",
      baseUrl: this.baseUrl,
    };
  }

  public async register(_config: OAuthConfig): Promise<AuthorizationResult> {
    const state = crypto.randomUUID().replace(/-/g, "");
    return {
      type: "authorization_code",
      authorizationUrl: this.flow.getAuthorizationUrl(state),
      state,
    };
  }

  public async authorize(config: OAuthConfig): Promise<AuthorizationResult> {
    return this.register(config);
  }

  public async exchange(code: string, _config: OAuthConfig, context?: OAuthExchangeContext): Promise<OAuthTokens> {
    const tokens = await this.flow.exchangeCode(code, { redirectUri: context?.redirectUri });
    await this.tokenStore.save(this.providerType, tokens);
    return tokens;
  }

  public async refresh(
    refreshToken: string,
    _config: OAuthConfig,
    _context?: OAuthExchangeContext,
  ): Promise<OAuthTokens> {
    const tokens = await this.flow.refreshTokens(refreshToken);
    await this.tokenStore.save(this.providerType, tokens);
    return tokens;
  }

  public async revoke(_token: string, _config: OAuthConfig): Promise<void> {
    await this.disconnect();
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const token = await this.getAccessToken();
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        tools: request.tools,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
      }),
    });

    if (!response.ok) {
      throw new ProviderError(`OpenAI chat request failed (${response.status}): ${await response.text()}`);
    }

    const payload = (await response.json()) as unknown;
    if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
      throw new ProviderError("OpenAI chat response payload is invalid");
    }

    const choice = payload.choices[0];
    if (!isRecord(choice)) {
      throw new ProviderError("OpenAI chat response choice is invalid");
    }

    const message = isRecord(choice.message) ? choice.message : {};
    const content = asString(message.content) ?? "";
    const toolCalls = parseToolCalls(message.tool_calls);

    return {
      id: asString(payload.id) ?? generateId("openai"),
      model: asString(payload.model) ?? request.model,
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: parseUsage(payload.usage),
      finishReason: mapFinishReason(choice.finish_reason),
    };
  }

  public async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const token = await this.getAccessToken();
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        stream: true,
        tools: request.tools,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
      }),
    });

    if (!response.ok || !response.body) {
      throw new ProviderError(`OpenAI stream request failed (${response.status}): ${await response.text()}`);
    }

    for await (const event of StreamTransformer.fromSSE(response.body)) {
      yield event;
    }
  }

  public async listModels(): Promise<Model[]> {
    const token = await this.getAccessToken();
    const response = await fetch(`${this.baseUrl}/v1/models`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new ProviderError(`OpenAI models request failed (${response.status}): ${await response.text()}`);
    }

    const payload = (await response.json()) as unknown;
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new ProviderError("OpenAI models response payload is invalid");
    }

    const models: Model[] = [];
    for (const item of payload.data) {
      if (!isRecord(item)) {
        continue;
      }

      const id = asString(item.id);
      if (!id) {
        continue;
      }

      models.push({
        id,
        name: id,
        provider: this.config.id,
        contextWindow: 128_000,
        capabilities: ["chat", "streaming", "tool_use"],
      });
    }

    return models;
  }

  public async validateConnection(): Promise<boolean> {
    try {
      const models = await this.listModels();
      return models.length > 0;
    } catch {
      return false;
    }
  }
}
