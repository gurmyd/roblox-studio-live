import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBatchFrame,
  DEFAULT_PUSH_FILTER,
  EventFanout,
  FANOUT_MAX_FRAME_BYTES,
  FanoutClient,
  parseFilterQuery,
  shrinkEvent,
} from '../../bridge/src/fanout.js';
import { JobStore } from '../../bridge/src/jobs.js';
import { NO_FILTER } from '../../bridge/src/journal.js';
import { silentLogger } from '../../bridge/src/log.js';
import type { EvFrame } from '../../bridge/src/protocol.js';
import { SessionRegistry } from '../../bridge/src/session.js';

function ev(seq: number, type = 'custom', extra: Record<string, string | number | boolean> = {}): EvFrame {
  return { v: 1, kind: 'ev', seq, t: seq / 10, wall: 1789000000 + seq, src: 'client:1', type, ...extra };
}

interface Batch {
  batch: EvFrame[];
  seq: number;
  dropped: number;
}

describe('FanoutClient batching', () => {
  const sent: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const batches = (): Batch[] => sent.map((text) => JSON.parse(text) as Batch);

  it('coalesces events from one 100 ms window into a single batch frame', () => {
    const client = new FanoutClient((text) => sent.push(text), NO_FILTER);
    client.push(ev(1));
    client.push(ev(2));
    client.push(ev(3));
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(99);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(batches()).toEqual([{ batch: [ev(1), ev(2), ev(3)], seq: 3, dropped: 0 }]);
    vi.advanceTimersByTime(1000);
    expect(sent.length).toBe(1);
  });

  it('keeps every frame ≤ 4 KB and sends at most 10 frames per second', () => {
    const client = new FanoutClient((text) => sent.push(text), NO_FILTER);
    for (let seq = 1; seq <= 60; seq += 1) client.push(ev(seq, 'log', { level: 'warn', msg: 'm'.repeat(300) }));
    vi.advanceTimersByTime(1000);
    expect(sent.length).toBeLessThanOrEqual(10);
    expect(sent.length).toBeGreaterThan(1);
    for (const text of sent) expect(Buffer.byteLength(text)).toBeLessThanOrEqual(FANOUT_MAX_FRAME_BYTES);
    const all = batches().flatMap((b) => b.batch.map((e) => e.seq));
    expect(all).toEqual(Array.from({ length: all.length }, (_, i) => i + 1));
    vi.advanceTimersByTime(5000);
    const seqs = batches().flatMap((b) => b.batch.map((e) => e.seq));
    expect(seqs).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(client.pending).toBe(0);
  });

  it('counts queue overflow as dropped on the next frame, then resets', () => {
    const client = new FanoutClient((text) => sent.push(text), NO_FILTER, { maxQueue: 10 });
    for (let seq = 1; seq <= 15; seq += 1) client.push(ev(seq));
    expect(client.dropped).toBe(5);
    vi.advanceTimersByTime(100);
    const [first] = batches();
    expect(first?.dropped).toBe(5);
    expect(first?.batch[0]?.seq).toBe(6);
    client.push(ev(16));
    vi.advanceTimersByTime(100);
    expect(batches()[1]?.dropped).toBe(0);
  });

  it('applies the filter and reports dropped on heartbeats', () => {
    const client = new FanoutClient((text) => sent.push(text), DEFAULT_PUSH_FILTER, { maxQueue: 1 });
    client.push(ev(1, 'log', { level: 'print', msg: 'x' }));
    client.push(ev(2, 'change', { added: 1, removed: 0 }));
    client.push(ev(3, 'selection'));
    expect(client.pending).toBe(0);
    client.push(ev(4, 'log', { level: 'warn', msg: 'x' }));
    client.push(ev(5, 'assert', { name: 'a', ok: false }));
    expect(client.dropped).toBe(1);
    client.heartbeat({ seq: 5, alive: ['edit', 'server'], playtest: true });
    expect(JSON.parse(sent[0]!)).toEqual({ kind: 'hb', seq: 5, alive: ['edit', 'server'], playtest: true, dropped: 1 });
    vi.advanceTimersByTime(100);
    expect(batches()[1]).toEqual({ batch: [ev(5, 'assert', { name: 'a', ok: false })], seq: 5, dropped: 0 });
    client.close();
    client.push(ev(6));
    vi.advanceTimersByTime(200);
    expect(sent.length).toBe(2);
  });
});

describe('frame construction', () => {
  it('shrinks an oversized single event instead of exceeding the cap', () => {
    const huge = ev(1, 'error', { msg: 'm'.repeat(6000), stack: 's'.repeat(6000) });
    const { text, count } = buildBatchFrame([huge, ev(2)], 0);
    expect(count).toBe(1);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(FANOUT_MAX_FRAME_BYTES);
    const parsed = JSON.parse(text) as Batch;
    expect(parsed.batch[0]).toMatchObject({ seq: 1, type: 'error', truncated: true });
    expect(String(parsed.batch[0]?.msg)).toMatch(/…\[\+\d+ chars\]$/);
    const stub = shrinkEvent(ev(9, 'custom', { data: 'd'.repeat(500) }), 120);
    expect(stub).toEqual({ v: 1, kind: 'ev', seq: 9, t: 0.9, wall: 1789000009, src: 'client:1', type: 'custom', truncated: true });
  });

  it('parses kinds/levels from the query string with defaults', () => {
    const custom = parseFilterQuery(new URLSearchParams('kinds=log,assert&levels=print'), DEFAULT_PUSH_FILTER);
    expect([...custom.types!]).toEqual(['log', 'assert']);
    expect([...custom.levels!]).toEqual(['print']);
    const defaults = parseFilterQuery(new URLSearchParams(''), DEFAULT_PUSH_FILTER);
    expect(defaults.types).toBe(DEFAULT_PUSH_FILTER.types);
    expect(defaults.levels).toBe(DEFAULT_PUSH_FILTER.levels);
    expect(defaults.types?.has('vision')).toBe(true);
    const open = parseFilterQuery(new URLSearchParams('kinds='), NO_FILTER);
    expect(open.types).toBeNull();
  });
});

describe('bridge-made events', () => {
  it('pushLocal delivers vision events to every socket with the session seq repeated and its own lseq', async () => {
    vi.useFakeTimers();
    const jobs = new JobStore();
    const registry = new SessionRegistry({ bundle: { current: { hash: 'h', entry: 'runtime/init', modules: {} } }, jobs, log: silentLogger, bridgeVersion: 't' });
    const fanout = new EventFanout({ registry, log: silentLogger, heartbeatMs: 60_000 });
    try {
      const sent: string[] = [];
      const socket = { readyState: 1, OPEN: 1, send: (text: string) => sent.push(text), on: () => undefined };
      fanout.attach(socket as never, DEFAULT_PUSH_FILTER, null);
      const filtered = { readyState: 1, OPEN: 1, send: (text: string) => sent.push(`filtered:${text}`), on: () => undefined };
      fanout.attach(filtered as never, parseFilterQuery(new URLSearchParams('kinds=assert'), DEFAULT_PUSH_FILTER), null);
      expect(fanout.pushLocal({ type: 'vision', watch_id: 'w-1', frame: 1, answer: 'standing' })).toBe(1);
      expect(fanout.pushLocal({ type: 'vision', watch_id: 'w-1', done: true, reason: 'max_frames' })).toBe(2);
      vi.advanceTimersByTime(100);
      expect(sent).toHaveLength(1);
      const frame = JSON.parse(sent[0]!) as { batch: EvFrame[]; seq: number; dropped: number };
      // No hub is connected: the session seq is 0, so no gap is ever signalled; lseq counts locally.
      expect(frame).toMatchObject({ seq: 0, dropped: 0 });
      expect(frame.batch).toEqual([
        expect.objectContaining({ v: 1, kind: 'ev', seq: 0, lseq: 1, src: 'bridge', type: 'vision', watch_id: 'w-1', frame: 1, answer: 'standing' }),
        expect.objectContaining({ seq: 0, lseq: 2, type: 'vision', done: true, reason: 'max_frames' }),
      ]);
      expect(typeof frame.batch[0]?.wall).toBe('number');
      fanout.close();
      expect(fanout.pushLocal({ type: 'vision' })).toBe(2);
    } finally {
      fanout.close();
      registry.close();
      jobs.close();
      vi.useRealTimers();
    }
  });
});
