/**
 * Screen capture of the Roblox Studio window.
 *
 * A persistent PowerShell worker (worker.ps1, next to this module) does the Win32 work:
 * PrintWindow(PW_RENDERFULLCONTENT) -> optional crop -> bicubic resize -> JPEG/PNG on disk.
 * This module owns the process: lazy spawn, one JSON line per request with an id, a per-request
 * timeout that restarts a hung worker, restart after a crash, and the rolling frames directory.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export interface StudioWindow {
  hwnd: string;
  pid: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  foreground: boolean;
}

export interface CaptureOptions {
  hwnd?: string;
  titleMatch?: string;
  maxWidth?: number;
  format?: 'jpeg' | 'png';
  quality?: number;
  region?: { x: number; y: number; w: number; h: number };
  restore?: boolean;
  outDir?: string;
}

export interface CaptureResult {
  path: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: 'image/jpeg' | 'image/png';
  windowTitle: string;
  hwnd: string;
  captured_ms: number;
  base64: string;
  /** Pixel size of the captured area (window or `region`) before `maxWidth` scaling. */
  sourceWidth: number;
  sourceHeight: number;
  /** Window pixels per image pixel (1 when no scaling was applied). */
  scale: number;
}

export type CaptureErrorCode = 'no_window' | 'minimized' | 'capture_failed';

export class CaptureError extends Error {
  readonly code: CaptureErrorCode;

  constructor(code: CaptureErrorCode, message: string) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
  }
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/**
 * Cold start budget: PowerShell plus the C# compile of the Win32 shim can take well over
 * the per-request timeout on a cold machine, so requests only start their own timer once
 * the worker has announced itself.
 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;
export const DEFAULT_MAX_FRAMES = 200;
export const DEFAULT_MAX_WIDTH = 1024;
export const DEFAULT_JPEG_QUALITY = 70;
const SHUTDOWN_GRACE_MS = 2_000;

export type Logger = (message: string) => void;

const stderrLogger: Logger = (message) => {
  process.stderr.write(`[capture] ${message}\n`);
};

export function defaultFramesDir(): string {
  return path.join(os.tmpdir(), 'studio-live', 'frames');
}

export function workerScriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.ps1');
}

export function defaultWorkerSpec(): { command: string; args: string[] } {
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', workerScriptPath()],
  };
}

// ---------------------------------------------------------------------------------------------
// Transport: request/response framing over the worker's stdio.
// ---------------------------------------------------------------------------------------------

export interface CaptureWorkerOptions {
  /** Executable to spawn (default: powershell.exe running worker.ps1). */
  command?: string;
  args?: readonly string[];
  /** Per-request timeout, counted from the moment the worker is ready; exceeding it kills and restarts the worker. */
  timeoutMs?: number;
  /** How long a freshly spawned worker may take to announce itself before it is killed. */
  startupTimeoutMs?: number;
  log?: Logger;
}

const replySchema = z.object({ id: z.string() }).passthrough();
export type WorkerReply = z.infer<typeof replySchema>;

interface Pending {
  cmd: string;
  timeoutMs: number;
  resolve: (reply: WorkerReply) => void;
  reject: (err: Error) => void;
  /** Armed once the worker is ready (null while it is still starting). */
  timer: NodeJS.Timeout | null;
}

interface Spawned {
  child: ChildProcess;
  /** Resolves when the worker printed its ready line (or answered anything); rejects if it died first. */
  ready: Promise<void>;
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max} chars]` : text;
}

export class CaptureWorker {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly timeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly log: Logger;
  private spawned: Spawned | null = null;
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private spawnCount = 0;

  constructor(options: CaptureWorkerOptions = {}) {
    const spec = options.command === undefined && options.args === undefined ? defaultWorkerSpec() : null;
    this.command = options.command ?? spec?.command ?? 'powershell.exe';
    this.args = options.args ?? spec?.args ?? [];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.log = options.log ?? stderrLogger;
  }

  /** PID of the live worker process, if one is running. */
  get pid(): number | undefined {
    return this.spawned?.child.pid;
  }

  /** How many times a worker process has been spawned (1 = never restarted). */
  get spawns(): number {
    return this.spawnCount;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  /**
   * Spawns the worker if needed, then round-trips `ping` and `list` so the command loop, the JSON
   * cmdlets and window enumeration are all exercised before the first real request (their first use
   * in a fresh PowerShell costs hundreds of milliseconds). Errors are logged, not thrown.
   */
  async warmup(): Promise<boolean> {
    try {
      await this.ensureChild().ready;
      await this.request('ping');
      await this.request('list');
      return true;
    } catch (err) {
      this.log(`warm-up failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  request(cmd: string, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<WorkerReply> {
    const { child, ready } = this.ensureChild();
    const id = `c${++this.nextId}`;
    const line = `${JSON.stringify({ ...params, id, cmd })}\n`;
    return new Promise<WorkerReply>((resolve, reject) => {
      const pending: Pending = { cmd, timeoutMs, resolve, reject, timer: null };
      this.pending.set(id, pending);
      // The request is written right away (the worker reads stdin once it is up); only its clock waits.
      ready.then(
        () => {
          if (this.pending.get(id) === pending) pending.timer = this.armTimer(id, pending);
        },
        () => {
          // A startup failure has already rejected every pending request through failAll.
        },
      );
      child.stdin?.write(line, (err) => {
        if (err && this.pending.get(id) === pending) {
          if (pending.timer) clearTimeout(pending.timer);
          this.pending.delete(id);
          reject(new CaptureError('capture_failed', `could not write to capture worker: ${err.message}`));
        }
      });
    });
  }

  /** Close stdin so the worker exits on its own; kill it if it lingers. */
  async shutdown(): Promise<void> {
    const spawned = this.spawned;
    if (!spawned) return;
    const { child } = spawned;
    this.spawned = null;
    this.failAll('capture worker shut down');
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    child.stdin?.end();
    const killer = setTimeout(() => child.kill(), SHUTDOWN_GRACE_MS);
    await exited;
    clearTimeout(killer);
  }

  private armTimer(id: string, pending: Pending): NodeJS.Timeout {
    return setTimeout(() => {
      this.pending.delete(id);
      this.log(`'${pending.cmd}' (${id}) did not answer within ${pending.timeoutMs} ms; restarting worker`);
      this.terminate(`worker restarted after '${pending.cmd}' timed out`);
      pending.reject(new CaptureError('capture_failed', `capture worker did not answer '${pending.cmd}' within ${pending.timeoutMs} ms (worker restarted)`));
    }, pending.timeoutMs);
  }

  private ensureChild(): Spawned {
    if (this.spawned) return this.spawned;
    const child = spawn(this.command, [...this.args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.spawnCount += 1;

    let markReady: () => void = () => undefined;
    let markDead: (err: Error) => void = () => undefined;
    let settled = false;
    const ready = new Promise<void>((resolve, reject) => {
      markReady = () => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        resolve();
      };
      markDead = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        reject(err);
      };
    });
    // Nothing awaits `ready` until a request comes in; keep a failed start from surfacing as unhandled.
    ready.catch(() => undefined);
    const startupTimer = setTimeout(() => {
      if (settled || this.spawned !== spawned) return;
      this.log(`worker did not become ready within ${this.startupTimeoutMs} ms; killing it`);
      this.terminate(`capture worker did not start within ${this.startupTimeoutMs} ms`);
    }, this.startupTimeoutMs);
    const spawned: Spawned = { child, ready };
    this.spawned = spawned;

    const decoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '').trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          markReady();
          this.onLine(line);
        }
        nl = buffer.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (/\bready\b/.test(line)) markReady();
        this.log(line.trim());
      }
    });
    // EPIPE after a crash is reported through the request path; do not let it become an uncaught error.
    child.stdin?.on('error', (err) => this.log(`worker stdin: ${err.message}`));

    const gone = (why: string): void => {
      markDead(new CaptureError('capture_failed', why));
      if (this.spawned !== spawned) return;
      this.spawned = null;
      this.failAll(why);
    };
    child.once('exit', (code, signal) => gone(`capture worker exited (code ${code}, signal ${signal})`));
    child.once('error', (err) => gone(`capture worker could not start: ${err.message}`));
    return spawned;
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.log(`ignoring non-JSON worker output: ${truncate(line)}`);
      return;
    }
    const reply = replySchema.safeParse(parsed);
    if (!reply.success) {
      this.log(`ignoring worker output without an id: ${truncate(line)}`);
      return;
    }
    const pending = this.pending.get(reply.data.id);
    if (!pending) {
      this.log(`ignoring reply for unknown or expired request ${reply.data.id}`);
      return;
    }
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(reply.data.id);
    pending.resolve(reply.data);
  }

  private terminate(reason: string): void {
    const spawned = this.spawned;
    if (!spawned) return;
    this.spawned = null;
    this.failAll(reason);
    spawned.child.kill();
  }

  private failAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new CaptureError('capture_failed', `${reason} while '${pending.cmd}' was in flight`));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Commands: typed wrappers over the worker protocol plus the frames directory.
// ---------------------------------------------------------------------------------------------

const errorReplySchema = z.object({ ok: z.literal(false), code: z.string(), message: z.string() });

const windowReplySchema = z.object({
  hwnd: z.string(),
  pid: z.number().int(),
  title: z.string(),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  minimized: z.boolean(),
  foreground: z.boolean(),
});

const listReplySchema = z.object({ ok: z.literal(true), windows: z.array(windowReplySchema) });

const captureReplySchema = z.object({
  ok: z.literal(true),
  path: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  ms: z.number().nonnegative(),
  title: z.string(),
  hwnd: z.string(),
  /** Older workers omit it; the output size is then the best available estimate of the source. */
  source: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
});

const okReplySchema = z.object({ ok: z.literal(true) });

function toCaptureCode(code: string): CaptureErrorCode {
  return code === 'no_window' || code === 'minimized' ? code : 'capture_failed';
}

function expectReply<T>(schema: z.ZodType<T>, reply: WorkerReply, cmd: string): T {
  const failure = errorReplySchema.safeParse(reply);
  if (failure.success) throw new CaptureError(toCaptureCode(failure.data.code), failure.data.message);
  const parsed = schema.safeParse(reply);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new CaptureError('capture_failed', `malformed '${cmd}' reply from capture worker (${issues})`);
  }
  return parsed.data;
}

function assertHwnd(hwnd: string): void {
  if (!/^\d{1,19}$/.test(hwnd)) throw new CaptureError('no_window', `hwnd must be a decimal string, got '${hwnd}'`);
}

function frameStamp(now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}T` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${p(now.getMilliseconds(), 3)}`
  );
}

export interface CaptureClientOptions {
  /** Directory for frames (default %TEMP%\studio-live\frames). */
  outDir?: string;
  /** Oldest frames beyond this count are deleted after each capture. */
  maxFrames?: number;
  log?: Logger;
}

export class CaptureClient {
  private readonly outDir: string;
  private readonly maxFrames: number;
  private readonly log: Logger;
  private frameSeq = 0;

  constructor(
    readonly worker: CaptureWorker,
    options: CaptureClientOptions = {},
  ) {
    this.outDir = options.outDir ?? defaultFramesDir();
    this.maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
    this.log = options.log ?? stderrLogger;
  }

  async listStudioWindows(): Promise<StudioWindow[]> {
    const reply = expectReply(listReplySchema, await this.worker.request('list'), 'list');
    return reply.windows.map((w) => ({
      hwnd: w.hwnd,
      pid: w.pid,
      title: w.title,
      x: w.rect.x,
      y: w.rect.y,
      width: w.rect.width,
      height: w.rect.height,
      minimized: w.minimized,
      foreground: w.foreground,
    }));
  }

  async captureStudio(opts: CaptureOptions = {}): Promise<CaptureResult> {
    const format = opts.format ?? 'jpeg';
    if (format !== 'jpeg' && format !== 'png') {
      throw new CaptureError('capture_failed', `format must be 'jpeg' or 'png', got '${String(format)}'`);
    }
    if (opts.hwnd !== undefined) assertHwnd(opts.hwnd);
    const outDir = opts.outDir ?? this.outDir;
    await fs.mkdir(outDir, { recursive: true });
    this.frameSeq += 1;
    const outPath = path.join(outDir, `frame-${frameStamp(new Date())}-${String(this.frameSeq).padStart(4, '0')}.${format === 'png' ? 'png' : 'jpg'}`);

    const reply = expectReply(
      captureReplySchema,
      await this.worker.request('capture', {
        hwnd: opts.hwnd,
        titleMatch: opts.titleMatch,
        maxWidth: opts.maxWidth ?? DEFAULT_MAX_WIDTH,
        format,
        quality: opts.quality ?? DEFAULT_JPEG_QUALITY,
        region: opts.region,
        outPath,
        restore: opts.restore ?? true,
      }),
      'capture',
    );

    const data = await fs.readFile(reply.path);
    const sourceWidth = reply.source?.width ?? reply.width;
    const sourceHeight = reply.source?.height ?? reply.height;
    const result: CaptureResult = {
      path: reply.path,
      width: reply.width,
      height: reply.height,
      bytes: data.length,
      mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
      windowTitle: reply.title,
      hwnd: reply.hwnd,
      captured_ms: reply.ms,
      base64: data.toString('base64'),
      sourceWidth,
      sourceHeight,
      scale: Math.round((sourceWidth / reply.width) * 1000) / 1000,
    };
    await this.pruneFrames(outDir).catch((err: unknown) => {
      this.log(`frame cleanup in ${outDir} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return result;
  }

  async restoreWindow(hwnd: string): Promise<void> {
    assertHwnd(hwnd);
    expectReply(okReplySchema, await this.worker.request('restore', { hwnd }), 'restore');
  }

  shutdown(): Promise<void> {
    return this.worker.shutdown();
  }

  private async pruneFrames(dir: string): Promise<void> {
    const names = (await fs.readdir(dir)).filter((n) => n.startsWith('frame-')).sort();
    const excess = names.length - this.maxFrames;
    if (excess <= 0) return;
    await Promise.all(names.slice(0, excess).map((n) => fs.unlink(path.join(dir, n)).catch(() => undefined)));
  }
}

// ---------------------------------------------------------------------------------------------
// Module-level default client (what the bridge uses).
// ---------------------------------------------------------------------------------------------

let defaultClient: CaptureClient | null = null;

function getDefaultClient(): CaptureClient {
  if (defaultClient) return defaultClient;
  if (process.platform !== 'win32') {
    throw new CaptureError('capture_failed', 'screen capture is only available on Windows (PrintWindow)');
  }
  const spec = defaultWorkerSpec();
  const script = workerScriptPath();
  if (!existsSync(script)) {
    throw new CaptureError('capture_failed', `capture worker script missing at ${script}; run "npm run build" (scripts/copy-assets.mjs copies it into dist)`);
  }
  defaultClient = new CaptureClient(new CaptureWorker({ command: spec.command, args: spec.args }));
  return defaultClient;
}

export async function listStudioWindows(): Promise<StudioWindow[]> {
  return getDefaultClient().listStudioWindows();
}

/** Throws CaptureError with .code = 'no_window' | 'minimized' | 'capture_failed'. */
export async function captureStudio(opts?: CaptureOptions): Promise<CaptureResult> {
  return getDefaultClient().captureStudio(opts);
}

export async function restoreWindow(hwnd: string): Promise<void> {
  return getDefaultClient().restoreWindow(hwnd);
}

export async function shutdownCaptureWorker(): Promise<void> {
  const client = defaultClient;
  defaultClient = null;
  if (client) await client.shutdown();
}

/** Spawns, readies and pings the default worker ahead of the first screenshot (no-op off Windows). Never throws. */
export async function warmupCaptureWorker(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    return await getDefaultClient().worker.warmup();
  } catch (err) {
    stderrLogger(`warm-up skipped: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
