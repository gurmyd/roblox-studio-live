export type CloudErrorCode =
  | 'bad_request'
  | 'no_api_key'
  | 'no_ids'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'server_error'
  | 'http_error'
  | 'network'
  | 'timeout'
  | 'task_failed'
  | 'upload_failed'
  | 'internal';

export interface CloudErrorOptions {
  status?: number;
  details?: Record<string, unknown>;
}

/** Every failure the module reports to the agent. `details` is included in the tool result (after masking). */
export class CloudError extends Error {
  readonly code: CloudErrorCode;
  readonly status: number | undefined;
  readonly details: Record<string, unknown>;

  constructor(code: CloudErrorCode, message: string, options: CloudErrorOptions = {}) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.status = options.status;
    this.details = options.details ?? {};
  }
}

export function badRequest(message: string, details?: Record<string, unknown>): CloudError {
  return new CloudError('bad_request', message, details ? { details } : {});
}
