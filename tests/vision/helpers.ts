/**
 * Shared fixtures for the vision tests: a partial mock of '@anthropic-ai/sdk' whose default
 * export is a fake client (so `client.beta.messages.create` is `createMock`) but whose typed
 * error classes are the real ones, so `instanceof Anthropic.AuthenticationError` still works.
 *
 * Test files register it with
 *   vi.mock('@anthropic-ai/sdk', async (importOriginal) => (await import('./helpers.js')).mockedSdk(importOriginal));
 */
import type Anthropic from '@anthropic-ai/sdk';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { CaptureLike, CaptureRequest, VisionContext, VisionEvent } from '../../bridge/src/vision/types.js';

type SdkModule = typeof import('@anthropic-ai/sdk');

export const createMock = vi.fn();
/** Called once per `new Anthropic()` so tests can see when the shared client is rebuilt. */
export const constructMock = vi.fn();

const ERROR_CLASSES = [
  'AnthropicError',
  'APIError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'APIUserAbortError',
  'NotFoundError',
  'ConflictError',
  'RateLimitError',
  'BadRequestError',
  'AuthenticationError',
  'InternalServerError',
  'PermissionDeniedError',
  'UnprocessableEntityError',
] as const;

export async function mockedSdk(importOriginal: () => Promise<SdkModule>): Promise<SdkModule> {
  const actual = await importOriginal();
  const Real = actual.default as unknown as Record<string, unknown>;
  class MockAnthropic {
    beta = { messages: { create: createMock } };
    constructor(...args: unknown[]) {
      constructMock(...args);
    }
  }
  for (const name of ERROR_CLASSES) (MockAnthropic as unknown as Record<string, unknown>)[name] = Real[name];
  return { ...actual, default: MockAnthropic as unknown as SdkModule['default'] };
}

export interface MessageOverrides {
  content?: Anthropic.Beta.BetaContentBlock[];
  model?: string;
  stop_reason?: Anthropic.Beta.BetaStopReason;
  stop_details?: Anthropic.Beta.BetaRefusalStopDetails | null;
  usage?: Partial<Anthropic.Beta.BetaUsage>;
}

/** A minimal BetaMessage; only the fields the sidecar reads are meaningful. */
export function message(text: string, overrides: MessageOverrides = {}): Anthropic.Beta.BetaMessage {
  const usage = { input_tokens: 512, output_tokens: 24, iterations: null, ...overrides.usage };
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: overrides.model ?? 'claude-opus-5',
    content: overrides.content ?? [{ type: 'text', text, citations: null }],
    stop_reason: overrides.stop_reason ?? 'end_turn',
    stop_sequence: null,
    stop_details: overrides.stop_details ?? null,
    usage,
  } as unknown as Anthropic.Beta.BetaMessage;
}

export function apiError<T extends new (...args: never[]) => InstanceType<typeof Anthropic.APIError>>(
  cls: T,
  status: number,
  type: string,
  msg: string,
  headers: Record<string, string> = {},
): InstanceType<T> {
  const Ctor = cls as unknown as new (status: number, error: unknown, message: string, headers: Headers) => InstanceType<T>;
  return new Ctor(status, { type, message: msg }, msg, new Headers(headers));
}

let frameSeq = 0;

export function frame(base64: string, extra: Partial<CaptureLike> = {}): CaptureLike {
  frameSeq += 1;
  return {
    path: `C:\\frames\\frame-${frameSeq}.jpg`,
    width: 768,
    height: 480,
    bytes: Math.floor((base64.length * 3) / 4),
    mimeType: 'image/jpeg',
    base64,
    windowTitle: 'Place1 - Roblox Studio',
    captured_ms: 31,
    ...extra,
  };
}

/** Deterministic pseudo-random base64-ish text so two "different" frames share nothing. */
export function noise(length: number, seed: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let state = seed >>> 0 || 1;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out += alphabet[(state >>> 16) & 63];
  }
  return out;
}

export interface LogLine {
  level: string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface TestContext {
  ctx: VisionContext;
  events: VisionEvent[];
  captures: CaptureRequest[];
  logs: LogLine[];
  /** Frames handed out in order; the last one repeats. A function entry is called (may throw). */
  frames: Array<CaptureLike | (() => CaptureLike | Promise<CaptureLike>)>;
}

export function makeContext(frames: TestContext['frames']): TestContext {
  const events: VisionEvent[] = [];
  const captures: CaptureRequest[] = [];
  const logs: LogLine[] = [];
  let index = 0;
  const ctx: VisionContext = {
    async capture(opts) {
      captures.push(opts);
      const entry = frames[Math.min(index, frames.length - 1)];
      index += 1;
      if (entry === undefined) throw new Error('no frame configured');
      return typeof entry === 'function' ? entry() : entry;
    },
    emit(event) {
      events.push(event);
    },
    log(level, msg, data) {
      logs.push({ level, msg, data });
    },
  };
  return { ctx, events, captures, logs, frames };
}

/** Lets pending promise chains (mock resolutions, awaited captures) run while timers are faked. */
export async function flush(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

export function parse(result: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

/**
 * A stand-in for the Claude Code CLI: a node script behind a `claude.cmd` (Windows) or `claude`
 * (POSIX) shim, so the provider's PATH lookup, shim handling, stdin prompt and JSON parsing all
 * run for real. It reads the prompt from stdin, records {argv, stdin, cwd} in capture.json next
 * to itself, and behaves according to a `MODE:<name>` marker in the prompt:
 *
 *   ok (default) → a success result naming the --model it was given
 *   prefix       → a log line, then the success result
 *   error        → is_error:true, "Not logged in" (the CLI's own wording)
 *   errfield     → is_error:true with no result: the text is in `error.message` and `errors[]`
 *   overloaded   → is_error:true with a transient API error
 *   empty        → success with an empty result
 *   garbage      → plain text, exit 0
 *   exit2        → stderr noise, exit 2
 *   hang         → no output for 10 s (for timeout / kill / abort tests)
 *   slow         → the success result after 400 ms
 */
const FAKE_CLAUDE_SOURCE = `
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const argv = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', main);
function ok(result, extra = {}) {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 9156, duration_api_ms: 8100, num_turns: 2, result, session_id: 'fake-session', total_cost_usd: 0.03, usage: { input_tokens: 1200, output_tokens: 40 }, ...extra });
}
function main() {
  writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'capture.json'), JSON.stringify({ argv, stdin, cwd: process.cwd() }));
  const model = argv[argv.indexOf('--model') + 1];
  const mode = (/MODE:([a-z0-9]+)/.exec(stdin) || [])[1] || 'ok';
  switch (mode) {
    case 'prefix': process.stdout.write('[fake] warming up\\n' + ok('answer after a log line')); break;
    case 'error': process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in. Please run /login', duration_ms: 420, num_turns: 1, total_cost_usd: 0 })); break;
    case 'overloaded': process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 overloaded_error', duration_ms: 900, num_turns: 1, total_cost_usd: 0 })); break;
    case 'errfield': process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, error: { message: 'Reached max turns (1)' }, errors: ['no answer was produced'], duration_ms: 50, num_turns: 1, total_cost_usd: 0.001 })); break;
    case 'empty': process.stdout.write(ok('')); break;
    case 'garbage': process.stdout.write('this is not json at all'); break;
    case 'exit2': process.stderr.write('error: unknown option --nope'); process.exitCode = 2; break;
    case 'hang': setTimeout(() => process.stdout.write(ok('too late')), 10_000); break;
    case 'slow': setTimeout(() => process.stdout.write(ok('slow answer from ' + model)), 400); break;
    default: process.stdout.write(ok('answer from ' + model + ': one red line in the Output panel'));
  }
}
`;

export interface FakeClaude {
  /** Temp dir holding the shim, the script and capture.json; put first on PATH. */
  dir: string;
  /** The shim: `<dir>/claude.cmd` on Windows, `<dir>/claude` elsewhere. */
  exe: string;
  /** {argv, stdin, cwd} of the last invocation. */
  lastCall(): { argv: string[]; stdin: string; cwd: string };
  cleanup(): void;
}

export function installFakeClaude(): FakeClaude {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-live-fake-claude-'));
  writeFileSync(path.join(dir, 'fake-claude.mjs'), FAKE_CLAUDE_SOURCE);
  let exe: string;
  if (process.platform === 'win32') {
    exe = path.join(dir, 'claude.cmd');
    writeFileSync(exe, `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  } else {
    exe = path.join(dir, 'claude');
    writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.mjs" "$@"\n`);
    chmodSync(exe, 0o755);
  }
  return {
    dir,
    exe,
    lastCall: () => JSON.parse(readFileSync(path.join(dir, 'capture.json'), 'utf8')) as { argv: string[]; stdin: string; cwd: string },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Polls `check` with real timers; rejects after `timeoutMs`. */
export async function waitFor(check: () => boolean, timeoutMs = 15_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Path equality for a `where`/`which` hit vs the path the test built: case- and separator-insensitive,
 * and resolved through the file system so an 8.3 short name (GitHub's Windows runners set %TEMP% to
 * `C:\Users\RUNNER~1\…`, which `where.exe` expands to the long name) compares equal to its long form.
 */
export function samePath(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const canon = (p: string): string => {
    let real = p;
    try {
      real = realpathSync.native(p);
    } catch {
      // not on disk: compare as written
    }
    return path.normalize(real).replace(/[\\/]+$/, '').toLowerCase();
  };
  return canon(a) === canon(b);
}
