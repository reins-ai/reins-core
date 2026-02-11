export interface BillingSyncPayload {
  gatewayKeyPrefix: string;
  balanceCents: number;
  autoReloadEnabled: boolean;
  autoReloadThresholdCents: number;
  autoReloadAmountCents: number;
  recentTransactionCount: number;
  checksum: string;
}

export class SyncError extends Error {
  public readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "SyncError";
    this.cause = cause;
  }
}
