import { err, ok, type Result } from "../result";
import { IntegrationError } from "./errors";
import { IntegrationState } from "./types";

export type StateChangeListener = (
  integrationId: string,
  from: IntegrationState,
  to: IntegrationState,
) => void;

/**
 * Valid state transitions for the integration lifecycle.
 *
 * installed → configured → connected → active ↔ suspended
 * Any state → disconnected (force cleanup)
 * disconnected → installed (reinstall)
 */
const VALID_TRANSITIONS: Record<IntegrationState, IntegrationState[]> = {
  [IntegrationState.INSTALLED]: [IntegrationState.CONFIGURED, IntegrationState.DISCONNECTED],
  [IntegrationState.CONFIGURED]: [IntegrationState.CONNECTED, IntegrationState.DISCONNECTED],
  [IntegrationState.CONNECTED]: [IntegrationState.ACTIVE, IntegrationState.DISCONNECTED],
  [IntegrationState.ACTIVE]: [IntegrationState.SUSPENDED, IntegrationState.DISCONNECTED],
  [IntegrationState.SUSPENDED]: [IntegrationState.ACTIVE, IntegrationState.DISCONNECTED],
  [IntegrationState.DISCONNECTED]: [IntegrationState.INSTALLED],
};

export class IntegrationStateMachine {
  private state: IntegrationState;
  private readonly listeners: Set<StateChangeListener> = new Set();

  constructor(
    private readonly integrationId: string,
    initialState: IntegrationState = IntegrationState.INSTALLED,
  ) {
    this.state = initialState;
  }

  getState(): IntegrationState {
    return this.state;
  }

  getIntegrationId(): string {
    return this.integrationId;
  }

  canTransition(to: IntegrationState): boolean {
    const validNextStates = VALID_TRANSITIONS[this.state];
    return validNextStates.includes(to);
  }

  /**
   * Attempts to transition to the given state. Returns an error if the
   * transition is invalid — the internal state is only mutated on success.
   */
  transition(to: IntegrationState): Result<void, IntegrationError> {
    if (!this.canTransition(to)) {
      return err(
        new IntegrationError(
          `Invalid state transition for "${this.integrationId}": ${this.state} → ${to}`,
        ),
      );
    }

    const from = this.state;
    this.state = to;

    this.notifyListeners(from, to);

    return ok(undefined);
  }

  addListener(listener: StateChangeListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: StateChangeListener): void {
    this.listeners.delete(listener);
  }

  private notifyListeners(from: IntegrationState, to: IntegrationState): void {
    for (const listener of this.listeners) {
      try {
        listener(this.integrationId, from, to);
      } catch {
        // Listener errors must not break the state machine
      }
    }
  }
}
