/**
 * Error type shared by every bridge module. `code` uses the protocol error
 * codes (docs/protocol.md §2.2) where one fits, plus a few bridge-level codes
 * (`no_session`, `not_found`, `port_in_use`, `bad_config`, `proxy_unreachable`).
 */
export class BridgeError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

/** Extracts a machine-readable code from any thrown value (`.code` strings are honoured, e.g. capture errors). */
export function errorCode(err: unknown, fallback = 'internal'): string {
  if (err instanceof BridgeError) return err.code;
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return fallback;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
