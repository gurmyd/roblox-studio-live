/**
 * The `look` tool: schema, description and dispatcher over one-shot / watch / stop / list.
 */
import { z } from 'zod';
import { CLI_MIN_INTERVAL_S, MODEL_RULE } from './cli.js';
import { CALL_BUDGET_MS, MAX_ANSWER_TOKENS, describeFrame, invalidModelSource, resolveModel, type ModelKind, type VisionFailure } from './model.js';
import { selectProvider, type ProviderSelection } from './provider.js';
import type { CaptureLike, ToolText, VisionContext } from './types.js';
import {
  DEFAULT_INTERVAL_S,
  DEFAULT_MAX_FRAMES,
  MAX_INTERVAL_S,
  MAX_MAX_FRAMES,
  MIN_INTERVAL_S,
  WatchManager,
  displayModel,
  type WatchSpec,
} from './watch.js';

/** Vision cost is per pixel (≈ width × height / 750 tokens); 768 px keeps a Studio frame near 500 tokens. */
export const DEFAULT_MAX_WIDTH = 768;
export const MIN_MAX_WIDTH = 64;
export const MAX_MAX_WIDTH = 2048;

export const lookToolName = 'look' as const;

export const lookToolDescription = [
  'Look at the Roblox Studio window through a vision model and get a short TEXT answer instead of an image — the screenshot never enters your context (a 768 px frame is ≈ 500 image tokens on the sidecar, a few hundred characters back to you).',
  "One-shot: {question, max_width? (768), region? {x,y,w,h} window px, model?} → {answer, model, provider, captured_ms, model_ms, usage, frame_path}. Ask concrete visual questions: 'is there a red error in the Output panel? quote it', 'where is the Play button (region or px)?', 'is the character standing on the platform or falling?'. The model sees only the screenshot and answers 'not visible' when it cannot tell.",
  "Watch: {watch: {question, interval_s (5, min 2; 15 on claude-cli), max_frames (60), stop_when? (substring, or /regex/i), diff_only? (true)}} → {watch_id}. Frames are analysed in the background, one model call at a time; each answer arrives as a Monitor event {type:'vision', watch_id, frame, answer, changed, provider}. With diff_only, frames whose bytes differ < 2% from the last analysed frame are skipped (no model call, no event). The watch ends on max_frames, when the answer matches stop_when, on {stop: watch_id | 'all'}, or after 3 consecutive failures; the last event has done:true and reason. {list: true} shows running watches with counts and the last answer.",
  'Prefer observe tree|props|find|player for state — they are exact and free. look is for what only pixels can tell: rendering, layout, UI text, visual glitches, what a playtest looks like. Works with an Anthropic API key (ANTHROPIC_API_KEY / `ant auth login`, ~2 s per look) OR a logged-in Claude Code install (`claude` on PATH, ~10–15 s per look on the subscription); STUDIO_LIVE_VISION_PROVIDER = auto (default) | api | claude-cli. Models: STUDIO_LIVE_VISION_MODEL (look; default claude-opus-5 / sonnet on the CLI) and STUDIO_LIVE_WATCH_MODEL (watch; default claude-sonnet-5 / haiku).',
].join('\n');

const regionSchema = z
  .object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() })
  .describe('Crop in window pixels before scaling (coordinates as in observe screenshot / windows)');

const watchSchema = z.object({
  question: z.string().min(1).max(2000).describe('Asked about every analysed frame'),
  interval_s: z
    .number()
    .min(MIN_INTERVAL_S)
    .max(MAX_INTERVAL_S)
    .optional()
    .describe(`Seconds between frames (default ${DEFAULT_INTERVAL_S}, min ${MIN_INTERVAL_S}; raised to ${CLI_MIN_INTERVAL_S} on the claude-cli provider)`),
  max_frames: z.number().int().min(1).max(MAX_MAX_FRAMES).optional().describe(`Stop after this many captured frames (default ${DEFAULT_MAX_FRAMES})`),
  stop_when: z.string().min(1).max(500).optional().describe('Stop when the answer contains this substring (case-insensitive) or matches /pattern/flags'),
  diff_only: z.boolean().optional().describe('Skip frames whose bytes differ < 2% from the last analysed frame (default true)'),
});

const shape = {
  question: z.string().min(1).max(2000).optional().describe('One-shot: what to look for in the Studio window'),
  max_width: z.number().int().min(MIN_MAX_WIDTH).max(MAX_MAX_WIDTH).optional().describe(`Frame width in px (default ${DEFAULT_MAX_WIDTH}; image tokens ≈ w×h/750)`),
  region: regionSchema.optional(),
  model: z.string().min(1).max(100).optional().describe('Model override: an id (default claude-opus-5 for look, claude-sonnet-5 for watch) or, on the claude-cli provider, an alias (sonnet / haiku / opus)'),
  watch: watchSchema.optional().describe('Start a background watch: frames → text events'),
  stop: z.string().min(1).max(64).optional().describe("Stop a watch by watch_id, or 'all'"),
  list: z.boolean().optional().describe('List running watches'),
};

export const lookToolShape: Record<string, z.ZodTypeAny> = shape;

const argsSchema = z.object(shape);
type LookArgs = z.infer<typeof argsSchema>;

const watches = new WatchManager();

function text(value: unknown, isError = false): ToolText {
  const body = JSON.stringify(value, null, 1);
  return isError ? { content: [{ type: 'text', text: body }], isError: true } : { content: [{ type: 'text', text: body }] };
}

function errorText(code: string, message: string, extra: Record<string, unknown> = {}): ToolText {
  return text({ error: { code, message, ...extra } }, true);
}

function captureCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code ? code : 'capture_failed';
}

/** `bad_request` naming the argument or env var that holds an unusable model string, or null. */
function modelError(kind: ModelKind, override: string | undefined): ToolText | null {
  const source = invalidModelSource(kind, override);
  return source ? errorText('bad_request', `${source} is not a model id or alias: ${MODEL_RULE}`) : null;
}

function failureExtra(failure: VisionFailure): Record<string, unknown> {
  return {
    provider: failure.provider,
    requested_model: failure.requested_model,
    model_ms: failure.model_ms,
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.stop_details ? { stop_details: failure.stop_details } : {}),
    ...(failure.answer ? { partial_answer: failure.answer } : {}),
    ...(failure.usage ? { usage: failure.usage } : {}),
    ...(failure.retryable ? { retryable: true } : {}),
  };
}

async function lookOnce(args: LookArgs, question: string, ctx: VisionContext): Promise<ToolText> {
  const badModel = modelError('look', args.model);
  if (badModel) return badModel;
  let shot: CaptureLike;
  try {
    shot = await ctx.capture({ maxWidth: args.max_width ?? DEFAULT_MAX_WIDTH, format: 'jpeg', region: args.region });
  } catch (err) {
    return errorText(captureCode(err), err instanceof Error ? err.message : String(err));
  }
  const choice = await selectProvider({ log: ctx.log });
  if (!choice.provider) {
    ctx.log('warn', 'vision look: no provider', { code: choice.code, message: choice.message });
    return errorText(choice.code, choice.message, { frame_path: shot.path });
  }
  const model = resolveModel('look', args.model, choice.provider);
  ctx.log('debug', 'vision look', { model, provider: choice.provider, width: shot.width, height: shot.height, bytes: shot.bytes });
  // One-shot calls are bounded by CALL_BUDGET_MS inside describeFrame (code 'timeout' when hit).
  const outcome = await describeFrame(shot, question, {
    model,
    provider: choice.provider,
    ...(choice.cli ? { cli: choice.cli } : {}),
    log: ctx.log,
    budgetMs: CALL_BUDGET_MS,
  });
  if (!outcome.ok) {
    ctx.log('warn', 'vision look failed', { code: outcome.code, message: outcome.message, provider: outcome.provider });
    return errorText(outcome.code, outcome.message, { ...failureExtra(outcome), frame_path: shot.path });
  }
  return text({
    answer: outcome.answer,
    model: outcome.model,
    provider: outcome.provider,
    ...(outcome.model !== outcome.requested_model ? { requested_model: outcome.requested_model } : {}),
    ...(outcome.fallback ? { fallback: true } : {}),
    ...(outcome.truncated
      ? {
          truncated: true,
          note: `max_tokens (${MAX_ANSWER_TOKENS}) was reached before the answer finished${outcome.answer ? '' : ' — no text was produced'}; usage.output_tokens (${outcome.usage.output_tokens}) includes the model's thinking. Ask a narrower question or crop with region.`,
        }
      : {}),
    captured_ms: shot.captured_ms,
    model_ms: outcome.model_ms,
    ...(outcome.wall_ms !== undefined ? { wall_ms: outcome.wall_ms } : {}),
    usage: outcome.usage,
    frame_path: shot.path,
    width: shot.width,
    height: shot.height,
  });
}

/** The interval a watch runs at on this provider; the CLI is too slow for anything under CLI_MIN_INTERVAL_S. */
function watchInterval(requested: number | undefined, choice: ProviderSelection): { interval_s: number; clamped: boolean; requested: number } {
  const min = choice.provider === 'claude-cli' ? CLI_MIN_INTERVAL_S : MIN_INTERVAL_S;
  const wanted = requested ?? Math.max(DEFAULT_INTERVAL_S, min);
  return { interval_s: Math.max(wanted, min), clamped: wanted < min, requested: wanted };
}

async function startWatch(args: LookArgs, watch: NonNullable<LookArgs['watch']>, ctx: VisionContext): Promise<ToolText> {
  const badModel = modelError('watch', args.model);
  if (badModel) return badModel;
  const choice = await selectProvider({ log: ctx.log });
  if (!choice.provider) {
    ctx.log('warn', 'vision watch: no provider', { code: choice.code, message: choice.message });
    return errorText(choice.code, choice.message);
  }
  const interval = watchInterval(watch.interval_s, choice);
  const clampNote = interval.clamped
    ? `interval_s raised from ${interval.requested} to ${interval.interval_s}: the claude-cli provider needs ~10–15 s per frame, so a watch on it never captures more often than every ${CLI_MIN_INTERVAL_S} s`
    : null;
  const spec: WatchSpec = {
    question: watch.question,
    interval_s: interval.interval_s,
    max_frames: watch.max_frames ?? DEFAULT_MAX_FRAMES,
    diff_only: watch.diff_only ?? true,
    model: resolveModel('watch', args.model, choice.provider),
    provider: choice.provider,
    max_width: args.max_width ?? DEFAULT_MAX_WIDTH,
    ...(choice.cli ? { cli: choice.cli } : {}),
    ...(clampNote ? { note: clampNote } : {}),
    ...(watch.stop_when !== undefined ? { stop_when: watch.stop_when } : {}),
    ...(args.region ? { region: args.region } : {}),
  };
  let summary;
  try {
    summary = watches.start(spec, ctx);
  } catch (err) {
    return errorText('bad_request', err instanceof Error ? err.message : String(err));
  }
  return text({
    watch_id: summary.watch_id,
    model: displayModel(spec),
    provider: summary.provider,
    interval_s: summary.interval_s,
    ...(interval.clamped ? { interval_clamped: { requested: interval.requested, min: CLI_MIN_INTERVAL_S } } : {}),
    max_frames: summary.max_frames,
    diff_only: summary.diff_only,
    stop_when: summary.stop_when,
    max_width: spec.max_width,
    note: `analysing a frame every ${summary.interval_s} s via ${summary.provider}; answers arrive as {type:'vision', watch_id:'${summary.watch_id}'} events (Monitor on /events); look {stop:'${summary.watch_id}'} ends it early, look {list:true} shows progress${clampNote ? `. ${clampNote}` : ''}`,
  });
}

async function stopWatches(target: string): Promise<ToolText> {
  if (target === 'all') {
    const stopped = await watches.stopAll();
    return text({ stopped });
  }
  const settled = watches.settled(target);
  if (!watches.stop(target)) return errorText('not_found', `no running watch '${target}' (look {list:true} shows running watches)`);
  await settled;
  return text({ stopped: [target] });
}

/**
 * Dispatches one `look` call. Precedence when several modes are given: list, stop, watch, question.
 * Never throws: schema and runtime failures come back as {error:{code,message}} with isError.
 */
export async function runLookTool(args: unknown, ctx: VisionContext): Promise<ToolText> {
  const parsed = argsSchema.safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return errorText('bad_request', issues);
  }
  const a = parsed.data;
  if (a.list) return text({ watches: watches.list() });
  if (a.stop !== undefined) return stopWatches(a.stop);
  if (a.watch) return startWatch(a, a.watch, ctx);
  if (a.question !== undefined) return lookOnce(a, a.question, ctx);
  return errorText('bad_request', "pass question (one-shot look), watch:{question,…} (background watch), stop: watch_id | 'all', or list: true");
}

/** Stops every running watch and resolves once their loops have wound down (bridge shutdown). */
export async function stopAllWatches(): Promise<void> {
  await watches.stopAll();
}

/** Running watches (for status pages and tests). */
export function listWatches(): ReturnType<WatchManager['list']> {
  return watches.list();
}
