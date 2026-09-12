import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaptureError, CaptureWorker } from '../../bridge/src/capture/index.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-worker.mjs');

function fakeWorker(timeoutMs = 2_000, logs: string[] = []): CaptureWorker {
  return new CaptureWorker({ command: process.execPath, args: [FAKE], timeoutMs, log: (m) => logs.push(m) });
}

const workers: CaptureWorker[] = [];
const track = (w: CaptureWorker): CaptureWorker => {
  workers.push(w);
  return w;
};

afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.shutdown()));
});

describe('CaptureWorker framing', () => {
  it('spawns lazily and matches one reply per request by id', async () => {
    const w = track(fakeWorker());
    expect(w.pid).toBeUndefined();
    const reply = await w.request('ping');
    expect(reply).toMatchObject({ ok: true, pong: true });
    expect(w.pid).toBe(reply['pid']);
    expect(w.spawns).toBe(1);
    expect(w.inFlight).toBe(0);
  });

  it('warmup spawns the worker and round-trips ping and list so the first real request is warm', async () => {
    const w = track(fakeWorker());
    expect(await w.warmup()).toBe(true);
    expect(w.pid).toBeDefined();
    expect(w.spawns).toBe(1);
    expect(w.inFlight).toBe(0);
    const reply = await w.request('echo', { after: 'warmup' });
    expect((reply['echo'] as Record<string, unknown>)['id']).toBe('c3');
    expect(w.spawns).toBe(1);
  });

  it('sends the request fields as one JSON line with id and cmd winning over params', async () => {
    const w = track(fakeWorker());
    const reply = await w.request('echo', { a: 1, nested: { b: 'x' }, id: 'spoofed', cmd: 'spoofed' });
    const echoed = reply['echo'] as Record<string, unknown>;
    expect(echoed['cmd']).toBe('echo');
    expect(echoed['id']).toBe(reply.id);
    expect(echoed['a']).toBe(1);
    expect(echoed['nested']).toEqual({ b: 'x' });
  });

  it('routes concurrent, out-of-order replies to the right callers', async () => {
    const w = track(fakeWorker());
    const [slow, fast, ping] = await Promise.all([
      w.request('sleep', { ms: 300 }),
      w.request('sleep', { ms: 20 }),
      w.request('ping'),
    ]);
    expect(slow['slept']).toBe(300);
    expect(fast['slept']).toBe(20);
    expect(ping['pong']).toBe(true);
    expect(w.spawns).toBe(1);
  });

  it('ignores non-JSON and id-less lines instead of failing the request', async () => {
    const logs: string[] = [];
    const w = track(fakeWorker(2_000, logs));
    const reply = await w.request('garbage');
    expect(reply['after']).toBe('garbage');
    expect(logs.some((l) => l.includes('non-JSON'))).toBe(true);
    expect(logs.some((l) => l.includes('without an id'))).toBe(true);
  });

  it('decodes UTF-8 replies intact', async () => {
    const w = track(fakeWorker());
    const reply = await w.request('unicode');
    expect(reply['text']).toBe('PIRATES — Roblox Studio ✓ 日本語');
  });

  it('passes worker-reported failures through as replies (the client maps them to errors)', async () => {
    const w = track(fakeWorker());
    const reply = await w.request('fail', { code: 'no_window', message: 'nothing here' });
    expect(reply).toMatchObject({ ok: false, code: 'no_window', message: 'nothing here' });
  });
});

describe('CaptureWorker timeout and restart', () => {
  it('rejects a request that exceeds the timeout, kills the worker and restarts it on the next call', async () => {
    const logs: string[] = [];
    const w = track(fakeWorker(150, logs));
    const first = await w.request('ping');
    const firstPid = first['pid'];

    const err = await w.request('noreply').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).code).toBe('capture_failed');
    expect((err as CaptureError).message).toMatch(/did not answer 'noreply' within 150 ms/);
    expect(w.pid).toBeUndefined();

    const second = await w.request('ping');
    expect(second['pid']).not.toBe(firstPid);
    expect(w.spawns).toBe(2);
    expect(logs.some((l) => l.includes('restarting worker'))).toBe(true);
  });

  it('rejects other in-flight requests when one times out and the worker is restarted', async () => {
    const w = track(fakeWorker(200));
    const hung = w.request('noreply');
    const bystander = w.request('sleep', { ms: 5_000 });
    await expect(hung).rejects.toMatchObject({ code: 'capture_failed' });
    await expect(bystander).rejects.toMatchObject({ code: 'capture_failed', message: expect.stringMatching(/restarted.*'sleep'/) });
    expect(w.inFlight).toBe(0);
  });

  it('rejects pending requests when the worker crashes and respawns afterwards', async () => {
    const w = track(fakeWorker());
    const before = await w.request('ping');
    const crashed = w.request('crash');
    const pendingToo = w.request('sleep', { ms: 5_000 });
    await expect(crashed).rejects.toMatchObject({ code: 'capture_failed', message: expect.stringMatching(/exited \(code 3/) });
    await expect(pendingToo).rejects.toMatchObject({ code: 'capture_failed' });

    const after = await w.request('ping');
    expect(after['pid']).not.toBe(before['pid']);
    expect(w.spawns).toBe(2);
  });

  it('reports a spawn failure as capture_failed instead of hanging until the timeout', async () => {
    const w = track(new CaptureWorker({ command: 'definitely-not-a-real-executable-xyz', args: [], timeoutMs: 5_000, log: () => undefined }));
    const t0 = Date.now();
    const err = await w.request('ping').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).message).toMatch(/could not start/);
    expect(Date.now() - t0).toBeLessThan(4_000);
  });

  it('shutdown ends the worker and a later request starts a fresh one', async () => {
    const w = track(fakeWorker());
    const first = await w.request('ping');
    await w.shutdown();
    expect(w.pid).toBeUndefined();
    await w.shutdown();
    const second = await w.request('ping');
    expect(second['pid']).not.toBe(first['pid']);
  });

  it('applies a per-request timeout override', async () => {
    const w = track(fakeWorker(10_000));
    await expect(w.request('noreply', {}, 100)).rejects.toMatchObject({ code: 'capture_failed', message: expect.stringMatching(/within 100 ms/) });
  });

  it('counts the request timeout from worker readiness, not from spawn', async () => {
    // A worker that takes 600 ms to come up must not eat a 300 ms request budget.
    const slowStart = ['-e', 'setTimeout(() => { process.stderr.write("slow worker ready\\n"); process.stdin.on("data", (d) => { for (const l of d.toString().split("\\n")) if (l.trim()) process.stdout.write(JSON.stringify({ id: JSON.parse(l).id, ok: true }) + "\\n"); }); }, 600)'];
    const w = track(new CaptureWorker({ command: process.execPath, args: slowStart, timeoutMs: 300, log: () => undefined }));
    const reply = await w.request('ping');
    expect(reply['ok']).toBe(true);
    expect(w.spawns).toBe(1);
  });

  it('gives up on a worker that never becomes ready', async () => {
    const never = ['-e', 'setInterval(() => {}, 1000)'];
    const w = track(new CaptureWorker({ command: process.execPath, args: never, timeoutMs: 10_000, startupTimeoutMs: 300, log: () => undefined }));
    await expect(w.request('ping')).rejects.toMatchObject({ code: 'capture_failed', message: expect.stringMatching(/did not start within 300 ms/) });
    expect(w.pid).toBeUndefined();
    expect(await w.warmup()).toBe(false);
  });
});
