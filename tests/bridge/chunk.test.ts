import { describe, expect, it } from 'vitest';
import { CHUNK_DATA_CHARS, ChunkAssembler, nextChunkId, splitFrame } from '../../bridge/src/chunk.js';
import { isChunkFrame, parseFrame } from '../../bridge/src/protocol.js';

describe('splitFrame', () => {
  it('splits a large frame into ordered chunk frames that reassemble exactly', () => {
    const modules = { 'runtime/init': 'x'.repeat(600 * 1024) };
    const text = JSON.stringify({ v: 1, kind: 'bundle', hash: 'sha256-test', entry: 'runtime/init', modules });
    const chunks = splitFrame(text, 'c-1');
    expect(chunks.length).toBe(Math.ceil(text.length / CHUNK_DATA_CHARS));
    chunks.forEach((chunk, i) => {
      expect(chunk).toMatchObject({ v: 1, kind: 'chunk', cid: 'c-1', i, n: chunks.length });
      expect(chunk.data.length).toBeLessThanOrEqual(CHUNK_DATA_CHARS);
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(512 * 1024);
    });
    expect(chunks.map((c) => c.data).join('')).toBe(text);
  });

  it('never cuts a surrogate pair', () => {
    const text = `ab${'😀'.repeat(20)}`;
    const chunks = splitFrame(text, 'c-2', 3);
    for (const chunk of chunks) {
      expect(chunk.data).toBe(chunk.data.toWellFormed());
      expect(JSON.parse(JSON.stringify(chunk.data))).toBe(chunk.data);
    }
    expect(chunks.map((c) => c.data).join('')).toBe(text);
  });

  it('produces one empty chunk for an empty frame and unique cids', () => {
    expect(splitFrame('', 'c-3')).toEqual([{ v: 1, kind: 'chunk', cid: 'c-3', i: 0, n: 1, data: '' }]);
    const a = nextChunkId();
    const b = nextChunkId();
    expect(a).toMatch(/^c-\d+$/);
    expect(a).not.toBe(b);
  });
});

describe('ChunkAssembler', () => {
  const frame = JSON.stringify({ v: 1, kind: 'res', id: 'r-1', ok: true, body: { value: 'é'.repeat(50) } });

  it('returns the frame text only once every part has arrived, in any order', () => {
    const assembler = new ChunkAssembler();
    const chunks = splitFrame(frame, 'c-9', 16);
    expect(chunks.length).toBeGreaterThan(2);
    const [first, ...rest] = chunks;
    for (const chunk of rest.reverse()) expect(assembler.accept(chunk)).toBeNull();
    expect(assembler.pending).toBe(1);
    const text = assembler.accept(first!);
    expect(text).toBe(frame);
    expect(assembler.pending).toBe(0);
    const parsed = parseFrame(text!);
    expect(parsed?.kind).toBe('res');
  });

  it('accepts what the guard accepts and drops stale partials', () => {
    let now = 0;
    const assembler = new ChunkAssembler({ staleMs: 1000, now: () => now });
    const [a, b] = splitFrame(frame, 'c-10', 40);
    expect(isChunkFrame(a!)).toBe(true);
    expect(isChunkFrame({ kind: 'chunk', cid: 'x', i: 2, n: 2, data: '' })).toBe(false);
    assembler.accept(a!);
    now = 5000;
    // The sweep runs on the next accept; the stale partial is gone and this part starts a fresh one.
    expect(assembler.accept(b!)).toBeNull();
    expect(assembler.pending).toBe(1);
  });

  it('restarts when a cid is reused with a different part count and enforces a byte cap', () => {
    const assembler = new ChunkAssembler({ maxTotalBytes: 100 });
    assembler.accept({ v: 1, kind: 'chunk', cid: 'c-11', i: 0, n: 3, data: 'abc' });
    expect(assembler.accept({ v: 1, kind: 'chunk', cid: 'c-11', i: 0, n: 2, data: 'ab' })).toBeNull();
    expect(assembler.accept({ v: 1, kind: 'chunk', cid: 'c-11', i: 1, n: 2, data: 'cd' })).toBe('abcd');
    expect(() => assembler.accept({ v: 1, kind: 'chunk', cid: 'c-12', i: 0, n: 2, data: 'z'.repeat(101) })).toThrow(RangeError);
    expect(assembler.pending).toBe(0);
  });
});
