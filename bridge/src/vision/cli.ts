/**
 * The `claude-cli` provider: one `claude -p` per frame on the user's Claude Code login.
 *
 *   printf '<system prompt>\n\nRead the image file <abs path> and answer: <question>' |
 *     claude -p --model <model> --output-format json --allowedTools Read --strict-mcp-config --no-session-persistence
 *
 * The prompt goes on stdin (a trailing prompt argument after the flags is rejected by the CLI),
 * stdout is one JSON object ({result, is_error, duration_ms, num_turns, total_cost_usd, …}),
 * and the call is killed after CLI_TIMEOUT_MS. `--strict-mcp-config` with no `--mcp-config`
 * keeps the nested CLI from starting the user's MCP servers — including this bridge — on every
 * frame; `--no-session-persistence` keeps it from writing a session file per frame under the
 * Claude config dir; the working directory is the frame's folder so no project CLAUDE.md is
 * picked up either.
 *
 * Verified live: ~9 s of model time, ~14 s wall including the CLI's startup, for one 768 px frame
 * on `haiku`; usage counts against the subscription, not an API bill.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DescribeOptions, VisionFailure, VisionOutcome, VisionUsage } from './model.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { cliCommand, findClaudeCli, killTree, CLI_NAME } from './provider.js';
import type { CaptureLike } from './types.js';

/** One-shot `look` default on the CLI: the `sonnet` alias. Overridable with STUDIO_LIVE_VISION_MODEL. */
export const DEFAULT_CLI_LOOK_MODEL = 'sonnet';
/** Watch default on the CLI: the `haiku` alias (a frame every 15 s adds up). Overridable with STUDIO_LIVE_WATCH_MODEL. */
export const DEFAULT_CLI_WATCH_MODEL = 'haiku';
/** The CLI is killed when it has not exited after this long (startup + model + tool turn). */
export const CLI_TIMEOUT_MS = 120_000;
/** A CLI call takes 10–15 s, so a watch on this provider never captures more often than this. */
export const CLI_MIN_INTERVAL_S = 15;
/** Characters of CLI output quoted in an error message. */
const EXCERPT_CHARS = 400;

/**
 * What a model id or alias may look like on either provider: `claude-opus-5`, `sonnet`,
 * `opus[1m]`, a Bedrock `us.anthropic.…:0` or Vertex `…@20251101` id. Anything else is refused
 * before it reaches a command line — on a `.cmd` shim the model is part of a `cmd /c` line, so
 * whitespace, quotes, `%`, `&`, `|` and friends must never get there.
 */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@[\]-]{0,99}$/;
/** Human wording of MODEL_PATTERN for error messages. */
export const MODEL_RULE = 'letters, digits and . _ : @ [ ] - only, up to 100 characters (an id such as claude-opus-5, or sonnet / haiku / opus on the claude-cli provider)';

export function isValidModel(model: string): boolean {
  return MODEL_PATTERN.test(model);
}

export function cliArgs(model: string): string[] {
  return ['-p', '--model', model, '--output-format', 'json', '--allowedTools', 'Read', '--strict-mcp-config', '--no-session-persistence'];
}

/** The system prompt folded into the user prompt, then the instruction to read the frame. */
export function cliPrompt(framePath: string, question: string): string {
  return `${SYSTEM_PROMPT}\n\nRead the image file ${path.resolve(framePath)} and answer: ${question}`;
}

export function cliModelName(model: string): string {
  return `claude-cli:${model}`;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function tryParse(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text);
    const object = asObject(value);
    if (object) return object;
    // `--output-format json` with --verbose prints every message; the result is the last one.
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) {
        const entry = asObject(value[i]);
        if (entry && entry.type === 'result') return entry;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The result object from the CLI's stdout. Tolerant of noise before it: when the whole output
 * is not JSON, the last line that starts with `{` (and everything after it) is tried.
 */
export function parseCliOutput(stdout: string): Json | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const whole = tryParse(trimmed);
  if (whole) return whole;
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    const candidate = tryParse(lines.slice(i).join('\n')) ?? tryParse(line);
    if (candidate) return candidate;
  }
  return null;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
}

/** Maps the CLI's error text onto the codes the watch treats as permanent (`auth`, `bad_model`). */
export function classifyCliText(text: string): 'auth' | 'bad_model' | 'cli_error' {
  // Whole words only: "dialog in the viewport" or "catalog index" must not read as a login problem.
  if (/not logged in|\blogged out\b|please (run )?\/?login|\blog ?in\b|authenticat|unauthori[sz]ed|invalid api key|\boauth\b|token (has )?expired/i.test(text)) return 'auth';
  if (/model/i.test(text) && /not (found|available|supported|recognized)|invalid|unknown|does not exist/i.test(text)) return 'bad_model';
  return 'cli_error';
}

/** Error text newer result objects carry beside `result`: `error` (a string or `{message}`) and/or `errors: string[]`. */
function cliErrorFields(parsed: Json): string {
  const parts: string[] = [];
  if (typeof parsed.error === 'string') parts.push(parsed.error);
  else {
    const error = asObject(parsed.error);
    if (error && typeof error.message === 'string') parts.push(error.message);
  }
  if (Array.isArray(parsed.errors)) for (const entry of parsed.errors) if (typeof entry === 'string') parts.push(entry);
  return parts.join('; ').trim();
}

function transient(text: string): boolean {
  return /overloaded|rate.?limit|too many requests|\b(429|5\d\d)\b|network|econn|timed? ?out|temporar/i.test(text);
}

/** The frame's folder (no CLAUDE.md, no .mcp.json there), or the temp dir if it is gone. */
function workingDirFor(framePath: string): string {
  const dir = path.dirname(framePath);
  try {
    if (statSync(dir).isDirectory()) return dir;
  } catch {
    // fall through
  }
  return os.tmpdir();
}

interface CliRun {
  kind: 'ok' | 'timeout' | 'aborted' | 'spawn_error';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  cwd: string;
}

/** CLI processes alive right now, so a bridge exit takes them down instead of orphaning a 120 s call. */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // 'exit' handlers must be synchronous; killTree only *starts* taskkill / sends SIGKILL, which is.
  process.once('exit', () => {
    for (const live of liveChildren) killTree(live);
    liveChildren.clear();
  });
}

/** Spawns the CLI, feeds `input` on stdin, collects both streams, kills on timeout/abort. Never rejects. */
export function runCli(cmd: ReturnType<typeof cliCommand>, input: string, opts: RunOptions): Promise<CliRun> {
  return new Promise((resolve) => {
    // A watch stopped between capture and model call: nothing to spawn, nothing to kill.
    if (opts.signal?.aborted) return resolve({ kind: 'aborted', stdout: '', stderr: '', exitCode: null });
    let child;
    try {
      child = spawn(cmd.file, cmd.args, {
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(cmd.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (err) {
      return resolve({ kind: 'spawn_error', stdout: '', stderr: '', exitCode: null, error: err instanceof Error ? err.message : String(err) });
    }
    trackChild(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killedFor: 'timeout' | 'aborted' | null = null;
    const finish = (run: CliRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(run);
    };
    const kill = (why: 'timeout' | 'aborted'): void => {
      if (killedFor) return;
      killedFor = why;
      killTree(child);
    };
    const onAbort = (): void => kill('aborted');
    const timer = setTimeout(() => kill('timeout'), opts.timeoutMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => finish({ kind: killedFor ?? 'spawn_error', stdout, stderr, exitCode: null, error: err.message }));
    // `exit` fires as soon as the process is gone; `close` waits for the pipes, which a killed
    // shim's orphaned child could hold open. A normal run waits for `close` so no output is lost.
    child.on('exit', (code) => {
      if (killedFor) finish({ kind: killedFor, stdout, stderr, exitCode: code });
    });
    child.on('close', (code) => finish({ kind: killedFor ?? 'ok', stdout, stderr, exitCode: code }));
    child.stdin.on('error', () => {
      // EPIPE when the CLI exits before reading its prompt; the exit code tells the story.
    });
    child.stdin.end(input);
  });
}

/**
 * Asks the CLI one question about one frame. Never throws.
 *
 * Success maps the CLI's JSON onto the common outcome: `answer` = result, `model` =
 * `claude-cli:<model>`, `model_ms` = the CLI's duration_ms (`wall_ms` includes startup),
 * `usage` = {cost_usd, turns} plus token counts when the CLI reports them.
 */
export async function describeFrameWithCli(frame: CaptureLike, question: string, opts: DescribeOptions): Promise<VisionOutcome> {
  const started = Date.now();
  const elapsed = (): number => Date.now() - started;
  const requested = cliModelName(opts.model);
  const fail = (code: VisionFailure['code'], message: string, retryable: boolean): VisionFailure => ({
    ok: false,
    code,
    message,
    retryable,
    requested_model: requested,
    model_ms: elapsed(),
    provider: 'claude-cli',
  });
  if (!isValidModel(opts.model)) {
    return fail('bad_model', `model '${excerpt(opts.model)}' is not a model id or alias: ${MODEL_RULE}`, false);
  }
  const exe = opts.cli ?? (await findClaudeCli());
  if (!exe) {
    return fail('auth', `no '${CLI_NAME}' executable on the bridge's PATH: install Claude Code and log in (https://claude.com/claude-code), or provide an API credential`, false);
  }
  const timeoutMs = opts.budgetMs ?? CLI_TIMEOUT_MS;
  const framePath = path.resolve(frame.path);
  const cmd = cliCommand(exe, cliArgs(opts.model));
  opts.log?.('debug', 'vision: claude-cli call', { exe, model: opts.model, frame: framePath });
  const run = await runCli(cmd, cliPrompt(framePath, question), { timeoutMs, signal: opts.signal, cwd: workingDirFor(framePath) });

  if (run.kind === 'aborted') return fail('aborted', 'vision request aborted (claude CLI killed)', false);
  if (run.kind === 'timeout') {
    return fail('timeout', `the claude CLI gave no answer within ${Math.round(timeoutMs / 1000)} s and was killed; it is slow to start or the model is overloaded, try again`, true);
  }
  if (run.kind === 'spawn_error') return fail('cli_error', `could not start '${exe}': ${run.error ?? 'unknown error'}`, false);

  const parsed = parseCliOutput(run.stdout);
  if (!parsed) {
    const noise = excerpt(run.stderr) || excerpt(run.stdout) || '(no output)';
    if (run.exitCode === 0) return fail('cli_bad_output', `claude CLI output is not a JSON result object: ${noise}`, false);
    const code = classifyCliText(noise);
    if (code === 'auth') return fail('auth', `claude CLI is not logged in (exit ${run.exitCode}): run \`claude\` once and log in, then call look again. ${noise}`, false);
    return fail(code, `claude CLI exited ${run.exitCode ?? 'by signal'} without a JSON result: ${noise}`, code === 'cli_error' && transient(noise));
  }

  const result = typeof parsed.result === 'string' ? parsed.result.trim() : '';
  const subtype = typeof parsed.subtype === 'string' ? parsed.subtype : null;
  const errorFields = cliErrorFields(parsed);
  if (parsed.is_error === true) {
    const text = result || errorFields || excerpt(run.stderr) || subtype || 'no details';
    const code = classifyCliText(text);
    const hint = code === 'auth' ? ' — run `claude` once and log in, then call look again' : '';
    return fail(code, `claude CLI reported an error${subtype ? ` (${subtype})` : ''}: ${text}${hint}`, code === 'cli_error' && transient(text));
  }
  if (!result) {
    const detail = errorFields || excerpt(run.stderr);
    return fail('cli_error', `claude CLI returned no answer${subtype ? ` (${subtype})` : ''}${detail ? `: ${detail}` : ''}`, true);
  }

  const usage: VisionUsage = {};
  if (typeof parsed.total_cost_usd === 'number') usage.cost_usd = parsed.total_cost_usd;
  if (typeof parsed.num_turns === 'number') usage.turns = parsed.num_turns;
  const tokens = asObject(parsed.usage);
  if (tokens) {
    if (typeof tokens.input_tokens === 'number') usage.input_tokens = tokens.input_tokens;
    if (typeof tokens.output_tokens === 'number') usage.output_tokens = tokens.output_tokens;
  }
  return {
    ok: true,
    answer: result,
    model: requested,
    requested_model: requested,
    model_ms: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : elapsed(),
    wall_ms: elapsed(),
    usage,
    stop_reason: subtype,
    truncated: false,
    fallback: false,
    provider: 'claude-cli',
  };
}
