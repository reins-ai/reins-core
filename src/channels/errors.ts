import { ReinsError } from "../errors";

/**
 * Channel domain error for channel registry and adapter failures.
 */
export class ChannelError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "CHANNEL_ERROR", cause);
    this.name = "ChannelError";
  }
}
