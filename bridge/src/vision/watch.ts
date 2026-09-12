/**
 * Background watches: capture → (skip if unchanged) → model → `vision` event, repeated every
 * `interval_s` until max_frames, a stop_when match, an explicit stop, or repeated failures.
 *
 * The loop is a self-rescheduling setTimeout chain, so a watch never has more than one capture
 * or one model call in flight, and a slow model call simply delays the next frame. `frames`
 * counts captures (max_frames therefore bounds wall-clock time to interval_s × max_frames),
 * `analysed` counts model calls.
 */
import { cliModelName } from './cli.js';
import { DIFF_THRESHOLD, frameSignature, signatureDifference, type FrameSignature } from './diff.js';
import { describeFrame, type DescribeOptions, type VisionOutcome } from './model.js';
import type { CaptureRegion, VisionContext, VisionEvent, VisionProvider } from './types.js';

export const DEFAULT_INTERVAL_S = 5;
export const MIN_INTERVAL_S = 2;
export const MAX_INTERVAL_S = 600;
export const DEFAULT_MAX_FRAMES = 60;
export const MAX_MAX_FRAMES = 1000;
/** Concurrent watches per bridge process; each one is a model call every interval. */
export const MAX_WATCHES = 4;
/** A watch gives up after this many consecutive failed frames (capture or model). */
export const MAX_CONSECUTIVE_ERRORS = 3;
/** Answers inside events are clipped so a frame stays well under the 4 KB Monitor budget. */
export const EVENT_ANSWER_CHARS = 1_500;

export interface WatchSpec {
  question: string;
  interval_s: number;
  max_frames: number;
  stop_when?: string;
  diff_only: boolean;
  model: string;
  max_width: number;
  region?: CaptureRegion;
  /** Backend for every frame (default `api`). */
  provider?: VisionProvider;
  /** `claude-cli`: resolved executable, so frames do not repeat the PATH lookup. */
  cli?: string;
  /** Attached as `note` to the first frame event (e.g. an interval clamped for the CLI). */
  note?: string;
}

export type WatchEndReason = 'max_frames' | 'stop_when' | 'stopped' | 'error';

export interface WatchSummary {
  watch_id: string;
  question: string;
  /** `claude-cli:<model>` on the CLI provider, the model id on the API. */
  model: string;
  provider: VisionProvider;
  interval_s: number;
  max_frames: number;
  diff_only: boolean;
  stop_when: string | null;
  started_at: number;
  frames: number;
  analysed: number;
  skipped: number;
  errors: number;
  in_flight: boolean;
  last_answer: string | null;
  last_at: number | null;
}

type WatchState = 'running' | 'stopping' | 'done';

interface Watch {
  id: string;
  spec: WatchSpec;
  ctx: VisionContext;
  matcher: ((answer: string) => boolean) | null;
  state: WatchState;
  startedAt: number;
  frames: number;
  analysed: number;
  skipped: number;
  errors: number;
  consecutiveErrors: number;
  inFlight: boolean;
  /** `spec.note` has been delivered on a frame event. */
  noteSent: boolean;
  lastSignature: FrameSignature | null;
  lastAnswer: string | null;
  lastAt: number | null;
  timer: NodeJS.Timeout | null;
  abort: AbortController;
  done: Promise<void>;
  finish: () => void;
}

/** `claude-cli:<model>` on the CLI provider, the model id on the API — what answers and events report. */
export function displayModel(spec: Pick<WatchSpec, 'model' | 'provider'>): string {
  return spec.provider === 'claude-cli' ? cliModelName(spec.model) : spec.model;
}

export function clipAnswer(text: string, max: number = EVENT_ANSWER_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max} chars]` : text;
}

/**
 * `stop_when` is a case-insensitive substring, or a regular expression when written as
 * `/pattern/flags`. Throws a RangeError for an invalid pattern so the tool can answer bad_request.
 */
export function compileStopWhen(stopWhen: string): (answer: string) => boolean {
  const asRegex = /^\/(.+)\/([a-z]*)$/s.exec(stopWhen);
  if (asRegex) {
    let re: RegExp;
    try {
      re = new RegExp(asRegex[1]!, asRegex[2]!.replace(/g/g, ''));
    } catch (err) {
      throw new RangeError(`stop_when is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`);
    }
    return (answer) => re.test(answer);
  }
  const needle = stopWhen.toLowerCase();
  return (answer) => answer.toLowerCase().includes(needle);
}

export interface WatchManagerDeps {
  describe?: (frame: Parameters<typeof describeFrame>[0], question: string, opts: DescribeOptions) => Promise<VisionOutcome>;
  now?: () => number;
  maxWatches?: number;
  maxConsecutiveErrors?: number;
}

export class WatchManager {
  private readonly watches = new Map<string, Watch>();
  private readonly describe: NonNullable<WatchManagerDeps['describe']>;
  private readonly now: () => number;
  private readonly maxWatches: number;
  private readonly maxConsecutiveErrors: number;
  private nextId = 0;

  constructor(deps: WatchManagerDeps = {}) {
    this.describe = deps.describe ?? describeFrame;
    this.now = deps.now ?? Date.now;
    this.maxWatches = deps.maxWatches ?? MAX_WATCHES;
    this.maxConsecutiveErrors = deps.maxConsecutiveErrors ?? MAX_CONSECUTIVE_ERRORS;
  }

  get size(): number {
    return this.watches.size;
  }

  /** Validates stop_when, registers the watch and analyses the first frame right away. */
  start(spec: WatchSpec, ctx: VisionContext): WatchSummary {
    if (this.watches.size >= this.maxWatches) {
      throw new RangeError(`at most ${this.maxWatches} watches can run at once; stop one first (look {stop: watch_id | 'all'})`);
    }
    const matcher = spec.stop_when === undefined ? null : compileStopWhen(spec.stop_when);
    this.nextId += 1;
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const watch: Watch = {
      id: `w-${this.nextId}`,
      spec,
      ctx,
      matcher,
      state: 'running',
      startedAt: this.now(),
      frames: 0,
      analysed: 0,
      skipped: 0,
      errors: 0,
      consecutiveErrors: 0,
      inFlight: false,
      noteSent: false,
      lastSignature: null,
      lastAnswer: null,
      lastAt: null,
      timer: null,
      abort: new AbortController(),
      done,
      finish,
    };
    this.watches.set(watch.id, watch);
    ctx.log('info', 'vision watch started', { watch_id: watch.id, model: spec.model, provider: spec.provider ?? 'api', interval_s: spec.interval_s, max_frames: spec.max_frames });
    this.run(watch);
    return this.summarize(watch);
  }

  /**
   * Every entry into the loop goes through here so no path can reject unobserved: an unhandled
   * rejection would take the whole bridge process down (Node's default). `tick` already turns
   * expected failures into error events; this only catches what escapes it (a throwing logger,
   * a bug) and ends the watch instead of leaving it half-alive with no timer.
   */
  private run(watch: Watch): void {
    this.tick(watch).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      try {
        watch.ctx.log('error', 'vision watch loop crashed', { watch_id: watch.id, error: message });
      } catch {
        // the logger itself is broken; nothing else to do
      }
      try {
        this.end(watch, 'error');
      } catch {
        this.watches.delete(watch.id);
        watch.state = 'done';
        watch.finish();
      }
    });
  }

  /** Returns false when no such watch is running. The in-flight model call (if any) is aborted. */
  stop(id: string): boolean {
    const watch = this.watches.get(id);
    if (!watch || watch.state !== 'running') return false;
    watch.state = 'stopping';
    if (watch.timer) {
      clearTimeout(watch.timer);
      watch.timer = null;
    }
    watch.abort.abort();
    if (!watch.inFlight) this.end(watch, 'stopped');
    return true;
  }

  /** Stops everything and resolves once every loop has wound down. */
  async stopAll(): Promise<string[]> {
    const ids = [...this.watches.keys()];
    const pending = ids.map((id) => this.watches.get(id)?.done);
    for (const id of ids) this.stop(id);
    await Promise.all(pending);
    return ids;
  }

  /** Resolves when the watch has ended (for tests and orderly shutdown). */
  settled(id: string): Promise<void> | undefined {
    return this.watches.get(id)?.done;
  }

  list(): WatchSummary[] {
    return [...this.watches.values()].filter((w) => w.state === 'running').map((w) => this.summarize(w));
  }

  private summarize(watch: Watch): WatchSummary {
    return {
      watch_id: watch.id,
      question: watch.spec.question,
      model: displayModel(watch.spec),
      provider: watch.spec.provider ?? 'api',
      interval_s: watch.spec.interval_s,
      max_frames: watch.spec.max_frames,
      diff_only: watch.spec.diff_only,
      stop_when: watch.spec.stop_when ?? null,
      started_at: watch.startedAt,
      frames: watch.frames,
      analysed: watch.analysed,
      skipped: watch.skipped,
      errors: watch.errors,
      in_flight: watch.inFlight,
      last_answer: watch.lastAnswer,
      last_at: watch.lastAt,
    };
  }

  private emit(watch: Watch, event: Omit<VisionEvent, 'type'>): void {
    try {
      watch.ctx.emit({ type: 'vision', watch_id: watch.id, ...event });
    } catch (err) {
      watch.ctx.log('warn', 'vision event sink threw', { watch_id: watch.id, err: err instanceof Error ? err.message : String(err) });
    }
  }

  /** `{note}` for the first frame event only (answer or error), when the spec carries one. */
  private pendingNote(watch: Watch): Record<string, unknown> {
    if (!watch.spec.note || watch.noteSent) return {};
    watch.noteSent = true;
    return { note: watch.spec.note };
  }

  private end(watch: Watch, reason: WatchEndReason): void {
    if (watch.state === 'done') return;
    watch.state = 'done';
    if (watch.timer) {
      clearTimeout(watch.timer);
      watch.timer = null;
    }
    this.watches.delete(watch.id);
    watch.ctx.log('info', 'vision watch ended', { watch_id: watch.id, reason, frames: watch.frames, analysed: watch.analysed, skipped: watch.skipped, errors: watch.errors });
    this.emit(watch, { done: true, reason, frames: watch.frames, analysed: watch.analysed, skipped: watch.skipped, errors: watch.errors, at: this.now() });
    watch.finish();
  }

  /** Records a failed frame; ends the watch when the failure is permanent or has repeated. */
  private fail(watch: Watch, frame: number, error: Record<string, unknown>, permanent: boolean): void {
    watch.errors += 1;
    watch.consecutiveErrors += 1;
    watch.ctx.log('warn', 'vision watch frame failed', { watch_id: watch.id, frame, ...error });
    this.emit(watch, { frame, error, provider: watch.spec.provider ?? 'api', ...this.pendingNote(watch), at: this.now() });
    if (permanent || watch.consecutiveErrors >= this.maxConsecutiveErrors) this.end(watch, 'error');
  }

  private async tick(watch: Watch): Promise<void> {
    if (watch.state !== 'running') return this.end(watch, 'stopped');
    watch.inFlight = true;
    watch.frames += 1;
    const frame = watch.frames;
    const { spec } = watch;
    try {
      let shot;
      try {
        shot = await watch.ctx.capture({ maxWidth: spec.max_width, format: 'jpeg', region: spec.region });
      } catch (err) {
        if (watch.state === 'running') {
          const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'capture_failed';
          this.fail(watch, frame, { code, message: err instanceof Error ? err.message : String(err) }, false);
        }
        return;
      }
      if (watch.state !== 'running') return;

      const signature = frameSignature(shot.base64);
      const diff = watch.lastSignature ? signatureDifference(watch.lastSignature, signature) : 1;
      const changed = diff >= DIFF_THRESHOLD;
      if (spec.diff_only && watch.lastSignature && !changed) {
        watch.skipped += 1;
        watch.ctx.log('debug', 'vision watch: frame unchanged, skipped', { watch_id: watch.id, frame, diff });
        return;
      }

      const outcome = await this.describe(shot, spec.question, {
        model: spec.model,
        provider: spec.provider ?? 'api',
        ...(spec.cli ? { cli: spec.cli } : {}),
        signal: watch.abort.signal,
        log: watch.ctx.log,
      });
      if (watch.state !== 'running') return;
      if (!outcome.ok) {
        const permanent = outcome.code === 'auth' || outcome.code === 'bad_model';
        this.fail(
          watch,
          frame,
          {
            code: outcome.code,
            message: outcome.message,
            ...(outcome.status !== undefined ? { status: outcome.status } : {}),
            ...(outcome.stop_details ? { stop_details: outcome.stop_details } : {}),
          },
          permanent,
        );
        return;
      }

      watch.analysed += 1;
      watch.consecutiveErrors = 0;
      watch.lastSignature = signature;
      watch.lastAnswer = outcome.answer;
      watch.lastAt = this.now();
      this.emit(watch, {
        frame,
        answer: clipAnswer(outcome.answer),
        changed,
        diff: Math.round(diff * 1000) / 1000,
        model: outcome.model,
        provider: outcome.provider,
        model_ms: outcome.model_ms,
        ...(outcome.wall_ms !== undefined ? { wall_ms: outcome.wall_ms } : {}),
        usage: outcome.usage,
        captured_ms: shot.captured_ms,
        frame_path: shot.path,
        ...(outcome.truncated ? { truncated: true } : {}),
        ...this.pendingNote(watch),
        at: watch.lastAt,
      });
      if (watch.matcher && watch.matcher(outcome.answer)) this.end(watch, 'stop_when');
    } catch (err) {
      // Anything unexpected (a capture result without base64, a bug in the diff) counts as a
      // failed frame like a model error would, rather than rejecting the loop's promise.
      if (watch.state === 'running') {
        this.fail(watch, frame, { code: 'internal', message: `vision watch frame crashed: ${err instanceof Error ? err.message : String(err)}` }, false);
      }
    } finally {
      watch.inFlight = false;
      if (watch.state === 'running') {
        if (watch.frames >= spec.max_frames) {
          this.end(watch, 'max_frames');
        } else {
          watch.timer = setTimeout(() => this.run(watch), spec.interval_s * 1000);
        }
      } else {
        this.end(watch, 'stopped');
      }
    }
  }
}
