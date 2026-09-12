import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { loadConfig, PACKAGE_ROOT, parseGeometryPolicy } from '../../bridge/src/config.js';
import { EventFanout } from '../../bridge/src/fanout.js';
import { JobStore } from '../../bridge/src/jobs.js';
import { silentLogger } from '../../bridge/src/log.js';
import { buildInstructions } from '../../bridge/src/mcp.js';
import { PersistStore } from '../../bridge/src/persist.js';
import { parseFrame, type AnyFrame } from '../../bridge/src/protocol.js';
import { compactJson, shrinkToBudget, takeWithinBudget } from '../../bridge/src/result.js';
import { startBridgeServer, type BridgeServer } from '../../bridge/src/server.js';
import { SessionRegistry, type HubSession } from '../../bridge/src/session.js';
import { parseSkillHeader, renderSkillFile, SkillStore } from '../../bridge/src/skills.js';
import { cloudIdsOf, createLocalExecutor, geometryPolicyFor, TOOL_NAMES, TOOL_SPECS, type CaptureApi, type ToolExecutor } from '../../bridge/src/tools.js';
import type { VisionEvent } from '../../bridge/src/vision/index.js';

const SESSION = 'ab12ab12-0000-4000-8000-0000000000ff';

interface TextResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

function payload(result: TextResult): Record<string, unknown> {
  const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('result formatting', () => {
  it('prints compact-pretty JSON and truncates arrays with a flag when over budget', () => {
    expect(compactJson({ a: [1, 2, 3], b: { c: 'x' } })).toBe('{\n "a":[1,2,3],\n "b":{"c":"x"}\n}');
    const big = { items: Array.from({ length: 5000 }, (_, i) => ({ i, name: `part-${i}`, pos: [i, 0, 0] })), note: 'ok' };
    const { text, truncated } = shrinkToBudget(big, 20_000);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(20_000);
    const parsed = JSON.parse(text) as { items: unknown[]; truncated: boolean; note: string };
    expect(parsed.truncated).toBe(true);
    expect(parsed.items.length).toBeLessThan(5000);
    expect(parsed.note).toBe('ok');
    expect(shrinkToBudget({ s: 'y'.repeat(100_000) }, 5000).text).toMatch(/…\[\+\d+ chars\]/);
  });

  it('keeps tool descriptions and server instructions under Claude Code limits', () => {
    for (const spec of TOOL_SPECS) expect(Buffer.byteLength(spec.description), spec.name).toBeLessThan(2048);
    expect(Buffer.byteLength(buildInstructions(47800))).toBeLessThanOrEqual(2048);
    expect(buildInstructions(47800)).toMatch(/`look \{question\}`/);
    expect(buildInstructions(47800)).toMatch(/`cloud`/);
    expect(TOOL_SPECS.map((s) => s.name)).toEqual([...TOOL_NAMES]);
    expect([...TOOL_NAMES]).toEqual(['run', 'observe', 'playtest', 'input', 'events', 'skills', 'job', 'cloud', 'look']);
    // `job cancel` rolls back an edit-DM recording, so the whole tool must not be marked read-only; `look` only reads.
    expect(TOOL_SPECS.filter((s) => s.annotations.readOnlyHint).map((s) => s.name)).toEqual(['observe', 'events', 'look']);
    // The sidecars reach out of the machine (Open Cloud, the Claude API); nothing else does.
    expect(TOOL_SPECS.filter((s) => s.annotations.openWorldHint).map((s) => s.name)).toEqual(['cloud', 'look']);
  });

  it('defaults cloud ids from the session without inventing zeros', () => {
    expect(cloudIdsOf(null)).toBeNull();
    const session = { studio: { placeId: 5, placeName: 'PIRATES' } } as unknown as HubSession;
    expect(cloudIdsOf(session)).toEqual({ placeId: 5, placeName: 'PIRATES' });
    const full = { studio: { placeId: 5, placeName: 'PIRATES', universeId: 42, creatorType: 'Group', creatorId: 7 } } as unknown as HubSession;
    expect(cloudIdsOf(full)).toEqual({ placeId: 5, placeName: 'PIRATES', universeId: 42, creatorType: 'Group', creatorId: 7 });
    const odd = { studio: { placeId: 5, creatorType: 'Alien', creatorId: 7 } } as unknown as HubSession;
    expect(cloudIdsOf(odd)).toEqual({ placeId: 5, creatorId: 7 });
  });

  it('resolves the geometry policy per dm and parses the STUDIO_LIVE_GEOMETRY_POLICY default', () => {
    // Edit DM: the explicit argument, else the bridge default. Play DMs: only an explicit argument (ephemeral parts).
    expect(geometryPolicyFor(undefined, undefined, 'warn')).toBe('warn');
    expect(geometryPolicyFor('edit', undefined, 'reject')).toBe('reject');
    expect(geometryPolicyFor('edit', 'off', 'reject')).toBe('off');
    expect(geometryPolicyFor('server', undefined, 'warn')).toBeUndefined();
    expect(geometryPolicyFor('client:2', undefined, 'reject')).toBeUndefined();
    expect(geometryPolicyFor('client', 'warn', 'off')).toBe('warn');
    expect(parseGeometryPolicy(undefined)).toBe('warn');
    expect(parseGeometryPolicy('')).toBe('warn');
    expect(parseGeometryPolicy(' Reject ')).toBe('reject');
    expect(parseGeometryPolicy('OFF')).toBe('off');
    expect(() => parseGeometryPolicy('strict')).toThrow(/STUDIO_LIVE_GEOMETRY_POLICY must be one of warn \| reject \| off/);
    expect(loadConfig({ STUDIO_LIVE_HOME: os.tmpdir(), STUDIO_LIVE_GEOMETRY_POLICY: 'off' }).geometryPolicy).toBe('off');
    expect(loadConfig({ STUDIO_LIVE_HOME: os.tmpdir() }).geometryPolicy).toBe('warn');
    expect(() => loadConfig({ STUDIO_LIVE_HOME: os.tmpdir(), STUDIO_LIVE_GEOMETRY_POLICY: 'maybe' })).toThrow(/STUDIO_LIVE_GEOMETRY_POLICY/);
    // The server instructions and the run tool say where the report lands and how to make it fatal.
    expect(buildInstructions(47800)).toMatch(/run\.geometry/);
    expect(buildInstructions(47800)).toMatch(/geometry_policy 'reject'/);
    const run = TOOL_SPECS.find((s) => s.name === 'run')!;
    expect(run.description).toMatch(/geometry_violation/);
    expect(Object.keys(run.inputSchema)).toContain('geometry_policy');
    expect(Object.keys(TOOL_SPECS.find((s) => s.name === 'skills')!.inputSchema)).toContain('geometry_policy');
    const observe = TOOL_SPECS.find((s) => s.name === 'observe')!;
    expect(observe.description).toMatch(/- geometry:/);
    expect(Object.keys(observe.inputSchema)).toEqual(expect.arrayContaining(['tolerance', 'include_nested']));
  });

  it('marks cut arrays inside objects and keeps cursored lists honest', () => {
    const items = Array.from({ length: 700 }, (_, i) => ({ seq: i + 1, msg: 'x'.repeat(200) }));
    const { text } = shrinkToBudget({ items, next: 700 }, 30_000);
    const parsed = JSON.parse(text) as { items: unknown[]; truncated: boolean };
    expect(parsed.truncated).toBe(true);
    expect(parsed.items[parsed.items.length - 1]).toMatch(/^…\[\+\d+ more\]$/);
    const fit = takeWithinBudget(items, 5_000);
    expect(fit.truncated).toBe(true);
    expect(fit.kept.length).toBeGreaterThan(0);
    expect(fit.kept.length).toBeLessThan(items.length);
    expect(takeWithinBudget(items.slice(0, 3), 5_000)).toEqual({ kept: items.slice(0, 3), truncated: false });
  });
});

describe('skill files', () => {
  it('round-trips the header block', () => {
    const file = renderSkillFile({ name: 'arena', description: 'builds\nan arena', params: { size: 10 } }, 'return S.part{}');
    expect(file.startsWith('--[[ studio-live skill\nname: arena\ndescription: builds an arena\nparams: {"size":10}\n]]\n')).toBe(true);
    const parsed = parseSkillHeader(file);
    expect(parsed?.meta).toEqual({ name: 'arena', description: 'builds an arena', params: { size: 10 } });
    expect(parsed?.body).toBe('return S.part{}\n');
    expect(parseSkillHeader('print(1)')).toBeNull();
  });
});

describe('local tool executor', () => {
  let dir: string;
  let port: number;
  let server: BridgeServer;
  let registry: SessionRegistry;
  let fanout: EventFanout;
  let jobs: JobStore;
  let executor: ToolExecutor;
  let hub: WebSocket | null = null;
  const captureCalls: unknown[] = [];
  let captureImpl: CaptureApi['captureStudio'] = async (opts) => {
    captureCalls.push(opts);
    return {
      path: 'C:\\frames\\f1.jpg',
      width: 1024,
      height: 640,
      bytes: 3,
      mimeType: 'image/jpeg',
      windowTitle: 'Place1 - Roblox Studio',
      hwnd: '4242',
      captured_ms: 31,
      base64: 'AAAA',
      sourceWidth: 1734,
      sourceHeight: 1084,
      scale: 1.693,
    };
  };

  const localEvents: VisionEvent[] = [];
  const frames: AnyFrame[] = [];
  const nextFrame = (pred: (f: AnyFrame) => boolean, timeoutMs = 3000): Promise<AnyFrame> =>
    new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = (): void => {
        const index = frames.findIndex(pred);
        if (index >= 0) return resolve(frames.splice(index, 1)[0]!);
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for hub frame'));
        setTimeout(tick, 5);
      };
      tick();
    });

  const connectHub = async (): Promise<void> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.on('message', (data) => {
      const frame = parseFrame(data.toString());
      if (frame) frames.push(frame);
    });
    ws.send(JSON.stringify({ v: 1, kind: 'hello', proto: 1, bootstrap: '1.0.0', role: 'edit', session: SESSION, studio: { placeId: 77, placeName: 'Test' }, lastSeq: 0 }));
    await nextFrame((f) => f.kind === 'hello_ack');
    // Every hello is followed by the bridge's persist_sync (bridge-side persisted controllers); the hub answers it.
    const sync = await nextFrame((f) => f.kind === 'req' && f.op === 'persist_sync');
    expect(sync).toMatchObject({ dm: 'edit', deadline_ms: 30_000, body: { controllers: [] } });
    ws.send(JSON.stringify({ v: 1, kind: 'res', id: sync.id, ok: true, dm: 'edit', body: { persisted: 0, rejected: 0, installs_issued: 0 } }));
    hub = ws;
  };

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-live-skills-'));
    jobs = new JobStore();
    registry = new SessionRegistry({
      bundle: { current: { hash: 'h', entry: 'runtime/init', modules: {} } },
      jobs,
      log: silentLogger,
      bridgeVersion: 'test',
      requestGraceMs: 200,
      persist: new PersistStore(path.join(dir, 'persist'), silentLogger),
    });
    fanout = new EventFanout({ registry, log: silentLogger, heartbeatMs: 60_000 });
    executor = createLocalExecutor({
      registry,
      jobs,
      skills: new SkillStore(dir, path.join(PACKAGE_ROOT, 'skills', 'builtin')),
      capture: {
        captureStudio: (opts) => captureImpl(opts),
        listStudioWindows: async () => [{ hwnd: '4242', pid: 1, title: 'Place1 - Roblox Studio', x: 0, y: 0, width: 1734, height: 1084, minimized: false, foreground: true }],
      },
      log: silentLogger,
      bridge: { version: 'test', port: 0, bootstrapVersion: '1.0.0' },
      home: dir,
      localEvents: (event) => {
        localEvents.push(event);
      },
    });
    const started = await startBridgeServer({ port: 0, registry, fanout, executor, status: () => ({ name: 'studio-live' }), log: silentLogger });
    if (started.mode !== 'primary') throw new Error('expected primary');
    server = started.server;
    port = server.port;
  });

  afterAll(async () => {
    hub?.close();
    fanout.close();
    registry.close();
    await server.close();
    jobs.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    frames.length = 0;
  });

  it('rejects unknown tools and invalid arguments without touching Studio', async () => {
    const unknown = payload((await executor.call('nope', {})) as TextResult);
    expect(unknown).toMatchObject({ error: { code: 'bad_request' } });
    const invalid = (await executor.call('run', { code: 'x', dm: 'client:0' })) as TextResult;
    expect(invalid.isError).toBe(true);
    expect(payload(invalid)).toMatchObject({ error: { code: 'bad_request', issues: [expect.stringMatching(/^dm:/)] } });
    const missing = payload((await executor.call('playtest', { action: 'install', name: 'walker' })) as TextResult);
    expect(missing).toMatchObject({ error: { code: 'bad_request', message: 'code (or code_file) is required' } });
  });

  it('reports no_session when Studio is not connected', async () => {
    const result = payload((await executor.call('run', { code: 'return 1' })) as TextResult);
    expect(result).toMatchObject({ error: { code: 'no_session' } });
    const events = payload((await executor.call('events', {})) as TextResult);
    expect(events).toMatchObject({ error: { code: 'no_session' } });
  });

  it('takes screenshots through the capture module and never sends them to Studio', async () => {
    const result = (await executor.call('observe', { what: 'screenshot', max_width: 512, format: 'png', quality: 50 })) as TextResult;
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' });
    expect(payload(result)).toEqual({
      path: 'C:\\frames\\f1.jpg',
      width: 1024,
      height: 640,
      source_width: 1734,
      source_height: 1084,
      scale: 1.693,
      bytes: 3,
      windowTitle: 'Place1 - Roblox Studio',
      hwnd: '4242',
      captured_ms: 31,
    });
    expect(captureCalls).toEqual([{ maxWidth: 512, format: 'png', quality: 50 }]);

    // Window pinning and "no scaling" reach the capture backend; a bad handle is refused up front.
    await executor.call('observe', { what: 'screenshot', hwnd: '4242', title_match: 'Place1', max_width: 0 });
    expect(captureCalls[1]).toEqual({ maxWidth: 0, hwnd: '4242', titleMatch: 'Place1' });
    expect(payload((await executor.call('observe', { what: 'screenshot', max_width: 10 })) as TextResult)).toMatchObject({ error: { code: 'bad_request' } });
    expect(payload((await executor.call('observe', { what: 'screenshot', hwnd: 'abc' })) as TextResult)).toMatchObject({ error: { code: 'bad_request' } });
    expect(payload((await executor.call('observe', { what: 'windows' })) as TextResult)).toEqual({
      windows: [{ hwnd: '4242', pid: 1, title: 'Place1 - Roblox Studio', x: 0, y: 0, width: 1734, height: 1084, minimized: false, foreground: true }],
    });

    captureImpl = async () => {
      throw Object.assign(new Error('Studio window not found'), { code: 'no_window' });
    };
    const failed = payload((await executor.call('observe', { what: 'screenshot' })) as TextResult);
    expect(failed).toMatchObject({ error: { code: 'no_window', message: 'Studio window not found' } });
  });

  it('serves cloud and look through the executor like every other tool', async () => {
    // cloud: no key in a fresh home → no_api_key names the three locations; bad arguments never reach the key lookup.
    const noKey = (await executor.call('cloud', { action: 'info', what: 'universe' })) as TextResult;
    expect(noKey.isError).toBe(true);
    expect(payload(noKey)).toMatchObject({ error: { code: 'no_api_key', message: expect.stringContaining(path.join(dir, 'opencloud.json')) } });
    expect(payload((await executor.call('cloud', { action: 'nope' })) as TextResult)).toMatchObject({ error: { code: 'bad_request' } });
    // A key present but no Studio connected → the id defaulting explains itself (nothing is sent).
    await fsp.writeFile(path.join(dir, 'opencloud.key'), 'test-key-never-sent\n', 'utf8');
    try {
      const noIds = payload((await executor.call('cloud', { action: 'info', what: 'universe' })) as TextResult);
      expect(noIds).toMatchObject({ error: { code: 'no_ids', message: expect.stringMatching(/no Studio session is connected/) } });
    } finally {
      await fsp.rm(path.join(dir, 'opencloud.key'), { force: true });
    }
    // look: list / stop / argument validation work without a credential or a capture.
    expect(payload((await executor.call('look', { list: true })) as TextResult)).toEqual({ watches: [] });
    expect(payload((await executor.call('look', { stop: 'w-404' })) as TextResult)).toMatchObject({ error: { code: 'not_found' } });
    expect(payload((await executor.call('look', {})) as TextResult)).toMatchObject({ error: { code: 'bad_request' } });
    expect(payload((await executor.call('look', { question: 'x', max_width: 8 })) as TextResult)).toMatchObject({ error: { code: 'bad_request' } });
    // A one-shot look captures through the same capture backend (768 px JPEG) before anything else happens.
    captureCalls.length = 0;
    captureImpl = async (opts) => {
      captureCalls.push(opts);
      throw Object.assign(new Error('Studio window not found'), { code: 'no_window' });
    };
    expect(payload((await executor.call('look', { question: 'what is visible?', region: { x: 1, y: 2, w: 3, h: 4 } })) as TextResult)).toMatchObject({ error: { code: 'no_window' } });
    expect(captureCalls).toEqual([{ maxWidth: 768, format: 'jpeg', region: { x: 1, y: 2, w: 3, h: 4 } }]);
    expect(localEvents).toEqual([]);
  });

  it('caps input holds and refuses a job_id-less status', async () => {
    const tooLong = payload((await executor.call('input', { actions: [{ type: 'key', key: 'W', hold_ms: 2_147_483_648 }] })) as TextResult);
    expect(tooLong).toMatchObject({ error: { code: 'bad_request', issues: [expect.stringMatching(/hold_ms/)] } });
    expect(payload((await executor.call('job', { action: 'status' })) as TextResult)).toMatchObject({ error: { code: 'bad_request', message: 'job_id is required' } });
    expect(payload((await executor.call('job', { action: 'list' })) as TextResult)).toEqual({ jobs: [] });
  });

  it('runs programs, returns job handles for slow work and resolves them through job', async () => {
    await connectHub();
    const running = executor.call('run', { code: 'return 42', dm: 'server', timeout_ms: 5000, wait_ms: 50 });
    const req = await nextFrame((f) => f.kind === 'req');
    expect(req).toMatchObject({ op: 'run', dm: 'server', deadline_ms: 5000, body: { code: 'return 42', timeout_ms: 5000 } });
    const handle = payload((await running) as TextResult);
    expect(handle).toMatchObject({ job_id: req.id, status: 'running', op: 'run', dm: 'server' });

    hub!.send(JSON.stringify({ v: 1, kind: 'progress', id: req.id, note: 'placing', pct: 0.4 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = payload((await executor.call('job', { action: 'status', job_id: req.id })) as TextResult);
    expect(status).toMatchObject({ job_id: req.id, status: 'running', origin: 'stdio', hub_connected: true, progress: { note: 'placing', pct: 0.4 } });
    const listed = payload((await executor.call('job', { action: 'list' })) as TextResult) as { jobs: Array<Record<string, unknown>> };
    expect(listed.jobs[0]).toMatchObject({ job_id: req.id, status: 'running', op: 'run', dm: 'server', progress: { note: 'placing' } });

    const waiting = executor.call('job', { action: 'wait', job_id: req.id, wait_ms: 5000 });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req.id, ok: true, dm: 'server', body: { value: 42, output: [], duration_ms: 1, undo: 'n/a', ephemeral: true } }));
    const done = payload((await waiting) as TextResult);
    expect(done).toMatchObject({ status: 'done', result: { value: 42, ephemeral: true }, responder: 'server' });

    // A call made through /rpc tags its job so shutdown can wait for it.
    const viaRpc = executor.call('run', { code: 'return 7', wait_ms: 50 }, { origin: 'rpc' });
    const rpcReq = await nextFrame((f) => f.kind === 'req');
    expect(jobs.get(rpcReq.id as string)?.origin).toBe('rpc');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: rpcReq.id, ok: true, dm: 'edit', body: { value: 7 } }));
    await viaRpc;

    const fast = executor.call('run', { code: 'return 1' });
    const req2 = await nextFrame((f) => f.kind === 'req');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req2.id, ok: true, dm: 'edit', body: { value: 1, undo: 'committed' } }));
    expect(payload((await fast) as TextResult)).toEqual({ value: 1, undo: 'committed', dm: 'edit' });

    const failing = executor.call('run', { code: 'error()' });
    const req3 = await nextFrame((f) => f.kind === 'req');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req3.id, ok: false, dm: 'edit', error: { code: 'luau_error', message: 'boom', stack: 'st', output: [] } }));
    const errored = (await failing) as TextResult;
    expect(errored.isError).toBe(true);
    expect(payload(errored)).toMatchObject({ error: { code: 'luau_error', message: 'boom', stack: 'st', dm: 'edit', job_id: req3.id } });

    const cancelling = executor.call('job', { action: 'cancel', job_id: 'r-does-not-exist' });
    expect(payload((await cancelling) as TextResult)).toMatchObject({ error: { code: 'not_found' } });
  });

  it('routes observe, playtest, input and events with the protocol ops', async () => {
    const observe = executor.call('observe', { what: 'tree', root: 'Workspace', depth: 3, dm: 'client' });
    const req = await nextFrame((f) => f.kind === 'req');
    expect(req).toMatchObject({ op: 'observe', dm: 'client', body: { what: 'tree', root: 'Workspace', depth: 3, dm: 'client' } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req.id, ok: true, dm: 'client:1', body: { nodes: [], truncated: false } }));
    expect(payload((await observe) as TextResult)).toEqual({ nodes: [], truncated: false, dm: 'client:1' });

    const status = executor.call('observe', { what: 'status' });
    const req1 = await nextFrame((f) => f.kind === 'req');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req1.id, ok: true, body: { role: 'edit', capabilities: { loadstring: true, virtualInput: false, capture: false } } }));
    expect(payload((await status) as TextResult)).toMatchObject({
      role: 'edit',
      capabilities: { loadstring: true, capture: process.platform === 'win32' },
      bridge: { version: 'test', events_url: 'ws://127.0.0.1:0/events', bootstrap: { shipped: '1.0.0', installed: '1.0.0', outdated: false } },
    });

    const untilCall = executor.call('playtest', { action: 'run_until', dm: 'server', predicate: 'return #game.Players:GetPlayers() > 0', timeout_ms: 1000 });
    const req2 = await nextFrame((f) => f.kind === 'req');
    expect(req2).toMatchObject({ op: 'playtest', dm: 'server', deadline_ms: 6000, body: { action: 'run_until', predicate: 'return #game.Players:GetPlayers() > 0', timeout_ms: 1000 } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req2.id, ok: true, dm: 'server', body: { result: true, checks: 3 } }));
    expect(payload((await untilCall) as TextResult)).toMatchObject({ result: true, checks: 3 });

    const wrongDm = payload((await executor.call('input', { actions: [{ type: 'wait', ms: 10 }], dm: 'server' })) as TextResult);
    expect(wrongDm).toMatchObject({ error: { code: 'bad_request' } });
    const input = executor.call('input', { actions: [{ type: 'key', key: 'W', hold_ms: 600 }, { type: 'click', x: 1, y: 2 }] });
    const req3 = await nextFrame((f) => f.kind === 'req');
    expect(req3).toMatchObject({ op: 'input', dm: 'client', body: { dm: 'client', actions: [{ type: 'key', key: 'W', hold_ms: 600 }, { type: 'click', x: 1, y: 2 }] } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req3.id, ok: true, dm: 'client:1', body: { steps: [{ i: 0, ok: true }, { i: 1, ok: true }], elapsed_ms: 700 } }));
    expect(payload((await input) as TextResult)).toMatchObject({ steps: [{ i: 0, ok: true }, { i: 1, ok: true }], dm: 'client:1' });

    hub!.send(JSON.stringify({ v: 1, kind: 'ev', seq: 1, t: 1, wall: 1, src: 'server', type: 'assert', name: 'a', ok: true }));
    hub!.send(JSON.stringify({ v: 1, kind: 'ev', seq: 2, t: 1, wall: 1, src: 'server', type: 'log', level: 'print', msg: 'p' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const events = payload((await executor.call('events', { since: 0, kinds: ['assert'] })) as TextResult);
    expect(events).toMatchObject({ session: SESSION, cursor: 2, latest_seq: 2, dropped: 0, events: [{ seq: 1, type: 'assert' }] });
    expect(frames.filter((f) => f.kind === 'req')).toEqual([]);

    // A page too big for one result is cut by the events tool itself: the cursor stops at the last event returned.
    for (let seq = 3; seq <= 400; seq += 1) {
      hub!.send(JSON.stringify({ v: 1, kind: 'ev', seq, t: 1, wall: 1, src: 'server', type: 'log', level: 'print', msg: 'm'.repeat(400) }));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const page = payload((await executor.call('events', { since: 2, kinds: ['log'] })) as TextResult) as { cursor: number; truncated: boolean; events: Array<{ seq: number }> };
    expect(page.truncated).toBe(true);
    expect(page.events.length).toBeGreaterThan(10);
    expect(page.events.length).toBeLessThan(398);
    expect(page.cursor).toBe(page.events[page.events.length - 1]!.seq);
    const rest = payload((await executor.call('events', { since: page.cursor, kinds: ['log'] })) as TextResult) as { events: Array<{ seq: number }> };
    expect(rest.events[0]?.seq).toBe(page.cursor + 1);

    // observe logs: the hub's `next` is pulled back to the last item that fits.
    const logsCall = executor.call('observe', { what: 'logs' });
    const logsReq = await nextFrame((f) => f.kind === 'req');
    const items = Array.from({ length: 600 }, (_, i) => ({ seq: i + 1, t: 1, level: 'print', msg: 'l'.repeat(300), src: 'edit' }));
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: logsReq.id, ok: true, dm: 'edit', body: { items, next: 600 } }));
    const logs = payload((await logsCall) as TextResult) as { items: Array<{ seq: number }>; next: number; truncated: boolean };
    expect(logs.truncated).toBe(true);
    expect(logs.items.length).toBeLessThan(600);
    expect(logs.next).toBe(logs.items[logs.items.length - 1]!.seq);
  });

  it('requires session for writes while two Studios are connected and hints on reads', async () => {
    const otherId = 'ab12ab12-0000-4000-8000-000000000002';
    const other = new WebSocket(`ws://127.0.0.1:${port}/studio`);
    await new Promise<void>((resolve, reject) => {
      other.once('open', () => resolve());
      other.once('error', reject);
    });
    const otherFrames: AnyFrame[] = [];
    other.on('message', (data) => {
      const frame = parseFrame(data.toString());
      if (frame) otherFrames.push(frame);
    });
    other.send(JSON.stringify({ v: 1, kind: 'hello', proto: 1, bootstrap: '1.0.0', role: 'edit', session: otherId, studio: { placeName: 'Scratch' }, lastSeq: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The other hub's persist_sync is not a tool request.
    otherFrames.splice(0, otherFrames.length, ...otherFrames.filter((f) => !(f.kind === 'req' && f.op === 'persist_sync')));
    try {
      const refused = payload((await executor.call('run', { code: 'return 1' })) as TextResult);
      expect(refused).toMatchObject({ error: { code: 'bad_request', message: expect.stringMatching(/several Studio sessions/), sessions: [{ session: SESSION }, { session: otherId, place: 'Scratch' }] } });
      expect(frames.filter((f) => f.kind === 'req')).toEqual([]);

      const read = executor.call('events', { since: 10_000 });
      expect(payload((await read) as TextResult)).toMatchObject({ session: SESSION, session_note: expect.stringMatching(/2 Studio sessions/) });

      const named = executor.call('run', { code: 'return 1', session: 'ab12ab12-0000-4000-8000-000000000002' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const req = otherFrames.find((f) => f.kind === 'req');
      expect(req).toBeDefined();
      other.send(JSON.stringify({ v: 1, kind: 'res', id: req!.id, ok: true, dm: 'edit', body: { value: 1 } }));
      expect(payload((await named) as TextResult)).toEqual({ value: 1, dm: 'edit' });
      expect(registry.active?.id).toBe(otherId);
    } finally {
      other.close();
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(registry.active?.id).toBe(SESSION);
  });

  it('stores skills on disk and runs them as run programs', async () => {
    const saved = payload((await executor.call('skills', { action: 'save', name: 'arena', source: 'return S.part{}', description: 'arena', params: { size: 1 } })) as TextResult);
    expect(saved).toMatchObject({ name: 'arena', replaced: false, path: path.join(dir, 'arena.luau') });
    expect(payload((await executor.call('skills', { action: 'save', name: 'arena', source: 'return 2' })) as TextResult)).toMatchObject({ replaced: true });
    const listed = payload((await executor.call('skills', { action: 'list' })) as TextResult) as { skills: Array<{ name: string; description: string; builtin: boolean }> };
    expect(listed.skills.filter((s) => !s.builtin)).toEqual([expect.objectContaining({ name: 'arena', description: '', builtin: false })]);
    expect(listed.skills.filter((s) => s.builtin).map((s) => s.name)).toContain('settle_physics');
    expect(payload((await executor.call('skills', { action: 'get', name: 'arena' })) as TextResult)).toMatchObject({ name: 'arena', source: 'return 2\n', builtin: false });
    expect(payload((await executor.call('skills', { action: 'save', name: '../evil', source: 'x' })) as TextResult)).toMatchObject({ error: { code: 'bad_request' } });

    const run = executor.call('skills', { action: 'run', name: 'arena', args: { size: 3 } });
    const req = await nextFrame((f) => f.kind === 'req');
    expect(req).toMatchObject({ op: 'run', dm: 'edit', body: { code: 'return 2\n', args: { size: 3 }, undo_label: 'skill: arena' } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req.id, ok: true, dm: 'edit', body: { value: 2 } }));
    expect(payload((await run) as TextResult)).toEqual({ value: 2, dm: 'edit', skill: 'arena', builtin: false });

    expect(payload((await executor.call('skills', { action: 'delete', name: 'arena' })) as TextResult)).toEqual({ name: 'arena', deleted: true });
    expect(payload((await executor.call('skills', { action: 'get', name: 'arena' })) as TextResult)).toMatchObject({ error: { code: 'not_found' } });
  });

  it('serves builtin skills: get/run work, save overrides, delete of a builtin is refused', async () => {
    const got = payload((await executor.call('skills', { action: 'get', name: 'remote_map' })) as TextResult) as { builtin: boolean; source: string; params: Record<string, unknown> };
    expect(got.builtin).toBe(true);
    expect(got.source).toContain('S.find');
    expect(got.params).toMatchObject({ root: expect.anything() });

    const run = executor.call('skills', { action: 'run', name: 'remote_map', args: { max: 5 }, dm: 'server' });
    const req = await nextFrame((f) => f.kind === 'req');
    expect(req).toMatchObject({ op: 'run', dm: 'server', body: { code: got.source, args: { max: 5 }, undo_label: 'skill: remote_map' } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req.id, ok: true, dm: 'server', body: { value: { count: 0 } } }));
    expect(payload((await run) as TextResult)).toEqual({ value: { count: 0 }, dm: 'server', skill: 'remote_map', builtin: true });

    expect(payload((await executor.call('skills', { action: 'delete', name: 'remote_map' })) as TextResult)).toMatchObject({ error: { code: 'bad_request', message: expect.stringMatching(/builtin/) } });
    expect(payload((await executor.call('skills', { action: 'save', name: 'remote_map', source: 'return 0' })) as TextResult)).toMatchObject({ replaced: false, overrides_builtin: true });
    expect(payload((await executor.call('skills', { action: 'get', name: 'remote_map' })) as TextResult)).toMatchObject({ builtin: false, source: 'return 0\n' });
    expect(payload((await executor.call('skills', { action: 'delete', name: 'remote_map' })) as TextResult)).toEqual({ name: 'remote_map', deleted: true, builtin_visible: true });
    expect(payload((await executor.call('skills', { action: 'get', name: 'remote_map' })) as TextResult)).toMatchObject({ builtin: true });
  });

  it('sends multiplayer start, add_players and push with their hub ops and fills the defaults', async () => {
    const start = executor.call('playtest', { action: 'start', mode: 'multiplayer', players: 3 });
    const req = await nextFrame((f) => f.kind === 'req');
    expect(req).toMatchObject({ op: 'playtest', dm: 'edit', deadline_ms: 120_000, body: { action: 'start', mode: 'multiplayer', players: 3 } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req.id, ok: true, dm: 'edit', body: { running: true, peers: [], started_ms: 9000 } }));
    expect(payload((await start) as TextResult)).toEqual({ running: true, mode: 'multiplayer', players: 3, peers: [], started_ms: 9000, dm: 'edit' });

    // multiplayer without players sends the default; play mode sends no players and keeps the 30 s deadline.
    const defaulted = executor.call('playtest', { action: 'start', mode: 'multiplayer' });
    const req1 = await nextFrame((f) => f.kind === 'req');
    expect(req1).toMatchObject({ body: { mode: 'multiplayer', players: 2 } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req1.id, ok: true, dm: 'edit', body: { running: true, mode: 'multiplayer', players: 2 } }));
    await defaulted;
    const plain = executor.call('playtest', { action: 'start' });
    const req2 = await nextFrame((f) => f.kind === 'req');
    expect(req2).toMatchObject({ deadline_ms: 30_000, body: { action: 'start', mode: 'play' } });
    expect((req2.body as Record<string, unknown>).players).toBeUndefined();
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req2.id, ok: true, dm: 'edit', body: { running: true, mode: 'play' } }));
    expect(payload((await plain) as TextResult)).toMatchObject({ running: true, mode: 'play' });
    expect(payload((await executor.call('playtest', { action: 'start', players: 2 })) as TextResult)).toMatchObject({ error: { code: 'bad_request' } });
    expect(payload((await executor.call('playtest', { action: 'start', mode: 'multiplayer', players: 9 })) as TextResult)).toMatchObject({ error: { code: 'bad_request' } });

    const add = executor.call('playtest', { action: 'add_players' });
    const req3 = await nextFrame((f) => f.kind === 'req');
    expect(req3).toMatchObject({ op: 'playtest', dm: 'edit', deadline_ms: 120_000, body: { action: 'add_players', count: 1 } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req3.id, ok: true, dm: 'edit', body: { added: 1, peers: [] } }));
    expect(payload((await add) as TextResult)).toMatchObject({ added: 1 });
    const addMany = executor.call('playtest', { action: 'add_players', count: 4 });
    const req3b = await nextFrame((f) => f.kind === 'req');
    expect(req3b).toMatchObject({ body: { action: 'add_players', count: 4 } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req3b.id, ok: true, dm: 'edit', body: { added: 4 } }));
    await addMany;

    // push is its own op, always addressed to the hub (req.dm edit) with the destination inside the body.
    const push = executor.call('playtest', { action: 'push', paths: ['Workspace.Arena'], dm: 'client:1', parent: 'Workspace.Live', timeout_ms: 10_000 });
    const req4 = await nextFrame((f) => f.kind === 'req');
    expect(req4).toMatchObject({ op: 'push', dm: 'edit', deadline_ms: 10_000, body: { paths: ['Workspace.Arena'], dm: 'client:1', parent: 'Workspace.Live', timeout_ms: 10_000 } });
    // The hub's dispatcher answers on frame dm 'edit' with the destination inside the body (runtime Notes).
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req4.id, ok: true, dm: 'edit', body: { dm: 'client:1', paths: ['Workspace.Live.Arena'], count: 1, bytes: 3900, replicated: false } }));
    expect(payload((await push) as TextResult)).toEqual({ dm: 'client:1', paths: ['Workspace.Live.Arena'], count: 1, bytes: 3900, replicated: false, replace: true, parent: 'Workspace.Live' });

    // Without parent each root lands at its own edit-DM path: the bridge invents no default, `paths` tell.
    const pushDefaults = executor.call('playtest', { action: 'push', paths: ['Workspace.Arena'] });
    const req5 = await nextFrame((f) => f.kind === 'req');
    expect(req5).toMatchObject({ op: 'push', dm: 'edit', deadline_ms: 30_000, body: { paths: ['Workspace.Arena'], dm: 'server' } });
    expect((req5.body as Record<string, unknown>).parent).toBeUndefined();
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req5.id, ok: true, dm: 'edit', body: { paths: ['Workspace.Arena'], count: 1, replicated: true } }));
    expect(payload((await pushDefaults) as TextResult)).toEqual({ paths: ['Workspace.Arena'], count: 1, replicated: true, dm: 'server', replace: true });
    expect(payload((await executor.call('playtest', { action: 'push' })) as TextResult)).toMatchObject({ error: { code: 'bad_request', message: 'paths is required' } });
    expect(payload((await executor.call('playtest', { action: 'push', paths: ['Workspace'], dm: 'edit' })) as TextResult)).toMatchObject({ error: { code: 'bad_request' } });
    expect(frames.filter((f) => f.kind === 'req')).toEqual([]);

    // list repeats the persistence semantics so the agent never has to guess them.
    const list = executor.call('playtest', { action: 'list' });
    const req6 = await nextFrame((f) => f.kind === 'req');
    expect(req6).toMatchObject({ op: 'playtest', body: { action: 'list' } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req6.id, ok: true, dm: 'edit', body: { controllers: [{ dm: 'client:1', name: 'walker', persist: true }] } }));
    expect(payload((await list) as TextResult)).toMatchObject({ controllers: [{ name: 'walker', persist: true }], persisted: [], persistence: expect.stringMatching(/runtime restarts/) });

    // push replace: sent as true by default, echoed in the result; false is passed through.
    const replaced = executor.call('playtest', { action: 'push', paths: ['Workspace.PushProbe'] });
    const req7 = await nextFrame((f) => f.kind === 'req');
    expect(req7).toMatchObject({ op: 'push', body: { paths: ['Workspace.PushProbe'], dm: 'server', replace: true } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req7.id, ok: true, dm: 'edit', body: { dm: 'server', paths: ['Workspace.PushProbe'], count: 1, replaced: 1, replicated: true } }));
    expect(payload((await replaced) as TextResult)).toMatchObject({ replaced: 1, replace: true, dm: 'server' });
    const kept = executor.call('playtest', { action: 'push', paths: ['Workspace.PushProbe'], replace: false });
    const req8 = await nextFrame((f) => f.kind === 'req');
    expect(req8).toMatchObject({ body: { replace: false } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req8.id, ok: true, dm: 'edit', body: { dm: 'server', paths: ['Workspace.PushProbe'], count: 1, replaced: 0 } }));
    expect(payload((await kept) as TextResult)).toMatchObject({ replaced: 0, replace: false });
  });

  it('keeps persisted controllers in the bridge store and syncs the hub with persist_sync', async () => {
    const file = path.join(dir, 'persist', '77.json');
    // install persist=true: stored once the hub acknowledged, then persist_sync carries the whole list.
    const install = executor.call('playtest', { action: 'install', dm: 'client', name: 'walker', code: 'return {}', persist: true });
    const req = await nextFrame((f) => f.kind === 'req');
    expect(req).toMatchObject({ op: 'playtest', dm: 'client', body: { action: 'install', dm: 'client', name: 'walker', code: 'return {}', persist: true } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req.id, ok: true, dm: 'client:1', body: { installed: 'walker', replaced: false, persist: true } }));
    const sync = await nextFrame((f) => f.kind === 'req' && f.op === 'persist_sync');
    expect(sync).toMatchObject({ dm: 'edit', body: { controllers: [{ dm: 'client:1', name: 'walker', code: 'return {}' }] } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: sync.id, ok: true, dm: 'edit', body: { persisted: 1, rejected: 0, installs_issued: 0 } }));
    expect(payload((await install) as TextResult)).toMatchObject({ installed: 'walker', persist: true, persist_source: 'bridge', persist_file: file, dm: 'client:1' });
    expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toMatchObject({ v: 1, placeId: 77, controllers: [{ dm: 'client:1', name: 'walker', code: 'return {}' }] });
    expect(registry.status()[0]?.persisted).toBe(1);
    expect(jobs.list().some((job) => job.op === 'persist_sync')).toBe(false);

    // list shows the bridge's entries with their source.
    const list = executor.call('playtest', { action: 'list' });
    const req2 = await nextFrame((f) => f.kind === 'req');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req2.id, ok: true, dm: 'edit', body: { controllers: [{ dm: 'client:1', name: 'walker' }] } }));
    expect(payload((await list) as TextResult)).toMatchObject({ persisted: [{ dm: 'client:1', name: 'walker', bytes: 9, persist: true, source: 'bridge' }] });

    // A failed install stores nothing and syncs nothing.
    const failed = executor.call('playtest', { action: 'install', dm: 'server', name: 'broken', code: 'return #"a\nb"', persist: true });
    const req3 = await nextFrame((f) => f.kind === 'req');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req3.id, ok: false, dm: 'server', error: { code: 'syntax_error', message: 'StudioLiveController:1: Malformed string' } }));
    const failedResult = (await failed) as TextResult;
    expect(failedResult.isError).toBe(true);
    expect(payload(failedResult)).toMatchObject({ error: { code: 'syntax_error', hint: expect.stringMatching(/\(code_file\)$/) } });
    expect(frames.filter((f) => f.kind === 'req')).toEqual([]);

    // The latest install decides: the same name without persist drops the entry.
    const plain = executor.call('playtest', { action: 'install', dm: 'client:1', name: 'walker', code: 'return 2' });
    const req4 = await nextFrame((f) => f.kind === 'req');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req4.id, ok: true, dm: 'client:1', body: { installed: 'walker', replaced: true, persist: false } }));
    const sync2 = await nextFrame((f) => f.kind === 'req' && f.op === 'persist_sync');
    expect(sync2).toMatchObject({ body: { controllers: [] } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: sync2.id, ok: true, dm: 'edit', body: { persisted: 0, rejected: 0, installs_issued: 0 } }));
    expect(payload((await plain) as TextResult)).toMatchObject({ installed: 'walker', persist: false, persist_removed: true });
    await expect(fsp.access(file)).rejects.toThrow();

    // uninstall removes the entry even when the hub has nothing live (no_peer / bad_request → ok with a note).
    // The runtime answers a forwarded request for an absent peer from its own dispatcher, i.e. with
    // dm "edit" (protocol.err in hub/init.luau `forward`), so the removal must key on the caller's dm.
    await registry.persist.remember(SESSION, 'server', 'ghost', 'return 1');
    const uninstall = executor.call('playtest', { action: 'uninstall', dm: 'server', name: 'ghost' });
    const req5 = await nextFrame((f) => f.kind === 'req');
    expect(req5).toMatchObject({ body: { action: 'uninstall', name: 'ghost' } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req5.id, ok: false, dm: 'edit', error: { code: 'no_peer', message: "dm 'server' is not connected" } }));
    const sync3 = await nextFrame((f) => f.kind === 'req' && f.op === 'persist_sync');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: sync3.id, ok: true, dm: 'edit', body: { persisted: 0, rejected: 0, installs_issued: 0 } }));
    expect(payload((await uninstall) as TextResult)).toMatchObject({ uninstalled: false, persisted_removed: true, dm: 'server', note: expect.stringMatching(/persisted entry was removed/) });
    expect(await registry.persist.list(SESSION)).toEqual([]);
    // `client` resolves to the lowest client entry when nothing live could resolve it.
    await registry.persist.remember(SESSION, 'client:2', 'ghost', 'return 1');
    const uninstallClient = executor.call('playtest', { action: 'uninstall', dm: 'client', name: 'ghost' });
    const req5b = await nextFrame((f) => f.kind === 'req');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req5b.id, ok: false, dm: 'edit', error: { code: 'no_peer', message: "dm 'client' is not connected" } }));
    const sync3b = await nextFrame((f) => f.kind === 'req' && f.op === 'persist_sync');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: sync3b.id, ok: true, dm: 'edit', body: { persisted: 0, rejected: 0, installs_issued: 0 } }));
    expect(payload((await uninstallClient) as TextResult)).toMatchObject({ uninstalled: false, persisted_removed: true, dm: 'client' });
    expect(await registry.persist.list(SESSION)).toEqual([]);
    // Nothing stored + no peer stays an error.
    const noPeer = executor.call('playtest', { action: 'uninstall', dm: 'client:9', name: 'ghost' });
    const req6 = await nextFrame((f) => f.kind === 'req');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req6.id, ok: false, dm: 'edit', error: { code: 'no_peer', message: 'absent' } }));
    expect(payload((await noPeer) as TextResult)).toMatchObject({ error: { code: 'no_peer' } });

    // An install that outlives wait_ms is still recorded once the hub answers (a job hook, not the
    // tool's return path); the running handle says the bookkeeping is pending.
    const slow = executor.call('playtest', { action: 'install', dm: 'server', name: 'slow', code: 'return 3', persist: true, wait_ms: 0 });
    const req7 = await nextFrame((f) => f.kind === 'req');
    expect(payload((await slow) as TextResult)).toMatchObject({ status: 'running', persist_pending: true });
    expect(await registry.persist.list(SESSION)).toEqual([]);
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req7.id, ok: true, dm: 'server', body: { installed: 'slow', replaced: false, persist: true } }));
    const sync4 = await nextFrame((f) => f.kind === 'req' && f.op === 'persist_sync');
    expect(sync4).toMatchObject({ body: { controllers: [{ dm: 'server', name: 'slow', code: 'return 3' }] } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: sync4.id, ok: true, dm: 'edit', body: { persisted: 1, rejected: 0, installs_issued: 0 } }));
    expect(await registry.persist.list(SESSION)).toEqual([{ dm: 'server', name: 'slow', bytes: 8, persist: true, source: 'bridge' }]);
    expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toMatchObject({ controllers: [{ dm: 'server', name: 'slow', session: SESSION }] });
    await registry.persist.forget(SESSION, 'server', 'slow');
  });

  it('reads programs from files, refuses ambiguous file arguments and hints at the heredoc bug on Malformed string', async () => {
    const file = path.join(dir, 'prog.luau');
    const luau = 'return #"a\\nb" + #("x\\ny"):match("[^\\n]+")\n';
    await fsp.writeFile(file, `\uFEFF${luau}`, 'utf8');
    const run = executor.call('run', { code_file: file, dm: 'server' });
    const req = await nextFrame((f) => f.kind === 'req');
    expect(req).toMatchObject({ op: 'run', dm: 'server', body: { code: luau } });
    expect((req.body as Record<string, unknown>).code_file).toBeUndefined();
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req.id, ok: true, dm: 'server', body: { value: 3 } }));
    expect(payload((await run) as TextResult)).toEqual({ value: 3, dm: 'server' });

    expect(payload((await executor.call('run', { code: 'x', code_file: file })) as TextResult)).toMatchObject({ error: { code: 'bad_request', message: /mutually exclusive/ } });
    expect(payload((await executor.call('run', { code_file: 'prog.luau' })) as TextResult)).toMatchObject({ error: { code: 'bad_request', message: /absolute path/ } });
    expect(payload((await executor.call('run', {})) as TextResult)).toMatchObject({ error: { code: 'bad_request', message: 'code (or code_file) is required' } });
    expect(payload((await executor.call('playtest', { action: 'run_until', dm: 'server', predicate_file: path.join(dir, 'missing.luau') })) as TextResult)).toMatchObject({
      error: { code: 'bad_request', message: /predicate_file not found/ },
    });
    expect(payload((await executor.call('playtest', { action: 'hotpatch', dm: 'server', path: 'ServerScriptService.Main' })) as TextResult)).toMatchObject({ error: { code: 'bad_request', message: 'source (or source_file) is required' } });
    expect(frames.filter((f) => f.kind === 'req')).toEqual([]);

    // hotpatch / skills save from files reach the wire as `source`.
    await fsp.writeFile(path.join(dir, 'src.luau'), 'print("patched")', 'utf8');
    const patch = executor.call('playtest', { action: 'hotpatch', dm: 'server', path: 'ServerScriptService.Main', source_file: path.join(dir, 'src.luau') });
    const req2 = await nextFrame((f) => f.kind === 'req');
    expect(req2).toMatchObject({ body: { action: 'hotpatch', path: 'ServerScriptService.Main', source: 'print("patched")' } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req2.id, ok: true, dm: 'server', body: { patched: 'ServerScriptService.Main' } }));
    await patch;
    expect(payload((await executor.call('skills', { action: 'save', name: 'fromfile', source_file: path.join(dir, 'src.luau') })) as TextResult)).toMatchObject({ name: 'fromfile' });
    expect(payload((await executor.call('skills', { action: 'get', name: 'fromfile' })) as TextResult)).toMatchObject({ source: 'print("patched")\n' });
    await executor.call('skills', { action: 'delete', name: 'fromfile' });

    // A raw newline inside a quoted literal + "Malformed string" → the hint; a Malformed string on clean code → no hint.
    const broken = executor.call('run', { code: 'return #"a\nb"' });
    const req3 = await nextFrame((f) => f.kind === 'req');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req3.id, ok: false, dm: 'edit', error: { code: 'syntax_error', message: 'StudioLiveProgram:1: Malformed string' } }));
    expect(payload((await broken) as TextResult)).toMatchObject({
      error: {
        code: 'syntax_error',
        message: 'StudioLiveProgram:1: Malformed string — your transport turned \\n into a newline — pass code from a file (code_file)',
        hint: 'your transport turned \\n into a newline — pass code from a file (code_file)',
      },
    });
    const clean = executor.call('run', { code: 'return "a' });
    const req4 = await nextFrame((f) => f.kind === 'req');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req4.id, ok: false, dm: 'edit', error: { code: 'syntax_error', message: 'StudioLiveProgram:1: Malformed string' } }));
    const cleanResult = payload((await clean) as TextResult) as { error: Record<string, unknown> };
    expect(cleanResult.error.message).toBe('StudioLiveProgram:1: Malformed string');
    expect(cleanResult.error.hint).toBeUndefined();
    const predicate = executor.call('playtest', { action: 'run_until', dm: 'server', predicate: 'return #"a\nb" > 0', timeout_ms: 500 });
    const req5 = await nextFrame((f) => f.kind === 'req');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req5.id, ok: false, dm: 'server', error: { code: 'syntax_error', message: 'Malformed string' } }));
    expect(payload((await predicate) as TextResult)).toMatchObject({ error: { hint: expect.stringMatching(/\(predicate_file\)$/) } });

    // The program already came from a file: the file holds the raw newline, so the hint names its line
    // instead of telling the agent to pass a file.
    await fsp.writeFile(path.join(dir, 'raw.luau'), 'local ok = "fine"\nreturn #"a\nb"\n', 'utf8');
    const fromFile = executor.call('run', { code_file: path.join(dir, 'raw.luau') });
    const req6 = await nextFrame((f) => f.kind === 'req');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req6.id, ok: false, dm: 'edit', error: { code: 'syntax_error', message: 'StudioLiveProgram:2: Malformed string' } }));
    expect(payload((await fromFile) as TextResult)).toMatchObject({
      error: { code: 'syntax_error', hint: 'code_file has a raw newline inside a quoted literal at line 2 — fix the string in the file (use \\n, or a [[long string]])' },
    });
    // A program file above the cap is refused before anything is sent.
    await fsp.writeFile(path.join(dir, 'huge.luau'), Buffer.alloc(4 * 1024 * 1024 + 1, 0x20), 'utf8');
    expect(payload((await executor.call('run', { code_file: path.join(dir, 'huge.luau') })) as TextResult)).toMatchObject({ error: { code: 'bad_request', message: /code_file is too large/ } });
    expect(frames.filter((f) => f.kind === 'req')).toEqual([]);
  });

  it('routes observe logs dm all on the hub and observe script with path/from/to', async () => {
    const all = executor.call('observe', { what: 'logs', dm: 'all', tail: 5 });
    const req = await nextFrame((f) => f.kind === 'req');
    expect(req).toMatchObject({ op: 'observe', dm: 'edit', body: { what: 'logs', dm: 'all', tail: 5 } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req.id, ok: true, dm: 'edit', body: { items: [{ seq: 1, src: 'server', msg: 'a' }, { seq: 2, src: 'client:1', msg: 'b' }], next: 2 } }));
    expect(payload((await all) as TextResult)).toMatchObject({ items: [{ src: 'server' }, { src: 'client:1' }], next: 2 });
    expect(payload((await executor.call('observe', { what: 'tree', dm: 'all' })) as TextResult)).toMatchObject({ error: { code: 'bad_request', message: /logs only/ } });
    expect(payload((await executor.call('run', { code: 'x', dm: 'all' })) as TextResult)).toMatchObject({ error: { code: 'bad_request' } });

    const script = executor.call('observe', { what: 'script', path: 'ServerScriptService.Main', from: 10, to: 20, dm: 'server' });
    const req2 = await nextFrame((f) => f.kind === 'req');
    expect(req2).toMatchObject({ op: 'observe', dm: 'server', body: { what: 'script', path: 'ServerScriptService.Main', from: 10, to: 20, dm: 'server' } });
    const text = Array.from({ length: 11 }, (_, i) => `-- line ${i + 10} ${'x'.repeat(900)}`).join('\n');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req2.id, ok: true, dm: 'server', body: { path: 'ServerScriptService.Main', class: 'Script', lines: 11, total_lines: 60, text } }));
    const result = payload((await script) as TextResult) as { text: string; lines: number };
    expect(result.lines).toBe(11);
    expect(result.text).toBe(text);
    expect(result.text.length).toBeGreaterThan(8192);
    expect(payload((await executor.call('observe', { what: 'script' })) as TextResult)).toMatchObject({ error: { code: 'bad_request', message: 'path is required' } });
    expect(payload((await executor.call('observe', { what: 'script', path: 'x', from: 5, to: 2 })) as TextResult)).toMatchObject({ error: { code: 'bad_request' } });
    expect(frames.filter((f) => f.kind === 'req')).toEqual([]);
  });

  it('passes place identity from the heartbeat into observe status and the sessions list', async () => {
    hub!.send(JSON.stringify({ v: 1, kind: 'hb', seq: 400, t: 5, peers: [], playtest: { running: false }, dropped: 0, universeId: 424242, creatorType: 'Group', creatorId: 99 }));
    await nextFrame((f) => f.kind === 'ack');
    const status = executor.call('observe', { what: 'status' });
    const req = await nextFrame((f) => f.kind === 'req');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req.id, ok: true, body: { role: 'edit', place: { placeId: 1, placeName: 'PIRATES' }, capabilities: {} } }));
    const result = payload((await status) as TextResult) as { place: Record<string, unknown>; bridge: { playtest: unknown; sessions: Array<Record<string, unknown>> } };
    expect(result.place).toEqual({ placeId: 1, placeName: 'PIRATES', universeId: 424242, creatorType: 'Group', creatorId: 99 });
    expect(result.bridge.sessions[0]).toMatchObject({ session: SESSION, universeId: 424242, creatorType: 'Group', creatorId: 99, active: true });
    expect(result.bridge.playtest).toEqual({ running: false });

    // Identity the hub already put in its status answer is left alone.
    const explicit = executor.call('observe', { what: 'status' });
    const req2 = await nextFrame((f) => f.kind === 'req');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req2.id, ok: true, body: { role: 'edit', place: { placeId: 1, universeId: 7, creatorType: 'User', creatorId: 1 } } }));
    expect((payload((await explicit) as TextResult) as { place: unknown }).place).toEqual({ placeId: 1, universeId: 7, creatorType: 'User', creatorId: 1 });
  });

  it('forwards dry_run, undo_label, timeout_ms, args and session from skills run exactly like run', async () => {
    await executor.call('skills', { action: 'save', name: 'probe', source: 'return S.part{}' });
    const run = executor.call('skills', {
      action: 'run',
      name: 'probe',
      args: { n: 3 },
      dry_run: true,
      undo_label: 'agent: probe',
      timeout_ms: 5000,
      response_format: 'detailed',
      session: SESSION,
    });
    const req = await nextFrame((f) => f.kind === 'req');
    expect(req).toMatchObject({
      op: 'run',
      dm: 'edit',
      deadline_ms: 5000,
      body: { code: 'return S.part{}\n', args: { n: 3 }, dry_run: true, undo_label: 'agent: probe', timeout_ms: 5000, response_format: 'detailed' },
    });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req.id, ok: true, dm: 'edit', body: { value: 1, undo: 'cancelled' } }));
    expect(payload((await run) as TextResult)).toEqual({ value: 1, undo: 'cancelled', dm: 'edit', skill: 'probe', builtin: false });

    // Without dry_run the body carries no dry_run key at all (same as the run tool).
    const plain = executor.call('skills', { action: 'run', name: 'probe' });
    const req2 = await nextFrame((f) => f.kind === 'req');
    expect(req2).toMatchObject({ deadline_ms: 30_000, body: { undo_label: 'skill: probe', timeout_ms: 30_000 } });
    expect((req2.body as Record<string, unknown>).dry_run).toBeUndefined();
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req2.id, ok: true, dm: 'edit', body: { value: 1, undo: 'committed' } }));
    expect(payload((await plain) as TextResult)).toMatchObject({ undo: 'committed', skill: 'probe' });
    await executor.call('skills', { action: 'delete', name: 'probe' });
  });

  /** Answers the next `run` request with a trivial ok body and returns what the hub received. */
  const answerRun = async (call: Promise<unknown>): Promise<Record<string, unknown>> => {
    const req = await nextFrame((f) => f.kind === 'req' && (f as { op: string }).op === 'run');
    const dm = (req as { dm: string }).dm;
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req.id, ok: true, dm: dm === 'client' ? 'client:1' : dm, body: { value: 1, undo: dm === 'edit' ? 'committed' : 'n/a' } }));
    expect(payload((await call) as TextResult)).toMatchObject({ value: 1 });
    return (req as { body: Record<string, unknown> }).body;
  };

  it('fills geometry_policy from the bridge default on edit-DM runs, forwards an explicit one and leaves play DMs unchecked', async () => {
    // The executor above was given no default: `warn` (DEFAULT_GEOMETRY_POLICY) travels with every edit-DM run.
    expect((await answerRun(executor.call('run', { code: 'return 1' }))).geometry_policy).toBe('warn');
    expect((await answerRun(executor.call('run', { code: 'return 1', dm: 'edit', geometry_policy: 'reject' }))).geometry_policy).toBe('reject');
    expect((await answerRun(executor.call('run', { code: 'return 1', geometry_policy: 'off' }))).geometry_policy).toBe('off');
    // Play DMs: their parts are ephemeral, so the check runs only when the call asks for it.
    expect((await answerRun(executor.call('run', { code: 'return 1', dm: 'server' }))).geometry_policy).toBeUndefined();
    expect((await answerRun(executor.call('run', { code: 'return 1', dm: 'client', geometry_policy: 'warn' }))).geometry_policy).toBe('warn');
    // skills run builds the same body as run.
    await executor.call('skills', { action: 'save', name: 'geo', source: 'return S.part{}' });
    expect((await answerRun(executor.call('skills', { action: 'run', name: 'geo' }))).geometry_policy).toBe('warn');
    expect((await answerRun(executor.call('skills', { action: 'run', name: 'geo', geometry_policy: 'reject' }))).geometry_policy).toBe('reject');
    expect((await answerRun(executor.call('skills', { action: 'run', name: 'geo', dm: 'server' }))).geometry_policy).toBeUndefined();
    await executor.call('skills', { action: 'delete', name: 'geo' });
    // An unknown policy never reaches Studio.
    expect(payload((await executor.call('run', { code: 'x', geometry_policy: 'strict' })) as TextResult)).toMatchObject({ error: { code: 'bad_request', issues: [expect.stringMatching(/^geometry_policy:/)] } });
    expect(payload((await executor.call('skills', { action: 'run', name: 'geo', geometry_policy: 'never' })) as TextResult)).toMatchObject({ error: { code: 'bad_request' } });
    expect(frames.filter((f) => f.kind === 'req')).toEqual([]);

    // A bridge started with STUDIO_LIVE_GEOMETRY_POLICY=reject (app.ts passes config.geometryPolicy) sends
    // `reject` when the call gives none; the call still wins, and play DMs stay unchecked.
    const strict = createLocalExecutor({
      registry,
      jobs,
      skills: new SkillStore(dir, path.join(PACKAGE_ROOT, 'skills', 'builtin')),
      capture: { captureStudio: (opts) => captureImpl(opts) },
      log: silentLogger,
      bridge: { version: 'test', port: 0, bootstrapVersion: '1.0.0' },
      home: dir,
      geometryPolicy: 'reject',
    });
    expect((await answerRun(strict.call('run', { code: 'return 1' }))).geometry_policy).toBe('reject');
    expect((await answerRun(strict.call('run', { code: 'return 1', geometry_policy: 'off' }))).geometry_policy).toBe('off');
    expect((await answerRun(strict.call('run', { code: 'return 1', dm: 'server' }))).geometry_policy).toBeUndefined();
    await strict.call('skills', { action: 'save', name: 'geo2', source: 'return 2' });
    expect((await answerRun(strict.call('skills', { action: 'run', name: 'geo2' }))).geometry_policy).toBe('reject');
    await strict.call('skills', { action: 'delete', name: 'geo2' });
  });

  it('passes a run geometry report and warnings through and surfaces geometry_violation with its report', async () => {
    const geometry = {
      overlaps: [
        { a: 'Workspace.Map.Deck', b: 'Workspace.Map.WallEast', depth: 1.5, aClass: 'Part', bClass: 'Part' },
        { a: 'Workspace.Map.Ramp', b: 'Workspace.Map.Platform', depth: 0.75, aClass: 'WedgePart', bClass: 'Part', approximate: true },
      ],
      nested: [{ path: 'Workspace.Map.Pillar.Cap', parent: 'Workspace.Map.Pillar', class: 'Part' }],
      checked: 12,
      ms: 3.2,
      totals: { overlaps: 2, nested: 1 },
    };
    const warnings = [
      '2 overlapping part pairs (e.g. Workspace.Map.Deck ⟂ Workspace.Map.WallEast, 1.5 studs) — fix before continuing (move, resize or S.placeOn them); see geometry',
      '1 part parented under another part (e.g. Workspace.Map.Pillar.Cap under Workspace.Map.Pillar) — parts belong in a Model or Folder, never under a BasePart; see geometry',
    ];
    // warn (the default): the run succeeds and the report rides along with the runtime's warnings, untouched.
    const warn = executor.call('run', { code: 'build' });
    const req = await nextFrame((f) => f.kind === 'req');
    expect(req).toMatchObject({ op: 'run', body: { code: 'build', geometry_policy: 'warn' } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req.id, ok: true, dm: 'edit', body: { value: { parts: 12 }, undo: 'committed', changes: { added: 12, removed: 0, paths: ['Workspace.Map'] }, geometry, warnings } }));
    expect(payload((await warn) as TextResult)).toEqual({ value: { parts: 12 }, undo: 'committed', changes: { added: 12, removed: 0, paths: ['Workspace.Map'] }, geometry, warnings, dm: 'edit' });

    // A clean run carries no geometry key at all (the runtime omits it when empty; the bridge invents nothing).
    const clean = executor.call('run', { code: 'build' });
    const req1 = await nextFrame((f) => f.kind === 'req');
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req1.id, ok: true, dm: 'edit', body: { value: 1, undo: 'committed' } }));
    expect(payload((await clean) as TextResult)).toEqual({ value: 1, undo: 'committed', dm: 'edit' });

    // reject: the runtime cancels the recording and answers geometry_violation; every attached field reaches the result.
    const reject = executor.call('run', { code: 'build', geometry_policy: 'reject' });
    const req2 = await nextFrame((f) => f.kind === 'req');
    expect(req2).toMatchObject({ body: { geometry_policy: 'reject' } });
    const message = '2 overlapping part pairs and 1 nested part — the program was rolled back (geometry_policy reject); see geometry';
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req2.id, ok: false, dm: 'edit', error: { code: 'geometry_violation', message, geometry, warnings, undo: 'cancelled', output: [{ level: 'print', msg: 'built 12', t: 1 }] } }));
    const result = (await reject) as TextResult;
    expect(result.isError).toBe(true);
    expect(payload(result)).toEqual({
      error: { code: 'geometry_violation', message, geometry, warnings, undo: 'cancelled', output: [{ level: 'print', msg: 'built 12', t: 1 }], dm: 'edit', job_id: req2.id },
    });
  });

  it('sends observe geometry with root, max, tolerance and include_nested on req.dm and refuses those arguments for other reads', async () => {
    const report = {
      overlaps: [{ a: 'Workspace.Map.Deck', b: 'Workspace.Map.WallEast', depth: 1.5, aClass: 'Part', bClass: 'Part' }],
      nested: [],
      checked: 1000,
      sampled: true,
      ms: 41,
      totals: { overlaps: 3, nested: 0 },
    };
    const audit = executor.call('observe', { what: 'geometry', root: 'Workspace.Map', max: 1000, tolerance: 0.1, include_nested: false, dm: 'server' });
    const req = await nextFrame((f) => f.kind === 'req');
    expect(req).toMatchObject({ op: 'observe', dm: 'server', deadline_ms: 30_000, body: { what: 'geometry', root: 'Workspace.Map', max: 1000, tolerance: 0.1, include_nested: false, dm: 'server' } });
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req.id, ok: true, dm: 'server', body: report }));
    expect(payload((await audit) as TextResult)).toEqual({ ...report, dm: 'server' });

    // Defaults belong to the runtime (Workspace, 5000, 0.05, true): the bridge sends only what was given.
    const bare = executor.call('observe', { what: 'geometry' });
    const req2 = await nextFrame((f) => f.kind === 'req');
    expect(req2).toMatchObject({ op: 'observe', dm: 'edit', body: { what: 'geometry' } });
    expect(Object.keys((req2 as { body: Record<string, unknown> }).body)).toEqual(['what']);
    const empty = { overlaps: [], nested: [], checked: 0, sampled: false, ms: 0.1, totals: { overlaps: 0, nested: 0 } };
    hub!.send(JSON.stringify({ v: 1, kind: 'res', id: req2.id, ok: true, dm: 'edit', body: empty }));
    expect(payload((await bare) as TextResult)).toEqual({ ...empty, dm: 'edit' });

    // Geometry-only arguments elsewhere, or out of range, are refused before anything is sent.
    expect(payload((await executor.call('observe', { what: 'tree', tolerance: 0.1 })) as TextResult)).toMatchObject({ error: { code: 'bad_request', message: /what 'geometry' only/ } });
    expect(payload((await executor.call('observe', { what: 'find', include_nested: true })) as TextResult)).toMatchObject({ error: { code: 'bad_request' } });
    expect(payload((await executor.call('observe', { what: 'geometry', tolerance: 6 })) as TextResult)).toMatchObject({ error: { code: 'bad_request', issues: [expect.stringMatching(/^tolerance:/)] } });
    expect(payload((await executor.call('observe', { what: 'geometry', max: 6000 })) as TextResult)).toMatchObject({ error: { code: 'bad_request' } });
    expect(payload((await executor.call('observe', { what: 'geometry', dm: 'all' })) as TextResult)).toMatchObject({ error: { code: 'bad_request' } });
    expect(frames.filter((f) => f.kind === 'req')).toEqual([]);
  });
});
