export class AvError extends Error {
  readonly code: string;
  readonly closed: boolean;

  constructor(code: string, message: string, closed = true) {
    super(message);
    this.name = "AvError";
    this.code = code;
    this.closed = closed;
  }
}

export class PackLoadError extends AvError {
  constructor(code: string, message: string) {
    super(code, message, true);
    this.name = "PackLoadError";
  }
}

/** Missing or unreadable product trust anchors. Fail closed — no generated fallback. */
export class TrustAnchorError extends AvError {
  constructor(code: string, message: string) {
    super(code, message, true);
    this.name = "TrustAnchorError";
  }
}

export class PolicyDeniedError extends AvError {
  constructor(message: string) {
    super("POLICY_DENIED", message, true);
    this.name = "PolicyDeniedError";
  }
}

export class AuthorizationRequiredError extends AvError {
  readonly cardId: string;
  constructor(cardId: string, message: string) {
    super("AUTHORIZATION_REQUIRED", message, true);
    this.cardId = cardId;
    this.name = "AuthorizationRequiredError";
  }
}

export class SurfaceViolationError extends AvError {
  constructor(message: string) {
    super("SURFACE_VIOLATION", message, true);
    this.name = "SurfaceViolationError";
  }
}

export class ComputerError extends AvError {
  constructor(code: string, message: string) {
    super(code, message, true);
    this.name = "ComputerError";
  }
}

/** Production deploy is incomplete. Fail closed — do not invent a live tenant. */
export class DeployIncompleteError extends AvError {
  constructor(message: string) {
    super("DEPLOY_INCOMPLETE", message, true);
    this.name = "DeployIncompleteError";
  }
}
