/**
 * One screenshot + one question → one short text answer.
 *
 * `describeFrame` dispatches on the provider: the Claude API through the SDK (this file) or
 * the Claude Code CLI (cli.ts). The API path follows the claude-api skill: default
 * `new Anthropic()` credential resolution (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an
 * `ant auth login` profile — never a key in code), base64 image content block,
 * `client.beta.messages.create` with the server-side `fallbacks: "default"` beta, explicit
 * per-request `timeout` / `maxRetries` plus a hard call budget, typed error classes checked
 * most-specific first, and `stop_reason: "refusal"` handled before the text is trusted.
 */
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_CLI_LOOK_MODEL, DEFAULT_CLI_WATCH_MODEL, describeFrameWithCli, isValidModel } from './cli.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { AUTH_HINT } from './provider.js';
import type { CaptureLike, VisionLogLevel, VisionProvider } from './types.js';

export { SYSTEM_PROMPT } from './prompt.js';

/** One-shot `look` default on the API provider. Overridable with STUDIO_LIVE_VISION_MODEL. */
export const DEFAULT_LOOK_MODEL = 'claude-opus-5';
/** Continuous watch default on the API provider (cheaper per frame). Overridable with STUDIO_LIVE_WATCH_MODEL. */
export const DEFAULT_WATCH_MODEL = 'claude-sonnet-5';
/** Beta header for the scalar `fallbacks: "default"` form (the array form uses the 2026-06-01 header). */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/**
 * Room for the answer AND for adaptive thinking: Opus 5 and Sonnet 5 think by default when
 * `thinking` is omitted, and thinking tokens count against max_tokens, so a 1024 cap could be
 * spent before any text block existed. The system prompt keeps the visible answer short and
 * `effort: "low"` keeps the thinking short; this cap only has to stop runaway output.
 */
export const MAX_ANSWER_TOKENS = 4096;
/** Extra client-side wait before the single rate-limit retry when the API sends no retry-after. */
export const RATE_LIMIT_RETRY_MS = 3_000;
export const RATE_LIMIT_RETRY_MAX_MS = 30_000;
/** Per-attempt SDK timeout (milliseconds). The SDK default is 10 minutes, retried twice. */
export const REQUEST_TIMEOUT_MS = 60_000;
/** SDK-level retries (408/409/429/5xx, connection errors, timeouts); the module adds one 429 retry of its own. */
export const SDK_MAX_RETRIES = 1;
/** Hard wall-clock cap on one describeFrame call, covering every SDK attempt and the 429 retry sleep. */
export const CALL_BUDGET_MS = 120_000;

export type ModelKind = 'look' | 'watch';

/**
 * Explicit override → env (STUDIO_LIVE_VISION_MODEL / STUDIO_LIVE_WATCH_MODEL) → built-in
 * default for the provider (full ids on the API, the `sonnet` / `haiku` aliases on the CLI; the
 * CLI accepts full ids too, so one env var serves both providers).
 */
export function resolveModel(kind: ModelKind, override?: string, provider: VisionProvider = 'api'): string {
  const explicit = override?.trim();
  if (explicit) return explicit;
  const env = (kind === 'look' ? process.env.STUDIO_LIVE_VISION_MODEL : process.env.STUDIO_LIVE_WATCH_MODEL)?.trim();
  if (env) return env;
  if (provider === 'claude-cli') return kind === 'look' ? DEFAULT_CLI_LOOK_MODEL : DEFAULT_CLI_WATCH_MODEL;
  return kind === 'look' ? DEFAULT_LOOK_MODEL : DEFAULT_WATCH_MODEL;
}

export const MODEL_ENV: Record<ModelKind, string> = { look: 'STUDIO_LIVE_VISION_MODEL', watch: 'STUDIO_LIVE_WATCH_MODEL' };

/**
 * Where an unusable model string would come from — `'the model argument'` or the env var name —
 * or null when what `resolveModel` will return is a well-formed id / alias (the built-in
 * defaults always are). Checked by the tool before a capture is spent on the call.
 */
export function invalidModelSource(kind: ModelKind, override?: string): string | null {
  const explicit = override?.trim();
  if (explicit) return isValidModel(explicit) ? null : 'the model argument';
  const env = process.env[MODEL_ENV[kind]]?.trim();
  if (env) return isValidModel(env) ? null : MODEL_ENV[kind];
  return null;
}

/** Token counts from the API; the CLI reports its own cost and turn count (and tokens when it has them). */
export interface VisionUsage {
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  turns?: number;
}

export interface VisionAnswer {
  ok: true;
  answer: string;
  /**
   * Model that produced the message: `response.model` on the API (differs from
   * `requested_model` when a fallback served it), `claude-cli:<model>` on the CLI.
   */
  model: string;
  requested_model: string;
  /** Model time: the API round trip, or the CLI's own `duration_ms`. */
  model_ms: number;
  /** CLI only: wall-clock time of the whole call including the CLI's startup. */
  wall_ms?: number;
  usage: VisionUsage;
  stop_reason: string | null;
  /** `stop_reason === 'max_tokens'`: MAX_ANSWER_TOKENS was reached (thinking counts too) before the answer finished. */
  truncated: boolean;
  /** A fallback model served the response (`fallback_message` in `usage.iterations`). */
  fallback: boolean;
  provider: VisionProvider;
}

export type VisionErrorCode =
  | 'auth'
  | 'rate_limited'
  | 'refusal'
  | 'bad_model'
  | 'bad_request'
  | 'connection'
  | 'timeout'
  | 'api_error'
  | 'aborted'
  /** The claude CLI could not be started, exited with an error, or reported `is_error`. */
  | 'cli_error'
  /** The claude CLI produced output that is not the expected JSON result object. */
  | 'cli_bad_output';

export interface VisionFailure {
  ok: false;
  code: VisionErrorCode;
  message: string;
  status?: number;
  /** Worth trying again later (rate limit, overload, network). */
  retryable: boolean;
  requested_model: string;
  model_ms: number;
  provider: VisionProvider;
  /** Structured refusal information (`code === 'refusal'`). */
  stop_details?: { category: string | null; explanation: string | null };
  /** Partial text that accompanied a refusal, if any. */
  answer?: string;
  usage?: VisionUsage;
}

export type VisionOutcome = VisionAnswer | VisionFailure;

export { AUTH_HINT } from './provider.js';

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export type VisionLog = (level: VisionLogLevel, msg: string, data?: Record<string, unknown>) => void;

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
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

export interface DescribeOptions {
  model: string;
  /** Which backend answers (default `api`). Chosen by provider.ts; the watch/tool pass it through. */
  provider?: VisionProvider;
  /** `claude-cli` only: resolved path of the executable (looked up on PATH when absent). */
  cli?: string;
  /** Caller-side cancellation (a watch being stopped). Composed with the call budget. */
  signal?: AbortSignal;
  /** Wall-clock cap for the whole call (default CALL_BUDGET_MS, or CLI_TIMEOUT_MS on the CLI); exceeding it answers `code: 'timeout'`. */
  budgetMs?: number;
  /** Receives one warning when a model rejects `fallbacks` and the call is resent without them. */
  log?: VisionLog;
  /** Injected in tests; defaults to a setTimeout sleep. */
  sleep?: Sleep;
  /** Injected in tests; defaults to the shared client. */
  client?: Anthropic;
}

let sharedClient: Anthropic | null = null;
/** Models that answered 400 to `fallbacks: "default"`; later calls to them go without it. */
const fallbacksUnsupported = new Set<string>();

/**
 * Lazily constructed so a missing credential surfaces on the first call, not at import. The
 * SDK reads ANTHROPIC_API_KEY in its constructor and caches the profile resolution on the
 * instance, so the client is dropped again after an auth failure (see describeFrame).
 */
export function getClient(): Anthropic {
  if (!sharedClient) sharedClient = new Anthropic();
  return sharedClient;
}

/** Drops the shared client and the per-model fallback memo (tests, or after the user fixes credentials). */
export function resetClient(): void {
  sharedClient = null;
  fallbacksUnsupported.clear();
}

/** Whether the next call to `model` will carry `fallbacks: "default"` (false once the model rejected it). */
export function fallbacksEnabledFor(model: string): boolean {
  return !fallbacksUnsupported.has(model);
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'TimeoutError';
}

/** `Anthropic.X` as a *type* names the API error-body interface, so the error classes are typed via their constructors. */
type APIErrorInstance = InstanceType<typeof Anthropic.APIError>;
type RateLimitErrorInstance = InstanceType<typeof Anthropic.RateLimitError>;

function retryAfterMs(err: RateLimitErrorInstance): number {
  const header = err.headers?.get?.('retry-after');
  const seconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RATE_LIMIT_RETRY_MAX_MS);
  return RATE_LIMIT_RETRY_MS;
}

function textOf(response: Anthropic.Beta.BetaMessage): string {
  return response.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function interpret(response: Anthropic.Beta.BetaMessage, requested: string, modelMs: number): VisionOutcome {
  const answer = textOf(response);
  const usage: VisionUsage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
  if (response.stop_reason === 'refusal') {
    const details = response.stop_details;
    const category = details?.category ?? null;
    const explanation = details?.explanation ?? null;
    return {
      ok: false,
      code: 'refusal',
      message: `the vision model declined to answer${category ? ` (category: ${category})` : ''}${explanation ? `: ${explanation}` : ''}`,
      retryable: false,
      requested_model: requested,
      model_ms: modelMs,
      provider: 'api',
      stop_details: { category, explanation },
      ...(answer ? { answer } : {}),
      usage,
    };
  }
  const fallback = (response.usage.iterations ?? []).some((entry) => entry.type === 'fallback_message');
  return {
    ok: true,
    answer,
    model: response.model,
    requested_model: requested,
    model_ms: modelMs,
    usage,
    stop_reason: response.stop_reason,
    truncated: response.stop_reason === 'max_tokens',
    fallback,
    provider: 'api',
  };
}

function apiMessage(err: APIErrorInstance): string {
  const status = err.status === undefined ? '' : `${err.status} `;
  return `Claude API error ${status}${err.type ? `(${err.type}) ` : ''}${err.message}`.trim();
}

/**
 * Maps a thrown value to a VisionFailure. Order: most specific SDK class first, base APIError last.
 * `signal` (the composed call signal) tells a budget timeout apart from a caller-side abort.
 */
export function classifyError(err: unknown, requested: string, modelMs: number, signal?: AbortSignal): VisionFailure {
  const base = { ok: false as const, requested_model: requested, model_ms: modelMs, provider: 'api' as const };
  if (err instanceof Anthropic.APIUserAbortError) {
    if (signal?.aborted && isTimeoutReason(signal.reason)) {
      return { ...base, code: 'timeout', retryable: true, message: `vision request gave up after ${Math.round(modelMs / 1000)} s (call budget ${CALL_BUDGET_MS / 1000} s); the Claude API is slow or unreachable, try again` };
    }
    return { ...base, code: 'aborted', message: 'vision request aborted', retryable: false };
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return { ...base, code: 'auth', status: err.status, retryable: false, message: `Claude API authentication failed (${err.status}): ${AUTH_HINT}. ${err.message}` };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { ...base, code: 'rate_limited', status: err.status, retryable: true, message: `Claude API rate limit (${err.status}) persisted after one retry; wait and try again. ${err.message}` };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return { ...base, code: 'bad_model', status: err.status, retryable: false, message: `model '${requested}' not found or not available to this organization (404): check STUDIO_LIVE_VISION_MODEL / STUDIO_LIVE_WATCH_MODEL / the model argument. ${err.message}` };
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { ...base, code: 'bad_request', status: err.status, retryable: false, message: apiMessage(err) };
  }
  // APIConnectionTimeoutError extends APIConnectionError extends APIError, so most specific first.
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return { ...base, code: 'timeout', retryable: true, message: `the Claude API did not answer within ${REQUEST_TIMEOUT_MS / 1000} s (${SDK_MAX_RETRIES + 1} attempts): ${err.message}` };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { ...base, code: 'connection', retryable: true, message: `could not reach the Claude API: ${err.message}` };
  }
  if (err instanceof Anthropic.APIError) {
    const retryable = err instanceof Anthropic.InternalServerError || err.status === undefined || err.status >= 500;
    return { ...base, code: 'api_error', status: err.status, retryable, message: apiMessage(err) };
  }
  const message = err instanceof Error ? err.message : String(err);
  // The SDK reports "no credential found" with a plain Error at request time (not a typed class),
  // so this one narrow message check is the only way to give the same guidance as a 401.
  if (/authentication method/i.test(message)) {
    return { ...base, code: 'auth', retryable: false, message: `no Claude API credential: ${AUTH_HINT}. ${message}` };
  }
  return { ...base, code: 'api_error', retryable: false, message: `vision request failed: ${message}` };
}

/**
 * Asks one question about one frame through the selected provider (`opts.provider`, default
 * `api`). Never throws: every failure is a VisionFailure, and every outcome names its provider.
 */
export async function describeFrame(frame: CaptureLike, question: string, opts: DescribeOptions): Promise<VisionOutcome> {
  if (opts.provider === 'claude-cli') return describeFrameWithCli(frame, question, opts);
  return describeFrameWithApi(frame, question, opts);
}

/**
 * The API provider: one `client.beta.messages.create` per frame.
 *
 * Time bounds: each SDK attempt gets REQUEST_TIMEOUT_MS and is retried at most SDK_MAX_RETRIES
 * times by the SDK; a 429 is retried once more here after `retry-after` (or RATE_LIMIT_RETRY_MS);
 * and the whole call is cut at `budgetMs` (CALL_BUDGET_MS) with `code: 'timeout'`, so one MCP
 * call can never hang for the SDK's default 10-minute timeout × 3 attempts.
 *
 * `fallbacks: "default"` is sent for every model; a model without a server-side fallback
 * configuration answers 400, in which case the call is resent once without it and the model is
 * remembered so a watch does not pay the 400 on every frame.
 */
export async function describeFrameWithApi(frame: CaptureLike, question: string, opts: DescribeOptions): Promise<VisionOutcome> {
  const sleep = opts.sleep ?? defaultSleep;
  const started = Date.now();
  const elapsed = (): number => Date.now() - started;
  const budget = AbortSignal.timeout(opts.budgetMs ?? CALL_BUDGET_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, budget]) : budget;
  let retriedRateLimit = false;
  let withFallbacks = fallbacksEnabledFor(opts.model);
  for (;;) {
    try {
      const client = opts.client ?? getClient();
      const response = await client.beta.messages.create(
        {
          model: opts.model,
          ...(withFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
          max_tokens: MAX_ANSWER_TOKENS,
          output_config: { effort: 'low' },
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: frame.mimeType, data: frame.base64 } },
                { type: 'text', text: question },
              ],
            },
          ],
        },
        { signal, timeout: REQUEST_TIMEOUT_MS, maxRetries: SDK_MAX_RETRIES },
      );
      return interpret(response, opts.model, elapsed());
    } catch (err) {
      if (withFallbacks && err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message) && !signal.aborted) {
        withFallbacks = false;
        fallbacksUnsupported.add(opts.model);
        opts.log?.('warn', 'vision: model rejected server-side fallbacks, retrying without them', { model: opts.model, error: err.message });
        continue;
      }
      if (err instanceof Anthropic.RateLimitError && !retriedRateLimit && !signal.aborted) {
        retriedRateLimit = true;
        await sleep(retryAfterMs(err), signal);
        if (signal.aborted) return classifyError(new Anthropic.APIUserAbortError(), opts.model, elapsed(), signal);
        continue;
      }
      const failure = classifyError(err, opts.model, elapsed(), signal);
      // The shared client keeps the credential it resolved at construction; drop it so the
      // next call picks up a key or `ant auth login` profile added since.
      if (failure.code === 'auth' && !opts.client) sharedClient = null;
      return failure;
    }
  }
}
