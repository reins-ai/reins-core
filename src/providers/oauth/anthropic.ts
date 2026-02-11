import { ProviderError } from "../../errors";
import { StreamTransformer } from "../../streaming";
import { generateId } from "../../conversation/id";
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

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicOAuthProviderOptions {
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

function parseUsage(value: unknown): TokenUsage {
  if (!isRecord(value)) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  const inputTokens = typeof value.input_tokens === "number" ? value.input_tokens : 0;
  const outputTokens = typeof value.output_tokens === "number" ? value.output_tokens : 0;

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function parseToolCalls(content: unknown): ToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const calls: ToolCall[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }

    if (block.type !== "tool_use") {
      continue;
    }

    const id = asString(block.id) ?? generateId("tool");
    const name = asString(block.name) ?? "unknown_tool";
    const input = isRecord(block.input) ? block.input : {};

    calls.push({
      id,
      name,
      arguments: input,
    });
  }

  return calls;
}

function parseTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }

    if (block.type !== "text") {
      continue;
    }

    const text = asString(block.text);
    if (text) {
      textParts.push(text);
    }
  }

  return textParts.join("\n");
}

function mapFinishReason(value: unknown): ChatResponse["finishReason"] {
  if (value === "tool_use") {
    return "tool_use";
  }

  if (value === "max_tokens") {
    return "length";
  }

  return "stop";
}

function mapMessages(request: ChatRequest): AnthropicMessage[] {
  return request.messages
    .filter(
      (message): message is ChatRequest["messages"][number] & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";

const DEFAULT_MODELS: Model[] = [
  {
    id: "claude-3-5-sonnet-latest",
    name: "Claude 3.5 Sonnet",
    provider: "anthropic-oauth",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: ["chat", "streaming", "tool_use", "vision"],
  },
  {
    id: "claude-3-5-haiku-latest",
    name: "Claude 3.5 Haiku",
    provider: "anthropic-oauth",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: ["chat", "streaming", "tool_use", "vision"],
  },
];

export class AnthropicOAuthProvider extends OAuthProvider implements Provider, OAuthProviderDefinition {
  protected readonly providerType = "anthropic" as const;

  public readonly id = "anthropic";

  public readonly authModes = ["oauth", "token"] as const;

  public readonly metadata: ProviderMetadata;

  public readonly config: ProviderConfig;

  private readonly baseUrl: string;

  constructor(options: AnthropicOAuthProviderOptions) {
    super(options.oauthConfig, options.tokenStore, options.flow ?? new OAuthFlowHandler(options.oauthConfig));

    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.metadata = {
      name: "Anthropic",
      description: "Anthropic provider supporting OAuth and setup-token credentials",
      authModes: [...this.authModes],
      oauth: {
        authUrl: options.oauthConfig.authorizationUrl,
        tokenUrl: options.oauthConfig.tokenUrl,
        scopes: [...options.oauthConfig.scopes],
        pkce: true,
      },
      endpoints: [this.baseUrl],
      icon: "anthropic",
    };
    this.config = {
      id: options.providerConfig?.id ?? "anthropic-oauth",
      name: options.providerConfig?.name ?? "Anthropic OAuth",
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
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model,
        system: request.systemPrompt,
        messages: mapMessages(request),
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature,
      }),
    });

    if (!response.ok) {
      throw new ProviderError(
        `Anthropic chat request failed (${response.status}): ${await response.text()}`,
      );
    }

    const payload = (await response.json()) as unknown;
    if (!isRecord(payload)) {
      throw new ProviderError("Anthropic chat response payload is invalid");
    }

    const finishReason = mapFinishReason(payload.stop_reason);
    const usage = parseUsage(payload.usage);
    const content = parseTextContent(payload.content);
    const toolCalls = parseToolCalls(payload.content);

    return {
      id: asString(payload.id) ?? generateId("anthropic"),
      model: asString(payload.model) ?? request.model,
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      finishReason,
    };
  }

  public async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const token = await this.getAccessToken();
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model,
        system: request.systemPrompt,
        messages: mapMessages(request),
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature,
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      throw new ProviderError(
        `Anthropic stream request failed (${response.status}): ${await response.text()}`,
      );
    }

    for await (const event of StreamTransformer.fromSSE(response.body)) {
      yield event;
    }
  }

  public async listModels(): Promise<Model[]> {
    return DEFAULT_MODELS.map((model) => ({ ...model, provider: this.config.id }));
  }

  public async validateConnection(): Promise<boolean> {
    try {
      const token = await this.getAccessToken();
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
