import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventFanout } from '../../bridge/src/fanout.js';
import { JobStore } from '../../bridge/src/jobs.js';
import { silentLogger } from '../../bridge/src/log.js';
import { parseFrame, type AnyFrame } from '../../bridge/src/protocol.js';
import { startBridgeServer, type BridgeServer } from '../../bridge/src/server.js';
import { SessionRegistry } from '../../bridge/src/session.js';

const SESSION = 'f00d0000-0000-4000-8000-00000000abcd';

interface PollResult {
  session: string;
  cursor: number;
  events: Array<{ seq: number; type: string }>;
  dropped: number;
  truncated: boolean;
}

function openSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextText(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ws frame')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
  });
}

describe('HTTP long-poll and /events fan-out', () => {
  let port = 0;
  let server: BridgeServer;
  let registry: SessionRegistry;
  let fanout: EventFanout;
  let jobs: JobStore;
  let hub: WebSocket;
  let seq = 0;

  const sendEvent = (type: string, extra: Record<string, unknown> = {}): number => {
    seq += 1;
    hub.send(JSON.stringify({ v: 1, kind: 'ev', seq, t: seq, wall: seq, src: 'edit', type, ...extra }));
    return seq;
  };

  beforeAll(async () => {
    jobs = new JobStore();
    registry = new SessionRegistry({
      bundle: { current: { hash: 'sha256-x', entry: 'runtime/init', modules: {} } },
      jobs,
      log: silentLogger,
      bridgeVersion: 'test',
    });
    fanout = new EventFanout({ registry, log: silentLogger, heartbeatMs: 60_000 });
    const started = await startBridgeServer({
      port: 0,
      registry,
      fanout,
      executor: { call: async (name, args) => ({ content: [{ type: 'text', text: JSON.stringify({ name, args }) }] }) },
      status: () => ({ name: 'studio-live', version: 'test' }),
      log: silentLogger,
    });
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
  });

  it('answers 503 for the long-poll while no Studio session exists', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events?since=0&timeout=0`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('no_session');
  });

  it('serves /status and 404s unknown routes', async () => {
    const status = (await (await fetch(`http://127.0.0.1:${port}/status`)).json()) as { name: string };
    expect(status.name).toBe('studio-live');
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
  });

  it('returns backfill immediately and long-polls for new events', async () => {
    hub = await openSocket(`ws://127.0.0.1:${port}/studio`);
    hub.send(JSON.stringify({ v: 1, kind: 'hello', proto: 1, bootstrap: '1.0.0', role: 'edit', session: SESSION, lastSeq: 0 }));
    const ack = parseFrame(await nextText(hub));
    expect(ack?.kind).toBe('hello_ack');

    sendEvent('custom', { name: 'a' });
    sendEvent('log', { level: 'print', msg: 'p' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const immediate = (await (await fetch(`http://127.0.0.1:${port}/events?since=0&timeout=5000`)).json()) as PollResult;
    expect(immediate.session).toBe(SESSION);
    expect(immediate.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(immediate.cursor).toBe(2);
    expect(immediate.dropped).toBe(0);

    const filtered = (await (await fetch(`http://127.0.0.1:${port}/events?since=0&kinds=custom&timeout=0`)).json()) as PollResult;
    expect(filtered.events.map((e) => e.type)).toEqual(['custom']);

    const started = Date.now();
    const pending = fetch(`http://127.0.0.1:${port}/events?since=${immediate.cursor}&kinds=assert&timeout=5000`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    sendEvent('custom', { name: 'ignored' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const asserted = sendEvent('assert', { name: 'door', ok: true });
    const result = (await (await pending).json()) as PollResult;
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.events.map((e) => e.seq)).toEqual([asserted]);
    expect(result.cursor).toBe(asserted);

    const empty = (await (await fetch(`http://127.0.0.1:${port}/events?since=${asserted}&timeout=60`)).json()) as PollResult;
    expect(empty.events).toEqual([]);
    expect(empty.cursor).toBe(asserted);
  });

  it('pushes filtered batches over the /events WebSocket', async () => {
    const monitor = await openSocket(`ws://127.0.0.1:${port}/events?kinds=milestone,log&levels=warn`);
    expect(fanout.size).toBe(1);
    sendEvent('log', { level: 'print', msg: 'skip' });
    sendEvent('custom', { name: 'skip' });
    const first = sendEvent('milestone', { name: 'm1' });
    const second = sendEvent('log', { level: 'warn', msg: 'w' });
    const frame = JSON.parse(await nextText(monitor)) as { batch: AnyFrame[]; seq: number; dropped: number };
    expect(frame.batch.map((e) => e.seq)).toEqual([first, second]);
    expect(frame.seq).toBe(second);
    expect(frame.dropped).toBe(0);

    const defaults = await openSocket(`ws://127.0.0.1:${port}/events`);
    sendEvent('change', { added: 1, removed: 0 });
    const asserted = sendEvent('assert', { name: 'x', ok: false });
    const pushed = JSON.parse(await nextText(defaults)) as { batch: AnyFrame[] };
    expect(pushed.batch.map((e) => e.seq)).toEqual([asserted]);

    monitor.close();
    defaults.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fanout.size).toBe(0);
  });

  it('proxies POST /rpc to the executor and refuses browser origins', async () => {
    const ok = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'events', args: { since: 3 } }),
    });
    expect(ok.status).toBe(200);
    const result = (await ok.json()) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toEqual({ name: 'events', args: { since: 3 } });

    const origin = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: '{"tool":"run"}',
    });
    expect(origin.status).toBe(403);
    const badType = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(badType.status).toBe(415);
    const badJson = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(badJson.status).toBe(400);
  });
});
