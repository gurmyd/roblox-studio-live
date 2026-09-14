import { CloudError } from './errors.js';
import type { CloudLog } from './types.js';

/**
 * Thin fetch wrapper for https://apis.roblox.com: x-api-key auth, 30 s per-attempt
 * timeout (overridable per request), retries (max 3, honouring Retry-After) on 429 for
 * every call and on 5xx / network errors only for idempotent calls — a 429 was never
 * processed, but a 5xx after a POST such as `:increment` or `:publishMessage` may have
 * been, and replaying it would apply the side effect again. Status → CloudError mapping.
 * The key only ever goes into the request header; it is never logged or echoed.
 */
export const DEFAULT_BASE_URL = 'https://apis.roblox.com';
/** Override the API host (tests, proxies). Read per call, like the key. */
export const BASE_URL_ENV = 'ROBLOX_OPEN_CLOUD_BASE_URL';
export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
/** A Retry-After longer than this is reported to the caller instead of waited out inside a tool call. */
const MAX_RETRY_WAIT_MS = 20_000;
const BODY_PREVIEW_CHARS = 600;

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type Query = Record<string, string | number | boolean | undefined>;

export interface CloudRequest {
  method: HttpMethod;
  /** Absolute path on the API host, e.g. `/cloud/v2/universes/1`. */
  path: string;
  query?: Query;
  json?: unknown;
  form?: FormData;
  /** Safe to resend after a network failure, timeout or 5xx (GET, DELETE, full-value PATCH). */
  idempotent?: boolean;
  /**
   * Never retry this request, not even a 429. The capability probe sets it: it fires one
   * request per capability, so the usual "a 429 was never processed, resend it" rule would
   * turn a rate-limited probe into four times as many requests — and `unknown` is a perfectly
   * good answer for a probe that could not settle.
   */
  noRetry?: boolean;
  /** Per-attempt timeout for this request (default REQUEST_TIMEOUT_MS); large uploads raise it. */
  timeoutMs?: number;
}

export interface CloudResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

export interface HttpClient {
  request(req: CloudRequest): Promise<CloudResponse>;
  readonly baseUrl: string;
}

export interface HttpOptions {
  key: string;
  baseUrl?: string;
  log: CloudLog;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
}

export function baseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[BASE_URL_ENV]?.trim();
  return raw ? raw.replace(/\/+$/, '') : DEFAULT_BASE_URL;
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

function buildUrl(baseUrl: string, path: string, query: Query | undefined): URL {
  const url = new URL(baseUrl + path);
  if (query) {
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
  }
  return url;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return null;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('json') || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // not JSON after all: return the raw text
    }
  }
  return text;
}

function messageFromBody(body: unknown): string | undefined {
  if (typeof body === 'string') return body.slice(0, BODY_PREVIEW_CHARS);
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  for (const field of ['message', 'errorMessage', 'title', 'error']) {
    const value = record[field];
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string') {
      return (value as { message: string }).message;
    }
  }
  const errors = record.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as { message?: unknown };
    if (typeof first?.message === 'string') return first.message;
  }
  return undefined;
}

function preview(body: unknown): unknown {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return body.length > BODY_PREVIEW_CHARS ? `${body.slice(0, BODY_PREVIEW_CHARS)}…` : body;
  return body;
}

export function httpError(status: number, body: unknown, method: HttpMethod, path: string, extra: Record<string, unknown> = {}): CloudError {
  const reason = messageFromBody(body);
  const suffix = reason ? `: ${reason}` : '';
  const details = { status, method, path, ...(preview(body) !== undefined ? { response: preview(body) } : {}), ...extra };
  const make = (code: CloudError['code'], message: string): CloudError => new CloudError(code, message, { status, details });
  if (status === 400) return make('bad_request', `Open Cloud rejected the request (400)${suffix}`);
  if (status === 401) return make('unauthorized', `Open Cloud rejected the API key (401)${suffix}`);
  if (status === 403) return make('forbidden', `The API key is not allowed to ${method} ${path} (403)${suffix}`);
  if (status === 404) return make('not_found', `Open Cloud found nothing at ${method} ${path} (404)${suffix}`);
  if (status === 409 || status === 412) return make('conflict', `Open Cloud reported a conflict (${status}) — the entry changed since it was read (etag mismatch) or the resource already exists${suffix}`);
  if (status === 429) return make('rate_limited', `Open Cloud rate limit hit (429) on ${method} ${path}${suffix}`);
  if (status >= 500) return make('server_error', `Open Cloud server error (${status}) on ${method} ${path}${suffix}`);
  return make('http_error', `Open Cloud answered ${status} on ${method} ${path}${suffix}`);
}

export function createHttp(options: HttpOptions): HttpClient {
  const baseUrl = options.baseUrl ?? baseUrlFromEnv();
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const defaultTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  async function request(req: CloudRequest): Promise<CloudResponse> {
    const url = buildUrl(baseUrl, req.path, req.query);
    const logPath = url.pathname + url.search;
    const timeoutMs = req.timeoutMs ?? defaultTimeoutMs;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { 'x-api-key': options.key, accept: 'application/json' };
      let body: RequestInit['body'];
      if (req.form) {
        body = req.form;
      } else if (req.json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(req.json);
      }
      const started = Date.now();
      let res: Response;
      try {
        res = await fetchImpl(url, { method: req.method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        const timedOut = name === 'TimeoutError' || name === 'AbortError';
        const reason = err instanceof Error ? (err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message) : String(err);
        options.log('warn', 'cloud request failed', { method: req.method, path: logPath, attempt, error: reason });
        if (req.idempotent && !req.noRetry && attempt < MAX_RETRIES) {
          await sleep(BACKOFF_BASE_MS * 2 ** attempt);
          continue;
        }
        const message = timedOut
          ? `Open Cloud did not answer within ${Math.round(timeoutMs / 1000)} s (${req.method} ${logPath})`
          : `network error talking to Open Cloud (${req.method} ${logPath}): ${reason}`;
        throw new CloudError(timedOut ? 'timeout' : 'network', message, { details: { method: req.method, path: logPath, attempts: attempt + 1 } });
      }
      const parsed = await parseBody(res);
      options.log('debug', 'cloud request', { method: req.method, path: logPath, status: res.status, ms: Date.now() - started, attempt });
      if (res.status === 429 || res.status >= 500) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        const waitMs = retryAfterMs ?? BACKOFF_BASE_MS * 2 ** attempt;
        // A 429 was never processed, so it is always safe to resend; a 5xx may have been.
        const safeToResend = !req.noRetry && (res.status === 429 || req.idempotent === true);
        if (safeToResend && attempt < MAX_RETRIES && waitMs <= MAX_RETRY_WAIT_MS) {
          options.log('warn', 'cloud request retried', { method: req.method, path: logPath, status: res.status, wait_ms: waitMs, attempt: attempt + 1 });
          await sleep(waitMs);
          continue;
        }
        throw httpError(res.status, parsed, req.method, logPath, {
          attempts: attempt + 1,
          ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
          ...(res.status >= 500 && !req.idempotent ? { not_retried: 'the call is not idempotent, so a 5xx is not replayed (the server may already have applied it)' } : {}),
        });
      }
      if (!res.ok) throw httpError(res.status, parsed, req.method, logPath);
      return { status: res.status, body: parsed, headers: res.headers };
    }
  }

  return { request, baseUrl };
}
