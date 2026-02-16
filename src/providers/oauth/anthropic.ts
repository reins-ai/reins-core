import { ProviderError } from "../../errors";
import { AuthError } from "../../errors";
import { err, ok, type Result } from "../../result";
import { StreamTransformer } from "../../streaming";
import { generateId } from "../../conversation/id";
import type { ContentBlock } from "../../types/conversation";
import type { StreamEvent } from "../../types/streaming";
import type {
  ChatRequest,
  ChatResponse,
  Model,
  Provider,
  ProviderConfig,
  TokenUsage,
} from "../../types/provider";
import type { ToolCall, ToolDefinition } from "../../types/tool";
import { OAuthFlowHandler } from "./flow";
import { OAuthProvider } from "./provider";
import type {
  AuthorizationResult,
  OAuthConfig,
  OAuthExchangeContext,
  OAuthCallbackContext,
  OAuthProviderDefinition,
  OAuthStrategy,
  OAuthTokens,
  OAuthInitiateContext,
  OAuthRefreshContext,
  OAuthStoreContext,
  AuthStrategyContext,
  ProviderMetadata,
} from "./types";
import { persistOAuthTokens, type OAuthTokenStore } from "./token-store";
import {
  claudeCodeHeaders,
  transformUrl,
  transformSystemPrompt,
  prefixToolDefinitions,
  prefixMessageToolNames,
  stripToolPrefixFromPayload,
  createStrippingStream,
} from "./claude-code-transform";

interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicOAuthProviderOptions {
  oauthConfig: OAuthConfig;
  tokenStore: OAuthTokenStore;
  baseUrl?: string;
  providerConfig?: Partial<ProviderConfig>;
  flow?: OAuthFlowHandler;
}

interface PendingOAuthSession {
  state: string;
  codeVerifier: string;
  redirectUri?: string;
  createdAt: number;
}

const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;

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

// claudeCodeHeaders() from claude-code-transform.ts replaces the old oauthHeaders().
// It includes the full set of beta flags required for Claude Code credential acceptance.

function resolveAnthropicApiModelId(model: string): string {
  return model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model;
}

/**
 * Maps internal ToolDefinition[] to Anthropic API tool format.
 * See: https://docs.anthropic.com/en/docs/build-with-claude/tool-use
 */
function mapTools(
  tools: ToolDefinition[] | undefined,
): { name: string; description: string; input_schema: ToolDefinition["parameters"] }[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function mapContentBlocks(blocks: ContentBlock[]): AnthropicContentBlock[] {
  return blocks.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text" as const, text: block.text };
      case "tool_use":
        return {
          type: "tool_use" as const,
          id: block.id,
          name: block.name,
          input: block.input,
        };
      case "tool_result":
        return {
          type: "tool_result" as const,
          tool_use_id: block.tool_use_id,
          content: block.content,
          ...(block.is_error ? { is_error: true } : {}),
        };
    }
  });
}

function mapMessages(request: ChatRequest): AnthropicMessage[] {
  return request.messages
    .filter(
      (message): message is ChatRequest["messages"][number] & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      role: message.role,
      content: typeof message.content === "string"
        ? message.content
        : mapContentBlocks(message.content),
    }));
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";

const DEFAULT_MODELS: Model[] = [
  {
    id: "anthropic/claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic-oauth",
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    capabilities: ["chat", "streaming", "tool_use", "vision"],
  },
  {
    id: "anthropic/claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    provider: "anthropic-oauth",
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    capabilities: ["chat", "streaming", "tool_use", "vision"],
  },
  {
    id: "anthropic/claude-opus-4-5",
    name: "Claude Opus 4.5",
    provider: "anthropic-oauth",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    capabilities: ["chat", "streaming", "tool_use", "vision"],
  },
  {
    id: "anthropic/claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "anthropic-oauth",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    capabilities: ["chat", "streaming", "tool_use", "vision"],
  },
];

export class AnthropicOAuthProvider extends OAuthProvider implements Provider, OAuthProviderDefinition {
  protected readonly providerType = "anthropic" as const;

  public readonly id = "anthropic";

  public readonly authModes = ["oauth", "token"] as const;

  public readonly metadata: ProviderMetadata;

  public readonly strategy: OAuthStrategy;

  public readonly config: ProviderConfig;

  private readonly baseUrl: string;

  private pendingSession: PendingOAuthSession | null = null;

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

    this.strategy = {
      mode: "oauth",
      initiate: (context) => this.initiate(context),
      handleCallback: (context) => this.handleCallback(context),
      refresh: (context) => this.refreshWithResult(context),
      storeTokens: (context) => this.storeTokensWithResult(context),
      retrieveTokens: (context) => this.retrieveTokensWithResult(context),
      revoke: (context) => this.revokeWithResult(context),
    };
  }

  public async initiate(context: OAuthInitiateContext): Promise<Result<AuthorizationResult, AuthError>> {
    if (context.provider !== this.providerType) {
      return err(new AuthError(`OAuth strategy for ${this.providerType} cannot initiate flow for ${context.provider}`));
    }

    const pkce = this.flow.generatePkcePair();
    const codeVerifier = context.register?.codeVerifier ?? pkce.verifier;
    // OpenCode pattern: use the PKCE verifier as the OAuth state parameter
    const state = context.register?.state ?? codeVerifier;
    const redirectUri = context.register?.redirectUri ?? this.oauthConfig.redirectUri;
    const authorizationUrl = this.flow.getAuthorizationUrl(state, {
      codeChallenge: OAuthFlowHandler.computePkceChallenge(codeVerifier),
      codeChallengeMethod: pkce.method,
    });

    this.pendingSession = {
      state,
      codeVerifier,
      redirectUri,
      createdAt: Date.now(),
    };

    return ok({
      type: "authorization_code",
      authorizationUrl,
      state,
      codeVerifier: this.pendingSession.codeVerifier,
    });
  }

  public async handleCallback(context: OAuthCallbackContext): Promise<Result<OAuthTokens, AuthError>> {
    if (context.provider !== this.providerType) {
      return err(new AuthError(`OAuth strategy for ${this.providerType} cannot handle callback for ${context.provider}`));
    }

    const code = context.code.trim();
    if (code.length === 0) {
      return err(new AuthError("OAuth callback code is required for provider anthropic"));
    }

    const pendingSession = this.pendingSession;
    if (!pendingSession) {
      try {
        const tokens = await this.flow.exchangeCode(code, {
          codeVerifier: context.exchange?.codeVerifier,
          redirectUri: context.exchange?.redirectUri,
          state: context.state,
        });
        await persistOAuthTokens(this.tokenStore, this.providerType, tokens);
        return ok(tokens);
      } catch (error) {
        return err(
          new AuthError(
            "No active Anthropic OAuth session. Start sign-in again from the connect flow.",
            error instanceof Error ? error : undefined,
          ),
        );
      }
    }

    if (Date.now() - pendingSession.createdAt > OAUTH_SESSION_TTL_MS) {
      this.pendingSession = null;
      return err(new AuthError("Anthropic OAuth session expired. Start sign-in again."));
    }

    // In the code-paste flow (Anthropic callback page), the user pastes "code#state".
    // The state embedded in the pasted string is handled by exchangeCode() which splits
    // on "#". The codeVerifier (= the original PKCE verifier = the state param we sent)
    // is used for the token exchange, matching the OpenCode reference pattern.
    try {
      const tokens = await this.flow.exchangeCode(code, {
        codeVerifier: context.exchange?.codeVerifier ?? pendingSession.codeVerifier,
        redirectUri: context.exchange?.redirectUri ?? pendingSession.redirectUri,
        state: context.state ?? pendingSession.state,
      });
      await persistOAuthTokens(this.tokenStore, this.providerType, tokens);
      this.pendingSession = null;
      return ok(tokens);
    } catch (error) {
      return err(
        new AuthError(
          "Anthropic OAuth token exchange failed. Complete browser login again and retry.",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  public async refreshWithResult(context: OAuthRefreshContext): Promise<Result<OAuthTokens, AuthError>> {
    if (context.provider !== this.providerType) {
      return err(new AuthError(`OAuth strategy for ${this.providerType} cannot refresh tokens for ${context.provider}`));
    }

    const refreshToken = context.refreshToken.trim();
    if (refreshToken.length === 0) {
      return err(new AuthError("Refresh token is required for provider anthropic"));
    }

    try {
      const tokens = await this.flow.refreshTokens(refreshToken);
      await persistOAuthTokens(this.tokenStore, this.providerType, tokens);
      return ok(tokens);
    } catch (error) {
      return err(
        new AuthError(
          "Anthropic OAuth refresh failed. Re-authenticate from the connect flow to continue.",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  public async storeTokensWithResult(context: OAuthStoreContext): Promise<Result<void, AuthError>> {
    if (context.provider !== this.providerType) {
      return err(new AuthError(`OAuth strategy for ${this.providerType} cannot store tokens for ${context.provider}`));
    }

    try {
      await persistOAuthTokens(this.tokenStore, this.providerType, context.tokens);
      return ok(undefined);
    } catch (error) {
      return err(
        new AuthError(
          "Unable to persist Anthropic OAuth tokens securely.",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  public async retrieveTokensWithResult(context: AuthStrategyContext): Promise<Result<OAuthTokens | null, AuthError>> {
    if (context.provider !== this.providerType) {
      return err(new AuthError(`OAuth strategy for ${this.providerType} cannot load tokens for ${context.provider}`));
    }

    try {
      const tokens = await this.tokenStore.load(this.providerType);
      return ok(tokens);
    } catch (error) {
      return err(
        new AuthError(
          "Unable to load Anthropic OAuth tokens from credential storage.",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  public async revokeWithResult(context: AuthStrategyContext): Promise<Result<void, AuthError>> {
    if (context.provider !== this.providerType) {
      return err(new AuthError(`OAuth strategy for ${this.providerType} cannot revoke tokens for ${context.provider}`));
    }

    try {
      await this.tokenStore.delete(this.providerType);
      this.pendingSession = null;
      return ok(undefined);
    } catch (error) {
      return err(
        new AuthError(
          "Unable to revoke Anthropic OAuth tokens.",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  public async register(_config: OAuthConfig): Promise<AuthorizationResult> {
    const initiateResult = await this.initiate({ provider: this.providerType });
    if (!initiateResult.ok) {
      throw initiateResult.error;
    }

    return initiateResult.value;
  }

  public async authorize(config: OAuthConfig): Promise<AuthorizationResult> {
    return this.register(config);
  }

  public async exchange(code: string, _config: OAuthConfig, context?: OAuthExchangeContext): Promise<OAuthTokens> {
    const callbackResult = await this.handleCallback({
      provider: this.providerType,
      code,
      state: context?.state,
      exchange: context,
    });
    if (!callbackResult.ok) {
      throw callbackResult.error;
    }

    return callbackResult.value;
  }

  public async refresh(
    refreshToken: string,
    _config: OAuthConfig,
    _context?: OAuthExchangeContext,
  ): Promise<OAuthTokens> {
    const refreshResult = await this.refreshWithResult({
      provider: this.providerType,
      refreshToken,
      exchange: _context,
    });
    if (!refreshResult.ok) {
      throw refreshResult.error;
    }

    return refreshResult.value;
  }

  public async revoke(_token: string, _config: OAuthConfig): Promise<void> {
    const revokeResult = await this.revokeWithResult({ provider: this.providerType });
    if (!revokeResult.ok) {
      throw revokeResult.error;
    }
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const token = await this.getAccessToken();
    const apiModel = resolveAnthropicApiModelId(request.model);

    // Apply Claude Code transforms: system prompt prefix, tool name prefix, beta URL
    const mappedTools = mapTools(request.tools);
    const url = transformUrl(`${this.baseUrl}/v1/messages`);

    const response = await fetch(url, {
      method: "POST",
      headers: claudeCodeHeaders(token),
      body: JSON.stringify({
        model: apiModel,
        system: transformSystemPrompt(request.systemPrompt),
        messages: prefixMessageToolNames(mapMessages(request)),
        max_tokens: request.maxTokens ?? 16_384,
        temperature: request.temperature,
        ...(prefixToolDefinitions(mappedTools)
          ? { tools: prefixToolDefinitions(mappedTools) }
          : {}),
      }),
    });

    if (!response.ok) {
      throw new ProviderError(
        `Anthropic chat request failed (${response.status}): ${await response.text()}`,
      );
    }

    const rawPayload = (await response.json()) as unknown;
    if (!isRecord(rawPayload)) {
      throw new ProviderError("Anthropic chat response payload is invalid");
    }

    // Strip mcp_ prefix from tool names in response
    const payload = stripToolPrefixFromPayload(rawPayload);

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
    const apiModel = resolveAnthropicApiModelId(request.model);

    // Apply Claude Code transforms: system prompt prefix, tool name prefix, beta URL
    const mappedTools = mapTools(request.tools);
    const url = transformUrl(`${this.baseUrl}/v1/messages`);

    const response = await fetch(url, {
      method: "POST",
      headers: claudeCodeHeaders(token),
      body: JSON.stringify({
        model: apiModel,
        system: transformSystemPrompt(request.systemPrompt),
        messages: prefixMessageToolNames(mapMessages(request)),
        max_tokens: request.maxTokens ?? 16_384,
        temperature: request.temperature,
        stream: true,
        ...(prefixToolDefinitions(mappedTools)
          ? { tools: prefixToolDefinitions(mappedTools) }
          : {}),
      }),
    });

    if (!response.ok || !response.body) {
      throw new ProviderError(
        `Anthropic stream request failed (${response.status}): ${await response.text()}`,
      );
    }

    // Wrap the SSE stream to strip mcp_ prefix from tool names
    const strippedStream = createStrippingStream(response.body);
    for await (const event of StreamTransformer.fromSSE(strippedStream)) {
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
        headers: claudeCodeHeaders(token, false),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
