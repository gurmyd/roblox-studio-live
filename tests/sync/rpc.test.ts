import { afterEach, describe, expect, it } from 'vitest';
import { RpcClient, callWithRetry, followJob, interpretRpcBody } from '../../bridge/src/sync/rpc.js';
import { startFakeBridge, type FakeBridge } from './fake-bridge.js';

const bridges: FakeBridge[] = [];
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.close();
});

async function fake(): Promise<FakeBridge> {
  const b = await startFakeBridge();
  bridges.push(b);
  return b;
}

describe('interpretRpcBody', () => {
  it('unwraps tool results, tool errors, running jobs and HTTP-level errors', () => {
    const ok = interpretRpcBody(200, JSON.stringify({ content: [{ type: 'text', text: '{"value":{"a":1},"undo":"committed"}' }] }));
    expect(ok).toEqual({ ok: true, value: { value: { a: 1 }, undo: 'committed' } });
    const err = interpretRpcBody(200, JSON.stringify({ content: [{ type: 'text', text: '{"error":{"code":"busy","message":"one at a time"}}' }], isError: true }));
    expect(err).toMatchObject({ ok: false, code: 'busy', message: 'one at a time', transport: false });
    const running = interpretRpcBody(200, JSON.stringify({ content: [{ type: 'text', text: '{"job_id":"r-1-2","status":"running"}' }] }));
    expect(running).toMatchObject({ ok: false, code: 'running', value: { job_id: 'r-1-2' } });
    expect(interpretRpcBody(503, JSON.stringify({ error: { code: 'no_session', message: 'no hub' } }))).toMatchObject({ ok: false, code: 'no_session', transport: true });
    expect(interpretRpcBody(400, JSON.stringify({ error: { code: 'bad_request', message: 'nope' } }))).toMatchObject({ ok: false, code: 'bad_request', transport: false });
    expect(interpretRpcBody(500, JSON.stringify({ error: { code: 'internal', message: 'boom' } }))).toMatchObject({ ok: false, code: 'unreachable', transport: true });
    expect(interpretRpcBody(200, 'garbage')).toMatchObject({ ok: false, code: 'unreachable', transport: true });
  });
});

describe('RpcClient / callWithRetry', () => {
  it('posts {tool,args} like scripts/rpc.mjs and returns the tool value', async () => {
    const bridge = await fake();
    const client = new RpcClient(bridge.port);
    const outcome = await client.call('observe', { what: 'status' });
    expect(outcome).toMatchObject({ ok: true, value: { playtest: { running: false } } });
    expect(bridge.calls).toEqual([{ tool: 'observe', args: { what: 'status' } }]);
  });

  it('retries busy and transport failures with back-off and gives up after the budget', async () => {
    const bridge = await fake();
    bridge.failures.push({ code: 'busy' }, { code: 'http500' }, { code: 'garbage' });
    const client = new RpcClient(bridge.port);
    const retries: string[] = [];
    const outcome = await callWithRetry(client, 'observe', { what: 'status' }, { budgetMs: 5000, baseMs: 10, maxMs: 40, onRetry: (f) => retries.push(f.code) });
    expect(outcome.ok).toBe(true);
    expect(retries).toEqual(['busy', 'unreachable', 'unreachable']);
    expect(bridge.calls).toHaveLength(4);

    bridge.failures.push({ code: 'luau_error', message: 'boom' });
    const fatal = await callWithRetry(client, 'observe', { what: 'status' }, { budgetMs: 5000, baseMs: 10, maxMs: 40 });
    expect(fatal).toMatchObject({ ok: false, code: 'luau_error' });
    expect(bridge.calls).toHaveLength(5);

    bridge.failures.push({ code: 'no_session' }, { code: 'no_session' }, { code: 'no_session' }, { code: 'no_session' }, { code: 'no_session' });
    const t0 = Date.now();
    const exhausted = await callWithRetry(client, 'observe', { what: 'status' }, { budgetMs: 60, baseMs: 20, maxMs: 20 });
    expect(exhausted).toMatchObject({ ok: false, code: 'no_session' });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('follows a job handle to its result, and cancels it when the signal aborts', async () => {
    const bridge = await fake();
    bridge.studio.put(['ServerScriptService', 'Main'], 'Script', 'x\n');
    const client = new RpcClient(bridge.port);
    bridge.deferRuns = 1;
    bridge.deferPolls = 2;
    const jobsSeen: string[] = [];
    const outcome = await callWithRetry(client, 'run', { code: 'list', args: { op: 'list', offset: 0, limit: 200 } }, { budgetMs: 5000, baseMs: 10, maxMs: 40, onJob: (id) => jobsSeen.push(id) });
    expect(outcome).toMatchObject({ ok: true, value: { value: { total: 1 } } });
    expect(jobsSeen).toEqual(['r-fake00-1']);
    expect(bridge.calls.map((c) => c.tool)).toEqual(['run', 'job', 'job', 'job']);

    // followJobs: false hands the handle back untouched.
    bridge.deferRuns = 1;
    const raw = await callWithRetry(client, 'run', { args: { op: 'list' } }, { budgetMs: 5000, baseMs: 10, maxMs: 40, followJobs: false });
    expect(raw).toMatchObject({ ok: false, code: 'running', value: { job_id: 'r-fake00-2' } });
    expect(await followJob(client, 'r-fake00-2', { waitMs: 100 })).toMatchObject({ ok: true });
    expect(await followJob(client, 'r-nope', { waitMs: 100 })).toMatchObject({ ok: false, code: 'not_found' });

    // An abort while following sends `job cancel` and reports cancelled.
    bridge.deferRuns = 1;
    bridge.deferPolls = 1_000;
    const abort = new AbortController();
    const pending = callWithRetry(client, 'run', { args: { op: 'list' } }, { budgetMs: 60_000, baseMs: 10, maxMs: 40, signal: abort.signal });
    await new Promise((r) => setTimeout(r, 60));
    abort.abort();
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' });
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.cancelled).toEqual(['r-fake00-3']);
  });

  it('waits for a bridge that is not listening yet', async () => {
    const bridge = await fake();
    const port = bridge.port;
    await bridge.pause();
    const client = new RpcClient(port);
    const pending = callWithRetry(client, 'observe', { what: 'status' }, { budgetMs: 5000, baseMs: 20, maxMs: 50 });
    await new Promise((r) => setTimeout(r, 120));
    await bridge.listen();
    expect((await pending).ok).toBe(true);
  });

  it('stops retrying when the signal aborts', async () => {
    const bridge = await fake();
    const port = bridge.port;
    await bridge.pause();
    const abort = new AbortController();
    const client = new RpcClient(port);
    const pending = callWithRetry(client, 'observe', {}, { budgetMs: 60_000, baseMs: 50, maxMs: 50, signal: abort.signal });
    setTimeout(() => abort.abort(), 30);
    const t0 = Date.now();
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
