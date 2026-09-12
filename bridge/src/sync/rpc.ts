/**
 * Minimal client for the bridge's `POST /rpc {tool,args}` (exactly what scripts/rpc.mjs does).
 * No bridge internals are imported, so the sync works against a bridge in another process.
 */

export type RpcOutcome =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; code: string; message: string; transport: boolean; value?: Record<string, unknown> };

export interface RpcCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 90_000;

/** Tool-level codes worth retrying: the bridge or Studio is temporarily unavailable, not our request. */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set(['unreachable', 'no_session', 'busy', 'timeout', 'disconnected', 'proxy_unreachable']);

function firstText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
      return (part as { text: string }).text;
    }
  }
  return null;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Interprets a bridge tool result body (`{content:[{type:'text',text}], isError?}`) or an HTTP error body. */
export function interpretRpcBody(status: number, text: string): RpcOutcome {
  const body = parseObject(text);
  if (!body) return { ok: false, code: 'unreachable', message: `HTTP ${status}: non-JSON response`, transport: true };
  const inner = firstText(body);
  if (inner === null) {
    const err = body.error as { code?: unknown; message?: unknown } | undefined;
    if (err && typeof err.code === 'string') {
      const code = err.code === 'no_session' || err.code === 'disconnected' ? err.code : status >= 500 ? 'unreachable' : err.code;
      return { ok: false, code, message: typeof err.message === 'string' ? err.message : code, transport: status >= 500 };
    }
    return { ok: false, code: 'unreachable', message: `HTTP ${status}: unexpected body`, transport: true };
  }
  const value = parseObject(inner);
  if (!value) return { ok: false, code: 'internal', message: `tool result is not JSON: ${inner.slice(0, 200)}`, transport: false };
  const err = value.error as { code?: unknown; message?: unknown } | undefined;
  if (body.isError === true || (err && typeof err.code === 'string')) {
    const code = err && typeof err.code === 'string' ? err.code : 'internal';
    const message = err && typeof err.message === 'string' ? err.message : inner.slice(0, 500);
    return { ok: false, code, message, transport: false, value };
  }
  if (value.status === 'running' && typeof value.job_id === 'string') {
    // A job handle is progress, not failure: the caller follows it with `job wait` (followJob).
    return { ok: false, code: 'running', message: `still running as job ${value.job_id}`, transport: false, value };
  }
  return { ok: true, value };
}

/** Per `job wait` poll; the tool caps wait_ms at 50 s and the RPC request at 90 s. */
export const JOB_POLL_WAIT_MS = 25_000;

export interface FollowJobOptions {
  signal?: AbortSignal;
  waitMs?: number;
  /** Delay between polls that failed with a retryable code (bridge restarting). */
  retryMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Waits for a job handle the bridge returned (`{job_id, status:'running'}`) with `job wait` until it
 * is done or failed, then answers exactly like the original call would have. An aborted signal
 * sends `job cancel` so nothing stays queued in Studio. A handle the bridge no longer knows
 * (`not_found`: bridge restarted, or the job expired) is reported as such — the caller decides.
 */
export async function followJob(client: RpcClient, jobId: string, options: FollowJobOptions = {}): Promise<RpcOutcome> {
  const waitMs = options.waitMs ?? JOB_POLL_WAIT_MS;
  for (;;) {
    if (options.signal?.aborted) {
      await client.call('job', { action: 'cancel', job_id: jobId }).catch(() => undefined);
      return { ok: false, code: 'cancelled', message: 'stopped', transport: false };
    }
    const snap = await client.call('job', { action: 'wait', job_id: jobId, wait_ms: waitMs }, { signal: options.signal });
    if (!snap.ok) {
      if (snap.code === 'running') continue; // the wait elapsed with the job still running: poll again
      if (snap.code === 'cancelled') continue; // the signal fired mid-poll: the next turn cancels the job
      if (snap.transport && !options.signal?.aborted) {
        await sleep(options.retryMs ?? 250, options.signal);
        continue;
      }
      return snap;
    }
    const status = snap.value.status;
    if (status === 'done') {
      const result = snap.value.result;
      return { ok: true, value: isRecord(result) ? result : { value: result ?? null } };
    }
    if (status === 'error') {
      const err = isRecord(snap.value.error) ? snap.value.error : {};
      return {
        ok: false,
        code: typeof err.code === 'string' ? err.code : 'internal',
        message: typeof err.message === 'string' ? err.message : `job ${jobId} failed`,
        transport: false,
        value: snap.value,
      };
    }
    // still running: poll again
  }
}

export class RpcClient {
  constructor(
    readonly port: number,
    private readonly host: string = '127.0.0.1',
  ) {}

  get url(): string {
    return `http://${this.host}:${this.port}/rpc`;
  }

  async call(tool: string, args: unknown, options: RpcCallOptions = {}): Promise<RpcOutcome> {
    const signals: AbortSignal[] = [AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)];
    if (options.signal) signals.push(options.signal);
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool, args: args ?? {} }),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      if (options.signal?.aborted) return { ok: false, code: 'cancelled', message: 'stopped', transport: false };
      return { ok: false, code: 'unreachable', message: err instanceof Error ? err.message : String(err), transport: true };
    }
    const text = await response.text().catch(() => '');
    return interpretRpcBody(response.status, text);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RetryPolicy {
  /** Give up after this long (the last outcome is returned). */
  budgetMs: number;
  /** First back-off delay; doubles up to maxMs. `busy` uses a quarter of both. */
  baseMs: number;
  maxMs: number;
  signal?: AbortSignal;
  onRetry?: (outcome: Extract<RpcOutcome, { ok: false }>, attempt: number, delayMs: number) => void;
  /** Extra veto on retrying a failure whose code is retryable (e.g. a `busy` that will not clear). */
  retryIf?: (outcome: Extract<RpcOutcome, { ok: false }>) => boolean;
  /** Called when the bridge answered with a job handle that is now being followed. */
  onJob?: (jobId: string) => void;
  /** Set false to get the `running` outcome back instead of following the job (default: follow). */
  followJobs?: boolean;
}

/**
 * Calls the tool, retrying retryable failures with exponential back-off until the budget is spent.
 * A job handle (the tool's wait_ms elapsed while the request still runs in Studio) is followed to
 * its end rather than treated as a failure, so a slow batch is never re-sent behind itself.
 */
export async function callWithRetry(client: RpcClient, tool: string, args: unknown, policy: RetryPolicy): Promise<RpcOutcome> {
  const started = Date.now();
  let attempt = 0;
  let delay = policy.baseMs;
  for (;;) {
    let outcome = await client.call(tool, args, { signal: policy.signal });
    if (!outcome.ok && outcome.code === 'running' && policy.followJobs !== false) {
      const jobId = typeof outcome.value?.job_id === 'string' ? outcome.value.job_id : null;
      if (jobId) {
        policy.onJob?.(jobId);
        outcome = await followJob(client, jobId, { signal: policy.signal });
      }
    }
    if (outcome.ok || !RETRYABLE_CODES.has(outcome.code) || policy.signal?.aborted) return outcome;
    if (policy.retryIf && !policy.retryIf(outcome)) return outcome;
    const elapsed = Date.now() - started;
    if (elapsed >= policy.budgetMs) return outcome;
    attempt += 1;
    // busy = another edit-DM write is in flight; it clears in milliseconds, so poll faster.
    const wait = Math.min(outcome.code === 'busy' ? Math.max(50, delay / 4) : delay, policy.budgetMs - elapsed);
    policy.onRetry?.(outcome, attempt, wait);
    await sleep(wait, policy.signal);
    if (policy.signal?.aborted) return outcome;
    delay = Math.min(policy.maxMs, delay * 2);
  }
}
