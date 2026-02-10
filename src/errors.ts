export class ReinsError extends Error {
  constructor(message: string, public code: string, public cause?: Error) {
    super(message);
    this.name = "ReinsError";
  }
}

export class ProviderError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "PROVIDER_ERROR", cause);
    this.name = "ProviderError";
  }
}

export class AuthError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "AUTH_ERROR", cause);
    this.name = "AuthError";
  }
}

export class ToolError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "TOOL_ERROR", cause);
    this.name = "ToolError";
  }
}

export class PluginError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "PLUGIN_ERROR", cause);
    this.name = "PluginError";
  }
}

export class ConversationError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "CONVERSATION_ERROR", cause);
    this.name = "ConversationError";
  }
}
