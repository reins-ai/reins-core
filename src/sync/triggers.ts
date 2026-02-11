export type SyncTrigger = "manual" | "credential_change" | "billing_change" | "startup";

export interface SyncTriggerConfig {
  autoSyncOnCredentialChange: boolean;
  autoSyncOnBillingChange: boolean;
  autoSyncOnStartup: boolean;
}

export const DEFAULT_SYNC_TRIGGER_CONFIG: SyncTriggerConfig = {
  autoSyncOnCredentialChange: true,
  autoSyncOnBillingChange: false,
  autoSyncOnStartup: false,
};

export class SyncTriggerManager {
  private config: SyncTriggerConfig;
  private readonly listeners: Map<SyncTrigger, Array<() => Promise<void>>>;

  constructor(config?: Partial<SyncTriggerConfig>) {
    this.config = {
      ...DEFAULT_SYNC_TRIGGER_CONFIG,
      ...config,
    };

    this.listeners = new Map<SyncTrigger, Array<() => Promise<void>>>([
      ["manual", []],
      ["credential_change", []],
      ["billing_change", []],
      ["startup", []],
    ]);
  }

  public onTrigger(trigger: SyncTrigger, handler: () => Promise<void>): void {
    const triggerHandlers = this.listeners.get(trigger);
    if (!triggerHandlers) {
      this.listeners.set(trigger, [handler]);
      return;
    }

    triggerHandlers.push(handler);
  }

  public async fire(trigger: SyncTrigger): Promise<void> {
    const triggerHandlers = this.listeners.get(trigger) ?? [];
    await Promise.all(triggerHandlers.map(async (handler) => handler()));
  }

  public shouldAutoSync(trigger: SyncTrigger): boolean {
    switch (trigger) {
      case "credential_change":
        return this.config.autoSyncOnCredentialChange;
      case "billing_change":
        return this.config.autoSyncOnBillingChange;
      case "startup":
        return this.config.autoSyncOnStartup;
      case "manual":
      default:
        return false;
    }
  }

  public getConfig(): SyncTriggerConfig {
    return { ...this.config };
  }

  public updateConfig(config: Partial<SyncTriggerConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }
}
