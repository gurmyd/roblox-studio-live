import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../bridge/src/log.js';
import { PERSIST_MAX_BYTES, PersistStore } from '../../bridge/src/persist.js';

describe('PersistStore (bridge-side persisted controllers)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-live-persist-'));
  });

  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('keeps entries per session, mirrors them to <dir>/<placeId>.json and reloads them in a fresh store', async () => {
    const store = new PersistStore(dir, silentLogger);
    expect(await store.attach('s1', 42)).toEqual([]);
    const file = path.join(dir, '42.json');
    expect(await store.remember('s1', 'client:1', 'walker', 'return {}')).toEqual({ stored: true, replaced: false, file });
    expect(await store.list('s1')).toEqual([{ dm: 'client:1', name: 'walker', bytes: 9, persist: true, source: 'bridge' }]);
    const onDisk = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toMatchObject({ v: 1, placeId: 42, controllers: [{ dm: 'client:1', name: 'walker', code: 'return {}' }] });

    // The same dm + name replaces; another dm with the same name is a separate entry (oldest first).
    expect((await store.remember('s1', 'client:1', 'walker', 'return 2')).replaced).toBe(true);
    await store.remember('s1', 'server', 'walker', 'return 3');
    expect((await store.controllers('s1')).map((e) => [e.dm, e.code])).toEqual([
      ['client:1', 'return 2'],
      ['server', 'return 3'],
    ]);

    // A later Studio on the same place (new session, fresh bridge) loads the file; other places and unknown sessions see nothing.
    const fresh = new PersistStore(dir, silentLogger);
    expect((await fresh.attach('s2', 42)).map((e) => `${e.dm}/${e.name}`)).toEqual(['client:1/walker', 'server/walker']);
    expect(await fresh.attach('s3', 43)).toEqual([]);
    expect(await fresh.controllers('nope')).toEqual([]);

    // forget removes exactly one entry; the file disappears once the list is empty.
    expect(await store.forget('s1', 'client:1', 'nope')).toBe(false);
    expect(await store.forget('s1', 'client:1', 'walker')).toBe(true);
    expect((await store.list('s1')).map((e) => e.dm)).toEqual(['server']);
    expect(await store.forget('s1', 'server', 'walker')).toBe(true);
    await expect(fsp.access(file)).rejects.toThrow();
    expect(await new PersistStore(dir, silentLogger).attach('s9', 42)).toEqual([]);
  });

  it('is memory-only without a place id or a directory, drops forgotten sessions and refuses the cap', async () => {
    const store = new PersistStore(dir, silentLogger);
    await store.attach('s4', 0);
    expect((await store.remember('s4', 'server', 'a', 'x')).file).toBeNull();
    expect(await store.list('s4')).toHaveLength(1);
    expect(store.fileFor(0)).toBeNull();
    expect(store.fileFor(undefined)).toBeNull();

    const memory = new PersistStore(null, silentLogger);
    expect(memory.fileFor(5)).toBeNull();
    // remember/forget work for a session that was never attached (tests, or a hub without a hello yet).
    expect((await memory.remember('s5', 'server', 'a', 'x')).stored).toBe(true);
    expect(await memory.list('s5')).toHaveLength(1);
    memory.forgetSession('s5');
    expect(await memory.list('s5')).toEqual([]);

    const huge = await memory.remember('s6', 'server', 'big', 'y'.repeat(PERSIST_MAX_BYTES));
    expect(huge.stored).toBe(false);
    expect(huge.note).toMatch(/not persisted/);
    expect(await memory.list('s6')).toEqual([]);
  });

  it('keeps the place file as the union of every session on that place (a twin never erases the original)', async () => {
    const store = new PersistStore(dir, silentLogger);
    const file = path.join(dir, '99.json');
    const names = async (): Promise<string[]> => ((JSON.parse(await fsp.readFile(file, 'utf8')) as { controllers: Array<{ dm: string; name: string; session?: string }> }).controllers).map((e) => `${e.dm}/${e.name}@${e.session ?? '-'}`);
    await store.attach('orig', 99);
    await store.remember('orig', 'client:1', 'walker', 'return 1');
    // The twin loads what the original stored, then adds its own entry: the file holds both, each tagged.
    expect((await store.attach('twin', 99)).map((e) => e.name)).toEqual(['walker']);
    await store.remember('twin', 'server', 'probe', 'return 2');
    expect(await names()).toEqual(['client:1/walker@orig', 'server/probe@twin']);
    // The twin's uninstall removes its entry only; its list can even go empty without the file going away.
    expect(await store.forget('twin', 'server', 'probe')).toBe(true);
    expect(await names()).toEqual(['client:1/walker@orig']);
    expect(await store.forget('twin', 'client:1', 'walker')).toBe(true);
    expect(await store.list('twin')).toEqual([]);
    expect(await names()).toEqual(['client:1/walker@orig']);
    // A forgotten session's entries stay in the file as orphans until the next session on the place adopts them.
    await store.remember('twin', 'server', 'late', 'return 3');
    store.forgetSession('twin');
    await store.remember('orig', 'client:1', 'walker', 'return 1b');
    expect(await names()).toEqual(['server/late@-', 'client:1/walker@orig']);
    expect((await store.attach('third', 99)).map((e) => `${e.dm}/${e.name}`)).toEqual(['server/late', 'client:1/walker']);
    await store.remember('third', 'server', 'late', 'return 3b');
    expect(await names()).toEqual(['client:1/walker@orig', 'server/late@third']);
    // Only the last session holding an entry removes it from disk.
    expect(await store.forget('orig', 'client:1', 'walker')).toBe(true);
    expect(await names()).toEqual(['client:1/walker@third', 'server/late@third']);
    await store.forget('third', 'client:1', 'walker');
    await store.forget('third', 'server', 'late');
    await expect(fsp.access(file)).rejects.toThrow();
  });

  it('says so when the mirror write fails instead of advertising a file', async () => {
    const blocked = path.join(dir, 'blocked');
    await fsp.writeFile(blocked, 'not a directory', 'utf8');
    const store = new PersistStore(blocked, silentLogger);
    await store.attach('s10', 5);
    const result = await store.remember('s10', 'server', 'a', 'x');
    expect(result).toMatchObject({ stored: true, file: null, note: expect.stringMatching(/not mirrored to disk/) });
    expect(await store.list('s10')).toHaveLength(1);
  });

  it('tolerates a BOM, skips malformed entries and ignores a corrupt file', async () => {
    await fsp.writeFile(path.join(dir, '77.json'), '\uFEFF{"v":1,"controllers":[{"dm":"server","name":"ok","code":"1"},{"bad":true}]}', 'utf8');
    await fsp.writeFile(path.join(dir, '78.json'), '{nope', 'utf8');
    const store = new PersistStore(dir, silentLogger);
    expect((await store.attach('s7', 77)).map((e) => e.name)).toEqual(['ok']);
    expect(await store.attach('s8', 78)).toEqual([]);
    // Re-attaching the same session to another place re-binds it.
    expect((await store.attach('s8', 77)).map((e) => e.name)).toEqual(['ok']);
    // Entries remembered before the session announced its place carry over the hello and win over the file's.
    await store.remember('early', 'server', 'ok', 'from-memory');
    await store.remember('early', 'client:1', 'extra', 'x');
    expect((await store.attach('early', 77)).map((e) => `${e.dm}/${e.name}/${e.code}`)).toEqual(['server/ok/from-memory', 'client:1/extra/x']);
  });
});
