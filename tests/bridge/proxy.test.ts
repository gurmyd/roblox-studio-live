import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EventFanout } from '../../bridge/src/fanout.js';
import { JobStore } from '../../bridge/src/jobs.js';
import { silentLogger } from '../../bridge/src/log.js';
import { parsePrimaryStatus, probePrimary, ProxyToolExecutor, rpcCall } from '../../bridge/src/proxy.js';
import { startBridgeServer } from '../../bridge/src/server.js';
import { SessionRegistry } from '../../bridge/src/session.js';

type Responder = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function listenOn(handler: Responder): Promise<number> {
  const server = http.createServer(handler);
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

describe('primary detection', () => {
  it('accepts only a status body that announces studio-live', () => {
    expect(parsePrimaryStatus('{"name":"studio-live","version":"1.2.3","pid":42,"port":47800}')).toMatchObject({
      name: 'studio-live',
      version: '1.2.3',
      pid: 42,
      port: 47800,
    });
    expect(parsePrimaryStatus('{"name":"other"}')).toBeNull();
    expect(parsePrimaryStatus('[]')).toBeNull();
    expect(parsePrimaryStatus('not json')).toBeNull();
    expect(parsePrimaryStatus('{"name":"studio-live"}')?.version).toBeNull();
  });

  it('probes a healthy bridge, a foreign listener and a closed port', async () => {
    const healthyPort = await listenOn((_req, res) => json(res, 200, { name: 'studio-live', version: '9', pid: 7 }));
    expect(await probePrimary(healthyPort)).toMatchObject({ state: 'healthy', status: { version: '9', pid: 7 } });

    const foreignPort = await listenOn((_req, res) => json(res, 200, { hello: 'world' }));
    expect((await probePrimary(foreignPort)).state).toBe('other');

    const brokenPort = await listenOn((_req, res) => json(res, 500, { name: 'studio-live' }));
    expect((await probePrimary(brokenPort)).state).toBe('other');

    const closedPort = await listenOn((_req, res) => res.end());
    await closers.pop()!();
    expect((await probePrimary(closedPort, { timeoutMs: 500 })).state).toBe('unreachable');
  });
});

describe('startBridgeServer on an occupied port', () => {
  const deps = () => {
    const jobs = new JobStore();
    const registry = new SessionRegistry({ bundle: { current: { hash: 'h', entry: 'runtime/init', modules: {} } }, jobs, log: silentLogger, bridgeVersion: 't' });
    const fanout = new EventFanout({ registry, log: silentLogger });
    closers.push(async () => {
      fanout.close();
      registry.close();
      jobs.close();
    });
    return { registry, fanout, jobs };
  };

  it('enters proxy mode when a healthy bridge owns the port', async () => {
    const port = await listenOn((_req, res) => json(res, 200, { name: 'studio-live', pid: 123 }));
    const { registry, fanout } = deps();
    const started = await startBridgeServer({ port, registry, fanout, executor: { call: async () => ({ content: [] }) }, status: () => ({}), log: silentLogger });
    expect(started).toMatchObject({ mode: 'proxy', primary: { pid: 123 } });
  });

  it('fails clearly when something else owns the port', async () => {
    const port = await listenOn((_req, res) => json(res, 200, { name: 'some-other-daemon' }));
    const { registry, fanout } = deps();
    await expect(
      startBridgeServer({ port, registry, fanout, executor: { call: async () => ({ content: [] }) }, status: () => ({}), log: silentLogger }),
    ).rejects.toMatchObject({ code: 'port_in_use' });
  });
});

describe('rpc forwarding', () => {
  it('returns the primary tool result verbatim and wraps failures', async () => {
    const port = await listenOn((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const { tool, args } = JSON.parse(body) as { tool: string; args: unknown };
        if (tool === 'garbage') return json(res, 200, { nope: true });
        if (tool === 'boom') return json(res, 500, { error: { code: 'internal', message: 'kaput' } });
        json(res, 200, { content: [{ type: 'text', text: JSON.stringify({ tool, args }) }] });
      });
    });
    const direct = await rpcCall(port, 'events', { since: 1 });
    expect(direct).toEqual({ content: [{ type: 'text', text: '{"tool":"events","args":{"since":1}}' }] });

    const garbage = await rpcCall(port, 'garbage', {});
    expect(garbage.isError).toBe(true);
    expect(JSON.parse((garbage.content[0] as { text: string }).text).error.code).toBe('internal');

    const boom = await rpcCall(port, 'boom', {});
    expect(JSON.parse((boom.content[0] as { text: string }).text).error.message).toMatch(/kaput/);

    const executor = new ProxyToolExecutor(port);
    expect(await executor.call('job', { action: 'status', job_id: 'r-1' })).toEqual({
      content: [{ type: 'text', text: '{"tool":"job","args":{"action":"status","job_id":"r-1"}}' }],
    });
  });

  it('reports an unreachable primary as a tool error', async () => {
    const port = await listenOn((_req, res) => res.end());
    await closers.pop()!();
    const executor = new ProxyToolExecutor(port, { timeoutMs: 500 });
    const result = await executor.call('run', { code: 'x' });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as { text: string }).text).error.code).toBe('proxy_unreachable');
  });

  it('promotes itself once when the primary is gone and serves later calls locally', async () => {
    const port = await listenOn((_req, res) => res.end());
    await closers.pop()!();
    let promotions = 0;
    const local = { call: async (name: string) => ({ content: [{ type: 'text' as const, text: `local:${name}` }] }) };
    const executor = new ProxyToolExecutor(port, {
      timeoutMs: 500,
      promote: async () => {
        promotions += 1;
        return local;
      },
    });
    const [a, b] = await Promise.all([executor.call('events', {}), executor.call('job', { action: 'list' })]);
    expect((a.content[0] as { text: string }).text).toBe('local:events');
    expect((b.content[0] as { text: string }).text).toBe('local:job');
    expect(promotions).toBe(1);
    expect((await executor.call('observe', { what: 'status' })).content[0]).toEqual({ type: 'text', text: 'local:observe' });
    expect(promotions).toBe(1);

    const stuck = new ProxyToolExecutor(port, { timeoutMs: 500, promote: async () => null });
    const result = await stuck.call('run', { code: 'x' });
    expect(JSON.parse((result.content[0] as { text: string }).text).error.code).toBe('proxy_unreachable');
  });
});
