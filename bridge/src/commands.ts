/**
 * Non-MCP entry points of the CLI: `studio-live call` (one tool call over POST /rpc, for
 * scripts and shells), `studio-live sync` (a folder ⇄ Studio script mirror driven by
 * ./sync/index.js) and `studio-live twin` (a second Studio on a local place file). Kept out of
 * cli.ts so tests can drive them without a process.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeError, errorMessage } from './errors.js';
import { probePrimary, rpcCall } from './proxy.js';
import { startSync as defaultStartSync, type SyncHandle, type SyncOptions } from './sync/index.js';

export type { SyncHandle, SyncOptions } from './sync/index.js';

/** `startSync` of ./sync/index.js: `(opts: SyncOptions) => Promise<SyncHandle>`; injectable for tests. */
export type StartSync = (opts: SyncOptions) => Promise<SyncHandle>;

export interface CommandIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Whole stdin as text; used when the JSON arguments are not on the command line. */
  readStdin: () => Promise<string>;
  stdinIsTty: boolean;
  /** True once any byte arrived on stdin (lets an implicit read keep waiting for a slow producer). */
  stdinDataSeen?: () => boolean;
}

/**
 * An implicit stdin read (no literal, stdin not a TTY) gives up after this long when nothing has
 * arrived: a wrapper that spawns `studio-live call` with a pipe it never writes to or closes would
 * otherwise hang forever. `-` always waits for EOF.
 */
export const STDIN_IDLE_MS = 750;

export interface ParsedFlags {
  positional: string[];
  flags: Map<string, string | true>;
}

/** `--name value` / `--name=value` / bare `--flag`; everything else is positional, in order. */
export function parseFlags(argv: readonly string[]): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    // A value-taking flag consumes the following token unless it is another flag.
    if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

/** `studio-live call` flags naming a Luau file: the absolute path becomes the matching `*_file` tool argument. */
export const CALL_FILE_FLAGS: ReadonlyArray<{ flag: string; field: string; inline: string }> = [
  { flag: 'code-file', field: 'code_file', inline: 'code' },
  { flag: 'source-file', field: 'source_file', inline: 'source' },
  { flag: 'predicate-file', field: 'predicate_file', inline: 'predicate' },
];

const VALUE_FLAGS = new Set(['port', 'timeout', 'exe', 'args-file', ...CALL_FILE_FLAGS.map((f) => f.flag)]);

/** An integer `--name` flag within [min, max]; absent (or bare) → fallback; anything else is refused up front. */
export function intFlag(flags: ParsedFlags['flags'], name: string, fallback: number | undefined, min: number, max: number): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined || raw === true) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(value) || value < min || value > max) {
    throw new BridgeError('bad_request', `--${name} must be an integer in ${min}..${max}, got "${raw}"`);
  }
  return value;
}

export function portFlag(flags: ParsedFlags['flags'], fallback: number): number {
  return intFlag(flags, 'port', fallback, 1, 65535) as number;
}

/** `--timeout ms` of `call` / `twin`: a positive integer or nothing (the command's default). */
export function timeoutFlag(flags: ParsedFlags['flags']): number | undefined {
  return intFlag(flags, 'timeout', undefined, 1, 3_600_000);
}

/** `--exe path` of `twin`: an explicit RobloxStudioBeta.exe (also `STUDIO_LIVE_STUDIO_EXE`). */
export function exeFlag(flags: ParsedFlags['flags']): string | undefined {
  const raw = flags.get('exe');
  if (raw === undefined) return undefined;
  if (raw === true || raw.trim() === '') throw new BridgeError('bad_request', '--exe needs a path');
  return raw;
}

/** Stdin when nothing named it: whatever arrives before EOF, or `{}` when the pipe stays silent. */
async function readImplicitStdin(io: CommandIo, idleMs: number): Promise<string> {
  const reading = io.readStdin();
  let timer: NodeJS.Timeout | undefined;
  const idle = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), idleMs);
  });
  const first = await Promise.race([reading.then((text) => ({ text })), idle]);
  if (timer) clearTimeout(timer);
  if (first !== null) return first.text;
  // Bytes are flowing, just slowly: wait for EOF like an explicit "-" would.
  if (io.stdinDataSeen?.()) return reading;
  io.stderr(`no tool arguments on stdin after ${idleMs} ms; calling with {} (pass a JSON literal, or "-" to wait for stdin)\n`);
  return '';
}

/** Parses the tool arguments: a JSON object literal, `-` / omitted for stdin (when piped). */
export async function readToolArgs(literal: string | undefined, io: CommandIo, idleMs: number = STDIN_IDLE_MS): Promise<Record<string, unknown>> {
  let text: string;
  if (literal !== undefined && literal !== '-') {
    text = literal;
  } else if (literal === '-') {
    text = await io.readStdin();
  } else if (!io.stdinIsTty) {
    text = await readImplicitStdin(io, idleMs);
  } else {
    text = '';
  }
  text = text.trim();
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new BridgeError('bad_request', `tool arguments are not valid JSON (${errorMessage(err)}): ${text.slice(0, 120)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BridgeError('bad_request', 'tool arguments must be a JSON object, e.g. {"what":"status"}');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Tool arguments of `studio-live call`: the JSON literal / stdin, then `--args-file` (a JSON
 * object file merged over it), then `--code-file` / `--source-file` / `--predicate-file`, whose
 * absolute paths become `code_file` / `source_file` / `predicate_file` (replacing an inline
 * `code` / `source` / `predicate`) so the bridge reads the Luau itself and no shell or JSON
 * escaping ever touches it.
 */
export async function readCallArgs(
  literal: string | undefined,
  flags: ParsedFlags['flags'],
  io: CommandIo,
  idleMs: number = STDIN_IDLE_MS,
): Promise<Record<string, unknown>> {
  const argsFile = flags.get('args-file');
  if (argsFile === true) throw new BridgeError('bad_request', '--args-file needs a path');
  // With --args-file or any *-file flag and no literal, the arguments are complete: stdin is not
  // consulted (a piped-but-silent stdin would only add a wait).
  const complete = argsFile !== undefined || CALL_FILE_FLAGS.some((f) => flags.has(f.flag));
  const base = literal === undefined && complete ? {} : await readToolArgs(literal, io, idleMs);
  const args: Record<string, unknown> = { ...base };
  if (argsFile !== undefined) {
    const file = path.resolve(argsFile);
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (err) {
      throw new BridgeError('bad_request', `--args-file ${file}: ${errorMessage(err)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (err) {
      throw new BridgeError('bad_request', `--args-file ${file} is not valid JSON (${errorMessage(err)})`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BridgeError('bad_request', `--args-file ${file} must hold a JSON object`);
    }
    Object.assign(args, parsed);
  }
  for (const { flag, field, inline } of CALL_FILE_FLAGS) {
    const value = flags.get(flag);
    if (value === undefined) continue;
    if (value === true) throw new BridgeError('bad_request', `--${flag} needs a path`);
    args[field] = path.resolve(value);
    delete args[inline];
  }
  return args;
}

/** Text a shell user wants to see: text parts verbatim, images as a one-line placeholder. */
export function renderCallResult(result: CallToolResult): string {
  const lines: string[] = [];
  for (const part of result.content) {
    if (part.type === 'text') lines.push(part.text);
    else if (part.type === 'image') lines.push(`[image ${part.mimeType}, ${Math.round((part.data.length * 3) / 4)} bytes base64; use --raw for the data]`);
    else lines.push(`[${part.type}]`);
  }
  return lines.join('\n');
}

export interface CallCommandOptions {
  port: number;
  tool: string;
  args: Record<string, unknown>;
  raw: boolean;
  timeoutMs?: number;
}

/** POSTs one tool call to the running bridge and prints the result; returns the process exit code. */
export async function runCall(options: CallCommandOptions, io: CommandIo): Promise<number> {
  const probe = await probePrimary(options.port);
  if (probe.state !== 'healthy') {
    io.stderr(`no studio-live bridge on port ${options.port} (${probe.detail}); start one with "studio-live serve"\n`);
    return 1;
  }
  const result = await rpcCall(options.port, options.tool, options.args, options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {});
  io.stdout(`${options.raw ? JSON.stringify(result) : renderCallResult(result)}\n`);
  return result.isError ? 1 : 0;
}

export interface SyncCommandOptions {
  dir: string;
  port: number;
  pull: boolean;
  once: boolean;
  hotpatch: boolean;
}

export interface SyncCommandDeps {
  /** Resolves the sync module's `startSync`; the default is ./sync/index.js's. */
  loadStartSync?: () => Promise<StartSync>;
  /** Resolves when the user asks to stop (SIGINT); the default waits for the signal. */
  waitForStop?: () => Promise<void>;
}

const importStartSync = async (): Promise<StartSync> => defaultStartSync;

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

// ---- studio-live twin -------------------------------------------------------------------------------

/** How long `twin` waits for the launched Studio's hub to hello the bridge (a cold Studio start takes 10–20 s). */
export const TWIN_WAIT_MS = 90_000;
export const TWIN_POLL_MS = 1_000;
export const STUDIO_EXE = 'RobloxStudioBeta.exe';

/** `%LOCALAPPDATA%\Roblox\Versions`: one `version-<hash>` folder per installed Studio / Player build. */
export function defaultVersionsDir(): string {
  const localAppData = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Roblox', 'Versions');
}

/** Every Versions folder Studio may live in: the per-user one first, then the per-machine installs. */
export function defaultVersionsDirs(): string[] {
  const dirs = [defaultVersionsDir()];
  for (const key of ['ProgramFiles(x86)', 'ProgramFiles']) {
    const base = process.env[key];
    if (base) dirs.push(path.join(base, 'Roblox', 'Versions'));
  }
  return [...new Set(dirs)];
}

/** Environment override for the Studio executable (`--exe` on the command line wins over it). */
export const STUDIO_EXE_ENV = 'STUDIO_LIVE_STUDIO_EXE';

/**
 * Newest `version-*` folder under the Versions dir(s) that holds RobloxStudioBeta.exe (Player builds
 * have none), or null. `override` (an explicit exe path) is checked first and must exist.
 */
export async function findStudioExecutable(versionsDirs: string | string[] = defaultVersionsDirs(), override?: string): Promise<string | null> {
  if (override !== undefined && override !== '') {
    try {
      if ((await fsp.stat(override)).isFile()) return path.resolve(override);
    } catch {
      // fall through: reported by the caller as not found
    }
    return null;
  }
  let best: { exe: string; mtimeMs: number } | null = null;
  for (const versionsDir of Array.isArray(versionsDirs) ? versionsDirs : [versionsDirs]) {
    let names: string[];
    try {
      names = await fsp.readdir(versionsDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('version-')) continue;
      const dir = path.join(versionsDir, name);
      const exe = path.join(dir, STUDIO_EXE);
      try {
        const [exeStat, dirStat] = await Promise.all([fsp.stat(exe), fsp.stat(dir)]);
        if (!exeStat.isFile()) continue;
        const mtimeMs = Math.max(dirStat.mtimeMs, exeStat.mtimeMs);
        if (!best || mtimeMs > best.mtimeMs) best = { exe, mtimeMs };
      } catch {
        // no Studio in this version folder
      }
    }
  }
  return best?.exe ?? null;
}

/** A launched Studio: its pid and a promise of its exit code (null when killed by a signal), if it exits. */
export interface StudioLaunch {
  pid: number | undefined;
  exited: Promise<number | null>;
}

/**
 * Launches Studio on the place file as its own process group so it outlives this CLI. Resolves
 * once the process has actually started; rejects with the spawn error (EACCES, ENOENT, EBUSY…)
 * instead of letting a launch that never happened burn the whole wait.
 */
async function spawnStudioDetached(exe: string, place: string): Promise<StudioLaunch> {
  const child = spawn(exe, [place], { detached: true, stdio: 'ignore', windowsHide: false });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', (err) => reject(err));
  });
  child.unref();
  return { pid: child.pid, exited };
}

export interface TwinCommandOptions {
  /** Local place file (.rbxl / .rbxlx). */
  place: string;
  port: number;
  waitMs?: number;
  pollMs?: number;
  /** Explicit RobloxStudioBeta.exe (`--exe`, else STUDIO_LIVE_STUDIO_EXE, else the Versions scan). */
  exe?: string;
}

export interface TwinCommandDeps {
  findStudio?: (override?: string) => Promise<string | null>;
  /** Spawns Studio; resolves with its pid once started, rejects when it cannot start. Injected by tests. */
  spawnStudio?: (exe: string, place: string) => Promise<StudioLaunch>;
}

interface StatusSession {
  session: string;
  connected: boolean;
  studio?: { placeName?: string; placeId?: number } | null;
}

/** Sessions the running bridge reports, or null when no bridge answers. */
async function bridgeSessions(port: number): Promise<StatusSession[] | null> {
  const probe = await probePrimary(port);
  if (probe.state !== 'healthy') return null;
  const sessions = probe.status.raw.sessions;
  return Array.isArray(sessions) ? (sessions as StatusSession[]) : [];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts a second Roblox Studio on a local place file and waits for its hub to connect: prints
 * `{session, place, placeId, pid, waited_ms}` so the caller can pass `session` on tool calls.
 * Returns the exit code (0 connected, 1 no bridge / no Studio / timeout, 2 bad place file).
 */
export async function runTwin(options: TwinCommandOptions, io: CommandIo, deps: TwinCommandDeps = {}): Promise<number> {
  const before = await bridgeSessions(options.port);
  if (before === null) {
    io.stderr(`no studio-live bridge on port ${options.port}; start one with "studio-live serve"\n`);
    return 1;
  }
  const place = path.resolve(options.place);
  if (!/\.rbxlx?$/i.test(place)) {
    io.stderr(`twin needs a .rbxl or .rbxlx place file, got ${place}\n`);
    return 2;
  }
  try {
    if (!(await fsp.stat(place)).isFile()) throw new Error('not a file');
  } catch {
    io.stderr(`place file not found: ${place}\n`);
    return 2;
  }
  const override = options.exe ?? process.env[STUDIO_EXE_ENV];
  const exe = await (deps.findStudio ? deps.findStudio(override) : findStudioExecutable(undefined, override));
  if (!exe) {
    if (override) io.stderr(`Roblox Studio not found: ${override} (from ${options.exe !== undefined ? '--exe' : STUDIO_EXE_ENV}) is not a file\n`);
    else io.stderr(`Roblox Studio not found: no version-*\\${STUDIO_EXE} under ${defaultVersionsDirs().join(' or ')} (pass --exe <path> or set ${STUDIO_EXE_ENV})\n`);
    return 1;
  }
  const known = new Set(before.map((s) => s.session));
  let launch: StudioLaunch;
  try {
    launch = await (deps.spawnStudio ?? spawnStudioDetached)(exe, place);
  } catch (err) {
    io.stderr(`could not start ${exe}: ${errorMessage(err)}\n`);
    return 1;
  }
  const { pid } = launch;
  let exitCode: number | null | undefined;
  void launch.exited.then((code) => {
    exitCode = code;
  });
  const waitMs = options.waitMs ?? TWIN_WAIT_MS;
  io.stderr(`launched ${exe} "${place}"${pid !== undefined ? ` (pid ${pid})` : ''}; waiting up to ${Math.round(waitMs / 1000)} s for its session on the bridge (port ${options.port})\n`);
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await sleep(options.pollMs ?? TWIN_POLL_MS);
    if (exitCode !== undefined && exitCode !== 0) {
      // Studio quit before connecting (a bad place file, a crash at start): no point waiting further.
      io.stderr(`Studio exited with code ${exitCode} before its session connected\n`);
      return 1;
    }
    const now = await bridgeSessions(options.port);
    const fresh = now?.find((s) => s.connected && !known.has(s.session));
    if (fresh) {
      io.stdout(
        `${JSON.stringify({
          session: fresh.session,
          place: fresh.studio?.placeName ?? null,
          placeId: fresh.studio?.placeId ?? null,
          pid: pid ?? null,
          waited_ms: Date.now() - t0,
          note: 'pass session=<this id> on tool calls to address this Studio; without it, writes are refused while two Studios are connected',
        })}\n`,
      );
      return 0;
    }
  }
  io.stderr(`no new Studio session connected within ${Math.round(waitMs / 1000)} s (the plugin must be installed: studio-live install); check GET /status later\n`);
  return 1;
}

/** Mirrors `dir` into Studio (and back with --pull) until stopped, or once; returns the exit code. */
export async function runSync(options: SyncCommandOptions, io: CommandIo, deps: SyncCommandDeps = {}): Promise<number> {
  const probe = await probePrimary(options.port);
  if (probe.state !== 'healthy') {
    io.stderr(`no studio-live bridge on port ${options.port} (${probe.detail}); start one with "studio-live serve"\n`);
    return 1;
  }
  const startSync = await (deps.loadStartSync ?? importStartSync)();
  const handle = await startSync({
    dir: options.dir,
    port: options.port,
    pull: options.pull,
    once: options.once,
    hotpatch: options.hotpatch,
    log: (line) => io.stderr(`${line}\n`),
  });
  if (!options.once) {
    io.stderr(`syncing ${options.dir} ${options.pull ? '←' : '→'} Studio on port ${options.port}${options.hotpatch ? '' : ' (hotpatch off)'}; Ctrl+C stops\n`);
    await (deps.waitForStop ?? waitForSignal)();
  }
  await handle.stop();
  const stats = handle.stats();
  io.stdout(`${JSON.stringify(stats)}\n`);
  return stats.errors > 0 ? 1 : 0;
}
