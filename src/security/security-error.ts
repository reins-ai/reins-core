import { ReinsError } from "../errors";

export class SecurityError extends ReinsError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, cause);
    this.name = "SecurityError";
  }
}
