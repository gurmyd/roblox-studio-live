import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ChunkAssembler, splitFrame } from '../../bridge/src/chunk.js';
import { EventFanout } from '../../bridge/src/fanout.js';
import { JobStore } from '../../bridge/src/jobs.js';
import { NO_FILTER } from '../../bridge/src/journal.js';
import { silentLogger } from '../../bridge/src/log.js';
import { isChunkFrame, parseFrame, playtestInfoFromEvent, type AnyFrame, type BundlePayload, type EvFrame } from '../../bridge/src/protocol.js';
import { startBridgeServer, type BridgeServer } from '../../bridge/src/server.js';
import { BRIDGE_ID, compareSemver, mergeHelloStudio, REQUEST_ID_PATTERN, SessionRegistry } from '../../bridge/src/session.js';

const SESSION = '8d1c0b7e-0000-4000-8000-000000000001';

class FakeHub {
  private readonly frames: AnyFrame[] = [];
  private readonly waiters: Array<{ pred: (f: AnyFrame) => boolean; resolve: (f: AnyFrame) => void; timer: NodeJS.Timeout }> = [];
  private readonly assembler = new ChunkAssembler();
  readonly closed: Promise<number>;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const frame = parseFrame(data.toString());
      if (!frame) return;
      if (isChunkFrame(frame)) {
        const text = this.assembler.accept(frame);
        if (text === null) return;
        const inner = parseFrame(text);
        if (inner) this.offer({ ...inner, __chunked: true });
        return;
      }
      this.offer(frame);
    });
    this.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  }

  static connect(port: number): Promise<FakeHub> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio`);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(new FakeHub(ws)));
      ws.once('error', reject);
    });
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  next(pred: (f: AnyFrame) => boolean = () => true, timeoutMs = 3000): Promise<AnyFrame> {
    const index = this.frames.findIndex(pred);
    if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.findIndex((w) => w.timer === timer), 1);
        reject(new Error(`timeout waiting for frame; buffered kinds: ${this.frames.map((f) => f.kind).join(',')}`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  /** The `persist_sync` requests received (one per hello_ack, plus one per bundle push / list change). */
  readonly persistSyncs: AnyFrame[] = [];

  async hello(session = SESSION, extra: Record<string, unknown> = {}): Promise<AnyFrame> {
    this.send({
      v: 1,
      kind: 'hello',
      proto: 1,
      bootstrap: '1.0.0',
      role: 'edit',
      session,
      studio: { version: '0.738.0', placeId: 1, placeName: 'Test', dataModelName: 'Place1' },
      lastSeq: 0,
      ...extra,
    });
    const ack = await this.next((f) => f.kind === 'hello_ack' || f.kind === 'error');
    // Every accepted hello is followed by persist_sync (bridge-side persisted controllers); consume and answer it.
    if (ack.kind === 'hello_ack') await this.expectPersistSync();
    return ack;
  }

  async expectPersistSync(timeoutMs = 2000): Promise<AnyFrame> {
    const sync = await this.next((f) => f.kind === 'req' && f.op === 'persist_sync', timeoutMs);
    this.persistSyncs.push(sync);
    // The runtime's answer shape; the bridge only reads ok / error.code.
    this.send({ v: 1, kind: 'res', id: sync.id, ok: true, dm: 'edit', body: { persisted: (sync.body as { controllers: unknown[] }).controllers.length, rejected: 0, installs_issued: 0 } });
    return sync;
  }

  close(): void {
    this.ws.close();
  }

  private offer(frame: AnyFrame): void {
    const index = this.waiters.findIndex((w) => w.pred(frame));
    if (index >= 0) {
      const waiter = this.waiters.splice(index, 1)[0]!;
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else {
      this.frames.push(frame);
    }
  }
}

interface Harness {
  port: number;
  registry: SessionRegistry;
  jobs: JobStore;
  server: BridgeServer;
  close(): Promise<void>;
}

async function startHarness(options: { bundle?: BundlePayload; shippedBootstrap?: string } = {}): Promise<Harness> {
  const jobs = new JobStore();
  const bundle = { current: options.bundle ?? { hash: 'sha256-test', entry: 'runtime/init', modules: { 'runtime/init': 'return {}' } } };
  const registry = new SessionRegistry({
    bundle,
    jobs,
    log: silentLogger,
    bridgeVersion: '0.0.0-test',
    shippedBootstrap: options.shippedBootstrap,
    requestGraceMs: 200,
    ackIntervalMs: 150,
  });
  const fanout = new EventFanout({ registry, log: silentLogger, heartbeatMs: 60_000 });
  const started = await startBridgeServer({
    port: 0,
    registry,
    fanout,
    executor: { call: async () => ({ content: [] }) },
    status: () => ({ name: 'studio-live' }),
    log: silentLogger,
  });
  if (started.mode !== 'primary') throw new Error('expected primary mode on an ephemeral port');
  return {
    port: started.server.port,
    registry,
    jobs,
    server: started.server,
    async close() {
      fanout.close();
      registry.close();
      await started.server.close();
      jobs.close();
    },
  };
}

describe('hub handshake', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('answers hello with hello_ack carrying the bundle inline', async () => {
    const hub = await FakeHub.connect(h.port);
    const ack = await hub.hello();
    expect(ack).toMatchObject({
      v: 1,
      kind: 'hello_ack',
      proto: 1,
      bridge: '0.0.0-test',
      bridgeId: BRIDGE_ID,
      ackUpto: 0,
      bundle: { hash: 'sha256-test', entry: 'runtime/init', modules: { 'runtime/init': 'return {}' } },
    });
    expect(BRIDGE_ID).toMatch(/^[0-9a-f]{6}$/);
    expect(typeof ack.serverTime).toBe('number');
    const session = h.registry.get(SESSION);
    expect(session?.connected).toBe(true);
    expect(session?.bundleHash).toBe('sha256-test');
    expect(session?.studio?.placeName).toBe('Test');
    expect(h.registry.active?.id).toBe(SESSION);
    hub.close();
  });

  it('rejects a protocol mismatch with an error frame and closes', async () => {
    const hub = await FakeHub.connect(h.port);
    const reply = await hub.hello(SESSION, { proto: 2 });
    expect(reply).toMatchObject({ kind: 'error', code: 'proto_mismatch' });
    await expect(hub.closed).resolves.toBeTypeOf('number');
    expect(h.registry.get(SESSION)).toBeUndefined();
  });

  it('ignores frames before hello and unknown kinds after it', async () => {
    const hub = await FakeHub.connect(h.port);
    hub.send({ v: 1, kind: 'ev', seq: 1, t: 0, wall: 0, src: 'edit', type: 'custom' });
    hub.send({ kind: 'nonsense' });
    hub.ws.send('not json');
    const ack = await hub.hello();
    expect(ack.kind).toBe('hello_ack');
    hub.send({ v: 1, kind: 'future_thing', payload: 1 });
    hub.send({ v: 1, kind: 'hb', seq: 0, t: 1, peers: [], playtest: { running: false }, dropped: 0 });
    expect((await hub.next((f) => f.kind === 'ack')).upto).toBe(0);
    hub.close();
  });

  it('sends hello_ack with bundle:null followed by a chunked bundle frame when the bundle is large', async () => {
    await h.close();
    const big = { hash: 'sha256-big', entry: 'runtime/init', modules: { 'runtime/init': 'x'.repeat(700 * 1024) } };
    h = await startHarness({ bundle: big });
    const hub = await FakeHub.connect(h.port);
    const ack = await hub.hello();
    expect(ack).toMatchObject({ kind: 'hello_ack', bundle: null });
    const bundle = await hub.next((f) => f.kind === 'bundle');
    expect(bundle.__chunked).toBe(true);
    expect(bundle.hash).toBe('sha256-big');
    expect((bundle.modules as Record<string, string>)['runtime/init']?.length).toBe(700 * 1024);
    expect(h.registry.get(SESSION)?.bundleHash).toBe('sha256-big');
    hub.close();
  });

  it('flags a hub whose bootstrap is older than the one the package ships', async () => {
    expect(compareSemver('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(compareSemver('0.9.0', '1.0.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('dev', '1.0.0')).toBe(0);

    await h.close();
    h = await startHarness({ shippedBootstrap: '1.2.0' });
    const stale = await FakeHub.connect(h.port);
    expect((await stale.hello(SESSION, { bootstrap: '1.1.9' })).kind).toBe('hello_ack');
    expect(h.registry.get(SESSION)?.bootstrapOutdated).toBe(true);
    expect(h.registry.status()[0]?.bootstrapOutdated).toBe(true);
    stale.close();

    const fresh = await FakeHub.connect(h.port);
    await fresh.hello(SESSION, { bootstrap: '1.2.0' });
    expect(h.registry.get(SESSION)?.bootstrapOutdated).toBe(false);
    fresh.close();
  });

  it('pushes a bundle frame to every connected hub on broadcast, followed by persist_sync for the new runtime', async () => {
    const hub = await FakeHub.connect(h.port);
    await hub.hello();
    const delivered = h.registry.broadcastBundle({ hash: 'sha256-v2', entry: 'runtime/init', modules: { 'runtime/init': 'return 2' } });
    expect(delivered).toBe(1);
    const frame = await hub.next((f) => f.kind === 'bundle');
    expect(frame).toMatchObject({ v: 1, kind: 'bundle', hash: 'sha256-v2', entry: 'runtime/init' });
    expect(await hub.expectPersistSync()).toMatchObject({ dm: 'edit', body: { controllers: [] } });
    hub.close();
  });

  it('sends persist_sync with the stored controllers on hello and on syncPersisted, consuming the answer itself', async () => {
    await h.registry.persist.remember(SESSION, 'client:1', 'walker', 'return {}');
    const hub = await FakeHub.connect(h.port);
    await hub.hello();
    expect(hub.persistSyncs[0]).toMatchObject({ v: 1, kind: 'req', dm: 'edit', deadline_ms: 30_000, body: { controllers: [{ dm: 'client:1', name: 'walker', code: 'return {}' }] } });
    expect(hub.persistSyncs[0]!.id).toMatch(REQUEST_ID_PATTERN);
    const session = h.registry.resolve();
    expect(session.persistedCount).toBe(1);
    expect(session.status(true).persisted).toBe(1);
    expect(h.jobs.size).toBe(0);
    expect(session.inflight.size).toBe(0);
    // A list change re-syncs; an `unsupported` answer (older runtime) is tolerated and remembered.
    await h.registry.persist.forget(SESSION, 'client:1', 'walker');
    expect(await h.registry.syncPersisted(session, 'test')).toBe(true);
    const sync = await hub.next((f) => f.kind === 'req' && f.op === 'persist_sync');
    expect(sync).toMatchObject({ body: { controllers: [] } });
    hub.send({ v: 1, kind: 'res', id: sync.id, ok: false, dm: 'edit', error: { code: 'unsupported', message: "unknown op 'persist_sync'" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(session.persistSyncUnsupported).toBe(true);
    expect(session.persistedCount).toBe(0);
    hub.close();
    await hub.closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await h.registry.syncPersisted(session, 'offline')).toBe(false);
  });
});

describe('request multiplexer', () => {
  let h: Harness;
  let hub: FakeHub;
  beforeEach(async () => {
    h = await startHarness();
    hub = await FakeHub.connect(h.port);
    await hub.hello();
  });
  afterEach(async () => {
    hub.close();
    await h.close();
  });

  it('round-trips a request and resolves the job with the response body', async () => {
    const session = h.registry.resolve();
    const job = session.request('run', { code: 'return 1' }, { dm: 'edit', deadlineMs: 5000 });
    const req = await hub.next((f) => f.kind === 'req');
    expect(req).toMatchObject({ v: 1, kind: 'req', id: job.id, op: 'run', dm: 'edit', deadline_ms: 5000, body: { code: 'return 1' } });
    expect(req.id).toMatch(REQUEST_ID_PATTERN);
    expect(req.id.startsWith(`r-${BRIDGE_ID}-`)).toBe(true);
    expect(job.origin).toBe('stdio');
    hub.send({ v: 1, kind: 'progress', id: job.id, note: 'half', pct: 0.5 });
    hub.send({ v: 1, kind: 'res', id: job.id, ok: true, dm: 'edit', body: { value: 1, duration_ms: 3 } });
    expect(await job.wait(2000)).toBe(true);
    expect(job.status).toBe('done');
    expect(job.result).toEqual({ value: 1, duration_ms: 3 });
    expect(job.notes[0]).toMatchObject({ note: 'half', pct: 0.5 });
    expect(session.inflight.size).toBe(0);
    expect(h.jobs.get(job.id)).toBe(job);
  });

  it('relays error responses and reassembles chunked inbound frames', async () => {
    const session = h.registry.resolve();
    const job = session.request('run', { code: 'error("x")' }, { dm: 'client:1' });
    const req = await hub.next((f) => f.kind === 'req');
    expect(req.dm).toBe('client:1');
    const res = JSON.stringify({ v: 1, kind: 'res', id: job.id, ok: false, dm: 'client:1', error: { code: 'luau_error', message: 'x', stack: 's'.repeat(200) } });
    for (const chunk of splitFrame(res, 'c-hub-1', 64)) hub.send(chunk);
    await job.wait(2000);
    expect(job.status).toBe('error');
    expect(job.error).toMatchObject({ code: 'luau_error', message: 'x' });
    expect(job.responder).toBe('client:1');
  });

  it('times out locally after deadline + grace and sends a cancel', async () => {
    const session = h.registry.resolve();
    const job = session.request('run', { code: 'while true do end' }, { deadlineMs: 100 });
    await hub.next((f) => f.kind === 'req');
    await job.wait(2000);
    expect(job.status).toBe('error');
    expect(job.error?.code).toBe('timeout');
    const cancel = await hub.next((f) => f.kind === 'cancel');
    expect(cancel.id).toBe(job.id);
    hub.send({ v: 1, kind: 'res', id: job.id, ok: true, body: null });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(job.error?.code).toBe('timeout');
  });

  it('cancel sends the cancel frame once and the job finishes on the hub answer', async () => {
    const session = h.registry.resolve();
    const job = session.request('run', { code: 'loop' }, { deadlineMs: 5000 });
    await hub.next((f) => f.kind === 'req');
    expect(job.cancel()).toBe(true);
    expect(job.cancel()).toBe(false);
    const cancel = await hub.next((f) => f.kind === 'cancel');
    expect(cancel).toEqual({ v: 1, kind: 'cancel', id: job.id });
    expect(job.status).toBe('running');
    hub.send({ v: 1, kind: 'res', id: job.id, ok: false, error: { code: 'cancelled', message: 'stopped' } });
    await job.wait(2000);
    expect(job.error?.code).toBe('cancelled');
  });

  it('keeps in-flight requests alive across a socket close and resolves them after the hub reconnects', async () => {
    const session = h.registry.resolve();
    const job = session.request('run', { code: 'long build' }, { deadlineMs: 5000, origin: 'rpc' });
    const req = await hub.next((f) => f.kind === 'req');
    hub.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.connected).toBe(false);
    expect(job.running).toBe(true);
    expect(session.inflight.get(job.id)).toBe(job);
    expect(h.registry.active).toBeNull();
    expect(() => h.registry.resolve()).toThrowError(/no Roblox Studio connected/);
    expect(h.registry.resolve(undefined, { allowDisconnected: true })).toBe(session);
    expect(() => session.request('run', {})).toThrowError(/not connected/);

    // The bootstrap's scheduled refresh: same session GUID, new socket; the hub answers with the same id.
    hub = await FakeHub.connect(h.port);
    await hub.hello();
    expect(h.registry.get(SESSION)).toBe(session);
    expect(session.connected).toBe(true);
    expect(job.running).toBe(true);
    hub.send({ v: 1, kind: 'res', id: req.id, ok: true, dm: 'edit', body: { value: 'built', undo: 'committed' } });
    expect(await job.wait(2000)).toBe(true);
    expect(job.status).toBe('done');
    expect(job.result).toEqual({ value: 'built', undo: 'committed' });
    expect(job.origin).toBe('rpc');
  });

  it('fails a request with disconnected when the hub never comes back before the deadline', async () => {
    const session = h.registry.resolve();
    const job = session.request('run', { code: 'x' }, { deadlineMs: 100 });
    await hub.next((f) => f.kind === 'req');
    hub.close();
    await job.wait(2000);
    expect(job.error?.code).toBe('disconnected');
    expect(job.error?.message).toMatch(/did not reconnect/);
    expect(session.inflight.size).toBe(0);
  });

  it('cancels the Studio request when the MCP request signal aborts', async () => {
    const session = h.registry.resolve();
    const controller = new AbortController();
    const job = session.request('run', { code: 'slow' }, { deadlineMs: 5000, signal: controller.signal });
    await hub.next((f) => f.kind === 'req');
    controller.abort();
    const cancel = await hub.next((f) => f.kind === 'cancel');
    expect(cancel.id).toBe(job.id);
    expect(job.cancelRequested).toBe(true);
    hub.send({ v: 1, kind: 'res', id: job.id, ok: false, error: { code: 'cancelled', message: 'stopped' } });
    await job.wait(1000);
    expect(job.error?.code).toBe('cancelled');
  });

  it('cancel_all reaches every connected hub', async () => {
    h.registry.cancelAll();
    expect(await hub.next((f) => f.kind === 'cancel_all')).toEqual({ v: 1, kind: 'cancel_all' });
  });
});

describe('events, acks and heartbeats', () => {
  let h: Harness;
  let hub: FakeHub;
  beforeEach(async () => {
    h = await startHarness();
    hub = await FakeHub.connect(h.port);
    await hub.hello();
  });
  afterEach(async () => {
    hub.close();
    await h.close();
  });

  it('journals events with seq dedup and acks within the ack interval', async () => {
    const session = h.registry.resolve();
    const seen: number[] = [];
    h.registry.onEvent((_s, ev) => seen.push(ev.seq));
    for (const seq of [1, 2, 2, 3]) hub.send({ v: 1, kind: 'ev', seq, t: 1, wall: 2, src: 'edit', type: 'custom', name: 'n' });
    const ack = await hub.next((f) => f.kind === 'ack', 1000);
    expect(ack.upto).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
    expect(session.journal.latestSeq).toBe(3);
    expect(session.journal.size).toBe(3);
  });

  it('acks immediately on hb, records peers/playtest and resumes ackUpto on re-hello', async () => {
    const session = h.registry.resolve();
    hub.send({ v: 1, kind: 'ev', seq: 7, t: 1, wall: 2, src: 'edit', type: 'milestone', name: 'm' });
    hub.send({
      v: 1,
      kind: 'hb',
      seq: 7,
      t: 10,
      peers: [{ dm: 'server', connected: true }, { dm: 'client:1', connected: true, userId: 1, playerName: 'p' }],
      playtest: { running: true, mode: 'play' },
      dropped: 4,
      fps: 60,
      placeName: 'PIRATES',
    });
    const ack = await hub.next((f) => f.kind === 'ack', 100);
    expect(ack.upto).toBe(7);
    expect(session.alive()).toEqual(['edit', 'server', 'client:1']);
    expect(session.hb?.playtest).toEqual({ running: true, mode: 'play' });
    expect(session.status(true)).toMatchObject({ session: SESSION, connected: true, active: true, hubDropped: 4, fps: 60, peers: [{ dm: 'server', connected: true }, { dm: 'client:1', connected: true }] });
    // The hub's resolved place name replaces the hello's game.Name; a heartbeat without one changes nothing.
    expect(session.studio).toEqual({ version: '0.738.0', placeId: 1, placeName: 'PIRATES', dataModelName: 'Place1' });
    expect(session.label).toBe(`${SESSION.slice(0, 8)} (PIRATES)`);
    hub.send({ v: 1, kind: 'hb', seq: 7, t: 11, peers: [], playtest: { running: false }, dropped: 0 });
    await hub.next((f) => f.kind === 'ack', 100);
    expect(session.studio?.placeName).toBe('PIRATES');

    hub.close();
    hub = await FakeHub.connect(h.port);
    const ack2 = await hub.hello(SESSION, { lastSeq: 7 });
    expect(ack2.ackUpto).toBe(7);
    // The re-hello (bootstrap refresh) repeats game.Name; the name learned from hb stays, the hello's other fields land.
    expect(session.studio).toEqual({ version: '0.738.0', placeId: 1, placeName: 'PIRATES', dataModelName: 'Place1' });
    expect(session.label).toBe(`${SESSION.slice(0, 8)} (PIRATES)`);
  });

  it('merges a hello over hb-learned identity only for the same place', () => {
    const known = { version: '0.738.0', placeId: 1, placeName: 'PIRATES', dataModelName: 'Place1', universeId: 42, creatorType: 'Group', creatorId: 7 };
    expect(mergeHelloStudio(known, { version: '0.739.0', placeId: 1, placeName: 'Place1', dataModelName: 'Place1' })).toEqual({ ...known, version: '0.739.0' });
    expect(mergeHelloStudio(known, { placeName: 'Place1' })).toEqual(known);
    expect(mergeHelloStudio(null, { placeId: 1, placeName: 'Place1' })).toEqual({ placeId: 1, placeName: 'Place1' });
    expect(mergeHelloStudio(known, undefined)).toEqual(known);
    // A different placeId is a different place: the hello wins, including its game.Name.
    expect(mergeHelloStudio(known, { placeId: 2, placeName: 'Other' })).toEqual({ ...known, placeId: 2, placeName: 'Other' });
  });

  it('learns place identity from hb (kept across a re-hello) and reports it in status', async () => {
    const session = h.registry.resolve();
    hub.send({ v: 1, kind: 'hb', seq: 0, t: 1, peers: [], playtest: { running: false }, dropped: 0, universeId: 42, creatorType: 'Group', creatorId: 7 });
    await hub.next((f) => f.kind === 'ack', 500);
    expect(session.studio).toEqual({ version: '0.738.0', placeId: 1, placeName: 'Test', dataModelName: 'Place1', universeId: 42, creatorType: 'Group', creatorId: 7 });
    expect(session.status(true)).toMatchObject({ universeId: 42, creatorType: 'Group', creatorId: 7, playtest: { running: false } });
    // A heartbeat without identity changes nothing; a bare status shows nulls before any hb.
    hub.send({ v: 1, kind: 'hb', seq: 0, t: 2, peers: [], playtest: { running: false }, dropped: 0 });
    await hub.next((f) => f.kind === 'ack', 500);
    expect(session.studio?.universeId).toBe(42);
    hub.close();
    hub = await FakeHub.connect(h.port);
    await hub.hello();
    expect(h.registry.get(SESSION)?.studio).toMatchObject({ placeName: 'Test', universeId: 42, creatorType: 'Group', creatorId: 7 });
    const fresh = await FakeHub.connect(h.port);
    await fresh.hello('8d1c0b7e-0000-4000-8000-00000000f5e5');
    expect(h.registry.get('8d1c0b7e-0000-4000-8000-00000000f5e5')?.status(false)).toMatchObject({ universeId: null, creatorType: null, creatorId: null, playtest: null });
    fresh.close();
  });

  it('tracks the playtest flag from playtest events between heartbeats and lets a newer hb win', async () => {
    const session = h.registry.resolve();
    const ev = (seq: number, extra: Record<string, unknown>): EvFrame => ({ v: 1, kind: 'ev', seq, t: seq, wall: seq, src: 'edit', type: 'playtest', ...extra } as EvFrame);
    expect(playtestInfoFromEvent(ev(1, { state: 'stopping' }), { running: true, mode: 'play' })).toBeNull();
    expect(playtestInfoFromEvent(ev(1, { state: 'running' }), { running: false, starting: true, mode: 'multiplayer', players: 2 })).toEqual({ running: true, starting: false, mode: 'multiplayer', players: 2 });
    expect(playtestInfoFromEvent({ ...ev(1, {}), type: 'custom' }, null)).toBeNull();

    hub.send({ v: 1, kind: 'hb', seq: 0, t: 1, peers: [], playtest: { running: false }, dropped: 0 });
    await hub.next((f) => f.kind === 'ack', 500);
    expect(session.playtest).toEqual({ running: false });

    // A tiny fan-out client on a fake socket sees the flag on its next heartbeat.
    const sent: string[] = [];
    const fanout = new EventFanout({ registry: h.registry, log: silentLogger, heartbeatMs: 25 });
    const fakeSocket = { readyState: 1, OPEN: 1, send: (text: string) => sent.push(text), on: () => undefined };
    fanout.attach(fakeSocket as never, NO_FILTER, null);
    try {
      hub.send(ev(1, { state: 'starting', mode: 'multiplayer', players: 2 }));
      hub.send(ev(2, { state: 'running' }));
      await hub.next((f) => f.kind === 'ack', 1500);
      expect(session.playtest).toEqual({ running: true, starting: false, mode: 'multiplayer', players: 2 });
      expect(session.status(true).playtest).toEqual({ running: true, starting: false, mode: 'multiplayer', players: 2 });
      await new Promise((resolve) => setTimeout(resolve, 60));
      const heartbeats = sent.map((t) => JSON.parse(t) as { kind: string; playtest?: boolean }).filter((f) => f.kind === 'hb');
      expect(heartbeats.length).toBeGreaterThan(0);
      expect(heartbeats[heartbeats.length - 1]?.playtest).toBe(true);

      // An older heartbeat (seq below the event) cannot roll the flag back; one at or past it can.
      hub.send({ v: 1, kind: 'hb', seq: 1, t: 2, peers: [], playtest: { running: false }, dropped: 0 });
      await hub.next((f) => f.kind === 'ack', 500);
      expect(session.playtest?.running).toBe(true);
      hub.send({ v: 1, kind: 'hb', seq: 2, t: 3, peers: [{ dm: 'server', connected: true }], playtest: { running: true, mode: 'multiplayer', players: 2 }, dropped: 0 });
      await hub.next((f) => f.kind === 'ack', 500);
      expect(session.playtest).toEqual({ running: true, mode: 'multiplayer', players: 2 });

      hub.send(ev(3, { state: 'stopping' }));
      hub.send(ev(4, { state: 'stopped', mode: 'multiplayer' }));
      await hub.next((f) => f.kind === 'ack', 1500);
      expect(session.playtest).toEqual({ running: false, starting: false });
      sent.length = 0;
      await new Promise((resolve) => setTimeout(resolve, 60));
      const later = sent.map((t) => JSON.parse(t) as { kind: string; playtest?: boolean }).filter((f) => f.kind === 'hb');
      expect(later[later.length - 1]?.playtest).toBe(false);
    } finally {
      fanout.close();
    }
  });

  it('keeps the active session sticky: heartbeats never re-elect it, naming one does, writes need a name', async () => {
    const other = await FakeHub.connect(h.port);
    const otherId = '8d1c0b7e-0000-4000-8000-000000000002';
    await other.hello(otherId, { studio: { placeName: 'Other' } });
    // The first hub stays active; a later hello and later heartbeats from the other one change nothing.
    expect(h.registry.active?.id).toBe(SESSION);
    other.send({ v: 1, kind: 'hb', seq: 0, t: 1, peers: [], playtest: { running: false }, dropped: 0 });
    await other.next((f) => f.kind === 'ack');
    expect(h.registry.active?.id).toBe(SESSION);
    expect(h.registry.status().map((s) => s.active)).toEqual([true, false]);

    // Reads fall back to the active one; writes must name a session while two are connected.
    expect(h.registry.resolve().id).toBe(SESSION);
    expect(() => h.registry.resolve(undefined, { write: true })).toThrowError(/several Studio sessions/);
    expect(() => h.registry.resolve('8d1c0b7e')).toThrowError(/ambiguous/);
    expect(() => h.registry.resolve('nope')).toThrowError(/no Studio session/);

    // Naming a connected session makes it the active one.
    expect(h.registry.resolve(otherId).id).toBe(otherId);
    expect(h.registry.active?.id).toBe(otherId);
    expect(h.registry.describeConnected()).toMatch(/\(Other\) \[active\]/);

    // Failover only when the active hub disconnects.
    other.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.registry.active?.id).toBe(SESSION);
    expect(h.registry.resolve(undefined, { write: true }).id).toBe(SESSION);
  });

  it('evicts disconnected sessions after the grace period', async () => {
    await h.close();
    h = await startHarness();
    const registry = new SessionRegistry({
      bundle: { current: { hash: 'h', entry: 'runtime/init', modules: {} } },
      jobs: h.jobs,
      log: silentLogger,
      bridgeVersion: 't',
      evictAfterMs: 0,
    });
    const fanout = new EventFanout({ registry, log: silentLogger, heartbeatMs: 60_000 });
    const started = await startBridgeServer({ port: 0, registry, fanout, executor: { call: async () => ({ content: [] }) }, status: () => ({}), log: silentLogger });
    if (started.mode !== 'primary') throw new Error('expected primary');
    try {
      const gone = await FakeHub.connect(started.server.port);
      await gone.hello('8d1c0b7e-0000-4000-8000-00000000dead');
      gone.close();
      await gone.closed;
      expect(registry.all().length).toBe(1);
      // The persist_sync answer touched the session a moment ago; let the zero grace elapse.
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Same sweep the registry runs every 5 s.
      registry.sweep();
      expect(registry.all().length).toBe(0);
    } finally {
      fanout.close();
      registry.close();
      await started.server.close();
    }
  });
});
