import { describe, expect, it } from 'vitest';
import { FETCH_PROGRAM, LIST_PROGRAM, PUSH_PROGRAM, fetchRunArgs, listRunArgs, pushBatchBytes, pushRunArgs, splitBatches, type PushItem } from '../../bridge/src/sync/luau.js';
import { hashSource, normalizeSource } from '../../bridge/src/sync/state.js';

function item(rel: string, src: string, extra: Partial<PushItem> = {}): PushItem {
  return { rel, service: 'ServerScriptService', parents: [], name: rel.replace(/\..*$/, ''), class: 'Script', src, prev: null, ...extra };
}

describe('hashSource / normalizeSource', () => {
  it('folds CRLF to LF and strips a BOM before hashing', () => {
    expect(normalizeSource('a\r\nb\r\n')).toBe('a\nb\n');
    expect(normalizeSource('﻿print(1)')).toBe('print(1)');
    expect(hashSource(normalizeSource('a\r\nb'))).toBe(hashSource('a\nb'));
  });

  it('matches the Luau formula: <utf8 length>-<Σ (h*31+byte) mod 2^32>', () => {
    // Computed by hand: "ab" → h = (0*31+97)*31+98 = 3105
    expect(hashSource('ab')).toBe('2-3105');
    expect(hashSource('')).toBe('0-0');
    // 'é' is two UTF-8 bytes (0xC3 0xA9): (195*31)+169 = 6214
    expect(hashSource('é')).toBe('2-6214');
    // Stays exact past 2^32 wrap-around (no float drift): 200 'z' bytes.
    let h = 0;
    for (let i = 0; i < 200; i += 1) h = (h * 31 + 122) % 4294967296;
    expect(hashSource('z'.repeat(200))).toBe(`200-${h}`);
  });
});

describe('push program', () => {
  it('sets sources through S.script.set, creates scripts with S.script.create and parents with Instance.new', () => {
    expect(PUSH_PROGRAM).toContain('S.script.set(inst, src)');
    expect(PUSH_PROGRAM).toContain('S.script.set(fresh, src)');
    expect(PUSH_PROGRAM).toContain('S.script.create(it.class, it.name, parent, src)');
    expect(PUSH_PROGRAM).toContain('pcall(Instance.new, spec.class)');
    expect(PUSH_PROGRAM).toContain('parent:FindFirstChild(spec.name)');
    expect(PUSH_PROGRAM).toContain('pcall(game.GetService, game, it.service)');
    expect(PUSH_PROGRAM).toContain('return R');
    // Conflict detection compares the hash recorded at the last sync with what Studio holds now.
    expect(PUSH_PROGRAM).toContain('if hash(cur) ~= it.prev then');
    // The Luau hash mirrors state.ts exactly.
    expect(PUSH_PROGRAM).toContain('h = (h * 31 + a) % 4294967296');
    expect(PUSH_PROGRAM).toContain('string.format("%d-%d", n, h)');
    expect(PUSH_PROGRAM).toContain('string.gsub(s, "\\r\\n", "\\n")');
  });

  it('builds one run per batch with the sync undo label and the items in ARGS', () => {
    const items = [item('Main.server.luau', 'print(1)\n', { prev: '9-1' }), item('Util.luau', 'return {}\n', { class: 'ModuleScript', parents: [{ name: 'Lib', class: 'Folder' }] })];
    const args = pushRunArgs(items);
    expect(args).toMatchObject({ code: PUSH_PROGRAM, dm: 'edit', undo_label: 'sync: 2 file(s)' });
    expect(args.args).toEqual({ op: 'push', items });
    expect((args.args as { items: PushItem[] }).items[1]?.parents).toEqual([{ name: 'Lib', class: 'Folder' }]);
  });

  it('splits batches at the byte cap and never splits a single file', () => {
    const big = 'x'.repeat(150 * 1024);
    const items = [item('A.server.luau', big), item('B.server.luau', big), item('C.server.luau', big), item('D.server.luau', 'small')];
    const batches = splitBatches(items, 400 * 1024);
    expect(batches.map((b) => b.map((i) => i.rel))).toEqual([['A.server.luau', 'B.server.luau'], ['C.server.luau', 'D.server.luau']]);
    for (const batch of batches) expect(pushBatchBytes(batch)).toBeLessThanOrEqual(400 * 1024);
    const huge = [item('Huge.server.luau', 'y'.repeat(500 * 1024)), item('Tiny.luau', 'z')];
    expect(splitBatches(huge, 400 * 1024).map((b) => b.length)).toEqual([1, 1]);
    expect(splitBatches([], 400 * 1024)).toEqual([]);
  });
});

describe('pull programs', () => {
  it('list pages with offset/limit ≤ 200 and skips Studio-internal services', () => {
    expect(LIST_PROGRAM).toContain('CoreGui = true');
    expect(LIST_PROGRAM).toContain('d:IsA("LuaSourceContainer")');
    expect(LIST_PROGRAM).toContain('return { total = total, items = items }');
    expect(listRunArgs(400)).toMatchObject({ code: LIST_PROGRAM, dry_run: true, response_format: 'detailed', args: { op: 'list', offset: 400, limit: 200 } });
    expect((listRunArgs(0, 999).args as { limit: number }).limit).toBe(999);
    expect(LIST_PROGRAM).toContain('math.min(200, tonumber(ARGS.limit) or 200)');
  });

  it('fetch returns UTF-8-safe slices under a byte budget', () => {
    expect(FETCH_PROGRAM).toContain('if b >= 0x80 and b < 0xC0 then');
    expect(FETCH_PROGRAM).toContain('eof = pos > len');
    expect(fetchRunArgs([{ n: ['ServerScriptService', 'Main'] }, { n: ['ReplicatedStorage', 'X'], from: 4001 }], 8000, 2000)).toMatchObject({
      code: FETCH_PROGRAM,
      dry_run: true,
      response_format: 'detailed',
      args: { op: 'fetch', reqs: [{ n: ['ServerScriptService', 'Main'] }, { n: ['ReplicatedStorage', 'X'], from: 4001 }], budget: 8000, part: 2000 },
    });
  });
});
