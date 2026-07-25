export class BridgeError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BridgeBusyError extends BridgeError {
  public constructor(message: string, details?: unknown) {
    super(message, "BRIDGE_BUSY", details);
  }
}

export class BridgeTimeoutError extends BridgeError {
  public constructor(message: string, details?: unknown) {
    super(message, "BRIDGE_TIMEOUT", details);
  }
}

export class BridgeProtocolError extends BridgeError {
  public constructor(message: string, details?: unknown) {
    super(message, "BRIDGE_PROTOCOL_ERROR", details);
  }
}

export class BridgeRemoteError extends BridgeError {
  public constructor(code: string, message: string, details?: unknown) {
    super(message, code, details);
  }
}

export class BridgeUnavailableError extends BridgeError {
  public constructor(message: string, details?: unknown) {
    super(message, "BRIDGE_UNAVAILABLE", details);
  }
}

export interface PublicError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export function toPublicError(error: unknown): PublicError {
  if (error instanceof BridgeError) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  }

  if (error instanceof Error) {
    return { code: "INTERNAL_ERROR", message: error.message };
  }

  return { code: "INTERNAL_ERROR", message: String(error) };
}
