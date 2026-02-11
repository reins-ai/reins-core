import { err, ok } from "../result";
import type {
  DaemonLifecycleEvent,
  DaemonLifecycleLogger,
  DaemonManagedService,
  DaemonResult,
  DaemonRuntimeOptions,
  DaemonState,
} from "./types";
import { DaemonError } from "./types";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_RESTART_BACKOFF_MS = 250;

const VALID_TRANSITIONS: Record<DaemonState, ReadonlySet<DaemonState>> = {
  stopped: new Set(["starting"]),
  starting: new Set(["running", "failed", "stopping"]),
  running: new Set(["stopping", "failed"]),
  stopping: new Set(["stopped", "failed"]),
  failed: new Set(["stopped"]),
};

class JsonLifecycleLogger implements DaemonLifecycleLogger {
  log(event: DaemonLifecycleEvent): void {
    console.info(JSON.stringify({ scope: "daemon", ...event }));
  }
}

/**
 * Runtime coordinator for daemon lifecycle transitions and managed services.
 */
export class DaemonRuntime {
  private state: DaemonState = "stopped";
  private readonly services: DaemonManagedService[] = [];
  private readonly listeners = new Set<(event: DaemonLifecycleEvent) => void>();
  private readonly shutdownTimeoutMs: number;
  private readonly restartBackoffMs: number;
  private readonly logger: DaemonLifecycleLogger;
  private readonly now: () => Date;
  private signalsBound = false;
  private readonly signalHandler = (signal: NodeJS.Signals): void => {
    this.emit({ type: "signal-received", signal, state: this.state, message: `Received ${signal}` });
    void this.stop({ signal });
  };

  constructor(options: DaemonRuntimeOptions = {}) {
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    this.logger = options.logger ?? new JsonLifecycleLogger();
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Returns the current lifecycle state.
   */
  getState(): DaemonState {
    return this.state;
  }

  /**
   * Registers a service that will be started and stopped with the daemon runtime.
   */
  registerService(service: DaemonManagedService): DaemonResult<void> {
    if (this.state !== "stopped") {
      return err(new DaemonError("Services can only be registered while stopped", "DAEMON_INVALID_STATE"));
    }

    if (this.services.some((existing) => existing.id === service.id)) {
      return err(new DaemonError(`Service '${service.id}' is already registered`, "DAEMON_DUPLICATE_SERVICE"));
    }

    this.services.push(service);
    this.emit({ type: "service-registered", serviceId: service.id, state: this.state });
    return ok(undefined);
  }

  /**
   * Starts all registered services and transitions runtime to running.
   */
  async start(): Promise<DaemonResult<void>> {
    this.emit({ type: "start-requested", state: this.state });

    const transition = this.transitionTo("starting");
    if (!transition.ok) {
      return transition;
    }

    for (const service of this.services) {
      const result = await service.start();
      if (!result.ok) {
        this.emitError(result.error);
        await this.transitionFailure();
        return err(result.error);
      }
    }

    const runningTransition = this.transitionTo("running");
    if (!runningTransition.ok) {
      return runningTransition;
    }

    this.bindSignals();
    return ok(undefined);
  }

  /**
   * Stops all registered services with graceful shutdown timeout.
   */
  async stop(options: { signal?: NodeJS.Signals } = {}): Promise<DaemonResult<void>> {
    this.emit({ type: "stop-requested", signal: options.signal, state: this.state });

    const transition = this.transitionTo("stopping");
    if (!transition.ok) {
      return transition;
    }

    this.unbindSignals();

    const stopResult = await this.withTimeout(this.stopServices(options.signal), this.shutdownTimeoutMs);
    if (!stopResult.ok) {
      this.emitError(stopResult.error);
      const failTransition = this.transitionTo("failed");
      if (!failTransition.ok) {
        return failTransition;
      }
      const toStopped = this.transitionTo("stopped");
      if (!toStopped.ok) {
        return toStopped;
      }
      return err(stopResult.error);
    }

    return this.transitionTo("stopped");
  }

  /**
   * Restarts the daemon runtime by stopping and then starting services.
   */
  async restart(): Promise<DaemonResult<void>> {
    this.emit({ type: "restart-requested", state: this.state });

    if (this.state === "stopped") {
      return this.start();
    }

    const stopResult = await this.stop();
    if (!stopResult.ok) {
      return stopResult;
    }

    await this.sleep(this.restartBackoffMs);
    return this.start();
  }

  /**
   * Subscribes to lifecycle events.
   */
  onEvent(handler: (event: DaemonLifecycleEvent) => void): void {
    this.listeners.add(handler);
  }

  /**
   * Removes a lifecycle event subscription.
   */
  offEvent(handler: (event: DaemonLifecycleEvent) => void): void {
    this.listeners.delete(handler);
  }

  /**
   * Cleans signal subscriptions without modifying current runtime state.
   */
  dispose(): void {
    this.unbindSignals();
  }

  private emit(event: Omit<DaemonLifecycleEvent, "timestamp">): void {
    const payload: DaemonLifecycleEvent = {
      ...event,
      timestamp: this.now().toISOString(),
    };

    this.logger.log(payload);

    for (const listener of this.listeners) {
      listener(payload);
    }
  }

  private emitError(error: DaemonError): void {
    this.emit({
      type: "error",
      state: this.state,
      message: error.message,
      error: {
        name: error.name,
        code: error.code,
        message: error.message,
      },
    });
  }

  private transitionTo(next: DaemonState): DaemonResult<void> {
    if (!this.canTransition(next)) {
      return err(
        new DaemonError(
          `Invalid daemon transition '${this.state}' -> '${next}'`,
          "DAEMON_INVALID_TRANSITION",
        ),
      );
    }

    const previous = this.state;
    this.state = next;
    this.emit({ type: "state-transition", previousState: previous, nextState: next, state: next });
    return ok(undefined);
  }

  private canTransition(next: DaemonState): boolean {
    return VALID_TRANSITIONS[this.state].has(next);
  }

  private async transitionFailure(): Promise<void> {
    const failed = this.transitionTo("failed");
    if (!failed.ok) {
      return;
    }

    await this.sleep(this.restartBackoffMs);
    this.transitionTo("stopped");
  }

  private async stopServices(signal?: NodeJS.Signals): Promise<DaemonResult<void>> {
    for (const service of [...this.services].reverse()) {
      const result = await service.stop(signal);
      if (!result.ok) {
        return err(result.error);
      }
    }

    return ok(undefined);
  }

  private withTimeout<T>(work: Promise<DaemonResult<T>>, timeoutMs: number): Promise<DaemonResult<T>> {
    const timeout = new Promise<DaemonResult<T>>((resolve) => {
      setTimeout(() => {
        resolve(err(new DaemonError(`Shutdown timed out after ${timeoutMs}ms`, "DAEMON_SHUTDOWN_TIMEOUT")));
      }, timeoutMs);
    });

    return Promise.race([work, timeout]);
  }

  private bindSignals(): void {
    if (this.signalsBound) {
      return;
    }

    process.on("SIGTERM", this.signalHandler);
    process.on("SIGINT", this.signalHandler);
    this.signalsBound = true;
  }

  private unbindSignals(): void {
    if (!this.signalsBound) {
      return;
    }

    if (typeof process.off === "function") {
      process.off("SIGTERM", this.signalHandler);
      process.off("SIGINT", this.signalHandler);
    } else {
      process.removeListener("SIGTERM", this.signalHandler);
      process.removeListener("SIGINT", this.signalHandler);
    }
    this.signalsBound = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
