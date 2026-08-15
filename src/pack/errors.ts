import { FailClosedError } from "../errors.js";

export class PackLoadError extends FailClosedError {
  constructor(code: string, message: string, cause?: unknown) {
    super(code, message, cause);
    this.name = "PackLoadError";
  }
}
