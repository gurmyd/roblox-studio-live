import { describe, expect, it } from 'vitest';
import { Journal, makeFilter, matchesFilter, NO_FILTER } from '../../bridge/src/journal.js';
import type { EvFrame } from '../../bridge/src/protocol.js';

function ev(seq: number, type = 'custom', extra: Record<string, string | number | boolean> = {}): EvFrame {
  return { v: 1, kind: 'ev', seq, t: seq / 10, wall: 1789000000 + seq, src: 'edit', type, ...extra };
}

describe('Journal ring', () => {
  it('ingests monotonically and dedups by seq', () => {
    const journal = new Journal(100);
    expect(journal.ingest(ev(1))).toBe(true);
    expect(journal.ingest(ev(2))).toBe(true);
    expect(journal.ingest(ev(2))).toBe(false);
    expect(journal.ingest(ev(1))).toBe(false);
    expect(journal.latestSeq).toBe(2);
    expect(journal.size).toBe(2);
  });

  it('evicts the oldest event at capacity and tracks the count', () => {
    const journal = new Journal(3);
    for (let seq = 1; seq <= 5; seq += 1) journal.ingest(ev(seq));
    expect(journal.size).toBe(3);
    expect(journal.oldestSeq).toBe(3);
    expect(journal.latestSeq).toBe(5);
    expect(journal.evicted).toBe(2);
    expect(journal.backfill(0).events.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('counts seq gaps as hub-side loss but not the initial offset', () => {
    const journal = new Journal(10);
    journal.ingest(ev(500));
    expect(journal.gaps).toBe(0);
    journal.ingest(ev(501));
    journal.ingest(ev(504));
    expect(journal.gaps).toBe(2);
  });
});

describe('Journal backfill', () => {
  it('filters by since, type and log level', () => {
    const journal = new Journal(100);
    journal.ingest(ev(1, 'log', { level: 'print', msg: 'a' }));
    journal.ingest(ev(2, 'log', { level: 'warn', msg: 'b' }));
    journal.ingest(ev(3, 'assert', { name: 'door', ok: false }));
    journal.ingest(ev(4, 'custom', { name: 'x' }));

    expect(journal.backfill(2).events.map((e) => e.seq)).toEqual([3, 4]);
    expect(journal.backfill(0, makeFilter(['log'], ['warn'])).events.map((e) => e.seq)).toEqual([2]);
    expect(journal.backfill(0, makeFilter(['assert', 'custom'])).events.map((e) => e.seq)).toEqual([3, 4]);
    expect(matchesFilter(ev(9, 'change'), makeFilter(null, ['warn']))).toBe(true);
  });

  it('advances the cursor past filtered-out events and reports truncation', () => {
    const journal = new Journal(100);
    for (let seq = 1; seq <= 10; seq += 1) journal.ingest(ev(seq, seq % 2 === 0 ? 'custom' : 'change'));

    const nothing = journal.backfill(0, makeFilter(['assert']));
    expect(nothing.events).toEqual([]);
    expect(nothing.cursor).toBe(10);

    const page = journal.backfill(0, makeFilter(['custom']), 3);
    expect(page.events.map((e) => e.seq)).toEqual([2, 4, 6]);
    expect(page.truncated).toBe(true);
    expect(page.cursor).toBe(6);

    const rest = journal.backfill(page.cursor, makeFilter(['custom']), 3);
    expect(rest.events.map((e) => e.seq)).toEqual([8, 10]);
    expect(rest.truncated).toBe(false);
    expect(rest.cursor).toBe(10);
    expect(journal.backfill(50).cursor).toBe(50);
  });

  it('reports dropped events when the consumer is behind the ring', () => {
    const journal = new Journal(4);
    for (let seq = 1; seq <= 10; seq += 1) journal.ingest(ev(seq));
    expect(journal.oldestSeq).toBe(7);
    expect(journal.backfill(0).dropped).toBe(6);
    expect(journal.backfill(4).dropped).toBe(2);
    expect(journal.backfill(6).dropped).toBe(0);
    expect(journal.backfill(8).dropped).toBe(0);
  });

  it('does not count seqs from before the bridge ever saw this session as dropped', () => {
    const journal = new Journal(4);
    for (let seq = 1000; seq <= 1002; seq += 1) journal.ingest(ev(seq));
    expect(journal.backfill(0).dropped).toBe(0);
    for (let seq = 1003; seq <= 1006; seq += 1) journal.ingest(ev(seq));
    expect(journal.backfill(0).dropped).toBe(3);
    expect(journal.backfill(1001).dropped).toBe(1);
  });
});

describe('Journal long-poll', () => {
  it('resolves immediately when matching events already exist', async () => {
    const journal = new Journal(10);
    journal.ingest(ev(1));
    const result = await journal.waitFor(0, NO_FILTER, 5000);
    expect(result.events.map((e) => e.seq)).toEqual([1]);
  });

  it('waits for the next matching event', async () => {
    const journal = new Journal(10);
    const pending = journal.waitFor(0, makeFilter(['assert']), 5000);
    journal.ingest(ev(1, 'custom'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    journal.ingest(ev(2, 'assert'));
    const result = await pending;
    expect(result.events.map((e) => e.seq)).toEqual([2]);
    expect(result.cursor).toBe(2);
  });

  it('returns empty on timeout and on abort', async () => {
    const journal = new Journal(10);
    const started = Date.now();
    const timedOut = await journal.waitFor(0, NO_FILTER, 50);
    expect(timedOut.events).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);

    const abort = new AbortController();
    const pending = journal.waitFor(0, NO_FILTER, 10_000, 500, abort.signal);
    abort.abort();
    const aborted = await pending;
    expect(aborted.events).toEqual([]);
  });
});
