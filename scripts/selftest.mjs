// Offline end-to-end check of the bridge against docs/protocol.md — no Studio, no stdio:
// a real bridge (createBridge) on a random port talks to scripts/fake-hub.mjs over ws://…/studio while
// tools are called through POST /rpc and pushes are read from ws://…/events. Covers the hello/bundle
// handshake, request routing and deadlines, job handles, timeout, cancel, cancel_all, >512 KB chunked
// frames in both directions, /events batching / seq continuity / dropped, the long-poll, acks, hb,
// reconnect, the bootstrap version check, proxy mode, bridge-side persisted controllers (persist_sync),
// push replace, file-based code arguments and the escape/transport hint, observe logs dm all and
// script ranges, the geometry rules (geometry_policy plumbing and its STUDIO_LIVE_GEOMETRY_POLICY
// default, run.geometry / geometry_violation pass-through, observe geometry). Prints PASS/FAIL per
// check; exits 1 on any FAIL.
// Requires "npm run build".
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { FakeHub } from './fake-hub.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = (name) => path.join(root, 'dist', 'bridge', name);
if (!existsSync(dist('app.js'))) {
  console.error(`selftest: ${dist('app.js')} is missing; run "npm run build" first`);
  process.exit(2);
}
const load = (name) => import(pathToFileURL(dist(name)).href);
const { createBridge } = await load('app.js');
const { loadConfig } = await load('config.js');
const { FANOUT_MAX_FRAME_BYTES } = await load('fanout.js');
const { createLogger } = await load('log.js');
const { L1_CHUNK_THRESHOLD_BYTES } = await load('protocol.js');

const SESSION = '5e1f7e57-0000-4000-8000-00000000c0de';
const OLD_SESSION = '5e1f7e57-0000-4000-8000-0000000001d0';
const SECOND_SESSION = '5e1f7e57-0000-4000-8000-00000000beef';
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const WATCHDOG_MS = 120_000;
/** Request ids embed a per-process nonce (protocol Notes, "Job handles"). */
const JOB_ID = /^r-[0-9a-f]{6}-\d+$/;

// ---- tiny assertion / reporting kit ---------------------------------------------------------------

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '');
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
async function until(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// ---- bridge + helpers -----------------------------------------------------------------------------

const watchdog = setTimeout(() => {
  console.error(`selftest: no result after ${WATCHDOG_MS} ms; aborting`);
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-live-selftest-'));
// Bridge logs go to stderr; the checks below deliberately trigger warnings, so only errors show by default.
const config = { ...loadConfig({ STUDIO_LIVE_HOME: home, STUDIO_LIVE_LOG: process.env.STUDIO_LIVE_LOG ?? 'error' }), port: 0, dev: false };
const log = createLogger({ level: config.logLevel });
const capture = {
  captureStudio: async () => ({
    path: path.join(home, 'selftest.png'),
    width: 1,
    height: 1,
    bytes: 68,
    mimeType: 'image/png',
    windowTitle: 'selftest - Roblox Studio',
    hwnd: '1',
    captured_ms: 1,
    base64: PNG_1X1,
    sourceWidth: 2,
    sourceHeight: 2,
    scale: 2,
  }),
};
const bridge = await createBridge(config, log, { requestGraceMs: 500, ackIntervalMs: 100, capture });
if (bridge.mode !== 'primary') {
  console.error(`selftest: expected primary mode on an ephemeral port, got ${bridge.mode}`);
  process.exit(1);
}
const port = bridge.port;
const base = `http://127.0.0.1:${port}`;

async function rpc(tool, args) {
  const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, args }) });
  const result = await response.json();
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '{}';
  return { status: response.status, result, payload: JSON.parse(text), text };
}
async function getJson(route) {
  return (await fetch(`${base}${route}`)).json();
}
/** One /events WebSocket; `next()` yields parsed frames (with `bytes`) in arrival order. */
function openEvents(query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events${query}`);
  const frames = [];
  let pending = null;
  ws.on('message', (data) => {
    const text = data.toString();
    frames.push({ ...JSON.parse(text), bytes: Buffer.byteLength(text, 'utf8') });
    if (pending) {
      const deliver = pending;
      pending = null;
      deliver();
    }
  });
  const open = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const next = (timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = null;
        reject(new Error('timeout waiting for an /events frame'));
      }, timeoutMs);
      const deliver = () => {
        clearTimeout(timer);
        resolve(frames.shift());
      };
      if (frames.length > 0) deliver();
      else pending = deliver;
    });
  return { open, next, close: () => ws.close() };
}

// ---- checks ---------------------------------------------------------------------------------------

let hub;

await check('bridge starts in primary mode on an ephemeral port with the runtime bundle', async () => {
  assert(port > 0 && port !== 47800, `port ${port}`);
  const modules = Object.keys(bridge.bundle.current.modules);
  assert(modules.includes('runtime/init'), 'bundle lacks runtime/init');
  assert(modules.length >= 20, `only ${modules.length} runtime modules`);
  return `port ${port}, ${modules.length} modules, ${bridge.bundle.current.hash.slice(0, 19)}`;
});

await check('GET /status announces studio-live with no sessions', async () => {
  const status = await getJson('/status');
  eq(status.name, 'studio-live', 'name');
  eq(status.port, port, 'port');
  eq(status.mode, 'primary', 'mode');
  eq(status.sessions.length, 0, 'sessions');
  eq(status.bundle.modules, Object.keys(bridge.bundle.current.modules).length, 'bundle.modules');
});

await check('tool calls without Studio answer no_session', async () => {
  const { result, payload } = await rpc('run', { code: 'return 1' });
  eq(result.isError, true, 'isError');
  eq(payload.error?.code, 'no_session', 'code');
});

await check('POST /rpc refuses browser origins and non-JSON, rejects unknown tools and bad arguments', async () => {
  const origin = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{"tool":"run"}' });
  eq(origin.status, 403, 'Origin status');
  const type = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  eq(type.status, 415, 'content-type status');
  eq((await rpc('nope', {})).payload.error?.code, 'bad_request', 'unknown tool');
  const bad = (await rpc('run', { code: 'x', dm: 'client:0' })).payload;
  eq(bad.error?.code, 'bad_request', 'client:0');
  assert(Array.isArray(bad.error?.issues) && bad.error.issues.length > 0, 'issues[] missing');
});

await check('cloud and look are served through POST /rpc like every other tool (no Studio, no key, no credential)', async () => {
  // look: list / stop / validation need neither a capture nor a Claude credential.
  const list = await rpc('look', { list: true });
  eq(list.result.isError, undefined, 'look list isError');
  assert(Array.isArray(list.payload.watches) && list.payload.watches.length === 0, 'look list → {watches: []}');
  eq((await rpc('look', { stop: 'w-404' })).payload.error?.code, 'not_found', 'look stop unknown id');
  eq((await rpc('look', {})).payload.error?.code, 'bad_request', 'look without a mode');
  // cloud: a fresh STUDIO_LIVE_HOME has no key → no_api_key names the file locations; bad arguments never get that far.
  // (The key is read from the environment on every call, so a developer shell exporting one is hidden for this check.)
  const savedKey = process.env.ROBLOX_OPEN_CLOUD_KEY;
  delete process.env.ROBLOX_OPEN_CLOUD_KEY;
  try {
    const noKey = await rpc('cloud', { action: 'info', what: 'universe' });
    eq(noKey.result.isError, true, 'cloud isError');
    eq(noKey.payload.error?.code, 'no_api_key', 'cloud without a key');
    assert(String(noKey.payload.error?.message ?? '').includes(path.join(home, 'opencloud.json')), 'no_api_key message names <home>/opencloud.json');
    eq((await rpc('cloud', { action: 'nope' })).payload.error?.code, 'bad_request', 'cloud unknown action');
  } finally {
    if (savedKey !== undefined) process.env.ROBLOX_OPEN_CLOUD_KEY = savedKey;
  }
});

await check('§8 hello with another proto is refused with error proto_mismatch and the socket closes', async () => {
  const stranger = await FakeHub.connect(port, { session: 'proto-mismatch' });
  const { ack } = await stranger.hello({ proto: 2 });
  eq(ack.kind, 'error', 'kind');
  eq(ack.code, 'proto_mismatch', 'code');
  await stranger.closed;
});

await check('§1.1 hello → hello_ack carries proto 1, bridgeId, ackUpto 0 and the runtime bundle', async () => {
  hub = await FakeHub.connect(port, { session: SESSION });
  const { ack, bundle } = await hub.hello();
  eq(ack.kind, 'hello_ack', 'kind');
  eq(ack.v, 1, 'v');
  eq(ack.proto, 1, 'proto');
  eq(ack.ackUpto, 0, 'ackUpto');
  eq(ack.bridge, config.version, 'bridge');
  assert(/^[0-9a-f]{6}$/.test(ack.bridgeId ?? ''), `bridgeId ${ack.bridgeId}`);
  assert(typeof ack.serverTime === 'number', 'serverTime missing');
  assert(bundle, 'no bundle delivered');
  eq(bundle.hash, bridge.bundle.current.hash, 'bundle.hash');
  eq(bundle.entry, 'runtime/init', 'bundle.entry');
  eq(Object.keys(bundle.modules).length, Object.keys(bridge.bundle.current.modules).length, 'module count');
  return ack.bundle ? 'bundle inline' : 'bundle as a separate frame (> 512 KB)';
});

await check('GET /status lists the connected session as active with an up-to-date bootstrap', async () => {
  const status = await getJson('/status');
  eq(status.sessions.length, 1, 'sessions');
  eq(status.active, SESSION, 'active');
  const s = status.sessions[0];
  eq(s.session, SESSION, 'session');
  eq(s.connected, true, 'connected');
  eq(s.bootstrap, '1.0.0', 'bootstrap');
  eq(s.bootstrapOutdated, false, 'bootstrapOutdated');
});

await check('observe status runs on the hub (dm edit, deadline 30000) and gains the bridge block', async () => {
  const { payload } = await rpc('observe', { what: 'status' });
  eq(payload.role, 'edit', 'role');
  eq(payload.bridge?.port, port, 'bridge.port');
  eq(payload.bridge?.events_url, `ws://127.0.0.1:${port}/events`, 'events_url');
  eq(payload.bridge?.bootstrap?.installed, '1.0.0', 'bootstrap.installed');
  eq(payload.bridge?.bootstrap?.outdated, false, 'bootstrap.outdated');
  eq(typeof payload.capabilities?.capture, 'boolean', 'capabilities.capture');
  const req = hub.requests.at(-1);
  eq(req.op, 'observe', 'req.op');
  eq(req.dm, 'edit', 'req.dm');
  eq(req.body.what, 'status', 'body.what');
  eq(req.deadline_ms, 30000, 'deadline_ms');
});

await check('§4.1 run: req carries id r-N, op, dm, deadline_ms and body; the response body comes back with dm', async () => {
  const { result, payload } = await rpc('run', { code: 'return 1', args: { a: 1 }, undo_label: 'selftest' });
  assert(!result.isError, `error ${JSON.stringify(payload.error)}`);
  eq(payload.value?.echo, 'return 1', 'value.echo');
  eq(payload.value?.args?.a, 1, 'value.args.a');
  eq(payload.undo, 'committed', 'undo');
  eq(payload.dm, 'edit', 'dm');
  const req = hub.requests.at(-1);
  eq(req.v, 1, 'req.v');
  assert(JOB_ID.test(req.id), `req.id ${req.id}`);
  eq(req.op, 'run', 'req.op');
  eq(req.dm, 'edit', 'req.dm');
  eq(req.deadline_ms, 30000, 'deadline_ms');
  eq(req.body.timeout_ms, 30000, 'body.timeout_ms');
  eq(req.body.undo_label, 'selftest', 'body.undo_label');
});

await check('§2.2 error responses surface code, message, stack, output and job_id', async () => {
  const { result, payload } = await rpc('run', { code: 'error' });
  eq(result.isError, true, 'isError');
  eq(payload.error?.code, 'luau_error', 'code');
  eq(payload.error?.message, 'boom', 'message');
  eq(payload.error?.stack, 'StudioLiveProgram:1: boom', 'stack');
  assert(Array.isArray(payload.error?.output), 'output missing');
  assert(JOB_ID.test(payload.error?.job_id ?? ''), 'job_id missing');
});

await check('§2.1 a request for an absent peer answers no_peer', async () => {
  const { payload } = await rpc('run', { code: 'x', dm: 'client:9' });
  eq(payload.error?.code, 'no_peer', 'code');
});

await check('§4.3 playtest status runs on the hub', async () => {
  const { payload } = await rpc('playtest', { action: 'status' });
  eq(payload.running, false, 'running');
  eq(payload.dm, 'edit', 'dm');
  const req = hub.requests.at(-1);
  eq(req.dm, 'edit', 'req.dm');
  eq(req.body.action, 'status', 'body.action');
});

await check('§4.3 run_until: deadline_ms = timeout_ms + 5000 and dm is repeated in the body', async () => {
  const { payload } = await rpc('playtest', { action: 'run_until', dm: 'server', predicate: 'return true', timeout_ms: 1000 });
  eq(payload.result, true, 'result');
  const req = hub.requests.at(-1);
  eq(req.dm, 'server', 'req.dm');
  eq(req.body.dm, 'server', 'body.dm');
  eq(req.deadline_ms, 6000, 'deadline_ms');
  eq(req.body.timeout_ms, 1000, 'body.timeout_ms');
});

await check('§4.4 input defaults to dm client, refuses other dms locally, and reports the responder dm', async () => {
  const before = hub.requests.length;
  const wrong = (await rpc('input', { actions: [{ type: 'wait', ms: 1 }], dm: 'server' })).payload;
  eq(wrong.error?.code, 'bad_request', 'server dm');
  eq(hub.requests.length, before, 'no request sent for the refused call');
  const { payload } = await rpc('input', { actions: [{ type: 'key', key: 'W', hold_ms: 10 }, { type: 'wait', ms: 1 }] });
  eq(payload.steps?.length, 2, 'steps');
  eq(payload.dm, 'client:1', 'responder dm');
  const req = hub.requests.at(-1);
  eq(req.dm, 'client', 'req.dm');
  eq(req.body.dm, 'client', 'body.dm');
  eq(req.body.actions?.length, 2, 'body.actions');
});

await check('observe screenshot is served by the bridge and never reaches the hub', async () => {
  const before = hub.requests.length;
  const { result, payload } = await rpc('observe', { what: 'screenshot', max_width: 256 });
  eq(result.content?.[0]?.type, 'image', 'content[0].type');
  eq(result.content?.[0]?.mimeType, 'image/png', 'mimeType');
  eq(payload.width, 1, 'width');
  eq(payload.scale, 2, 'scale');
  eq(payload.source_width, 2, 'source_width');
  eq(hub.requests.length, before, 'hub saw a request');
});

await check('a run interrupted by the MCP client (AbortSignal) is cancelled in Studio', async () => {
  const controller = new AbortController();
  const pending = bridge.executor.call('run', { code: 'hang', wait_ms: 3000 }, { origin: 'stdio', signal: controller.signal });
  const req = await hub.next((f) => f.kind === 'req' && f.body?.code === 'hang', 1000);
  controller.abort();
  const cancel = await hub.next((f) => f.kind === 'cancel' && f.id === req.id, 1000);
  eq(cancel.kind, 'cancel', 'cancel frame');
  const text = (await pending).content.find((c) => c.type === 'text')?.text ?? '{}';
  eq(JSON.parse(text).error?.code, 'cancelled', 'error.code');
});

await check('slow work returns a job handle; job status/list show progress and job wait resolves it', async () => {
  const handle = (await rpc('run', { code: 'sleep:400', wait_ms: 50 })).payload;
  eq(handle.status, 'running', 'status');
  assert(JOB_ID.test(handle.job_id ?? ''), 'job_id missing');
  await until(() => bridge.jobs.get(handle.job_id)?.notes.length > 0, 1000, 'a progress note');
  const status = (await rpc('job', { action: 'status', job_id: handle.job_id })).payload;
  eq(status.status, 'running', 'status.status');
  eq(status.origin, 'rpc', 'status.origin');
  eq(status.hub_connected, true, 'status.hub_connected');
  eq(status.progress?.note, 'sleeping 400 ms', 'progress.note');
  const listed = (await rpc('job', { action: 'list' })).payload;
  eq(listed.jobs?.[0]?.job_id, handle.job_id, 'list[0].job_id');
  eq(listed.jobs?.[0]?.status, 'running', 'list[0].status');
  const done = (await rpc('job', { action: 'wait', job_id: handle.job_id, wait_ms: 3000 })).payload;
  eq(done.status, 'done', 'done.status');
  eq(done.result?.value?.slept_ms, 400, 'result.value');
  eq((await rpc('job', { action: 'status', job_id: 'r-999999' })).payload.error?.code, 'not_found', 'unknown job');
});

await check('§2.1 executor deadline: the hub answers error.code timeout at deadline_ms', async () => {
  const t0 = Date.now();
  const { payload } = await rpc('run', { code: 'sleep:5000', timeout_ms: 300 });
  eq(payload.error?.code, 'timeout', 'code');
  assert(Date.now() - t0 < 2500, 'took too long');
});

await check('bridge give-up: an unanswered request fails locally after deadline + grace and a cancel frame is sent', async () => {
  const t0 = Date.now();
  const { payload } = await rpc('run', { code: 'hang', timeout_ms: 200, wait_ms: 3000 });
  const elapsed = Date.now() - t0;
  eq(payload.error?.code, 'timeout', 'code');
  assert(elapsed >= 600 && elapsed < 2500, `elapsed ${elapsed} ms`);
  const cancel = await hub.next((f) => f.kind === 'cancel' && f.id === payload.error?.job_id, 1000);
  eq(cancel.v, 1, 'cancel.v');
  return `${elapsed} ms`;
});

await check('§2.4 job cancel: cancel frame → hub answers cancelled → job ends with error.code cancelled', async () => {
  const handle = (await rpc('run', { code: 'hang', wait_ms: 20 })).payload;
  eq(handle.status, 'running', 'handle.status');
  const cancelled = (await rpc('job', { action: 'cancel', job_id: handle.job_id })).payload;
  eq(cancelled.cancel_sent, true, 'cancel_sent');
  eq(cancelled.cancel_requested, true, 'cancel_requested');
  eq(cancelled.status, 'error', 'status');
  eq(cancelled.error?.code, 'cancelled', 'error.code');
  await hub.next((f) => f.kind === 'cancel' && f.id === handle.job_id, 1000);
});

const bigCode = `big:${'x'.repeat(600 * 1024)}`;
let bigOutcome = null;
await check('§3 a request > 512 KB is split into chunk frames and reassembled by the hub', async () => {
  hub.reassembled.length = 0;
  const chunksOutBefore = hub.chunksOut;
  bigOutcome = await rpc('run', { code: bigCode, timeout_ms: 10000 });
  bigOutcome.chunksOut = hub.chunksOut - chunksOutBefore;
  assert(!bigOutcome.result.isError, `error ${JSON.stringify(bigOutcome.payload.error)}`);
  const assembled = hub.reassembled.find((r) => r.length > L1_CHUNK_THRESHOLD_BYTES);
  assert(assembled, 'hub saw no chunked request');
  assert(assembled.parts >= 5, `${assembled.parts} parts`);
  eq(hub.requests.at(-1).body.code.length, bigCode.length, 'reassembled code length');
  return `${assembled.parts} chunk frames`;
});

await check('§3 a response > 512 KB is chunked by the hub and reassembled by the bridge', async () => {
  assert(bigOutcome && !bigOutcome.result.isError, 'previous check failed');
  assert(bigOutcome.chunksOut >= 5, `hub sent ${bigOutcome.chunksOut} chunk frames`);
  eq(bigOutcome.payload.value?.len, bigCode.length, 'value.len');
  eq(bigOutcome.payload.value?.sha256, sha256(bigCode), 'value.sha256');
  assert(bigOutcome.text.includes('…[+'), 'oversized result was not truncated to the tool budget');
  return `${bigOutcome.chunksOut} chunk frames`;
});

await check('§5.1 events in one 100 ms window arrive as one {batch,seq,dropped} frame ≤ 4 KB', async () => {
  const monitor = openEvents();
  await monitor.open;
  const first = hub.emit({ type: 'assert', name: 'a1', ok: true });
  hub.emit({ type: 'assert', name: 'a2', ok: false, detail: 'nope', controller: 'walker' });
  const last = hub.emit({ type: 'assert', name: 'a3', ok: true });
  const frame = await monitor.next();
  assert(Array.isArray(frame.batch), 'no batch');
  eq(frame.batch.length, 3, 'batch length');
  eq(frame.seq, last, 'frame.seq');
  eq(frame.dropped, 0, 'dropped');
  eq(frame.batch[0].seq, first, 'batch[0].seq');
  eq(frame.batch[0].kind, 'ev', 'batch[0].kind');
  eq(frame.batch[1].detail, 'nope', 'batch[1].detail');
  assert(frame.bytes <= FANOUT_MAX_FRAME_BYTES, `frame is ${frame.bytes} B`);

  hub.emit({ type: 'log', level: 'print', msg: 'skip' });
  hub.emit({ type: 'change', added: 1, removed: 0 });
  hub.emit({ type: 'selection', paths: [] });
  const warn = hub.emit({ type: 'log', level: 'warn', msg: 'kept' });
  const second = await monitor.next();
  eq(second.batch.length, 1, 'default filter batch length');
  eq(second.batch[0].seq, warn, 'default filter kept the warn log');
  eq(second.seq, warn, 'second frame.seq');
  monitor.close();
});

await check('§5.1 bridge-made vision events reach a default /events socket (src bridge, session seq repeated, own lseq) and are never journaled', async () => {
  const monitor = openEvents();
  await monitor.open;
  const before = hub.seq;
  // What a `look {watch}` frame does through VisionContext.emit → EventFanout.pushLocal.
  const lseq = bridge.fanout.pushLocal({ type: 'vision', watch_id: 'w-1', frame: 1, answer: 'standing', changed: true });
  const frame = await monitor.next();
  eq(frame.batch.length, 1, 'batch length');
  const ev = frame.batch[0];
  eq(ev.kind, 'ev', 'kind');
  eq(ev.type, 'vision', 'type');
  eq(ev.src, 'bridge', 'src');
  eq(ev.seq, before, 'seq repeats the session’s latest journal seq (no gap signalled)');
  eq(ev.lseq, lseq, 'lseq');
  eq(ev.watch_id, 'w-1', 'watch_id');
  eq(ev.answer, 'standing', 'answer');
  eq(frame.seq, before, 'frame.seq');
  eq(frame.dropped, 0, 'dropped');
  monitor.close();
  // The journal never stores it: the next hub event keeps its own seq and backfill knows no vision events.
  const next = hub.emit({ type: 'milestone', name: 'after-vision' });
  eq(next, before + 1, 'hub seq continues');
  await until(() => hub.lastAck === next, 2000, `ack upto ${next} (last ${hub.lastAck})`);
  const backfill = (await rpc('events', { since: 0, kinds: ['vision'] })).payload;
  eq(backfill.events?.length, 0, 'vision events in backfill');
  eq(backfill.latest_seq, next, 'latest_seq is still the hub’s');
  return `lseq ${lseq}`;
});

await check('§5.1 seq continuity: an unfiltered socket sees every seq exactly once across frames ≤ 4 KB', async () => {
  const all = openEvents('?kinds=log,error,assert,milestone,custom,playtest,peer,selection,job,controller,change&levels=print,info,warn,error');
  await all.open;
  const seqs = [];
  for (let i = 0; i < 40; i += 1) {
    seqs.push(hub.emit({ type: i % 2 ? 'custom' : 'log', level: 'print', name: `c${i}`, msg: 'm'.repeat(150) }));
    if (i % 10 === 9) await sleep(30);
  }
  let expected = seqs[0];
  let frames = 0;
  while (expected <= seqs.at(-1)) {
    const frame = await all.next();
    frames += 1;
    assert(frame.bytes <= FANOUT_MAX_FRAME_BYTES, `frame is ${frame.bytes} B`);
    eq(frame.dropped, 0, 'dropped');
    for (const ev of frame.batch) {
      eq(ev.seq, expected, 'seq continuity');
      expected += 1;
    }
    eq(frame.seq, expected - 1, 'frame.seq');
  }
  all.close();
  return `${seqs.length} events in ${frames} frames`;
});

await check('§5.1 dropped counts this socket’s queue overflow during a burst', async () => {
  const sock = openEvents('?kinds=custom');
  await sock.open;
  for (let i = 0; i < 2500; i += 1) hub.emit({ type: 'custom', name: 'burst', data: { i } });
  let dropped = 0;
  let frames = 0;
  let previous = 0;
  while (dropped === 0 && frames < 15) {
    const frame = await sock.next(1500);
    frames += 1;
    dropped += frame.dropped;
    for (const ev of frame.batch) {
      assert(ev.seq > previous, 'seq went backwards');
      previous = ev.seq;
    }
  }
  sock.close();
  assert(dropped > 0, `no dropped reported in ${frames} frames`);
  return `dropped ${dropped} within ${frames} frame(s)`;
});

await check('§2.6 the bridge acks up to the latest seq within the ack interval', async () => {
  const target = hub.seq;
  await until(() => hub.lastAck === target, 2000, `ack upto ${target} (last ${hub.lastAck})`);
  assert(hub.ackCount > 0, 'no acks');
});

await check('§5.2 GET /events long-polls until a matching event arrives', async () => {
  const since = hub.seq;
  const pending = fetch(`${base}/events?since=${since}&kinds=assert&timeout=4000`);
  await sleep(80);
  hub.emit({ type: 'custom', name: 'ignored' });
  const target = hub.emit({ type: 'assert', name: 'poll', ok: true });
  const body = await (await pending).json();
  eq(body.session, SESSION, 'session');
  eq(body.events.length, 1, 'events');
  eq(body.events[0].seq, target, 'events[0].seq');
  eq(body.cursor, target, 'cursor');
  eq(body.dropped, 0, 'dropped');
});

await check('events tool backfills by kinds with a limit, reports truncation and a resumable cursor', async () => {
  const first = (await rpc('events', { since: 0, kinds: ['assert'], limit: 2 })).payload;
  eq(first.session, SESSION, 'session');
  eq(first.events.length, 2, 'events');
  eq(first.truncated, true, 'truncated');
  eq(first.events[0].type, 'assert', 'type');
  eq(first.cursor, first.events[1].seq, 'cursor');
  eq(first.latest_seq, hub.seq, 'latest_seq');
  const rest = (await rpc('events', { since: first.cursor, kinds: ['assert'] })).payload;
  eq(rest.events.length, 2, 'remaining asserts');
  eq(rest.truncated, false, 'rest.truncated');
  eq(rest.cursor, hub.seq, 'rest.cursor');
});

await check('events tool: a page over the result budget is cut by the tool and the cursor stops at the last event returned', async () => {
  const since = hub.seq;
  for (let i = 0; i < 300; i += 1) hub.emit({ type: 'milestone', name: 'big', data: { pad: 'p'.repeat(400), i } });
  await until(() => bridge.registry.resolve(SESSION).journal.latestSeq === hub.seq, 2000, 'journal to catch up');
  const page = (await rpc('events', { since, kinds: ['milestone'] })).payload;
  eq(page.truncated, true, 'truncated');
  assert(page.events.length > 10 && page.events.length < 300, `events ${page.events.length}`);
  eq(page.cursor, page.events.at(-1).seq, 'cursor = last returned seq');
  const rest = (await rpc('events', { since: page.cursor, kinds: ['milestone'] })).payload;
  eq(rest.events[0]?.seq, page.cursor + 1, 'next page starts right after the cursor');
});

await check('§2.7 hb: peers, playtest, dropped and fps are recorded, acked at once and shown in /status', async () => {
  const acks = hub.ackCount;
  hub.hb({
    peers: [{ dm: 'server', connected: true }, { dm: 'client:1', connected: true, userId: 7, playerName: 'player7' }],
    playtest: { running: true, mode: 'play' },
    dropped: 2,
    fps: 59.5,
  });
  await until(() => hub.ackCount > acks, 500, 'the immediate ack');
  eq(hub.lastAck, hub.seq, 'ack.upto');
  const s = (await getJson('/status')).sessions.find((x) => x.session === SESSION);
  eq(s.peers.length, 2, 'peers');
  eq(s.peers[1].playerName, 'player7', 'peers[1].playerName');
  eq(s.playtest?.running, true, 'playtest.running');
  eq(s.playtest?.mode, 'play', 'playtest.mode');
  eq(s.hubDropped, 2, 'hubDropped');
  eq(s.fps, 59.5, 'fps');
  eq(s.stale, false, 'stale');
  eq((await rpc('events', { since: hub.seq })).payload.hub_dropped, 2, 'events.hub_dropped');
});

await check('skills: save to disk, run as a program with ARGS, delete', async () => {
  eq((await rpc('skills', { action: 'save', name: 'probe', source: 'return ARGS.n', description: 'selftest' })).payload.replaced, false, 'replaced');
  const run = (await rpc('skills', { action: 'run', name: 'probe', args: { n: 2 } })).payload;
  eq(run.skill, 'probe', 'skill');
  eq(run.value?.echo, 'return ARGS.n\n', 'value.echo');
  eq(hub.requests.at(-1).body.undo_label, 'skill: probe', 'undo_label');
  eq((await rpc('skills', { action: 'delete', name: 'probe' })).payload.deleted, true, 'deleted');
});

// ---- fix pass 3: bridge-side persistence (L1), push replace (L2), file-based code (F1), logs dm all (F5), script ranges (F6) ----

const CONTROLLER = 'return { load = function(ctx) ctx.log("hi") end, unload = function() end }';
const PERSIST_FILE = path.join(home, 'persist', '1.json');

await check('(L1) persist_sync: every hello hands the hub the session’s persisted controllers as a bridge-internal req (dm edit, 30 s deadline), never a job', async () => {
  const sync = hub.requests.find((r) => r.op === 'persist_sync');
  assert(sync, 'no persist_sync after hello');
  eq(sync.v, 1, 'req.v');
  assert(JOB_ID.test(sync.id), `req.id ${sync.id}`);
  eq(sync.dm, 'edit', 'req.dm');
  eq(sync.deadline_ms, 30000, 'deadline_ms');
  assert(Array.isArray(sync.body.controllers) && sync.body.controllers.length === 0, 'controllers not empty on a fresh place');
  eq(hub.persistSyncs.length, 1, 'syncs so far');
  const jobs = (await rpc('job', { action: 'list' })).payload.jobs ?? [];
  assert(!jobs.some((j) => j.op === 'persist_sync'), 'persist_sync surfaced in job list');
  eq((await getJson('/status')).sessions.find((x) => x.session === SESSION)?.persisted, 0, 'status persisted');
});

await check('(L1) install persist=true: stored by the bridge (memory + <home>/persist/<placeId>.json), synced to the hub, listed with source bridge', async () => {
  const syncs = hub.persistSyncs.length;
  const { result, payload } = await rpc('playtest', { action: 'install', dm: 'client:1', name: 'walker', code: CONTROLLER, persist: true });
  assert(!result.isError, `error ${JSON.stringify(payload.error)}`);
  eq(payload.installed, 'walker', 'installed');
  eq(payload.persist, true, 'persist');
  eq(payload.persist_source, 'bridge', 'persist_source');
  eq(payload.persist_file, PERSIST_FILE, 'persist_file');
  eq(payload.dm, 'client:1', 'dm');
  const onDisk = JSON.parse(await fsp.readFile(PERSIST_FILE, 'utf8'));
  eq(onDisk.v, 1, 'file.v');
  eq(onDisk.placeId, 1, 'file.placeId');
  eq(onDisk.controllers?.length, 1, 'file.controllers');
  eq(onDisk.controllers[0].dm, 'client:1', 'file dm');
  eq(onDisk.controllers[0].name, 'walker', 'file name');
  eq(onDisk.controllers[0].code, CONTROLLER, 'file code');
  eq(hub.persistSyncs.length, syncs + 1, 'one persist_sync after the install');
  const synced = hub.persistSyncs.at(-1);
  eq(synced.length, 1, 'synced controllers');
  eq(synced[0].dm, 'client:1', 'synced dm');
  eq(synced[0].name, 'walker', 'synced name');
  eq(synced[0].code, CONTROLLER, 'synced code');
  const list = (await rpc('playtest', { action: 'list' })).payload;
  eq(list.controllers?.[0]?.name, 'walker', 'live controller listed by the hub');
  eq(list.persisted?.length, 1, 'persisted');
  eq(list.persisted[0].dm, 'client:1', 'persisted[0].dm');
  eq(list.persisted[0].name, 'walker', 'persisted[0].name');
  eq(list.persisted[0].source, 'bridge', 'persisted[0].source');
  eq(list.persisted[0].bytes, Buffer.byteLength(CONTROLLER), 'persisted[0].bytes');
  assert(/bridge/.test(list.persistence ?? ''), 'persistence note names the bridge');
  eq((await getJson('/status')).sessions.find((x) => x.session === SESSION)?.persisted, 1, 'status persisted');
});

await check('(L1) the latest install decides: a same-name install without persist drops the entry; uninstall drops it, even when nothing is live', async () => {
  const again = (await rpc('playtest', { action: 'install', dm: 'client:1', name: 'walker', code: CONTROLLER })).payload;
  eq(again.installed, 'walker', 'installed');
  eq(again.persist, false, 'persist');
  eq(again.persist_removed, true, 'persist_removed');
  eq(hub.persistSyncs.at(-1).length, 0, 'sync emptied');
  let missing = false;
  try {
    await fsp.access(PERSIST_FILE);
  } catch {
    missing = true;
  }
  assert(missing, 'file still present after the entry was dropped');
  await rpc('playtest', { action: 'install', dm: 'client:1', name: 'walker', code: CONTROLLER, persist: true });
  eq(hub.persistSyncs.at(-1).length, 1, 'stored again');
  const removed = (await rpc('playtest', { action: 'uninstall', dm: 'client:1', name: 'walker' })).payload;
  eq(removed.uninstalled, 'walker', 'uninstalled');
  eq(removed.persisted_removed, true, 'persisted_removed');
  eq(hub.persistSyncs.at(-1).length, 0, 'sync emptied by uninstall');
  eq((await rpc('playtest', { action: 'list' })).payload.persisted?.length, 0, 'list persisted');
  // An absent peer with nothing stored stays an error.
  eq((await rpc('playtest', { action: 'uninstall', dm: 'client:9', name: 'walker' })).payload.error?.code, 'no_peer', 'absent peer');
  // Stored entry whose live copy vanished on the hub: uninstall still removes the entry and answers ok.
  await rpc('playtest', { action: 'install', dm: 'server', name: 'ghost', code: CONTROLLER, persist: true });
  assert(hub.dropController('server', 'ghost'), 'fake hub had no live ghost');
  const gone = (await rpc('playtest', { action: 'uninstall', dm: 'server', name: 'ghost' })).payload;
  eq(gone.uninstalled, false, 'uninstalled');
  eq(gone.persisted_removed, true, 'persisted_removed');
  eq(gone.dm, 'server', 'dm');
  assert(/persisted entry was removed/.test(gone.note ?? ''), `note ${gone.note}`);
  eq(hub.persistSyncs.at(-1).length, 0, 'sync emptied');
});

await check('(L1) a re-hello of the same session gets persist_sync with the stored list; a fresh hub runtime installs it on the peers already connected (once); a fresh store (restarted bridge) reloads it from disk', async () => {
  const installsBefore = hub.persistInstalls.length;
  await rpc('playtest', { action: 'install', dm: 'client:1', name: 'walker', code: CONTROLLER, persist: true });
  await until(() => hub.persistSyncs.at(-1)?.length === 1, 1000, 'the sync after the install');
  eq(hub.persistInstalls.length, installsBefore, 'a sync never re-installs a controller the peer already runs');
  const seq = hub.seq;
  hub.close();
  await hub.closed;
  hub = await FakeHub.connect(port, { session: SESSION });
  hub.seq = seq;
  await hub.hello();
  const sync = await hub.next((f) => f.kind === 'req' && f.op === 'persist_sync', 2000);
  eq(sync.body.controllers?.length, 1, 'controllers');
  eq(sync.body.controllers[0].name, 'walker', 'name');
  eq(sync.body.controllers[0].dm, 'client:1', 'dm');
  await until(() => hub.persisted.length === 1, 1000, 'the fake hub to hold the synced list');
  // A hub runtime that starts after its agents (bundle push mid-test) sees connected peers with no
  // controllers: the sync installs what each peer lacks — exactly once (runtime Notes).
  eq(hub.controllers('client:1').map((c) => `${c.name}:${c.persist}`).join(','), 'walker:true', 'installed on the already-connected client by the sync');
  eq(hub.persistInstalls.filter((i) => i.why === 'persist_sync').length, 1, 'one install issued by the sync');
  const { PersistStore } = await load('persist.js');
  const fresh = new PersistStore(path.join(home, 'persist'), log);
  eq((await fresh.attach('another-session-on-the-same-place', 1)).map((e) => `${e.dm}/${e.name}`).join(','), 'client:1/walker', 'reloaded from disk');
  eq((await fresh.attach('a-session-on-another-place', 2)).length, 0, 'other place');
  eq((await rpc('playtest', { action: 'uninstall', dm: 'client:1', name: 'walker' })).payload.persisted_removed, true, 'cleanup');
});

await check('(L2) push sends replace=true by default and reports replaced; replace=false keeps both', async () => {
  const first = (await rpc('playtest', { action: 'push', paths: ['Workspace.PushProbe'] })).payload;
  eq(hub.requests.at(-1).body.replace, true, 'body.replace default');
  eq(first.replaced, 0, 'first replaced');
  eq(first.replace, true, 'replace echoed');
  const second = (await rpc('playtest', { action: 'push', paths: ['Workspace.PushProbe'] })).payload;
  eq(second.replaced, 1, 'second replaced');
  const third = (await rpc('playtest', { action: 'push', paths: ['Workspace.PushProbe'], replace: false })).payload;
  eq(hub.requests.at(-1).body.replace, false, 'body.replace false');
  eq(third.replaced, 0, 'third replaced');
  eq(third.replace, false, 'replace echoed false');
});

await check('(F1) code_file: the bridge reads the file (BOM stripped) and the hub receives the Luau byte-exact; code+code_file / relative / missing / neither are refused locally', async () => {
  const luau = 'return #"a\\nb" + #("x\\ny"):match("[^\\n]+")\n';
  const file = path.join(home, 'probe.luau');
  await fsp.writeFile(file, `\uFEFF${luau}`, 'utf8');
  const { result, payload } = await rpc('run', { code_file: file });
  assert(!result.isError, `error ${JSON.stringify(payload.error)}`);
  eq(hub.requests.at(-1).body.code, luau, 'code byte-exact (no BOM, escapes intact)');
  eq(hub.requests.at(-1).body.code_file, undefined, 'code_file never on the wire');
  eq(payload.value?.echo, luau, 'value.echo');
  const before = hub.requests.length;
  eq((await rpc('run', { code: 'x', code_file: file })).payload.error?.code, 'bad_request', 'code + code_file');
  eq((await rpc('run', { code_file: 'probe.luau' })).payload.error?.code, 'bad_request', 'relative');
  const missing = (await rpc('run', { code_file: path.join(home, 'nope.luau') })).payload;
  eq(missing.error?.code, 'bad_request', 'missing');
  assert(String(missing.error?.message).includes('nope.luau'), 'missing names the path');
  eq((await rpc('run', {})).payload.error?.code, 'bad_request', 'neither code nor code_file');
  eq(hub.requests.length, before, 'refused locally');
  // install / run_until / hotpatch / skills save take files too.
  await fsp.writeFile(path.join(home, 'ctl.luau'), CONTROLLER, 'utf8');
  eq((await rpc('playtest', { action: 'install', dm: 'server', name: 'filectl', code_file: path.join(home, 'ctl.luau') })).payload.installed, 'filectl', 'install from file');
  eq(hub.requests.at(-1).body.code, CONTROLLER, 'install body.code');
  await fsp.writeFile(path.join(home, 'pred.luau'), 'return true', 'utf8');
  eq((await rpc('playtest', { action: 'run_until', dm: 'server', predicate_file: path.join(home, 'pred.luau'), timeout_ms: 1000 })).payload.result, true, 'run_until from file');
  eq(hub.requests.at(-1).body.predicate, 'return true', 'run_until body.predicate');
  await fsp.writeFile(path.join(home, 'src.luau'), 'print("patched")', 'utf8');
  eq((await rpc('playtest', { action: 'hotpatch', dm: 'server', path: 'ServerScriptService.Main', source_file: path.join(home, 'src.luau') })).payload.patched, 'ServerScriptService.Main', 'hotpatch from file');
  eq(hub.requests.at(-1).body.source, 'print("patched")', 'hotpatch body.source');
  eq((await rpc('skills', { action: 'save', name: 'fromfile', source_file: path.join(home, 'src.luau') })).payload.name, 'fromfile', 'skills save from file');
  eq((await rpc('skills', { action: 'get', name: 'fromfile' })).payload.source, 'print("patched")\n', 'skill source');
  await rpc('skills', { action: 'delete', name: 'fromfile' });
  await rpc('playtest', { action: 'uninstall', dm: 'server', name: 'filectl' });
});

await check('(F1) escapes: "\\n" and "[^\\n]+" inside Luau strings reach the hub as two characters and compile; a raw newline inside a literal gets the transport hint', async () => {
  const code = 'local n = #"a\\nb"\nreturn ("x\\ny"):find("[^\\n]+"), n';
  const { result, payload } = await rpc('run', { code });
  assert(!result.isError, `error ${JSON.stringify(payload.error)}`);
  eq(payload.value?.echo, code, 'value.echo');
  eq(hub.requests.at(-1).body.code.split('\\n').length, 4, 'three escaped \\n sequences survived');
  const broken = (await rpc('run', { code: 'return #"a\nb"' })).payload;
  eq(broken.error?.code, 'syntax_error', 'code');
  assert(/Malformed string/.test(broken.error?.message ?? ''), 'message');
  eq(broken.error?.hint, 'your transport turned \\n into a newline — pass code from a file (code_file)', 'hint');
  assert(String(broken.error?.message).endsWith('(code_file)'), 'hint appended to the message');
  const predicate = (await rpc('playtest', { action: 'run_until', dm: 'server', predicate: 'return #"a\nb" > 0', timeout_ms: 500 })).payload;
  eq(predicate.error?.code, 'syntax_error', 'predicate code');
  assert(String(predicate.error?.hint).endsWith('(predicate_file)'), `predicate hint ${predicate.error?.hint}`);
  const controller = (await rpc('playtest', { action: 'install', dm: 'server', name: 'bad', code: 'return { load = function() print("a\nb") end }' })).payload;
  eq(controller.error?.code, 'syntax_error', 'install code');
  assert(String(controller.error?.hint).endsWith('(code_file)'), `install hint ${controller.error?.hint}`);
});

await check('(F5/F6) observe logs dm all rides on req.dm edit with body.dm all (lines carry src); observe script passes path/from/to and returns the text uncut', async () => {
  const all = (await rpc('observe', { what: 'logs', dm: 'all' })).payload;
  eq(hub.requests.at(-1).dm, 'edit', 'req.dm');
  eq(hub.requests.at(-1).body.dm, 'all', 'body.dm');
  eq(all.items?.length, 4, 'merged items');
  eq(new Set(all.items.map((i) => i.src)).size, 3, 'sources');
  const server = (await rpc('observe', { what: 'logs', dm: 'server' })).payload;
  eq(hub.requests.at(-1).dm, 'server', 'req.dm for one dm');
  assert(server.items.every((i) => i.src === 'server'), 'filtered by dm');
  eq((await rpc('observe', { what: 'tree', dm: 'all' })).payload.error?.code, 'bad_request', "dm 'all' outside logs");
  const range = (await rpc('observe', { what: 'script', path: 'ServerScriptService.Main', from: 10, to: 20 })).payload;
  eq(hub.requests.at(-1).body.what, 'script', 'body.what');
  eq(hub.requests.at(-1).body.path, 'ServerScriptService.Main', 'body.path');
  eq(hub.requests.at(-1).body.from, 10, 'body.from');
  eq(hub.requests.at(-1).body.to, 20, 'body.to');
  eq(range.lines, 11, 'lines');
  eq(range.total_lines, 60, 'total_lines');
  eq(range.class, 'Script', 'class');
  assert(range.text.startsWith('-- line 10 '), 'text starts at line 10');
  const whole = (await rpc('observe', { what: 'script', path: 'ServerScriptService.Main' })).payload;
  assert(whole.text.length > 8192, `whole text ${whole.text.length} chars`);
  assert(!whole.text.includes('…[+'), 'text was cut');
  eq(whole.lines, 60, 'whole lines');
  eq((await rpc('observe', { what: 'script' })).payload.error?.code, 'bad_request', 'path required');
  eq((await rpc('observe', { what: 'script', path: 'x', from: 5, to: 2 })).payload.error?.code, 'bad_request', 'to < from');
});

// ---- geometry rules: §4.1 geometry_policy, §4.2 observe geometry, STUDIO_LIVE_GEOMETRY_POLICY (protocol Notes "geometry") ----

await check('(geometry) run: geometry_policy defaults to warn on the edit DM, an explicit value is forwarded, play DMs are unchecked unless asked; skills run alike; unknown values are refused locally', async () => {
  const overlapRuns = hub.geometryRuns.length;
  eq((await rpc('run', { code: 'return 1' })).payload.value?.echo, 'return 1', 'plain run');
  eq(hub.requests.at(-1).body.geometry_policy, 'warn', 'bridge default on the edit DM');
  await rpc('run', { code: 'return 1', dm: 'edit', geometry_policy: 'reject' });
  eq(hub.requests.at(-1).body.geometry_policy, 'reject', 'explicit reject');
  await rpc('run', { code: 'return 1', geometry_policy: 'off' });
  eq(hub.requests.at(-1).body.geometry_policy, 'off', 'explicit off');
  await rpc('run', { code: 'return 1', dm: 'server' });
  eq(hub.requests.at(-1).body.geometry_policy, undefined, 'play DM: no policy unless asked');
  await rpc('run', { code: 'return 1', dm: 'client:1', geometry_policy: 'warn' });
  eq(hub.requests.at(-1).body.geometry_policy, 'warn', 'play DM: explicit policy forwarded');
  await rpc('skills', { action: 'save', name: 'geo', source: 'return 1' });
  await rpc('skills', { action: 'run', name: 'geo' });
  eq(hub.requests.at(-1).body.geometry_policy, 'warn', 'skills run default');
  await rpc('skills', { action: 'run', name: 'geo', geometry_policy: 'off' });
  eq(hub.requests.at(-1).body.geometry_policy, 'off', 'skills run explicit');
  await rpc('skills', { action: 'run', name: 'geo', dm: 'server' });
  eq(hub.requests.at(-1).body.geometry_policy, undefined, 'skills run on a play DM');
  await rpc('skills', { action: 'delete', name: 'geo' });
  const before = hub.requests.length;
  const bad = (await rpc('run', { code: 'return 1', geometry_policy: 'strict' })).payload;
  eq(bad.error?.code, 'bad_request', 'unknown policy');
  assert(Array.isArray(bad.error?.issues) && bad.error.issues.some((i) => /^geometry_policy:/.test(i)), `issues ${JSON.stringify(bad.error?.issues)}`);
  eq((await rpc('skills', { action: 'run', name: 'geo', geometry_policy: 'never' })).payload.error?.code, 'bad_request', 'unknown policy on skills run');
  eq(hub.requests.length, before, 'refused locally');
  eq(hub.geometryRuns.length, overlapRuns, 'plain programs are not the overlap program');
});

await check('(geometry) run warn: the report and the runtime warnings pass through the result unchanged; off skips the check; play DMs only when asked', async () => {
  const { result, payload } = await rpc('run', { code: 'overlap', undo_label: 'agent: deck' });
  assert(!result.isError, `error ${JSON.stringify(payload.error)}`);
  eq(hub.geometryRuns.at(-1)?.policy, 'warn', 'hub saw warn');
  eq(payload.undo, 'committed', 'undo');
  eq(payload.value?.built, 4, 'value');
  eq(payload.changes?.added, 4, 'changes.added');
  const g = payload.geometry;
  eq(g?.totals?.overlaps, 3, 'totals.overlaps');
  eq(g?.totals?.nested, 1, 'totals.nested');
  eq(g?.overlaps?.length, 3, 'overlaps listed');
  eq(g?.overlaps?.[0]?.a, 'Workspace.Map.Deck', 'overlaps[0].a');
  eq(g?.overlaps?.[0]?.b, 'Workspace.Map.WallEast', 'overlaps[0].b');
  eq(g?.overlaps?.[0]?.depth, 1.5, 'overlaps[0].depth');
  eq(g?.overlaps?.[0]?.aClass, 'Part', 'overlaps[0].aClass');
  eq(g?.overlaps?.[1]?.approximate, true, 'the wedge pair is approximate');
  eq(g?.overlaps?.[2]?.decor, true, 'the CanCollide=false pair is decor');
  eq(g?.nested?.[0]?.path, 'Workspace.Map.Pillar.Cap', 'nested[0].path');
  eq(g?.nested?.[0]?.parent, 'Workspace.Map.Pillar', 'nested[0].parent');
  eq(g?.checked, 4, 'checked');
  eq(g?.sampled, undefined, 'sampled omitted when false');
  eq(typeof g?.ms, 'number', 'ms');
  eq(payload.warnings?.length, 2, 'two warning lines');
  assert(/^3 overlapping part pairs \(e\.g\. Workspace\.Map\.Deck ⟂ Workspace\.Map\.WallEast, 1\.5 studs\) — fix before continuing/.test(payload.warnings[0]), `warnings[0] ${payload.warnings[0]}`);
  assert(/see geometry$/.test(payload.warnings[0]), 'warnings[0] points at geometry');
  assert(/^1 part parented under another part \(e\.g\. Workspace\.Map\.Pillar\.Cap under Workspace\.Map\.Pillar\)/.test(payload.warnings[1]), `warnings[1] ${payload.warnings[1]}`);
  const off = (await rpc('run', { code: 'overlap', geometry_policy: 'off' })).payload;
  eq(hub.geometryRuns.at(-1)?.policy, 'off', 'hub saw off');
  eq(off.geometry, undefined, 'no report with off');
  eq(off.warnings, undefined, 'no warnings with off');
  eq(off.undo, 'committed', 'off still commits');
  const play = (await rpc('run', { code: 'overlap', dm: 'server' })).payload;
  eq(hub.geometryRuns.at(-1)?.policy, null, 'play DM: no policy sent');
  eq(play.geometry, undefined, 'play DM: unchecked');
  eq(play.ephemeral, true, 'play DM: ephemeral');
  const playWarn = (await rpc('run', { code: 'overlap', dm: 'server', geometry_policy: 'warn' })).payload;
  eq(playWarn.geometry?.totals?.overlaps, 3, 'play DM: checked when asked');
  eq(playWarn.dm, 'server', 'play DM: responder');
});

await check('(geometry) run reject: error geometry_violation carries the report, warnings, undo cancelled, output, dm and job_id; the same through skills run; no transport hint', async () => {
  const { result, payload } = await rpc('run', { code: 'overlap', geometry_policy: 'reject' });
  eq(result.isError, true, 'isError');
  eq(hub.geometryRuns.at(-1)?.policy, 'reject', 'hub saw reject');
  const e = payload.error;
  eq(e?.code, 'geometry_violation', 'code');
  assert(/rolled back/.test(e?.message ?? ''), `message ${e?.message}`);
  assert(/see geometry$/.test(e?.message ?? ''), 'message points at geometry');
  eq(e?.geometry?.totals?.overlaps, 3, 'error.geometry.totals.overlaps');
  eq(e?.geometry?.overlaps?.length, 3, 'error.geometry.overlaps');
  eq(e?.geometry?.nested?.length, 1, 'error.geometry.nested');
  eq(e?.warnings?.length, 2, 'error.warnings');
  eq(e?.undo, 'cancelled', 'error.undo');
  assert(Array.isArray(e?.output), 'error.output');
  eq(e?.dm, 'edit', 'error.dm');
  assert(JOB_ID.test(e?.job_id ?? ''), 'job_id');
  eq(e?.hint, undefined, 'no transport hint on a geometry error');
  eq(payload.geometry, undefined, 'the report lives under error, not beside it');
  const job = (await rpc('job', { action: 'status', job_id: e.job_id })).payload;
  eq(job.status, 'error', 'job status');
  eq(job.error?.code, 'geometry_violation', 'job error code');
  await rpc('skills', { action: 'save', name: 'overlap', source: 'overlap' });
  const skill = (await rpc('skills', { action: 'run', name: 'overlap', geometry_policy: 'reject' })).payload;
  eq(skill.error?.code, 'geometry_violation', 'skills run code');
  eq(skill.error?.geometry?.totals?.nested, 1, 'skills run report');
  eq(hub.requests.at(-1).body.undo_label, 'skill: overlap', 'skills run undo_label');
  const skillWarn = (await rpc('skills', { action: 'run', name: 'overlap' })).payload;
  eq(skillWarn.skill, 'overlap', 'skills run warn result');
  eq(skillWarn.geometry?.totals?.overlaps, 3, 'skills run warn report');
  await rpc('skills', { action: 'delete', name: 'overlap' });
});

await check('(geometry) observe geometry: root/max/tolerance/include_nested reach the executor on req.dm (defaults are its own), the report comes back; misplaced or out-of-range arguments are refused locally', async () => {
  const { result, payload } = await rpc('observe', { what: 'geometry' });
  assert(!result.isError, `error ${JSON.stringify(payload.error)}`);
  const req = hub.requests.at(-1);
  eq(req.op, 'observe', 'req.op');
  eq(req.dm, 'edit', 'req.dm');
  eq(req.body.what, 'geometry', 'body.what');
  eq(req.body.root, undefined, 'no root invented');
  eq(req.body.max, undefined, 'no max invented');
  eq(req.body.tolerance, undefined, 'no tolerance invented');
  eq(req.body.include_nested, undefined, 'no include_nested invented');
  eq(hub.geometryObserves.at(-1)?.root, 'Workspace', 'executor default root');
  eq(payload.overlaps?.length, 3, 'overlaps');
  eq(payload.nested?.length, 1, 'nested');
  eq(payload.checked, 4, 'checked');
  eq(payload.sampled, false, 'sampled');
  eq(typeof payload.ms, 'number', 'ms');
  eq(payload.totals?.overlaps, 3, 'totals.overlaps');
  eq(payload.totals?.nested, 1, 'totals.nested');
  eq(payload.dm, 'edit', 'dm');
  const tuned = (await rpc('observe', { what: 'geometry', root: 'Workspace.Map', max: 1, tolerance: 1, include_nested: false, dm: 'server' })).payload;
  const req2 = hub.requests.at(-1);
  eq(req2.dm, 'server', 'req.dm routes into the play DM');
  eq(req2.body.dm, 'server', 'body.dm');
  eq(req2.body.root, 'Workspace.Map', 'body.root');
  eq(req2.body.max, 1, 'body.max');
  eq(req2.body.tolerance, 1, 'body.tolerance');
  eq(req2.body.include_nested, false, 'body.include_nested');
  eq(tuned.overlaps?.length, 1, 'tolerance 1 hides the shallow pairs');
  eq(tuned.checked, 1, 'max is the number of parts checked, not a list cap');
  eq(tuned.overlaps?.[0]?.depth, 1.5, 'the deep pair survives');
  eq(tuned.totals?.overlaps, 1, 'totals follow the tolerance');
  eq(tuned.nested?.length, 0, 'nesting off');
  eq(tuned.totals?.nested, 0, 'totals.nested off');
  eq(tuned.dm, 'server', 'responder dm');
  eq((await rpc('observe', { what: 'geometry', root: 'Nowhere.Map' })).payload.error?.code, 'bad_request', "the executor's bad_request for an unknown root passes through");
  const before = hub.requests.length;
  eq((await rpc('observe', { what: 'tree', tolerance: 0.1 })).payload.error?.code, 'bad_request', 'tolerance outside geometry');
  eq((await rpc('observe', { what: 'find', include_nested: true })).payload.error?.code, 'bad_request', 'include_nested outside geometry');
  eq((await rpc('observe', { what: 'geometry', tolerance: 6 })).payload.error?.code, 'bad_request', 'tolerance above 5');
  eq((await rpc('observe', { what: 'geometry', max: 6000 })).payload.error?.code, 'bad_request', 'max above 5000');
  eq((await rpc('observe', { what: 'geometry', dm: 'all' })).payload.error?.code, 'bad_request', "dm 'all' outside logs");
  eq(hub.requests.length, before, 'refused locally');
});

await check('(geometry) STUDIO_LIVE_GEOMETRY_POLICY: loadConfig parses it (case-insensitive, default warn, bad_config otherwise); a bridge started with reject sends it on every edit-DM run that names none, the call still wins, play DMs stay unchecked', async () => {
  eq(loadConfig({ STUDIO_LIVE_HOME: home, STUDIO_LIVE_GEOMETRY_POLICY: 'Off' }).geometryPolicy, 'off', 'case-insensitive');
  eq(loadConfig({ STUDIO_LIVE_HOME: home }).geometryPolicy, 'warn', 'default');
  eq(config.geometryPolicy, 'warn', 'the selftest bridge runs the default');
  let refused = null;
  try {
    loadConfig({ STUDIO_LIVE_HOME: home, STUDIO_LIVE_GEOMETRY_POLICY: 'strict' });
  } catch (err) {
    refused = err;
  }
  eq(refused?.code, 'bad_config', 'unknown value refused at load');
  assert(/STUDIO_LIVE_GEOMETRY_POLICY/.test(refused?.message ?? ''), 'message names the variable');
  const strictHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-live-selftest-strict-'));
  const strictConfig = { ...loadConfig({ STUDIO_LIVE_HOME: strictHome, STUDIO_LIVE_LOG: process.env.STUDIO_LIVE_LOG ?? 'error', STUDIO_LIVE_GEOMETRY_POLICY: 'reject' }), port: 0, dev: false };
  eq(strictConfig.geometryPolicy, 'reject', 'strict config');
  const strict = await createBridge(strictConfig, log, { requestGraceMs: 500, ackIntervalMs: 100, capture });
  try {
    eq(strict.mode, 'primary', 'a second primary on its own ephemeral port');
    assert(strict.port !== port, 'own port');
    const peer = await FakeHub.connect(strict.port, { session: '5e1f7e57-0000-4000-8000-00000000d00d' });
    eq((await peer.hello()).ack.kind, 'hello_ack', 'peer hello');
    const call = async (tool, args) => {
      const response = await fetch(`http://127.0.0.1:${strict.port}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, args }) });
      const body = await response.json();
      return JSON.parse(body.content?.find((c) => c.type === 'text')?.text ?? '{}');
    };
    const lastRun = () => peer.requests.filter((r) => r.op === 'run').at(-1)?.body;
    eq((await call('run', { code: 'return 1' })).value?.echo, 'return 1', 'run on the strict bridge');
    eq(lastRun()?.geometry_policy, 'reject', 'env default reaches the hub');
    const rejected = await call('run', { code: 'overlap' });
    eq(rejected.error?.code, 'geometry_violation', 'the env default makes an overlapping run fatal');
    eq(rejected.error?.undo, 'cancelled', 'rolled back');
    const warned = await call('run', { code: 'overlap', geometry_policy: 'warn' });
    eq(lastRun()?.geometry_policy, 'warn', 'the call wins over the env default');
    eq(warned.geometry?.totals?.overlaps, 3, 'reported, not rejected');
    await call('run', { code: 'return 1', dm: 'server' });
    eq(lastRun()?.geometry_policy, undefined, 'play DM unchecked under the env default');
    await call('skills', { action: 'save', name: 'strictgeo', source: 'return 1' });
    await call('skills', { action: 'run', name: 'strictgeo' });
    eq(lastRun()?.geometry_policy, 'reject', 'skills run takes the env default');
    peer.close();
    await peer.closed;
  } finally {
    await strict.close();
    await fsp.rm(strictHome, { recursive: true, force: true });
  }
});

// ---- v1.1: multiplayer playtests, add_players, push, place identity (protocol Notes "runtime v1.1") ----

await check('§4.3 (v1.1) playtest start multiplayer: players and a 120 s deadline reach the hub; peers server + client:1..2 (Player1.., userId −1, −2), playtest events and hb follow', async () => {
  const monitor = openEvents('?kinds=playtest');
  await monitor.open;
  const before = hub.requests.length;
  const { result, payload } = await rpc('playtest', { action: 'start', mode: 'multiplayer' });
  assert(!result.isError, `error ${JSON.stringify(payload.error)}`);
  const req = hub.requests[before];
  eq(req.op, 'playtest', 'req.op');
  eq(req.dm, 'edit', 'req.dm');
  eq(req.deadline_ms, 120000, 'deadline_ms');
  eq(req.body.action, 'start', 'body.action');
  eq(req.body.mode, 'multiplayer', 'body.mode');
  eq(req.body.players, 2, 'body.players (bridge default)');
  eq(payload.running, true, 'running');
  eq(payload.mode, 'multiplayer', 'mode');
  eq(payload.players, 2, 'players');
  eq(payload.dm, 'edit', 'dm');
  assert(typeof payload.started_ms === 'number', 'started_ms missing');
  eq(payload.peers.map((p) => p.dm).join(','), 'server,client:1,client:2', 'peers');
  eq(payload.peers[1].userId, -1, 'client:1 userId');
  eq(payload.peers[1].playerName, 'Player1', 'client:1 playerName');
  eq(payload.peers[2].userId, -2, 'client:2 userId');
  // The hub's extra heartbeats on every state change keep /status current.
  const s = (await getJson('/status')).sessions.find((x) => x.session === SESSION);
  eq(s.playtest?.running, true, 'status playtest.running');
  eq(s.playtest?.mode, 'multiplayer', 'status playtest.mode');
  eq(s.playtest?.players, 2, 'status playtest.players');
  eq(s.peers.length, 3, 'status peers');
  eq(s.peers[2].userId, -2, 'status peers[2].userId');
  // /events: `starting` then `running`, both naming the mode; `running` carries the player count.
  const states = [];
  let runningEvent = null;
  while (runningEvent === null) {
    const frame = await monitor.next();
    for (const ev of frame.batch) {
      if (ev.type !== 'playtest') continue;
      states.push(ev.state);
      if (ev.state === 'running') runningEvent = ev;
    }
  }
  monitor.close();
  eq(states[0], 'starting', 'first playtest event');
  eq(runningEvent.mode, 'multiplayer', 'running.mode');
  eq(runningEvent.players, 2, 'running.players');
  eq(runningEvent.src, 'edit', 'running.src');
  // A second start while the test runs is a state check on the hub: busy.
  eq((await rpc('playtest', { action: 'start', mode: 'multiplayer' })).payload.error?.code, 'busy', 'second start');
  // Bridge-side validation never reaches Studio: players outside 1-8, or players without multiplayer.
  const sent = hub.requests.length;
  eq((await rpc('playtest', { action: 'start', mode: 'multiplayer', players: 9 })).payload.error?.code, 'bad_request', 'players 9');
  eq((await rpc('playtest', { action: 'start', mode: 'play', players: 2 })).payload.error?.code, 'bad_request', 'players with play');
  eq(hub.requests.length, sent, 'refused locally');
  return `${states.join(' → ')}, ${payload.started_ms} ms`;
});

await check('§4.3 (v1.1) add_players: count reaches the hub with a 120 s deadline; the new client joins as client:3 (userId −3) and /status follows', async () => {
  const { result, payload } = await rpc('playtest', { action: 'add_players' });
  assert(!result.isError, `error ${JSON.stringify(payload.error)}`);
  const req = hub.requests.at(-1);
  eq(req.op, 'playtest', 'req.op');
  eq(req.dm, 'edit', 'req.dm');
  eq(req.deadline_ms, 120000, 'deadline_ms');
  eq(req.body.action, 'add_players', 'body.action');
  eq(req.body.count, 1, 'body.count (bridge default)');
  eq(payload.added, 1, 'added');
  eq(payload.joined, 1, 'joined');
  eq(payload.complete, true, 'complete');
  eq(payload.players, 3, 'players');
  eq(payload.peers.length, 4, 'peers');
  eq(payload.peers[3].dm, 'client:3', 'peers[3].dm');
  eq(payload.peers[3].userId, -3, 'peers[3].userId');
  const s = (await getJson('/status')).sessions.find((x) => x.session === SESSION);
  eq(s.playtest?.players, 3, 'status playtest.players');
  eq(s.peers.length, 4, 'status peers');
  const two = (await rpc('playtest', { action: 'add_players', count: 2 })).payload;
  eq(hub.requests.at(-1).body.count, 2, 'body.count 2');
  eq(two.added, 2, 'added 2');
  eq(two.players, 5, 'players 5');
  eq((await rpc('playtest', { action: 'add_players', count: 9 })).payload.error?.code, 'bad_request', 'count 9');
  eq((await rpc('run', { code: 'return 1', dm: 'client:5' })).payload.value?.echo, 'return 1', 'run on the late client');
});

await check('§4 (v1.1) push: op push with req.dm edit and the destination in body.dm; the result names the play DM, lists the landed paths and marks replication', async () => {
  const before = hub.requests.length;
  eq((await rpc('playtest', { action: 'push', paths: ['Workspace.Arena'], dm: 'edit' })).payload.error?.code, 'bad_request', 'dm edit');
  eq((await rpc('playtest', { action: 'push' })).payload.error?.code, 'bad_request', 'paths missing');
  eq(hub.requests.length, before, 'refused locally');
  const { result, payload } = await rpc('playtest', { action: 'push', paths: ['Workspace.Arena', 'ReplicatedStorage.Config'], dm: 'client', parent: 'Workspace.Live', timeout_ms: 10000 });
  assert(!result.isError, `error ${JSON.stringify(payload.error)}`);
  const req = hub.requests.at(-1);
  eq(req.op, 'push', 'req.op');
  eq(req.dm, 'edit', 'req.dm');
  eq(req.deadline_ms, 10000, 'deadline_ms');
  eq(req.body.dm, 'client', 'body.dm');
  eq(req.body.parent, 'Workspace.Live', 'body.parent');
  eq(req.body.paths?.length, 2, 'body.paths');
  eq(payload.dm, 'client:1', 'dm = the peer that received the instances');
  eq(payload.count, 2, 'count');
  eq(payload.paths?.[0], 'Workspace.Live.Arena', 'paths[0]');
  eq(payload.replicated, false, 'replicated (client)');
  eq(payload.parent, 'Workspace.Live', 'parent echoed');
  eq(hub.pushes.at(-1)?.dm, 'client:1', 'hub forwarded to client:1');
  const server = (await rpc('playtest', { action: 'push', paths: ['Workspace.Arena'] })).payload;
  eq(hub.requests.at(-1).body.dm, 'server', 'default body.dm');
  eq(hub.requests.at(-1).body.parent, undefined, 'no parent sent');
  eq(hub.requests.at(-1).deadline_ms, 30000, 'default deadline');
  eq(server.dm, 'server', 'server dm');
  eq(server.replicated, true, 'replicated (server)');
  eq(server.paths?.[0], 'Workspace.Arena', 'lands at its edit-DM path');
  eq(server.parent, undefined, 'no parent default invented by the bridge');
  eq((await rpc('playtest', { action: 'push', paths: ['Workspace.Arena'], dm: 'client:9' })).payload.error?.code, 'no_peer', 'absent client');
});

await check('(v1.1) place identity: hb universeId/creatorType/creatorId reach GET /status, observe status place.* and bridge.sessions[]', async () => {
  const s = (await getJson('/status')).sessions.find((x) => x.session === SESSION);
  eq(s.universeId, 4242, 'status universeId');
  eq(s.creatorType, 'User', 'status creatorType');
  eq(s.creatorId, 100000001, 'status creatorId');
  eq(s.studio?.placeName, 'FakeHub', 'status placeName from hb');
  const { payload } = await rpc('observe', { what: 'status' });
  eq(payload.place?.universeId, 4242, 'place.universeId');
  eq(payload.place?.creatorType, 'User', 'place.creatorType');
  eq(payload.place?.creatorId, 100000001, 'place.creatorId');
  eq(payload.playtest?.mode, 'multiplayer', 'playtest.mode');
  eq(payload.playtest?.players, 5, 'playtest.players');
  eq(payload.bridge?.playtest?.mode, 'multiplayer', 'bridge.playtest.mode');
  const mine = payload.bridge?.sessions?.find((x) => x.session === SESSION);
  eq(mine?.universeId, 4242, 'bridge.sessions[].universeId');
  eq(mine?.creatorType, 'User', 'bridge.sessions[].creatorType');
  eq(mine?.creatorId, 100000001, 'bridge.sessions[].creatorId');
  eq(mine?.placeId, 1, 'bridge.sessions[].placeId');
  // A status answer without identity (older runtime) is completed from what the bridge learned over hb.
  hub.statusOmitsIdentity = true;
  const filled = (await rpc('observe', { what: 'status' })).payload;
  hub.statusOmitsIdentity = false;
  eq(filled.place?.universeId, 4242, 'filled place.universeId');
  eq(filled.place?.creatorType, 'User', 'filled place.creatorType');
  eq(filled.place?.creatorId, 100000001, 'filled place.creatorId');
});

await check('§4.3 (v1.1) playtest stop ends the test through the server peer: stopping → stopped events, peers gone, /status idle; a second stop answers stopped_ms 0 with a note', async () => {
  // Stored while the server peer is still up; the next check uninstalls it once the peer is gone.
  const stored = (await rpc('playtest', { action: 'install', dm: 'server', name: 'orphan', code: CONTROLLER, persist: true })).payload;
  eq(stored.persist, true, 'orphan persisted');
  const monitor = openEvents('?kinds=playtest');
  await monitor.open;
  const { result, payload } = await rpc('playtest', { action: 'stop' });
  assert(!result.isError, `error ${JSON.stringify(payload.error)}`);
  eq(hub.requests.at(-1).body.action, 'stop', 'body.action');
  eq(hub.requests.at(-1).dm, 'edit', 'req.dm');
  assert(typeof payload.stopped_ms === 'number' && payload.stopped_ms > 0, `stopped_ms ${payload.stopped_ms}`);
  const states = [];
  while (!states.includes('stopped')) {
    const frame = await monitor.next();
    for (const ev of frame.batch) if (ev.type === 'playtest') states.push(ev.state);
  }
  monitor.close();
  eq(states.join(','), 'stopping,stopped', 'playtest events');
  const s = (await getJson('/status')).sessions.find((x) => x.session === SESSION);
  eq(s.playtest?.running, false, 'status playtest.running');
  eq(s.peers.length, 0, 'status peers');
  const again = (await rpc('playtest', { action: 'stop' })).payload;
  eq(again.stopped_ms, 0, 'second stop');
  eq(again.note, 'no playtest was running', 'second stop note');
  eq((await rpc('playtest', { action: 'status' })).payload.running, false, 'status after stop');
  eq((await rpc('run', { code: 'x', dm: 'server' })).payload.error?.code, 'no_peer', 'server gone');
});

await check('(fix pass 4) uninstall of a persisted controller whose peer is gone: the hub refuses with no_peer from its own dispatcher (dm edit) and the bridge still drops the entry', async () => {
  const syncs = hub.persistSyncs.length;
  eq((await rpc('playtest', { action: 'list' })).payload.persisted?.map((e) => `${e.dm}/${e.name}`).join(','), 'server/orphan', 'stored before');
  const gone = (await rpc('playtest', { action: 'uninstall', dm: 'server', name: 'orphan' })).payload;
  eq(gone.uninstalled, false, 'uninstalled');
  eq(gone.persisted_removed, true, 'persisted_removed');
  eq(gone.dm, 'server', 'dm');
  assert(/no_peer/.test(gone.note ?? ''), `note ${gone.note}`);
  eq(hub.persistSyncs.length, syncs + 1, 'one sync after the removal');
  eq(hub.persistSyncs.at(-1).length, 0, 'sync emptied');
  eq((await rpc('playtest', { action: 'list' })).payload.persisted?.length, 0, 'list persisted');
  // Nothing stored + no peer stays the raw error.
  eq((await rpc('playtest', { action: 'uninstall', dm: 'server', name: 'orphan' })).payload.error?.code, 'no_peer', 'second uninstall');
});

await check('§8 a hub announcing an older bootstrap is flagged in /status and observe status', async () => {
  const old = await FakeHub.connect(port, { session: OLD_SESSION, bootstrap: '0.9.0' });
  eq((await old.hello()).ack.kind, 'hello_ack', 'kind');
  const s = (await getJson('/status')).sessions.find((x) => x.session === OLD_SESSION);
  eq(s?.bootstrapOutdated, true, 'bootstrapOutdated');
  const { payload } = await rpc('observe', { what: 'status', session: OLD_SESSION });
  eq(payload.bridge?.bootstrap?.outdated, true, 'bridge.bootstrap.outdated');
  eq(payload.bridge?.bootstrap?.shipped, config.bootstrapVersion, 'bridge.bootstrap.shipped');
  old.close();
  await old.closed;
});

await check('§1.1 reconnect: a new socket with the same session resumes with ackUpto = latest seq and keeps in-flight jobs', async () => {
  const seq = hub.seq;
  const inflight = (await rpc('run', { code: 'hang', wait_ms: 20, timeout_ms: 10000 })).payload;
  eq(inflight.status, 'running', 'job running before the drop');
  hub.close();
  await hub.closed;
  await sleep(50);
  const status = await getJson('/status');
  eq(status.sessions.find((x) => x.session === SESSION)?.connected, false, 'connected after close');
  eq(status.active, null, 'active after close');
  eq((await rpc('job', { action: 'status', job_id: inflight.job_id })).payload.status, 'running', 'job survives the socket close');
  eq((await rpc('job', { action: 'status', job_id: inflight.job_id })).payload.hub_connected, false, 'hub_connected while away');
  hub = await FakeHub.connect(port, { session: SESSION });
  hub.seq = seq;
  const { ack } = await hub.hello();
  eq(ack.ackUpto, seq, 'ackUpto');
  eq((await getJson('/status')).sessions.length, 2, 'sessions (this one and the old-bootstrap one)');
  eq((await rpc('observe', { what: 'status' })).payload.role, 'edit', 'tool call after reconnect');
  // The hub answers the old id on the new socket, as the runtime does after the bootstrap's refresh.
  hub.ok(inflight.job_id, 'edit', { value: { resumed: true }, undo: 'committed' });
  const done = (await rpc('job', { action: 'wait', job_id: inflight.job_id, wait_ms: 2000 })).payload;
  eq(done.status, 'done', 'job completed after the reconnect');
  eq(done.result?.value?.resumed, true, 'result delivered on the new socket');
});

await check('two connected Studios: the active one is sticky, writes require session, reads say so, /events pins', async () => {
  const second = await FakeHub.connect(port, { session: SECOND_SESSION });
  await second.hello({ studio: { version: 'x', placeId: 2, placeName: 'Scratch', dataModelName: 'Place2' } });
  second.hb();
  await until(() => second.ackCount > 0, 1000, 'ack for the second hub');
  eq((await getJson('/status')).active, SESSION, 'active stays with the first hub after the second hello + hb');
  const refused = (await rpc('run', { code: 'return 1' })).payload;
  eq(refused.error?.code, 'bad_request', 'write without session');
  assert(/several Studio sessions/.test(refused.error?.message ?? ''), 'message names the sessions');
  const read = (await rpc('events', { since: hub.seq })).payload;
  eq(read.session, SESSION, 'read uses the active session');
  assert(/2 Studio sessions/.test(read.session_note ?? ''), 'read carries the session note');
  const monitor = openEvents();
  await monitor.open;
  second.emit({ type: 'assert', name: 'other', ok: true });
  const mine = hub.emit({ type: 'assert', name: 'mine', ok: true });
  const frame = await monitor.next();
  eq(frame.batch.length, 1, 'only the pinned session reaches the socket');
  eq(frame.batch[0].seq, mine, 'pinned to the active session at attach');
  monitor.close();
  const named = (await rpc('run', { code: 'return 1', session: SECOND_SESSION.slice(0, 34) })).payload;
  eq(named.value?.echo, 'return 1', 'named session served the write');
  eq((await getJson('/status')).active, SECOND_SESSION, 'naming a session makes it active');
  second.close();
  await second.closed;
  await sleep(50);
  eq((await getJson('/status')).active, SESSION, 'fails over when the active hub leaves');
});

await check('a second bridge on the same port runs in proxy mode and forwards tool calls over POST /rpc', async () => {
  const proxy = await createBridge({ ...config, port }, log, { capture });
  eq(proxy.mode, 'proxy', 'mode');
  eq(proxy.primary.pid, process.pid, 'primary.pid');
  const result = await proxy.executor.call('playtest', { action: 'status' });
  const payload = JSON.parse(result.content[0].text);
  eq(payload.running, false, 'running');
  eq(payload.dm, 'edit', 'dm');
  await proxy.close();
});

await check('§4.6 shutdown: jobs from other processes drain first, then cancel_all reaches the hub and the socket is closed', async () => {
  const rpcJob = (await rpc('run', { code: 'sleep:300', wait_ms: 10 })).payload;
  eq(rpcJob.status, 'running', 'rpc job running');
  const t0 = Date.now();
  eq(await bridge.drainRpcJobs(5000), 0, 'drained');
  assert(Date.now() - t0 >= 200, 'drain waited for the rpc job');
  eq(bridge.jobs.get(rpcJob.job_id)?.status, 'done', 'rpc job finished before shutdown');
  const closing = bridge.close();
  const frame = await hub.next((f) => f.kind === 'cancel_all', 2000);
  eq(frame.v, 1, 'cancel_all.v');
  const code = await hub.closed;
  assert(typeof code === 'number', 'no close code');
  await closing;
});

await fsp.rm(home, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
