const HEARTBEAT_ACK_TOKEN_REGEX = /\bHEARTBEAT_OK\b/gi;
const MEANINGFUL_CONTENT_REGEX = /[a-z0-9]/i;

export interface HeartbeatAckResult {
  stripped: string;
  isAckOnly: boolean;
  hadAckToken: boolean;
}

export function parseHeartbeatResponse(output: string): HeartbeatAckResult {
  const hadAckToken = HEARTBEAT_ACK_TOKEN_REGEX.test(output);
  HEARTBEAT_ACK_TOKEN_REGEX.lastIndex = 0;

  const stripped = output.replace(HEARTBEAT_ACK_TOKEN_REGEX, "").trim();
  HEARTBEAT_ACK_TOKEN_REGEX.lastIndex = 0;

  const isAckOnly = hadAckToken && !MEANINGFUL_CONTENT_REGEX.test(stripped);

  return {
    stripped,
    isAckOnly,
    hadAckToken,
  };
}

export function shouldSuppressOutput(ackResult: HeartbeatAckResult): boolean {
  return ackResult.isAckOnly;
}
