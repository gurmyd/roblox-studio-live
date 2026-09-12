/**
 * The claude-cli provider against a fake `claude` on PATH (see installFakeClaude in helpers):
 * real spawn, real shim, real stdin, real JSON parsing, real timeouts — no Anthropic SDK, no
 * network. Real timers throughout (child processes and fake timers do not mix).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CLI_MIN_INTERVAL_S,
  CLI_TIMEOUT_MS,
  DEFAULT_CLI_LOOK_MODEL,
  DEFAULT_CLI_WATCH_MODEL,
  cliArgs,
  cliPrompt,
  classifyCliText,
  describeFrameWithCli,
  isValidModel,
  parseCliOutput,
} from '../../bridge/src/vision/cli.js';
import { SYSTEM_PROMPT, describeFrame, invalidModelSource, resolveModel } from '../../bridge/src/vision/model.js';
import { NO_PROVIDER_HINT, PROVIDER_ENV, resetProviderCache } from '../../bridge/src/vision/provider.js';
import { listWatches, lookToolDescription, runLookTool, stopAllWatches } from '../../bridge/src/vision/tool.js';
import { installFakeClaude, frame, makeContext, noise, parse, samePath, waitFor, type FakeClaude } from './helpers.js';

const ENV_KEYS = [
  'STUDIO_LIVE_VISION_PROVIDER',
  'STUDIO_LIVE_VISION_MODEL',
  'STUDIO_LIVE_WATCH_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_CONFIG_DIR',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
] as const;

const originalPath = process.env.PATH;
let saved: Record<string, string | undefined> = {};
let fake: FakeClaude;
let emptyDir: string;
const F1 = noise(60_000, 201);

/** A frame whose folder exists (the CLI is spawned with cwd = the frame's folder). */
function cliFrame(): ReturnType<typeof frame> {
  return frame(F1, { path: path.join(fake.dir, 'frame-1.jpg'), captured_ms: 29 });
}

beforeAll(() => {
  fake = installFakeClaude();
  emptyDir = mkdtempSync(path.join(os.tmpdir(), 'studio-live-empty-'));
});

afterAll(() => {
  fake.cleanup();
  rmSync(emptyDir, { recursive: true, force: true });
});

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ANTHROPIC_CONFIG_DIR = emptyDir; // no SDK profile
  process.env.PATH = `${fake.dir}${path.delimiter}${originalPath ?? ''}`;
  resetProviderCache();
});

afterEach(async () => {
  await stopAllWatches();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  process.env.PATH = originalPath;
  resetProviderCache();
});

describe('constants and helpers', () => {
  it('uses the verified command line, the aliases as defaults, and a 120 s kill', () => {
    expect(cliArgs('haiku')).toEqual(['-p', '--model', 'haiku', '--output-format', 'json', '--allowedTools', 'Read', '--strict-mcp-config', '--no-session-persistence']);
    expect(DEFAULT_CLI_LOOK_MODEL).toBe('sonnet');
    expect(DEFAULT_CLI_WATCH_MODEL).toBe('haiku');
    expect(resolveModel('look', undefined, 'claude-cli')).toBe('sonnet');
    expect(resolveModel('watch', undefined, 'claude-cli')).toBe('haiku');
    expect(resolveModel('look', 'opus', 'claude-cli')).toBe('opus');
    process.env.STUDIO_LIVE_VISION_MODEL = 'claude-sonnet-5';
    process.env.STUDIO_LIVE_WATCH_MODEL = 'claude-haiku-4-5';
    expect(resolveModel('look', undefined, 'claude-cli')).toBe('claude-sonnet-5');
    expect(resolveModel('watch', undefined, 'claude-cli')).toBe('claude-haiku-4-5');
    expect(CLI_TIMEOUT_MS).toBe(120_000);
    expect(CLI_MIN_INTERVAL_S).toBe(15);
  });

  it('folds the system prompt into the user prompt and points at the absolute frame path', () => {
    const prompt = cliPrompt('C:\\frames\\f.jpg', 'Is the door open?');
    expect(prompt.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(prompt).toContain('not visible');
    expect(prompt.endsWith(`Read the image file ${path.resolve('C:\\frames\\f.jpg')} and answer: Is the door open?`)).toBe(true);
  });

  it('parses the result object, tolerating noise before it and the verbose array form', () => {
    expect(parseCliOutput('{"result":"a","is_error":false}')).toEqual({ result: 'a', is_error: false });
    expect(parseCliOutput('  \n{"result":"a"}\n')).toEqual({ result: 'a' });
    expect(parseCliOutput('warning: something\nanother line\n{"result":"b","num_turns":2}')).toEqual({ result: 'b', num_turns: 2 });
    expect(parseCliOutput('noise\n{\n "result": "multi",\n "is_error": false\n}')).toEqual({ result: 'multi', is_error: false });
    expect(parseCliOutput('[{"type":"system"},{"type":"result","result":"last"}]')).toEqual({ type: 'result', result: 'last' });
    expect(parseCliOutput('not json')).toBeNull();
    expect(parseCliOutput('')).toBeNull();
    expect(parseCliOutput('42')).toBeNull();
    expect(parseCliOutput('{"a":1} trailing garbage')).toBeNull();
  });

  it('classifies CLI error text into the permanent codes', () => {
    expect(classifyCliText('Not logged in. Please run /login')).toBe('auth');
    expect(classifyCliText('Invalid API key · Fix external API key')).toBe('auth');
    expect(classifyCliText('OAuth token has expired')).toBe('auth');
    expect(classifyCliText('You have been logged out')).toBe('auth');
    expect(classifyCliText('Please log in first')).toBe('auth');
    expect(classifyCliText("Model 'claude-nope' not found")).toBe('bad_model');
    expect(classifyCliText('API Error: 529 overloaded_error')).toBe('cli_error');
    expect(classifyCliText('unknown option --nope')).toBe('cli_error');
    // "login" inside another word is not an auth problem.
    expect(classifyCliText('Error: could not open the dialog in the viewport')).toBe('cli_error');
    expect(classifyCliText('catalog index is missing')).toBe('cli_error');
  });

  it('accepts ids and aliases as models and refuses anything that could not be one (it ends up on a command line)', () => {
    for (const ok of ['haiku', 'sonnet', 'opus', 'opus[1m]', 'claude-opus-5', 'claude-sonnet-4-5-20250929', 'us.anthropic.claude-opus-4-5-20251101-v1:0', 'claude-opus-4-5@20251101']) {
      expect(isValidModel(ok), ok).toBe(true);
    }
    for (const bad of ['', ' sonnet', 'so net', 'sonnet & del *.*', 'a"b', '%PATH%', '-p', '--dangerously-skip-permissions', 'x'.repeat(101), 'haiku\nsonnet']) {
      expect(isValidModel(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(invalidModelSource('look')).toBeNull(); // the built-in defaults
    expect(invalidModelSource('watch')).toBeNull();
    expect(invalidModelSource('look', 'sonnet')).toBeNull();
    expect(invalidModelSource('look', 'so net')).toBe('the model argument');
    process.env.STUDIO_LIVE_WATCH_MODEL = 'ha|ku';
    expect(invalidModelSource('watch')).toBe('STUDIO_LIVE_WATCH_MODEL');
    expect(invalidModelSource('watch', 'haiku')).toBeNull(); // the argument wins, the env var is not consulted
    process.env.STUDIO_LIVE_VISION_MODEL = ' claude-opus-5 ';
    expect(invalidModelSource('look')).toBeNull(); // trimmed like resolveModel does
  });

  it('tells agents that a Claude Code login works too', () => {
    expect(lookToolDescription).toMatch(/Claude Code/);
    expect(lookToolDescription).toContain('STUDIO_LIVE_VISION_PROVIDER');
    expect(Buffer.byteLength(lookToolDescription)).toBeLessThan(2000);
  });
});

describe('describeFrame via the claude CLI', () => {
  it('spawns the shim with the model flag, the prompt on stdin, cwd = the frame folder, and maps the JSON result', async () => {
    const shot = cliFrame();
    const outcome = await describeFrame(shot, 'MODE:ok Is there an error in Output?', { provider: 'claude-cli', model: 'sonnet', cli: fake.exe });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.answer).toBe('answer from sonnet: one red line in the Output panel');
    expect(outcome.model).toBe('claude-cli:sonnet');
    expect(outcome.requested_model).toBe('claude-cli:sonnet');
    expect(outcome.provider).toBe('claude-cli');
    expect(outcome.model_ms).toBe(9156); // the CLI's own duration_ms
    expect(outcome.wall_ms).toBeGreaterThanOrEqual(0);
    expect(outcome.usage).toEqual({ cost_usd: 0.03, turns: 2, input_tokens: 1200, output_tokens: 40 });
    expect(outcome.stop_reason).toBe('success');
    expect(outcome.truncated).toBe(false);
    expect(outcome.fallback).toBe(false);

    const call = fake.lastCall();
    expect(call.argv).toEqual(cliArgs('sonnet'));
    expect(call.stdin).toBe(cliPrompt(shot.path, 'MODE:ok Is there an error in Output?'));
    expect(call.stdin).toContain(path.resolve(shot.path));
    expect(samePath(call.cwd, fake.dir)).toBe(true);
  });

  it('resolves the executable from PATH when none is given', async () => {
    const outcome = await describeFrameWithCli(cliFrame(), 'MODE:ok q', { model: 'haiku' });
    expect(outcome.ok).toBe(true);
    expect(fake.lastCall().argv).toContain('haiku');
  });

  it('takes the result after noise on stdout', async () => {
    const outcome = await describeFrame(cliFrame(), 'MODE:prefix q', { provider: 'claude-cli', model: 'sonnet', cli: fake.exe });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.answer).toBe('answer after a log line');
  });

  it('maps is_error to a failure: auth when the CLI is not logged in, a retryable cli_error for a transient API error', async () => {
    const auth = await describeFrame(cliFrame(), 'MODE:error q', { provider: 'claude-cli', model: 'sonnet', cli: fake.exe });
    if (auth.ok) throw new Error('expected failure');
    expect(auth.code).toBe('auth');
    expect(auth.retryable).toBe(false);
    expect(auth.provider).toBe('claude-cli');
    expect(auth.requested_model).toBe('claude-cli:sonnet');
    expect(auth.message).toContain('error_during_execution');
    expect(auth.message).toContain('Not logged in');
    expect(auth.message).toContain('log in');

    const busy = await describeFrame(cliFrame(), 'MODE:overloaded q', { provider: 'claude-cli', model: 'sonnet', cli: fake.exe });
    if (busy.ok) throw new Error('expected failure');
    expect(busy.code).toBe('cli_error');
    expect(busy.retryable).toBe(true);
    expect(busy.message).toContain('529');
  });

  it('reads the error text from error.message / errors[] when is_error comes without a result', async () => {
    const outcome = await describeFrame(cliFrame(), 'MODE:errfield q', { provider: 'claude-cli', model: 'sonnet', cli: fake.exe });
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('cli_error');
    expect(outcome.retryable).toBe(false);
    expect(outcome.message).toContain('error_max_turns');
    expect(outcome.message).toContain('Reached max turns (1); no answer was produced');
  });

  it('refuses a model string that could not be a model before spawning anything', async () => {
    const outcome = await describeFrame(cliFrame(), 'MODE:ok NEVER-SPAWNED', { provider: 'claude-cli', model: 'sonnet & echo pwned', cli: fake.exe });
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('bad_model');
    expect(outcome.retryable).toBe(false);
    expect(outcome.message).toContain('not a model id or alias');
    expect(outcome.requested_model).toBe('claude-cli:sonnet & echo pwned');
    let stdin = '';
    try {
      stdin = fake.lastCall().stdin;
    } catch {
      // no call recorded yet in this file
    }
    expect(stdin).not.toContain('NEVER-SPAWNED');
  });

  it('does not spawn at all when the caller has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await describeFrame(cliFrame(), 'MODE:ok PRE-ABORTED', { provider: 'claude-cli', model: 'sonnet', cli: fake.exe, signal: controller.signal });
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('aborted');
    let stdin = '';
    try {
      stdin = fake.lastCall().stdin;
    } catch {
      // no call recorded yet in this file
    }
    expect(stdin).not.toContain('PRE-ABORTED');
  });

  it('reports non-JSON output, a failing exit and an empty answer without throwing', async () => {
    const garbage = await describeFrame(cliFrame(), 'MODE:garbage q', { provider: 'claude-cli', model: 'sonnet', cli: fake.exe });
    if (garbage.ok) throw new Error('expected failure');
    expect(garbage.code).toBe('cli_bad_output');
    expect(garbage.message).toContain('this is not json at all');

    const exit2 = await describeFrame(cliFrame(), 'MODE:exit2 q', { provider: 'claude-cli', model: 'sonnet', cli: fake.exe });
    if (exit2.ok) throw new Error('expected failure');
    expect(exit2.code).toBe('cli_error');
    expect(exit2.message).toContain('exited 2');
    expect(exit2.message).toContain('unknown option --nope');
    expect(exit2.retryable).toBe(false);

    const empty = await describeFrame(cliFrame(), 'MODE:empty q', { provider: 'claude-cli', model: 'sonnet', cli: fake.exe });
    if (empty.ok) throw new Error('expected failure');
    expect(empty.code).toBe('cli_error');
    expect(empty.message).toContain('no answer');
  });

  it('kills a hung CLI at the budget with code timeout', async () => {
    const started = Date.now();
    const outcome = await describeFrame(cliFrame(), 'MODE:hang q', { provider: 'claude-cli', model: 'sonnet', cli: fake.exe, budgetMs: 700 });
    const elapsed = Date.now() - started;
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('timeout');
    expect(outcome.retryable).toBe(true);
    expect(outcome.message).toContain('killed');
    expect(outcome.message).toContain('1 s');
    expect(elapsed).toBeLessThan(6_000); // the 10 s fake never got to answer
  });

  it('kills the CLI when the caller aborts (a watch being stopped)', async () => {
    const controller = new AbortController();
    const pending = describeFrame(cliFrame(), 'MODE:hang q', { provider: 'claude-cli', model: 'sonnet', cli: fake.exe, signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    const outcome = await pending;
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('aborted');
    expect(outcome.retryable).toBe(false);
  });

  it('fails with cli_error when the executable cannot be started', async () => {
    const outcome = await describeFrame(cliFrame(), 'q', { provider: 'claude-cli', model: 'sonnet', cli: path.join(emptyDir, 'claude-missing.exe') });
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('cli_error');
    expect(outcome.message).toContain('could not start');
  });
});

describe('look tool on the claude-cli provider', () => {
  it('answers a one-shot look through the CLI with provider and cost in the result', async () => {
    process.env[PROVIDER_ENV] = 'claude-cli';
    const { ctx, logs } = makeContext([cliFrame()]);
    const result = await runLookTool({ question: 'MODE:ok Any error in Output?' }, ctx);
    expect(result.isError).toBeUndefined();
    const body = parse(result);
    expect(body.provider).toBe('claude-cli');
    expect(body.model).toBe('claude-cli:sonnet');
    expect(body).not.toHaveProperty('requested_model');
    expect(body.answer).toBe('answer from sonnet: one red line in the Output panel');
    expect(body.model_ms).toBe(9156);
    expect(typeof body.wall_ms).toBe('number');
    expect(body.usage).toEqual({ cost_usd: 0.03, turns: 2, input_tokens: 1200, output_tokens: 40 });
    expect(body.captured_ms).toBe(29);
    expect(logs.some((l) => l.level === 'debug' && l.msg === 'vision look' && l.data?.provider === 'claude-cli')).toBe(true);
  });

  it('is chosen by auto when no API credential resolves, and honours STUDIO_LIVE_VISION_MODEL', async () => {
    process.env.STUDIO_LIVE_VISION_MODEL = 'claude-haiku-4-5';
    const { ctx } = makeContext([cliFrame()]);
    const body = parse(await runLookTool({ question: 'MODE:ok q' }, ctx));
    expect(body.provider).toBe('claude-cli');
    expect(body.model).toBe('claude-cli:claude-haiku-4-5');
    expect(fake.lastCall().argv).toEqual(cliArgs('claude-haiku-4-5'));
  });

  it('answers bad_request for a malformed model from the argument or the env var, before capturing anything', async () => {
    process.env[PROVIDER_ENV] = 'claude-cli';
    const { ctx, captures } = makeContext([cliFrame()]);
    const arg = await runLookTool({ question: 'q', model: 'sonnet & del *.*' }, ctx);
    expect(arg.isError).toBe(true);
    expect(parse(arg)).toMatchObject({ error: { code: 'bad_request' } });
    expect((parse(arg).error as { message: string }).message).toContain('the model argument');

    process.env.STUDIO_LIVE_WATCH_MODEL = 'haiku"';
    const watch = await runLookTool({ watch: { question: 'q' } }, ctx);
    expect(watch.isError).toBe(true);
    expect(parse(watch)).toMatchObject({ error: { code: 'bad_request' } });
    expect((parse(watch).error as { message: string }).message).toContain('STUDIO_LIVE_WATCH_MODEL');

    expect(captures).toHaveLength(0);
    expect(listWatches()).toEqual([]);
  });

  it('returns CLI failures as tool errors with the provider', async () => {
    process.env[PROVIDER_ENV] = 'claude-cli';
    const { ctx } = makeContext([cliFrame()]);
    const result = await runLookTool({ question: 'MODE:error q' }, ctx);
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: { code: 'auth', provider: 'claude-cli', requested_model: 'claude-cli:sonnet' } });
    expect((parse(result).error as { frame_path: string }).frame_path).toContain('frame-1.jpg');
  });

  it('answers auth with the extended hint when neither a credential nor claude is available', async () => {
    process.env.PATH = emptyDir;
    const { ctx } = makeContext([cliFrame()]);
    const result = await runLookTool({ question: 'q' }, ctx);
    expect(result.isError).toBe(true);
    const error = parse(result).error as { code: string; message: string; frame_path: string };
    expect(error.code).toBe('auth');
    expect(error.message).toContain('ANTHROPIC_API_KEY');
    expect(error.message).toContain(NO_PROVIDER_HINT);
    expect(error.frame_path).toContain('frame-1.jpg');

    const watch = await runLookTool({ watch: { question: 'q' } }, ctx);
    expect(watch.isError).toBe(true);
    expect(parse(watch)).toMatchObject({ error: { code: 'auth' } });
    expect(listWatches()).toEqual([]);
  });

  it('clamps a watch interval up to 15 s, says so in the start result and the first event, and never overlaps calls', async () => {
    process.env[PROVIDER_ENV] = 'claude-cli';
    const { ctx, events, captures } = makeContext([cliFrame()]);
    const result = await runLookTool({ watch: { question: 'MODE:slow Is the door open?', interval_s: 2, max_frames: 5 } }, ctx);
    expect(result.isError).toBeUndefined();
    const started = parse(result);
    expect(started).toMatchObject({
      provider: 'claude-cli',
      model: 'claude-cli:haiku',
      interval_s: CLI_MIN_INTERVAL_S,
      interval_clamped: { requested: 2, min: CLI_MIN_INTERVAL_S },
      max_frames: 5,
    });
    expect(String(started.note)).toContain('raised from 2 to 15');
    const id = started.watch_id as string;

    // While the (slow) first call is in flight nothing else is captured or spawned.
    await waitFor(() => listWatches()[0]?.in_flight === true, 5_000, 'first call in flight');
    expect(captures).toHaveLength(1);
    expect(listWatches()[0]).toMatchObject({ watch_id: id, provider: 'claude-cli', model: 'claude-cli:haiku', interval_s: 15, frames: 1, analysed: 0 });

    await waitFor(() => events.length >= 1, 15_000, 'first vision event');
    expect(events[0]).toMatchObject({
      type: 'vision',
      watch_id: id,
      frame: 1,
      answer: 'slow answer from haiku',
      provider: 'claude-cli',
      model: 'claude-cli:haiku',
      model_ms: 9156,
      usage: { cost_usd: 0.03, turns: 2 },
    });
    expect(String(events[0]!.note)).toContain('raised from 2 to 15');
    expect(fake.lastCall().argv).toEqual(cliArgs('haiku'));
    expect(captures).toHaveLength(1); // the next capture is 15 s away
    expect(listWatches()[0]).toMatchObject({ frames: 1, analysed: 1, in_flight: false });

    expect(parse(await runLookTool({ stop: id }, ctx))).toEqual({ stopped: [id] });
    expect(events.at(-1)).toMatchObject({ done: true, reason: 'stopped', frames: 1, analysed: 1 });
    expect(events.filter((e) => e.note)).toHaveLength(1);
    expect(captures).toHaveLength(1);
  });

  it('defaults a CLI watch to the 15 s interval without a clamp note, and leaves longer intervals alone', async () => {
    process.env[PROVIDER_ENV] = 'claude-cli';
    const { ctx, events } = makeContext([cliFrame()]);
    const started = parse(await runLookTool({ watch: { question: 'MODE:ok q' } }, ctx));
    expect(started).toMatchObject({ interval_s: 15, provider: 'claude-cli' });
    expect(started).not.toHaveProperty('interval_clamped');
    await waitFor(() => events.length >= 1, 15_000, 'first vision event');
    expect(events[0]).not.toHaveProperty('note');
    await runLookTool({ stop: started.watch_id as string }, ctx);

    const longer = parse(await runLookTool({ watch: { question: 'MODE:ok q', interval_s: 30 } }, ctx));
    expect(longer).toMatchObject({ interval_s: 30 });
    expect(longer).not.toHaveProperty('interval_clamped');
    await runLookTool({ stop: longer.watch_id as string }, ctx);
  });
});
