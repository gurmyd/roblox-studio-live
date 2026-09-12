import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_HINT,
  CALL_BUDGET_MS,
  DEFAULT_LOOK_MODEL,
  DEFAULT_WATCH_MODEL,
  FALLBACK_BETA,
  MAX_ANSWER_TOKENS,
  REQUEST_TIMEOUT_MS,
  SDK_MAX_RETRIES,
  SYSTEM_PROMPT,
  describeFrame,
  fallbacksEnabledFor,
  resetClient,
  resolveModel,
} from '../../bridge/src/vision/model.js';
import { apiError, constructMock, createMock, flush, frame, message, mockedSdk } from './helpers.js';

vi.mock('@anthropic-ai/sdk', async (importOriginal) => (await import('./helpers.js')).mockedSdk(importOriginal as never));

const ENV_KEYS = ['STUDIO_LIVE_VISION_MODEL', 'STUDIO_LIVE_WATCH_MODEL'] as const;

/** A fake `create` that hangs until the request signal aborts, then throws the SDK's abort error. */
function hangUntilAborted(): void {
  createMock.mockImplementation(
    (_params: unknown, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const fail = (): void => reject(new Anthropic.APIUserAbortError());
        if (options.signal.aborted) fail();
        else options.signal.addEventListener('abort', fail, { once: true });
      }),
  );
}

beforeEach(() => {
  createMock.mockReset();
  constructMock.mockReset();
  resetClient();
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  vi.useRealTimers();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('mock wiring', () => {
  it('keeps the SDK error classes real while faking the client', async () => {
    expect(typeof mockedSdk).toBe('function');
    const err = apiError(Anthropic.AuthenticationError, 401, 'authentication_error', 'invalid x-api-key');
    expect(err).toBeInstanceOf(Anthropic.AuthenticationError);
    expect(err).toBeInstanceOf(Anthropic.APIError);
    expect(err.status).toBe(401);
  });
});

describe('resolveModel', () => {
  it('uses the built-in defaults per kind', () => {
    expect(resolveModel('look')).toBe('claude-opus-5');
    expect(resolveModel('watch')).toBe('claude-sonnet-5');
    expect(DEFAULT_LOOK_MODEL).toBe('claude-opus-5');
    expect(DEFAULT_WATCH_MODEL).toBe('claude-sonnet-5');
  });

  it('prefers the explicit override, then the environment', () => {
    process.env.STUDIO_LIVE_VISION_MODEL = 'claude-sonnet-5';
    process.env.STUDIO_LIVE_WATCH_MODEL = 'claude-opus-5';
    expect(resolveModel('look')).toBe('claude-sonnet-5');
    expect(resolveModel('watch')).toBe('claude-opus-5');
    expect(resolveModel('look', 'claude-custom')).toBe('claude-custom');
    expect(resolveModel('watch', '   ')).toBe('claude-opus-5');
  });
});

describe('describeFrame', () => {
  it('sends one base64 image block plus the question with the fallback beta, bounded output and explicit time limits', async () => {
    createMock.mockResolvedValueOnce(message('A red error in the Output panel: attempt to index nil'));
    const shot = frame('QUJD', { mimeType: 'image/png', path: 'C:\\frames\\x.png' });
    const outcome = await describeFrame(shot, 'Is there an error?', { model: resolveModel('look') });

    expect(createMock).toHaveBeenCalledTimes(1);
    const [params, options] = createMock.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(params.model).toBe('claude-opus-5');
    expect(params.betas).toEqual([FALLBACK_BETA]);
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.fallbacks).toBe('default');
    expect(params.max_tokens).toBe(MAX_ANSWER_TOKENS);
    // Adaptive thinking (on by default for Opus 5 / Sonnet 5) shares this cap with the answer.
    expect(params.max_tokens).toBe(4096);
    expect(params.output_config).toEqual({ effort: 'low' });
    expect(params.system).toBe(SYSTEM_PROMPT);
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('thinking');
    expect(params.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
          { type: 'text', text: 'Is there an error?' },
        ],
      },
    ]);
    // Never the SDK defaults (10 min × 3 attempts): a per-attempt timeout, one SDK retry, and a call budget signal.
    expect(options.timeout).toBe(REQUEST_TIMEOUT_MS);
    expect(options.timeout).toBe(60_000);
    expect(options.maxRetries).toBe(SDK_MAX_RETRIES);
    expect(options.maxRetries).toBe(1);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect((options.signal as AbortSignal).aborted).toBe(false);
    expect(CALL_BUDGET_MS).toBe(120_000);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.answer).toBe('A red error in the Output panel: attempt to index nil');
    expect(outcome.model).toBe('claude-opus-5');
    expect(outcome.requested_model).toBe('claude-opus-5');
    expect(outcome.usage).toEqual({ input_tokens: 512, output_tokens: 24 });
    expect(outcome.truncated).toBe(false);
    expect(outcome.fallback).toBe(false);
    expect(outcome.model_ms).toBeGreaterThanOrEqual(0);
  });

  it('keeps only text blocks and reports fallback / truncation signals', async () => {
    createMock.mockResolvedValueOnce(
      message('', {
        model: 'claude-opus-4-8',
        stop_reason: 'max_tokens',
        content: [
          { type: 'thinking', thinking: 'looking…', signature: 'sig' } as never,
          { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' } } as never,
          { type: 'text', text: 'The Play button is in the ribbon,', citations: null } as never,
          { type: 'text', text: 'centre-top.', citations: null } as never,
        ],
        usage: { input_tokens: 600, output_tokens: 1024, iterations: [{ type: 'message' }, { type: 'fallback_message' }] as never },
      }),
    );
    const outcome = await describeFrame(frame('AAAA'), 'Where is Play?', { model: 'claude-opus-5' });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.answer).toBe('The Play button is in the ribbon,\ncentre-top.');
    expect(outcome.model).toBe('claude-opus-4-8');
    expect(outcome.requested_model).toBe('claude-opus-5');
    expect(outcome.fallback).toBe(true);
    expect(outcome.truncated).toBe(true);
    expect(outcome.stop_reason).toBe('max_tokens');
  });

  it('surfaces stop_details on a refusal instead of trusting the text', async () => {
    createMock.mockResolvedValueOnce(
      message('partial', {
        stop_reason: 'refusal',
        stop_details: { category: 'general_harms', explanation: 'declined', fallback_credit_token: null } as never,
      }),
    );
    const outcome = await describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('refusal');
    expect(outcome.stop_details).toEqual({ category: 'general_harms', explanation: 'declined' });
    expect(outcome.answer).toBe('partial');
    expect(outcome.retryable).toBe(false);
    expect(outcome.message).toContain('general_harms');
    expect(outcome.message).toContain('declined');
  });

  it('tells the user how to authenticate on a 401', async () => {
    createMock.mockRejectedValueOnce(apiError(Anthropic.AuthenticationError, 401, 'authentication_error', 'invalid x-api-key'));
    const outcome = await describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5' });
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('auth');
    expect(outcome.status).toBe(401);
    expect(outcome.message).toContain('ANTHROPIC_API_KEY');
    expect(outcome.message).toContain('ant auth login');
    expect(outcome.message).toContain(AUTH_HINT);
    expect(outcome.message).toContain('re-read on the next call');
    expect(outcome.message).toContain('invalid x-api-key');
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('drops the shared client after an auth failure so a credential fixed afterwards is picked up without a restart', async () => {
    createMock.mockRejectedValueOnce(apiError(Anthropic.AuthenticationError, 401, 'authentication_error', 'invalid x-api-key')).mockResolvedValue(message('ok'));
    await describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5' });
    expect(constructMock).toHaveBeenCalledTimes(1);
    const fixed = await describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5' });
    expect(fixed.ok).toBe(true);
    expect(constructMock).toHaveBeenCalledTimes(2); // rebuilt: the SDK resolves credentials at construction
    await describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5' });
    expect(constructMock).toHaveBeenCalledTimes(2); // and cached again once it works
  });

  it('maps an SDK request timeout to a retryable timeout failure', async () => {
    createMock.mockRejectedValueOnce(new Anthropic.APIConnectionTimeoutError());
    const outcome = await describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5' });
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('timeout');
    expect(outcome.retryable).toBe(true);
    expect(outcome.message).toContain('60 s');
  });

  it('cuts a hung call at the call budget with code timeout, distinct from a caller-side abort', async () => {
    hangUntilAborted();
    const outcome = await describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5', budgetMs: 5 });
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('timeout');
    expect(outcome.retryable).toBe(true);
    expect(outcome.message).toContain('budget');

    const controller = new AbortController();
    const pending = describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5', signal: controller.signal });
    controller.abort();
    const aborted = await pending;
    if (aborted.ok) throw new Error('expected failure');
    expect(aborted.code).toBe('aborted');
    expect(aborted.retryable).toBe(false);
  });

  it('resends once without fallbacks when the model rejects them, remembers that model, and leaves other 400s alone', async () => {
    createMock
      .mockRejectedValueOnce(apiError(Anthropic.BadRequestError, 400, 'invalid_request_error', 'fallbacks: this model has no fallback configuration'))
      .mockResolvedValueOnce(message('ok'))
      .mockResolvedValueOnce(message('again'));
    const logs: Array<[string, string]> = [];
    expect(fallbacksEnabledFor('claude-haiku-4-5')).toBe(true);
    const first = await describeFrame(frame('AAAA'), 'q', { model: 'claude-haiku-4-5', log: (level, msg) => logs.push([level, msg]) });
    expect(first.ok).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(2);
    const [withParams] = createMock.mock.calls[0] as [Record<string, unknown>];
    const [withoutParams] = createMock.mock.calls[1] as [Record<string, unknown>];
    expect(withParams.fallbacks).toBe('default');
    expect(withoutParams).not.toHaveProperty('fallbacks');
    expect(withoutParams).not.toHaveProperty('betas');
    expect(withoutParams.max_tokens).toBe(MAX_ANSWER_TOKENS);
    expect(logs).toEqual([['warn', expect.stringContaining('fallbacks')]]);
    expect(fallbacksEnabledFor('claude-haiku-4-5')).toBe(false);
    expect(fallbacksEnabledFor('claude-opus-5')).toBe(true);

    // The next call to that model skips the 400 entirely.
    await describeFrame(frame('AAAA'), 'q', { model: 'claude-haiku-4-5' });
    expect(createMock).toHaveBeenCalledTimes(3);
    expect((createMock.mock.calls[2] as [Record<string, unknown>])[0]).not.toHaveProperty('fallbacks');

    // An unrelated 400 is reported, not retried.
    createMock.mockRejectedValueOnce(apiError(Anthropic.BadRequestError, 400, 'invalid_request_error', 'image too large'));
    const other = await describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5' });
    expect(other.ok).toBe(false);
    expect(createMock).toHaveBeenCalledTimes(4);

    resetClient();
    expect(fallbacksEnabledFor('claude-haiku-4-5')).toBe(true);
  });

  it('gives the same guidance when the SDK finds no credential at all', async () => {
    createMock.mockRejectedValueOnce(new Error('Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set.'));
    const outcome = await describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5' });
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('auth');
    expect(outcome.message).toContain('ant auth login');
  });

  it('retries a 429 once after the retry-after delay, then succeeds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    createMock
      .mockRejectedValueOnce(apiError(Anthropic.RateLimitError, 429, 'rate_limit_error', 'slow down', { 'retry-after': '2' }))
      .mockResolvedValueOnce(message('fine now'));
    const pending = describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5' });
    await flush();
    expect(createMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(createMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(createMock).toHaveBeenCalledTimes(2);
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.answer).toBe('fine now');
  });

  it('reports a rate limit that persists after the single retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    createMock.mockRejectedValue(apiError(Anthropic.RateLimitError, 429, 'rate_limit_error', 'slow down'));
    const pending = describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5' });
    await flush();
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    const outcome = await pending;
    expect(createMock).toHaveBeenCalledTimes(2);
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('rate_limited');
    expect(outcome.status).toBe(429);
    expect(outcome.retryable).toBe(true);
    expect(outcome.message).toContain('429');
  });

  it('maps the other typed errors to codes with status and message', async () => {
    createMock.mockRejectedValueOnce(apiError(Anthropic.NotFoundError, 404, 'not_found_error', 'model: claude-nope'));
    let outcome = await describeFrame(frame('AAAA'), 'q', { model: 'claude-nope' });
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('bad_model');
    expect(outcome.message).toContain("'claude-nope'");
    expect(outcome.message).toContain('STUDIO_LIVE_VISION_MODEL');

    createMock.mockRejectedValueOnce(apiError(Anthropic.InternalServerError, 529, 'overloaded_error', 'Overloaded'));
    outcome = await describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5' });
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('api_error');
    expect(outcome.status).toBe(529);
    expect(outcome.retryable).toBe(true);
    expect(outcome.message).toContain('529');
    expect(outcome.message).toContain('Overloaded');

    createMock.mockRejectedValueOnce(apiError(Anthropic.BadRequestError, 400, 'invalid_request_error', 'image too large'));
    outcome = await describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5' });
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('bad_request');
    expect(outcome.status).toBe(400);
    expect(outcome.message).toContain('image too large');

    createMock.mockRejectedValueOnce(new Anthropic.APIConnectionError({ message: 'ECONNRESET' }));
    outcome = await describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5' });
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('connection');
    expect(outcome.retryable).toBe(true);

    createMock.mockRejectedValueOnce(new Anthropic.APIUserAbortError());
    outcome = await describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5' });
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('aborted');
  });

  it('passes the caller abort signal through to the SDK (composed with the call budget)', async () => {
    const controller = new AbortController();
    createMock.mockResolvedValueOnce(message('ok'));
    await describeFrame(frame('AAAA'), 'q', { model: 'claude-opus-5', signal: controller.signal });
    const [, options] = createMock.mock.calls[0] as [unknown, { signal: AbortSignal }];
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
    controller.abort();
    expect(options.signal.aborted).toBe(true);
  });
});
