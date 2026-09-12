import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYNC_TUNING, startSync, type SyncHandle } from '../../bridge/src/sync/index.js';
import { STATE_FILE, hashSource } from '../../bridge/src/sync/state.js';
import { startFakeBridge, type FakeBridge } from './fake-bridge.js';

const saved = { ...SYNC_TUNING };
const cleanups: Array<() => Promise<void>> = [];
let dir: string;

beforeEach(async () => {
  Object.assign(SYNC_TUNING, { debounceMs: 60, pollMs: 80, fsPollMs: 100, retryBudgetMs: 1500, retryBaseMs: 20, retryMaxMs: 60 });
  dir = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-live-sync-pull-')), 'project');
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  Object.assign(SYNC_TUNING, saved);
  await fsp.rm(path.dirname(dir), { recursive: true, force: true });
});

async function fake(): Promise<FakeBridge> {
  const b = await startFakeBridge();
  cleanups.push(() => b.close());
  return b;
}

function track(handle: SyncHandle): SyncHandle {
  cleanups.push(() => handle.stop());
  return handle;
}

async function read(rel: string): Promise<string | null> {
  try {
    return await fsp.readFile(path.join(dir, ...rel.split('/')), 'utf8');
  } catch {
    return null;
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fetchCalls(bridge: FakeBridge): number {
  return bridge.calls.filter((c) => c.tool === 'run' && (c.args.args as { op?: string })?.op === 'fetch').length;
}

describe('pull mode', () => {
  it('writes every script into the layout with LF endings and records the state', async () => {
    const bridge = await fake();
    const s = bridge.studio;
    s.put(['ServerScriptService', 'Main'], 'Script', 'print("main")\r\nprint(2)\r\n');
    s.put(['ServerScriptService', 'Game'], 'Script', 'game\n');
    s.put(['ServerScriptService', 'Game', 'Combat'], 'ModuleScript', 'return {}\n');
    s.put(['ReplicatedStorage', 'Shared', 'Types'], 'ModuleScript', 'types ünïcödé\n');
    s.put(['StarterPlayer', 'StarterPlayerScripts', 'Hud'], 'LocalScript', 'hud\n');
    s.put(['Workspace', 'Door', 'DoorScript'], 'Script', 'door\n');
    s.service('CoreGui').children.push({ name: 'Internal', class: 'LocalScript', source: 'nope', children: [] });
    const lines: string[] = [];
    const handle = track(await startSync({ dir, port: bridge.port, pull: true, once: true, log: (l) => lines.push(l) }));

    expect(await read('ServerScriptService/Main.server.luau')).toBe('print("main")\nprint(2)\n');
    expect(await read('ServerScriptService/Game/init.server.luau')).toBe('game\n');
    expect(await read('ServerScriptService/Game/Combat.luau')).toBe('return {}\n');
    expect(await read('ReplicatedStorage/Shared/Types.luau')).toBe('types ünïcödé\n');
    expect(await read('StarterPlayer/StarterPlayerScripts/Hud.client.luau')).toBe('hud\n');
    expect(await read('Workspace/Door/DoorScript.server.luau')).toBe('door\n');
    expect(await read('CoreGui/Internal.client.luau')).toBeNull();
    const state = JSON.parse(await fsp.readFile(path.join(dir, STATE_FILE), 'utf8')) as { files: Record<string, { hash: string; mtime: number }> };
    expect(Object.keys(state.files)).toHaveLength(6);
    expect(state.files['ServerScriptService/Main.server.luau']?.hash).toBe(hashSource('print("main")\nprint(2)\n'));
    expect(handle.stats()).toMatchObject({ pulled: 6, pushed: 0, errors: 0 });
    expect(bridge.calls.filter((c) => c.tool === 'run').every((c) => c.args.dry_run === true && c.args.response_format === 'detailed')).toBe(true);

    // A second one-shot pull has nothing to do.
    bridge.calls.length = 0;
    track(await startSync({ dir, port: bridge.port, pull: true, once: true, log: () => undefined }));
    expect(fetchCalls(bridge)).toBe(0);
  });

  it('pages large sources across fetch calls without truncation', async () => {
    const bridge = await fake();
    const big = Array.from({ length: 3000 }, (_, i) => `local v${i} = "é${i}"`).join('\n') + '\n';
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(24_000 * 2);
    bridge.studio.put(['ServerScriptService', 'Big'], 'Script', big);
    bridge.studio.put(['ServerScriptService', 'Small'], 'Script', 'small\n');
    const lines: string[] = [];
    track(await startSync({ dir, port: bridge.port, pull: true, once: true, log: (l) => lines.push(l) }));
    expect(await read('ServerScriptService/Big.server.luau')).toBe(big);
    expect(await read('ServerScriptService/Small.server.luau')).toBe('small\n');
    expect(fetchCalls(bridge)).toBeGreaterThan(2);
    expect(lines.some((l) => /checksum computed in Studio/.test(l))).toBe(false);
  });

  it('shrinks its page when the bridge truncates a result', async () => {
    const bridge = await fake();
    bridge.studio.put(['ServerScriptService', 'A'], 'Script', 'a'.repeat(9000));
    let mangled = 0;
    bridge.mangle = (_tool, body) => {
      const a = body.value as { items?: Array<{ parts?: string[] }> } | undefined;
      const budget = (bridge.calls[bridge.calls.length - 1]?.args.args as { budget?: number })?.budget ?? 0;
      if (a?.items?.[0]?.parts && budget > 6000) {
        mangled += 1;
        const parts = a.items[0].parts;
        parts[parts.length - 1] = `${parts[parts.length - 1]?.slice(0, 100)}…[+3900 chars]`;
      }
      return body;
    };
    const lines: string[] = [];
    track(await startSync({ dir, port: bridge.port, pull: true, once: true, log: (l) => lines.push(l) }));
    expect(mangled).toBeGreaterThan(0);
    expect(await read('ServerScriptService/A.server.luau')).toBe('a'.repeat(9000));
    expect(lines.some((l) => /truncated by the bridge; retrying with \d+-byte pages/.test(l))).toBe(true);
  });

  it('never skips scripts when the bridge truncates a listing page', async () => {
    const bridge = await fake();
    for (let i = 0; i < 150; i += 1) bridge.studio.put(['ReplicatedStorage', 'Packages', '_Index', `author_pkg@1.0.${i}`, 'src', `M${i}`], 'ModuleScript', `return ${i}\n`);
    let mangled = 0;
    // What result.ts's shrinkToBudget does to a 200-item page of long name chains: 100 items, a marker, truncated: true.
    bridge.mangle = (_tool, body) => {
      const value = body.value as { items?: unknown[]; total?: number } | undefined;
      const op = (bridge.calls[bridge.calls.length - 1]?.args.args as { op?: string; limit?: number })?.op;
      if (op === 'list' && value?.items && value.items.length > 100) {
        mangled += 1;
        value.items = [...value.items.slice(0, 100), `…[+${value.items.length - 100} more]`];
        (value as { truncated?: boolean }).truncated = true;
      }
      return body;
    };
    const lines: string[] = [];
    const handle = track(await startSync({ dir, port: bridge.port, pull: true, once: true, log: (l) => lines.push(l) }));
    expect(mangled).toBeGreaterThan(0);
    expect(handle.stats()).toMatchObject({ pulled: 150, errors: 0 });
    for (let i = 0; i < 150; i += 1) expect(await read(`ReplicatedStorage/Packages/_Index/author_pkg@1.0.${i}/src/M${i}.luau`)).toBe(`return ${i}\n`);
    expect(lines.some((l) => /listing page was truncated by the bridge; retrying with 100-item pages/.test(l))).toBe(true);
    const lists = bridge.calls.filter((c) => c.tool === 'run' && (c.args.args as { op?: string }).op === 'list').map((c) => c.args.args as { offset: number; limit: number });
    expect(lists).toEqual([
      { op: 'list', offset: 0, limit: 200 },
      { op: 'list', offset: 0, limit: 100 },
      { op: 'list', offset: 100, limit: 100 },
    ]);
  });

  it('keeps polling and pulls changed, added and class-changed scripts', async () => {
    const bridge = await fake();
    bridge.studio.put(['ServerScriptService', 'Main'], 'Script', 'v1\n');
    const lines: string[] = [];
    const handle = track(await startSync({ dir, port: bridge.port, pull: true, log: (l) => lines.push(l) }));
    expect(await read('ServerScriptService/Main.server.luau')).toBe('v1\n');

    bridge.studio.put(['ServerScriptService', 'Main'], 'Script', 'v2\n');
    bridge.studio.put(['ReplicatedStorage', 'New'], 'ModuleScript', 'new\n');
    await waitFor(async () => (await read('ServerScriptService/Main.server.luau')) === 'v2\n' && (await read('ReplicatedStorage/New.luau')) === 'new\n');

    // Same-length edit (mtime-independent: the checksum decides).
    bridge.studio.put(['ServerScriptService', 'Main'], 'Script', 'v3\n');
    await waitFor(async () => (await read('ServerScriptService/Main.server.luau')) === 'v3\n');

    // A script that gains a child script moves to the init form; the stale flat file is reported.
    bridge.studio.put(['ServerScriptService', 'Main', 'Child'], 'ModuleScript', 'child\n');
    await waitFor(async () => (await read('ServerScriptService/Main/init.server.luau')) === 'v3\n' && (await read('ServerScriptService/Main/Child.luau')) === 'child\n');
    await waitFor(() => lines.some((l) => /WARN ServerScriptService\/Main\.server\.luau is stale/.test(l)));

    // Removal in Studio keeps the file and says so once.
    bridge.studio.service('ReplicatedStorage').children.length = 0;
    await waitFor(() => lines.some((l) => /WARN ReplicatedStorage\/New\.luau: the script no longer exists in Studio/.test(l)));
    await new Promise((r) => setTimeout(r, SYNC_TUNING.pollMs * 3));
    expect(lines.filter((l) => /ReplicatedStorage\/New\.luau: the script no longer exists/.test(l))).toHaveLength(1);
    expect(await read('ReplicatedStorage/New.luau')).toBe('new\n');
    expect(handle.stats().pulled).toBe(6);
    expect(handle.stats().errors).toBe(0);
  });

  it('lets Studio win conflicts in pull mode and leaves local-only edits alone', async () => {
    const bridge = await fake();
    bridge.studio.put(['ServerScriptService', 'A'], 'Script', 'a1\n');
    bridge.studio.put(['ServerScriptService', 'B'], 'Script', 'b1\n');
    const lines: string[] = [];
    track(await startSync({ dir, port: bridge.port, pull: true, once: true, log: (l) => lines.push(l) }));

    await fsp.writeFile(path.join(dir, 'ServerScriptService', 'A.server.luau'), 'a-local\n');
    await fsp.writeFile(path.join(dir, 'ServerScriptService', 'B.server.luau'), 'b-local\n');
    bridge.studio.put(['ServerScriptService', 'A'], 'Script', 'a2\n');
    track(await startSync({ dir, port: bridge.port, pull: true, once: true, log: (l) => lines.push(l) }));
    expect(lines.filter((l) => /WARN conflict: ServerScriptService\/A\.server\.luau .*Studio's version wins/.test(l))).toHaveLength(1);
    expect(await read('ServerScriptService/A.server.luau')).toBe('a2\n');
    expect(await read('ServerScriptService/B.server.luau')).toBe('b-local\n');
    expect(lines.some((l) => /B\.server\.luau/.test(l) && /WARN/.test(l))).toBe(false);
  });

  it('falls back from dry_run while a playtest is running and reports unmappable names', async () => {
    const bridge = await fake();
    bridge.studio.playtestRunning = true;
    bridge.studio.put(['ServerScriptService', 'Main'], 'Script', 'v1\n');
    bridge.studio.put(['ServerScriptService', 'bad:name'], 'Script', 'x\n');
    const lines: string[] = [];
    const handle = track(await startSync({ dir, port: bridge.port, pull: true, once: true, log: (l) => lines.push(l) }));
    expect(await read('ServerScriptService/Main.server.luau')).toBe('v1\n');
    expect(bridge.calls.some((c) => c.tool === 'run' && c.args.dry_run === false)).toBe(true);
    expect(lines.some((l) => /WARN cannot map ServerScriptService\.bad:name to a file/.test(l))).toBe(true);
    expect(handle.stats()).toMatchObject({ pulled: 1, errors: 0 });
  });

  it('fails a one-shot pull cleanly when the bridge is unreachable and creates the directory otherwise', async () => {
    const bridge = await fake();
    const port = bridge.port;
    await bridge.pause();
    await expect(startSync({ dir, port, pull: true, once: true, log: () => undefined })).rejects.toThrow(/initial pull failed/);
    await bridge.listen();
    bridge.studio.put(['ServerScriptService', 'Main'], 'Script', 'v1\n');
    track(await startSync({ dir, port, pull: true, once: true, log: () => undefined }));
    expect(await read('ServerScriptService/Main.server.luau')).toBe('v1\n');
  });
});
