import { parseHeartbeatResponse, shouldSuppressOutput } from "./ack";
import { AlertDedupeStore } from "./dedupe";

const MEANINGFUL_CONTENT_REGEX = /[a-z0-9]/i;

export interface HeartbeatProcessedOutput {
  content: string;
  shouldDeliver: boolean;
  reason: "delivered" | "ack_suppressed" | "duplicate_suppressed";
}

export class HeartbeatOutputHandler {
  constructor(private readonly dedupeStore: AlertDedupeStore = new AlertDedupeStore()) {}

  processOutput(rawOutput: string): HeartbeatProcessedOutput {
    const ackResult = parseHeartbeatResponse(rawOutput);
    const content = ackResult.stripped;

    if (shouldSuppressOutput(ackResult) || !MEANINGFUL_CONTENT_REGEX.test(content)) {
      return {
        content,
        shouldDeliver: false,
        reason: "ack_suppressed",
      };
    }

    const alertKey = this.dedupeStore.generateAlertKey(content);
    if (this.dedupeStore.isDuplicate(alertKey)) {
      return {
        content,
        shouldDeliver: false,
        reason: "duplicate_suppressed",
      };
    }

    this.dedupeStore.recordAlert(alertKey);
    return {
      content,
      shouldDeliver: true,
      reason: "delivered",
    };
  }
}
