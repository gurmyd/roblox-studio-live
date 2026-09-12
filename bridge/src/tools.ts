import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { CaptureOptions, CaptureResult, StudioWindow } from './capture/index.js';
import { cloudToolDescription, cloudToolName, cloudToolShape, runCloudTool, type CloudContext, type CloudIds } from './cloud/index.js';
import { DEFAULT_GEOMETRY_POLICY, GEOMETRY_POLICIES, type GeometryPolicy } from './config.js';
import { BridgeError, errorCode, errorMessage } from './errors.js';
import { makeFilter } from './journal.js';
import { MAX_JOB_WAIT_MS, type Job, type JobOrigin, type JobStore } from './jobs.js';
import type { Logger } from './log.js';
import { fileHint, isMalformedStringError, PROGRAM_FILE_MAX_BYTES, rawNewlineLine, readProgramArg, transportHint } from './program.js';
import { DEFAULT_DEADLINE_MS, DM_PATTERN, type JsonObject, type JsonValue, type ResError } from './protocol.js';
import { RESULT_CHAR_BUDGET, errorResult, imageResult, takeWithinBudget, textResult, toJsonValue } from './result.js';
import type { HubSession, RequestOptions, SessionRegistry } from './session.js';
import type { SkillStore } from './skills.js';
import { lookToolDescription, lookToolName, lookToolShape, runLookTool, type VisionContext, type VisionEvent } from './vision/index.js';

export const DEFAULT_WAIT_MS = 25_000;
const MAX_TIMEOUT_MS = 600_000;
const RUN_UNTIL_MAX_MS = 120_000;
/** Longest single hold/wait in an input step (matches the runtime's own cap). */
const INPUT_STEP_MAX_MS = 60_000;
/** Slack added to executor deadlines so a legitimate `run_until` timeout still arrives as a response. */
const DEADLINE_SLACK_MS = 5_000;
const CANCEL_SETTLE_MS = 2_000;
/** Spawning client Studio processes (multiplayer start / add_players) takes tens of seconds each; the hub waits, the bridge must not give up first. */
const MULTIPLAYER_DEADLINE_MS = 120_000;
const MAX_PLAYERS = 8;
const DEFAULT_MULTIPLAYER_PLAYERS = 2;
/** How persisted controllers behave (protocol Notes); repeated on `playtest list` so the agent never has to guess. */
export const CONTROLLER_PERSISTENCE_NOTE =
  'persist=true controllers are stored by the bridge (per session in memory, mirrored to <home>/persist/<placeId>.json when the place has an id; an unsaved place (placeId 0) is memory-only and loses them on a bridge restart) and synced to the hub on every connect: re-installed whenever their DM appears in a later playtest, kept across hub runtime restarts and bridge restarts, removed by uninstall or by a later install of the same name without persist';
/** `observe logs` accepts every DM plus `all` (the hub's merged journal; each line carries `src`). */
const OBSERVE_DM_PATTERN = /^(edit|server|client(:[1-9]\d*)?|all)$/;
/** Room left in the result budget for the fields around a cursored list (events, logs). */
const LIST_ENVELOPE_CHARS = 3_000;

export const TOOL_NAMES = ['run', 'observe', 'playtest', 'input', 'events', 'skills', 'job', cloudToolName, lookToolName] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const sessionArg = z
  .string()
  .optional()
  .describe('Studio session GUID or unique prefix (default: the active hub; required for writes when several Studios are connected)');
const waitArg = z
  .number()
  .int()
  .min(0)
  .max(MAX_JOB_WAIT_MS)
  .optional()
  .describe('Wait this long for completion before returning a {job_id,status:"running"} handle (default 25000)');
const dmArg = z
  .string()
  .regex(DM_PATTERN, "dm must be 'edit', 'server', 'client' or 'client:N'")
  .optional()
  .describe("Target DataModel: 'edit' (default) | 'server' | 'client' (lowest-numbered) | 'client:N'");
const timeoutArg = z.number().int().min(100).max(MAX_TIMEOUT_MS).optional().describe('Executor deadline in ms (default 30000)');
const argsArg = z.record(z.unknown()).optional().describe('Available to the program as ARGS');
const responseFormatArg = z.enum(['concise', 'detailed']).optional();
/** Geometry check of the parts a run created (protocol §4.1); the bridge default fills an absent value on edit-DM runs. */
const geometryPolicyArg = z
  .enum(GEOMETRY_POLICIES)
  .optional()
  .describe('warn (default; env STUDIO_LIVE_GEOMETRY_POLICY): overlapping/nested parts → result.geometry + warnings; reject: such a run is rolled back (error geometry_violation); off: no check. Play DMs check only when set');
/** Overlap tolerance in studs: faces closer than this count as touching, not overlapping (runtime default 0.05). */
const GEOMETRY_TOLERANCE_MAX = 5;

const programFileArg = (what: string): z.ZodOptional<z.ZodString> =>
  z
    .string()
    .min(1)
    .optional()
    .describe(`${what}: absolute path of a file holding the Luau (read by the bridge; UTF-8, BOM ok, ≤ ${PROGRAM_FILE_MAX_BYTES / (1024 * 1024)} MB). No shell/JSON escaping touches it`);

const runShape = {
  code: z.string().min(1).optional().describe('Luau program. Globals: S (resident API), ARGS, print/warn (captured), game, workspace, task. A top-level `return` is captured.'),
  code_file: programFileArg('Instead of code'),
  dm: dmArg,
  args: argsArg,
  undo_label: z.string().max(200).optional().describe('ChangeHistory waypoint name (edit DM)'),
  dry_run: z.boolean().optional().describe('edit DM only: run, then roll back'),
  geometry_policy: geometryPolicyArg,
  timeout_ms: timeoutArg,
  response_format: responseFormatArg.describe("detailed: full 12-component CFrames ('c') in the returned value (default concise)"),
  wait_ms: waitArg,
  session: sessionArg,
};

const observeShape = {
  what: z.enum(['status', 'tree', 'props', 'find', 'diff', 'logs', 'script', 'geometry', 'stats', 'selection', 'player', 'screenshot', 'windows', 'selftest']),
  dm: z
    .string()
    .regex(OBSERVE_DM_PATTERN, "dm must be 'edit', 'server', 'client', 'client:N' or (logs only) 'all'")
    .optional()
    .describe("Target DataModel: 'edit' (default) | 'server' | 'client' | 'client:N'; logs also accepts 'all' (merged journal)"),
  root: z.string().optional().describe('tree/find: root path (default game); geometry: default Workspace'),
  path: z.string().optional().describe('script: path of a Script/LocalScript/ModuleScript'),
  from: z.number().int().min(1).optional().describe('script: first line (1-based, default 1)'),
  to: z.number().int().min(1).optional().describe('script: last line inclusive (default: end)'),
  depth: z.number().int().min(0).max(6).optional().describe('tree: default 2, max 6'),
  max: z.number().int().min(1).max(5000).optional().describe('tree: default 500; find: default 100; geometry: parts checked (default 5000, sampled beyond)'),
  tolerance: z.number().min(0).max(GEOMETRY_TOLERANCE_MAX).optional().describe('geometry: studs of penetration ignored so touching faces are not overlaps (default 0.05)'),
  include_nested: z.boolean().optional().describe('geometry: also list BaseParts parented under BaseParts (default true)'),
  classes: z.array(z.string()).optional().describe('tree: keep only these classes'),
  fields: z.array(z.string()).optional().describe('tree: extra props per node, e.g. ["Position","Size"]'),
  paths: z.array(z.string()).optional().describe('props: instance paths'),
  props: z.array(z.string()).optional().describe('props: property names (default: notable props, ≤ 60)'),
  name: z.string().optional().describe('find: name substring, case-insensitive'),
  class: z.string().optional().describe('find: IsA class'),
  tag: z.string().optional().describe('find: CollectionService tag'),
  attr: z.object({ name: z.string(), value: z.unknown().optional() }).optional().describe('find: attribute match'),
  prop: z.object({ name: z.string(), value: z.unknown() }).optional().describe('find: property match'),
  since: z.number().int().min(0).optional().describe('diff/logs: seq cursor'),
  level: z.enum(['print', 'info', 'warn', 'error']).optional().describe('logs: minimum level'),
  filter: z.string().optional().describe('logs: substring'),
  tail: z.number().int().min(1).max(1000).optional().describe('logs: default 100'),
  response_format: responseFormatArg.describe('concise ≈ 20 KB (default) | detailed ≈ 200 KB'),
  max_width: z
    .number()
    .int()
    .min(0)
    .max(4096)
    .refine((v) => v === 0 || v >= 64, { message: 'max_width must be 0 (no scaling) or between 64 and 4096' })
    .optional()
    .describe('screenshot: default 1024; 0 disables scaling'),
  format: z.enum(['jpeg', 'png']).optional().describe('screenshot: default jpeg'),
  quality: z.number().int().min(1).max(100).optional().describe('screenshot: jpeg quality, default 70'),
  region: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional().describe('screenshot: crop in window pixels'),
  restore: z.boolean().optional().describe('screenshot: un-minimize without stealing focus (default true)'),
  hwnd: z.string().regex(/^\d{1,19}$/, 'hwnd is a decimal window handle from observe windows').optional().describe('screenshot: pin one Studio window (from observe windows)'),
  title_match: z.string().optional().describe('screenshot: choose the Studio window whose title contains this (case-insensitive)'),
  wait_ms: waitArg,
  session: sessionArg,
};

const playtestShape = {
  action: z.enum(['start', 'stop', 'status', 'run_until', 'install', 'uninstall', 'list', 'hotpatch', 'add_players', 'push']),
  mode: z.enum(['play', 'run', 'multiplayer']).optional().describe('start: default play'),
  players: z.number().int().min(1).max(MAX_PLAYERS).optional().describe('start (multiplayer): client Studio processes to spawn, 1-8 (default 2)'),
  count: z.number().int().min(1).max(MAX_PLAYERS).optional().describe('add_players: clients to add to the running multiplayer test, 1-8 (default 1)'),
  paths: z.array(z.string().min(1)).min(1).max(200).optional().describe('push: edit-DM instance paths to serialize into the live DM'),
  parent: z.string().optional().describe('push: parent path in the target DM (default: each instance lands at its own edit-DM path)'),
  replace: z.boolean().optional().describe('push: destroy a same-named sibling at the target parent first (default true); false keeps both'),
  dm: dmArg,
  predicate: z.string().optional().describe('run_until: Luau expression or chunk; truthy ends the wait'),
  predicate_file: programFileArg('run_until: instead of predicate'),
  timeout_ms: z.number().int().min(100).max(RUN_UNTIL_MAX_MS).optional().describe('run_until/push: default 30000, max 120000'),
  interval_ms: z.number().int().min(0).max(10_000).optional().describe('run_until: 0 = every Heartbeat (default)'),
  args: argsArg,
  name: z.string().optional().describe('install/uninstall: controller name'),
  code: z.string().optional().describe('install: Luau returning { load = function(ctx) … end, unload = function() … end }'),
  code_file: programFileArg('install: instead of code'),
  persist: z.boolean().optional().describe('install: keep it in the bridge and re-install whenever that DM appears in a later playtest'),
  path: z.string().optional().describe('hotpatch: script path, e.g. ServerScriptService.Main'),
  source: z.string().optional().describe('hotpatch: full new source'),
  source_file: programFileArg('hotpatch: instead of source'),
  restart: z.boolean().optional().describe('hotpatch: toggle Disabled to restart the script (default true)'),
  wait_ms: waitArg,
  session: sessionArg,
};

const inputAction = z
  .object({
    type: z.enum(['key', 'click', 'move', 'look', 'text', 'wait', 'focus']),
    key: z.string().optional(),
    hold_ms: z.number().int().min(0).max(INPUT_STEP_MAX_MS).optional(),
    down: z.boolean().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    button: z.enum(['left', 'right', 'middle']).optional(),
    dx: z.number().optional(),
    dy: z.number().optional(),
    text: z.string().optional(),
    ms: z.number().int().min(0).max(INPUT_STEP_MAX_MS).optional(),
    path: z.string().optional(),
    gui: z.boolean().optional(),
  })
  .passthrough();

const inputShape = {
  actions: z.array(inputAction).min(1).max(200),
  dm: dmArg,
  abort_on_error: z.boolean().optional().describe('Stop at the first failing step (default false)'),
  wait_ms: waitArg,
  session: sessionArg,
};

const eventsShape = {
  since: z.number().int().min(0).optional().describe('Return events with seq > since (default 0)'),
  kinds: z.array(z.string()).optional().describe('Event types to include (default all)'),
  levels: z.array(z.string()).optional().describe('log levels to include: print|info|warn|error (default all)'),
  timeout_ms: z.number().int().min(0).max(MAX_JOB_WAIT_MS).optional().describe('Long-poll up to this long for a matching event (default 0 = return now)'),
  limit: z.number().int().min(1).max(2000).optional().describe('Max events (default 500)'),
  session: sessionArg,
};

const skillsShape = {
  action: z.enum(['list', 'get', 'save', 'delete', 'run']),
  name: z.string().optional().describe('Skill name: letters, digits, _ or - (max 64)'),
  source: z.string().optional().describe('save: Luau program (same environment as run)'),
  source_file: programFileArg('save: instead of source'),
  description: z.string().optional().describe('save: one-line description'),
  params: z.record(z.unknown()).optional().describe('save: JSON describing the expected ARGS'),
  args: argsArg,
  dm: dmArg,
  undo_label: z.string().max(200).optional().describe('run: ChangeHistory waypoint name (default "skill: <name>")'),
  dry_run: z.boolean().optional().describe('run: edit DM only: run, then roll back'),
  geometry_policy: geometryPolicyArg,
  timeout_ms: timeoutArg,
  response_format: responseFormatArg.describe('run: as for the run tool'),
  wait_ms: waitArg,
  session: sessionArg,
};

const jobShape = {
  action: z.enum(['status', 'cancel', 'wait', 'list']),
  job_id: z.string().optional().describe('The job handle returned by a running tool call (status/cancel/wait)'),
  wait_ms: z.number().int().min(0).max(MAX_JOB_WAIT_MS).optional().describe('wait: max time to block (default 25000, max 50000)'),
};

type RunArgs = z.infer<z.ZodObject<typeof runShape>>;
type ObserveArgs = z.infer<z.ZodObject<typeof observeShape>>;
type PlaytestArgs = z.infer<z.ZodObject<typeof playtestShape>>;
type InputArgs = z.infer<z.ZodObject<typeof inputShape>>;
type EventsArgs = z.infer<z.ZodObject<typeof eventsShape>>;
type SkillsArgs = z.infer<z.ZodObject<typeof skillsShape>>;
type JobArgs = z.infer<z.ZodObject<typeof jobShape>>;

export interface ToolSpec {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
}

const readOnly: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'run',
    title: 'Run Luau in Studio',
    description: [
      'Run a Luau program in Roblox Studio against the resident `S` API. Ship whole programs, not micro-calls: build, query and verify in one call and `return` one JSON-safe summary. Globals: S, ARGS (= args), print/warn (captured), game, workspace, task.',
      "dm 'edit' (default): ONE ChangeHistory recording — one undo step, rolled back on error/timeout. 'server' | 'client' | 'client:N': inside the live playtest, ephemeral (lost on stop, not undoable).",
      '`code` or `code_file` (absolute path the bridge reads). Never heredoc Luau: \\n in a string becomes a real newline → syntax_error "Malformed string".',
      'S: get, ensure(path,class,props), find{root,name,class,tag,attr,max}, tree, props, new, set (unwritable props → result.unwritable), batchSet, clone, destroy (undoable), part, model, grid, placeOn(part,target,{align,gap}) sets a part on top of target, fits(cframe,size) → ok, blockers, overlaps(parts), script.get(path,{from,to})/set/patch/restart/create, emit, log, yield() (in long loops), wait, raycast, distance, remaining().',
      'Geometry is enforced: parts intersecting parts (touching faces are fine) and BaseParts parented under BaseParts (use Models/Folders) are reported. geometry_policy warn (default) → result.geometry {overlaps[{a,b,depth}], nested[{path,parent}], checked, totals} + warnings; reject → rolled back, error geometry_violation with the report; off. Fix before moving on.',
      "Result: {value, output[], duration_ms, changes{added,removed,paths}, undo: committed|cancelled|unavailable|n/a, ephemeral, dm, warnings?, detached?, unwritable?, geometry?}. response_format 'detailed' adds 12-component CFrames. Errors: {error:{code: luau_error|syntax_error|timeout|no_peer|cancelled|busy|geometry_violation|…, message, stack, output}}.",
      "Still running after wait_ms (default 25000)? {job_id, status:'running'} — the program keeps running; use `job`. Edit-DM writes queue FIFO. dry_run (edit only) rolls back; a raw :Destroy() is neither rolled back nor undoable (use S.destroy). Several Studios connected: pass `session`.",
    ].join('\n'),
    inputSchema: runShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'observe',
    title: 'Observe Studio',
    description: [
      'Read-only view of Studio. what:',
      '- status: session, place{placeId,placeName,universeId,creatorType,creatorId}, peers, playtest, capabilities, fps, journal seq.',
      '- tree: root (game), depth (2, max 6), max (500), classes, fields (extra props) → {nodes:[{path,class,name,n,props?}], truncated} (explicit root always returned).',
      '- props: paths[], props[] → {items:[{path,class,props}], missing} (unreadable props omitted).',
      '- find: root, name (substring), class (IsA), tag, attr{name,value}, prop{name,value} → {items, total}.',
      '- diff: since (seq) → {added[], removed[]} instance paths changed since a cursor.',
      "- logs: since, level, filter, tail (100), dm ('all' = merged journal, lines carry src) → {items:[{seq,t,level,msg,src}], next}; startup prints of play DMs included.",
      '- script: path, from, to (1-based lines) → {path, class, lines, total_lines, text} (not cut at 8 KB). stats: fps, frameMs, heartbeatMs, physicsMs, instances, memoryMB. selection: {paths} (edit only).',
      '- geometry: root (Workspace), max (5000; sampled beyond), tolerance (0.05), include_nested (true) → {overlaps:[{a,b,depth}], nested:[{path,parent}], checked, sampled, ms, totals}: parts intersecting parts, BaseParts under BaseParts. Audit a build; fix all listed.',
      '- player: dm (client) → name, position, velocity, state, health, walkSpeed, cameraCFrame, floorMaterial, seated.',
      '- screenshot: the Studio window captured by the bridge (works occluded, un-minimizes without focus). max_width (1024; 0 = none), format jpeg|png, quality (70), region{x,y,w,h} window px, hwnd | title_match → image + {path,width,height,source_width,source_height,scale,windowTitle,hwnd,captured_ms}; image px × scale = window px. windows: lists Studio windows.',
      "- selftest: the hub's runtime self-check → {ok, checks[]}; use after install or when results look wrong.",
      "Prefer structured reads (exact, cheap); screenshots only for visual checks (`look` answers them in text). dm routes the read into the playtest. response_format 'detailed': ~200 KB cap, full CFrames.",
    ].join('\n'),
    inputSchema: observeShape,
    annotations: readOnly,
  },
  {
    name: 'playtest',
    title: 'Playtest control',
    description: [
      'Control the live playtest and the in-engine runtime. Keep ONE playtest alive; a restart costs ~3 s and loses play-DM state.',
      '- start {mode: play|run|multiplayer, players}: waits for the runtimes → {running, mode, players, peers, started_ms}. multiplayer spawns a server DM plus `players` (1-8, default 2) client Studios (client:1..N; slow → job handle). no_peer: turn on "Load User Plugins In Run Modes" / install the plugin (test still running: Stop in Studio).',
      '- stop → {stopped_ms}. status → {running, mode, players, peers, elapsed_s, controllers}. add_players {count} (multiplayer).',
      "- run_until {dm, predicate | predicate_file, timeout_ms ≤ 120000, interval_ms, args}: Luau predicate evaluated in-engine each Heartbeat until truthy → {result: true|'timeout', value, elapsed_ms, checks}.",
      '- install {dm, name, code | code_file, persist}: code returns { load = function(ctx) … end, unload = function() … end }. ctx: S, assert(name,cond,detail), milestone, emit, log, onHeartbeat, onEvent, every, after, player, character(), input.*, moveTo (straight line), pathTo (pathfinding), state(), storage. Same name replaces; asserts/milestones → /events. persist: kept by the bridge, re-installed whenever that DM appears in a later playtest.',
      '- uninstall {dm, name} (drops the persisted entry). list → controllers on all peers + persisted.',
      '- hotpatch {dm, path, source | source_file, restart}: writes a script Source in the live DM and restarts it, playtest kept (ModuleScript: re-require needed).',
      '- push {paths, dm, parent, replace}: copies edit-DM instances into the live DM at their own paths (or under parent) → {dm, paths, count, bytes, replaced, skipped?, replicated}; replace (default true) removes a same-name, same-class sibling first (never Terrain, the camera, a character); ephemeral, not undoable.',
      "dm: 'server' | 'client' | 'client:N'. *_file = absolute path the bridge reads (never heredoc Luau). Slow actions return {job_id, status:'running'} after wait_ms; use `job`.",
    ].join('\n'),
    inputSchema: playtestShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'input',
    title: 'Virtual input',
    description: [
      "Human-like input in a play client through the real input pipeline (dm 'client' = lowest-numbered client, or 'client:N'). actions run in order:",
      "- {type:'key', key:'W', hold_ms:600 (≤ 60000)} press, hold, release; {type:'key', key:'Space', down:true|false} single edge",
      "- {type:'click', x, y, button:'left'|'right'|'middle'} down, 50 ms, up; {type:'move', x, y} absolute cursor; {type:'look', dx, dy} relative camera look — best effort: the step fails unless the camera actually rotated (the default camera script ignores virtual deltas; drive workspace.CurrentCamera from a `run` instead)",
      "- {type:'text', text}; {type:'focus', path:'PlayerGui.Hud.Input'} TextBox:CaptureFocus(); {type:'wait', ms (≤ 60000)}",
      'x,y default to GUI space (gui: true): the coordinates a GuiObject reports as AbsolutePosition; the runtime adds GuiService:GetGuiInset(). gui: false sends raw viewport pixels (inset included). Screenshot pixels are NOT viewport pixels: the screenshot is the whole Studio window scaled by `scale`; the 3D viewport sits inside it at an offset you must calibrate (see the agent guide). Input only reaches the game while the Studio window renders (not minimized).',
      'Result: {steps:[{i, ok, error?}], elapsed_ms}. A failing step does not abort the sequence unless abort_on_error=true; keys still held when a sequence aborts or is cancelled are released. No scroll action: virtual input produces no MouseWheel events. For reactive or long-running input, install a controller with `playtest`.',
    ].join('\n'),
    inputSchema: inputShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'events',
    title: 'Event journal',
    description: [
      "Backfill from the bridge's event journal (ring of 10,000 per session). Returns events with seq > since, oldest first → {cursor, events[], dropped, truncated, latest_seq, hub_dropped}. cursor is the seq of the last event actually returned: pass it as the next since. truncated means more events wait after cursor; dropped > 0 means the ring evicted events you never saw.",
      'kinds filters by event type: log, error, assert, milestone, custom, playtest, peer, selection, job, controller, change (default all); levels filters log events (print|info|warn|error).',
      'timeout_ms > 0 long-polls: returns as soon as a matching event arrives, or empty when the timeout (≤ 50000) elapses.',
      'This is the portable fallback to push. Prefer Monitor on ws://127.0.0.1:<port>/events: batched frames ≤ 4 KB carrying seq and dropped; default kinds error, assert, milestone, custom, playtest, peer, controller, job plus warn/error logs (?kinds=…&levels=… per socket). After any dropped > 0 or seq gap on the socket, call events with since = the last seq you saw.',
    ].join('\n'),
    inputSchema: eventsShape,
    annotations: readOnly,
  },
  {
    name: 'skills',
    title: 'Skill library',
    description: [
      'Luau program library on disk (<home>/skills/<name>.luau with a `--[[ studio-live skill … ]]` header holding name, description and params). Save programs you will run again; run them with args (ARGS), same environment and result shape as `run`.',
      'action: list → [{name, description, params, builtin}]; get {name} → {source, …}; save {name, source | source_file (absolute path), description, params}; delete {name}; run {name, args, dm, undo_label, dry_run, geometry_policy, timeout_ms, response_format, wait_ms, session} → the run result (geometry checked exactly as for `run`).',
      'Builtins ship read-only (builtin: true): settle_physics, device_sim, profile_scripts, bulk_attributes, insert_asset, lighting_preset, list_scripts, remote_map — `get` one to read its params. Saving a skill with a builtin name overrides it; deleting the override restores it; builtins themselves cannot be deleted.',
    ].join('\n'),
    inputSchema: skillsShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'job',
    title: 'Job handle',
    description: [
      "Track long operations that returned {job_id, status:'running'}.",
      'status {job_id} → {status: running|done|error, op, dm, elapsed_ms, progress, notes, hub_connected, result?, error?}. wait {job_id, wait_ms ≤ 50000} blocks until the job finishes or the wait elapses, then returns the same snapshot. list → {jobs:[…]} running first, then recent ones (find an id you lost).',
      "cancel {job_id} asks Studio to stop the program at its next S.yield()/slice boundary and rolls back an edit-DM recording; the job then finishes with error.code 'cancelled'. Jobs survive a Studio reconnect (hub_connected false while it is away) and end at their deadline. Finished jobs expire 10 minutes after completion.",
    ].join('\n'),
    inputSchema: jobShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    // Open Cloud (bridge/src/cloud): ids default from the active session's hello/hb identity.
    name: cloudToolName,
    title: 'Roblox Open Cloud',
    description: cloudToolDescription,
    inputSchema: cloudToolShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    // Vision sidecar (bridge/src/vision): screenshots → text through the Claude API; never writes to Studio.
    name: lookToolName,
    title: 'Look at Studio',
    description: lookToolDescription,
    inputSchema: lookToolShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

export function getToolSpec(name: string): ToolSpec | undefined {
  return TOOL_SPECS.find((spec) => spec.name === name);
}

/** Who is calling and whether the MCP request can be cancelled underneath us. */
export interface CallContext {
  origin: JobOrigin;
  signal?: AbortSignal | undefined;
}

export interface ToolExecutor {
  call(name: string, args: unknown, context?: CallContext): Promise<CallToolResult>;
}

/** The subset of ./capture/index.js the tools need; injected so tests can stub it. */
export interface CaptureApi {
  captureStudio(opts?: CaptureOptions): Promise<CaptureResult>;
  listStudioWindows?(): Promise<StudioWindow[]>;
}

export interface LocalExecutorDeps {
  registry: SessionRegistry;
  jobs: JobStore;
  skills: SkillStore;
  capture: CaptureApi;
  log: Logger;
  /** Read at call time, so a port bound after construction is reported correctly. */
  bridge: { version: string; port: number; bootstrapVersion: string | null };
  /** STUDIO_LIVE_HOME: the `cloud` tool reads its API key file here. */
  home: string;
  /** Sink for bridge-made events (`vision`): delivered to /events sockets, never journaled. Optional (tests). */
  localEvents?: (event: VisionEvent) => void;
  /** Default `geometry_policy` for edit-DM runs (config.geometryPolicy, from STUDIO_LIVE_GEOMETRY_POLICY); `warn` when omitted. */
  geometryPolicy?: GeometryPolicy;
}

/**
 * The `geometry_policy` a run body carries (protocol §4.1 Notes): on the edit DM the explicit argument
 * or the bridge default, so the runtime never has to guess what the operator configured; on play DMs
 * only an explicit argument — their parts are ephemeral, so the check runs only when asked for.
 */
export function geometryPolicyFor(dm: string | undefined, explicit: GeometryPolicy | undefined, fallback: GeometryPolicy): GeometryPolicy | undefined {
  if (explicit !== undefined) return explicit;
  return dm === undefined || dm === 'edit' ? fallback : undefined;
}

/**
 * Ids the `cloud` tool defaults from: `universeId` / `creatorType` / `creatorId` stay undefined (not 0)
 * until an `hb` carried them, so the tool can tell "not reported yet" from "unpublished" (docs/cloud.md §2).
 */
export function cloudIdsOf(session: HubSession | null): CloudIds | null {
  if (!session) return null;
  const studio = session.studio ?? {};
  const creatorType = studio.creatorType === 'User' || studio.creatorType === 'Group' ? studio.creatorType : undefined;
  return {
    ...(typeof studio.universeId === 'number' ? { universeId: studio.universeId } : {}),
    ...(typeof studio.placeId === 'number' ? { placeId: studio.placeId } : {}),
    ...(creatorType !== undefined ? { creatorType } : {}),
    ...(typeof studio.creatorId === 'number' ? { creatorId: studio.creatorId } : {}),
    ...(typeof studio.placeName === 'string' && studio.placeName !== '' ? { placeName: studio.placeName } : {}),
  };
}

/** Drops undefined values and converts to plain JSON so the body is wire-safe. */
function bodyOf(fields: Record<string, unknown>): JsonObject {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
  return toJsonValue(out) as JsonObject;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Outcome =
  | { state: 'running'; result: CallToolResult }
  | { state: 'error'; result: CallToolResult }
  | { state: 'done'; value: JsonObject };

/** Extra fields for an error result, computed from the executor's error (e.g. the transport hint). */
type ErrorExtras = (error: ResError) => Record<string, unknown>;

/**
 * A `syntax_error` saying "Malformed string" on code that has a raw newline inside a quoted literal
 * is the heredoc bug, not a bridge bug (docs/multi-agent-build-report.md F1): name the fix. When
 * the program already came from `<field>_file`, the file itself holds the newline — say which line
 * instead of telling the agent to do what it just did.
 */
function transportHintFor(code: string | undefined, fileField: string, fromFile: boolean): ErrorExtras | undefined {
  if (code === undefined) return undefined;
  return (error) => {
    if (error.code !== 'syntax_error' || !isMalformedStringError(error.message)) return {};
    const line = rawNewlineLine(code);
    if (line === null) return {};
    return { hint: fromFile ? fileHint(fileField, line) : transportHint(fileField) };
  };
}

async function awaitJob(job: Job, waitMs: number, errorExtras?: ErrorExtras, runningExtra: Record<string, unknown> = {}): Promise<Outcome> {
  const finished = await job.wait(waitMs);
  const dm = job.responder ?? job.dm;
  if (!finished) {
    const snap = job.snapshot();
    return {
      state: 'running',
      result: textResult({
        job_id: job.id,
        status: 'running',
        op: job.op,
        dm,
        elapsed_ms: snap.elapsed_ms,
        progress: snap.progress ?? null,
        note: `still running after ${waitMs} ms; the request stays alive in Studio — call job(action='wait'|'status'|'cancel', job_id='${job.id}')`,
        ...runningExtra,
      }),
    };
  }
  if (job.error) {
    const extras = errorExtras?.(job.error) ?? {};
    const message = typeof extras.hint === 'string' ? `${job.error.message} — ${extras.hint}` : job.error.message;
    // Every field the executor attached beyond code/message travels with the error (a
    // `geometry_violation` carries its `geometry` report, a luau_error its stack and output).
    const { code: _code, message: _message, ...attached } = job.error;
    return {
      state: 'error',
      result: errorResult(job.error.code, message, bodyOf({ dm, job_id: job.id, ...attached, ...extras })),
    };
  }
  const value: JsonObject = isJsonObject(job.result) ? { ...job.result } : { value: job.result ?? null };
  if (value.dm === undefined) value.dm = dm;
  return { state: 'done', value };
}

/** `defaults` fill fields the responder omitted; `extra` is added on top (bridge-owned fields). */
function finish(outcome: Outcome, extra: Record<string, unknown> = {}, defaults: Record<string, unknown> = {}): CallToolResult {
  return outcome.state === 'done' ? textResult({ ...defaults, ...outcome.value, ...extra }) : outcome.result;
}

function require<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new BridgeError('bad_request', `${what} is required`);
  return value;
}

function estimateInputMs(actions: InputArgs['actions']): number {
  let total = 0;
  for (const action of actions) total += (action.hold_ms ?? 0) + (action.ms ?? 0) + 100;
  return Math.min(MAX_TIMEOUT_MS, Math.max(DEFAULT_DEADLINE_MS, total + 10_000));
}

/** Items of a cursored list (`events`, `observe logs`) that fit the result budget alongside their envelope. */
function fitList<T>(items: readonly T[]): { kept: T[]; truncated: boolean } {
  return takeWithinBudget(items, RESULT_CHAR_BUDGET - LIST_ENVELOPE_CHARS);
}

function seqOf(item: JsonValue): number | null {
  return isJsonObject(item) && typeof item.seq === 'number' ? item.seq : null;
}

export function createLocalExecutor(deps: LocalExecutorDeps): ToolExecutor {
  const { registry, jobs, skills, capture, log } = deps;
  const defaultGeometryPolicy = deps.geometryPolicy ?? DEFAULT_GEOMETRY_POLICY;

  /** Fields appended to results that used the default session while several hubs are connected. */
  const sessionHint = (session: HubSession, explicit: string | undefined): Record<string, unknown> => {
    if (explicit !== undefined || registry.connected().length < 2) return {};
    return {
      session_note: `${registry.connected().length} Studio sessions are connected; this used ${session.label}. Pass session=<prefix> to address another: ${registry.describeConnected()}`,
    };
  };

  const requestOptions = (context: CallContext, dm: string | undefined, deadlineMs: number): RequestOptions => ({
    dm,
    deadlineMs,
    origin: context.origin,
    signal: context.signal,
  });

  const run = async (args: RunArgs, context: CallContext): Promise<CallToolResult> => {
    // code_file is read here: the hub only ever sees `code`, so no shell or JSON escaping touches the Luau.
    const code = (await readProgramArg(args.code, args.code_file, 'code', true)) as string;
    const session = registry.resolve(args.session, { write: true });
    const timeout = args.timeout_ms ?? DEFAULT_DEADLINE_MS;
    const job = session.request(
      'run',
      bodyOf({
        code,
        args: args.args,
        undo_label: args.undo_label,
        dry_run: args.dry_run,
        geometry_policy: geometryPolicyFor(args.dm, args.geometry_policy, defaultGeometryPolicy),
        timeout_ms: timeout,
        response_format: args.response_format,
      }),
      requestOptions(context, args.dm, timeout),
    );
    return finish(await awaitJob(job, args.wait_ms ?? DEFAULT_WAIT_MS, transportHintFor(code, 'code_file', args.code_file !== undefined)), sessionHint(session, args.session));
  };

  const screenshot = async (args: ObserveArgs): Promise<CallToolResult> => {
    const options: CaptureOptions = {};
    if (args.max_width !== undefined) options.maxWidth = args.max_width;
    if (args.format !== undefined) options.format = args.format;
    if (args.quality !== undefined) options.quality = args.quality;
    if (args.region !== undefined) options.region = args.region;
    if (args.restore !== undefined) options.restore = args.restore;
    if (args.hwnd !== undefined) options.hwnd = args.hwnd;
    if (args.title_match !== undefined) options.titleMatch = args.title_match;
    const shot = await capture.captureStudio(options);
    return imageResult(shot.base64, shot.mimeType, {
      path: shot.path,
      width: shot.width,
      height: shot.height,
      source_width: shot.sourceWidth,
      source_height: shot.sourceHeight,
      scale: shot.scale,
      bytes: shot.bytes,
      windowTitle: shot.windowTitle,
      hwnd: shot.hwnd,
      captured_ms: shot.captured_ms,
    });
  };

  const windows = async (): Promise<CallToolResult> => {
    if (!capture.listStudioWindows) throw new BridgeError('unsupported', 'window listing is not available on this bridge');
    return textResult({ windows: await capture.listStudioWindows() });
  };

  const observe = async (args: ObserveArgs, context: CallContext): Promise<CallToolResult> => {
    if (args.what === 'screenshot') return screenshot(args);
    if (args.what === 'windows') return windows();
    if (args.dm === 'all' && args.what !== 'logs') throw new BridgeError('bad_request', "dm 'all' applies to logs only");
    if (args.what === 'script') {
      require(args.path, 'path');
      if (args.from !== undefined && args.to !== undefined && args.to < args.from) throw new BridgeError('bad_request', 'to must not be smaller than from');
    }
    if (args.what !== 'geometry' && (args.tolerance !== undefined || args.include_nested !== undefined)) {
      throw new BridgeError('bad_request', "tolerance and include_nested apply to what 'geometry' only");
    }
    const session = registry.resolve(args.session);
    if (args.what === 'selftest') {
      // Hub-only self-check of the runtime (serialize, paths, chunking, undo); used after install/updates.
      const job = session.request('selftest', {}, requestOptions(context, 'edit', DEFAULT_DEADLINE_MS));
      return finish(await awaitJob(job, args.wait_ms ?? DEFAULT_WAIT_MS), sessionHint(session, args.session));
    }
    const body = bodyOf({
      what: args.what,
      dm: args.dm,
      root: args.root,
      path: args.path,
      from: args.from,
      to: args.to,
      depth: args.depth,
      max: args.max,
      classes: args.classes,
      fields: args.fields,
      paths: args.paths,
      props: args.props,
      name: args.name,
      class: args.class,
      tag: args.tag,
      attr: args.attr,
      prop: args.prop,
      since: args.since,
      level: args.level,
      filter: args.filter,
      tail: args.tail,
      tolerance: args.tolerance,
      include_nested: args.include_nested,
      response_format: args.response_format,
    });
    // `logs` always runs on the hub (it filters the hub's merged journal by body.dm), so 'all' rides on req.dm 'edit'.
    const job = session.request('observe', body, requestOptions(context, args.dm === 'all' ? 'edit' : args.dm, DEFAULT_DEADLINE_MS));
    const outcome = await awaitJob(job, args.wait_ms ?? DEFAULT_WAIT_MS);
    const hint = sessionHint(session, args.session);
    if (outcome.state !== 'done') return finish(outcome);
    if (args.what === 'logs' && Array.isArray(outcome.value.items)) {
      // The cursor must follow what is actually returned, so the budget is applied here, not by shrinkToBudget.
      const { kept, truncated } = fitList(outcome.value.items);
      if (truncated) {
        const last = kept.length > 0 ? seqOf(kept[kept.length - 1] as JsonValue) : null;
        outcome.value.items = kept;
        outcome.value.truncated = true;
        if (last !== null) outcome.value.next = last;
      }
      return finish(outcome, hint);
    }
    if (args.what !== 'status') return finish(outcome, hint);
    // Studio reports capture:false because screenshots never enter Studio; the bridge is the capture provider.
    if (isJsonObject(outcome.value.capabilities)) outcome.value.capabilities.capture = process.platform === 'win32';
    // Place identity the hub reported over hello/hb fills whatever this status answer left out.
    const place: JsonObject = isJsonObject(outcome.value.place) ? outcome.value.place : {};
    place.universeId ??= session.studio?.universeId ?? null;
    place.creatorType ??= session.studio?.creatorType ?? null;
    place.creatorId ??= session.studio?.creatorId ?? null;
    outcome.value.place = place;
    return finish(outcome, {
      bridge: {
        version: deps.bridge.version,
        port: deps.bridge.port,
        events_url: `ws://127.0.0.1:${deps.bridge.port}/events`,
        journal: session.journal.stats(),
        stale: session.stale,
        playtest: session.playtest,
        bootstrap: { shipped: deps.bridge.bootstrapVersion, installed: session.bootstrap, outdated: session.bootstrapOutdated },
        sessions: registry.connected().map((s) => ({
          session: s.id,
          place: s.studio?.placeName ?? null,
          placeId: s.studio?.placeId ?? null,
          universeId: s.studio?.universeId ?? null,
          creatorType: s.studio?.creatorType ?? null,
          creatorId: s.studio?.creatorId ?? null,
          active: s.id === registry.active?.id,
        })),
      },
      ...hint,
    });
  };

  /**
   * Persisted controllers are the bridge's (Studio 0.738 cannot read plugin settings): once the hub
   * acknowledged an install, store the entry (persist=true) or drop a stale one (the latest install
   * decides), then hand the hub the whole list as `persist_sync`. Returns the fields the tool result
   * gains; the same bookkeeping runs from a job hook when the install outlives `wait_ms`.
   */
  const settleInstall = async (session: HubSession, args: PlaytestArgs, code: string, dm: string): Promise<Record<string, unknown>> => {
    const name = args.name as string;
    const store = registry.persist;
    const fields: Record<string, unknown> = {};
    let changed = false;
    if (args.persist === true) {
      const stored = await store.remember(session.id, dm, name, code);
      fields.persist = stored.stored;
      if (stored.stored) {
        fields.persist_source = 'bridge';
        if (stored.file) fields.persist_file = stored.file;
        changed = true;
      }
      if (stored.note) fields.persist_note = stored.note;
    } else {
      changed = await store.forget(session.id, dm, name);
      fields.persist = false;
      if (changed) fields.persist_removed = true;
    }
    if (changed) await registry.syncPersisted(session, 'install');
    return fields;
  };

  const recordInstall = async (session: HubSession, args: PlaytestArgs, code: string, job: Job, outcome: Outcome): Promise<Outcome> => {
    if (outcome.state === 'running') {
      // The hook runs whether or not anyone waits for the job, so a slow client Studio never loses
      // its persisted entry; `persist_pending` in the handle says the bookkeeping is still to come.
      job.onFinish((finished) => {
        if (finished.error) return;
        const dm = finished.responder ?? args.dm ?? 'server';
        void settleInstall(session, args, code, dm).catch((err: unknown) => {
          log.warn('persisted controller bookkeeping failed after the install finished', { job: finished.id, err });
        });
      });
      return outcome;
    }
    if (outcome.state !== 'done') return outcome;
    // The responder names the concrete DM (`client` → `client:1`); persisted entries must match peer hellos exactly.
    const dm = typeof outcome.value.dm === 'string' ? outcome.value.dm : (args.dm ?? 'server');
    const fields = await settleInstall(session, args, code, dm);
    if (fields.persist_source !== undefined) delete outcome.value.persist_note;
    Object.assign(outcome.value, fields);
    return outcome;
  };

  /**
   * `uninstall` always drops the persisted entry, even when nothing is running to uninstall from.
   * The responder's dm is trusted only for a successful answer: the hub answers a forwarded request
   * for an absent peer with `dm: "edit"` (protocol.err in its forward path), which names nothing.
   */
  const recordUninstall = async (session: HubSession, args: PlaytestArgs, job: Job, outcome: Outcome): Promise<Outcome> => {
    const name = args.name as string;
    const requested = args.dm ?? 'server';
    const dm = outcome.state === 'done' ? (job.responder ?? requested) : requested;
    const store = registry.persist;
    let removed = await store.forget(session.id, dm, name);
    if (!removed && dm !== requested) removed = await store.forget(session.id, requested, name);
    if (!removed && (dm === 'client' || requested === 'client')) {
      // No peer resolved `client` for us: the entry was stored under the lowest-numbered client.
      const match = (await store.controllers(session.id))
        .filter((entry) => entry.name === name && /^client:\d+$/.test(entry.dm))
        .sort((a, b) => Number(a.dm.slice(7)) - Number(b.dm.slice(7)))[0];
      if (match) removed = await store.forget(session.id, match.dm, name);
    }
    if (removed) await registry.syncPersisted(session, 'uninstall');
    if (outcome.state === 'done') {
      outcome.value.persisted_removed = removed;
      return outcome;
    }
    const code = job.error?.code;
    if (removed && (code === 'no_peer' || code === 'bad_request')) {
      // Nothing live to uninstall from, but the durable entry is gone: that is what the caller asked for.
      return {
        state: 'done',
        value: { uninstalled: false, persisted_removed: true, dm, name, note: `not installed in a live DM (${code}: ${job.error?.message ?? ''}); the persisted entry was removed` },
      };
    }
    return outcome;
  };

  const playtest = async (args: PlaytestArgs, context: CallContext): Promise<CallToolResult> => {
    let deadline = DEFAULT_DEADLINE_MS;
    const mode = args.action === 'start' ? (args.mode ?? 'play') : args.mode;
    // Sent explicitly for multiplayer so the hub never has to pick a default; absent otherwise.
    const players = args.action === 'start' && mode === 'multiplayer' ? (args.players ?? DEFAULT_MULTIPLAYER_PLAYERS) : undefined;
    const count = args.action === 'add_players' ? (args.count ?? 1) : undefined;
    // Program text may come from files (code_file / source_file / predicate_file): resolved here, before anything is sent.
    let predicate: string | undefined;
    let code: string | undefined;
    let source: string | undefined;
    switch (args.action) {
      case 'start':
        if (args.players !== undefined && mode !== 'multiplayer') throw new BridgeError('bad_request', "players only applies to mode 'multiplayer'");
        if (mode === 'multiplayer') deadline = MULTIPLAYER_DEADLINE_MS;
        break;
      case 'add_players':
        deadline = MULTIPLAYER_DEADLINE_MS;
        break;
      case 'run_until':
        predicate = await readProgramArg(args.predicate, args.predicate_file, 'predicate', true);
        deadline = (args.timeout_ms ?? DEFAULT_DEADLINE_MS) + DEADLINE_SLACK_MS;
        break;
      case 'install':
        require(args.name, 'name');
        code = await readProgramArg(args.code, args.code_file, 'code', true);
        break;
      case 'uninstall':
        require(args.name, 'name');
        break;
      case 'hotpatch':
        require(args.path, 'path');
        source = await readProgramArg(args.source, args.source_file, 'source', true);
        break;
      case 'push':
        require(args.paths, 'paths');
        deadline = args.timeout_ms ?? DEFAULT_DEADLINE_MS;
        break;
      default:
        break;
    }
    const write = args.action !== 'status' && args.action !== 'list';
    const session = registry.resolve(args.session, { write });
    const hint = sessionHint(session, args.session);
    if (args.action === 'push') {
      // The hub serializes the edit-DM instances itself and ships them to body.dm, so the request
      // always targets `edit` (protocol Notes); the destination DM is inside the body.
      const dm = args.dm ?? 'server';
      if (dm === 'edit') throw new BridgeError('bad_request', "push targets a play DM: dm must be 'server', 'client' or 'client:N'");
      // replace defaults to true and is always sent: a same-named sibling at the target parent is destroyed first.
      const replace = args.replace ?? true;
      const body = bodyOf({ paths: args.paths, dm, parent: args.parent, replace, timeout_ms: args.timeout_ms });
      const job = session.request('push', body, requestOptions(context, 'edit', deadline));
      const outcome = await awaitJob(job, args.wait_ms ?? DEFAULT_WAIT_MS);
      // The hub answers from `edit`; the result names the DM that received the instances. `parent` is
      // repeated only when the caller chose one: otherwise each root lands at its edit-DM path (runtime
      // Notes) and the returned `paths` say where.
      if (outcome.state === 'done' && (outcome.value.dm === undefined || outcome.value.dm === 'edit')) outcome.value.dm = dm;
      return finish(outcome, hint, { replace, ...(args.parent !== undefined ? { parent: args.parent } : {}) });
    }
    const body = bodyOf({
      action: args.action,
      mode,
      players,
      count,
      dm: args.dm,
      predicate,
      timeout_ms: args.timeout_ms,
      interval_ms: args.interval_ms,
      args: args.args,
      name: args.name,
      code,
      persist: args.persist,
      path: args.path,
      source,
      restart: args.restart,
    });
    const job = session.request('playtest', body, requestOptions(context, args.dm, deadline));
    const errorExtras =
      args.action === 'run_until'
        ? transportHintFor(predicate, 'predicate_file', args.predicate_file !== undefined)
        : args.action === 'install'
          ? transportHintFor(code, 'code_file', args.code_file !== undefined)
          : undefined;
    const runningExtra = args.action === 'install' && args.persist === true ? { persist_pending: true } : {};
    const outcome = await awaitJob(job, args.wait_ms ?? DEFAULT_WAIT_MS, errorExtras, runningExtra);
    switch (args.action) {
      case 'start':
        return finish(outcome, hint, { mode, ...(players !== undefined ? { players } : {}) });
      case 'list':
        // The bridge is the source of truth for persisted entries; the hub's own view (if any) is replaced.
        return finish(outcome, hint, { persisted: await registry.persist.list(session.id), persistence: CONTROLLER_PERSISTENCE_NOTE });
      case 'install':
        return finish(await recordInstall(session, args, code as string, job, outcome), hint);
      case 'uninstall':
        return finish(await recordUninstall(session, args, job, outcome), hint);
      default:
        return finish(outcome, hint);
    }
  };

  const input = async (args: InputArgs, context: CallContext): Promise<CallToolResult> => {
    const dm = args.dm ?? 'client';
    if (!dm.startsWith('client')) throw new BridgeError('bad_request', `input targets a client DM, got '${dm}'`);
    const session = registry.resolve(args.session, { write: true });
    const job = session.request(
      'input',
      bodyOf({ dm, actions: args.actions, abort_on_error: args.abort_on_error }),
      requestOptions(context, dm, estimateInputMs(args.actions)),
    );
    return finish(await awaitJob(job, args.wait_ms ?? DEFAULT_WAIT_MS), sessionHint(session, args.session));
  };

  const events = async (args: EventsArgs): Promise<CallToolResult> => {
    const session = registry.resolve(args.session, { allowDisconnected: true });
    const backfill = await session.journal.waitFor(args.since ?? 0, makeFilter(args.kinds, args.levels), args.timeout_ms ?? 0, args.limit);
    const { kept, truncated } = fitList(backfill.events);
    const last = kept[kept.length - 1];
    return textResult({
      session: session.id,
      connected: session.connected,
      cursor: truncated && last ? last.seq : backfill.cursor,
      latest_seq: session.journal.latestSeq,
      dropped: backfill.dropped,
      hub_dropped: session.hb?.dropped ?? 0,
      truncated: backfill.truncated || truncated,
      events: kept,
      ...sessionHint(session, args.session),
    });
  };

  const skillsTool = async (args: SkillsArgs, context: CallContext): Promise<CallToolResult> => {
    switch (args.action) {
      case 'list':
        return textResult({
          dir: skills.dir,
          builtin_dir: skills.builtinDir,
          note: 'builtin: true skills ship with the bridge (read-only); save a skill with the same name to override one',
          skills: await skills.list(),
        });
      case 'get':
        return textResult(await skills.get(require(args.name, 'name')));
      case 'save': {
        const name = require(args.name, 'name');
        const saved = await skills.save({
          name,
          source: (await readProgramArg(args.source, args.source_file, 'source', true)) as string,
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.params !== undefined ? { params: toJsonValue(args.params) as JsonObject } : {}),
        });
        return textResult({ name, ...saved });
      }
      case 'delete': {
        const name = require(args.name, 'name');
        return textResult({ name, ...(await skills.delete(name)) });
      }
      case 'run': {
        const name = require(args.name, 'name');
        const skill = await skills.get(name);
        const session = registry.resolve(args.session, { write: true });
        const timeout = args.timeout_ms ?? DEFAULT_DEADLINE_MS;
        // Same body the run tool sends, so dry_run / undo_label / geometry_policy / timeout_ms reach the executor unchanged.
        const job = session.request(
          'run',
          bodyOf({
            code: skill.source,
            args: args.args,
            undo_label: args.undo_label ?? `skill: ${name}`,
            dry_run: args.dry_run,
            geometry_policy: geometryPolicyFor(args.dm, args.geometry_policy, defaultGeometryPolicy),
            timeout_ms: timeout,
            response_format: args.response_format,
          }),
          requestOptions(context, args.dm, timeout),
        );
        return finish(await awaitJob(job, args.wait_ms ?? DEFAULT_WAIT_MS), { skill: name, builtin: skill.builtin, ...sessionHint(session, args.session) });
      }
    }
  };

  const jobTool = async (args: JobArgs): Promise<CallToolResult> => {
    if (args.action === 'list') return textResult({ jobs: jobs.list() });
    const id = require(args.job_id, 'job_id');
    const job = jobs.get(id);
    if (!job) throw new BridgeError('not_found', `unknown job ${id} (finished jobs expire after 10 minutes; job list shows the known ones)`);
    const snapshot = (): Record<string, unknown> => ({ ...job.snapshot(), hub_connected: registry.get(job.session)?.connected ?? false });
    switch (args.action) {
      case 'status':
        return textResult(snapshot());
      case 'cancel': {
        const sent = job.cancel();
        await job.wait(CANCEL_SETTLE_MS);
        return textResult({ ...snapshot(), cancel_sent: sent });
      }
      case 'wait':
        await job.wait(Math.min(args.wait_ms ?? DEFAULT_WAIT_MS, MAX_JOB_WAIT_MS));
        return textResult(snapshot());
    }
  };

  // Both sidecars take the raw (already validated) arguments and never throw: results are ToolText.
  const cloudContext: CloudContext = {
    home: deps.home,
    log: (level, msg, data) => log.child('cloud')[level](msg, data),
    ids: () => cloudIdsOf(registry.active),
  };
  const visionContext: VisionContext = {
    capture: (opts) => {
      const options: CaptureOptions = {};
      if (opts.maxWidth !== undefined) options.maxWidth = opts.maxWidth;
      if (opts.format !== undefined) options.format = opts.format;
      if (opts.quality !== undefined) options.quality = opts.quality;
      if (opts.region !== undefined) options.region = opts.region;
      return capture.captureStudio(options);
    },
    emit: (event) => {
      try {
        deps.localEvents?.(event);
      } catch (err) {
        log.warn('vision event delivery failed', { err });
      }
    },
    log: (level, msg, data) => log.child('vision')[level](msg, data),
  };
  // ToolText is a CallToolResult without the SDK's index signature; the spread adds it.
  const cloud = async (args: unknown): Promise<CallToolResult> => ({ ...(await runCloudTool(args, cloudContext)) });
  const look = async (args: unknown): Promise<CallToolResult> => ({ ...(await runLookTool(args, visionContext)) });

  const handlers: { [K in ToolName]: (args: never, context: CallContext) => Promise<CallToolResult> } = {
    run,
    observe,
    playtest,
    input,
    events,
    skills: skillsTool,
    job: jobTool,
    cloud,
    look,
  };

  return {
    async call(name, rawArgs, context = { origin: 'stdio' }) {
      const spec = getToolSpec(name);
      if (!spec) return errorResult('bad_request', `unknown tool "${name}"; tools: ${TOOL_NAMES.join(', ')}`);
      const parsed = z.object(spec.inputSchema).safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
        return errorResult('bad_request', `invalid arguments for ${name}`, { issues });
      }
      const handler = handlers[spec.name] as (args: unknown, context: CallContext) => Promise<CallToolResult>;
      try {
        return await handler(parsed.data, context);
      } catch (err) {
        const code = errorCode(err);
        const details = err instanceof BridgeError && err.details ? err.details : {};
        if (code === 'internal') log.error(`tool ${name} failed`, { err });
        return errorResult(code, errorMessage(err), details);
      }
    },
  };
}
