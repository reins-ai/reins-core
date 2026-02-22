import { ReinsError } from "../errors";

export class AgentError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "AGENT_ERROR", cause);
    this.name = "AgentError";
  }
}
