import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYNC_TUNING, startSync, type SyncHandle } from '../../bridge/src/sync/index.js';
import type { PushItem } from '../../bridge/src/sync/luau.js';
import { STATE_FILE, hashSource } from '../../bridge/src/sync/state.js';
import { startFakeBridge, type FakeBridge } from './fake-bridge.js';

const saved = { ...SYNC_TUNING };
const cleanups: Array<() => Promise<void>> = [];
let dir: string;

beforeEach(async () => {
  Object.assign(SYNC_TUNING, { debounceMs: 60, pollMs: 100, fsPollMs: 100, retryBudgetMs: 1500, retryBaseMs: 20, retryMaxMs: 60 });
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-live-sync-push-'));
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  Object.assign(SYNC_TUNING, saved);
  await fsp.rm(dir, { recursive: true, force: true });
});

async function fake(): Promise<FakeBridge> {
  const b = await startFakeBridge();
  cleanups.push(() => b.close());
  return b;
}

async function write(rel: string, text: string): Promise<void> {
  const abs = path.join(dir, ...rel.split('/'));
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, text, 'utf8');
}

function track(handle: SyncHandle): SyncHandle {
  cleanups.push(() => handle.stop());
  return handle;
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function runCalls(bridge: FakeBridge): PushItem[][] {
  return bridge.calls.filter((c) => c.tool === 'run' && (c.args.args as { op?: string })?.op === 'push').map((c) => (c.args.args as { items: PushItem[] }).items);
}

describe('push mode', () => {
  it('pushes the initial tree in one run (right classes, parents, init convention) and records the state', async () => {
    const bridge = await fake();
    await write('ServerScriptService/Main.server.luau', 'print("main")\r\n');
    await write('ServerScriptService/Game/init.server.luau', 'print("game")\n');
    await write('ServerScriptService/Game/Combat.luau', 'return {}\n');
    await write('ReplicatedStorage/Shared/Types.luau', 'export type T = number\n');
    await write('StarterPlayer/StarterPlayerScripts/Input.client.luau', 'print("client")\n');
    await write('ServerScriptService/README.md', 'ignored\n');
    await write('.git/HEAD', 'ignored\n');
    const lines: string[] = [];
    const handle = track(await startSync({ dir, port: bridge.port, once: true, log: (l) => lines.push(l) }));

    const pushes = runCalls(bridge);
    expect(pushes).toHaveLength(1);
    const run = bridge.calls.find((c) => c.tool === 'run');
    expect(run?.args).toMatchObject({ undo_label: 'sync: 5 file(s)', dm: 'edit' });
    const items = pushes[0] as PushItem[];
    expect(items.map((i) => i.rel)).toEqual([
      'ServerScriptService/Game/init.server.luau',
      'ServerScriptService/Main.server.luau',
      'ReplicatedStorage/Shared/Types.luau',
      'ServerScriptService/Game/Combat.luau',
      'StarterPlayer/StarterPlayerScripts/Input.client.luau',
    ]);
    expect(items.find((i) => i.rel === 'ServerScriptService/Main.server.luau')?.src).toBe('print("main")\n');
    expect(items.find((i) => i.rel === 'ServerScriptService/Game/Combat.luau')?.parents).toEqual([{ name: 'Game', class: 'Script' }]);

    const studio = bridge.studio;
    expect(studio.find(['ServerScriptService', 'Main'])).toMatchObject({ class: 'Script', source: 'print("main")\n' });
    expect(studio.find(['ServerScriptService', 'Game'])).toMatchObject({ class: 'Script', source: 'print("game")\n' });
    expect(studio.find(['ServerScriptService', 'Game', 'Combat'])).toMatchObject({ class: 'ModuleScript' });
    expect(studio.find(['ReplicatedStorage', 'Shared'])).toMatchObject({ class: 'Folder' });
    expect(studio.find(['StarterPlayer', 'StarterPlayerScripts', 'Input'])).toMatchObject({ class: 'LocalScript' });
    expect(studio.find(['ServerScriptService', 'README'])).toBeNull();

    const state = JSON.parse(await fsp.readFile(path.join(dir, STATE_FILE), 'utf8')) as { files: Record<string, { hash: string }> };
    expect(Object.keys(state.files).sort()).toEqual(items.map((i) => i.rel).sort());
    expect(state.files['ServerScriptService/Main.server.luau']?.hash).toBe(hashSource('print("main")\n'));
    expect(handle.stats()).toMatchObject({ pushed: 5, pulled: 0, errors: 0 });
    expect(lines.some((l) => /pushed 5 file\(s\)/.test(l))).toBe(true);
    // Not a playtest: no hotpatch, but the status was checked once.
    expect(bridge.calls.filter((c) => c.tool === 'playtest')).toHaveLength(0);
  });

  it('debounces bursts of edits into one run and only ships files whose content changed', async () => {
    const bridge = await fake();
    // A generous quiet period keeps the burst below it even when the suites run in parallel.
    SYNC_TUNING.debounceMs = 200;
    await write('ServerScriptService/A.server.luau', 'a1\n');
    await write('ServerScriptService/B.server.luau', 'b1\n');
    track(await startSync({ dir, port: bridge.port, log: () => undefined }));
    expect(runCalls(bridge)).toHaveLength(1);

    await write('ServerScriptService/A.server.luau', 'a2\n');
    await write('ServerScriptService/B.server.luau', 'b2\n');
    await write('ServerScriptService/C.server.luau', 'c1\n');
    await waitFor(() => runCalls(bridge).length >= 2);
    await new Promise((r) => setTimeout(r, SYNC_TUNING.debounceMs * 3));
    const pushes = runCalls(bridge);
    expect(pushes).toHaveLength(2);
    expect((pushes[1] as PushItem[]).map((i) => [i.rel, i.src]).sort()).toEqual([
      ['ServerScriptService/A.server.luau', 'a2\n'],
      ['ServerScriptService/B.server.luau', 'b2\n'],
      ['ServerScriptService/C.server.luau', 'c1\n'],
    ]);
    expect(bridge.studio.find(['ServerScriptService', 'C'])?.source).toBe('c1\n');

    // Touching a file without changing its content pushes nothing.
    await write('ServerScriptService/A.server.luau', 'a2\n');
    await new Promise((r) => setTimeout(r, SYNC_TUNING.debounceMs * 4));
    expect(runCalls(bridge)).toHaveLength(2);
  });

  it('warns about deletions instead of propagating them', async () => {
    const bridge = await fake();
    await write('ServerScriptService/Gone.server.luau', 'x\n');
    await write('ServerScriptService/Stay.server.luau', 'y\n');
    const lines: string[] = [];
    track(await startSync({ dir, port: bridge.port, log: (l) => lines.push(l) }));
    await fsp.rm(path.join(dir, 'ServerScriptService', 'Gone.server.luau'));
    await write('ServerScriptService/Stay.server.luau', 'y2\n');
    await waitFor(() => lines.some((l) => /WARN deleted on disk: ServerScriptService\/Gone\.server\.luau/.test(l)));
    await waitFor(() => runCalls(bridge).length >= 2);
    expect(bridge.studio.find(['ServerScriptService', 'Gone'])).not.toBeNull();
    expect((runCalls(bridge)[1] as PushItem[]).map((i) => i.rel)).toEqual(['ServerScriptService/Stay.server.luau']);
  });

  it('resolves conflicts in favour of the disk and names the file', async () => {
    const bridge = await fake();
    await write('ServerScriptService/Main.server.luau', 'v1\n');
    const lines: string[] = [];
    track(await startSync({ dir, port: bridge.port, once: true, log: (l) => lines.push(l) }));
    expect(lines.some((l) => /WARN conflict/.test(l))).toBe(false);

    // Studio edits the script behind our back, then the file changes too.
    bridge.studio.put(['ServerScriptService', 'Main'], 'Script', 'studio edit\n');
    await write('ServerScriptService/Main.server.luau', 'v2\n');
    track(await startSync({ dir, port: bridge.port, once: true, log: (l) => lines.push(l) }));
    expect(lines.filter((l) => /WARN conflict: ServerScriptService\/Main\.server\.luau/.test(l))).toHaveLength(1);
    expect(bridge.studio.find(['ServerScriptService', 'Main'])?.source).toBe('v2\n');

    // A pre-existing Studio script with no sync record is reported as overwritten, not as a conflict.
    bridge.studio.put(['ReplicatedStorage', 'Old'], 'ModuleScript', 'old\n');
    await write('ReplicatedStorage/Old.luau', 'new\n');
    lines.length = 0;
    track(await startSync({ dir, port: bridge.port, once: true, log: (l) => lines.push(l) }));
    expect(lines.some((l) => /no sync record.*ReplicatedStorage\/Old\.luau/.test(l))).toBe(true);
    expect(lines.some((l) => /WARN conflict/.test(l))).toBe(false);
  });

  it('splits big batches at 400 KB per program', async () => {
    const bridge = await fake();
    const big = `${'-- '.repeat(1)}${'x'.repeat(150 * 1024)}\n`;
    await write('ServerScriptService/A.server.luau', big);
    await write('ServerScriptService/B.server.luau', big);
    await write('ServerScriptService/C.server.luau', big);
    const handle = track(await startSync({ dir, port: bridge.port, once: true, log: () => undefined }));
    const pushes = runCalls(bridge);
    expect(pushes.map((p) => p.length)).toEqual([2, 1]);
    expect(bridge.calls.filter((c) => c.tool === 'run').map((c) => c.args.undo_label)).toEqual(['sync: 2 file(s)', 'sync: 1 file(s)']);
    expect(handle.stats().pushed).toBe(3);
  });

  it('follows a job handle instead of re-sending the batch, and never counts it as an error', async () => {
    const bridge = await fake();
    bridge.deferRuns = 1;
    bridge.deferPolls = 2;
    await write('ServerScriptService/Main.server.luau', 'v1\n');
    await write('ReplicatedStorage/Shared.luau', 'return 1\n');
    const lines: string[] = [];
    const handle = track(await startSync({ dir, port: bridge.port, once: true, log: (l) => lines.push(l) }));
    // Exactly one run reached the bridge; the sync waited on the job (running twice, then done).
    expect(runCalls(bridge)).toHaveLength(1);
    const waits = bridge.calls.filter((c) => c.tool === 'job');
    expect(waits.map((c) => c.args.action)).toEqual(['wait', 'wait', 'wait']);
    expect(waits[0]?.args).toMatchObject({ job_id: 'r-fake00-1', wait_ms: 25_000 });
    expect(bridge.studio.find(['ServerScriptService', 'Main'])?.source).toBe('v1\n');
    expect(handle.stats()).toMatchObject({ pushed: 2, errors: 0 });
    expect(lines.some((l) => /still running in Studio as job r-fake00-1; waiting for it/.test(l))).toBe(true);
    expect(lines.some((l) => /ERROR/.test(l))).toBe(false);
    expect(lines.some((l) => /pushed 2 file\(s\)/.test(l))).toBe(true);
    const state = JSON.parse(await fsp.readFile(path.join(dir, STATE_FILE), 'utf8')) as { files: Record<string, unknown> };
    expect(Object.keys(state.files).sort()).toEqual(['ReplicatedStorage/Shared.luau', 'ServerScriptService/Main.server.luau']);
    expect(bridge.cancelled).toEqual([]);

    // A watched sync that is stopped while a job is pending cancels it so nothing stays queued in Studio.
    const live = await startSync({ dir, port: bridge.port, log: () => undefined });
    bridge.deferRuns = 1;
    bridge.deferPolls = 1_000_000;
    await write('ServerScriptService/Main.server.luau', 'v2\n');
    await waitFor(() => bridge.calls.some((c) => c.tool === 'job' && c.args.job_id === 'r-fake00-2'));
    await live.stop();
    await waitFor(() => bridge.cancelled.includes('r-fake00-2'));
  });

  it('caps a program at 500 items so every outcome is recorded', async () => {
    const bridge = await fake();
    for (let i = 0; i < 600; i += 1) await write(`ReplicatedStorage/Packages/M${String(i).padStart(3, '0')}.luau`, `return ${i}\n`);
    const lines: string[] = [];
    const handle = track(await startSync({ dir, port: bridge.port, once: true, log: (l) => lines.push(l) }));
    const pushes = runCalls(bridge);
    expect(pushes.map((p) => p.length)).toEqual([500, 100]);
    expect(handle.stats()).toMatchObject({ pushed: 600, errors: 0 });
    const state = JSON.parse(await fsp.readFile(path.join(dir, STATE_FILE), 'utf8')) as { files: Record<string, unknown> };
    expect(Object.keys(state.files)).toHaveLength(600);
    expect(lines.some((l) => /WARN|ERROR/.test(l))).toBe(false);

    // A result the bridge still truncated (marker + missing outcomes) is re-checked at once, not lost.
    bridge.calls.length = 0;
    bridge.mangle = (_tool, body) => {
      const value = body.value as { outcomes?: unknown[] } | undefined;
      if (value?.outcomes && value.outcomes.length > 300) {
        value.outcomes = [...value.outcomes.slice(0, 300), `…[+${value.outcomes.length - 300} more]`];
        (value as { truncated?: boolean }).truncated = true;
      }
      return body;
    };
    for (let i = 0; i < 600; i += 1) await write(`ReplicatedStorage/Packages/M${String(i).padStart(3, '0')}.luau`, `return ${i + 1}\n`);
    lines.length = 0;
    const again = track(await startSync({ dir, port: bridge.port, once: true, log: (l) => lines.push(l) }));
    expect(runCalls(bridge).map((p) => p.length)).toEqual([500, 200, 100]);
    expect(again.stats()).toMatchObject({ pushed: 600, errors: 0 });
    expect(lines.filter((l) => /WARN push result was truncated: 200 of 500 outcome/.test(l))).toHaveLength(1);
    const after = JSON.parse(await fsp.readFile(path.join(dir, STATE_FILE), 'utf8')) as { files: Record<string, { hash: string }> };
    expect(Object.keys(after.files)).toHaveLength(600);
    expect(after.files['ReplicatedStorage/Packages/M599.luau']?.hash).toBe(hashSource('return 600\n'));
  });

  it('hot-patches server-side scripts into a running playtest and explains why client scripts are not', async () => {
    const bridge = await fake();
    bridge.studio.playtestRunning = true;
    bridge.studio.serverScripts.add('ServerScriptService.Main');
    bridge.studio.serverScripts.add('ReplicatedStorage.Module');
    await write('ServerScriptService/Main.server.luau', 'server\n');
    await write('ReplicatedStorage/Module.luau', 'return 1\n');
    await write('StarterPlayer/StarterPlayerScripts/Hud.client.luau', 'client\n');
    await write('ServerStorage/Later.server.luau', 'not in play dm\n');
    const lines: string[] = [];
    track(await startSync({ dir, port: bridge.port, once: true, log: (l) => lines.push(l) }));

    const patches = bridge.calls.filter((c) => c.tool === 'playtest');
    expect(patches.map((c) => c.args.path).sort()).toEqual(['ReplicatedStorage.Module', 'ServerScriptService.Main', 'ServerStorage.Later']);
    expect(patches.find((c) => c.args.path === 'ServerScriptService.Main')?.args).toMatchObject({ action: 'hotpatch', dm: 'server', source: 'server\n', restart: true });
    expect(lines.some((l) => /hotpatched ServerScriptService\.Main in the play server/.test(l))).toBe(true);
    expect(lines.some((l) => /hotpatched ReplicatedStorage\.Module.*require cache unaffected/.test(l))).toBe(true);
    expect(lines.some((l) => /WARN hotpatch ServerStorage\.Later failed/.test(l))).toBe(true);
    expect(lines.some((l) => /1 client-side script\(s\) not hot-applied.*Hud\.client\.luau/.test(l))).toBe(true);
    expect(bridge.calls.filter((c) => c.tool === 'observe')).toHaveLength(1);
  });

  it('never hot-patches when hotpatch is false, and never when nothing changed', async () => {
    const bridge = await fake();
    bridge.studio.playtestRunning = true;
    bridge.studio.serverScripts.add('ServerScriptService.Main');
    await write('ServerScriptService/Main.server.luau', 'server\n');
    track(await startSync({ dir, port: bridge.port, once: true, hotpatch: false, log: () => undefined }));
    expect(bridge.calls.filter((c) => c.tool === 'playtest' || c.tool === 'observe')).toHaveLength(0);

    track(await startSync({ dir, port: bridge.port, once: true, log: () => undefined }));
    expect(bridge.calls.filter((c) => c.tool === 'playtest')).toHaveLength(0);
  });

  it('keeps edits queued while the bridge is down and pushes them when it returns', async () => {
    const bridge = await fake();
    await write('ServerScriptService/Main.server.luau', 'v1\n');
    const lines: string[] = [];
    const handle = track(await startSync({ dir, port: bridge.port, log: (l) => lines.push(l) }));
    expect(runCalls(bridge)).toHaveLength(1);

    await bridge.pause();
    await write('ServerScriptService/Main.server.luau', 'v2\n');
    await waitFor(() => lines.some((l) => /bridge not ready/.test(l)));
    await bridge.listen();
    // The fake applies the push before it answers; wait for the pusher to have processed the answer.
    await waitFor(() => handle.stats().pushed === 2, 8000);
    expect(bridge.studio.find(['ServerScriptService', 'Main'])?.source).toBe('v2\n');
    expect(handle.stats().errors).toBe(0);
  });

  it('fails a one-shot push cleanly when the bridge never answers, and reports tool errors without crashing', async () => {
    const bridge = await fake();
    const port = bridge.port;
    await bridge.pause();
    await write('ServerScriptService/Main.server.luau', 'v1\n');
    await expect(startSync({ dir, port, once: true, log: () => undefined })).rejects.toThrow(/initial push failed/);

    await bridge.listen();
    bridge.failures.push({ code: 'luau_error', message: 'S.script.set: boom' });
    const lines: string[] = [];
    const handle = track(await startSync({ dir, port, once: true, log: (l) => lines.push(l) }));
    expect(handle.stats()).toMatchObject({ pushed: 0, errors: 1 });
    expect(lines.some((l) => /ERROR push of 1 file\(s\) failed \(luau_error\): S\.script\.set: boom/.test(l))).toBe(true);
  });

  it('round-trips: a pull followed by a push changes nothing and raises no warnings', async () => {
    const bridge = await fake();
    bridge.studio.put(['ServerScriptService', 'Main'], 'Script', 'print("main")\r\n');
    bridge.studio.put(['ServerScriptService', 'Game'], 'Script', 'game\n');
    bridge.studio.put(['ServerScriptService', 'Game', 'Combat'], 'ModuleScript', 'return {}\n');
    bridge.studio.put(['ReplicatedStorage', 'Shared', 'Types'], 'ModuleScript', 'types\n');
    const lines: string[] = [];
    const pulled = track(await startSync({ dir, port: bridge.port, pull: true, once: true, log: (l) => lines.push(l) }));
    expect(pulled.stats().pulled).toBe(4);
    bridge.calls.length = 0;
    const pushed = track(await startSync({ dir, port: bridge.port, once: true, log: (l) => lines.push(l) }));
    expect(pushed.stats()).toMatchObject({ pushed: 0, errors: 0 });
    expect(lines.filter((l) => /WARN|ERROR|no sync record/.test(l))).toEqual([]);
    expect(lines.some((l) => /pushed 4 file\(s\).*unchanged 4/.test(l))).toBe(true);
    expect(bridge.studio.find(['ServerScriptService', 'Main'])?.source).toBe('print("main")\r\n');
  });

  it('reports files the program skipped and refuses a missing directory', async () => {
    const bridge = await fake();
    bridge.studio.service('Workspace').children.push({ name: 'Part', class: 'Part', children: [] });
    await write('Workspace/Part.server.luau', 'x\n');
    await write('NotAService/Thing.luau', 'y\n');
    const lines: string[] = [];
    const handle = track(await startSync({ dir, port: bridge.port, once: true, log: (l) => lines.push(l) }));
    expect(lines.some((l) => /WARN Workspace\/Part\.server\.luau: Part is a Part, not a script/.test(l))).toBe(true);
    expect(lines.some((l) => /WARN NotAService\/Thing\.luau: 'NotAService' is not a valid Service name/.test(l))).toBe(true);
    expect(handle.stats().pushed).toBe(0);
    await expect(startSync({ dir: path.join(dir, 'missing'), port: bridge.port, once: true, log: () => undefined })).rejects.toThrow(/not a directory/);
  });
});
