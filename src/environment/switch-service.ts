import type { ReinsError } from "../errors";
import { ConfigStore } from "../config/store";
import { isValidEnvironmentName } from "../config/schema";
import { err, ok, type Result } from "../result";
import {
  EnvironmentNotFoundError,
  EnvironmentSwitchFailedError,
  InvalidEnvironmentNameError,
  type EnvironmentError,
} from "./errors";
import type { EnvironmentResolver } from "./resolver";
import type { OverlayResolution } from "./types";

export interface EnvironmentSwitchResult {
  previousEnvironment: string;
  activeEnvironment: string;
  resolvedDocuments: OverlayResolution;
  switchedAt: Date;
}

export interface EnvironmentSwitchEvent {
  previousEnvironment: string;
  activeEnvironment: string;
  resolvedDocuments: OverlayResolution;
  switchedAt: Date;
}

export type EnvironmentSwitchListener = (event: EnvironmentSwitchEvent) => void;

export class EnvironmentSwitchService {
  private readonly listeners = new Set<EnvironmentSwitchListener>();

  constructor(
    private readonly configStore: ConfigStore,
    private readonly resolver: EnvironmentResolver,
    private readonly onSwitch?: EnvironmentSwitchListener,
  ) {}

  onEnvironmentSwitch(listener: EnvironmentSwitchListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  async switchEnvironment(
    name: string,
  ): Promise<Result<EnvironmentSwitchResult, EnvironmentError>> {
    if (!isValidEnvironmentName(name)) {
      return err(new InvalidEnvironmentNameError(name));
    }

    const currentEnvironmentResult = await this.getCurrentEnvironment();
    if (!currentEnvironmentResult.ok) {
      return err(toEnvironmentSwitchError("Unable to read current active environment", currentEnvironmentResult.error));
    }

    const environmentsResult = await this.resolver.listEnvironments();
    if (!environmentsResult.ok) {
      return err(environmentsResult.error);
    }

    const targetEnvironment = environmentsResult.value.find((environment) => environment.name === name);
    if (!targetEnvironment) {
      return err(new EnvironmentNotFoundError(name));
    }

    const setActiveResult = await this.configStore.setActiveEnvironment(name);
    if (!setActiveResult.ok) {
      return err(toEnvironmentSwitchError(`Unable to switch active environment to ${name}`, setActiveResult.error));
    }

    const resolvedDocumentsResult = await this.resolver.resolveAll(name);
    if (!resolvedDocumentsResult.ok) {
      return err(resolvedDocumentsResult.error);
    }

    const switchedAt = new Date();
    const result: EnvironmentSwitchResult = {
      previousEnvironment: currentEnvironmentResult.value,
      activeEnvironment: name,
      resolvedDocuments: resolvedDocumentsResult.value,
      switchedAt,
    };

    this.emitSwitch(result);

    return ok(result);
  }

  async getCurrentEnvironment(): Promise<Result<string, ReinsError>> {
    return this.configStore.getActiveEnvironment();
  }

  async getResolvedDocuments(
    envName?: string,
  ): Promise<Result<OverlayResolution, EnvironmentError>> {
    const targetEnvironmentNameResult = envName
      ? ok(envName)
      : await this.getCurrentEnvironment();

    if (!targetEnvironmentNameResult.ok) {
      return err(toEnvironmentSwitchError("Unable to determine active environment", targetEnvironmentNameResult.error));
    }

    if (!isValidEnvironmentName(targetEnvironmentNameResult.value)) {
      return err(new InvalidEnvironmentNameError(targetEnvironmentNameResult.value));
    }

    return this.resolver.resolveAll(targetEnvironmentNameResult.value);
  }

  private emitSwitch(result: EnvironmentSwitchResult): void {
    const event: EnvironmentSwitchEvent = {
      previousEnvironment: result.previousEnvironment,
      activeEnvironment: result.activeEnvironment,
      resolvedDocuments: result.resolvedDocuments,
      switchedAt: result.switchedAt,
    };

    if (this.onSwitch) {
      this.onSwitch(event);
    }

    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function toEnvironmentSwitchError(message: string, cause: ReinsError): EnvironmentSwitchFailedError {
  return new EnvironmentSwitchFailedError(message, cause);
}
