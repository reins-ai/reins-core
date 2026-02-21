import { AuthError, ProviderError } from "../errors";
import { createLogger } from "../logger";
import { err, ok, type Result } from "../result";

const log = createLogger("providers:router");
import type { Model, ModelCapability, Provider } from "../types";
import type { AuthService, ConversationAuthCheck, ProviderAuthGuidance } from "./auth-service";
import { ProviderRegistry } from "./registry";

export interface RouteRequest {
  model?: string;
  provider?: string;
  capabilities?: ModelCapability[];
}

export interface RouteResult {
  provider: Provider;
  model: Model;
}

export interface AuthenticatedRouteResult extends RouteResult {
  authCheck: ConversationAuthCheck;
}

export interface RouteAuthError {
  provider: string;
  guidance: ProviderAuthGuidance;
}

export class ModelRouter {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly authService?: AuthService,
  ) {}

  async listAllModels(): Promise<Model[]> {
    const providers = this.registry.list();
    const allModels: Model[] = [];
    for (const provider of providers) {
      try {
        const models = await provider.listModels();
        allModels.push(...models);
      } catch (e) {
        // Expected: some providers may be temporarily unavailable
        log.debug("skipping provider that failed to list models", { provider: provider.config.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return allModels;
  }

  async route(request: RouteRequest): Promise<RouteResult> {
    const providers = this.getProvidersForRequest(request);
    const requiredCapabilities = request.capabilities ?? [];

    for (const provider of providers) {
      const models = await provider.listModels();
      const selectedModel = this.selectModel(models, request.model, requiredCapabilities);

      if (selectedModel) {
        return { provider, model: selectedModel };
      }
    }

    throw new ProviderError(this.buildNoMatchMessage(request));
  }

  async routeWithAuthCheck(request: RouteRequest): Promise<Result<AuthenticatedRouteResult, AuthError>> {
    const routeResult = await this.route(request);

    if (!this.authService) {
      return ok({
        ...routeResult,
        authCheck: {
          allowed: true,
          provider: routeResult.provider.config.id,
          connectionState: "ready",
        },
      });
    }

    const authCheckResult = await this.authService.checkConversationReady(routeResult.provider.config.id);
    if (!authCheckResult.ok) {
      return authCheckResult;
    }

    const authCheck = authCheckResult.value;
    if (!authCheck.allowed) {
      return err(
        new AuthError(
          authCheck.guidance?.message ?? `Provider ${routeResult.provider.config.id} is not ready for conversations.`,
        ),
      );
    }

    return ok({
      ...routeResult,
      authCheck,
    });
  }

  private getProvidersForRequest(request: RouteRequest): Provider[] {
    if (request.provider) {
      return [this.registry.getOrThrow(request.provider)];
    }

    const providers = this.registry.list();

    if (providers.length === 0) {
      throw new ProviderError("No providers are registered");
    }

    return providers;
  }

  private selectModel(
    models: Model[],
    requestedModel: string | undefined,
    requiredCapabilities: ModelCapability[],
  ): Model | undefined {
    const filteredByModel = requestedModel
      ? models.filter((model) => model.id === requestedModel)
      : models;

    return filteredByModel.find((model) =>
      requiredCapabilities.every((capability) => model.capabilities.includes(capability)),
    );
  }

  private buildNoMatchMessage(request: RouteRequest): string {
    const details: string[] = [];

    if (request.provider) {
      details.push(`provider=${request.provider}`);
    }

    if (request.model) {
      details.push(`model=${request.model}`);
    }

    if (request.capabilities && request.capabilities.length > 0) {
      details.push(`capabilities=${request.capabilities.join(",")}`);
    }

    if (details.length === 0) {
      return "No route found: no providers with available models";
    }

    return `No route found for ${details.join(" ")}`;
  }
}
