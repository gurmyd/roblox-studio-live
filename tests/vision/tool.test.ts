import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_MAX_WIDTH,
  listWatches,
  lookToolDescription,
  lookToolName,
  lookToolShape,
  runLookTool,
  stopAllWatches,
} from '../../bridge/src/vision/index.js';
import { resetClient } from '../../bridge/src/vision/model.js';
import { compileStopWhen } from '../../bridge/src/vision/watch.js';
import { apiError, createMock, flush, frame, makeContext, message, noise, parse } from './helpers.js';

vi.mock('@anthropic-ai/sdk', async (importOriginal) => (await import('./helpers.js')).mockedSdk(importOriginal as never));

const F1 = noise(60_000, 101);
const F2 = noise(60_000, 102);
const F3 = noise(60_000, 103);

beforeEach(() => {
  createMock.mockReset();
  resetClient();
  delete process.env.STUDIO_LIVE_VISION_MODEL;
  delete process.env.STUDIO_LIVE_WATCH_MODEL;
  // These tests cover the API provider; the CLI provider (and auto selection) is tested in cli.test.ts / provider.test.ts.
  process.env.STUDIO_LIVE_VISION_PROVIDER = 'api';
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  await stopAllWatches();
  vi.useRealTimers();
  delete process.env.STUDIO_LIVE_VISION_PROVIDER;
});

describe('tool surface', () => {
  it('exports the look tool with a description under Claude Code’s 2 KB limit', () => {
    expect(lookToolName).toBe('look');
    expect(Buffer.byteLength(lookToolDescription)).toBeLessThan(2000);
    expect(Object.keys(lookToolShape).sort()).toEqual(['list', 'max_width', 'model', 'question', 'region', 'stop', 'watch']);
    for (const value of Object.values(lookToolShape)) expect(value).toBeInstanceOf(z.ZodType);
    expect(DEFAULT_MAX_WIDTH).toBe(768);
  });

  it('rejects bad arguments and an empty call with bad_request', async () => {
    const { ctx } = makeContext([frame(F1)]);
    let result = await runLookTool({ watch: { question: 'q', interval_s: 1 } }, ctx);
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: { code: 'bad_request' } });
    expect((parse(result).error as { message: string }).message).toContain('interval_s');

    result = await runLookTool({}, ctx);
    expect(result.isError).toBe(true);
    expect((parse(result).error as { message: string }).message).toContain('question');

    result = await runLookTool({ question: 'q', max_width: 16 }, ctx);
    expect(parse(result)).toMatchObject({ error: { code: 'bad_request' } });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('compiles stop_when as a substring or a /regex/', () => {
    expect(compileStopWhen('Door Open')('the door open now')).toBe(true);
    expect(compileStopWhen('door open')('closed')).toBe(false);
    expect(compileStopWhen('/health:\\s*0/i')('Health: 0 shown')).toBe(true);
    expect(compileStopWhen('/^yes/')('yes, visible')).toBe(true);
    expect(compileStopWhen('/^yes/')('no')).toBe(false);
    expect(() => compileStopWhen('/(/')).toThrow(RangeError);
  });
});

describe('one-shot look', () => {
  it('captures at 768 px, asks the look model and returns a text answer with usage', async () => {
    createMock.mockResolvedValueOnce(message('Yes: "attempt to index nil" in red in the Output panel.'));
    const { ctx, captures } = makeContext([frame(F1, { path: 'C:\\frames\\one.jpg', captured_ms: 37 })]);
    const result = await runLookTool({ question: 'Any error in Output?' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(captures).toEqual([{ maxWidth: 768, format: 'jpeg', region: undefined }]);
    const [params] = createMock.mock.calls[0] as [Record<string, unknown>];
    expect(params.model).toBe('claude-opus-5');
    const body = parse(result);
    expect(body.answer).toBe('Yes: "attempt to index nil" in red in the Output panel.');
    expect(body.model).toBe('claude-opus-5');
    expect(body.provider).toBe('api');
    expect(body.captured_ms).toBe(37);
    expect(body.usage).toEqual({ input_tokens: 512, output_tokens: 24 });
    expect(body.frame_path).toBe('C:\\frames\\one.jpg');
    expect(typeof body.model_ms).toBe('number');
    expect(body).not.toHaveProperty('requested_model');
  });

  it('passes max_width, region and a model override through', async () => {
    createMock.mockResolvedValueOnce(message('ok', { model: 'claude-sonnet-5' }));
    const { ctx, captures } = makeContext([frame(F1)]);
    const result = await runLookTool({ question: 'q', max_width: 1024, region: { x: 10, y: 20, w: 300, h: 200 }, model: 'claude-sonnet-5' }, ctx);
    expect(captures[0]).toEqual({ maxWidth: 1024, format: 'jpeg', region: { x: 10, y: 20, w: 300, h: 200 } });
    const [params] = createMock.mock.calls[0] as [Record<string, unknown>];
    expect(params.model).toBe('claude-sonnet-5');
    expect(parse(result).model).toBe('claude-sonnet-5');
  });

  it('honours STUDIO_LIVE_VISION_MODEL', async () => {
    process.env.STUDIO_LIVE_VISION_MODEL = 'claude-sonnet-5';
    createMock.mockResolvedValueOnce(message('ok'));
    const { ctx } = makeContext([frame(F1)]);
    await runLookTool({ question: 'q' }, ctx);
    const [params] = createMock.mock.calls[0] as [Record<string, unknown>];
    expect(params.model).toBe('claude-sonnet-5');
  });

  it('explains a max_tokens cut, including when thinking consumed the whole budget before any text', async () => {
    createMock.mockResolvedValueOnce(message('', { stop_reason: 'max_tokens', content: [], usage: { input_tokens: 600, output_tokens: 4096 } }));
    const { ctx } = makeContext([frame(F1)]);
    const body = parse(await runLookTool({ question: 'q' }, ctx));
    expect(body.answer).toBe('');
    expect(body.truncated).toBe(true);
    expect(String(body.note)).toContain('4096');
    expect(String(body.note)).toContain('no text was produced');
    expect(body.usage).toEqual({ input_tokens: 600, output_tokens: 4096 });
  });

  it('reports capture failures by their code without calling the model', async () => {
    const { ctx } = makeContext([
      () => {
        const err = new Error('Studio window is minimized') as Error & { code: string };
        err.code = 'minimized';
        throw err;
      },
    ]);
    const result = await runLookTool({ question: 'q' }, ctx);
    expect(result.isError).toBe(true);
    expect(parse(result)).toEqual({ error: { code: 'minimized', message: 'Studio window is minimized' } });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('returns auth guidance and refusal details as tool errors', async () => {
    createMock.mockRejectedValueOnce(apiError(Anthropic.AuthenticationError, 401, 'authentication_error', 'invalid x-api-key'));
    const { ctx, logs } = makeContext([frame(F1)]);
    let result = await runLookTool({ question: 'q' }, ctx);
    expect(result.isError).toBe(true);
    let error = parse(result).error as { code: string; message: string; status: number };
    expect(error.code).toBe('auth');
    expect(error.status).toBe(401);
    expect(error.message).toContain('ANTHROPIC_API_KEY');
    expect(error.message).toContain('ant auth login');
    expect(logs.some((l) => l.level === 'warn')).toBe(true);

    createMock.mockResolvedValueOnce(
      message('', { stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: 'no', fallback_credit_token: null } as never }),
    );
    result = await runLookTool({ question: 'q' }, ctx);
    expect(result.isError).toBe(true);
    error = parse(result).error as { code: string; message: string; status: number };
    expect(error.code).toBe('refusal');
    expect(parse(result).error).toMatchObject({ stop_details: { category: 'cyber', explanation: 'no' } });
  });
});

describe('watch', () => {
  it('analyses the first frame at once, then every interval, and emits one vision event per analysed frame', async () => {
    createMock.mockResolvedValueOnce(message('door closed')).mockResolvedValueOnce(message('door still closed'));
    const { ctx, events, captures } = makeContext([frame(F1, { path: 'C:\\frames\\a.jpg' }), frame(F2, { path: 'C:\\frames\\b.jpg' })]);
    const result = await runLookTool({ watch: { question: 'Is the door open?', interval_s: 2, max_frames: 2 }, max_width: 512 }, ctx);
    expect(result.isError).toBeUndefined();
    const started = parse(result);
    expect(started.watch_id).toMatch(/^w-\d+$/);
    expect(started).toMatchObject({ model: 'claude-sonnet-5', provider: 'api', interval_s: 2, max_frames: 2, diff_only: true, stop_when: null, max_width: 512 });
    expect(started).not.toHaveProperty('interval_clamped');
    const id = started.watch_id as string;

    await flush();
    expect(captures).toEqual([{ maxWidth: 512, format: 'jpeg', region: undefined }]);
    expect(createMock).toHaveBeenCalledTimes(1);
    const [params] = createMock.mock.calls[0] as [Record<string, unknown>];
    expect(params.model).toBe('claude-sonnet-5');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'vision', watch_id: id, frame: 1, answer: 'door closed', changed: true, provider: 'api', frame_path: 'C:\\frames\\a.jpg', usage: { input_tokens: 512, output_tokens: 24 } });
    expect(events[0]).not.toHaveProperty('note');

    const listed = parse(await runLookTool({ list: true }, ctx)).watches as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ watch_id: id, frames: 1, analysed: 1, skipped: 0, errors: 0, last_answer: 'door closed', in_flight: false });

    await vi.advanceTimersByTimeAsync(1999);
    expect(captures).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(captures).toHaveLength(2);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({ type: 'vision', watch_id: id, frame: 2, answer: 'door still closed', changed: true });
    expect(events[2]).toMatchObject({ type: 'vision', watch_id: id, done: true, reason: 'max_frames', frames: 2, analysed: 2, skipped: 0, errors: 0 });
    expect(listWatches()).toEqual([]);
  });

  it('skips unchanged frames with diff_only (no model call, no event) and compares against the last analysed frame', async () => {
    createMock.mockResolvedValueOnce(message('first')).mockResolvedValueOnce(message('third'));
    const { ctx, events } = makeContext([frame(F1), frame(F1), frame(F3)]);
    const id = parse(await runLookTool({ watch: { question: 'q', interval_s: 2, max_frames: 3 } }, ctx)).watch_id as string;
    await flush();
    expect(createMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    const listed = parse(await runLookTool({ list: true }, ctx)).watches as Array<Record<string, unknown>>;
    expect(listed[0]).toMatchObject({ watch_id: id, frames: 2, analysed: 1, skipped: 1 });

    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({ frame: 3, answer: 'third', changed: true });
    expect(events[2]).toMatchObject({ done: true, reason: 'max_frames', frames: 3, analysed: 2, skipped: 1 });
  });

  it('analyses every frame when diff_only is false', async () => {
    createMock.mockResolvedValue(message('same'));
    const { ctx, events } = makeContext([frame(F1)]);
    await runLookTool({ watch: { question: 'q', interval_s: 2, max_frames: 3, diff_only: false } }, ctx);
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(events.map((e) => e.frame)).toEqual([1, 2, 3, undefined]);
    expect(events[1]).toMatchObject({ changed: false });
    expect(events[3]).toMatchObject({ done: true, reason: 'max_frames', analysed: 3, skipped: 0 });
  });

  it('stops when the answer matches stop_when', async () => {
    createMock.mockResolvedValueOnce(message('The door is closed.')).mockResolvedValueOnce(message('Now the DOOR is OPEN.'));
    const { ctx, events } = makeContext([frame(F1), frame(F2), frame(F3)]);
    const id = parse(await runLookTool({ watch: { question: 'q', interval_s: 3, max_frames: 60, stop_when: 'door is open' } }, ctx)).watch_id as string;
    await flush();
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({ watch_id: id, frame: 2, answer: 'Now the DOOR is OPEN.' });
    expect(events[2]).toMatchObject({ watch_id: id, done: true, reason: 'stop_when', frames: 2, analysed: 2 });
    expect(listWatches()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('supports a /regex/ stop_when and rejects an invalid one up front', async () => {
    createMock.mockResolvedValueOnce(message('Health: 0'));
    const { ctx, events } = makeContext([frame(F1)]);
    const bad = await runLookTool({ watch: { question: 'q', stop_when: '/(/' } }, ctx);
    expect(bad.isError).toBe(true);
    expect(parse(bad)).toMatchObject({ error: { code: 'bad_request' } });
    await runLookTool({ watch: { question: 'q', stop_when: '/health:\\s*0/i' } }, ctx);
    await flush();
    expect(events.at(-1)).toMatchObject({ done: true, reason: 'stop_when' });
  });

  it('emits an error event and keeps going when a model call fails, then gives up after three in a row', async () => {
    createMock
      .mockRejectedValueOnce(apiError(Anthropic.InternalServerError, 529, 'overloaded_error', 'Overloaded'))
      .mockResolvedValueOnce(message('recovered'))
      .mockRejectedValue(apiError(Anthropic.InternalServerError, 500, 'api_error', 'boom'));
    // Every frame differs, so diff_only never skips one and each failure counts.
    const { ctx, events } = makeContext([frame(F1), frame(F2), frame(F3), frame(noise(60_000, 104)), frame(noise(60_000, 105)), frame(noise(60_000, 106))]);
    const id = parse(await runLookTool({ watch: { question: 'q', interval_s: 2, max_frames: 60 } }, ctx)).watch_id as string;
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'vision', watch_id: id, frame: 1, error: { code: 'api_error', status: 529 } });
    expect((events[0]!.error as { message: string }).message).toContain('Overloaded');
    expect(listWatches()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(events[1]).toMatchObject({ frame: 2, answer: 'recovered' });
    expect(listWatches()[0]).toMatchObject({ errors: 1, analysed: 1 });

    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
    }
    expect(events.filter((e) => e.error)).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ done: true, reason: 'error', frames: 5, analysed: 1, errors: 4 });
    expect(listWatches()).toEqual([]);
  });

  it('ends immediately on an authentication failure', async () => {
    createMock.mockRejectedValueOnce(apiError(Anthropic.AuthenticationError, 401, 'authentication_error', 'invalid x-api-key'));
    const { ctx, events } = makeContext([frame(F1)]);
    await runLookTool({ watch: { question: 'q' } }, ctx);
    await flush();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ frame: 1, error: { code: 'auth', status: 401 } });
    expect((events[0]!.error as { message: string }).message).toContain('ant auth login');
    expect(events[1]).toMatchObject({ done: true, reason: 'error', errors: 1 });
    expect(listWatches()).toEqual([]);
  });

  it('turns an unexpected throw inside a frame into an internal error event instead of an unhandled rejection', async () => {
    createMock.mockResolvedValue(message('ok'));
    // A capture result without base64 makes frameSignature throw a TypeError inside tick().
    const broken = { ...frame(F1), base64: undefined as unknown as string };
    const { ctx, events, logs } = makeContext([broken, frame(F2)]);
    await runLookTool({ watch: { question: 'q', interval_s: 2, max_frames: 2 } }, ctx);
    await flush();
    expect(events[0]).toMatchObject({ frame: 1, error: { code: 'internal' } });
    expect((events[0]!.error as { message: string }).message).toContain('crashed');
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('frame failed'))).toBe(true);
    expect(listWatches()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(events[1]).toMatchObject({ frame: 2, answer: 'ok' });
    expect(events[2]).toMatchObject({ done: true, reason: 'max_frames', errors: 1, analysed: 1 });
    expect(listWatches()).toEqual([]);
  });

  it('treats a capture failure like a model failure', async () => {
    createMock.mockResolvedValue(message('ok'));
    const { ctx, events } = makeContext([
      () => {
        const err = new Error('no Studio window') as Error & { code: string };
        err.code = 'no_window';
        throw err;
      },
      frame(F1),
    ]);
    await runLookTool({ watch: { question: 'q', interval_s: 2, max_frames: 2 } }, ctx);
    await flush();
    expect(events[0]).toMatchObject({ frame: 1, error: { code: 'no_window', message: 'no Studio window' } });
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(events[1]).toMatchObject({ frame: 2, answer: 'ok' });
    expect(events[2]).toMatchObject({ done: true, reason: 'max_frames', errors: 1, analysed: 1 });
  });

  it('stops one watch by id, all watches with "all", and reports unknown ids', async () => {
    createMock.mockResolvedValue(message('ok'));
    const { ctx, events } = makeContext([frame(F1)]);
    const a = parse(await runLookTool({ watch: { question: 'a', interval_s: 5 } }, ctx)).watch_id as string;
    const b = parse(await runLookTool({ watch: { question: 'b', interval_s: 5 } }, ctx)).watch_id as string;
    await flush();
    expect(listWatches().map((w) => w.watch_id)).toEqual([a, b]);

    expect(parse(await runLookTool({ stop: a }, ctx))).toEqual({ stopped: [a] });
    expect(events.filter((e) => e.done)).toEqual([expect.objectContaining({ watch_id: a, reason: 'stopped' })]);
    expect(listWatches().map((w) => w.watch_id)).toEqual([b]);

    const missing = await runLookTool({ stop: a }, ctx);
    expect(missing.isError).toBe(true);
    expect(parse(missing)).toMatchObject({ error: { code: 'not_found' } });

    expect(parse(await runLookTool({ stop: 'all' }, ctx))).toEqual({ stopped: [b] });
    expect(listWatches()).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight model call on stop without emitting an error', async () => {
    createMock.mockImplementation(
      (_params: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()), { once: true });
        }),
    );
    const { ctx, events } = makeContext([frame(F1)]);
    const id = parse(await runLookTool({ watch: { question: 'q' } }, ctx)).watch_id as string;
    await flush();
    expect(listWatches()[0]).toMatchObject({ watch_id: id, in_flight: true });

    const stopped = await runLookTool({ stop: id }, ctx);
    expect(parse(stopped)).toEqual({ stopped: [id] });
    expect(events).toEqual([expect.objectContaining({ type: 'vision', watch_id: id, done: true, reason: 'stopped', frames: 1, analysed: 0, errors: 0 })]);
    expect(listWatches()).toEqual([]);
  });

  it('refuses a fifth concurrent watch', async () => {
    createMock.mockResolvedValue(message('ok'));
    const { ctx } = makeContext([frame(F1)]);
    for (let i = 0; i < 4; i += 1) expect((await runLookTool({ watch: { question: 'q' } }, ctx)).isError).toBeUndefined();
    const fifth = await runLookTool({ watch: { question: 'q' } }, ctx);
    expect(fifth.isError).toBe(true);
    expect((parse(fifth).error as { message: string }).message).toContain('at most 4');
  });

  it('stopAllWatches ends every loop and resolves', async () => {
    createMock.mockResolvedValue(message('ok'));
    const { ctx, events } = makeContext([frame(F1)]);
    await runLookTool({ watch: { question: 'a', interval_s: 5 } }, ctx);
    await runLookTool({ watch: { question: 'b', interval_s: 5 } }, ctx);
    await flush();
    await stopAllWatches();
    expect(listWatches()).toEqual([]);
    expect(events.filter((e) => e.done).map((e) => e.reason)).toEqual(['stopped', 'stopped']);
    await stopAllWatches();
  });

  it('survives an event sink that throws', async () => {
    createMock.mockResolvedValue(message('ok'));
    const { ctx, logs } = makeContext([frame(F1)]);
    ctx.emit = () => {
      throw new Error('sink closed');
    };
    await runLookTool({ watch: { question: 'q', max_frames: 1 } }, ctx);
    await flush();
    expect(listWatches()).toEqual([]);
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('sink'))).toBe(true);
  });
});
