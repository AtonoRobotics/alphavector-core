export class AvError extends Error {
  readonly code: string;
  readonly closed: boolean;

  constructor(code: string, message: string, options?: { closed?: boolean; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AvError";
    this.code = code;
    this.closed = options?.closed ?? true;
  }
}

export class FailClosedError extends AvError {
  constructor(code: string, message: string, cause?: unknown) {
    super(code, message, { closed: true, cause });
    this.name = "FailClosedError";
  }
}
